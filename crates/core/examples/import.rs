//! Try the import pipeline on the desktop without the app:
//!   cargo run -p offline_core --example import -- https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa
//!   cargo run -p offline_core --example import -- "https://music.youtube.com/playlist?list=..."
//!   cargo run -p offline_core --example import -- https://soundcloud.com/forss/sets/soulhack
//!   cargo run -p offline_core --example import -- <url> --list-only     (skip matching)
//!   cargo run -p offline_core --example import -- <url> --commit /tmp/x.sqlite   (write the playlist)
//!
//! The platform is detected from the link. YouTube and SoundCloud need `yt-dlp` on PATH
//! (or in ./data/bin).

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use anyhow::{anyhow, bail};
use offline_core::sources::{self, MatchStatus, Platform};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(url) = args.first() else { bail!("usage: import <url> [--list-only] [--commit <db.sqlite>]") };
    let list_only = args.iter().any(|a| a == "--list-only");
    let commit_db = args.iter().position(|a| a == "--commit").and_then(|i| args.get(i + 1));
    let platform = Platform::detect(url).ok_or_else(|| anyhow!("unknown platform for {url}"))?;

    let t = Instant::now();
    let list = match platform {
        Platform::Spotify => sources::spotify::fetch(url).await?,
        p => {
            let bin = offline_core::youtube::ytdlp::find_binary(Path::new("data")).ok_or_else(|| anyhow!("yt-dlp not found"))?;
            sources::ytdlp_playlist::list(&bin, p, url, |d, n| eprint!("\rlisting {d}/{n}")).await?
        }
    };
    eprintln!();
    println!("{} \"{}\": {} songs, listed in {:.1}s", platform.label(), list.name, list.items.len(), t.elapsed().as_secs_f64());
    if let Some(n) = &list.note {
        println!("note: {n}");
    }
    if list_only {
        for (i, it) in list.items.iter().enumerate() {
            println!("{:3}. {} — {} ({:?}s)", i + 1, it.title, it.artist, it.duration_secs);
        }
        return Ok(());
    }

    let t = Instant::now();
    let preview = sources::preview(offline_core::new_id(), list, |d, n| eprint!("\rmatching {d}/{n}")).await?;
    eprintln!();
    for (i, it) in preview.items.iter().enumerate() {
        let tag = match it.status {
            MatchStatus::Matched => "OK    ",
            MatchStatus::Review => "REVIEW",
            MatchStatus::NotFound => "NONE  ",
        };
        let m = it.matched.as_ref().map(|m| format!("{} — {} ({:?}s) [{}]", m.title, m.artist, m.duration_secs, m.video_id)).unwrap_or_default();
        println!("{:3}. {tag} {} — {} ({:?}s)  =>  {m}", i + 1, it.title, it.artist, it.duration_secs);
        if it.status != MatchStatus::Matched {
            for a in &it.alternatives {
                println!("             alt: {} — {} ({:?}s)", a.title, a.artist, a.duration_secs);
            }
        }
    }
    println!(
        "matched {} · review {} · not found {} — {:.1}s",
        preview.count(MatchStatus::Matched),
        preview.count(MatchStatus::Review),
        preview.count(MatchStatus::NotFound),
        t.elapsed().as_secs_f64()
    );

    if let Some(db_path) = commit_db {
        let db = offline_core::db::Db::open(Path::new(db_path))?;
        let include: Vec<usize> = (0..preview.items.len()).collect();
        let p = sources::commit(&db, &preview, &preview.name, &include, &HashMap::new())?;
        println!("saved playlist {} \"{}\" with {} songs", p.id, p.name, p.track_count);
    }
    Ok(())
}
