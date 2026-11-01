// Resizing a widget. Two kinds, both remembered per widget:
//  - stretch: drag the grip in the bottom-right corner to set width and height separately.
//    The card gets more (or less) room; text and dials keep their size.
//  - scale: Shift + drag the grip, or Ctrl + mouse wheel, to grow or shrink everything evenly.
// Double-click the grip for the default size. Locked widgets can't be resized.

import { config } from "./config.js";
import { widgetName, setScale, setStretch, getDesignSize, windowSize, makeRoom } from "./api.js";
import { getSaved, setSaved } from "./store.js";

const KEY = `size.${widgetName}`; // this widget's size on top of config.scale; 1 = default
const STRETCH_KEY = `stretch.${widgetName}`; // [width, height] in full-size px added to its design size
const MIN = 0.6, MAX = 1.8;
// How far below its design size each widget can be squeezed, as a share of that size. The clock and
// the turntable have fixed geometry, so they only grow; the weather and calendar cards can give a little.
const SQUEEZE = { weather: 0.15, calendar: 0.15 }[widgetName] ?? 0;
const MAX_GROW = 1; // up to twice the design size each way
const WHEEL_STEP = 0.0005; // one mouse-wheel notch (deltaY 100) = about 5%
const gripIcon = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M8.6 1.4 9.6 2.4 2.4 9.6 1.4 8.6zM8.6 5.4 9.6 6.4 6.4 9.6 5.4 8.6z"/></svg>';

const clamp = (f) => Math.min(MAX, Math.max(MIN, f));
let factor = 1;
let stretch = [0, 0];
let resizing = Promise.resolve(); // the last window resize, so makeRoom can wait for it

function apply(f) {
  factor = clamp(f);
  resizing = setScale(config.scale * factor);
}

function applyStretch(w, h) {
  const [dw, dh] = getDesignSize();
  const fit = (v, d) => Math.round(Math.min(d * MAX_GROW, Math.max(-d * SQUEEZE, v)));
  stretch = [fit(w, dw), fit(h, dh)];
  resizing = setStretch(...stretch);
}

/** Puts back this widget's saved size. Runs before the widget mounts, so its first resize is already right. */
export function restoreSize() {
  const saved = getSaved(STRETCH_KEY);
  if (Array.isArray(saved)) {
    stretch = saved.map((v) => Number(v) || 0);
    setStretch(...stretch); // no window yet to measure, so it's checked against the limits on the next drag
  }
  apply(Number(getSaved(KEY)) || 1);
}

export function startResizing({ isLocked, showToast }) {
  // On <body>, outside the card: widgets that redraw their card can't wipe it, and it isn't a drag handle.
  const grip = document.createElement("div");
  grip.className = "resize-grip";
  grip.title = "Drag to set width and height. Shift + drag (or Ctrl + wheel) to scale evenly. Double-click for the default size.";
  grip.innerHTML = gripIcon;
  document.body.append(grip);

  // End of a resize: remember it, say the new size, and once the window has its new size,
  // move any widget it now covers (makeRoom measures the window, so it has to wait).
  async function finish(what = "scale") {
    setSaved(KEY, factor);
    setSaved(STRETCH_KEY, stretch[0] || stretch[1] ? stretch : null); // null: back to the design size
    const [w, h] = windowSize();
    showToast(what === "scale" ? `${Math.round(factor * 100)}%` : `${Math.round(w)} × ${Math.round(h)}`);
    await resizing;
    makeRoom();
  }

  // ---- Drag the grip ----
  // Measured from where the drag started, in screen pixels: the grip itself moves and changes
  // size under the pointer as the zoom changes, so its own position can't be trusted mid-drag.
  // Shift held when the drag starts picks scale; otherwise it's a stretch.
  let start = null;
  let wanted = factor;
  let wantedStretch = stretch;
  let frame = 0;

  grip.addEventListener("pointerdown", (e) => {
    if (isLocked() || e.button !== 0) return;
    const [w, h] = windowSize();
    start = { x: e.screenX, y: e.screenY, w, h, factor, stretch, even: e.shiftKey };
    wanted = factor;
    wantedStretch = stretch;
    grip.setPointerCapture(e.pointerId); // keeps the moves coming if the pointer leaves the window
  });

  grip.addEventListener("pointermove", (e) => {
    if (!start) return;
    const w = start.w + e.screenX - start.x, h = start.h + e.screenY - start.y; // the window size wanted
    if (start.even) {
      // Average how much wider and how much taller the window would be: dragging along either edge works.
      wanted = start.factor * (w / start.w + h / start.h) / 2;
    } else {
      // Screen px back to full-size px (the page is zoomed by the scale), minus the design size.
      const zoom = config.scale * factor;
      const [dw, dh] = getDesignSize();
      wantedStretch = [w / zoom - dw, h / zoom - dh];
    }
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (start?.even) apply(wanted);
      else if (start) applyStretch(...wantedStretch);
    });
  });

  function endDrag() {
    if (!start) return;
    const { even } = start;
    // A plain click isn't a resize.
    const changed = even
      ? Math.abs(wanted - start.factor) > 0.005
      : Math.abs(wantedStretch[0] - start.stretch[0]) + Math.abs(wantedStretch[1] - start.stretch[1]) > 1;
    start = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!changed) return;
    if (even) apply(wanted);
    else applyStretch(...wantedStretch);
    finish(even ? "scale" : "stretch");
  }
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  grip.addEventListener("dblclick", () => {
    if (isLocked()) return;
    applyStretch(0, 0);
    apply(1);
    finish();
  });

  // ---- Ctrl + mouse wheel ----
  // Capture phase, so it runs before the calendar's wheel (which would flip the month). Touchpad
  // pinches arrive as many small Ctrl+wheel events; scaling by deltaY keeps those smooth too.
  let wheelTimer = 0;
  window.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (isLocked()) return;
    apply(factor * Math.exp(-e.deltaY * WHEEL_STEP));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(finish, 300); // once the wheel stops
  }, { capture: true, passive: false });
}
