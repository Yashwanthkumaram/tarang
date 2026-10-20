//! Music-vs-voice classifier.
//!
//! Runs fully offline with no model file. It decodes a short excerpt of the
//! file, extracts a handful of signal features (rhythm, bandwidth, energy
//! modulation, stereo width), combines them with metadata hints (sample rate,
//! channels, tags, folder and file names) and produces a voice probability.
//!
//! The weights live in [`Weights`] so they can be tuned in one place. A
//! learned model (ONNX) can replace [`score`] later without touching callers:
//! keep the [`Classification`] output shape.

use std::fs::File;
use std::path::Path;

use anyhow::{anyhow, Result};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::models::{Classification, Kind};
use crate::tags::FileMeta;

/// How many seconds of audio to analyse. Longer is more accurate but slower.
pub const EXCERPT_SECS: f64 = 40.0;
/// Seconds to skip at the start (intros and recording-button clicks).
pub const SKIP_SECS: f64 = 1.5;

const FRAME: usize = 2048;
const HOP: usize = 1024;

/// Decoded, downmixed excerpt plus the stereo correlation measured before downmix.
pub struct Excerpt {
    pub sample_rate: u32,
    pub channels: usize,
    pub mono: Vec<f32>,
    /// Pearson correlation of L and R. `None` for mono files.
    pub stereo_correlation: Option<f32>,
}

/// Decodes up to `max_secs` of audio after `skip_secs`. Fails only when the
/// container or codec is unsupported; callers then fall back to hints alone.
pub fn decode_excerpt(path: &Path, skip_secs: f64, max_secs: f64) -> Result<Excerpt> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = crate::paths::extension(path) {
        hint.with_extension(&ext);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("no decodable track"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;

    let mut rate = 0u32;
    let mut channels = 0usize;
    let mut left: Vec<f32> = Vec::new();
    let mut right: Vec<f32> = Vec::new();
    let mut skipped = 0usize;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        if rate == 0 {
            rate = spec.rate;
            channels = spec.channels.count();
        }
        let buf = sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        buf.copy_interleaved_ref(decoded);
        let samples = buf.samples();
        let skip_target = (skip_secs * rate as f64) as usize;
        let max_frames = (max_secs * rate as f64) as usize;
        let ch = channels.max(1);
        for frame in samples.chunks_exact(ch) {
            if skipped < skip_target {
                skipped += 1;
                continue;
            }
            left.push(frame[0]);
            if ch > 1 {
                right.push(frame[1]);
            }
            if left.len() >= max_frames {
                break;
            }
        }
        if left.len() >= max_frames {
            break;
        }
    }
    if rate == 0 || left.is_empty() {
        return Err(anyhow!("decoded no audio"));
    }

    let stereo_correlation = if channels > 1 && right.len() == left.len() {
        Some(pearson(&left, &right))
    } else {
        None
    };
    let mono: Vec<f32> = if channels > 1 {
        left.iter().zip(right.iter()).map(|(l, r)| 0.5 * (l + r)).collect()
    } else {
        left
    };
    Ok(Excerpt { sample_rate: rate, channels, mono, stereo_correlation })
}

fn pearson(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f64;
    if n < 2.0 {
        return 1.0;
    }
    let ma = a.iter().map(|x| *x as f64).sum::<f64>() / n;
    let mb = b.iter().map(|x| *x as f64).sum::<f64>() / n;
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let dx = *x as f64 - ma;
        let dy = *y as f64 - mb;
        cov += dx * dy;
        va += dx * dx;
        vb += dy * dy;
    }
    if va == 0.0 || vb == 0.0 {
        return 1.0;
    }
    (cov / (va.sqrt() * vb.sqrt())) as f32
}

/// Signal features. All are dimensionless so the weights are easy to reason about.
#[derive(Debug, Clone, Default)]
pub struct Features {
    /// Fraction of frames that are near-silent (speech has pauses).
    pub silence_ratio: f64,
    /// Coefficient of variation of frame energy (speech is bursty).
    pub energy_cv: f64,
    /// Energy of the 3–8 Hz modulation band relative to the whole envelope
    /// spectrum. Syllables land here; music is flatter.
    pub syllable_modulation: f64,
    /// Strength of a periodic beat in the onset envelope (0..1). Music has one.
    pub beat_strength: f64,
    /// Fraction of spectral energy above 4 kHz. Phone recordings have little.
    pub high_band_ratio: f64,
    /// 95 % roll-off frequency in Hz, averaged over frames.
    pub rolloff_hz: f64,
    /// Std-dev of spectral centroid over frames, normalised by its mean.
    pub centroid_cv: f64,
    /// Mean zero-crossing rate (crossings per sample).
    pub zcr_mean: f64,
    /// Std-dev of the zero-crossing rate across frames.
    pub zcr_std: f64,
    /// Mean spectral flatness (0 = tonal, 1 = noise).
    pub flatness: f64,
    /// L/R correlation; 1 = effectively mono. None for mono files.
    pub stereo_correlation: Option<f64>,
    pub analysed_secs: f64,
}

/// Extracts [`Features`] from a decoded excerpt.
pub fn extract_features(ex: &Excerpt) -> Features {
    let rate = ex.sample_rate as f64;
    let x = &ex.mono;
    let mut f = Features { stereo_correlation: ex.stereo_correlation.map(|c| c as f64), analysed_secs: x.len() as f64 / rate, ..Default::default() };
    if x.len() < FRAME * 4 {
        return f;
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let window: Vec<f32> = (0..FRAME).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FRAME as f32).cos()).collect();
    let bin_hz = rate / FRAME as f64;
    let bin_4k = ((4000.0 / bin_hz) as usize).min(FRAME / 2);

    let mut rms = Vec::new();
    let mut zcr = Vec::new();
    let mut centroid = Vec::new();
    let mut rolloff = Vec::new();
    let mut flat = Vec::new();
    let mut high = Vec::new();
    let mut flux = Vec::new();
    let mut prev_mag: Vec<f32> = vec![0.0; FRAME / 2];
    let mut buf = vec![Complex::new(0.0f32, 0.0); FRAME];

    let mut start = 0;
    while start + FRAME <= x.len() {
        let frame = &x[start..start + FRAME];
        let e = (frame.iter().map(|s| s * s).sum::<f32>() / FRAME as f32).sqrt();
        rms.push(e as f64);
        let crossings = frame.windows(2).filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0)).count();
        zcr.push(crossings as f64 / FRAME as f64);

        for i in 0..FRAME {
            buf[i] = Complex::new(frame[i] * window[i], 0.0);
        }
        fft.process(&mut buf);
        let mag: Vec<f32> = buf[..FRAME / 2].iter().map(|c| c.norm()).collect();
        let total: f64 = mag.iter().map(|m| *m as f64).sum();
        if total > 1e-6 {
            let c = mag.iter().enumerate().map(|(i, m)| i as f64 * bin_hz * *m as f64).sum::<f64>() / total;
            centroid.push(c);
            let mut acc = 0.0;
            let mut r = 0usize;
            for (i, m) in mag.iter().enumerate() {
                acc += *m as f64;
                if acc >= 0.95 * total {
                    r = i;
                    break;
                }
            }
            rolloff.push(r as f64 * bin_hz);
            high.push(mag[bin_4k..].iter().map(|m| *m as f64).sum::<f64>() / total);
            let n = mag.len() as f64;
            let geo = (mag.iter().map(|m| (*m as f64 + 1e-9).ln()).sum::<f64>() / n).exp();
            flat.push(geo / (total / n));
        }
        let fl: f32 = mag.iter().zip(&prev_mag).map(|(a, b)| (a - b).max(0.0)).sum();
        flux.push(fl as f64);
        prev_mag = mag;
        start += HOP;
    }

    let n = rms.len() as f64;
    let mean = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };
    let std = |v: &[f64]| {
        let m = mean(v);
        (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len().max(1) as f64).sqrt()
    };

    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    let peak = sorted[sorted.len() - 1].max(1e-9);
    let quiet = rms.iter().filter(|e| **e < (0.08 * median).max(0.01 * peak)).count() as f64;
    f.silence_ratio = quiet / n;
    f.energy_cv = if mean(&rms) > 0.0 { std(&rms) / mean(&rms) } else { 0.0 };
    f.zcr_mean = mean(&zcr);
    f.zcr_std = std(&zcr);
    f.centroid_cv = if mean(&centroid) > 0.0 { std(&centroid) / mean(&centroid) } else { 0.0 };
    f.rolloff_hz = mean(&rolloff);
    f.high_band_ratio = mean(&high);
    f.flatness = mean(&flat);

    // Envelope modulation spectrum: FFT of the RMS envelope (sampled at rate/HOP).
    let env_rate = rate / HOP as f64;
    f.syllable_modulation = band_fraction(&rms, env_rate, 3.0, 8.0, 0.3, 20.0);
    f.beat_strength = beat_strength(&flux, env_rate);
    f
}

/// Fraction of envelope-spectrum energy in `lo..hi` Hz relative to `all_lo..all_hi`.
fn band_fraction(env: &[f64], env_rate: f64, lo: f64, hi: f64, all_lo: f64, all_hi: f64) -> f64 {
    let n = env.len().next_power_of_two().max(64);
    let m = env.iter().sum::<f64>() / env.len() as f64;
    let mut buf: Vec<Complex<f32>> = (0..n).map(|i| Complex::new(if i < env.len() { (env[i] - m) as f32 } else { 0.0 }, 0.0)).collect();
    let mut planner = FftPlanner::<f32>::new();
    planner.plan_fft_forward(n).process(&mut buf);
    let hz = env_rate / n as f64;
    let (mut band, mut all) = (0.0, 0.0);
    for (i, c) in buf[..n / 2].iter().enumerate() {
        let fq = i as f64 * hz;
        let p = (c.norm() as f64).powi(2);
        if fq >= all_lo && fq <= all_hi {
            all += p;
            if fq >= lo && fq <= hi {
                band += p;
            }
        }
    }
    if all > 0.0 { band / all } else { 0.0 }
}

/// Autocorrelation of the onset (spectral flux) envelope over lags matching
/// 50–200 BPM. Returns the best normalised peak, 0..1.
fn beat_strength(flux: &[f64], env_rate: f64) -> f64 {
    if flux.len() < 64 {
        return 0.0;
    }
    let m = flux.iter().sum::<f64>() / flux.len() as f64;
    let x: Vec<f64> = flux.iter().map(|v| v - m).collect();
    let r0: f64 = x.iter().map(|v| v * v).sum();
    if r0 <= 0.0 {
        return 0.0;
    }
    let lag_min = (env_rate * 60.0 / 200.0) as usize;
    let lag_max = ((env_rate * 60.0 / 50.0) as usize).min(x.len() / 2);
    let mut best: f64 = 0.0;
    for lag in lag_min.max(1)..lag_max {
        let r: f64 = x[..x.len() - lag].iter().zip(&x[lag..]).map(|(a, b)| a * b).sum();
        best = best.max(r / r0);
    }
    best.clamp(0.0, 1.0)
}

/// Metadata available without decoding.
#[derive(Debug, Clone, Default)]
pub struct Hints {
    pub format: String,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub has_tags: bool,
    pub has_artist: bool,
    pub duration_secs: f64,
    /// From [`crate::paths::folder_hint`]: positive leans voice.
    pub folder_hint: f64,
    pub file_name: String,
}

impl Hints {
    pub fn from_meta(path: &Path, meta: &FileMeta) -> Hints {
        Hints {
            format: meta.format.clone(),
            sample_rate: meta.sample_rate,
            channels: meta.channels,
            has_tags: meta.has_tags,
            has_artist: meta.artist.is_some(),
            duration_secs: meta.duration_secs,
            folder_hint: crate::paths::folder_hint(path),
            file_name: path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default(),
        }
    }
}

/// Every contribution to the voice score. Positive pushes towards "voice".
/// Tune here; nothing else hard-codes numbers.
#[derive(Debug, Clone)]
pub struct Weights {
    pub bias: f64,
    pub silence_ratio: f64,
    pub energy_cv: f64,
    pub syllable_modulation: f64,
    pub beat_strength: f64,
    pub high_band_ratio: f64,
    pub low_rolloff: f64,
    pub centroid_cv: f64,
    pub zcr_std: f64,
    pub stereo_mono_like: f64,
    pub mono_file: f64,
    pub low_sample_rate: f64,
    pub voice_format: f64,
    pub has_tags: f64,
    pub has_artist: f64,
    pub folder_hint: f64,
    pub file_name_pattern: f64,
    pub very_long: f64,
}

impl Default for Weights {
    fn default() -> Self {
        Weights {
            bias: -0.6,
            silence_ratio: 3.0,
            energy_cv: 1.6,
            syllable_modulation: 3.0,
            beat_strength: -4.0,
            high_band_ratio: -4.0,
            low_rolloff: 1.4,
            centroid_cv: 1.2,
            zcr_std: 8.0,
            stereo_mono_like: 1.0,
            mono_file: 1.2,
            low_sample_rate: 2.0,
            voice_format: 3.0,
            has_tags: -1.2,
            has_artist: -1.8,
            folder_hint: 2.2,
            file_name_pattern: 2.0,
            very_long: 0.8,
        }
    }
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// File-name patterns typical of recorders: "Rec 2026-10-14", "PTT-20261009-WA0012",
/// "Voice 003", "Call recording", "20261014_091233".
fn name_looks_recorded(name: &str) -> bool {
    let words = ["rec ", "rec_", "rec-", "recording", "voice", "memo", "ptt-", "call", "aud-", "audio_", "dictation"];
    if words.iter().any(|w| name.starts_with(w) || name.contains(w)) {
        return true;
    }
    // 8 digits, separator, 6 digits: a timestamp file name.
    let digits: Vec<bool> = name.chars().map(|c| c.is_ascii_digit()).collect();
    digits.windows(15).any(|w| w[..8].iter().all(|d| *d) && !w[8] && w[9..15].iter().all(|d| *d))
}

/// Combines features and hints into a probability and a labelled reason.
pub fn score(features: Option<&Features>, h: &Hints, w: &Weights) -> (f64, Vec<String>) {
    let mut s = w.bias;
    let mut why: Vec<String> = Vec::new();

    if let Some(f) = features {
        s += w.silence_ratio * f.silence_ratio;
        if f.silence_ratio > 0.2 {
            why.push("frequent pauses".into());
        }
        s += w.energy_cv * f.energy_cv.min(2.0);
        s += w.syllable_modulation * f.syllable_modulation;
        if f.syllable_modulation > 0.45 {
            why.push("speech-rate rhythm".into());
        }
        s += w.beat_strength * f.beat_strength;
        if f.beat_strength > 0.35 {
            why.push("steady beat".into());
        }
        s += w.high_band_ratio * f.high_band_ratio.min(0.5) * 2.0;
        if f.rolloff_hz > 0.0 && f.rolloff_hz < 4500.0 {
            s += w.low_rolloff;
            why.push("narrow bandwidth".into());
        }
        s += w.centroid_cv * f.centroid_cv.min(1.5);
        s += w.zcr_std * f.zcr_std.min(0.15);
        if let Some(c) = f.stereo_correlation {
            if c > 0.98 {
                s += w.stereo_mono_like;
                why.push("stereo but identical channels".into());
            } else if c < 0.9 {
                s -= w.stereo_mono_like;
            }
        }
    }

    if h.channels == Some(1) {
        s += w.mono_file;
        why.push("mono".into());
    }
    if let Some(r) = h.sample_rate {
        if r <= 22050 {
            s += w.low_sample_rate;
            why.push(format!("{} kHz", r / 1000));
        }
    }
    if crate::paths::VOICE_LEANING_EXTENSIONS.contains(&h.format.as_str()) {
        s += w.voice_format;
        why.push(format!(".{} recorder format", h.format));
    }
    if h.has_tags {
        s += w.has_tags;
    }
    if h.has_artist {
        s += w.has_artist;
        why.push("has artist tag".into());
    } else {
        why.push("no artist tag".into());
    }
    s += w.folder_hint * h.folder_hint;
    if h.folder_hint > 0.0 {
        why.push("recordings folder".into());
    } else if h.folder_hint < 0.0 {
        why.push("music folder".into());
    }
    if name_looks_recorded(&h.file_name) {
        s += w.file_name_pattern;
        why.push("recorder-style file name".into());
    }
    if h.duration_secs > 20.0 * 60.0 {
        s += w.very_long;
    }
    (sigmoid(s), why)
}

/// Full pipeline for one file. `threshold` is the minimum confidence to auto-file.
pub fn classify_file(path: &Path, meta: &FileMeta, threshold: f64, use_hints: bool, weights: &Weights) -> Classification {
    let excerpt = decode_excerpt(path, SKIP_SECS, EXCERPT_SECS).ok();
    let mut hints = Hints::from_meta(path, meta);
    if let Some(ex) = &excerpt {
        // The tag reader may not know these (3GPP recorder files); the decoder does.
        if hints.channels.is_none() {
            hints.channels = Some(ex.channels as u8);
        }
        if hints.sample_rate.is_none() {
            hints.sample_rate = Some(ex.sample_rate);
        }
    }
    let features = excerpt.as_ref().map(extract_features);
    if !use_hints {
        hints.folder_hint = 0.0;
        hints.file_name = String::new();
    }
    let (p, why) = score(features.as_ref(), &hints, weights);
    let mut c = finish(p, why, threshold, features.is_none());
    if let Some(ex) = &excerpt {
        c.decoded_sample_rate = Some(ex.sample_rate);
        c.decoded_channels = Some(ex.channels as u8);
    }
    c
}

fn finish(p: f64, mut why: Vec<String>, threshold: f64, hints_only: bool) -> Classification {
    let confidence = ((p - 0.5).abs() * 2.0).clamp(0.0, 1.0);
    let mut kind = if p >= 0.5 { Kind::Voice } else { Kind::Music };
    if confidence < threshold {
        kind = Kind::Unsure;
    }
    if hints_only {
        why.insert(0, "could not decode audio, used metadata only".into());
    }
    why.truncate(4);
    Classification { kind, voice_probability: p, confidence, reason: why.join(", "), decoded_sample_rate: None, decoded_channels: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_music(rate: u32, secs: f64) -> Excerpt {
        // Sustained chord + kick every 0.5 s, wide stereo, full bandwidth.
        let n = (rate as f64 * secs) as usize;
        let mut l = Vec::with_capacity(n);
        let mut r = Vec::with_capacity(n);
        let mut seed = 1u32;
        for i in 0..n {
            let t = i as f64 / rate as f64;
            let chord = (2.0 * std::f64::consts::PI * 220.0 * t).sin() + (2.0 * std::f64::consts::PI * 277.0 * t).sin() + (2.0 * std::f64::consts::PI * 330.0 * t).sin();
            let beat_phase = t % 0.5;
            let kick = if beat_phase < 0.05 { (1.0 - beat_phase / 0.05) * (2.0 * std::f64::consts::PI * 60.0 * t).sin() * 2.0 } else { 0.0 };
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let hat = if (t * 4.0) % 1.0 < 0.03 { ((seed >> 8) as f64 / u32::MAX as f64 * 2.0 - 1.0) * 0.6 } else { 0.0 };
            l.push(((chord * 0.2 + kick * 0.5 + hat) * 0.5) as f32);
            r.push(((chord * 0.2 * (1.0 + 0.5 * (t * 0.7).sin()) + kick * 0.5 - hat) * 0.5) as f32);
        }
        let corr = pearson(&l, &r);
        let mono = l.iter().zip(&r).map(|(a, b)| 0.5 * (a + b)).collect();
        Excerpt { sample_rate: rate, channels: 2, mono, stereo_correlation: Some(corr) }
    }

    fn synth_speech(rate: u32, secs: f64) -> Excerpt {
        // Harmonic bursts at ~4 Hz with pauses, band-limited, mono.
        let n = (rate as f64 * secs) as usize;
        let mut x = Vec::with_capacity(n);
        let mut seed = 7u32;
        for i in 0..n {
            let t = i as f64 / rate as f64;
            let syl = (t * 4.3) % 1.0;
            let in_word = ((t / 1.7) % 1.0) < 0.6;
            let env = if in_word && syl < 0.55 { (std::f64::consts::PI * syl / 0.55).sin() } else { 0.0 };
            let f0 = 120.0 + 30.0 * (t * 2.0).sin();
            let mut v = 0.0;
            for h in 1..12 {
                v += (2.0 * std::f64::consts::PI * f0 * h as f64 * t).sin() / h as f64;
            }
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = ((seed >> 8) as f64 / u32::MAX as f64 * 2.0 - 1.0) * 0.1;
            x.push((env * (v * 0.3 + noise)) as f32);
        }
        Excerpt { sample_rate: rate, channels: 1, mono: x, stereo_correlation: None }
    }

    #[test]
    fn synthetic_music_scores_low() {
        let ex = synth_music(44100, 20.0);
        let f = extract_features(&ex);
        let h = Hints { format: "mp3".into(), sample_rate: Some(44100), channels: Some(2), has_tags: true, has_artist: true, duration_secs: 200.0, folder_hint: -0.5, file_name: "01 - song.mp3".into() };
        let (p, _) = score(Some(&f), &h, &Weights::default());
        assert!(p < 0.3, "music probability of voice was {p}, features {f:?}");
        assert!(f.beat_strength > f.syllable_modulation * 0.5 || f.high_band_ratio > 0.05);
    }

    #[test]
    fn synthetic_speech_scores_high() {
        let ex = synth_speech(16000, 20.0);
        let f = extract_features(&ex);
        let h = Hints { format: "m4a".into(), sample_rate: Some(16000), channels: Some(1), has_tags: false, has_artist: false, duration_secs: 90.0, folder_hint: 0.5, file_name: "rec 2026-10-14 09.12.m4a".into() };
        let (p, why) = score(Some(&f), &h, &Weights::default());
        assert!(p > 0.7, "speech probability of voice was {p}, features {f:?} why {why:?}");
    }

    #[test]
    fn signal_alone_separates_the_two() {
        // Same neutral hints for both: only the audio differs.
        let h = Hints { format: "wav".into(), sample_rate: Some(44100), channels: Some(2), has_tags: false, has_artist: false, duration_secs: 60.0, folder_hint: 0.0, file_name: "x.wav".into() };
        let (pm, _) = score(Some(&extract_features(&synth_music(44100, 20.0))), &h, &Weights::default());
        let mut sp = synth_speech(44100, 20.0);
        sp.channels = 2;
        sp.stereo_correlation = Some(1.0);
        let (ps, _) = score(Some(&extract_features(&sp)), &h, &Weights::default());
        assert!(ps > pm + 0.3, "speech {ps} vs music {pm}");
    }

    #[test]
    fn recorder_file_names_are_recognised() {
        assert!(name_looks_recorded("ptt-20261009-wa0012.opus"));
        assert!(name_looks_recorded("20261014_091233.m4a"));
        assert!(name_looks_recorded("voice 003.m4a"));
        assert!(!name_looks_recorded("01 - instant crush.flac"));
    }

    #[test]
    fn unsure_when_confidence_is_low() {
        let c = finish(0.55, vec![], 0.75, false);
        assert_eq!(c.kind, Kind::Unsure);
        let c = finish(0.95, vec![], 0.75, false);
        assert_eq!(c.kind, Kind::Voice);
    }
}
