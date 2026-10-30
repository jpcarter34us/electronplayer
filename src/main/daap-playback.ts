import { ipcMain } from 'electron';
import type { PlaybackState } from '../shared/backend';
import type { DaapSettings, DaapSong } from '../shared/daap';
import { Daap } from './daap';
import { broadcast } from './music-assistant';
import type { NativeMethod } from './native';

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

/**
 * DAAP in the app: settings and library IPC, and adding songs to the local
 * playlist (played by libaudcore through the proxy).
 */
export function setUpDaap(native: Call | undefined): Daap {
  const daap = new Daap(
    (status) => broadcast('aud:daap-status', status),
    (shares) => broadcast('aud:daap-shares', shares),
  );

  ipcMain.handle('aud:daap-state', () => ({ settings: daap.getSettings(), status: daap.status, shares: daap.shares() }));
  ipcMain.handle('aud:daap-discover', () => daap.discover());
  ipcMain.handle('aud:daap-configure', async (_e, update: Partial<DaapSettings>) => {
    const clean: Partial<DaapSettings> = {};
    if (Array.isArray(update?.servers)) clean.servers = update.servers.filter((s) => typeof s === 'string');
    if (typeof update?.discover === 'boolean') clean.discover = update.discover;
    await daap.configure(clean);
    return daap.getSettings();
  });
  ipcMain.handle('aud:daap-connect', (_e, id: string, password?: string) =>
    daap.connect(String(id ?? ''), typeof password === 'string' ? password : undefined));
  ipcMain.handle('aud:daap-disconnect', () => daap.disconnect());
  ipcMain.handle('aud:daap-forget-password', (_e, id: string) => daap.forgetPassword(String(id ?? '')));
  ipcMain.handle('aud:daap-songs', () => daap.allSongs());
  ipcMain.handle('aud:daap-playlists', () => daap.playlists());
  ipcMain.handle('aud:daap-playlist-songs', (_e, id: number) => daap.playlistSongs(Number(id)));

  // Play Now inserts after the current song and starts it; Next inserts
  // there without playing; Add appends (as for Subsonic).
  ipcMain.handle('aud:daap-play', async (_e, songs: DaapSong[], option: 'play' | 'next' | 'add') => {
    if (!native) throw new Error('DAAP playback needs the Audacious engine');
    const base = daap.status.proxyBase;
    if (!base) throw new Error('No shared library is open');
    const entries = (Array.isArray(songs) ? songs : []).filter((s) => Number.isInteger(s?.id)).map((s) => ({
      uri: `${base}/stream/${s.id}.${(s.format || 'mp3').replace(/[^a-z0-9]/gi, '')}`,
      title: s.title,
      artist: s.artist,
      album: s.album,
      length: s.duration ? Math.round(s.duration * 1000) : -1,
    }));
    if (!entries.length) return;
    let at = -1;
    if (option !== 'add') {
      const state = (await native('getState', [])) as PlaybackState;
      at = state.position >= 0 ? state.position + 1 : -1;
    }
    await native('insert', [entries, at, option === 'play']);
  });

  return daap;
}
