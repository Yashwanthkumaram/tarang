//! Matches songs from other apps to YouTube Music songs.
//!
//! Each song is searched with `youtube::search("<title> <first artist>")` (title without
//! "feat." / "Remastered" noise). Every result is scored on title similarity (character
//! bigram Dice of the normalised titles, so it also works for scripts without spaces),
//! artist similarity and duration:
//!
//! * **matched** — title ≥ 0.85, artist ≥ 0.5, same version markers (live, remix, …) and
//!   duration within ±5 s (or, when the source has no duration, title ≥ 0.95 and
//!   artist ≥ 0.8);
//! * **review** — the best result is plausible (title ≥ 0.5 with a similar artist or
//!   length within ±10 s, or title ≥ 0.3 with the artist matching) but not certain; up
//!   to 3 alternatives are attached;
//! * **not_found** — nothing plausible; up to 3 alternatives are still attached so the
//!   user can pick one.
//!
//! YouTube playlist items already are videos and are matched to themselves.

use std::collections::HashSet;

use anyhow::Result;
use futures::stream::{self, StreamExt};

use super::{MatchStatus, PreviewItem, SourceItem};
use crate::models::YtTrack;
use crate::youtube;

/// Searches running at once.
pub const CONCURRENCY: usize = 4;
/// Results fetched per search.
const SEARCH_LIMIT: usize = 8;
/// Alternatives offered for "review" / "not_found" rows.
const ALTERNATIVES: usize = 3;
/// Allowed duration difference for a sure match, seconds.
pub const DURATION_TOLERANCE: f64 = 5.0;

/// Matches every item, at most [`CONCURRENCY`] searches at a time, preserving order.
/// `on_progress(done, total)` runs after each item. Fails only when every search failed
/// (network down); single failures become `not_found`.
pub async fn match_all(items: &[SourceItem], on_progress: impl Fn(usize, usize) + Send + Sync) -> Result<Vec<PreviewItem>> {
    let total = items.len();
    // Owned items and no captured references: the future must stay `Send` for any
    // lifetime when a Tauri command awaits it.
    let jobs = items.to_vec().into_iter().enumerate().map(|(i, item)| async move { (i, match_one(&item).await) });
    let mut pending = stream::iter(jobs).buffer_unordered(CONCURRENCY);
    let mut results: Vec<(usize, Result<PreviewItem>)> = Vec::with_capacity(total);
    while let Some(r) = pending.next().await {
        results.push(r);
        on_progress(results.len(), total);
    }
    results.sort_by_key(|(i, _)| *i);

    let failures = results.iter().filter(|(_, r)| r.is_err()).count();
    if total > 0 && failures == total {
        let (_, first) = results.into_iter().next().expect("non-empty");
        return Err(first.expect_err("all failed").context("Couldn't search YouTube Music — check your connection"));
    }
    Ok(results
        .into_iter()
        .map(|(i, r)| {
            r.unwrap_or_else(|e| {
                tracing::warn!("import match failed for {:?}: {e:#}", items[i].title);
                unmatched(&items[i], Vec::new())
            })
        })
        .collect())
}

/// Matches one song (one or two searches).
pub async fn match_one(item: &SourceItem) -> Result<PreviewItem> {
    if let Some(v) = &item.video {
        return Ok(PreviewItem {
            title: item.title.clone(),
            artist: item.artist.clone(),
            duration_secs: item.duration_secs,
            status: MatchStatus::Matched,
            matched: Some(v.clone()),
            alternatives: Vec::new(),
        });
    }
    let title = core_title(&item.title);
    let title = if title.is_empty() { item.title.clone() } else { title };
    let artist = primary_artist(&item.artist);
    let query = format!("{title} {artist}").trim().to_string();
    let mut hits = youtube::search(&query, SEARCH_LIMIT).await?;
    if hits.is_empty() && !artist.is_empty() {
        hits = youtube::search(&title, SEARCH_LIMIT).await?;
    }
    Ok(classify(item, hits))
}

fn unmatched(item: &SourceItem, alternatives: Vec<YtTrack>) -> PreviewItem {
    PreviewItem { title: item.title.clone(), artist: item.artist.clone(), duration_secs: item.duration_secs, status: MatchStatus::NotFound, matched: None, alternatives }
}

/// Scores of one candidate against the source song.
#[derive(Debug, Clone, Copy)]
pub struct Score {
    pub title: f64,
    pub artist: f64,
    /// Absolute difference in seconds, when both durations are known.
    pub duration_diff: Option<f64>,
    pub same_version: bool,
}

impl Score {
    pub fn total(&self) -> f64 {
        let dur = match self.duration_diff {
            Some(d) if d <= DURATION_TOLERANCE => 1.0,
            Some(d) => (1.0 - (d - DURATION_TOLERANCE) / 25.0).max(0.0),
            None => 0.5,
        };
        let version = if self.same_version { 0.0 } else { 0.15 };
        0.55 * self.title + 0.3 * self.artist + 0.15 * dur - version
    }

    pub fn is_sure(&self) -> bool {
        if !self.same_version || self.title < 0.85 || self.artist < 0.5 {
            return false;
        }
        match self.duration_diff {
            Some(d) => d <= DURATION_TOLERANCE,
            None => self.title >= 0.95 && self.artist >= 0.8,
        }
    }

    /// Worth showing as a suggestion: a similar title by a similar artist (or with a
    /// near-equal length), or the right artist with a loosely similar title. A same-named
    /// song by an unrelated artist is not.
    pub fn is_plausible(&self) -> bool {
        let close_length = self.duration_diff.is_some_and(|d| d <= 2.0 * DURATION_TOLERANCE);
        (self.title >= 0.5 && (self.artist >= 0.3 || close_length)) || (self.title >= 0.3 && self.artist >= 0.5)
    }
}

pub fn score(item: &SourceItem, c: &YtTrack) -> Score {
    let title = bigram_dice(&normalize(&core_title(&item.title)), &normalize(&core_title(&c.title)))
        .max(bigram_dice(&normalize(&item.title), &normalize(&c.title)));
    Score {
        title,
        artist: artist_similarity(&item.artist, &c.artist),
        duration_diff: match (item.duration_secs, c.duration_secs) {
            (Some(a), Some(b)) => Some((a - b).abs()),
            _ => None,
        },
        same_version: version_markers(&item.title) == version_markers(&c.title),
    }
}

/// Picks the status, match and alternatives from search results.
pub fn classify(item: &SourceItem, hits: Vec<YtTrack>) -> PreviewItem {
    let mut seen = HashSet::new();
    let mut scored: Vec<(Score, YtTrack)> = hits.into_iter().filter(|h| seen.insert(h.video_id.clone())).map(|h| (score(item, &h), h)).collect();
    // Stable sort: equal scores keep YouTube Music's own ranking.
    scored.sort_by(|a, b| b.0.total().total_cmp(&a.0.total()));
    let Some((best, _)) = scored.first().map(|(s, t)| (*s, t)) else {
        return unmatched(item, Vec::new());
    };
    if best.is_sure() {
        let (_, m) = scored.remove(0);
        return PreviewItem { title: item.title.clone(), artist: item.artist.clone(), duration_secs: item.duration_secs, status: MatchStatus::Matched, matched: Some(m), alternatives: Vec::new() };
    }
    if best.is_plausible() {
        let mut it = scored.into_iter().map(|(_, t)| t);
        let m = it.next();
        return PreviewItem {
            title: item.title.clone(),
            artist: item.artist.clone(),
            duration_secs: item.duration_secs,
            status: MatchStatus::Review,
            matched: m,
            alternatives: it.take(ALTERNATIVES).collect(),
        };
    }
    unmatched(item, scored.into_iter().map(|(_, t)| t).take(ALTERNATIVES).collect())
}

// ------------------------------------------------------------------ text helpers

/// Lowercase, letters and digits only (any script), single spaces; "&" reads as "and".
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars().flat_map(char::to_lowercase) {
        let ch = fold_accent(ch);
        if ch == '&' {
            out.push_str(" and ");
        } else if ch.is_alphanumeric() {
            out.push(ch);
        } else if ch != '\'' && ch != '’' {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Common Latin accents folded so "Beyoncé" equals "Beyonce".
fn fold_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        _ => c,
    }
}

/// Words inside brackets or after " - " that don't change which recording it is.
const NOISE: &[&str] = &[
    "official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "hd", "hq", "4k", "mv", "m v", "oficial", "clip", "explicit", "clean",
    "remaster", "remastered", "feat", "ft", "featuring", "with", "prod", "free download", "out now", "radio edit", "single version", "album version",
    "original mix", "mono", "stereo", "bonus track", "deluxe",
];

fn is_noise(segment: &str) -> bool {
    let n = normalize(segment);
    if n.is_empty() {
        return true;
    }
    let padded = format!(" {n} ");
    NOISE.iter().any(|w| padded.contains(&format!(" {w} "))) || n.chars().all(|c| c.is_ascii_digit() || c == ' ')
}

/// Removes "(Official Video)", "[Lyrics]", "(feat. X)", " - Remastered 2011", trailing
/// "ft. X" and similar noise; keeps markers like "(Live)" or "(Remix)".
pub fn strip_noise(title: &str) -> String {
    let mut out = String::new();
    let mut rest = title;
    while let Some(start) = rest.find(['(', '[']) {
        let close = if rest.as_bytes()[start] == b'(' { ')' } else { ']' };
        let Some(len) = rest[start + 1..].find(close) else { break };
        let inner = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        if !is_noise(inner) {
            out.push_str(&rest[start..start + len + 2]);
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    let mut s = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // Unbracketed "ft. X" / "feat. X" to the end.
    let lower = s.to_ascii_lowercase(); // same byte offsets as `s`
    if let Some(i) = [" feat. ", " feat ", " ft. ", " ft ", " featuring "].iter().filter_map(|m| lower.find(m)).min() {
        if i > 0 {
            s.truncate(i);
        }
    }
    let s = s.trim().trim_end_matches(['-', '–', '|', ',']).trim().to_string();
    // Trailing " - Remastered 2009" / " - Radio Edit".
    if let Some((head, tail)) = s.rsplit_once(" - ") {
        if is_noise(tail) && !head.trim().is_empty() {
            return head.trim().to_string();
        }
    }
    s
}

/// Title for searching and comparing: noise removed, then any bracketed part and
/// anything after " - " dropped.
pub fn core_title(title: &str) -> String {
    let s = strip_noise(title);
    let mut out = String::new();
    let mut depth = 0i32;
    for ch in s.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    let out = out.split(" - ").next().unwrap_or("").to_string();
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Words that make a different recording of the same song.
fn version_markers(title: &str) -> Vec<&'static str> {
    const MARKERS: &[&str] = &["live", "remix", "acoustic", "instrumental", "karaoke", "cover", "slowed", "sped", "nightcore", "reverb", "8d", "demo", "unplugged", "orchestral", "piano"];
    let n = normalize(title);
    let words: HashSet<&str> = n.split(' ').collect();
    MARKERS.iter().copied().filter(|m| words.contains(m)).collect()
}

fn primary_artist(artists: &str) -> String {
    artists.split([',', '&']).next().unwrap_or("").trim().to_string()
}

/// 1.0 when the source's first artist is (part of) the candidate's artist; otherwise
/// the share of candidate artist words found among all source artists.
pub fn artist_similarity(source: &str, candidate: &str) -> f64 {
    let c = normalize(candidate);
    if c.is_empty() {
        return 0.0;
    }
    let primary = normalize(&primary_artist(source));
    let c_compact = c.replace(' ', "");
    let p_compact = primary.replace(' ', "");
    if !p_compact.is_empty() && (c_compact.contains(&p_compact) || p_compact.contains(&c_compact)) {
        return 1.0;
    }
    let all = normalize(source);
    let source_words: HashSet<&str> = all.split(' ').collect();
    let cand_words: Vec<&str> = c.split(' ').filter(|w| *w != "and" && *w != "the").collect();
    if cand_words.is_empty() {
        return 0.0;
    }
    let overlap = cand_words.iter().filter(|w| source_words.contains(*w)).count() as f64 / cand_words.len() as f64;
    overlap.max(bigram_dice(&primary, &c))
}

/// Dice coefficient over character bigrams (spaces removed). 1.0 for equal strings.
pub fn bigram_dice(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().filter(|c| !c.is_whitespace()).collect();
    let b: Vec<char> = b.chars().filter(|c| !c.is_whitespace()).collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    if a.len() < 2 || b.len() < 2 {
        return 0.0;
    }
    let mut grams: Vec<(char, char)> = a.windows(2).map(|w| (w[0], w[1])).collect();
    let total = grams.len() + b.len() - 1;
    let mut hits = 0;
    for w in b.windows(2) {
        if let Some(i) = grams.iter().position(|g| *g == (w[0], w[1])) {
            grams.swap_remove(i);
            hits += 1;
        }
    }
    2.0 * hits as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn src(title: &str, artist: &str, dur: Option<f64>) -> SourceItem {
        SourceItem { title: title.into(), artist: artist.into(), duration_secs: dur, video: None }
    }

    fn yt(id: &str, title: &str, artist: &str, dur: Option<f64>) -> YtTrack {
        YtTrack { video_id: id.into(), title: title.into(), artist: artist.into(), album: None, duration_secs: dur, thumbnail: None, explicit: false, local_track_id: None }
    }

    #[test]
    fn strips_noise() {
        assert_eq!(strip_noise("Get Lucky (feat. Pharrell Williams & Nile Rodgers) - Radio Edit"), "Get Lucky");
        assert_eq!(strip_noise("Hello [Official Music Video]"), "Hello");
        assert_eq!(strip_noise("Here Comes the Sun - Remastered 2009"), "Here Comes the Sun");
        assert_eq!(strip_noise("Song (Live at Wembley)"), "Song (Live at Wembley)");
        assert_eq!(strip_noise("Track ft. Someone"), "Track");
        assert_eq!(strip_noise("Paint The Town Red (2023)"), "Paint The Town Red");
        assert_eq!(core_title("Instant Crush (feat. Julian Casablancas)"), "Instant Crush");
        assert_eq!(core_title("Song (Live at Wembley)"), "Song");
        assert_eq!(normalize("Beyoncé & JAY-Z"), "beyonce and jay z");
    }

    #[test]
    fn similarity_measures() {
        assert_eq!(bigram_dice("night", "night"), 1.0);
        assert!(bigram_dice("give life back to music", "give life back 2 music") > 0.8);
        assert!(bigram_dice("hello", "goodbye") < 0.2);
        assert_eq!(artist_similarity("Olivia Rodrigo, Chappell Roan", "Olivia Rodrigo"), 1.0);
        assert_eq!(artist_similarity("Daft Punk", "Daft Punk & Pharrell Williams"), 1.0);
        assert!(artist_similarity("Daft Punk", "Kanye West") < 0.3);
    }

    #[test]
    fn classifies_matched() {
        let item = src("Give Life Back to Music", "Daft Punk", Some(275.0));
        let p = classify(&item, vec![yt("other000001", "Give Life Back to Music (Live)", "Daft Punk", Some(300.0)), yt("aaaaaaaaaaa", "Give Life Back to Music", "Daft Punk", Some(274.0))]);
        assert_eq!(p.status, MatchStatus::Matched);
        assert_eq!(p.matched.unwrap().video_id, "aaaaaaaaaaa");
    }

    #[test]
    fn duration_off_means_review() {
        let item = src("Get Lucky", "Daft Punk", Some(248.0));
        let p = classify(&item, vec![yt("aaaaaaaaaaa", "Get Lucky", "Daft Punk", Some(369.0)), yt("b", "Get Lucky (Radio Edit)", "Daft Punk", Some(390.0)), yt("c", "Lose Yourself to Dance", "Daft Punk", Some(353.0))]);
        assert_eq!(p.status, MatchStatus::Review);
        assert_eq!(p.matched.unwrap().video_id, "aaaaaaaaaaa");
        assert_eq!(p.alternatives.len(), 2);
    }

    #[test]
    fn different_version_is_not_sure() {
        let item = src("Song", "Artist", Some(200.0));
        let p = classify(&item, vec![yt("a", "Song (Remix)", "Artist", Some(201.0))]);
        assert_eq!(p.status, MatchStatus::Review);
    }

    #[test]
    fn unrelated_is_not_found_with_alternatives() {
        let item = src("Obscure Bedroom Demo", "Nobody Known", Some(100.0));
        let hits = (0..5).map(|i| yt(&format!("v{i}"), &format!("Totally Different {i}"), "Famous Star", Some(200.0))).collect();
        let p = classify(&item, hits);
        assert_eq!(p.status, MatchStatus::NotFound);
        assert!(p.matched.is_none());
        assert_eq!(p.alternatives.len(), 3);
        assert_eq!(classify(&item, vec![]).status, MatchStatus::NotFound);
    }

    #[test]
    fn missing_duration_needs_exact_title() {
        let item = src("Night Drive", "Some Band", None);
        assert_eq!(classify(&item, vec![yt("a", "Night Drive", "Some Band", Some(200.0))]).status, MatchStatus::Matched);
        assert_eq!(classify(&item, vec![yt("a", "Night Drives", "Some Band", Some(200.0))]).status, MatchStatus::Review);
    }

    #[test]
    fn same_title_other_artist_is_not_found() {
        let item = src("Characteristics", "Forss", Some(399.0));
        let p = classify(&item, vec![yt("a", "characteristic", "ptasinski & RJ Pasin", Some(123.0))]);
        assert_eq!(p.status, MatchStatus::NotFound);
        assert_eq!(p.alternatives.len(), 1);
    }

    #[tokio::test]
    async fn videos_match_themselves_without_search() {
        let v = yt("fOT0BUpITw8", "BELLAKEO", "Peso Pluma", Some(235.0));
        let items = vec![SourceItem { title: "BELLAKEO".into(), artist: "Peso Pluma".into(), duration_secs: Some(235.0), video: Some(v) }];
        let calls = AtomicUsize::new(0);
        let out = match_all(&items, |d, t| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!((d, t), (1, 1));
        })
        .await
        .unwrap();
        assert_eq!(out[0].status, MatchStatus::Matched);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
