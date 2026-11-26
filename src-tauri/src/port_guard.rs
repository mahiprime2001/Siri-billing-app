//! Who holds the app's local port, and clearing a stale copy of THIS app off it.
//!
//! Seen at Nellore on 2026-11-26: after an update, the old copy of the app kept running in the background for 15
//! minutes, holding :8080 without answering, so the new copy's screens got nothing. At start (before the front door
//! and the backend start) and while the front door retries, a holder of the port is closed when it is:
//!   * another copy of this same app (same program file name, not this process): with its whole process tree, so its
//!     own backend goes too;
//!   * the store app's Python backend (Siribilling-backend.exe), only when the front door needs the port (a leftover
//!     from an earlier run; with the front door on, the backend never belongs on that port).
//! Anything else holding the port is left alone and only named in the log.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;

use crate::store_log;

#[cfg(target_os = "windows")]
const NO_WINDOW: u32 = 0x0800_0000;
const BACKEND_IMAGE: &str = "siribilling-backend.exe";

/// The process ids LISTENING on `port` in `netstat -ano` output (any local address).
pub fn listeners(netstat: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut out = Vec::new();
    for line in netstat.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 5 && cols[0].eq_ignore_ascii_case("TCP") && cols[1].ends_with(&suffix)
            && cols[3].eq_ignore_ascii_case("LISTENING") {
            if let Ok(pid) = cols[4].parse::<u32>() {
                if pid != 0 && !out.contains(&pid) {
                    out.push(pid);
                }
            }
        }
    }
    out
}

/// The program name from `tasklist /FO CSV /NH` output ("app.exe","1234",...).
pub fn image_name(tasklist_csv: &str) -> Option<String> {
    let first = tasklist_csv.lines().find(|l| l.starts_with('"'))?;
    let name = first.trim_start_matches('"').split('"').next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Should a holder be closed? Only another copy of this app, or (front door) a leftover backend.
pub fn should_close(holder_image: &str, holder_pid: u32, own_image: &str, own_pid: u32, front_door: bool) -> bool {
    if holder_pid == own_pid || holder_pid == 0 {
        return false;
    }
    let h = holder_image.to_ascii_lowercase();
    (!own_image.is_empty() && h == own_image.to_ascii_lowercase()) || (front_door && h == BACKEND_IMAGE)
}

fn run(program: &str, args: &[&str]) -> String {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(NO_WINDOW);
    cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
}

fn holders(port: u16) -> Vec<(u32, String)> {
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }
    listeners(&run("netstat", &["-ano", "-p", "TCP"]), port).into_iter()
        .map(|pid| (pid, image_name(&run("tasklist", &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])).unwrap_or_default()))
        .collect()
}

fn own_image() -> String {
    std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).unwrap_or_default()
}

/// Who holds the port, for the log ("app.exe pid 1234" / "nobody listening").
pub fn describe(port: u16) -> String {
    let h = holders(port);
    if h.is_empty() {
        return "nobody listening (closing connections)".into();
    }
    h.iter().map(|(pid, img)| format!("{} pid {pid}", if img.is_empty() { "?" } else { img })).collect::<Vec<_>>().join(", ")
}

/// Close a stale copy of this app (or, with `front_door`, a leftover backend) holding `port`. Returns how many were
/// closed. Waits up to 5 s for the port to come free.
pub fn free_port(port: u16, front_door: bool) -> usize {
    let (own, me) = (own_image(), std::process::id());
    let mut closed = 0;
    for (pid, image) in holders(port) {
        if should_close(&image, pid, &own, me, front_door) {
            store_log::event("warn", "front", &format!("port :{port} held by a stale {image} (pid {pid}): closing it"));
            run("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]);
            closed += 1;
        } else if pid != me {
            store_log::event("warn", "front", &format!("port :{port} held by {} (pid {pid}): not ours, left alone",
                                                       if image.is_empty() { "?" } else { &image }));
        }
    }
    if closed > 0 {
        for _ in 0..20 {
            if holders(port).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSTAT: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       10068
  TCP    127.0.0.1:8080         127.0.0.1:51234        ESTABLISHED     10068
  TCP    127.0.0.1:51234        127.0.0.1:8080         ESTABLISHED     10712
  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:18080        0.0.0.0:0              LISTENING       77
";

    #[test]
    fn finds_only_the_listener_of_that_exact_port() {
        assert_eq!(listeners(NETSTAT, 8080), vec![10068]);
        assert_eq!(listeners(NETSTAT, 8081), vec![4242]);
        assert_eq!(listeners(NETSTAT, 18080), vec![77]);
        assert!(listeners(NETSTAT, 9999).is_empty());
    }

    #[test]
    fn reads_the_program_name() {
        assert_eq!(image_name("\"Siri-Billing-App.exe\",\"10068\",\"Console\",\"1\",\"85,120 K\"\r\n").as_deref(),
                   Some("Siri-Billing-App.exe"));
        assert_eq!(image_name("INFO: No tasks are running which match the specified criteria.\r\n"), None);
    }

    #[test]
    fn only_a_stale_copy_of_this_app_or_a_leftover_backend_is_closed() {
        let own = "Siri-Billing-App.exe";
        assert!(should_close("siri-billing-app.exe", 10068, own, 999, false), "an older copy of this app");
        assert!(!should_close("Siri-Billing-App.exe", 999, own, 999, true), "never this process");
        assert!(should_close("Siribilling-backend.exe", 4242, own, 999, true), "a leftover backend, front door on");
        assert!(!should_close("Siribilling-backend.exe", 4242, own, 999, false), "python-only mode reuses a healthy backend");
        assert!(!should_close("node.exe", 1, own, 999, true), "someone else's program is left alone");
        assert!(!should_close("Siri-Billing-App.exe", 5, "", 999, true), "own name unknown: close nothing of that name");
    }

    /// Helper for the live test: run by a SECOND copy of this test program, holds port 18556 for 60 s.
    #[test]
    #[ignore]
    fn helper_hold_port_18556() {
        let _l = std::net::TcpListener::bind("127.0.0.1:18556").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    #[test]
    #[ignore]
    fn live_a_stale_copy_of_this_program_is_closed_and_someone_else_is_not() {
        // cargo test --bin app port_guard::tests::live_a_stale -- --ignored --nocapture
        let me = std::env::current_exe().unwrap();
        let mut other = Command::new(&me)
            .args(["port_guard::tests::helper_hold_port_18556", "--ignored", "--exact", "--test-threads=1"])
            .spawn().unwrap();
        let start = std::time::Instant::now();
        while holders(18556).is_empty() && start.elapsed().as_secs() < 15 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        println!("held by: {}", describe(18556));
        assert_eq!(free_port(18556, false), 1, "the other copy of this program is closed");
        assert!(holders(18556).is_empty(), "and the port is free");
        let _ = other.wait();

        let foreign = std::net::TcpListener::bind("127.0.0.1:18557").unwrap();   // held by THIS process
        assert_eq!(free_port(18557, true), 0, "this process is never closed");
        drop(foreign);
    }

    #[test]
    #[ignore]
    fn live_this_pc_netstat_and_tasklist_are_read() {
        // cargo test --bin app port_guard::tests::live -- --ignored --nocapture
        println!("own image: {}", own_image());
        println!("135 held by: {}", describe(135));
    }
}
