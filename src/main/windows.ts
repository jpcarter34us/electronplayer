import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';

// Secondary windows (Settings, Equalizer, plugin settings). Each is a
// singleton: opening it again focuses the existing one.

const open = new Map<string, BrowserWindow>();

/** Shared by every app window: the preload bridge, isolated and sandboxed. */
export const webPreferences = (): Electron.WebPreferences => ({
  preload: path.join(__dirname, '../preload/preload.js'),
  contextIsolation: true,
  sandbox: true,
});

export const rendererFile = (file: string) => path.join(__dirname, '../renderer', file);

function show(
  key: string,
  file: string,
  options: BrowserWindowConstructorOptions,
  hash?: string,
): BrowserWindow {
  const existing = open.get(key);
  if (existing && !existing.isDestroyed()) {
    if (hash) existing.webContents.send('aud:navigate', hash);
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    backgroundColor: '#1e1f22',
    show: false,
    ...options,
    webPreferences: webPreferences(),
  });
  open.set(key, win);
  win.on('closed', () => open.delete(key));
  win.once('ready-to-show', () => win.show());
  win.loadFile(rendererFile(file), hash ? { hash } : {});
  return win;
}

/**
 * Settings window. `page` selects a page and optional tab, e.g. "audio",
 * "plugins/effect".
 */
export function openSettings(page?: string): BrowserWindow {
  return show('settings', 'settings.html', { title: 'ElectronPlayer Settings', width: 760, height: 560, minWidth: 600, minHeight: 400 }, page);
}

export function openEqualizer(): BrowserWindow {
  return show('equalizer', 'equalizer.html', { title: 'Equalizer', width: 620, height: 340, resizable: false });
}

/** A plugin's own settings, generated from its PreferencesWidget tree. */
export function openPluginPrefs(id: string, parent?: BrowserWindow): BrowserWindow {
  return show(`prefs:${id}`, 'prefs.html', { width: 520, height: 480, minWidth: 360, minHeight: 200, parent }, id);
}

/** Library browser: Music Assistant or Subsonic (`source` "ma" / "subsonic"). */
export function openLibrary(source?: string): BrowserWindow {
  return show('library', 'library.html', { title: 'Library', width: 980, height: 680, minWidth: 640, minHeight: 420 }, source);
}
