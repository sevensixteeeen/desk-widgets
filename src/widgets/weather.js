import { config } from "../config.js";

// Open-Meteo: free, no API key. Docs: https://open-meteo.com/en/docs
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const REFRESH_MS = 15 * 60 * 1000;
const CITY_KEY = "weather.city"; // saved as {name, latitude, longitude}

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
  const saved = JSON.parse(localStorage.getItem(CITY_KEY) || "null");
  saved ? showWeather(saved) : askCity();

  function askCity(message = "") {
    clearInterval(timer);
    root.innerHTML = `
      <form class="wx-form">
        <label for="city">Which city?</label>
        <input id="city" autocomplete="off" placeholder="e.g. Lisbon" />
        <p class="note">${message || "Press Enter to save."}</p>
      </form>`;
    const input = root.querySelector("input");
    input.focus();
    root.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      try {
        const res = await fetch(`${GEO_URL}?name=${encodeURIComponent(name)}&count=1`).then((r) => r.json());
        const place = res.results?.[0];
        if (!place) return askCity(`No city called "${name}". Check the spelling.`);
        const city = { name: place.name, latitude: place.latitude, longitude: place.longitude };
        localStorage.setItem(CITY_KEY, JSON.stringify(city));
        showWeather(city);
      } catch {
        askCity("Can't reach the weather service. Check your connection.");
      }
    });
  }

  function showWeather(city) {
    root.innerHTML = `<div class="wx"><p class="note">Loading weather for ${city.name}…</p></div>`;
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
            <button class="wx-city" title="Change city">${city.name}</button>
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
    root.querySelector(".wx-city").addEventListener("click", () => askCity());
  }
}

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
