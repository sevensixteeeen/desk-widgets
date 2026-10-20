// The settings window (tray → Settings). Your choices are saved under "config" in widgets.json,
// on top of the defaults in config.js, and the widgets a change affects reload to use it (main.js).

import { defaults, withDefaults } from "./config.js";
import { inTauri } from "./api.js";
import { loadStore, getSaved, setSaved } from "./store.js";
import { startTheme } from "./theme.js";
import { dials } from "./widgets/dials.js";

const SAVE_DELAY = 300; // ms after the last change, so clicking through the faces reloads the clock once

// Each row is a config.js key, its label, and its choices as [value, text]. Faces and size draw their own controls.
const sections = [
  ["Clock", [
    { key: "clockStyle", label: "Clock face", faces: true },
    { key: "clockSeconds", label: "Second hand", choices: [[true, "On"], [false, "Off"]] },
    { key: "hour12", label: "Time", choices: [[false, "24-hour"], [true, "12-hour"]] },
  ]],
  ["Calendar", [
    { key: "weekStartsOn", label: "Week starts on", choices: [[1, "Monday"], [0, "Sunday"]] },
  ]],
  ["Weather", [
    { key: "temperatureUnit", label: "Temperature", choices: [["celsius", "°C"], ["fahrenheit", "°F"]] },
  ]],
  ["Now playing", [
    { key: "nowPlayingStyle", label: "Style", choices: [["turntable", "Turntable"], ["card", "Card"]] },
  ]],
  ["Size", [
    { key: "scale", label: "All widgets", size: true },
  ]],
];

await loadStore();
startTheme();
const version = inTauri ? await window.__TAURI__.app.getVersion().catch(() => "") : "";

const root = document.getElementById("settings");
let chosen = differences(withDefaults(getSaved("config"))); // only what differs from the defaults
let timer = 0; // a save waiting for SAVE_DELAY
let previews = []; // update functions of the face previews
let previewMinute = -1;

// Only what differs from the defaults is saved, so a default changed in a later version still reaches you.
function differences(values) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== defaults[key]));
}

function choose(key, value) {
  chosen = differences({ ...withDefaults(chosen), [key]: value });
  clearTimeout(timer);
  timer = setTimeout(save, SAVE_DELAY);
}

function save() {
  clearTimeout(timer);
  timer = 0;
  setSaved("config", Object.keys(chosen).length ? chosen : null); // null removes it: all defaults
}

// ---------- Drawing ----------

// Radio inputs carry their value as JSON, so true, 1 and "card" come back as the same type.
const radio = (key, value, checked) => `<input type="radio" name="${key}" value='${JSON.stringify(value)}' ${checked ? "checked" : ""}>`;

function rowHtml(row, value) {
  if (row.faces) {
    return `
      <div class="set-faces clock" role="radiogroup" aria-label="${row.label}">
        ${Object.entries(dials).map(([name, dial]) => `
          <label class="set-face">${radio(row.key, name, name === value)}${dial.html}<span>${dial.label}</span></label>`).join("")}
      </div>`;
  }
  if (row.size) {
    const percent = Math.round((value / defaults.scale) * 100);
    return `
      <div class="set-row">
        <label class="set-label" for="${row.key}">${row.label}</label>
        <div class="set-size">
          <input id="${row.key}" type="range" min="70" max="130" step="5" value="${percent}">
          <output for="${row.key}">${percent}%</output>
        </div>
      </div>
      <p class="note">Each widget's corner grip still resizes just that widget.</p>`;
  }
  return `
    <div class="set-row">
      <span class="set-label" id="label-${row.key}">${row.label}</span>
      <div class="set-pills" role="radiogroup" aria-labelledby="label-${row.key}">
        ${row.choices.map(([v, text]) => `<label class="set-pill">${radio(row.key, v, v === value)}<span>${text}</span></label>`).join("")}
      </div>
    </div>`;
}

function render() {
  const values = withDefaults(chosen);
  root.innerHTML = `
    <header>
      <h1>Settings</h1>
      <p class="note">Changes apply to the widgets right away.</p>
    </header>
    ${sections.map(([title, rows]) => `
      <section class="set-section">
        <h2>${title}</h2>
        ${rows.map((row) => rowHtml(row, values[row.key])).join("")}
      </section>`).join("")}
    <footer class="set-foot">
      <button type="button" class="btn-quiet set-reset">Reset to defaults</button>
      <span class="note">${version && `Desk Widgets ${version}`}</span>
    </footer>`;

  for (const input of root.querySelectorAll("input[type=radio]")) {
    input.addEventListener("change", () => choose(input.name, JSON.parse(input.value)));
  }
  const size = root.querySelector("#scale");
  size.addEventListener("input", () => (size.nextElementSibling.textContent = `${size.value}%`));
  size.addEventListener("change", () => choose("scale", Number(((defaults.scale * size.value) / 100).toFixed(3))));
  root.querySelector(".set-reset").addEventListener("click", () => {
    chosen = {};
    save();
    render();
  });

  // The face previews are the real dials, showing the time here. They move once a minute (no second hands).
  previews = [...root.querySelectorAll(".set-face")].map((el) => dials[JSON.parse(el.firstElementChild.value)].bind(el.querySelector(".dial")));
  previewMinute = -1;
  tickPreviews();
}

function tickPreviews() {
  const now = new Date();
  if (now.getMinutes() === previewMinute) return;
  previewMinute = now.getMinutes();
  const t = { hour: now.getHours(), minute: now.getMinutes(), second: 0 };
  for (const update of previews) update(t, {});
}

render();
setInterval(tickPreviews, 1000);
addEventListener("pagehide", () => timer && save()); // closed right after a change: save it now
