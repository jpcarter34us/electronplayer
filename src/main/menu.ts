import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { pathToFileURL } from 'node:url';
import type { PlaybackState } from '../shared/backend';
import type { VisId } from '../shared/prefs';
import type { NativeMethod } from './native';
import type { VisState } from './vis';
import { openEqualizer, openSettings } from './windows';

// The menu bar, following qtui's (audacious-plugins/src/qtui/menus.cc):
// File, Playback, Playlist, Output, View. Playlist-management, queue and
// song-info dialogs arrive with the phase 2 interface.

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

const isMac = process.platform === 'darwin';

/** Playback toggles, all core config booleans. */
const TOGGLES = [
  { key: 'repeat', label: 'Repeat', accelerator: 'CmdOrCtrl+R' },
  { key: 'shuffle', label: 'Shuffle', accelerator: 'CmdOrCtrl+S' },
  { key: 'album_shuffle', label: 'Shuffle by Album' },
  { key: 'no_playlist_advance', label: 'No Playlist Advance', accelerator: 'CmdOrCtrl+N' },
  // Cmd+M is Minimize on macOS.
  { key: 'stop_after_current_song', label: 'Stop After This Song', accelerator: isMac ? undefined : 'Ctrl+M' },
] as const;

const SORTS: [string, string][] = [
  ['track', 'By Track Number'], ['title', 'By Title'], ['artist', 'By Artist'], ['album', 'By Album'],
  ['album-artist', 'By Album Artist'], ['date', 'By Release Date'], ['genre', 'By Genre'],
  ['length', 'By Length'], ['path', 'By File Path'], ['custom-title', 'By Custom Title'],
  ['comment', 'By Comment'], ['disc', 'By Disc Number'], ['bitrate', 'By Bitrate'],
  ['file-created', 'By File Created'], ['file-modified', 'By File Modified'],
];

const VISUALIZERS: [VisId, string][] = [['spectrum', 'Spectrum Analyzer'], ['scope', 'Blur Scope'], ['vu', 'VU Meter']];

export function createAppMenu(call: Call, vis: VisState): { refresh(): Promise<void> } {
  const run = (method: NativeMethod, ...args: unknown[]) => void call(method, args).catch(() => {});
  const command = (name: string, arg?: string) => () => run('command', name, arg);
  let toggles: Record<string, boolean> = {};

  async function pick(folder: boolean): Promise<string[]> {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
      properties: folder ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths.map((p) => pathToFileURL(p).href);
  }

  const openOrAdd = (method: 'open' | 'add', folder: boolean) => async () => {
    const uris = await pick(folder);
    if (uris.length) run(method, uris);
  };

  async function changeVolume(direction: 1 | -1) {
    const [state, delta] = (await Promise.all([call('getState', []), call('getConfig', [null, 'volume_delta', 'int'])])) as [PlaybackState, number];
    run('setVolume', Math.min(100, Math.max(0, state.volume + direction * (delta || 5))));
  }

  const settingsItem: MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() };

  function template(): MenuItemConstructorOptions[] {
    const visConfig = vis.get();
    return [
      ...(isMac
        ? [{
            label: app.name,
            submenu: [
              { role: 'about' }, { type: 'separator' }, settingsItem, { type: 'separator' },
              { role: 'services' }, { type: 'separator' },
              { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
            ] as MenuItemConstructorOptions[],
          }]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open Files…', accelerator: 'CmdOrCtrl+O', click: openOrAdd('open', false) },
          { label: 'Open Folder…', accelerator: 'CmdOrCtrl+K', click: openOrAdd('open', true) },
          { label: 'Add Files…', accelerator: 'CmdOrCtrl+Shift+O', click: openOrAdd('add', false) },
          { label: 'Add Folder…', accelerator: 'CmdOrCtrl+Shift+K', click: openOrAdd('add', true) },
          ...(isMac ? [] : [{ type: 'separator' } as const, settingsItem, { type: 'separator' } as const, { role: 'quit' } as const]),
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Playback',
        submenu: [
          { label: 'Play', accelerator: 'CmdOrCtrl+Enter', click: () => run('play') },
          // Ctrl+, upstream; that is Settings on macOS.
          { label: 'Pause', accelerator: isMac ? undefined : 'Ctrl+,', click: () => run('pause') },
          { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => run('stop') },
          { label: 'Previous', accelerator: 'Alt+Up', click: () => run('prev') },
          { label: 'Next', accelerator: 'Alt+Down', click: () => run('next') },
          { label: 'Previous Album', click: command('prev-album') },
          { label: 'Next Album', click: command('next-album') },
          { type: 'separator' },
          ...TOGGLES.map((t): MenuItemConstructorOptions => ({
            label: t.label,
            type: 'checkbox',
            checked: !!toggles[t.key],
            accelerator: 'accelerator' in t ? t.accelerator : undefined,
            click: async (item) => {
              await call('setConfig', [null, t.key, 'bool', item.checked]);
              await refresh();
            },
          })),
          { type: 'separator' },
          { label: 'Set Repeat Point A', accelerator: 'CmdOrCtrl+1', click: command('ab-a') },
          { label: 'Set Repeat Point B', accelerator: 'CmdOrCtrl+2', click: command('ab-b') },
          { label: 'Clear Repeat Points', accelerator: 'CmdOrCtrl+3', click: command('ab-clear') },
        ],
      },
      {
        label: 'Playlist',
        submenu: [
          { label: 'Play/Resume', accelerator: 'Shift+Enter', click: command('play-resume') },
          { label: 'Refresh', accelerator: 'F5', click: command('refresh') },
          { type: 'separator' },
          {
            label: 'Sort',
            submenu: [
              ...SORTS.map(([arg, label]) => ({ label, click: command('sort', arg) })),
              { type: 'separator' },
              { label: 'Reverse Order', click: command('reverse') },
              { label: 'Random Order', click: command('randomize') },
            ],
          },
          {
            label: 'Remove Duplicates',
            submenu: [
              { label: 'By Title', click: command('remove-duplicates', 'title') },
              { label: 'By File Name', click: command('remove-duplicates', 'filename') },
              { label: 'By File Path', click: command('remove-duplicates', 'path') },
            ],
          },
          { label: 'Remove Unavailable Files', click: command('remove-unavailable') },
          { type: 'separator' },
          { label: 'Clear', click: () => run('clear') },
        ],
      },
      {
        label: 'Output',
        submenu: [
          { label: 'Volume Up', accelerator: 'CmdOrCtrl+Plus', click: () => changeVolume(1) },
          { label: 'Volume Down', accelerator: 'CmdOrCtrl+-', click: () => changeVolume(-1) },
          { type: 'separator' },
          { label: 'Equalizer…', accelerator: 'CmdOrCtrl+E', click: () => openEqualizer() },
          { label: 'Effects…', click: () => openSettings('plugins/effect') },
          { type: 'separator' },
          { label: 'Audio Settings…', click: () => openSettings('audio') },
        ],
      },
      {
        label: 'View',
        submenu: [
          ...VISUALIZERS.map(([id, label]): MenuItemConstructorOptions => ({
            label,
            type: 'checkbox',
            checked: visConfig[id],
            click: (item) => void vis.set(id, item.checked),
          })),
          { label: 'Visualizations…', click: () => openSettings('plugins/vis') },
          ...(app.isPackaged ? [] : [{ type: 'separator' } as const, { role: 'toggleDevTools' } as const]),
        ],
      },
      { role: 'windowMenu' },
    ];
  }

  async function refresh(): Promise<void> {
    const values = await Promise.all(TOGGLES.map((t) => call('getConfig', [null, t.key, 'bool'])));
    toggles = Object.fromEntries(TOGGLES.map((t, i) => [t.key, values[i] as boolean]));
    Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
  return { refresh };
}
