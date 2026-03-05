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

use tauri::{Manager, RunEvent, WindowEvent};
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
// ✅ CUSTOM PRINT COMMAND — No wkhtmltopdf, No PDF, Pure HTML → Printer
// ============================================================================
//
// Strategy:
//   1. Write HTML to a temp .html file
//   2. Write a PowerShell script that uses System.Windows.Forms.WebBrowser
//      (built into all Windows .NET installs) to render and print silently
//   3. Loops N times for copy count, no dialog, no PDF
//   4. Works on Windows 10/11 with any printer including thermal printers
//
// ============================================================================

#[tauri::command]
async fn print_html_native(html: String, printer_name: String, copies: u32, paper_size: Option<String>) -> Result<String, String> {
    info!("🖨️ [print_html_native] Starting print job...");
    info!("   Printer : {}", printer_name);
    info!("   Copies  : {}", copies);
    info!("   HTML len: {}", html.len());

    let copies = copies.max(1);

    // FIX Risk 1 + Risk 5: set WebBrowser pixel width to match the paper.
    // IE ignores CSS @page width so the WebBrowser control's own Size is what
    // determines the render width. Wrong width = content squished or cut off.
    //   Thermal 58mm  →  220px  (58  × 96 ÷ 25.4)
    //   Thermal 80mm  →  302px  (80  × 96 ÷ 25.4)
    //   A4            →  794px  (210 × 96 ÷ 25.4)
    //   Letter        →  816px  (216 × 96 ÷ 25.4)
    let ps_paper_size = paper_size.as_deref().unwrap_or("Thermal 80mm");
    let browser_width_px: u32 = match ps_paper_size {
        s if s.contains("58mm")  =>  220,
        s if s.contains("80mm")  =>  302,
        s if s == "A4"           =>  794,
        s if s == "Letter"       =>  816,
        _                        =>  302, // safe thermal default
    };

    // ── Step 1: Write HTML to a temp file ──────────────────────────────────
    let temp_dir = std::env::temp_dir();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let temp_html = temp_dir.join(format!("siri_invoice_{}.html", ts));
    let temp_ps   = temp_dir.join(format!("siri_print_{}.ps1",  ts));

    fs::write(&temp_html, html.as_bytes())
        .map_err(|e| format!("Failed to write temp HTML: {}", e))?;

    let html_path = temp_html.to_string_lossy().replace('\\', "/");
    info!("📄 Temp HTML: {}", html_path);

    // ── Step 2: Write PowerShell script to disk ────────────────────────────
    //
    // Uses System.Windows.Forms.WebBrowser which:
    //   - Is built into ALL Windows 10/11 systems (.NET Framework)
    //   - Renders HTML faithfully (IE engine / Trident)
    //   - Supports silent printing via .Print() method
    //   - Targets a specific printer by temporarily setting it as default
    //
    let ps_script = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$htmlPath  = '{html_path}'
$printerName = '{printer}'
$copies    = {copies}

# ── Temporarily set target printer as default ──
$currentDefault = ''
try {{
    $currentDefault = (Get-CimInstance -ClassName Win32_Printer -Filter 'Default=True').Name
    Write-Host "Current default printer: $currentDefault"
}} catch {{
    Write-Host "Could not get current default printer"
}}

if ($printerName -ne '') {{
    try {{
        $p = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$printerName'"
        if ($p) {{
            Invoke-CimMethod -InputObject $p -MethodName SetDefaultPrinter | Out-Null
            Write-Host "Set default printer to: $printerName"
        }} else {{
            Write-Host "Printer not found: $printerName - using system default"
        }}
    }} catch {{
        Write-Host "Warning: could not set printer: $_"
    }}
}}

# ── Zero out ALL IE page margins and suppress headers/footers via registry ──
# FIX: IE/WebBrowser ignores CSS @page margin:0. These registry keys are the
# only way to remove IE's built-in physical page margins (top/bottom/left/right).
$regPath = 'HKCU:\Software\Microsoft\Internet Explorer\PageSetup'
$savedHeader = $savedFooter = ''
$savedMarginTop = $savedMarginBottom = $savedMarginLeft = $savedMarginRight = ''
try {{
    $savedHeader      = (Get-ItemProperty -Path $regPath -Name 'header'        -ErrorAction SilentlyContinue).header
    $savedFooter      = (Get-ItemProperty -Path $regPath -Name 'footer'        -ErrorAction SilentlyContinue).footer
    $savedMarginTop   = (Get-ItemProperty -Path $regPath -Name 'margin_top'    -ErrorAction SilentlyContinue).margin_top
    $savedMarginBottom= (Get-ItemProperty -Path $regPath -Name 'margin_bottom' -ErrorAction SilentlyContinue).margin_bottom
    $savedMarginLeft  = (Get-ItemProperty -Path $regPath -Name 'margin_left'   -ErrorAction SilentlyContinue).margin_left
    $savedMarginRight = (Get-ItemProperty -Path $regPath -Name 'margin_right'  -ErrorAction SilentlyContinue).margin_right

    Set-ItemProperty -Path $regPath -Name 'header'        -Value '' -Force
    Set-ItemProperty -Path $regPath -Name 'footer'        -Value '' -Force
    Set-ItemProperty -Path $regPath -Name 'margin_top'    -Value '0.000000' -Force
    Set-ItemProperty -Path $regPath -Name 'margin_bottom' -Value '0.000000' -Force
    Set-ItemProperty -Path $regPath -Name 'margin_left'   -Value '0.000000' -Force
    Set-ItemProperty -Path $regPath -Name 'margin_right'  -Value '0.000000' -Force
    Write-Host "Registry: all IE margins zeroed and headers/footers cleared"
}} catch {{
    Write-Host "Warning: could not set IE registry margins: $_"
}}

# ── Print using WebBrowser control ────────────────────────────────────────
$printed = $false
try {{
    for ($i = 1; $i -le $copies; $i++) {{
        Write-Host "Printing copy $i of $copies..."
        $wb = New-Object System.Windows.Forms.WebBrowser
        $wb.ScriptErrorsSuppressed = $true
        $wb.ScrollBarsEnabled = $false

        # FIX Risk 1 + Risk 5: use the correct pixel width for the paper type.
        # IE renders at this pixel width before sending to the printer.
        $wb.Size = New-Object System.Drawing.Size({browser_width_px}, 4800)

        $loaded = $false
        $wb.add_DocumentCompleted({{
            param($s, $e)
            $script:loaded = $true
        }})

        $wb.Navigate("file:///$htmlPath")

        # Wait for page load (max 10 seconds)
        $wait = 0
        while (-not $script:loaded -and $wait -lt 10000) {{
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 100
            $wait += 100
        }}

        # FIX: Extra settle time so IE finishes layout at the narrow width
        # before sending to printer. 300ms was too short.
        Start-Sleep -Milliseconds 800

        $wb.Print()
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 2000

        $wb.Dispose()
        $script:loaded = $false
        Write-Host "Copy $i sent to printer"
    }}
    $printed = $true
}} catch {{
    Write-Host "Print error: $_"
}}

# ── Restore registry ──
try {{
    if ($savedHeader      -ne '') {{ Set-ItemProperty -Path $regPath -Name 'header'        -Value $savedHeader      -Force }}
    if ($savedFooter      -ne '') {{ Set-ItemProperty -Path $regPath -Name 'footer'        -Value $savedFooter      -Force }}
    if ($savedMarginTop   -ne '') {{ Set-ItemProperty -Path $regPath -Name 'margin_top'    -Value $savedMarginTop   -Force }}
    if ($savedMarginBottom-ne '') {{ Set-ItemProperty -Path $regPath -Name 'margin_bottom' -Value $savedMarginBottom-Force }}
    if ($savedMarginLeft  -ne '') {{ Set-ItemProperty -Path $regPath -Name 'margin_left'   -Value $savedMarginLeft  -Force }}
    if ($savedMarginRight -ne '') {{ Set-ItemProperty -Path $regPath -Name 'margin_right'  -Value $savedMarginRight -Force }}
}} catch {{}}

# ── Restore original default printer ──
if ($currentDefault -and $currentDefault -ne $printerName) {{
    try {{
        $orig = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$currentDefault'"
        if ($orig) {{ Invoke-CimMethod -InputObject $orig -MethodName SetDefaultPrinter | Out-Null }}
        Write-Host "Restored default printer: $currentDefault"
    }} catch {{}}
}}

# ── Cleanup ──
Remove-Item -Path '{html_path_win}' -Force -ErrorAction SilentlyContinue
Remove-Item -Path '{ps_path_win}' -Force -ErrorAction SilentlyContinue

if ($printed) {{
    Write-Host "SUCCESS: Print job complete"
    exit 0
}} else {{
    Write-Host "FAILED: Print job did not complete"
    exit 1
}}
"#,
        html_path         = html_path,
        html_path_win     = temp_html.to_string_lossy(),
        ps_path_win       = temp_ps.to_string_lossy(),
        printer           = printer_name.replace('\'', "''"),
        copies            = copies,
        browser_width_px  = browser_width_px,
    );

    fs::write(&temp_ps, ps_script.as_bytes())
        .map_err(|e| format!("Failed to write PS script: {}", e))?;

    // ── Step 3: Run the PowerShell script ─────────────────────────────────
    let mut cmd = Command::new("powershell");
    cmd.args(&[
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File",
        &temp_ps.to_string_lossy(),
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output()
        .map_err(|e| format!("Failed to spawn PowerShell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    info!("📤 PS stdout: {}", stdout.trim());
    if !stderr.is_empty() {
        warn!("⚠️ PS stderr: {}", stderr.trim());
    }

    // Cleanup fallback
    let _ = fs::remove_file(&temp_html);
    let _ = fs::remove_file(&temp_ps);

    if output.status.success() && stdout.contains("SUCCESS") {
        info!("✅ Print job complete");
        Ok(format!("Printed {} cop{} to '{}'",
            copies,
            if copies == 1 { "y" } else { "ies" },
            printer_name
        ))
    } else {
        let err = if !stderr.is_empty() { stderr.trim().to_string() } else { stdout.trim().to_string() };
        error!("❌ Print failed: {}", err);
        Err(format!("Print failed: {}", err))
    }
}

// ── List printers via PowerShell (no plugin needed) ───────────────────────

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