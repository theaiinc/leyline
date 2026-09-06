mod sidecar;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(20);
const SIDECAR_RETRY_DELAY: Duration = Duration::from_secs(2);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // The setup hook runs inside applicationDidFinishLaunching; a panic
            // or Err here aborts the whole app (SIGABRT). Keep it infallible
            // and non-blocking: sidecar startup happens on a background thread
            // and every failure is logged instead of propagated.
            let resource_dir = app.path().resource_dir().ok();
            let manager = Arc::new(Mutex::new(sidecar::SidecarManager::new()));
            app.manage(manager.clone());
            std::thread::spawn(move || supervise_sidecar(manager, resource_dir));

            if let Err(error) = setup_window_and_tray(app) {
                eprintln!("[Leyline] Failed to set up tray/menu: {error}");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Leyline Tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(manager) = app.try_state::<Arc<Mutex<sidecar::SidecarManager>>>() {
                    if let Ok(mut manager) = manager.lock() {
                        manager.stop();
                    }
                }
            }
        });
}

fn supervise_sidecar(
    manager: Arc<Mutex<sidecar::SidecarManager>>,
    resource_dir: Option<std::path::PathBuf>,
) {
    loop {
        let (endpoint, outcome) = {
            let Ok(mut guard) = manager.lock() else {
                return;
            };
            (
                guard.endpoint(),
                guard.spawn_if_needed(resource_dir.clone()),
            )
        };

        match outcome {
            Ok(sidecar::StartOutcome::Reused) => {
                std::thread::sleep(SIDECAR_RETRY_DELAY);
            }
            Ok(sidecar::StartOutcome::Waiting) => {
                std::thread::sleep(Duration::from_millis(250));
            }
            Ok(sidecar::StartOutcome::Spawned) => {
                let (host, port) = endpoint;
                if sidecar::wait_until_endpoint_ready(&host, port, SIDECAR_READY_TIMEOUT) {
                    println!("[Leyline] Internal API ready on {host}:{port}");
                } else {
                    eprintln!(
                        "[Leyline] Internal API did not become ready on {host}:{port} within {}s; retrying",
                        SIDECAR_READY_TIMEOUT.as_secs()
                    );
                    if let Ok(mut guard) = manager.lock() {
                        guard.stop();
                    }
                }
            }
            Err(error) => {
                eprintln!("[Leyline] Failed to start internal API sidecar: {error}; retrying");
                std::thread::sleep(SIDECAR_RETRY_DELAY);
            }
        }
    }
}

fn setup_window_and_tray(app: &tauri::App) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let window_for_close = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_for_close.hide();
            }
        });
    } else {
        eprintln!("[Leyline] Main window not found; close-to-tray disabled");
    }

    let show = MenuItem::with_id(app, "show", "Show Leyline", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Leyline", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let Some(tray_icon) = tray_icon() else {
        eprintln!("[Leyline] Tray icon failed to decode; tray disabled");
        return Ok(());
    };
    TrayIconBuilder::new()
        .menu(&menu)
        .icon(tray_icon)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn tray_icon() -> Option<Image<'static>> {
    let decoder = png::Decoder::new(std::io::Cursor::new(include_bytes!("../icons/tray.png")));
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buffer).ok()?;
    Some(Image::new_owned(
        buffer[..info.buffer_size()].to_vec(),
        info.width,
        info.height,
    ))
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
