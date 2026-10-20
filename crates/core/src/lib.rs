//! Platform-independent core of the offline player.
pub mod models;
pub mod db;
pub mod tags;
pub mod classifier;
pub mod scanner;
pub mod paths;
pub mod util;
pub mod youtube;
pub mod sources;
pub mod update;

pub use models::*;

/// Random id for new rows. Centralised so the shell crate does not need `uuid`.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
