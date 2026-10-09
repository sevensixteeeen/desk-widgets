import { config } from "../config.js";
import { moonIcon, moonPhase, skyIcons } from "./sky.js";

/**
 * Clock faces. Pick one with config.clockStyle.
 *
 * Each style has:
 *   html        the SVG, drawn around (0, 0) in a 100 x 100 box, so rotate(deg) turns about the centre
 *   bind(svg)   finds its moving parts once and returns update(t, extra), called every tick
 *               with t = {hour, minute, second} (hour 0-23); extra = {sky} for faces that show weather
 *
 * Angles: 0° = 12 o'clock, clockwise, because that's how SVG's rotate() turns.
 */

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (t) => {
  const h = config.hour12 ? t.hour % 12 || 12 : t.hour;
  return `${config.hour12 ? h : pad(h)}:${pad(t.minute)}`;
};
const polar = (deg, r) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [(r * Math.cos(a)).toFixed(2), (r * Math.sin(a)).toFixed(2)];
};
const times = (n, fn) => [...Array(n)].map((_, i) => fn(i)).join("");

// Hour, minute and second hands, shared by the two faces that have them.
const hands = `
  <line class="dial-hour" y1="5" y2="-23"/>
  <line class="dial-minute" y1="6" y2="-35"/>
  ${config.clockSeconds ? '<line class="dial-second" y1="10" y2="-39"/>' : ""}
  <circle class="dial-cap" r="2.6"/>`;

function bindHands(svg) {
  const [hour, minute, second] = [".dial-hour", ".dial-minute", ".dial-second"].map((s) => svg.querySelector(s));
  return (t) => {
    const m = t.minute + t.second / 60;
    hour.setAttribute("transform", `rotate(${((t.hour % 12) + m / 60) * 30})`);
    minute.setAttribute("transform", `rotate(${m * 6})`);
    second?.setAttribute("transform", `rotate(${t.second * 6})`);
  };
}

const svg = (name, inner) =>
  `<svg class="dial dial-${name}" viewBox="-50 -50 100 100" aria-hidden="true"><circle class="dial-face" r="48"/>${inner}</svg>`;

export const dials = {
  // 1. Ticks and hands.
  classic: {
    label: "Classic",
    html: svg("classic", `
      ${times(12, (i) => `<line class="dial-tick${i % 3 ? "" : " is-major"}" y1="${i % 3 ? -41 : -38}" y2="-44" transform="rotate(${i * 30})"/>`)}
      ${hands}`),
    bind: bindHands,
  },

  // 2. Thin numbers all the way round.
  numerals: {
    label: "Numerals",
    html: svg("numerals", `
      ${times(12, (i) => {
        const [x, y] = polar(i * 30, 37);
        return `<text class="dial-num${i % 3 ? "" : " is-major"}" x="${x}" y="${y}">${i || 12}</text>`;
      })}
      ${hands}`),
    bind: bindHands,
  },

  // 3. No hands: the outer ring fills with the minutes, the inner one with the hours.
  rings: {
    label: "Rings",
    html: svg("rings", `
      <circle class="ring-track ring-outer" r="42"/>
      <circle class="ring-fill ring-outer ring-minute" r="42" pathLength="60" transform="rotate(-90)"/>
      <circle class="ring-track ring-inner" r="33"/>
      <circle class="ring-fill ring-inner ring-hour" r="33" pathLength="12" transform="rotate(-90)"/>
      ${config.clockSeconds ? '<circle class="ring-second" r="2" cy="-42"/>' : ""}
      <text class="dial-digits" y="1">00:00</text>`),
    bind(el) {
      const [minute, hour, second, digits] = [".ring-minute", ".ring-hour", ".ring-second", ".dial-digits"].map((s) => el.querySelector(s));
      return (t) => {
        const m = t.minute + t.second / 60;
        minute.setAttribute("stroke-dasharray", `${m.toFixed(2)} 60`);
        hour.setAttribute("stroke-dasharray", `${((t.hour % 12) + m / 60).toFixed(3)} 12`);
        second?.setAttribute("transform", `rotate(${t.second * 6})`);
        digits.textContent = hhmm(t);
      };
    },
  },

  // 4. 24 hours on one turn: noon at the top, midnight at the bottom, the night half shaded.
  //    The hand ends in the weather there by day (sun, cloud, rain...) and tonight's moon by night.
  sun: {
    label: "24-hour sun",
    wantsWeather: true, // tells clock.js to fetch the weather for each clock
    html: svg("sun", `
      <path class="sun-night" d="M -48 0 A 48 48 0 0 0 48 0 Z"/>
      ${times(24, (i) => `<line class="dial-tick${i % 6 ? "" : " is-major"}" y1="${i % 6 ? -42 : -39}" y2="-45" transform="rotate(${i * 15})"/>`)}
      ${[[12, 0], [18, 90], [0, 180], [6, 270]].map(([h, deg]) => {
        const [x, y] = polar(deg, 23);
        return `<text class="sun-label" x="${x}" y="${y}">${h}</text>`;
      }).join("")}
      <text class="dial-digits sun-digits" y="11">00:00</text>
      <g class="sun-hand">
        <line y1="0" y2="-27"/>
        <g transform="translate(0 -36) scale(1.15)"><circle class="sky-back" r="8"/><g class="sun-tip"></g></g>
      </g>
      <circle class="dial-cap" r="2.6"/>`),
    bind(el) {
      const [hand, tip, digits] = [".sun-hand", ".sun-tip", ".sun-digits"].map((s) => el.querySelector(s));
      let shown = ""; // which icon is drawn, so it's only redrawn when it changes
      return (t, { sky = "clear", moon = moonPhase() } = {}) => {
        const h = t.hour + t.minute / 60 + t.second / 3600;
        const angle = (h / 24) * 360 + 180; // +180: midnight is at the bottom
        hand.setAttribute("transform", `rotate(${angle})`);
        tip.setAttribute("transform", `rotate(${-angle})`); // turn the icon back upright
        digits.textContent = hhmm(t);

        const night = t.hour < 6 || t.hour >= 18; // same rule as the shaded half and the dark dial
        // The hand is in the top half by day and the bottom half at night: keep the time on the other side.
        digits.setAttribute("y", night ? -11 : 11);
        // The moon's shape changes slowly, so round it to 1/100 of a cycle (about 7 hours).
        const want = night ? `moon:${moon.toFixed(2)}` : `sky:${sky}`;
        if (want !== shown) {
          shown = want;
          tip.innerHTML = night ? moonIcon(Number(moon.toFixed(2))) : skyIcons[sky] || skyIcons.clear;
        }
      };
    },
  },

  // 5. The numbers turn instead of the hands: the hour under the notch is the time.
  bezel: {
    label: "Turning bezel",
    html: svg("bezel", `
      <g class="bezel">
        ${times(48, (i) => (i % 4 ? `<line class="dial-tick" y1="-43" y2="-45" transform="rotate(${i * 7.5})"/>` : ""))}
        ${times(12, (i) => {
          const [x, y] = polar(i * 30, 38);
          return `<text class="dial-num is-major" x="${x}" y="${y}" transform="rotate(${i * 30} ${x} ${y})">${i || 12}</text>`;
        })}
      </g>
      <path class="bezel-notch" d="M -5 -50 L 5 -50 L 0 -43 Z"/>
      <text class="dial-digits bezel-minutes" y="1">:00</text>`),
    bind(el) {
      const [bezel, minutes] = [".bezel", ".bezel-minutes"].map((s) => el.querySelector(s));
      return (t) => {
        const h = (t.hour % 12) + t.minute / 60;
        bezel.setAttribute("transform", `rotate(${-h * 30})`);
        minutes.textContent = `:${pad(t.minute)}`;
      };
    },
  },

  // 6. Digital time in the middle, a dot running round the edge with the seconds.
  digital: {
    label: "Digital ring",
    html: svg("digital", `
      ${times(60, (i) => {
        const [x, y] = polar(i * 6, 43);
        return `<circle class="digital-dot${i % 5 ? "" : " is-major"}" cx="${x}" cy="${y}" r="${i % 5 ? 0.8 : 1.4}"/>`;
      })}
      <circle class="digital-runner" r="3" cy="-43"/>
      <text class="dial-digits digital-time" y="1">00:00</text>`),
    bind(el) {
      const [runner, time] = [".digital-runner", ".digital-time"].map((s) => el.querySelector(s));
      return (t) => {
        // No seconds setting: the dot marks the minutes instead.
        runner.setAttribute("transform", `rotate(${(config.clockSeconds ? t.second : t.minute) * 6})`);
        time.textContent = hhmm(t);
      };
    },
  },
};

/** The style from config.js (or ?dial= in a browser preview), falling back to classic. */
export function chosenDial() {
  const preview = new URLSearchParams(location.search).get("dial");
  return dials[preview] || dials[config.clockStyle] || dials.classic;
}
