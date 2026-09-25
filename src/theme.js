// Takes the colours of your wallpaper and turns them into the widgets' theme.
//
// 1. Shrink the wallpaper to a tiny image (thousands of pixels is plenty to judge colour).
// 2. Measure overall brightness -> dark or light cards.
// 3. Average colour -> the card's tint, so cards feel "made of" the wallpaper.
// 4. Group vivid pixels by hue -> the two strongest, distinct hues become the two "inks".

import { invoke, inTauri } from "./api.js";

const CACHE_KEY = "theme.palette";
const STAMP_KEY = "theme.stamp";
const CHECK_MS = 30 * 1000;

export function startTheme() {
  // Apply the last palette instantly so there's no flash of the default colours.
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) apply(JSON.parse(cached));

  // Browser preview: index.html?w=clock&wp=path/to/image.jpg
  const previewImage = new URLSearchParams(location.search).get("wp");
  if (!inTauri) {
    if (previewImage) paletteFromImage(previewImage).then(apply);
    return;
  }

  let stamp = localStorage.getItem(STAMP_KEY);
  async function check() {
    try {
      const wp = await invoke("wallpaper", { known: stamp }); // null = unchanged
      if (!wp) return;
      const palette = await paletteFromImage(wp.dataUrl);
      stamp = wp.stamp;
      localStorage.setItem(STAMP_KEY, stamp);
      localStorage.setItem(CACHE_KEY, JSON.stringify(palette));
      apply(palette);
    } catch {
      // No picture wallpaper (e.g. a solid colour): keep the current theme.
    }
  }
  check();
  setInterval(check, CHECK_MS);
}

function apply(p) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(p.vars)) root.style.setProperty(`--${name}`, value);
  root.dataset.theme = p.dark ? "dark" : "light";
}

// ---------- Palette extraction ----------

export async function paletteFromImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return buildPalette(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

function buildPalette(px) {
  const bins = Array.from({ length: 36 }, () => ({ w: 0, r: 0, g: 0, b: 0 })); // 10° hue buckets
  let r0 = 0, g0 = 0, b0 = 0, lum = 0, n = 0;

  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    r0 += r; g0 += g; b0 += b; n++;
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // perceived brightness

    const [h, s, l] = rgbToHsl(r, g, b);
    // Only vivid, mid-brightness pixels can be "inks"; weight by how vivid they are.
    if (s > 0.35 && l > 0.18 && l < 0.82) {
      const w = s * s * (1 - Math.abs(l - 0.5) * 1.4);
      const bin = bins[Math.floor(h / 10) % 36];
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
  }

  const dark = lum / n < 0.55;
  const [baseH, baseS] = rgbToHsl(r0 / n, g0 / n, b0 / n);

  // Smooth each bucket with its neighbours so a hue split across two buckets still wins.
  const scored = bins.map((bin, i) => ({
    ...bin,
    i,
    score: bin.w + 0.5 * (bins[(i + 35) % 36].w + bins[(i + 1) % 36].w),
  }));
  const ranked = scored.filter((b) => b.w > 0).sort((a, b) => b.score - a.score);
  const hueOf = (bin) => rgbToHsl(bin.r / bin.w, bin.g / bin.w, bin.b / bin.w)[0];

  const first = ranked[0];
  const hueA = first ? hueOf(first) : baseH;
  const second = ranked.find(
    (b) => b !== first && hueDistance(hueOf(b), hueA) >= 50 && b.score >= (first?.score ?? 0) * 0.06,
  );
  const hueB = second ? hueOf(second) : (hueA + 150) % 360;

  // Fixed lightness per mode keeps text readable whatever the wallpaper is.
  const tint = Math.min(Math.max(baseS * 0.6, 0.12), 0.35);
  const vars = dark
    ? {
        paper: hsl(baseH, tint, 0.11, 0.86),
        "paper-solid": hsl(baseH, tint, 0.11),
        ink: hsl(baseH, 0.2, 0.94),
        muted: hsl(baseH, 0.14, 0.7),
        "accent-a": hsl(hueA, 0.85, 0.62),
        "accent-b": hsl(hueB, 0.85, 0.6),
        blend: "screen", // light inks on dark paper add up, like projected light
      }
    : {
        paper: hsl(baseH, tint, 0.94, 0.9),
        "paper-solid": hsl(baseH, tint, 0.94),
        ink: hsl(baseH, 0.35, 0.14),
        muted: hsl(baseH, 0.14, 0.4),
        "accent-a": hsl(hueA, 0.8, 0.46),
        "accent-b": hsl(hueB, 0.8, 0.5),
        blend: "multiply", // dark inks on light paper darken where they overlap, like print
      };
  return { dark, vars };
}

// ---------- Colour helpers ----------

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

const hsl = (h, s, l, a = 1) =>
  `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}% / ${a})`;
