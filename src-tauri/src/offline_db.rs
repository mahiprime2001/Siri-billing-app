//! Rust-side local database for the future offline mode.
//!
//! Lives in its own file (`rust-offline.db` in the app data folder) and is
//! deliberately separate from the Flask sidecar's data: two programs never write
//! to the same database, and this module only ever READS Flask's JSON files.
//! Flask stays the real offline system until the store logs show this one is
//! ready to take over.
//!
//! Slice 1: a mirror of the product catalogue with fast barcode lookup. Each row
//! keeps the full product JSON in `raw`, so a field we don't index yet is never lost.

use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

const SCHEMA_VERSION: i64 = 4;

pub struct OfflineDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProductRow {
    pub id: String,
    pub name: String,
    pub price: f64,
    pub selling_price: f64,
    pub stock: i64,
    pub raw: Value,
}

/// Same rule the cashier screen uses (`code.trim().replace(/^0+/, "")`), so a scan
/// that matches there matches here.
pub fn normalize_barcode(code: &str) -> String {
    code.trim().trim_start_matches('0').to_string()
}

fn text(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| v.get(*k).filter(|x| !x.is_null()))
        .map(|x| match x {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn number(v: &Value, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|k| v.get(*k))
        .and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim().parse().ok())))
        .unwrap_or(0.0)
}

/// Every barcode a product answers to: `barcode` plus the comma-separated `barcodes`.
fn barcodes_of(p: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in ["barcode", "barcodes"] {
        for part in text(p, &[key]).split(',') {
            let code = normalize_barcode(part);
            if !code.is_empty() && !out.contains(&code) {
                out.push(code);
            }
        }
    }
    out
}

impl OfflineDb {
    /// Opens (creating if needed) the database at `path` and brings the schema up to date.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Self::from_connection(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> rusqlite::Result<Self> {
        // WAL keeps readers (barcode lookups) from blocking behind a refresh, and
        // survives a crash or power cut mid-write.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let db = OfflineDb { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS products (
                     id            TEXT PRIMARY KEY,
                     name          TEXT NOT NULL DEFAULT '',
                     price         REAL NOT NULL DEFAULT 0,
                     selling_price REAL NOT NULL DEFAULT 0,
                     stock         INTEGER NOT NULL DEFAULT 0,
                     updated_at    TEXT NOT NULL DEFAULT '',
                     raw           TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS product_barcodes (
                     code       TEXT NOT NULL,
                     product_id TEXT NOT NULL,
                     PRIMARY KEY (code, product_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_product_barcodes_code ON product_barcodes(code);
                 CREATE TABLE IF NOT EXISTS meta (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );",
            )?;
        }
        if version < 2 {
            // Slice 2 (Rust offline mode, piece 2): the store's own records copied from siri-api, and the scrambled
            // offline-login copies of every cashier of the store (never a password).
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS records (
                     tbl        TEXT NOT NULL,
                     key        TEXT NOT NULL,
                     raw        TEXT NOT NULL,
                     synced_at  TEXT NOT NULL DEFAULT '',
                     PRIMARY KEY (tbl, key)
                 );
                 CREATE TABLE IF NOT EXISTS offline_logins (
                     email      TEXT PRIMARY KEY,
                     user_id    TEXT NOT NULL,
                     name       TEXT NOT NULL DEFAULT '',
                     role       TEXT NOT NULL DEFAULT '',
                     status     TEXT NOT NULL DEFAULT '',
                     salt       TEXT NOT NULL,
                     hash       TEXT NOT NULL,
                     rounds     INTEGER NOT NULL
                 );",
            )?;
        }
        if version < 3 {
            // Slice 3 (piece 3): the last good answer to each read the screens make, replayed when offline.
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS answers (
                     key          TEXT PRIMARY KEY,
                     status       INTEGER NOT NULL,
                     content_type TEXT NOT NULL DEFAULT '',
                     body         BLOB NOT NULL,
                     saved_at     TEXT NOT NULL DEFAULT ''
                 );",
            )?;
        }
        if version < 4 {
            // Slice 4 (piece 4): bills made with no internet, waiting to be sent, and every bill number seen online
            // (so an offline number never repeats one already used today).
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS offline_bills (
                     queue_id          TEXT PRIMARY KEY,
                     bill_id           TEXT NOT NULL UNIQUE,
                     client_request_id TEXT,
                     user_id           TEXT NOT NULL,
                     store_id          TEXT NOT NULL,
                     payload           TEXT NOT NULL,
                     status            TEXT NOT NULL DEFAULT 'queued',
                     attempts          INTEGER NOT NULL DEFAULT 0,
                     last_error        TEXT,
                     server_bill_id    TEXT,
                     created_at        TEXT NOT NULL,
                     updated_at        TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_bills_request
                     ON offline_bills(client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> '';
                 CREATE TABLE IF NOT EXISTS known_bills (
                     bill_id  TEXT PRIMARY KEY,
                     seen_at  TEXT NOT NULL DEFAULT ''
                 );",
            )?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }

    /// Run `f` with the database connection (one caller at a time). For modules that own their own tables.
    pub fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let mut conn = self.conn.lock().unwrap();
        f(&mut conn)
    }

    /// Remembers the answer to one read (replaces the previous one).
    pub fn save_answer(&self, key: &str, status: u16, content_type: &str, body: &[u8]) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO answers (key, status, content_type, body, saved_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET status=excluded.status, content_type=excluded.content_type,
                 body=excluded.body, saved_at=excluded.saved_at",
            params![key, status as i64, content_type, body],
        )?;
        Ok(())
    }

    /// The last good answer to one read: (status, content type, body, saved at).
    pub fn get_answer(&self, key: &str) -> Option<(u16, String, Vec<u8>, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT status, content_type, body, saved_at FROM answers WHERE key = ?1",
            params![key],
            |r| Ok((r.get::<_, i64>(0)? as u16, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// How a copied row is recognised: its id, or (returns) s_no, or (store links) user + store.
    pub fn record_key(row: &Value) -> Option<String> {
        let s = |k: &str| row.get(k).and_then(|v| match v {
            Value::String(t) if !t.is_empty() => Some(t.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        });
        if let Some(id) = s("id") {
            return Some(id);
        }
        if let Some(n) = s("s_no") {
            return Some(format!("s_no:{n}"));
        }
        match (s("userId").or_else(|| s("userid")), s("storeId").or_else(|| s("storeid"))) {
            (Some(u), Some(st)) => Some(format!("{u}|{st}")),
            _ => None,
        }
    }

    /// Inserts or refreshes copied rows of one table (rows without a key are skipped). One transaction.
    pub fn upsert_records(&self, tbl: &str, rows: &[Value], synced_at: &str) -> rusqlite::Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut written = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO records (tbl, key, raw, synced_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(tbl, key) DO UPDATE SET raw=excluded.raw, synced_at=excluded.synced_at",
            )?;
            for row in rows {
                if let Some(key) = Self::record_key(row) {
                    stmt.execute(params![tbl, key, row.to_string(), synced_at])?;
                    written += 1;
                }
            }
        }
        tx.commit()?;
        Ok(written)
    }

    pub fn record_count(&self, tbl: &str) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM records WHERE tbl = ?1", params![tbl], |r| r.get(0))
    }

    pub fn records(&self, tbl: &str) -> rusqlite::Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT raw FROM records WHERE tbl = ?1")?;
        let rows = stmt.query_map(params![tbl], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|t| serde_json::from_str(&t).ok()).collect())
    }

    /// Stores the scrambled copies siri-api sent (one per person; a newer copy replaces the older one).
    pub fn upsert_offline_logins(&self, rows: &[Value]) -> rusqlite::Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut written = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO offline_logins (email, user_id, name, role, status, salt, hash, rounds)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(email) DO UPDATE SET user_id=excluded.user_id, name=excluded.name, role=excluded.role,
                     status=excluded.status, salt=excluded.salt, hash=excluded.hash, rounds=excluded.rounds",
            )?;
            for row in rows {
                let t = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let email = t("email").trim().to_lowercase();
                let rounds = row.get("rounds").and_then(Value::as_i64).unwrap_or(0);
                if email.is_empty() || t("id").is_empty() || t("salt").is_empty() || t("hash").is_empty() || rounds <= 0 {
                    continue;
                }
                stmt.execute(params![email, t("id"), t("name"), t("role"), t("status"), t("salt"), t("hash"), rounds])?;
                written += 1;
            }
        }
        tx.commit()?;
        Ok(written)
    }

    /// The person (id, name, email, role) when `password` matches the scrambled copy for `email`; else None.
    /// A person whose status is "inactive" is never let in.
    pub fn check_offline_login(&self, email: &str, password: &str) -> Option<Value> {
        let email = email.trim().to_lowercase();
        if email.is_empty() || password.is_empty() {
            return None;
        }
        let row: Option<(String, String, String, String, String, String, i64)> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT user_id, name, role, status, salt, hash, rounds FROM offline_logins WHERE email = ?1",
                params![email],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .optional()
            .ok()
            .flatten()
        };
        let (user_id, name, role, status, salt, hash, rounds) = row?;
        if status.eq_ignore_ascii_case("inactive") {
            return None;
        }
        let salt = hex::decode(salt).ok()?;
        let expected = hex::decode(hash).ok()?;
        let got = pbkdf2_sha256(password.as_bytes(), &salt, u32::try_from(rounds).ok()?);
        if got.len() != expected.len() || got.iter().zip(&expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) != 0 {
            return None;
        }
        Some(serde_json::json!({ "id": user_id, "name": name, "email": email, "role": role }))
    }

    /// Inserts or refreshes products (and their barcodes) in one transaction.
    /// Rows without an id are skipped. Returns how many rows were written.
    pub fn upsert_products(&self, products: &[Value]) -> rusqlite::Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let written = Self::write_products(&tx, products)?;
        tx.commit()?;
        Ok(written)
    }

    /// Makes the table match `products` exactly: removes everything, then writes the
    /// list. All-or-nothing, so a failure leaves the old mirror untouched.
    pub fn replace_products(&self, products: &[Value]) -> rusqlite::Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM product_barcodes", [])?;
        tx.execute("DELETE FROM products", [])?;
        let written = Self::write_products(&tx, products)?;
        tx.commit()?;
        Ok(written)
    }

    fn write_products(tx: &rusqlite::Transaction, products: &[Value]) -> rusqlite::Result<usize> {
        let mut written = 0;
        let mut upsert = tx.prepare(
            "INSERT INTO products (id, name, price, selling_price, stock, updated_at, raw)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name, price=excluded.price, selling_price=excluded.selling_price,
                 stock=excluded.stock, updated_at=excluded.updated_at, raw=excluded.raw",
        )?;
        let mut clear_codes = tx.prepare("DELETE FROM product_barcodes WHERE product_id = ?1")?;
        let mut add_code = tx.prepare("INSERT OR IGNORE INTO product_barcodes (code, product_id) VALUES (?1, ?2)")?;
        for p in products {
            let id = text(p, &["id"]);
            if id.is_empty() {
                continue;
            }
            upsert.execute(params![
                id,
                text(p, &["name"]),
                number(p, &["price"]),
                number(p, &["selling_price", "sellingPrice", "sellingprice"]),
                number(p, &["stock"]) as i64,
                text(p, &["updated_at", "updatedat"]),
                p.to_string(),
            ])?;
            clear_codes.execute(params![id])?;
            for code in barcodes_of(p) {
                add_code.execute(params![code, id])?;
            }
            written += 1;
        }
        Ok(written)
    }

    /// Looks a scanned barcode up the way the cashier screen does (trim + strip leading zeros).
    pub fn find_by_barcode(&self, barcode: &str) -> rusqlite::Result<Option<ProductRow>> {
        let code = normalize_barcode(barcode);
        if code.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT p.id, p.name, p.price, p.selling_price, p.stock, p.raw
               FROM product_barcodes b JOIN products p ON p.id = b.product_id
              WHERE b.code = ?1 ORDER BY p.id LIMIT 1",
            params![code],
            |r| {
                let raw: String = r.get(5)?;
                Ok(ProductRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    price: r.get(2)?,
                    selling_price: r.get(3)?,
                    stock: r.get(4)?,
                    raw: serde_json::from_str(&raw).unwrap_or(Value::Null),
                })
            },
        )
        .optional()
    }

    pub fn product_count(&self) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0))
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
    }

    /// Re-reads Flask's products file into this database when the file has changed
    /// since the last refresh. Read-only on the Flask side. Returns `Some(count)` if a
    /// refresh happened, `None` if the file is unchanged.
    pub fn refresh_from_flask_file(&self, products_json: &Path) -> Result<Option<usize>, String> {
        let meta = std::fs::metadata(products_json).map_err(|e| format!("products file: {e}"))?;
        let stamp = format!(
            "{}:{}",
            meta.len(),
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        if self.get_meta("products_file_stamp").map_err(|e| e.to_string())?.as_deref() == Some(stamp.as_str()) {
            return Ok(None);
        }
        let bytes = std::fs::read(products_json).map_err(|e| format!("read products file: {e}"))?;
        let parsed: Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse products file: {e}"))?;
        let list = parsed.as_array().ok_or("products file is not a list")?;
        // Flask rewrites the file in place; an empty list from a half-written file must
        // never wipe a good mirror.
        if list.is_empty() && self.product_count().map_err(|e| e.to_string())? > 0 {
            return Err("products file is empty; keeping the existing mirror".into());
        }
        let n = self.replace_products(list).map_err(|e| e.to_string())?;
        self.set_meta("products_file_stamp", &stamp).map_err(|e| e.to_string())?;
        Ok(Some(n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Vec<Value> {
        vec![
            json!({"id": "p1", "name": "Soap", "barcode": "0890100", "price": 10, "selling_price": 12.5, "stock": 7, "updated_at": "2026-11-01T00:00:00Z", "hsn_code_id": "h1"}),
            json!({"id": "p2", "name": "Rice 1kg", "barcode": "890200", "barcodes": "890200, 890201", "price": "55", "sellingPrice": "60", "stock": 3}),
        ]
    }

    #[test]
    fn finds_a_product_by_barcode_ignoring_leading_zeros() {
        let db = OfflineDb::open_in_memory().unwrap();
        assert_eq!(db.upsert_products(&sample()).unwrap(), 2);
        for scan in ["890100", "0890100", " 00890100 "] {
            let p = db.find_by_barcode(scan).unwrap().unwrap_or_else(|| panic!("{scan} should match"));
            assert_eq!((p.id.as_str(), p.name.as_str(), p.stock), ("p1", "Soap", 7));
        }
        assert_eq!(db.find_by_barcode("890100").unwrap().unwrap().raw["hsn_code_id"], "h1", "unindexed fields are kept in raw");
    }

    #[test]
    fn a_product_can_answer_to_several_barcodes() {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_products(&sample()).unwrap();
        assert_eq!(db.find_by_barcode("890201").unwrap().unwrap().id, "p2");
        assert_eq!(db.find_by_barcode("890200").unwrap().unwrap().id, "p2");
    }

    #[test]
    fn numbers_given_as_strings_and_alternate_key_names_are_read() {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_products(&sample()).unwrap();
        let p = db.find_by_barcode("890200").unwrap().unwrap();
        assert_eq!((p.price, p.selling_price), (55.0, 60.0));
    }

    #[test]
    fn unknown_or_blank_barcode_is_none() {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_products(&sample()).unwrap();
        assert!(db.find_by_barcode("000").unwrap().is_none());
        assert!(db.find_by_barcode("  ").unwrap().is_none());
        assert!(db.find_by_barcode("999").unwrap().is_none());
    }

    #[test]
    fn upsert_updates_in_place_and_drops_old_barcodes() {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_products(&sample()).unwrap();
        let changed = vec![json!({"id": "p1", "name": "Soap", "barcode": "555", "stock": 2}), json!({"name": "no id"})];
        assert_eq!(db.upsert_products(&changed).unwrap(), 1);
        assert_eq!(db.product_count().unwrap(), 2);
        assert_eq!(db.find_by_barcode("555").unwrap().unwrap().stock, 2);
        assert!(db.find_by_barcode("890100").unwrap().is_none(), "old barcode no longer matches");
    }

    #[test]
    fn replace_removes_products_that_are_gone() {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_products(&sample()).unwrap();
        db.replace_products(&sample()[..1]).unwrap();
        assert_eq!(db.product_count().unwrap(), 1);
        assert!(db.find_by_barcode("890200").unwrap().is_none());
    }

    #[test]
    fn meta_round_trips() {
        let db = OfflineDb::open_in_memory().unwrap();
        assert_eq!(db.get_meta("k").unwrap(), None);
        db.set_meta("k", "a").unwrap();
        db.set_meta("k", "b").unwrap();
        assert_eq!(db.get_meta("k").unwrap().as_deref(), Some("b"));
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("offline-db-{tag}-{}", std::process::id()))
    }

    #[test]
    fn file_database_survives_reopen() {
        let dir = temp_dir("reopen");
        let path = dir.join("rust-offline.db");
        {
            let db = OfflineDb::open(&path).unwrap();
            db.upsert_products(&sample()).unwrap();
        }
        let db = OfflineDb::open(&path).unwrap();
        assert_eq!(db.product_count().unwrap(), 2);
        assert_eq!(db.find_by_barcode("890100").unwrap().unwrap().id, "p1");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Manual check against a real Flask products file:
    /// `OFFLINE_DB_REAL_PRODUCTS=path/to/products.json cargo test real_products -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_products_file_loads_and_looks_up_fast() {
        let Ok(path) = std::env::var("OFFLINE_DB_REAL_PRODUCTS") else { return };
        let db = OfflineDb::open_in_memory().unwrap();
        let t = std::time::Instant::now();
        let n = db.refresh_from_flask_file(Path::new(&path)).unwrap().unwrap();
        println!("loaded {n} products in {:?}", t.elapsed());
        let sample: Vec<Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let t = std::time::Instant::now();
        let mut checked = 0;
        for p in sample.iter().filter(|p| !barcodes_of(p).is_empty()).take(2000) {
            // A few products carry several codes joined by commas; each part is indexed on its own.
            let code = barcodes_of(p).remove(0);
            let found = db.find_by_barcode(&code).unwrap().unwrap_or_else(|| panic!("{code} not found"));
            // Duplicate barcodes across products are possible; the id may differ then.
            assert!(!found.id.is_empty());
            checked += 1;
        }
        println!("{checked} lookups in {:?}", t.elapsed());
    }

    #[test]
    fn refresh_reads_flask_file_only_when_it_changed_and_never_wipes_on_empty() {
        let dir = temp_dir("refresh");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("products.json");
        let db = OfflineDb::open_in_memory().unwrap();

        assert!(db.refresh_from_flask_file(&file).is_err(), "missing file is an error, not a wipe");

        std::fs::write(&file, serde_json::to_vec(&sample()).unwrap()).unwrap();
        assert_eq!(db.refresh_from_flask_file(&file).unwrap(), Some(2));
        assert_eq!(db.refresh_from_flask_file(&file).unwrap(), None, "unchanged file is skipped");

        std::fs::write(&file, b"[]").unwrap();
        assert!(db.refresh_from_flask_file(&file).is_err(), "empty file must not wipe a good mirror");
        assert_eq!(db.product_count().unwrap(), 2);

        std::fs::write(&file, b"{ not json").unwrap();
        assert!(db.refresh_from_flask_file(&file).is_err());
        assert_eq!(db.product_count().unwrap(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}


/// PBKDF2-HMAC-SHA256 with a 32-byte result (the same as Python's hashlib.pbkdf2_hmac("sha256", ...)).
pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], rounds: u32) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    type H = Hmac<sha2::Sha256>;
    let prf = H::new_from_slice(password).expect("HMAC takes a key of any length");
    let mut first = prf.clone();
    first.update(salt);
    first.update(&1u32.to_be_bytes());
    let mut u = first.finalize().into_bytes();
    let mut out = u;
    for _ in 1..rounds.max(1) {
        let mut m = prf.clone();
        m.update(&u);
        u = m.finalize().into_bytes();
        for (o, x) in out.iter_mut().zip(u.iter()) {
            *o ^= x;
        }
    }
    out.to_vec()
}

#[cfg(test)]
mod slice2_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pbkdf2_matches_pythons_hashlib() {
        // python: hashlib.pbkdf2_hmac("sha256", b"testing", bytes.fromhex("00112233445566778899aabbccddeeff"), 1000).hex()
        let got = pbkdf2_sha256(b"testing", &hex::decode("00112233445566778899aabbccddeeff").unwrap(), 1000);
        assert_eq!(hex::encode(got), "9e92adc61d75045ce20736fa60e546f91b5c0dd233d3edeeae6b204f07978f2f");
    }

    #[test]
    fn records_are_upserted_by_their_key() {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_records("Users", &[json!({"id": "u1", "name": "A"}), json!({"name": "no key"})], "t1").unwrap();
        db.upsert_records("Users", &[json!({"id": "u1", "name": "B"})], "t2").unwrap();
        db.upsert_records("Returns", &[json!({"s_no": 7})], "t1").unwrap();
        db.upsert_records("UserStores", &[json!({"userId": "u1", "storeId": "s1"})], "t1").unwrap();
        assert_eq!(db.record_count("Users").unwrap(), 1);
        assert_eq!(db.records("Users").unwrap()[0]["name"], "B");
        assert_eq!(db.record_count("Returns").unwrap(), 1);
        assert_eq!(db.record_count("UserStores").unwrap(), 1);
    }

    #[test]
    fn offline_login_checks_the_scrambled_copy() {
        let db = OfflineDb::open_in_memory().unwrap();
        let salt = hex::decode("00112233445566778899aabbccddeeff").unwrap();
        let hash = hex::encode(pbkdf2_sha256(b"testing", &salt, 1000));
        db.upsert_offline_logins(&[json!({"id": "u1", "email": "A@X.com ", "name": "Asha", "role": "billing_user",
            "status": "active", "salt": hex::encode(&salt), "hash": hash, "rounds": 1000})]).unwrap();
        let ok = db.check_offline_login("a@x.com", "testing").unwrap();
        assert_eq!((ok["id"].as_str(), ok["name"].as_str()), (Some("u1"), Some("Asha")));
        assert!(db.check_offline_login("a@x.com", "wrong").is_none());
        assert!(db.check_offline_login("other@x.com", "testing").is_none());
        db.upsert_offline_logins(&[json!({"id": "u1", "email": "a@x.com", "status": "inactive",
            "salt": hex::encode(&salt), "hash": hex::encode(pbkdf2_sha256(b"testing", &salt, 1000)), "rounds": 1000})]).unwrap();
        assert!(db.check_offline_login("a@x.com", "testing").is_none());      // switched off in the admin app
    }
}
