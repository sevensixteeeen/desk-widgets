//! Updates: looks for a newer release on GitHub and offers to install it.
//! Where to look, and the public key that proves an update came from us, are in
//! tauri.conf.json → plugins.updater. .github/workflows/release.yml builds and signs each release.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use tauri::{menu::MenuItem, AppHandle, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::AppHandleExt;

/// The first look waits a minute: right after login, Wi-Fi often isn't connected yet.
const FIRST_CHECK: Duration = Duration::from_secs(60);
/// Widgets stay open for days, so look again once a day, not only at startup.
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// Set while a check or its dialog is open, so the daily check and the tray item can't both ask.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Checks a minute after startup, then once a day. Says nothing unless there's an update.
/// `item` is the tray's "Check for updates…", which changes to "Update to x.y.z…" when there is one.
pub fn check_daily(app: &AppHandle, item: MenuItem<Wry>) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            check(&app, &item, false);
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// Tray → Check for updates…: the same check, but it also says when there's nothing new or it failed.
pub fn check_now(app: &AppHandle, item: &MenuItem<Wry>) {
    // Its own thread: the dialogs wait for a click, and this is called from the tray's event handler.
    let (app, item) = (app.clone(), item.clone());
    std::thread::spawn(move || check(&app, &item, true));
}

/// `asked`: the user chose the tray item, so tell them the result even when it's "nothing new".
fn check(app: &AppHandle, item: &MenuItem<Wry>, asked: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return; // another check is already running or asking
    }
    let checked = tauri::async_runtime::block_on(async {
        match app.updater()?.check().await? {
            Some(update) => {
                let _ = item.set_text(format!("Update to {}…", update.version));
                offer(app, update).await;
            }
            None if asked => {
                let version = app.package_info().version.to_string();
                tell(app, MessageDialogKind::Info, &format!("You have the latest version, {version}."));
            }
            None => {}
        }
        Ok::<_, tauri_plugin_updater::Error>(())
    });
    if let Err(e) = checked {
        // A daily check fails quietly (offline, GitHub busy); it tries again tomorrow.
        if asked {
            tell(app, MessageDialogKind::Error, &format!("Couldn't check for updates.\n\n{e}"));
        } else {
            eprintln!("Couldn't check for updates: {e}");
        }
    }
    BUSY.store(false, Ordering::SeqCst);
}

/// Asks before installing. On Windows the installer closes the app, updates it and opens it again.
async fn offer(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let install = app
        .dialog()
        .message(format!(
            "Desk Widgets {} is out. You have {}.\n\nInstall it now? The widgets close for a few seconds \
             and come back where they were.",
            update.version, update.current_version
        ))
        .title("Desk Widgets update")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .blocking_show();
    if !install {
        return;
    }

    // The installer ends the app without quitting it, so the window-state plugin's save at quit
    // never runs. Save now, on the main thread like every other save (see save_state_after_changes).
    let (saved, wait) = mpsc::channel();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = handle.save_window_state(crate::REMEMBERED);
        let _ = saved.send(());
    });
    let _ = wait.recv_timeout(Duration::from_secs(2));

    // Downloads, checks the signature, and starts the installer, which closes this app.
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        tell(app, MessageDialogKind::Error, &format!("Couldn't install the update.\n\n{e}"));
    }
}

fn tell(app: &AppHandle, kind: MessageDialogKind, text: &str) {
    app.dialog().message(text).title("Desk Widgets update").kind(kind).blocking_show();
}
