//! YouTube Music / YouTube playlists and SoundCloud sets, listed through the yt-dlp
//! binary (desktop only — the shell refuses these platforms on Android).
//!
//! * YouTube: `yt-dlp --flat-playlist -J <url>` — one JSON document whose `entries`
//!   carry video id, title, channel and duration. The videos are used as the matches
//!   directly (no search), see [`super::matcher`].
//! * SoundCloud: the flat listing has no titles or durations for most tracks (only
//!   `api-v2.soundcloud.com/tracks/<id>` URLs), so each track is resolved:
//!   `yt-dlp -j <url>` prints one JSON line per track (≈1 s each), reported as progress.

use std::path::Path;
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use super::matcher::{normalize, strip_noise};
use super::{Platform, SourceItem, SourceList};
use crate::models::YtTrack;

/// Lists a YouTube playlist or SoundCloud set/likes/track with the yt-dlp binary at
/// `bin`. `on_progress(done, total)` is called while SoundCloud tracks are resolved.
pub async fn list(bin: &Path, platform: Platform, url: &str, on_progress: impl Fn(usize, usize)) -> Result<SourceList> {
    let url = url.trim();
    match platform {
        Platform::Youtube => {
            let out = crate::youtube::command(bin)
                .args(["--flat-playlist", "-J", "--yes-playlist", "--no-warnings", "--ignore-errors", "--", url])
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output()
                .await
                .context("couldn't run yt-dlp")?;
            if !out.status.success() && out.stdout.is_empty() {
                bail!(ytdlp_error(&String::from_utf8_lossy(&out.stderr), platform));
            }
            let mut l = parse_youtube(&String::from_utf8_lossy(&out.stdout))?;
            l.url = url.to_string();
            Ok(l)
        }
        Platform::Soundcloud => {
            let mut child = crate::youtube::command(bin)
                .args(["-j", "--yes-playlist", "--no-warnings", "--ignore-errors", "--", url])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .context("couldn't run yt-dlp")?;
            let stdout = child.stdout.take().ok_or_else(|| anyhow!("yt-dlp has no output"))?;
            let stderr = child.stderr.take();
            let err_task = tokio::spawn(async move {
                let mut s = String::new();
                if let Some(mut e) = stderr {
                    let _ = tokio::io::AsyncReadExt::read_to_string(&mut e, &mut s).await;
                }
                s
            });
            let mut lines = BufReader::new(stdout).lines();
            let mut acc = SoundcloudAcc::default();
            while let Some(line) = lines.next_line().await? {
                if let Some(total) = acc.push(&line) {
                    on_progress(acc.items.len(), total.max(acc.items.len()));
                }
            }
            let _ = child.wait().await;
            let stderr = err_task.await.unwrap_or_default();
            if acc.items.is_empty() {
                bail!(ytdlp_error(&stderr, platform));
            }
            let mut l = acc.finish();
            l.url = url.to_string();
            Ok(l)
        }
        Platform::Spotify => bail!("Spotify links are read without yt-dlp"),
    }
}

/// A readable message from yt-dlp's stderr.
fn ytdlp_error(stderr: &str, platform: Platform) -> String {
    let last = stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("").trim();
    let lower = last.to_ascii_lowercase();
    if lower.contains("private") || lower.contains("sign in") || lower.contains("does not exist") || lower.contains("404") || lower.contains("not found") {
        format!("{} says this list doesn't exist or is private", platform.label())
    } else if lower.contains("unable to download") || lower.contains("network") || lower.contains("resolve") {
        format!("Couldn't reach {} — check your connection", platform.label())
    } else if last.is_empty() {
        format!("Couldn't read this {} link", platform.label())
    } else {
        format!("Couldn't read this {} link: {}", platform.label(), last.trim_start_matches("ERROR:").trim())
    }
}

// ------------------------------------------------------------------ YouTube

/// Parses `yt-dlp --flat-playlist -J` output (a playlist, or a single video).
pub fn parse_youtube(json: &str) -> Result<SourceList> {
    let v: Value = serde_json::from_str(json.trim()).context("yt-dlp returned unreadable output")?;
    let str_of = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let entries: Vec<&Value> = match v.get("entries").and_then(Value::as_array) {
        Some(e) => e.iter().collect(),
        None if v.get("id").is_some() => vec![&v],
        None => bail!("This YouTube link has no songs"),
    };
    let mut items = Vec::new();
    let mut unavailable = 0;
    for e in entries {
        let id = str_of(e, "id").filter(|id| id.len() == 11);
        let title = str_of(e, "title").unwrap_or_default();
        let (Some(id), false) = (id, title.is_empty() || title.starts_with('[')) else {
            // "[Private video]", "[Deleted video]", entries without an id.
            unavailable += 1;
            continue;
        };
        let channel = str_of(e, "channel").or_else(|| str_of(e, "uploader")).unwrap_or_default();
        let (title, artist) = split_video_title(&title, &channel);
        let duration = e.get("duration").and_then(Value::as_f64).filter(|d| *d > 0.0);
        let video = YtTrack {
            video_id: id.clone(),
            title: title.clone(),
            artist: if artist.is_empty() { "Unknown artist".into() } else { artist.clone() },
            album: None,
            duration_secs: duration,
            thumbnail: Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
            explicit: false,
            local_track_id: None,
        };
        items.push(SourceItem { title, artist, duration_secs: duration, video: Some(video) });
    }
    if items.is_empty() {
        bail!("This YouTube playlist has no playable videos");
    }
    let name = str_of(&v, "title").map(|t| t.trim_start_matches("Album - ").to_string()).unwrap_or_else(|| "YouTube playlist".into());
    let note = (unavailable > 0).then(|| format!("{unavailable} private or deleted video{} left out.", if unavailable == 1 { " was" } else { "s were" }));
    Ok(SourceList { platform: Platform::Youtube, name, url: String::new(), items, note })
}

/// `(title, artist)` from a video title and its channel: drops "(Official Video)"-style
/// noise and " - Topic"; splits "Artist - Title" / "Title - Artist" using the channel name.
pub fn split_video_title(title: &str, channel: &str) -> (String, String) {
    let channel = channel.trim().trim_end_matches(" - Topic").trim().to_string();
    let channel = channel.strip_suffix("VEVO").map(str::trim).filter(|c| !c.is_empty()).map(str::to_string).unwrap_or(channel);
    let clean = strip_noise(title);
    let nch = normalize(&channel).replace(' ', "");
    let mentions = |s: &str| {
        let n = normalize(s).replace(' ', "");
        !nch.is_empty() && !n.is_empty() && (n.contains(&nch) || nch.contains(&n))
    };
    for sep in [" - ", " – ", " — ", " | "] {
        if let Some((a, b)) = clean.split_once(sep) {
            let (a, b) = (a.trim(), b.trim());
            if a.is_empty() || b.is_empty() {
                continue;
            }
            if mentions(b) && !mentions(a) {
                return (a.to_string(), b.to_string());
            }
            if mentions(a) || channel.is_empty() {
                return (b.to_string(), a.to_string());
            }
        }
    }
    (clean, channel)
}

// ------------------------------------------------------------------ SoundCloud

/// Collects `yt-dlp -j` lines for SoundCloud.
#[derive(Default)]
struct SoundcloudAcc {
    name: Option<String>,
    items: Vec<SourceItem>,
}

impl SoundcloudAcc {
    /// Adds one line; returns the expected total when a track was added.
    fn push(&mut self, line: &str) -> Option<usize> {
        let v: Value = serde_json::from_str(line.trim()).ok()?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        if self.name.is_none() {
            self.name = s("playlist_title").or_else(|| s("playlist"));
        }
        let raw = s("title")?;
        let uploader = s("uploader").or_else(|| s("artist")).unwrap_or_default();
        let (title, artist) = split_soundcloud_title(&raw, &uploader);
        if self.name.is_none() && self.items.is_empty() {
            self.name = Some(title.clone());
        }
        self.items.push(SourceItem { title, artist, duration_secs: v.get("duration").and_then(Value::as_f64).filter(|d| *d > 0.0).map(f64::round), video: None });
        let total = v.get("n_entries").or_else(|| v.get("playlist_count")).and_then(Value::as_u64).map(|n| n as usize);
        Some(total.unwrap_or(self.items.len()))
    }

    fn finish(self) -> SourceList {
        SourceList { platform: Platform::Soundcloud, name: self.name.unwrap_or_else(|| "SoundCloud".into()), url: String::new(), items: self.items, note: None }
    }
}

/// SoundCloud uploads are often "Artist - Title" posted by someone else; otherwise the
/// uploader is the artist.
pub fn split_soundcloud_title(title: &str, uploader: &str) -> (String, String) {
    let clean = strip_noise(title);
    for sep in [" - ", " – ", " — "] {
        if let Some((a, b)) = clean.split_once(sep) {
            if !a.trim().is_empty() && !b.trim().is_empty() {
                return (b.trim().to_string(), a.trim().to_string());
            }
        }
    }
    (clean, uploader.trim().to_string())
}

/// Parses saved `yt-dlp -j` output (one JSON object per line).
pub fn parse_soundcloud_lines(text: &str) -> Result<SourceList> {
    let mut acc = SoundcloudAcc::default();
    for line in text.lines() {
        acc.push(line);
    }
    if acc.items.is_empty() {
        bail!("This SoundCloud link has no tracks");
    }
    Ok(acc.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_youtube_fixture() {
        let l = parse_youtube(include_str!("fixtures/ytdlp_youtube_playlist.json")).unwrap();
        assert_eq!(l.name, "Popular Music Videos");
        assert_eq!(l.items.len(), 3);
        let first = &l.items[0];
        assert_eq!(first.title, "BELLAKEO");
        assert_eq!(first.artist, "Peso Pluma, Anitta");
        assert_eq!(first.duration_secs, Some(235.0));
        let v = first.video.as_ref().unwrap();
        assert_eq!(v.video_id, "fOT0BUpITw8");
        assert_eq!(v.thumbnail.as_deref(), Some("https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg"));
        assert!(l.note.unwrap().contains("1 private or deleted video was"));
    }

    #[test]
    fn splits_video_titles() {
        assert_eq!(split_video_title("Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers", "Daft Punk"), ("Get Lucky".into(), "Daft Punk".into()));
        assert_eq!(split_video_title("Get Lucky", "Daft Punk - Topic"), ("Get Lucky".into(), "Daft Punk".into()));
        assert_eq!(split_video_title("Adele - Hello", "AdeleVEVO"), ("Hello".into(), "Adele".into()));
        assert_eq!(split_video_title("Some Artist - Song [Lyrics]", ""), ("Song".into(), "Some Artist".into()));
        assert_eq!(split_video_title("Song Title", "Uploader"), ("Song Title".into(), "Uploader".into()));
    }

    #[test]
    fn parses_soundcloud_fixture() {
        let l = parse_soundcloud_lines(include_str!("fixtures/ytdlp_soundcloud_set.jsonl")).unwrap();
        assert_eq!(l.name, "Soulhack");
        assert_eq!(l.items.len(), 3);
        assert_eq!(l.items[0].key(), ("City Ports", "Forss", Some(142.0)));
        assert!(l.items[0].video.is_none());
    }

    #[test]
    fn soundcloud_reposts_split_artist() {
        let line = r#"{"title":"Daft Punk - Something About Us (Free Download)","uploader":"some label","duration":231.5}"#;
        let l = parse_soundcloud_lines(line).unwrap();
        assert_eq!((l.items[0].title.as_str(), l.items[0].artist.as_str()), ("Something About Us", "Daft Punk"));
        assert_eq!(l.name, "Something About Us");
    }

    #[test]
    fn ytdlp_errors_are_readable() {
        assert!(ytdlp_error("ERROR: [youtube:tab] PLx: The playlist does not exist.", Platform::Youtube).contains("doesn't exist or is private"));
        assert_eq!(ytdlp_error("", Platform::Soundcloud), "Couldn't read this SoundCloud link");
    }
}
