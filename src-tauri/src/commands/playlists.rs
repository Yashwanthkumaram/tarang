//! Playlists, including the virtual "Liked songs" playlist (id 0). Thin wrappers over
//! `offline_core::db::Db`; see docs/API-v2.md for the shapes.

use offline_core::models::{Playlist, PlaylistDetail, YtTrack};
use tauri::State;

use super::youtube::{self, YtState};
use crate::state::{err, AppState, CmdResult};

/// Liked songs first, then user playlists, most recently changed first.
#[tauri::command]
pub fn list_playlists(state: State<'_, AppState>) -> CmdResult<Vec<Playlist>> {
    state.db.list_playlists().map_err(err)
}

/// `{ playlist, entries }`; id 0 is Liked songs.
#[tauri::command]
pub fn get_playlist(state: State<'_, AppState>, id: i64) -> CmdResult<PlaylistDetail> {
    state.db.get_playlist(id).map_err(err)?.ok_or_else(|| "playlist not found".into())
}

#[tauri::command]
pub fn create_playlist(state: State<'_, AppState>, name: String, description: Option<String>) -> CmdResult<Playlist> {
    state.db.create_playlist(&name, description.as_deref(), None).map_err(err)
}

#[tauri::command]
pub fn rename_playlist(state: State<'_, AppState>, id: i64, name: String, description: Option<String>) -> CmdResult<Playlist> {
    state.db.rename_playlist(id, &name, description.as_deref()).map_err(err)
}

#[tauri::command]
pub fn delete_playlist(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    state.db.delete_playlist(id).map_err(err)
}

/// Appends library tracks and/or YouTube results (which become stream-only library
/// rows). Songs already in the playlist are skipped. On id 0 this likes them.
#[tauri::command]
pub fn add_to_playlist(state: State<'_, AppState>, playlist_id: i64, track_ids: Option<Vec<String>>, yt_tracks: Option<Vec<YtTrack>>) -> CmdResult<Playlist> {
    state
        .db
        .add_to_playlist_mixed(playlist_id, &track_ids.unwrap_or_default(), &yt_tracks.unwrap_or_default())
        .map_err(err)
}

#[tauri::command]
pub fn remove_from_playlist(state: State<'_, AppState>, playlist_id: i64, entry_ids: Vec<i64>) -> CmdResult<Playlist> {
    state.db.remove_from_playlist(playlist_id, &entry_ids).map_err(err)
}

/// `entry_ids` is the full new order.
#[tauri::command]
pub fn reorder_playlist(state: State<'_, AppState>, playlist_id: i64, entry_ids: Vec<i64>) -> CmdResult<Playlist> {
    state.db.reorder_playlist(playlist_id, &entry_ids).map_err(err)
}

/// Queues every song in the playlist that is not on the device yet. Returns the
/// download ids (existing ones are reused for songs already queued).
#[tauri::command]
pub async fn download_playlist(state: State<'_, AppState>, yt: State<'_, YtState>, id: i64) -> CmdResult<Vec<String>> {
    let missing = state.db.playlist_missing_downloads(id).map_err(err)?;
    let mut ids = Vec::with_capacity(missing.len());
    let mut first_error = None;
    for t in &missing {
        let Some(track) = youtube::yt_from_track(t) else { continue };
        match youtube::start_download(&state, &yt, track).await {
            Ok(did) => ids.push(did),
            Err(e) => {
                tracing::warn!("download {}: {e}", t.title);
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        Some(e) if ids.is_empty() => Err(e),
        _ => Ok(ids),
    }
}
