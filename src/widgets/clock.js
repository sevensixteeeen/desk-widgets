import { config } from "../config.js";
import { inTauri, makeRoom, resizeWindow } from "../api.js";
import { getSaved, setSaved } from "../store.js";
import { chosenDial } from "./dials.js";
import { fetchSkies } from "./sky.js";

// Typed places become time zones through Open-Meteo's geocoder (the weather widget uses it too).
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const ZONES_KEY = "clock.zones"; // saved as [{name, timeZone, latitude, longitude}]; your own clock isn't in the list
const CITY_KEY = "weather.city"; // the weather widget's city = where your own clock is
const SKY_REFRESH = 20 * 60 * 1000; // weather every 20 minutes
const MAX_CLOCKS = 8; // yours + 7; the + button disappears at the limit
const PER_ROW = 3; // a 4th clock starts a new row

// Sizes in the card's full-size px. styles.css uses the same numbers (.clock-grid, .clock-zone).
const PAD = [24, 20];    // card padding: left/right, top/bottom
const CELL = [132, 164]; // one clock: dial, name, day line
const GAP = [18, 14];

const plusIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>';
const closeIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.1 2.7 3.9 3.9 3.9-3.9 1.4 1.4L9.4 8l3.9 3.9-1.4 1.4L8 9.4l-3.9 3.9-1.4-1.4L6.6 8 2.7 4.1z"/></svg>';

const dial = chosenDial(); // the face design, set by clockStyle in config.js (see dials.js)

export function mountClock(root) {
  let zones = loadZones();
  let cells = [];
  let lastMinute = "";
  const skies = new Map(); // "lat,lon" -> "clear" | "cloudy" | "rain" ...

  // ---------- Clocks ----------

  function render() {
    lastMinute = ""; // relabel on the next tick
    const all = [{ name: null, timeZone: undefined }, ...zones]; // yours first
    root.innerHTML = `
      <div class="clock">
        <div class="clock-grid" style="--cols:${Math.min(all.length, PER_ROW)}"></div>
      </div>
      <button class="clock-add" aria-label="Add a clock" title="Add a city or country" ${all.length >= MAX_CLOCKS ? "hidden" : ""}>${plusIcon}</button>`;

    const grid = root.querySelector(".clock-grid");
    cells = all.map((zone, i) => {
      const el = document.createElement("div");
      el.className = "clock-zone";
      el.innerHTML = `${dial.html}<p class="clock-name"></p><p class="clock-day"></p>`;
      if (zone.timeZone) {
        const remove = document.createElement("button");
        remove.className = "clock-remove";
        remove.title = "Remove";
        remove.setAttribute("aria-label", `Remove ${zone.name}`);
        remove.innerHTML = closeIcon;
        remove.addEventListener("click", () => {
          zones.splice(i - 1, 1); // i - 1: your own clock is first in `all`
          saveZones();
          render();
        });
        el.prepend(remove);
      }
      grid.append(el);
      return {
        el,
        timeZone: zone.timeZone,
        place: i === 0 ? getSaved(CITY_KEY) : zone, // where to get its weather
        label: zone.name,
        update: dial.bind(el.querySelector(".dial")), // moves this face's hands/rings/numbers
        name: el.querySelector(".clock-name"),
        day: el.querySelector(".clock-day"),
      };
    });
    root.querySelector(".clock-add").addEventListener("click", () => openForm());

    // Grow or shrink to fit the clocks, then nudge any widget we'd now cover out of the way.
    resizeWindow(...gridSize()).then(makeRoom);
    tick();
  }

  function gridSize() {
    const n = zones.length + 1;
    const cols = Math.min(n, PER_ROW), rows = Math.ceil(n / PER_ROW);
    return [PAD[0] * 2 + cols * CELL[0] + (cols - 1) * GAP[0], PAD[1] * 2 + rows * CELL[1] + (rows - 1) * GAP[1]];
  }

  function tick() {
    if (!cells.length) return; // the add form is open
    const now = new Date();
    const here = wallTime(undefined, now);
    const minute = `${here.day} ${here.hour}:${here.minute}`;
    const newMinute = minute !== lastMinute;
    if (!newMinute && !config.clockSeconds) return; // nothing on screen changes until the next minute
    lastMinute = minute;

    for (const c of cells) {
      const t = c.timeZone ? wallTime(c.timeZone, now) : here;
      c.update(t, { sky: skies.get(placeKey(c.place)) ?? previewSky(cells.indexOf(c)) });
      if (!newMinute) continue;

      c.el.classList.toggle("is-night", t.hour < 6 || t.hour >= 18); // dark dial from 6 pm to 6 am
      if (!c.timeZone) {
        c.name.textContent = now.toLocaleDateString(undefined, { weekday: "long" });
        c.day.textContent = now.toLocaleDateString(undefined, { day: "numeric", month: "long" });
      } else {
        const { minutes, days } = difference(t, here);
        c.name.textContent = c.label;
        // Two days apart is possible across the date line (Kiribati vs Samoa): fall back to the weekday.
        const when = ["Yesterday", "Today", "Tomorrow"][days + 1] ?? now.toLocaleDateString(undefined, { weekday: "long", timeZone: c.timeZone });
        c.day.textContent = `${when}, ${offsetText(minutes)}`;
        c.el.title = `${c.label} (${c.timeZone})`;
      }
    }
  }

  // ---------- Adding a clock ----------

  function openForm(message = "", text = "") {
    cells = [];
    root.innerHTML = `
      <form class="clock-form">
        <label for="zone">Add a city or country</label>
        <input id="zone" autocomplete="off" placeholder="e.g. Tokyo, Japan" />
        <div class="clock-form-row">
          <p class="note"></p>
          <button type="button" class="btn-quiet">Cancel</button>
        </div>
      </form>`;
    // The form fits inside the clock's current size, so opening it never covers another widget.

    const input = root.querySelector("input");
    const note = root.querySelector(".note");
    note.textContent = message || "Press Enter to add.";
    input.value = text; // what you typed, kept after an error
    input.focus();
    input.addEventListener("keydown", (e) => e.key === "Escape" && render());
    root.querySelector(".btn-quiet").addEventListener("click", render);

    root.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || input.readOnly) return; // readOnly: already looking it up
      input.readOnly = true;
      note.textContent = "Looking it up…";
      let found;
      try {
        found = await findZone(text);
      } catch {
        return openForm("Can't reach the place search. Check your connection.", text);
      }
      if (found.error) return openForm(found.error, text);
      if (!zones.some((z) => z.timeZone === found.timeZone && z.name === found.name)) {
        zones.push(found);
        saveZones();
      }
      render();
    });
  }

  function saveZones() {
    setSaved(ZONES_KEY, zones);
  }

  // ---------- Weather (only for faces that show it) ----------

  async function refreshSkies() {
    if (!dial.wantsWeather || !inTauri) return;
    // Clocks saved before weather existed have no coordinates: look them up once by name.
    let changed = false;
    for (const z of zones) {
      if (z.latitude != null) continue;
      const found = await findZone(z.name).catch(() => null);
      if (found?.latitude != null && found.timeZone === z.timeZone) {
        Object.assign(z, { latitude: found.latitude, longitude: found.longitude });
        changed = true;
      }
    }
    if (changed) saveZones();

    const here = getSaved(CITY_KEY);
    const places = [here, ...zones].filter((p) => p?.latitude != null);
    if (!places.length) return;
    try {
      const list = await fetchSkies(places);
      places.forEach((p, i) => skies.set(placeKey(p), list[i]));
      lastMinute = ""; // redraw on the next tick
    } catch {
      // Offline: keep the last weather (or the plain sun) and try again next time.
    }
  }

  render();
  refreshSkies();
  setInterval(refreshSkies, SKY_REFRESH);
  // Checking every second (not every minute) also keeps it correct after sleep/resume.
  setInterval(tick, 1000);
}

// ---------- Time zones ----------

const placeKey = (p) => (p?.latitude != null ? `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}` : "");

/** Browser preview only: index.html?w=clock&sky=rain,cloudy picks each clock's weather. */
function previewSky(index) {
  if (inTauri) return undefined;
  return new URLSearchParams(location.search).get("sky")?.split(",")[index];
}

function loadZones() {
  // Browser preview: index.html?w=clock&zones=Asia/Tokyo,Europe/London
  const preview = !inTauri && new URLSearchParams(location.search).get("zones");
  const list = preview
    ? preview.split(",").map((tz) => ({ name: cityOf(tz), timeZone: tz }))
    : getSaved(ZONES_KEY) ?? [];
  return list.filter((z) => checkZone(z.timeZone)); // drop anything this PC doesn't know
}

/** The zone's official name ("utc" -> "UTC"), or null if it isn't a time zone. */
function checkZone(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// "America/New_York" -> "New York"
const cityOf = (timeZone) => timeZone.split("/").pop().replaceAll("_", " ");

/** Turns what you typed into {name, timeZone}, or {error} with a message to show. */
async function findZone(text) {
  // A time zone ID typed directly ("UTC", "Asia/Tokyo"). Checked first, or the geocoder reads "UTC" as Utrecht.
  // Only these shapes: plain names like "Japan" or "Singapore" are old zone aliases too, and should stay places.
  const typed = (text.includes("/") || /^(utc|gmt)$/i.test(text)) && checkZone(text);
  if (typed) {
    const name = text.includes("/") ? cityOf(text).replace(/\b\w/g, (c) => c.toUpperCase()) : typed; // "asia/new_york" -> "New York"
    return { name, timeZone: typed };
  }

  const res = await fetch(`${GEO_URL}?name=${encodeURIComponent(text)}&count=1`).then((r) => r.json());
  const place = res.results?.[0];
  if (!place) return { error: `No place called "${text}". Check the spelling.` };
  // Countries spanning several zones (United States, Russia, Australia) come back without one.
  const timeZone = place.timezone && checkZone(place.timezone);
  if (!timeZone) return { error: `${place.name} has several time zones. Type a city there instead.` };
  return { name: place.name, timeZone, latitude: place.latitude, longitude: place.longitude };
}

// One formatter per zone, made once. Intl does the DST rules, so no offsets are worked out by hand.
const formatters = new Map();

/** The wall-clock time in a zone (undefined = this PC's), as numbers: {year, month, day, hour, minute, second}. */
function wallTime(timeZone, date) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", // h23: midnight is 0, never 24
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }));
  }
  const t = {};
  for (const p of formatters.get(timeZone).formatToParts(date)) if (p.type !== "literal") t[p.type] = Number(p.value);
  return t;
}

/** How far a zone's clock is from yours: minutes ahead (negative = behind), and days (-1, 0 or 1). */
function difference(t, here) {
  const at = (x, withTime) => Date.UTC(x.year, x.month - 1, x.day, withTime ? x.hour : 0, withTime ? x.minute : 0);
  return {
    minutes: Math.round((at(t, true) - at(here, true)) / 60000),
    days: Math.round((at(t, false) - at(here, false)) / 86400000),
  };
}

// 330 -> "+5h 30m", -240 -> "−4h", 0 -> "same time"
function offsetText(minutes) {
  if (minutes === 0) return "same time";
  const h = Math.floor(Math.abs(minutes) / 60), m = Math.abs(minutes) % 60;
  return (minutes > 0 ? "+" : "−") + [h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ");
}
