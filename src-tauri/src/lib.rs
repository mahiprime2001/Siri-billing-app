use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{sleep, spawn};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, WindowEvent, PhysicalSize};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use log::LevelFilter;

// Flag to prevent multiple close attempts
static IS_CLOSING: AtomicBool = AtomicBool::new(false);

// Find an available port on localhost
fn find_available_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("Failed to bind to port")
        .local_addr()
        .unwrap()
        .port()
}

// Wait for the server to start and listen on the port
fn wait_for_server(port: u16, retries: u32, delay_ms: u64) -> bool {
    for _ in 0..retries {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        sleep(Duration::from_millis(delay_ms));
    }
    false
}

// Helper function to safely rewrite a file by deleting it first
fn rewrite_file(file_path: &PathBuf, content: &str) -> std::io::Result<()> {
    if file_path.exists() {
        fs::remove_file(file_path)?; // delete old file if it exists
    }
    let mut file = File::create(file_path)?; // create new file
    file.write_all(content.as_bytes())?; // write content
    Ok(())
}

// Main function to run the app
pub fn run() {
    let exe_dir: PathBuf = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| env::current_dir().unwrap());

    let logs_dir = exe_dir.join("logs");

    if !logs_dir.exists() {
        fs::create_dir_all(&logs_dir).expect("Failed to create logs directory");
    }

    let stdout_log = File::create(logs_dir.join("server.log")).expect("Failed to create server.log file");
    let stderr_log = File::create(logs_dir.join("server-error.log")).expect("Failed to create server-error.log file");

    assert!(exe_dir.join("node/node.exe").exists(), "node.exe not found in node folder");
    assert!(exe_dir.join("node/node_modules/npm/bin/npm-cli.js").exists(), "npm-cli.js not found");

    let is_dev = cfg!(debug_assertions);
    let port = find_available_port(); // Use dynamically found port
    let port_file = logs_dir.join("port.info");
    let main_port_info_file = exe_dir.join("port.info");

    let child_process = Arc::new(Mutex::new(None));

    let mut command = Command::new(exe_dir.join("node/node.exe"));
    command
        .arg(exe_dir.join("node/node_modules/npm/bin/npm-cli.js"))
        .arg("run")
        .arg("dev")
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .creation_flags(0x08000000) // hide terminal window on Windows
        .env("PORT", port.to_string()) // Pass dynamic port to Next.js
        .env("NODE_ENV", if is_dev { "development" } else { "production" });

    let child = command.spawn().expect("Failed to start Next.js server");
    *child_process.lock().unwrap() = Some(child);

    let child_process_clone = Arc::clone(&child_process);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let main_window = app.get_webview_window("main").unwrap();

            if is_dev {
                let handle = app.handle().clone();
                handle
                    .plugin(
                        tauri_plugin_log::Builder::default()
                            .level(LevelFilter::Info)
                            .build(),
                    )
                    .expect("Failed to register log plugin");
            }

            // Resize main window to monitor size
            if let Some(monitor) = app.primary_monitor().unwrap_or(None) {
                let size = monitor.size();
                main_window
                    .set_size(PhysicalSize::new(size.width, size.height))
                    .expect("Failed to resize window");
            }

            let main_window_clone = main_window.clone();
            let error_log_path = logs_dir.join("server-error.log");

            spawn(move || {
                let show_error = |msg: &str| {
                    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                    let env_info = format!(
                        "App Version: {}\nOS: {}\nExe Dir: {}\nIs Dev: {}",
                        env!("CARGO_PKG_VERSION"),
                        std::env::consts::OS,
                        exe_dir.display(),
                        is_dev
                    );
                    let error_type = if msg.contains("port.info") {
                        "Port File Error"
                    } else if msg.contains("not responding") {
                        "Server Connection Error"
                    } else {
                        "General Startup Error"
                    };
                    let full_msg = format!(
                        "[{}] [{}]\n{}\n\nDiagnostics:\n{}",
                        timestamp, error_type, msg, env_info
                    );
                    let _ = fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&error_log_path)
                        .and_then(|mut f| writeln!(f, "{}", full_msg));
                    let server_errors = fs::read_to_string(&error_log_path).unwrap_or_else(|_| "No server errors logged yet.".to_string());
                    let html = format!(
                        "<html><body style='font-family:sans-serif;padding:2em;'><h2 style='color:#c00;'>Startup Error</h2><pre style='background:#f8d7da;padding:1em;border-radius:4px;color:#721c24;'>{}</pre><h3>Diagnostics</h3><pre style='background:#e2e3e5;padding:1em;border-radius:4px;color:#383d41;'>{}</pre><h3>Server Errors</h3><pre style='background:#fff3cd;padding:1em;border-radius:4px;color:#856404;max-height:300px;overflow:auto;'>{}</pre></body></html>",
                        msg,
                        format!("Time: {}\nType: {}\n{}", timestamp, error_type, env_info),
                        server_errors
                    );
                    let _ = main_window_clone.eval(&format!("document.documentElement.innerHTML = `{}`", html.replace('`', "\\`")));
                    main_window_clone.show().ok();
                };

                let mut server_ready = false;
                let mut error_msg = None;

                // Write the dynamically found port to port.info for the Next.js app to potentially read
                let _ = rewrite_file(&port_file, &port.to_string());

                if wait_for_server(port, 50, 200) {
                    server_ready = true;
                } else {
                    error_msg = Some(format!("Next.js server at port {} not responding.", port));
                }

                // Show main window with server or error view
                if server_ready {
                    let url = format!("http://localhost:{}", port);
                    let _ = main_window_clone.eval(&format!("window.location.replace('{}')", url));
                    main_window_clone.show().ok();
                } else {
                    show_error(&error_msg.unwrap_or("Unknown startup error".to_string()));
                }
            });

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if IS_CLOSING.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();

                let app_handle = window.app_handle().clone();
                let child_process = Arc::clone(&child_process_clone);

                spawn(move || {
                    let confirmed = app_handle
                        .dialog()
                        .message("Are you sure you want to close the application?")
                        .title("Confirm Close")
                        .buttons(MessageDialogButtons::OkCancel)
                        .blocking_show();

                    if confirmed {
                        IS_CLOSING.store(true, Ordering::SeqCst);

                        if let Some(mut child) = child_process.lock().unwrap().take() {
                            // Attempt to gracefully terminate the pnpm process
                            #[cfg(target_os = "windows")]
                            {
                                // On Windows, killing the parent pnpm process might not kill its children (Node.js)
                                // We might need to find and kill the Node.js process directly.
                                // For simplicity, we'll just kill the pnpm process for now.
                                let _ = child.kill();
                            }
                            #[cfg(not(target_os = "windows"))]
                            {
                                // On Unix-like systems, killing the parent process usually kills children
                                let _ = child.kill();
                            }
                            let _ = child.wait();
                        }

                        let ah_clone = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            if let Some(win) = ah_clone.get_webview_window("main") {
                                let _ = win.close();
                            }
                        });
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}
