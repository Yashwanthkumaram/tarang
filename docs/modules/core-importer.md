# Module: imports — v1 removed

The v1 importer (`crates/core/src/importer.rs`: Spotify privacy-export JSON, Exportify /
Takeout CSV, pasted text, matched against local files) was deleted in v2 together with its
commands (`import_file`, `import_text`, `list_imports`, `list_import_items`,
`delete_import`, `rematch_imports`).

* **Existing data**: database migration 2 turned every v1 import into a normal playlist of
  its matched songs (`playlists.imported_from` = `spotify`/`youtube`) and an
  `import_history` row. See [core-db.md](core-db.md).
* **v2 import pipeline** (Spotify / YouTube Music / SoundCloud links, matched against
  YouTube Music): `crates/core/src/sources/`, commands `import_preview`, `import_commit`,
  `list_import_history` (docs/API-v2.md). It stores results through
  `Db::create_playlist(name, None, Some(platform))`, `Db::add_to_playlist_mixed` (YtTracks
  become stream-only library rows) and `Db::add_import_history`.
