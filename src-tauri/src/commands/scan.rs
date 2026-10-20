//! Device scanning and folder rules. Progress is emitted as the `scan://progress` event.

use std::sync::atomic::Ordering;

use offline_core::models::{FolderRule, RuleKind, ScanConfig, ScanReport};
use offline_core::scanner;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{err, AppState, CmdResult};

pub const PROGRESS_EVENT: &str = "scan://progress";

#[tauri::command]
pub fn get_scan_config(state: State<'_, AppState>) -> CmdResult<ScanConfig> {
    scanner::load_config(&state.db).map_err(err)
}

#[tauri::command]
pub fn list_folder_rules(state: State<'_, AppState>) -> CmdResult<Vec<FolderRule>> {
    state.db.list_rules().map_err(err)
}

/// `rule`: "include" | "exclude" | "app".
#[tauri::command]
pub fn add_folder_rule(state: State<'_, AppState>, path: String, rule: String) -> CmdResult<Vec<FolderRule>> {
    state.db.add_rule(&path, RuleKind::parse(&rule)).map_err(err)?;
    state.db.list_rules().map_err(err)
}

#[tauri::command]
pub fn remove_folder_rule(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<FolderRule>> {
    state.db.remove_rule(id).map_err(err)?;
    state.db.list_rules().map_err(err)
}

#[tauri::command]
pub fn set_folder_rule_enabled(state: State<'_, AppState>, id: i64, enabled: bool) -> CmdResult<()> {
    state.db.set_rule_enabled(id, enabled).map_err(err)
}

/// Seeds sensible defaults on first run (platform music folders, common excludes).
pub fn seed_defaults(db: &offline_core::db::Db) {
    if db.get_setting("seeded").ok().flatten().is_some() {
        return;
    }
    for p in offline_core::paths::default_include_folders() {
        if std::path::Path::new(&p).exists() {
            let _ = db.add_rule(&p, RuleKind::Include);
        }
    }
    for p in offline_core::paths::DEFAULT_EXCLUDE_PATTERNS {
        let _ = db.add_rule(p, RuleKind::Exclude);
    }
    let _ = db.set_setting("seeded", "1");
}

/// Starts a scan on a worker thread. Returns immediately; watch the progress event.
#[tauri::command]
pub fn start_scan(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".into());
    }
    state.scan_cancel.store(false, Ordering::SeqCst);
    let cfg = scanner::load_config(&state.db).map_err(err)?;
    let db = state.db.clone();
    let cancel = state.scan_cancel.clone();
    std::thread::Builder::new()
        .name("scanner".into())
        .spawn(move || {
            let app2 = app.clone();
            let result = scanner::scan(&db, &cfg, cancel, |r| {
                let _ = app2.emit(PROGRESS_EVENT, r);
            });
            if let Err(e) = result {
                tracing::error!("scan failed: {e:#}");
                let _ = app.emit(PROGRESS_EVENT, ScanReport { finished: true, current_path: format!("Error: {e:#}"), ..Default::default() });
            }
            if let Some(s) = app.try_state::<AppState>() {
                s.scanning.store(false, Ordering::SeqCst);
            }
        })
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) -> CmdResult<()> {
    state.scan_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn is_scanning(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(state.scanning.load(Ordering::SeqCst))
}

/// Last completed scan as (unix timestamp, report).
#[tauri::command]
pub fn last_scan(state: State<'_, AppState>) -> CmdResult<Option<(i64, ScanReport)>> {
    state.db.last_scan().map_err(err)
}

/// Re-runs the classifier on one track (after the user changes classifier settings).
#[tauri::command]
pub fn reclassify_track(state: State<'_, AppState>, id: String) -> CmdResult<Option<offline_core::models::Track>> {
    let Some(track) = state.db.get_track(&id).map_err(err)? else { return Ok(None) };
    let cfg = scanner::load_config(&state.db).map_err(err)?;
    // Not-downloaded YouTube rows have no file to classify.
    let Some(p) = track.path.clone() else { return Ok(Some(track)) };
    let path = std::path::Path::new(&p);
    let meta = offline_core::tags::read(path);
    let c = offline_core::classifier::classify_file(path, &meta, cfg.confidence_threshold, cfg.use_hints, &Default::default());
    let mut t = track;
    t.sample_rate = t.sample_rate.or(c.decoded_sample_rate);
    t.channels = t.channels.or(c.decoded_channels);
    t.kind = c.kind;
    t.confidence = c.confidence;
    t.reason = Some(c.reason);
    state.db.upsert_track(&t).map_err(err)?;
    state.db.get_track(&id).map_err(err)
}
