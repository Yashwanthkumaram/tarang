# Module: Native playback (Android)

## What it is
On Android, songs play in a native **Media3 ExoPlayer** inside a foreground
**`MediaSessionService`**, not in the WebView's `<audio>` (which stalls on the asset
protocol, holds no audio focus and dies in the background; D9, D21). Media3 supplies the
media notification, lock-screen controls, Bluetooth/headset buttons, audio focus and
"becoming noisy" (headphones unplugged → pause). The queue stays in the UI (`player.js`).

Desktop keeps the HTML engine (`src/js/engine/html.js`); `engine/index.js` picks
`engine/android.js` on Android and falls back to HTML if the plugin is missing.

```
player.js ── engine/android.js ──invoke──▶ commands/playback.rs ──run_mobile_plugin──▶ PlaybackPlugin.kt
     ▲               ▲                                                                   │
     │         listen("playback://*") ◀── app.emit ◀── Rust IPC Channel ◀── Plugin.trigger┘
     │                                                                                   ▼
     └──────── remote {next/prev/like/…} ◀───── RemotePlayer ◀── MediaSession ◀── PlaybackCore (ExoPlayer, SimpleCache)
                                                                    ▲
                                                        PlaybackService (MediaSessionService)
```

## Files
| File | Role |
|---|---|
| `src-tauri/gen/android/app/src/main/java/dev/yashwanth/offlineplayer/PlaybackCore.kt` | process-wide ExoPlayer, stream cache, state/event helpers, `RemotePlayer` |
| `…/PlaybackService.kt` | `MediaSessionService`: wraps the player in a `MediaSession`, like button, stops on swipe-away |
| `…/PlaybackPlugin.kt` | Tauri mobile plugin `playback`: the commands below, posts work to the main looper |
| `src-tauri/src/commands/playback.rs` | `playback_*` Tauri commands (async), event bridge, `stream.cache_mb` lookup; desktop stubs |
| `src/js/engine/android.js` | engine interface (docs/API-v2.md "Playback engine") over the commands |
| `AndroidManifest.xml` | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`, the `<service>` |
| `MainActivity.kt` | asks for `POST_NOTIFICATIONS` (Android 13+) together with the audio permission |
| `app/build.gradle.kts` | `androidx.media3:media3-{exoplayer,session,datasource,database}:1.11.1` |

## Tauri commands (Rust → Kotlin)
| command | args (JS camelCase) | returns | Kotlin |
|---|---|---|---|
| `playback_load` | `url?, path?, videoId?, title?, artist?, album?, artworkUrl?, autoplay?, startMs?` | `PlaybackStatus` | `load` (+ `cacheMb` from the setting) |
| `playback_play` / `playback_pause` / `playback_stop` | – | – | `play` / `pause` / `stop` |
| `playback_seek` | `ms` | – | `seek` |
| `playback_set_rate` | `rate` | – | `setRate` (0.25–4) |
| `playback_set_volume` | `volume` 0..1 | – | `setVolume` |
| `playback_set_queue_hints` | `hasPrev, hasNext` | – | `setQueueHints` |
| `playback_set_metadata` | `title?, artist?, album?, artworkUrl?` | – | `setMetadata` (no re-buffer) |
| `playback_set_liked` | `liked` | – | `setLiked` (heart icon) |
| `playback_get_state` | – | `PlaybackStatus` | `getState` |
| `playback_cache_size` | – | `{ bytes }` | `cacheSize` |
| `playback_clear_cache` | – | `{ bytes }` (left) | `clearCache` |
| `clear_stream_cache` | – | – (API-v2 name used by Settings → Storage; desktop: no-op) | `clearCache` |

`PlaybackStatus = { playing, play_when_ready, buffering, ended, position_ms, duration_ms,
buffered_ms, loaded, rate, volume, error? }`. `playing` is "audio is coming out";
`play_when_ready` is the intent (stays true while buffering or ducked).

On desktop every command except the cache pair returns `"native playback is Android-only"`;
the cache pair returns `{ bytes: 0 }`.

## Events
Kotlin calls `Plugin.trigger(event, payload)`. On the first `playback_*` command, Rust
registers one IPC `Channel` per event through the plugin's built-in `registerListener`
and re-emits each payload with `app.emit`:

| UI event | payload | when |
|---|---|---|
| `playback://state` | `PlaybackStatus` | play/pause, buffering, ended, error, seek |
| `playback://ended` | `PlaybackStatus` | a song finished (once) |
| `playback://error` | `{ message, code, http_status }` | ExoPlayer error; `http_status` 403/410 = stream link expired |
| `playback://remote` | `{ action, position? }` | notification / lock screen / headset / Bluetooth |

Remote `action`s: `play`, `pause`, `seek` (`position` in seconds) are **already executed**
natively when the event arrives (so they work with the WebView asleep); `next`, `prev`,
`like` are **only reported** — the UI owns the queue and the library. The like button
flips its icon immediately; the UI should confirm with `playback_set_liked`.

Events reach the WebView through `evaluateJavascript`, which runs while the app is in the
background; JS timers do not (they are throttled), so `android.js` polls `getState` every
500 ms only while playing and visible, purely for the progress bar.

## How things work
* **Threads.** Plugin commands arrive on a Rust thread; everything touching ExoPlayer is
  posted to the main looper. Rust commands are `async` so a blocking plugin call never runs
  on the main thread (it would deadlock).
* **Player vs service.** The ExoPlayer lives in `PlaybackCore` (a process singleton), not
  in the service, so commands work whether or not the service runs. Every `load`/`play`
  calls `startService` (idempotent); the service builds the `MediaSession` and adds it to
  itself (`addSession`) because no `MediaController` ever binds. Media3 moves the service
  to the foreground while playing and keeps it there up to 10 min after a pause/end, which
  covers the gap while the UI resolves the next stream in the background.
* **UI vs remote calls.** The UI drives the raw `ExoPlayer`; the session gets a
  `RemotePlayer` (`ForwardingPlayer`) around it. Anything that reaches the player through
  `RemotePlayer` came from outside the app and is reported as `remote`. It also adds
  next/previous to the available commands from the queue hints and re-announces them to
  the session when the hints change.
* **Local files** play by absolute path (`file://`), through a plain `DefaultDataSource` —
  no asset protocol, no Blob URLs (supersedes D21 on Android).
* **Streams** go through `CacheDataSource` → `SimpleCache` in `<cacheDir>/stream-cache`
  with `LeastRecentlyUsedCacheEvictor(stream.cache_mb MB)` (default 256, min 32). Because
  googlevideo URLs change on every resolve, the cache key is `yt:<videoId>:<itag>`, so a
  song streamed again plays from disk even with a new link. The HTTP user agent is the
  WebView's (the agent that played these links before, D22). A changed `stream.cache_mb`
  takes effect on the next stream `load` (the cache is reopened with the new limit).
  Android may also clear `cacheDir` under storage pressure, which is fine.
* **Swipe-away.** `onTaskRemoved` pauses and stops the service: without the WebView the
  queue cannot advance, and a reopened UI would not know about an orphan song.

## Debugging
```fish
adb logcat -s Playback PlaybackPlugin ExoPlayerImpl MediaSessionService RustStdoutStderr
adb shell dumpsys media_session      # session state, actions, metadata
```
In the WebView console: `localStorage.engine = 'html'` forces the old `<audio>` engine.

## Known limits
* An expired stream link (403/410) surfaces as an error; `player.js` should re-resolve
  (`youtube_stream_url`) and `load` again at the same position (`startMs`).
* No gapless/crossfade natively yet (one item at a time). Preloading the next song as a
  second `MediaItem` would enable both.
* Android Auto / `MediaBrowser` browsing is not offered (the service answers only sessions).

## Registration
`lib.rs` adds `playback::plugin()` on Android (after `ytdlp_plugin()`) and registers all the
commands above on every platform (D42). Verified on the phone: a stream and a local file
both reach `AudioTrack state:started`, and the Media3 notification (category transport,
prev / play-pause / like) appears.
