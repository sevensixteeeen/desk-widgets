//! App settings saved to %APPDATA%\com.deskwidgets.app\settings.json

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    #[serde(default)] // missing in an older file -> false instead of an error
    pub locked: bool,
    #[serde(default)] // missing -> empty list, i.e. every widget shown
    pub hidden: Vec<String>, // labels of widgets you've hidden, e.g. ["weather"]
    #[serde(default)] // missing -> none of the STARTS_HIDDEN widgets turned on yet
    pub shown: Vec<String>, // STARTS_HIDDEN widgets you've turned on, e.g. ["lyrics"]
}

/// Widgets that start hidden, on a new install and after an update, until you turn them on from
/// the tray. Every other widget starts shown. Adding a widget here keeps it off people's desktops
/// until they ask for it.
pub const STARTS_HIDDEN: [&str; 1] = ["lyrics"];

impl Settings {
    pub fn is_hidden(&self, label: &str) -> bool {
        let listed = |list: &Vec<String>| list.iter().any(|l| l == label);
        if STARTS_HIDDEN.contains(&label) {
            !listed(&self.shown)
        } else {
            listed(&self.hidden)
        }
    }

    pub fn set_hidden(&mut self, label: &str, hide: bool) {
        // STARTS_HIDDEN widgets are listed while shown; the others while hidden.
        let (list, listed) = if STARTS_HIDDEN.contains(&label) {
            (&mut self.shown, !hide)
        } else {
            (&mut self.hidden, hide)
        };
        list.retain(|l| l != label);
        if listed {
            list.push(label.to_string());
        }
    }
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default() // no file yet, or unreadable -> defaults
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let p = path(app).ok_or("Can't find the settings folder")?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}
