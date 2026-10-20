//! Over-the-air updates from GitHub Releases (D45).
//!
//! `update_check() → UpdateInfo` and `update_install() → "installing" | "needs_permission"`,
//! with progress on `update://progress { downloaded, total }`.
//!
//! - Desktop: Tauri's updater plugin. It reads `latest.json` from the latest release, checks
//!   the minisign signature against the public key in tauri.conf.json, installs, and
//!   restarts (on Windows the installer closes the app itself).
//! - Android: core's `update` module finds the release's `.apk` and downloads it into the
//!   cache, then the Kotlin `ApkInstallerPlugin` opens the system installer. The first time,
//!   Android asks the user to allow installs from Tarang; the command then answers
//!   "needs_permission" and the UI asks the user to tap Update again.

use offline_core::update::UpdateInfo;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::{err, CmdResult};

pub const PROGRESS_EVENT: &str = "update://progress";

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: u64,
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: u64) {
    let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(target_os = "android")]
pub use android::*;
#[cfg(not(target_os = "android"))]
pub use desktop::*;

#[cfg(not(target_os = "android"))]
mod desktop {
    use tauri_plugin_updater::UpdaterExt;

    use super::*;

    fn info_from(current: String, u: Option<&tauri_plugin_updater::Update>) -> UpdateInfo {
        match u {
            Some(u) => UpdateInfo {
                available: true,
                current,
                version: u.version.clone(),
                notes: u.body.clone().unwrap_or_default(),
                published_at: u.date.map(|d| d.to_string()),
                page_url: format!("https://github.com/{}/releases/tag/v{}", offline_core::update::REPO, u.version),
                asset_url: None,
                asset_size: 0,
            },
            None => UpdateInfo { version: current.clone(), current, ..Default::default() },
        }
    }

    #[tauri::command]
    pub async fn update_check(app: AppHandle) -> CmdResult<UpdateInfo> {
        let update = app.updater().map_err(err)?.check().await.map_err(err)?;
        Ok(info_from(current_version(&app), update.as_ref()))
    }

    #[tauri::command]
    pub async fn update_install(app: AppHandle) -> CmdResult<String> {
        let update = app.updater().map_err(err)?.check().await.map_err(err)?
            .ok_or_else(|| "Tarang is already up to date".to_string())?;
        let mut downloaded = 0u64;
        let handle = app.clone();
        update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    emit_progress(&handle, downloaded, total.unwrap_or(0));
                },
                || {},
            )
            .await
            .map_err(err)?;
        // Windows: the installer has already taken over. Elsewhere: start the new version.
        app.restart();
    }
}

#[cfg(target_os = "android")]
mod android {
    use serde_json::{json, Value};
    use tauri::plugin::{PluginHandle, TauriPlugin};
    use tauri::{Manager, State, Wry};

    use super::*;

    pub struct InstallerState(PluginHandle<Wry>);

    pub fn plugin() -> TauriPlugin<Wry> {
        tauri::plugin::Builder::new("apkinstaller")
            .setup(|app, api| {
                let handle = api.register_android_plugin("dev.yashwanth.offlineplayer", "ApkInstallerPlugin")?;
                app.manage(InstallerState(handle));
                Ok(())
            })
            .build()
    }

    #[tauri::command]
    pub async fn update_check(app: AppHandle) -> CmdResult<UpdateInfo> {
        offline_core::update::check(&current_version(&app), true).await.map_err(err)
    }

    #[tauri::command]
    pub async fn update_install(app: AppHandle, installer: State<'_, InstallerState>) -> CmdResult<String> {
        let info = offline_core::update::check(&current_version(&app), true).await.map_err(err)?;
        if !info.available {
            return Err("Tarang is already up to date".into());
        }
        let url = info.asset_url.clone().ok_or("This release has no Android app")?;
        let dir = app.path().app_cache_dir().map_err(err)?.join("updates");
        let handle = app.clone();
        let path = offline_core::update::download(&url, &dir, &format!("tarang-{}.apk", info.version), move |d, t| {
            emit_progress(&handle, d, t)
        })
        .await
        .map_err(err)?;
        let res: Value = installer.0
            .run_mobile_plugin("install", json!({ "path": path.to_string_lossy() }))
            .map_err(err)?;
        Ok(res.get("status").and_then(Value::as_str).unwrap_or("installing").to_string())
    }
}
