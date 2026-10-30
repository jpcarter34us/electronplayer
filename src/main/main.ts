import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppMenu } from './menu';
import { loadNativeCore, type NativeMethod } from './native';
import { createPlaybackTouchBar } from './touchbar';
import { VisState } from './vis';
import { openEqualizer, openPluginPrefs, openSettings } from './windows';
import type { PlaybackState, PluginInfo, Track } from '../shared/backend';
import type { VisId, VisSettings } from '../shared/prefs';

let playbackTouchBar: ReturnType<typeof createPlaybackTouchBar> | undefined;
let mainWindow: BrowserWindow | undefined;

// libaudcore keeps its config and playlists under $XDG_CONFIG_HOME/audacious;
// point it at our own userData so a regular Audacious install is untouched.
const native = loadNativeCore(app.getPath('userData'), (event) => {
  // Vis frames arrive ~30 times a second; send them only to the windows
  // drawing visualizers (the main window, or the separate vis windows).
  const targets = event.type === 'vis' ? (vis?.targets(mainWindow) ?? []) : BrowserWindow.getAllWindows();
  for (const win of targets) if (!win.isDestroyed()) win.webContents.send('aud:event', event);
  playbackTouchBar?.update(event);
});

const vis = native.call
  ? new VisState(native.call, (config) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('aud:vis-config', config);
      void appMenu?.refresh();
    })
  : undefined;
let appMenu: ReturnType<typeof createAppMenu> | undefined;

// Touch Bar controls talk to libaudcore directly, so they need the native
// engine; the HTML5 fallback plays inside the renderer.
function setUpTouchBar(): void {
  if (process.platform !== 'darwin' || !native.call) return;
  const call = native.call;
  const touchBar = (playbackTouchBar = createPlaybackTouchBar(call));
  // Catch up on events sent before the Touch Bar existed; resolves once the
  // engine is running, without holding up the window.
  Promise.all([call('getPlaylist', []), call('getState', [])])
    .then(([tracks, state]) => {
      touchBar.update({ type: 'playlist', tracks: tracks as Track[] });
      touchBar.update({ type: 'state', state: state as PlaybackState });
    })
    .catch((err) => console.error('Touch Bar sync failed:', err));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 480,
    minHeight: 320,
    title: 'Audacious',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (playbackTouchBar) win.setTouchBar(playbackTouchBar.touchBar);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
}

ipcMain.handle('aud:open-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    // With libaudcore every format its input plugins support is playable.
    filters: native.info.available
      ? [{ name: 'All files', extensions: ['*'] }]
      : [
          { name: 'Audio', extensions: ['mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'webm'] },
          { name: 'All files', extensions: ['*'] },
        ],
  });
  return result.canceled ? [] : result.filePaths.map((p) => pathToFileURL(p).href);
});

ipcMain.handle('aud:native-info', () => native.info);

ipcMain.handle('aud:call', (_event, method: NativeMethod, args: unknown[]) => {
  if (!native.call) throw new Error('libaudcore is not loaded');
  return native.call(method, Array.isArray(args) ? args : []);
});

// Settings, equalizer and plugin-settings windows (native engine only).
ipcMain.handle('aud:open-window', (event, kind: string, arg?: string) => {
  if (!native.call) return;
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  if (kind === 'settings') openSettings(arg);
  else if (kind === 'equalizer') openEqualizer();
  else if (kind === 'plugin-prefs' && arg) openPluginPrefs(arg, parent);
});

ipcMain.handle('aud:plugin-about', async (event, id: string) => {
  if (!native.call) return;
  const [plugins, about] = (await Promise.all([native.call('listPlugins', []), native.call('pluginAbout', [id])])) as [PluginInfo[], string];
  const name = plugins.find((p) => p.id === id)?.name ?? id;
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options = { type: 'info' as const, message: `About ${name}`, detail: about || 'No information available.' };
  await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
});

// File chooser for plugin settings; libaudcore stores these as URIs.
ipcMain.handle('aud:choose-path', async (event, mode: 'file' | 'folder', current?: string) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    properties: [mode === 'folder' ? 'openDirectory' : 'openFile', 'createDirectory'],
    defaultPath: current?.startsWith('file://') ? decodeURIComponent(new URL(current).pathname) : undefined,
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : pathToFileURL(result.filePaths[0]).href;
});

ipcMain.handle('aud:vis-config', (): VisSettings =>
  vis?.get() ?? { enabled: { spectrum: false, scope: false, vu: false }, separate: false, onTop: false });
ipcMain.handle('aud:set-vis', (_event, id: VisId, on: boolean) => vis?.set(id, !!on));
ipcMain.handle('aud:set-vis-option', (_event, option: 'separate' | 'onTop', on: boolean) => {
  if (option === 'separate' || option === 'onTop') return vis?.setOption(option, !!on);
});

app.whenReady().then(() => {
  setUpTouchBar();
  if (native.call) {
    appMenu = createAppMenu(native.call, vis!);
    // Both wait for the engine; neither holds up the window.
    vis!.load().then(() => appMenu!.refresh()).catch((err) => console.error('Menu setup failed:', err));
  }
  createWindow();
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

// Saves config and playlists and stops the engine thread.
app.on('will-quit', () => native.shutdown?.());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
