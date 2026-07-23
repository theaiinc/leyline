mod sidecar;

use std::sync::Mutex;
use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let mut manager = sidecar::SidecarManager::new();
            manager.ensure_started(resource_dir)?;
            app.manage(Mutex::new(manager));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Leyline Tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(manager) = app.try_state::<Mutex<sidecar::SidecarManager>>() {
                    if let Ok(mut manager) = manager.lock() {
                        manager.stop();
                    }
                }
            }
        });
}
