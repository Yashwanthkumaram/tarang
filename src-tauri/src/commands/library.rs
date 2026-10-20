//! Library queries: tracks, voice recordings, stats, albums/artists, likes and plays.
//! Thin wrappers over `offline_core::db::Db`; see docs/API-v2.md for the shapes.

use offline_core::db::{TrackFilter, TrackSort};
use offline_core::models::{Group, Kind, LibraryStats, Track, YtTrack};
use tauri::State;

use crate::state::{err, AppState, CmdResult};

const DEFAULT_LIMIT: u32 = 500;
const DEFAULT_RECENT: u32 = 20;

fn non_empty(q: Option<String>) -> Option<String> {
    q.filter(|q| !q.trim().is_empty())
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> CmdResult<LibraryStats> {
    state.db.stats().map_err(err)
}

/// `kind`: "music" | "voice" | "unsure"; `filter`: "all" | "liked" | "downloaded" | "device";
/// `sort`: "recent" | "title" | "artist" | "album" | "duration".
#[tauri::command]
pub fn list_tracks(
    state: State<'_, AppState>,
    kind: String,
    filter: Option<String>,
    query: Option<String>,
    sort: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<Track>> {
    let filter = TrackFilter::parse(filter.as_deref().unwrap_or("all"));
    let sort = TrackSort::parse(sort.as_deref().unwrap_or("recent"));
    let q = non_empty(query);
    state.db.list_tracks(Kind::parse(&kind), filter, q.as_deref(), sort, limit.unwrap_or(DEFAULT_LIMIT)).map_err(err)
}

#[tauri::command]
pub fn get_track(state: State<'_, AppState>, id: String) -> CmdResult<Option<Track>> {
    state.db.get_track(&id).map_err(err)
}

/// Recently played songs, newest first.
#[tauri::command]
pub fn list_recent(state: State<'_, AppState>, limit: Option<u32>) -> CmdResult<Vec<Track>> {
    state.db.list_recent(limit.unwrap_or(DEFAULT_RECENT)).map_err(err)
}

#[tauri::command]
pub fn list_albums(state: State<'_, AppState>, query: Option<String>) -> CmdResult<Vec<Group>> {
    state.db.list_albums(non_empty(query).as_deref()).map_err(err)
}

#[tauri::command]
pub fn list_artists(state: State<'_, AppState>, query: Option<String>) -> CmdResult<Vec<Group>> {
    state.db.list_artists(non_empty(query).as_deref()).map_err(err)
}

#[tauri::command]
pub fn set_liked(state: State<'_, AppState>, id: String, liked: bool) -> CmdResult<Track> {
    state.db.set_liked(&id, liked).map_err(err)
}

/// Likes a YouTube result; creates a stream-only library row when needed.
#[tauri::command]
pub fn like_youtube(state: State<'_, AppState>, track: YtTrack, liked: bool) -> CmdResult<Track> {
    state.db.like_youtube(&track, liked).map_err(err)
}

/// play_count + 1, last_played_at = now. A stream started from a search result has no
/// library id yet: pass the result as `track` (any `id`) and its row is created.
#[tauri::command]
pub fn record_play(state: State<'_, AppState>, id: String, track: Option<YtTrack>) -> CmdResult<()> {
    let id = match (state.db.get_track(&id).map_err(err)?, track) {
        (Some(t), _) => t.id,
        (None, Some(yt)) => state.db.ensure_youtube_track(&yt).map_err(err)?.id,
        (None, None) => return Err("track not found".into()),
    };
    state.db.record_play(&id).map_err(err)
}

/// User override from the review queue: "music" or "voice".
#[tauri::command]
pub fn set_track_kind(state: State<'_, AppState>, id: String, kind: String) -> CmdResult<()> {
    state.db.set_track_kind(&id, Kind::parse(&kind)).map_err(err)
}
