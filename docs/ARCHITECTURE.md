# Architecture

## One sentence

A platform-independent Rust core does all the work; a thin Tauri shell exposes it as
commands; a plain HTML/CSS/JS frontend renders it; the same three layers ship on Linux
desktop and Android.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ src/   Frontend (webview)                                     │
│   views/*.js  ── api.js (invoke) ──┐   player.js (<audio>)    │
│   styles/tokens.css (theme)        │                          │
└────────────────────────────────────┼──────────────────────────┘
                                     │ Tauri IPC (JSON)
┌────────────────────────────────────▼──────────────────────────┐
│ src-tauri/   Shell                                            │
│   commands/{library,scan,server,downloads,imports,settings}   │
│   state.rs: Db, Downloader, TorrentEngine, scan flags         │
└────────────────────────────────────┬──────────────────────────┘
                                     │ plain Rust calls
┌────────────────────────────────────▼──────────────────────────┐
│ crates/core/   Core (no Tauri dependency, unit-tested)        │
│   scanner ─► tags ─► classifier ─► db                          │
│   server (Subsonic + HTTP downloader)   torrent (librqbit)     │
│   importer (Spotify/YouTube exports → db matches)              │
└───────────────────────────────────────────────────────────────┘
```

**Rule:** logic goes in `crates/core`. The shell only converts arguments, picks directories
and returns results. The frontend never builds SQL, paths or URLs.

## Key data flows

**Scan.** `start_scan` → `scanner::load_config` (settings + folder rules) → walk roots with
`walkdir`, filtered by exclude rules and `.nomedia` → for each audio file: skip if size/mtime
unchanged → `tags::read` (lofty) → `classifier::classify_file` (symphonia decode + features)
→ `db.upsert_track`. Progress is emitted as the `scan://progress` event; the frontend shows a
banner and refreshes lists when `finished` is true. Files not seen are deleted at the end.

**Play.** The frontend asks Tauri for an asset URL for the file path (`convertFileSrc`) and
plays it in an `<audio>` element. Server tracks play from their Subsonic stream URL.

**Server search.** `server_search` → `SubsonicClient::search` → results get
`local_track_id` when `db.find_match` finds the same song on device → UI offers Stream or
Download. Download runs in the `Downloader` (reqwest stream to `<app folder>/name.ext`) and
indexes the file on completion.

**Torrents.** `add_torrent` → `TorrentEngine::add` with an audio-only file regex → librqbit
downloads into the app folder → `list_downloads` polls stats; finished torrents are indexed.

**Imports.** `import_file` parses a Spotify JSON / CSV / text file → `importer::import` stores
the playlist and matches each entry with `db.find_match`. `rematch` runs after scans and
downloads so matches improve over time.

## Storage

* SQLite at `<app data dir>/library.sqlite` (Linux: `~/.local/share/dev.yashwanth.offlineplayer/`,
  Android: app-private storage). Schema in `db.rs::MIGRATIONS`.
* Downloads go to the **app folder** rule if set, else `<app data dir>/downloads`.
* Settings are key/value rows; keys are defined next to the code that reads them
  (`scanner::keys`, `server::keys`, `torrent::keys`) and mirrored in the frontend views.

## Platform differences

| Concern | Linux | Android |
|---|---|---|
| Folder picker | native dialog | in-app browser over `list_dirs` (native picker returns content URIs) |
| Scan roots | `$HOME` | `/storage/emulated/0` |
| Storage permission | none | `READ_MEDIA_AUDIO` + "All files access", requested in `MainActivity.kt` |
| Background playback | fine | webview may pause when the app is backgrounded (see DECISIONS) |
