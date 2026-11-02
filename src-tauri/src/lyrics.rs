//! Song lyrics from LRCLIB (https://lrclib.net): free, no account or key, and most songs come
//! with every line's time, so the widgets can follow along. Spotify's own lyrics (Musixmatch)
//! aren't available to other apps.
//!
//! Found lyrics are kept in %LOCALAPPDATA%\com.deskwidgets.app\lyrics\, so a song played again
//! needs no request. "Not found" is only remembered until the app closes: LRCLIB keeps growing.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};

const API: &str = "https://lrclib.net/api";
/// LRCLIB asks apps to say who they are.
const USER_AGENT: &str = concat!(
    "Desk Widgets ",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/sevensixteeeen/desk-widgets)"
);
/// A search result counts as the same recording if its length is within this many seconds.
const SAME_LENGTH: f64 = 3.0;
/// When it's overloaded, LRCLIB turns some requests away with 503 "ServerOverloaded" and
/// `retry-after: 1`, and asking again a moment later usually gets through (on 2026-11-02 the
/// fourth try did, about 5 s in). So a busy answer is retried this many times, 1 s apart and a
/// little longer each time, before the lookup gives up and the widget tries again later.
const BUSY_TRIES: u32 = 5;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub synced: Option<String>, // one line each, like "[00:15.55] Tere bina kya wajood mera"
    pub plain: Option<String>,  // the words without times, when that's all there is
    pub instrumental: bool,
}

/// One song as LRCLIB sends it; only the fields used here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    duration: Option<f64>, // seconds
    #[serde(default)]
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

impl From<Record> for Lyrics {
    fn from(r: Record) -> Self {
        Lyrics { synced: r.synced_lyrics, plain: r.plain_lyrics, instrumental: r.instrumental }
    }
}

/// Songs looked up since the app started, found or not. The lyrics widget and the now-playing
/// widget ask for the same song, so the second one gets it from here.
static SEEN: Mutex<BTreeMap<String, Option<Lyrics>>> = Mutex::new(BTreeMap::new());

/// One lookup at a time per song. Both windows ask for a new song at about the same moment; the
/// second waits on that song's lock and then finds the answer in SEEN, instead of sending a busy
/// LRCLIB the same requests. Per song, not one lock for all: when you skip through songs, the new
/// one mustn't wait behind lookups for songs nobody is listening to any more.
static LOOKING_UP: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>> = Mutex::new(BTreeMap::new());

/// The lyrics of a song, or None if LRCLIB doesn't have them. An Err (offline, LRCLIB busy)
/// isn't remembered, so asking again later tries again.
pub async fn get(
    app: &AppHandle,
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: i64,
) -> Result<Option<Lyrics>, String> {
    let key = format!("{artist}|{title}|{}", duration_ms / 1000);
    let seen = || SEEN.lock().unwrap().get(&key).cloned();
    if let Some(found) = seen() {
        return Ok(found);
    }
    let song_lock = LOOKING_UP.lock().unwrap().entry(key.clone()).or_default().clone();
    let _this_song_once = song_lock.lock().await;
    if let Some(found) = seen() {
        return Ok(found); // the other window just looked it up
    }

    let file = cache_file(app, &key);
    let saved = file
        .as_ref()
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|raw| serde_json::from_str::<Lyrics>(&raw).ok());
    if let Some(found) = saved {
        SEEN.lock().unwrap().insert(key, Some(found.clone()));
        return Ok(Some(found));
    }

    let found = fetch(title, artist, album, duration_ms).await?;
    if let (Some(lyrics), Some(file)) = (&found, &file) {
        if let Ok(json) = serde_json::to_string(lyrics) {
            let _ = fs::write(file, json); // only a cache: if it can't be written, it's fetched next time
        }
    }
    SEEN.lock().unwrap().insert(key, found.clone());
    Ok(found)
}

async fn fetch(title: &str, artist: &str, album: &str, duration_ms: i64) -> Result<Option<Lyrics>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. Exact: title, artist, album and length (LRCLIB allows a couple of seconds' difference).
    if !album.is_empty() && duration_ms > 0 {
        let seconds = (duration_ms / 1000).to_string();
        let res = send(
            client
                .get(format!("{API}/get"))
                .query(&[("track_name", title), ("artist_name", artist), ("album_name", album), ("duration", seconds.as_str())]),
        )
        .await?;
        match res.status() {
            s if s.is_success() => return Ok(Some(res.json::<Record>().await.map_err(|e| e.to_string())?.into())),
            reqwest::StatusCode::NOT_FOUND => {} // no exact match: search below
            s => return Err(format!("LRCLIB answered {s}")),
        }
    }

    // 2. Search. Spotify's names often don't match exactly ("Kesariya (From \"Brahmastra\")",
    // "Pritam, Arijit Singh"), so search for the plain title and the first artist, keep results
    // of about the same length, and prefer timed lyrics.
    let res = send(
        client
            .get(format!("{API}/search"))
            .query(&[("track_name", plain_title(title)), ("artist_name", first_artist(artist))]),
    )
    .await?;
    if !res.status().is_success() {
        return Err(format!("LRCLIB answered {}", res.status()));
    }
    let seconds = duration_ms as f64 / 1000.0;
    let mut matches: Vec<Record> = res
        .json::<Vec<Record>>()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| duration_ms <= 0 || r.duration.is_some_and(|d| (d - seconds).abs() <= SAME_LENGTH))
        .collect();
    let best = matches.iter().position(|r| r.synced_lyrics.is_some()).or(if matches.is_empty() { None } else { Some(0) });
    Ok(best.map(|i| matches.swap_remove(i).into()))
}

/// Sends a request, and while LRCLIB answers "busy" (503, or 429 "too many requests"), waits as
/// long as its retry-after says (1 s, then a little longer each time, at most 4 s) and asks again.
/// After BUSY_TRIES it returns the busy answer, which the caller turns into an error.
async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let mut tries = 1;
    loop {
        let again = request.try_clone().ok_or("can't repeat the request")?; // a GET always can
        let res = again.send().await.map_err(|e| e.to_string())?;
        let busy = matches!(res.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE | reqwest::StatusCode::TOO_MANY_REQUESTS);
        if !busy || tries == BUSY_TRIES {
            return Ok(res);
        }
        let asked = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map_or(Duration::from_secs(1), Duration::from_secs);
        let wait = asked.max(Duration::from_millis(500 + 500 * u64::from(tries))).min(Duration::from_secs(4));
        tokio::time::sleep(wait).await;
        tries += 1;
    }
}

/// "Kesariya (From \"Brahmastra\")" -> "Kesariya", "Song - Remastered 2011" -> "Song".
/// A title that starts with brackets, like "(I Can't Get No) Satisfaction", is left as it is.
fn plain_title(title: &str) -> &str {
    let cut = [" - ", " ("].iter().filter_map(|sep| title.find(sep)).min().unwrap_or(title.len());
    title[..cut].trim()
}

/// "Pritam, Arijit Singh" -> "Pritam"
fn first_artist(artist: &str) -> &str {
    artist.split([',', '&']).next().unwrap_or(artist).trim()
}

/// lyrics\<hash>.json in the app's local data folder, one file per song.
fn cache_file(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("lyrics");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{:016x}.json", fnv1a(key))))
}

/// A short, stable name for a song's file. (Rust's own hasher may change between versions,
/// which would orphan every saved file.)
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ byte as u64).wrapping_mul(0x100000001b3))
}
