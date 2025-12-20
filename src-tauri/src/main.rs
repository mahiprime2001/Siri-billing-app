#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::process::Command;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use tauri_plugin_updater::Builder as UpdaterBuilder;
use log::{info, error};

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        // /T = kill child processes, /F = force
        let _ = Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|e| error!("Failed to taskkill {}: {}", pid, e));
    }
    #[cfg(not(target_os = "windows"))]
    {
        // -TERM entire process group
        let _ = Command::new("kill")
            .args(&["-TERM", &format!("-{}", pid)])
            .status()
            .map_err(|e| error!("Failed to kill -TERM {}: {}", pid, e));
    }
}

fn main() {
    let child_handle: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())  // ✅ ADD THIS LINE
        .plugin(UpdaterBuilder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            LogBuilder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: Some("siri-billing-app".into()) }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![])
        .setup({
            let child_handle = Arc::clone(&child_handle);
            move |app| {
                info!("Tauri setup complete.");

                let handle = app.app_handle();
                let cmd = handle.shell().sidecar("Siribilling-backend")?;
                let (mut rx, mut command_child) = cmd.spawn()?;

                // Store the child
                let pid = command_child.pid();
                info!("Spawned sidecar with PID {}", pid);
                *child_handle.lock().unwrap() = Some(command_child);

                // Log output
                let child_handle_clone = Arc::clone(&child_handle);
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => info!("stdout: {}", String::from_utf8_lossy(&line)),
                            CommandEvent::Stderr(line) => error!("stderr: {}", String::from_utf8_lossy(&line)),
                            _ => {}
                        }
                    }
                    let _ = child_handle_clone.lock().unwrap().take();
                });

                // Kill on window close
                let main_win = app.get_window("main").unwrap();
                let child_handle_clone = Arc::clone(&child_handle);
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        if let Some(child) = child_handle_clone.lock().unwrap().take() {
                            let pid = child.pid();
                            kill_process_tree(pid);
                            info!("Killed sidecar tree on window close (PID {})", pid);
                        }
                    }
                });

                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error building app")
        .run({
            let child_handle = Arc::clone(&child_handle);
            move |_app_handle, event| {
                if let RunEvent::Exit = event {
                    if let Some(child) = child_handle.lock().unwrap().take() {
                        let pid = child.pid();
                        kill_process_tree(pid);
                        info!("Killed sidecar tree on app exit (PID {})", pid);
                    }
                }
            }
        });
}
