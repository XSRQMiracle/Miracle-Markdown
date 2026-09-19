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

/// The id the custom Quit item carries, and the one `on_menu_event` matches.
///
/// It exists because the predefined Quit item does not send a menu event at
/// all: muda gives it the `terminate:` selector and a nil target, so AppKit
/// tears the process down without the event loop ever hearing about it.
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "quit";

/// The Edit menu's history items, which are ours for the same kind of reason
/// Quit is: the predefined ones drive the *webview's* editing history, and the
/// only thing focused when the reader is writing is a hidden textarea that
/// exists to collect keystrokes and is emptied after every one. Undoing into
/// it puts keystrokes back and leaves the document alone. These carry an id,
/// and the window decides which history the reader meant.
#[cfg(target_os = "macos")]
const UNDO_MENU_ID: &str = "undo";
#[cfg(target_os = "macos")]
const REDO_MENU_ID: &str = "redo";

/// Select All is ours for a related reason, not the same one. Cut, Copy and
/// Paste each raise a DOM event that the editor intercepts, so they can stay
/// with the platform; `selectAll:` raises none, and selects whatever is in the
/// focused field — which is the hidden collector, empty between keystrokes.
#[cfg(target_os = "macos")]
const SELECT_ALL_MENU_ID: &str = "select-all";

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

    fn protect(&self, label: &str) {
        self.0.lock().unwrap().protected.insert(label.to_string());
    }

    /// This window has agreed to go. Recording it is only honest while the
    /// window is actually on its way out, so the caller undoes it when the
    /// destroy it asked for did not happen.
    fn approve(&self, label: &str) {
        self.0.lock().unwrap().approved.insert(label.to_string());
    }

    fn withdraw(&self, label: &str) {
        self.0.lock().unwrap().approved.remove(label);
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
    state.protect(window.label());
}

/// This window has finished asking, and may go.
///
/// It closes itself rather than exiting the application: the other windows
/// hold their own documents and have not been asked. When the last one goes
/// the runtime raises `ExitRequested` again with nothing left to protect, and
/// the application ends there.
#[tauri::command]
fn finish_close(window: tauri::Window, state: tauri::State<'_, CloseGuard>) {
    let guard = state.inner();
    guard.approve(window.label());
    // An approval that does not end in a destroyed window would outlive the
    // answer it stands for: the label would go on counting as answered, and
    // the next quit would step over this document without asking. Better to be
    // back where we started and ask again than to remember a lie.
    if window.destroy().is_err() {
        guard.withdraw(window.label());
    }
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

/// The application menu.
///
/// Built by hand rather than taken from `Menu::default`, because the quit item
/// default gives us is a predefined one, and on macOS muda wires those
/// straight to `terminate:` with no target — AppKit ends the process without
/// the event loop ever seeing an exit request, and the unsaved-changes guard
/// below never gets to run. Everything else here is deliberately the same set
/// of predefined items Tauri would have built, so nothing native is lost by
/// taking the menu over: only the one item that has to be ours is ours.
///
/// macOS only. On the other platforms Tauri builds no menu at all, and growing
/// one here would put a menu bar over chrome that was drawn without room for it.
#[cfg(target_os = "macos")]
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // English, against the house rule for user-facing strings, because the
    // items around it are English: muda hard-codes the wording of every
    // predefined item, so a Chinese 退出 would sit alone under About and
    // Services looking like a mistake rather than like a translation.
    let quit = MenuItem::with_id(
        app,
        QUIT_MENU_ID,
        format!("Quit {}", package.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    let app_menu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;

    // Cut, Copy and Paste stay predefined, so that they keep going through the
    // responder chain to whatever is focused: each of them raises a DOM event,
    // and the editor answers it with the document's own range. Undo, Redo and
    // Select All raise nothing the editor can answer — the first two would
    // reach the hidden collector's history and the third its empty contents —
    // so those three carry an id and are routed by the window instead.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, UNDO_MENU_ID, "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, REDO_MENU_ID, "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(app, SELECT_ALL_MENU_ID, "Select All", true, Some("CmdOrCtrl+A"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    // The two ids are not decoration: Tauri looks them up once the menu is
    // installed and hands the submenus to AppKit, which is what puts the list
    // of open windows under Window and the search field under Help.
    let window_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;

    let help_menu =
        Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Give the application its menu, and route the items that are ours.
///
/// Separated from the builder chain so the whole arrangement can be absent on
/// the platforms that have no application menu, and so that a new custom item
/// is one arm of one match rather than another `cfg` somewhere else.
#[cfg(target_os = "macos")]
fn with_app_menu(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            // Not an exit: a request for one. `AppHandle::exit` posts through
            // the event loop proxy, so what comes back a turn later is
            // `ExitRequested` — which is where every document gets its say.
            QUIT_MENU_ID => app.exit(0),
            UNDO_MENU_ID => send_edit_command(app, "undo"),
            REDO_MENU_ID => send_edit_command(app, "redo"),
            SELECT_ALL_MENU_ID => send_edit_command(app, "selectAll"),
            _ => {}
        })
}

/// Hand an Edit-menu command to the window the reader is actually in.
///
/// To that window and no other. A menu belongs to the application and every
/// window has its own document and its own history, so a broadcast would undo
/// an edit in a document nobody was looking at.
#[cfg(target_os = "macos")]
fn send_edit_command(app: &tauri::AppHandle, command: &str) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false));
    let Some(window) = focused else { return };
    let _ = app.emit_to(
        EventTarget::AnyLabel {
            label: window.label().to_string(),
        },
        "menu-edit-command",
        command,
    );
}

#[cfg(not(target_os = "macos"))]
fn with_app_menu(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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
        ]);

    with_app_menu(builder)
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
            // Reached two ways: the Quit item above asking for an exit, and
            // the runtime noticing the last window has gone. Quitting takes
            // every window with it, so here the broadcast is right — each
            // document gets asked, and each window that agrees closes itself.
            // When the last one has gone this fires again with nothing left to
            // protect, and that is where the application ends.
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

    // The close guard's state machine.
    //
    // Quitting asks every window that is holding a document, one at a time,
    // and ends only when none of them is still owed an answer. Whether that
    // question is asked at all is the menu's business and cannot be tested
    // without a running event loop; whether the right windows are asked is
    // arithmetic, and is tested here.

    #[test]
    fn a_protected_window_is_asked_until_it_answers() {
        let guard = CloseGuard::default();
        guard.protect("main");
        assert!(guard.should_prompt("main"));
        assert!(guard.any_unanswered(), "a quit has to stop for it");

        guard.approve("main");
        assert!(!guard.should_prompt("main"), "and stop asking once it has answered");
        assert!(!guard.any_unanswered(), "so a quit may go ahead");
    }

    #[test]
    fn an_unprotected_window_is_never_asked() {
        let guard = CloseGuard::default();
        assert!(!guard.should_prompt("main"));
        assert!(!guard.any_unanswered(), "and holds nothing up");
    }

    #[test]
    fn one_windows_answer_does_not_speak_for_another() {
        let guard = CloseGuard::default();
        guard.protect("main");
        guard.protect("doc-2");
        guard.approve("main");
        assert!(!guard.should_prompt("main"));
        assert!(guard.should_prompt("doc-2"), "the other document has not been asked");
        assert!(guard.any_unanswered(), "so the quit is still waiting on it");
    }

    #[test]
    fn a_cancelled_quit_leaves_every_window_ready_to_be_asked_again() {
        let guard = CloseGuard::default();
        guard.protect("main");
        guard.protect("doc-2");
        // Cancelling is the absence of an answer, not an answer of its own:
        // nothing is recorded, so the next quit starts the same conversation.
        assert!(guard.any_unanswered());
        assert!(guard.should_prompt("main") && guard.should_prompt("doc-2"));
    }

    #[test]
    fn withdrawing_an_approval_puts_the_window_back_in_the_queue() {
        let guard = CloseGuard::default();
        guard.protect("main");
        guard.approve("main");
        assert!(!guard.any_unanswered());
        // The window agreed to go and then did not go. An approval that
        // outlived its window would let the next quit step over the document
        // without asking.
        guard.withdraw("main");
        assert!(guard.should_prompt("main"));
        assert!(guard.any_unanswered());
    }

    #[test]
    fn a_reused_label_starts_over_rather_than_inheriting_an_answer() {
        let guard = CloseGuard::default();
        guard.protect("doc-2");
        guard.approve("doc-2");
        guard.forget("doc-2");
        // A label is only unique for the life of the application, so a second
        // window wearing it must not inherit the first one's consent.
        guard.protect("doc-2");
        assert!(guard.should_prompt("doc-2"));
        assert!(guard.any_unanswered());
    }

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
