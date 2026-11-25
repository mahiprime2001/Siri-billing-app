//! Rust offline mode, piece 3: the front door answers from Rust's own database when there is no internet.
//!
//! * Knowing "offline": every 15 s Rust asks siri-api's /health (4 s limit). No answer = offline.
//! * Login offline: the email + password are checked against Rust's scrambled copies (every cashier of the store,
//!   piece 2). A match asks the local Python backend for the normal session over a route only the front door can
//!   use (a one-time key given to Python at start), so the token works everywhere Python still answers (offline
//!   billing, until piece 4). No copy for that person, or a wrong password: Python's own offline login answers, as
//!   before.
//! * Reads offline: while online, the last good answer to each read the screens make (settings, stores, store links,
//!   HSN codes, customers, notifications, "who am I", users) is remembered per person; offline it is replayed.
//!   Anything not remembered yet still goes to Python. Products, stock and bills are NOT replayed: offline sales
//!   change them and only Python tracks that until piece 4.
//! Online, nothing here changes an answer: requests pass through to Python exactly as in piece 1.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::offline_db::OfflineDb;
use crate::{front_door, shadow, store_log};

static ONLINE: AtomicBool = AtomicBool::new(true);
static FRONT_KEY: OnceLock<String> = OnceLock::new();
static REPLAYED: AtomicU64 = AtomicU64::new(0);
static OFFLINE_LOGINS: AtomicU64 = AtomicU64::new(0);

const MAX_REMEMBERED: usize = 32 * 1024 * 1024;

/// Reads the screens make that do not change with offline sales: remembered online, replayed offline.
const REPLAYABLE: &[&str] = &[
    "/api/settings", "/api/stores", "/api/user-stores", "/api/stores/current", "/api/hsn-codes", "/api/customers",
    "/api/auth/me", "/api/auth/check", "/api/notifications", "/api/notifications/unread/count", "/api/users",
];

pub fn set_front_key(key: String) {
    let _ = FRONT_KEY.set(key);
}

pub fn is_online() -> bool {
    ONLINE.load(Ordering::Relaxed)
}

/// Watch the internet (siri-api's /health) and log when it changes; also a per-minute summary of offline answers.
pub fn start_watch(api_base: &'static str) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().unwrap_or_default();
        loop {
            let up = client.get(format!("{api_base}/health")).send().await.map(|r| r.status().is_success()).unwrap_or(false);
            if ONLINE.swap(up, Ordering::Relaxed) != up {
                store_log::event(if up { "info" } else { "warn" }, "front",
                                 if up { "internet back: answers come from the backend again" }
                                 else { "no internet: Rust answers login and remembered reads" });
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let r = REPLAYED.swap(0, Ordering::Relaxed);
            let l = OFFLINE_LOGINS.swap(0, Ordering::Relaxed);
            if r > 0 || l > 0 {
                store_log::event("info", "front", &format!("offline answers by Rust: reads={r} logins={l}"));
            }
        }
    });
}

/// The front door's entry point (live: the real database, online flag and key).
pub async fn handle(req: Request, upstream_port: u16) -> Response {
    let key = FRONT_KEY.get().cloned().unwrap_or_default();
    handle_with(req, upstream_port, shadow::database(), is_online(), &key).await
}

fn replayable(method: &Method, path: &str) -> bool {
    method == Method::GET && REPLAYABLE.contains(&path)
}

/// Who is asking (the token's `sub`), so one cashier's remembered answer is never shown to another.
/// The token is only read here, not checked: Python checks it on every online request, and the replay only ever
/// hands back what this same person was already shown online.
fn person(headers: &HeaderMap) -> String {
    let from_header = headers.get("authorization").and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ")).map(str::to_string);
    let from_cookie = headers.get("cookie").and_then(|v| v.to_str().ok()).and_then(|c| {
        c.split(';').map(str::trim).find_map(|kv| kv.strip_prefix("access_token_cookie=").map(str::to_string))
    });
    let Some(token) = from_header.or(from_cookie) else { return String::from("-") };
    token.split('.').nth(1).and_then(base64url).and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("sub").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| String::from("-"))
}

fn base64url(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = status;
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
    r
}

pub async fn handle_with(req: Request, upstream_port: u16, db: Option<&'static OfflineDb>, online: bool, key: &str)
                         -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let path_and_query = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| path.clone());

    // ---- login with no internet: Rust's scrambled copies (every cashier of the store)
    if !online && method == Method::POST && path == "/api/auth/login" {
        if let Some(db) = db {
            let (parts, body) = req.into_parts();
            let bytes = axum::body::to_bytes(body, 64 * 1024).await.unwrap_or_default();
            let creds: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let email = creds.get("email").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
            let password = creds.get("password").and_then(Value::as_str).unwrap_or("").to_string();
            let checked = if email.is_empty() || password.is_empty() {
                None
            } else {
                // PBKDF2 takes a moment: keep it off the async threads
                tokio::task::spawn_blocking(move || db.check_offline_login(&email, &password)).await.ok().flatten()
            };
            if let (Some(user), false) = (checked, key.is_empty()) {
                let session = Request::builder()
                    .method("POST")
                    .uri("/api/auth/front-door-session")
                    .header("content-type", "application/json")
                    .header("X-Front-Door-Key", key)
                    .body(Body::from(user.to_string()))
                    .unwrap();
                let answer = front_door::proxy(session, upstream_port).await;
                if answer.status() == StatusCode::OK {
                    OFFLINE_LOGINS.fetch_add(1, Ordering::Relaxed);
                    return answer;
                }
            }
            // no copy, a wrong password or no session: Python's own offline login decides, as before
            let again = Request::from_parts(parts, Body::from(bytes));
            return front_door::proxy(again, upstream_port).await;
        }
    }

    if replayable(&method, &path) {
        let who = person(req.headers());
        let answer_key = format!("{who}|GET {path_and_query}");
        if !online {
            if let Some((status, ctype, body, saved_at)) = db.and_then(|d| d.get_answer(&answer_key)) {
                REPLAYED.fetch_add(1, Ordering::Relaxed);
                let mut r = Response::new(Body::from(body));
                *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
                if let Ok(v) = HeaderValue::from_str(&ctype) {
                    r.headers_mut().insert("content-type", v);
                }
                if let Ok(v) = HeaderValue::from_str(&saved_at) {
                    r.headers_mut().insert("x-offline-answer-from", v);
                }
                return r;
            }
            return front_door::proxy(req, upstream_port).await;
        }
        // online: pass through, and remember a good JSON answer for later
        let answer = front_door::proxy(req, upstream_port).await;
        let ctype = answer.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if answer.status() == StatusCode::OK && ctype.starts_with("application/json") && who != "-" {
            if let Some(db) = db {
                let (parts, body) = answer.into_parts();
                let bytes = match axum::body::to_bytes(body, MAX_REMEMBERED).await {
                    Ok(b) => b,
                    Err(_) => return json_response(StatusCode::BAD_GATEWAY, json!({"message": "answer too large"})),
                };
                let _ = db.save_answer(&answer_key, 200, &ctype, &bytes);
                return Response::from_parts(parts, Body::from(bytes));
            }
        }
        return answer;
    }

    front_door::proxy(req, upstream_port).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn token(sub: &str) -> String {
        let b64 = |v: &[u8]| {
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut s = String::new();
            for chunk in v.chunks(3) {
                let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | ((*b as u32) << (16 - 8 * i)));
                for i in 0..(chunk.len() + 1) {
                    s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            s
        };
        format!("x.{}.sig", b64(json!({"sub": sub}).to_string().as_bytes()))
    }

    /// A stand-in for the Python backend: counts calls, echoes the path, and serves the front-door session.
    async fn fake_python(calls: Arc<AtomicUsize>) -> u16 {
        let app = Router::new().fallback(move |req: Request| {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::Relaxed);
                let path = req.uri().path().to_string();
                let key = req.headers().get("x-front-door-key").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let body = if path == "/api/auth/front-door-session" {
                    if key != "k1" {
                        return json_response(StatusCode::NOT_FOUND, json!({}));
                    }
                    json!({"auth_ok": true, "access_token": "from-python", "via": "front-door"})
                } else if path == "/api/auth/login" {
                    return json_response(StatusCode::UNAUTHORIZED, json!({"message": "Invalid email or password"}));
                } else {
                    json!({"path": path, "n": calls.load(Ordering::Relaxed)})
                };
                json_response(StatusCode::OK, body)
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        port
    }

    fn get(path: &str, who: &str) -> Request {
        Request::builder().uri(path).header("authorization", format!("Bearer {}", token(who))).body(Body::empty()).unwrap()
    }

    async fn body(r: Response) -> Value {
        serde_json::from_slice(&axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap()).unwrap()
    }

    fn leak(db: OfflineDb) -> &'static OfflineDb {
        Box::leak(Box::new(db))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reads_are_remembered_online_and_replayed_offline_per_person() {
        let calls = Arc::new(AtomicUsize::new(0));
        let port = fake_python(calls.clone()).await;
        let db = leak(OfflineDb::open_in_memory().unwrap());
        let online = handle_with(get("/api/settings", "u1"), port, Some(db), true, "k1").await;
        assert_eq!(body(online).await["path"], "/api/settings");
        let before = calls.load(Ordering::Relaxed);
        let offline = handle_with(get("/api/settings", "u1"), port, Some(db), false, "k1").await;
        assert!(offline.headers().get("x-offline-answer-from").is_some());
        assert_eq!(body(offline).await["path"], "/api/settings");
        assert_eq!(calls.load(Ordering::Relaxed), before, "the remembered answer did not ask Python");
        // another person has nothing remembered: Python answers for them
        handle_with(get("/api/settings", "u2"), port, Some(db), false, "k1").await;
        assert_eq!(calls.load(Ordering::Relaxed), before + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn products_and_bills_always_go_to_python_even_offline() {
        let calls = Arc::new(AtomicUsize::new(0));
        let port = fake_python(calls.clone()).await;
        let db = leak(OfflineDb::open_in_memory().unwrap());
        for path in ["/api/products", "/api/bills"] {
            handle_with(get(path, "u1"), port, Some(db), true, "k1").await;
            handle_with(get(path, "u1"), port, Some(db), false, "k1").await;
        }
        assert_eq!(calls.load(Ordering::Relaxed), 4);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn offline_login_uses_rusts_copy_and_gets_the_session_from_python() {
        let calls = Arc::new(AtomicUsize::new(0));
        let port = fake_python(calls.clone()).await;
        let db = leak(OfflineDb::open_in_memory().unwrap());
        let salt = hex::decode("00112233445566778899aabbccddeeff").unwrap();
        db.upsert_offline_logins(&[json!({"id": "u1", "email": "a@x.com", "name": "Asha", "role": "billing_user",
            "status": "active", "salt": hex::encode(&salt),
            "hash": hex::encode(crate::offline_db::pbkdf2_sha256(b"testing", &salt, 1000)), "rounds": 1000})]).unwrap();
        let login = |pw: &str| Request::builder().method("POST").uri("/api/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(json!({"email": "A@x.com", "password": pw}).to_string())).unwrap();

        let ok = handle_with(login("testing"), port, Some(db), false, "k1").await;
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(body(ok).await["via"], "front-door");

        let wrong = handle_with(login("nope"), port, Some(db), false, "k1").await;
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED, "a wrong password goes to Python's own login");

        let no_key = handle_with(login("testing"), port, Some(db), false, "").await;
        assert_eq!(no_key.status(), StatusCode::UNAUTHORIZED, "without the one-time key Rust cannot get a session");

        let online = handle_with(login("testing"), port, Some(db), true, "k1").await;
        assert_eq!(online.status(), StatusCode::UNAUTHORIZED, "online, the login is always Python's (siri-api checks)");
    }

    #[test]
    fn the_person_is_read_from_the_header_or_the_cookie() {
        let mut h = HeaderMap::new();
        assert_eq!(person(&h), "-");
        h.insert("cookie", HeaderValue::from_str(&format!("a=1; access_token_cookie={}", token("u7"))).unwrap());
        assert_eq!(person(&h), "u7");
        h.insert("authorization", HeaderValue::from_str(&format!("Bearer {}", token("u8"))).unwrap());
        assert_eq!(person(&h), "u8");
    }
}

#[cfg(test)]
mod live {
    //! Piece 3 against the REAL Python backend (SIRI_LIVE_BACKEND_PORT, started with SIRI_FRONT_KEY=SIRI_LIVE_KEY) and
    //! a REAL siri-api for the login copies (SIRI_LIVE_API + SIRI_LIVE_PYDATA with a store login, SIRI_LIVE_EMAIL,
    //! SIRI_LIVE_PASSWORD). cargo test --bin app offline_answers::live -- --ignored --nocapture
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn offline_login_and_replayed_reads_with_the_real_backend() {
        let env = |k: &str| std::env::var(k).expect(k);
        let port: u16 = env("SIRI_LIVE_BACKEND_PORT").parse().unwrap();
        let (api, key, email, password) = (env("SIRI_LIVE_API"), env("SIRI_LIVE_KEY"), env("SIRI_LIVE_EMAIL"), env("SIRI_LIVE_PASSWORD"));
        let pydata = std::path::PathBuf::from(env("SIRI_LIVE_PYDATA"));
        let db: &'static OfflineDb = Box::leak(Box::new(OfflineDb::open_in_memory().unwrap()));
        let copied = tokio::task::spawn_blocking(move || crate::rust_sync::run_once(db, &pydata, &api)).await.unwrap();
        println!("copied: {:?}", copied);

        let login = |pw: &str| Request::builder().method("POST").uri("/api/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(json!({"email": email, "password": pw}).to_string())).unwrap();
        let r = handle_with(login(&password), port, Some(db), false, &key).await;
        let status = r.status();
        let b: Value = serde_json::from_slice(&axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap()).unwrap();
        println!("offline login: {} user={}", status, b["user"]);
        assert_eq!(status, StatusCode::OK);
        let token = b["access_token"].as_str().unwrap().to_string();

        let wrong = handle_with(login("wrong-password"), port, Some(db), false, &key).await;
        println!("offline wrong password: {}", wrong.status());
        assert_ne!(wrong.status(), StatusCode::OK);

        // the token Python issued works on a real route, and the answer is remembered then replayed offline
        let settings = || Request::builder().uri("/api/settings").header("authorization", format!("Bearer {token}")).body(Body::empty()).unwrap();
        let online = handle_with(settings(), port, Some(db), true, &key).await;
        println!("settings online with the offline-login token: {}", online.status());
        assert_eq!(online.status(), StatusCode::OK);
        let first = axum::body::to_bytes(online.into_body(), 1 << 22).await.unwrap();
        let offline = handle_with(settings(), port, Some(db), false, &key).await;
        assert!(offline.headers().get("x-offline-answer-from").is_some(), "replayed by Rust");
        let again = axum::body::to_bytes(offline.into_body(), 1 << 22).await.unwrap();
        assert_eq!(first, again, "the replay is exactly what the screen got online");
        println!("settings replayed offline: {} bytes, identical", again.len());
    }
}
