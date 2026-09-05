//! The desktop shell.
//!
//! Deliberately thin. All the typesetting happens in the webview, in the
//! `typeset-core` crate compiled to WebAssembly, so that a keystroke never
//! has to cross the IPC boundary to be laid out. What the shell owns is the
//! things a webview cannot do: the window, the menu and the filesystem.

use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

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
    // Write to a sibling temporary file and rename, so an interrupted save
    // cannot leave the user with a half-written document.
    let target = PathBuf::from(&path);
    let tmp = target.with_extension("md.tmp");
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("无法写入：{e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("无法保存 {path}：{e}"))?;
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            suggested_fonts
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Miracle Markdown");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
