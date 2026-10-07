import { invoke } from "../api.js";
import { config } from "../config.js";

const icons = {
  prev: '<svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2v12l8-6z"/></svg>',
};

const EMPTY_HINT = "Play something in Spotify and it shows up here.";

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const controlsHtml = `
  <button data-action="prev" aria-label="Previous track">${icons.prev}</button>
  <button data-action="toggle" aria-label="Play or pause">${icons.play}</button>
  <button data-action="next" aria-label="Next track">${icons.next}</button>`;

/**
 * The widget is split in two:
 *  - the data side (below, in mountNowPlaying): asks Windows what's playing, fetches
 *    cover art, works out the position between polls, sends play/pause/skip
 *  - a "view": draws it. There are two, picked by config.nowPlayingStyle:
 *    "turntable" (default) or "card" (the original design).
 * Every view has the same methods, so the data side doesn't care which one it's driving.
 * A view calls seek(fraction) when you click/drag its progress bar (0 = start, 1 = end).
 */
export function mountNowPlaying(root) {
  const makeView = config.nowPlayingStyle === "card" ? cardView : turntableView;
  const view = makeView(root, seek);

  let track = null;   // last answer from Rust
  let receivedAt = 0; // when we got it, to keep things moving between polls
  let trackKey = "";

  async function poll() {
    try {
      track = await invoke("media_now_playing");
    } catch {
      track = null;
    }
    receivedAt = performance.now();

    const key = track ? `${track.title}|${track.artist}` : "";
    if (key !== trackKey) {
      trackKey = key;
      view.setTrack(track);
      loadArt(); // cover art is only fetched when the song changes
    }
    // Only some apps let other programs move their position; Windows tells us which.
    view.setSeekable(Boolean(track?.canSeek && track.durationMs));
  }

  async function seek(fraction) {
    if (!track?.canSeek || !track.durationMs) return;
    const ms = Math.round(fraction * track.durationMs);
    // Jump the widget straight away instead of waiting for the next poll.
    track.positionMs = ms;
    receivedAt = performance.now();
    await invoke("media_seek", { positionMs: ms }).catch(() => {});
    setTimeout(poll, 400); // then check where the player really ended up
  }

  async function loadArt() {
    const src = track ? await invoke("media_thumbnail").catch(() => null) : null;
    view.setArt(src);
  }

  // Smooth progress: runs 4x/second, polls Windows only every 1.5 s.
  function tick() {
    if (!track) return view.setProgress(0, 0, false);
    const elapsed = track.playing ? performance.now() - receivedAt : 0;
    const pos = Math.min(track.positionMs + elapsed, track.durationMs || Infinity);
    view.setProgress(pos, track.durationMs, track.playing);
  }

  view.controls.addEventListener("click", async (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (!action) return;
    await invoke("media_control", { action }).catch(() => {});
    setTimeout(poll, 250); // give the player a moment to react
  });

  poll();
  setInterval(poll, 1500);
  setInterval(tick, 250);
}

// Swaps the play/pause icon only when the state actually changes.
function syncToggle(button, playing) {
  if (button.dataset.playing === String(playing)) return;
  button.dataset.playing = playing;
  button.innerHTML = playing ? icons.pause : icons.play;
  button.setAttribute("aria-label", playing ? "Pause" : "Play");
}

// ---------- View 1: turntable ----------

// Tonearm geometry, in the SVG's own units (the card's content area is 332 x 190).
// Worked out once: where the needle sits for each arm angle (0° = arm pointing straight down).
const ARM = {
  pivot: { x: 192, y: 22 },
  length: 118,
  rest: 0,   // off the record, parked beside it
  start: 18, // needle on the outer groove: start of the song
  end: 35,   // needle near the label: end of the song
};

// Progress arc around the top of the record: from the left side, over the top,
// to just before the tonearm. Angles in degrees, 0 = 3 o'clock, 90 = 12 o'clock.
const RING = { cx: 92, cy: 95, r: 97, from: 170, to: 40 };

/** Point on the ring at `deg`. SVG's y axis points down, hence the minus. */
function ringPoint(deg) {
  const a = (deg * Math.PI) / 180;
  return { x: RING.cx + RING.r * Math.cos(a), y: RING.cy - RING.r * Math.sin(a) };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function turntableView(root, seek) {
  const { pivot: p, length: L } = ARM;
  const a = ringPoint(RING.from);
  const b = ringPoint(RING.to);
  // One SVG arc command: radius r, small arc (0), drawn clockwise on screen (1).
  const ringPath = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${RING.r} ${RING.r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  root.innerHTML = `
    <div class="tt is-empty">
      <div class="tt-platter">
        <div class="tt-record">
          <div class="tt-label"><img alt="" hidden><span class="glyph">♪</span></div>
          <i class="tt-spindle"></i>
        </div>
      </div>

      <svg class="tt-ring" viewBox="0 0 332 190" aria-hidden="true">
        <path class="tt-ring-track" d="${ringPath}" pathLength="1" />
        <path class="tt-ring-played" d="${ringPath}" pathLength="1" stroke-dasharray="0 1" />
        <circle class="tt-ring-dot" r="4.5" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" />
        <path class="tt-ring-hit" d="${ringPath}" data-no-drag />
      </svg>

      <svg class="tt-arm" viewBox="0 0 332 190" aria-hidden="true">
        <g class="tt-arm-swing">
          <rect class="tt-weight" x="${p.x - 7}" y="${p.y - 27}" width="14" height="15" rx="3" />
          <line class="tt-tube" x1="${p.x}" y1="${p.y - 12}" x2="${p.x}" y2="${p.y + L - 14}" />
          <rect class="tt-head" x="${p.x - 5}" y="${p.y + L - 16}" width="10" height="17" rx="2" />
        </g>
        <circle class="tt-base" cx="${p.x}" cy="${p.y}" r="13" />
        <circle class="tt-hub" cx="${p.x}" cy="${p.y}" r="4.5" />
      </svg>

      <div class="tt-side">
        <p class="tt-title">Nothing playing</p>
        <p class="tt-artist">${EMPTY_HINT}</p>
        <p class="tt-time"></p>
        <div class="tt-controls">${controlsHtml}</div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const el = {
    tt: $(".tt"), img: $(".tt-label img"), glyph: $(".tt-label .glyph"), title: $(".tt-title"),
    artist: $(".tt-artist"), time: $(".tt-time"), arm: $(".tt-arm-swing"), toggle: $('[data-action="toggle"]'),
    played: $(".tt-ring-played"), dot: $(".tt-ring-dot"), ring: $(".tt-ring"), hit: $(".tt-ring-hit"),
  };
  el.arm.style.transformOrigin = `${p.x}px ${p.y}px`; // swing around the pivot

  let last = { pos: 0, duration: 0, playing: false }; // latest values from the data side
  let dragging = null; // while you're dragging the arc: where you are (0..1), otherwise null

  /** Mouse position -> how far along the arc it is (0..1). */
  function fractionAt(e) {
    // Screen pixels -> the SVG's own 332 x 190 units (the widget is scaled, so they differ).
    const box = el.ring.getBoundingClientRect();
    const x = ((e.clientX - box.left) * 332) / box.width;
    const y = ((e.clientY - box.top) * 190) / box.height;
    // Angle around the record's centre, same convention as RING (0 = 3 o'clock, 90 = 12).
    let deg = (Math.atan2(RING.cy - y, x - RING.cx) * 180) / Math.PI;
    if (deg < -90) deg += 360; // keep the left side as 180-270 rather than -180..-90
    return clamp((RING.from - deg) / (RING.from - RING.to), 0, 1);
  }

  function draw() {
    const { duration, playing } = last;
    const pos = dragging === null ? last.pos : dragging * duration;
    // The record spins only while playing (CSS pauses the animation otherwise).
    el.tt.classList.toggle("is-playing", playing);

    // The arm: parked when paused, on the record while playing, and it creeps
    // inward as the song goes on, so it doubles as the progress bar.
    const progress = duration ? Math.min(pos / duration, 1) : 0;
    const angle = playing ? ARM.start + (ARM.end - ARM.start) * progress : ARM.rest;
    el.arm.style.transform = `rotate(${angle.toFixed(2)}deg)`;

    // The arc: played part filled, the rest faint, a dot at the current position.
    // pathLength="1" on the path makes the dash pattern work in fractions of the arc.
    el.played.setAttribute("stroke-dasharray", `${progress.toFixed(4)} 1`);
    const here = ringPoint(RING.from - (RING.from - RING.to) * progress);
    el.dot.setAttribute("cx", here.x.toFixed(1));
    el.dot.setAttribute("cy", here.y.toFixed(1));

    el.time.textContent = duration ? `${fmt(pos)} / ${fmt(duration)}` : "";
    syncToggle(el.toggle, playing);
  }

  // Click or drag the arc. "Pointer capture" keeps the moves coming to us even
  // when the mouse slides off the thin arc mid-drag.
  el.hit.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !el.tt.classList.contains("can-seek")) return;
    el.hit.setPointerCapture(e.pointerId);
    dragging = fractionAt(e);
    el.tt.classList.add("is-seeking");
    draw();
  });
  el.hit.addEventListener("pointermove", (e) => {
    if (dragging === null) return;
    dragging = fractionAt(e);
    draw();
  });
  el.hit.addEventListener("pointerup", () => {
    if (dragging === null) return;
    const target = dragging;
    dragging = null;
    el.tt.classList.remove("is-seeking");
    seek(target); // only now tell the player, not on every pixel of the drag
  });
  el.hit.addEventListener("pointercancel", () => {
    dragging = null;
    el.tt.classList.remove("is-seeking");
    draw();
  });

  return {
    controls: $(".tt-controls"),

    setSeekable(yes) {
      el.tt.classList.toggle("can-seek", yes);
    },

    setTrack(track) {
      el.tt.classList.toggle("is-empty", !track);
      el.title.textContent = track?.title || "Nothing playing";
      el.artist.textContent = track ? track.artist || track.album || "" : EMPTY_HINT;
      el.title.title = el.title.textContent; // full text on hover when it's cut off
    },

    setArt(src) {
      el.img.hidden = !src;
      el.glyph.hidden = Boolean(src);
      if (src) el.img.src = src;
    },

    setProgress(pos, duration, playing) {
      last = { pos, duration, playing };
      draw(); // while dragging, draw() shows the drag position instead
    },
  };
}

// ---------- View 2: card (the original design) ----------

function cardView(root, seek) {
  root.innerHTML = `
    <div class="np is-empty">
      <div class="np-art"><img alt="" hidden><span class="glyph">♪</span></div>
      <div class="np-body">
        <p class="np-title">Nothing playing</p>
        <p class="np-artist">${EMPTY_HINT}</p>
        <div class="np-bar" data-no-drag><span></span></div>
        <div class="np-row">
          <span class="np-time"></span>
          <div class="np-controls">${controlsHtml}</div>
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const el = {
    np: $(".np"), img: $(".np-art img"), glyph: $(".np-art .glyph"), title: $(".np-title"),
    artist: $(".np-artist"), bar: $(".np-bar span"), time: $(".np-time"), toggle: $('[data-action="toggle"]'),
  };

  // Click anywhere on the bar to jump there.
  $(".np-bar").addEventListener("click", (e) => {
    if (!el.np.classList.contains("can-seek")) return;
    const box = e.currentTarget.getBoundingClientRect();
    seek(clamp((e.clientX - box.left) / box.width, 0, 1));
  });

  return {
    controls: $(".np-controls"),

    setSeekable(yes) {
      el.np.classList.toggle("can-seek", yes);
    },

    setTrack(track) {
      el.np.classList.toggle("is-empty", !track);
      el.title.textContent = track?.title || "Nothing playing";
      el.artist.textContent = track ? track.artist || track.album || "" : EMPTY_HINT;
    },

    setArt(src) {
      el.img.hidden = !src;
      el.glyph.hidden = Boolean(src);
      if (src) el.img.src = src;
    },

    setProgress(pos, duration, playing) {
      el.bar.style.width = duration ? `${(pos / duration) * 100}%` : "0";
      el.time.textContent = duration ? `${fmt(pos)} / ${fmt(duration)}` : "";
      syncToggle(el.toggle, playing);
    },
  };
}
