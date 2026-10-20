# Documentation index

Read in this order if you are new:

1. [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit, data flow, where code lives.
2. [API-v2.md](API-v2.md) — the frontend ⇄ backend command contract.
3. [DECISIONS.md](DECISIONS.md) — every decision we made and why (append-only log).
4. One page per module under `modules/`:

| Module | Page | Lives in |
|---|---|---|
| Data model | [modules/core-models.md](modules/core-models.md) | `crates/core/src/models.rs` |
| Database, playlists, likes | [modules/core-db.md](modules/core-db.md) | `crates/core/src/db.rs` |
| Scanner & folder rules | [modules/core-scanner.md](modules/core-scanner.md) | `crates/core/src/scanner.rs`, `paths.rs`, `tags.rs` |
| Small helpers (file names, URL encoding, disk usage) | — (doc comments) | `crates/core/src/util.rs` |
| Music vs voice classifier | [modules/core-classifier.md](modules/core-classifier.md) | `crates/core/src/classifier.rs` |
| Import from Spotify / YouTube Music / SoundCloud links | [modules/core-import.md](modules/core-import.md) | `crates/core/src/sources/`, `commands/imports.rs` |
| Playlists & Liked songs | [modules/core-db.md](modules/core-db.md) | `crates/core/src/db.rs`, `commands/playlists.rs` |
| Native playback (Android Media3, notification, stream cache) | [modules/playback.md](modules/playback.md) | `commands/playback.rs`, `PlaybackCore/Service/Plugin.kt`, `src/js/engine/` |
| v1 importer (removed; pointer only) | [modules/core-importer.md](modules/core-importer.md) | — |
| YouTube Music search, yt-dlp downloads & queue | [modules/core-youtube.md](modules/core-youtube.md) | `crates/core/src/youtube.rs`, `commands/youtube.rs`, `commands/downloads.rs`, `YtdlpPlugin.kt` |
| Tauri shell & commands | [modules/shell-tauri.md](modules/shell-tauri.md) | `src-tauri/` |
| Frontend | [modules/frontend.md](modules/frontend.md) | `src/` |
| Theming & design tokens | [modules/theming.md](modules/theming.md) | `src/styles/tokens.css`, `src/js/theme.js` |
| Android | [modules/android.md](modules/android.md) | `src-tauri/gen/android/` |
| Toolchain & environment | [modules/toolchain.md](modules/toolchain.md) | `~/opt`, `~/Android/Sdk`, `~/.cargo` |

Conventions for these pages: say **what it does**, **public surface**, **how to change it**,
and **known limits**. Keep them short; the code has doc comments for detail.
