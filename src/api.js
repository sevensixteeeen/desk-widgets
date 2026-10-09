// One place that talks to Tauri. Outside Tauri (a normal browser) it returns sample data,
// so you can design widgets with live reload: open src/index.html?w=clock in a browser.

import { config } from "./config.js";

const tauri = window.__TAURI__;
export const inTauri = Boolean(tauri);

export const widgetName = inTauri
  ? tauri.window.getCurrentWindow().label
  : new URLSearchParams(location.search).get("w") ?? "clock";

export function startDrag() {
  if (inTauri) tauri.window.getCurrentWindow().startDragging();
}

// ---- Size ----
// Widgets are designed at full size. `scale` shrinks the page (zoom) and the window by the same
// amount. It starts at config.scale; resize.js changes it per widget.
let scale = config.scale;
let designSize = null; // the full-size [width, height] the widget last asked for

/** Sizes the window for a widget designed at width x height; `scale` shrinks it like the page zoom. */
export async function resizeWindow(width, height) {
  designSize = [width, height];
  if (!inTauri) return;
  const size = new tauri.dpi.LogicalSize(Math.round(width * scale), Math.round(height * scale));
  await tauri.window.getCurrentWindow().setSize(size);
}

/** New scale: the page zooms now, and the window follows (same design size, new scale). */
export function setScale(value) {
  scale = value;
  document.documentElement.style.zoom = value;
  return designSize ? resizeWindow(...designSize) : Promise.resolve();
}

/** The window's current size in screen pixels (logical, like screenX), worked out from the design size. */
export function windowSize() {
  const [w, h] = designSize ?? [innerWidth / scale, innerHeight / scale];
  return [w * scale, h * scale];
}

/**
 * Keeps widgets from covering each other after this one grows: any widget it now overlaps
 * moves just below it, or to its right when there's no room below. A widget that gets moved
 * can push the next one along the same way.
 * Positions here are physical pixels (real screen dots), which is what Windows works in.
 */
export async function makeRoom() {
  if (!inTauri) return;
  const GAP = 12;
  const me = tauri.window.getCurrentWindow();
  const monitor = await tauri.window.currentMonitor();
  const bottom = monitor ? monitor.position.y + monitor.size.height : Infinity;

  const rectOf = async (w) => {
    const [p, s] = await Promise.all([w.outerPosition(), w.outerSize()]);
    return { x: p.x, y: p.y, w: s.width, h: s.height };
  };
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  const others = [];
  for (const w of await tauri.window.getAllWindows()) {
    if (w.label !== me.label && (await w.isVisible())) others.push({ win: w, rect: await rectOf(w) });
  }

  const queue = [await rectOf(me)]; // rectangles that may be sitting on top of something
  for (let rounds = 0; queue.length && rounds < 20; rounds++) {
    const pusher = queue.shift();
    for (const o of others) {
      if (o.rect === pusher || !overlaps(pusher, o.rect)) continue;
      let x = o.rect.x, y = pusher.y + pusher.h + GAP; // just below
      if (y + o.rect.h > bottom) [x, y] = [pusher.x + pusher.w + GAP, o.rect.y]; // off the screen: to the right instead
      o.rect = { ...o.rect, x, y };
      await o.win.setPosition(new tauri.dpi.PhysicalPosition(x, y));
      queue.push(o.rect); // it moved, so it may now be on top of another one
    }
  }
}

/** Tell every widget window something (they hear it with onEvent). */
export function emitEvent(name, payload) {
  if (inTauri) tauri.event.emit(name, payload);
}

/** Listen for an event sent from Rust or another widget. */
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
