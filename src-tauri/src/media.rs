//! "Now playing" via Windows' Global System Media Transport Controls (GSMTC).
//!
//! This is the same API that powers the media flyout when you press a volume key.
//! Any app that reports media to Windows (Spotify, Chrome/YouTube, Apple Music...)
//! shows up here, so we need no Spotify developer account or login.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")] // Rust snake_case -> JS camelCase
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub app: String,
    pub playing: bool,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub can_seek: bool, // the app lets others move its playback position
}

// Public functions return `Result<_, String>` because Tauri sends errors to JS as strings.
pub fn now_playing() -> Result<Option<NowPlaying>, String> {
    imp::now_playing().map_err(|e| e.to_string())
}

pub fn thumbnail() -> Result<Option<String>, String> {
    imp::thumbnail().map_err(|e| e.to_string())
}

pub fn control(action: &str) -> Result<(), String> {
    imp::control(action).map_err(|e| e.to_string())
}

/// Jumps to `position_ms` in the current track. Ok(false) = the app refused.
pub fn seek(position_ms: i64) -> Result<bool, String> {
    imp::seek(position_ms).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod imp {
    use super::NowPlaying;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    /// WinRT times are "ticks": 100-nanosecond units. 10,000 ticks = 1 ms.
    const TICKS_PER_MS: i64 = 10_000;
    /// WinRT DateTime counts from 1601-01-01; Unix time counts from 1970-01-01.
    const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

    /// The session Windows considers "current" (the one the media flyout shows).
    fn current_session() -> windows::core::Result<Option<Session>> {
        // `.get()` blocks until the async WinRT call finishes. That's why the
        // Tauri commands run these functions on a background thread.
        let manager = Manager::RequestAsync()?.get()?;
        // Fails when no media app is open; that just means "nothing playing".
        Ok(manager.GetCurrentSession().ok())
    }

    pub fn now_playing() -> windows::core::Result<Option<NowPlaying>> {
        let Some(session) = current_session()? else { return Ok(None) };

        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let info = session.GetPlaybackInfo()?;
        let playing = info.PlaybackStatus()? == Status::Playing;
        // Each app decides whether outside controls may seek. If asking fails, assume not.
        let can_seek = info
            .Controls()
            .and_then(|c| c.IsPlaybackPositionEnabled())
            .unwrap_or(false);
        let timeline = session.GetTimelineProperties()?;

        let duration =
            (timeline.EndTime()?.Duration - timeline.StartTime()?.Duration) / TICKS_PER_MS;
        let mut position = timeline.Position()?.Duration / TICKS_PER_MS;

        // Apps only report the position occasionally (Spotify roughly every few
        // seconds). Add the time elapsed since that report so the bar stays accurate.
        if playing {
            let reported_at = timeline.LastUpdatedTime()?.UniversalTime;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64 * TICKS_PER_MS + EPOCH_DIFF_TICKS)
                .unwrap_or(reported_at);
            position += (now - reported_at).max(0) / TICKS_PER_MS;
        }

        Ok(Some(NowPlaying {
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            album: props.AlbumTitle()?.to_string(),
            app: session.SourceAppUserModelId()?.to_string(),
            playing,
            position_ms: if duration > 0 { position.min(duration) } else { position },
            duration_ms: duration,
            can_seek,
        }))
    }

    /// Album art as a `data:` URL the <img> tag can use directly.
    pub fn thumbnail() -> windows::core::Result<Option<String>> {
        let Some(session) = current_session()? else { return Ok(None) };
        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let Ok(thumb) = props.Thumbnail() else { return Ok(None) };

        let stream = thumb.OpenReadAsync()?.get()?;
        let size = stream.Size()? as u32;
        if size == 0 {
            return Ok(None);
        }

        // Copy the stream into a Rust byte buffer.
        let reader = DataReader::CreateDataReader(&stream)?;
        reader.LoadAsync(size)?.get()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes)?;

        let mime = stream.ContentType()?.to_string();
        let mime = if mime.is_empty() { "image/png".to_string() } else { mime };
        Ok(Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))))
    }

    pub fn control(action: &str) -> windows::core::Result<()> {
        let Some(session) = current_session()? else { return Ok(()) };
        match action {
            "toggle" => { session.TryTogglePlayPauseAsync()?.get()?; }
            "next" => { session.TrySkipNextAsync()?.get()?; }
            "prev" => { session.TrySkipPreviousAsync()?.get()?; }
            _ => {}
        }
        Ok(())
    }

    pub fn seek(position_ms: i64) -> windows::core::Result<bool> {
        let Some(session) = current_session()? else { return Ok(false) };
        // The timeline may not start at 0, so positions are measured from its StartTime.
        let start = session.GetTimelineProperties()?.StartTime()?.Duration;
        session
            .TryChangePlaybackPositionAsync(start + position_ms * TICKS_PER_MS)?
            .get()
    }
}

/// Stub so the project still compiles on macOS/Linux (widget just shows "nothing playing").
#[cfg(not(windows))]
mod imp {
    use super::NowPlaying;
    pub fn now_playing() -> Result<Option<NowPlaying>, String> { Ok(None) }
    pub fn thumbnail() -> Result<Option<String>, String> { Ok(None) }
    pub fn control(_: &str) -> Result<(), String> { Ok(()) }
    pub fn seek(_: i64) -> Result<bool, String> { Ok(false) }
}
