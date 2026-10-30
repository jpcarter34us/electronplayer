import { app } from 'electron';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const APP_NAME = 'ElectronPlayer';

/**
 * Names the app ElectronPlayer however it is launched (package.json's
 * productName is only read when Electron starts from the project folder),
 * and keeps the default settings folder in step. A custom userData set
 * before this runs (tests) is left alone.
 */
export function useAppIdentity(): void {
  const defaultFor = (name: string) => path.join(app.getPath('appData'), name);
  const isDefault = app.getPath('userData') === defaultFor(app.getName());
  app.setName(APP_NAME);
  if (isDefault) app.setPath('userData', defaultFor(APP_NAME));
}

/** Names this app had before; its settings folder was named after them. */
const PREVIOUS_NAMES = ['audacious-electron'];

/**
 * The app was renamed to ElectronPlayer, which moves Electron's settings
 * folder. On first launch under the new name, copy the old folder over:
 * playlists, libaudcore config, equalizer presets, Music Assistant and
 * Subsonic settings. Sign-ins don't carry over: they are encrypted with a
 * Keychain key named after the app, so they read as absent and the app asks
 * to sign in again.
 *
 * Only for the default folder, so a custom userData (tests) is untouched.
 */
export function migrateUserData(): string | null {
  const userData = app.getPath('userData');
  if (userData !== path.join(app.getPath('appData'), app.getName())) return null;
  if (existsSync(userData) && readdirSync(userData).length) return null;
  for (const name of PREVIOUS_NAMES) {
    const old = path.join(app.getPath('appData'), name);
    if (!existsSync(old)) continue;
    cpSync(old, userData, { recursive: true });
    return old;
  }
  return null;
}
