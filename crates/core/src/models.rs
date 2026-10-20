//! Shared data types. Everything that crosses the core ↔ UI boundary lives here
//! and is serialisable with serde, so the frontend sees the same shapes
//! (docs/API-v2.md is the contract).

use serde::{Deserialize, Serialize};

/// Where a track came from. Stored as lowercase text in SQLite. v1 rows with
/// `server`, `spotify` or `torrent` were rewritten to `local` by migration 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A file found on this device by the scanner.
    Local,
    /// A YouTube Music song: streamed, liked, in a playlist and/or downloaded.
    Youtube,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Local => "local",
            Source::Youtube => "youtube",
        }
    }
    pub fn parse(s: &str) -> Source {
        match s {
            "youtube" => Source::Youtube,
            _ => Source::Local,
        }
    }
}

/// Result of the music-vs-voice classifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Music,
    Voice,
    /// Confidence fell below the user's threshold; shown in the review queue.
    Unsure,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Music => "music",
            Kind::Voice => "voice",
            Kind::Unsure => "unsure",
        }
    }
    pub fn parse(s: &str) -> Kind {
        match s {
            "voice" => Kind::Voice,
            "unsure" => Kind::Unsure,
            _ => Kind::Music,
        }
    }
}

/// One song or recording known to the library. Voice recordings are tracks with
/// `kind == Voice`. A YouTube song that was liked or added to a playlist but never
/// downloaded has `path == None` and is streamed by `video_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    /// Real file path when the song is on this device; `None` for stream-only YouTube songs.
    pub path: Option<String>,
    /// YouTube Music video id when known (unique across the table).
    pub video_id: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: f64,
    /// https artwork URL (YouTube) or `None` (the UI draws generated art).
    pub thumbnail: Option<String>,
    pub source: Source,
    pub kind: Kind,
    /// 0.0–1.0 confidence that `kind` is right. 1.0 when the user set it by hand.
    pub confidence: f64,
    /// Short human-readable reason from the classifier, e.g. "mono, 16 kHz, no tags".
    pub reason: Option<String>,
    pub format: String,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bitrate_kbps: Option<u32>,
    pub size_bytes: u64,
    pub modified_at: i64,
    /// Set by the database on insert; the value passed in is ignored.
    pub added_at: i64,
    pub play_count: u32,
    pub last_played_at: Option<i64>,
    pub liked: bool,
    /// Computed when read: `path` is set and the file exists. Ignored on write.
    #[serde(default)]
    pub downloaded: bool,
}

/// How the scanner decides where to look on a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    /// Walk every readable root, honouring the exclude list.
    WholeDevice,
    /// Walk only the `Include` folders, honouring the exclude list.
    SelectedFolders,
    /// Walk only the single `App` folder.
    AppFolderOnly,
}

impl ScanMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanMode::WholeDevice => "whole_device",
            ScanMode::SelectedFolders => "selected_folders",
            ScanMode::AppFolderOnly => "app_folder_only",
        }
    }
    pub fn parse(s: &str) -> ScanMode {
        match s {
            "whole_device" => ScanMode::WholeDevice,
            "app_folder_only" => ScanMode::AppFolderOnly,
            _ => ScanMode::SelectedFolders,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    Include,
    Exclude,
    /// The one folder dedicated to this app. Downloads land here.
    App,
}

impl RuleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RuleKind::Include => "include",
            RuleKind::Exclude => "exclude",
            RuleKind::App => "app",
        }
    }
    pub fn parse(s: &str) -> RuleKind {
        match s {
            "exclude" => RuleKind::Exclude,
            "app" => RuleKind::App,
            _ => RuleKind::Include,
        }
    }
}

/// A folder rule. `path` may be an absolute path or, for excludes, a bare
/// directory-name pattern such as `node_modules` that matches at any depth.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRule {
    pub id: i64,
    pub path: String,
    pub rule: RuleKind,
    pub enabled: bool,
}

/// Everything the scanner needs, resolved from settings + rules before a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanConfig {
    pub mode: ScanMode,
    pub roots: Vec<String>,
    pub rules: Vec<FolderRule>,
    pub extensions: Vec<String>,
    pub min_duration_secs: f64,
    pub respect_nomedia: bool,
    pub classify: bool,
    /// Below this confidence the file goes to `Kind::Unsure`.
    pub confidence_threshold: f64,
    pub use_hints: bool,
}

/// Summary of one scan run; also streamed as progress while it runs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanReport {
    pub files_seen: u64,
    pub audio_found: u64,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub music: u64,
    pub voice: u64,
    pub unsure: u64,
    pub skipped: u64,
    pub current_path: String,
    pub finished: bool,
    pub elapsed_ms: u64,
}

/// Output of the classifier for a single file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    pub kind: Kind,
    /// Probability that the file is a voice recording (0.0 = certainly music).
    pub voice_probability: f64,
    pub confidence: f64,
    pub reason: String,
    /// Stream properties seen while decoding; fill gaps the tag reader left.
    pub decoded_sample_rate: Option<u32>,
    pub decoded_channels: Option<u8>,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadKind {
    Youtube,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    Queued,
    Active,
    Paused,
    Done,
    Error,
}

/// Live view of one download in the queue (desktop yt-dlp job or Android plugin job).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Download {
    pub id: String,
    pub kind: DownloadKind,
    pub name: String,
    pub state: DownloadState,
    /// 0.0–1.0
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    /// The library row this download fills in.
    pub track_id: Option<String>,
    pub error: Option<String>,
}

/// One song from YouTube Music (search, imports). Lives here so the database can
/// turn it into a [`Track`]; re-exported as `youtube::YtTrack`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YtTrack {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub explicit: bool,
    /// Id of a library track whose audio is already on this device: the downloaded
    /// copy of this video, else a file that matches title/artist/duration.
    #[serde(default)]
    pub local_track_id: Option<String>,
}

impl YtTrack {
    pub fn url(&self) -> String {
        format!("https://music.youtube.com/watch?v={}", self.video_id)
    }
    /// "Artist - Title", safe as a file name (no extension).
    pub fn file_stem(&self) -> String {
        crate::util::sanitize_file_name(&format!("{} - {}", self.artist, self.title))
    }
}

/// A playlist as the Library shows it. Id 0 is the virtual "Liked songs" playlist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub track_count: u32,
    pub total_secs: f64,
    pub downloaded_count: u32,
    /// Up to 4 distinct thumbnails for the mosaic, in playlist order (may be empty).
    pub artwork: Vec<String>,
    /// "spotify" | "youtube" | "soundcloud" | None
    pub imported_from: Option<String>,
    pub is_liked: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One row of a playlist. `entry_id` identifies the row (a song may sit in many
/// playlists); for Liked songs it is the track's SQLite rowid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistEntry {
    pub entry_id: i64,
    pub position: u32,
    pub track: Track,
}

/// `get_playlist` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistDetail {
    pub playlist: Playlist,
    pub entries: Vec<PlaylistEntry>,
}

/// One album or artist in the Library lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub name: String,
    /// Albums: the artist when every track shares one, else `None`. Artists: `None`.
    pub artist: Option<String>,
    pub track_count: u32,
    pub artwork: Option<String>,
}

/// One past import (Settings → Import from other apps → history).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRecord {
    pub id: i64,
    pub platform: String,
    pub name: String,
    pub source_url: Option<String>,
    pub imported_at: i64,
    pub total: u32,
    pub matched: u32,
    /// `None` once the playlist was deleted.
    pub playlist_id: Option<i64>,
}

/// Counts shown on Home and the Library. Counts cover songs "in the library": on the
/// device, liked, or in a playlist (stream-only history rows are not counted).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibraryStats {
    pub music: u64,
    pub voice: u64,
    pub unsure: u64,
    pub liked: u64,
    /// YouTube songs kept on the device.
    pub downloaded: u64,
    /// User playlists (Liked songs not counted).
    pub playlists: u64,
    /// Music files on the device.
    pub total_bytes: u64,
    pub total_secs: f64,
    pub albums: u64,
    pub artists: u64,
}

/// Disk usage for the Downloads screen and Settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StorageInfo {
    /// Bytes in use on the disk that holds the download folder (all apps).
    pub used_bytes: u64,
    /// Bytes this app can still write there.
    pub free_bytes: u64,
    /// Size of the downloaded YouTube songs.
    pub downloads_bytes: u64,
    /// Size of the app cache folder (stream cache).
    pub cache_bytes: u64,
}
