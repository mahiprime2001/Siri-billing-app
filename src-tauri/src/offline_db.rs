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

const SCHEMA_VERSION: i64 = 1;

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
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
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
