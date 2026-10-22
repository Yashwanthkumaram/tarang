//! YouTube Music search (shared by every platform) and, on desktop, audio
//! downloads through `yt-dlp`. Android runs yt-dlp through the Kotlin plugin
//! in `src-tauri/gen/android/.../YtdlpPlugin.kt`; the shell picks the path.
//!
//! Search uses YouTube Music's song index rather than plain YouTube: results
//! are real songs with artist, album and duration, not lyric videos or AMVs.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use tokio::sync::Mutex;
use ytmapi_rs::auth::noauth::NoAuthToken;
use ytmapi_rs::builder::YtMusicBuilder;
use ytmapi_rs::common::YoutubeID;
use ytmapi_rs::YtMusic;

/// One song from YouTube Music search. Defined in `models` so the database can use it.
pub use crate::models::YtTrack;

/// "4:53" → 293.0; "1:02:03" → 3723.0
fn parse_duration(s: &str) -> Option<f64> {
    let parts: Vec<u64> = s.trim().split(':').map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    Some(parts.iter().fold(0u64, |acc, p| acc * 60 + p) as f64)
}

/// HTTP client for YouTube Music with bundled root certificates, so TLS works on
/// Android without the platform verifier (which needs JNI initialisation).
fn http_client() -> Result<ytmapi_rs::client::Client> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let client = reqwest13::Client::builder()
        .use_preconfigured_tls(tls)
        .timeout(Duration::from_secs(20))
        // Keep the TLS connection alive between searches: on the phone a handshake
        // to YouTube costs 0.4-1.2 s, far more than the search itself.
        .pool_idle_timeout(Duration::from_secs(120))
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;
    Ok(ytmapi_rs::client::Client::new_from_reqwest_client(client))
}

/// The API handle (HTTP connection pool + unauthenticated visitor token), built once
/// and shared by every search. Building it costs a full page fetch of music.youtube.com,
/// so a fresh one per search doubled the time (1.1 s on desktop, 5 s on the phone).
struct Cached {
    yt: Arc<YtMusic<NoAuthToken>>,
    built: Instant,
}

/// Tokens are re-fetched after this long; the client version ytmapi derives from the
/// token's creation date would otherwise drift.
const TOKEN_TTL: Duration = Duration::from_secs(6 * 60 * 60);

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Returns the shared client, building it on first use or after it expired.
async fn client() -> Result<Arc<YtMusic<NoAuthToken>>> {
    let mut guard = cache().lock().await;
    if let Some(c) = guard.as_ref().filter(|c| c.built.elapsed() < TOKEN_TTL) {
        return Ok(c.yt.clone());
    }
    let yt = YtMusicBuilder::new_with_client(http_client()?).build().await.map_err(|e| anyhow!("YouTube Music: {e}"))?;
    let yt = Arc::new(yt);
    *guard = Some(Cached { yt: yt.clone(), built: Instant::now() });
    Ok(yt)
}

/// Drops the cached client so the next call fetches a new token.
async fn invalidate() {
    *cache().lock().await = None;
}

/// Builds the shared client ahead of time (call once at app start, in the
/// background) so the first search pays only one request.
pub async fn warm_up() -> Result<()> {
    client().await.map(|_| ())
}

/// Searches YouTube Music for songs. No account or API key needed.
///
/// A failed request is retried once on the same client (a pooled connection the
/// phone's network silently dropped just gets reopened), then once more with a fresh
/// token in case YouTube rejected the cached one.
pub async fn search(query: &str, limit: usize) -> Result<Vec<YtTrack>> {
    let yt = client().await?;
    let songs = match yt.search_songs(query).await {
        Ok(songs) => songs,
        Err(first) => {
            tracing::info!("YouTube Music search failed ({first}); retrying");
            match yt.search_songs(query).await {
                Ok(songs) => songs,
                Err(second) => {
                    tracing::info!("YouTube Music search failed again ({second}); refreshing client");
                    invalidate().await;
                    let yt = client().await?;
                    yt.search_songs(query).await.map_err(|e| anyhow!("YouTube Music search: {e}"))?
                }
            }
        }
    };
    Ok(songs
        .into_iter()
        .take(limit)
        .map(|s| YtTrack {
            video_id: s.video_id.get_raw().to_string(),
            title: s.title,
            artist: s.artist,
            album: s.album.map(|a| a.name),
            duration_secs: parse_duration(&s.duration),
            thumbnail: s.thumbnails.iter().max_by_key(|t| t.width).map(|t| t.url.clone()),
            explicit: matches!(s.explicit, ytmapi_rs::common::Explicit::IsExplicit),
            local_track_id: None,
        })
        .collect())
}

/// A `yt-dlp` command that opens no console window on Windows.
pub fn command(bin: &std::path::Path) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(bin);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// Desktop-only: drives the `yt-dlp` binary.
#[cfg(not(target_os = "android"))]
pub mod ytdlp {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use anyhow::{anyhow, Context, Result};
    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::YtTrack;
    use crate::models::{Download, DownloadKind, DownloadState};

    /// The standalone build for this OS (no Python needed) from yt-dlp's GitHub releases.
    #[cfg(windows)]
    const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    #[cfg(target_os = "macos")]
    const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    #[cfg(all(not(any(windows, target_os = "macos")), target_arch = "aarch64"))]
    const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64";
    #[cfg(all(not(any(windows, target_os = "macos")), not(target_arch = "aarch64")))]
    const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
    const BIN_NAME: &str = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };

    pub use super::command;

    /// A system `yt-dlp` on PATH, else the copy we downloaded into the app data dir.
    /// Normal `--extractor-args`: audio comes from the player response, so the HLS/DASH
    /// manifests (one request each, ~0.7 s) and translated subtitles are never fetched.
    /// `visionos` first: since Oct 2026 it is the only client whose audio links play without
    /// YouTube's anti-bot (PO) tokens; others, e.g. ANDROID, return links that answer 403 (D46).
    pub const EXTRACTOR_ARGS: &str = "youtube:player_client=visionos,default;skip=hls,dash,translated_subs";
    /// Used once YouTube has blocked this network's address (D41): the embedded-player
    /// client still gets stream URLs there; the default clients stay in the list for songs
    /// that cannot be embedded.
    pub const BLOCKED_EXTRACTOR_ARGS: &str = "youtube:player_client=visionos,web_embedded,default;skip=hls,dash,translated_subs";
    /// How long a detected block is remembered before the normal clients are tried again.
    const BLOCKED_TTL_SECS: u64 = 12 * 3600;
    static BLOCKED_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn now_secs() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    /// The `--extractor-args` value to use right now.
    pub fn extractor_args() -> &'static str {
        if BLOCKED_UNTIL.load(std::sync::atomic::Ordering::Relaxed) > now_secs() { BLOCKED_EXTRACTOR_ARGS } else { EXTRACTOR_ARGS }
    }

    /// True for YouTube's "this address is blocked" answers: the bot check, often after
    /// HTTP 429. Shared (CGNAT) IPv4 addresses get these while other clients still work.
    pub fn is_address_block(msg: &str) -> bool {
        msg.contains("not a bot") || msg.contains("HTTP Error 429")
    }

    /// Remembers that the fallback clients were needed (process-wide, [`BLOCKED_TTL_SECS`]).
    pub fn mark_blocked() {
        BLOCKED_UNTIL.store(now_secs() + BLOCKED_TTL_SECS, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn find_binary(data_dir: &Path) -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let p = dir.join(BIN_NAME);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        let local = data_dir.join("bin").join(BIN_NAME);
        local.is_file().then_some(local)
    }

    /// Downloads the standalone build for this OS when nothing is installed.
    pub async fn ensure_binary(data_dir: &Path) -> Result<PathBuf> {
        if let Some(p) = find_binary(data_dir) {
            return Ok(p);
        }
        let dir = data_dir.join("bin");
        tokio::fs::create_dir_all(&dir).await?;
        let dest = dir.join(BIN_NAME);
        let bytes = reqwest::get(RELEASE_URL).await?.error_for_status()?.bytes().await.context("download yt-dlp")?;
        tokio::fs::write(&dest, &bytes).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).await?;
        }
        Ok(dest)
    }

    pub async fn version(bin: &Path) -> Result<String> {
        let out = command(bin).arg("--version").output().await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// `yt-dlp -U`. Works for the standalone build; a distro-packaged binary
    /// refuses and the message says to use the package manager.
    pub async fn update(bin: &Path) -> Result<String> {
        let out = command(bin).arg("-U").output().await?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if out.status.success() {
            Ok(text.lines().last().unwrap_or("Updated").to_string())
        } else {
            Err(anyhow!(text.trim().to_string()))
        }
    }

    /// Called with the final file once a download succeeds (tag + index it).
    pub type OnDone = Arc<dyn Fn(PathBuf, YtTrack) + Send + Sync>;

    struct Job {
        track: YtTrack,
        track_id: Option<String>,
        dest_dir: PathBuf,
        bin: PathBuf,
        on_done: OnDone,
        downloaded: u64,
        total: u64,
        speed: u64,
        eta: Option<u64>,
        state: DownloadState,
        error: Option<String>,
        child_pid: Option<u32>,
        /// Bumped on every (re)start so a killed run cannot overwrite a newer one.
        generation: u64,
    }

    /// Runs and tracks yt-dlp downloads. Cheap to clone.
    ///
    /// Pause kills the yt-dlp process and keeps the `.part` file; resume and retry start
    /// yt-dlp again under the same id, which continues the partial file.
    #[derive(Clone, Default)]
    pub struct Jobs {
        inner: Arc<Mutex<HashMap<String, Job>>>,
    }

    impl Jobs {
        /// Starts a download and returns its id. `on_done(path, track)` runs after success.
        pub fn start(&self, bin: PathBuf, track: YtTrack, track_id: Option<String>, dest_dir: &Path, on_done: OnDone) -> String {
            let id = crate::new_id();
            let job = Job {
                track, track_id, dest_dir: dest_dir.to_path_buf(), bin, on_done,
                downloaded: 0, total: 0, speed: 0, eta: None, state: DownloadState::Queued,
                error: None, child_pid: None, generation: 0,
            };
            self.inner.lock().unwrap().insert(id.clone(), job);
            self.spawn(&id);
            id
        }

        /// Id of a queued, active or paused job for this video, if any.
        pub fn find_open(&self, video_id: &str) -> Option<String> {
            self.inner.lock().unwrap().iter()
                .find(|(_, j)| j.track.video_id == video_id && matches!(j.state, DownloadState::Queued | DownloadState::Active | DownloadState::Paused))
                .map(|(id, _)| id.clone())
        }

        /// (Re)runs yt-dlp for an existing job id.
        fn spawn(&self, id: &str) {
            let (bin, track, dest, on_done, generation) = {
                let mut guard = self.inner.lock().unwrap();
                let Some(j) = guard.get_mut(id) else { return };
                j.generation += 1;
                j.state = DownloadState::Queued;
                j.error = None;
                j.speed = 0;
                (j.bin.clone(), j.track.clone(), j.dest_dir.clone(), j.on_done.clone(), j.generation)
            };
            let jobs = self.inner.clone();
            let jid = id.to_string();
            tokio::spawn(async move {
                let mut progress = |done, total, speed, eta, pid| {
                    if let Some(j) = jobs.lock().unwrap().get_mut(&jid).filter(|j| j.generation == generation) {
                        j.downloaded = done;
                        j.total = total;
                        j.speed = speed;
                        j.eta = eta;
                        j.child_pid = pid;
                        if j.state != DownloadState::Paused {
                            j.state = DownloadState::Active;
                        }
                    }
                };
                let xargs = extractor_args();
                let mut result = run(&bin, &track, &dest, xargs, &mut progress).await;
                // Address blocked by YouTube: retry once with the fallback clients (D41),
                // unless the user paused the job meanwhile.
                let paused = || jobs.lock().unwrap().get(&jid).map(|j| j.state == DownloadState::Paused || j.generation != generation).unwrap_or(true);
                if xargs != BLOCKED_EXTRACTOR_ARGS && matches!(&result, Err(e) if is_address_block(&e.to_string())) && !paused() {
                    let retry = run(&bin, &track, &dest, BLOCKED_EXTRACTOR_ARGS, &mut progress).await;
                    if retry.is_ok() {
                        mark_blocked();
                        result = retry;
                    }
                }
                let mut guard = jobs.lock().unwrap();
                let Some(j) = guard.get_mut(&jid).filter(|j| j.generation == generation) else { return };
                j.child_pid = None;
                j.speed = 0;
                match result {
                    // A paused job was killed on purpose; keep it paused.
                    _ if j.state == DownloadState::Paused => {}
                    Ok(path) => {
                        j.state = DownloadState::Done;
                        j.downloaded = j.total.max(j.downloaded);
                        j.eta = None;
                        drop(guard);
                        on_done(path, track);
                    }
                    Err(e) => {
                        j.state = DownloadState::Error;
                        j.error = Some(e.to_string());
                    }
                }
            });
        }

        pub fn list(&self) -> Vec<Download> {
            self.inner
                .lock()
                .unwrap()
                .iter()
                .map(|(id, j)| Download {
                    id: id.clone(),
                    kind: DownloadKind::Youtube,
                    name: format!("{} - {}", j.track.artist, j.track.title),
                    state: j.state,
                    progress: if j.state == DownloadState::Done { 1.0 } else if j.total > 0 { (j.downloaded as f64 / j.total as f64).min(1.0) } else { 0.0 },
                    downloaded_bytes: j.downloaded,
                    total_bytes: j.total,
                    speed_bps: j.speed,
                    eta_secs: j.eta,
                    track_id: j.track_id.clone(),
                    error: j.error.clone(),
                })
                .collect()
        }

        /// True when this queue knows the id.
        pub fn contains(&self, id: &str) -> bool {
            self.inner.lock().unwrap().contains_key(id)
        }

        /// Stops a queued or active download, keeping the partial file.
        pub fn pause(&self, id: &str) -> Result<()> {
            let mut guard = self.inner.lock().unwrap();
            let j = guard.get_mut(id).ok_or_else(|| anyhow!("unknown download"))?;
            match j.state {
                DownloadState::Queued | DownloadState::Active => {
                    j.state = DownloadState::Paused;
                    j.speed = 0;
                    j.eta = None;
                    kill(j.child_pid.take());
                    Ok(())
                }
                DownloadState::Paused => Ok(()),
                _ => Err(anyhow!("only running downloads can be paused")),
            }
        }

        /// Restarts a paused or failed download (resume and retry are the same thing).
        pub fn resume(&self, id: &str) -> Result<()> {
            {
                let guard = self.inner.lock().unwrap();
                let j = guard.get(id).ok_or_else(|| anyhow!("unknown download"))?;
                if !matches!(j.state, DownloadState::Paused | DownloadState::Error) {
                    return Ok(());
                }
            }
            self.spawn(id);
            Ok(())
        }

        pub fn remove(&self, id: &str) {
            if let Some(j) = self.inner.lock().unwrap().remove(id) {
                kill(j.child_pid);
            }
        }

        /// Forgets every finished download. Returns how many were removed.
        pub fn clear_finished(&self) -> usize {
            let mut guard = self.inner.lock().unwrap();
            let before = guard.len();
            guard.retain(|_, j| j.state != DownloadState::Done);
            before - guard.len()
        }
    }

    fn kill(pid: Option<u32>) {
        #[cfg(unix)]
        if let Some(pid) = pid {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
        #[cfg(windows)]
        if let Some(pid) = pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000).status();
        }
        #[cfg(not(any(unix, windows)))]
        let _ = pid;
    }

    /// Runs yt-dlp for one track, reporting progress, and returns the final file path.
    async fn run(bin: &Path, track: &YtTrack, dest_dir: &Path, xargs: &str, mut progress: impl FnMut(u64, u64, u64, Option<u64>, Option<u32>)) -> Result<PathBuf> {
        tokio::fs::create_dir_all(dest_dir).await?;
        let template = dest_dir.join(format!("{}.%(ext)s", track.file_stem()));
        let mut child = command(bin)
            .args([
                "--no-playlist", "--no-mtime", "--no-warnings", "--newline", "--progress",
                // itag 140 is YouTube's standard 128 kbps AAC; naming it first skips format probing.
                "-f", "140/bestaudio[ext=m4a]/bestaudio",
                // See EXTRACTOR_ARGS / BLOCKED_EXTRACTOR_ARGS.
                "--extractor-args", xargs,
                "--progress-template", "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
                "--print", "after_move:FILE %(filepath)s",
                "-o",
            ])
            .arg(&template)
            .arg(track.url())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .with_context(|| format!("start {}", bin.display()))?;
        let pid = child.id();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let mut path: Option<PathBuf> = None;
        let started = Instant::now();
        while let Some(line) = lines.next_line().await? {
            if let Some(rest) = line.strip_prefix("PROGRESS ") {
                let f: Vec<&str> = rest.split_whitespace().collect();
                let num = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as u64;
                let total = if num(1) > 0 { num(1) } else { num(2) };
                let speed = if num(3) > 0 { num(3) } else { (num(0) as f64 / started.elapsed().as_secs_f64().max(0.1)) as u64 };
                progress(num(0), total, speed, f.get(4).and_then(|s| s.parse().ok()), pid);
            } else if let Some(p) = line.strip_prefix("FILE ") {
                path = Some(PathBuf::from(p.trim()));
            }
        }
        let status = child.wait().await?;
        if !status.success() {
            let mut err = String::new();
            let _ = tokio::io::AsyncReadExt::read_to_string(&mut BufReader::new(stderr), &mut err).await;
            let last = err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("yt-dlp failed");
            return Err(anyhow!(last.trim_start_matches("ERROR: ").to_string()));
        }
        // yt-dlp sometimes prints the path without its extension; resolve by stem.
        if let Some(p) = path.as_ref().filter(|p| p.is_file()) {
            return Ok(p.clone());
        }
        let stem = track.file_stem();
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        for entry in std::fs::read_dir(dest_dir)?.flatten() {
            let p = entry.path();
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with(&stem) && !name.ends_with(".part") && !name.ends_with(".ytdl") && p.is_file() {
                let t = entry.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                if newest.as_ref().map(|(nt, _)| t > *nt).unwrap_or(true) {
                    newest = Some((t, p));
                }
            }
        }
        newest.map(|(_, p)| p).ok_or_else(|| anyhow!("yt-dlp finished but no file was found"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_block_detection() {
        assert!(ytdlp::is_address_block("ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies"));
        assert!(ytdlp::is_address_block("Unable to download webpage: HTTP Error 429: Too Many Requests"));
        assert!(!ytdlp::is_address_block("ERROR: [youtube] x: Video unavailable"));
        assert_eq!(ytdlp::extractor_args(), ytdlp::EXTRACTOR_ARGS);
    }

    #[test]
    fn durations_parse() {
        assert_eq!(parse_duration("4:53"), Some(293.0));
        assert_eq!(parse_duration("1:02:03"), Some(3723.0));
        assert_eq!(parse_duration("abc"), None);
    }

    #[test]
    fn file_stem_is_safe() {
        let t = YtTrack { video_id: "x".into(), title: "A/B: C?".into(), artist: "Kanye West".into(), album: None, duration_secs: None, thumbnail: None, explicit: false, local_track_id: None };
        assert_eq!(t.file_stem(), "Kanye West - A_B_ C_");
    }
}
