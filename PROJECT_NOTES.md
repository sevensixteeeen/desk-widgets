# Desk Widgets: Project Notes

Everything important about how this project works, why it's built this way, and how to maintain it.

---

## 1. Overview

**Desk Widgets** is a Windows 11 desktop app that shows four widgets directly on the desktop:

| Widget | What it shows | Data source |
|---|---|---|
| **Clock** | Time and date | System clock |
| **Now playing** | Current song, album art, progress, play/pause/skip | Windows media session API |
| **Weather** | Temperature, conditions, high/low, next 6 hours | Open-Meteo (free, no API key) |
| **Calendar** | Month view with navigation, upcoming events, add events to any of your calendars | Google Calendar API |

- **Repo:** https://github.com/sevensixteeeen/desk-widgets
- **Privacy/terms site (for Google):** https://sevensixteeeen.github.io/desk-widgets-site/

---

## 2. Features

- Widgets sit **behind all apps** on the desktop and **survive Win+D** (Show desktop).
- **Colours come from your wallpaper** and update automatically when the wallpaper changes.
- **Now playing** works with Spotify, YouTube in Chrome, or any app that reports media to Windows, with no login.
- **Calendar** shows events from every calendar ticked in the Google Calendar sidebar (holidays, shared, work). Each event has a dot in its calendar's colour.
- **Browse months** with ‹ ›, or the mouse wheel over the dates; **Today** jumps back.
- **Add events** from the desktop: click a day or **+**, pick which calendar, and leave the time empty for an all-day event.
- **Tray menu:** Show widgets (tick/untick each one), Lock widgets, Open at login, Quit.
- **Ctrl+Alt+L** locks/unlocks dragging from anywhere, with a brief "Locked"/"Unlocked" message.
- **Drag to move.** Positions are remembered.
- **One setting resizes everything** (`scale` in `config.js`).

---

## 3. Tech stack and why

| Choice | Why |
|---|---|
| **Tauri 2** | Uses about 150–250 MB of RAM, versus 400–600 MB for Electron. The UI is still plain HTML/CSS. |
| **Rust backend** | Direct access to Windows APIs (media, window ownership) and reliable background work. |
| **Plain HTML/CSS/JS, no bundler** | Nothing to compile on the frontend; `withGlobalTauri` exposes `window.__TAURI__`. |
| **WebView2** | Built into Windows 11, so nothing extra to install. |
| **Open-Meteo** | Free, no API key, supports browser requests directly. |
| **Archivo (variable font)** | Width axis from 62% to 125%. Expanded for the big numbers, condensed for the month name. Bundled locally, so it works offline. |

Options considered and rejected: **Electron** (too heavy for always-on widgets) and **Python + PySide6** (glass/blur styling is harder and it's less polished).

---

## 4. Architecture

```
┌──────────────────────── Tauri app (one process) ────────────────────────┐
│                                                                          │
│  Rust core (src-tauri/src)                                               │
│   ├─ media.rs      → Windows media session (now playing, controls, art)  │
│   ├─ gcal.rs       → Google sign-in, list calendars, read/add events     │
│   ├─ wallpaper.rs  → reads the current wallpaper file                    │
│   ├─ settings.rs   → saved settings (lock, hidden widgets)               │
│   └─ lib.rs        → commands, tray menu, shortcut, plugins, Win+D fix   │
│                                                                          │
│  4 windows (WebView2), all loading src/index.html                        │
│   clock │ nowplaying │ weather │ calendar                                │
│   main.js reads the window's *label* and mounts that widget              │
└──────────────────────────────────────────────────────────────────────────┘
```

**JS ↔ Rust communication:**

- **JS → Rust:** `invoke("command_name", { args })`. Commands are defined with `#[tauri::command]` in `lib.rs`. JS camelCase arguments map automatically to Rust snake_case (`timeMin` → `time_min`).
- **Rust → JS:** `app.emit("event-name", payload)`, received in JS with `onEvent(...)` (e.g. `lock-changed`).
- **Rust only:** the tray menu, showing/hiding windows and the global shortcut never touch JS; Rust handles them directly.

**One page, four windows:** every window loads the same `index.html`. `main.js` checks the window's label (set in `tauri.conf.json`) and runs the matching widget's `mount` function.

---

## 5. Project structure

```
desk-widgets/
├─ src/                         Frontend
│  ├─ index.html                Shared page for every widget window
│  ├─ main.js                   Widget selection, size (zoom), drag, lock
│  ├─ api.js                    invoke / events / window helpers + sample data for browser preview
│  ├─ config.js                 User settings (scale, 12/24h, week start, units)
│  ├─ theme.js                  Wallpaper → colour palette
│  ├─ styles.css                Design system and all widget styles
│  ├─ fonts/archivo.woff2       Bundled variable font (+ licence)
│  └─ widgets/
│     ├─ clock.js
│     ├─ nowplaying.js
│     ├─ weather.js
│     └─ calendar.js
├─ src-tauri/
│  ├─ tauri.conf.json           Window definitions, app identifier, bundle config
│  ├─ Cargo.toml                Rust dependencies
│  ├─ capabilities/default.json Which Tauri APIs the JS side may use
│  ├─ icons/                    App icons (generated with `npx tauri icon`)
│  └─ src/
│     ├─ main.rs                Entry point (hides the console in release builds)
│     ├─ lib.rs
│     ├─ media.rs
│     ├─ gcal.rs
│     ├─ wallpaper.rs
│     └─ settings.rs
├─ .gitignore
├─ README.md
└─ package.json                 Only the Tauri CLI
```

---

## 6. How each part works

### Window setup (`tauri.conf.json`)

Each widget window is `decorations: false` (no frame), `transparent: true`, `shadow: false`, `resizable: false`, `skipTaskbar: true` (no taskbar button), `alwaysOnBottom: true` (behind other apps) and `visible: false`. Windows start invisible; at startup Rust shows only the ones you haven't hidden, so hidden widgets never flash on screen.

### Win+D fix (`lib.rs → pin_to_desktop`)

Win+D minimizes every normal window. Windows **owned by the desktop** (`Progman`, the system window that draws desktop icons) count as part of the desktop and stay visible. On startup, each widget's owner is set to `Progman` with `SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, progman)`.

### Size (`config.js → scale`, `main.js`)

Widgets are designed at full size. `main.js` applies CSS `zoom: scale` to the page and resizes the window by the same factor, so one number resizes everything. Current value: `0.78`.

### Lock (`lib.rs → toggle_lock`, `settings.rs`, `main.js`)

Two ways in, one function: the tray's **Lock widgets** item and the global shortcut **Ctrl+Alt+L** both call `toggle_lock()`, which flips `locked` in `settings.json`, updates the tray tick, and emits `lock-changed`. Every widget then ignores drag attempts.

- **Global shortcut:** `tauri-plugin-global-shortcut`, registered in Rust at startup with `on_shortcut(LOCK_SHORTCUT, ...)`. The handler acts only on `ShortcutState::Pressed` (Windows reports press and release). The library registers with Windows' no-repeat flag, so holding the keys doesn't flicker the lock.
- **If the shortcut is taken** by another app, registering fails; the error is logged and the app carries on (the tray item still works).
- **Feedback:** on `lock-changed`, each widget shows a "Locked"/"Unlocked" toast for 1.2 s. The toast sits on `<body>`, outside the card, so a widget redrawing its card can't remove it. No toast at startup.
- **Cursor:** ✥ move when unlocked, a normal arrow when locked. Dragging is started from JS with `startDragging()` on `mousedown`, skipping buttons and inputs.

### Show / hide widgets (`lib.rs → toggle_widget`, `settings.rs`)

- Tray → **Show widgets** submenu, one tickbox per widget. The list lives in one constant, `WIDGETS` (label + menu name), so a new widget is a one-line addition.
- Menu item ids are `show:<label>` (e.g. `show:weather`). The click handler uses `strip_prefix("show:")`, so one piece of code handles every widget.
- `toggle_widget()` calls `window.hide()` / `window.show()` and keeps the list of hidden labels in `settings.json` (`"hidden": ["weather"]`), so the choice survives restarts.
- Hidden widgets are hidden, not closed: their pages keep running in the background.

### Now playing (`media.rs`, `nowplaying.js`)

- Uses the **Global System Media Transport Controls** (the same API as the Windows volume-key media flyout).
- WinRT calls block, so the commands run inside `spawn_blocking` to keep the main thread free.
- Apps report playback position only occasionally, so Rust adds the time elapsed since `LastUpdatedTime`, and JS interpolates between polls. Result: a smooth progress bar.
- JS polls every 1.5 s and fetches album art only when the track changes.
- The album art is shown as a duotone in the two theme inks; hover to see the original.

### Weather (`weather.js`)

- The city is typed once, geocoded with Open-Meteo, and saved to `localStorage`. Click the city name to change it.
- Refreshes every 15 minutes.
- Weather codes (WMO) are mapped to words.

### Calendar (`gcal.rs`, `calendar.js`)

- **Sign-in:** the OAuth "loopback" flow for desktop apps with **PKCE**. Rust starts a temporary local server on `127.0.0.1:<random port>`, opens Google sign-in in the browser, catches the returned `code`, and exchanges it for a **refresh token**. PKCE plus a random `state` value stop an intercepted code from being used by anyone else.
- **Reading:** lists all calendars (`calendarList`, via the shared `calendar_list()` helper), keeps the ones that are `selected` (ticked in Google Calendar) and not hidden, then fetches events from each one. A calendar that fails is skipped rather than breaking the whole widget. JS sorts the merged list.
- **Month navigation:** JS keeps the month on screen (`view`) separate from today.
  - The **upcoming list** always starts from today, whatever month you're viewing.
  - Each refresh makes one request covering the current month's grid plus the next 45 days, for both the grid dots and the upcoming list.
  - **Other months** are fetched only when you open them, then cached (`monthCache`). A short 250 ms wait means clicking › five times quickly fetches one month, not five.
  - Everything is re-fetched every 10 minutes and after adding an event, so the cache never goes stale.
  - At midnight, if you were on the current month and a new month starts, the view follows.
- **Header:** two lines, with the year and a **Today** button (visible only on other months) above the month name and the ‹ › + controls.
- **Adding:**
  - `gcal_calendars` returns the calendars you can write to (`accessRole` owner or writer, ticked in the sidebar), with your main calendar first.
  - The form shows a picker with the calendar's colour dot, only when there's more than one. Your last choice is remembered in `localStorage`; the first time, your main calendar is chosen.
  - `create_event` posts to the chosen calendar ID. IDs contain `@` and `#`, so the URL is built with `path_segments_mut()`, never by pasting text together.
  - All-day events use `{"date"}` with the end date set to the **next day** (Google treats the end date as exclusive). Timed events use `{"dateTime"}`.
  - The duration box says **All day** until a time is typed. The message line (saving, errors) only appears when needed, stays on one line, and shows the full text on hover.
- **Size:** the calendar widget is 320×490 before scaling, tall enough that the add form and an error line always fit.
- **Scope versioning:** the saved token records `scope_version`. When scopes change (v1 read-only → v2 read + add), the widget shows **Reconnect** instead of failing.
- An expired or revoked sign-in (`invalid_grant`) deletes the token and asks you to connect again.
- Event titles and calendar names are inserted as plain text (`textContent`, `new Option(name, id)`), never with `innerHTML`, so they can't inject HTML.

### Wallpaper theme (`wallpaper.rs`, `theme.js`)

1. Rust reads Windows' copy of the current wallpaper at `%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper` and returns it only if its modified time changed (cheap to poll).
2. JS shrinks it to 160×90 px on a canvas.
3. **Average brightness** decides dark or light cards.
4. **Average colour** tints the cards.
5. Vivid pixels are grouped into 36 hue buckets. The strongest becomes **ink A**, and the strongest hue at least 50° away becomes **ink B**.
6. Lightness is fixed per mode, so text stays readable on any wallpaper.
7. It checks every 30 s and caches the palette in `localStorage` to avoid a colour flash on startup.

### Autostart (`lib.rs`)

`tauri-plugin-autostart` adds or removes the app in the Windows startup list. Tray → **Open at login**. Turn it on in the **installed** app only; in dev mode it would register the temporary debug build.

---

## 7. Design system

**Concept: two-ink print.** The big numbers (time, temperature) are printed twice, in ink A and ink B, slightly off-register. That offset is the one bold element; everything else stays quiet.

| CSS variable | Role |
|---|---|
| `--paper` | Card background (slightly transparent when themed) |
| `--paper-solid` | Same colour, opaque (text on accent fills) |
| `--ink` | Main text |
| `--muted` | Secondary text |
| `--accent-a` | Ink A: big numbers, buttons, today |
| `--accent-b` | Ink B: off-register copy, bars, event dots |
| `--blend` | How the inks mix (`multiply` on light, `screen` on dark) |
| `--rule` | Hairlines (ink at 15%) |

- Default (no wallpaper): cool paper `#eceef0`, riso blue `#0078bf`, fluorescent pink `#ff48b0`.
- On dark themes, ink B is placed **behind** ink A instead of blended, because blended inks wash out on dark cards.
- Paper texture: an SVG noise layer with `mix-blend-mode: overlay`, which works on both light and dark cards.

**Typography:** Archivo only. 800 weight at 125% width for big numbers; 62% width for the month name; regular widths for text.

---

## 8. Configuration

**`src/config.js`** (restart the app after changing):

| Setting | Current | Meaning |
|---|---|---|
| `scale` | `0.78` | Widget size (1 = original) |
| `hour12` | `false` | 12h or 24h clock |
| `weekStartsOn` | `1` | 0 = Sunday, 1 = Monday |
| `temperatureUnit` | `"celsius"` | or `"fahrenheit"` |
| `upcomingEvents` | `3` | Events listed under the calendar |

**Lock shortcut:** `LOCK_SHORTCUT` at the top of the Lock section in `src-tauri/src/lib.rs` (default `"ctrl+alt+L"`). It's registered in Rust at startup, so it lives there rather than in `config.js`; change it, then rebuild. Also update the menu label text (`Some("Ctrl+Alt+L")`) to match.

**`%APPDATA%\com.deskwidgets.app\settings.json`** (written by the app): `locked` and `hidden` (list of hidden widget labels).

**`src-tauri/tauri.conf.json`:** window labels, default positions, and base window sizes (already multiplied by `scale`). App identifier: `com.deskwidgets.app`. Don't change the identifier; it decides the AppData folder where the Google files live.

---

## 9. Data and file locations

| What | Where | In Git? |
|---|---|---|
| Google OAuth client | `%APPDATA%\com.deskwidgets.app\google_client.json` | **Never** |
| Google sign-in token | `%APPDATA%\com.deskwidgets.app\google_token.json` | **Never** |
| Settings (lock, hidden widgets) | `%APPDATA%\com.deskwidgets.app\settings.json` | No |
| Widget positions | Saved by the window-state plugin in the app's config folder | No |
| Weather city, theme cache, last calendar used | WebView `localStorage` | No |

- Dev mode and the installed app have **separate `localStorage`**, so the weather city has to be entered once in each. Files in `%APPDATA%` are shared.
- `.gitignore` blocks `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `google_client.json`, `google_token.json`, `client_secret*.json`, `.env*`, `settings.json`, and editor clutter.

---

## 10. Google Cloud setup

**Google Cloud project:** Calendar API enabled. The API is free and no billing account is needed.

**Google Auth Platform:**

| Page | Setting |
|---|---|
| Branding | App name "Desk Widgets", home page, privacy policy and terms links (below). **No logo.** |
| Audience | External, **published (In production)** |
| Data Access | `.../auth/calendar.readonly` and `.../auth/calendar.events` |
| Clients | Desktop app client, whose JSON was downloaded as `google_client.json` |

**Branding links** (hosted on GitHub Pages from the `desk-widgets-site` repo):

- Home: `https://sevensixteeeen.github.io/desk-widgets-site/`
- Privacy: `https://sevensixteeeen.github.io/desk-widgets-site/privacy.html`
- Terms: `https://sevensixteeeen.github.io/desk-widgets-site/terms.html`
- Authorized domain: `sevensixteeeen.github.io`

**Lessons learned:**

- In **Testing** mode, refresh tokens expire after **7 days**. Publishing fixes that.
- **Publishing requires** a home page, privacy policy and authorized domain on the Branding page.
- **Uploading a logo triggers brand verification.** Leave it empty.
- The **"Google hasn't verified this app"** screen is expected for a personal app: Advanced → Go to Desk Widgets.
- On the permission screen, **tick every checkbox**, because Google lets you grant scopes one by one.
- If the scopes change, update the **privacy page** too. It must describe what the app actually does.

---

## 11. Development workflow

Run from the project root (the folder with `package.json`):

```powershell
npm install            # once, installs the Tauri CLI
npm run tauri dev      # run with auto-rebuild
npm run tauri build    # release build + installers
cargo fmt              # (inside src-tauri) format Rust code
```

- **Frontend changes:** click a widget and press `Ctrl+R` to reload it.
- **Rust changes:** rebuild automatically in dev mode.
- **Dev tools:** right-click a widget → **Inspect** (dev mode only).
- **Design in a normal browser:** serve `src/` with any static server and open `index.html?w=clock` (or `nowplaying`, `weather`, `calendar`). `api.js` fills in sample data. Add `&wp=image.jpg` to test the wallpaper theme with any image.

**Prerequisites on a new PC:** Visual Studio Build Tools with **Desktop development with C++**, Rust (`rustup`), and Node.js LTS.

---

## 12. Build, install and update

1. `npm run tauri build` (5–15 minutes).
2. The installer is at `src-tauri\target\release\bundle\nsis\Desk Widgets_0.1.0_x64-setup.exe` (an MSI is also made in `bundle\msi\`).
3. Run it. On **"Windows protected your PC"** (the app isn't code-signed), click **More info → Run anyway**.
4. Tray → tick **Open at login**.

**Updating:** change the code → build → run the new installer (it replaces the old one). Bump `version` in `tauri.conf.json` and `Cargo.toml` for clarity.

Don't run `npm run tauri dev` while the installed app is open, or you'll get two sets of widgets.

---

## 13. Git and GitHub

- The app repo is `sevensixteeeen/desk-widgets`, which is separate from `desk-widgets-site` (the privacy site). **Never push the app into the site repo.**
- Commit and push changes:

```powershell
git add .
git commit -m "Describe the change"
git push
```

- **Check for secrets before pushing:**

```powershell
git grep --cached -n -e "GOCSPX" -e "apps.googleusercontent.com" -e "gmail.com"
```

  No output means it's clean. `GOCSPX` is the prefix of Google client secrets.

---

## 14. Sharing with other Windows users

**Send the installer** (`Desk Widgets_0.1.0_x64-setup.exe`, about 3 MB) by Drive, WhatsApp, USB, or zipped by email. Better: attach it to a **GitHub Release** on the repo and share the link, so every version lives in one place.

**What the other person does:**

1. Run the installer. On SmartScreen, click **More info → Run anyway**.
2. Open **Desk Widgets** from the Start menu.
3. Tray → **Open at login** (optional).
4. Type their city into the weather widget.

**Requirements:** 64-bit Windows 10 or 11. Windows 11 already has WebView2; on Windows 10 the installer downloads it if missing (needs internet).

**Calendar for other people:**

| Option | How | Trade-off |
|---|---|---|
| **A. Share your client file** | Send `google_client.json` **privately** (never in a public release). They save it to `%APPDATA%\com.deskwidgets.app\` and sign in with their own Google account. | They see the "unverified app" screen. Each person counts toward Google's 100-user limit for unverified apps. Only share with people you trust. |
| **B. Their own client** | They follow the Google Cloud setup in the README. | Fully independent, but about 20 minutes of setup. |

Each person's calendar data goes directly between their PC and Google; nobody else can see it.

**Keep in mind:** the app is only tested on one PC (Windows 11, single monitor), and updates are manual. They run the new installer, which replaces the old version.

---

## 15. Troubleshooting (issues already hit and fixed)

| Symptom | Cause | Fix |
|---|---|---|
| `npm install` → ENOENT package.json | Terminal in the wrong folder (zip extracted into a nested folder) | `cd` into the folder that contains `package.json` |
| `cargo metadata … program not found` | Rust not installed, or terminal opened before installing | Install Rust, then restart VS Code |
| winget Build Tools "exit code 1" | Already installed; the upgrade failed | Visual Studio Installer → Modify → tick **Desktop development with C++** |
| Widgets not visible | Win+D or Show desktop hides them; they sit behind other windows | Minimize apps normally (fixed permanently by the Win+D fix) |
| ♪ icon shown over album art | CSS `display` overrode the `hidden` attribute | `[hidden] { display: none !important; }` |
| Google "Publish app" greyed out | Branding page incomplete | Add home page, privacy, terms and authorized domain |
| Branding verification issues | A logo was uploaded, and the home page didn't exist yet | Remove the logo; publish the GitHub Pages site |
| `git push` → Repository not found | The GitHub repo hadn't been created | Create it at github.com/new (no README), push again |
| VS Code opens the `.exe` as text | VS Code can't run programs | Run it from the terminal with `& ".\path\to\setup.exe"` or from File Explorer |
| Rust error "`X` is defined multiple times" / "redefined here" | Pasted new code next to the old code instead of replacing it | Delete the duplicate; use **Ctrl+Shift+O** in VS Code to spot items listed twice |
| A new feature does nothing | Edits weren't saved (white dot on the tab), or were made in another copy of the project | Save all (**Ctrl+K, S**); check the tab's path is the inner `desk-widgets\desk-widgets` folder |

---

## 16. Known limitations

- **Windows only:** the media API, Win+D fix and wallpaper path are Windows-specific.
- The upcoming list looks 45 days ahead; events further out only show as dots when you navigate to that month.
- Changing the lock shortcut means editing `lib.rs` and rebuilding (there's no settings window).
- Hidden widgets keep running in the background (their windows are hidden, not closed).
- The wallpaper is re-read as a full image when it changes, which causes a brief memory spike.
- The installer is **unsigned**, so SmartScreen shows a warning on install.

---

## 17. Performance

Typical RAM is **~150–250 MB** in total: Rust core ~10–20 MB, WebView2 shared processes ~60–100 MB, and ~20–40 MB per widget.

This is normal as long as it stays **flat over time**. If it climbs by hundreds of MB over a day, that's a leak worth investigating.

Options if you want it lower:

| Option | Effect |
|---|---|
| Resize the wallpaper in Rust before sending it to JS | Removes the spike when the wallpaper changes; worth doing |
| Poll now-playing every 3 s instead of 1.5 s | Less CPU |
| Merge all widgets into one window | ~30–40% less RAM, but much more complex |

---

## 18. Decisions made along the way

- **Design:** deliberately *not* a macOS copy. It started as a light risograph look and became wallpaper-adaptive.
- **Alarms and DND:** built, then dropped, because Windows' own Clock app and Focus already do this well.
- **Brand verification:** skipped; the app is for personal use.
- **Code-signing:** skipped. It only removes the SmartScreen warning for people downloading the installer, which doesn't matter for personal use. Revisit only if the app is ever distributed widely.
- **Dark themes:** ink B sits behind ink A instead of blending, for crisp numbers.
- **Calendar header on two lines:** "September 2027" plus five controls didn't fit in one line of a 250 px-wide card.
- **Shared functions for shared actions:** the tray item and the shortcut both call `toggle_lock()`; `events()` and `calendars()` both use `calendar_list()`.
- **Learning approach:** later features were built partly by hand (typing the change, then a line-by-line review) to learn Rust and Tauri, not just copy code.

---

## 19. Changelog

| Date | Change |
|---|---|
| 2026-09-25 | First version: 4 widgets, wallpaper theme, lock, Win+D fix, Google Calendar read + add, installer, autostart |
| 2026-09-27 | Calendar month navigation (‹ ›, mouse wheel, Today) |
| 2026-09-28 | Show/hide widgets from the tray, calendar picker for new events, lock shortcut (Ctrl+Alt+L) with toast |

## 20. Ideas for later

- **Next:** resize the wallpaper in Rust before sending it to JS (removes the memory spike). Planned as a hands-on lesson with the `image` crate.
- Poll now-playing less often if CPU use matters.
- Use it for a few days and note what's missing, before adding new widgets.

## 21. If it ever becomes a product

Not planned right now; these notes are here so the thinking isn't lost.

**Market:** crowded with free options (Rainmeter, Lively Wallpaper, free Microsoft Store widget apps, Windows' own Widgets board). People do pay for polished desktop customization (Wallpaper Engine on Steam). The differentiator would be zero-config polish: wallpaper-adaptive themes, now playing with any app, a two-way calendar, low RAM.

**Blockers before selling:**

- A settings window (no editing `config.js`).
- Google OAuth verification (`calendar.events` is a sensitive scope; unverified apps are capped at 100 users).
- Open-Meteo's free tier is non-commercial; a paid app needs their commercial plan or another provider.
- Code-signing or Microsoft Store distribution, so there's no SmartScreen warning.
- Auto-updates (Tauri updater plugin).
- Testing on Windows 10, multiple monitors and different display scaling.
- Don't market it as a "Spotify widget" (trademark); say "works with any music app".

**Best-fit model:** freemium with a one-time Pro unlock (~$3–5), or one-time paid on Steam or the Microsoft Store. Subscriptions are a poor fit.

**Steam basics:** Steamworks signup, $100 fee per app (returned after $1,000 in sales), tax/bank/identity paperwork, a waiting period of roughly 3–4 weeks after paying, a public Coming Soon page for at least 2 weeks, 3–5 business days of review per submission, and Steam keeps 30% of sales. Register as **Software** and upload the built app folder with SteamPipe, not the installer.

**Validate first:** record a 30-second demo (changing the wallpaper and the widgets recolouring), post it to r/desktops, r/Windows11 and r/Rainmeter with a waitlist link (or use Steam wishlists), and set a threshold in advance, such as 300+ signups in 2 weeks.
