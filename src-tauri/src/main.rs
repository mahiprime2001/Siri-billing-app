// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use tauri::Manager;
fn main() {
  tauri::Builder::default()
        .setup(|app| {
            // Only spawn Next.js in release builds
            #[cfg(not(debug_assertions))]
            {
                let _ = Command::new("node")
                    .args(["node_modules/next/dist/bin/next", "start", "-p", "1420"])
                    .current_dir(app.path_resolver().app_dir().unwrap())
                    .spawn();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}

