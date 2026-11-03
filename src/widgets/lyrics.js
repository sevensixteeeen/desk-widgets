import { invoke, isShown, startDrag } from "../api.js";
import { isSpotify, loadLyrics, lineAt, LEAD_MS } from "../lyrics.js";

const POLL_MS = 1500; // ask Windows what's playing, like the now-playing widget
const TICK_MS = 200;  // move the highlight along
const FOLLOW_AGAIN_MS = 4000; // after you scroll, back to the line being sung once you've left it alone this long
const MOVE_PX = 5;      // a press that moves less than this is a tap
const WHEEL_LINE_PX = 40; // mice that report the wheel in lines, not pixels
const PRE_ROLL_MS = 150; // a tapped line starts this much early, so its first word isn't cut off

/**
 * The words of the song Spotify is playing, following along: the line being sung is bright and
 * held a little above the middle, the lines around it fade out. A taller card shows more of them.
 * Scroll (wheel, touchpad, or drag while locked) to look back or ahead; it follows the song again
 * once you leave it alone. Tap a line to play the song from there (timed lyrics only).
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
  let browseY = null; // while you're scrolling: where you've moved the lines to (px); null = following the song
  let followTimer = 0;
  let press = null;   // a mouse button or finger down on the lines: {id, x, y, moved, fromY}

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
    markTappable();

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
    stopBrowsing();
    ly.classList.add("is-note");
    ly.classList.remove("is-plain");
    list.style.transform = "";
    list.innerHTML = `<p class="ly-note"></p>`;
    list.firstChild.textContent = text;
    shownLine = -2;
    markTappable();
  }

  function drawLines() {
    stopBrowsing();
    ly.classList.remove("is-note");
    ly.classList.toggle("is-plain", !lyrics.synced); // no times: scrolls along, nothing highlighted
    list.replaceChildren(...lyrics.lines.map(({ text }) => {
      const p = document.createElement("p");
      p.className = "ly-line";
      p.textContent = text || "♪"; // a gap between verses
      p.dataset.noDrag = ""; // main.js doesn't start moving the widget on a press here; the press code below decides
      return p;
    }));
    shownLine = -2;
    markTappable();
    tick();
  }

  // Only timed lyrics can be tapped (lines without times have none to jump to), and only if
  // Spotify lets other apps move its position (Windows tells us). CSS shows the pointer then.
  const canTap = () => Boolean(lyrics?.synced && track?.canSeek);
  function markTappable() {
    ly.classList.toggle("can-tap", canTap());
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

  // Where the lines must be moved to so line `p` sits a little above the middle.
  const yFor = (p) => view.clientHeight * 0.42 - (p.offsetTop + p.offsetHeight / 2);

  // Holds the current line (or the first, before the singing starts) a little above the middle,
  // unless you're scrolling: then the lines stay where you put them.
  function centre() {
    const p = list.children[Math.max(shownLine, 0)];
    if (!p || shownLine === -2 || browseY !== null) return;
    list.style.transform = `translateY(${Math.round(yFor(p))}px)`;
  }

  // ---- Scrolling ----
  // Where the lines are right now, even halfway through sliding to the next one.
  const currentY = () => browseY ?? new DOMMatrix(getComputedStyle(list).transform).m42;
  // Pointer and wheel distances are screen px; the page is zoomed by the widget's scale (api.js),
  // so divide, or the lines would trail behind your finger.
  const unzoom = (px) => px / (Number(document.documentElement.style.zoom) || 1);

  /** Moves the lines to `y`, no further than the first or last line at the follow point. */
  function browseTo(y) {
    if (!lyrics) return;
    browseY = Math.min(yFor(list.firstElementChild), Math.max(yFor(list.lastElementChild), y));
    ly.classList.add("is-browsing"); // CSS: a quick slide instead of the slow one between lines
    list.style.transform = `translateY(${Math.round(browseY)}px)`;
    clearTimeout(followTimer);
    followTimer = setTimeout(followSong, FOLLOW_AGAIN_MS);
  }

  function stopBrowsing() {
    clearTimeout(followTimer);
    browseY = null;
    press = null;
    ly.classList.remove("is-browsing", "is-dragging");
  }

  // Back to the line being sung, with the usual slow slide.
  function followSong() {
    if (press?.moved) return; // still holding the lines; this is checked again when you let go
    stopBrowsing();
    centre();
  }

  // Wheel or touchpad. Ctrl + wheel never gets here: resize.js takes it to scale the widget.
  view.addEventListener("wheel", (e) => {
    if (!lyrics) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaMode === 2 ? e.deltaY * view.clientHeight : unzoom(e.deltaY);
    browseTo(currentY() - dy);
  }, { passive: false });

  // A press on the lines: let go without moving and it's a tap, which plays the song from that
  // line. Move instead and, while locked, the lines scroll with the pointer; while unlocked, the
  // widget moves, as it does when you drag it anywhere else.
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !lyrics) return;
    const locked = document.body.classList.contains("is-locked");
    if (!locked && !e.target.closest(".ly-line")) return; // main.js is already moving the widget
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, fromY: 0 };
  });

  view.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (!(e.buttons & 1)) return void (press = null); // let go somewhere we didn't hear about
    if (!press.moved) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < MOVE_PX) return;
      if (!document.body.classList.contains("is-locked")) {
        press = null;
        return startDrag();
      }
      press.moved = true;
      press.fromY = currentY() - unzoom(e.clientY - press.y); // so the lines don't jump by the first few px
      view.setPointerCapture(e.pointerId); // keeps the moves coming if the pointer leaves the widget
      ly.classList.add("is-dragging"); // CSS: no slide at all, the lines stick to the pointer
    }
    browseTo(press.fromY + unzoom(e.clientY - press.y));
  });

  view.addEventListener("pointerup", (e) => {
    if (!press || e.pointerId !== press.id) return;
    const { moved } = press;
    press = null;
    ly.classList.remove("is-dragging");
    if (moved) return browseTo(currentY()); // starts the wait before following the song again
    const p = e.target.closest(".ly-line");
    if (p) playFrom([...list.children].indexOf(p));
  });

  view.addEventListener("pointercancel", () => {
    if (press?.moved) browseTo(currentY());
    press = null;
    ly.classList.remove("is-dragging");
  });

  // ---- Tap a line ----
  async function playFrom(i) {
    const line = lyrics?.lines[i];
    if (!line || !canTap()) return;
    const ms = Math.max(0, line.ms - PRE_ROLL_MS);
    const wasPlaying = track.playing;
    // Move the highlight straight away instead of waiting for the next poll.
    track.positionMs = ms;
    track.playing = true;
    receivedAt = performance.now();
    stopBrowsing();
    shownLine = -2; // so tick() centres on the tapped line even if it was already the current one
    tick();
    await invoke("media_seek", { positionMs: ms }).catch(() => {});
    // Paused: play from there. Not "toggle": that would pause a song that's playing.
    if (!wasPlaying) await invoke("media_control", { action: "play" }).catch(() => {});
    setTimeout(poll, 400); // then check where Spotify really is
  }

  // Resized (resize.js): lines re-wrap, so centre again (or keep your scroll within the lines).
  new ResizeObserver(() => requestAnimationFrame(() => (browseY === null ? centre() : browseTo(browseY)))).observe(view);

  showNote("Play a song on Spotify to see its lyrics here.");
  setSong(null);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(tick, TICK_MS);
}
