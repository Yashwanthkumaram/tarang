//! Native playback commands (Android). Thin glue over the Kotlin `PlaybackPlugin`
//! (Media3 ExoPlayer in a foreground `MediaSessionService`); see docs/modules/playback.md.
//!
//! Events: on first use the plugin's `state`, `ended`, `error` and `remote` events are
//! subscribed through Rust-side IPC channels and re-emitted to the UI as
//! `playback://state`, `playback://ended`, `playback://error`, `playback://remote`.
//! Rust-side channels (instead of JS `addPluginListener`) keep the UI on the ordinary event
//! API and need no extra capability permissions.
//!
//! On desktop the UI plays through `<audio>`; these commands then report
//! "native playback is Android-only", except the cache ones, which report an empty cache.

use serde::Serialize;

/// Stream cache size when `stream.cache_mb` is unset or invalid.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const DEFAULT_CACHE_MB: u64 = 256;
/// Smallest cache we accept from the setting (Media3 needs room for at least one song).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const MIN_CACHE_MB: u64 = 32;

/// `playback_get_state` / `playback_load` result and `playback://state` payload.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct PlaybackStatus {
    pub playing: bool,
    pub play_when_ready: bool,
    pub buffering: bool,
    pub ended: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub buffered_ms: u64,
    pub loaded: bool,
    pub rate: f64,
    pub volume: f64,
    pub error: Option<String>,
}

/// `playback_cache_size` / `playback_clear_cache` result.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CacheInfo {
    pub bytes: u64,
}

/// Parses the `stream.cache_mb` setting.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn parse_cache_mb(value: Option<&str>) -> u64 {
    value
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|mb| mb.max(MIN_CACHE_MB))
        .unwrap_or(DEFAULT_CACHE_MB)
}

#[cfg(target_os = "android")]
pub use android::*;
#[cfg(not(target_os = "android"))]
pub use desktop::*;

#[cfg(target_os = "android")]
mod android {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use serde_json::{json, Value};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::plugin::{PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Emitter, Manager, State, Wry};

    use super::{parse_cache_mb, CacheInfo, PlaybackStatus};
    use crate::state::{err, AppState, CmdResult};

    /// Plugin events re-emitted to the UI as `playback://<name>`.
    const EVENTS: [&str; 4] = ["state", "ended", "error", "remote"];

    pub struct PlaybackState {
        pub plugin: PluginHandle<Wry>,
        listening: AtomicBool,
        listen_lock: Mutex<()>,
    }

    /// Registers the Kotlin `PlaybackPlugin` (add with `builder.plugin(...)` in lib.rs).
    pub fn plugin() -> TauriPlugin<Wry> {
        tauri::plugin::Builder::new("playback")
            .setup(|app, api| {
                let handle = api.register_android_plugin("dev.yashwanth.offlineplayer", "PlaybackPlugin")?;
                app.manage(PlaybackState { plugin: handle, listening: AtomicBool::new(false), listen_lock: Mutex::new(()) });
                Ok(())
            })
            .build()
    }

    /// Subscribes once to the plugin's events. Done lazily from a command (never on the main
    /// thread, where a blocking plugin call could deadlock with Kotlin's UI thread).
    fn ensure_listeners(app: &AppHandle, st: &PlaybackState) -> CmdResult<()> {
        if st.listening.load(Ordering::Acquire) {
            return Ok(());
        }
        let _guard = st.listen_lock.lock().map_err(err)?;
        if st.listening.load(Ordering::Acquire) {
            return Ok(());
        }
        for ev in EVENTS {
            let app = app.clone();
            let name = format!("playback://{ev}");
            let channel: Channel<Value> = Channel::new(move |body| {
                let payload = match body {
                    InvokeResponseBody::Json(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
                    InvokeResponseBody::Raw(b) => serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
                };
                let _ = app.emit(&name, payload);
                Ok(())
            });
            let _: Value = st
                .plugin
                .run_mobile_plugin("registerListener", json!({ "event": ev, "handler": channel }))
                .map_err(err)?;
        }
        st.listening.store(true, Ordering::Release);
        Ok(())
    }

    fn call<T: serde::de::DeserializeOwned>(app: &AppHandle, st: &PlaybackState, cmd: &str, args: Value) -> CmdResult<T> {
        ensure_listeners(app, st)?;
        st.plugin.run_mobile_plugin(cmd, args).map_err(err)
    }

    fn cache_mb(state: &AppState) -> u64 {
        parse_cache_mb(state.db.get_setting("stream.cache_mb").ok().flatten().as_deref())
    }

    /// Loads a song: `path` (local file) or `url` (stream, cached by `video_id`).
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn playback_load(
        app: AppHandle,
        st: State<'_, PlaybackState>,
        state: State<'_, AppState>,
        url: Option<String>,
        path: Option<String>,
        video_id: Option<String>,
        title: Option<String>,
        artist: Option<String>,
        album: Option<String>,
        artwork_url: Option<String>,
        autoplay: Option<bool>,
        start_ms: Option<u64>,
        headers: Option<std::collections::HashMap<String, String>>,
    ) -> CmdResult<PlaybackStatus> {
        if url.is_none() && path.is_none() {
            return Err("playback_load needs a path or a url".into());
        }
        let args = json!({
            "url": url, "path": path, "videoId": video_id,
            "title": title, "artist": artist, "album": album, "artworkUrl": artwork_url,
            "cacheMb": cache_mb(&state), "autoplay": autoplay.unwrap_or(false), "startMs": start_ms.unwrap_or(0),
            "headers": headers.unwrap_or_default(),
        });
        call(&app, &st, "load", args)
    }

    #[tauri::command]
    pub async fn playback_play(app: AppHandle, st: State<'_, PlaybackState>) -> CmdResult<()> {
        call::<Value>(&app, &st, "play", json!({})).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_pause(app: AppHandle, st: State<'_, PlaybackState>) -> CmdResult<()> {
        call::<Value>(&app, &st, "pause", json!({})).map(|_| ())
    }

    /// Stops and unloads the song (the notification goes away).
    #[tauri::command]
    pub async fn playback_stop(app: AppHandle, st: State<'_, PlaybackState>) -> CmdResult<()> {
        call::<Value>(&app, &st, "stop", json!({})).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_seek(app: AppHandle, st: State<'_, PlaybackState>, ms: u64) -> CmdResult<()> {
        call::<Value>(&app, &st, "seek", json!({ "ms": ms })).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_set_rate(app: AppHandle, st: State<'_, PlaybackState>, rate: f32) -> CmdResult<()> {
        call::<Value>(&app, &st, "setRate", json!({ "rate": rate })).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_set_volume(app: AppHandle, st: State<'_, PlaybackState>, volume: f32) -> CmdResult<()> {
        call::<Value>(&app, &st, "setVolume", json!({ "volume": volume })).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_set_queue_hints(app: AppHandle, st: State<'_, PlaybackState>, has_prev: bool, has_next: bool) -> CmdResult<()> {
        call::<Value>(&app, &st, "setQueueHints", json!({ "hasPrev": has_prev, "hasNext": has_next })).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_set_metadata(
        app: AppHandle,
        st: State<'_, PlaybackState>,
        title: Option<String>,
        artist: Option<String>,
        album: Option<String>,
        artwork_url: Option<String>,
    ) -> CmdResult<()> {
        let args = json!({ "title": title, "artist": artist, "album": album, "artworkUrl": artwork_url });
        call::<Value>(&app, &st, "setMetadata", args).map(|_| ())
    }

    /// Fills or empties the heart of the notification's like button.
    #[tauri::command]
    pub async fn playback_set_liked(app: AppHandle, st: State<'_, PlaybackState>, liked: bool) -> CmdResult<()> {
        call::<Value>(&app, &st, "setLiked", json!({ "liked": liked })).map(|_| ())
    }

    #[tauri::command]
    pub async fn playback_get_state(app: AppHandle, st: State<'_, PlaybackState>) -> CmdResult<PlaybackStatus> {
        call(&app, &st, "getState", json!({}))
    }

    /// Bytes used by the stream cache.
    #[tauri::command]
    pub async fn playback_cache_size(app: AppHandle, st: State<'_, PlaybackState>, state: State<'_, AppState>) -> CmdResult<CacheInfo> {
        call(&app, &st, "cacheSize", json!({ "cacheMb": cache_mb(&state) }))
    }

    /// Empties the stream cache (a song being streamed right now keeps its part). Returns bytes left.
    #[tauri::command]
    pub async fn playback_clear_cache(app: AppHandle, st: State<'_, PlaybackState>, state: State<'_, AppState>) -> CmdResult<CacheInfo> {
        call(&app, &st, "clearCache", json!({ "cacheMb": cache_mb(&state) }))
    }

    /// API-v2 name for emptying the stream cache (Settings → Storage).
    #[tauri::command]
    pub async fn clear_stream_cache(app: AppHandle, st: State<'_, PlaybackState>, state: State<'_, AppState>) -> CmdResult<()> {
        call::<CacheInfo>(&app, &st, "clearCache", json!({ "cacheMb": cache_mb(&state) })).map(|_| ())
    }
}

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::{CacheInfo, PlaybackStatus};
    use crate::state::CmdResult;

    const ANDROID_ONLY: &str = "native playback is Android-only";

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn playback_load(
        url: Option<String>,
        path: Option<String>,
        video_id: Option<String>,
        title: Option<String>,
        artist: Option<String>,
        album: Option<String>,
        artwork_url: Option<String>,
        autoplay: Option<bool>,
        start_ms: Option<u64>,
        headers: Option<std::collections::HashMap<String, String>>,
    ) -> CmdResult<PlaybackStatus> {
        let _ = (url, path, video_id, title, artist, album, artwork_url, autoplay, start_ms, headers);
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_play() -> CmdResult<()> {
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_pause() -> CmdResult<()> {
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_stop() -> CmdResult<()> {
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_seek(ms: u64) -> CmdResult<()> {
        let _ = ms;
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_set_rate(rate: f32) -> CmdResult<()> {
        let _ = rate;
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_set_volume(volume: f32) -> CmdResult<()> {
        let _ = volume;
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_set_queue_hints(has_prev: bool, has_next: bool) -> CmdResult<()> {
        let _ = (has_prev, has_next);
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_set_metadata(title: Option<String>, artist: Option<String>, album: Option<String>, artwork_url: Option<String>) -> CmdResult<()> {
        let _ = (title, artist, album, artwork_url);
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_set_liked(liked: bool) -> CmdResult<()> {
        let _ = liked;
        Err(ANDROID_ONLY.into())
    }

    #[tauri::command]
    pub async fn playback_get_state() -> CmdResult<PlaybackStatus> {
        Err(ANDROID_ONLY.into())
    }

    /// The desktop player has no stream cache of its own (the webview's HTTP cache is not ours).
    #[tauri::command]
    pub async fn playback_cache_size() -> CmdResult<CacheInfo> {
        Ok(CacheInfo::default())
    }

    #[tauri::command]
    pub async fn playback_clear_cache() -> CmdResult<CacheInfo> {
        Ok(CacheInfo::default())
    }

    /// API-v2 name for emptying the stream cache; nothing to clear on desktop.
    #[tauri::command]
    pub async fn clear_stream_cache() -> CmdResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_mb_setting() {
        assert_eq!(parse_cache_mb(None), DEFAULT_CACHE_MB);
        assert_eq!(parse_cache_mb(Some("abc")), DEFAULT_CACHE_MB);
        assert_eq!(parse_cache_mb(Some(" 512 ")), 512);
        assert_eq!(parse_cache_mb(Some("1")), MIN_CACHE_MB);
    }
}
