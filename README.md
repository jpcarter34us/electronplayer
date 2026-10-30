# Audacious for Electron

A port of the [Audacious](https://audacious-media-player.org) media player and its plugins to Electron.

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

The status bar shows `libaudcore (plugin API …)` when the native engine is active. Without it the app falls back to the HTML5 stub, which plays MP3, FLAC, Ogg, Opus, WAV and AAC only.

## Touch Bar

On MacBook Pros with a Touch Bar, the app shows previous, play/pause and next buttons, the current song, a seek slider and a volume popover. The Touch Bar talks to libaudcore directly, so it appears only when the native engine is built, not with the HTML5 fallback.

## Menus, settings and plugins

With the native engine, the menu bar follows upstream Audacious: File, Playback, Playlist, Output and View.

- **Settings** (Cmd+, on macOS, File › Settings… elsewhere): Audio, Network, Playlist, Song Info, Plugins and Advanced pages. The Plugins page turns plugins on and off by type and opens each plugin's settings, which are generated from the plugin's own declarations.
- **Equalizer** (Output › Equalizer…, Cmd/Ctrl+E): 10 bands plus preamp, with presets saved to `eq.preset` like upstream.
- **Effects** (Output › Effects…): the Plugins page's Effect tab.
- **Visualizations** (View menu): Spectrum Analyzer, Blur Scope and VU Meter, drawn above the playlist.
