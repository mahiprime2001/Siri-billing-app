#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::Manager;
use std::path::PathBuf;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let app_dir = app.path_resolver().resource_dir().unwrap();

                // Figure out which node binary to use
                let node_path: PathBuf = if cfg!(target_os = "windows") {
                    app_dir.join("bin/node/node.exe")
                } else {
                    app_dir.join("bin/node/bin/node")
                };

                // Start Next.js server on port 1420
                let _ = Command::new(node_path)
                    .args([
                        "node_modules/next/dist/bin/next",
                        "start",
                        "-p",
                        "1420",
                    ])
                    .current_dir(app.path_resolver().app_dir().unwrap())
                    .spawn();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
