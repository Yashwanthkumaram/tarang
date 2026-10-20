//! SQLite persistence. One connection behind a mutex; every public method is a
//! small, named query so the UI layer never writes SQL.
//!
//! Schema lives in [`MIGRATIONS`]; add a new entry to change it, never edit an
//! old one. `user_version` tracks which migrations have run. Each migration runs in
//! its own transaction with foreign keys off (SQLite's recipe for table rebuilds).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;

const MIGRATIONS: &[&str] = &[
    // v1: initial schema
    r#"
    CREATE TABLE tracks (
        id            TEXT PRIMARY KEY,
        path          TEXT NOT NULL UNIQUE,
        title         TEXT NOT NULL,
        artist        TEXT,
        album         TEXT,
        duration_secs REAL NOT NULL DEFAULT 0,
        source        TEXT NOT NULL DEFAULT 'local',
        kind          TEXT NOT NULL DEFAULT 'music',
        confidence    REAL NOT NULL DEFAULT 1,
        reason        TEXT,
        format        TEXT NOT NULL DEFAULT '',
        sample_rate   INTEGER,
        channels      INTEGER,
        bitrate_kbps  INTEGER,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        modified_at   INTEGER NOT NULL DEFAULT 0,
        added_at      INTEGER NOT NULL DEFAULT 0,
        play_count    INTEGER NOT NULL DEFAULT 0,
        liked         INTEGER NOT NULL DEFAULT 0,
        user_kind     INTEGER NOT NULL DEFAULT 0,
        seen_in_scan  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_tracks_kind ON tracks(kind);
    CREATE INDEX idx_tracks_added ON tracks(added_at DESC);
    CREATE INDEX idx_tracks_artist ON tracks(artist);

    CREATE TABLE folder_rules (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        path    TEXT NOT NULL,
        rule    TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(path, rule)
    );

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE scan_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        report_json TEXT
    );

    CREATE TABLE import_playlists (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        source  TEXT NOT NULL,
        name    TEXT NOT NULL,
        total   INTEGER NOT NULL DEFAULT 0,
        matched INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE import_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id      INTEGER NOT NULL REFERENCES import_playlists(id) ON DELETE CASCADE,
        title            TEXT NOT NULL,
        artist           TEXT,
        album            TEXT,
        duration_secs    REAL,
        matched_track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL
    );

    CREATE TABLE downloads (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        state      TEXT NOT NULL,
        dest_dir   TEXT NOT NULL,
        magnet     TEXT,
        url        TEXT,
        created_at INTEGER NOT NULL
    );
    "#,
    // v2: YouTube songs without a file, playlists, import history; v1 torrent/server
    // leftovers removed. v1 imports become playlists of their matched songs.
    r#"
    CREATE TABLE tracks_v2 (
        id             TEXT PRIMARY KEY,
        path           TEXT UNIQUE,
        video_id       TEXT,
        title          TEXT NOT NULL,
        artist         TEXT,
        album          TEXT,
        duration_secs  REAL NOT NULL DEFAULT 0,
        thumbnail      TEXT,
        source         TEXT NOT NULL DEFAULT 'local',
        kind           TEXT NOT NULL DEFAULT 'music',
        confidence     REAL NOT NULL DEFAULT 1,
        reason         TEXT,
        format         TEXT NOT NULL DEFAULT '',
        sample_rate    INTEGER,
        channels       INTEGER,
        bitrate_kbps   INTEGER,
        size_bytes     INTEGER NOT NULL DEFAULT 0,
        modified_at    INTEGER NOT NULL DEFAULT 0,
        added_at       INTEGER NOT NULL DEFAULT 0,
        play_count     INTEGER NOT NULL DEFAULT 0,
        last_played_at INTEGER,
        liked          INTEGER NOT NULL DEFAULT 0,
        liked_at       INTEGER,
        user_kind      INTEGER NOT NULL DEFAULT 0,
        seen_in_scan   INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO tracks_v2 (id, path, video_id, title, artist, album, duration_secs, thumbnail,
        source, kind, confidence, reason, format, sample_rate, channels, bitrate_kbps,
        size_bytes, modified_at, added_at, play_count, last_played_at, liked, liked_at,
        user_kind, seen_in_scan)
    SELECT id, path, NULL, title, artist, album, duration_secs, NULL,
        CASE WHEN source = 'youtube' THEN 'youtube' ELSE 'local' END,
        kind, confidence, reason, format, sample_rate, channels, bitrate_kbps,
        size_bytes, modified_at, added_at, play_count, NULL, liked,
        CASE WHEN liked != 0 THEN added_at END,
        user_kind, seen_in_scan
    FROM tracks;
    DROP TABLE tracks;
    ALTER TABLE tracks_v2 RENAME TO tracks;
    CREATE INDEX idx_tracks_kind ON tracks(kind);
    CREATE INDEX idx_tracks_added ON tracks(added_at DESC);
    CREATE INDEX idx_tracks_artist ON tracks(artist);
    CREATE INDEX idx_tracks_played ON tracks(last_played_at DESC);
    CREATE INDEX idx_tracks_liked ON tracks(liked, liked_at DESC);
    CREATE UNIQUE INDEX idx_tracks_video ON tracks(video_id) WHERE video_id IS NOT NULL;

    CREATE TABLE playlists (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        description   TEXT,
        imported_from TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE TABLE playlist_entries (
        entry_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL
    );
    CREATE INDEX idx_entries_playlist ON playlist_entries(playlist_id, position);
    CREATE INDEX idx_entries_track ON playlist_entries(track_id);
    CREATE TABLE import_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        platform    TEXT NOT NULL,
        name        TEXT NOT NULL,
        source_url  TEXT,
        imported_at INTEGER NOT NULL,
        total       INTEGER NOT NULL DEFAULT 0,
        matched     INTEGER NOT NULL DEFAULT 0,
        playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL
    );

    INSERT INTO playlists (id, name, description, imported_from, created_at, updated_at)
    SELECT id, name, NULL,
        CASE WHEN source IN ('spotify', 'youtube') THEN source END,
        CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
    FROM import_playlists;
    INSERT INTO playlist_entries (playlist_id, track_id, position)
    SELECT playlist_id, matched_track_id,
        ROW_NUMBER() OVER (PARTITION BY playlist_id ORDER BY id) - 1
    FROM import_items
    WHERE matched_track_id IN (SELECT id FROM tracks);
    INSERT INTO import_history (platform, name, source_url, imported_at, total, matched, playlist_id)
    SELECT source, name, NULL, CAST(strftime('%s', 'now') AS INTEGER), total, matched, id
    FROM import_playlists;
    DROP TABLE import_items;
    DROP TABLE import_playlists;

    DROP TABLE downloads;
    DELETE FROM settings WHERE key LIKE 'torrent.%' OR key LIKE 'server.%';
    "#,
];

/// Thread-safe handle to the library database.
pub struct Db {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Which slice of the library `list_tracks` returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackFilter {
    /// Everything in the library: on the device, liked, or in a playlist.
    All,
    Liked,
    /// YouTube songs kept on the device.
    Downloaded,
    /// Files found by the device scan.
    Device,
}

impl TrackFilter {
    pub fn parse(s: &str) -> TrackFilter {
        match s {
            "liked" => TrackFilter::Liked,
            "downloaded" => TrackFilter::Downloaded,
            "device" => TrackFilter::Device,
            _ => TrackFilter::All,
        }
    }
    fn sql(self) -> &'static str {
        match self {
            TrackFilter::All => IN_LIBRARY,
            TrackFilter::Liked => "liked = 1",
            TrackFilter::Downloaded => "(source = 'youtube' AND path IS NOT NULL)",
            TrackFilter::Device => "(source = 'local' AND path IS NOT NULL)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackSort {
    /// Newest first.
    Recent,
    Title,
    Artist,
    Album,
    /// Shortest first.
    Duration,
}

impl TrackSort {
    pub fn parse(s: &str) -> TrackSort {
        match s {
            "title" => TrackSort::Title,
            "artist" => TrackSort::Artist,
            "album" => TrackSort::Album,
            "duration" => TrackSort::Duration,
            _ => TrackSort::Recent,
        }
    }
    fn sql(self) -> &'static str {
        match self {
            TrackSort::Recent => "added_at DESC, title COLLATE NOCASE",
            TrackSort::Title => "title COLLATE NOCASE, artist COLLATE NOCASE",
            TrackSort::Artist => "artist IS NULL, artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE",
            TrackSort::Album => "album IS NULL, album COLLATE NOCASE, title COLLATE NOCASE",
            TrackSort::Duration => "duration_secs, title COLLATE NOCASE",
        }
    }
}

/// A row belongs to the library (rather than only to play history) when its audio is
/// on the device, it is liked, or it sits in a playlist.
const IN_LIBRARY: &str = "(path IS NOT NULL OR liked = 1 OR EXISTS (SELECT 1 FROM playlist_entries pe WHERE pe.track_id = tracks.id))";

/// File facts recorded when a download finishes.
#[derive(Debug, Clone, Default)]
pub struct FileFacts {
    pub format: String,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bitrate_kbps: Option<u32>,
    pub size_bytes: u64,
    /// 0 keeps the duration already stored.
    pub duration_secs: f64,
}

fn file_exists(path: Option<&str>) -> bool {
    path.map(|p| Path::new(p).is_file()).unwrap_or(false)
}

impl Db {
    /// Opens (or creates) the database file and applies pending migrations.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).with_context(|| format!("open db {}", path.display()))?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        if let Err(e) = db.prune_orphans() {
            tracing::warn!("prune orphans: {e:#}");
        }
        Ok(db)
    }

    /// In-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        let db = Db { conn: Mutex::new(Connection::open_in_memory()?) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql).with_context(|| format!("migration {}", i + 1))?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(())
    }

    // ------------------------------------------------------------------ tracks

    fn row_to_track(r: &Row) -> rusqlite::Result<Track> {
        let path: Option<String> = r.get("path")?;
        Ok(Track {
            id: r.get("id")?,
            downloaded: file_exists(path.as_deref()),
            path,
            video_id: r.get("video_id")?,
            title: r.get("title")?,
            artist: r.get("artist")?,
            album: r.get("album")?,
            duration_secs: r.get("duration_secs")?,
            thumbnail: r.get("thumbnail")?,
            source: Source::parse(&r.get::<_, String>("source")?),
            kind: Kind::parse(&r.get::<_, String>("kind")?),
            confidence: r.get("confidence")?,
            reason: r.get("reason")?,
            format: r.get("format")?,
            sample_rate: r.get("sample_rate")?,
            channels: r.get("channels")?,
            bitrate_kbps: r.get("bitrate_kbps")?,
            size_bytes: r.get::<_, i64>("size_bytes")? as u64,
            modified_at: r.get("modified_at")?,
            added_at: r.get("added_at")?,
            play_count: r.get::<_, i64>("play_count")? as u32,
            last_played_at: r.get("last_played_at")?,
            liked: r.get::<_, i64>("liked")? != 0,
        })
    }

    /// Column list for `row_to_track`. Unqualified on purpose: no joined table in
    /// this file shares a column name with `tracks`.
    const TRACK_COLS: &'static str = "id, path, video_id, title, artist, album, duration_secs, thumbnail, source, kind, confidence, reason, format, sample_rate, channels, bitrate_kbps, size_bytes, modified_at, added_at, play_count, last_played_at, liked";

    fn track_by_id(conn: &Connection, id: &str) -> Result<Option<Track>> {
        let sql = format!("SELECT {} FROM tracks WHERE id=?1", Self::TRACK_COLS);
        Ok(conn.query_row(&sql, params![id], Self::row_to_track).optional()?)
    }

    fn track_by_video(conn: &Connection, video_id: &str) -> Result<Option<Track>> {
        let sql = format!("SELECT {} FROM tracks WHERE video_id=?1", Self::TRACK_COLS);
        Ok(conn.query_row(&sql, params![video_id], Self::row_to_track).optional()?)
    }

    fn query_tracks(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Track>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(args, Self::row_to_track)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Inserts or updates a scanned file by path. A user-set kind is never overwritten
    /// by the scanner, and a downloaded YouTube song keeps its source and metadata.
    /// Returns true when a new row was created.
    pub fn upsert_track(&self, t: &Track) -> Result<bool> {
        let path = t.path.as_deref().ok_or_else(|| anyhow!("upsert_track needs a file path"))?;
        let conn = self.conn.lock().unwrap();
        let existing: Option<(String, i64, String)> = conn
            .query_row("SELECT id, user_kind, source FROM tracks WHERE path = ?1", params![path], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        match existing {
            Some((id, _, source)) if source == "youtube" => {
                // The scan found a song we downloaded: refresh only the file facts.
                conn.execute(
                    "UPDATE tracks SET format=?2, sample_rate=?3, channels=?4, bitrate_kbps=?5,
                        size_bytes=?6, modified_at=?7, seen_in_scan=1 WHERE id=?1",
                    params![id, t.format, t.sample_rate, t.channels, t.bitrate_kbps, t.size_bytes as i64, t.modified_at],
                )?;
                Ok(false)
            }
            Some((id, user_kind, _)) => {
                let keep_kind = user_kind != 0;
                conn.execute(
                    "UPDATE tracks SET title=?2, artist=?3, album=?4, duration_secs=?5, source=?6,
                        kind = CASE WHEN ?16 THEN kind ELSE ?7 END,
                        confidence = CASE WHEN ?16 THEN confidence ELSE ?8 END,
                        reason = CASE WHEN ?16 THEN reason ELSE ?9 END,
                        format=?10, sample_rate=?11, channels=?12, bitrate_kbps=?13,
                        size_bytes=?14, modified_at=?15, seen_in_scan=1
                     WHERE id=?1",
                    params![
                        id, t.title, t.artist, t.album, t.duration_secs, t.source.as_str(),
                        t.kind.as_str(), t.confidence, t.reason, t.format, t.sample_rate,
                        t.channels, t.bitrate_kbps, t.size_bytes as i64, t.modified_at, keep_kind
                    ],
                )?;
                Ok(false)
            }
            None => {
                conn.execute(
                    "INSERT INTO tracks (id, path, video_id, title, artist, album, duration_secs, thumbnail,
                        source, kind, confidence, reason, format, sample_rate, channels, bitrate_kbps,
                        size_bytes, modified_at, added_at, seen_in_scan)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,1)",
                    params![
                        t.id, path, t.video_id, t.title, t.artist, t.album, t.duration_secs, t.thumbnail,
                        t.source.as_str(), t.kind.as_str(), t.confidence, t.reason, t.format, t.sample_rate,
                        t.channels, t.bitrate_kbps, t.size_bytes as i64, t.modified_at, now()
                    ],
                )?;
                Ok(true)
            }
        }
    }

    /// Returns (size, mtime, duration) for a path so the scanner can skip unchanged files.
    pub fn track_stamp(&self, path: &str) -> Result<Option<(u64, i64, f64)>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT size_bytes, modified_at, duration_secs FROM tracks WHERE path=?1", params![path], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get(1)?, r.get(2)?))
            })
            .optional()?)
    }

    pub fn mark_seen(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE tracks SET seen_in_scan=1 WHERE path=?1", params![path])?;
        Ok(())
    }

    /// Call before a scan: clears the "seen" flag for local tracks under the given roots.
    pub fn begin_scan(&self, roots: &[String]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for root in roots {
            let like = format!("{}%", root.trim_end_matches('/'));
            conn.execute("UPDATE tracks SET seen_in_scan=0 WHERE path LIKE ?1 AND source = 'local'", params![like])?;
        }
        Ok(())
    }

    /// Call after a scan: removes local tracks under the roots that were not seen
    /// (deleted files). YouTube rows are never removed by a scan.
    pub fn finish_scan(&self, roots: &[String]) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let mut removed = 0;
        for root in roots {
            let like = format!("{}%", root.trim_end_matches('/'));
            removed += conn.execute(
                "DELETE FROM tracks WHERE path LIKE ?1 AND seen_in_scan=0 AND source = 'local'",
                params![like],
            )? as u64;
        }
        Ok(removed)
    }

    /// Lists tracks of a kind. `query` matches title, artist, album or path.
    pub fn list_tracks(&self, kind: Kind, filter: TrackFilter, query: Option<&str>, sort: TrackSort, limit: u32) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let like = query.map(|q| q.trim()).filter(|q| !q.is_empty()).map(|q| format!("%{q}%"));
        let sql = format!(
            "SELECT {} FROM tracks WHERE kind=?1 AND {}
               AND (?2 IS NULL OR title LIKE ?2 OR artist LIKE ?2 OR album LIKE ?2 OR path LIKE ?2)
             ORDER BY {} LIMIT ?3",
            Self::TRACK_COLS,
            filter.sql(),
            sort.sql()
        );
        Self::query_tracks(&conn, &sql, params![kind.as_str(), like, limit])
    }

    pub fn get_track(&self, id: &str) -> Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        Self::track_by_id(&conn, id)
    }

    pub fn get_track_by_video(&self, video_id: &str) -> Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        Self::track_by_video(&conn, video_id)
    }

    /// Songs played most recently first (voice recordings excluded).
    pub fn list_recent(&self, limit: u32) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM tracks WHERE last_played_at IS NOT NULL AND kind != 'voice'
             ORDER BY last_played_at DESC LIMIT ?1",
            Self::TRACK_COLS
        );
        Self::query_tracks(&conn, &sql, params![limit])
    }

    /// User override: marks a track as music or voice with full confidence.
    pub fn set_track_kind(&self, id: &str, kind: Kind) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET kind=?2, confidence=1, reason='Set by you', user_kind=1 WHERE id=?1",
            params![id, kind.as_str()],
        )?;
        Ok(())
    }

    fn set_liked_c(conn: &Connection, id: &str, liked: bool) -> Result<usize> {
        Ok(if liked {
            // Keep the original like time when it is already liked.
            conn.execute(
                "UPDATE tracks SET liked_at = CASE WHEN liked = 1 THEN liked_at ELSE ?2 END, liked = 1 WHERE id=?1",
                params![id, now()],
            )?
        } else {
            conn.execute("UPDATE tracks SET liked = 0, liked_at = NULL WHERE id=?1", params![id])?
        })
    }

    /// Likes or unlikes a track and returns it.
    pub fn set_liked(&self, id: &str, liked: bool) -> Result<Track> {
        let conn = self.conn.lock().unwrap();
        if Self::set_liked_c(&conn, id, liked)? == 0 {
            bail!("track not found");
        }
        Self::track_by_id(&conn, id)?.ok_or_else(|| anyhow!("track not found"))
    }

    /// play_count + 1 and last_played_at = now.
    pub fn record_play(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE tracks SET play_count = play_count + 1, last_played_at = ?2 WHERE id=?1", params![id, now()])?;
        Ok(())
    }

    // --------------------------------------------------------- YouTube songs

    /// The YouTube row for this video, created (stream-only, `path` NULL) if missing.
    /// Missing artwork/album on an existing row are filled in from `yt`.
    fn ensure_youtube_c(conn: &Connection, yt: &YtTrack) -> Result<Track> {
        if yt.video_id.trim().is_empty() {
            bail!("missing YouTube video id");
        }
        if let Some(t) = Self::track_by_video(conn, &yt.video_id)? {
            if (t.thumbnail.is_none() && yt.thumbnail.is_some()) || (t.album.is_none() && yt.album.is_some()) {
                conn.execute(
                    "UPDATE tracks SET thumbnail = COALESCE(thumbnail, ?2), album = COALESCE(album, ?3) WHERE id=?1",
                    params![t.id, yt.thumbnail, yt.album],
                )?;
                return Self::track_by_id(conn, &t.id)?.ok_or_else(|| anyhow!("track vanished"));
            }
            return Ok(t);
        }
        let id = crate::new_id();
        let artist = Some(yt.artist.trim()).filter(|a| !a.is_empty());
        conn.execute(
            "INSERT INTO tracks (id, path, video_id, title, artist, album, duration_secs, thumbnail,
                source, kind, confidence, reason, added_at)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, 'youtube', 'music', 1, 'YouTube Music', ?8)",
            params![id, yt.video_id, yt.title, artist, yt.album, yt.duration_secs.unwrap_or(0.0), yt.thumbnail, now()],
        )?;
        Self::track_by_id(conn, &id)?.ok_or_else(|| anyhow!("insert failed"))
    }

    /// The library row a YouTube result stands for: the row with this video id, else the
    /// on-device track it was matched to (`local_track_id`), else a new stream-only row.
    fn resolve_youtube_c(conn: &Connection, yt: &YtTrack) -> Result<Track> {
        if let Some(t) = Self::track_by_video(conn, &yt.video_id)? {
            return Ok(t);
        }
        if let Some(local) = yt.local_track_id.as_deref() {
            if let Some(t) = Self::track_by_id(conn, local)? {
                return Ok(t);
            }
        }
        Self::ensure_youtube_c(conn, yt)
    }

    /// The YouTube row for this video, created if missing (used before downloads and by imports).
    pub fn ensure_youtube_track(&self, yt: &YtTrack) -> Result<Track> {
        let conn = self.conn.lock().unwrap();
        Self::ensure_youtube_c(&conn, yt)
    }

    /// Likes or unlikes a YouTube result, creating its library row when needed.
    pub fn like_youtube(&self, yt: &YtTrack, liked: bool) -> Result<Track> {
        let conn = self.conn.lock().unwrap();
        let t = Self::resolve_youtube_c(&conn, yt)?;
        Self::set_liked_c(&conn, &t.id, liked)?;
        Self::track_by_id(&conn, &t.id)?.ok_or_else(|| anyhow!("track vanished"))
    }

    /// Records a finished download on the video's row (creating it if it was pruned)
    /// instead of adding a duplicate. If another row already owns `path` (the scanner
    /// got there first), its likes and playlist entries move to this row and it is removed.
    pub fn attach_download(&self, yt: &YtTrack, path: &str, facts: &FileFacts) -> Result<Track> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let t = Self::ensure_youtube_c(&tx, yt)?;
        let other: Option<(String, i64)> = tx
            .query_row("SELECT id, liked FROM tracks WHERE path=?1 AND id != ?2", params![path, t.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((other_id, other_liked)) = other {
            if other_liked != 0 {
                Self::set_liked_c(&tx, &t.id, true)?;
            }
            tx.execute("UPDATE playlist_entries SET track_id=?2 WHERE track_id=?1", params![other_id, t.id])?;
            tx.execute("DELETE FROM tracks WHERE id=?1", params![other_id])?;
        }
        tx.execute(
            "UPDATE tracks SET path=?2, format=?3, sample_rate=?4, channels=?5, bitrate_kbps=?6, size_bytes=?7,
                duration_secs = CASE WHEN ?8 > 0 THEN ?8 ELSE duration_secs END,
                modified_at=?9, source='youtube', reason='Downloaded from YouTube Music', seen_in_scan=1
             WHERE id=?1",
            params![t.id, path, facts.format, facts.sample_rate, facts.channels, facts.bitrate_kbps, facts.size_bytes as i64, facts.duration_secs, now()],
        )?;
        let out = Self::track_by_id(&tx, &t.id)?.ok_or_else(|| anyhow!("track vanished"))?;
        tx.commit()?;
        Ok(out)
    }

    /// Fills `local_track_id` on search results whose audio is already on the device.
    pub fn match_local(&self, hits: &mut [YtTrack]) -> Result<()> {
        for h in hits.iter_mut() {
            let by_video = {
                let conn = self.conn.lock().unwrap();
                Self::track_by_video(&conn, &h.video_id)?.filter(|t| t.downloaded)
            };
            h.local_track_id = match by_video {
                Some(t) => Some(t.id),
                None => self.find_match(&h.title, Some(&h.artist), h.duration_secs)?.filter(|t| t.downloaded).map(|t| t.id),
            };
        }
        Ok(())
    }

    /// Deletes stream-only YouTube rows nothing refers to any more (not liked, in no
    /// playlist, never played). Run at startup so ids never vanish mid-session.
    pub fn prune_orphans(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "DELETE FROM tracks WHERE source='youtube' AND path IS NULL AND liked=0 AND last_played_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM playlist_entries pe WHERE pe.track_id = tracks.id)",
            [],
        )? as u64)
    }

    /// Bytes of downloaded YouTube songs still on disk.
    pub fn downloads_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM tracks WHERE source='youtube' AND path IS NOT NULL")?;
        let paths = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(paths.iter().filter_map(|p| std::fs::metadata(p).ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
    }

    // ----------------------------------------------------------- stats, groups

    pub fn stats(&self) -> Result<LibraryStats> {
        let conn = self.conn.lock().unwrap();
        let mut s = LibraryStats::default();
        let sql = format!(
            "SELECT kind, COUNT(*), COALESCE(SUM(CASE WHEN path IS NOT NULL THEN size_bytes END),0), COALESCE(SUM(duration_secs),0)
             FROM tracks WHERE {IN_LIBRARY} GROUP BY kind"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, f64>(3)?)))?;
        for row in rows {
            let (kind, n, bytes, secs) = row?;
            match Kind::parse(&kind) {
                Kind::Music => { s.music = n as u64; s.total_bytes += bytes as u64; s.total_secs += secs; }
                Kind::Voice => s.voice = n as u64,
                Kind::Unsure => s.unsure = n as u64,
            }
        }
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map(|n| n as u64);
        s.liked = count("SELECT COUNT(*) FROM tracks WHERE liked=1")?;
        s.downloaded = count("SELECT COUNT(*) FROM tracks WHERE source='youtube' AND path IS NOT NULL")?;
        s.playlists = count("SELECT COUNT(*) FROM playlists")?;
        s.albums = count(&format!("SELECT COUNT(DISTINCT LOWER(album)) FROM tracks WHERE kind='music' AND album IS NOT NULL AND TRIM(album) != '' AND {IN_LIBRARY}"))?;
        s.artists = count(&format!("SELECT COUNT(DISTINCT LOWER(artist)) FROM tracks WHERE kind='music' AND artist IS NOT NULL AND TRIM(artist) != '' AND {IN_LIBRARY}"))?;
        Ok(s)
    }

    fn groups(&self, column: &str, query: Option<&str>) -> Result<Vec<Group>> {
        let conn = self.conn.lock().unwrap();
        let like = query.map(|q| q.trim()).filter(|q| !q.is_empty()).map(|q| format!("%{q}%"));
        let sql = format!(
            "SELECT {column}, COUNT(*), COUNT(DISTINCT LOWER(artist)), MAX(artist), MAX(thumbnail) FROM tracks
             WHERE kind='music' AND {column} IS NOT NULL AND TRIM({column}) != '' AND {IN_LIBRARY}
               AND (?1 IS NULL OR album LIKE ?1 OR artist LIKE ?1)
             GROUP BY {column} COLLATE NOCASE ORDER BY {column} COLLATE NOCASE"
        );
        let is_album = column == "album";
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![like], |r| {
            let artists: i64 = r.get(2)?;
            Ok(Group {
                name: r.get(0)?,
                artist: if is_album && artists == 1 { r.get(3)? } else { None },
                track_count: r.get::<_, i64>(1)? as u32,
                artwork: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn list_albums(&self, query: Option<&str>) -> Result<Vec<Group>> {
        self.groups("album", query)
    }

    pub fn list_artists(&self, query: Option<&str>) -> Result<Vec<Group>> {
        self.groups("artist", query)
    }

    /// Finds an on-device track that matches an external title/artist (used by search
    /// to flag "already on this device").
    pub fn find_match(&self, title: &str, artist: Option<&str>, duration_secs: Option<f64>) -> Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM tracks WHERE kind='music' AND path IS NOT NULL AND LOWER(title)=LOWER(?1)
               AND (?2 IS NULL OR artist IS NULL OR LOWER(artist) LIKE '%' || LOWER(?2) || '%')
               AND (?3 IS NULL OR duration_secs = 0 OR ABS(duration_secs - ?3) < 4)
             ORDER BY (artist IS NULL) LIMIT 1",
            Self::TRACK_COLS
        );
        Ok(conn.query_row(&sql, params![title.trim(), artist, duration_secs], Self::row_to_track).optional()?)
    }

    // --------------------------------------------------------------- playlists

    /// Count, total time, downloaded count and up to 4 artworks from (path, thumbnail, secs).
    fn summarize(rows: impl IntoIterator<Item = (Option<String>, Option<String>, f64)>) -> (u32, f64, u32, Vec<String>) {
        let (mut n, mut secs, mut down) = (0u32, 0f64, 0u32);
        let mut art: Vec<String> = Vec::new();
        for (path, thumb, d) in rows {
            n += 1;
            secs += d;
            if file_exists(path.as_deref()) {
                down += 1;
            }
            if let Some(t) = thumb {
                if art.len() < 4 && !art.contains(&t) {
                    art.push(t);
                }
            }
        }
        (n, secs, down, art)
    }

    fn liked_playlist_c(conn: &Connection) -> Result<Playlist> {
        let mut stmt = conn.prepare("SELECT path, thumbnail, duration_secs FROM tracks WHERE liked=1 ORDER BY liked_at DESC, rowid DESC")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let (track_count, total_secs, downloaded_count, artwork) = Self::summarize(rows);
        let updated_at: Option<i64> = conn.query_row("SELECT MAX(liked_at) FROM tracks WHERE liked=1", [], |r| r.get(0))?;
        Ok(Playlist {
            id: 0,
            name: "Liked songs".into(),
            description: None,
            track_count,
            total_secs,
            downloaded_count,
            artwork,
            imported_from: None,
            is_liked: true,
            created_at: 0,
            updated_at: updated_at.unwrap_or(0),
        })
    }

    fn playlist_c(conn: &Connection, id: i64) -> Result<Option<Playlist>> {
        if id == 0 {
            return Self::liked_playlist_c(conn).map(Some);
        }
        let head = conn
            .query_row(
                "SELECT name, description, imported_from, created_at, updated_at FROM playlists WHERE id=?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)),
            )
            .optional()?;
        let Some((name, description, imported_from, created_at, updated_at)) = head else { return Ok(None) };
        let mut stmt = conn.prepare(
            "SELECT t.path, t.thumbnail, t.duration_secs FROM playlist_entries e JOIN tracks t ON t.id = e.track_id
             WHERE e.playlist_id=?1 ORDER BY e.position, e.entry_id",
        )?;
        let rows = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let (track_count, total_secs, downloaded_count, artwork) = Self::summarize(rows);
        Ok(Some(Playlist { id, name, description, track_count, total_secs, downloaded_count, artwork, imported_from, is_liked: false, created_at, updated_at }))
    }

    fn playlist_or_err(conn: &Connection, id: i64) -> Result<Playlist> {
        Self::playlist_c(conn, id)?.ok_or_else(|| anyhow!("playlist not found"))
    }

    fn touch(conn: &Connection, id: i64) -> Result<()> {
        conn.execute("UPDATE playlists SET updated_at=?2 WHERE id=?1", params![id, now()])?;
        Ok(())
    }

    /// Liked songs first, then user playlists, most recently changed first.
    pub fn list_playlists(&self) -> Result<Vec<Playlist>> {
        let conn = self.conn.lock().unwrap();
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM playlists ORDER BY updated_at DESC, id DESC")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = vec![Self::liked_playlist_c(&conn)?];
        for id in ids {
            if let Some(p) = Self::playlist_c(&conn, id)? {
                out.push(p);
            }
        }
        Ok(out)
    }

    pub fn get_playlist(&self, id: i64) -> Result<Option<PlaylistDetail>> {
        let conn = self.conn.lock().unwrap();
        let Some(playlist) = Self::playlist_c(&conn, id)? else { return Ok(None) };
        let entries = Self::entries_c(&conn, id)?;
        Ok(Some(PlaylistDetail { playlist, entries }))
    }

    fn entries_c(conn: &Connection, id: i64) -> Result<Vec<PlaylistEntry>> {
        let sql = if id == 0 {
            format!("SELECT tracks.rowid AS entry_id, {} FROM tracks WHERE liked=1 ORDER BY liked_at DESC, tracks.rowid DESC", Self::TRACK_COLS)
        } else {
            format!(
                "SELECT e.entry_id AS entry_id, {} FROM playlist_entries e JOIN tracks ON tracks.id = e.track_id
                 WHERE e.playlist_id=?1 ORDER BY e.position, e.entry_id",
                Self::TRACK_COLS
            )
        };
        let mut stmt = conn.prepare(&sql)?;
        let map = |r: &Row| Ok((r.get::<_, i64>("entry_id")?, Self::row_to_track(r)?));
        let rows: Vec<(i64, Track)> = if id == 0 {
            stmt.query_map([], map)?.collect::<rusqlite::Result<_>>()?
        } else {
            stmt.query_map(params![id], map)?.collect::<rusqlite::Result<_>>()?
        };
        Ok(rows.into_iter().enumerate().map(|(i, (entry_id, track))| PlaylistEntry { entry_id, position: i as u32, track }).collect())
    }

    /// `imported_from`: "spotify" | "youtube" | "soundcloud" for imports, else None.
    pub fn create_playlist(&self, name: &str, description: Option<&str>, imported_from: Option<&str>) -> Result<Playlist> {
        let name = name.trim();
        if name.is_empty() {
            bail!("give the playlist a name");
        }
        let description = description.map(str::trim).filter(|d| !d.is_empty());
        let conn = self.conn.lock().unwrap();
        let t = now();
        conn.execute(
            "INSERT INTO playlists (name, description, imported_from, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![name, description, imported_from, t],
        )?;
        let id = conn.last_insert_rowid();
        Self::playlist_or_err(&conn, id)
    }

    pub fn rename_playlist(&self, id: i64, name: &str, description: Option<&str>) -> Result<Playlist> {
        if id == 0 {
            bail!("Liked songs cannot be renamed");
        }
        let name = name.trim();
        if name.is_empty() {
            bail!("give the playlist a name");
        }
        let description = description.map(str::trim).filter(|d| !d.is_empty());
        let conn = self.conn.lock().unwrap();
        if conn.execute("UPDATE playlists SET name=?2, description=?3, updated_at=?4 WHERE id=?1", params![id, name, description, now()])? == 0 {
            bail!("playlist not found");
        }
        Self::playlist_or_err(&conn, id)
    }

    /// Deletes a playlist and its entries; the songs stay in the library.
    pub fn delete_playlist(&self, id: i64) -> Result<()> {
        if id == 0 {
            bail!("Liked songs cannot be deleted");
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id=?1", params![id])?;
        Ok(())
    }

    /// Appends tracks in order, skipping ones already in the playlist. For Liked songs
    /// (id 0) this likes them.
    pub fn add_to_playlist(&self, id: i64, track_ids: &[String]) -> Result<Playlist> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        Self::add_c(&tx, id, track_ids)?;
        let p = Self::playlist_or_err(&tx, id)?;
        tx.commit()?;
        Ok(p)
    }

    /// Like [`add_to_playlist`](Self::add_to_playlist), turning YouTube results into
    /// library rows first (stream-only until downloaded).
    pub fn add_to_playlist_mixed(&self, id: i64, track_ids: &[String], yt_tracks: &[YtTrack]) -> Result<Playlist> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut ids: Vec<String> = track_ids.to_vec();
        for yt in yt_tracks {
            ids.push(Self::resolve_youtube_c(&tx, yt)?.id);
        }
        Self::add_c(&tx, id, &ids)?;
        let p = Self::playlist_or_err(&tx, id)?;
        tx.commit()?;
        Ok(p)
    }

    fn add_c(conn: &Connection, id: i64, track_ids: &[String]) -> Result<()> {
        if id == 0 {
            for t in track_ids {
                Self::set_liked_c(conn, t, true)?;
            }
            return Ok(());
        }
        if Self::playlist_c(conn, id)?.is_none() {
            bail!("playlist not found");
        }
        let mut present: HashSet<String> = conn
            .prepare("SELECT track_id FROM playlist_entries WHERE playlist_id=?1")?
            .query_map(params![id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut next: i64 = conn.query_row("SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_entries WHERE playlist_id=?1", params![id], |r| r.get(0))?;
        for t in track_ids {
            if present.contains(t) || Self::track_by_id(conn, t)?.is_none() {
                continue;
            }
            conn.execute("INSERT INTO playlist_entries (playlist_id, track_id, position) VALUES (?1, ?2, ?3)", params![id, t, next])?;
            present.insert(t.clone());
            next += 1;
        }
        Self::touch(conn, id)
    }

    /// Removes entries. For Liked songs the entry ids are track rowids and the songs are unliked.
    pub fn remove_from_playlist(&self, id: i64, entry_ids: &[i64]) -> Result<Playlist> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if id == 0 {
            for e in entry_ids {
                tx.execute("UPDATE tracks SET liked=0, liked_at=NULL WHERE rowid=?1", params![e])?;
            }
        } else {
            for e in entry_ids {
                tx.execute("DELETE FROM playlist_entries WHERE playlist_id=?1 AND entry_id=?2", params![id, e])?;
            }
            Self::renumber(&tx, id)?;
            Self::touch(&tx, id)?;
        }
        let p = Self::playlist_or_err(&tx, id)?;
        tx.commit()?;
        Ok(p)
    }

    fn renumber(conn: &Connection, id: i64) -> Result<()> {
        let ids: Vec<i64> = conn
            .prepare("SELECT entry_id FROM playlist_entries WHERE playlist_id=?1 ORDER BY position, entry_id")?
            .query_map(params![id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for (i, e) in ids.iter().enumerate() {
            conn.execute("UPDATE playlist_entries SET position=?2 WHERE entry_id=?1", params![e, i as i64])?;
        }
        Ok(())
    }

    /// Sets the full new order. `entry_ids` must contain every entry exactly once.
    pub fn reorder_playlist(&self, id: i64, entry_ids: &[i64]) -> Result<Playlist> {
        if id == 0 {
            bail!("Liked songs are ordered by when you liked them");
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: HashSet<i64> = tx
            .prepare("SELECT entry_id FROM playlist_entries WHERE playlist_id=?1")?
            .query_map(params![id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let wanted: HashSet<i64> = entry_ids.iter().copied().collect();
        if wanted.len() != entry_ids.len() || wanted != current {
            bail!("the playlist changed; reload it and try again");
        }
        for (i, e) in entry_ids.iter().enumerate() {
            tx.execute("UPDATE playlist_entries SET position=?2 WHERE entry_id=?1", params![e, i as i64])?;
        }
        Self::touch(&tx, id)?;
        let p = Self::playlist_or_err(&tx, id)?;
        tx.commit()?;
        Ok(p)
    }

    /// Songs in the playlist that can be downloaded: not on the device and with a video id.
    pub fn playlist_missing_downloads(&self, id: i64) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        if Self::playlist_c(&conn, id)?.is_none() {
            bail!("playlist not found");
        }
        let mut seen = HashSet::new();
        Ok(Self::entries_c(&conn, id)?
            .into_iter()
            .map(|e| e.track)
            .filter(|t| !t.downloaded && t.video_id.is_some() && seen.insert(t.id.clone()))
            .collect())
    }

    // ----------------------------------------------------------- import history

    pub fn add_import_history(&self, platform: &str, name: &str, source_url: Option<&str>, total: u32, matched: u32, playlist_id: Option<i64>) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO import_history (platform, name, source_url, imported_at, total, matched, playlist_id) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![platform, name, source_url, now(), total, matched, playlist_id],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Newest first.
    pub fn list_import_history(&self) -> Result<Vec<ImportRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, platform, name, source_url, imported_at, total, matched, playlist_id FROM import_history ORDER BY imported_at DESC, id DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(ImportRecord {
                id: r.get(0)?,
                platform: r.get(1)?,
                name: r.get(2)?,
                source_url: r.get(3)?,
                imported_at: r.get(4)?,
                total: r.get::<_, i64>(5)? as u32,
                matched: r.get::<_, i64>(6)? as u32,
                playlist_id: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ------------------------------------------------------------ folder rules

    pub fn list_rules(&self) -> Result<Vec<FolderRule>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, path, rule, enabled FROM folder_rules ORDER BY rule, path")?;
        let rows = stmt.query_map([], |r| {
            Ok(FolderRule {
                id: r.get(0)?,
                path: r.get(1)?,
                rule: RuleKind::parse(&r.get::<_, String>(2)?),
                enabled: r.get::<_, i64>(3)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_rule(&self, path: &str, rule: RuleKind) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        if rule == RuleKind::App {
            // Only one app folder at a time.
            conn.execute("DELETE FROM folder_rules WHERE rule='app'", [])?;
        }
        conn.execute(
            "INSERT OR IGNORE INTO folder_rules (path, rule, enabled) VALUES (?1, ?2, 1)",
            params![path.trim_end_matches('/'), rule.as_str()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn remove_rule(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM folder_rules WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn set_rule_enabled(&self, id: i64, enabled: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE folder_rules SET enabled=?2 WHERE id=?1", params![id, enabled as i64])?;
        Ok(())
    }

    pub fn app_folder(&self) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT path FROM folder_rules WHERE rule='app' LIMIT 1", [], |r| r.get(0))
            .optional()?)
    }

    // ---------------------------------------------------------------- settings

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> Result<HashMap<String, String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // --------------------------------------------------------------- scan runs

    pub fn record_scan(&self, started_at: i64, report: &ScanReport) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO scan_runs (started_at, finished_at, report_json) VALUES (?1, ?2, ?3)",
            params![started_at, now(), serde_json::to_string(report)?],
        )?;
        Ok(())
    }

    pub fn last_scan(&self) -> Result<Option<(i64, ScanReport)>> {
        let conn = self.conn.lock().unwrap();
        let row: Option<(i64, String)> = conn
            .query_row("SELECT started_at, report_json FROM scan_runs ORDER BY id DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        match row {
            Some((at, json)) => Ok(Some((at, serde_json::from_str(&json)?))),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(path: &str, kind: Kind) -> Track {
        Track {
            id: uuid::Uuid::new_v4().to_string(),
            path: Some(path.into()),
            video_id: None,
            title: "T".into(),
            artist: Some("A".into()),
            album: None,
            duration_secs: 100.0,
            thumbnail: None,
            source: Source::Local,
            kind,
            confidence: 0.9,
            reason: None,
            format: "mp3".into(),
            sample_rate: Some(44100),
            channels: Some(2),
            bitrate_kbps: Some(320),
            size_bytes: 10,
            modified_at: 1,
            added_at: 0,
            play_count: 0,
            last_played_at: None,
            liked: false,
            downloaded: false,
        }
    }

    fn yt(id: &str, title: &str) -> YtTrack {
        YtTrack {
            video_id: id.into(),
            title: title.into(),
            artist: "Artist".into(),
            album: Some("Album".into()),
            duration_secs: Some(200.0),
            thumbnail: Some(format!("https://i.ytimg.com/{id}.jpg")),
            explicit: false,
            local_track_id: None,
        }
    }

    fn music(db: &Db, filter: TrackFilter) -> Vec<Track> {
        db.list_tracks(Kind::Music, filter, None, TrackSort::Recent, 100).unwrap()
    }

    #[test]
    fn upsert_respects_user_override() {
        let db = Db::open_in_memory().unwrap();
        let t = sample("/m/a.mp3", Kind::Music);
        assert!(db.upsert_track(&t).unwrap());
        let id = music(&db, TrackFilter::All)[0].id.clone();
        db.set_track_kind(&id, Kind::Voice).unwrap();
        // Scanner re-classifies as music; user choice must win.
        assert!(!db.upsert_track(&t).unwrap());
        assert_eq!(db.get_track(&id).unwrap().unwrap().kind, Kind::Voice);
        assert_eq!(db.stats().unwrap().voice, 1);
    }

    #[test]
    fn scan_bookkeeping_removes_missing_files() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_track(&sample("/m/a.mp3", Kind::Music)).unwrap();
        db.upsert_track(&sample("/m/b.mp3", Kind::Music)).unwrap();
        let roots = vec!["/m".to_string()];
        db.begin_scan(&roots).unwrap();
        db.mark_seen("/m/a.mp3").unwrap();
        assert_eq!(db.finish_scan(&roots).unwrap(), 1);
        assert_eq!(music(&db, TrackFilter::All).len(), 1);
    }

    #[test]
    fn rules_and_settings_round_trip() {
        let db = Db::open_in_memory().unwrap();
        db.add_rule("/a", RuleKind::Include).unwrap();
        db.add_rule("/x", RuleKind::App).unwrap();
        db.add_rule("/y", RuleKind::App).unwrap();
        let rules = db.list_rules().unwrap();
        assert_eq!(rules.iter().filter(|r| r.rule == RuleKind::App).count(), 1);
        assert_eq!(db.app_folder().unwrap().as_deref(), Some("/y"));
        db.set_setting("theme", "light").unwrap();
        db.set_setting("theme", "dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("dark"));
    }

    #[test]
    fn liking_a_youtube_song_creates_one_stream_only_row() {
        let db = Db::open_in_memory().unwrap();
        let t = db.like_youtube(&yt("v1", "Song"), true).unwrap();
        assert!(t.liked && t.path.is_none() && !t.downloaded);
        assert_eq!(t.source, Source::Youtube);
        assert_eq!(t.video_id.as_deref(), Some("v1"));
        // Liking again (e.g. from another search) reuses the row.
        let again = db.like_youtube(&yt("v1", "Song"), true).unwrap();
        assert_eq!(again.id, t.id);
        assert_eq!(music(&db, TrackFilter::Liked).len(), 1);
        assert_eq!(db.stats().unwrap().liked, 1);
        // Unliked and never played: it leaves the library and is pruned on next start.
        db.like_youtube(&yt("v1", "Song"), false).unwrap();
        assert!(music(&db, TrackFilter::All).is_empty());
        assert_eq!(db.prune_orphans().unwrap(), 1);
    }

    #[test]
    fn played_stream_rows_survive_pruning_and_show_in_recent() {
        let db = Db::open_in_memory().unwrap();
        let t = db.ensure_youtube_track(&yt("v9", "Streamed")).unwrap();
        db.record_play(&t.id).unwrap();
        assert_eq!(db.prune_orphans().unwrap(), 0);
        let recent = db.list_recent(10).unwrap();
        assert_eq!(recent[0].id, t.id);
        assert_eq!(recent[0].play_count, 1);
        assert!(recent[0].last_played_at.is_some());
        // History is not "in the library".
        assert!(music(&db, TrackFilter::All).is_empty());
    }

    #[test]
    fn playlists_add_remove_reorder() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_track(&sample("/m/local.mp3", Kind::Music)).unwrap();
        let local = music(&db, TrackFilter::All)[0].id.clone();
        let p = db.create_playlist("  Road trip ", Some(""), None).unwrap();
        assert_eq!((p.name.as_str(), p.description.clone(), p.track_count), ("Road trip", None, 0));
        let p = db.add_to_playlist_mixed(p.id, &[local.clone()], &[yt("a", "A"), yt("b", "B")]).unwrap();
        assert_eq!(p.track_count, 3);
        assert_eq!(p.total_secs, 500.0);
        assert_eq!(p.artwork.len(), 2);
        // Adding the same songs again is a no-op.
        let p = db.add_to_playlist_mixed(p.id, &[local.clone()], &[yt("a", "A")]).unwrap();
        assert_eq!(p.track_count, 3);

        let d = db.get_playlist(p.id).unwrap().unwrap();
        let ids: Vec<i64> = d.entries.iter().map(|e| e.entry_id).collect();
        assert_eq!(d.entries[1].track.title, "A");
        let p = db.reorder_playlist(p.id, &[ids[2], ids[0], ids[1]]).unwrap();
        let d = db.get_playlist(p.id).unwrap().unwrap();
        assert_eq!(d.entries.iter().map(|e| e.track.title.as_str()).collect::<Vec<_>>(), ["B", "T", "A"]);
        assert_eq!(d.entries.iter().map(|e| e.position).collect::<Vec<_>>(), [0, 1, 2]);
        // A partial order is rejected.
        assert!(db.reorder_playlist(p.id, &[ids[0]]).is_err());

        let p = db.remove_from_playlist(p.id, &[ids[2]]).unwrap();
        assert_eq!(p.track_count, 2);
        let d = db.get_playlist(p.id).unwrap().unwrap();
        assert_eq!(d.entries.iter().map(|e| e.position).collect::<Vec<_>>(), [0, 1]);
        // Songs in a playlist count as library songs; the stream-only one needs downloading.
        assert_eq!(db.playlist_missing_downloads(p.id).unwrap().len(), 1);

        let p = db.rename_playlist(p.id, "Drive", Some("night")).unwrap();
        assert_eq!((p.name.as_str(), p.description.as_deref()), ("Drive", Some("night")));
        let all = db.list_playlists().unwrap();
        assert!(all[0].is_liked && all[0].id == 0);
        assert_eq!(all.len(), 2);
        assert_eq!(db.stats().unwrap().playlists, 1);

        db.delete_playlist(p.id).unwrap();
        assert_eq!(db.list_playlists().unwrap().len(), 1);
        // The local file stays; both stream-only songs ("B" removed earlier, "A" with the
        // playlist) are now orphans.
        assert_eq!(db.prune_orphans().unwrap(), 2);
        assert!(db.get_track(&local).unwrap().is_some());
    }

    #[test]
    fn liked_songs_is_virtual_playlist_zero() {
        let db = Db::open_in_memory().unwrap();
        let a = db.like_youtube(&yt("a", "A"), true).unwrap();
        let b = db.ensure_youtube_track(&yt("b", "B")).unwrap();
        let p = db.add_to_playlist(0, &[b.id.clone()]).unwrap();
        assert!(p.is_liked);
        assert_eq!(p.track_count, 2);
        let d = db.get_playlist(0).unwrap().unwrap();
        assert_eq!(d.entries.len(), 2);
        assert!(db.reorder_playlist(0, &[]).is_err());
        assert!(db.rename_playlist(0, "x", None).is_err());
        assert!(db.delete_playlist(0).is_err());
        let a_entry = d.entries.iter().find(|e| e.track.id == a.id).unwrap().entry_id;
        let p = db.remove_from_playlist(0, &[a_entry]).unwrap();
        assert_eq!(p.track_count, 1);
        assert!(!db.get_track(&a.id).unwrap().unwrap().liked);
    }

    #[test]
    fn finished_download_fills_the_existing_row() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Artist - A.m4a");
        std::fs::write(&file, b"audio").unwrap();
        let path = file.to_string_lossy().to_string();

        let db = Db::open_in_memory().unwrap();
        let liked = db.like_youtube(&yt("a", "A"), true).unwrap();
        // The scanner indexed the file before the download finished.
        db.upsert_track(&sample(&path, Kind::Music)).unwrap();
        let p = db.create_playlist("P", None, None).unwrap();
        let scanned = db.list_tracks(Kind::Music, TrackFilter::Device, None, TrackSort::Recent, 10).unwrap()[0].id.clone();
        db.add_to_playlist(p.id, &[scanned]).unwrap();

        let facts = FileFacts { format: "m4a".into(), size_bytes: 5, duration_secs: 201.0, ..Default::default() };
        let t = db.attach_download(&yt("a", "A"), &path, &facts).unwrap();
        assert_eq!(t.id, liked.id);
        assert!(t.downloaded && t.liked);
        assert_eq!(t.duration_secs, 201.0);
        // No duplicates: one row, and the playlist entry now points at it.
        assert_eq!(music(&db, TrackFilter::All).len(), 1);
        assert_eq!(db.get_playlist(p.id).unwrap().unwrap().entries[0].track.id, liked.id);
        assert_eq!(music(&db, TrackFilter::Downloaded).len(), 1);
        assert_eq!(db.stats().unwrap().downloaded, 1);
        assert_eq!(db.downloads_bytes().unwrap(), 5);
        // A re-scan of the folder keeps it a YouTube song.
        db.upsert_track(&sample(&path, Kind::Music)).unwrap();
        let t = db.get_track(&liked.id).unwrap().unwrap();
        assert_eq!((t.source, t.title.as_str()), (Source::Youtube, "A"));

        let mut hits = vec![yt("a", "A"), yt("z", "Z")];
        db.match_local(&mut hits).unwrap();
        assert_eq!(hits[0].local_track_id.as_deref(), Some(liked.id.as_str()));
        assert!(hits[1].local_track_id.is_none());
        assert!(db.playlist_missing_downloads(p.id).unwrap().is_empty());
    }

    #[test]
    fn albums_artists_and_sorting() {
        let db = Db::open_in_memory().unwrap();
        let mut a = sample("/m/1.mp3", Kind::Music);
        a.title = "Zed".into();
        a.album = Some("One".into());
        let mut b = sample("/m/2.mp3", Kind::Music);
        b.title = "alpha".into();
        b.album = Some("one".into());
        db.upsert_track(&a).unwrap();
        db.upsert_track(&b).unwrap();
        let albums = db.list_albums(None).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!((albums[0].track_count, albums[0].artist.as_deref()), (2, Some("A")));
        assert_eq!(db.list_artists(Some("a")).unwrap()[0].track_count, 2);
        let sorted = db.list_tracks(Kind::Music, TrackFilter::All, None, TrackSort::Title, 10).unwrap();
        assert_eq!(sorted[0].title, "alpha");
        assert_eq!(db.list_tracks(Kind::Music, TrackFilter::All, Some("zed"), TrackSort::Recent, 10).unwrap().len(), 1);
    }

    #[test]
    fn import_history_round_trip() {
        let db = Db::open_in_memory().unwrap();
        let p = db.create_playlist("From Spotify", None, Some("spotify")).unwrap();
        assert_eq!(p.imported_from.as_deref(), Some("spotify"));
        db.add_import_history("spotify", "From Spotify", Some("https://open.spotify.com/playlist/x"), 10, 8, Some(p.id)).unwrap();
        db.delete_playlist(p.id).unwrap();
        let h = db.list_import_history().unwrap();
        assert_eq!((h[0].total, h[0].matched, h[0].playlist_id), (10, 8, None));
    }

    /// A phone still on the v1 schema must keep its tracks, likes and imports.
    #[test]
    fn migrates_a_v1_database() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("library.sqlite");
        {
            let c = Connection::open(&file).unwrap();
            c.execute_batch(MIGRATIONS[0]).unwrap();
            c.pragma_update(None, "user_version", 1).unwrap();
            c.execute_batch(
                "INSERT INTO tracks (id, path, title, source, kind, liked, added_at) VALUES
                    ('t1', '/m/a.mp3', 'A', 'server', 'music', 1, 5),
                    ('t2', '/m/b.m4a', 'B', 'youtube', 'music', 0, 6);
                 INSERT INTO import_playlists (id, source, name, total, matched) VALUES (7, 'spotify', 'Gym', 3, 2);
                 INSERT INTO import_items (playlist_id, title, matched_track_id) VALUES
                    (7, 'B', 't2'), (7, 'missing', NULL), (7, 'A', 't1');
                 INSERT INTO settings (key, value) VALUES ('torrent.audio_only', 'true'), ('server.url', 'x'), ('theme', 'dark');
                 INSERT INTO downloads (id, kind, name, state, dest_dir, created_at) VALUES ('d', 'torrent', 'n', 'active', '/', 0);",
            )
            .unwrap();
        }
        let db = Db::open(&file).unwrap();
        let a = db.get_track("t1").unwrap().unwrap();
        assert_eq!((a.source, a.liked, a.path.as_deref()), (Source::Local, true, Some("/m/a.mp3")));
        assert_eq!(db.get_track("t2").unwrap().unwrap().source, Source::Youtube);
        let d = db.get_playlist(7).unwrap().unwrap();
        assert_eq!(d.playlist.imported_from.as_deref(), Some("spotify"));
        assert_eq!(d.entries.iter().map(|e| e.track.id.as_str()).collect::<Vec<_>>(), ["t2", "t1"]);
        let h = db.list_import_history().unwrap();
        assert_eq!((h[0].total, h[0].matched, h[0].playlist_id), (3, 2, Some(7)));
        let s = db.all_settings().unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(db.get_playlist(0).unwrap().unwrap().entries.len(), 1);
        // New schema accepts stream-only rows and enforces one row per video.
        db.ensure_youtube_track(&yt("v", "V")).unwrap();
        db.ensure_youtube_track(&yt("v", "V")).unwrap();
        assert_eq!(db.like_youtube(&yt("v", "V"), true).unwrap().video_id.as_deref(), Some("v"));
        drop(db);
        // Re-opening is a no-op.
        let db = Db::open(&file).unwrap();
        assert_eq!(db.list_playlists().unwrap().len(), 2);
    }
}
