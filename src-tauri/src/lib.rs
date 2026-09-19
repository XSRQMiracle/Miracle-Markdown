//! The desktop shell.
//!
//! Deliberately thin. All the typesetting happens in the webview, in the
//! `typeset-core` crate compiled to WebAssembly, so that a keystroke never
//! has to cross the IPC boundary to be laid out. What the shell owns is the
//! things a webview cannot do: the window, the menu and the filesystem.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, EventTarget, Manager};

/// Which windows are holding a document that has to be asked about before it
/// can go away, and which of them have already had their say.
///
/// Per window, not per application: a document lives in its window, so one
/// window's answer says nothing about another's. Answering for all of them at
/// once is how a clean window used to be able to quit the app out from under a
/// dirty one.
#[derive(Default)]
struct CloseGuard(Mutex<GuardState>);

#[derive(Default)]
struct GuardState {
    protected: HashSet<String>,
    approved: HashSet<String>,
}

impl CloseGuard {
    fn should_prompt(&self, label: &str) -> bool {
        let state = self.0.lock().unwrap();
        state.protected.contains(label) && !state.approved.contains(label)
    }

    /// Is any window still waiting to be asked? This is the question a quit
    /// has to answer, since it takes every window with it.
    fn any_unanswered(&self) -> bool {
        let state = self.0.lock().unwrap();
        state
            .protected
            .iter()
            .any(|label| !state.approved.contains(label))
    }

    fn forget(&self, label: &str) {
        let mut state = self.0.lock().unwrap();
        state.protected.remove(label);
        state.approved.remove(label);
    }
}

// Enable interception only after the webview has installed its listener.
#[tauri::command]
fn protect_document(window: tauri::Window, state: tauri::State<'_, CloseGuard>) {
    state
        .0
        .lock()
        .unwrap()
        .protected
        .insert(window.label().to_string());
}

/// This window has finished asking, and may go.
///
/// It closes itself rather than exiting the application: the other windows
/// hold their own documents and have not been asked. When the last one goes
/// the runtime raises `ExitRequested` again with nothing left to protect, and
/// the application ends there.
#[tauri::command]
fn finish_close(window: tauri::Window, state: tauri::State<'_, CloseGuard>) {
    state
        .0
        .lock()
        .unwrap()
        .approved
        .insert(window.label().to_string());
    let _ = window.destroy();
}

mod file_save;

#[derive(Serialize)]
pub struct OpenedFile {
    path: String,
    contents: String,
}

/// Read a markdown file the user picked.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    read_regular_file(Path::new(&path)).map_err(|e| format!("无法读取 {path}：{e}"))
}

/// Read a path, having first established that it is an ordinary file.
///
/// Judged through the descriptor the read will use rather than through the
/// path. A check on the path answers a question about whatever that name
/// pointed at a moment ago, and a name can be repointed in between; a
/// descriptor cannot, so opening first and asking afterwards is the only order
/// that cannot be raced.
///
/// On Unix the open carries `O_NONBLOCK`, because the file we most need to
/// turn down is the one kind whose `open` never returns: a FIFO with no writer
/// holds the calling thread for as long as it stays that way, and a FIFO named
/// `notes.md` is an ordinary-looking entry in a folder. Opening one
/// non-blocking returns at once and lets the check below refuse it. The flag
/// is a no-op for the regular files that get past that check.
///
/// `O_NOFOLLOW` guards the resolved path against being replaced by a link
/// between the two calls. The link that named the file has already been
/// followed, by `canonicalize` — which is the same bargain `file_save` strikes
/// on the way out, so both halves of the file boundary agree about which file
/// a link means.
fn read_regular_file(path: &Path) -> io::Result<String> {
    let target = std::fs::canonicalize(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(&target)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "只能打开普通文件",
        ));
    }
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

/// Write the document back to disk.
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    file_save::save_document(std::path::Path::new(&path), contents.as_bytes())
        .map_err(|e| format!("无法保存 {path}：{e}"))
}

/// One entry in a folder the sidebar is showing.
///
/// Named the way the webview reads them: Tauri serialises a command's return
/// value with plain serde, which renames nothing, so without this the wire
/// would carry `is_dir` while `platform.ts` asks for `isDir` — and every
/// directory would arrive as `undefined`, that is, as a file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// Bytes. Zero for a directory.
    size: u64,
    /// Milliseconds since the epoch, or zero when the platform will not say.
    modified: f64,
}

/// Whether a file is worth showing in a Markdown editor's file tree.
fn is_document(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

/// Whether a listed entry is an ordinary file, following a link to ask.
///
/// `file_type` reports the link itself, so a symlink has to be followed to
/// find out what it stands for. Following it costs a `stat`, which reads the
/// inode and does not open anything — so unlike `read_file`'s problem, asking
/// this question cannot itself block on a FIFO.
fn is_regular(entry: &std::fs::DirEntry, kind: std::fs::FileType) -> bool {
    if kind.is_file() {
        return true;
    }
    kind.is_symlink() && entry.path().metadata().is_ok_and(|meta| meta.is_file())
}

/// Directories that are never what someone means by "my notes".
fn is_noise(name: &str) -> bool {
    name.starts_with('.')
        || matches!(name, "node_modules" | "target" | "dist" | "build" | "__pycache__")
}

/// List one level of a folder.
///
/// One level rather than the whole tree: a notes folder can sit inside a home
/// directory, and walking it eagerly would cost seconds before the sidebar
/// could draw anything. The panel asks again when a folder is opened.
#[tauri::command]
fn list_folder(path: String) -> Result<Vec<FolderEntry>, String> {
    let mut entries = Vec::new();
    let dir = std::fs::read_dir(&path).map_err(|e| format!("无法读取文件夹 {path}：{e}"))?;
    for entry in dir {
        let entry = match entry {
            Ok(entry) => entry,
            // One unreadable entry must not lose the rest of the folder.
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        // Symlinks are followed for their kind but not chased for loops: a
        // link to an ancestor simply shows as a folder that can be opened.
        let is_dir = kind.is_dir()
            || (kind.is_symlink() && entry.path().is_dir());
        if is_dir {
            if is_noise(&name) {
                continue;
            }
        } else if name.starts_with('.') || !is_document(&name) {
            continue;
        } else if !is_regular(&entry, kind) {
            // A FIFO, a socket or a device can be called notes.md as easily as
            // anything else, and offering one as a document invites the reader
            // to open something that cannot be read as text — and, for a FIFO
            // with no writer, something that would never finish being read.
            // `read_file` refuses these too; this is so they are not offered.
            continue;
        }
        let meta = entry.metadata().ok();
        let size = if is_dir { 0 } else { meta.as_ref().map_or(0, |m| m.len()) };
        let modified = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_millis() as f64);
        entries.push(FolderEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size,
            modified,
        });
    }
    // Folders first, then files, each run sorted the way a person reads them.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// The folder a `../images/photo.png` is measured against.
///
/// Climbing one level out of the document's own folder is what makes the
/// commonest layout in the wild work, a `posts` and an `images` sitting beside
/// each other. A document that lives straight in a home directory or at the
/// top of a disk is not part of a project, though, and climbing out of one of
/// those would hand the renderer somebody's whole world for the sake of a
/// markdown convention. Those are the cases this refuses.
fn project_root<'a>(directory: &'a Path, home: Option<&Path>) -> Option<&'a Path> {
    let parent = directory.parent()?;
    let grandparent = parent.parent()?;
    if grandparent.parent().is_none() {
        return None;
    }
    if home.is_some_and(|home| parent == home) {
        return None;
    }
    Some(parent)
}

/// Let the asset protocol serve the pictures that belong to a folder.
///
/// The scope is deliberately not written in `tauri.conf.json`. A static one
/// would have to be wide enough for every document the user will ever open,
/// which means the whole filesystem, and that is a grant nobody can take back.
/// Extending it as documents arrive means the renderer reaches exactly the
/// folders the reader has themselves pointed the application at — the one the
/// open document lives in, the project folder around it, and whatever the
/// sidebar is showing — and nothing else. Granting the same folder twice costs
/// nothing; the scope is a set of patterns, not a list.
#[tauri::command]
fn allow_images_in(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let directory = Path::new(&path);
    if !directory.is_dir() {
        return Err(format!("找不到文件夹 {path}"));
    }
    let scope = app.asset_protocol_scope();
    let home = app.path().home_dir().ok();
    scope
        .allow_directory(directory, true)
        .map_err(|e| format!("无法读取 {path} 中的图片：{e}"))?;
    if let Some(root) = project_root(directory, home.as_deref()) {
        scope
            .allow_directory(root, true)
            .map_err(|e| format!("无法读取 {} 中的图片：{e}", root.display()))?;
    }
    Ok(())
}

/// Fonts the user actually has, so the settings panel can offer real choices
/// rather than a stack that may silently fall back.
#[tauri::command]
fn suggested_fonts() -> Vec<String> {
    // Kept as a curated list rather than a system enumeration: for a
    // typesetting application the point is to offer faces that are known to
    // carry a full CJK range and a matching Latin companion.
    let candidates = [
        "Source Han Serif SC",
        "Noto Serif CJK SC",
        "Songti SC",
        "SimSun",
        "STSong",
        "Source Han Sans SC",
        "PingFang SC",
        "Microsoft YaHei",
        "Hiragino Sans GB",
    ];
    candidates.iter().map(|s| s.to_string()).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CloseGuard::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_folder,
            allow_images_in,
            suggested_fonts,
            protect_document,
            finish_close
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.state::<CloseGuard>().should_prompt(window.label()) {
                    api.prevent_close();
                    // To this window and no other. `emit` broadcasts, which
                    // would put the unsaved-changes dialog in front of every
                    // open document because one of them was being closed.
                    let _ = window.emit_to(
                        EventTarget::AnyLabel {
                            label: window.label().to_string(),
                        },
                        "document-close-requested",
                        (),
                    );
                }
            }
            // A label is only unique for the life of the app, and a closed
            // window must not go on counting as one that owes an answer.
            tauri::WindowEvent::Destroyed => {
                window.state::<CloseGuard>().forget(window.label());
            }
            _ => {}
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Miracle Markdown");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // Application Quit (including Cmd-Q) can bypass window close, and
            // it takes every window with it — so here the broadcast is right:
            // each document gets asked, and each window that agrees closes
            // itself. The app ends when the last one has gone.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app.state::<CloseGuard>().any_unanswered() {
                    api.prevent_exit();
                    let _ = app.emit("document-close-requested", ());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run `body` on its own thread and insist it finishes.
    ///
    /// The defect under test is an operation that never returns, so a test that
    /// simply called it would not fail — it would hang, and a hung suite says
    /// nothing about which case broke. Giving the work a thread and the test a
    /// deadline turns "waits for ever" into an ordinary failure.
    fn within<T: Send + 'static>(seconds: u64, body: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(body());
        });
        rx.recv_timeout(std::time::Duration::from_secs(seconds))
            .expect("the read should finish rather than wait for a writer that is not coming")
    }

    #[test]
    fn an_ordinary_file_reads_back_what_was_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, "# 标题\n正文\n").unwrap();
        assert_eq!(read_regular_file(&path).unwrap(), "# 标题\n正文\n");
    }

    #[test]
    fn invalid_utf8_is_refused_rather_than_mangled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.md");
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        let error = read_regular_file(&path).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_directory_is_not_a_document() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_regular_file(dir.path()).is_err());
    }

    #[test]
    fn a_missing_file_says_so() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_regular_file(&dir.path().join("absent.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_with_no_writer_is_refused_instead_of_waited_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let c_path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);

        // Nothing will ever open the other end. Before this was guarded, the
        // open itself blocked here and the application simply stopped.
        let error = within(5, move || read_regular_file(&path).unwrap_err());
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_read_as_the_file_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "through the link\n").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // The same bargain `file_save` strikes on the way out: a link is
        // followed once, so reading and saving agree about which file it means.
        assert_eq!(read_regular_file(&link).unwrap(), "through the link\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_fifo_is_refused_like_the_fifo_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);
        let link = dir.path().join("notes.md");
        std::os::unix::fs::symlink(&fifo, &link).unwrap();

        let error = within(5, move || read_regular_file(&link).unwrap_err());
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_offers_the_real_document_and_not_the_pipe_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.md"), "x").unwrap();
        let fifo = dir.path().join("notes.md");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);

        let path = dir.path().to_string_lossy().into_owned();
        let listed = within(5, move || list_folder(path).unwrap());
        let names: Vec<&str> = listed.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["real.md"]);
    }
}
