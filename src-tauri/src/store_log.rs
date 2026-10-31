//! Store-side event log, shipped to the VPS as plain-text .log files.
//!
//! * `event()` appends one readable line to `<app data>/logs/store-events-YYYY-MM-DD.log`.
//! * A background thread tails those files, plus the Flask sidecar's own
//!   `data/logs/*.log`, and POSTs new lines to siri-api (`/api/client-logs`).
//!   The byte offset of what has been sent is kept in `.upload-state.json`, so
//!   nothing is lost across restarts or while offline, and nothing is sent twice.
//! * A heartbeat line is written every few minutes with the sidecar's state
//!   (pending / failed offline changes, last sync), so a store that silently
//!   stops syncing shows up in the log.
//!
//! Logs hold ids, counts and error text only -- never passwords, tokens or
//! customer details.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime};

use chrono::Local;
use serde::{Deserialize, Serialize};

const DEFAULT_API_BASE: &str = "https://api.ifleon.com";
const UPLOAD_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(300);
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const RECENT_FILE_AGE: Duration = Duration::from_secs(3 * 24 * 3600);
const MAX_MESSAGE_CHARS: usize = 2000;
const STATE_FILE: &str = ".upload-state.json";

#[derive(Clone, Default)]
struct Context {
    api_base: String,
    log_key: String,
    store_id: String,
    store_name: String,
}

struct State {
    logs_dir: PathBuf,
    flask_logs_dir: Option<PathBuf>,
    device_id: String,
    app_version: String,
    ctx: Context,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static LAST_UPLOAD_WARNING: Mutex<Option<SystemTime>> = Mutex::new(None);

fn sanitize_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(40)
        .collect();
    if cleaned.is_empty() { "pc".into() } else { cleaned }
}

/// A stable id for this installation, kept in `device-id.txt` next to the logs.
fn load_or_create_device_id(logs_dir: &Path) -> String {
    let path = logs_dir.join("device-id.txt");
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return existing.to_string();
        }
    }
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let host = sanitize_id(&std::env::var("COMPUTERNAME").unwrap_or_default());
    let suffix = (nanos ^ ((std::process::id() as u128) << 7)) & 0xFF_FFFF;
    let id = format!("{}-{:06x}", host, suffix);
    let _ = fs::write(&path, &id);
    id
}

/// Sets up logging. Call once at startup, before `event()` or `start_background()`.
pub fn init(logs_dir: PathBuf, app_version: String) {
    let _ = fs::create_dir_all(&logs_dir);
    let device_id = load_or_create_device_id(&logs_dir);
    let flask_logs_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("data").join("logs")));
    let _ = STATE.set(Mutex::new(State {
        logs_dir,
        flask_logs_dir,
        device_id,
        app_version,
        ctx: Context::default(),
    }));
}

type Snapshot = (PathBuf, Option<PathBuf>, String, String, Context);

fn snapshot() -> Option<Snapshot> {
    let state = STATE.get()?.lock().ok()?;
    Some((
        state.logs_dir.clone(),
        state.flask_logs_dir.clone(),
        state.device_id.clone(),
        state.app_version.clone(),
        state.ctx.clone(),
    ))
}

/// Appends one line to today's store-events log.
/// Format: `2026-10-31 10:02:11.123 +05:30 | INFO  | sync | store=NLR | message`
pub fn event(level: &str, category: &str, message: &str) {
    let Some((logs_dir, _, _, _, ctx)) = snapshot() else { return };
    let now = Local::now();
    let mut msg: String = message.replace(['\r', '\n'], " ");
    if msg.chars().count() > MAX_MESSAGE_CHARS {
        msg = msg.chars().take(MAX_MESSAGE_CHARS).collect::<String>() + "...";
    }
    let store = if ctx.store_id.is_empty() { "-" } else { ctx.store_id.as_str() };
    let line = format!(
        "{} | {:<5} | {} | store={} | {}\n",
        now.format("%Y-%m-%d %H:%M:%S%.3f %:z"),
        level.to_uppercase(),
        category,
        store,
        msg
    );
    let path = logs_dir.join(format!("store-events-{}.log", now.format("%Y-%m-%d")));
    let _guard = WRITE_LOCK.lock();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn set_context(api_base: Option<String>, log_key: String, store_id: String, store_name: String) {
    if let Some(state) = STATE.get() {
        if let Ok(mut state) = state.lock() {
            state.ctx = Context {
                api_base: api_base
                    .filter(|b| !b.trim().is_empty())
                    .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
                    .trim_end_matches('/')
                    .to_string(),
                log_key,
                store_id: sanitize_id(&store_id),
                store_name,
            };
        }
    }
    event("info", "context", "log context set");
}

// ---- upload -----------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct UploadState {
    offsets: HashMap<String, u64>,
}

fn load_upload_state(logs_dir: &Path) -> UploadState {
    fs::read_to_string(logs_dir.join(STATE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_upload_state(logs_dir: &Path, state: &UploadState) {
    if let Ok(json) = serde_json::to_string(state) {
        let _ = fs::write(logs_dir.join(STATE_FILE), json);
    }
}

fn recent_log_files(dir: &Path, prefix: Option<&str>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else { return files };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".log") || prefix.map_or(false, |p| !name.starts_with(p)) {
            continue;
        }
        let recent = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map_or(true, |age| age < RECENT_FILE_AGE);
        if recent {
            files.push(path);
        }
    }
    files.sort();
    files
}

struct Sender<'a> {
    client: &'a reqwest::blocking::Client,
    ctx: &'a Context,
    device_id: &'a str,
    app_version: &'a str,
    logs_dir: &'a Path,
}

impl Sender<'_> {
    /// Ships one chunk. On success records the new offset on disk and returns true.
    fn send(&self, state: &mut UploadState, key: &str, source: &str, file_name: &str, offset: u64, bytes: &[u8]) -> bool {
        let body = serde_json::json!({
            "store_id": if self.ctx.store_id.is_empty() { "unknown-store" } else { self.ctx.store_id.as_str() },
            "store_name": self.ctx.store_name,
            "device_id": self.device_id,
            "app_version": self.app_version,
            "source": source,
            "file": file_name,
            "offset": offset,
            "text": String::from_utf8_lossy(bytes),
        });
        let api = if self.ctx.api_base.is_empty() { DEFAULT_API_BASE } else { self.ctx.api_base.as_str() };
        let result = self
            .client
            .post(format!("{}/api/client-logs", api))
            .header("X-Log-Key", &self.ctx.log_key)
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send();
        match result {
            Ok(resp) if resp.status().is_success() => {
                state.offsets.insert(key.to_string(), offset + bytes.len() as u64);
                save_upload_state(self.logs_dir, state);
                true
            }
            Ok(resp) => {
                warn_rate_limited(&format!("log upload rejected by server: HTTP {}", resp.status()));
                false
            }
            Err(e) => {
                // Offline is normal for a store; keep the note short and rare.
                warn_rate_limited(&format!("log upload failed (will retry): {}", e));
                false
            }
        }
    }
}

/// Sends new complete lines of every recent log file. Returns bytes still waiting.
fn upload_once(client: &reqwest::blocking::Client) -> u64 {
    let Some((logs_dir, flask_dir, device_id, app_version, ctx)) = snapshot() else { return 0 };
    let mut sources: Vec<(&str, PathBuf)> = recent_log_files(&logs_dir, Some("store-events-"))
        .into_iter()
        .map(|p| ("app", p))
        .collect();
    if let Some(dir) = flask_dir {
        sources.extend(recent_log_files(&dir, None).into_iter().map(|p| ("flask", p)));
    }

    let sender = Sender { client, ctx: &ctx, device_id: &device_id, app_version: &app_version, logs_dir: &logs_dir };
    let mut state = load_upload_state(&logs_dir);
    let uploads_enabled = !ctx.log_key.is_empty();
    let mut backlog: u64 = 0;
    let mut halted = false;

    for (source, path) in sources {
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let key = format!("{}/{}", source, file_name);
        let Ok(meta) = fs::metadata(&path) else { continue };
        let len = meta.len();
        let mut offset = *state.offsets.get(&key).unwrap_or(&0);
        if offset > len {
            offset = 0; // file was replaced or truncated
        }

        while offset < len {
            if !uploads_enabled || halted {
                backlog += len - offset;
                break;
            }
            let Ok(mut file) = fs::File::open(&path) else { break };
            if file.seek(SeekFrom::Start(offset)).is_err() {
                break;
            }
            let mut buf = vec![0u8; ((len - offset) as usize).min(MAX_CHUNK_BYTES)];
            let Ok(read) = file.read(&mut buf) else { break };
            buf.truncate(read);
            // Only ship whole lines; a half-written line waits for the next round.
            let chunk_len = match buf.iter().rposition(|&b| b == b'\n') {
                Some(i) => i + 1,
                None if buf.len() >= MAX_CHUNK_BYTES => buf.len(), // one huge line: send as-is
                None => break,
            };
            if !sender.send(&mut state, &key, source, &file_name, offset, &buf[..chunk_len]) {
                halted = true;
                backlog += len - offset;
                break;
            }
            offset += chunk_len as u64;
        }
    }
    save_upload_state(&logs_dir, &state);
    backlog
}

fn warn_rate_limited(message: &str) {
    let due = {
        let mut last = match LAST_UPLOAD_WARNING.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        let due = last.map_or(true, |t| t.elapsed().map_or(true, |e| e > Duration::from_secs(600)));
        if due {
            *last = Some(SystemTime::now());
        }
        due
    };
    if due {
        event("warn", "log-upload", message);
    }
}

// ---- heartbeat --------------------------------------------------------------

fn heartbeat(client: &reqwest::blocking::Client, backlog: u64) {
    let sidecar = match client.get("http://127.0.0.1:8080/api/sync/status").send() {
        Ok(resp) if resp.status().is_success() => match resp.text().ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).ok_or(()) {
            Ok(v) => {
                let get = |k: &str| v.get(k).map(|x| x.to_string()).unwrap_or_else(|| "?".into());
                format!(
                    "sidecar=up pending_changes={} failed_changes={} last_sync={}",
                    get("pendingChanges"),
                    get("failedChanges"),
                    get("lastSync")
                )
            }
            Err(_) => "sidecar=up (status unreadable)".into(),
        },
        Ok(resp) => format!("sidecar=up (status HTTP {})", resp.status()),
        Err(e) => format!("sidecar=DOWN ({})", e),
    };
    event("info", "heartbeat", &format!("{} log_backlog_bytes={}", sidecar, backlog));
}

/// Starts the upload and heartbeat thread. Call after `init()`.
pub fn start_background() {
    let _ = thread::Builder::new().name("store-log-upload".into()).spawn(|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        let local = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        thread::sleep(Duration::from_secs(20));
        let mut last_heartbeat: Option<SystemTime> = None;
        loop {
            let backlog = upload_once(&client);
            let due = last_heartbeat.map_or(true, |t| t.elapsed().map_or(true, |e| e >= HEARTBEAT_INTERVAL));
            if due {
                heartbeat(&local, backlog);
                last_heartbeat = Some(SystemTime::now());
            }
            thread::sleep(UPLOAD_INTERVAL);
        }
    });
}

/// Deletes .log files older than `max_age_days` (keeps recent history, unlike a wipe on every start).
pub fn prune_old(logs_dir: &Path, max_age_days: u64) {
    let max_age = Duration::from_secs(max_age_days * 24 * 3600);
    let Ok(entries) = fs::read_dir(logs_dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map_or(false, |age| age > max_age);
        if old {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes real log lines, uploads them to a running siri-api (SIRI_TEST_API + SIRI_TEST_KEY),
    /// uploads again to prove nothing is sent twice. Skipped when SIRI_TEST_API is unset.
    #[test]
    fn writes_lines_and_uploads_once() {
        let Ok(api) = std::env::var("SIRI_TEST_API") else { return };
        let key = std::env::var("SIRI_TEST_KEY").unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("store-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        init(dir.clone(), "test-1.0".into());
        set_context(Some(api), key, "store-test".into(), "Test Store".into());
        event("info", "sync", "pulled products=8045 stores=3");
        event("error", "bill", "bill INV-1 failed: connection reset");

        let today = Local::now().format("%Y-%m-%d");
        let text = fs::read_to_string(dir.join(format!("store-events-{}.log", today))).unwrap();
        assert!(text.contains("| INFO  | sync | store=store-test | pulled products=8045"), "{}", text);
        assert!(text.contains("| ERROR | bill |"), "{}", text);

        let client = reqwest::blocking::Client::new();
        assert_eq!(upload_once(&client), 0, "everything should upload");
        let after_first = fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert_eq!(upload_once(&client), 0);
        assert_eq!(after_first, fs::read_to_string(dir.join(STATE_FILE)).unwrap());
        println!("DEVICE={}", load_or_create_device_id(&dir));
    }
}
