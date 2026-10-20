import { config } from "../config.js";
import { getSaved, setSaved } from "../store.js";

// Open-Meteo: free, no API key. Docs: https://open-meteo.com/en/docs
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const REFRESH_MS = 15 * 60 * 1000;
const CITY_KEY = "weather.city"; // saved as {name, latitude, longitude, region}; cities saved before 0.5.4 have no region
const CHOICES = 4; // places listed when a name matches several and none stands out

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
  current ? showWeather(current) : askCity();

  function askCity(message = "", text = "") {
    clearInterval(timer);
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
    root.innerHTML = `<div class="wx"><p class="note"></p></div>`;
    root.querySelector(".note").textContent = `Loading weather for ${city.name}…`; // names from the search go in as text
    const load = () => fetchWeather(city).then((d) => render(city, d)).catch(() => {
      root.innerHTML = `<div class="wx"><p class="note">Can't reach the weather service. Trying again in 15 minutes.</p></div>`;
    });
    load();
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }

  function render(city, d) {
    const round = (n) => Math.round(n);
    const now = d.current.time; // local time, e.g. "2026-09-25T14:15"
    const start = d.hourly.time.findIndex((t) => t > now);
    const hours = d.hourly.time.slice(start, start + 6).map((t, i) => ({
      hour: t.slice(11, 13),
      temp: d.hourly.temperature_2m[start + i],
    }));

    // Bar heights: scale the 6-hour range to 6–34px so small changes are visible.
    const temps = hours.map((h) => h.temp);
    const lo = Math.min(...temps), hi = Math.max(...temps);
    const barHeight = (t) => 6 + (hi === lo ? 14 : ((t - lo) / (hi - lo)) * 28);

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
        <div class="wx-hours">
          ${hours.map((h) => `
            <div class="wx-hour">
              <b>${round(h.temp)}°</b>
              <i style="height:${barHeight(h.temp)}px"></i>
              <small>${h.hour}</small>
            </div>`).join("")}
        </div>
      </div>`;
    const cityButton = root.querySelector(".wx-city");
    cityButton.textContent = city.name;
    cityButton.title = city.region ? `${city.name}, ${city.region}. Click to change.` : "Change city";
    cityButton.addEventListener("click", () => askCity());
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
    daily: "temperature_2m_max,temperature_2m_min",
    temperature_unit: config.temperatureUnit,
    timezone: "auto", // times come back in the city's local time
    forecast_days: 2, // tomorrow too, so "next 6 hours" works late at night
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
  return res.json();
}
