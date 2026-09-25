mod gcal;
mod media;
mod settings;
mod wallpaper;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

// ---------- Commands: functions the JS side can call with invoke("name") ----------

// Media calls block while Windows answers, so each one runs on a background
// thread (spawn_blocking) instead of freezing the app's main thread.

#[tauri::command]
async fn media_now_playing() -> Result<Option<media::NowPlaying>, String> {
    tauri::async_runtime::spawn_blocking(media::now_playing).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_thumbnail() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(media::thumbnail).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn gcal_status(app: AppHandle) -> Result<gcal::Status, String> {
    gcal::status(&app)
}

#[tauri::command]
async fn gcal_connect(app: AppHandle) -> Result<(), String> {
    gcal::connect(app).await
}

#[tauri::command]
async fn gcal_events(app: AppHandle, time_min: String, time_max: String) -> Result<Vec<gcal::Event>, String> {
    gcal::events(app, time_min, time_max).await
}

#[tauri::command]
async fn gcal_create_event(
    app: AppHandle,
    title: String,
    start: String,
    end: String,
    all_day: bool,
) -> Result<(), String> {
    gcal::create_event(app, title, start, end, all_day).await
}

#[tauri::command]
fn gcal_disconnect(app: AppHandle) -> Result<(), String> {
    gcal::disconnect(&app)
}

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command]
async fn wallpaper(known: Option<String>) -> Result<Option<wallpaper::Wallpaper>, String> {
    wallpaper::read(known)
}

// ---------- Desktop pinning ----------

/// Makes a widget "owned" by the desktop so Win+D (Show desktop) leaves it visible.
#[cfg(windows)]
fn pin_to_desktop(window: &tauri::WebviewWindow) {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetWindowLongPtrW, GWLP_HWNDPARENT};

    // HWND = Windows' ID number for a window
    let Ok(hwnd) = window.hwnd() else { return };
    // "Progman" is the system window that draws the desktop and its icons
    let Ok(desktop) = (unsafe { FindWindowW(w!("Progman"), PCWSTR::null()) }) else { return };

    // GWLP_HWNDPARENT sets the window's *owner* (despite the name)
    unsafe {
        SetWindowLongPtrW(HWND(hwnd.0), GWLP_HWNDPARENT, desktop.0 as isize);
    }
}

// ---------- App ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Registers/unregisters the app in Windows' startup list (HKCU\...\Run).
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // Only remember position; sizes come from config.js.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .setup(|app| {
            // Widgets have no taskbar button, so the tray icon is the control panel.
            let locked = settings::load(app.handle()).locked;
            let lock = CheckMenuItem::with_id(app, "lock", "Lock widgets", true, locked, None::<&str>)?;
            let starts_at_login = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart =
                CheckMenuItem::with_id(app, "autostart", "Open at login", true, starts_at_login, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit widgets", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&lock, &autostart, &quit])?;

            // The closure below needs its own handles to update the checkmarks.
            let lock_item = lock.clone();
            let autostart_item = autostart.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon missing"))
                .tooltip("Desk widgets")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "lock" => {
                        // Flip the saved value (don't trust the checkmark's own toggle timing),
                        // then make the checkmark and every widget agree with it.
                        let mut s = settings::load(app);
                        s.locked = !s.locked;
                        let _ = settings::save(app, &s);
                        let _ = lock_item.set_checked(s.locked);
                        let _ = app.emit("lock-changed", s.locked); // JS listens for this
                    }
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let enable = !launcher.is_enabled().unwrap_or(false);
                        let _ = if enable { launcher.enable() } else { launcher.disable() };
                        // Show what Windows actually has, in case enabling failed.
                        let _ = autostart_item.set_checked(launcher.is_enabled().unwrap_or(false));
                    }
                    "quit" => {
                        let _ = app.save_window_state(StateFlags::POSITION);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            #[cfg(windows)]
            for window in app.webview_windows().values() {
                pin_to_desktop(window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media_now_playing,
            media_thumbnail,
            media_control,
            gcal_status,
            gcal_connect,
            gcal_events,
            gcal_create_event,
            gcal_disconnect,
            get_settings,
            wallpaper
        ])
        .run(tauri::generate_context!())
        .expect("error while running desk widgets");
}
