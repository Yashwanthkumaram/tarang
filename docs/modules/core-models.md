# Module: data model (`crates/core/src/models.rs`)

## What it does
Defines every type that crosses the core ↔ UI boundary. All derive `serde`, so the JSON the
frontend receives has exactly these field names (snake_case). `docs/API-v2.md` is the
contract; change it first.

## Public surface
| Type | Purpose |
|---|---|
| `Track` | One song or recording. `path: Option` (None = stream-only YouTube song), `video_id`, `thumbnail`, `last_played_at`, `liked`, computed `downloaded`. Voice recordings have `kind: Voice`. |
| `Source` | `local` (scanned file) · `youtube` (YouTube Music song). v1 values map to `local`. |
| `Kind` | `music` · `voice` · `unsure` (classifier result; `unsure` = review queue). |
| `YtTrack` | A YouTube Music result (search, imports); re-exported as `youtube::YtTrack`. `local_track_id` = a library track whose audio is already on the device. |
| `Playlist`, `PlaylistEntry`, `PlaylistDetail` | Library playlists; id 0 / `is_liked` = Liked songs. |
| `Group` | One album or artist row (`name, artist?, track_count, artwork?`). |
| `ImportRecord` | One import-history row. |
| `Download`, `DownloadKind` (`youtube`), `DownloadState` (`queued/active/paused/done/error`) | Download queue row, with `track_id`. |
| `LibraryStats` | Counts for Home/Library (`music, voice, unsure, liked, downloaded, playlists, total_bytes, total_secs, albums, artists`). |
| `StorageInfo` | `used_bytes, free_bytes, downloads_bytes, cache_bytes`. |
| `FolderRule`, `RuleKind`, `ScanMode`, `ScanConfig`, `ScanReport`, `Classification` | Scanner and classifier. |

Enums have `as_str()` / `parse()` so SQLite stores plain lowercase text.

## How to change it
* Add a field to `Track` → add a column in a **new** migration in `db.rs`, add it to
  `TRACK_COLS` and `row_to_track`, then to `docs/API-v2.md` and `src/js/mock.js`.

## Known limits
`Track.added_at` is set by the database on insert and `Track.downloaded` is computed on
read; the values you pass in are ignored.
