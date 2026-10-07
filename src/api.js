// One place that talks to Tauri. Outside Tauri (a normal browser) it returns sample data,
// so you can design widgets with live reload: open src/index.html?w=clock in a browser.

const tauri = window.__TAURI__;
export const inTauri = Boolean(tauri);

export const widgetName = inTauri
  ? tauri.window.getCurrentWindow().label
  : new URLSearchParams(location.search).get("w") ?? "clock";

export function startDrag() {
  if (inTauri) tauri.window.getCurrentWindow().startDragging();
}

export function resizeWindow(width, height) {
  if (inTauri) tauri.window.getCurrentWindow().setSize(new tauri.dpi.LogicalSize(width, height));
}

/** Listen for an event sent from Rust. */
export function onEvent(name, handler) {
  if (inTauri) tauri.event.listen(name, (e) => handler(e.payload));
}

export function invoke(command, args) {
  return inTauri ? tauri.core.invoke(command, args) : sample(command, args);
}

// ---- Sample data for browser previews ----
let startedAt = Date.now(); // `let` so the sample can "seek"
const dayKey = (iso) => iso.slice(0, 10);
function sample(command, args) {
  if (command === "media_seek") startedAt = Date.now() - (args.positionMs - 83000);
  const now = new Date();
  const at = (days, h, m = 0) => {
    const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString();
  };
  const data = {
    media_now_playing: {
      title: "Night Drive", artist: "Sample Artist", album: "Preview", app: "Spotify.exe",
      playing: true, positionMs: 83000 + (Date.now() - startedAt), durationMs: 214000, canSeek: true,
    },
    media_thumbnail: null,
    media_control: null,
    media_seek: true,
    gcal_status: { configured: true, connected: true, needsReconnect: false, clientPath: "" },
    gcal_events: [
      { title: "Design review", start: at(0, 23, 30), allDay: false, calendar: "Personal", color: "#9fe1e7" },
      { title: "Gym", start: at(1, 7), allDay: false, calendar: "Personal", color: "#9fe1e7" },
      { title: "Gandhi Jayanti", start: dayKey(at(7, 0)), allDay: true, calendar: "Holidays in India", color: "#16a765" },
      { title: "Supplier call", start: at(6, 11), allDay: false, calendar: "Work", color: "#fa573c" },
      { title: "Flight to Dubai", start: at(32, 9, 40), allDay: false, calendar: "Personal", color: "#9fe1e7" },
    ],
    gcal_connect: null,
    gcal_create_event: null,
    gcal_calendars: [
      { id: "me@example.com", name: "Personal", color: "#9fe1e7", primary: true },
      { id: "work", name: "Work", color: "#fa573c", primary: false },
    ],
    get_settings: { locked: false },
    wallpaper: null,
    gcal_disconnect: null,
  };
  return Promise.resolve(data[command] ?? null);
}
