//! Reads metadata tags and stream properties from audio files using `lofty`.

use std::path::Path;

use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use symphonia::core::codecs::CODEC_TYPE_NULL;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;

/// Metadata the scanner needs for one file. Missing tags stay `None`;
/// `title` falls back to the file stem so every track has something to show.
#[derive(Debug, Clone, Default)]
pub struct FileMeta {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: f64,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bitrate_kbps: Option<u32>,
    /// True when at least one of title/artist/album was present as a real tag.
    pub has_tags: bool,
    pub format: String,
}

/// Reads tags and properties. Never fails hard: an unreadable file yields a
/// `FileMeta` with just the stem as title, so the scanner can still list it.
pub fn read(path: &Path) -> FileMeta {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".into());
    let format = crate::paths::extension(path).unwrap_or_default();

    let mut meta = FileMeta { title: stem.clone(), format, ..Default::default() };

    // Relaxed mode accepts recorder-style 3GPP/MP4 files that strict parsing rejects.
    let tagged = Probe::open(path)
        .and_then(|p| p.options(ParseOptions::new().parsing_mode(ParsingMode::Relaxed)).read())
        .or_else(|_| lofty::read_from_path(path));
    let tagged = match tagged {
        Ok(t) => t,
        Err(_) => {
            if let Some((rate, ch, dur)) = probe_properties(path) {
                meta.sample_rate = rate;
                meta.channels = ch;
                meta.duration_secs = dur;
            }
            return meta;
        }
    };

    let props = tagged.properties();
    meta.duration_secs = props.duration().as_secs_f64();
    meta.sample_rate = props.sample_rate();
    meta.channels = props.channels();
    meta.bitrate_kbps = props.audio_bitrate();
    if meta.duration_secs == 0.0 || meta.sample_rate.is_none() {
        if let Some((rate, ch, dur)) = probe_properties(path) {
            meta.sample_rate = meta.sample_rate.or(rate);
            meta.channels = meta.channels.or(ch);
            if meta.duration_secs == 0.0 {
                meta.duration_secs = dur;
            }
        }
    }

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        let title = tag.title().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let artist = tag
            .artist()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| tag.get_string(ItemKey::AlbumArtist).map(|s| s.to_string()));
        let album = tag.album().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        meta.has_tags = title.is_some() || artist.is_some() || album.is_some();
        if let Some(t) = title {
            meta.title = t;
        }
        meta.artist = artist;
        meta.album = album;
    }
    meta
}

/// Stream properties via Symphonia's demuxer, for containers lofty cannot parse.
/// Returns (sample rate, channels, duration in seconds).
pub fn probe_properties(path: &Path) -> Option<(Option<u32>, Option<u8>, f64)> {
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = crate::paths::extension(path) {
        hint.with_extension(&ext);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &Default::default(), &Default::default()).ok()?;
    let track = probed.format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let p = &track.codec_params;
    let rate = p.sample_rate;
    let channels = p.channels.map(|c| c.count() as u8);
    let duration = match (p.n_frames, p.time_base, rate) {
        (Some(n), Some(tb), _) => {
            let t = tb.calc_time(n);
            t.seconds as f64 + t.frac
        }
        (Some(n), None, Some(r)) if r > 0 => n as f64 / r as f64,
        _ => 0.0,
    };
    Some((rate, channels, duration))
}

/// Writes title/artist/album into the file's primary tag (creating one if
/// needed). Used for downloads whose metadata came from the source, not the file.
pub fn write_basic(path: &Path, title: &str, artist: Option<&str>, album: Option<&str>) -> anyhow::Result<()> {
    use lofty::config::WriteOptions;
    use lofty::tag::{Tag, TagExt, TagType};

    let mut tagged = Probe::open(path)?.options(ParseOptions::new().parsing_mode(ParsingMode::Relaxed)).read()?;
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged.primary_tag_mut().ok_or_else(|| anyhow::anyhow!("no tag slot"))?;
    tag.set_title(title.to_string());
    if let Some(a) = artist {
        tag.set_artist(a.to_string());
    }
    if let Some(a) = album {
        tag.set_album(a.to_string());
    }
    let _ = TagType::Mp4Ilst; // keep the import meaningful for MP4 readers of this code
    tag.save_to_path(path, WriteOptions::default())?;
    Ok(())
}
