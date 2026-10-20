//! Small helpers shared across modules: file names, URL encoding, disk usage.

use std::path::Path;

/// Keeps file names portable across Linux and Android (FAT-style limits).
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() { "download".into() } else { trimmed.chars().take(180).collect() }
}

/// Percent-encodes a query value.
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Total size of every regular file under `dir` (0 when it does not exist).
pub fn dir_size(dir: &Path) -> u64 {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// `(used, free)` bytes of the file system holding `path`. Walks up to the nearest
/// existing ancestor, so a download folder that does not exist yet still works.
/// `free` is what an unprivileged app can write (`f_bavail`).
#[cfg(unix)]
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let existing = path.ancestors().find(|p| p.exists())?;
    let c = CString::new(existing.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` is a properly sized out-parameter.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frsize = st.f_frsize as u64;
    let used = (st.f_blocks as u64).saturating_sub(st.f_bfree as u64) * frsize;
    Some((used, st.f_bavail as u64 * frsize))
}

#[cfg(not(unix))]
pub fn disk_space(_path: &Path) -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_sanitised() {
        assert_eq!(sanitize_file_name("AC/DC: Back?.flac"), "AC_DC_ Back_.flac");
        assert_eq!(sanitize_file_name("   "), "download");
    }

    #[test]
    fn urlencode_escapes_reserved() {
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn disk_space_of_missing_dir_uses_ancestor() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("f"), b"12345").unwrap();
        assert_eq!(dir_size(d.path()), 5);
        let (_, free) = disk_space(&d.path().join("not/yet/here")).unwrap();
        assert!(free > 0);
    }
}
