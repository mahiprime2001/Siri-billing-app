//! Shadow mode for the Rust offline database.
//!
//! Flask is still the system that answers the cashier. This module only keeps a
//! mirror of Flask's product file in `rust-offline.db` and, when the cashier screen
//! reports a barcode scan plus the product Flask found, looks the same barcode up in
//! Rust and writes whether the two agree to the store log (category `shadow`).
//! Nothing here can change what the cashier sees or what gets billed.
//!
//! After a few days of real scans the log shows how often Rust agrees with Flask --
//! the evidence for making Rust the main offline mode.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::offline_db::OfflineDb;
use crate::store_log;

const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

static DB: OnceLock<OfflineDb> = OnceLock::new();
static LAST_REFRESH_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Match,
    Mismatch,
    RustMiss,
    FlaskMiss,
    BothMiss,
}

/// Compares the product ids Rust and Flask found for the same scan.
pub fn classify(rust: Option<&str>, flask: Option<&str>) -> Outcome {
    match (rust, flask) {
        (Some(r), Some(f)) if r == f => Outcome::Match,
        (Some(_), Some(_)) => Outcome::Mismatch,
        (None, Some(_)) => Outcome::RustMiss,
        (Some(_), None) => Outcome::FlaskMiss,
        (None, None) => Outcome::BothMiss,
    }
}

/// Opens the database and keeps it in step with Flask's products file. Never blocks startup.
pub fn start(app_data_dir: PathBuf) {
    // Flask runs as a sidecar next to this exe and keeps its data under `data/json`.
    let products_file = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("data").join("json").join("products.json")));

    thread::spawn(move || {
        let db_path = app_data_dir.join("rust-offline.db");
        let db = match OfflineDb::open(&db_path) {
            Ok(db) => db,
            Err(e) => {
                store_log::event("warn", "shadow", &format!("could not open rust-offline.db: {e}"));
                return;
            }
        };
        let _ = DB.set(db);
        let Some(products_file) = products_file else {
            store_log::event("warn", "shadow", "could not locate the Flask products file");
            return;
        };
        loop {
            refresh_once(&products_file);
            thread::sleep(REFRESH_INTERVAL);
        }
    });
}

fn refresh_once(products_file: &std::path::Path) {
    let Some(db) = DB.get() else { return };
    let started = Instant::now();
    match db.refresh_from_flask_file(products_file) {
        Ok(Some(n)) => {
            *LAST_REFRESH_ERROR.lock().unwrap() = None;
            store_log::event(
                "info",
                "shadow",
                &format!("mirror refreshed products={n} ms={}", started.elapsed().as_millis()),
            );
        }
        Ok(None) => {}
        Err(e) => {
            // The same error every minute would flood the log: say it once until it changes.
            let mut last = LAST_REFRESH_ERROR.lock().unwrap();
            if last.as_deref() != Some(e.as_str()) {
                store_log::event("warn", "shadow", &format!("mirror refresh failed: {e}"));
                *last = Some(e);
            }
        }
    }
}

/// Looks `barcode` up in Rust and logs how that compares with the product Flask found.
pub fn check_barcode(barcode: &str, flask_product_id: Option<&str>) {
    let Some(db) = DB.get() else {
        store_log::event("warn", "shadow", "barcode check skipped: mirror not ready yet");
        return;
    };
    let started = Instant::now();
    let found = match db.find_by_barcode(barcode) {
        Ok(found) => found,
        Err(e) => {
            store_log::event("warn", "shadow", &format!("barcode lookup error barcode={barcode}: {e}"));
            return;
        }
    };
    let micros = started.elapsed().as_micros();
    let rust_id = found.as_ref().map(|p| p.id.as_str());
    let flask = flask_product_id.filter(|s| !s.is_empty());
    let (level, text) = match classify(rust_id, flask) {
        Outcome::Match => ("info", format!("match barcode={barcode} product={} us={micros}", rust_id.unwrap_or(""))),
        Outcome::Mismatch => ("warn", format!("MISMATCH barcode={barcode} rust={} flask={}", rust_id.unwrap_or(""), flask.unwrap_or(""))),
        Outcome::RustMiss => ("warn", format!("rust-miss barcode={barcode} flask={}", flask.unwrap_or(""))),
        Outcome::FlaskMiss => ("warn", format!("flask-miss barcode={barcode} rust={}", rust_id.unwrap_or(""))),
        Outcome::BothMiss => ("info", format!("both-miss barcode={barcode}")),
    };
    store_log::event(level, "shadow", &text);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_covers_every_case() {
        assert_eq!(classify(Some("a"), Some("a")), Outcome::Match);
        assert_eq!(classify(Some("a"), Some("b")), Outcome::Mismatch);
        assert_eq!(classify(None, Some("b")), Outcome::RustMiss);
        assert_eq!(classify(Some("a"), None), Outcome::FlaskMiss);
        assert_eq!(classify(None, None), Outcome::BothMiss);
    }
}
