//! Rust offline mode, piece 5: the other actions a store does with no internet, kept and sent later.
//!
//!   damaged return        POST /api/store-damage-returns          one queued row per product  (id SDR-...)
//!   return order          POST /api/return-orders                 one queued order             (id RET-...)
//!   transfer verify       POST /api/transfer-orders/<id>/verify   one queued verification      (verification_session_id)
//!                         POST /api/transfer-orders/verify-batch  one per order, session "<batch>-<order>"
//!
//! * The screen gets the same answer the Python side gives offline (202, `queued: true`), after the same checks.
//! * Each action keeps its own request id, sent to siri-api as it is, so siri-api never does one twice (a repeat is
//!   answered with what it already made).
//! * Every minute, while online, they go to siri-api's replay routes with the cashier's replay pass, by the same
//!   rules as bills: a refused pass waits for the next login, a real "no" (4xx) is kept as "needs attention" for a
//!   person (never dropped), a "not yet" (retryable) or anything else is tried again.
//! * Until sent they show in the damaged-returns and return-orders lists, and damaged quantities come off the stock
//!   shown offline (together with the offline sales).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::offline_db::OfflineDb;
use crate::store_log;

pub const DAMAGE: &str = "damage_return";
pub const RETURN_ORDER: &str = "return_order";
pub const TRANSFER: &str = "transfer";
const TRANSFER_MESSAGE: &str = "System offline. Transfer verification queued and will sync automatically.";
const REASON_TYPES: [&str; 4] = ["damaged", "modification", "low_sales", "other"];

fn stamp(now: chrono::DateTime<Utc>) -> String {
    now.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// The time format the Python side writes into rows (datetime.now(timezone.utc).isoformat()).
fn iso(now: chrono::DateTime<Utc>) -> String {
    now.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

/// `bytes` random bytes as upper-case hex, from SQLite's random source.
fn random_hex(c: &Connection, bytes: i64) -> rusqlite::Result<String> {
    c.query_row("SELECT hex(randomblob(?1))", params![bytes], |r| r.get(0))
}

fn text(v: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str)).unwrap_or("").trim().to_string()
}

/// int(item.get("quantity") or 0), tolerant of "2" and 2.0.
fn qty(v: &Value) -> i64 {
    match v.get("quantity") {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<f64>().map(|f| f as i64).unwrap_or(0),
        _ => 0,
    }
}

fn bad(message: &str) -> (u16, Value) {
    (400, json!({"message": message}))
}

fn no_store() -> (u16, Value) {
    (404, json!({"message": "No store assigned to this user"}))
}

/// Save one action. When the same (kind, request id) was saved before, nothing new is saved and its first answer
/// is returned.
#[allow(clippy::too_many_arguments)]
fn save(tx: &Connection, kind: &str, request_id: &str, user_id: &str, store_id: &str, target: &str, body: &Value,
        answer: &Value, now: chrono::DateTime<Utc>) -> rusqlite::Result<Value> {
    if let Some(old) = tx.query_row("SELECT answer FROM offline_actions WHERE kind = ?1 AND request_id = ?2",
                                    params![kind, request_id], |r| r.get::<_, String>(0)).optional()? {
        return Ok(serde_json::from_str(&old).unwrap_or(Value::Null));
    }
    let queue_id = answer.get("queue_id").and_then(Value::as_str).unwrap_or("").to_string();
    tx.execute(
        "INSERT INTO offline_actions (queue_id, kind, request_id, user_id, store_id, target, body, answer, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![queue_id, kind, request_id, user_id, store_id, target, body.to_string(), answer.to_string(), stamp(now)],
    )?;
    Ok(answer.clone())
}

// ------------------------------------------------------------------------------------------------ damaged returns

/// POST /api/store-damage-returns with no internet: (HTTP status, answer), as the Python side gives them.
pub fn damage_returns(db: &OfflineDb, user_id: &str, data: &Value, now: chrono::DateTime<Utc>) -> rusqlite::Result<(u16, Value)> {
    let items = data.get("selectedItems").and_then(Value::as_array).cloned().unwrap_or_default();
    let reason = text(data, &["reason"]);
    let mut reason_type = text(data, &["reasonType", "reason_type"]).to_lowercase();
    let origin = match text(data, &["damageOrigin"]).to_lowercase() {
        o if o.is_empty() => "store".to_string(),
        o => o,
    };
    if origin != "store" && origin != "transport" {
        return Ok(bad("damageOrigin must be 'store' or 'transport'"));
    }
    if items.is_empty() {
        return Ok(bad("selectedItems is required"));
    }
    if reason.is_empty() {
        return Ok(bad("reason is required"));
    }
    if reason_type.is_empty() {
        let low = reason.to_lowercase();
        reason_type = if low.contains("damage") { "damaged" } else if low.contains("modif") { "modification" }
                      else if low.contains("sale") { "low_sales" } else { "other" }.to_string();
    }
    if !REASON_TYPES.contains(&reason_type.as_str()) {
        return Ok(bad("reasonType must be damaged, modification, low_sales, or other"));
    }
    let Some(store_id) = crate::offline_bills::store_of(db, user_id) else { return Ok(no_store()) };
    let when = iso(now);
    let note_all = text(data, &["note"]);
    db.with_conn(|c| {
        let tx = c.transaction()?;
        let mut rows = Vec::new();
        for item in &items {
            let product_id = text(item, &["productId", "product_id"]);
            let quantity = qty(item);
            if product_id.is_empty() || quantity <= 0 {
                continue;
            }
            let note = match text(item, &["note"]) {
                n if n.is_empty() => note_all.clone(),
                n => n,
            };
            let id = format!("SDR-{}", random_hex(&tx, 6)?);
            let row = json!({
                "id": id, "store_id": store_id, "product_id": product_id, "quantity": quantity, "reason": reason,
                "reason_type": reason_type, "damage_origin": origin, "status": "sent_to_admin",
                "resolution_status": "pending", "notes": note, "created_by": user_id, "created_at": when, "updated_at": when,
                "queued": true, "queue_id": format!("QDR-{}", random_hex(&tx, 6)?.to_lowercase()),
            });
            // the request siri-api takes (services/siri_writes.py damage_return_request): the row id is the request id
            let body = json!({
                "selectedItems": [{"productId": product_id, "quantity": quantity, "note": note}],
                "reason": reason, "reasonType": reason_type, "damageOrigin": origin, "_client_request_id": id,
            });
            rows.push(save(&tx, DAMAGE, &id, user_id, &store_id, "", &body, &row, now)?);
        }
        if rows.is_empty() {
            return Ok(bad("No valid items to submit"));
        }
        tx.commit()?;
        Ok((202, json!({"message": "Damage return submitted", "count": rows.len(), "queued": true, "rows": rows})))
    })
}

// ------------------------------------------------------------------------------------------------ return orders

/// POST /api/return-orders with no internet.
pub fn return_order(db: &OfflineDb, user_id: &str, data: &Value, now: chrono::DateTime<Utc>) -> rusqlite::Result<(u16, Value)> {
    let items = data.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    if items.is_empty() {
        return Ok(bad("items is required"));
    }
    let Some(store_id) = crate::offline_bills::store_of(db, user_id) else { return Ok(no_store()) };
    let note = text(data, &["note"]);
    let when = iso(now);
    db.with_conn(|c| {
        let tx = c.transaction()?;
        let return_id = format!("RET-{}", random_hex(&tx, 6)?);
        let mut lines = Vec::new();
        let mut total = 0;
        for item in &items {
            let product_id = text(item, &["productId", "product_id"]);
            let quantity = qty(item);
            let mut reason_type = match text(item, &["reasonType", "reason_type"]).to_lowercase() {
                r if r.is_empty() => "other".to_string(),
                r => r,
            };
            if !REASON_TYPES.contains(&reason_type.as_str()) {
                reason_type = "other".into();
            }
            let reason = text(item, &["reason"]);
            if product_id.is_empty() || quantity <= 0 {
                continue;
            }
            total += quantity;
            lines.push(json!({
                "id": format!("RP-{}", random_hex(&tx, 6)?), "return_id": return_id, "product_id": product_id,
                "quantity": quantity, "reason": if reason.is_empty() { reason_type.clone() } else { reason },
                "reason_type": reason_type, "verify_status": "pending", "verified_qty": 0, "holding_status": "in_transit",
                "notes": text(item, &["note"]), "created_at": when, "updated_at": when,
            }));
        }
        if lines.is_empty() {
            return Ok(bad("No valid items to submit"));
        }
        let header = json!({
            "return_id": return_id, "store_id": store_id, "created_by": user_id, "return_type": "store_to_admin",
            "admin_status": "sent_to_admin", "return_quantity": total, "message": note, "created_at": when, "updated_at": when,
        });
        // the request siri-api takes (services/siri_writes.py return_order_request): the return id is the request id
        let body = json!({
            "items": lines.iter().map(|ln| json!({"productId": ln["product_id"], "quantity": ln["quantity"],
                "reasonType": ln["reason_type"], "reason": ln["reason"], "note": ln["notes"]})).collect::<Vec<_>>(),
            "note": note, "_client_request_id": return_id,
        });
        let kept = json!({"queue_id": format!("QRO-{}", random_hex(&tx, 6)?.to_lowercase()), "return": header, "items": lines});
        let kept = save(&tx, RETURN_ORDER, &return_id, user_id, &store_id, "", &body, &kept, now)?;
        tx.commit()?;
        Ok((202, json!({"message": "Return order submitted", "queued": true, "count": lines.len(),
                        "return": kept["return"], "items": kept["items"]})))
    })
}

// ------------------------------------------------------------------------------------------------ transfer verification

fn queue_transfer(tx: &Connection, user_id: &str, store_id: &str, order_id: &str, data: &Value,
                  now: chrono::DateTime<Utc>) -> rusqlite::Result<Value> {
    let mut body = if data.is_object() { data.clone() } else { json!({}) };
    let mut session = text(&body, &["verification_session_id"]);
    if session.is_empty() {
        session = format!("ver-{}", random_hex(tx, 8)?.to_lowercase());
        body["verification_session_id"] = json!(session);
    }
    let answer = json!({"queued": true, "queue_id": format!("QTV-{}", random_hex(tx, 6)?.to_lowercase()),
                        "verification_session_id": session, "message": TRANSFER_MESSAGE});
    save(tx, TRANSFER, &session, user_id, store_id, order_id, &body, &answer, now)
}

/// POST /api/transfer-orders/<order_id>/verify with no internet.
pub fn transfer_verify(db: &OfflineDb, user_id: &str, order_id: &str, data: &Value, now: chrono::DateTime<Utc>)
                       -> rusqlite::Result<(u16, Value)> {
    let Some(store_id) = crate::offline_bills::store_of(db, user_id) else { return Ok(no_store()) };
    db.with_conn(|c| {
        let tx = c.transaction()?;
        let answer = queue_transfer(&tx, user_id, &store_id, order_id, data, now)?;
        tx.commit()?;
        Ok((202, answer))
    })
}

/// POST /api/transfer-orders/verify-batch with no internet (same counting as the Python side).
pub fn transfer_batch(db: &OfflineDb, user_id: &str, data: &Value, now: chrono::DateTime<Utc>) -> rusqlite::Result<(u16, Value)> {
    let verifications = data.get("verifications").and_then(Value::as_array).cloned().unwrap_or_default();
    let batch = text(data, &["verification_session_id"]);
    if batch.is_empty() {
        return Ok(bad("verification_session_id is required"));
    }
    if verifications.is_empty() {
        return Ok(bad("verifications array is required"));
    }
    let Some(store_id) = crate::offline_bills::store_of(db, user_id) else { return Ok(no_store()) };
    db.with_conn(|c| {
        let tx = c.transaction()?;
        let (mut results, mut queued, mut failed) = (Vec::new(), 0, 0);
        for (index, v) in verifications.iter().enumerate() {
            let order_id = text(v, &["order_id", "orderId"]);
            if order_id.is_empty() {
                failed += 1;
                results.push(json!({"index": index, "status": "failed", "message": "order_id is required", "status_code": 400}));
                continue;
            }
            let payload = json!({
                "verification_session_id": format!("{batch}-{order_id}"),
                "items": v.get("items").cloned().filter(Value::is_array).unwrap_or(json!([])),
                "scans": v.get("scans").cloned().filter(Value::is_array).unwrap_or(json!([])),
            });
            let answer = queue_transfer(&tx, user_id, &store_id, &order_id, &payload, now)?;
            queued += 1;
            let mut row = json!({"index": index, "order_id": order_id, "status": "queued", "status_code": 202});
            if let (Some(r), Some(a)) = (row.as_object_mut(), answer.as_object()) {
                r.extend(a.clone());
            }
            results.push(row);
        }
        tx.commit()?;
        let status = match (failed, queued) {
            (0, 0) => 200,
            (0, _) => 202,
            (_, 0) => 400,
            _ => 207,
        };
        Ok((status, json!({
            "message": "Batch verification processed", "verification_session_id": batch,
            "success_count": 0, "failed_count": failed, "duplicate_count": 0, "queued_count": queued,
            "queued": queued > 0, "results": results, "reconcile": Value::Null,
        })))
    })
}

// ------------------------------------------------------------------------------------------------ lists and stock

/// (kept answer, status) of every action of `kind` at `store_id` not sent yet, newest first.
fn unsent(db: &OfflineDb, kind: &str, store_id: &str) -> Vec<(Value, String)> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT answer, status FROM offline_actions WHERE kind = ?1 AND store_id = ?2
             AND status IN ('queued', 'needs_attention') ORDER BY created_at DESC, queue_id DESC")?;
        let rows = stmt.query_map(params![kind, store_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.flatten().map(|(a, s)| (serde_json::from_str(&a).unwrap_or(Value::Null), s)).collect())
    }).unwrap_or_default()
}

fn product_brief(products: &[Value], product_id: &str) -> Value {
    products.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(product_id))
        .map(|p| json!({"id": p.get("id"), "name": p.get("name"), "barcode": p.get("barcode"),
                        "selling_price": p.get("selling_price")}))
        .unwrap_or(Value::Null)
}

/// The damaged-returns list (GET /api/store-damage-returns) with the rows made offline put in front.
/// `status` is the screen's filter (a queued row is "sent_to_admin"). Anything not understood: unchanged.
pub fn merge_damage_list(db: &OfflineDb, user_id: &str, body: &[u8], status: Option<&str>) -> Vec<u8> {
    let Some(store_id) = crate::offline_bills::store_of(db, user_id) else { return body.to_vec() };
    let Ok(Value::Array(list)) = serde_json::from_slice::<Value>(body) else { return body.to_vec() };
    let have: std::collections::HashSet<String> =
        list.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let products = db.records("Products").ok().unwrap_or_default();
    let store_name = db.records("Stores").ok().unwrap_or_default().into_iter()
        .find(|s| s.get("id").and_then(Value::as_str) == Some(store_id.as_str()))
        .and_then(|s| s.get("name").cloned()).unwrap_or(Value::Null);
    let mut out = Vec::new();
    for (mut row, state) in unsent(db, DAMAGE, &store_id) {
        let id = row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let filtered_out = status.map(|s| row.get("status").and_then(Value::as_str) != Some(s)).unwrap_or(false);
        if id.is_empty() || have.contains(&id) || filtered_out {
            continue;
        }
        let pid = row.get("product_id").and_then(Value::as_str).unwrap_or("").to_string();
        row["products"] = product_brief(&products, &pid);
        row["stores"] = json!({"id": store_id, "name": store_name});
        row["offline_queued"] = json!(true);
        row["offline_status"] = json!(state);
        out.push(row);
    }
    if out.is_empty() {
        return body.to_vec();
    }
    out.extend(list);
    serde_json::to_vec(&out).unwrap_or_else(|_| body.to_vec())
}

/// The return-orders list (GET /api/return-orders) with the orders made offline put in front.
pub fn merge_return_orders(db: &OfflineDb, user_id: &str, body: &[u8]) -> Vec<u8> {
    let Some(store_id) = crate::offline_bills::store_of(db, user_id) else { return body.to_vec() };
    let Ok(Value::Array(list)) = serde_json::from_slice::<Value>(body) else { return body.to_vec() };
    let have: std::collections::HashSet<String> =
        list.iter().filter_map(|r| r.get("return_id").and_then(Value::as_str).map(str::to_string)).collect();
    let products = db.records("Products").ok().unwrap_or_default();
    let mut out = Vec::new();
    for (kept, state) in unsent(db, RETURN_ORDER, &store_id) {
        let mut header = kept.get("return").cloned().unwrap_or(Value::Null);
        let id = header.get("return_id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() || have.contains(&id) {
            continue;
        }
        let lines: Vec<Value> = kept.get("items").and_then(Value::as_array).cloned().unwrap_or_default().into_iter()
            .map(|mut ln| {
                let pid = ln.get("product_id").and_then(Value::as_str).unwrap_or("").to_string();
                ln["products"] = product_brief(&products, &pid);
                ln
            }).collect();
        header["return_products"] = json!(lines);
        header["offline_queued"] = json!(true);
        header["offline_status"] = json!(state);
        out.push(header);
    }
    if out.is_empty() {
        return body.to_vec();
    }
    out.extend(list);
    serde_json::to_vec(&out).unwrap_or_else(|_| body.to_vec())
}

/// Quantity reported damaged offline per product at this store since `since` ("YYYY-MM-DD HH:MM:SS", UTC): it comes
/// off the shelf stock shown offline, like a sale.
pub fn damaged_since(db: &OfflineDb, store_id: &str, since: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let bodies: Vec<String> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT body FROM offline_actions WHERE kind = ?1 AND store_id = ?2 AND created_at >= ?3 AND status <> 'needs_attention'")?;
        let rows = stmt.query_map(params![DAMAGE, store_id, since], |r| r.get::<_, String>(0))?;
        Ok(rows.flatten().collect())
    }).unwrap_or_default();
    for b in bodies {
        let Ok(v) = serde_json::from_str::<Value>(&b) else { continue };
        for item in v.get("selectedItems").and_then(Value::as_array).cloned().unwrap_or_default() {
            let pid = text(&item, &["productId"]);
            let q = qty(&item) as f64;
            if !pid.is_empty() && q > 0.0 {
                *out.entry(pid).or_insert(0.0) += q;
            }
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------ status and replay

/// Waiting / needing a person, and which ones need a person (for the status note).
pub fn status(db: &OfflineDb) -> Value {
    db.with_conn(|c| {
        let waiting: i64 = c.query_row("SELECT COUNT(*) FROM offline_actions WHERE status = 'queued'", [], |r| r.get(0))?;
        let mut stmt = c.prepare(
            "SELECT kind, request_id, attempts, last_error, created_at FROM offline_actions WHERE status = 'needs_attention'
             ORDER BY created_at")?;
        let needing: Vec<Value> = stmt.query_map([], |r| Ok(json!({"kind": r.get::<_, String>(0)?, "id": r.get::<_, String>(1)?,
            "attempts": r.get::<_, i64>(2)?, "error": r.get::<_, Option<String>>(3)?, "made_at": r.get::<_, String>(4)?})))?
            .flatten().collect();
        Ok(json!({"waiting": waiting, "needs_attention": needing.len(), "needing_attention": needing}))
    }).unwrap_or_else(|_| json!({"waiting": 0, "needs_attention": 0, "needing_attention": []}))
}

fn replay_path(kind: &str, target: &str) -> Option<String> {
    match kind {
        DAMAGE => Some("/api/store/replay/damage-returns".into()),
        RETURN_ORDER => Some("/api/store/replay/return-orders".into()),
        TRANSFER if !target.is_empty() =>
            Some(format!("/api/store/replay/transfer-orders/{}/verify", urlencoding::encode(target))),
        _ => None,
    }
}

type QueuedAction = (String, String, String, String, String, String, String);

/// Send queued actions (oldest first). Returns (request id, outcome) for the log and the tests.
pub fn replay_once(db: &OfflineDb, python_dir: &Path, api_base: &str) -> Vec<(String, String)> {
    let queued: Vec<QueuedAction> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT queue_id, kind, request_id, user_id, store_id, target, body FROM offline_actions WHERE status = 'queued'
             ORDER BY created_at, rowid LIMIT 25")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?;
        Ok(rows.flatten().collect())
    }).unwrap_or_default();
    if queued.is_empty() {
        return Vec::new();
    }
    let Ok(client) = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60)).build() else { return Vec::new() };
    let mut outcomes = Vec::new();
    for (queue_id, kind, request_id, user_id, store_id, target, body) in queued {
        let set = |status: &str, error: Option<String>| {
            let _ = db.with_conn(|c| c.execute(
                "UPDATE offline_actions SET status = ?2, attempts = attempts + 1, last_error = ?3, updated_at = ?4 WHERE queue_id = ?1",
                params![queue_id, status, error, stamp(Utc::now())]));
        };
        let Some(path) = replay_path(&kind, &target) else {
            set("needs_attention", Some(format!("cannot send a {kind} with no target")));
            outcomes.push((request_id, "needs attention (cannot send)".into()));
            continue;
        };
        let Some(pass) = crate::offline_bills::replay_pass(python_dir, &user_id, &store_id) else {
            outcomes.push((request_id, "waiting for a replay pass (next online login)".into()));
            continue;
        };
        let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        match client.post(format!("{api_base}{path}")).bearer_auth(&pass).json(&body).send() {
            Ok(r) if r.status().is_success() => {
                // siri-api keeps its own id, derived from the request id (the same every time it is sent)
                let answer: Value = r.json().unwrap_or(Value::Null);
                let server = answer.pointer("/rows/0/id").or_else(|| answer.pointer("/return/return_id"))
                    .or_else(|| answer.get("verification_session_id")).and_then(Value::as_str).map(str::to_string);
                set("sent", None);
                let _ = db.with_conn(|c| c.execute("UPDATE offline_actions SET server_id = ?2 WHERE queue_id = ?1",
                                                   params![queue_id, server]));
                outcomes.push((request_id, "sent".into()));
            }
            Ok(r) if r.status().as_u16() == 401 => {
                outcomes.push((request_id, "replay pass refused: waiting for the next login".into()));
                break;
            }
            Ok(r) if r.status().is_client_error() => {
                let code = r.status().as_u16();
                let text = r.text().unwrap_or_default();
                let answer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let short = format!("HTTP {code}: {}", text.chars().take(300).collect::<String>());
                if answer.get("retryable") == Some(&json!(true)) {
                    set("queued", Some(short));                 // siri-api says "not yet" (e.g. still in progress)
                    outcomes.push((request_id, format!("not yet (HTTP {code}): will retry")));
                } else {
                    set("needs_attention", Some(short));
                    store_log::event("error", "rustactions",
                                     &format!("{kind} {request_id} refused by siri-api (HTTP {code}): kept for a person to check"));
                    outcomes.push((request_id, format!("needs attention (HTTP {code})")));
                }
            }
            Ok(r) => {
                set("queued", Some(format!("HTTP {}", r.status().as_u16())));
                outcomes.push((request_id, "server busy: will retry".into()));
            }
            Err(e) => {
                set("queued", Some(format!("{e}")));
                outcomes.push((request_id, "no answer: will retry".into()));
                break;
            }
        }
    }
    let sent = outcomes.iter().filter(|(_, o)| o == "sent").count();
    store_log::event("info", "rustactions", &format!("offline actions: sent={sent} of {} ({:?})", outcomes.len(), outcomes));
    outcomes
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Path as UrlPath;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use chrono::TimeZone;
    use std::sync::{Arc, Mutex};

    const STORE: &str = "s1";
    const USER: &str = "u1";

    fn db() -> OfflineDb {
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_records("UserStores", &[json!({"id": 1, "userId": USER, "storeId": STORE})], "t").unwrap();
        db.upsert_records("Products", &[json!({"id": "p1", "name": "Ring", "barcode": "B1", "selling_price": 45})], "t").unwrap();
        db.upsert_records("Stores", &[json!({"id": STORE, "name": "Mypadu"})], "t").unwrap();
        db
    }

    fn now() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 25, 10, 0, 0).unwrap()
    }

    fn bodies(db: &OfflineDb, kind: &str) -> Vec<Value> {
        db.with_conn(|c| {
            let mut s = c.prepare("SELECT body FROM offline_actions WHERE kind = ?1 ORDER BY rowid")?;
            let r = s.query_map(params![kind], |r| r.get::<_, String>(0))?;
            Ok(r.flatten().map(|b| serde_json::from_str(&b).unwrap()).collect())
        }).unwrap()
    }

    fn pydir(name: &str, session: Option<Value>) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("offline-actions-{}-{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        match session {
            Some(s) => std::fs::write(d.join("siri_session.json"), s.to_string()).unwrap(),
            None => { let _ = std::fs::remove_file(d.join("siri_session.json")); }
        }
        d
    }

    fn one_item() -> Value {
        json!({"selectedItems": [{"productId": "p1", "quantity": 1}], "reason": "x"})
    }

    #[test]
    fn damage_return_checks_match_python() {
        let db = db();
        assert_eq!(damage_returns(&db, USER, &json!({"selectedItems": [], "reason": "x"}), now()).unwrap().1["message"],
                   "selectedItems is required");
        assert_eq!(damage_returns(&db, USER, &json!({"selectedItems": [{"productId": "p1", "quantity": 1}]}), now()).unwrap().1["message"],
                   "reason is required");
        let mut moon = one_item();
        moon["damageOrigin"] = json!("moon");
        assert_eq!(damage_returns(&db, USER, &moon, now()).unwrap().0, 400);
        let mut odd = one_item();
        odd["reasonType"] = json!("lost");
        assert_eq!(damage_returns(&db, USER, &odd, now()).unwrap().0, 400);
        assert_eq!(damage_returns(&db, USER, &json!({"selectedItems": [{"productId": "p1", "quantity": 0}], "reason": "x"}), now())
                       .unwrap().1["message"], "No valid items to submit");
        assert_eq!(damage_returns(&db, "someone-else", &one_item(), now()).unwrap().0, 404);
        assert!(bodies(&db, DAMAGE).is_empty(), "nothing saved for a refused request");
    }

    #[test]
    fn damage_return_is_queued_with_its_row_id_as_request_id() {
        let db = db();
        let (code, answer) = damage_returns(&db, USER, &json!({"selectedItems": [{"productId": "p1", "quantity": "2", "note": "cracked"}],
                                                               "reason": "Damaged in shop"}), now()).unwrap();
        assert_eq!(code, 202);
        assert_eq!(answer["queued"], true);
        assert_eq!(answer["count"], 1);
        let row = &answer["rows"][0];
        let id = row["id"].as_str().unwrap();
        assert!(id.starts_with("SDR-") && id.len() == 16, "{id}");
        assert_eq!(row["reason_type"], "damaged", "guessed from the reason, like Python");
        assert_eq!(row["store_id"], STORE);
        assert_eq!(row["quantity"], 2);
        assert_eq!(row["created_at"], "2026-11-25T10:00:00.000000+00:00");
        let sent = &bodies(&db, DAMAGE)[0];
        assert_eq!(sent["_client_request_id"], row["id"]);
        assert_eq!(sent["selectedItems"][0], json!({"productId": "p1", "quantity": 2, "note": "cracked"}));
        // the shelf stock shown offline drops by the damaged quantity (only after the remembered list)
        assert_eq!(damaged_since(&db, STORE, "2026-11-25 09:00:00").get("p1"), Some(&2.0));
        assert!(damaged_since(&db, STORE, "2026-11-25 11:00:00").is_empty());
        // the list shows it in front, with the product and store
        let list: Value = serde_json::from_slice(&merge_damage_list(&db, USER, br#"[{"id":"SDR-OLD"}]"#, None)).unwrap();
        assert_eq!(list[0]["id"], row["id"]);
        assert_eq!(list[0]["products"]["name"], "Ring");
        assert_eq!(list[0]["stores"]["name"], "Mypadu");
        assert_eq!(list[0]["offline_queued"], true);
        assert_eq!(list[1]["id"], "SDR-OLD");
        assert_eq!(merge_damage_list(&db, USER, b"[]", Some("approved")), b"[]".to_vec(), "the screen's filter is kept");
        assert_eq!(merge_damage_list(&db, USER, b"{\"x\":1}", None), b"{\"x\":1}".to_vec(), "not a list: unchanged");
    }

    #[test]
    fn return_order_is_queued_with_its_return_id() {
        let db = db();
        assert_eq!(return_order(&db, USER, &json!({"items": []}), now()).unwrap().1["message"], "items is required");
        let (code, answer) = return_order(&db, USER, &json!({"note": "  back to admin ", "items": [
            {"productId": "p1", "quantity": 3, "reasonType": "WEIRD"}, {"productId": "", "quantity": 1}]}), now()).unwrap();
        assert_eq!(code, 202);
        assert_eq!(answer["count"], 1);
        let rid = answer["return"]["return_id"].as_str().unwrap().to_string();
        assert!(rid.starts_with("RET-"));
        assert_eq!(answer["return"]["return_quantity"], 3);
        assert_eq!(answer["return"]["message"], "back to admin");
        assert_eq!(answer["items"][0]["reason_type"], "other");
        assert_eq!(answer["items"][0]["reason"], "other");
        let sent = &bodies(&db, RETURN_ORDER)[0];
        assert_eq!(sent["_client_request_id"], rid);
        assert_eq!(sent["items"][0]["productId"], "p1");
        let list: Value = serde_json::from_slice(&merge_return_orders(&db, USER, b"[]")).unwrap();
        assert_eq!(list[0]["return_id"], rid);
        assert_eq!(list[0]["return_products"][0]["products"]["barcode"], "B1");
        assert_eq!(list[0]["offline_status"], "queued");
        let both: Value = serde_json::from_slice(&merge_return_orders(&db, USER, format!(r#"[{{"return_id":"{rid}"}}]"#).as_bytes())).unwrap();
        assert_eq!(both.as_array().unwrap().len(), 1, "already in the online list: not doubled");
        assert!(damaged_since(&db, STORE, "2026-11-25 00:00:00").is_empty(), "a return order does not change stock");
    }

    #[test]
    fn transfer_verify_keeps_its_session_and_a_repeat_is_the_same() {
        let db = db();
        let data = json!({"verification_session_id": "ver-abc", "items": [{"product_id": "p1", "verified_qty": 2}]});
        let (code, first) = transfer_verify(&db, USER, "TO-1", &data, now()).unwrap();
        assert_eq!(code, 202);
        assert_eq!(first["verification_session_id"], "ver-abc");
        assert_eq!(first["message"], TRANSFER_MESSAGE);
        let (_, again) = transfer_verify(&db, USER, "TO-1", &data, now()).unwrap();
        assert_eq!(again["queue_id"], first["queue_id"]);
        assert_eq!(bodies(&db, TRANSFER).len(), 1, "the same session is saved once");
        let (_, made) = transfer_verify(&db, USER, "TO-2", &json!({"items": []}), now()).unwrap();
        assert!(made["verification_session_id"].as_str().unwrap().starts_with("ver-"), "no session given: one is made");
        assert_eq!(bodies(&db, TRANSFER)[1]["verification_session_id"], made["verification_session_id"]);
        assert_eq!(replay_path(TRANSFER, "TO 1/x").unwrap(), "/api/store/replay/transfer-orders/TO%201%2Fx/verify");
    }

    #[test]
    fn transfer_batch_counts_like_python() {
        let db = db();
        assert_eq!(transfer_batch(&db, USER, &json!({"verifications": [{}]}), now()).unwrap().1["message"],
                   "verification_session_id is required");
        let (code, answer) = transfer_batch(&db, USER, &json!({"verification_session_id": "B1",
            "verifications": [{"order_id": "TO-1", "items": [{"x": 1}]}, {"items": []}]}), now()).unwrap();
        assert_eq!(code, 207);
        assert_eq!(answer["queued_count"], 1);
        assert_eq!(answer["failed_count"], 1);
        assert_eq!(answer["results"][0]["verification_session_id"], "B1-TO-1");
        assert_eq!(answer["results"][0]["status"], "queued");
        assert_eq!(answer["results"][1]["status"], "failed");
        let (code, _) = transfer_batch(&db, USER, &json!({"verification_session_id": "B2", "verifications": [{"orderId": "TO-9"}]}), now()).unwrap();
        assert_eq!(code, 202);
        assert_eq!(status(&db)["waiting"], 2);
    }

    /// A stand-in for siri-api's three replay routes.
    async fn fake_replay(seen: Arc<Mutex<Vec<(String, Value)>>>, answer: Arc<Mutex<(u16, Value)>>) -> String {
        let note = |seen: Arc<Mutex<Vec<(String, Value)>>>, answer: Arc<Mutex<(u16, Value)>>, path: String, headers: HeaderMap, body: Value| {
            assert_eq!(headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer pass-s1"));
            seen.lock().unwrap().push((path, body));
            let (code, a) = answer.lock().unwrap().clone();
            (StatusCode::from_u16(code).unwrap(), Json(a))
        };
        let (s1, a1, s2, a2, s3, a3) = (seen.clone(), answer.clone(), seen.clone(), answer.clone(), seen, answer);
        let app = Router::new()
            .route("/api/store/replay/damage-returns", post(move |h: HeaderMap, Json(b): Json<Value>| {
                let r = note(s1.clone(), a1.clone(), "damage".into(), h, b); async move { r }
            }))
            .route("/api/store/replay/return-orders", post(move |h: HeaderMap, Json(b): Json<Value>| {
                let r = note(s2.clone(), a2.clone(), "return".into(), h, b); async move { r }
            }))
            .route("/api/store/replay/transfer-orders/{id}/verify", post(move |UrlPath(id): UrlPath<String>, h: HeaderMap, Json(b): Json<Value>| {
                let r = note(s3.clone(), a3.clone(), format!("transfer {id}"), h, b); async move { r }
            }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        base
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn queued_actions_are_sent_once_to_their_routes_and_a_refusal_is_kept() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let answer = Arc::new(Mutex::new((201u16, json!({"ok": true}))));
        let base = fake_replay(seen.clone(), answer.clone()).await;
        let (first, second, later, not_yet, st) = tokio::task::spawn_blocking(move || {
            let db = db();
            let py = pydir("replay", Some(json!({"replay_by_user": {USER: {STORE: "pass-s1"}}})));
            damage_returns(&db, USER, &one_item(), now()).unwrap();
            return_order(&db, USER, &json!({"items": [{"productId": "p1", "quantity": 1}]}), now()).unwrap();
            transfer_verify(&db, USER, "TO-7", &json!({"verification_session_id": "ver-7"}), now()).unwrap();
            let first = replay_once(&db, &py, &base);
            let second = replay_once(&db, &py, &base);                 // nothing left: nothing is sent again
            *answer.lock().unwrap() = (409, json!({"code": "conflict", "message": "no"}));
            transfer_verify(&db, USER, "TO-8", &json!({"verification_session_id": "ver-8"}), now()).unwrap();
            let later = replay_once(&db, &py, &base);
            *answer.lock().unwrap() = (409, json!({"code": "in_progress", "retryable": true}));
            transfer_verify(&db, USER, "TO-9", &json!({"verification_session_id": "ver-9"}), now()).unwrap();
            let not_yet = replay_once(&db, &py, &base);
            (first, second, later, not_yet, status(&db))
        }).await.unwrap();
        assert_eq!(first.len(), 3);
        assert!(first.iter().all(|(_, o)| o == "sent"), "{first:?}");
        assert!(second.is_empty());
        assert_eq!(later[0], ("ver-8".to_string(), "needs attention (HTTP 409)".to_string()));
        assert_eq!(not_yet[0].1, "not yet (HTTP 409): will retry");
        assert_eq!(st["waiting"], 1, "the 'not yet' one waits");
        assert_eq!(st["needs_attention"], 1, "the refused one is kept, not dropped");
        assert_eq!(st["needing_attention"][0]["id"], "ver-8");
        let sent = seen.lock().unwrap();
        assert_eq!(sent.len(), 5);
        assert_eq!(sent[0].0, "damage");
        assert!(sent[0].1["_client_request_id"].as_str().unwrap().starts_with("SDR-"));
        assert_eq!(sent[1].0, "return");
        assert!(sent[1].1["_client_request_id"].as_str().unwrap().starts_with("RET-"));
        assert_eq!(sent[2], ("transfer TO-7".to_string(), json!({"verification_session_id": "ver-7"})));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn without_a_replay_pass_or_internet_the_actions_wait() {
        let (no_pass, no_net, st) = tokio::task::spawn_blocking(|| {
            let db = db();
            damage_returns(&db, USER, &one_item(), now()).unwrap();
            let no_pass = replay_once(&db, &pydir("nopass", None), "http://127.0.0.1:9");
            let py = pydir("nonet", Some(json!({"replay_tokens": {STORE: "pass-s1"}})));
            let no_net = replay_once(&db, &py, "http://127.0.0.1:9");      // nothing listens there
            (no_pass, no_net, status(&db))
        }).await.unwrap();
        assert!(no_pass[0].1.starts_with("waiting for a replay pass"));
        assert_eq!(no_net[0].1, "no answer: will retry");
        assert_eq!(st["waiting"], 1);
        assert_eq!(st["needs_attention"], 0);
    }
}

#[cfg(test)]
mod live {
    //! Against a REAL siri-api (piece 5 live test, test store only). Needs SIRI_LIVE_API (e.g. http://127.0.0.1:5055),
    //! SIRI_LIVE_PYDATA (a folder with siri_session.json from the test cashier's login), SIRI_LIVE_STORE,
    //! SIRI_LIVE_USER, SIRI_LIVE_PRODUCT.  cargo test --bin app offline_actions::live -- --ignored --nocapture
    use super::*;

    #[test]
    #[ignore]
    fn a_damaged_return_and_a_return_order_are_queued_then_sent_once_through_the_real_replay_routes() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
        let (api, py, store, user, product) =
            (env("SIRI_LIVE_API"), env("SIRI_LIVE_PYDATA"), env("SIRI_LIVE_STORE"), env("SIRI_LIVE_USER"), env("SIRI_LIVE_PRODUCT"));
        let db = OfflineDb::open_in_memory().unwrap();
        db.upsert_records("UserStores", &[json!({"id": 1, "userId": user, "storeId": store})], "t").unwrap();
        let (c1, a1) = damage_returns(&db, &user, &json!({"selectedItems": [{"productId": product, "quantity": 1, "note": "piece5 live"}],
                                                          "reason": "damaged (piece 5 live test)"}), Utc::now()).unwrap();
        let (c2, a2) = return_order(&db, &user, &json!({"note": "piece 5 live test", "items": [{"productId": product, "quantity": 1}]}),
                                    Utc::now()).unwrap();
        assert_eq!((c1, c2), (202, 202));
        println!("DAMAGE_ID={}", a1["rows"][0]["id"].as_str().unwrap());
        println!("RETURN_ID={}", a2["return"]["return_id"].as_str().unwrap());
        let first = replay_once(&db, Path::new(&py), &api);
        println!("first send: {first:?}");
        assert!(first.len() == 2 && first.iter().all(|(_, o)| o == "sent"), "{first:?}");
        assert!(replay_once(&db, Path::new(&py), &api).is_empty(), "nothing is sent twice");
        // the same rows sent again by hand: siri-api answers with what it already made (no second row)
        db.with_conn(|c| c.execute("UPDATE offline_actions SET status = 'queued'", [])).unwrap();
        let resend = replay_once(&db, Path::new(&py), &api);
        println!("resend: {resend:?}");
        assert!(resend.iter().all(|(_, o)| o == "sent"), "{resend:?}");
    }
}
