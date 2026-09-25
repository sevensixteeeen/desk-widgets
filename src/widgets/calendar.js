import { invoke } from "../api.js";
import { config } from "../config.js";

const REFRESH_MS = 10 * 60 * 1000;
const plusIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>';

// "2026-09-25" for a Date, in local time (toISOString would use UTC and can shift the day)
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "2026-09-25" -> Date at local midnight (new Date("2026-09-25") would be UTC midnight)
const fromKey = (key) => new Date(`${key}T00:00:00`);

const parseStart = (e) => (e.allDay ? fromKey(e.start) : new Date(e.start));

// Google's calendar colours arrive as "#a4bdfc"; anything else is ignored.
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c ?? "") ? c : "var(--accent-b)");

export function mountCalendar(root) {
  root.innerHTML = `
    <div class="cal">
      <div class="cal-head">
        <h1 class="cal-month"></h1>
        <div class="cal-head-side">
          <span class="cal-year"></span>
          <button class="cal-add" aria-label="Add event" title="Add event" hidden>${plusIcon}</button>
        </div>
      </div>
      <div class="cal-grid"></div>
      <div class="cal-bottom"></div>
    </div>`;

  const grid = root.querySelector(".cal-grid");
  const bottom = root.querySelector(".cal-bottom");
  const addButton = root.querySelector(".cal-add");

  let events = [];
  let connected = false;
  let formDate = null; // a date key while the add-event form is open, else null
  let renderedDay = "";

  // ---------- Month grid ----------

  function renderMonth() {
    const today = new Date();
    renderedDay = dayKey(today);
    const year = today.getFullYear(), month = today.getMonth();

    root.querySelector(".cal-month").textContent = today.toLocaleDateString(undefined, { month: "long" });
    root.querySelector(".cal-year").textContent = year;

    // Weekday initials, rotated so the week starts on config.weekStartsOn
    const dow = [...Array(7)].map((_, i) => {
      const d = new Date(2024, 0, 7 + ((i + config.weekStartsOn) % 7)); // Jan 7 2024 was a Sunday
      return `<div class="cal-dow">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</div>`;
    });

    const first = new Date(year, month, 1);
    const offset = (first.getDay() - config.weekStartsOn + 7) % 7;
    const eventDays = new Set(events.map((e) => dayKey(parseStart(e))));

    // Each day is a real <button>: click it to add an event on that date.
    const days = [...Array(42)].map((_, i) => {
      const d = new Date(year, month, 1 - offset + i);
      const key = dayKey(d);
      const cls = [
        "cal-day",
        d.getMonth() !== month && "is-other",
        key === renderedDay && "is-today",
        key === formDate && "is-picked",
        eventDays.has(key) && "has-event",
      ].filter(Boolean).join(" ");
      return `<button class="${cls}" data-date="${key}" ${connected ? "" : "disabled"}
        aria-label="${d.toLocaleDateString(undefined, { dateStyle: "full" })}"><span>${d.getDate()}</span></button>`;
    });

    grid.innerHTML = dow.join("") + days.join("");
  }

  grid.addEventListener("click", (e) => {
    const day = e.target.closest(".cal-day");
    if (day && connected) openForm(day.dataset.date);
  });
  addButton.addEventListener("click", () => openForm(dayKey(new Date())));

  // ---------- Bottom area: upcoming list, add form, or a message ----------

  function renderUpcoming() {
    const now = new Date();
    const todayKey = dayKey(now);
    const tomorrowKey = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: config.hour12 });

    const upcoming = events
      .map((e) => ({ ...e, date: parseStart(e) }))
      .filter((e) => (e.allDay ? dayKey(e.date) >= todayKey : e.date >= now))
      .sort((a, b) => a.date - b.date) // events come from several calendars, so sort here
      .slice(0, config.upcomingEvents);

    if (!upcoming.length) {
      bottom.className = "cal-foot";
      bottom.innerHTML = `<p class="note">Nothing coming up. Click a day to add an event.</p>`;
      return;
    }

    bottom.className = "cal-events";
    bottom.innerHTML = upcoming.map((e) => {
      const key = dayKey(e.date);
      const day = key === todayKey ? "Today"
        : key === tomorrowKey ? "Tmrw"
        : `${e.date.toLocaleDateString(undefined, { weekday: "short" })} ${e.date.getDate()}`;
      const when = e.allDay ? day : `${day} ${timeFmt.format(e.date)}`;
      return `
        <div class="cal-event">
          <span class="cal-when">${when}</span>
          <span class="cal-what"><i class="cal-dot" style="background:${safeColor(e.color)}"></i><span></span></span>
        </div>`;
    }).join("");

    // Titles go in via textContent so an event called "<b>hi</b>" can't inject HTML.
    bottom.querySelectorAll(".cal-what > span").forEach((el, i) => {
      el.textContent = upcoming[i].title;
      el.parentElement.title = `${upcoming[i].title} (${upcoming[i].calendar})`;
    });
  }

  function openForm(key) {
    formDate = key;
    renderMonth(); // highlights the picked day
    bottom.className = "cal-form-wrap";
    bottom.innerHTML = `
      <form class="cal-form">
        <input name="title" placeholder="Event title" aria-label="Event title" required autocomplete="off" />
        <div class="cal-form-row">
          <input type="date" name="date" aria-label="Date" required />
          <input type="time" name="time" aria-label="Time, leave empty for all day" />
        </div>
        <div class="cal-form-row">
          <select name="duration" aria-label="Duration">
            <option value="30">30 min</option>
            <option value="60" selected>1 hour</option>
            <option value="120">2 hours</option>
          </select>
          <button type="button" class="btn-quiet" data-cancel>Cancel</button>
          <button type="submit" class="btn">Add</button>
        </div>
        <p class="note cal-form-msg">No time = all-day event.</p>
      </form>`;

    const form = bottom.querySelector("form");
    const msg = form.querySelector(".cal-form-msg");
    form.date.value = key;
    form.title.focus();

    // Clicking another day while the form is open just changes the date.
    form.date.addEventListener("change", () => { formDate = form.date.value; renderMonth(); });
    form.time.addEventListener("input", () => (form.duration.disabled = !form.time.value));
    form.duration.disabled = true; // starts all-day until a time is typed
    form.querySelector("[data-cancel]").addEventListener("click", closeForm);
    form.addEventListener("keydown", (e) => e.key === "Escape" && closeForm());

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = form.title.value.trim();
      const date = form.date.value;
      if (!title || !date) return;

      let start, end;
      const allDay = !form.time.value;
      if (allDay) {
        const next = fromKey(date);
        next.setDate(next.getDate() + 1);
        start = date;
        end = dayKey(next); // Google's all-day end date is exclusive: the next day
      } else {
        const s = new Date(`${date}T${form.time.value}`);
        start = s.toISOString();
        end = new Date(s.getTime() + Number(form.duration.value) * 60_000).toISOString();
      }

      msg.textContent = "Adding…";
      try {
        await invoke("gcal_create_event", { title, start, end, allDay });
        closeForm();
        loadEvents();
      } catch (err) {
        msg.textContent = String(err);
      }
    });
  }

  function closeForm() {
    formDate = null;
    renderMonth();
    renderUpcoming();
  }

  // A message with an optional button (not connected, errors...)
  function renderFoot(message, buttonLabel, detail = "") {
    bottom.className = "cal-foot";
    bottom.innerHTML = `
      <p class="note">${message}</p>
      ${detail ? `<code class="muted"></code>` : ""}
      ${buttonLabel ? `<button class="btn">${buttonLabel}</button>` : ""}`;
    if (detail) bottom.querySelector("code").textContent = detail;
    bottom.querySelector(".btn")?.addEventListener("click", connect);
  }

  function setConnected(value) {
    connected = value;
    addButton.hidden = !value;
  }

  async function connect() {
    renderFoot("Finish signing in with Google in your browser.", "");
    try {
      await invoke("gcal_connect");
      await loadEvents();
    } catch (err) {
      renderFoot(String(err), "Connect Google Calendar");
    }
  }

  async function loadEvents() {
    const status = await invoke("gcal_status");
    if (!status.configured) {
      setConnected(false);
      return renderFoot("To show your events, add your Google client file here:", "", status.clientPath);
    }
    if (status.needsReconnect) {
      setConnected(false);
      return renderFoot("Reconnect to see all your calendars and add events.", "Reconnect");
    }
    if (!status.connected) {
      setConnected(false);
      return renderFoot("See your events here.", "Connect Google Calendar");
    }

    // From the start of this month's grid to ~2 weeks past month end.
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1 - 7);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 14);
    try {
      events = await invoke("gcal_events", { timeMin: from.toISOString(), timeMax: to.toISOString() });
      setConnected(true);
      renderMonth();
      if (!formDate) renderUpcoming(); // don't wipe a half-typed event
    } catch (err) {
      setConnected(false);
      renderFoot(String(err), "Connect Google Calendar");
    }
  }

  renderMonth();
  loadEvents();
  setInterval(loadEvents, REFRESH_MS);
  // Redraw at midnight (checked every minute) so "today" moves on.
  setInterval(() => {
    if (dayKey(new Date()) !== renderedDay) {
      renderMonth();
      if (connected && !formDate) renderUpcoming();
    }
  }, 60 * 1000);
}
