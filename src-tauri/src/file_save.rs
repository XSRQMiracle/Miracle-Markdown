//! Document replacement, including the filesystem metadata that belongs to it.
//!
//! The temporary file is exclusively created beside the destination. Existing
//! symlinks are resolved once, matching read_file: saving through a symlink edits
//! its referent and keeps the link. Dangling links and non-files are rejected.
//! Saves within this process are serialized; unrelated external writers still
//! need coordination (replacement of an existing path is last-writer-wins).
//!
//! We sync file data before replacement and the parent directory on Unix where
//! supported. This is not a guarantee against every disk/network filesystem or
//! power failure. In particular Windows has no portable directory-sync API.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static SAVES: Mutex<()> = Mutex::new(());

pub fn save_document(path: &Path, contents: &[u8]) -> io::Result<()> {
    let _save = SAVES.lock().map_err(|_| io::Error::other("保存锁不可用"))?;
    save_with(path, |file| file.write_all(contents))
}

fn resolve_destination(path: &Path) -> io::Result<(PathBuf, Option<File>)> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            // canonicalize deliberately rejects dangling links. Never replace
            // such a link with a new file, or change which file read_file read.
            let target = fs::canonicalize(path)?;
            let mut options = OpenOptions::new();
            options.read(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let original = options.open(&target)?;
            if !original.metadata()?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "只能保存普通文件",
                ));
            }
            Ok((target, Some(original)))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let name = path
                .file_name()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "保存路径缺少文件名"))?;
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            Ok((fs::canonicalize(parent)?.join(name), None))
        }
        Err(error) => Err(error),
    }
}

fn save_with(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let (target, original) = resolve_destination(path)?;
    let parent = target.parent().expect("resolved destination has a parent");
    #[cfg(unix)]
    let directory = File::open(parent)?;

    // tempfile uses random names and create_new/O_EXCL, including retries on
    // collisions. An existing file or symlink is never opened or truncated.
    let mut temporary = tempfile::Builder::new()
        .prefix(".miracle-save-")
        .tempfile_in(parent)?;
    write(temporary.as_file_mut())?;
    temporary.as_file_mut().flush()?;
    #[cfg(unix)]
    if let Some(original) = &original {
        preserve_metadata(original, temporary.as_file())?;
    }
    #[cfg(windows)]
    preserve_metadata(original.as_ref(), temporary.as_file())?;
    sync_file(temporary.as_file())?;

    // Close handles before Windows ReplaceFileW, which opens the replacement
    // without sharing. TempPath still owns cleanup on every pre-commit error.
    let existed = original.is_some();
    drop(original);
    replace(temporary.into_temp_path(), &target, existed)?;

    #[cfg(unix)]
    if let Err(error) = directory.sync_all() {
        if !sync_unsupported(&error) {
            return Err(io::Error::new(
                error.kind(),
                format!("内容已替换，但无法同步目录：{error}"),
            ));
        }
    }
    Ok(())
}

fn sync_file(file: &File) -> io::Result<()> {
    file.sync_all()?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // fsync alone need not flush a drive's volatile write cache on macOS.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } == -1 {
            let error = io::Error::last_os_error();
            if !sync_unsupported(&error) {
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn sync_unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::EINVAL) | Some(libc::ENOTSUP)
    )
}

#[cfg(unix)]
fn preserve_metadata(original: &File, replacement: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let metadata = original.metadata()?;
    let replacement_metadata = replacement.metadata()?;
    // Changing ownership can clear set-id bits, so do this before mode/ACLs.
    if (metadata.uid(), metadata.gid()) != (replacement_metadata.uid(), replacement_metadata.gid())
    {
        if unsafe { libc::fchown(replacement.as_raw_fd(), metadata.uid(), metadata.gid()) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    replacement.set_permissions(metadata.permissions())?;

    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        // These descriptor APIs copy ACLs and xattrs (including Finder tags and
        // resource forks) without copying stale data or modification times.
        let result = unsafe {
            libc::fcopyfile(
                original.as_raw_fd(),
                replacement.as_raw_fd(),
                std::ptr::null_mut(),
                libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
            )
        };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fchflags(replacement.as_raw_fd(), metadata.st_flags()) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(target_os = "linux")]
    {
        use xattr::FileExt;
        let names: Vec<_> = original.list_xattr()?.collect();
        // A parent may give the temporary file an inherited ACL. Do not retain
        // metadata absent from the original, including a wider inherited ACL.
        for name in replacement.list_xattr()? {
            if !names.contains(&name) {
                replacement.remove_xattr(&name)?;
            }
        }
        for name in names {
            let value = original
                .get_xattr(&name)?
                .ok_or_else(|| io::Error::other("保存期间文件扩展属性发生变化"))?;
            replacement.set_xattr(&name, &value)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn preserve_metadata(original: Option<&File>, replacement: &File) -> io::Result<()> {
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, SetFileInformationByHandle, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN,
        FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_READONLY,
        FILE_ATTRIBUTE_SYSTEM, FILE_BASIC_INFO,
    };

    // ReplaceFileW merges the original's DACL, encryption, compression, and
    // named streams. Copy flags supported by FILE_BASIC_INFO separately, and
    // clear tempfile's TEMPORARY flag before syncing even for a brand-new file.
    // Zero timestamps leave the replacement's current timestamps unchanged.
    let attributes = original
        .map(File::metadata)
        .transpose()?
        .map_or(0, |m| m.file_attributes());
    let attributes = attributes
        & (FILE_ATTRIBUTE_HIDDEN
            | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
            | FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_READONLY
            | FILE_ATTRIBUTE_SYSTEM);
    let info = FILE_BASIC_INFO {
        FileAttributes: attributes | FILE_ATTRIBUTE_ARCHIVE,
        ..Default::default()
    };
    let result = unsafe {
        SetFileInformationByHandle(
            replacement.as_raw_handle(),
            FileBasicInfo,
            (&info as *const FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn replace(temporary: tempfile::TempPath, target: &Path, existed: bool) -> io::Result<()> {
    if existed {
        temporary.persist(target).map_err(|error| error.error)
    } else {
        temporary
            .persist_noclobber(target)
            .map_err(|error| error.error)
    }
}

#[cfg(windows)]
fn replace(temporary: tempfile::TempPath, target: &Path, existed: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    let target_wide = wide(target);
    let temporary_wide = wide(&temporary);
    if !existed {
        // No replace flag: a file created concurrently must not be overwritten.
        let result = unsafe {
            MoveFileExW(
                temporary_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        };
        return if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
    }

    // ReplaceFileW can move the old file before failing. Reserve a fresh unique
    // namespace for its backup so such a failure never destroys the only copy.
    let backup_dir = tempfile::Builder::new()
        .prefix(".miracle-backup-")
        .tempdir_in(target.parent().unwrap())?;
    let backup = backup_dir.path().join("original");
    let backup_wide = wide(&backup);
    let result = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        let error = io::Error::last_os_error();
        if backup.try_exists().unwrap_or(true) {
            // Restore only when the target is absent; never clobber another
            // writer's new file during error recovery.
            let restored = unsafe {
                MoveFileExW(
                    backup_wide.as_ptr(),
                    target_wide.as_ptr(),
                    MOVEFILE_WRITE_THROUGH,
                )
            };
            if restored == 0 {
                let recovery = backup_dir.keep();
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "{error}；原文件保留在 {}",
                        recovery.join("original").display()
                    ),
                ));
            }
        }
        return Err(error);
    }
    // The API merges metadata after the first sync. Flush the resulting file as
    // well; report that replacement already happened if this final flush fails.
    let sync_result = OpenOptions::new()
        .write(true)
        .open(target)
        .and_then(|file| file.sync_all());
    backup_dir.close().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("内容已替换，但无法清理备份 {}：{error}", backup.display()),
        )
    })?;
    sync_result.map_err(|error| {
        io::Error::new(error.kind(), format!("内容已替换，但无法同步文件：{error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_replaces_document_without_touching_old_temp_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let old_temp = dir.path().join("notes.md.tmp");
        fs::write(&old_temp, "unrelated file").unwrap();
        save_document(&path, b"first").unwrap();
        save_document(&path, "新内容\r\n".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "新内容\r\n");
        assert_eq!(fs::read_to_string(&old_temp).unwrap(), "unrelated file");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn partial_write_failure_leaves_original_and_removes_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let result = save_with(&path, |file| {
            file.write_all(b"partial contents")?;
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "injected disk full",
            ))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_new_destination_created_during_save_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let result = save_with(&path, |file| {
            file.write_all(b"our contents")?;
            fs::write(&path, "another writer")
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "another writer");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn simultaneous_saves_publish_only_complete_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let snapshots: Vec<_> = (b'a'..=b'd').map(|byte| vec![byte; 64 * 1024]).collect();
        std::thread::scope(|scope| {
            for snapshot in &snapshots {
                let path = &path;
                scope.spawn(move || save_document(path, snapshot).unwrap());
            }
        });
        assert!(snapshots.contains(&fs::read(&path).unwrap()));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_replace_removes_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let result = save_with(&path, |file| {
            file.write_all(b"new contents")?;
            fs::rename(&path, dir.path().join("original.md"))?;
            fs::create_dir(&path)
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("original.md")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_mode_and_never_follows_old_temporary_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let victim = dir.path().join("other.md");
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&victim, "do not change").unwrap();
        symlink(&victim, path.with_extension("md.tmp")).unwrap();
        save_document(&path, b"saved").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "do not change");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_symlink_keeps_link_and_rejects_dangling_link() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("notes.md");
        let link = dir.path().join("link.md");
        fs::write(&target, "original").unwrap();
        symlink(&target, &link).unwrap();
        save_document(&link, b"saved").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "saved");
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        fs::remove_file(&target).unwrap();
        assert!(save_document(&link, b"no").is_err());
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert!(!target.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preserves_macos_acl_and_extended_attributes() {
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        assert!(Command::new("/bin/chmod")
            .args(["+a", "everyone allow read"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("/usr/bin/xattr")
            .args(["-w", "com.miracle.test", "retained"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let acl_before = Command::new("/bin/ls")
            .arg("-le")
            .arg(&path)
            .output()
            .unwrap()
            .stdout;
        save_document(&path, b"saved").unwrap();
        let acl_after = Command::new("/bin/ls")
            .arg("-le")
            .arg(&path)
            .output()
            .unwrap()
            .stdout;
        // The first ls line contains the deliberately changed size/mtime.
        assert_eq!(
            String::from_utf8(acl_before)
                .unwrap()
                .lines()
                .skip(1)
                .collect::<Vec<_>>(),
            String::from_utf8(acl_after)
                .unwrap()
                .lines()
                .skip(1)
                .collect::<Vec<_>>()
        );
        let attribute = Command::new("/usr/bin/xattr")
            .args(["-p", "com.miracle.test"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(attribute.status.success());
        assert_eq!(
            String::from_utf8(attribute.stdout).unwrap().trim(),
            "retained"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preserves_linux_extended_attributes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        xattr::set(&path, "user.miracle.test", b"retained").unwrap();
        save_document(&path, b"saved").unwrap();
        assert_eq!(
            xattr::get(&path, "user.miracle.test").unwrap(),
            Some(b"retained".to_vec())
        );
    }

    #[cfg(windows)]
    #[test]
    fn preserves_windows_named_streams() {
        use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_TEMPORARY,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let stream = format!("{}:miracle-test", path.display());
        fs::write(&stream, "retained").unwrap();
        let wide_path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        assert_ne!(
            unsafe { SetFileAttributesW(wide_path.as_ptr(), FILE_ATTRIBUTE_HIDDEN) },
            0
        );
        save_document(&path, b"saved").unwrap();
        assert_eq!(fs::read_to_string(stream).unwrap(), "retained");
        let attributes = fs::metadata(&path).unwrap().file_attributes();
        assert_ne!(attributes & FILE_ATTRIBUTE_HIDDEN, 0);
        assert_eq!(attributes & FILE_ATTRIBUTE_TEMPORARY, 0);
        let new_path = dir.path().join("new.md");
        save_document(&new_path, b"new").unwrap();
        assert_eq!(
            fs::metadata(new_path).unwrap().file_attributes() & FILE_ATTRIBUTE_TEMPORARY,
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn preserves_windows_explicit_dacl() {
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let powershell = |script: &str| {
            let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("MIRACLE_SAVE_TEST_FILE", &path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        // Break inheritance while retaining current access, giving the original
        // a DACL that a freshly created sibling does not inherit.
        powershell("$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:MIRACLE_SAVE_TEST_FILE; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $env:MIRACLE_SAVE_TEST_FILE -AclObject $a");
        let read_acl = "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:MIRACLE_SAVE_TEST_FILE).Sddl";
        let before = powershell(read_acl);
        save_document(&path, b"saved").unwrap();
        assert_eq!(before, powershell(read_acl));
    }
}
