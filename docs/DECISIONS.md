# Decisions

Append-only. Newest at the bottom. Each entry: context → decision → consequences.
When a decision is reversed, add a new entry that references the old one; do not edit it.

---

## D1 · 2026-10-19 · Design first as a static HTML mockup
**Context.** The user wanted to see the whole product before any code.
**Decision.** Build `design-mockup.html`, one self-contained file, and iterate on it.
**Consequences.** The real frontend reuses its structure and class names, so the mockup is
still a good reference for intent. It is not kept in sync with the app.

## D2 · 2026-10-19 · Stack: Tauri 2 + Rust core, plain web frontend
**Context.** Targets are Linux desktop and Android. Rust was already installed. Options
considered: Tauri, Capacitor+Tauri, Flutter, Kotlin Multiplatform.
**Decision.** Tauri 2 with a separate `crates/core` library. Frontend is plain HTML/CSS/JS
modules with no bundler.
**Why.** One Rust implementation of scanning, classification and torrents for both
platforms; the HTML design carries over unchanged; no bundler means the UI can be previewed
by any static file server and read without tooling.
**Consequences.** Android background playback and native media controls need Kotlin glue
later (see D9). Desktop build requires `webkit2gtk-4.1`.

## D3 · 2026-10-19 · Core crate has no Tauri dependency
**Decision.** Everything testable lives in `crates/core`; `src-tauri` is glue only.
**Why.** `cargo test -p offline_core` runs without WebKit or the Android NDK, and the core
could be reused by a CLI or a server later.

## D4 · 2026-10-19 · Voice recordings are tracks with `kind = voice`
**Context.** The user wants recordings in a separate section, never in shuffle.
**Decision.** One `tracks` table with a `kind` column (`music` | `voice` | `unsure`) instead
of two tables. A `user_kind` flag records manual overrides so re-scans never undo them.
**Consequences.** Queries filter by `kind`; the review queue is simply `kind = unsure`.

## D5 · 2026-10-19 · Classifier is feature-based, no model file (for now)
**Context.** The app must work offline on first launch on both platforms.
**Decision.** Decode ~40 s with Symphonia, compute rhythm/bandwidth/modulation/stereo
features, combine with file hints (sample rate, channels, tags, folder and file names) using
hand-set weights in `classifier::Weights`. Output a probability, a confidence and a
human-readable reason.
**Why.** Zero download, fast, explainable ("mono, 16 kHz, no artist tag"). Weights are in one
struct so they can be tuned from real data.
**Consequences.** Accuracy on edge cases (acoustic demos, podcasts with music beds) will be
imperfect; the review queue and manual override cover that. A learned ONNX model can replace
`classifier::score` without changing callers.

## D6 · 2026-10-19 · Server protocol: Subsonic first
**Context.** The user's own search engine is not yet specified.
**Decision.** Implement the Subsonic API (Navidrome, Gonic, Airsonic, Ampache) with salted
token auth. `ServerConfig.kind` leaves room for a second backend.
**Consequences.** When the user's server is known, add another client behind the same
`ServerTrack` shape; the UI does not change.

## D7 · 2026-10-19 · Torrents via librqbit, audio-only by default
**Decision.** Use `librqbit` (pure Rust) so the same code builds for Android. Default to
keeping only audio files via `only_files_regex`. Indexer search talks to Jackett/Prowlarr.
**Consequences.** No native libtorrent dependency. Torrent persistence across restarts is
"re-add from magnet"; librqbit's own fastresume is not enabled yet.

## D8 · 2026-10-19 · Imports from export files, not OAuth
**Context.** The user said functional account linking is not needed right away.
**Decision.** Parse Spotify privacy export JSON, Exportify/YouTube Takeout CSV and pasted
text. Match by title + artist + duration against the library.
**Consequences.** "Connect account" buttons are not shown; OAuth can be added as another
producer of `ParsedPlaylist`.

## D9 · 2026-10-19 · Playback in the webview `<audio>` element
**Decision.** Play local files through Tauri's asset protocol and server tracks through their
stream URL. Media Session API gives lock-screen controls where the webview supports it.
**Consequences.** On Android, audio may stop when the activity is backgrounded for long.
Planned fix: a small Kotlin foreground service with MediaSession (tracked as future work in
`docs/modules/android.md`).

## D10 · 2026-10-19 · Theme: light red/gray default, dark available, tokens only
**Context.** The user asked for a whitish red/gray look, both themes, and colours that can be
changed effortlessly.
**Decision.** All colours, radii, spacing and type sizes are CSS custom properties in
`src/styles/tokens.css`, with one light block and one dark block. `theme.js` resolves
"system" to an explicit value so CSS never duplicates the dark block for a media query.
**Consequences.** Components must never hard-code colours. Adding a theme means adding one
block to tokens.css.

## D11 · 2026-10-19 · Android storage: media permission + All-files access
**Decision.** Request `READ_MEDIA_AUDIO` (13+) / `READ_EXTERNAL_STORAGE` (≤12) at launch and
offer "All files access" so whole-device scans and downloads into user-chosen folders work.
`usesCleartextTraffic` is on because the user's server is plain HTTP on the LAN.
**Consequences.** Google Play would require justification for All-files access; this app is
side-loaded so that is acceptable.

## D12 · 2026-10-19 · Toolchain in user space
**Decision.** rustup, JDK 17 and the Android SDK/NDK are installed under the home directory,
not through pacman (no sudo). Only `webkit2gtk-4.1` for the desktop build needs the system
package manager.

## D13 · 2026-10-19 · Android: 16 KB page alignment and system-bar insets in Kotlin
**Context.** First run on the Samsung SM-S948B (Android 17) warned that the Rust library is
not 16 KB page-aligned, and the web content was drawn under the status bar.
**Decision.** `src-tauri/build.rs` adds `-Wl,-z,max-page-size=16384` for Android targets
(NDK r27 does not default to it). `MainActivity.kt` pads the content view with the system-bar
insets because the WebView does not expose edge-to-edge insets to CSS `env()`.
**Consequences.** Both are build/shell concerns; the frontend keeps `viewport-fit=cover` and
needs no platform branches. Upgrading to NDK r28+ makes the linker flag redundant but harmless.

## D14 · 2026-10-19 · `npm run tauri` must exist
**Context.** Tauri's Gradle plugin shells out to `npm run tauri android android-studio-script`.
**Decision.** `package.json` has `"scripts": { "tauri": "tauri" }`. Do not remove it.

## D15 · 2026-10-19 · Scanner defaults learned from the first real phone scan
**Context.** The Samsung SM-S948B holds 40 audio files: one song, one voice recorder file
that is really recorded music, and 38 recorder/voicemail files in 3GPP-branded `.m4a`.
**Decision.**
* Minimum duration default is **2 s**, not 10 s: eleven voicemails under 10 s were skipped
  and then deleted as "unseen". Two seconds still drops notification sounds.
* Tags are read in lofty's relaxed mode with a Symphonia fallback for sample rate, channels
  and duration; the classifier also returns what it decoded so stored rows are complete.
* Rows with duration 0 are re-read on each scan instead of being skipped by size + mtime.
* Scan progress is emitted on a 300 ms timer, not every five audio files, so whole-device
  walks through thousands of photos still move the banner.
**Consequences.** Short voice memos survive; Samsung recorder files show real durations;
a parser improvement is picked up automatically on the next scan.

## D16 · 2026-10-19 · Torrent search works out of the box with public sources
**Context.** The user wants torrent search usable without configuring anything, with a
dropdown of one or two ready sources, and self-hosted indexers as an option.
**Decision.** `INDEXER_PRESETS` in `torrent.rs`: Torrents-CSV (default) and apibay are
public JSON APIs needing no setup; Jackett and Prowlarr need a URL and key. The same picker
component appears on the Get screen (next to the search box) and in Settings.
**Consequences.** Adding a source = one match arm in `search_indexer` plus one preset row.
Public APIs can go down or change shape; errors surface as toasts and the user can switch
source from the dropdown.

## D17 · 2026-10-19 · YouTube: search via YouTube Music, download via yt-dlp (bundled on Android)
**Context.** The user wants YouTube as a music source. Tested on the PC: `yt-dlp` search
1.2 s and audio download 3.9 s; the pure-Rust YouTube client (`rusty_ytdl`) returned empty
stream URLs (broken against current YouTube); YouTube Music song search via `ytmapi-rs`
gave clean song results in 1.1 s. Android cannot run Python directly.
**Decision.** Search with `ytmapi-rs` in the shared core on every platform. Download with
`yt-dlp`: the binary on desktop (auto-downloaded standalone build if none on PATH), and
`youtubedl-android` (bundled Python + yt-dlp, in-app self-update, used by Seal and YTDLnis)
on Android through a Tauri mobile plugin. Audio-only m4a, no ffmpeg.
**Alternatives rejected.** Own Rust extractor (maintenance treadmill against YouTube);
NewPipeExtractor (no self-update, needs an APK per fix); Chaquopy (more setup than needed).
**Consequences.** APK grows ~35 MB; first download on Android pays a one-time unpack. The
youtubedl-android library is GPL-3.0. Lucida-style stream rippers for paid services were
declined (D-note: not integrated).

## D18 · 2026-10-19 · Quick search on Super+Space via a Hyprland keybind, not an in-app global hotkey
**Context.** The user wants Super+Space to open a search palette. The desktop runs Hyprland
on Wayland, where Tauri's global-shortcut plugin (X11 key grabs) does not work. Super+Space
was already bound to the Ryoku launcher, and this Hyprland Lua runtime stacks handlers on a
bound chord instead of replacing them.
**Decision.** `~/.config/hypr/user.lua` unbinds Super+Space and binds it to
`offline-player --quick-search` (wrapper in `~/.local/bin`). The app uses
`tauri-plugin-single-instance`: a second launch with that flag focuses the running window
and emits `ui://quick-search`; the frontend opens the palette (`components/quicksearch.js`,
also on Ctrl+K). Library matches play instantly; the last rows jump to Search for My server or
YouTube Music with the query prefilled.
**Consequences.** The Ryoku launcher is no longer on Super+Space (two lines in user.lua to
revert, or pick another chord). On Android the palette is reachable only via Ctrl+K on a
keyboard, which is fine since the phone has the Search tab.

## D19 · 2026-10-19 · Correction to D18: Super+Space stays the launcher, Super+M opens the app
**Context.** The user did not want the Ryoku launcher replaced; they expected the launcher's
search to *find* the music app, and asked for Super+M for the app itself.
**Decision.** `user.lua` binds only `SUPER + M` → `offline-player --quick-search`. A desktop
entry (`~/.local/share/applications/offline-player.desktop`, icon in `~/.local/share/icons`)
makes "Offline Player" appear in the Super+Space launcher, with a "Quick search" action.
**Consequences.** D18's unbind of Super+Space is reverted. Nothing in the app changed.

## D20 · 2026-10-19 · YouTube speed: cached search client, itag 140 + manifest skipping, bytecode-precompiled yt-dlp on Android
**Context.** Search took 1.1–1.2 s on the desktop and 4.7–6.0 s on the phone; a download
took 3.2–3.9 s on the desktop and 12–15 s on the phone (84 s the very first time). Profiling
showed: `youtube::search` built a new `ytmapi-rs` client and fetched a fresh visitor token
(a full GET of music.youtube.com) per call, which on the phone means two TLS handshakes of
0.4–1.2 s each; yt-dlp fetched the HLS and DASH manifests it never used; on Android every
download is a fresh Python process that recompiles yt-dlp's ~1050 source files because the
release zipapp carries no bytecode and Python cannot cache into a zip.
**Decision.** (1) One shared `YtMusic<NoAuthToken>` client (`tokio::sync::Mutex` in a
`OnceLock`), connection pool kept alive, token refreshed after 6 h, retry once on the same
client then once with a fresh token; `youtube::warm_up()` runs at app start. (2) yt-dlp on
both platforms: `-f 140/bestaudio[ext=m4a]/bestaudio` and
`--extractor-args youtube:skip=hls,dash,translated_subs`. (3) Android: `YtdlpPlugin.load()`
initialises, precompiles the yt-dlp zip in place with the bundled interpreter (a `.pyc`
beside every `.py`, which zipimport prefers), and runs `yt-dlp --version` once; the
precompile re-runs after a self-update; yt-dlp's `-v` output goes to logcat.
**Measured.** Desktop search cold 1.06–1.26 s, cached 0.45–0.68 s (was 1.0–1.2 s every
time). Phone search 0.8–1.3 s typical (was 4.7–6.0 s). Desktop download median 3.18 s →
2.82 s (A/B, 5 rounds; network-bound). Phone download 4.9–9.2 s over four runs (was 12–15 s);
yt-dlp start-up on the phone 600–740 ms → 288 ms.
**Alternatives rejected.** `player_skip=webpage` (bot check), other `player_client`s (no
itag 140 without a PO token), `--fixup never` (0.2 s, playback risk), OAuth (out of scope),
replacing youtubedl-android's Python with a native extractor (maintenance treadmill, D17).
**Consequences.** The yt-dlp zip on the phone grows 3 MB → 8.6 MB. The precompile depends on
youtubedl-android's private directory layout (`no_backup/youtubedl-android/yt-dlp/yt-dlp`,
`packages/python/usr`); if a library update moves it, the step logs "layout not found" and
downloads still work, just slower. Searches and downloads on the phone remain bounded by
its network; see the module doc's known limits for two transient failures observed.

## D21 · 2026-10-19 · Android playback: Blob URLs instead of streaming through the asset protocol
**Context.** On the phone, songs stopped about 30 s in while the UI still showed "playing".
Probing the WebView over DevTools showed Tauri's asset protocol on Android answers a range
request starting at byte 0 (206) but fails any range starting later ("Failed to fetch"). The
`<audio>` element plays its first buffered chunk, asks for the next range, gets a failure
and stalls; Android then tears down the idle audio track.
**Decision.** `player.js` reads the whole local file once with `fetch` (a full GET works) and
plays it from a Blob URL on Android; the previous Blob URL is revoked on track change and a
stale load is discarded if the user skips. Desktop keeps streaming from the asset URL.
**Consequences.** One file (3–10 MB, up to ~40 MB for FLAC) is held in memory per track;
seeking is instant. The proper long-term fix is native playback in a foreground media
service (also needed for reliable background playback and lock-screen controls).

## D22 · 2026-10-19 · Stream links: cache, de-duplicate, prefetch
**Context.** Streaming a YouTube Music song needs a direct googlevideo link resolved by
yt-dlp on the playing device (links are bound to its IP). Measured on the phone: 11–14 s to
resolve, then ~1 s to first audio; on the PC ~1.5 s.
**Decision.** `commands/youtube.rs` keeps a per-video link cache valid until 10 min before
the `expire=` time in the URL (fallback 1 h), shares one in-flight resolve between callers
(`OnceCell` per id), caps parallel yt-dlp resolves at 2, and exposes `youtube_prefetch`.
The UI prefetches the top 3 YouTube search results and the next 2 queued streams; the player
streams `video_id` items through `youtube_stream_url` and shows "Loading stream…" meanwhile.
**Consequences.** Play on a prefetched song costs ~1 s; a cold tap still pays the resolve.
Prefetching spends a little data and CPU on songs that may not be played.


## D23 · 2026-10-19 · Android playback: native Media3 service, queue stays in the UI
**Context.** The WebView `<audio>` stalls on the asset protocol (D21), holds no audio focus,
shows no real notification and is suspended in the background (D9). Spotify-style
background playback with lock-screen controls needs a foreground media service.
**Decision.** A Tauri mobile plugin `playback` drives one process-wide Media3 `ExoPlayer`,
wrapped in a `MediaSession` by a `MediaSessionService` (foreground, `mediaPlayback`).
Media3's default notification gives notification + lock screen; a custom "like" button sits
in the overflow slot. Audio focus and becoming-noisy are Media3's (`handleAudioFocus`).
The queue stays in `player.js`: the session's player is a `ForwardingPlayer` that reports
every outside action as `remote`; play/pause/seek are executed natively first (work with the
WebView asleep), next/prev/like are only reported and the UI answers with `load`.
Events go Kotlin `trigger` → Rust IPC `Channel` (registered via `registerListener` on first
use) → `app.emit("playback://…")`, so the UI uses the normal event API and no plugin ACL
permissions are needed. Local files play by path; streams go through a Media3 `SimpleCache`
(LRU, `stream.cache_mb`, default 256 MB) keyed by `yt:<videoId>:<itag>` because the link
itself changes on every resolve. Swiping the app away stops playback (nothing could advance
the queue without the UI).
**Consequences.** Playback survives screen-off and backgrounding; replaying a recent stream
needs no network. One song is loaded at a time, so gapless/crossfade are not native yet.
Expired links (403/410) surface as an error the UI must handle by re-resolving.

## D24 · 2026-10-19 · Library v2: YouTube songs are track rows without a file, keyed by video id
**Context.** v2 lets people like, playlist and stream YouTube Music songs they never
downloaded, and a later download must not create a second copy of the song.
**Decision.** `tracks.path` became nullable (migration 2 rebuilds the table) with a unique
`video_id`. Liking, adding to a playlist, downloading or playing a result creates one
`source='youtube'` row (path NULL); a finished download sets `path` on that row
(`Db::attach_download`), merging a row the scanner may have created for the same file.
"In the library" means on the device, liked, or in a playlist; rows that were only
streamed stay for Recently played but are not listed or counted. Rows nothing refers to
are pruned at startup only, so an id the UI holds never disappears mid-session.
**Consequences.** One row per song everywhere (likes, playlists, downloads, history).
`Track.downloaded` is computed on read by checking the file. The Library's "downloaded"
filter means YouTube songs kept offline; "device" means scanned files.

## D25 · 2026-10-19 · Liked songs is a virtual playlist (id 0); v1 imports become playlists
**Context.** The Library shows "Liked songs" as a playlist card, and the phone has a v1
database with imported Spotify/YouTube lists.
**Decision.** Likes stay a flag on `tracks` (plus a new `liked_at` for ordering); playlist
id 0 is synthesised from them, its `entry_id` is the track rowid, add = like,
remove = unlike, rename/delete/reorder are refused. Real playlists live in `playlists` +
`playlist_entries` (adding a song already present is a no-op). Migration 2 converts each
v1 import into a playlist of its matched songs plus an `import_history` row and drops the
v1 import, torrent-download and server/torrent settings data. Migrations now run one
transaction each with foreign keys off, SQLite's recipe for table rebuilds.
**Consequences.** No sync problem between "liked" and a Liked playlist. Unmatched v1 import
entries are not carried over (they had no song to point at).

## D26 · 2026-10-19 · Download pause/resume: stop and re-run yt-dlp; queue is in memory
**Context.** The Downloads design has pause, resume and retry. yt-dlp has no pause, and
the Android plugin forgets a cancelled job and cannot reuse its id.
**Decision.** Pause kills the yt-dlp process (desktop) or cancels the plugin job
(Android) and keeps the `.part` file; resume and retry start yt-dlp again for the same
song, which continues the partial file. Desktop jobs carry a generation number so a killed
run cannot overwrite the next run's state; on Android the Rust side keeps the queue keyed
by the id the UI sees and maps it to the current plugin job id. The queue is not
persisted (the v1 `downloads` table only existed for torrents).
**Consequences.** After an app restart the queue is empty; finished songs are in the
library, interrupted ones must be started again (the `.part` file is reused).

## D27 · 2026-10-19 · Frontend v2: design system ported verbatim; views lazy-loaded with a placeholder fallback
**Context.** The approved designs all link one stylesheet (`design/system.css`) and several
agents write the v2 views in parallel.
**Decision.** `src/styles/system.css` is a byte-for-byte copy of `design/system.css`; app-level
shared patterns go in `app.css`, Now Playing in `now-playing.css`, and each other screen ships
its own screen-only CSS through the view module's `css` export (injected once). The router
lazy-imports `views/<name>.js` and renders a placeholder card if the module is missing or
fails to load, so the shell, player and navigation always work. Shell defaults per view (phone
tab kept active, sidebar item, back link, trailing action, setup shell) live in one
`REGISTRY` in `router.js`.
**Consequences.** Updating the design system is a file copy. A broken view never breaks the
app. Screen CSS lives next to the screen's code instead of in `src/styles`.

## D28 · 2026-10-19 · Desktop top-bar search opens the quick-search palette
**Context.** Every design shows a search field with a "Ctrl K" hint in the desktop top bar, and
the app already has a Ctrl+K palette (D18/D19). Two separate search UIs would compete.
**Decision.** Focusing the top-bar field opens the palette (library songs play instantly; the
last row opens `#search?q=…` for YouTube Music). The Search screen keeps its own large field
and hides the top-bar field (`topbarSearch: false`).
**Consequences.** One search behaviour on every screen; the field never holds stale text.

## D29 · 2026-10-19 · Now Playing: no output-device picker; phone utility row is Sleep · Queue · Add to playlist
**Context.** The design shows an "Output" select (desktop card, bar icon, phone "Phone speaker"
button). Neither WebKitGTK `<audio>` nor the planned Android engine exposes output switching
through the v2 API, and the brief forbids controls that don't work.
**Decision.** The desktop card is "Volume" (slider only) and the bar has no speaker button; the
phone utility row shows Sleep timer, Queue (count) and Add to playlist.
**Consequences.** Add an output picker later only with a backend command behind it.

## D30 · 2026-10-19 · Player queue model: "Added by you" entries, shuffle restores order, auto-skip at 0:00
**Context.** The design's queue has "Now playing", "Added by you" and "Next from <context>"
groups, Clear added / Clear queue, drag to reorder, and errors that skip on.
**Decision.** The queue is `[{ uid, item, added }]`; Play next / Add to queue insert `added`
entries right after the current song; dragging to the top of Up next marks an entry added.
Shuffle shuffles only the context part and remembers the original order so turning it off
restores it. A song that fails before 1 s of audio (missing file, dead stream) is skipped with a
toast, at most 3 in a row; later failures stop with an error banner and Skip/Try again. Offline,
streaming entries are skipped. `record_play` fires on the first audio of each entry that has a
library id. Shuffle/repeat/volume persist in localStorage (per device, not settings).
**Consequences.** YouTube search results played without being liked/added have no library id,
so they don't reach Recently played (see open issue: a `record_play` for YtTracks).

## D31 · 2026-10-19 · Import matching: scored YouTube Music search; YouTube playlist videos are their own match
**Context.** Imported songs must become YouTube rows (API-v2 "Import from other apps"):
matched / review / not found, without false "matched" rows the user never checks.
**Decision.** Each Spotify/SoundCloud song is searched as "<title without feat./remaster
noise> <first artist>" (8 results, 4 searches at a time). Results are scored on title
(character-bigram Dice, works for any script), artist and duration. *Matched* needs title
≥ 0.85, artist ≥ 0.5, the same version words (live, remix, acoustic, …) and duration within
±5 s (no source duration: near-exact title and artist). *Review* needs a similar title plus a
similar artist or a length within ±10 s, so a same-named song by a stranger is *not found*
instead. Review and not-found rows carry up to 3 alternatives. YouTube / YouTube Music
playlist items are already videos, so they are used as-is (status matched, no search);
private/deleted entries are dropped with a note. A preview fails only if every search failed.
**Consequences.** Big Spotify playlists match in seconds (50 songs ≈ 7 s on desktop);
YouTube playlists import music videos as they were, not the "song" versions.

## D32 · 2026-10-19 · Import listing limits: Spotify embed caps at 100; SoundCloud resolved per track; previews in memory
**Context.** Spotify is read without a key from the embed page; yt-dlp's flat SoundCloud
listing has no title or duration for most tracks; the review step lets the user pick an
alternative.
**Decision.** Spotify playlists longer than 100 songs are cut at 100 and the preview carries a
`note` saying so. SoundCloud runs `yt-dlp -j` (full per-track metadata, ≈1 s per track)
and reports it as `import://progress` with `phase: "listing"`; matching reports
`phase: "matching"`. YouTube/SoundCloud listing needs the yt-dlp binary, so on Android those
platforms return "not available on the phone yet" (Spotify works there). Previews live in a
process-wide bounded list (16) until `import_commit`, which also takes optional
`picks: { index: YtTrack }` for the user's choices; import_history records total = songs in
the source, matched = songs added.
**Consequences.** Very long SoundCloud sets take minutes to list; a preview is lost on app
restart (the UI asks to paste the link again).


## D33 · 2026-10-19 · Home Quick picks are seeded YouTube Music searches; Continue listening resumes from the player
**Context.** The design's Home shows "Quick picks from YouTube Music" and "Continue listening (with
progress)", but docs/API-v2.md has no recommendations command and no stored playback position.
**Decision.** Quick picks = `youtube_search` for up to 3 artists from `list_recent` (interleaved,
de-duplicated, topped up with "top hits"; a fresh install searches "top hits" and says "popular on
YouTube Music"). Results are cached in sessionStorage for 30 min; Refresh rotates the seed artists.
Offline, the section becomes "From your downloads" (liked downloads first). Continue listening shows
the loaded song (or its playlist/album queue) with live progress, then recent songs; their progress
comes from `player.resumeInfo(item)` when the player provides it, otherwise "Played 2 h ago".
Recently played tiles are the albums of recent songs.
**Consequences.** No extra backend command; picks are only as good as the seed searches. Real
per-song resume needs the player to persist positions (open item for player.js).

## D34 · 2026-10-19 · Search albums/artists are grouped from song results; recent searches stay on the device
**Context.** `youtube_search` returns songs only, yet the Search design groups Songs / Albums /
Artists with a Top result card.
**Decision.** Albums (album + primary artist) and Artists (first credited artist) are grouped from the
song results; the Top result is an artist or album the query names (≥2 songs for an artist), else the
first song. Opening an album or artist searches for it. "Your library" mode uses list_tracks /
list_albums / list_artists; offline forces it, with the banner. Each result is merged with its library
row (`get_track` on `local_track_id`, or the download's track_id) so liked / downloaded state is real.
Recent searches (queries, songs, albums, artists; 12 max) live in localStorage — a per-viewer
convenience. On desktop the shell top bar is hidden on Search and the view shows its own download pill
(one search field per screen, as designed).
**Consequences.** Album/artist counts reflect the 30 results, not the full discography. A true
album/artist browse needs a YouTube Music browse command later.

## D35 · 2026-10-19 · Library derives its tabs from one list_tracks call and owns its row anatomy
**Context.** The Library design shows exact counts on six tabs, live chips (All / Downloaded /
Streaming only / On device) with counts, and a row with a select box plus a download-state
indicator that moves from the subtitle (desktop) to its own 44 px column (phone).
**Decision.** `views/library.js` loads `list_tracks('music')` once and filters / sorts Liked,
Downloads, Device and the chips on the client (Downloads = downloaded and not `source: local`;
Device = `source: local`); Recently played is `list_recent`. Rows are rendered by a local
`libRow()` (design markup) but keep `data-idx` / `data-key` / `data-act` so the shared
`bindTrackList` still wires play, like and ⋯; the phone download column uses `.lib-dlcell`
(not `.row__dl`, which `bindTrackList` rewrites). Playlist cards fetch `get_playlist` per card
(≤ 48) to build the four-cover mosaic because `Playlist.artwork` only carries thumbnails.
Search-within-library is the route `#library?q=…`. Playlist sort reads "Recently updated" (no
last-played time exists for playlists). Multi-select "Remove…" only exists on Liked (unlike), because
the contract has no command to delete a song from the library.
**Consequences.** Very large libraries pay one bigger list call instead of one per tab; switching tabs
and chips is instant. The mosaic costs one extra call per playlist on first paint.

## D36 · 2026-10-19 · Playlist download progress and edit mode are computed in the view
**Context.** The playlist hero shows "Downloading 19 of 24 · 76% · 3.2 MB/s · 4 queued · 1 failed",
Pause download, and an Edit mode with drag reorder; the contract has `download_playlist`, per-download
pause/resume/retry and `reorder_playlist` (full order) but no per-playlist download status.
**Decision.** `views/playlist.js` joins the playlist's songs with the shared downloads store
(`downloadFor`) to compute done / active / queued / paused / failed, progress = (done + partial) /
songs with a file or a video id; Pause/Resume act on that playlist's downloads one by one. After
`download_playlist` the returned ids are mapped to the not-yet-downloaded songs in order
(`rememberDownload`) so rows show progress before the core reports `track_id`. "Download all · ≈ N MB"
estimates 32 kB/s of audio (256 kbps m4a). Edit mode keeps a draft and saves with rename →
remove → reorder; reorder uses pointer drag on the handle with a drop line, and ArrowUp/ArrowDown on a
focused handle. Liked songs (id 0) has no Edit / Add songs / Delete. Removing a song from the row menu
offers Undo (re-add + reorder back to its old position).
**Consequences.** If the core later exposes a per-playlist download status the view can switch to it;
the estimate in "Download all" is labelled "≈".

## D37 · 2026-10-19 · Downloads screen: rows from the store, song details from get_track
**Context.** The Downloads design shows artwork, artist, bitrate and "x min ago" per row; the
`Download` shape has only `name` ("Artist – Title"), sizes, speed, ETA and an optional `track_id`.
**Decision.** `views/downloads.js` renders from the shared polled `downloads` store and looks up
`get_track(track_id)` once per download (cached) for art, artist, bitrate and `modified_at`; without a
track it splits `name` on " – ". Offline turns Active into "Paused · Waiting for connection" with
Retry now; a warn banner appears when less than 500 MB is free and something is queued. "Move to
top / bottom" from the design is left out: the contract has no queue-reorder command.
**Consequences.** Adding `move_download(id, position)` to the contract would let the phone row sheet
and the desktop ↑ button from the design come back.

## D38 · 2026-10-19 · Settings / onboarding show only controls the v2 API can honour
**Context.** The approved Settings, Onboarding, Voice and Device designs include options with no
command or settings key behind them: sleep-timer fade, parallel downloads, embed tags, yt-dlp
auto-update, "What's new" / licences pages, Spotify data-export (.zip) import, profile links with
several playlists, per-folder file counts before a scan, recording rename / delete, "When unsure"
policy, Android "All files access" status.
**Decision.** Those controls are left out (principle 10, "nothing fake") and listed as open issues;
everything shown maps to a key or command. Values chosen for keys the contract left open:
`download.quality` = `best` | `high` (MP3 320) | `standard` (192) | `small` (128);
`stream.quality` = `high` | `normal`; `stream.cache_mb` ∈ 256/512/1024/2048; crossfade off is
`playback.crossfade_secs = 0`. "Change download location" adds an `app` folder rule (the core's
`download_dir()` follows it). "Reset settings" writes these defaults and theme = system. Device
uses the scanner's own keys (`scan.mode`, `scan.extensions`, `scan.respect_nomedia` — shown as
"Skip folders with a .nomedia file" instead of the design's "Skip hidden folders" —
`classifier.enabled`). Per-folder and per-type counts come from `list_tracks` rows.
**Consequences.** When the backend gains those settings/commands the rows can be added back from the
design files without layout changes.

## D39 · 2026-10-19 · Import flow: one link → one playlist; review = best guess or leave out
**Context.** `import_preview` returns one playlist per link and `import_commit` takes item indexes,
not a chosen alternative; the designs show a profile with several playlists and alternative pickers.
**Decision.** Settings → Import is a sub-page (`#settings?import=<platform>`, `&url=…&go=1` starts
matching): link → matching (indeterminate until `import://progress` arrives, then done/total) →
review (Matched / Needs review / Not found; review rows choose "use best guess" or "leave out";
not-found rows link to Search) → import (optional "Download all" calls `download_playlist`) → done.
Onboarding step 4 uses the same commands with the onboarding layout; `#onboarding?step=4&link=…`
pre-fills and starts it. Cancel abandons the pending preview (no cancel command).
**Consequences.** Picking an alternative match needs `import_commit` to accept per-item choices.

## D40 · 2026-10-19 · Voice resume positions and speeds live in localStorage
**Context.** The Voice design's "Continue listening · Resume from 21:40" needs a per-recording
position; the API has no such field.
**Decision.** `views/voice.js` installs one `player.onTime` listener when the module first loads
and stores `voice.pos.<id>` (seconds; cleared at the end) and `voice.last`; per-recording speed
uses `voice.speed.<id>`, the key player.js already reads. Resume = play the recording queue, then
seek once the engine has loaded. The card shows the playing recording, else the last part-played
one, else the newest.
**Consequences.** Positions are per device and only recorded after Voice was opened once in the
session; moving this listener into player.js (or a `playback_position` column) would make it
complete.

## D41 · 2026-10-19 · yt-dlp falls back to the embedded-player client when YouTube blocks the address
**Context.** On the test phone every stream resolve and download failed with "Sign in to
confirm you're not a bot" after HTTP 429. The Wi-Fi's shared IPv4 address (CGNAT) was
blocked for all default clients. The desktop on the same Wi-Fi worked because it goes out
over IPv6, and `yt-dlp -4` on the desktop failed the same way. The phone's Wi-Fi has no IPv6
default route, so `--force-ipv6` failed with "Network is unreachable". Over IPv4, only the
`web_embedded` client of `android_vr, tv, tv_simply, mweb, ios, web_music, web_safari,
web_embedded` returned a stream URL.
**Decision.** On a bot-check or 429 error, retry once with
`player_client=web_embedded,default` (plus the usual `skip=`). If the retry works, keep using
it for 12 h: SharedPreferences on Android, process memory on desktop. A cancelled or paused
download is not retried, and when the retry also fails the user sees the original error.
Android yt-dlp also gets `--cache-dir <app cache>/yt-dlp`; before this it had no writable
cache at all.
**Alternatives rejected.** Forcing IPv6 (no route on that network). Cookies or OAuth (needs
an account; out of scope). Running `web_embedded` all the time (it adds a ≈3 MB player
download and a JS solve to every call when the address is not blocked).
**Consequences.** Streaming and downloads keep working on blocked networks, but slowly on the
phone (35–47 s per resolve on the slow test Wi-Fi; most of it is the player-JS download).
Songs that cannot be embedded still fail while blocked. See core-youtube.md "Blocked addresses".

## D42 · 2026-10-19 · v2 rebuild integrated: contract fixes made during integration
**Context.** The v2 rebuild (D23–D40) landed in parallel: backend library and playlists,
imports, Android native playback and the redesigned frontend. Integration found a few
mismatches between the parts and docs/API-v2.md.
**Decision.**
* `lib.rs` registers every API-v2 command plus the 13 `playback_*` commands, and registers
  the `playback` Android plugin next to `ytdlp`. The torrent/server/v1-import commands and the
  torrent restore task are gone. Playback events are re-emitted from Rust, so no extra
  capability permissions are needed.
* `clear_stream_cache` (the contract name the UI calls) was missing. It is now a command in
  `commands/playback.rs` that wraps the plugin's `clearCache`; on desktop it does nothing.
* `record_play(id, track?)` is part of the contract. `player.js` passes the YtTrack for a
  stream started from search (no library id yet), so Recently played includes it.
* CSP `img-src` gains `https:`. YouTube artwork was blocked and every cover fell back to
  generated art.
* `reclassify_track` skips rows without a file (a not-downloaded YouTube row has
  `path = null`).
**Verified on the phone (v1 data kept).** The migration kept all 31 tracks (4 music,
27 voice). Everything below worked on the device: search, playlist create and add, stream
playback (Media3 AudioTrack started, media notification with the like button), local
playback, like, a download that filled the existing row, and Spotify album preview
(13/13 matched).
**Consequences.** API-v2.md documents `record_play`'s `track` argument and the `playback_*`
commands.

## D43 · 2026-10-19 · Design-fidelity pass: output picker, sleep fade, inferred review suggestions and scan estimates
**Context.** A design review listed 15 gaps between the app and `design/screens/`. Several
need data the API does not have: output devices, a voice probability per track, per-file
skip reasons, a scan-size estimate and Android's "All files access" state.
**Decision.**
* **Output.** `components/output.js` lists `audiooutput` devices with
  `navigator.mediaDevices.enumerateDevices()` and switches with `HTMLMediaElement.setSinkId`
  (`engine/html.js` → `player.setOutput`). If the devices can't be listed or switched
  (WebKitGTK, Android WebView, the native Android engine), the Output select is disabled
  and shows the current sink. That sink is "Built-in speakers" on desktop and "Phone speaker"
  on Android. On phone, the output button shows a toast that says the system routes audio.
  The chosen device id is stored in `localStorage` (`player.output`).
* **Sleep fade.** The new setting `playback.sleep_fade` defaults to on (`"true"`). With it on,
  `player.js` scales the engine volume by `remaining / 30 s` in the last 30 s of the sleep
  timer. It works in both modes: minutes, and end of song. The user's volume is not changed,
  and the scale resets when the timer ends or is cancelled.
* **Needs review "Accept suggestions".** A track has `confidence` but no direction, so
  `views/voice.js` works out the suggestion from the classifier's reason labels
  (`classifier.rs::score`). Each label leans voice or music. Audio cues weigh 2 and "no
  artist tag" weighs 0.5. Ties stay voice. The reason line shows a short phrase ("Speech over
  music", "Mostly instruments"), and the full list is in the tooltip.
* **Scan estimates.** After each finished scan, `views/device.js` records `files_seen` and
  `elapsed_ms` for that mode in `localStorage` (`scan.memo`). The mode cards show
  "~N files · about T". A mode that hasn't been scanned yet falls back to library counts or a
  plain hint. On Android, the "All files access" line comes from scan outcomes
  (`scan.perm`): granted after a successful non-app-folder scan, denied after a permission
  error.
* **Skipped files.** The scan reports only a count. The "Skipped files" button opens a sheet
  that explains the skip rules (too short, unplayable, type off, .nomedia). It does not list
  the files.
* **Player bar.** The art and title block is the expand target, so the chevron-up is gone. The
  chevron-down shows only while Now Playing is open, as in the design.
**Consequences.** The suggestions, the scan estimates and the permission line are
approximations. Adding `voice_probability` to `Track`, a skipped-file list to `ScanReport`,
and a storage-permission query would make them exact. `Track.year` is not in the Rust model
yet, so only mock data shows the year in the Now Playing meta line.

## D44 · 2026-10-20 · Media session listeners forwarded by ForwardingPlayer; notification heart follows the song

**Context.** Testing on the phone showed Samsung's media panel with a Play button while music
played. Pressing it paused, but a second press did nothing. The platform session state lagged
one step behind the player. `RemotePlayer` wrapped every session listener in
`CommandsListener(target) : Player.Listener by target`. All `Player.Listener` methods are Java
default methods, and Kotlin `by` delegation does not forward those. `javap` showed that the
compiled class had only `onAvailableCommandsChanged`. So the session never received play/pause,
position or state callbacks. It refreshed only when the queue hints changed. Separately, the
notification heart showed "Like" on liked songs, because `player.js` never sent the liked state.

**Decision.** `RemotePlayer` passes listeners straight to `ForwardingPlayer` and keeps them in a
set. `commandsChanged()` re-announces the filtered command set to those listeners. It runs when
the queue hints change and again after the inner player announces its own commands.
`player.js` sends `engine.setLiked(current.liked)` from `emit()` whenever that value changes. This
covers load, in-app likes, panel likes and library refreshes.

**Verified on the phone.** In the panel, play/pause works repeatedly and the platform state
matches (PLAYING/PAUSED with position). Next, previous, like and unlike work, and the heart
matches each song. On the last song the Next button disappears. Media keys (play, pause, next,
previous) work. Not checked separately: the lock-screen player, which is the same session.

## D45 · 2026-10-20 · Tarang: public GitHub releases for every platform, and OTA updates

**Context.** The user named the app **Tarang** ("wave"). They want it on GitHub, with a
Windows .exe, an Android app, Linux and optionally macOS, and with installed apps updating
themselves from GitHub.

**Decision.**
* **Name.** Product name, window title, Android label and binary (`mainBinaryName: tarang`)
  are Tarang. The identifier stays `dev.yashwanth.offlineplayer`, so existing installs keep
  their app-data folder and library, and the Android package name does not change.
* **Releases.** Repository `Yashwanthkumaram/tarang`, public, so the app can read releases
  without a token. A `v*` tag runs `.github/workflows/release.yml`: it creates a draft, builds
  Windows NSIS, Linux AppImage+deb, macOS universal (optional, unsigned, allowed to fail) and
  a signed Android APK, then publishes. `scripts/release.sh X.Y.Z` bumps the versions and tags.
* **Desktop OTA.** `tauri-plugin-updater` reads `releases/latest/download/latest.json` and
  verifies its minisign signature against the public key in tauri.conf.json. On Linux only
  the AppImage self-updates.
* **Android OTA.** The Tauri updater does not support Android. `offline_core::update` reads
  the GitHub API's latest release, compares semver, picks the universal/arm64 `.apk` and
  downloads it to `cache/updates`. The Kotlin `ApkInstallerPlugin` opens the system installer
  through the FileProvider. The first time, it opens "Install unknown apps" for Tarang instead
  (`needs_permission`). Android checks that the APK is signed with the same key.
* **Signing.** The updater keypair and the Android release keystore are generated once.
  They are kept in `~/.tarang-keys/` (never committed) and in the repository secrets. The
  Gradle `tarang` signing config signs release builds, and local debug builds when the key is
  present, so the phone's build can take OTA updates. R8 is off in release builds (plugins
  use reflection), and legacy JNI packaging applies to every build type (youtubedl-android).
* **UI.** Settings › About has a "Tarang updates" row: check, update with progress, What's new,
  and the Android permission hint. At start-up the app checks quietly at most once a day and
  shows a toast with an Update action (`components/updates.js`).
* **Windows.** yt-dlp gets the right binary per OS (`yt-dlp.exe`, `yt-dlp_macos`,
  `yt-dlp_linux[_aarch64]`). PATH is split with `split_paths`. Child processes start with
  `CREATE_NO_WINDOW`, and pause uses `taskkill` there.

**Consequences.** Losing `~/.tarang-keys` means installed apps can no longer be updated, so
it must be backed up. The current phone install was signed with the old debug key, so it has
to be replaced once by a build signed with the new key; after that, updates install over it.
The Windows and macOS builds are compiled only in CI; they cannot be tested on this machine.
