import { invoke, isShown } from "../api.js";
import { isSpotify, loadLyrics, lineAt, LEAD_MS } from "../lyrics.js";

const POLL_MS = 1500; // ask Windows what's playing, like the now-playing widget
const TICK_MS = 200;  // move the highlight along

/**
 * The words of the song Spotify is playing, following along: the line being sung is bright and
 * held a little above the middle, the lines around it fade out. A taller card shows more of them.
 * Other apps are ignored. While the widget is hidden (tray → Show widgets), it asks nothing of
 * Windows or LRCLIB.
 */
export function mountLyrics(root) {
  root.innerHTML = `
    <div class="ly is-note">
      <p class="ly-song"><i></i><b></b><span></span></p>
      <div class="ly-view"><div class="ly-lines"></div></div>
    </div>`;
  const ly = root.querySelector(".ly");
  const song = root.querySelector(".ly-song");
  const view = root.querySelector(".ly-view");
  const list = root.querySelector(".ly-lines");

  let track = null;   // last answer from Rust
  let receivedAt = 0; // when we got it, to keep the position moving between polls
  let trackKey = "";
  let lyrics = null;  // {lines, synced} once found
  let shownLine = -2; // the highlighted line's index; -2 = none drawn yet

  async function poll() {
    if (!(await isShown())) {
      track = null;
      if (trackKey !== "hidden") {
        trackKey = "hidden"; // looked up again when it's shown
        lyrics = null;
      }
      return;
    }
    try {
      track = await invoke("media_now_playing");
    } catch {
      track = null;
    }
    receivedAt = performance.now();

    const key = track && isSpotify(track) ? `${track.title}|${track.artist}` : track ? "other" : "";
    if (key === trackKey) return;
    trackKey = key;
    lyrics = null;
    setSong(key === "other" || !track ? null : track);
    if (!track) return showNote("Play a song on Spotify to see its lyrics here.");
    if (key === "other") return showNote("Lyrics show for songs playing on Spotify.");

    showNote("Finding the lyrics…");
    const stillWanted = () => trackKey === key;
    const found = await loadLyrics(track, stillWanted, () => showNote("Can't reach the lyrics service. Trying again…"));
    if (!stillWanted() || found === undefined) return;
    if (!found) return showNote("No lyrics found for this song.");
    if (found.instrumental) return showNote("♪  Instrumental");
    lyrics = found;
    drawLines();
  }

  function setSong(t) {
    song.hidden = !t;
    if (!t) return;
    // Song names go in as text, never HTML.
    song.querySelector("b").textContent = t.title;
    song.querySelector("span").textContent = t.artist ? `· ${t.artist}` : "";
  }

  function showNote(text) {
    ly.classList.add("is-note");
    ly.classList.remove("is-plain");
    list.style.transform = "";
    list.innerHTML = `<p class="ly-note"></p>`;
    list.firstChild.textContent = text;
    shownLine = -2;
  }

  function drawLines() {
    ly.classList.remove("is-note");
    ly.classList.toggle("is-plain", !lyrics.synced); // no times: scrolls along, nothing highlighted
    list.replaceChildren(...lyrics.lines.map(({ text }) => {
      const p = document.createElement("p");
      p.className = "ly-line";
      p.textContent = text || "♪"; // a gap between verses
      return p;
    }));
    shownLine = -2;
    tick();
  }

  function tick() {
    if (!lyrics || !track) return;
    const pos = track.positionMs + (track.playing ? performance.now() - receivedAt : 0);
    // Without times, guess the line from how far through the song it is.
    const line = lyrics.synced
      ? lineAt(lyrics.lines, pos + LEAD_MS)
      : Math.min(lyrics.lines.length - 1, Math.floor((pos / (track.durationMs || Infinity)) * lyrics.lines.length));
    if (line === shownLine) return;
    shownLine = line;
    [...list.children].forEach((p, i) => {
      p.classList.toggle("is-now", i === line && lyrics.synced);
      p.classList.toggle("is-past", i < line);
    });
    centre();
  }

  // Holds the current line (or the first, before the singing starts) a little above the middle.
  function centre() {
    const p = list.children[Math.max(shownLine, 0)];
    if (!p || shownLine === -2) return;
    const y = view.clientHeight * 0.42 - (p.offsetTop + p.offsetHeight / 2);
    list.style.transform = `translateY(${Math.round(y)}px)`;
  }

  // Resized (resize.js): lines re-wrap, so centre again.
  new ResizeObserver(() => requestAnimationFrame(centre)).observe(view);

  showNote("Play a song on Spotify to see its lyrics here.");
  setSong(null);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(tick, TICK_MS);
}
