import { config } from "../config.js";
import { getSaved, setSaved } from "../store.js";

// Open-Meteo: free, no API key. Docs: https://open-meteo.com/en/docs
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const REFRESH_MS = 15 * 60 * 1000;
const CITY_KEY = "weather.city"; // saved as {name, latitude, longitude, region}; cities saved before 0.5.4 have no region
const CHOICES = 4; // places listed when a name matches several and none stands out

// A bigger card shows more (see fit below). Sizes in the card's full-size px, like styles.css.
const MIN_HOURS = 6, MAX_HOURS = 24; // hourly forecast: 6 at the normal width, one more per spare column
const HOUR_WIDTH = 50, HOUR_GAP = 6; // narrowest an hour's column gets before another one is added
const MAX_DAYS = 6;                  // daily forecast, after today: as many as fit the height

// WMO weather codes -> words
const CONDITIONS = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail",
};

export function mountWeather(root) {
  let timer = null;
  let current = getSaved(CITY_KEY);
  let shown = null; // {city, d} while the forecast is on screen, so a resize can redraw it
  current ? showWeather(current) : askCity();

  // Resized (resize.js): lay the forecast out again for the new size.
  let frame = 0;
  new ResizeObserver(() => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (shown) render(shown.city, shown.d);
    });
  }).observe(root);

  function askCity(message = "", text = "") {
    clearInterval(timer);
    shown = null;
    root.innerHTML = `
      <form class="wx-form">
        <label for="city">Which city?</label>
        <input id="city" autocomplete="off" placeholder="e.g. Lisbon" />
        <p class="note"></p>
      </form>`;
    const input = root.querySelector("input");
    root.querySelector(".note").textContent = message || (current ? "Press Enter to save, Esc to cancel." : "Press Enter to save.");
    input.value = text; // what you typed, kept after an error or Back
    input.focus();
    input.addEventListener("keydown", (e) => e.key === "Escape" && current && showWeather(current));
    root.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      let places;
      try {
        // Several matches, so a far bigger first one can be told apart from a tie.
        const res = await fetch(`${GEO_URL}?name=${encodeURIComponent(name)}&count=10`).then((r) => r.json());
        places = res.results ?? [];
      } catch {
        return askCity("Can't reach the weather service. Check your connection.", name);
      }
      if (!places.length) return askCity(`No city called "${name}". Check the spelling.`, name);
      obvious(places) ? choose(places[0]) : pickPlace(name, places.slice(0, CHOICES));
    });
  }

  // Several places share the name (the search knows ten villages called Gurgaon, and Gurugram only by
  // that name): list them with district, state and country, so the one you meant is clear, or clearly missing.
  // Each choice is a <button>: main.js starts a window drag on mousedown anywhere else.
  function pickPlace(name, places) {
    shown = null;
    root.innerHTML = `
      <div class="wx-form wx-pick">
        <p class="wx-pick-title"></p>
        <div class="wx-choices"></div>
        <p class="note">Not listed? Try its official name. <button type="button" class="btn-quiet">Back</button></p>
      </div>`;
    root.querySelector(".wx-pick-title").textContent = `Which ${name}?`;
    const list = root.querySelector(".wx-choices");
    for (const place of places) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "wx-choice";
      choice.innerHTML = "<b></b><span></span>";
      choice.querySelector("b").textContent = place.name;
      choice.querySelector("span").textContent = regionOf(place, true);
      choice.addEventListener("click", () => choose(place));
      list.append(choice);
    }
    root.querySelector(".btn-quiet").addEventListener("click", () => askCity("", name));
    root.querySelector(".wx-pick").addEventListener("keydown", (e) => e.key === "Escape" && askCity("", name));
    list.firstElementChild.focus();
  }

  function choose(place) {
    current = { name: place.name, latitude: place.latitude, longitude: place.longitude, region: regionOf(place) };
    setSaved(CITY_KEY, current);
    showWeather(current);
  }

  function showWeather(city) {
    shown = null;
    root.innerHTML = `<div class="wx"><p class="note"></p></div>`;
    root.querySelector(".note").textContent = `Loading weather for ${city.name}…`; // names from the search go in as text
    const load = () => fetchWeather(city).then((d) => render(city, d)).catch(() => {
      shown = null;
      root.innerHTML = `<div class="wx"><p class="note">Can't reach the weather service. Trying again in 15 minutes.</p></div>`;
    });
    load();
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }

  function render(city, d) {
    shown = { city, d };
    const round = (n) => Math.round(n);

    // As many hours as fit across: a wider card shows more of the day ahead.
    const pad = getComputedStyle(root);
    const width = root.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const count = Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.floor((width + HOUR_GAP) / (HOUR_WIDTH + HOUR_GAP))));
    const now = d.current.time; // local time, e.g. "2026-09-25T14:15"
    const start = d.hourly.time.findIndex((t) => t > now);
    const hours = d.hourly.time.slice(start, start + count).map((t, i) => ({
      hour: t.slice(11, 13),
      temp: d.hourly.temperature_2m[start + i],
    }));

    // Bar heights: the hours' range runs from a 6px stub to 6px + --bar-range (28px, more in a
    // taller card), so small changes are visible. --f is where each hour sits in the range.
    const temps = hours.map((h) => h.temp);
    const lo = Math.min(...temps), hi = Math.max(...temps);
    const barPart = (t) => (hi === lo ? 0.5 : (t - lo) / (hi - lo)).toFixed(3);

    // Tomorrow onwards. Dates are the city's own ("2026-09-26"), so they're read as local midnight.
    const days = d.daily.time.slice(1, 1 + MAX_DAYS).map((t, i) => ({
      name: i === 0 ? "Tomorrow" : new Date(`${t}T00:00`).toLocaleDateString(undefined, { weekday: "long" }),
      cond: CONDITIONS[d.daily.weather_code[i + 1]] ?? "—",
      high: round(d.daily.temperature_2m_max[i + 1]),
      low: round(d.daily.temperature_2m_min[i + 1]),
    }));

    const temp = `${round(d.current.temperature_2m)}°`;
    root.innerHTML = `
      <div class="wx">
        <div class="wx-top">
          <span class="print">${temp}</span>
          <div class="wx-side">
            <p class="wx-cond">${CONDITIONS[d.current.weather_code] ?? "—"}</p>
            <button class="wx-city"></button>
            <p class="wx-feels">High ${round(d.daily.temperature_2m_max[0])}°, low ${round(d.daily.temperature_2m_min[0])}°</p>
          </div>
        </div>
        <div class="wx-days">
          ${days.map((day) => `
            <div class="wx-day">
              <span class="wx-day-name">${day.name}</span>
              <span class="wx-day-cond">${day.cond}</span>
              <span class="wx-day-temp"><b>${day.high}°</b> ${day.low}°</span>
            </div>`).join("")}
        </div>
        <div class="wx-hours" style="--cols:${hours.length}">
          ${hours.map((h) => `
            <div class="wx-hour">
              <b>${round(h.temp)}°</b>
              <i style="--f:${barPart(h.temp)}"></i>
              <small>${h.hour}</small>
            </div>`).join("")}
        </div>
      </div>`;
    fit();
    const cityButton = root.querySelector(".wx-city");
    cityButton.textContent = city.name;
    cityButton.title = city.region ? `${city.name}, ${city.region}. Click to change.` : "Change city";
    cityButton.addEventListener("click", () => askCity());
  }

  // Fills a tall card: the daily forecast takes as many days as fit between the temperature and
  // the hours, then whatever height is still spare makes the hourly bars taller.
  function fit() {
    const wx = root.querySelector(".wx");
    const list = root.querySelector(".wx-days");
    const days = [...list.children];
    while (days.length && wx.scrollHeight > wx.clientHeight) days.pop().remove();
    list.hidden = !days.length;

    const used = [...wx.children].reduce((sum, el) => sum + el.offsetHeight, 0) + (days.length ? 24 : 0); // .wx-days margins
    const spare = wx.clientHeight - used - 14; // keep a little gap above the hours
    wx.style.setProperty("--bar-range", `${28 + Math.min(Math.max(spare, 0), 60)}px`);
  }
}

/** One match, or a first match far bigger than the rest (Lisbon, Portugal vs Lisbon, Maine): no need to ask. */
function obvious(places) {
  const [first, ...rest] = places;
  return !rest.length || (first.population > 0 && rest.every((p) => (p.population ?? 0) * 10 < first.population));
}

// "Haryana, India", or with the district too ("Hingoli District, Maharashtra, India") to tell same-named villages apart.
const regionOf = (place, withDistrict = false) =>
  [withDistrict && place.admin2 !== place.name && place.admin2, place.admin1, place.country].filter(Boolean).join(", ");

async function fetchWeather(city) {
  const params = new URLSearchParams({
    latitude: city.latitude,
    longitude: city.longitude,
    current: "temperature_2m,weather_code",
    hourly: "temperature_2m",
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    temperature_unit: config.temperatureUnit,
    timezone: "auto", // times come back in the city's local time
    forecast_days: 1 + MAX_DAYS, // today and the days a tall card lists; the hours run into tomorrow too
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
  return res.json();
}
