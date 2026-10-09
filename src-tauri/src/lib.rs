mod gcal;
mod media;
mod settings;
mod store;
mod wallpaper;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent, Wry,
};
use std::{sync::mpsc, time::Duration};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
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
async fn media_seek(position_ms: i64) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || media::seek(position_ms))
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
    calendar_id: String,
) -> Result<(), String> {
    gcal::create_event(app, title, start, end, all_day, calendar_id).await
}

#[tauri::command]
async fn gcal_calendars(app: AppHandle) -> Result<Vec<gcal::CalendarChoice>, String> {
    gcal::calendars(app).await
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
fn store_load(app: AppHandle, legacy: store::Store) -> Result<store::Store, String> {
    store::load(&app, legacy)
}

#[tauri::command]
fn store_set(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    store::set(&app, key, value)
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

// ---------- Saving positions ----------

/// The window-state plugin only writes positions to disk when the app quits, but shutting
/// Windows down ends the app without quitting it, so a moved widget came back where it was.
/// Instead, save half a second after widgets stop moving. Send () on every move.
fn save_positions_after_moves(app: &AppHandle) -> mpsc::Sender<()> {
    let (moved, moves) = mpsc::channel();
    let app = app.clone();
    std::thread::spawn(move || {
        while moves.recv().is_ok() {
            while moves.recv_timeout(Duration::from_millis(500)).is_ok() {} // still moving
            // On the main thread, like the plugin's own save at quit: from here it could deadlock
            // with the plugin's move handler.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = handle.save_window_state(StateFlags::POSITION);
            });
        }
    });
    moved
}

// ---------- Show / hide widgets ----------

/// Every widget window: (label in tauri.conf.json, name shown in the tray menu).
const WIDGETS: [(&str, &str); 4] = [
    ("clock", "Clock"),
    ("nowplaying", "Now playing"),
    ("weather", "Weather"),
    ("calendar", "Calendar"),
];

/// Shows the widget if it's hidden, hides it if it's shown, and remembers the choice.
fn toggle_widget(app: &AppHandle, label: &str, item: &CheckMenuItem<Wry>) {
    let Some(window) = app.get_webview_window(label) else { return };
    let mut s = settings::load(app);

    let was_hidden = s.hidden.iter().any(|h| h == label);
    if was_hidden {
        s.hidden.retain(|h| h != label); // keep every entry except this one
        let _ = window.show();
    } else {
        s.hidden.push(label.to_string());
        let _ = window.hide();
    }

    let _ = settings::save(app, &s);
    let _ = item.set_checked(was_hidden); // it was hidden -> now shown -> ticked
}

// ---------- Lock ----------

/// Keyboard shortcut that locks/unlocks the widgets from anywhere.
/// Written as modifier+modifier+key; change it here if another app already uses it.
const LOCK_SHORTCUT: &str = "ctrl+alt+L";

/// Flips the lock, saves it, updates the tray tick, and tells every widget.
/// Used by both the tray menu and the keyboard shortcut.
fn toggle_lock(app: &AppHandle, item: &CheckMenuItem<Wry>) {
    let mut s = settings::load(app);
    s.locked = !s.locked;
    let _ = settings::save(app, &s);
    let _ = item.set_checked(s.locked);
    let _ = app.emit("lock-changed", s.locked); // JS listens for this
}

// ---------- App ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            let saved = settings::load(app.handle());

            // "Show widgets" submenu: one tickbox per widget.
            let widgets_menu = Submenu::new(app, "Show widgets", true)?;
            let mut widget_items = Vec::new(); // (label, menu item), used by the click handler
            for (label, name) in WIDGETS {
                let shown = !saved.hidden.iter().any(|h| h == label);
                let item = CheckMenuItem::with_id(app, format!("show:{label}"), name, true, shown, None::<&str>)?;
                widgets_menu.append(&item)?;
                widget_items.push((label, item));
            }

            // The last argument shows the shortcut next to the menu text.
            let lock = CheckMenuItem::with_id(app, "lock", "Lock widgets", true, saved.locked, Some("Ctrl+Alt+L"))?;

            // Global shortcut: works even while another app is focused.
            let lock_for_shortcut = lock.clone();
            let registered = app.global_shortcut().on_shortcut(LOCK_SHORTCUT, move |app, _shortcut, event| {
                // Fires on key down and key up; only act once, on the press.
                if event.state() == ShortcutState::Pressed {
                    toggle_lock(app, &lock_for_shortcut);
                }
            });
            if let Err(e) = registered {
                // Usually means another app already owns this shortcut. The tray item still works.
                eprintln!("Couldn't register {LOCK_SHORTCUT}: {e}");
            }
            let starts_at_login = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart =
                CheckMenuItem::with_id(app, "autostart", "Open at login", true, starts_at_login, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit widgets", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &widgets_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &lock,
                    &autostart,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            // The closure below needs its own handles to update the checkmarks.
            let lock_item = lock.clone();
            let autostart_item = autostart.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon missing"))
                .tooltip("Desk widgets")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    let id = event.id.as_ref();

                    // Widget tickboxes have ids like "show:clock".
                    if let Some(label) = id.strip_prefix("show:") {
                        if let Some((_, item)) = widget_items.iter().find(|(l, _)| *l == label) {
                            toggle_widget(app, label, item);
                        }
                        return;
                    }

                    match id {
                        "lock" => toggle_lock(app, &lock_item),
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
                    }
                })
                .build(app)?;

            let moved = save_positions_after_moves(app.handle());
            for window in app.webview_windows().values() {
                #[cfg(windows)]
                pin_to_desktop(window);

                let moved = moved.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Moved(_) = event {
                        let _ = moved.send(());
                    }
                });

                // Windows start hidden (tauri.conf.json), so hidden widgets never flash on screen.
                if !saved.hidden.iter().any(|h| h == window.label()) {
                    let _ = window.show();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media_now_playing,
            media_thumbnail,
            media_control,
            media_seek,
            gcal_status,
            gcal_connect,
            gcal_events,
            gcal_create_event,
            gcal_calendars,
            gcal_disconnect,
            get_settings,
            store_load,
            store_set,
            wallpaper
        ])
        .run(tauri::generate_context!())
        .expect("error while running desk widgets");
}
