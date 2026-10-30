import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadNativeCore, type NativeMethod } from './native';

// libaudcore keeps its config and playlists under $XDG_CONFIG_HOME/audacious;
// point it at our own userData so a regular Audacious install is untouched.
const native = loadNativeCore(app.getPath('userData'), (event) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('aud:event', event);
});

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
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Saves config and playlists and stops the engine thread.
app.on('will-quit', () => native.shutdown?.());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
