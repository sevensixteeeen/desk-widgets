import { config, withDefaults } from "./config.js";
import { inTauri, invoke, widgetName, startDrag, resizeWindow, onEvent } from "./api.js";
import { startTheme } from "./theme.js";
import { loadStore, getSaved } from "./store.js";
import { restoreSize, startResizing } from "./resize.js";
import { mountClock } from "./widgets/clock.js";
import { mountNowPlaying } from "./widgets/nowplaying.js";
import { mountWeather } from "./widgets/weather.js";
import { mountCalendar } from "./widgets/calendar.js";

// uses: the config.js settings each widget reads besides scale, so it reloads only when one of them changes.
const widgets = {
  clock: { mount: mountClock, uses: ["clockStyle", "clockSeconds", "hour12"] }, // no size: it grows with the clocks you add
  nowplaying: { mount: mountNowPlaying, size: config.nowPlayingStyle === "card" ? [380, 150] : [380, 230], uses: ["nowPlayingStyle"] }, // fixed size
  weather: { mount: mountWeather, size: [380, 220], uses: ["temperatureUnit"] },
  calendar: { mount: mountCalendar, size: [320, 490], uses: ["hour12", "weekStartsOn", "upcomingEvents"] },
};
const widget = widgets[widgetName];

// ---- Settings ----
// config.js merges your choices from the settings window before anything runs, so a widget takes a
// change by reloading. It starts listening before reading the saved setup below, then compares once
// more, so a change made while it was starting up isn't missed.
function reloadIfChanged(chosen) {
  const next = withDefaults(chosen);
  if (["scale", ...widget.uses].some((key) => next[key] !== config[key])) location.reload();
}
await onEvent("store-changed", ({ key, value }) => key === "config" && reloadIfChanged(value));

// ---- Saved setup ----
// Sizes, clocks and the weather city, read once before anything below asks for them.
await loadStore();
reloadIfChanged(getSaved("config"));

// ---- Size ----
// Widgets are designed at full size; `zoom` shrinks everything inside evenly,
// and resizeWindow shrinks the window by the same factor so the card still fills it.
// The factor is config.scale times this widget's own size (resize.js), restored before
// mounting so a widget that sizes itself (the clock) starts at the right size.
restoreSize();
if (widget.size) resizeWindow(...widget.size);

// ---- Theme from wallpaper ----
startTheme();

// ---- Mount ----
const root = document.getElementById("widget");
root.dataset.widget = widgetName;
widget.mount(root);

// ---- Drag + lock ----
let locked = false;
function setLocked(value, announce = false) {
  locked = value;
  document.body.classList.toggle("is-locked", value); // CSS swaps the cursor
  if (announce) showToast(value ? "Locked" : "Unlocked");
}
if (inTauri) {
  invoke("get_settings").then((s) => setLocked(s.locked)); // at startup: no toast
  onEvent("lock-changed", (value) => setLocked(value, true)); // tray item or Ctrl+Alt+L
}

// A short "Locked" / "Unlocked" label in the middle of the widget. It lives on <body>,
// outside the card, so a widget redrawing its card can't wipe it away.
function showToast(text) {
  document.querySelector(".toast")?.remove(); // pressing again quickly replaces it
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.append(toast);
  toast.addEventListener("animationend", () => toast.remove());
}

root.addEventListener("mousedown", (e) => {
  if (locked || e.button !== 0 || e.target.closest("button, input, a, [data-no-drag]")) return;
  startDrag();
});

// ---- Resize ----
// Grip in the bottom-right corner, or Ctrl + mouse wheel. Off while locked.
startResizing({ isLocked: () => locked, showToast });
