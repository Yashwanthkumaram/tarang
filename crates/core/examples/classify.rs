//! Classify audio files from the command line. Handy for tuning `Weights`.
//!
//! cargo run -p offline_core --example classify -- /path/to/file.mp3 [more files...]
//! cargo run -p offline_core --example classify -- --dir /path/to/folder

use std::path::{Path, PathBuf};

use offline_core::classifier::{self, Weights};
use offline_core::tags;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--dir" {
            let allowed: Vec<String> = offline_core::paths::DEFAULT_AUDIO_EXTENSIONS.iter().chain(offline_core::paths::VOICE_LEANING_EXTENSIONS).map(|s| s.to_string()).collect();
            for e in walkdir::WalkDir::new(&args[i + 1]).into_iter().flatten() {
                if e.file_type().is_file() && offline_core::paths::is_audio(e.path(), &allowed) {
                    files.push(e.path().to_path_buf());
                }
            }
            i += 2;
        } else {
            files.push(PathBuf::from(&args[i]));
            i += 1;
        }
    }
    if files.is_empty() {
        eprintln!("usage: classify <file>... | --dir <folder>");
        std::process::exit(2);
    }
    println!("{:<7} {:>5} {:>5}  {:<40} {}", "kind", "voice", "conf", "file", "reason");
    for f in files {
        classify_one(&f);
    }
}

fn classify_one(path: &Path) {
    if std::env::var("VERBOSE").is_ok() {
        match lofty::read_from_path(path) {
            Ok(_) => eprintln!("  tags: ok"),
            Err(e) => eprintln!("  tags: ERROR {e}"),
        }
        match classifier::decode_excerpt(path, classifier::SKIP_SECS, classifier::EXCERPT_SECS) {
            Ok(ex) => eprintln!("  decode: {} Hz, {} ch, {:.1} s, stereo corr {:?}\n  features: {:#?}", ex.sample_rate, ex.channels, ex.mono.len() as f64 / ex.sample_rate as f64, ex.stereo_correlation, classifier::extract_features(&ex)),
            Err(e) => eprintln!("  decode: ERROR {e:#}"),
        }
    }
    let meta = tags::read(path);
    if std::env::var("VERBOSE").is_ok() {
        eprintln!("  meta: title={:?} artist={:?} dur={:.1}s rate={:?} ch={:?} tags={}", meta.title, meta.artist, meta.duration_secs, meta.sample_rate, meta.channels, meta.has_tags);
    }
    let started = std::time::Instant::now();
    let c = classifier::classify_file(path, &meta, 0.5, true, &Weights::default());
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    println!(
        "{:<7} {:>4.0}% {:>4.0}%  {:<40} {}  ({} ms)",
        c.kind.as_str(),
        c.voice_probability * 100.0,
        c.confidence * 100.0,
        if name.chars().count() > 40 { format!("{}…", name.chars().take(39).collect::<String>()) } else { name },
        c.reason,
        started.elapsed().as_millis()
    );
}
