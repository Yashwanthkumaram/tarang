//! Path helpers shared by the scanner and the downloader.

use std::path::Path;

/// Extensions the scanner treats as audio by default. Order is cosmetic.
pub const DEFAULT_AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif", "mka",
];

/// Extensions that are almost always phone recordings. Off by default; the user
/// can switch them on from Scan & folders.
pub const VOICE_LEANING_EXTENSIONS: &[&str] = &["amr", "3ga", "awb", "m4r"];

/// Folder-name patterns excluded on every device unless the user removes them.
pub const DEFAULT_EXCLUDE_PATTERNS: &[&str] = &["node_modules", ".cache", ".git", ".Trash", "lost+found"];

/// Lowercase extension of a path, without the dot.
pub fn extension(path: &Path) -> Option<String> {
    path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase())
}

/// True when the file's extension is in `allowed` (already lowercase).
pub fn is_audio(path: &Path, allowed: &[String]) -> bool {
    match extension(path) {
        Some(ext) => allowed.iter().any(|a| *a == ext),
        None => false,
    }
}

/// Folder-name hints that push the classifier towards "voice".
pub const VOICE_FOLDER_HINTS: &[&str] = &[
    "recording", "recordings", "voice", "memo", "memos", "call", "calls", "callrec",
    "whatsapp audio", "ptt", "meeting", "meetings", "dictation", "notes",
];

/// Folder-name hints that push the classifier towards "music".
pub const MUSIC_FOLDER_HINTS: &[&str] = &["music", "songs", "album", "albums", "itunes", "flac", "mp3"];

/// Returns a hint score in -1.0..=1.0: positive means the path looks like a recording.
pub fn folder_hint(path: &Path) -> f64 {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let voice = VOICE_FOLDER_HINTS.iter().filter(|h| lower.contains(*h)).count() as f64;
    let music = MUSIC_FOLDER_HINTS.iter().filter(|h| lower.contains(*h)).count() as f64;
    ((voice - music) / 2.0).clamp(-1.0, 1.0)
}

/// Default scan roots per platform. Android's shared storage; a desktop home dir otherwise.
pub fn default_roots() -> Vec<String> {
    if cfg!(target_os = "android") {
        vec!["/storage/emulated/0".to_string()]
    } else {
        std::env::var("HOME").map(|h| vec![h]).unwrap_or_default()
    }
}

/// Default include folders a fresh install starts with.
pub fn default_include_folders() -> Vec<String> {
    if cfg!(target_os = "android") {
        vec![
            "/storage/emulated/0/Music".into(),
            "/storage/emulated/0/Download".into(),
            "/storage/emulated/0/Recordings".into(),
        ]
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![format!("{home}/Music"), format!("{home}/Downloads")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_detection_is_case_insensitive() {
        let allowed: Vec<String> = DEFAULT_AUDIO_EXTENSIONS.iter().map(|s| s.to_string()).collect();
        assert!(is_audio(Path::new("/a/b/Song.MP3"), &allowed));
        assert!(!is_audio(Path::new("/a/b/cover.jpg"), &allowed));
        assert!(!is_audio(Path::new("/a/b/noext"), &allowed));
    }

    #[test]
    fn folder_hints_lean_the_right_way() {
        assert!(folder_hint(Path::new("/sdcard/Recordings/Voice/rec.m4a")) > 0.0);
        assert!(folder_hint(Path::new("/home/me/Music/Album/track.flac")) < 0.0);
    }
}
