//! Import songs and playlists from Spotify, YouTube Music / YouTube and SoundCloud
//! links (API-v2 "Import from other apps"). The work is in `offline_core::sources`;
//! these commands pick the platform path, keep previews in memory until committed,
//! and emit `import://progress`.
//!
//! Spotify is plain HTTP and works everywhere. YouTube playlists and SoundCloud need
//! the yt-dlp binary, which only the desktop has; on Android they return a clear error.

use std::collections::HashMap;
use std::sync::OnceLock;

use offline_core::models::{ImportRecord, Playlist, YtTrack};
use offline_core::sources::{self, ImportPreview, Platform, Previews, SourceList};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::{err, AppState, CmdResult};

pub const PROGRESS_EVENT: &str = "import://progress";

/// `import://progress` payload. `phase` is "listing" while SoundCloud tracks are being
/// read (slow, ≈1 s each) and "matching" while songs are searched on YouTube Music.
#[derive(Clone, Serialize)]
struct Progress<'a> {
    preview_id: &'a str,
    phase: &'static str,
    done: usize,
    total: usize,
}

/// Previews waiting for `import_commit` (process-wide; nothing to register in `lib.rs`).
fn previews() -> &'static Previews {
    static P: OnceLock<Previews> = OnceLock::new();
    P.get_or_init(Previews::default)
}

/// Reads the list behind `url` and matches every song on YouTube Music.
#[tauri::command]
pub async fn import_preview(app: AppHandle, state: State<'_, AppState>, platform: String, url: String) -> CmdResult<ImportPreview> {
    let platform = Platform::parse(&platform).map_err(err)?;
    platform.check_url(&url).map_err(err)?;
    let preview_id = offline_core::new_id();
    let emit = |phase: &'static str, done: usize, total: usize| {
        let _ = app.emit(PROGRESS_EVENT, Progress { preview_id: &preview_id, phase, done, total });
    };

    let list = fetch(&state, platform, &url, |d, n| emit("listing", d, n)).await?;
    emit("matching", 0, list.items.len());
    let mut preview = sources::preview(preview_id.clone(), list, |d, n| emit("matching", d, n)).await.map_err(err)?;
    mark_local(&state, &mut preview);
    previews().insert(preview.clone());
    Ok(preview)
}

/// Saves the chosen songs of a preview as a playlist. `include`: item indexes to keep;
/// `picks` (optional): item index → the song the user picked instead of the match.
#[tauri::command]
pub fn import_commit(state: State<'_, AppState>, preview_id: String, name: String, include: Vec<usize>, picks: Option<HashMap<usize, YtTrack>>) -> CmdResult<Playlist> {
    let preview = previews().get(&preview_id).ok_or_else(|| "This import expired — paste the link again".to_string())?;
    let playlist = sources::commit(&state.db, &preview, &name, &include, &picks.unwrap_or_default()).map_err(err)?;
    previews().remove(&preview_id);
    Ok(playlist)
}

#[tauri::command]
pub fn list_import_history(state: State<'_, AppState>) -> CmdResult<Vec<ImportRecord>> {
    state.db.list_import_history().map_err(err)
}

async fn fetch(state: &AppState, platform: Platform, url: &str, on_progress: impl Fn(usize, usize)) -> CmdResult<SourceList> {
    match platform {
        Platform::Spotify => sources::spotify::fetch(url).await.map_err(err),
        _ => fetch_with_ytdlp(state, platform, url, on_progress).await,
    }
}

#[cfg(not(target_os = "android"))]
async fn fetch_with_ytdlp(state: &AppState, platform: Platform, url: &str, on_progress: impl Fn(usize, usize)) -> CmdResult<SourceList> {
    let bin = offline_core::youtube::ytdlp::ensure_binary(&state.data_dir).await.map_err(|e| format!("yt-dlp is needed to read {} links: {e:#}", platform.label()))?;
    sources::ytdlp_playlist::list(&bin, platform, url, on_progress).await.map_err(err)
}

#[cfg(target_os = "android")]
async fn fetch_with_ytdlp(_state: &AppState, platform: Platform, _url: &str, _on_progress: impl Fn(usize, usize)) -> CmdResult<SourceList> {
    Err(format!("Importing from {} is not available on the phone yet. Spotify links work here.", platform.label()))
}

/// Fills `local_track_id` on matches and alternatives that are already on this device.
fn mark_local(state: &AppState, preview: &mut ImportPreview) {
    for item in &mut preview.items {
        if let Some(m) = item.matched.as_mut() {
            let _ = state.db.match_local(std::slice::from_mut(m));
        }
        let _ = state.db.match_local(&mut item.alternatives);
    }
}
