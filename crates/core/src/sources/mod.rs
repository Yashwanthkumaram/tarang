//! Import songs and playlists from other apps (Spotify, YouTube Music / YouTube,
//! SoundCloud) by link, match each song on YouTube Music, and save the result as a
//! playlist of YouTube rows. See `docs/modules/core-import.md`.
//!
//! The pipeline is: [`Platform::detect`]/[`Platform::check_url`] → fetch the list
//! ([`spotify::fetch`] over plain HTTP, [`ytdlp_playlist::list`] through the yt-dlp
//! binary) → [`matcher::match_all`] → an [`ImportPreview`] kept in [`Previews`] until
//! [`commit`] writes the playlist and an `import_history` row.

pub mod matcher;
pub mod spotify;
pub mod ytdlp_playlist;

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::models::{Playlist, YtTrack};

/// Where an import comes from. Serialised lowercase, as the API and
/// `playlists.imported_from` / `import_history.platform` use it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Spotify,
    Youtube,
    Soundcloud,
}

impl Platform {
    pub fn parse(s: &str) -> Result<Platform> {
        match s.trim().to_ascii_lowercase().as_str() {
            "spotify" => Ok(Platform::Spotify),
            "youtube" | "youtube_music" | "ytmusic" => Ok(Platform::Youtube),
            "soundcloud" => Ok(Platform::Soundcloud),
            other => bail!("unknown platform \"{other}\""),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Spotify => "spotify",
            Platform::Youtube => "youtube",
            Platform::Soundcloud => "soundcloud",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Platform::Spotify => "Spotify",
            Platform::Youtube => "YouTube Music",
            Platform::Soundcloud => "SoundCloud",
        }
    }

    /// The platform a link belongs to, from its host.
    pub fn detect(url: &str) -> Option<Platform> {
        if url.trim().starts_with("spotify:") {
            return Some(Platform::Spotify);
        }
        let host = host_of(url)?;
        let is = |d: &str| host == d || host.ends_with(&format!(".{d}"));
        if is("spotify.com") || is("spotify.link") || is("spoti.fi") {
            Some(Platform::Spotify)
        } else if is("youtube.com") || is("youtu.be") {
            Some(Platform::Youtube)
        } else if is("soundcloud.com") || is("on.soundcloud.com") {
            Some(Platform::Soundcloud)
        } else {
            None
        }
    }

    /// Fails with a readable message when the link is not a link of this platform.
    pub fn check_url(self, url: &str) -> Result<()> {
        if url.trim().is_empty() {
            bail!("Paste a {} link first", self.label());
        }
        match Platform::detect(url) {
            Some(p) if p == self => Ok(()),
            Some(p) => bail!("That is a {} link, not a {} link", p.label(), self.label()),
            None => bail!("That doesn't look like a {} link", self.label()),
        }
    }
}

/// Lower-cased host of an http(s) link; a bare "open.spotify.com/..." gets https added.
pub(crate) fn host_of(url: &str) -> Option<String> {
    parse_url(url).and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

pub(crate) fn parse_url(url: &str) -> Option<reqwest::Url> {
    let url = url.trim();
    let with_scheme = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    reqwest::Url::parse(&with_scheme).ok().filter(|u| matches!(u.scheme(), "http" | "https"))
}

/// One song as the other app lists it, before matching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceItem {
    pub title: String,
    /// Display artist(s), comma separated as the source shows them.
    pub artist: String,
    pub duration_secs: Option<f64>,
    /// Set when the source already is a YouTube video (YouTube playlists): it is used
    /// as the match directly instead of searching.
    pub video: Option<YtTrack>,
}

/// A whole list read from the other app.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceList {
    pub platform: Platform,
    pub name: String,
    pub url: String,
    pub items: Vec<SourceItem>,
    /// Shown to the user when the list is incomplete (e.g. Spotify's 100-song limit).
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchStatus {
    Matched,
    Review,
    NotFound,
}

/// One row of the match preview (API-v2 `import_preview` items).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewItem {
    pub title: String,
    pub artist: String,
    pub duration_secs: Option<f64>,
    pub status: MatchStatus,
    #[serde(rename = "match")]
    pub matched: Option<YtTrack>,
    pub alternatives: Vec<YtTrack>,
}

/// `import_preview` result. Kept in memory until committed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub preview_id: String,
    pub name: String,
    pub platform: Platform,
    pub source_url: String,
    pub items: Vec<PreviewItem>,
    /// Optional notice for the user, e.g. that only the first 100 songs were listed.
    pub note: Option<String>,
}

impl SourceItem {
    /// `(title, artist, duration)` — handy for comparisons in tests and logs.
    pub fn key(&self) -> (&str, &str, Option<f64>) {
        (&self.title, &self.artist, self.duration_secs)
    }
}

impl ImportPreview {
    pub fn count(&self, status: MatchStatus) -> usize {
        self.items.iter().filter(|i| i.status == status).count()
    }
}

/// Previews waiting for `import_commit`, newest last. Bounded so abandoned previews
/// don't pile up for the life of the process.
#[derive(Default)]
pub struct Previews {
    inner: Mutex<Vec<ImportPreview>>,
}

/// How many uncommitted previews are kept; older ones are dropped.
const MAX_PREVIEWS: usize = 16;

impl Previews {
    pub fn insert(&self, p: ImportPreview) {
        let mut v = self.inner.lock().unwrap();
        v.retain(|x| x.preview_id != p.preview_id);
        v.push(p);
        let extra = v.len().saturating_sub(MAX_PREVIEWS);
        v.drain(..extra);
    }

    pub fn get(&self, id: &str) -> Option<ImportPreview> {
        self.inner.lock().unwrap().iter().find(|p| p.preview_id == id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<ImportPreview> {
        let mut v = self.inner.lock().unwrap();
        let i = v.iter().position(|p| p.preview_id == id)?;
        Some(v.remove(i))
    }
}

/// Builds the preview from a fetched list: matches every song (4 at a time) and
/// reports `(done, total)` after each one. `preview_id` is chosen by the caller (so it
/// can tag progress events before the preview exists); `crate::new_id()` is fine.
pub async fn preview(preview_id: String, list: SourceList, on_progress: impl Fn(usize, usize) + Send + Sync) -> Result<ImportPreview> {
    let items = matcher::match_all(&list.items, on_progress).await?;
    Ok(ImportPreview {
        preview_id,
        name: list.name,
        platform: list.platform,
        source_url: list.url,
        items,
        note: list.note,
    })
}

/// Writes a preview as a playlist: `include` are the item indexes to keep, `picks`
/// replaces an item's match (the user's choice for a "review" row, from its
/// alternatives or a search). Items without a match are skipped. Records the import in
/// `import_history` (total = songs in the source list, matched = songs added).
pub fn commit(db: &Db, preview: &ImportPreview, name: &str, include: &[usize], picks: &HashMap<usize, YtTrack>) -> Result<Playlist> {
    let name = if name.trim().is_empty() { preview.name.as_str() } else { name.trim() };
    if let Some(bad) = include.iter().find(|&&i| i >= preview.items.len()) {
        bail!("song {bad} is not in this import");
    }
    let mut seen = std::collections::HashSet::new();
    let tracks: Vec<YtTrack> = include
        .iter()
        .filter(|&&i| seen.insert(i))
        .filter_map(|&i| picks.get(&i).cloned().or_else(|| preview.items[i].matched.clone()))
        .collect();
    if tracks.is_empty() {
        return Err(anyhow!("None of the selected songs has a match to import"));
    }
    let playlist = db.create_playlist(name, None, Some(preview.platform.as_str()))?;
    let playlist = match db.add_to_playlist_mixed(playlist.id, &[], &tracks) {
        Ok(p) => p,
        Err(e) => {
            let _ = db.delete_playlist(playlist.id);
            return Err(e);
        }
    };
    db.add_import_history(
        preview.platform.as_str(),
        name,
        Some(&preview.source_url),
        preview.items.len() as u32,
        playlist.track_count,
        Some(playlist.id),
    )?;
    Ok(playlist)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yt(id: &str) -> YtTrack {
        YtTrack {
            video_id: id.into(),
            title: format!("Song {id}"),
            artist: "Artist".into(),
            album: None,
            duration_secs: Some(200.0),
            thumbnail: None,
            explicit: false,
            local_track_id: None,
        }
    }

    fn item(status: MatchStatus, m: Option<YtTrack>) -> PreviewItem {
        PreviewItem { title: "t".into(), artist: "a".into(), duration_secs: None, status, matched: m, alternatives: vec![] }
    }

    #[test]
    fn detects_platforms() {
        assert_eq!(Platform::detect("https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa"), Some(Platform::Spotify));
        assert_eq!(Platform::detect("open.spotify.com/playlist/x"), Some(Platform::Spotify));
        assert_eq!(Platform::detect("spotify:album:abc"), Some(Platform::Spotify));
        assert_eq!(Platform::detect("https://music.youtube.com/playlist?list=PL1"), Some(Platform::Youtube));
        assert_eq!(Platform::detect("https://m.soundcloud.com/forss/sets/soulhack"), Some(Platform::Soundcloud));
        assert_eq!(Platform::detect("https://example.com/x"), None);
        assert!(Platform::Spotify.check_url("https://soundcloud.com/a/sets/b").unwrap_err().to_string().contains("SoundCloud link"));
        assert!(Platform::Youtube.check_url("").is_err());
    }

    #[test]
    fn previews_are_bounded() {
        let s = Previews::default();
        for i in 0..20 {
            s.insert(ImportPreview { preview_id: i.to_string(), name: "n".into(), platform: Platform::Spotify, source_url: String::new(), items: vec![], note: None });
        }
        assert!(s.get("0").is_none());
        assert!(s.get("19").is_some());
        assert!(s.remove("19").is_some());
        assert!(s.get("19").is_none());
    }

    #[test]
    fn commit_creates_playlist_and_history() {
        let db = Db::open_in_memory().unwrap();
        let p = ImportPreview {
            preview_id: "p".into(),
            name: "Mix".into(),
            platform: Platform::Spotify,
            source_url: "https://open.spotify.com/playlist/x".into(),
            items: vec![
                item(MatchStatus::Matched, Some(yt("aaaaaaaaaaa"))),
                item(MatchStatus::Review, Some(yt("bbbbbbbbbbb"))),
                item(MatchStatus::NotFound, None),
                item(MatchStatus::Matched, Some(yt("ccccccccccc"))),
            ],
            note: None,
        };
        let picks = HashMap::from([(1usize, yt("ddddddddddd"))]);
        let pl = commit(&db, &p, "  ", &[0, 1, 2, 0], &picks).unwrap();
        assert_eq!(pl.name, "Mix");
        assert_eq!(pl.imported_from.as_deref(), Some("spotify"));
        assert_eq!(pl.track_count, 2);
        let detail = db.get_playlist(pl.id).unwrap().unwrap();
        let ids: Vec<_> = detail.entries.iter().map(|e| e.track.video_id.clone().unwrap()).collect();
        assert_eq!(ids, vec!["aaaaaaaaaaa", "ddddddddddd"]);
        let h = db.list_import_history().unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].total, h[0].matched, h[0].playlist_id), (4, 2, Some(pl.id)));
        assert!(commit(&db, &p, "x", &[2], &HashMap::new()).is_err());
        assert!(commit(&db, &p, "x", &[9], &HashMap::new()).is_err());
    }
}
