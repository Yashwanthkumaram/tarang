//! Spotify playlists, albums and tracks without an account or API key.
//!
//! The public embed page `open.spotify.com/embed/{kind}/{id}` ships its data as JSON in
//! `<script id="__NEXT_DATA__">`: `props.pageProps.state.data.entity` holds `name` and a
//! `trackList` of `{ title, subtitle (artists), duration (ms) }`. It is plain HTTP, so
//! this works on every platform. The embed lists at most 100 songs.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use super::{parse_url, Platform, SourceItem, SourceList};

/// The embed page stops after this many songs.
pub const EMBED_LIMIT: usize = 100;

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Playlist,
    Album,
    Track,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Playlist => "playlist",
            Kind::Album => "album",
            Kind::Track => "track",
        }
    }
}

/// `(kind, id)` from any Spotify link form: `open.spotify.com/{kind}/{id}`, with an
/// `intl-xx/` prefix, the `embed/` form, query strings, or a `spotify:{kind}:{id}` URI.
pub fn parse_link(url: &str) -> Result<(Kind, String)> {
    let url = url.trim();
    let parts: Vec<String> = if let Some(rest) = url.strip_prefix("spotify:") {
        rest.split(':').map(str::to_string).collect()
    } else {
        let u = parse_url(url).ok_or_else(|| anyhow!("That doesn't look like a Spotify link"))?;
        u.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(str::to_string).collect()).unwrap_or_default()
    };
    let mut it = parts.iter().map(String::as_str).skip_while(|p| p.starts_with("intl-") || *p == "embed");
    let kind = match it.next() {
        Some("playlist") => Kind::Playlist,
        Some("album") => Kind::Album,
        Some("track") => Kind::Track,
        Some("artist") => bail!("Artist pages can't be imported — open one of the artist's albums or playlists and copy its link"),
        Some("user") | Some("collection") => bail!("Spotify profiles and Liked Songs can't be read without signing in — copy a playlist's link instead"),
        _ => bail!("Use a link to a Spotify playlist, album or song"),
    };
    let id = it.next().filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())).ok_or_else(|| anyhow!("That Spotify link has no playlist, album or song id"))?;
    Ok((kind, id.to_string()))
}

pub fn embed_url(kind: Kind, id: &str) -> String {
    format!("https://open.spotify.com/embed/{}/{}", kind.as_str(), id)
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent(UA).timeout(Duration::from_secs(20)).build()?)
}

/// Downloads and parses the list behind a Spotify link.
pub async fn fetch(url: &str) -> Result<SourceList> {
    let client = client()?;
    // Share links (spotify.link / spoti.fi) redirect to open.spotify.com.
    let mut link = url.trim().to_string();
    if matches!(super::host_of(&link).as_deref(), Some("spotify.link") | Some("spoti.fi")) {
        let resp = client.get(&link).send().await.context("Couldn't reach Spotify")?;
        link = resp.url().to_string();
    }
    let (kind, id) = parse_link(&link)?;
    let resp = client.get(embed_url(kind, &id)).send().await.context("Couldn't reach Spotify — check your connection")?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("Spotify says this {} doesn't exist or is private", kind.as_str());
    }
    let html = resp.error_for_status().context("Spotify refused the request")?.text().await?;
    let mut list = parse_embed(&html)?;
    list.url = format!("https://open.spotify.com/{}/{}", kind.as_str(), id);
    Ok(list)
}

/// Parses an embed page. `url` is left empty for the caller.
pub fn parse_embed(html: &str) -> Result<SourceList> {
    let json = next_data(html).ok_or_else(|| anyhow!("Spotify's page changed: no track data found (the playlist may be private)"))?;
    let v: Value = serde_json::from_str(json).context("Spotify's page changed: unreadable track data")?;
    let entity = v.pointer("/props/pageProps/state/data/entity").filter(|e| e.is_object()).ok_or_else(|| anyhow!("Spotify didn't return this list (it may be private or removed)"))?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(clean).unwrap_or_default();
    let name = Some(s(entity, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| s(entity, "title"));
    let kind = s(entity, "type");

    let items: Vec<SourceItem> = if kind == "track" {
        let artist = match entity.get("artists").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).map(clean).collect::<Vec<_>>().join(", "),
            None => s(entity, "subtitle"),
        };
        vec![SourceItem { title: name.clone(), artist, duration_secs: ms(entity.get("duration")), video: None }]
    } else {
        entity
            .get("trackList")
            .and_then(Value::as_array)
            .map(|tl| tl.as_slice())
            .unwrap_or_default()
            .iter()
            // Podcast episodes share the list format; only songs can be matched.
            .filter(|t| t.get("entityType").and_then(Value::as_str).is_none_or(|e| e == "track"))
            .map(|t| SourceItem { title: s(t, "title"), artist: split_artists(&s(t, "subtitle")).join(", "), duration_secs: ms(t.get("duration")), video: None })
            .filter(|i| !i.title.is_empty())
            .collect()
    };
    if items.is_empty() {
        bail!("This Spotify {} has no songs", if kind.is_empty() { "list" } else { &kind });
    }
    let note = (items.len() >= EMBED_LIMIT && kind == "playlist")
        .then(|| format!("Spotify only shows the first {EMBED_LIMIT} songs of a playlist without signing in, so longer playlists are cut off at {EMBED_LIMIT}."));
    Ok(SourceList { platform: Platform::Spotify, name, url: String::new(), items, note })
}

/// Contents of `<script id="__NEXT_DATA__" ...>…</script>`.
fn next_data(html: &str) -> Option<&str> {
    let start = html.find("id=\"__NEXT_DATA__\"")?;
    let open = start + html[start..].find('>')? + 1;
    let close = open + html[open..].find("</script>")?;
    Some(&html[open..close])
}

fn ms(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|d| *d > 0.0).map(|d| (d / 1000.0).round())
}

/// Spotify separates artists with ",\u{a0}"; whitespace is normalised.
fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn split_artists(s: &str) -> Vec<String> {
    s.split(',').map(clean).filter(|a| !a.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links() {
        let id = "4m2880jivSbbyEGAKfITCa".to_string();
        for url in [
            "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa",
            "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa?si=abc123",
            "open.spotify.com/intl-de/album/4m2880jivSbbyEGAKfITCa",
            "https://open.spotify.com/embed/album/4m2880jivSbbyEGAKfITCa?utm_source=generator",
            "spotify:album:4m2880jivSbbyEGAKfITCa",
        ] {
            assert_eq!(parse_link(url).unwrap(), (Kind::Album, id.clone()), "{url}");
        }
        assert_eq!(parse_link("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").unwrap().0, Kind::Playlist);
        assert_eq!(parse_link("https://open.spotify.com/track/0dEIca2nhcxDUV8C5QkPYb").unwrap().0, Kind::Track);
        assert!(parse_link("https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi").unwrap_err().to_string().contains("Artist"));
        assert!(parse_link("https://open.spotify.com/").is_err());
        assert!(parse_link("https://open.spotify.com/album/bad-id!").is_err());
        assert_eq!(embed_url(Kind::Album, &id), "https://open.spotify.com/embed/album/4m2880jivSbbyEGAKfITCa");
    }

    #[test]
    fn parses_album_fixture() {
        let l = parse_embed(include_str!("fixtures/spotify_album.html")).unwrap();
        assert_eq!(l.name, "Random Access Memories");
        assert_eq!(l.items.len(), 3);
        assert_eq!(l.items[0].key(), ("Give Life Back to Music", "Daft Punk", Some(275.0)));
        assert!(l.note.is_none());
    }

    #[test]
    fn parses_playlist_fixture_with_multiple_artists() {
        let l = parse_embed(include_str!("fixtures/spotify_playlist.html")).unwrap();
        assert_eq!(l.name, "Today’s Top Hits");
        assert_eq!(l.items[0].title, "expectations (feat. Chappell Roan)");
        assert_eq!(l.items[0].artist, "Olivia Rodrigo, Chappell Roan");
        assert!(l.items.iter().all(|i| i.duration_secs.unwrap_or(0.0) > 60.0));
    }

    #[test]
    fn parses_track_fixture() {
        let l = parse_embed(include_str!("fixtures/spotify_track.html")).unwrap();
        assert_eq!(l.items.len(), 1);
        assert_eq!(l.items[0].title, "Give Life Back to Music");
        assert_eq!(l.items[0].artist, "Daft Punk");
        assert_eq!(l.items[0].duration_secs, Some(275.0));
    }

    #[test]
    fn rejects_pages_without_data() {
        assert!(parse_embed("<html><body>nope</body></html>").is_err());
        let empty = r#"<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"type":"playlist","name":"x","trackList":[]}}}}}}</script>"#;
        assert!(parse_embed(empty).unwrap_err().to_string().contains("no songs"));
    }
}
