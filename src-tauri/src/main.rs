#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::process::Command;
use std::fs;
use std::path::PathBuf;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use tauri_plugin_updater::UpdaterExt; // ✅ Add this import
use log::{info, error, warn, debug};

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|e| error!("Failed to taskkill {}: {}", pid, e));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(&["-TERM", &format!("-{}", pid)])
            .status()
            .map_err(|e| error!("Failed to kill -TERM {}: {}", pid, e));
    }
}

/// Clean old log files on startup
fn cleanup_old_logs(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app_handle.path().app_data_dir()?;
    let logs_dir = app_data_dir.join("logs");

    if logs_dir.exists() {
        println!("🧹 Cleaning old logs from: {:?}", logs_dir);
        if let Ok(entries) = fs::read_dir(&logs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(extension) = path.extension() {
                        if extension == "log" {
                            match fs::remove_file(&path) {
                                Ok(_) => println!("✅ Deleted old log: {:?}", path.file_name()),
                                Err(e) => eprintln!("❌ Failed to delete {:?}: {}", path, e),
                            }
                        }
                    }
                }
            }
        }
    } else {
        println!("📁 Logs directory doesn't exist yet, will be created");
    }

    Ok(())
}

fn main() {
    let child_handle: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .build()
        )
        .plugin(tauri_plugin_process::init())
        .plugin(
            LogBuilder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Folder {
                        path: PathBuf::from("logs"),
                        file_name: Some("siri-billing-app.log".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Debug)
                .max_file_size(10_000_000)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![])
        .setup({
            let child_handle = Arc::clone(&child_handle);
            move |app| {
                // Clean old logs BEFORE starting new logging
                if let Err(e) = cleanup_old_logs(app.app_handle()) {
                    eprintln!("⚠️ Failed to cleanup old logs: {}", e);
                }

                info!("=================================================");
                info!("🚀 Siri Billing App Starting");
                info!("=================================================");
                info!("📦 App version: {}", app.package_info().version);
                info!("🔧 Bundle identifier: {}", app.config().identifier);

                let app_data_dir = app.path().app_data_dir()
                    .unwrap_or_else(|_| PathBuf::from("unknown"));
                info!("📂 App data directory: {:?}", app_data_dir);
                info!("📝 Logs directory: {:?}", app_data_dir.join("logs"));

                // ✅ LOG UPDATER CONFIGURATION
                info!("=================================================");
                info!("🔄 Updater Configuration");
                info!("=================================================");
                
                // Check if updater plugin is available
                match app.updater() {
                    Ok(updater) => {
                        info!("✅ Updater plugin initialized successfully");
                        info!("📡 Updater is ready to check for updates");
                    }
                    Err(e) => {
                        error!("❌ Updater plugin initialization failed: {}", e);
                    }
                }

                let handle = app.app_handle();

                info!("=================================================");
                info!("🔌 Starting Backend Sidecar");
                info!("=================================================");

                let cmd = handle.shell().sidecar("Siribilling-backend")?;
                let (mut rx, mut command_child) = cmd.spawn()?;
                let pid = command_child.pid();

                info!("✅ Backend spawned successfully");
                info!("🆔 Process ID: {}", pid);

                *child_handle.lock().unwrap() = Some(command_child);

                let child_handle_clone = Arc::clone(&child_handle);
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                let output = String::from_utf8_lossy(&line);
                                info!("🔵 [Backend] {}", output.trim());
                            }
                            CommandEvent::Stderr(line) => {
                                let output = String::from_utf8_lossy(&line);
                                error!("🔴 [Backend] {}", output.trim());
                            }
                            CommandEvent::Error(err) => {
                                error!("❌ [Backend] Error: {}", err);
                            }
                            CommandEvent::Terminated(payload) => {
                                warn!("⚠️ [Backend] Terminated with code: {:?}", payload.code);
                            }
                            _ => {}
                        }
                    }

                    let _ = child_handle_clone.lock().unwrap().take();
                    warn!("🛑 Backend sidecar process ended");
                });

                let main_win = app.get_webview_window("main").unwrap();
                let child_handle_clone = Arc::clone(&child_handle);

                main_win.on_window_event(move |event| {
                    match event {
                        WindowEvent::CloseRequested { .. } => {
                            info!("=================================================");
                            info!("🚪 Window Close Requested");
                            info!("=================================================");
                            if let Some(child) = child_handle_clone.lock().unwrap().take() {
                                let pid = child.pid();
                                info!("🔄 Terminating backend process (PID: {})", pid);
                                kill_process_tree(pid);
                                info!("✅ Backend terminated successfully");
                            }
                        }
                        WindowEvent::Focused(focused) => {
                            if *focused {
                                debug!("🔍 Window focused");
                            } else {
                                debug!("🔍 Window unfocused");
                            }
                        }
                        _ => {}
                    }
                });

                info!("=================================================");
                info!("✅ Tauri Setup Complete");
                info!("=================================================");

                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error building app")
        .run({
            let child_handle = Arc::clone(&child_handle);
            move |_app_handle, event| {
                match event {
                    RunEvent::Exit => {
                        info!("=================================================");
                        info!("🚪 App Exit Event");
                        info!("=================================================");
                        if let Some(child) = child_handle.lock().unwrap().take() {
                            let pid = child.pid();
                            info!("🔄 Cleaning up backend process (PID: {})", pid);
                            kill_process_tree(pid);
                            info!("✅ Cleanup complete");
                        }
                        info!("=================================================");
                    }
                    RunEvent::ExitRequested { api, .. } => {
                        info!("🚪 Exit requested");
                    }
                    _ => {}
                }
            }
        });
}
