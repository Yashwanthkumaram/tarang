//! Key/value settings and platform info.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::state::{err, AppState, CmdResult};

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<HashMap<String, String>> {
    state.db.all_settings().map_err(err)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    state.db.set_setting(&key, &value).map_err(err)
}

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub is_mobile: bool,
    pub data_dir: String,
    pub download_dir: String,
    pub default_roots: Vec<String>,
    pub version: String,
}

#[tauri::command]
pub fn get_platform(state: State<'_, AppState>) -> CmdResult<PlatformInfo> {
    Ok(PlatformInfo {
        os: std::env::consts::OS.to_string(),
        is_mobile: cfg!(any(target_os = "android", target_os = "ios")),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        download_dir: state.download_dir().to_string_lossy().to_string(),
        default_roots: offline_core::paths::default_roots(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// Lists sub-directories of a path, for the in-app folder picker on Android
/// (the native picker returns content URIs, which the scanner cannot walk).
#[tauri::command]
pub fn list_dirs(path: String) -> CmdResult<Vec<String>> {
    let mut out: Vec<String> = std::fs::read_dir(&path)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    out.sort();
    Ok(out)
}
