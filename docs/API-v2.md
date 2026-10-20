# v2 API contract (frontend ⇄ Tauri commands)

Single source of truth for the v2 rebuild. Backend agents implement exactly these commands
and shapes; frontend agents call only these (through `src/js/api.js`) and mirror them in
`src/js/mock.js`. Field names are snake_case JSON. Argument names are camelCase on the JS
side (Tauri converts them). Change this file first if a shape must change.

## Removed in v2
All torrent commands (`add_torrent`, `search_indexer`, `indexer_presets`), all self-hosted
server commands (`get_server_config`, `save_server_config`, `server_ping`, `server_search`,
`server_download`), and the v1 import commands (`import_file`, `import_text`, `list_imports`,
`list_import_items`, `delete_import`, `rematch_imports`). Delete their code
(`crates/core/src/torrent.rs`, `server.rs` except helpers still used, `importer.rs` v1 parts,
`src-tauri/src/commands/server.rs`) and the `librqbit` dependency.

## Shared shapes

```ts
Track {
  id: string                 // uuid
  path: string | null        // real file path when on device; null for not-downloaded YouTube songs
  video_id: string | null    // YouTube Music id when known
  title, artist?: string, album?: string
  duration_secs: number
  thumbnail: string | null   // https URL (YouTube) or null (render generated art)
  source: "local" | "youtube"
  kind: "music" | "voice" | "unsure"
  downloaded: boolean        // path != null && file exists
  liked: boolean
  play_count: number, last_played_at: number | null, added_at: number
  confidence, reason, format, sample_rate, channels, bitrate_kbps, size_bytes, modified_at  // unchanged from v1
}
YtTrack { video_id, title, artist, album?, duration_secs?, thumbnail?, explicit, local_track_id? }
Playlist {
  id: number, name: string, description: string | null
  track_count: number, total_secs: number, downloaded_count: number
  artwork: string[]          // up to 4 thumbnails for the mosaic (may be empty)
  imported_from: "spotify" | "youtube" | "soundcloud" | null
  is_liked: boolean          // the built-in "Liked songs" playlist (id 0, virtual)
  created_at, updated_at: number
}
PlaylistEntry { entry_id: number, position: number, track: Track }
Download { id, kind: "youtube", name, state: "queued"|"active"|"paused"|"done"|"error",
           progress 0..1, downloaded_bytes, total_bytes, speed_bps, eta_secs?, track_id?, error? }
```

## Commands

### Library
| command | args | returns |
|---|---|---|
| `get_stats` | – | `{ music, voice, unsure, liked, downloaded, playlists, total_bytes, total_secs, albums, artists }` |
| `list_tracks` | `kind, filter?: "all"\|"liked"\|"downloaded"\|"device", query?, sort?: "recent"\|"title"\|"artist"\|"album"\|"duration", limit?` | `Track[]` |
| `get_track` | `id` | `Track \| null` |
| `list_recent` | `limit?` | `Track[]` (by last_played_at) |
| `list_albums` / `list_artists` | `query?` | `[{ name, artist?, track_count, artwork? }]` |
| `set_liked` | `id, liked` | `Track` |
| `like_youtube` | `track: YtTrack, liked` | `Track` (creates a not-downloaded youtube Track row if needed) |
| `record_play` | `id, track?: YtTrack` | – (play_count++, last_played_at = now; with `track`, a stream started from search creates its youtube row first and `id` may be "") |
| `set_track_kind` | `id, kind` | – |

### Playlists
| command | args | returns |
|---|---|---|
| `list_playlists` | – | `Playlist[]` (Liked songs first) |
| `get_playlist` | `id` | `{ playlist: Playlist, entries: PlaylistEntry[] }` (id 0 = Liked songs) |
| `create_playlist` | `name, description?` | `Playlist` |
| `rename_playlist` | `id, name, description?` | `Playlist` |
| `delete_playlist` | `id` | – |
| `add_to_playlist` | `playlistId, trackIds?: string[], ytTracks?: YtTrack[]` | `Playlist` (YtTracks become youtube Track rows) |
| `remove_from_playlist` | `playlistId, entryIds` | `Playlist` |
| `reorder_playlist` | `playlistId, entryIds` (full new order) | `Playlist` |
| `download_playlist` | `id` | `string[]` download ids for not-yet-downloaded songs |

### YouTube Music (exists; keep)
`youtube_search(query, limit?) → YtTrack[]`, `youtube_stream_url(videoId) → { url, resolve_ms, cached }`,
`youtube_prefetch(videoIds)`, `youtube_download(track: YtTrack) → download id`,
`download_track(id) → download id` (for a youtube Track row), `youtube_version`, `youtube_update`.
A finished download updates the existing Track row (sets path) instead of creating a duplicate.

### Downloads
`list_downloads → Download[]`, `pause_download(id)`, `resume_download(id)`, `remove_download(id)`,
`retry_download(id)`, `clear_finished_downloads()`, `storage_info → { used_bytes, free_bytes, downloads_bytes, cache_bytes }`.

### Import from other apps (onboarding + Settings only)
| command | args | returns |
|---|---|---|
| `import_preview` | `platform: "spotify"\|"youtube"\|"soundcloud", url` | `{ preview_id, name, platform, items: [{ title, artist, duration_secs?, status: "matched"\|"review"\|"not_found", match: YtTrack \| null, alternatives: YtTrack[] }] }` |
| `import_commit` | `previewId, name, include: number[]` (item indexes) | `Playlist` |
| `list_import_history` | – | `[{ id, platform, name, imported_at, total, matched, playlist_id }]` |

Spotify: `open.spotify.com/{playlist,album,track}/<id>` via the embed page's `__NEXT_DATA__`.
YouTube Music / YouTube playlists: `yt-dlp --flat-playlist -J`. SoundCloud: `yt-dlp --flat-playlist -J`
on the set/likes URL. Each item is matched with `youtube::search` (title + artist, duration ±5 s →
matched; weaker → review with alternatives; none → not_found). Progress is emitted as event
`import://progress` `{ preview_id, done, total }`.

### Device scan (exists; keep)
`get_scan_config, list_folder_rules, add_folder_rule, remove_folder_rule, set_folder_rule_enabled,
start_scan, cancel_scan, is_scanning, last_scan, reclassify_track, list_dirs` + event `scan://progress`.

### Settings
`get_settings → map`, `set_setting(key, value)`, `get_platform → { os, is_mobile, data_dir, download_dir, version }`.
Keys: `ui.theme`, `ui.onboarded`, `playback.crossfade_secs`, `playback.gapless`, `playback.voice_speed`,
`stream.quality` ("high"|"normal"), `stream.cache_mb`, `download.quality`, `download.mobile_data`.

## Playback engine (frontend module `src/js/engine/`)
`engine.js` exports one interface used by `player.js`:
`load({ src?, path?, videoId? })`, `play()`, `pause()`, `seek(secs)`, `setRate(r)`, `setVolume(v)`,
`setMetadata({ title, artist, album, artwork })`, `setQueueHints({ hasPrev, hasNext })`, and events
`time {position, duration, buffered}`, `state {playing, buffering, ended, error}`,
`remote {action: "play"|"pause"|"next"|"prev"|"seek"|"like", position?}`.
Desktop implementation: HTML `<audio>` (Blob URL on Android not needed there) + Media Session.
Android implementation: native Media3 ExoPlayer in a `MediaSessionService` (foreground service,
media notification, lock screen, audio focus, becoming-noisy) driven through a Tauri mobile
plugin `playback`; local files by path, streams by URL from `youtube_stream_url`, with a
bounded on-disk stream cache (`stream.cache_mb`) cleared by `clear_stream_cache`.
The Android engine calls the `playback_*` commands (`playback_load {url?|path?, videoId?, title?, artist?,
album?, artworkUrl?, autoplay?, startMs?}`, `playback_play`, `playback_pause`, `playback_stop`,
`playback_seek {ms}`, `playback_set_rate`, `playback_set_volume`, `playback_set_queue_hints`,
`playback_set_metadata`, `playback_set_liked`, `playback_get_state`, `playback_cache_size`,
`playback_clear_cache`) and listens to `playback://state|ended|error|remote`; on desktop they
return "native playback is Android-only" (cache ones return 0 bytes).
