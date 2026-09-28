import { invoke } from "../api.js";
import { config } from "../config.js";

const REFRESH_MS = 10 * 60 * 1000;
const UPCOMING_DAYS = 45; // how far ahead the "upcoming" list looks
const LAST_CALENDAR_KEY = "calendar.lastCalendar"; // remembers the calendar you last added to
const plusIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>';
const prevIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.3 2.3 11.7 3.7 7.4 8l4.3 4.3-1.4 1.4L4.6 8z"/></svg>';
const nextIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.7 2.3 4.3 3.7 8.6 8l-4.3 4.3 1.4 1.4L11.4 8z"/></svg>';

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
        <span class="cal-year"></span>
        <button class="cal-today" title="Back to this month" hidden>Today</button>
        <h1 class="cal-month" aria-live="polite"></h1>
        <div class="cal-head-side">
          <button class="cal-nav" data-step="-1" aria-label="Previous month" title="Previous month">${prevIcon}</button>
          <button class="cal-nav" data-step="1" aria-label="Next month" title="Next month">${nextIcon}</button>
          <button class="cal-add" aria-label="Add event" title="Add event" hidden>${plusIcon}</button>
        </div>
      </div>
      <div class="cal-grid"></div>
      <div class="cal-bottom"></div>
    </div>`;

  const grid = root.querySelector(".cal-grid");
  const bottom = root.querySelector(".cal-bottom");
  const addButton = root.querySelector(".cal-add");
  const todayButton = root.querySelector(".cal-today");

  let upcoming = [];           // events from today onwards, for the list under the grid
  let calendars = [];          // calendars you can add events to, for the form's picker
  const monthCache = new Map(); // "2026-10" -> events shown as dots in that month's grid
  let connected = false;
  let formDate = null; // a date key while the add-event form is open, else null
  let renderedDay = "";

  // The month being shown. Starts on the current month; the arrows move it.
  const now0 = new Date();
  let view = { year: now0.getFullYear(), month: now0.getMonth() };

  const monthKey = (year, month) => `${year}-${String(month + 1).padStart(2, "0")}`;
  const isCurrentMonth = () => {
    const t = new Date();
    return view.year === t.getFullYear() && view.month === t.getMonth();
  };

  // First and last day the 6-week grid shows for a month (it includes bits of the months around it).
  function gridRange(year, month) {
    const offset = (new Date(year, month, 1).getDay() - config.weekStartsOn + 7) % 7;
    return { start: new Date(year, month, 1 - offset), end: new Date(year, month, 1 - offset + 42) };
  }

  // ---------- Month grid ----------

  function renderMonth() {
    renderedDay = dayKey(new Date());
    const { year, month } = view;
    const firstOfMonth = new Date(year, month, 1);

    root.querySelector(".cal-month").textContent = firstOfMonth.toLocaleDateString(undefined, { month: "long" });
    root.querySelector(".cal-year").textContent = year;
    todayButton.hidden = isCurrentMonth();
    const events = monthCache.get(monthKey(year, month)) ?? [];

    // Weekday initials, rotated so the week starts on config.weekStartsOn
    const dow = [...Array(7)].map((_, i) => {
      const d = new Date(2024, 0, 7 + ((i + config.weekStartsOn) % 7)); // Jan 7 2024 was a Sunday
      return `<div class="cal-dow">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</div>`;
    });

    const offset = (firstOfMonth.getDay() - config.weekStartsOn + 7) % 7;
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
  addButton.addEventListener("click", () => {
    // Today if you're looking at this month, otherwise the 1st of the month on screen.
    openForm(isCurrentMonth() ? dayKey(new Date()) : dayKey(new Date(view.year, view.month, 1)));
  });

  // ---------- Month navigation ----------

  let fetchTimer = null;

  function goToMonth(year, month, direction = 0) {
    const d = new Date(year, month, 1); // normalises month -1 / 12 into the right year
    view = { year: d.getFullYear(), month: d.getMonth() };
    renderMonth();

    // A short slide in the direction you moved, so it's clear the month changed.
    if (direction) {
      grid.classList.remove("slide-next", "slide-prev");
      void grid.offsetWidth; // restart the animation if you click quickly
      grid.classList.add(direction > 0 ? "slide-next" : "slide-prev");
    }

    // Load this month's events unless we already have them. Waiting briefly means
    // clicking › five times fetches one month, not five.
    clearTimeout(fetchTimer);
    if (connected && !monthCache.has(monthKey(view.year, view.month))) {
      fetchTimer = setTimeout(() => loadMonth(view.year, view.month), 250);
    }
  }

  root.querySelectorAll(".cal-nav").forEach((btn) =>
    btn.addEventListener("click", () => {
      const step = Number(btn.dataset.step);
      goToMonth(view.year, view.month + step, step);
    }),
  );
  todayButton.addEventListener("click", () => {
    const t = new Date();
    const step = Math.sign(t.getFullYear() * 12 + t.getMonth() - (view.year * 12 + view.month));
    goToMonth(t.getFullYear(), t.getMonth(), step);
  });

  // Mouse wheel over the grid also flips months (one step per wheel "notch").
  let wheelLock = false;
  grid.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (wheelLock || Math.abs(e.deltaY) < 10) return;
    wheelLock = true;
    setTimeout(() => (wheelLock = false), 300); // touchpads send many small events
    const step = e.deltaY > 0 ? 1 : -1;
    goToMonth(view.year, view.month + step, step);
  }, { passive: false });

  // ---------- Bottom area: upcoming list, add form, or a message ----------

  function renderUpcoming() {
    const now = new Date();
    const todayKey = dayKey(now);
    const tomorrowKey = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: config.hour12 });

    const list = upcoming
      .map((e) => ({ ...e, date: parseStart(e) }))
      .filter((e) => (e.allDay ? dayKey(e.date) >= todayKey : e.date >= now))
      .sort((a, b) => a.date - b.date) // events come from several calendars, so sort here
      .slice(0, config.upcomingEvents);

    if (!list.length) {
      bottom.className = "cal-foot";
      bottom.innerHTML = `<p class="note">Nothing coming up. Click a day to add an event.</p>`;
      return;
    }

    bottom.className = "cal-events";
    bottom.innerHTML = list.map((e) => {
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
      el.textContent = list[i].title;
      el.parentElement.title = `${list[i].title} (${list[i].calendar})`;
    });
  }

  function openForm(key) {
    formDate = key;
    renderMonth(); // highlights the picked day
    bottom.className = "cal-form-wrap";
    bottom.innerHTML = `
      <form class="cal-form">
        <input name="title" placeholder="Event title" aria-label="Event title" required autocomplete="off" />
        <div class="cal-form-row cal-pick" ${calendars.length > 1 ? "" : "hidden"}>
          <i class="cal-dot"></i>
          <select name="calendar" aria-label="Calendar"></select>
        </div>
        <div class="cal-form-row">
          <input type="date" name="date" aria-label="Date" required />
          <input type="time" name="time" aria-label="Time, leave empty for all day" />
        </div>
        <div class="cal-form-row">
          <select name="duration" aria-label="Duration">
            <option value="">All day</option>
            <option value="30">30 min</option>
            <option value="60" selected>1 hour</option>
            <option value="120">2 hours</option>
          </select>
          <button type="button" class="btn-quiet" data-cancel>Cancel</button>
          <button type="submit" class="btn">Add</button>
        </div>
        <p class="note cal-form-msg" aria-live="polite"></p>
      </form>`;

    const form = bottom.querySelector("form");
    const msg = form.querySelector(".cal-form-msg");
    form.date.value = key;
    form.title.focus();

    // Calendar picker. Names and colours come from Google, so they're set with
    // new Option(text, value) and style (never inserted as HTML).
    for (const cal of calendars) form.calendar.add(new Option(cal.name, cal.id));
    const last = localStorage.getItem(LAST_CALENDAR_KEY);
    const initial = calendars.find((c) => c.id === last) ?? calendars.find((c) => c.primary) ?? calendars[0];
    if (initial) form.calendar.value = initial.id;
    const dot = form.querySelector(".cal-pick .cal-dot");
    const paintDot = () => {
      const cal = calendars.find((c) => c.id === form.calendar.value);
      dot.style.background = safeColor(cal?.color);
    };
    paintDot();
    form.calendar.addEventListener("change", paintDot);

    // Clicking another day while the form is open just changes the date.
    // Changing the date in the form moves the grid to that month if needed.
    form.date.addEventListener("change", () => {
      if (!form.date.value) return;
      formDate = form.date.value;
      const d = fromKey(formDate);
      if (d.getFullYear() !== view.year || d.getMonth() !== view.month) {
        const step = Math.sign(d.getFullYear() * 12 + d.getMonth() - (view.year * 12 + view.month));
        goToMonth(d.getFullYear(), d.getMonth(), step);
      } else {
        renderMonth();
      }
    });
    // No time = all-day event. The duration box says "All day" until you type a time.
    const allDayOption = form.duration.options[0];
    function syncDuration() {
      const timed = Boolean(form.time.value);
      form.duration.disabled = !timed;
      allDayOption.hidden = timed;
      if (!timed) form.duration.value = "";
      else if (!form.duration.value) form.duration.value = "60";
    }
    form.time.addEventListener("input", syncDuration);
    syncDuration();
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

      // No picker (only one writable calendar, or the list hasn't loaded): use your main calendar.
      const calendarId = form.calendar.value || "primary";

      msg.textContent = "Adding…";
      try {
        await invoke("gcal_create_event", { title, start, end, allDay, calendarId });
        if (form.calendar.value) localStorage.setItem(LAST_CALENDAR_KEY, calendarId);
        closeForm();
        loadEvents(); // refreshes the list and the month on screen
      } catch (err) {
        msg.textContent = msg.title = String(err); // title = full text on hover if it's cut off
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

    try {
      // One request covers both this month's grid and the upcoming list.
      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const ahead = new Date(today.getFullYear(), today.getMonth(), today.getDate() + UPCOMING_DAYS);
      const range = gridRange(today.getFullYear(), today.getMonth());
      const end = ahead > range.end ? ahead : range.end;
      const events = await fetchEvents(range.start, end);
      // The picker list; if it fails, keep the last one (adding still works via "primary").
      calendars = await invoke("gcal_calendars").catch(() => calendars);

      setConnected(true);
      monthCache.clear(); // everything is re-fetched on refresh, so nothing goes stale
      monthCache.set(monthKey(today.getFullYear(), today.getMonth()), events);
      upcoming = events.filter((e) => parseStart(e) >= startOfToday);

      if (!isCurrentMonth()) await loadMonth(view.year, view.month);
      renderMonth();
      if (!formDate) renderUpcoming(); // don't wipe a half-typed event
    } catch (err) {
      setConnected(false);
      renderFoot(String(err), "Connect Google Calendar");
    }
  }

  function fetchEvents(from, to) {
    return invoke("gcal_events", { timeMin: from.toISOString(), timeMax: to.toISOString() });
  }

  // Events for a month you've navigated to (only the dots in the grid use these).
  async function loadMonth(year, month) {
    const { start, end } = gridRange(year, month);
    try {
      monthCache.set(monthKey(year, month), await fetchEvents(start, end));
    } catch {
      return; // keep the grid without dots; the next refresh tries again
    }
    // Only redraw if you're still looking at that month.
    if (view.year === year && view.month === month) renderMonth();
  }

  renderMonth();
  loadEvents();
  setInterval(loadEvents, REFRESH_MS);
  // At midnight (checked every minute), move "today" on. If you were looking at
  // the current month and a new month starts, follow it.
  setInterval(() => {
    const t = new Date();
    if (dayKey(t) === renderedDay) return;
    const was = fromKey(renderedDay);
    if (view.year === was.getFullYear() && view.month === was.getMonth()) {
      view = { year: t.getFullYear(), month: t.getMonth() };
    }
    if (connected) loadEvents(); else renderMonth();
  }, 60 * 1000);
}
