//! YouTube Music search and yt-dlp downloads.
//!
//! Search is shared Rust (`offline_core::youtube`). Downloads differ per platform:
//! desktop runs the `yt-dlp` binary from the core; Android calls the Kotlin
//! `YtdlpPlugin` (bundled Python + yt-dlp with self-update) through Tauri's
//! mobile plugin bridge. Both paths end in [`index_file`], which fills in the song's
//! existing library row (keyed by video id) instead of adding a duplicate.

use std::path::Path;
use std::sync::Mutex;

use offline_core::db::FileFacts;
use offline_core::models::{Download, Track};
use offline_core::youtube::{self, YtTrack};
use tauri::State;

use crate::state::{err, AppState, CmdResult};

#[tauri::command]
pub async fn youtube_search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> CmdResult<Vec<YtTrack>> {
    let mut hits = youtube::search(&query, limit.unwrap_or(30)).await.map_err(err)?;
    state.db.match_local(&mut hits).map_err(err)?;
    Ok(hits)
}

/// Tags the downloaded file from the search metadata and records it on the song's row.
pub fn index_file(db: &offline_core::db::Db, path: &Path, track: &YtTrack) {
    let _ = offline_core::tags::write_basic(path, &track.title, Some(&track.artist), track.album.as_deref());
    let meta = offline_core::tags::read(path);
    let facts = FileFacts {
        format: meta.format,
        sample_rate: meta.sample_rate,
        channels: meta.channels,
        bitrate_kbps: meta.bitrate_kbps,
        size_bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        duration_secs: meta.duration_secs,
    };
    if let Err(e) = db.attach_download(track, &path.to_string_lossy(), &facts) {
        tracing::error!("index download {}: {e:#}", path.display());
    }
}

/// A library row as the search-result shape the download paths take.
pub fn yt_from_track(t: &Track) -> Option<YtTrack> {
    Some(YtTrack {
        video_id: t.video_id.clone()?,
        title: t.title.clone(),
        artist: t.artist.clone().unwrap_or_else(|| "Unknown artist".into()),
        album: t.album.clone(),
        duration_secs: (t.duration_secs > 0.0).then_some(t.duration_secs),
        thumbnail: t.thumbnail.clone(),
        explicit: false,
        local_track_id: None,
    })
}

// ============================================================ desktop (yt-dlp binary)

#[cfg(not(target_os = "android"))]
mod platform {
    use super::*;
    use offline_core::youtube::ytdlp;

    #[derive(Default)]
    pub struct YtState {
        pub jobs: ytdlp::Jobs,
    }

    pub async fn download(state: &AppState, yt: &YtState, track: YtTrack, track_id: String) -> CmdResult<String> {
        if let Some(id) = yt.jobs.find_open(&track.video_id) {
            return Ok(id);
        }
        let bin = ytdlp::ensure_binary(&state.data_dir).await.map_err(err)?;
        let dest = state.download_dir();
        let db = state.db.clone();
        let on_done: ytdlp::OnDone = std::sync::Arc::new(move |path: std::path::PathBuf, track: YtTrack| index_file(&db, &path, &track));
        Ok(yt.jobs.start(bin, track, Some(track_id), &dest, on_done))
    }

    pub async fn list(_state: &AppState, yt: &YtState) -> Vec<Download> {
        yt.jobs.list()
    }

    pub async fn pause(yt: &YtState, id: &str) -> CmdResult<()> {
        yt.jobs.pause(id).map_err(err)
    }

    pub async fn resume(yt: &YtState, id: &str) -> CmdResult<()> {
        yt.jobs.resume(id).map_err(err)
    }

    pub async fn remove(yt: &YtState, id: &str) {
        yt.jobs.remove(id);
    }

    pub async fn clear_finished(yt: &YtState) {
        yt.jobs.clear_finished();
    }

    pub async fn version(state: &AppState) -> CmdResult<String> {
        match ytdlp::find_binary(&state.data_dir) {
            Some(bin) => ytdlp::version(&bin).await.map_err(err),
            None => Ok("not installed (downloads on first use)".into()),
        }
    }

    /// Direct audio URL for streaming (yt-dlp -g). Returns (url, resolve ms).
    pub async fn stream_url(state: &AppState, video_id: &str) -> CmdResult<(String, u64)> {
        let bin = ytdlp::ensure_binary(&state.data_dir).await.map_err(err)?;
        let t = std::time::Instant::now();
        let resolve = |xargs: &'static str| {
            let bin = bin.clone();
            async move {
                let out = offline_core::youtube::ytdlp::command(&bin)
                    .args(["--no-playlist", "--no-warnings", "-f", "140/bestaudio[ext=m4a]/bestaudio",
                           "--extractor-args", xargs, "-g"])
                    .arg(format!("https://music.youtube.com/watch?v={video_id}"))
                    .output().await.map_err(err)?;
                let text = String::from_utf8_lossy(&out.stdout);
                text.lines().map(str::trim).find(|l| l.starts_with("http")).map(str::to_string)
                    .ok_or_else(|| String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("no stream URL").to_string())
            }
        };
        let xargs = ytdlp::extractor_args();
        let url = match resolve(xargs).await {
            // Address blocked by YouTube: retry with the fallback clients (D41).
            Err(e) if xargs != ytdlp::BLOCKED_EXTRACTOR_ARGS && ytdlp::is_address_block(&e) => {
                let url = resolve(ytdlp::BLOCKED_EXTRACTOR_ARGS).await.map_err(|_| e)?;
                ytdlp::mark_blocked();
                url
            }
            r => r?,
        };
        Ok((url, t.elapsed().as_millis() as u64))
    }

    pub async fn update(state: &AppState) -> CmdResult<String> {
        let bin = ytdlp::ensure_binary(&state.data_dir).await.map_err(err)?;
        ytdlp::update(&bin).await.map_err(err)
    }
}

// ============================================================ android (Kotlin plugin)

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use offline_core::models::{DownloadKind, DownloadState};
    use serde::{Deserialize, Serialize};
    use std::collections::{HashMap, HashSet};
    use tauri::plugin::PluginHandle;
    use tauri::Wry;

    /// One download as the Rust side tracks it. The plugin job behind it is replaced on
    /// resume/retry (a cancelled plugin id cannot be reused), so `plugin_id` changes
    /// while the id the UI sees stays the same. yt-dlp continues the `.part` file.
    pub struct AJob {
        track: YtTrack,
        track_id: Option<String>,
        plugin_id: String,
        paused: bool,
        state: DownloadState,
        progress: f64,
    }

    /// Handle to the Kotlin `YtdlpPlugin`, registered in `lib.rs`.
    pub struct YtState {
        pub plugin: PluginHandle<Wry>,
        /// Every download in the queue, by the id the UI sees.
        pub pending: Mutex<HashMap<String, AJob>>,
        /// Download ids whose file was already indexed.
        pub indexed: Mutex<HashSet<String>>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DownloadArgs { id: String, url: String, dest: String, name: String }

    #[derive(Deserialize)]
    struct IdResponse { #[allow(dead_code)] id: String }

    #[derive(Deserialize)]
    struct KJob { id: String, progress: f64, eta: i64, state: String, path: String, error: String }

    #[derive(Deserialize)]
    struct StatusResponse { ready: bool, error: String, jobs: Vec<KJob> }

    #[derive(Deserialize)]
    struct VersionResponse { version: String }

    #[derive(Serialize)]
    struct IdArgs<'a> { id: &'a str }

    fn start_plugin(state: &AppState, yt: &YtState, plugin_id: &str, track: &YtTrack) -> CmdResult<()> {
        let args = DownloadArgs { id: plugin_id.to_string(), url: track.url(), dest: state.download_dir().to_string_lossy().to_string(), name: track.file_stem() };
        let _: IdResponse = yt.plugin.run_mobile_plugin("download", args).map_err(err)?;
        Ok(())
    }

    fn cancel_plugin(yt: &YtState, plugin_id: &str) {
        let _: Result<serde_json::Value, _> = yt.plugin.run_mobile_plugin("cancel", IdArgs { id: plugin_id });
    }

    pub async fn download(state: &AppState, yt: &YtState, track: YtTrack, track_id: String) -> CmdResult<String> {
        let open = yt.pending.lock().unwrap().iter()
            .find(|(_, j)| j.track.video_id == track.video_id && matches!(j.state, DownloadState::Queued | DownloadState::Active | DownloadState::Paused))
            .map(|(id, _)| id.clone());
        if let Some(id) = open {
            return Ok(id);
        }
        let id = offline_core::new_id();
        start_plugin(state, yt, &id, &track)?;
        yt.pending.lock().unwrap().insert(id.clone(), AJob { track, track_id: Some(track_id), plugin_id: id.clone(), paused: false, state: DownloadState::Queued, progress: 0.0 });
        Ok(id)
    }

    pub async fn list(state: &AppState, yt: &YtState) -> Vec<Download> {
        let st = yt.plugin.run_mobile_plugin::<StatusResponse>("status", ()).ok();
        let mut by_plugin: HashMap<String, KJob> = HashMap::new();
        let (ready, setup_error) = match st {
            Some(s) => { let r = (s.ready, s.error); for j in s.jobs { by_plugin.insert(j.id.clone(), j); } r }
            None => (true, String::new()),
        };
        let mut to_index: Vec<(String, String, YtTrack)> = Vec::new();
        let mut out = Vec::new();
        {
            let mut jobs = yt.pending.lock().unwrap();
            for (id, j) in jobs.iter_mut() {
                let mut error = None;
                let mut eta = None;
                if j.paused {
                    j.state = DownloadState::Paused;
                } else if let Some(k) = by_plugin.remove(&j.plugin_id) {
                    j.state = match k.state.as_str() { "active" => DownloadState::Active, "done" => DownloadState::Done, "error" => DownloadState::Error, _ => DownloadState::Queued };
                    j.progress = if j.state == DownloadState::Done { 1.0 } else { (k.progress / 100.0).clamp(0.0, 1.0) };
                    eta = (k.eta >= 0).then_some(k.eta as u64);
                    if !k.error.is_empty() { error = Some(k.error); }
                    if j.state == DownloadState::Done && !k.path.is_empty() {
                        to_index.push((id.clone(), k.path, j.track.clone()));
                    }
                    if !ready && !setup_error.is_empty() && j.state == DownloadState::Queued {
                        error = Some(format!("yt-dlp setup failed: {setup_error}"));
                    }
                } else if j.state != DownloadState::Done {
                    j.state = DownloadState::Error;
                    error = Some("download was interrupted".into());
                }
                out.push(Download {
                    id: id.clone(), kind: DownloadKind::Youtube,
                    name: format!("{} - {}", j.track.artist, j.track.title),
                    state: j.state, progress: j.progress, downloaded_bytes: 0, total_bytes: 0, speed_bps: 0,
                    eta_secs: eta, track_id: j.track_id.clone(), error,
                });
            }
        }
        for (id, path, track) in to_index {
            if yt.indexed.lock().unwrap().insert(id) {
                index_file(&state.db, Path::new(&path), &track);
            }
        }
        out
    }

    pub async fn pause(yt: &YtState, id: &str) -> CmdResult<()> {
        let plugin_id = {
            let mut jobs = yt.pending.lock().unwrap();
            let j = jobs.get_mut(id).ok_or("unknown download")?;
            if matches!(j.state, DownloadState::Done | DownloadState::Error) {
                return Err("only running downloads can be paused".into());
            }
            j.paused = true;
            j.state = DownloadState::Paused;
            j.plugin_id.clone()
        };
        cancel_plugin(yt, &plugin_id);
        Ok(())
    }

    /// Resume and retry: start a fresh plugin job for the same song.
    pub async fn resume(state: &AppState, yt: &YtState, id: &str) -> CmdResult<()> {
        let track = {
            let jobs = yt.pending.lock().unwrap();
            let j = jobs.get(id).ok_or("unknown download")?;
            if !(j.paused || j.state == DownloadState::Error) {
                return Ok(());
            }
            j.track.clone()
        };
        let plugin_id = offline_core::new_id();
        start_plugin(state, yt, &plugin_id, &track)?;
        if let Some(j) = yt.pending.lock().unwrap().get_mut(id) {
            j.plugin_id = plugin_id;
            j.paused = false;
            j.state = DownloadState::Queued;
        }
        Ok(())
    }

    pub async fn remove(yt: &YtState, id: &str) {
        let removed = yt.pending.lock().unwrap().remove(id);
        if let Some(j) = removed {
            cancel_plugin(yt, &j.plugin_id);
        }
    }

    pub async fn clear_finished(yt: &YtState) {
        let done: Vec<(String, String)> = yt.pending.lock().unwrap().iter()
            .filter(|(_, j)| j.state == DownloadState::Done)
            .map(|(id, j)| (id.clone(), j.plugin_id.clone()))
            .collect();
        for (id, plugin_id) in done {
            yt.pending.lock().unwrap().remove(&id);
            cancel_plugin(yt, &plugin_id); // drops the finished job from the plugin's list
        }
    }

    pub async fn version(_state: &AppState, yt: &YtState) -> CmdResult<String> {
        let r: VersionResponse = yt.plugin.run_mobile_plugin("version", ()).map_err(err)?;
        Ok(r.version)
    }

    pub async fn stream_url(yt: &YtState, video_id: &str) -> CmdResult<(String, u64)> {
        #[derive(Serialize)]
        struct UrlArgs { url: String }
        #[derive(Deserialize)]
        struct R { url: String, ms: u64 }
        let r: R = yt.plugin.run_mobile_plugin("resolve", UrlArgs { url: format!("https://music.youtube.com/watch?v={video_id}") }).map_err(err)?;
        Ok((r.url, r.ms))
    }

    pub async fn update(yt: &YtState) -> CmdResult<String> {
        #[derive(Deserialize)]
        struct R { version: String, status: String }
        let r: R = yt.plugin.run_mobile_plugin("update", ()).map_err(err)?;
        Ok(format!("{} ({})", r.version, r.status))
    }
}

pub use platform::YtState;

/// Queues a download for a library row or search result. Returns the download id (an
/// already queued/active/paused download of the same song is reused).
pub async fn start_download(state: &AppState, yt: &YtState, track: YtTrack) -> CmdResult<String> {
    let row = state.db.ensure_youtube_track(&track).map_err(err)?;
    if row.downloaded {
        return Err("Already downloaded".into());
    }
    platform::download(state, yt, track, row.id).await
}

/// Downloads a YouTube Music result (from search). The finished file fills in the song's
/// library row; nothing is duplicated.
#[tauri::command]
pub async fn youtube_download(state: State<'_, AppState>, yt: State<'_, YtState>, track: YtTrack) -> CmdResult<String> {
    start_download(&state, &yt, track).await
}

/// Downloads a YouTube song that is already in the library (liked, in a playlist).
#[tauri::command]
pub async fn download_track(state: State<'_, AppState>, yt: State<'_, YtState>, id: String) -> CmdResult<String> {
    let t = state.db.get_track(&id).map_err(err)?.ok_or("track not found")?;
    if t.downloaded {
        return Err("Already downloaded".into());
    }
    let track = yt_from_track(&t).ok_or("This song has no YouTube Music id, so it cannot be downloaded")?;
    start_download(&state, &yt, track).await
}

/// Called by `list_downloads` so YouTube jobs appear in the queue.
pub async fn list(state: &AppState, yt: &YtState) -> Vec<Download> {
    platform::list(state, yt).await
}

pub async fn pause(yt: &YtState, id: &str) -> CmdResult<()> {
    platform::pause(yt, id).await
}

pub async fn resume(state: &AppState, yt: &YtState, id: &str) -> CmdResult<()> {
    #[cfg(not(target_os = "android"))]
    { let _ = state; platform::resume(yt, id).await }
    #[cfg(target_os = "android")]
    { platform::resume(state, yt, id).await }
}

pub async fn remove(yt: &YtState, id: &str) {
    platform::remove(yt, id).await
}

pub async fn clear_finished(yt: &YtState) {
    platform::clear_finished(yt).await
}

#[tauri::command]
pub async fn youtube_version(state: State<'_, AppState>, yt: State<'_, YtState>) -> CmdResult<String> {
    #[cfg(not(target_os = "android"))]
    { let _ = &yt; platform::version(&state).await }
    #[cfg(target_os = "android")]
    { platform::version(&state, &yt).await }
}

#[tauri::command]
pub async fn youtube_update(state: State<'_, AppState>, yt: State<'_, YtState>) -> CmdResult<String> {
    #[cfg(not(target_os = "android"))]
    { let _ = &yt; platform::update(&state).await }
    #[cfg(target_os = "android")]
    { let _ = &state; platform::update(&yt).await }
}

// ============================================================ stream links: cache + prefetch
//
// Resolving a link costs ~1.5 s on the PC and 11–14 s on the phone (yt-dlp on a phone CPU
// and network). Links stay valid until the `expire=` timestamp in the URL (~6 h), so:
//  * every resolved link is cached per video id until shortly before it expires;
//  * concurrent requests for the same id share one resolve (no duplicate yt-dlp runs);
//  * `youtube_prefetch` resolves links in the background for search results and the
//    next songs in the queue, so pressing Play usually hits the cache. (DECISIONS D22)

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::sync::{OnceCell, Semaphore};

/// (url, resolve ms, unix time it stops being usable)
type Resolved = Result<(String, u64, i64), String>;

/// At most this many yt-dlp resolves run at once (each is a Python process on Android).
const MAX_PARALLEL_RESOLVES: usize = 2;
/// Stop using a link this long before YouTube's expiry.
const EXPIRY_MARGIN_SECS: i64 = 10 * 60;
/// Used when a URL carries no `expire=` parameter.
const DEFAULT_TTL_SECS: i64 = 60 * 60;
/// Prefetch requests beyond this many ids are ignored.
const MAX_PREFETCH: usize = 5;

fn links() -> &'static Mutex<HashMap<String, Arc<OnceCell<Resolved>>>> {
    static L: OnceLock<Mutex<HashMap<String, Arc<OnceCell<Resolved>>>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

fn resolve_slots() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(MAX_PARALLEL_RESOLVES))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Unix time after which `url` should not be used.
fn usable_until(url: &str) -> i64 {
    url.split(['?', '&'])
        .find_map(|kv| kv.strip_prefix("expire="))
        .and_then(|v| v.parse::<i64>().ok())
        .map(|e| e - EXPIRY_MARGIN_SECS)
        .unwrap_or_else(|| now() + DEFAULT_TTL_SECS)
}

async fn resolve_uncached(app: &AppHandle, video_id: &str) -> Result<(String, u64), String> {
    let _slot = resolve_slots().acquire().await.map_err(err)?;
    #[cfg(not(target_os = "android"))]
    {
        let state = app.state::<AppState>();
        platform::stream_url(&state, video_id).await
    }
    #[cfg(target_os = "android")]
    {
        let yt = app.state::<YtState>();
        platform::stream_url(&yt, video_id).await
    }
}

/// Returns a usable link for `video_id` and whether it came from the cache.
async fn resolve_cached(app: &AppHandle, video_id: &str) -> Result<(String, u64, bool), String> {
    let cell = {
        let mut map = links().lock().unwrap();
        let stale = match map.get(video_id).and_then(|c| c.get()) {
            Some(Ok((_, _, until))) => *until <= now(),
            Some(Err(_)) => true,
            None => false, // absent, or a resolve is in flight: join it
        };
        if stale {
            map.remove(video_id);
        }
        map.entry(video_id.to_string()).or_insert_with(|| Arc::new(OnceCell::new())).clone()
    };
    let mut fresh = false;
    let r = cell
        .get_or_init(|| async {
            fresh = true;
            resolve_uncached(app, video_id).await.map(|(url, ms)| { let until = usable_until(&url); (url, ms, until) })
        })
        .await
        .clone();
    match r {
        Ok((url, ms, _)) => Ok((url, ms, !fresh)),
        Err(e) => {
            links().lock().unwrap().remove(video_id); // allow a retry
            Err(e)
        }
    }
}

/// Direct, device-bound audio URL for streaming a YouTube Music song:
/// `{ url, resolve_ms, cached }`. googlevideo URLs are tied to the requesting IP and
/// expire after a few hours, so they are resolved on the device that plays and cached.
#[tauri::command]
pub async fn youtube_stream_url(app: AppHandle, video_id: String) -> CmdResult<serde_json::Value> {
    let (url, ms, cached) = resolve_cached(&app, &video_id).await?;
    Ok(serde_json::json!({ "url": url, "resolve_ms": ms, "cached": cached }))
}

/// Resolves links in the background so a later Play hits the cache. Returns at once.
#[tauri::command]
pub fn youtube_prefetch(app: AppHandle, video_ids: Vec<String>) {
    for id in video_ids.into_iter().take(MAX_PREFETCH) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = resolve_cached(&app, &id).await {
                tracing::info!("prefetch {id} failed: {e}");
            }
        });
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn expiry_comes_from_the_url() {
        let u = "https://x.googlevideo.com/videoplayback?expire=2000000000&ei=abc";
        assert_eq!(usable_until(u), 2_000_000_000 - EXPIRY_MARGIN_SECS);
        assert!(usable_until("https://example.com/a.m4a") > now());
    }
}
