//! Exercise the YouTube path on the desktop without the app:
//!   cargo run -p offline_core --example yt -- search "power kanye west"
//!   cargo run -p offline_core --example yt -- search "power kanye west" --repeat 3   (shows the cached client speed)
//!   cargo run -p offline_core --example yt -- download k8JflBNovLE /tmp/out-dir

use std::path::PathBuf;

use offline_core::youtube::{self, YtTrack};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, query, rest @ ..] if cmd == "search" => {
            let repeat: usize = match rest {
                [flag, n] if flag == "--repeat" => n.parse()?,
                [] => 1,
                _ => anyhow::bail!("usage: yt search <query> [--repeat N]"),
            };
            for i in 0..repeat {
                let t = std::time::Instant::now();
                let hits = youtube::search(query, 10).await?;
                println!("{} results in {:.2}s ({})", hits.len(), t.elapsed().as_secs_f64(), if i == 0 { "cold: builds client + token" } else { "cached client" });
                if i == 0 {
                    for h in hits {
                        println!("  {} | {} | {} | {} | {}s", h.video_id, h.title, h.artist, h.album.unwrap_or_default(), h.duration_secs.unwrap_or(0.0));
                    }
                }
            }
        }
        [cmd, id, dir] if cmd == "download" => {
            let data_dir = PathBuf::from(dir);
            let bin = youtube::ytdlp::ensure_binary(&data_dir).await?;
            println!("yt-dlp: {} ({})", bin.display(), youtube::ytdlp::version(&bin).await?);
            let track = youtube::search(id, 5).await?.into_iter().find(|t| t.video_id == *id).unwrap_or(YtTrack { video_id: id.clone(), title: id.clone(), artist: "Unknown".into(), album: None, duration_secs: None, thumbnail: None, explicit: false, local_track_id: None });
            let jobs = youtube::ytdlp::Jobs::default();
            let t = std::time::Instant::now();
            let done = std::sync::Arc::new(tokio::sync::Notify::new());
            let d2 = done.clone();
            let _id = jobs.start(bin, track, None, &data_dir, std::sync::Arc::new(move |path: PathBuf, track: YtTrack| {
                let _ = offline_core::tags::write_basic(&path, &track.title, Some(&track.artist), track.album.as_deref());
                let meta = offline_core::tags::read(&path);
                println!("done: {} → tags now title={:?} artist={:?} album={:?} {:.0}s", path.display(), meta.title, meta.artist, meta.album, meta.duration_secs);
                d2.notify_one();
            }));
            loop {
                tokio::select! {
                    _ = done.notified() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                        for d in jobs.list() { println!("  {:>3.0}%  {}  {:?}", d.progress * 100.0, d.name, d.state); if d.state == offline_core::models::DownloadState::Error { println!("  error: {:?}", d.error); return Ok(()); } }
                    }
                }
            }
            println!("took {:.1}s", t.elapsed().as_secs_f64());
        }
        _ => eprintln!("usage: yt search <query> [--repeat N] | yt download <video id> <dir>"),
    }
    Ok(())
}
