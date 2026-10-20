// Default settings. Most can be changed in the app (tray → Settings); change them here to set
// what a new install starts with, then rebuild.
export const defaults = {
  scale: 0.78,            // widget size: 1 = original, 0.78 = about a quarter smaller
  hour12: false,          // calendar event times and digital clocks: true -> 3:07 pm, false -> 15:07
  clockSeconds: true,     // second hand on the clocks
  clockStyle: "sun",      // classic, numerals, rings, sun, bezel or digital (see widgets/dials.js)
  weekStartsOn: 1,        // 0 = Sunday, 1 = Monday
  temperatureUnit: "celsius", // or "fahrenheit"
  upcomingEvents: 3,      // how many events the calendar lists (not in Settings: more don't fit the card)
  nowPlayingStyle: "turntable", // or "card" for the original compact design
};

/** Settings-window choices on top of the defaults. Unknown keys and values of the wrong type are ignored. */
export function withDefaults(chosen) {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(chosen ?? {})) {
    if (typeof value === typeof defaults[key]) merged[key] = value;
  }
  return merged;
}

// What the settings window saved ("config" in widgets.json), read before any other module runs,
// because several of them use these values the moment they load. Straight from Tauri rather than
// through api.js, which imports this file; globalThis rather than window, so tests can run it in Node.
const tauri = globalThis.__TAURI__;
const saved = tauri ? await tauri.core.invoke("store_load", { legacy: {} }).catch(() => ({})) : {};
export const config = withDefaults(saved.config);
