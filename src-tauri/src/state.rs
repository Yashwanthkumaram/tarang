//! Process-wide state shared by every command. Built once in `lib.rs`.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use offline_core::db::Db;

pub struct AppState {
    pub db: Arc<Db>,
    /// Where downloads and the SQLite file live when no app folder is set.
    pub data_dir: PathBuf,
    pub scan_cancel: Arc<AtomicBool>,
    pub scanning: AtomicBool,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Self> {
        let db = Db::open(&data_dir.join("library.sqlite"))?;
        Ok(AppState {
            db: Arc::new(db),
            data_dir,
            scan_cancel: Arc::new(AtomicBool::new(false)),
            scanning: AtomicBool::new(false),
        })
    }

    /// The folder downloads land in: the user's app folder, else `<data>/downloads`.
    pub fn download_dir(&self) -> PathBuf {
        match self.db.app_folder().ok().flatten() {
            Some(p) => PathBuf::from(p),
            None => self.data_dir.join("downloads"),
        }
    }
}

/// Error type returned to the frontend: a plain string so JS gets `err.message`-like text.
pub type CmdResult<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}
