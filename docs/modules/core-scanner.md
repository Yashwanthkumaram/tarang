# Module: scanner & folder rules (`scanner.rs`, `paths.rs`, `tags.rs`)

## What it does
Walks folders, finds audio, reads tags, classifies new files and syncs the database.

## Scan modes (`ScanMode`)
| Mode | Roots walked |
|---|---|
| `whole_device` | platform roots (`$HOME` / `/storage/emulated/0`), minus excludes |
| `selected_folders` | enabled **include** rules + the **app** folder, minus excludes |
| `app_folder_only` | the app folder only |

Exclude rules are either absolute paths (prefix match) or bare names (`node_modules`)
matched at any depth. Hidden folders (`.something`) and folders with a `.nomedia` marker
(when the setting is on) are skipped.

## Per-file pipeline
1. `paths::is_audio` by extension (user-editable list, setting `scan.extensions`).
2. Skip if `(size, mtime)` unchanged in the database → `mark_seen`.
3. `tags::read` (lofty): title/artist/album, duration, sample rate, channels, bitrate.
4. Skip if shorter than `scan.min_duration_secs` (default 2 s: long enough to drop notification sounds, short enough to keep brief voice memos and voicemails).
5. If `classifier.enabled`: `classifier::classify_file` → `kind`, `confidence`, `reason`.
6. `db.upsert_track`.

Progress callback at start, then at most every 300 ms while walking (even through non-audio folders), then once with `finished = true`. Cancellation through an
`AtomicBool`.

## Settings keys (`scanner::keys`)
`scan.mode`, `scan.extensions`, `scan.min_duration_secs`, `scan.respect_nomedia`,
`classifier.enabled`, `classifier.threshold`, `classifier.use_hints`. The frontend uses the
same strings in `views/folders.js`.

## How to change it
* New default folder → `paths::default_include_folders`.
* New exclude default → `paths::DEFAULT_EXCLUDE_PATTERNS` (applied once, on first run, by
  `commands/scan.rs::seed_defaults`).
* Different skip logic → `is_excluded` in `scanner.rs`; there is a temp-dir test covering
  excludes, patterns and `.nomedia`.

## Known limits
* Tags are read with lofty in relaxed mode; if that still fails (Samsung Voice Recorder
  writes 3GPP-branded `.m4a`), sample rate, channels and duration come from Symphonia's
  demuxer and title/artist fall back to the file name.
* A track whose duration could not be read (stored as 0) is re-read on every scan so a
  parser improvement picks it up; everything else is skipped by size + mtime.
* No file watching yet; the UI's "watch folders" idea from the mockup is not implemented.
Symlinks are not followed.
