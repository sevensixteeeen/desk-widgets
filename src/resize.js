// Resizing a widget: drag the grip in its bottom-right corner, or Ctrl + mouse wheel over it.
// Widgets scale evenly (their designs have fixed geometry, like the turntable's arm), and each
// one remembers its own size. Double-click the grip for the default size. Locked widgets can't be resized.

import { config } from "./config.js";
import { widgetName, setScale, windowSize, makeRoom } from "./api.js";
import { getSaved, setSaved } from "./store.js";

const KEY = `size.${widgetName}`; // this widget's size on top of config.scale; 1 = default
const MIN = 0.6, MAX = 1.8;
const WHEEL_STEP = 0.0005; // one mouse-wheel notch (deltaY 100) = about 5%
const gripIcon = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M8.6 1.4 9.6 2.4 2.4 9.6 1.4 8.6zM8.6 5.4 9.6 6.4 6.4 9.6 5.4 8.6z"/></svg>';

const clamp = (f) => Math.min(MAX, Math.max(MIN, f));
let factor = 1;
let resizing = Promise.resolve(); // the last window resize, so makeRoom can wait for it

function apply(f) {
  factor = clamp(f);
  resizing = setScale(config.scale * factor);
}

/** Puts back this widget's saved size. Runs before the widget mounts, so its first resize is already right. */
export function restoreSize() {
  apply(Number(getSaved(KEY)) || 1);
}

export function startResizing({ isLocked, showToast }) {
  // On <body>, outside the card: widgets that redraw their card can't wipe it, and it isn't a drag handle.
  const grip = document.createElement("div");
  grip.className = "resize-grip";
  grip.title = "Drag to resize. Double-click for the default size.";
  grip.innerHTML = gripIcon;
  document.body.append(grip);

  // End of a resize: remember it, say the new size, and once the window has its new size,
  // move any widget it now covers (makeRoom measures the window, so it has to wait).
  async function finish() {
    setSaved(KEY, factor);
    showToast(`${Math.round(factor * 100)}%`);
    await resizing;
    makeRoom();
  }

  // ---- Drag the grip ----
  // Measured from where the drag started, in screen pixels: the grip itself moves and changes
  // size under the pointer as the zoom changes, so its own position can't be trusted mid-drag.
  let start = null;
  let wanted = factor;
  let frame = 0;

  grip.addEventListener("pointerdown", (e) => {
    if (isLocked() || e.button !== 0) return;
    const [w, h] = windowSize();
    start = { x: e.screenX, y: e.screenY, w, h, factor };
    wanted = factor;
    grip.setPointerCapture(e.pointerId); // keeps the moves coming if the pointer leaves the window
  });

  grip.addEventListener("pointermove", (e) => {
    if (!start) return;
    // Average how much wider and how much taller the window would be: dragging along either edge works.
    const grow = ((start.w + e.screenX - start.x) / start.w + (start.h + e.screenY - start.y) / start.h) / 2;
    wanted = start.factor * grow;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      apply(wanted);
    });
  });

  function endDrag() {
    if (!start) return;
    const changed = Math.abs(wanted - start.factor) > 0.005; // a plain click isn't a resize
    start = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!changed) return;
    apply(wanted);
    finish();
  }
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  grip.addEventListener("dblclick", () => {
    if (isLocked()) return;
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
