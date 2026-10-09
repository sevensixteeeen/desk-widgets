// What sits on the tip of the 24-hour sun dial's hand: the weather by day, the moon by night.

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// ---------- Weather ----------

/** Open-Meteo's weather code (a WMO number) -> one of our icon names. */
export function skyFromCode(code) {
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "rain"; // drizzle 51-57, rain 61-67, showers 80-82
}

/**
 * Current weather for several places in ONE request (Open-Meteo takes comma-separated lists).
 * places: [{latitude, longitude}] -> resolves to the same-length list of icon names.
 */
export async function fetchSkies(places) {
  const params = new URLSearchParams({
    latitude: places.map((p) => p.latitude.toFixed(3)).join(","),
    longitude: places.map((p) => p.longitude.toFixed(3)).join(","),
    current: "weather_code",
  });
  const res = await fetch(`${FORECAST_URL}?${params}`).then((r) => r.json());
  const list = Array.isArray(res) ? res : [res]; // one place -> plain object, several -> array
  return list.map((r) => skyFromCode(r.current?.weather_code ?? 0));
}

// ---------- Moon ----------

const SYNODIC_MONTH = 29.530588853; // days from one new moon to the next
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a new moon we know the time of

/** How far through its cycle the moon is: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
export function moonPhase(date = new Date()) {
  const days = (date - KNOWN_NEW_MOON) / 86400000;
  return (((days / SYNODIC_MONTH) % 1) + 1) % 1; // the "+ 1) % 1" keeps it positive
}

/**
 * The lit part of the moon as an SVG path, radius r, centred on (0, 0).
 * One edge is always half the circle (the side facing the sun); the other edge, the line
 * between light and dark, is half an ellipse whose width goes r -> 0 -> r over each half-cycle.
 * Drawn as seen from the northern hemisphere: it grows from the right.
 */
export function moonPath(phase, r) {
  const waxing = phase < 0.5;
  const rx = Math.abs(Math.cos(phase * 2 * Math.PI)) * r; // terminator width
  const fat = phase > 0.25 && phase < 0.75; // gibbous: more than half lit
  const limb = waxing ? 1 : 0; // lit edge down the right (waxing) or the left (waning)
  const term = waxing === fat ? 1 : 0; // which way the terminator bulges
  return `M 0 ${-r} A ${r} ${r} 0 0 ${limb} 0 ${r} A ${rx.toFixed(2)} ${r} 0 0 ${term} 0 ${-r} Z`;
}

// ---------- Icons ----------
// About 14 x 14 units, centred on (0, 0). Colours come from classes in styles.css.

const cloud = (dx = 0, dy = 0) => `
  <g class="sky-cloud" transform="translate(${dx} ${dy})">
    <circle cx="-3.4" cy="1" r="2.6"/><circle cx="0.2" cy="-1.2" r="3.5"/><circle cx="3.6" cy="0.8" r="2.8"/>
    <rect x="-3.4" y="0.6" width="7" height="3" />
  </g>`;
const sun = (r = 3.4) => `
  <g class="sky-sun">
    <circle r="${r}"/>
    ${[...Array(8)].map((_, i) => `<line y1="${-(r + 1.4)}" y2="${-(r + 3)}" transform="rotate(${i * 45})"/>`).join("")}
  </g>`;

export const skyIcons = {
  clear: sun(),
  partly: `<g transform="translate(-2.2 -2.2) scale(0.8)">${sun()}</g>${cloud(1.6, 1.8)}`,
  cloudy: cloud(),
  rain: `${cloud(0, -2)}<g class="sky-rain">${[-3, 0, 3].map((x) => `<line x1="${x}" y1="3.5" x2="${x - 1}" y2="6.5"/>`).join("")}</g>`,
  snow: `${cloud(0, -2)}<g class="sky-snow">${[-3, 0, 3].map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 6.5 : 4.8}" r="0.9"/>`).join("")}</g>`,
  storm: `${cloud(0, -2)}<path class="sky-bolt" d="M 0.6 2.2 L -1.8 5.6 L 0 5.6 L -0.8 8.4 L 2 4.6 L 0.2 4.6 Z"/>`,
  fog: `<g class="sky-fog">${[-3, 0, 3].map((y, i) => `<line x1="${-5 + i}" x2="${5 - (i % 2) * 2}" y1="${y}" y2="${y}"/>`).join("")}</g>`,
};

/** The moon at `phase`: a hollow outline with the lit part filled in. */
export function moonIcon(phase) {
  const r = 5;
  return `<circle class="sky-moon-outline" r="${r}"/><path class="sky-moon-lit" d="${moonPath(phase, r)}"/>`;
}
