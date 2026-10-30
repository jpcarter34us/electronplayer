# ElectronPlayer

A music player for macOS (and, in time, Windows and Linux) built on the engine and plugins of the [Audacious](https://audacious-media-player.org) media player, ported to Electron. It also browses and plays Music Assistant and OpenSubsonic (Navidrome) libraries.

ElectronPlayer is an independent project, not affiliated with the Audacious developers.

The approach, the per-plugin porting matrix and the roadmap are in [docs/PORTING_PLAN.md](docs/PORTING_PLAN.md). In short, the real `libaudcore` engine and every non-GUI plugin run natively through an N-API addon. The GTK, Qt and Winamp-skin interfaces, visualizers and GUI-bound plugins are rewritten in HTML and TypeScript.

## Layout

| Path | What |
|---|---|
| `vendor/audacious`, `vendor/audacious-plugins` | Upstream sources (git submodules) |
| `scripts/build-audacious.sh` | Builds libaudcore + headless plugins into `vendor/prefix` |
| `native/` | N-API bridge to libaudcore (`audcore.node`); runs the engine on its own thread |
| `src/shared/` | Types shared by main and renderer: `AudBackend` (`backend.ts`) and settings widget trees (`prefs.ts`) |
| `src/main/` | Electron main process: native loader, menu bar (`menu.ts`), secondary windows (`windows.ts`), Touch Bar controls (`touchbar.ts`) |
| `src/preload/` | `contextBridge` API exposed to the UI |
| `src/renderer/` | UI. `backends/native.ts` talks to libaudcore over IPC; `backends/html5.ts` is the fallback when the addon isn't built. Settings (`settings.ts`), plugin settings (`prefs.ts`, drawn by `prefs-form.ts`), Equalizer (`equalizer.ts`) and visualizers (`visualizers.ts`). |

## Run

```bash
git submodule update --init --depth 1
npm install
npm start
```

To use the real Audacious engine (every format and plugin), build it once. The Homebrew packages it needs are listed at the top of `scripts/build-audacious.sh`.

```bash
npm run build:audacious
(cd native && npm install)
npm run build:native
npm start
```

The status bar shows `libaudcore (plugin API …)` when the native engine is active. (When run from source, macOS shows "Electron" in the Dock; a packaged build shows "ElectronPlayer".) Without it the app falls back to the HTML5 stub, which plays MP3, FLAC, Ogg, Opus, WAV and AAC only.

## Touch Bar

On MacBook Pros with a Touch Bar, the app shows previous, play/pause and next buttons, the current song, a seek slider and a volume popover. The Touch Bar talks to libaudcore directly, so it appears only when the native engine is built, not with the HTML5 fallback.

## Menus, settings and plugins

With the native engine, the menu bar follows upstream Audacious: File, Playback, Playlist, Output and View.

- **Settings** (Cmd+, on macOS, File › Settings… elsewhere): Audio, Network, Playlist, Song Info, Plugins and Advanced pages. The Plugins page turns plugins on and off by type and opens each plugin's settings, which are generated from the plugin's own declarations.
- **Equalizer** (Output › Equalizer…, Cmd/Ctrl+E): 10 bands plus preamp, with presets saved to `eq.preset` like upstream.
- **Effects** (Output › Effects…): the Plugins page's Effect tab.
- **Visualizations** (View menu): Spectrum Analyzer, Blur Scope and VU Meter, drawn above the playlist. With View › Show Visualizations in Separate Windows (also on the Settings › Plugins › Visualization tab), each one opens in its own resizable window instead. You can keep those windows on top of other apps; closing one turns that visualizer off, and their positions are remembered.

## Music Assistant

The app can browse and play a [Music Assistant](https://www.music-assistant.io) library, and act as a Music Assistant speaker.

1. Open **Settings › Music Assistant** and enter the server address (e.g. `192.168.1.20` or `http://homeassistant.local:8095`).
2. Sign in, as in the Music Assistant mobile app:
   - with your Music Assistant **username and password**, or
   - with **Sign in with Home Assistant…** (or another provider your server offers), which finishes in your browser.

   Either way the app keeps only a session token, encrypted in the macOS Keychain, never your password. Session tokens renew themselves while used and expire after 90 days at most; the app then asks you to sign in again. **Sign Out** revokes the session on the server. A pasted long-lived token still works, under "Use a long-lived token instead".
3. **File › Library…** (Cmd/Ctrl+Shift+M), or the ♫ button, opens the library: Artists, Albums, Tracks, Playlists, Radio, Podcasts, provider Browse and search. Each item has Play Now, Play Next and Add to Queue on the player chosen under **Play on**.

**This computer as a speaker (Sendspin).** On by default once a server is set. The app joins Music Assistant as a player (named "Audacious (your computer)") using [Sendspin](https://www.sendspin-audio.com), Music Assistant's synchronized streaming protocol. The first time, Music Assistant may ask to pair it: the app shows a 6-digit code in Settings and in the main window, which you enter in Music Assistant.

While Music Assistant plays here, the main window, the menus and the Touch Bar show and control its queue. Playing a local file pauses Music Assistant and hands control back.

Notes:
- Uses `@sendspin/sendspin-js` 5.0.0, the version Music Assistant's own web player uses. Music Assistant accepts it with its default **Allow legacy clients** setting; if you turn that off, this player (like the web player) can't connect.
- By default Music Assistant audio plays directly through Web Audio, bypassing Audacious. Turn on **Play through the Audacious engine** (Settings › Music Assistant, under "This computer as a speaker") to send it through the Audacious engine instead, so effects, the equalizer and visualizations apply. The app measures the engine's delay (about 70 ms) and feeds the audio that much early, keeping it in sync with your other Music Assistant speakers. It plays from a hidden playlist, so your own playlist is untouched. Music Assistant sends 16-bit audio to Sendspin players.

## OpenSubsonic (Navidrome and others)

**Settings › Subsonic**: enter the server address (e.g. `http://navidrome.local:4533`) with your username and password, or an API key if your server supports OpenSubsonic API keys (the app tells you when it does). Credentials are stored encrypted in the Keychain. Requests use the salted-token scheme, never the plain password.

In the Library window, switch the source to **Subsonic** for Artists, Albums, Recently Added, Playlists, Starred, Random Songs and search. Songs go into the Audacious playlist and play through the Audacious engine, so effects, the equalizer and visualizations apply. Plays are reported back to the server ("now playing", then a full play at half the song or 4 minutes).

Subsonic puts credentials in every stream URL, and Audacious saves playlist URLs to disk, so saved playlists hold local addresses (`http://127.0.0.1:<port>/subsonic/<key>/…`) and a small proxy in the app adds your credentials to each request. Saved Subsonic songs therefore play only while the app is running.

## Renamed from "Audacious for Electron"

Settings now live in `~/Library/Application Support/ElectronPlayer`. On first launch ElectronPlayer copies over the old `audacious-electron` folder (playlists, equalizer presets, Music Assistant and Subsonic settings) and leaves the original in place. Saved sign-ins can't be carried over, because they are encrypted with a Keychain key named after the app, so sign in to Music Assistant and Subsonic once more.
