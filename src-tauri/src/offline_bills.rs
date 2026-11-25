//! Rust offline mode, piece 4: making bills with no internet, and sending them when it is back.
//!
//! * A bill made offline is numbered on the PC: INV-<store code>-<ddmmyyyy IST><4 digits>, one more than the
//!   highest number this PC knows for today: bills seen online through the front door, bills copied from siri-api,
//!   bills already queued here, and (read-only) the Python side's own local bills and queue. So an offline number
//!   never repeats one already used today.
//! * It is saved in Rust's database (`offline_bills`) in one transaction before the screen hears "queued". The same
//!   request sent twice (same request id) is the same bill.
//! * Every minute, while online, queued bills are sent to siri-api's replay route with the cashier's replay pass
//!   (the Python side keeps the passes in data/siri_session.json; read-only). Each bill is sent with its number and
//!   request id, so siri-api never makes it twice. A refused pass waits for the next login; a real "no" from
//!   siri-api (4xx) is kept as "needs attention" for a person, never dropped; anything else is tried again.
//! * Stock offline: the product list the screen last got online is shown with every offline sale since then taken
//!   off (offline_answers.rs).

use std::collections::HashMap;
use std::path::Path;
use std::thread;
use std::time::Duration;

use chrono::{FixedOffset, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::offline_db::OfflineDb;
use crate::store_log;

pub const QUEUED_MESSAGE: &str = "Connection lost. Invoice queued and will sync automatically when internet returns.";
const REPLAY_EVERY: Duration = Duration::from_secs(60);

fn now_utc() -> String {
    Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Today's date in India for the bill number (the shop's day).
pub fn ist_day(now: chrono::DateTime<Utc>) -> String {
    now.with_timezone(&FixedOffset::east_opt(19800).unwrap()).format("%d%m%Y").to_string()
}

/// The last 4 digits of a bill number that belongs to `prefix` (INV-CODE-ddmmyyyy), else 0.
fn serial(id: &str, prefix: &str) -> u32 {
    id.strip_prefix(prefix)
        .filter(|rest| rest.len() == 4 && rest.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|rest| rest.parse().ok())
        .unwrap_or(0)
}

fn store_code(conn: &Connection, store_id: &str) -> String {
    conn.query_row("SELECT raw FROM records WHERE tbl = 'Stores' AND key = ?1", params![store_id], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("storecode").and_then(Value::as_str).map(|s| s.trim().to_uppercase()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "STR".to_string())
}

/// Numbers the Python side has used locally today (its bill copies and its own offline queue). Read-only.
fn python_numbers(python_dir: &Path, prefix: &str) -> u32 {
    let mut best = 0;
    let read = |name: &str| -> Vec<Value> {
        std::fs::read_to_string(python_dir.join("json").join(name)).ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    };
    for b in read("bills.json") {
        best = best.max(serial(b.get("id").and_then(Value::as_str).unwrap_or(""), prefix));
    }
    for q in read("offline_bill_queue.json") {
        best = best.max(serial(q.get("forced_bill_id").and_then(Value::as_str).unwrap_or(""), prefix));
        let forced = q.get("payload").and_then(|p| p.get("_forced_bill_id")).and_then(Value::as_str).unwrap_or("");
        best = best.max(serial(forced, prefix));
    }
    best
}

fn next_bill_id(conn: &Connection, prefix: &str, python_dir: &Path) -> rusqlite::Result<String> {
    let like = format!("{prefix}%");
    let mut best = python_numbers(python_dir, prefix);
    for sql in [
        "SELECT bill_id FROM known_bills WHERE bill_id LIKE ?1",
        "SELECT bill_id FROM offline_bills WHERE bill_id LIKE ?1",
        "SELECT key FROM records WHERE tbl = 'Bills' AND key LIKE ?1",
    ] {
        let mut stmt = conn.prepare(sql)?;
        for id in stmt.query_map(params![like], |r| r.get::<_, String>(0))?.flatten() {
            best = best.max(serial(&id, prefix));
        }
    }
    Ok(format!("{prefix}{:04}", best + 1))
}

/// A bill number seen online (made through siri-api or the backend): offline numbers continue after it.
pub fn remember_bill(db: &OfflineDb, bill_id: &str) {
    if bill_id.trim().is_empty() {
        return;
    }
    let _ = db.with_conn(|c| {
        c.execute("INSERT OR IGNORE INTO known_bills (bill_id, seen_at) VALUES (?1, ?2)", params![bill_id, now_utc()])
    });
}

#[derive(Debug, Clone, PartialEq)]
pub struct Queued {
    pub queue_id: String,
    pub bill_id: String,
    pub new: bool,
}

/// Save one bill made with no internet. `None` when the payload is not a bill this module can take (no store or no
/// items): the Python side then decides, as before.
pub fn queue_bill(db: &OfflineDb, user_id: &str, payload: &Value, python_dir: &Path, now: chrono::DateTime<Utc>)
                  -> rusqlite::Result<Option<Queued>> {
    let store_id = payload.get("store_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let has_items = payload.get("items").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false);
    if store_id.is_empty() || !has_items {
        return Ok(None);
    }
    let request_id = payload.get("_client_request_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    db.with_conn(|c| {
        let tx = c.transaction()?;
        if !request_id.is_empty() {
            let existing: Option<(String, String)> = tx
                .query_row("SELECT queue_id, bill_id FROM offline_bills WHERE client_request_id = ?1", params![request_id],
                           |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            if let Some((queue_id, bill_id)) = existing {
                return Ok(Some(Queued { queue_id, bill_id, new: false }));
            }
        }
        let prefix = format!("INV-{}-{}", store_code(&tx, &store_id), ist_day(now));
        let bill_id = next_bill_id(&tx, &prefix, python_dir)?;
        let queue_id = format!("RQ-{}", bill_id.replace('-', "").to_lowercase());
        let mut stored = payload.clone();
        stored["_forced_bill_id"] = json!(bill_id);
        let stamp = now.format("%Y-%m-%d %H:%M:%S").to_string();
        tx.execute(
            "INSERT INTO offline_bills (queue_id, bill_id, client_request_id, user_id, store_id, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![queue_id, bill_id, if request_id.is_empty() { None } else { Some(request_id.clone()) }, user_id,
                    store_id, stored.to_string(), stamp],
        )?;
        tx.commit()?;
        Ok(Some(Queued { queue_id, bill_id, new: true }))
    })
}

/// What the screen hears for a queued bill (the same answer the Python side gives).
pub fn queued_answer(q: &Queued) -> Value {
    json!({ "queued": true, "bill_id": q.bill_id, "queue_id": q.queue_id, "message": QUEUED_MESSAGE })
}

/// Quantity sold offline per product at this store since `since` ("YYYY-MM-DD HH:MM:SS", UTC).
pub fn sold_since(db: &OfflineDb, store_id: &str, since: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let payloads: Vec<String> = db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT payload FROM offline_bills WHERE store_id = ?1 AND created_at >= ?2")?;
        let rows = stmt.query_map(params![store_id, since], |r| r.get::<_, String>(0))?;
        Ok(rows.flatten().collect())
    }).unwrap_or_default();
    for p in payloads {
        let Ok(v) = serde_json::from_str::<Value>(&p) else { continue };
        for item in v.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
            let pid = item.get("product_id").or_else(|| item.get("productId")).and_then(Value::as_str).unwrap_or("");
            let qty = item.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
            if !pid.is_empty() && qty > 0.0 {
                *out.entry(pid.to_string()).or_insert(0.0) += qty;
            }
        }
    }
    out
}

/// The store this login works at, as remembered from the copy (the first store link of `user_id`).
pub fn store_of(db: &OfflineDb, user_id: &str) -> Option<String> {
    db.records("UserStores").ok()?.into_iter().find_map(|l| {
        let u = l.get("userId").or_else(|| l.get("userid")).and_then(Value::as_str)?;
        if u == user_id { l.get("storeId").or_else(|| l.get("storeid")).and_then(Value::as_str).map(str::to_string) } else { None }
    })
}

/// The product list with the offline sales taken off (stock never below 0). Anything not understood: unchanged.
pub fn adjust_products(body: &[u8], sold: &HashMap<String, f64>) -> Vec<u8> {
    if sold.is_empty() {
        return body.to_vec();
    }
    let Ok(mut v) = serde_json::from_slice::<Value>(body) else { return body.to_vec() };
    let list = if v.is_array() { Some(&mut v) } else { v.get_mut("products") };
    let Some(Value::Array(items)) = list else { return body.to_vec() };
    for p in items.iter_mut() {
        let pid = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(n) = sold.get(&pid) else { continue };
        for field in ["stock", "quantity", "store_quantity", "availableStock"] {
            if let Some(have) = p.get(field).and_then(Value::as_f64) {
                let left = (have - n).max(0.0);
                p[field] = if left.fract() == 0.0 { json!(left as i64) } else { json!(left) };
            }
        }
    }
    serde_json::to_vec(&v).unwrap_or_else(|_| body.to_vec())
}

/// The cashier's replay pass for this store (kept by the Python side).
fn replay_pass(python_dir: &Path, user_id: &str, store_id: &str) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(python_dir.join("siri_session.json")).ok()?).ok()?;
    let own = v.get("replay_by_user").and_then(|m| m.get(user_id)).and_then(|m| m.get(store_id)).and_then(Value::as_str);
    let any = v.get("replay_tokens").and_then(|m| m.get(store_id)).and_then(Value::as_str);
    own.or(any).filter(|t| !t.is_empty()).map(str::to_string)
}

/// One bill made offline, in the shape the history screen gets from the backend (bill row + customer + store),
/// marked `offline_queued` and never editable while it waits.
fn history_row(db: &OfflineDb, bill_id: &str, store_id: &str, payload: &Value, status: &str, created_at: &str) -> Value {
    let store = db.records("Stores").ok().unwrap_or_default().into_iter()
        .find(|s| s.get("id").and_then(Value::as_str) == Some(store_id)).unwrap_or(Value::Null);
    let p = |k: &str| payload.get(k).cloned().unwrap_or(Value::Null);
    let when = payload.get("timestamp").and_then(Value::as_str).map(str::to_string)
        .unwrap_or_else(|| created_at.replace(' ', "T"));
    json!({
        "id": bill_id, "storeid": store_id, "customerid": p("customer_id"),
        "subtotal": p("subtotal"), "tax_amount": p("tax_amount"), "discount_amount": p("discount_amount"),
        "discount_percentage": p("discount_percentage"), "total": p("total_amount"),
        "paymentmethod": p("payment_method"), "timestamp": when, "created_at": when, "updated_at": when,
        "status": "completed",
        "customers": {"name": p("customer_name"), "phone": p("customer_phone"), "email": p("customer_email"),
                      "address": p("customer_address")},
        "stores": {"name": store.get("name").cloned().unwrap_or(Value::Null),
                   "address": store.get("address").cloned().unwrap_or(Value::Null),
                   "phone": store.get("phone").cloned().unwrap_or(Value::Null)},
        "offline_queued": true, "offline_status": status,
        "can_edit": false, "can_cancel": false, "edit_expires_at": Value::Null, "seconds_remaining": 0,
    })
}

/// Bills made offline that siri-api does not have yet (waiting, or needing a person), newest first.
fn unsent(db: &OfflineDb) -> Vec<(String, String, Value, String, String)> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT bill_id, store_id, payload, status, created_at FROM offline_bills
             WHERE status IN ('queued', 'needs_attention') ORDER BY created_at DESC, bill_id DESC")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                                              r.get::<_, String>(3)?, r.get::<_, String>(4)?)))?;
        Ok(rows.flatten()
            .map(|(b, s, p, st, at)| (b, s, serde_json::from_str(&p).unwrap_or(Value::Null), st, at))
            .collect())
    }).unwrap_or_default()
}

/// The history list with the bills made offline put in front (any already in the list are not doubled).
/// `start`/`end` are the screen's date filters (compared as text, like the backend does).
pub fn merge_into_history(db: &OfflineDb, body: &[u8], start: Option<&str>, end: Option<&str>) -> Vec<u8> {
    let mut list: Vec<Value> = serde_json::from_slice::<Value>(body).ok()
        .and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let have: std::collections::HashSet<String> =
        list.iter().filter_map(|b| b.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let mut add = Vec::new();
    for (bill_id, store_id, payload, status, created_at) in unsent(db) {
        if have.contains(&bill_id) {
            continue;
        }
        let row = history_row(db, &bill_id, &store_id, &payload, &status, &created_at);
        let when = row["created_at"].as_str().unwrap_or("").to_string();
        if start.map(|s| when.as_str() < s).unwrap_or(false) || end.map(|e| when.as_str() > e).unwrap_or(false) {
            continue;
        }
        add.push(row);
    }
    add.extend(list.drain(..));
    serde_json::to_vec(&add).unwrap_or_else(|_| body.to_vec())
}

/// For a bill made offline and not sent yet: its record, its lines, or (events / replacements) an empty list,
/// in the backend's shapes. `None` when `bill_id` is not such a bill.
pub fn offline_bill_part(db: &OfflineDb, bill_id: &str, part: &str) -> Option<Value> {
    let (_, store_id, payload, status, created_at) = unsent(db).into_iter().find(|(b, ..)| b == bill_id)?;
    match part {
        "" => Some(history_row(db, bill_id, &store_id, &payload, &status, &created_at)),
        "items" => {
            let products = db.records("Products").ok().unwrap_or_default();
            let items = payload.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
            Some(Value::Array(items.into_iter().enumerate().map(|(i, it)| {
                let pid = it.get("product_id").or_else(|| it.get("productId")).and_then(Value::as_str).unwrap_or("").to_string();
                let prod = products.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(pid.as_str()))
                    .cloned().unwrap_or(Value::Null);
                let name = it.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string)
                    .or_else(|| prod.get("name").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
                let tax = it.get("tax_percentage").cloned().unwrap_or(Value::Null);
                let code = it.get("hsn_code").and_then(Value::as_str).unwrap_or("").to_string();
                let barcode = it.get("barcode").filter(|b| b.as_str().map(|s| !s.is_empty()).unwrap_or(false)).cloned()
                    .unwrap_or_else(|| prod.get("barcode").cloned().unwrap_or(Value::Null));
                json!({
                    "id": i + 1, "billid": bill_id, "productid": pid, "quantity": it.get("quantity").cloned().unwrap_or(json!(0)),
                    "price": it.get("unit_price").cloned().unwrap_or(Value::Null),
                    "total": it.get("item_total").cloned().unwrap_or(Value::Null),
                    "tax_percentage": tax, "taxPercentage": tax, "hsn_code": code, "hsnCode": code,
                    "products": {"id": pid, "name": name, "barcode": barcode,
                                 "selling_price": prod.get("selling_price").cloned().unwrap_or(Value::Null), "tax": tax},
                })
            }).collect()))
        }
        "events" | "replacements" => Some(json!([])),
        _ => None,
    }
}

/// What the status note shows: waiting / needing a person, with the bills that need a person.
pub fn status(db: &OfflineDb, online: bool) -> Value {
    let (waiting, attention) = counts(db);
    let needing: Vec<Value> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT bill_id, attempts, last_error, created_at FROM offline_bills WHERE status = 'needs_attention'
             ORDER BY created_at")?;
        let rows = stmt.query_map([], |r| Ok(json!({"bill_id": r.get::<_, String>(0)?, "attempts": r.get::<_, i64>(1)?,
            "error": r.get::<_, Option<String>>(2)?, "made_at": r.get::<_, String>(3)?})))?;
        Ok(rows.flatten().collect())
    }).unwrap_or_default();
    json!({"online": online, "waiting": waiting, "needs_attention": attention, "bills_needing_attention": needing})
}

/// How many bills are waiting, and how many need a person (for the log and the status note).
pub fn counts(db: &OfflineDb) -> (i64, i64) {
    db.with_conn(|c| {
        let q = c.query_row("SELECT COUNT(*) FROM offline_bills WHERE status = 'queued'", [], |r| r.get(0))?;
        let n = c.query_row("SELECT COUNT(*) FROM offline_bills WHERE status = 'needs_attention'", [], |r| r.get(0))?;
        Ok((q, n))
    }).unwrap_or((0, 0))
}

/// Send queued bills (oldest first). Returns (bill number, outcome) for the log and the tests.
pub fn replay_once(db: &OfflineDb, python_dir: &Path, api_base: &str) -> Vec<(String, String)> {
    let queued: Vec<(String, String, String, String, String)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT queue_id, bill_id, user_id, store_id, payload FROM offline_bills WHERE status = 'queued'
             ORDER BY created_at, bill_id LIMIT 25")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        Ok(rows.flatten().collect())
    }).unwrap_or_default();
    if queued.is_empty() {
        return Vec::new();
    }
    let Ok(client) = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60)).build() else { return Vec::new() };
    let mut outcomes = Vec::new();
    for (queue_id, bill_id, user_id, store_id, payload) in queued {
        let Some(pass) = replay_pass(python_dir, &user_id, &store_id) else {
            outcomes.push((bill_id, "waiting for a replay pass (next online login)".into()));
            continue;
        };
        let mut body: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        body["forced_bill_id"] = json!(bill_id);
        let set = |status: &str, error: Option<String>, server: Option<String>| {
            let _ = db.with_conn(|c| c.execute(
                "UPDATE offline_bills SET status = ?2, attempts = attempts + 1, last_error = ?3,
                     server_bill_id = COALESCE(?4, server_bill_id), updated_at = ?5 WHERE queue_id = ?1",
                params![queue_id, status, error, server, now_utc()]));
        };
        match client.post(format!("{api_base}/api/store/replay/bills")).bearer_auth(&pass).json(&body).send() {
            Ok(r) if r.status().is_success() => {
                let answer: Value = r.json().unwrap_or(Value::Null);
                let made = answer.get("bill_id").and_then(Value::as_str).unwrap_or(&bill_id).to_string();
                set("sent", None, Some(made.clone()));
                remember_bill(db, &made);
                if made != bill_id {
                    store_log::event("warn", "rustbills", &format!(
                        "bill {bill_id} was already saved by siri-api as {made} (no second bill made; the receipt shows {bill_id})"));
                }
                outcomes.push((bill_id, format!("sent as {made}")));
            }
            Ok(r) if r.status().as_u16() == 401 => {
                outcomes.push((bill_id, "replay pass refused: waiting for the next login".into()));
                break;
            }
            Ok(r) if r.status().is_client_error() => {
                let code = r.status().as_u16();
                let text = r.text().unwrap_or_default();
                set("needs_attention", Some(format!("HTTP {code}: {}", &text[..text.len().min(300)])), None);
                store_log::event("error", "rustbills",
                                 &format!("bill {bill_id} refused by siri-api (HTTP {code}): kept for a person to check"));
                outcomes.push((bill_id, format!("needs attention (HTTP {code})")));
            }
            Ok(r) => {
                set("queued", Some(format!("HTTP {}", r.status().as_u16())), None);
                outcomes.push((bill_id, "server busy: will retry".into()));
            }
            Err(e) => {
                set("queued", Some(format!("{e}")), None);
                outcomes.push((bill_id, "no answer: will retry".into()));
                break;
            }
        }
    }
    let sent = outcomes.iter().filter(|(_, o)| o.starts_with("sent")).count();
    if !outcomes.is_empty() {
        store_log::event("info", "rustbills", &format!("offline bills: sent={sent} of {} ({:?})", outcomes.len(), outcomes));
    }
    outcomes
}

pub fn start_replay(python_dir: std::path::PathBuf, api_base: &'static str) {
    thread::spawn(move || loop {
        thread::sleep(REPLAY_EVERY);
        if crate::offline_answers::is_online() {
            if let Some(db) = crate::shadow::database() {
                replay_once(db, &python_dir, api_base);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use chrono::TimeZone;
    use std::sync::{Arc, Mutex};

    fn db_with_store() -> OfflineDb {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_records("Stores", &[json!({"id": "s1", "storecode": "nlr"})], "t").unwrap();
        db
    }

    fn noon() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 25, 6, 30, 0).unwrap() // 12:00 IST
    }

    fn bill(req: &str, pid: &str, qty: i64) -> Value {
        json!({"store_id": "s1", "_client_request_id": req, "items": [{"product_id": pid, "quantity": qty, "unit_price": 100}],
               "total_amount": 103})
    }

    fn pydir(name: &str, session: Option<Value>) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("offline-bills-{}-{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(d.join("json"));
        let _ = std::fs::remove_file(d.join("json").join("bills.json"));
        match session {
            Some(s) => std::fs::write(d.join("siri_session.json"), s.to_string()).unwrap(),
            None => { let _ = std::fs::remove_file(d.join("siri_session.json")); }
        }
        d
    }

    #[test]
    fn numbers_continue_after_every_bill_this_pc_knows_and_ist_decides_the_day() {
        let db = db_with_store();
        let py = pydir("numbers", None);
        assert_eq!(ist_day(Utc.with_ymd_and_hms(2026, 11, 24, 19, 0, 0).unwrap()), "25112026"); // 00:30 IST next day
        let q1 = queue_bill(&db, "u1", &bill("r1", "p1", 1), &py, noon()).unwrap().unwrap();
        assert_eq!(q1.bill_id, "INV-NLR-251120260001");
        remember_bill(&db, "INV-NLR-251120260007"); // a bill made online meanwhile
        db.upsert_records("Bills", &[json!({"id": "INV-NLR-251120260005"})], "t").unwrap();
        std::fs::write(py.join("json").join("bills.json"), r#"[{"id": "INV-NLR-251120260009"}]"#).unwrap();
        let q2 = queue_bill(&db, "u1", &bill("r2", "p1", 1), &py, noon()).unwrap().unwrap();
        assert_eq!(q2.bill_id, "INV-NLR-251120260010", "after the highest number known from anywhere");
        assert_eq!(serial("INV-NLR-25112026001", "INV-NLR-25112026"), 0, "only exact 4-digit serials count");
    }

    #[test]
    fn the_same_request_twice_is_the_same_bill_and_bad_payloads_are_left_to_python() {
        let db = db_with_store();
        let py = pydir("same", None);
        let a = queue_bill(&db, "u1", &bill("same", "p1", 1), &py, noon()).unwrap().unwrap();
        let b = queue_bill(&db, "u1", &bill("same", "p1", 1), &py, noon()).unwrap().unwrap();
        assert!(a.new && !b.new);
        assert_eq!(a.bill_id, b.bill_id);
        assert_eq!(queued_answer(&a)["queued"], true);
        assert!(queue_bill(&db, "u1", &json!({"store_id": "s1", "items": []}), &py, noon()).unwrap().is_none());
        assert!(queue_bill(&db, "u1", &json!({"items": [{"product_id": "p1"}]}), &py, noon()).unwrap().is_none());
        assert_eq!(counts(&db), (1, 0));
    }

    #[test]
    fn offline_sales_come_off_the_product_list_never_below_zero() {
        let db = db_with_store();
        let py = pydir("stock", None);
        queue_bill(&db, "u1", &bill("a", "p1", 2), &py, noon()).unwrap();
        queue_bill(&db, "u1", &bill("b", "p1", 1), &py, noon()).unwrap();
        queue_bill(&db, "u1", &bill("c", "p2", 9), &py, noon()).unwrap();
        let sold = sold_since(&db, "s1", "2026-11-25 00:00:00");
        assert_eq!(sold.get("p1"), Some(&3.0));
        let list = json!([{"id": "p1", "stock": 5, "quantity": 5}, {"id": "p2", "stock": 4}, {"id": "p3", "stock": 1}]);
        let out: Value = serde_json::from_slice(&adjust_products(list.to_string().as_bytes(), &sold)).unwrap();
        assert_eq!((out[0]["stock"].clone(), out[0]["quantity"].clone()), (json!(2), json!(2)));
        assert_eq!(out[1]["stock"], 0, "never below zero");
        assert_eq!(out[2]["stock"], 1, "untouched");
        assert!(sold_since(&db, "s1", "2026-11-26 00:00:00").is_empty(), "only sales after the remembered list");
    }

    /// A stand-in for siri-api's replay route.
    async fn fake_replay(seen: Arc<Mutex<Vec<Value>>>, answer: Arc<Mutex<(u16, Value)>>) -> String {
        let app = Router::new().route("/api/store/replay/bills", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let (seen, answer) = (seen.clone(), answer.clone());
            async move {
                assert_eq!(headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer pass-s1"));
                seen.lock().unwrap().push(body.clone());
                let (code, mut a) = answer.lock().unwrap().clone();
                if a.get("bill_id").is_none() {
                    a["bill_id"] = body["forced_bill_id"].clone();
                }
                (StatusCode::from_u16(code).unwrap(), Json(a))
            }
        }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        base
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn queued_bills_are_sent_once_with_their_number_and_a_refusal_is_kept_for_a_person() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let answer = Arc::new(Mutex::new((201u16, json!({}))));
        let base = fake_replay(seen.clone(), answer.clone()).await;
        let (first, second, third, after) = tokio::task::spawn_blocking(move || {
            let db = db_with_store();
            let py = pydir("replay", Some(json!({"replay_by_user": {"u1": {"s1": "pass-s1"}}})));
            queue_bill(&db, "u1", &bill("x1", "p1", 1), &py, noon()).unwrap();
            queue_bill(&db, "u1", &bill("x2", "p1", 1), &py, noon()).unwrap();
            let first = replay_once(&db, &py, &base);
            let second = replay_once(&db, &py, &base);                     // nothing left: nothing is sent again
            *answer.lock().unwrap() = (409, json!({"code": "conflict"}));
            queue_bill(&db, "u1", &bill("x3", "p1", 1), &py, noon()).unwrap();
            let third = replay_once(&db, &py, &base);
            (first, second, third, counts(&db))
        }).await.unwrap();
        assert_eq!(first.len(), 2);
        assert!(first.iter().all(|(_, o)| o.starts_with("sent as INV-NLR-2511202600")));
        assert!(second.is_empty());
        assert_eq!(third[0].1, "needs attention (HTTP 409)");
        assert_eq!(after, (0, 1), "the refused bill is kept, not dropped");
        let sent = seen.lock().unwrap();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0]["forced_bill_id"], "INV-NLR-251120260001");
        assert_eq!(sent[0]["_client_request_id"], "x1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn without_a_replay_pass_or_internet_the_bills_wait() {
        let (no_pass, no_net, left) = tokio::task::spawn_blocking(|| {
            let db = db_with_store();
            let py = pydir("wait", None);
            queue_bill(&db, "u1", &bill("w1", "p1", 1), &py, noon()).unwrap();
            let no_pass = replay_once(&db, &py, "http://127.0.0.1:9");
            let py2 = pydir("wait2", Some(json!({"replay_tokens": {"s1": "pass-s1"}})));
            let no_net = replay_once(&db, &py2, "http://127.0.0.1:9");    // nothing listens there
            (no_pass, no_net, counts(&db))
        }).await.unwrap();
        assert!(no_pass[0].1.starts_with("waiting for a replay pass"));
        assert_eq!(no_net[0].1, "no answer: will retry");
        assert_eq!(left, (1, 0));
    }
}

#[cfg(test)]
mod live {
    //! Piece 4 against a REAL siri-api (SIRI_LIVE_API) with a store login + replay passes in SIRI_LIVE_PYDATA.
    //! Makes ONE real bill on the store of that login (use the Mypadu TEST store only; clean up afterwards).
    //! cargo test --bin app offline_bills::live -- --ignored --nocapture
    use super::*;

    #[test]
    #[ignore]
    fn an_offline_bill_is_queued_then_sent_once_through_the_real_replay_route() {
        let api = std::env::var("SIRI_LIVE_API").expect("SIRI_LIVE_API");
        let py = std::path::PathBuf::from(std::env::var("SIRI_LIVE_PYDATA").expect("SIRI_LIVE_PYDATA"));
        let store = std::env::var("SIRI_LIVE_STORE").expect("SIRI_LIVE_STORE");
        let user = std::env::var("SIRI_LIVE_USER").expect("SIRI_LIVE_USER");
        let product = std::env::var("SIRI_LIVE_PRODUCT").expect("SIRI_LIVE_PRODUCT");
        let db = OfflineDb::open_in_memory().unwrap();
        crate::rust_sync::run_once(&db, &py, &api);                     // the store code and today's bills
        let payload = json!({
            "store_id": store, "customer_name": "Walk-in Customer", "customer_phone": "", "subtotal": 42.86,
            "tax_percentage": 0, "tax_amount": 2.14, "discount_percentage": 0, "discount_amount": 0, "total_amount": 45,
            "payment_method": "Cash", "notes": "", "timestamp": Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "_client_request_id": format!("rust-live-{}", std::process::id()),
            "items": [{"product_id": product, "quantity": 1, "unit_price": 42.86, "item_total": 42.86,
                       "tax_percentage": 5, "hsn_code": "", "name": "", "barcode": ""}]
        });
        let q = queue_bill(&db, &user, &payload, &py, Utc::now()).unwrap().unwrap();
        println!("queued offline: {} ({})", q.bill_id, q.queue_id);
        let again = queue_bill(&db, &user, &payload, &py, Utc::now()).unwrap().unwrap();
        assert_eq!(again.bill_id, q.bill_id);
        let sent = replay_once(&db, &py, &api);
        println!("first send: {:?}", sent);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, format!("sent as {}", q.bill_id), "saved under the number the receipt shows");
        let nothing = replay_once(&db, &py, &api);
        println!("second send: {:?}", nothing);
        assert!(nothing.is_empty(), "a sent bill is never sent again");
        println!("BILL_ID={}", q.bill_id);
    }
}
