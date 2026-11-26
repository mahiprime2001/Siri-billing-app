//! The Rust "front door": the app's local `/api` on 127.0.0.1:8080, in front of the Python backend.
//!
//! Milestone 1 of the Rust offline mode. With the store's `rust_front` switch on, Rust takes port 8080 (the
//! address every screen already uses) and the Python backend moves to 8081 behind it. For now every request is
//! passed through unchanged (method, path, headers, body; the answer streams back as it comes, so the live stock
//! stream keeps working). Later milestones answer routes here, from Rust's own SQLite, when there is no internet.
//!
//! With the switch off (the default) nothing changes: Python stays on 8080 and this module is not started.
//! The switch is read once at start-up from the switches the Python side last fetched from siri-api
//! (`data/siri_switches.json`, read-only); the decision is also remembered in Rust's own file so a PC that has been
//! offline for days keeps the same mode.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::{json, Value};

use crate::store_log;

pub const FRONT_PORT: u16 = 8080;
pub const BACKEND_PORT_BEHIND: u16 = 8081;
const MAX_BODY: usize = 64 * 1024 * 1024;
const SWITCH: &str = "rust_front";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static REQUESTS: AtomicU64 = AtomicU64::new(0);
static UPSTREAM_ERRORS: AtomicU64 = AtomicU64::new(0);

/// Hop-by-hop headers are about one connection, never passed on.
fn hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-connection" | "transfer-encoding" | "upgrade" | "te" | "trailer" | "host"
            | "content-length"
    )
}

/// Should this start use the front door? `python_switches` = the Python side's remembered switches file,
/// `own` = Rust's own remembered decision. A fresh answer from siri-api wins; otherwise the last decision; else off.
pub fn wanted(python_switches: &Path, own: &Path) -> bool {
    switch(python_switches, own, SWITCH)
}

/// Piece 6: is the store's `rust_direct` switch on (Rust talks to siri-api itself, no Python)? Default off.
pub fn direct_wanted(python_switches: &Path, own: &Path) -> bool {
    switch(python_switches, own, "rust_direct")
}

/// One switch, from whichever copy heard from siri-api last: the Python side's (data/siri_switches.json) or Rust's
/// own (front_door.json, written by direct mode, which runs without Python, so Python's copy then goes stale).
/// The answer is remembered in Rust's copy without touching its other switches.
fn switch(python_switches: &Path, own: &Path, name: &str) -> bool {
    let read = |p: &Path| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let at = |v: &Value| v.get("fetched_at").and_then(Value::as_f64).unwrap_or(0.0);
    let from_python = read(python_switches)
        .and_then(|v| v.pointer(&format!("/switches/{name}")).and_then(Value::as_bool).map(|on| (on, at(&v))));
    let mut mine = read(own).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let from_own = mine.get(name).and_then(Value::as_bool).map(|on| (on, at(&mine)));
    let on = match (from_python, from_own) {
        (Some((p, pa)), Some((o, oa))) => if oa > pa { o } else { p },
        (Some((p, _)), None) => p,
        (None, Some((o, _))) => o,
        (None, None) => false,
    };
    if from_own.map(|(o, _)| o) != Some(on) {
        mine[name] = json!(on);
        let _ = std::fs::write(own, mine.to_string());
    }
    on
}

pub fn own_decision_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("front_door.json")
}

/// Start serving 127.0.0.1:`front_port`, passing everything to the backend on `upstream_port`.
pub fn start(front_port: u16, upstream_port: u16) {
    tauri::async_runtime::spawn(async move {
        // piece 3: offline answers first (login, remembered reads); everything else passes to Python
        let router = Router::new().fallback(move |req: Request| crate::offline_answers::handle(req, upstream_port));
        // The port can still be held for a moment by a copy that is closing (or, after an update, by the old copy
        // left running): keep trying for up to 2 minutes instead of giving up after one try.
        let mut tries = 0u32;
        let listener = loop {
            match tokio::net::TcpListener::bind(("127.0.0.1", front_port)).await {
                Ok(l) => break Some(l),
                Err(e) => {
                    tries += 1;
                    if tries == 1 || tries % 15 == 0 {
                        let who = tokio::task::spawn_blocking(move || crate::port_guard::describe(front_port)).await.unwrap_or_default();
                        store_log::event("error", "front", &format!(
                            "front door could not take :{front_port} (try {tries}): {e}; held by {who}"));
                    }
                    if tries >= 120 {
                        break None;
                    }
                    if tries % 5 == 0 {
                        let _ = tokio::task::spawn_blocking(move || crate::port_guard::free_port(front_port, true)).await;
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        };
        match listener {
            Some(listener) => {
                let after = if tries > 0 { format!(" (after {tries} tries)") } else { String::new() };
                store_log::event("info", "front", &format!("front door on :{} -> backend :{}{}", front_port, upstream_port, after));
                if let Err(e) = axum::serve(listener, router).await {
                    store_log::event("error", "front", &format!("front door stopped: {}", e));
                }
            }
            None => store_log::event("error", "front", &format!("front door gave up on :{front_port} after 2 minutes")),
        }
    });
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let n = REQUESTS.swap(0, Ordering::Relaxed);
            let e = UPSTREAM_ERRORS.swap(0, Ordering::Relaxed);
            if n > 0 || e > 0 {
                store_log::event(if e > 0 { "warn" } else { "info" }, "front", &format!("requests={} backend_unreachable={}", n, e));
            }
        }
    });
}

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .no_proxy()                                   // localhost only: a system proxy must never sit in between
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn unavailable(msg: &str) -> Response {
    let body = json!({ "message": msg, "code": "backend_unavailable", "retryable": true }).to_string();
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
    r
}

pub async fn proxy(req: Request, upstream_port: u16) -> Response {
    REQUESTS.fetch_add(1, Ordering::Relaxed);
    let (parts, body) = req.into_parts();
    let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("http://127.0.0.1:{}{}", upstream_port, path);
    let bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => return unavailable("The request was too large"),
    };
    let method = match reqwest::Method::from_bytes(parts.method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => reqwest::Method::GET,
    };
    let mut out = client().request(method, &url).body(bytes.to_vec());
    for (name, value) in parts.headers.iter() {
        if !hop_by_hop(name.as_str()) {
            if let Ok(v) = value.to_str() {
                out = out.header(name.as_str(), v);
            }
        }
    }
    let answer = match out.send().await {
        Ok(a) => a,
        Err(_) => {
            UPSTREAM_ERRORS.fetch_add(1, Ordering::Relaxed);
            return unavailable("The billing service is starting. Please try again in a moment.");
        }
    };
    let status = StatusCode::from_u16(answer.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut headers = Vec::new();
    for (name, value) in answer.headers().iter() {
        if !hop_by_hop(name.as_str()) {
            if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(name.as_str().as_bytes()), HeaderValue::from_bytes(value.as_bytes())) {
                headers.push((n, v));
            }
        }
    }
    let mut r = Response::new(Body::from_stream(answer.bytes_stream()));
    *r.status_mut() = status;
    for (n, v) in headers {
        r.headers_mut().append(n, v);
    }
    if parts.method == Method::OPTIONS && r.status() == StatusCode::METHOD_NOT_ALLOWED {
        *r.status_mut() = StatusCode::NO_CONTENT;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("front-door-test-{}-{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn off_by_default_and_remembers_the_last_answer() {
        let d = tmp("wanted");
        let py = d.join("siri_switches.json");
        let own = d.join("front_door.json");
        let _ = std::fs::remove_file(&py);
        let _ = std::fs::remove_file(&own);
        assert!(!wanted(&py, &own));
        std::fs::write(&py, r#"{"fetched_at": 1, "switches": {"rust_front": true}}"#).unwrap();
        assert!(wanted(&py, &own));
        std::fs::remove_file(&py).unwrap();                 // the Python side's file is gone: the last decision stays
        assert!(wanted(&py, &own));
        std::fs::write(&py, r#"{"switches": {"rust_front": false}}"#).unwrap();
        assert!(!wanted(&py, &own));
    }

    #[test]
    fn with_python_stopped_rusts_newer_copy_of_the_switches_wins() {
        let d = tmp("direct-wanted");
        let py = d.join("siri_switches.json");
        let own = d.join("front_door.json");
        let _ = std::fs::remove_file(&own);
        std::fs::write(&py, r#"{"fetched_at": 100, "switches": {"rust_front": true, "rust_direct": true}}"#).unwrap();
        assert!(wanted(&py, &own) && direct_wanted(&py, &own));
        // direct mode heard from siri-api later (Python no longer runs): an admin turned rust_direct off
        std::fs::write(&own, r#"{"fetched_at": 200, "rust_front": true, "rust_direct": false}"#).unwrap();
        assert!(!direct_wanted(&py, &own), "the stale Python copy does not turn it back on");
        assert!(wanted(&py, &own));
        let kept: Value = serde_json::from_str(&std::fs::read_to_string(&own).unwrap()).unwrap();
        assert_eq!((kept["rust_direct"].clone(), kept["fetched_at"].clone()), (json!(false), json!(200)), "nothing else wiped");
    }

    #[test]
    fn hop_by_hop_headers_are_not_passed_on() {
        assert!(hop_by_hop("Connection") && hop_by_hop("transfer-encoding") && hop_by_hop("Host"));
        assert!(!hop_by_hop("Authorization") && !hop_by_hop("content-type") && !hop_by_hop("X-Access-Token"));
    }

    #[tokio::test]
    async fn requests_pass_through_unchanged_and_answers_come_back() {
        // a tiny stand-in for the Python backend
        let upstream = Router::new().fallback(|req: Request| async move {
            let (p, b) = req.into_parts();
            let body = axum::body::to_bytes(b, 1024).await.unwrap();
            let echo = json!({
                "method": p.method.as_str(),
                "path": p.uri.path_and_query().map(|x| x.as_str()).unwrap_or(""),
                "auth": p.headers.get("authorization").and_then(|v| v.to_str().ok()),
                "body": String::from_utf8_lossy(&body),
            });
            let mut r = Response::new(Body::from(echo.to_string()));
            *r.status_mut() = StatusCode::CREATED;
            r.headers_mut().insert("x-access-token", HeaderValue::from_static("fresh"));
            r
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l, upstream).await.unwrap() });

        let req = Request::builder()
            .method("POST")
            .uri("/api/bills?x=1")
            .header("authorization", "Bearer abc")
            .body(Body::from("{\"total\": 5}"))
            .unwrap();
        let r = proxy(req, port).await;
        assert_eq!(r.status(), StatusCode::CREATED);
        assert_eq!(r.headers().get("x-access-token").unwrap(), "fresh");
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(r.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["method"], "POST");
        assert_eq!(body["path"], "/api/bills?x=1");
        assert_eq!(body["auth"], "Bearer abc");
        assert_eq!(body["body"], "{\"total\": 5}");
    }

    #[tokio::test]
    async fn a_backend_that_is_not_running_gives_a_clear_503() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);                                             // nothing listens there now
        let r = proxy(Request::builder().uri("/api/health").body(Body::empty()).unwrap(), port).await;
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}

#[cfg(test)]
mod live {
    //! Against a REAL Python backend: `SIRI_LIVE_BACKEND_PORT=8081 cargo test --bin app front_door::live -- --ignored`
    use super::*;

    fn port() -> u16 {
        std::env::var("SIRI_LIVE_BACKEND_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8081)
    }

    #[tokio::test]
    #[ignore]
    async fn health_and_a_failed_login_come_back_from_the_real_backend() {
        let r = proxy(Request::builder().uri("/api/health").body(Body::empty()).unwrap(), port()).await;
        assert_eq!(r.status(), StatusCode::OK);
        let login = Request::builder()
            .method("POST")
            .uri("/api/auth/login")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"email":"nobody@example.invalid","password":"x"}"#))
            .unwrap();
        let r = proxy(login, port()).await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    #[ignore]
    async fn the_live_stock_stream_starts_streaming_through_the_door() {
        let r = proxy(Request::builder().uri("/api/stock/stream").body(Body::empty()).unwrap(), port()).await;
        // without a login the backend refuses or starts the stream; either way an answer comes back promptly
        assert!(r.status().as_u16() < 500, "status {}", r.status());
    }
}
