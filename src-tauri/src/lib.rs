//! The desktop shell.
//!
//! Deliberately thin. All the typesetting happens in the webview, in the
//! `typeset-core` crate compiled to WebAssembly, so that a keystroke never
//! has to cross the IPC boundary to be laid out. What the shell owns is the
//! things a webview cannot do: the window, the menu and the filesystem.

use std::collections::HashSet;
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
    std::fs::read_to_string(&path).map_err(|e| format!("无法读取 {path}：{e}"))
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
