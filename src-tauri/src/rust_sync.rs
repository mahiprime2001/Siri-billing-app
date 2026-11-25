//! Rust offline mode, piece 2: keep Rust's own database (rust-offline.db) filled from siri-api.
//!
//! Every 5 minutes (and soon after start) the store's records are copied from siri-api's store-scoped copy
//! (`GET /api/store/sync/<Table>?since=...`, the same route the Python side uses with the `sync` switch) into the
//! `records` table, products also into the `products` table (barcode lookup), and `OfflineLogins` (a scrambled
//! copy of every cashier's password, never the password) into `offline_logins`.
//!
//! Until piece 6 gives Rust its own siri-api login, it borrows the one the Python side keeps in
//! `data/siri_session.json` (read-only, like every other Python file Rust looks at). No login there yet, or the
//! token refused: the cycle is skipped and tried again next time. Runs only with the front door on (`rust_front`).

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::offline_db::OfflineDb;
use crate::{shadow, store_log};

const API_BASE: &str = "https://api.ifleon.com";
const INTERVAL: Duration = Duration::from_secs(300);
const FIRST_DELAY: Duration = Duration::from_secs(20);

/// What is copied, in this order. Products and OfflineLogins also fill their own tables.
pub const TABLES: &[&str] = &[
    "OfflineLogins", "Users", "UserStores", "Stores", "SystemSettings", "Customers", "Products", "Returns",
    "Store_Damage_Returns", "Bills",
];

pub fn start(python_data_dir: PathBuf) {
    thread::spawn(move || {
        thread::sleep(FIRST_DELAY);
        loop {
            if let Some(db) = shadow::database() {
                run_once(db, &python_data_dir, API_BASE);
            }
            thread::sleep(INTERVAL);
        }
    });
}

/// The siri-api token the Python side holds (`None` when nobody has logged in online yet).
pub fn borrowed_token(python_data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(python_data_dir.join("siri_session.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
}

/// One copy cycle. Returns how many rows were written per table (for the log and the tests).
pub fn run_once(db: &OfflineDb, python_data_dir: &Path, api_base: &str) -> Vec<(String, usize)> {
    let Some(token) = borrowed_token(python_data_dir) else {
        return Vec::new();
    };
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let started = Instant::now();
    let mut written = Vec::new();
    let mut failed = Vec::new();
    for table in TABLES {
        let since_key = format!("sync_since:{table}");
        let since = db.get_meta(&since_key).ok().flatten();
        let mut req = client.get(format!("{api_base}/api/store/sync/{table}")).bearer_auth(&token);
        if let Some(s) = &since {
            req = req.query(&[("since", s.as_str())]);
        }
        let body: Option<Value> = match req.send() {
            Ok(r) if r.status().is_success() => r.json().ok(),
            Ok(r) if r.status().as_u16() == 401 => {
                // the borrowed login is no longer accepted: wait for the Python side to log in again
                store_log::event("info", "rustdb", "siri-api login not accepted; copy skipped until the next login");
                return written;
            }
            _ => None,
        };
        let Some(body) = body else {
            failed.push(table.to_string());
            continue;
        };
        let rows: Vec<Value> = body.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let stamp = body.get("sync_timestamp").and_then(Value::as_str).unwrap_or("").to_string();
        let result = match *table {
            "OfflineLogins" => db.upsert_offline_logins(&rows),
            "Products" => db.upsert_products(&rows).and_then(|_| db.upsert_records(table, &rows, &stamp)),
            _ => db.upsert_records(table, &rows, &stamp),
        };
        match result {
            Ok(n) => {
                if !stamp.is_empty() {
                    let _ = db.set_meta(&since_key, &stamp);
                }
                written.push((table.to_string(), n));
            }
            Err(e) => {
                store_log::event("warn", "rustdb", &format!("could not store {table}: {e}"));
                failed.push(table.to_string());
            }
        }
    }
    let changed: Vec<String> = written.iter().filter(|(_, n)| *n > 0).map(|(t, n)| format!("{t}={n}")).collect();
    if !changed.is_empty() || !failed.is_empty() {
        store_log::event(
            if failed.is_empty() { "info" } else { "warn" },
            "rustdb",
            &format!("copy from siri-api: {} failed=[{}] ms={}",
                     if changed.is_empty() { "nothing new".to_string() } else { changed.join(" ") },
                     failed.join(","), started.elapsed().as_millis()),
        );
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path as AxPath, Query};
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use std::collections::HashMap;

    fn python_dir(token: Option<&str>) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rust-sync-test-{}-{}", std::process::id(), token.unwrap_or("none")));
        let _ = std::fs::create_dir_all(&d);
        match token {
            Some(t) => std::fs::write(d.join("siri_session.json"), json!({"access_token": t}).to_string()).unwrap(),
            None => { let _ = std::fs::remove_file(d.join("siri_session.json")); }
        }
        d
    }

    async fn fake_sync(AxPath(table): AxPath<String>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap)
                       -> (axum::http::StatusCode, Json<Value>) {
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer good") {
            return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({})));
        }
        let rows = match (table.as_str(), q.get("since").is_some()) {
            ("Users", false) => json!([{"id": "u1", "name": "Asha"}, {"id": "u2", "name": "Bala"}]),
            ("Users", true) => json!([{"id": "u2", "name": "Bala K"}]),
            ("Products", _) => json!([{"id": "p1", "name": "Ring", "barcode": "8901", "selling_price": 100}]),
            ("OfflineLogins", _) => json!([{"id": "u1", "email": "a@x.com", "name": "Asha", "role": "billing_user",
                "status": "active", "salt": "00112233445566778899aabbccddeeff",
                "hash": hex::encode(crate::offline_db::pbkdf2_sha256(b"testing",
                    &hex::decode("00112233445566778899aabbccddeeff").unwrap(), 1000)), "rounds": 1000}]),
            ("Bills", _) => return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))),
            _ => json!([]),
        };
        (axum::http::StatusCode::OK, Json(json!({"rows": rows, "sync_timestamp": "2026-11-25T10:00:00"})))
    }

    async fn fake_siri() -> String {
        let app = Router::new().route("/api/store/sync/{table}", get(fake_sync));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        base
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cycle_fills_records_products_and_offline_logins_then_asks_only_for_changes() {
        let base = fake_siri().await;
        let dir = python_dir(Some("good"));
        let (w1, users, found, login_ok, w2, users_after) = tokio::task::spawn_blocking(move || {
            let db = OfflineDb::open_in_memory().unwrap();
            let w1 = run_once(&db, &dir, &base);
            let users = db.record_count("Users").unwrap();
            let found = db.find_by_barcode("8901").unwrap().is_some();
            let login_ok = db.check_offline_login("a@x.com", "testing").is_some();
            let w2 = run_once(&db, &dir, &base);
            (w1, users, found, login_ok, w2, db.records("Users").unwrap())
        }).await.unwrap();
        assert_eq!(users, 2);
        assert!(found, "products land in the barcode table too");
        assert!(login_ok, "every cashier gets an offline login");
        assert!(w1.iter().any(|(t, n)| t == "Users" && *n == 2));
        assert!(!w1.iter().any(|(t, _)| t == "Bills"), "a table siri-api could not give is skipped, not fatal");
        assert!(w2.iter().any(|(t, n)| t == "Users" && *n == 1), "the second cycle asks only for changes");
        assert!(users_after.iter().any(|u| u["name"] == "Bala K"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_borrowed_login_or_a_refused_one_skips_the_cycle() {
        let base = fake_siri().await;
        let (none, refused) = tokio::task::spawn_blocking(move || {
            let db = OfflineDb::open_in_memory().unwrap();
            (run_once(&db, &python_dir(None), &base), run_once(&db, &python_dir(Some("old")), &base))
        }).await.unwrap();
        assert!(none.is_empty() && refused.is_empty());
    }
}

#[cfg(test)]
mod live {
    //! Against a REAL siri-api (piece 2 live test). Needs: SIRI_LIVE_API (e.g. http://127.0.0.1:5055),
    //! SIRI_LIVE_PYDATA (a folder with siri_session.json from a store login), SIRI_LIVE_EMAIL + SIRI_LIVE_PASSWORD.
    //! cargo test --bin app rust_sync::live -- --ignored --nocapture
    use super::*;

    #[test]
    #[ignore]
    fn one_real_copy_cycle_fills_the_database_and_the_cashier_can_log_in_offline() {
        let api = std::env::var("SIRI_LIVE_API").expect("SIRI_LIVE_API");
        let pydata = PathBuf::from(std::env::var("SIRI_LIVE_PYDATA").expect("SIRI_LIVE_PYDATA"));
        let email = std::env::var("SIRI_LIVE_EMAIL").expect("SIRI_LIVE_EMAIL");
        let password = std::env::var("SIRI_LIVE_PASSWORD").expect("SIRI_LIVE_PASSWORD");
        let db_path = std::env::temp_dir().join(format!("rust-offline-live-{}.db", std::process::id()));
        let db = OfflineDb::open(&db_path).unwrap();

        let t = Instant::now();
        let first = run_once(&db, &pydata, &api);
        println!("first cycle ({} ms): {:?}", t.elapsed().as_millis(), first);
        for table in TABLES {
            println!("  {table:22} rows in Rust db: {}", db.record_count(table).unwrap());
        }
        println!("  products (barcode table): {}", db.product_count().unwrap());
        assert!(first.iter().any(|(t, n)| t == "OfflineLogins" && *n >= 1), "an offline login copy arrived");
        assert!(db.product_count().unwrap() > 1000, "the product list arrived");
        assert!(db.record_count("Users").unwrap() >= 1);
        let ok = db.check_offline_login(&email, &password);
        println!("offline login with the right password: {:?}", ok.as_ref().map(|u| u["id"].clone()));
        assert!(ok.is_some());
        assert!(db.check_offline_login(&email, "wrong-password").is_none());
        for u in db.records("Users").unwrap() {
            assert!(u.get("password").is_none(), "no password in the copied users");
        }

        let t = Instant::now();
        let second = run_once(&db, &pydata, &api);
        println!("second cycle ({} ms, only changes): {:?}", t.elapsed().as_millis(), second);
        assert!(second.iter().all(|(t, n)| t == "OfflineLogins" || *n < 50), "the second cycle asks only for changes");
        drop(db);
        let _ = std::fs::remove_file(&db_path);
    }
}
