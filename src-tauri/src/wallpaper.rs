//! Reads the current desktop wallpaper so the widgets can take their colours from it.
//!
//! Windows keeps a copy of whatever wallpaper is showing at
//! %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper (a JPEG with no extension),
//! so we don't need to know where the original image lives.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use image::ImageFormat;
use std::{fs, io::Cursor, path::PathBuf, time::UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wallpaper {
    stamp: String,    // last-modified time; changes when you change wallpaper
    data_url: String, // the image, ready for an <img>/canvas in JS
}

fn wallpaper_path() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA isn't set")?;
    Ok(PathBuf::from(appdata).join(r"Microsoft\Windows\Themes\TranscodedWallpaper"))
}

/// Returns `None` when the wallpaper hasn't changed since `known_stamp`,
/// so JS can poll cheaply without re-sending a multi-MB image.
pub fn read(known_stamp: Option<String>) -> Result<Option<Wallpaper>, String> {
    let path = wallpaper_path()?;
    let meta = fs::metadata(&path).map_err(|_| "No picture wallpaper is set")?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();

    if known_stamp.as_deref() == Some(stamp.as_str()) {
        return Ok(None);
    }

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    // The theme only needs the wallpaper's colours, not its detail. Shrink it here in Rust
    // so each widget receives a tiny image (~20 KB) instead of the full one (several MB).
    let full = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let small = full.thumbnail(160, 90); // fits inside 160x90, keeps the shape

    let mut png = Vec::new();
    small
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(Some(Wallpaper { stamp, data_url: format!("data:image/png;base64,{}", STANDARD.encode(png)) }))
}
