//! What you set up in the widgets (sizes, added clocks, weather city, last calendar used),
//! saved to %APPDATA%\com.deskwidgets.app\widgets.json.
//!
//! This used to live in the WebView's localStorage, which writes to disk lazily and lost
//! changes whenever Windows shut down mid-write. Here every change goes straight to the file.

use serde_json::Value;
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Key -> value, e.g. "clock.zones" -> [{"name": "Tokyo", ...}]. Sorted, so the file reads well.
pub type Store = BTreeMap<String, Value>;

/// All four widget windows save here. One at a time, so two saves can't overwrite each other.
static LOCK: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("widgets.json"))
}

fn read(path: &PathBuf) -> Result<Store, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::new()), // first run
        // Anything else (say, a virus scanner has it open): fail this save rather than
        // carry on with an empty list and overwrite everything else in the file.
        Err(e) => return Err(e.to_string()),
    };
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| {
        // Not valid JSON: keep it aside rather than overwrite it with the next save.
        let _ = fs::rename(path, path.with_extension("corrupt.json"));
        Store::new()
    }))
}

/// Writes a new file next to the old one, flushes it to disk, then swaps it in. A shutdown
/// halfway through leaves the old file whole instead of half a new one.
fn write(path: &PathBuf, store: &Store) -> Result<(), String> {
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Everything saved. `legacy` is what this window still has in localStorage from older
/// versions: any of it the file doesn't have yet is copied in, once.
pub fn load(app: &AppHandle, legacy: Store) -> Result<Store, String> {
    let _guard = LOCK.lock().unwrap();
    let path = path(app)?;
    let mut store = read(&path)?;
    let before = store.len();
    for (key, value) in legacy {
        store.entry(key).or_insert(value);
    }
    if store.len() > before {
        write(&path, &store)?;
    }
    Ok(store)
}

/// Saves one value (null removes it) and tells every widget window, so they all see it.
pub fn set(app: &AppHandle, key: String, value: Value) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap();
    let path = path(app)?;
    let mut store = read(&path)?;
    if value.is_null() {
        store.remove(&key);
    } else {
        store.insert(key.clone(), value.clone());
    }
    write(&path, &store)?;
    let _ = app.emit("store-changed", serde_json::json!({ "key": key, "value": value }));
    Ok(())
}
