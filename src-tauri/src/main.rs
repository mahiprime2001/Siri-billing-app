// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::process::Command;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::thread;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, RunEvent, WindowEvent, WebviewWindowBuilder, WebviewUrl};
use tauri::webview::{PageLoadEvent, Url as TauriUrl};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use tauri_plugin_updater::UpdaterExt;
use log::{info, error, warn, debug};
use serde::{Serialize, Deserialize};
use reqwest::blocking::Client;

#[cfg(target_os = "windows")]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, ICoreWebView2Environment6, ICoreWebView2PrintSettings2,
        COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
        COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE, COREWEBVIEW2_PRINT_STATUS_OTHER_ERROR,
    },
    PrintCompletedHandler,
};
#[cfg(target_os = "windows")]
use windows_core::Interface;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

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
// ? PRINT COMMAND ? WebView2 Native ICoreWebView2_16::Print()
// ============================================================================
//
// HOW THIS WORKS (Windows only):
//   1. Write HTML to a temp file
//   2. Create a hidden WebView2 window and load that file
//   3. After render, call ICoreWebView2_16::Print() with print settings:
//      - Exact printer name
//      - Exact copy count
//   4. Close the window silently
//
// This uses the exact same Blink engine as the app preview and does not show
// any dialog or require extra tools.
// ============================================================================

#[tauri::command]
async fn print_html_native(
    app_handle: tauri::AppHandle,
    html: String,
    printer_name: String,
    copies: u32,
    paper_size: Option<String>,
) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (html, printer_name, copies, paper_size);
        return Err("print_html_native is only supported on Windows.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
    info!("??? [print_html_native] Starting WebView2 native print job...");
    info!("   Printer   : {}", if printer_name.is_empty() { "System Default" } else { &printer_name });
    info!("   Copies    : {}", copies);
    info!("   Paper     : {}", paper_size.as_deref().unwrap_or("Thermal 80mm"));
    info!("   HTML len  : {}", html.len());

    let copies = copies.max(1);

    // ?? Step 1: Write HTML to temp file ?????????????????????????????????????
    let temp_dir = std::env::temp_dir();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_html = temp_dir.join(format!("siri_invoice_{}.html", ts));

    fs::write(&temp_html, html.as_bytes())
        .map_err(|e| format!("Failed to write temp HTML: {}", e))?;

    let html_url = TauriUrl::from_file_path(&temp_html)
        .map_err(|_| "Failed to convert temp file path to URL".to_string())?;
    info!("?? Temp HTML: {}", html_url.as_str());

    // ?? Step 2: Resolve printer name ???????????????????????????????????????
    // If no printer specified, get the system default via PowerShell so we
    // can pass it explicitly to WebView2.
    let resolved_printer = if printer_name.is_empty() {
        info!("?? No printer specified ? resolving system default...");
        let ps_out = Command::new("powershell")
            .args(&[
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command",
                "(Get-CimInstance -ClassName Win32_Printer -Filter 'Default=True').Name",
            ])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        if ps_out.is_empty() {
            return Err("Could not determine system default printer. Please select a printer manually.".to_string());
        }
        info!("? System default printer: {}", ps_out);
        ps_out
    } else {
        printer_name.clone()
    };

    // Keep a copy of the system default for fallback attempts.
    let system_default_printer = {
        let ps_out = Command::new("powershell")
            .args(&[
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command",
                "(Get-CimInstance -ClassName Win32_Printer -Filter 'Default=True').Name",
            ])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        ps_out
    };

    let printer_candidates: Vec<String> = if !system_default_printer.is_empty()
        && system_default_printer != resolved_printer
    {
        vec![resolved_printer.clone(), system_default_printer.clone()]
    } else {
        vec![resolved_printer.clone()]
    };

    // ?? Step 3: Open hidden WebView2 window and wait for load ???????????????
    let (page_tx, page_rx) = std::sync::mpsc::channel::<()>();
    let window_label = format!("print-{}", ts);
    let print_window = WebviewWindowBuilder::new(
        &app_handle,
        window_label,
        WebviewUrl::External(html_url),
    )
    .title("print")
    .visible(false)
    .focused(false)
    .focusable(false)
    .resizable(false)
    .decorations(false)
    .on_page_load(move |_window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = page_tx.send(());
        }
    })
    .build()
    .map_err(|e| format!("Failed to create print webview: {}", e))?;

    let page_loaded = tauri::async_runtime::spawn_blocking(move || {
        page_rx.recv_timeout(Duration::from_secs(10))
    })
    .await
    .map_err(|e| format!("Print webview load wait failed: {}", e))?;

    if page_loaded.is_err() {
        let _ = print_window.close();
        let _ = fs::remove_file(&temp_html);
        return Err("Print webview did not finish loading in time.".to_string());
    }

    // Small delay for fonts/layout to settle
    thread::sleep(Duration::from_millis(250));

    // ?? Step 4: Call ICoreWebView2_16::Print() with exact settings ??????????
    let (print_tx, print_rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let printer_for_settings = resolved_printer.clone();
    let printer_candidates = printer_candidates.clone();

    let with_webview_result = print_window.with_webview(move |webview| {
        let result: Result<String, String> = (|| unsafe {
            let controller = webview.controller();
            let core = controller
                .CoreWebView2()
                .map_err(|e| format!("CoreWebView2() failed: {}", e))?;
            let core16: ICoreWebView2_16 = core
                .cast()
                .map_err(|e| format!("ICoreWebView2_16 not available: {}", e))?;

            let env6: ICoreWebView2Environment6 = webview
                .environment()
                .cast()
                .map_err(|e| format!("ICoreWebView2Environment6 not available: {}", e))?;
            let print_settings = env6
                .CreatePrintSettings()
                .map_err(|e| format!("CreatePrintSettings failed: {}", e))?;

            // Base print settings
            let _ = print_settings.SetShouldPrintBackgrounds(true);
            let _ = print_settings.SetShouldPrintHeaderAndFooter(false);

            // Extended print settings (required for printer + copies)
            let settings2: ICoreWebView2PrintSettings2 = print_settings
                .cast()
                .map_err(|e| format!("ICoreWebView2PrintSettings2 not available: {}", e))?;
            // WebView2 Print sometimes ignores Copies; we loop prints per copy
            // and keep Copies = 1 to ensure consistent behavior.
            settings2
                .SetCopies(1)
                .map_err(|e| format!("SetCopies failed: {}", e))?;

            for candidate_printer in printer_candidates.iter() {
                let printer_wide = Arc::new(
                    candidate_printer
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect::<Vec<u16>>(),
                );
                let printer_pcw = PCWSTR::from_raw(printer_wide.as_ptr());
                settings2
                    .SetPrinterName(printer_pcw)
                    .map_err(|e| format!("SetPrinterName failed: {}", e))?;

                let mut success_count = 0u32;
                for copy_num in 1..=copies {
                    let status_cell = Arc::new(Mutex::new(COREWEBVIEW2_PRINT_STATUS_OTHER_ERROR));
                    let printer_wide_keepalive = Arc::clone(&printer_wide);
                    let status_cell_inner = Arc::clone(&status_cell);
                    let core16_inner = core16.clone();
                    let print_settings_inner = print_settings.clone();

                    let print_result = PrintCompletedHandler::wait_for_async_operation(
                        Box::new(move |handler| {
                            unsafe {
                                core16_inner
                                    .Print(&print_settings_inner, &handler)
                                    .map_err(webview2_com::Error::from)?;
                            }
                            Ok(())
                        }),
                        Box::new(move |result, status| {
                            let _keepalive = printer_wide_keepalive;
                            if let Ok(mut guard) = status_cell_inner.lock() {
                                *guard = status;
                            }
                            result
                        }),
                    );

                    match print_result {
                        Ok(()) if *status_cell.lock().unwrap() == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED => {
                            success_count += 1;
                        }
                        Ok(()) if *status_cell.lock().unwrap() == COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE => {
                            // Try next printer candidate (system default fallback)
                            success_count = 0;
                            break;
                        }
                        Ok(()) => {
                            return Err(format!(
                                "Print failed with status {:?} on copy {}/{}.",
                                *status_cell.lock().unwrap(),
                                copy_num,
                                copies
                            ));
                        }
                        Err(e) => {
                            return Err(format!("Print failed on copy {}/{}: {}", copy_num, copies, e));
                        }
                    }

                    if copy_num < copies {
                        thread::sleep(Duration::from_millis(1000));
                    }
                }

                if success_count == copies {
                    return Ok(candidate_printer.clone());
                }
            }

            Err(format!(
                "Printer unavailable: '{}'",
                printer_for_settings
            ))
        })();

        let _ = print_tx.send(result);
    });

    if let Err(e) = with_webview_result {
        let _ = print_window.close();
        let _ = fs::remove_file(&temp_html);
        return Err(format!("Failed to access WebView2: {}", e));
    }

    let print_status = tauri::async_runtime::spawn_blocking(move || {
        print_rx.recv_timeout(Duration::from_secs(15))
    })
    .await
    .map_err(|e| format!("Print completion wait failed: {}", e))?;

    // ?? Step 5: Cleanup temp file + close window ???????????????????????????
    let _ = print_window.close();
    let _ = fs::remove_file(&temp_html);

    // ?? Step 6: Return result ??????????????????????????????????????????????
    match print_status {
        Ok(Ok(used_printer)) => {
            let msg = format!(
                "Printed {} cop{} to '{}'",
                copies,
                if copies == 1 { "y" } else { "ies" },
                used_printer
            );
            info!("? {}", msg);
            Ok(msg)
        }
        Ok(Err(err)) => {
            error!("? {}", err);
            Err(err)
        }
        Err(_) => {
            let msg = "Print did not complete in time.".to_string();
            error!("? {}", msg);
            Err(msg)
        }
    }
    }
}

#[tauri::command]
async fn list_printers_native() -> Result<Vec<String>, String> {
    info!("🖨️ [list_printers_native] Listing printers...");

    let mut list_cmd = Command::new("powershell");
    list_cmd.args(&[
        "-NonInteractive",
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json",
    ]);
    #[cfg(target_os = "windows")]
    list_cmd.creation_flags(0x08000000);
    let output = list_cmd.output()
        .map_err(|e| format!("Failed to list printers: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    info!("📋 Printers JSON: {}", stdout.trim());

    // Parse JSON — could be array or single string
    let printers: Vec<String> = if stdout.trim().starts_with('[') {
        serde_json::from_str(stdout.trim())
            .unwrap_or_default()
    } else if stdout.trim().starts_with('"') {
        // Single printer returned as plain string
        serde_json::from_str::<String>(stdout.trim())
            .map(|s| vec![s])
            .unwrap_or_default()
    } else {
        stdout.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };

    info!("✅ Found {} printers", printers.len());
    Ok(printers)
}


fn main() {
    let child_handle: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // ✅ tauri-plugin-printer-v2 REMOVED — replaced with native print_html_native command
        // which needs NO external tools (no wkhtmltopdf) and supports N copies directly
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
            print_html_native,      // ✅ NEW
            list_printers_native,   // ✅ NEW
        ])
        .setup({
            let child_handle = Arc::clone(&child_handle);
            move |app| {
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

                info!("=================================================");
                info!("🔄 Updater Configuration");
                info!("=================================================");
                info!("✅ Updater plugin initialized successfully");

                let handle = app.app_handle();

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

                let main_win = app.get_webview_window("main").unwrap();

                #[cfg(debug_assertions)]
                {
                    info!("🔧 Opening DevTools...");
                    main_win.open_devtools();
                }

                let child_handle_clone = Arc::clone(&child_handle);
                main_win.on_window_event(move |event| {
                    match event {
                        WindowEvent::CloseRequested { .. } => {
                            info!("=================================================");
                            info!("🚪 Window Close Requested - Initiating Graceful Shutdown");
                            info!("=================================================");

                            if let Some(child) = child_handle_clone.lock().unwrap().as_ref() {
                                let pid = child.pid();
                                info!("📡 Sending graceful shutdown request to backend PID: {}", pid);
                                
                                let client = Client::builder()
                                    .timeout(Duration::from_secs(5))
                                    .build()
                                    .unwrap_or_else(|_| Client::new());
                                    
                                match client.post("http://localhost:8080/api/shutdown")
                                    .body("shutdown from tauri")
                                    .send() {
                                        Ok(response) => {
                                            info!("✅ Backend shutdown signal sent: HTTP {}", response.status());
                                        }
                                        Err(e) => {
                                            warn!("⚠️ Failed to send shutdown signal: {}", e);
                                        }
                                }
                            }

                            info!("⏳ Waiting 5 seconds for backend graceful shutdown...");
                            thread::sleep(Duration::from_secs(5));

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
