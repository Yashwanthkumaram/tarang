//! Walks the configured folders, reads tags, classifies new files and keeps
//! the database in sync. Progress is reported through a callback so the UI
//! can show a live banner.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use walkdir::{DirEntry, WalkDir};

use crate::classifier::{self, Weights};
use crate::db::Db;
use crate::models::*;
use crate::paths;
use crate::tags;

/// Settings keys the scanner reads. Kept here so the UI uses the same names.
pub mod keys {
    pub const SCAN_MODE: &str = "scan.mode";
    pub const EXTENSIONS: &str = "scan.extensions";
    pub const MIN_DURATION: &str = "scan.min_duration_secs";
    pub const RESPECT_NOMEDIA: &str = "scan.respect_nomedia";
    pub const CLASSIFY: &str = "classifier.enabled";
    pub const THRESHOLD: &str = "classifier.threshold";
    pub const USE_HINTS: &str = "classifier.use_hints";
}

/// Builds a [`ScanConfig`] from stored settings and folder rules, filling in
/// defaults for anything unset.
pub fn load_config(db: &Db) -> Result<ScanConfig> {
    let get = |k: &str| db.get_setting(k).ok().flatten();
    let mode = get(keys::SCAN_MODE).map(|s| ScanMode::parse(&s)).unwrap_or(ScanMode::SelectedFolders);
    let extensions = get(keys::EXTENSIONS)
        .map(|s| s.split(',').map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty()).collect())
        .unwrap_or_else(|| paths::DEFAULT_AUDIO_EXTENSIONS.iter().map(|s| s.to_string()).collect());
    Ok(ScanConfig {
        mode,
        roots: paths::default_roots(),
        rules: db.list_rules()?,
        extensions,
        min_duration_secs: get(keys::MIN_DURATION).and_then(|s| s.parse().ok()).unwrap_or(2.0),
        respect_nomedia: get(keys::RESPECT_NOMEDIA).map(|s| s != "false").unwrap_or(true),
        classify: get(keys::CLASSIFY).map(|s| s != "false").unwrap_or(true),
        confidence_threshold: get(keys::THRESHOLD).and_then(|s| s.parse().ok()).unwrap_or(0.5),
        use_hints: get(keys::USE_HINTS).map(|s| s != "false").unwrap_or(true),
    })
}

/// The folders a scan will actually walk, after applying the scan mode.
pub fn resolve_roots(cfg: &ScanConfig) -> Vec<PathBuf> {
    let enabled = |k: RuleKind| cfg.rules.iter().filter(move |r| r.enabled && r.rule == k).map(|r| PathBuf::from(&r.path));
    match cfg.mode {
        ScanMode::WholeDevice => cfg.roots.iter().map(PathBuf::from).collect(),
        ScanMode::SelectedFolders => enabled(RuleKind::Include).chain(enabled(RuleKind::App)).collect(),
        ScanMode::AppFolderOnly => enabled(RuleKind::App).collect(),
    }
}

/// True when `path` is inside an enabled exclude rule (absolute prefix or
/// bare directory-name pattern) or carries a `.nomedia` marker.
fn is_excluded(entry: &DirEntry, cfg: &ScanConfig) -> bool {
    let path = entry.path();
    for rule in cfg.rules.iter().filter(|r| r.enabled && r.rule == RuleKind::Exclude) {
        if rule.path.starts_with('/') {
            if path.starts_with(&rule.path) {
                return true;
            }
        } else if entry.file_type().is_dir() && entry.file_name().to_string_lossy() == rule.path {
            return true;
        }
    }
    if entry.file_type().is_dir() && entry.depth() > 0 {
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') && name != "." {
            return true;
        }
        if cfg.respect_nomedia && path.join(".nomedia").exists() {
            return true;
        }
    }
    false
}

/// Runs a scan. `on_progress` is called every few files and once at the end
/// (with `finished == true`). `cancel` stops the walk at the next file.
pub fn scan(db: &Db, cfg: &ScanConfig, cancel: Arc<AtomicBool>, mut on_progress: impl FnMut(&ScanReport)) -> Result<ScanReport> {
    let started = Instant::now();
    let started_at = chrono::Utc::now().timestamp();
    let roots = resolve_roots(cfg);
    let root_strings: Vec<String> = roots.iter().map(|p| p.to_string_lossy().to_string()).collect();
    db.begin_scan(&root_strings)?;

    let mut report = ScanReport::default();
    let weights = Weights::default();
    let mut last_report = Instant::now();
    on_progress(&report);

    'roots: for root in &roots {
        if !root.exists() {
            tracing::warn!("scan root missing: {}", root.display());
            continue;
        }
        let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| !is_excluded(e, cfg));
        for entry in walker {
            if cancel.load(Ordering::Relaxed) {
                break 'roots;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            report.files_seen += 1;
            let path = entry.path();
            // Report on a timer so long walks through non-audio folders still show life.
            if last_report.elapsed().as_millis() >= 300 {
                last_report = Instant::now();
                report.current_path = path.to_string_lossy().to_string();
                report.elapsed_ms = started.elapsed().as_millis() as u64;
                on_progress(&report);
            }
            if !paths::is_audio(path, &cfg.extensions) {
                continue;
            }
            report.audio_found += 1;
            report.current_path = path.to_string_lossy().to_string();

            match index_file(db, path, cfg, &weights, &mut report) {
                Ok(()) => {}
                Err(e) => tracing::warn!("index {}: {e}", path.display()),
            }

        }
    }

    report.removed = db.finish_scan(&root_strings)?;
    report.finished = true;
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    db.record_scan(started_at, &report)?;
    on_progress(&report);
    Ok(report)
}

/// Indexes one audio file: skips unchanged ones, otherwise reads tags,
/// classifies (if enabled) and upserts.
fn index_file(db: &Db, path: &Path, cfg: &ScanConfig, weights: &Weights, report: &mut ScanReport) -> Result<()> {
    let md = std::fs::metadata(path)?;
    let size = md.len();
    let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();

    // Unchanged files are skipped, unless their properties could not be read last
    // time (duration 0): a newer parser may do better, so try again.
    if let Some((old_size, old_mtime, old_duration)) = db.track_stamp(&path_str)? {
        if old_size == size && old_mtime == mtime && old_duration > 0.0 {
            db.mark_seen(&path_str)?;
            return Ok(());
        }
    }

    let mut meta = tags::read(path);
    if meta.duration_secs > 0.0 && meta.duration_secs < cfg.min_duration_secs {
        report.skipped += 1;
        return Ok(());
    }

    let (kind, confidence, reason) = if cfg.classify {
        let c = classifier::classify_file(path, &meta, cfg.confidence_threshold, cfg.use_hints, weights);
        meta.sample_rate = meta.sample_rate.or(c.decoded_sample_rate);
        meta.channels = meta.channels.or(c.decoded_channels);
        (c.kind, c.confidence, Some(c.reason))
    } else {
        (Kind::Music, 0.0, None)
    };
    match kind {
        Kind::Music => report.music += 1,
        Kind::Voice => report.voice += 1,
        Kind::Unsure => report.unsure += 1,
    }

    let track = Track {
        id: uuid::Uuid::new_v4().to_string(),
        path: Some(path_str),
        video_id: None,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration_secs: meta.duration_secs,
        thumbnail: None,
        source: Source::Local,
        kind,
        confidence,
        reason,
        format: meta.format,
        sample_rate: meta.sample_rate,
        channels: meta.channels,
        bitrate_kbps: meta.bitrate_kbps,
        size_bytes: size,
        modified_at: mtime,
        added_at: 0,
        play_count: 0,
        last_played_at: None,
        liked: false,
        downloaded: true,
    };
    if db.upsert_track(&track)? {
        report.added += 1;
    } else {
        report.updated += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(rules: Vec<FolderRule>, mode: ScanMode) -> ScanConfig {
        ScanConfig {
            mode,
            roots: vec!["/".into()],
            rules,
            extensions: vec!["mp3".into(), "wav".into()],
            min_duration_secs: 0.0,
            respect_nomedia: true,
            classify: false,
            confidence_threshold: 0.5,
            use_hints: true,
        }
    }

    fn rule(id: i64, path: &str, rule: RuleKind) -> FolderRule {
        FolderRule { id, path: path.into(), rule, enabled: true }
    }

    #[test]
    fn roots_follow_scan_mode() {
        let rules = vec![rule(1, "/a", RuleKind::Include), rule(2, "/app", RuleKind::App), rule(3, "/x", RuleKind::Exclude)];
        assert_eq!(resolve_roots(&cfg(rules.clone(), ScanMode::AppFolderOnly)), vec![PathBuf::from("/app")]);
        assert_eq!(resolve_roots(&cfg(rules.clone(), ScanMode::SelectedFolders)).len(), 2);
        assert_eq!(resolve_roots(&cfg(rules, ScanMode::WholeDevice)), vec![PathBuf::from("/")]);
    }

    #[test]
    fn scan_finds_files_and_honours_excludes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("music/skip")).unwrap();
        std::fs::create_dir_all(root.join("music/node_modules")).unwrap();
        std::fs::create_dir_all(root.join("music/hidden")).unwrap();
        std::fs::write(root.join("music/a.mp3"), b"x").unwrap();
        std::fs::write(root.join("music/b.txt"), b"x").unwrap();
        std::fs::write(root.join("music/skip/c.mp3"), b"x").unwrap();
        std::fs::write(root.join("music/node_modules/d.mp3"), b"x").unwrap();
        std::fs::write(root.join("music/hidden/.nomedia"), b"").unwrap();
        std::fs::write(root.join("music/hidden/e.mp3"), b"x").unwrap();

        let db = Db::open_in_memory().unwrap();
        let rules = vec![
            rule(1, root.join("music").to_str().unwrap(), RuleKind::Include),
            rule(2, root.join("music/skip").to_str().unwrap(), RuleKind::Exclude),
            rule(3, "node_modules", RuleKind::Exclude),
        ];
        let c = cfg(rules, ScanMode::SelectedFolders);
        let report = scan(&db, &c, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        assert_eq!(report.audio_found, 1, "{report:?}");
        assert_eq!(report.added, 1);
        assert!(report.finished);

        // Second scan: unchanged file is neither added nor updated; deleted file is removed.
        std::fs::remove_file(root.join("music/a.mp3")).unwrap();
        let report = scan(&db, &c, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        assert_eq!(report.removed, 1);
        assert_eq!(db.stats().unwrap().music, 0);
    }
}
