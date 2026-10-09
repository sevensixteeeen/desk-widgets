import { config } from "./config.js";
import { inTauri, invoke, widgetName, startDrag, resizeWindow, onEvent } from "./api.js";
import { startTheme } from "./theme.js";
import { restoreSize, startResizing } from "./resize.js";
import { mountClock } from "./widgets/clock.js";
import { mountNowPlaying } from "./widgets/nowplaying.js";
import { mountWeather } from "./widgets/weather.js";
import { mountCalendar } from "./widgets/calendar.js";

const widgets = {
  clock: { mount: mountClock }, // no size: it grows with the clocks you add
  nowplaying: { mount: mountNowPlaying, size: config.nowPlayingStyle === "card" ? [380, 150] : [380, 230] }, // fixed size
  weather: { mount: mountWeather, size: [380, 220] },
  calendar: { mount: mountCalendar, size: [320, 490] },
};
const widget = widgets[widgetName];

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
