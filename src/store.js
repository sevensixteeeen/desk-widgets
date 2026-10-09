// What you set up in the widgets: sizes, added clocks, weather city, last calendar used.
// Rust keeps it in widgets.json (store.rs), written the moment it changes, so it survives
// shutting the laptop down. localStorage lost it then, and dev mode had its own copy.
//
// loadStore() runs once before the widget mounts; after that, getSaved() answers straight away.
// Outside Tauri (browser preview) it's plain localStorage.

import { inTauri, invoke, onEvent } from "./api.js";

// Keys older versions kept in localStorage; loadStore() copies them into the file once.
const MOVED = /^(size\.\w+|clock\.zones|weather\.city|calendar\.lastCalendar)$/;

let saved = {};

// localStorage only holds text: JSON for most values, a plain calendar id for calendar.lastCalendar.
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fromLocalStorage() {
  const found = {};
  for (const key of Object.keys(localStorage)) {
    if (MOVED.test(key)) found[key] = parse(localStorage.getItem(key));
  }
  return found;
}

export async function loadStore() {
  if (!inTauri) {
    saved = fromLocalStorage();
    return;
  }
  try {
    saved = await invoke("store_load", { legacy: fromLocalStorage() });
  } catch (err) {
    console.error("Couldn't read saved widget settings:", err); // the widget still opens, with defaults
  }
  onEvent("store-changed", ({ key, value }) => {
    if (value === null) delete saved[key];
    else saved[key] = value;
  });
}

/** The saved value, or undefined if there isn't one. */
export function getSaved(key) {
  return saved[key];
}

/** Saves a value (anything JSON can hold); every widget window sees it. */
export function setSaved(key, value) {
  saved[key] = value;
  if (!inTauri) return localStorage.setItem(key, JSON.stringify(value));
  invoke("store_set", { key, value }).catch((err) => console.error(`Couldn't save ${key}:`, err));
}
