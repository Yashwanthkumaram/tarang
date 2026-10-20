//! Over-the-air updates from GitHub Releases (D45).
//!
//! Desktop builds update through Tauri's signed updater (`latest.json` on the release).
//! Android cannot use that, so this module reads the latest release from the GitHub API,
//! picks its `.apk` asset and downloads it; the shell then hands the file to the system
//! installer. Android only installs it when it is signed with the same key as the
//! installed app, which is what keeps a tampered APK out.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

/// `owner/name` of the GitHub repository releases are published to.
pub const REPO: &str = "Yashwanthkumaram/tarang";

/// What the UI shows about the newest release.
#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub version: String,
    pub notes: String,
    pub published_at: Option<String>,
    /// Release page, for "What's new".
    pub page_url: String,
    /// Direct download of the asset this platform installs (Android: the `.apk`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_url: Option<String>,
    pub asset_size: u64,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("Tarang/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()?)
}

/// Parses "v1.2.3", "1.2" or "1.2.3-beta" into comparable numbers (pre-release suffix ignored).
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>());
    let major = parts.next()?.ok()?;
    let minor = parts.next().unwrap_or(Ok(0)).ok()?;
    let patch = parts.next().unwrap_or(Ok(0)).ok()?;
    Some((major, minor, patch))
}

/// True when `latest` is a higher version than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// The asset an Android phone installs: the universal or arm64 APK.
fn pick_apk(assets: &[Asset]) -> Option<&Asset> {
    let apks: Vec<&Asset> = assets.iter().filter(|a| a.name.to_ascii_lowercase().ends_with(".apk")).collect();
    apks.iter().copied()
        .find(|a| { let n = a.name.to_ascii_lowercase(); n.contains("universal") || n.contains("arm64") || n.contains("aarch64") })
        .or_else(|| apks.first().copied())
}

/// Reads the newest published release of [`REPO`] and compares it with `current`.
/// `want_apk`: also look up the APK asset (Android).
pub async fn check(current: &str, want_apk: bool) -> Result<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("could not reach GitHub")?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // No release published yet.
        return Ok(UpdateInfo { current: current.to_string(), version: current.to_string(), ..Default::default() });
    }
    let release: Release = resp.error_for_status().context("GitHub answered with an error")?.json().await?;
    if release.draft || release.prerelease {
        return Ok(UpdateInfo { current: current.to_string(), version: current.to_string(), ..Default::default() });
    }
    let version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let apk = if want_apk { pick_apk(&release.assets) } else { None };
    let mut available = is_newer(&version, current);
    if want_apk && apk.is_none() {
        available = false; // a release without an APK cannot update the phone
    }
    Ok(UpdateInfo {
        available,
        current: current.to_string(),
        notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        page_url: release.html_url,
        asset_url: apk.map(|a| a.browser_download_url.clone()),
        asset_size: apk.map(|a| a.size).unwrap_or(0),
        version,
    })
}

/// Downloads `url` to `<dir>/<file_name>`, reporting (downloaded, total) bytes.
/// Writes to a `.part` file first so a half-finished download is never installed.
pub async fn download(url: &str, dir: &Path, file_name: &str, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    // Older downloaded updates are useless once a newer one is fetched.
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let _ = tokio::fs::remove_file(e.path()).await;
        }
    }
    let resp = client()?.get(url).send().await.context("could not start the download")?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);
    let dest = dir.join(file_name);
    let part = dir.join(format!("{file_name}.part"));
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = resp.bytes_stream();
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("download interrupted")?;
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            progress(done, total);
            last = std::time::Instant::now();
        }
    }
    file.flush().await?;
    drop(file);
    if total > 0 && done != total {
        return Err(anyhow!("download incomplete ({done} of {total} bytes)"));
    }
    progress(done, total);
    tokio::fs::rename(&part, &dest).await?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("v0.10.0", "0.9.3"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(is_newer("0.2", "0.1.9"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("0.2.0-beta", "0.2.0"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn picks_the_universal_apk() {
        let a = |n: &str| Asset { name: n.into(), browser_download_url: format!("https://x/{n}"), size: 1 };
        let assets = vec![a("Tarang_0.2.0_x64-setup.exe"), a("tarang-0.2.0-x86.apk"), a("tarang-0.2.0-universal.apk")];
        assert_eq!(pick_apk(&assets).unwrap().name, "tarang-0.2.0-universal.apk");
        assert!(pick_apk(&[a("Tarang.AppImage")]).is_none());
    }
}
