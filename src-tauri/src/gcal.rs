//! Google Calendar: sign-in (OAuth "loopback" flow for desktop apps) + event fetching.
//!
//! How sign-in works:
//! 1. We start a tiny web server on 127.0.0.1 at a random free port.
//! 2. We open Google's sign-in page in your browser, telling Google to send you back to that port.
//! 3. Google redirects to http://127.0.0.1:<port>/?code=... ; our server grabs the `code`.
//! 4. We trade the code for a *refresh token* and save it. Later, we trade the refresh
//!    token for short-lived *access tokens* whenever we need to read your calendar.
//!
//! PKCE (code_verifier / code_challenge) proves the app that finishes sign-in is the same
//! one that started it, so an intercepted `code` is useless to anyone else.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/calendar/v3";
// readonly: see your list of calendars + read events. events: add events.
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
/// Bumped whenever SCOPE changes, so older sign-ins know they must reconnect.
const SCOPE_VERSION: u32 = 2;
const CLIENT_FILE: &str = "google_client.json";
const TOKEN_FILE: &str = "google_token.json";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Files ----------

/// The JSON you download from Google Cloud for a "Desktop app" client looks like
/// {"installed": {"client_id": "...", "client_secret": "...", ...}}
#[derive(Deserialize)]
struct ClientFile {
    installed: ClientCreds,
}

#[derive(Deserialize)]
struct ClientCreds {
    client_id: String,
    client_secret: String,
}

#[derive(Serialize, Deserialize)]
struct SavedToken {
    refresh_token: String,
    #[serde(default)] // tokens saved before this field existed read as 0
    scope_version: u32,
}

/// %APPDATA%\com.deskwidgets.app on Windows
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn load_client(app: &AppHandle) -> Result<ClientCreds, String> {
    let path = config_dir(app)?.join(CLIENT_FILE);
    let raw = fs::read_to_string(&path)
        .map_err(|_| format!("Put your Google client file at {}", path.display()))?;
    let file: ClientFile =
        serde_json::from_str(&raw).map_err(|e| format!("{CLIENT_FILE} is not valid: {e}"))?;
    Ok(file.installed)
}

fn load_token(app: &AppHandle) -> Result<Option<SavedToken>, String> {
    let path = config_dir(app)?.join(TOKEN_FILE);
    match fs::read_to_string(path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
        Err(_) => Ok(None),
    }
}

fn save_token(app: &AppHandle, token: &SavedToken) -> Result<(), String> {
    let path = config_dir(app)?.join(TOKEN_FILE);
    fs::write(path, serde_json::to_string(token).map_err(err)?).map_err(err)
}

pub fn disconnect(app: &AppHandle) -> Result<(), String> {
    let path = config_dir(app)?.join(TOKEN_FILE);
    if path.exists() {
        fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

// ---------- Status ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,      // google_client.json exists
    connected: bool,       // signed in with every permission we need
    needs_reconnect: bool, // signed in, but before new permissions were added
    client_path: String,
}

pub fn status(app: &AppHandle) -> Result<Status, String> {
    let client_path = config_dir(app)?.join(CLIENT_FILE);
    let version = load_token(app)?.map(|t| t.scope_version);
    Ok(Status {
        configured: client_path.exists(),
        connected: version == Some(SCOPE_VERSION),
        needs_reconnect: matches!(version, Some(v) if v < SCOPE_VERSION),
        client_path: client_path.display().to_string(),
    })
}

// ---------- Sign-in ----------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

fn random_string(len: usize) -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(len).map(char::from).collect()
}

pub async fn connect(app: AppHandle) -> Result<(), String> {
    let creds = load_client(&app)?;

    let verifier = random_string(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_string(24); // guards against forged redirects

    // Port 0 = "any free port"
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr().map_err(err)?.port());

    let auth_url = Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", creds.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"), // ask for a refresh token
            ("prompt", "consent"),      // ...every time, even on re-connect
            ("state", state.as_str()),
        ],
    )
    .map_err(err)?;

    app.opener().open_url(auth_url.as_str(), None::<&str>).map_err(err)?;

    // Waiting on a socket blocks, so do it off the async runtime.
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state))
        .await
        .map_err(err)??;

    let token: TokenResponse = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;

    let refresh_token = token.refresh_token.ok_or("Google didn't return a refresh token")?;
    save_token(&app, &SavedToken { refresh_token, scope_version: SCOPE_VERSION })
}

/// Accepts browser requests until one carries `?code=...`, or gives up after 5 minutes.
fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(err)?; // lets us check the timeout
    let deadline = Instant::now() + Duration::from_secs(300);

    while Instant::now() < deadline {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).ok(); // on Windows it inherits non-blocking

        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        // First line of the request: "GET /?state=...&code=... HTTP/1.1"
        let path = request.split_whitespace().nth(1).unwrap_or("/");
        let params: HashMap<String, String> = Url::parse(&format!("http://localhost{path}"))
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();

        if params.contains_key("error") {
            reply(&mut stream, "Sign-in was cancelled. You can close this tab.");
            return Err("Google sign-in was cancelled".into());
        }
        let Some(code) = params.get("code") else {
            reply(&mut stream, ""); // e.g. the browser asking for /favicon.ico
            continue;
        };
        if params.get("state").map(String::as_str) != Some(expected_state) {
            reply(&mut stream, "Sign-in check failed. Try connecting again.");
            return Err("Sign-in state didn't match".into());
        }
        reply(&mut stream, "Calendar connected. You can close this tab.");
        return Ok(code.clone());
    }
    Err("Timed out waiting for Google sign-in".into())
}

fn reply(stream: &mut TcpStream, message: &str) {
    let body = format!(
        "<html><body style=\"font:18px system-ui;padding:48px\">{message}</body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

// ---------- Access token ----------

/// Swaps the long-lived refresh token for a 1-hour access token.
async fn access_token(app: &AppHandle, client: &reqwest::Client) -> Result<String, String> {
    let creds = load_client(app)?;
    let saved = load_token(app)?.ok_or("Not connected")?;

    let res = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("refresh_token", saved.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(err)?;

    if res.status().as_u16() == 400 {
        // Usually "invalid_grant": the refresh token expired or access was revoked.
        disconnect(app)?;
        return Err("Google sign-in expired. Connect again.".into());
    }
    let token: TokenResponse = res.error_for_status().map_err(err)?.json().await.map_err(err)?;
    Ok(token.access_token)
}

// ---------- Reading events ----------

#[derive(Deserialize)]
struct CalendarList {
    #[serde(default)]
    items: Vec<CalendarEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEntry {
    id: String,
    summary: Option<String>,
    summary_override: Option<String>, // the name *you* gave a shared calendar
    background_color: Option<String>, // the colour Google Calendar shows it in
    #[serde(default)]
    selected: bool, // ticked in the Google Calendar sidebar
    #[serde(default)]
    hidden: bool,
    access_role: Option<String>, // "owner" | "writer" | "reader" | "freeBusyReader"
    #[serde(default)]
    primary: bool, // your main calendar
}

#[derive(Deserialize)]
struct EventList {
    #[serde(default)]
    items: Vec<ApiEvent>,
}

#[derive(Deserialize)]
struct ApiEvent {
    summary: Option<String>,
    start: Option<ApiTime>,
}

#[derive(Deserialize)]
struct ApiTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>, // timed events: "2026-09-25T15:00:00+05:30"
    date: Option<String>,      // all-day events: "2026-09-25"
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    title: String,
    start: String,
    all_day: bool,
    calendar: String,
    color: String,
}

/// Every calendar in your Google Calendar sidebar (ticked or not).
async fn calendar_list(client: &reqwest::Client, token: &str) -> Result<CalendarList, String> {
    client
        .get(format!("{API}/users/me/calendarList"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)
}

/// A calendar you can add events to, for the picker in the add-event form.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarChoice {
    id: String,
    name: String,
    color: String,
    primary: bool,
}

/// Calendars you're allowed to add events to (you own them, or have "make changes" access),
/// that are ticked in your sidebar. Your main calendar comes first.
pub async fn calendars(app: AppHandle) -> Result<Vec<CalendarChoice>, String> {
    let client = reqwest::Client::new();
    let token = access_token(&app, &client).await?;
    let list = calendar_list(&client, &token).await?;

    let mut choices: Vec<CalendarChoice> = list
        .items
        .into_iter()
        .filter(|c| c.selected && !c.hidden)
        .filter(|c| matches!(c.access_role.as_deref(), Some("owner") | Some("writer")))
        .map(|c| CalendarChoice {
            name: c.summary_override.or(c.summary).unwrap_or_default(),
            color: c.background_color.unwrap_or_else(|| "#888888".into()),
            primary: c.primary,
            id: c.id,
        })
        .collect();

    // true sorts after false, so negate: primary first, then alphabetical.
    choices.sort_by(|a, b| (!a.primary, a.name.to_lowercase()).cmp(&(!b.primary, b.name.to_lowercase())));
    Ok(choices)
}

/// Events from every calendar ticked in your Google Calendar sidebar.
/// `time_min` / `time_max` are ISO timestamps from JS.
pub async fn events(app: AppHandle, time_min: String, time_max: String) -> Result<Vec<Event>, String> {
    let client = reqwest::Client::new();
    let token = access_token(&app, &client).await?;

    let calendars = calendar_list(&client, &token).await?;

    let mut all = Vec::new();
    for cal in calendars.items.into_iter().filter(|c| c.selected && !c.hidden) {
        let name = cal.summary_override.or(cal.summary).unwrap_or_default();
        let color = cal.background_color.unwrap_or_else(|| "#888888".into());

        // Calendar IDs contain characters like '#' and '@' (holiday calendars do),
        // so let the url crate encode the ID safely into the path.
        let mut url = Url::parse(API).map_err(err)?;
        url.path_segments_mut()
            .map_err(|_| "Bad calendar URL")?
            .extend(["calendars", cal.id.as_str(), "events"]);
        url.query_pairs_mut()
            .append_pair("timeMin", &time_min)
            .append_pair("timeMax", &time_max)
            .append_pair("singleEvents", "true") // expand repeating events
            .append_pair("orderBy", "startTime")
            .append_pair("maxResults", "250");

        // One calendar failing (e.g. access removed) shouldn't blank the whole widget.
        let Ok(res) = client.get(url).bearer_auth(&token).send().await else { continue };
        let Ok(list) = res.json::<EventList>().await else { continue };

        for e in list.items {
            let Some(start) = e.start else { continue };
            let all_day = start.date_time.is_none();
            let Some(when) = start.date_time.or(start.date) else { continue };
            all.push(Event {
                title: e.summary.unwrap_or_else(|| "(No title)".into()),
                start: when,
                all_day,
                calendar: name.clone(),
                color: color.clone(),
            });
        }
    }
    Ok(all) // JS sorts them, since mixed time zones sort wrong as plain text
}

// ---------- Adding events ----------

/// Adds an event to the calendar with id `calendar_id` ("primary" = your main calendar).
/// Timed: `start`/`end` are ISO timestamps. All-day: dates like "2026-09-25",
/// with `end` the day *after* (Google treats the end date as exclusive).
pub async fn create_event(
    app: AppHandle,
    title: String,
    start: String,
    end: String,
    all_day: bool,
    calendar_id: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let token = access_token(&app, &client).await?;

    // All-day events use {"date": ...}; timed events use {"dateTime": ...}.
    let (start, end) = if all_day {
        (json!({ "date": start }), json!({ "date": end }))
    } else {
        (json!({ "dateTime": start }), json!({ "dateTime": end }))
    };
    let body = json!({ "summary": title, "start": start, "end": end });

    // Same safe path-building as in events(): IDs can contain '@' and '#'.
    let mut url = Url::parse(API).map_err(err)?;
    url.path_segments_mut()
        .map_err(|_| "Bad calendar URL")?
        .extend(["calendars", calendar_id.as_str(), "events"]);

    let res = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(err)?;

    if res.status().as_u16() == 403 {
        return Err("No permission for that calendar. Try another.".into());
    }
    res.error_for_status().map_err(err)?;
    Ok(())
}
