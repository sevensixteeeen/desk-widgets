import { invoke } from "../api.js";

const icons = {
  prev: '<svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2v12l8-6z"/></svg>',
};

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function mountNowPlaying(root) {
  root.innerHTML = `
    <div class="np is-empty">
      <div class="np-art"><img alt="" hidden><span class="glyph">♪</span></div>
      <div class="np-body">
        <p class="np-title">Nothing playing</p>
        <p class="np-artist">Play something in Spotify and it shows up here.</p>
        <div class="np-bar"><span></span></div>
        <div class="np-row">
          <span class="np-time"></span>
          <div class="np-controls">
            <button data-action="prev" aria-label="Previous track">${icons.prev}</button>
            <button data-action="toggle" aria-label="Play or pause">${icons.play}</button>
            <button data-action="next" aria-label="Next track">${icons.next}</button>
          </div>
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const el = {
    np: $(".np"), img: $(".np-art img"), glyph: $(".glyph"), title: $(".np-title"),
    artist: $(".np-artist"), bar: $(".np-bar span"), time: $(".np-time"), toggle: $('[data-action="toggle"]'),
  };

  let track = null;     // last answer from Rust
  let receivedAt = 0;   // when we got it, to keep the bar moving between polls
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
      renderTrack();
      loadArt(); // cover art is only fetched when the song changes
    }
  }

  function renderTrack() {
    el.np.classList.toggle("is-empty", !track);
    el.title.textContent = track?.title || "Nothing playing";
    el.artist.textContent = track
      ? track.artist || track.album || ""
      : "Play something in Spotify and it shows up here.";
  }

  async function loadArt() {
    const src = track ? await invoke("media_thumbnail").catch(() => null) : null;
    el.img.hidden = !src;
    el.glyph.hidden = Boolean(src);
    if (src) el.img.src = src;
  }

  // Smooth progress: runs 4x/second, polls Windows only every 1.5 s.
  function renderProgress() {
    if (!track) return;
    const elapsed = track.playing ? performance.now() - receivedAt : 0;
    const pos = Math.min(track.positionMs + elapsed, track.durationMs || Infinity);
    el.bar.style.width = track.durationMs ? `${(pos / track.durationMs) * 100}%` : "0";
    el.time.textContent = track.durationMs ? `${fmt(pos)} / ${fmt(track.durationMs)}` : "";
    if (el.toggle.dataset.playing !== String(track.playing)) {
      el.toggle.dataset.playing = track.playing; // only swap the icon when state changes
      el.toggle.innerHTML = track.playing ? icons.pause : icons.play;
    }
  }

  root.querySelector(".np-controls").addEventListener("click", async (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (!action) return;
    await invoke("media_control", { action }).catch(() => {});
    setTimeout(poll, 250); // give the player a moment to react
  });

  poll();
  setInterval(poll, 1500);
  setInterval(renderProgress, 250);
}
