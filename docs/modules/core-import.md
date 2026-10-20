# Module: import from other apps (v2)

Brings songs and playlists from **Spotify**, **YouTube Music / YouTube** and **SoundCloud**
into the Library by link. Each song is matched on YouTube Music and the result is saved as a
normal playlist of YouTube rows (stream-only until downloaded). Decisions: D31, D32.

| file | role |
|---|---|
| `crates/core/src/sources/mod.rs` | `Platform` (detect/check links), `SourceItem`/`SourceList`, `PreviewItem`/`ImportPreview`, `Previews` (in-memory store), `preview()`, `commit()` |
| `crates/core/src/sources/spotify.rs` | link parsing, embed-page fetch and `__NEXT_DATA__` parsing |
| `crates/core/src/sources/ytdlp_playlist.rs` | yt-dlp listing for YouTube (`--flat-playlist -J`) and SoundCloud (`-j`), title/artist splitting |
| `crates/core/src/sources/matcher.rs` | search + scoring → matched / review / not_found, text normalisation |
| `crates/core/src/sources/fixtures/` | saved real responses used by the unit tests |
| `crates/core/examples/import.rs` | CLI to try a link on the desktop |
| `src-tauri/src/commands/imports.rs` | `import_preview`, `import_commit`, `list_import_history`, `import://progress` |

## Commands (API-v2)

* `import_preview(platform: "spotify"|"youtube"|"soundcloud", url)` →
  `{ preview_id, name, platform, source_url, note, items: [{ title, artist, duration_secs,
  status: "matched"|"review"|"not_found", match: YtTrack|null, alternatives: YtTrack[] }] }`.
  The link must belong to the chosen platform (readable error otherwise). `note` is a
  sentence for the user or null (Spotify's 100-song cut, dropped private YouTube videos).
  `match`/`alternatives` have `local_track_id` filled when the song is already on the device.
* `import_commit(previewId, name, include: number[], picks?: { [index]: YtTrack })` →
  `Playlist`. Creates the playlist (`imported_from` = platform; empty name → source name),
  adds the match (or the pick) of each included item in order, skips items without one,
  records `import_history`, and forgets the preview. Errors if nothing is left to add, an
  index is out of range, or the preview expired (only the 16 newest are kept, memory only).
* `list_import_history()` → `ImportRecord[]` (`{ id, platform, name, source_url,
  imported_at, total, matched, playlist_id }`, newest first).
* Event `import://progress` `{ preview_id, phase: "listing"|"matching", done, total }`.
  "listing" only occurs for SoundCloud. The frontend gets `preview_id` only when the call
  returns, so it should show whatever progress arrives while its one import is running.

## Sources

* **Spotify** (all platforms, plain HTTP): accepts `open.spotify.com/{playlist|album|track}/<id>`
  (with `intl-xx/`, `embed/`, query strings), `spotify:<kind>:<id>` and `spotify.link`
  share links (redirect followed). Fetches `https://open.spotify.com/embed/<kind>/<id>` and reads
  `props.pageProps.state.data.entity`: `name`, `trackList[{title, subtitle, duration ms}]`;
  a track entity has `artists[{name}]` and `duration`. Artists are separated by `, `.
  The embed lists at most **100** songs. Artist pages, profiles and Liked Songs are refused
  with an explanation. Private/removed lists → "Spotify didn't return this list…".
* **YouTube Music / YouTube** (desktop): `yt-dlp --flat-playlist -J --yes-playlist`.
  Entries give id, title, channel, duration. Titles are cleaned ("(Official Video)" etc.),
  "Artist - Title" / "Title - Artist" split using the channel name, " - Topic" and "VEVO"
  removed. The video itself is the match (no search). Album playlists (`OLAK5uy_…`) work;
  their name loses yt-dlp's "Album - " prefix.
* **SoundCloud** (desktop): sets, likes and single tracks through `yt-dlp -j` (the flat
  listing lacks titles/durations), one JSON line per track, ~1 s each, reported as progress.
  "Artist - Title" uploads are split; otherwise the uploader is the artist.
* On **Android** YouTube and SoundCloud return "Importing from … is not available on the
  phone yet. Spotify links work here." (no yt-dlp binary in the Rust process).

## Matching (`matcher.rs`)

Query `"<core title> <first artist>"`, 8 results, retried with the title alone if empty;
4 searches at a time (`CONCURRENCY`). Score per result: title = max bigram Dice of the
normalised core titles / full titles; artist = 1 when the first source artist is contained
in the result's artist, else word overlap; duration difference; version markers (live,
remix, acoustic, instrumental, karaoke, cover, slowed, sped, …) must agree.

* matched: title ≥ 0.85, artist ≥ 0.5, same version, |Δduration| ≤ 5 s (no duration:
  title ≥ 0.95, artist ≥ 0.8)
* review: best result has title ≥ 0.5 and (artist ≥ 0.3 or |Δ| ≤ 10 s), or title ≥ 0.3 and
  artist ≥ 0.5; `match` = best, `alternatives` = next 3
* not_found: `match` null, `alternatives` = best 3 results (may be empty)

A failed search makes that row not_found; if every search fails the preview fails
("Couldn't search YouTube Music — check your connection").

## Trying it

```
cargo run -p offline_core --example import -- https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa
cargo run -p offline_core --example import -- "https://music.youtube.com/playlist?list=OLAK5uy_kUDvDi-JgR__9d-UeVGRbr8aTgBVvZ6cE"
cargo run -p offline_core --example import -- https://soundcloud.com/forss/sets/soulhack
  … --list-only            only list, no matching
  … --commit /tmp/x.sqlite write the playlist into a database
```

Measured 2026-10-19 on the desktop: Random Access Memories 13/13 matched in 2.5 s; Today's
Top Hits 48 matched / 1 review / 1 not found of 50 in 6.6 s; a 182-video YouTube playlist
listed in 1.9 s; SoundCloud "Soulhack" (11) listed in 13 s, 9 matched.

Tests: `cargo test -p offline_core sources` (parsers on fixtures, matcher rules, commit
into an in-memory database). Network is not used by the tests.
