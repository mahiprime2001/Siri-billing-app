//! Rust offline mode, piece 6: Rust talks to siri-api itself. No Python.
//!
//! With the store's `rust_direct` switch on (and `rust_front`), the app does not start the Python backend. Every
//! screen still calls http://localhost:8080/api/... exactly as before; Rust answers:
//!
//! * LOGIN. Online, siri-api checks the password; Rust keeps the siri-api token and the replay passes and gives the
//!   screen its own session token (the screens only store it and send it back). Offline, the scrambled copy is
//!   checked (piece 2/3) and the password is kept in memory only, so siri-api can be logged in to as soon as the
//!   internet is back. A session ends after 2 hours without use (as Python's token did), or at logout.
//! * ONLINE: each route is sent to its siri-api route (the same mapping Python's @via_siri_api used), with the
//!   person's siri-api token. A token siri-api renews (X-Access-Token) is kept.
//! * WRITES carry a request id. If siri-api's answer is lost (or the internet drops), the write goes into the offline
//!   queue with the SAME id, so it is sent later and never done twice (pieces 4 and 5). A write that has no queue
//!   gets "the server did not confirm, try again" (siri-api's own guards make pressing again safe).
//! * OFFLINE: pieces 3-5 answer (remembered reads, queued bills and actions); anything else says "needs internet".
//! * Rust also answers what Python did on its own: /api/health, /api/sync/*, /api/auth/*, the live stock stream.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use chrono::Utc;
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::offline_db::OfflineDb;
use crate::store_log;

const SESSION_IDLE_SECONDS: i64 = 2 * 3600;
const WRITE_TIMEOUT: Duration = Duration::from_secs(25);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15);
const RELOGIN_EVERY: Duration = Duration::from_secs(30);
const APPROVAL_FOR: Duration = Duration::from_secs(10 * 60);
pub const OFFLINE_MESSAGE: &str = "No internet: this needs the internet. Please try again when it is back.";

static DIRECT: AtomicBool = AtomicBool::new(false);
static API: OnceLock<String> = OnceLock::new();
static OWN_SWITCHES: OnceLock<PathBuf> = OnceLock::new();
/// email -> (password, last try). Only for people who logged in OFFLINE; memory only, never on disk.
static PASSWORDS: OnceLock<Mutex<HashMap<String, (String, Option<Instant>)>>> = OnceLock::new();
/// user id -> (approved by, signed approval, until): a manager's discount code given before the bill exists.
static APPROVALS: OnceLock<Mutex<HashMap<String, Approval>>> = OnceLock::new();
static STOCK: OnceLock<tokio::sync::broadcast::Sender<String>> = OnceLock::new();

type Approval = (Value, String, Instant);

pub fn is_direct() -> bool {
    DIRECT.load(Ordering::Relaxed)
}

/// Turn direct mode on (called once at start). `own_switches`: where the last known switches are kept.
pub fn start(api_base: &str, own_switches: PathBuf) {
    let _ = API.set(api_base.trim_end_matches('/').to_string());
    let _ = OWN_SWITCHES.set(own_switches);
    DIRECT.store(true, Ordering::Relaxed);
    store_log::event("info", "direct", "direct mode: Rust talks to siri-api itself (no Python backend)");
    // keep the switches fresh (an admin turning rust_direct off takes effect at the next start)
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            if crate::offline_answers::is_online() {
                if let Some(t) = any_siri_token() {
                    refresh_switches(&t).await;
                }
            }
        }
    });
}

/// Where siri-api is (tests can point it elsewhere before anything is called).
pub fn set_api(api_base: &str) {
    let _ = API.set(api_base.trim_end_matches('/').to_string());
}

fn api() -> String {
    API.get().cloned().unwrap_or_else(|| "https://api.ifleon.com".to_string())
}

fn passwords() -> &'static Mutex<HashMap<String, (String, Option<Instant>)>> {
    PASSWORDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn approvals() -> &'static Mutex<HashMap<String, Approval>> {
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stock() -> &'static tokio::sync::broadcast::Sender<String> {
    STOCK.get_or_init(|| tokio::sync::broadcast::channel(100).0)
}

fn now_text() -> String {
    Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn json_response(status: u16, body: Value) -> Response {
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
    r
}

fn offline_answer() -> Response {
    json_response(503, json!({"message": OFFLINE_MESSAGE, "code": "offline", "retryable": true}))
}

fn random_hex(db: &OfflineDb, bytes: i64) -> String {
    db.with_conn(|c| c.query_row("SELECT lower(hex(randomblob(?1)))", params![bytes], |r| r.get::<_, String>(0)))
        .unwrap_or_else(|_| format!("{:x}", Utc::now().timestamp_nanos_opt().unwrap_or(0)))
}

// ------------------------------------------------------------------------------------------------ session tokens

fn b64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::with_capacity(bytes.len() * 4 / 3 + 3);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | ((*b as u32) << (16 - 8 * i)));
        for i in 0..(chunk.len() + 1) {
            s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    s
}

fn session_key(db: &OfflineDb) -> rusqlite::Result<Vec<u8>> {
    if let Some(k) = db.get_meta("session_key")?.and_then(|k| hex::decode(k).ok()).filter(|k| k.len() == 32) {
        return Ok(k);
    }
    let fresh = random_hex(db, 32);
    db.set_meta("session_key", &fresh)?;
    Ok(hex::decode(fresh).unwrap_or_default())
}

fn sign(key: &[u8], text: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    mac.update(text.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub sid: String,
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub siri_token: Option<String>,
}

/// A new screen session for `user` ({"id","email","name","role"}). The token looks like the old one (three dot-separated
/// parts, the person's id readable in the middle), so the screens and the per-person memory work unchanged.
pub fn issue(db: &OfflineDb, user: &Value, siri_token: Option<&str>) -> rusqlite::Result<String> {
    let key = session_key(db)?;
    let sid = random_hex(db, 16);
    let field = |k: &str, d: &str| user.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
    let (uid, email, name, role) = (field("id", ""), field("email", "").to_lowercase(), field("name", "Unknown"), field("role", "user"));
    let now = now_text();
    db.with_conn(|c| c.execute(
        "INSERT INTO sessions (sid, user_id, email, name, role, siri_token, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![sid, uid, email, name, role, siri_token, now]))?;
    let head = b64url(br#"{"alg":"HS256","typ":"JWT","kid":"rust"}"#);
    let body = b64url(json!({"sub": uid, "sid": sid, "email": email, "name": name, "role": role}).to_string().as_bytes());
    let signed = format!("{head}.{body}");
    Ok(format!("{signed}.{}", sign(&key, &signed)))
}

fn token_of(headers: &HeaderMap, query: &str) -> Option<String> {
    let header = headers.get("authorization").and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ")).map(|s| s.trim().to_string());
    let cookie = headers.get("cookie").and_then(|v| v.to_str().ok()).and_then(|c| {
        c.split(';').map(str::trim).find_map(|kv| kv.strip_prefix("access_token_cookie=").map(str::to_string))
    });
    let from_query = query.split('&').find_map(|kv| kv.strip_prefix("token="))
        .map(|t| urlencoding::decode(t).map(|s| s.into_owned()).unwrap_or_default());
    header.or(cookie).or(from_query).filter(|t| !t.is_empty())
}

/// The session a token belongs to: signed by this PC, not logged out, used within the last 2 hours.
pub fn session(db: &OfflineDb, token: &str) -> Option<Session> {
    let key = session_key(db).ok()?;
    let (signed, sig) = token.rsplit_once('.')?;
    if sign(&key, signed) != sig {
        return None;
    }
    let payload = crate::offline_answers::decode_b64url(signed.split('.').nth(1)?)?;
    let sid = serde_json::from_slice::<Value>(&payload).ok()?.get("sid").and_then(Value::as_str)?.to_string();
    let row: Option<(Session, String)> = db.with_conn(|c| c.query_row(
        "SELECT sid, user_id, email, name, role, siri_token, last_seen FROM sessions WHERE sid = ?1", params![sid],
        |r| Ok((Session { sid: r.get(0)?, user_id: r.get(1)?, email: r.get(2)?, name: r.get(3)?, role: r.get(4)?,
                          siri_token: r.get(5)? }, r.get::<_, String>(6)?))).optional()).ok().flatten();
    let (s, last_seen) = row?;
    let seen = chrono::NaiveDateTime::parse_from_str(&last_seen, "%Y-%m-%d %H:%M:%S").ok()?.and_utc();
    let idle = (Utc::now() - seen).num_seconds();
    if idle > SESSION_IDLE_SECONDS {
        let _ = db.with_conn(|c| c.execute("DELETE FROM sessions WHERE sid = ?1", params![sid]));
        return None;
    }
    if idle > 60 {
        let _ = db.with_conn(|c| c.execute("UPDATE sessions SET last_seen = ?2 WHERE sid = ?1", params![sid, now_text()]));
    }
    Some(s)
}

fn set_siri_token(db: &OfflineDb, user_id: &str, token: Option<&str>) {
    let _ = db.with_conn(|c| c.execute("UPDATE sessions SET siri_token = ?2 WHERE user_id = ?1", params![user_id, token]));
}

/// The newest siri-api token any signed-in person holds (for the background copy). None when nobody is signed in.
pub fn any_siri_token() -> Option<String> {
    crate::shadow::database()?.with_conn(|c| c.query_row(
        "SELECT siri_token FROM sessions WHERE siri_token IS NOT NULL AND siri_token <> '' ORDER BY last_seen DESC LIMIT 1",
        [], |r| r.get::<_, String>(0)).optional()).ok().flatten()
}

// ------------------------------------------------------------------------------------------------ replay passes

/// Keep a cashier's replay passes ({store id: pass}): they send that cashier's queued work later, even logged out.
pub fn remember_passes(db: &OfflineDb, user_id: &str, passes: &Value) {
    if user_id.is_empty() || passes.as_object().map(|m| m.is_empty()).unwrap_or(true) {
        return;
    }
    let mut all: Value = db.get_meta("replay_by_user").ok().flatten()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    all[user_id] = passes.clone();
    let _ = db.set_meta("replay_by_user", &all.to_string());
}

/// This cashier's replay pass for this store, as kept by Rust (None: ask the Python side's file).
pub fn rust_replay_pass(db: &OfflineDb, user_id: &str, store_id: &str) -> Option<String> {
    let all: Value = serde_json::from_str(&db.get_meta("replay_by_user").ok().flatten()?).ok()?;
    all.get(user_id).and_then(|m| m.get(store_id)).and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
}

fn forget_pass(db: &OfflineDb, user_id: &str, store_id: &str) {
    let Some(mut all) = db.get_meta("replay_by_user").ok().flatten().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return };
    if let Some(m) = all.get_mut(user_id).and_then(Value::as_object_mut) {
        m.remove(store_id);
    }
    let _ = db.set_meta("replay_by_user", &all.to_string());
}

/// The replay pass was refused (revoked): forget it until the cashier logs in again.
pub fn pass_refused(user_id: &str, store_id: &str) {
    if let Some(db) = crate::shadow::database() {
        forget_pass(db, user_id, store_id);
    }
}

// ------------------------------------------------------------------------------------------------ siri-api calls

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).timeout(timeout).build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

enum Outcome {
    Answer(u16, HeaderMap, Vec<u8>),
    NotSent(String),
    Unsure(String),
}

async fn call(method: &Method, path_and_query: &str, token: Option<&str>, body: Option<&Value>, timeout: Duration) -> Outcome {
    let url = format!("{}{}", api(), path_and_query);
    let m = reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut rb = client(timeout).request(m, &url);
    if let Some(t) = token {
        rb = rb.bearer_auth(t);
    }
    if let Some(b) = body {
        rb = rb.json(b);
    }
    match rb.send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let mut headers = HeaderMap::new();
            for (k, v) in r.headers() {
                if let (Ok(name), Ok(value)) = (axum::http::HeaderName::from_bytes(k.as_str().as_bytes()),
                                                HeaderValue::from_bytes(v.as_bytes())) {
                    headers.insert(name, value);
                }
            }
            match r.bytes().await {
                Ok(b) => Outcome::Answer(status, headers, b.to_vec()),
                Err(e) => Outcome::Unsure(format!("answer cut off: {e}")),
            }
        }
        Err(e) if e.is_connect() || e.is_builder() => Outcome::NotSent(e.to_string()),
        Err(e) => Outcome::Unsure(e.to_string()),
    }
}

/// Log in to siri-api: ("ok", body) / ("refused", body) / ("unreachable", _).
async fn siri_login(email: &str, password: &str) -> (&'static str, Value) {
    match call(&Method::POST, "/api/auth/login", None, Some(&json!({"email": email, "password": password})), LOGIN_TIMEOUT).await {
        Outcome::Answer(200, _, b) => {
            let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
            let ok = v.get("access_token").and_then(Value::as_str).map(|t| !t.is_empty()).unwrap_or(false);
            (if ok { "ok" } else { "unreachable" }, v)
        }
        Outcome::Answer(400 | 401 | 403, _, b) => ("refused", serde_json::from_slice(&b).unwrap_or(Value::Null)),
        _ => ("unreachable", Value::Null),
    }
}

fn user_of_login(body: &Value, email: &str) -> Value {
    let u = body.get("user").cloned().unwrap_or(json!({}));
    json!({"id": u.get("id").cloned().unwrap_or(Value::Null), "email": u.get("email").and_then(Value::as_str).unwrap_or(email),
           "name": u.get("name").and_then(Value::as_str).unwrap_or("Unknown"),
           "role": body.get("user_role").or_else(|| u.get("role")).and_then(Value::as_str).unwrap_or("user")})
}

/// After a good siri-api login: keep the passes and refresh the switches (in the background).
fn after_siri_login(db: &'static OfflineDb, user_id: &str, body: &Value) {
    remember_passes(db, user_id, body.get("replay_tokens").unwrap_or(&Value::Null));
    if let Some(token) = body.get("access_token").and_then(Value::as_str).map(str::to_string) {
        tokio::spawn(async move { refresh_switches(&token).await });
    }
}

/// Ask siri-api for this store's switches and keep them where the app looks at start (front_door.json).
pub async fn refresh_switches(token: &str) {
    let Outcome::Answer(200, _, b) = call(&Method::GET, "/api/store/config", Some(token), None, READ_TIMEOUT).await else { return };
    let Some(sw) = serde_json::from_slice::<Value>(&b).ok().and_then(|v| v.get("switches").cloned()) else { return };
    if let Some(path) = OWN_SWITCHES.get() {
        let keep = json!({"rust_front": sw.get("rust_front").and_then(Value::as_bool).unwrap_or(false),
                          "rust_direct": sw.get("rust_direct").and_then(Value::as_bool).unwrap_or(false), "switches": sw,
                          "fetched_at": Utc::now().timestamp() as f64});
        let _ = std::fs::write(path, keep.to_string());
    }
}

/// The person's siri-api token; after an offline login, logs in to siri-api with the remembered password (at most
/// every 30 s). None: work as offline for now.
async fn siri_token(db: &'static OfflineDb, s: &Session) -> Option<String> {
    if let Some(t) = s.siri_token.clone().filter(|t| !t.is_empty()) {
        return Some(t);
    }
    let password = {
        let mut map = passwords().lock().ok()?;
        let entry = map.get_mut(&s.email)?;
        if entry.1.map(|t| t.elapsed() < RELOGIN_EVERY).unwrap_or(false) {
            return None;
        }
        entry.1 = Some(Instant::now());
        entry.0.clone()
    };
    match siri_login(&s.email, &password).await {
        ("ok", body) => {
            let token = body.get("access_token").and_then(Value::as_str).unwrap_or("").to_string();
            set_siri_token(db, &s.user_id, Some(&token));
            after_siri_login(db, &s.user_id, &body);
            if let Ok(mut m) = passwords().lock() {
                m.remove(&s.email);
            }
            store_log::event("info", "direct", &format!("siri-api login restored after an offline login ({})", s.user_id));
            Some(token)
        }
        ("refused", _) => {
            if let Ok(mut m) = passwords().lock() {
                m.remove(&s.email);
            }
            store_log::event("warn", "direct", &format!("password no longer accepted by siri-api for {}", s.user_id));
            None
        }
        _ => None,
    }
}

// ------------------------------------------------------------------------------------------------ the entry point

/// What `forward` needs to know about the request (put on it by `handle`).
#[derive(Clone)]
pub struct Ctx {
    pub session: Session,
    pub online: bool,
}

/// Everything the screens send, in direct mode.
pub async fn handle(req: Request) -> Response {
    let Some(db) = crate::shadow::database() else {
        return json_response(503, json!({"message": "The local database is not available", "retryable": true}));
    };
    handle_in(req, db, crate::offline_answers::is_online()).await
}

pub async fn handle_in(req: Request, db: &'static OfflineDb, online: bool) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    // ---- answered without a login
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/health") => return json_response(200, json!({"status": "online", "app": "billing", "backend": "rust",
                                                                     "timestamp": chrono::Local::now().to_rfc3339()})),
        ("POST", "/api/auth/login") => return login(db, req, online).await,
        ("POST", "/api/auth/forgot-password-proxy") => return forgot_password(req).await,
        ("POST", "/api/shutdown") => return json_response(200, json!({"message": "nothing to stop"})),
        _ => {}
    }

    let token = token_of(req.headers(), &query);
    let Some(s) = token.as_deref().and_then(|t| session(db, t)) else {
        return json_response(401, json!({"msg": "Missing or invalid login", "message": "Please log in again"}));
    };
    match (method.as_str(), path.as_str()) {
        ("POST", "/api/auth/logout") => {
            let _ = db.with_conn(|c| c.execute("DELETE FROM sessions WHERE sid = ?1", params![s.sid]));
            return json_response(200, json!({"message": "Logout successful"}));
        }
        ("GET", "/api/auth/me") => return json_response(200, json!({"id": s.user_id, "email": s.email, "name": s.name,
                                                                      "role": s.role, "offline": !online})),
        ("GET", "/api/auth/check") => return json_response(200, json!({"authenticated": true, "user_id": s.user_id,
                                                                         "email": s.email, "role": s.role})),
        ("GET", "/api/sync/status") => {
            let (bills, attention) = crate::offline_bills::counts(db);
            let actions = crate::offline_actions::status(db);
            return json_response(200, json!({
                "database_connected": online, "online": online, "backend": "rust",
                "queue_size": bills + actions["waiting"].as_i64().unwrap_or(0),
                "needs_attention": attention + actions["needs_attention"].as_i64().unwrap_or(0),
            }));
        }
        ("POST", "/api/sync/trigger") => {
            std::thread::spawn(|| {
                if let Some(db) = crate::shadow::database() {
                    let py = crate::offline_answers::python_dir().unwrap_or_default();
                    crate::rust_sync::run_once(db, &py, &api());
                }
            });
            return json_response(200, json!({"message": "Sync started"}));
        }
        ("GET", "/api/sync/history") => return json_response(200, json!([])),
        ("GET", "/api/stock/stream") => return stock_stream(),
        _ => {}
    }

    let token_now = if online { siri_token(db, &s).await } else { None };
    let online_now = online && token_now.is_some();
    let mut req = req;
    req.extensions_mut().insert(Ctx { session: Session { siri_token: token_now, ..s }, online: online_now });
    req.extensions_mut().insert(DbRef(db));
    let py = crate::offline_answers::python_dir().unwrap_or_default();
    crate::offline_answers::handle_with(req, crate::offline_answers::Upstream::Siri, Some(db), online_now, "", &py).await
}

async fn body_json(req: Request) -> Value {
    let bytes = axum::body::to_bytes(req.into_body(), 8 * 1024 * 1024).await.unwrap_or_default();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn login_answer(token: &str, user: &Value) -> Response {
    let mut r = json_response(200, json!({
        "auth_ok": true, "message": "Login successful", "access_token": token,
        "user": {"id": user["id"], "email": user["email"], "name": user["name"]}, "user_role": user["role"],
    }));
    if let Ok(v) = HeaderValue::from_str(&format!("access_token_cookie={token}; Path=/; HttpOnly; SameSite=Lax")) {
        r.headers_mut().insert("set-cookie", v);
    }
    r
}

async fn login(db: &'static OfflineDb, req: Request, online: bool) -> Response {
    let creds = body_json(req).await;
    let email = creds.get("email").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
    let password = creds.get("password").and_then(Value::as_str).unwrap_or("").to_string();
    if email.is_empty() || password.is_empty() {
        return json_response(400, json!({"message": "Email and password are required"}));
    }
    if online {
        match siri_login(&email, &password).await {
            ("ok", body) => {
                let user = user_of_login(&body, &email);
                let uid = user["id"].as_str().unwrap_or("").to_string();
                after_siri_login(db, &uid, &body);
                return match issue(db, &user, body["access_token"].as_str()) {
                    Ok(t) => {
                        store_log::event("info", "direct", &format!("login ok user={uid} (siri-api)"));
                        login_answer(&t, &user)
                    }
                    Err(e) => json_response(500, json!({"message": format!("Could not start the session: {e}")})),
                };
            }
            ("refused", body) => {
                let message = body.get("message").or_else(|| body.get("error")).and_then(Value::as_str)
                    .unwrap_or("Invalid email or password").to_string();
                return json_response(401, json!({"message": message}));
            }
            _ => {} // siri-api did not answer: the copy decides
        }
    }
    let (e2, p2) = (email.clone(), password.clone());
    let checked = tokio::task::spawn_blocking(move || db.check_offline_login(&e2, &p2)).await.ok().flatten();
    let Some(user) = checked else {
        return json_response(401, json!({"message": "Invalid email or password"}));
    };
    if let Ok(mut m) = passwords().lock() {
        m.insert(email.clone(), (password, None));            // to log in to siri-api once the internet is back
    }
    match issue(db, &user, None) {
        Ok(t) => {
            store_log::event("info", "direct", &format!("offline login ok user={} (Rust copy)",
                                                        user.get("id").and_then(Value::as_str).unwrap_or("?")));
            login_answer(&t, &user)
        }
        Err(e) => json_response(500, json!({"message": format!("Could not start the session: {e}")})),
    }
}

async fn forgot_password(req: Request) -> Response {
    let data = body_json(req).await;
    let email = data.get("email").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
    let looks_ok = !email.contains(char::is_whitespace) && email.split_once('@')
        .map(|(a, b)| !a.is_empty() && b.contains('.') && !b.starts_with('.') && !b.ends_with('.')).unwrap_or(false);
    if !looks_ok {
        return json_response(400, json!({"success": false, "message": "Please enter a valid email address."}));
    }
    json_response(200, json!({"success": true, "message": "If an account exists for this email, reset instructions have been sent."}))
}

// ------------------------------------------------------------------------------------------------ stock stream

/// Tell the open screens that stock changed (the same event Python's stream sent).
pub fn announce_stock(store_id: &str, product_ids: Vec<String>) {
    if product_ids.is_empty() {
        return;
    }
    let event = json!({"type": "stock_update", "store_id": store_id, "product_ids": product_ids, "ts": Utc::now().to_rfc3339()});
    let _ = stock().send(event.to_string());
}

fn stock_stream() -> Response {
    let rx = stock().subscribe();
    let stream = futures_util::stream::unfold((rx, true), |(mut rx, first)| async move {
        if first {
            return Some((Ok::<_, std::convert::Infallible>("event: connected\ndata: {}\n\n".to_string()), (rx, false)));
        }
        let text = match tokio::time::timeout(Duration::from_secs(15), rx.recv()).await {
            Ok(Ok(payload)) => format!("event: stock\ndata: {payload}\n\n"),
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => "event: keepalive\ndata: {}\n\n".to_string(),
            Ok(Err(_)) => return None,
            Err(_) => format!("event: keepalive\ndata: {}\n\n", json!({"type": "keepalive", "ts": Utc::now().timestamp()})),
        };
        Some((Ok(text), (rx, false)))
    });
    let mut r = Response::new(Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert("content-type", HeaderValue::from_static("text/event-stream"));
    h.insert("cache-control", HeaderValue::from_static("no-cache"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    r
}

// ------------------------------------------------------------------------------------------------ route mapping

#[derive(Debug, Clone, PartialEq)]
pub enum Special {
    Plain,
    CurrentStore,
    Bill,
    /// queued with the same request id when siri-api's answer is lost (a piece 5 kind)
    Queueable(&'static str),
    VerifyOtp,
}

/// The siri-api route for a screen route (the mapping Python's @via_siri_api used). None: not a store route.
pub fn map_route(method: &Method, path: &str) -> Option<(String, Special)> {
    use crate::offline_actions as a;
    let rest = path.strip_prefix("/api/")?;
    let store = |p: &str| format!("/api/store/{p}");
    if method == Method::GET && rest == "stores/current" {
        return Some((store("me"), Special::CurrentStore));
    }
    if let Some(sub) = rest.strip_prefix("stores/current/transfer-orders") {
        return Some((store(&format!("transfer-orders{sub}")), Special::Plain));
    }
    let special = match (method.as_str(), rest) {
        ("POST", "bills") => Special::Bill,
        ("POST", "store-damage-returns") => Special::Queueable(a::DAMAGE),
        ("POST", "return-orders") => Special::Queueable(a::RETURN_ORDER),
        ("POST", "returns/submit") => Special::Queueable(a::CUSTOMER_RETURN),
        ("POST", "discounts/verify-otp") => Special::VerifyOtp,
        ("POST", r) if r.starts_with("transfer-orders/") && r.ends_with("/verify") => Special::Queueable(a::TRANSFER),
        ("POST", r) if r.starts_with("notifications/") && r.ends_with("/read") => Special::Queueable(a::NOTE_READ),
        _ => Special::Plain,
    };
    let known = ["bills", "customers", "discounts", "hsn-codes", "notifications", "products", "return-orders", "returns",
                 "store-damage-returns", "settings", "stores", "user-stores", "transfer-orders", "users"];
    let first = rest.split('/').next().unwrap_or("");
    known.contains(&first).then(|| (store(rest), special))
}

fn ensure_request_id(db: &OfflineDb, body: &mut Value) -> String {
    if !body.is_object() {
        *body = json!({});
    }
    let given = body.get("_client_request_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !given.is_empty() {
        return given;
    }
    let fresh = format!("pc-{}", random_hex(db, 16));
    body["_client_request_id"] = json!(fresh);
    fresh
}

fn answer_from(status: u16, headers: &HeaderMap, body: Vec<u8>) -> Response {
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let ctype = headers.get("content-type").cloned().unwrap_or(HeaderValue::from_static("application/json"));
    r.headers_mut().insert("content-type", ctype);
    for name in ["x-fallback-used", "x-data-source", "x-partial", "x-bills-fallback-used"] {
        if let Some(v) = headers.get(name) {
            r.headers_mut().insert(name, v.clone());
        }
    }
    r.headers_mut().insert("x-siri-api", HeaderValue::from_static("1"));
    r
}

/// Send one screen request to siri-api (online), or say it needs the internet (offline). Called by
/// offline_answers::handle_with wherever it would otherwise ask Python.
pub async fn forward(req: Request) -> Response {
    let Some(ctx) = req.extensions().get::<Ctx>().cloned() else {
        return json_response(401, json!({"message": "Please log in again"}));
    };
    let Some(db) = req.extensions().get::<DbRef>().map(|d| d.0).or_else(crate::shadow::database) else {
        return offline_answer();
    };
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let Some((target, special)) = map_route(&method, &path) else {
        return json_response(404, json!({"message": "Not found"}));
    };
    if !ctx.online {
        return offline_answer();
    }
    let has_body = matches!(method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    let mut body = body_json(req).await;
    let s = ctx.session.clone();
    let token = s.siri_token.clone().unwrap_or_default();

    // per-kind preparation: request ids (so a lost answer can be queued under the same id), hints, approvals
    let mut request_id = String::new();
    let mut approval: Option<Approval> = None;
    match &special {
        Special::Bill => {
            request_id = ensure_request_id(db, &mut body);
            if let Some(store_id) = body.get("store_id").and_then(Value::as_str).map(str::to_string) {
                let hint = crate::offline_bills::pending_serial_hint(db, &store_id, Utc::now());
                if hint > 0 {
                    body["_min_serial"] = json!(hint);
                }
            }
            approval = take_approval(&s.user_id, &mut body);
        }
        Special::Queueable(kind) if *kind == crate::offline_actions::TRANSFER => {
            if !body.is_object() {
                body = json!({});
            }
            if body.get("verification_session_id").and_then(Value::as_str).map(str::is_empty).unwrap_or(true) {
                body["verification_session_id"] = json!(format!("ver-{}", random_hex(db, 8)));
            }
            request_id = body["verification_session_id"].as_str().unwrap_or("").to_string();
        }
        Special::Queueable(kind) if *kind == crate::offline_actions::NOTE_READ => {}
        Special::Queueable(_) => request_id = ensure_request_id(db, &mut body),
        _ => {}
    }

    let timeout = if has_body { WRITE_TIMEOUT } else { READ_TIMEOUT };
    let send_body = if has_body && !body.is_null() { Some(body.clone()) } else { None };
    let url = format!("{target}{query}");
    let mut outcome = call(&method, &url, Some(&token), send_body.as_ref(), timeout).await;

    // a refused token: log in again with a remembered password once (nothing was done), else the screen logs in again
    if let Outcome::Answer(401, _, _) = outcome {
        set_siri_token(db, &s.user_id, None);
        match siri_token(db, &Session { siri_token: None, ..s.clone() }).await {
            Some(t) => outcome = call(&method, &url, Some(&t), send_body.as_ref(), timeout).await,
            None => {
                give_back(&s.user_id, approval);
                return json_response(401, json!({"msg": "Token has expired", "message": "Your session has ended. Please log in again."}));
            }
        }
    }

    match outcome {
        Outcome::Answer(status, headers, bytes) => {
            if let Some(fresh) = headers.get("x-access-token").and_then(|v| v.to_str().ok()).filter(|_| status < 400) {
                set_siri_token(db, &s.user_id, Some(fresh));
            }
            if status >= 500 && has_body {
                return unsure(db, &s, &special, &target, &request_id, &body, &format!("HTTP {status}")).await;
            }
            if !(200..300).contains(&status) {
                give_back(&s.user_id, approval);
                return answer_from(status, &headers, bytes);
            }
            let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            match special {
                Special::CurrentStore => match answer.get("store") {
                    Some(store) if !store.is_null() => json_response(200, store.clone()),
                    _ => json_response(404, json!({"message": "No store assigned to this user"})),
                },
                Special::Bill => json_response(201, bill_created(db, &body, &answer, &s)),
                Special::VerifyOtp => {
                    if answer.get("deferred").and_then(Value::as_bool).unwrap_or(false) {
                        if let (Some(t), Ok(mut m)) = (answer.get("approval_token").and_then(Value::as_str), approvals().lock()) {
                            m.insert(s.user_id.clone(), (answer.get("approved_by").cloned().unwrap_or(Value::Null),
                                                         t.to_string(), Instant::now() + APPROVAL_FOR));
                        }
                    }
                    answer_from(status, &headers, bytes)
                }
                Special::Queueable(kind) => {
                    if kind == crate::offline_actions::DAMAGE || kind == crate::offline_actions::TRANSFER {
                        let store_id = crate::offline_bills::store_of(db, &s.user_id).unwrap_or_default();
                        announce_stock(&store_id, product_ids(&body));
                    }
                    answer_from(status, &headers, bytes)
                }
                Special::Plain => answer_from(status, &headers, bytes),
            }
        }
        Outcome::NotSent(e) => {
            give_back(&s.user_id, approval);
            match special {
                // it never left this PC: the offline path takes it (a bill is numbered and queued here)
                Special::Bill | Special::Queueable(_) => unsure(db, &s, &special, &target, &request_id, &body, &format!("not sent: {e}")).await,
                _ => offline_answer(),
            }
        }
        Outcome::Unsure(e) if has_body => unsure(db, &s, &special, &target, &request_id, &body, &e).await,
        Outcome::Unsure(_) => offline_answer(),
    }
}

/// The database `handle_in` was given, for `forward` (the app-wide one in the app, a test's own in the tests).
#[derive(Clone, Copy)]
pub struct DbRef(pub &'static OfflineDb);

fn product_ids(body: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for list in ["items", "selectedItems"] {
        for it in body.get(list).and_then(Value::as_array).cloned().unwrap_or_default() {
            let pid = it.get("product_id").or_else(|| it.get("productId")).and_then(Value::as_str).unwrap_or("");
            if !pid.is_empty() && !out.iter().any(|p| p == pid) {
                out.push(pid.to_string());
            }
        }
    }
    out
}

/// A manager's discount code given before this bill: sent with the bill (Python did the same).
fn take_approval(user_id: &str, body: &mut Value) -> Option<Approval> {
    let pct = body.get("discount_percentage").or_else(|| body.get("discountPercentage"))
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0);
    if pct <= 10.0 || body.get("discount_request_id").map(|v| !v.is_null()).unwrap_or(false)
        || body.get("_deferred_discount_approval").is_some() {
        return None;
    }
    let entry = approvals().lock().ok()?.remove(user_id).filter(|(_, _, until)| *until > Instant::now())?;
    body["_deferred_discount_approval"] = json!(true);
    body["_discount_approval_token"] = json!(entry.1);
    Some(entry)
}

fn give_back(user_id: &str, approval: Option<Approval>) {
    if let (Some(a), Ok(mut m)) = (approval, approvals().lock()) {
        m.insert(user_id.to_string(), a);
    }
}

/// A bill siri-api made: remembered (offline numbers continue after it), the stock change announced, and the answer
/// in the shape the screens get.
fn bill_created(db: &OfflineDb, sent: &Value, answer: &Value, s: &Session) -> Value {
    let bill_id = answer.get("bill_id").or_else(|| answer.pointer("/bill/id")).and_then(Value::as_str).unwrap_or("").to_string();
    crate::offline_bills::remember_bill(db, &bill_id);
    announce_stock(sent.get("store_id").and_then(Value::as_str).unwrap_or(""), product_ids(sent));
    store_log::event("info", "direct", &format!("bill {bill_id} made through siri-api by {}", s.user_id));
    let mut out = json!({
        "queued": false, "message": answer.get("message").and_then(Value::as_str).unwrap_or("Bill created successfully"),
        "bill_id": bill_id, "bill": answer.get("bill").cloned().unwrap_or(Value::Null),
        "items_created": answer.get("items_created").cloned()
            .unwrap_or_else(|| json!(sent.get("items").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0))),
        "total_amount": answer.get("total_amount").cloned().unwrap_or_else(|| sent.get("total_amount").cloned().unwrap_or(Value::Null)),
        "replacements_created": answer.get("replacements_created").cloned().unwrap_or(json!(0)), "via": "siri-api",
    });
    if answer.get("idempotent_replay").and_then(Value::as_bool).unwrap_or(false) {
        out["idempotent_replay"] = json!(true);
    }
    out
}

/// siri-api may or may not have done it (or never saw it). Writes with a queue go to the queue under the SAME request
/// id; a bill is first looked up by its request id. Anything else: "not confirmed, try again".
async fn unsure(db: &'static OfflineDb, s: &Session, special: &Special, target: &str, request_id: &str, body: &Value,
                why: &str) -> Response {
    store_log::event("warn", "direct", &format!("{target}: siri-api did not confirm ({why})"));
    let now = Utc::now();
    match special {
        Special::Bill => {
            let token = s.siri_token.clone().unwrap_or_default();
            let lookup = format!("/api/store/bills/by-request/{}", urlencoding::encode(request_id));
            if let Outcome::Answer(200, _, b) = call(&Method::GET, &lookup, Some(&token), None, Duration::from_secs(5)).await {
                let found: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
                if found.get("found").and_then(Value::as_bool).unwrap_or(false) {
                    let answer = json!({"bill_id": found.get("bill_id"), "bill": found.get("bill"),
                                        "message": "Bill already processed", "idempotent_replay": true});
                    return json_response(201, bill_created(db, body, &answer, s));
                }
            }
            // the queued copy keeps the manager's approval in its own payload
            let (user, payload) = (s.user_id.clone(), body.clone());
            let py = crate::offline_answers::python_dir().unwrap_or_default();
            let saved = tokio::task::spawn_blocking(move || crate::offline_bills::queue_bill(db, &user, &payload, &py, now)).await;
            match saved {
                Ok(Ok(Some(q))) => {
                    store_log::event("info", "rustbills", &format!("bill {} queued (siri-api did not confirm)", q.bill_id));
                    json_response(202, crate::offline_bills::queued_answer(&q))
                }
                _ => json_response(503, json!({"message": "The server did not confirm this bill. Please check the bill list and try again.",
                                                "code": "siri_unclear", "retryable": true})),
            }
        }
        Special::Queueable(kind) => {
            let inner = |prefix: &str, suffix: &str| target.strip_prefix(prefix).and_then(|t| t.strip_suffix(suffix))
                .map(|t| urlencoding::decode(t).map(|c| c.into_owned()).unwrap_or_default()).unwrap_or_default();
            let target_id = if *kind == crate::offline_actions::TRANSFER { inner("/api/store/transfer-orders/", "/verify") }
                            else { inner("/api/store/notifications/", "/read") };
            let rid = if request_id.is_empty() { format!("read-{target_id}") } else { request_id.to_string() };
            match crate::offline_actions::queue_unsure(db, kind, &rid, &s.user_id, &target_id, body, now) {
                Ok((code, answer)) => json_response(code, answer),
                Err(e) => json_response(503, json!({"message": format!("The server did not confirm this action ({e}). Please try again."),
                                                     "code": "siri_unclear", "retryable": true})),
            }
        }
        _ => json_response(503, json!({"message": "The server did not confirm this action. Please check and try again.",
                                        "code": "siri_unclear", "retryable": true})),
    }
}

// ------------------------------------------------------------------------------------------------ start-up rule

/// Python's own offline queues still hold work (from before direct mode): Python must start to send it.
pub fn python_has_queued_work(python_dir: &std::path::Path) -> bool {
    ["offline_bill_queue.json", "offline_damage_return_queue.json", "offline_return_order_queue.json",
     "offline_transfer_verification_queue.json"].iter().any(|name| {
        std::fs::read_to_string(python_dir.join("json").join(name)).ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_array().map(|a| !a.is_empty()))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> &'static OfflineDb {
        Box::leak(Box::new(OfflineDb::open_in_memory().unwrap()))
    }

    #[test]
    fn a_session_token_is_signed_by_this_pc_and_ends_at_logout_or_after_two_idle_hours() {
        let db = db();
        let user = json!({"id": "u1", "email": "A@B.com", "name": "Ravi", "role": "billing_user"});
        let t = issue(db, &user, Some("siri-1")).unwrap();
        assert_eq!(t.split('.').count(), 3, "the screens check for three parts");
        let s = session(db, &t).unwrap();
        assert_eq!((s.user_id.as_str(), s.email.as_str(), s.siri_token.as_deref()), ("u1", "a@b.com", Some("siri-1")));
        let mid = crate::offline_answers::decode_b64url(t.split('.').nth(1).unwrap()).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&mid).unwrap()["sub"], "u1", "the person is readable, as before");
        let forged = format!("{}0", &t[..t.len() - 1]);
        assert!(forged == t || session(db, &forged).is_none(), "a changed signature is refused");
        assert!(session(self::db(), &t).is_none(), "a token from another PC (another key) is refused");
        db.with_conn(|c| c.execute("UPDATE sessions SET last_seen = '2000-01-01 00:00:00'", [])).unwrap();
        assert!(session(db, &t).is_none(), "two hours without use ends it");
        let t2 = issue(db, &user, None).unwrap();
        assert!(session(db, &t2).is_some());
        db.with_conn(|c| c.execute("DELETE FROM sessions", [])).unwrap();
        assert!(session(db, &t2).is_none(), "logged out");
    }

    #[test]
    fn replay_passes_are_kept_per_cashier_and_a_refused_one_is_forgotten() {
        let db = db();
        remember_passes(db, "u1", &json!({"s1": "p1", "s2": "p2"}));
        remember_passes(db, "u2", &json!({"s1": "q1"}));
        assert_eq!(rust_replay_pass(db, "u1", "s2").as_deref(), Some("p2"));
        assert_eq!(rust_replay_pass(db, "u2", "s1").as_deref(), Some("q1"));
        forget_pass(db, "u1", "s2");
        assert_eq!(rust_replay_pass(db, "u1", "s2"), None);
        assert_eq!(rust_replay_pass(db, "u1", "s1").as_deref(), Some("p1"));
        remember_passes(db, "u1", &json!({}));
        assert_eq!(rust_replay_pass(db, "u1", "s1").as_deref(), Some("p1"), "an empty answer does not wipe them");
    }

    #[test]
    fn every_screen_route_has_its_siri_api_route() {
        let (g, p) = (Method::GET, Method::POST);
        let cases: Vec<(Method, &str, &str, Special)> = vec![
            (g.clone(), "/api/products", "/api/store/products", Special::Plain),
            (g.clone(), "/api/products/p1", "/api/store/products/p1", Special::Plain),
            (g.clone(), "/api/stores/current", "/api/store/me", Special::CurrentStore),
            (g.clone(), "/api/stores", "/api/store/stores", Special::Plain),
            (g.clone(), "/api/stores/current/transfer-orders", "/api/store/transfer-orders", Special::Plain),
            (g.clone(), "/api/stores/current/transfer-orders/history", "/api/store/transfer-orders/history", Special::Plain),
            (g.clone(), "/api/stores/current/transfer-orders/barcode-status", "/api/store/transfer-orders/barcode-status", Special::Plain),
            (p.clone(), "/api/stores/current/transfer-orders/reconcile-inventory", "/api/store/transfer-orders/reconcile-inventory", Special::Plain),
            (g.clone(), "/api/transfer-orders/TO-1", "/api/store/transfer-orders/TO-1", Special::Plain),
            (p.clone(), "/api/transfer-orders/TO-1/verify", "/api/store/transfer-orders/TO-1/verify", Special::Queueable("transfer")),
            (p.clone(), "/api/transfer-orders/verify-batch", "/api/store/transfer-orders/verify-batch", Special::Plain),
            (p.clone(), "/api/bills", "/api/store/bills", Special::Bill),
            (g.clone(), "/api/bills", "/api/store/bills", Special::Plain),
            (g.clone(), "/api/bills/stats", "/api/store/bills/stats", Special::Plain),
            (Method::PUT, "/api/bills/INV-1/revise", "/api/store/bills/INV-1/revise", Special::Plain),
            (p.clone(), "/api/bills/INV-1/cancel", "/api/store/bills/INV-1/cancel", Special::Plain),
            (p.clone(), "/api/store-damage-returns", "/api/store/store-damage-returns", Special::Queueable("damage_return")),
            (p.clone(), "/api/return-orders", "/api/store/return-orders", Special::Queueable("return_order")),
            (p.clone(), "/api/returns/submit", "/api/store/returns/submit", Special::Queueable("customer_return")),
            (p.clone(), "/api/returns/RET-1/approve", "/api/store/returns/RET-1/approve", Special::Plain),
            (g.clone(), "/api/returns/pending/count", "/api/store/returns/pending/count", Special::Plain),
            (p.clone(), "/api/discounts/verify-otp", "/api/store/discounts/verify-otp", Special::VerifyOtp),
            (p.clone(), "/api/discounts/request", "/api/store/discounts/request", Special::Plain),
            (Method::PATCH, "/api/discounts/D1", "/api/store/discounts/D1", Special::Plain),
            (p.clone(), "/api/notifications/4/read", "/api/store/notifications/4/read", Special::Queueable("notification_read")),
            (p.clone(), "/api/notifications/read-all", "/api/store/notifications/read-all", Special::Plain),
            (g.clone(), "/api/user-stores", "/api/store/user-stores", Special::Plain),
            (Method::PUT, "/api/users/u1", "/api/store/users/u1", Special::Plain),
            (Method::DELETE, "/api/customers/c1", "/api/store/customers/c1", Special::Plain),
            (g.clone(), "/api/hsn-codes", "/api/store/hsn-codes", Special::Plain),
            (Method::PUT, "/api/settings", "/api/store/settings", Special::Plain),
        ];
        for (m, from, to, kind) in cases {
            assert_eq!(map_route(&m, from), Some((to.to_string(), kind)), "{m} {from}");
        }
        assert_eq!(map_route(&g, "/api/admin/switches"), None, "nothing outside the store routes");
        assert_eq!(map_route(&g, "/api/store/replay/bills"), None);
        assert_eq!(map_route(&g, "/health"), None);
    }

    #[test]
    fn a_discount_code_given_before_the_bill_goes_with_the_next_big_discount_bill_only() {
        approvals().lock().unwrap().insert("u9".into(), (json!("mgr"), "signed".into(), Instant::now() + APPROVAL_FOR));
        let mut small = json!({"discount_percentage": 5});
        assert!(take_approval("u9", &mut small).is_none());
        let mut big = json!({"discount_percentage": "15"});
        let taken = take_approval("u9", &mut big);
        assert!(taken.is_some());
        assert_eq!((big["_deferred_discount_approval"].clone(), big["_discount_approval_token"].clone()), (json!(true), json!("signed")));
        assert!(take_approval("u9", &mut json!({"discount_percentage": 15})).is_none(), "used once");
        give_back("u9", taken);
        assert!(take_approval("u9", &mut json!({"discount_percentage": 20})).is_some(), "given back when the bill did not go");
    }

    /// A stand-in for siri-api: one cashier (ok@x.com / good), products, the store, bills (quantity 99 = server
    /// fault), damaged returns (always a server fault).
    async fn fake_siri(seen: std::sync::Arc<Mutex<Vec<(String, Value)>>>) -> String {
        use axum::routing::{get, post};
        use axum::{Json, Router};
        let note = move |what: &str, body: Value| seen.lock().unwrap().push((what.to_string(), body));
        let (n1, n2, n3) = (note.clone(), note.clone(), note);
        let authed = |h: &HeaderMap| h.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer siri-tok");
        let app = Router::new()
            .route("/api/auth/login", post(|Json(b): Json<Value>| async move {
                if b["email"] == "ok@x.com" && b["password"] == "good" {
                    (StatusCode::OK, Json(json!({"access_token": "siri-tok", "user": {"id": "u1", "email": "ok@x.com", "name": "Ravi"},
                                                  "user_role": "billing_user", "replay_tokens": {"s1": "pass-s1"}})))
                } else {
                    (StatusCode::UNAUTHORIZED, Json(json!({"message": "Invalid email or password"})))
                }
            }))
            .route("/api/store/config", get(|| async { Json(json!({"switches": {"rust_front": true, "rust_direct": true}})) }))
            .route("/api/store/products", get(move |h: HeaderMap| async move {
                if !authed(&h) { return (StatusCode::UNAUTHORIZED, Json(json!({}))); }
                (StatusCode::OK, Json(json!([{"id": "p1", "name": "Ring", "stock": 5}])))
            }))
            .route("/api/store/me", get(|| async { Json(json!({"store": {"id": "s1", "name": "Mypadu"}})) }))
            .route("/api/store/bills", post(move |Json(b): Json<Value>| async move {
                n1("bill", b.clone());
                if b["items"][0]["quantity"] == 99 {
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"message": "boom"})));
                }
                (StatusCode::CREATED, Json(json!({"bill_id": "INV-MPD-251120260007", "bill": {"id": "INV-MPD-251120260007"}})))
            }))
            .route("/api/store/bills/by-request/{id}", get(move |axum::extract::Path(id): axum::extract::Path<String>| async move {
                n2("lookup", json!(id));
                Json(json!({"found": false}))
            }))
            .route("/api/store/store-damage-returns", post(move |Json(b): Json<Value>| async move {
                n3("damage", b);
                (StatusCode::GATEWAY_TIMEOUT, Json(json!({"message": "slow"})))
            }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        base
    }

    fn req(method: &str, path: &str, token: Option<&str>, body: Value) -> Request {
        let mut b = Request::builder().method(method).uri(path).header("content-type", "application/json");
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        b.body(Body::from(if body.is_null() { String::new() } else { body.to_string() })).unwrap()
    }

    async fn read(r: Response) -> (u16, Value) {
        let code = r.status().as_u16();
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        (code, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn direct_mode_logs_in_forwards_to_siri_api_and_queues_what_siri_api_did_not_confirm() {
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let base = fake_siri(seen.clone()).await;
        set_api(&base);
        assert_eq!(api(), base, "this is the only test that sets where siri-api is");
        let db = db();
        db.upsert_records("UserStores", &[json!({"id": 1, "userId": "u1", "storeId": "s1"})], "t").unwrap();
        db.upsert_records("Stores", &[json!({"id": "s1", "storecode": "mpd"})], "t").unwrap();

        // no login: refused
        assert_eq!(read(handle_in(req("GET", "/api/products", None, Value::Null), db, true).await).await.0, 401);
        assert_eq!(read(handle_in(req("POST", "/api/auth/login", None, json!({"email": "ok@x.com", "password": "bad"})), db, true).await).await.0, 401);
        let (code, login) = read(handle_in(req("POST", "/api/auth/login", None, json!({"email": "OK@x.com", "password": "good"})), db, true).await).await;
        assert_eq!(code, 200);
        assert_eq!((login["auth_ok"].clone(), login["user"]["id"].clone(), login["user_role"].clone()),
                   (json!(true), json!("u1"), json!("billing_user")));
        let t = login["access_token"].as_str().unwrap().to_string();
        assert_ne!(t, "siri-tok", "the screen gets this PC's token, never siri-api's");
        assert_eq!(rust_replay_pass(db, "u1", "s1").as_deref(), Some("pass-s1"));

        // online reads go to siri-api with the person's siri-api token
        let (code, products) = read(handle_in(req("GET", "/api/products", Some(&t), Value::Null), db, true).await).await;
        assert_eq!((code, products[0]["id"].clone()), (200, json!("p1")));
        let (_, store) = read(handle_in(req("GET", "/api/stores/current", Some(&t), Value::Null), db, true).await).await;
        assert_eq!(store, json!({"id": "s1", "name": "Mypadu"}), "the store, as the old route gave it");
        let (_, me) = read(handle_in(req("GET", "/api/auth/me", Some(&t), Value::Null), db, true).await).await;
        assert_eq!((me["id"].clone(), me["email"].clone()), (json!("u1"), json!("ok@x.com")));

        // a bill: made by siri-api, with a request id; its number is remembered
        let bill = json!({"store_id": "s1", "items": [{"product_id": "p1", "quantity": 1, "unit_price": 45}], "total_amount": 45});
        let (code, made) = read(handle_in(req("POST", "/api/bills", Some(&t), bill.clone()), db, true).await).await;
        assert_eq!((code, made["bill_id"].clone(), made["queued"].clone()), (201, json!("INV-MPD-251120260007"), json!(false)));
        // siri-api fails while saving: looked up by request id, then queued under the SAME id (never made twice)
        let mut broken = bill.clone();
        broken["items"][0]["quantity"] = json!(99);
        let (code, queued) = read(handle_in(req("POST", "/api/bills", Some(&t), broken), db, true).await).await;
        assert_eq!((code, queued["queued"].clone()), (202, json!(true)));
        let sent = seen.lock().unwrap().clone();
        let rid = sent.iter().filter(|(k, _)| k == "bill").last().unwrap().1["_client_request_id"].as_str().unwrap().to_string();
        assert!(rid.starts_with("pc-"));
        assert!(sent.iter().any(|(k, v)| k == "lookup" && v == &json!(rid)), "asked whether it got through");
        let queued_rid: String = db.with_conn(|c| c.query_row("SELECT client_request_id FROM offline_bills", [], |r| r.get(0))).unwrap();
        assert_eq!(queued_rid, rid);
        assert!(queued["bill_id"].as_str().unwrap() > "INV-MPD-251120260007" || queued["bill_id"].as_str().unwrap().starts_with("INV-MPD-"),
                "numbered on this PC after the bills it knows");

        // a damaged return siri-api did not confirm: queued with its request id, sent later
        let (code, d) = read(handle_in(req("POST", "/api/store-damage-returns", Some(&t),
            json!({"selectedItems": [{"productId": "p1", "quantity": 1}], "reason": "broken"})), db, true).await).await;
        assert_eq!((code, d["queued"].clone()), (202, json!(true)));
        let damage_rid = seen.lock().unwrap().iter().find(|(k, _)| k == "damage").unwrap().1["_client_request_id"].clone();
        let kept_rid: String = db.with_conn(|c| c.query_row("SELECT request_id FROM offline_actions", [], |r| r.get(0))).unwrap();
        assert_eq!(json!(kept_rid), damage_rid);

        // offline: the copy logs in (no Python), reads come from memory, the rest says "needs internet"
        db.upsert_offline_logins(&[json!({"email": "ok@x.com", "id": "u1", "name": "Ravi", "role": "billing_user",
            "status": "active", "salt": "00112233445566778899aabbccddeeff", "rounds": 1000,
            "hash": hex::encode(crate::offline_db::pbkdf2_sha256(b"good", &hex::decode("00112233445566778899aabbccddeeff").unwrap(), 1000))})]).unwrap();
        let (code, off) = read(handle_in(req("POST", "/api/auth/login", None, json!({"email": "ok@x.com", "password": "good"})), db, false).await).await;
        assert_eq!(code, 200, "{off}");
        let t2 = off["access_token"].as_str().unwrap().to_string();
        assert_eq!(read(handle_in(req("POST", "/api/auth/login", None, json!({"email": "ok@x.com", "password": "nope"})), db, false).await).await.0, 401);
        let (code, p) = read(handle_in(req("GET", "/api/products", Some(&t2), Value::Null), db, false).await).await;
        assert_eq!((code, p[0]["id"].clone()), (200, json!("p1")), "the product list remembered online for this person");
        let (code, body) = read(handle_in(req("GET", "/api/bills/stats", Some(&t2), Value::Null), db, false).await).await;
        assert_eq!((code, body["code"].clone()), (503, json!("offline")));
        let (_, status) = read(handle_in(req("GET", "/api/sync/status", Some(&t2), Value::Null), db, false).await).await;
        assert_eq!((status["database_connected"].clone(), status["queue_size"].clone()), (json!(false), json!(2)));

        // logout ends that session only
        assert_eq!(read(handle_in(req("POST", "/api/auth/logout", Some(&t2), Value::Null), db, false).await).await.0, 200);
        assert_eq!(read(handle_in(req("GET", "/api/auth/check", Some(&t2), Value::Null), db, false).await).await.0, 401);
        assert_eq!(read(handle_in(req("GET", "/api/auth/check", Some(&t), Value::Null), db, false).await).await.0, 200);
    }

    #[test]
    fn python_still_starts_while_its_own_queues_hold_work() {
        let d = std::env::temp_dir().join(format!("direct-pyq-{}", std::process::id()));
        let _ = std::fs::create_dir_all(d.join("json"));
        std::fs::write(d.join("json").join("offline_bill_queue.json"), "[]").unwrap();
        let _ = std::fs::remove_file(d.join("json").join("offline_return_order_queue.json"));
        assert!(!python_has_queued_work(&d));
        std::fs::write(d.join("json").join("offline_return_order_queue.json"), r#"[{"queue_id":"x"}]"#).unwrap();
        assert!(python_has_queued_work(&d));
        std::fs::write(d.join("json").join("offline_return_order_queue.json"), "[]").unwrap();
        assert!(!python_has_queued_work(&d));
    }
}

#[cfg(test)]
mod live {
    //! Piece 6 live test (test store only): direct mode against a REAL siri-api. Needs SIRI_LIVE_API,
    //! SIRI_LIVE_EMAIL, SIRI_LIVE_PASSWORD, SIRI_LIVE_STORE, SIRI_LIVE_USER, SIRI_LIVE_PRODUCT.
    //! cargo test --bin app direct::live -- --ignored --nocapture
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn login_reads_and_one_bill_through_siri_api_with_no_python() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
        set_api(&env("SIRI_LIVE_API"));
        let db: &'static OfflineDb = Box::leak(Box::new(OfflineDb::open_in_memory().unwrap()));
        let (store, user, product) = (env("SIRI_LIVE_STORE"), env("SIRI_LIVE_USER"), env("SIRI_LIVE_PRODUCT"));
        db.upsert_records("UserStores", &[json!({"id": 1, "userId": user, "storeId": store})], "t").unwrap();
        db.upsert_records("Stores", &[json!({"id": store, "storecode": "MPD"})], "t").unwrap();
        let send = |m: &str, p: &str, t: Option<&str>, b: Value| {
            let mut r = Request::builder().method(m).uri(p).header("content-type", "application/json");
            if let Some(t) = t { r = r.header("authorization", format!("Bearer {t}")); }
            r.body(Body::from(if b.is_null() { String::new() } else { b.to_string() })).unwrap()
        };
        let read = |r: Response| async move {
            let c = r.status().as_u16();
            (c, serde_json::from_slice::<Value>(&axum::body::to_bytes(r.into_body(), 64 << 20).await.unwrap()).unwrap_or(Value::Null))
        };
        let (c, login) = read(handle_in(send("POST", "/api/auth/login", None,
            json!({"email": env("SIRI_LIVE_EMAIL"), "password": env("SIRI_LIVE_PASSWORD")})), db, true).await).await;
        assert_eq!(c, 200, "{login}");
        let t = login["access_token"].as_str().unwrap().to_string();
        println!("login: user={} role={}", login["user"]["id"], login["user_role"]);
        for p in ["/api/stores/current", "/api/settings", "/api/hsn-codes", "/api/notifications/unread/count", "/api/bills?limit=3"] {
            let (c, b) = read(handle_in(send("GET", p, Some(&t), Value::Null), db, true).await).await;
            println!("{p} -> {c} {}", b.to_string().chars().take(90).collect::<String>());
            assert_eq!(c, 200, "{p}");
        }
        let (c, products) = read(handle_in(send("GET", "/api/products", Some(&t), Value::Null), db, true).await).await;
        let n = products.as_array().map(|a| a.len()).or_else(|| products["products"].as_array().map(|a| a.len())).unwrap_or(0);
        println!("/api/products -> {c} ({n} products)");
        assert_eq!(c, 200);
        let bill = json!({"store_id": store, "items": [{"product_id": product, "quantity": 1, "unit_price": 42.86,
            "item_total": 45, "tax_percentage": 5}], "subtotal": 42.86, "tax_amount": 2.14, "total_amount": 45,
            "payment_method": "cash", "customer_name": "Walk-in Customer"});
        let (c, made) = read(handle_in(send("POST", "/api/bills", Some(&t), bill), db, true).await).await;
        println!("BILL -> {c} {made}");
        assert_eq!((c, made["queued"].clone()), (201, json!(false)));
        println!("BILL_ID={}", made["bill_id"].as_str().unwrap());
        let (c, _) = read(handle_in(send("POST", "/api/auth/logout", Some(&t), Value::Null), db, true).await).await;
        assert_eq!(c, 200);
    }
}
