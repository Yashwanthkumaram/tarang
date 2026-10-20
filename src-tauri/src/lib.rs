//! Tauri shell: wires the core crate to the webview. Keep logic out of here;
//! it belongs in `crates/core` (platform-independent) or `commands/` (thin glue).

mod commands;
mod state;

use tauri::Manager;
#[cfg(desktop)]
use tauri::Emitter;

use commands::{downloads, imports, library, playback, playlists, scan, settings, updater, youtube};
use state::AppState;

/// Android: registers the Kotlin `YtdlpPlugin` and keeps its handle in managed state.
#[cfg(target_os = "android")]
fn ytdlp_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("ytdlp")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.yashwanth.offlineplayer", "YtdlpPlugin")?;
            app.manage(youtube::YtState { plugin: handle, pending: Default::default(), indexed: Default::default() });
            Ok(())
        })
        .build()
}

/// Emitted to the UI to open the quick-search palette.
pub const QUICK_SEARCH_EVENT: &str = "ui://quick-search";

#[cfg(desktop)]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("offline_core=info".parse().unwrap())).init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Desktop: one running instance. A second launch (e.g. the Super+Space keybind running
    // `tarang --quick-search`) focuses the existing window and opens quick search.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        focus_main_window(app);
        if args.iter().any(|a| a == "--quick-search") {
            let _ = app.emit(QUICK_SEARCH_EVENT, ());
        }
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(ytdlp_plugin()).plugin(playback::plugin()).plugin(updater::plugin());
    #[cfg(not(target_os = "android"))]
    let builder = builder.manage(youtube::YtState::default());

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let state = AppState::new(data_dir)?;
            scan::seed_defaults(&state.db);
            app.manage(state);

            // First launch with --quick-search: open the palette once the UI is ready.
            #[cfg(desktop)]
            if std::env::args().any(|a| a == "--quick-search") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                    let _ = handle.emit(QUICK_SEARCH_EVENT, ());
                });
            }

            // Build the YouTube Music client (TLS connection + visitor token) now so the
            // first search does not pay for it; harmless if offline.
            tauri::async_runtime::spawn(async {
                if let Err(e) = offline_core::youtube::warm_up().await {
                    tracing::info!("YouTube Music warm-up skipped: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::get_stats, library::list_tracks, library::get_track, library::list_recent,
            library::list_albums, library::list_artists, library::set_liked, library::like_youtube,
            library::record_play, library::set_track_kind,
            playlists::list_playlists, playlists::get_playlist, playlists::create_playlist,
            playlists::rename_playlist, playlists::delete_playlist, playlists::add_to_playlist,
            playlists::remove_from_playlist, playlists::reorder_playlist, playlists::download_playlist,
            downloads::list_downloads, downloads::pause_download, downloads::resume_download,
            downloads::remove_download, downloads::retry_download, downloads::clear_finished_downloads,
            downloads::storage_info,
            imports::import_preview, imports::import_commit, imports::list_import_history,
            scan::get_scan_config, scan::list_folder_rules, scan::add_folder_rule, scan::remove_folder_rule,
            scan::set_folder_rule_enabled, scan::start_scan, scan::cancel_scan, scan::is_scanning,
            scan::last_scan, scan::reclassify_track,
            settings::get_settings, settings::set_setting, settings::get_platform, settings::list_dirs,
            youtube::youtube_search, youtube::youtube_download, youtube::download_track,
            youtube::youtube_version, youtube::youtube_update, youtube::youtube_stream_url, youtube::youtube_prefetch,
            playback::playback_load, playback::playback_play, playback::playback_pause, playback::playback_stop,
            playback::playback_seek, playback::playback_set_rate, playback::playback_set_volume,
            playback::playback_set_queue_hints, playback::playback_set_metadata, playback::playback_set_liked,
            playback::playback_get_state, playback::playback_cache_size, playback::playback_clear_cache,
            playback::clear_stream_cache,
            updater::update_check, updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
