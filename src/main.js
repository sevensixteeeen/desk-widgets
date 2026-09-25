import { config } from "./config.js";
import { inTauri, invoke, widgetName, startDrag, resizeWindow, onEvent } from "./api.js";
import { startTheme } from "./theme.js";
import { mountClock } from "./widgets/clock.js";
import { mountNowPlaying } from "./widgets/nowplaying.js";
import { mountWeather } from "./widgets/weather.js";
import { mountCalendar } from "./widgets/calendar.js";

const widgets = {
  clock: { mount: mountClock, size: [380, 190] },
  nowplaying: { mount: mountNowPlaying, size: [380, 150] },
  weather: { mount: mountWeather, size: [380, 220] },
  calendar: { mount: mountCalendar, size: [320, 470] },
};
const widget = widgets[widgetName];

// ---- Size ----
// Widgets are designed at full size; `zoom` shrinks everything inside evenly,
// and the window is shrunk by the same factor so the card still fills it.
document.documentElement.style.zoom = config.scale;
const [w, h] = widget.size;
resizeWindow(Math.round(w * config.scale), Math.round(h * config.scale));

// ---- Theme from wallpaper ----
startTheme();

// ---- Mount ----
const root = document.getElementById("widget");
root.dataset.widget = widgetName;
widget.mount(root);

// ---- Drag + lock ----
let locked = false;
function setLocked(value) {
  locked = value;
  document.body.classList.toggle("is-locked", value); // CSS swaps the cursor
}
if (inTauri) {
  invoke("get_settings").then((s) => setLocked(s.locked));
  onEvent("lock-changed", setLocked); // sent by the tray's "Lock widgets" item
}

root.addEventListener("mousedown", (e) => {
  if (locked || e.button !== 0 || e.target.closest("button, input, a")) return;
  startDrag();
});
