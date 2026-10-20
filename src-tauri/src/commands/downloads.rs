//! The download queue (YouTube Music songs via yt-dlp) and storage usage.
//! The platform-specific job runners live in `commands/youtube.rs`.

use offline_core::models::{Download, DownloadState, StorageInfo};
use tauri::{AppHandle, Manager, State};

use super::youtube::{self, YtState};
use crate::state::{err, AppState, CmdResult};

/// Active first, then queued, paused, failed and finished; by name within a group.
#[tauri::command]
pub async fn list_downloads(state: State<'_, AppState>, yt: State<'_, YtState>) -> CmdResult<Vec<Download>> {
    let mut all = youtube::list(&state, &yt).await;
    let rank = |s: DownloadState| match s {
        DownloadState::Active => 0,
        DownloadState::Queued => 1,
        DownloadState::Paused => 2,
        DownloadState::Error => 3,
        DownloadState::Done => 4,
    };
    all.sort_by(|a, b| rank(a.state).cmp(&rank(b.state)).then_with(|| a.name.cmp(&b.name)));
    Ok(all)
}

/// Stops a running download and keeps the partial file for `resume_download`.
#[tauri::command]
pub async fn pause_download(yt: State<'_, YtState>, id: String) -> CmdResult<()> {
    youtube::pause(&yt, &id).await
}

#[tauri::command]
pub async fn resume_download(state: State<'_, AppState>, yt: State<'_, YtState>, id: String) -> CmdResult<()> {
    youtube::resume(&state, &yt, &id).await
}

/// Starts a failed download again (same as resume; yt-dlp continues a partial file).
#[tauri::command]
pub async fn retry_download(state: State<'_, AppState>, yt: State<'_, YtState>, id: String) -> CmdResult<()> {
    youtube::resume(&state, &yt, &id).await
}

/// Cancels (if running) and forgets a download. A finished file stays in the library.
#[tauri::command]
pub async fn remove_download(yt: State<'_, YtState>, id: String) -> CmdResult<()> {
    youtube::remove(&yt, &id).await;
    Ok(())
}

/// Forgets every finished download (the songs stay in the library).
#[tauri::command]
pub async fn clear_finished_downloads(yt: State<'_, YtState>) -> CmdResult<()> {
    youtube::clear_finished(&yt).await;
    Ok(())
}

/// `{ used_bytes, free_bytes, downloads_bytes, cache_bytes }`. Used/free describe the
/// disk holding the download folder; cache is the app cache folder (stream cache).
#[tauri::command]
pub async fn storage_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<StorageInfo> {
    let db = state.db.clone();
    let download_dir = state.download_dir();
    let cache_dir = app.path().app_cache_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let (used_bytes, free_bytes) = offline_core::util::disk_space(&download_dir).unwrap_or((0, 0));
        Ok(StorageInfo {
            used_bytes,
            free_bytes,
            downloads_bytes: db.downloads_bytes().map_err(err)?,
            cache_bytes: cache_dir.map(|d| offline_core::util::dir_size(&d)).unwrap_or(0),
        })
    })
    .await
    .map_err(err)?
}
