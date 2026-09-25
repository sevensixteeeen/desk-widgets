# Desk Widgets

Desktop widgets for Windows 11: a clock, now playing, weather, and Google Calendar. Built with [Tauri 2](https://tauri.app) (Rust + HTML/CSS/JS).

![Preview](preview.png)

## Features

- **Now playing:** shows whatever is playing in Spotify, YouTube in Chrome, or any app that reports media to Windows, with play/pause/skip. No Spotify login needed.
- **Weather:** current conditions and the next 6 hours, from [Open-Meteo](https://open-meteo.com) (no API key).
- **Calendar:** month view plus upcoming events from every calendar ticked in your Google Calendar. Click a day or **+** to add an event.
- **Themed from your wallpaper:** colours are pulled from your current wallpaper and update when you change it.
- **Stays on the desktop:** behind your apps, and still visible after Win+D.
- **Tray menu:** Lock widgets (stops accidental dragging), Open at login, Quit.

## Project map

```
src/                   Frontend (plain HTML/CSS/JS, no bundler)
  config.js            Your settings: size, 12/24h, week start, °C/°F
  main.js              Picks the widget for each window; size, drag and lock
  theme.js             Turns the wallpaper into a colour palette
  api.js               Talks to Rust, or returns sample data in a normal browser
  styles.css           Design system and all widget styles
  widgets/*.js         One file per widget
src-tauri/
  tauri.conf.json      The 4 windows: start position, frameless, pinned to desktop
  src/lib.rs           Commands exposed to JS, tray menu, plugins, Win+D fix
  src/media.rs         Now playing (Windows media session API)
  src/gcal.rs          Google sign-in, reading and adding events
  src/wallpaper.rs     Reads the current wallpaper
  src/settings.rs      Saved settings (lock)
```

## Build it yourself

**Prerequisites:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++", [Rust](https://rustup.rs), and Node.js LTS.

```
npm install
npm run tauri dev      # run in development
npm run tauri build    # make an installer in src-tauri/target/release/bundle/
```

## Connect Google Calendar (optional)

The app needs your **own** Google OAuth client. None is included in this repo.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Calendar API**.
2. In **Google Auth Platform**, set the audience to **External** and add yourself as a test user.
3. Under **Data Access**, add the scopes `calendar.readonly` and `calendar.events`.
4. Under **Clients**, create a **Desktop app** client and download its JSON.
5. Save it as `%APPDATA%\com.deskwidgets.app\google_client.json`.
6. Click **Connect Google Calendar** in the widget.

To stay signed in for more than 7 days, publish the app from the **Audience** page. This needs a home page and a privacy policy on the **Branding** page. Don't upload a logo, because that triggers Google's verification review.

## Your data

Everything stays on your PC. The Google client file and sign-in token live in `%APPDATA%\com.deskwidgets.app\` and are never part of this repo. Calendar events go straight between your PC and Google. The weather widget sends only the city name you type to Open-Meteo.
