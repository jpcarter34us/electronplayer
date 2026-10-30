# Porting Audacious to Electron

Upstream snapshot surveyed: `audacious` @ 929e89d and `audacious-plugins` @ 419f26c (both 2026-10-19).

## 1. What Audacious actually is

Audacious is two repositories:

| Repo | Contents | License |
|---|---|---|
| `audacious` | `libaudcore` (engine, ~18k lines C++), `libaudtag`, `libaudgui` (GTK helpers), `libaudqt` (Qt helpers), `audtool`, the `audacious` launcher | BSD-2-Clause |
| `audacious-plugins` | ~95 plugin folders (decoders, outputs, effects, UIs, visualizers, …) | Mixed: BSD, GPL-2/3, LGPL per plugin |

`libaudcore` has no GUI dependency. The GUI is itself a plugin (`PluginType::Iface`: `gtkui`, `qtui`, `skins`, `skins-qt`), and Audacious can already run with no UI (`audacious --headless`). Plugin types defined in `libaudcore/plugins.h`:

`Transport · Playlist · Input · Effect · Output · Vis · General · Iface`

Plugin settings are declared in data (`PreferencesWidget` in `libaudcore/preferences.h`: Label, Button, CheckButton, RadioButton, SpinButton, Entry, FileEntry, ComboBox, Box, Table, Notebook, Separator, Custom). Because of that, an HTML renderer can generate most plugin settings dialogs from the same declarations GTK and Qt use. Only `Custom` widgets need hand-written ports.

## 2. Options

### Option A: Native bridge (recommended)
Compile `libaudcore` and every non-GUI plugin natively, without GTK or Qt (`-Dgtk=false -Dqt=false`). Load them in Electron's main process through a Node N-API addon (`native/`). Rewrite only the GUI layer in HTML, CSS and TypeScript.

- Keeps all ~30 input decoders, ~10 outputs, ~20 effects, transports and playlist formats bit-exact, with no rewrite.
- Audio runs natively (CoreAudio, PulseAudio, PipeWire, WASAPI via waveout/SDL), not through Chromium, so gapless playback, ReplayGain, the equalizer and resampling behave the same as upstream.
- Upstream fixes keep flowing in, because `vendor/` tracks the real repos.
- Cost: a C++ build toolchain per platform, plus `electron-rebuild` on Electron upgrades. GPL plugins make the shipped app GPL as a whole.

### Option B: Pure web rewrite
Re-implement the engine in TypeScript on Web Audio. Use Chromium codecs plus WASM builds of libopenmpt, libsidplayfp, adplug, etc.
- Single toolchain, could run in a browser.
- Very large effort: every niche format (PSF, xSF, VTX, AdPlug, SID, MIDI) has to be ported to WASM one at a time. Gapless playback and output-plugin behaviour diverge from upstream, and you end up maintaining a fork of everything.

### Option C: Sidecar process
Run stock `audacious --headless` as a child process and drive it over D-Bus or `audtool`.
- Fastest to prototype.
- D-Bus is awkward on macOS and Windows. Visualizer PCM data and plugin settings are not exposed over the bus. Two processes to package.

**Decision: Option A**, with a **TypeScript `AudBackend` interface** in front of it. A temporary HTML5-audio backend implements the same interface, so UI work can start now, before the native build works.

## 3. Target architecture

```
┌──────────────── Electron renderer (HTML/TS) ────────────────┐
│  Iface ports: "Modern" (gtkui/qtui) · "Classic" (Winamp     │
│  skins)  ·  Vis ports (canvas/WebGL)  ·  General-plugin UIs │
│  Auto-generated prefs dialogs from PreferencesWidget JSON   │
└──────────────▲───────────────────────────────┬──────────────┘
               │ contextBridge (preload)       │ IPC
┌──────────────┴───────────────────────────────▼──────────────┐
│ Electron main process                                        │
│  AudBackend ──► native addon (N-API)  ─or─  Html5Backend     │
└──────────────────────────────▲──────────────────────────────┘
                               │ C++
┌──────────────────────────────┴──────────────────────────────┐
│ libaudcore + libaudtag  (vendor/audacious, built w/o GTK/Qt) │
│ Input/Output/Effect/Transport/Playlist/headless General      │
│ plugins (vendor/audacious-plugins)                           │
└─────────────────────────────────────────────────────────────┘
```

The addon's responsibilities:
1. **Main loop**: libaudcore expects a GLib or Qt main loop (`mainloop.cc`). Run a GLib loop on a dedicated thread, and forward hooks (`playback begin`, `title change`, `playlist update`, …) to JS with `Napi::ThreadSafeFunction`.
2. **API surface**: wrap `aud_drct_*` (play, pause, stop, seek, volume, `pl_next`/`prev`, …), `Playlist` (add, remove, sort, queue, tuples), `aud_get/set_*` config, the equalizer, and the plugin registry (enumerate, enable, `get_prefs`).
3. **Vis data**: register a `Visualizer` that copies MonoPCM, MultiPCM and Freq frames into a `SharedArrayBuffer` or transferable buffer for the renderer.
4. **Prefs**: serialize each plugin's `PluginPreferences` tree to JSON, and route widget changes back to `aud_set_*` and the plugin's callbacks.

## 4. Plugin porting matrix

Legend: **N** = runs unchanged in the native core · **W** = needs a web UI rewrite · **R** = replaced by Electron/OS facility · **D** = drop or defer

### Input (decoders): all N
aac, adplug, amidiplug, cdaudio, console (GME), ffaudio, flac, metronom, modplug, mpg123, openmpt, opus, psf, sid, sndfile, tonegen, vorbis, vtx, wavpack, xsf

### Output
| Plugin | Status |
|---|---|
| coreaudio (macOS), pulse, pipewire, alsa, jack, oss4, sndio, sdlout, waveout (Windows), filewriter | N (per-platform build) |
| qtaudio | D (Qt-only; SDL/waveout cover it) |

### Effect: all N
background_music, bitcrusher, bs2b, compressor, crossfade, crystalizer, echo_plugin, ladspa, mixer, resample, silence-removal, soxr, speedpitch, stereo_plugin, voice_removal

### Transport / Playlist formats: all N
gio\*, mms, neon · asx, asx3, audpl, cue, m3u, pls, xspf
<br>\*gio needs GLib's GIO, which we already ship for the main loop.

### Interface (Iface): all W
| Upstream | Electron port |
|---|---|
| gtkui / qtui | "Modern" UI: playlist tabs, info bar, toolbar, menus (shared with `ui-common`) |
| skins / skins-qt (+ skins-data) | "Classic" UI: Winamp 2.x `.wsz` skin renderer on canvas/DOM. Skin parsing and layout are pure data, so they port directly. |

### Visualization (Vis): all W, fed by the addon's vis buffer
blur_scope(-qt), cairo-spectrum / qt-spectrum, glspectrum / qtglspectrum (WebGL), vumeter(-qt)

### General
| Plugin | Status | Notes |
|---|---|---|
| ampache, cd-menu-items, delete-files, scrobbler2, songchange, streamtuner (data side), lirc | N | headless logic; menu items surface through the addon |
| mpris2 | N (Linux) | |
| mac-now-playing | N | Loads and runs on the engine thread as-is (phase 1) |
| hotkey / qthotkey | R | Electron `globalShortcut` + media keys |
| statusicon(-qt) | R | Electron `Tray` |
| notify, aosd | R | Electron `Notification`; aosd → transparent overlay window |
| albumart(-qt), lyrics-gtk/qt (+lyrics-common), song-info-qt, playback-history(-qt), playlist-manager(-qt), search-tool(-qt), filebrowser(-qt) | W | Port the views; the logic is small, and lyrics fetch logic in `lyrics-common` can be reused or rewritten in TS |

Totals: ~65 plugins run unchanged natively, ~25 need a web UI, ~8 map to Electron APIs.

## 5. Phased roadmap

| Phase | Goal | Exit criteria |
|---|---|---|
| 0. Scaffold *(done in this repo)* | Electron + TS app, `AudBackend` interface, HTML5 stub backend, upstream vendored as submodules | `npm start` plays local files |
| 1. Native core *(done on macOS)* | `scripts/build-audacious.sh` builds libaudcore + headless plugins into `vendor/prefix`; the addon links it and plays a file | `NativeBackend` passes the same smoke test as `Html5Backend` |
| 2. Modern UI | Playlists, multiple tabs, queue, search, equalizer, menus; prefs dialogs generated from JSON | Feature parity with gtkui main window |
| 3. Platform integration | Tray, global hotkeys, notifications, MediaSession/MPRIS, file associations, drag and drop | |
| 4. Vis + General UIs | Spectrum, scope, VU, album art, lyrics, song info, history, playlist manager, file browser | |
| 5. Classic skins | `.wsz` loader, main/EQ/playlist windows, shade mode, docking | Default skins from `skins-data` render pixel-correct |
| 6. Packaging | electron-builder for macOS (universal), Windows, Linux; bundle plugins and dylibs; codesign | Installable artifacts from CI |

## 6. Phase 1 results (macOS, x86_64)

- Audacious 4.6.2 core and 50 plugins build with `-Dgtk=false -Dqt=false`. Present: 18 input, 14 effect, 3 output (coreaudio, sdlout, filewriter), 2 transport, 7 playlist formats and 3 general plugins. adplug and cdaudio are skipped because their libraries aren't installed; the Linux-only outputs drop out on their own.
- The addon (`native/src/addon.cc`) runs `aud_init()` and `aud_run()` headless on an engine thread that owns the GLib main loop. JS calls are queued onto that thread and return Promises. Hooks come back as `BackendEvent`s through one `ThreadSafeFunction`.
- Verified end to end in Electron: add, play, pause, position updates, plugin listing, a clean shutdown that saves config, and playlist restore on the next launch.

Findings:
- **Install-path relocation.** libaudcore rewrites its plugin directory relative to the running executable (`set_install_paths` in `runtime.cc`). From `/usr/local/bin/node` it resolved to `/usr/local/lib/audacious`, a Homebrew Audacious install, and loaded incompatible plugins. Under Electron (`Electron.app/Contents/MacOS`) no rewrite happens, but packaging has to choose a layout on purpose, or upstream needs a plugin-dir override.
- **Config isolation.** The addon sets `XDG_CONFIG_HOME` to Electron's `userData`, so a regular Audacious install's config and playlists stay untouched.
- **First load.** The first-ever `init()` (macOS checking 50 newly built dylibs) took longer than 20 s once. Later starts take about 3 s.
- **Deployment target.** Homebrew dylibs target the host macOS version. Shipping to older macOS needs dependencies built with `MACOSX_DEPLOYMENT_TARGET`.

## 7. Risks and open questions
- **Linux main loop**: the GLib backend uses the *global default* `GMainContext` (`g_timeout_add_full` in `mainloop.cc`). On Linux, Chromium's UI thread also uses that context, so the engine thread would compete with it. Plan: an upstream patch so libaudcore uses its own context (or a libuv `MainloopType`).
- **Licensing**: shipping GPL plugins (e.g. ffaudio, sid, adplug) makes the distributed app GPL. Decide on the license for this repo early.
- **Windows build**: upstream's Windows build uses MSYS2/MinGW. The addon must then be built with the same toolchain, or the core must be loaded dynamically through a C shim to avoid C++ ABI mismatches.
- **GLib dependency**: libaudcore uses GLib in places (main loop, GIO, charset), so the app has to ship GLib.
- **Electron upgrades**: pin the Electron version and use N-API (ABI-stable) to keep rebuilds rare.
