# Module: YouTube Music search & yt-dlp downloads

## What it does
Searches YouTube Music for songs and downloads them as audio-only m4a files, tagged and
indexed as source `youtube`.

| Part | Where | Platform |
|---|---|---|
| Search (`youtube::search`) | `crates/core/src/youtube.rs` via `ytmapi-rs` (YouTube's internal API, no account) | all |
| Download, desktop (`youtube::ytdlp`) | same file; runs the `yt-dlp` binary with progress parsing | Linux |
| Download, Android | `gen/android/.../YtdlpPlugin.kt` using `youtubedl-android` (bundled Python + yt-dlp) | Android |
| Glue | `src-tauri/src/commands/youtube.rs` picks the platform path and indexes finished files | all |

## Why YouTube Music search, not YouTube
Song search returns real tracks with artist, album and duration and leaves out lyric videos,
AMVs and live rips (measured: 20 clean song results in 1.1 s). Plain YouTube search returned
the same song five times in different uploads.

## Search client cache
`youtube::search` used to build a new `ytmapi-rs` client and fetch a fresh visitor token
(a full GET of music.youtube.com) on every call, so each search paid two round trips plus
a TLS handshake. The client is now built once (`client()`, a `tokio::sync::Mutex<Option<..>>`
behind a `OnceLock`) and reused: the connection pool keeps the TLS connection alive
(`pool_idle_timeout` 120 s, TCP keep-alive 30 s) and the token is refreshed after 6 h.
A failed search is retried once on the same client (a dropped pooled connection is simply
reopened), then once more with a fresh token. `youtube::warm_up()` builds the client at
app start (`lib.rs`, background task) so the first search is already warm.

Measured (desktop, `cargo run -p offline_core --example yt -- search "power kanye west" --repeat 4`):
cold 1.06–1.26 s, cached 0.45–0.68 s. Phone (Samsung SM-S948B, lossy Wi-Fi): 4.7–6.0 s per
search before, 0.8–1.3 s typical after (first search after >2 min idle: 1–5 s, a new
connection on that network).

## Desktop yt-dlp
`ensure_binary` uses a `yt-dlp` on PATH, else downloads the standalone Linux build (no
Python needed) into `<app data>/bin/`. Downloads use
`-f 140/bestaudio[ext=m4a]/bestaudio` (itag 140 is the standard 128 kbps AAC, so no format
probing) and `--extractor-args youtube:skip=hls,dash,translated_subs` (the audio URL comes
from the player response; the HLS/DASH manifests were one extra request each), so ffmpeg is
never required for the download itself. Progress comes from `--progress-template`, the
final path from `--print after_move:…`. "Update yt-dlp" runs `yt-dlp -U` (works for the
standalone build; a distro package says to use the package manager instead).

Where the desktop time goes (yt-dlp `-v` with timestamps, 4.7 MB song): ~0.35 s Python
start-up, ~1.0 s "Downloading webpage", ~0.15 s `visionos` player API JSON, ~1.1 s the
download itself, ~0.2 s ffmpeg `+faststart` fixup (kept: cheap, and makes the file
seekable in every player). Rejected: `player_skip=webpage` (YouTube answers "Sign in to
confirm you're not a bot"), other `player_client`s (none offers itag 140 without a PO
token), `--fixup never` (saves 0.2 s, risks players that need a flat mp4),
`--concurrent-fragments` (a single HTTPS file, no fragments). Measured alternating A/B,
5 rounds: median 3.18 s → 2.82 s; the remaining time is network-bound.

## Android plugin
`YtdlpPlugin.kt` is a Tauri mobile plugin registered from `lib.rs` (`register_android_plugin`).
Commands: `download`, `status`, `cancel`, `version`, `update`. The first call unpacks
Python and yt-dlp (a few seconds, once per install). `update` self-updates yt-dlp inside the
app, so YouTube breakages are fixed without a new APK. Gradle needs
`jniLibs.useLegacyPackaging = true`, the manifest `extractNativeLibs="true"`, and the APK
grows by roughly 30–40 MB. Library licence: GPL-3.0. The library ships QuickJS
(`libqjs.so`) as yt-dlp's JS runtime; the `visionos` client used for music URLs does not
need it for itag 140.

Every yt-dlp call is a fresh Python process, so the plugin does three things at app start
(`load()`, background thread): `init`, `precompileYtdlp`, and one `yt-dlp --version` run.

**Bytecode precompile.** The yt-dlp release is a zipapp of ~1050 `.py` files with no
bytecode, and Python cannot write a `__pycache__` into a zip, so every run recompiled
yt-dlp (0.4 s on a desktop CPU; `--version` on the phone took 600–740 ms). `zipimport`
does load a `.pyc` stored next to each `.py` inside the zip when its header (mtime and
size) matches the source entry, so `precompileYtdlp` runs the bundled interpreter
(`<nativeLibraryDir>/libpython.so`, `PYTHONHOME=…/packages/python/usr`; not `-I`, which
would ignore `PYTHONHOME`) with a small script that rewrites
`<noBackupFilesDir>/youtubedl-android/yt-dlp/yt-dlp` with a `.pyc` beside every `.py`
(3.0 MB → 8.6 MB). The zip's size+mtime is stamped in SharedPreferences so the check is
skipped on later starts; it runs again after `update` (which replaces the zip). If a header
ever mismatches, zipimport silently falls back to the source. After it, `--version` takes
288 ms on the phone. `java.util.zip` rejects the shebang-prefixed zipapp, so the
"already has bytecode" check lives in the Python script too.

**Flags.** Same as desktop: `-f 140/bestaudio[ext=m4a]/bestaudio` and
`--extractor-args youtube:skip=hls,dash,translated_subs`, plus `-v`; yt-dlp's stderr is
written to logcat (`adb logcat | grep YtdlpPlugin`) with the total time, so a slow or failed
download can be read step by step. Measured on the phone (POWER, 4.7 MB, same Wi-Fi):
12–15 s before (after the one-time unpack; the very first download was 84 s with a stale
yt-dlp), 4.9 / 6.1 / 8.6 / 9.2 s after. The spread is the phone's network (a plain GET of
music.youtube.com from the phone takes 1.0–3.1 s; TLS handshake alone 0.4–1.2 s).

## After a download (both platforms)
`commands::youtube::index_file` writes title/artist/album into the file
(`tags::write_basic`), reads the file facts back and calls `Db::attach_download`, which
sets `path` on the song's existing row (keyed by `video_id`; created if missing). Liked or
playlisted songs therefore become "downloaded" in place, never duplicated. If the scanner
had already indexed the file, that row is merged into the YouTube row.

## Download queue (`commands/youtube.rs`, `commands/downloads.rs`)
* `youtube_download(track)` (search result) and `download_track(id)` (library row) both go
  through `start_download`: ensure the row, refuse if already downloaded, reuse an open
  (queued/active/paused) job for the same video, else start one. `download_playlist`
  calls it for every not-downloaded entry with a video id.
* Every `Download` carries `track_id`.
* **Desktop** (`youtube::ytdlp::Jobs`): pause kills yt-dlp and keeps the `.part` file;
  resume/retry re-run yt-dlp under the same id (it continues the partial file). Each run
  has a generation number so a killed run cannot overwrite the state of the next one.
* **Android**: the plugin forgets a cancelled job and a cancelled id cannot be reused, so
  the Rust side keeps its own table (`YtState.pending`, keyed by the id the UI sees) and
  maps it to the current plugin job id; pause = plugin `cancel`, resume/retry = a new
  plugin job for the same song (yt-dlp continues the `.part` file). `indexed` makes sure a
  finished file is indexed once. Bytes and speed are not reported by the plugin (0).
* `clear_finished_downloads` forgets done jobs (the songs stay in the library);
  `remove_download` cancels and forgets one.
* `storage_info`: used/free of the disk holding the download folder (`statvfs`),
  `downloads_bytes` = downloaded YouTube files still on disk, `cache_bytes` = size of the
  app cache folder (Android: includes Media3's `stream-cache`).

## TLS on Android
`ytmapi-rs` uses reqwest 0.13, whose rustls backend verifies certificates through the
platform verifier; on Android that needs JNI initialisation we do not do, and the request
hangs. `youtube::http_client` builds the client with a pre-configured rustls config using
bundled webpki roots. Measured: search 1.2 s on desktop; on the phone it hung before this fix.
See "Search client cache" above for the timings after caching.

## Blocked addresses (both platforms, D41)
ISPs often share one IPv4 address between many customers (CGNAT). YouTube can answer such an
address with HTTP 429 and "Sign in to confirm you're not a bot" for every default client. On
that error the stream resolve and the download are retried once with
`--extractor-args youtube:player_client=web_embedded,default;skip=hls,dash,translated_subs`
(the embedded-player client still works there). If the retry succeeds, the fallback is used
for every call for the next 12 h. Desktop keeps that in memory
(`ytdlp::extractor_args`/`mark_blocked`). Android also stores it in SharedPreferences `ytdlp`
(`address_blocked_until`). Android also passes `--cache-dir <app cache>/yt-dlp`, so solved
signature functions survive between runs.
Cost: `web_embedded` needs the player JS (≈3 MB) and a JS challenge solve (quickjs on the
phone) on every call. Measured on the test phone (2026-10-19, slow Wi-Fi at ≈30–130 KB/s
from every host): 35–47 s per resolve and 66 s per download, versus ≈1–3 s on the desktop
with deno. Forcing IPv6 was tried first and dropped, because that phone's Wi-Fi has no IPv6
default route.

## Progress lines
Both platforms pass `--newline --progress`: without `--progress`, yt-dlp prints no progress
when stdout is not a terminal. youtubedl-android parses `[download]  12.3% … ETA 00:05`.

## Known limits
* YouTube changes break yt-dlp a few times a year. Desktop: update via Settings or the
  package manager. Android: Settings → Update yt-dlp.
* The download queue lives in memory: it is empty after an app restart (finished songs
  stay in the library; an interrupted download has to be started again).
* The bundled yt-dlp was already stale on first install (HTTP 403). Settings → Update yt-dlp
  fixed it; the app could run that update automatically on first launch.
* On the test phone a search occasionally fails instantly with "error sending request",
  and every request in the next ~100 ms fails too, including on a fresh client; the Wi-Fi
  there logs `DATA_STALL_BAD_TX` and the phone keeps LTE attached, so this looks like a
  default-network switch. Seen 3 times in ~60 searches; never on the desktop. A later
  search works again. If it ever persists, add a bare `tokio::net::lookup_host` probe to the
  retry path to see which layer fails.
* One phone download with the new flags failed with "Requested format is not available"
  (seen once in 5); the next attempt of the same video succeeded. If it recurs, drop `hls`
  from the `skip=` list on Android so the HLS manifest remains a fallback.
* While an address is blocked (see above), every stream start on the phone pays for a
  player-JS download and a quickjs solve. The stream-link cache and `youtube_prefetch`
  (D22) hide this for the next songs in a queue, but not for the first song.
* `youtube_search` has no paging; it returns the first 30 songs. Each hit gets
  `local_track_id` when its audio is already on the device (`Db::match_local`).
