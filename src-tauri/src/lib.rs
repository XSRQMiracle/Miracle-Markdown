//! The desktop shell.
//!
//! Deliberately thin. All the typesetting happens in the webview, in the
//! `typeset-core` crate compiled to WebAssembly, so that a keystroke never
//! has to cross the IPC boundary to be laid out. What the shell owns is the
//! things a webview cannot do: the window, the menu and the filesystem.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Default)]
struct CloseGuard {
    protected: AtomicBool,
    approved: AtomicBool,
}

impl CloseGuard {
    fn should_prompt(&self) -> bool {
        self.protected.load(Ordering::SeqCst) && !self.approved.load(Ordering::SeqCst)
    }
}

// Enable interception only after the webview has installed its listener.
#[tauri::command]
fn protect_document(state: tauri::State<'_, CloseGuard>) {
    state.protected.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn finish_close(app: tauri::AppHandle, state: tauri::State<'_, CloseGuard>) {
    state.approved.store(true, Ordering::SeqCst);
    app.exit(0);
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
            suggested_fonts,
            protect_document,
            finish_close
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<CloseGuard>().should_prompt() {
                    api.prevent_close();
                    let _ = window.emit("document-close-requested", ());
                }
            }
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
            // Application Quit (including Cmd-Q) can bypass window close.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app.state::<CloseGuard>().should_prompt() {
                    api.prevent_exit();
                    let _ = app.emit("document-close-requested", ());
                }
            }
        });
}
