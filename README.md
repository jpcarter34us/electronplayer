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
| `docker/`, `patches/` | Build containers for the Linux and Windows packages; patches applied to `vendor/` by `scripts/apply-patches.sh` |
| `resources/` | App icon: `icon.svg` (source), `icon.icns` and `icon.png` (made by `npm run icon`) |
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

## Building the app (macOS)

```bash
npm run dist:mac
```

This builds both architectures into `release/`:

| | Apple Silicon | Intel |
|---|---|---|
| App | `release/mac-arm64/ElectronPlayer.app` | `release/mac/ElectronPlayer.app` |
| Installer | `ElectronPlayer-<version>-arm64.dmg` / `.zip` | `ElectronPlayer-<version>-x64.dmg` / `.zip` |
| Needs | macOS 15 or later | macOS 26 or later (see below) |

For one architecture only, run `npm run dist:mac:arm64` or `npm run dist:mac:x64`. Prerequisites are the same as for building the engine from source: Xcode command line tools, Homebrew, and the packages listed in `scripts/build-audacious.sh`. `scripts/package-mac.sh` runs these steps for each architecture:

1. Builds the TypeScript and the renderer bundles.
2. `scripts/build-engine-bundle.sh <arch>` builds libaudcore, the plugins and the native addon again, laid out as they sit inside the app (`Contents/Frameworks/engine`). libaudcore's own install-path relocation then finds its plugins in whichever `.app` it runs from, with no change to Audacious's path code.
3. `scripts/bundle-dylibs.py` copies the Homebrew libraries the plugins use (about 40 of them, 50–70 MB) into `Frameworks/engine/deps` and repoints every reference to `@executable_path/…`. The build fails if anything still points outside the app, or if any file is not built for the target architecture.
4. electron-builder assembles the app, with its minimum macOS set to the newest that any bundled library needs. `scripts/adhoc-sign.cjs` signs it ad hoc.

**Cross-building.** Homebrew installs only your Mac's own architecture. For the other architecture, `scripts/fetch-arm64-deps.py` downloads Homebrew's published arm64 builds ("bottles") of the same packages into `build/deps-arm64`, verifies their checksums and relocates them there; your Homebrew is not touched. Meson then cross-compiles against them. This works from an Intel Mac to Apple Silicon. The reverse is not set up, because Homebrew no longer publishes Intel bottles; on an Apple Silicon Mac, `npm run dist:mac:arm64` builds natively.

What the build is:
- **For your own Macs.** It is ad-hoc signed. On the Mac that built it, it just runs. Copied to another Mac (AirDrop, a download, a shared drive), macOS quarantines it and says it "can't be opened" or "is damaged". Clear that once on the other Mac, then open it normally:
  ```bash
  xattr -dr com.apple.quarantine /Applications/ElectronPlayer.app
  ```
  Sharing it with other people needs an Apple Developer ID signature and notarization, plus a license decision: several plugins and Homebrew's FFmpeg are GPL, so a distributed build must be GPL-compatible.
- **Minimum macOS.** Homebrew builds its libraries for the macOS it runs on. The Intel app therefore needs the same macOS as the Mac that built it (26 here). The Apple Silicon app uses Homebrew's oldest available bottles and runs on macOS 15 or later.
- **The Apple Silicon build was checked, not run.** It was built on an Intel Mac, which cannot run arm64 code, so nothing played audio in it here. Every binary was checked to be arm64, to point only inside the app, and to be signed. The Intel build was launched and played WAV, MP3, FLAC and Ogg.
- **No SID plugin on Apple Silicon (C64 music).** Homebrew's current libsidplayfp (3.x) is built without the ReSIDfp engine the plugin needs. The Intel build has SID only because this Mac still has libsidplayfp 2.x. Updating Homebrew would drop it there too.
- **Keychain prompt.** The first time the app saves a sign-in (Music Assistant or Subsonic), macOS asks to let ElectronPlayer use its "ElectronPlayer Safe Storage" key. Choose **Always Allow**. Because each ad-hoc build has a new signature, a rebuilt app may ask again.
- **App icon.** `resources/icon.svg` is the source. After editing it, run `npm run icon` to regenerate `resources/icon.png` (the dock icon when running with `npm start`) and `resources/icon.icns` (the app's icon). Electron renders the SVG, so no extra tools are needed.
- The SID plugin looks for optional C64 ROM files and a song-length database at a fixed build-time path, so it can't find them in the app (as before, without them SID files still play).

## Building for Linux and Windows

```bash
npm run dist:other      # all four; or npm run dist:linux / npm run dist:win
```

This builds, in `release/`:

| | x64 | arm64 |
|---|---|---|
| Linux | `ElectronPlayer-<version>-linux-x86_64.AppImage`, `electronplayer_<version>_amd64.deb`, `-linux-x64.tar.gz` | `-linux-arm64.AppImage`, `electronplayer_<version>_arm64.deb`, `-linux-arm64.tar.gz` |
| Windows | `ElectronPlayer-Setup-<version>-x64.exe` (installer), `-win-x64.zip` | `ElectronPlayer-Setup-<version>-arm64.exe`, `-win-arm64.zip` |

It needs only Docker. On a Mac: `brew install colima docker`, then `colima start --cpu 6 --memory 12 --disk 100 --vm-type vz`. Everything else runs in containers made from `docker/Dockerfile` (built on first use, about 5 GB). The first full run takes about an hour, later runs a few minutes per target. `scripts/package-other.sh` runs these steps for each target:

1. Builds the TypeScript and the renderer bundles (on the host).
2. `scripts/build-engine-other.sh <target>` (in a container) builds a small audio-only FFmpeg, libaudcore, the plugins and the native addon, laid out as they sit next to the app's executable (`engine/`, plugins in `engine/audacious/`). As on macOS, libaudcore relocates its paths from the executable, so this works wherever the app is installed or the AppImage is mounted.
   - **Linux** is built on Debian 12 (glibc 2.36), so it runs on distributions from about 2022 on: Ubuntu 22.04+, Debian 12+, Fedora 37+ and so on. x64 is native; arm64 is cross-compiled with Debian's arm64 libraries.
   - **Windows** is cross-compiled with [llvm-mingw](https://github.com/mstorsjo/llvm-mingw) against MSYS2's prebuilt libraries (`scripts/fetch-msys2-deps.py`, which downloads them with checksums). The addon is compiled directly, since node-gyp cannot target Windows from Linux.
3. `scripts/bundle-libs-other.py` copies the libraries the plugins use into `engine/`. On Linux, libraries every desktop has and Electron itself loads (glib, ALSA/PulseAudio/PipeWire, GnuTLS, X11) are left to the system; everything resolves through `$ORIGIN` RUNPATHs. On Windows, the addon adds `engine\` to the DLL search path.
4. electron-builder packages it (in the Windows container, which has Wine for the NSIS installer).

Plugins: the same set as macOS. Linux adds ALSA, PulseAudio, PipeWire and JACK output and MPRIS (desktop media keys and widgets); Windows uses waveOut. Two changes to Audacious were needed, kept in `patches/audacious/` and applied automatically:
- In headless mode libaudcore runs its main loop on its own GLib context. On Linux, Chromium's UI thread runs on GLib's default context, and sharing it crashed the app at start. The macOS build uses the same code.
- With clang on Windows, every symbol is exported instead of marking exports per function (clang rejects Audacious's mix of plain declarations and `dllexport` definitions, which GCC accepts).

What the builds are:
- **Unsigned.** Windows SmartScreen warns about an unknown publisher the first time ("More info", then "Run anyway").
- **Tested:** the Linux x64 `.deb` was installed on a clean Ubuntu 24.04 container and played WAV, MP3, FLAC and Ogg through PulseAudio, with every plugin found and every engine library loaded from the app. Not run here: the arm64 packages and the Windows builds (see `docs/PORTING_PLAN.md`).
- `scripts/package-other.sh` turns off the Docker VM's `qemu-i386` handler if it is on: on an x86_64 VM it hijacks 32-bit programs (the NSIS stub under Wine) and makes them crawl. Restarting the VM turns it back on.

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

**This computer as a speaker (Sendspin).** On by default once a server is set. The app joins Music Assistant as a player (named "ElectronPlayer (your computer)") using [Sendspin](https://www.sendspin-audio.com), Music Assistant's synchronized streaming protocol. The first time, Music Assistant may ask to pair it: the app shows a 6-digit code in Settings and in the main window, which you enter in Music Assistant.

Under **Connect the player**, choose how the player reaches the server:
- **Through the Music Assistant server address** (the default). The player connects to the server's own `/sendspin` endpoint at the address you signed in with, the same way Music Assistant's web player does. It uses the same scheme, host, port and path, so `https://music.example.com` becomes `wss://music.example.com/sendspin`. It signs in with your session, then the server relays the Sendspin stream. This works anywhere the server's web address does, including over the internet behind a reverse proxy with https, and needs nothing but the web port open. Requires Music Assistant 2.7 or later.
- **Directly to the Sendspin port.** The player connects straight to Sendspin, by default port 8927 on the server, or the address you enter (e.g. `ws://192.168.1.20:8927/sendspin`). This is for your local network, and is how earlier versions of this app connected; settings from those versions keep using it if they had an address filled in.

While Music Assistant plays here, the main window, the menus and the Touch Bar show and control its queue. Playing a local file pauses Music Assistant and hands control back.

Notes:
- Uses `@sendspin/sendspin-js` 5.0.0, the version Music Assistant's own web player uses. Music Assistant accepts it with its default **Allow legacy clients** setting; if you turn that off, this player (like the web player) can't connect.
- By default Music Assistant audio plays directly through Web Audio, bypassing Audacious. Turn on **Play through the Audacious engine** (Settings › Music Assistant, under "This computer as a speaker") to send it through the Audacious engine instead, so effects, the equalizer and visualizations apply. The app measures the engine's delay (about 70 ms) and feeds the audio that much early, keeping it in sync with your other Music Assistant speakers. It plays from a hidden playlist, so your own playlist is untouched. Music Assistant sends 16-bit audio to Sendspin players.

## OpenSubsonic (Navidrome and others)

**Settings › Subsonic**: enter the server address (e.g. `http://navidrome.local:4533`) with your username and password, or an API key if your server supports OpenSubsonic API keys (the app tells you when it does). Credentials are stored encrypted in the Keychain. Requests use the salted-token scheme, never the plain password.

In the Library window, switch the source to **Subsonic** for Artists, Albums, Songs, Recently Added, Playlists, Starred, Random Songs and search. **Songs** lists your whole library, 100 at a time (Load More adds the next page). While Songs is selected, the search box searches songs only, with paged results; elsewhere it searches artists, albums and songs. Song lists have **Play All** and **Add All** for the songs loaded so far. Songs go into the Audacious playlist and play through the Audacious engine, so effects, the equalizer and visualizations apply. Plays are reported back to the server ("now playing", then a full play at half the song or 4 minutes).

Subsonic puts credentials in every stream URL, and Audacious saves playlist URLs to disk, so saved playlists hold local addresses (`http://127.0.0.1:<port>/subsonic/<key>/…`) and a small proxy in the app adds your credentials to each request. Saved Subsonic songs therefore play only while the app is running.

## DAAP (iTunes sharing)

DAAP is the protocol iTunes used to share libraries on a local network. Servers that still speak it include [OwnTone](https://owntone.github.io/owntone-server/) (formerly forked-daapd), Firefly (mt-daapd), Rhythmbox's library sharing and Ampache.

**Settings › DAAP Sharing** lists the shared libraries the app finds on your network with Bonjour (on by default; **Search Again** looks again). You can also add one by address (`owntone.local`, `192.168.1.20:3689`). In the Library window, switch the source to **DAAP** and pick a library under **Library**. You can browse Songs, Artists, Albums, Genres and Playlists, and search. DAAP servers can't browse or search for you, so the app loads the song list once per library and groups and searches it locally. A library with a password asks for it in the Library window, then stores it encrypted in the Keychain. **Forget Password** in Settings removes it.

Songs play through the Audacious engine, like Subsonic. As with Subsonic, saved playlists hold local proxy addresses (`http://127.0.0.1:<port>/daap/<key>/<library>/…`), because song addresses need the server session, which expires. The proxy signs in again whenever needed, so saved DAAP songs play while the app is running and the library is reachable.

Not supported: libraries shared by iTunes 7 or later and by the Music app. They only accept requests signed with Apple's proprietary scheme, which this app doesn't implement. Home Sharing isn't supported either.

## Renamed from "Audacious for Electron"

Settings now live in `~/Library/Application Support/ElectronPlayer`. On first launch ElectronPlayer copies over the old `audacious-electron` folder (playlists, equalizer presets, Music Assistant and Subsonic settings) and leaves the original in place. Saved sign-ins can't be carried over, because they are encrypted with a Keychain key named after the app, so sign in to Music Assistant and Subsonic once more.
