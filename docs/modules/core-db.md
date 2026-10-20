# Module: database (`crates/core/src/db.rs`)

## What it does
SQLite (bundled, WAL mode) behind a `Mutex<Connection>`. Every public method is a named
query; no other module writes SQL. Migrations are an array of SQL strings applied by
`PRAGMA user_version`, each in its own transaction with foreign keys off (SQLite's recipe
for rebuilding a table), then `foreign_keys=ON` for normal use.

## Tables (schema v2)
| Table | Holds |
|---|---|
| `tracks` | every song/recording. `path` is **nullable** (stream-only YouTube songs), `video_id` (unique when set), `thumbnail`, `last_played_at`, `liked` + `liked_at`, `kind`/`confidence`/`reason`, `user_kind` (manual override), `seen_in_scan` (deletion bookkeeping) |
| `playlists` | `(id, name, description, imported_from, created_at, updated_at)` |
| `playlist_entries` | `(entry_id, playlist_id, track_id, position)`; cascades from both sides |
| `import_history` | `(id, platform, name, source_url, imported_at, total, matched, playlist_id)`; `playlist_id` becomes NULL when the playlist is deleted |
| `folder_rules` | `(path, rule, enabled)`; `rule` ∈ include/exclude/app; one `app` row max |
| `settings` | key/value strings |
| `scan_runs` | timestamp + JSON `ScanReport` of each scan |

Migration 2 rebuilt `tracks` (SQLite cannot drop NOT NULL in place), rewrote v1 sources
`server`/`spotify`/`torrent` to `local`, turned every v1 import into a playlist of its
matched songs plus an `import_history` row, and dropped `import_playlists`, `import_items`,
`downloads` and the `torrent.*` / `server.*` settings. Test: `migrates_a_v1_database`.

## Concepts
* **In the library** = on the device (`path` set) **or** liked **or** in a playlist. A
  YouTube song that was only streamed keeps a row for Recently played (`last_played_at`)
  but is not listed, counted in stats, or shown in albums/artists.
* **Liked songs** is virtual playlist **id 0**: liked tracks ordered by `liked_at` desc; its
  `entry_id` is the track's SQLite rowid. Adding to id 0 likes, removing unlikes; rename,
  delete and reorder are rejected.
* **YouTube rows** are keyed by `video_id`: `ensure_youtube_track` creates one (path NULL)
  or returns the existing one. `like_youtube` / `add_to_playlist_mixed` first honour
  `YtTrack.local_track_id` (a file already on the device), then create.
* **Downloads** finish in `attach_download(yt, path, facts)`: sets `path` and file facts on
  the video's row. If the scanner indexed that file first, the scanned row's like and
  playlist entries move over and it is deleted, so there is never a duplicate.
* `Track.downloaded` is computed on read (`path` set and the file exists). Filters
  ("downloaded", "device") and counts use `path IS NOT NULL` in SQL.
* `prune_orphans` (run in `Db::open` only, so ids never vanish mid-session) deletes
  stream-only YouTube rows that are not liked, in no playlist and never played.

## Public surface
Tracks: `upsert_track` (scanner), `track_stamp`, `begin_scan`/`mark_seen`/`finish_scan`,
`list_tracks(kind, TrackFilter, query, TrackSort, limit)`, `get_track`,
`get_track_by_video`, `list_recent`, `set_track_kind`, `set_liked`, `record_play`,
`stats`, `list_albums`, `list_artists`, `find_match`, `match_local`.
YouTube: `ensure_youtube_track`, `like_youtube`, `attach_download`, `downloads_bytes`,
`prune_orphans`.
Playlists: `list_playlists`, `get_playlist`, `create_playlist(name, description,
imported_from)`, `rename_playlist`, `delete_playlist`, `add_to_playlist`,
`add_to_playlist_mixed(id, track_ids, yt_tracks)`, `remove_from_playlist`,
`reorder_playlist` (full order required), `playlist_missing_downloads`.
Imports: `add_import_history`, `list_import_history`.
Also folder rules, settings and scan runs.

## Invariants
* `upsert_track` never overwrites `kind` when `user_kind = 1`, and never turns a
  `youtube` row back into `local` (a scan of the download folder only refreshes file facts).
* `finish_scan(roots)` deletes only `local` rows under those roots that were not seen.
* Adding a song already in a playlist is a no-op (no duplicate entries); positions are
  always `0..n-1` after remove/reorder.

## How to change it
Append a new string to `MIGRATIONS`. Never edit an existing one; existing installs have
already applied it. Add a test in the same file (copy `migrates_a_v1_database` for data
migrations).

## Known limits
One connection, so a long query blocks others briefly. Playlist summaries stat every
entry's file (`downloaded_count`); fine for personal libraries.
