// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::process::Command;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::thread;

use tauri::{Manager, RunEvent, WindowEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use tauri_plugin_updater::UpdaterExt;
use log::{info, error, warn, debug};
use serde::{Serialize, Deserialize};
use reqwest::blocking::Client;

#[derive(Clone, Serialize, Deserialize)]
struct UpdateInfo {
    available: bool,
    version: String,
    current_version: String,
    notes: String,
    date: String,
}

// ============================================================================
// UPDATER COMMANDS
// ============================================================================

#[tauri::command]
async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<String, String> {
    info!("Checking for updates...");
    match app_handle.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    info!("Update available: {:?}", update.version);
                    Ok(format!("Update available: {}", update.version))
                }
                Ok(None) => {
                    info!("No update available.");
                    Ok("No update available.".to_string())
                }
                Err(e) => {
                    error!("Failed to check for updates: {}", e);
                    Err(format!("Failed to check for updates: {}", e))
                }
            }
        }
        Err(e) => {
            error!("Failed to get updater: {}", e);
            Err(format!("Failed to get updater: {}", e))
        }
    }
}

#[tauri::command]
async fn install_update(app_handle: tauri::AppHandle) -> Result<String, String> {
    info!("Installing update...");
    match app_handle.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    info!("Update found, downloading and installing...");
                    let mut downloaded = 0;
                    match update.download_and_install(
                        |chunk_length, content_length| {
                            downloaded += chunk_length;
                            info!("Downloaded {} from {:?}", downloaded, content_length);
                        },
                        || {
                            info!("Download finished");
                        },
                    ).await {
                        Ok(_) => {
                            info!("Update installed successfully. Restart required.");
                            Ok("Update installed. Please restart the app.".to_string())
                        }
                        Err(e) => {
                            error!("Failed to download/install update: {}", e);
                            Err(format!("Failed to download/install update: {}", e))
                        }
                    }
                }
                Ok(None) => {
                    info!("No update available to install.");
                    Ok("No update available to install.".to_string())
                }
                Err(e) => {
                    error!("Failed to check for updates: {}", e);
                    Err(format!("Failed to check for updates: {}", e))
                }
            }
        }
        Err(e) => {
            error!("Failed to get updater: {}", e);
            Err(format!("Failed to get updater: {}", e))
        }
    }
}

// ============================================================================
// PRINTER COMMANDS (WINDOWS ONLY)
// ============================================================================

#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name",
            ])
            .output()
            .map_err(|e| format!("Failed to list printers: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut printers: Vec<String> = stdout
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect();

        if printers.is_empty() {
            // Fallback for systems without PrintManagement module (e.g., Windows Home)
            let fallback = Command::new("wmic")
                .args(["printer", "get", "name"])
                .output()
                .map_err(|e| format!("Failed to list printers (wmic): {}", e))?;

            let fallback_stdout = String::from_utf8_lossy(&fallback.stdout);
            printers = fallback_stdout
                .lines()
                .map(|line| line.trim())
                .filter(|line| !line.is_empty() && line.to_lowercase() != "name")
                .map(|line| line.to_string())
                .collect();
        }

        if printers.is_empty() && !output.status.success() {
            return Err("Failed to list printers".to_string());
        }

        Ok(printers)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Printer listing is only supported on Windows.".to_string())
    }
}

#[tauri::command]
fn print_text(content: String, printer_name: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut path = std::env::temp_dir();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        path.push(format!("siri-receipt-{}.txt", timestamp));

        fs::write(&path, content).map_err(|e| format!("Failed to write print file: {}", e))?;

        let escaped_path = path
            .to_string_lossy()
            .replace('\'', "''");
        let mut command = format!("Get-Content -Raw -LiteralPath '{}' | Out-Printer", escaped_path);

        if let Some(name) = printer_name {
            let escaped_name = name.replace('\'', "''");
            command.push_str(&format!(" -Name '{}'", escaped_name));
        }

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &command])
            .output()
            .map_err(|e| format!("Failed to print: {}", e))?;

        let _ = fs::remove_file(&path);

        if !output.status.success() {
            return Err("Silent print failed".to_string());
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Silent printing is only supported on Windows.".to_string())
    }
}

fn main() {
    let child_handle: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .invoke_handler(tauri::generate_handler![
            check_for_updates,
            install_update,
            list_printers,
            print_text
        ])
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

                // Updater Configuration
                info!("=================================================");
                info!("🔄 Updater Configuration");
                info!("=================================================");
                info!("✅ Updater plugin initialized successfully");
                info!("📡 Updater command ready - frontend can call check_for_updates()");

                let handle = app.app_handle();

                // Backend Sidecar
                info!("=================================================");
                info!("🔌 Starting Backend Sidecar");
                info!("=================================================");

                let cmd = handle.shell().sidecar("Siribilling-backend")?;
                let (mut rx, command_child) = cmd.spawn()?;
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

                // Get the main webview window (Tauri v2)
                let main_win = app.get_webview_window("main").unwrap();

                // Open DevTools automatically in debug builds
                #[cfg(debug_assertions)]
                {
                    info!("🔧 Opening DevTools...");
                    main_win.open_devtools();
                }

                // Window event handlers - 🆕 GRACEFUL SHUTDOWN
                let child_handle_clone = Arc::clone(&child_handle);
                main_win.on_window_event(move |event| {
                    match event {
                        WindowEvent::CloseRequested { .. } => {
                            info!("=================================================");
                            info!("🚪 Window Close Requested - Initiating Graceful Shutdown");
                            info!("=================================================");

                            // 🆕 STEP 1: Send HTTP shutdown signal to Flask
                            if let Some(child) = child_handle_clone.lock().unwrap().as_ref() {
                                let pid = child.pid();
                                info!("📡 Sending graceful shutdown request to backend PID: {}", pid);
                                
                                let client = Client::builder()
                                    .timeout(Duration::from_secs(5))
                                    .build()
                                    .unwrap_or_else(|_| {
                                        info!("⚠️ Failed to create reqwest client, skipping HTTP shutdown");
                                        Client::new()
                                    });
                                    
                                match client.post("http://localhost:8080/api/shutdown")
                                    .body("shutdown from tauri")
                                    .send() {
                                        Ok(response) => {
                                            info!("✅ Backend shutdown signal sent successfully: HTTP {}", response.status());
                                        }
                                        Err(e) => {
                                            warn!("⚠️ Failed to send shutdown signal: {}. Will force kill.", e);
                                        }
                                }
                            }

                            // 🆕 STEP 2: Wait for graceful shutdown (5 seconds max)
                            info!("⏳ Waiting 5 seconds for backend graceful shutdown...");
                            thread::sleep(Duration::from_secs(5));

                            // 🆕 STEP 3: Force kill if still running
                            if let Some(child) = child_handle_clone.lock().unwrap().take() {
                                let pid = child.pid();
                                info!("🔄 Force terminating backend process (PID: {})", pid);
                                
                                #[cfg(target_os = "windows")]
                                {
                                    let _ = Command::new("taskkill")
                                        .args(&["/PID", &pid.to_string(), "/T", "/F"])
                                        .status();
                                }
                                
                                #[cfg(not(target_os = "windows"))]
                                {
                                    let _ = Command::new("kill")
                                        .args(&["-9", &pid.to_string()])
                                        .status();
                                }
                                
                                info!("✅ Backend force terminated");
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
                        info!("🚪 App Exit Event - Final Cleanup");
                        info!("=================================================");

                        // Final cleanup
                        if let Some(child) = child_handle.lock().unwrap().take() {
                            let pid = child.pid();
                            info!("🔄 Final cleanup of backend process (PID: {})", pid);
                            
                            #[cfg(target_os = "windows")]
                            {
                                let _ = Command::new("taskkill")
                                    .args(&["/PID", &pid.to_string(), "/T", "/F"])
                                    .status();
                            }
                            
                            #[cfg(not(target_os = "windows"))]
                            {
                                let _ = Command::new("kill")
                                    .args(&["-9", &pid.to_string()])
                                    .status();
                            }
                            
                            info!("✅ Final cleanup complete");
                        }

                        info!("=================================================");
                    }
                    RunEvent::ExitRequested { .. } => {
                        info!("🚪 Exit requested");
                    }
                    _ => {}
                }
            }
        });
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
