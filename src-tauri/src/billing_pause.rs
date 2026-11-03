//! "Pause billing at this store while an audit runs" -- the store's side.
//!
//! The admin can pause a store's billing for the length of an audit (a flag on the audit session
//! in siri-api). This module asks siri-api every ~30 s, using the same shared key and store id as
//! the log uploader, and keeps the answer where the two things that must obey it can read it:
//!
//!   * the screen   -- `get_billing_pause` (a Tauri command the page polls) drives the blocking dialog;
//!   * the backend  -- a small JSON file the Flask sidecar reads before it creates any bill, so the
//!                     rule holds even if someone gets around the dialog.
//!
//! Offline safety: an answer is only believed for `MAX_ANSWER_AGE`. If siri-api can't be reached
//! for longer than that, billing goes back to normal -- a PC that lost internet while "paused"
//! must not stay frozen for days. (The flip side: an offline store can't hear a new pause.)

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::store_log;

const CHECK_INTERVAL: Duration = Duration::from_secs(30);
const WAIT_FOR_CONTEXT: Duration = Duration::from_secs(3);
pub const MAX_ANSWER_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Default, Serialize, Debug, PartialEq)]
pub struct PauseInfo {
    pub paused: bool,
    pub message: String,
    pub since: Option<String>,
}

struct Known {
    info: PauseInfo,
    checked_at: Option<SystemTime>,
}

static KNOWN: Mutex<Known> = Mutex::new(Known {
    info: PauseInfo { paused: false, message: String::new(), since: None },
    checked_at: None,
});

/// Reads siri-api's answer. `None` unless it clearly says `paused` is true or false.
pub fn parse_answer(body: &str) -> Option<PauseInfo> {
    let value: Value = serde_json::from_str(body).ok()?;
    let paused = value.get("paused")?.as_bool()?;
    Some(PauseInfo {
        paused,
        message: value.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
        since: value.get("since").and_then(Value::as_str).map(str::to_string),
    })
}

/// What to act on: the last answer, but only while it is fresh enough to believe.
pub fn effective(info: &PauseInfo, age: Option<Duration>) -> PauseInfo {
    match age {
        Some(age) if age <= MAX_ANSWER_AGE => info.clone(),
        _ => PauseInfo::default(),
    }
}

/// What the screen should show right now.
pub fn current() -> PauseInfo {
    let Ok(known) = KNOWN.lock() else { return PauseInfo::default() };
    effective(&known.info, known.checked_at.and_then(|t| t.elapsed().ok()))
}

fn epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The file the Flask sidecar reads. Written (temp file + rename, so a reader never sees half
/// of it) after every successful check; it simply goes stale if checks stop succeeding.
pub fn write_flag_file(path: &Path, info: &PauseInfo, checked_at_epoch: u64) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let body = json!({
        "paused": info.paused,
        "message": info.message,
        "since": info.since,
        "checkedAtEpoch": checked_at_epoch,
    });
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body.to_string())?;
    fs::rename(&tmp, path)
}

fn check_once(client: &reqwest::blocking::Client, flag_file: &Path) {
    let Some((api_base, key, store_id)) = store_log::context() else { return };
    let url = format!("{api_base}/api/stores/{store_id}/billing-status");
    let response = match client.get(&url).header("X-Log-Key", key).send() {
        Ok(r) if r.status().is_success() => r,
        // Wrong key, server trouble, no internet: say nothing new -- the last answer ages out by itself.
        _ => return,
    };
    let Some(answer) = response.text().ok().and_then(|t| parse_answer(&t)) else { return };

    let was_paused = {
        let Ok(mut known) = KNOWN.lock() else { return };
        let before = effective(&known.info, known.checked_at.and_then(|t| t.elapsed().ok())).paused;
        known.info = answer.clone();
        known.checked_at = Some(SystemTime::now());
        before
    };
    if let Err(e) = write_flag_file(flag_file, &answer, epoch_secs()) {
        store_log::event("warn", "billing", &format!("could not write {}: {e}", flag_file.display()));
    }
    if answer.paused && !was_paused {
        store_log::event("warn", "billing", &format!("billing PAUSED by the admin (audit in progress), since {}", answer.since.as_deref().unwrap_or("?")));
    } else if !answer.paused && was_paused {
        store_log::event("info", "billing", "billing RESUMED (audit finished or pause switched off)");
    }
}

/// Starts the checker. Call once at startup, after `store_log::init`.
pub fn start(flag_file: PathBuf) {
    let _ = thread::Builder::new().name("billing-pause".into()).spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        loop {
            if store_log::context().is_some() {
                check_once(&client, &flag_file);
                thread::sleep(CHECK_INTERVAL);
            } else {
                // Not signed in yet: look again soon, so the first check follows login quickly.
                thread::sleep(WAIT_FOR_CONTEXT);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_paused_answer() {
        let info = parse_answer(r#"{"paused":true,"message":"An audit is in progress","since":"2026-11-03T06:00:00+00:00","startedBy":"Asha","pollSeconds":30}"#).unwrap();
        assert_eq!(info, PauseInfo { paused: true, message: "An audit is in progress".into(), since: Some("2026-11-03T06:00:00+00:00".into()) });
    }

    #[test]
    fn reads_a_not_paused_answer_with_nulls() {
        let info = parse_answer(r#"{"paused":false,"message":null,"since":null}"#).unwrap();
        assert_eq!(info, PauseInfo { paused: false, message: String::new(), since: None });
    }

    #[test]
    fn anything_unclear_is_not_an_answer() {
        for body in ["", "nope", "[]", "{}", r#"{"paused":"yes"}"#, r#"{"paused":1}"#, r#"{"paused":null}"#, r#"{"error":"Forbidden"}"#] {
            assert_eq!(parse_answer(body), None, "{body:?} must not count as an answer");
        }
    }

    #[test]
    fn a_fresh_answer_is_believed_and_an_old_one_is_not() {
        let paused = PauseInfo { paused: true, message: "m".into(), since: None };
        assert!(effective(&paused, Some(Duration::from_secs(5))).paused);
        assert!(effective(&paused, Some(MAX_ANSWER_AGE)).paused);
        assert!(!effective(&paused, Some(MAX_ANSWER_AGE + Duration::from_secs(1))).paused);
        assert!(!effective(&paused, None).paused, "never checked yet means not paused");
        assert_eq!(effective(&paused, None), PauseInfo::default());
    }

    // ---- end-to-end against a RUNNING siri-api (skipped unless asked for) ----
    //
    // Driven by the script that starts a local siri-api and sets SIRI_TEST_API, SIRI_TEST_KEY
    // (the shared X-Log-Key), SIRI_TEST_STORE, SIRI_TEST_ADMIN_TOKEN (an admin login) and
    // SIRI_TEST_OUT (a scratch folder). Runs the REAL checker (`check_once`) through a whole
    // audit and leaves `paused.json` / `resumed.json` snapshots for the backend side to read.

    fn call(client: &reqwest::blocking::Client, api: &str, admin: &str, method: &str, path: &str, body: &str) -> (u16, Value) {
        let url = format!("{api}{path}");
        let builder = match method {
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            _ => client.get(&url),
        };
        let resp = builder
            .header("Authorization", format!("Bearer {admin}"))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    #[test]
    #[ignore = "needs a running siri-api; see the comment above"]
    fn against_a_running_siri_api() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        let (api, key, store, admin) = (var("SIRI_TEST_API"), var("SIRI_TEST_KEY"), var("SIRI_TEST_STORE"), var("SIRI_TEST_ADMIN_TOKEN"));
        let out = PathBuf::from(var("SIRI_TEST_OUT"));
        fs::create_dir_all(&out).unwrap();
        store_log::init(out.join("logs"), "test".into());
        let flag = out.join("data").join("billing-pause.json");
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build().unwrap();
        let flag_paused = || -> bool {
            let v: Value = serde_json::from_str(&fs::read_to_string(&flag).expect("flag file written")).unwrap();
            v["paused"].as_bool().unwrap()
        };

        // Not signed in yet (no store context): the checker does nothing and billing is normal.
        check_once(&client, &flag);
        assert!(!current().paused && !flag.exists(), "no context must mean no check");

        store_log::set_context(Some(api.clone()), key.clone(), store.clone(), "Test store".into());

        // 1. no audit running
        check_once(&client, &flag);
        assert!(!current().paused);
        assert!(!flag_paused(), "the file is written even when not paused");

        // 2. the admin starts an audit WITH the pause tick
        let (s, v) = call(&client, &api, &admin, "POST", &format!("/api/stores/{store}/audit-session"),
            r#"{"deviceId":"it-dev","startedBy":"Asha","pauseBilling":true}"#);
        assert_eq!(s, 200, "{v}");
        let sid = v["session"]["id"].as_str().expect("session id").to_string();
        check_once(&client, &flag);
        let now = current();
        assert!(now.paused, "the store must hear the pause");
        assert!(now.message.to_lowercase().contains("audit"), "message: {:?}", now.message);
        assert!(now.since.is_some());
        assert!(flag_paused());
        fs::copy(&flag, out.join("paused.json")).unwrap();

        // 3. the admin switches the pause off mid-audit, then on again
        let path = format!("/api/audit-sessions/{sid}/billing-pause");
        assert_eq!(call(&client, &api, &admin, "PUT", &path, r#"{"paused":false}"#).0, 200);
        check_once(&client, &flag);
        assert!(!current().paused && !flag_paused());
        fs::copy(&flag, out.join("resumed.json")).unwrap();
        assert_eq!(call(&client, &api, &admin, "PUT", &path, r#"{"paused":true}"#).0, 200);
        check_once(&client, &flag);
        assert!(current().paused && flag_paused());

        // 4. a wrong key is refused by siri-api: nothing changes (the last answer stands)
        store_log::set_context(Some(api.clone()), "wrong-key".into(), store.clone(), "Test store".into());
        check_once(&client, &flag);
        assert!(current().paused, "a refused check must not clear the pause");
        store_log::set_context(Some(api.clone()), key.clone(), store.clone(), "Test store".into());

        // 5. the audit is cancelled: billing is released
        assert_eq!(call(&client, &api, &admin, "POST", &format!("/api/audit-sessions/{sid}/cancel"), "{}").0, 200);
        check_once(&client, &flag);
        assert!(!current().paused && !flag_paused(), "cancelling the audit must release billing");

        // 6. an audit started WITHOUT the tick never pauses
        let (s, v) = call(&client, &api, &admin, "POST", &format!("/api/stores/{store}/audit-session"),
            r#"{"deviceId":"it-dev","startedBy":"Asha","pauseBilling":false}"#);
        assert_eq!(s, 200, "{v}");
        check_once(&client, &flag);
        assert!(!current().paused);
        let sid2 = v["session"]["id"].as_str().unwrap().to_string();
        call(&client, &api, &admin, "POST", &format!("/api/audit-sessions/{sid2}/cancel"), "{}");

        // 7. siri-api unreachable: no crash, and the last answer simply stays
        store_log::set_context(Some("http://127.0.0.1:9".into()), key.clone(), store.clone(), "Test store".into());
        check_once(&client, &flag);
        assert!(!current().paused);
    }

    #[test]
    fn the_flag_file_round_trips_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("billing-pause-test-{}", std::process::id()));
        let file = dir.join("data").join("billing-pause.json");
        let info = PauseInfo { paused: true, message: "An audit is in progress".into(), since: Some("2026-11-03T06:00:00+00:00".into()) };
        write_flag_file(&file, &info, 1_762_000_000).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["paused"], true);
        assert_eq!(v["message"], "An audit is in progress");
        assert_eq!(v["since"], "2026-11-03T06:00:00+00:00");
        assert_eq!(v["checkedAtEpoch"], 1_762_000_000u64);
        // writing again replaces it cleanly
        write_flag_file(&file, &PauseInfo::default(), 1_762_000_030).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["paused"], false);
        assert!(!file.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
