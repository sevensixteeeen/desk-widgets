import { config } from "../config.js";

export function mountClock(root) {
  root.innerHTML = `
    <div class="clock">
      <div><span class="print"></span><span class="period"></span></div>
      <p class="clock-date"></p>
    </div>`;

  const time = root.querySelector(".print");
  const period = root.querySelector(".period");
  const date = root.querySelector(".clock-date");

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: config.hour12 });
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

  let last = "";
  function tick() {
    const now = new Date();
    // formatToParts splits "03:07 pm" into pieces so am/pm can be styled separately
    const parts = timeFmt.formatToParts(now);
    const hm = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    if (hm === last) return; // only touch the DOM when the minute changes
    last = hm;
    time.textContent = hm;
    period.textContent = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
    date.textContent = dateFmt.format(now);
  }

  tick();
  // Checking every second (instead of every 60s) keeps it correct after sleep/resume.
  setInterval(tick, 1000);
}
