import { ipcMain } from 'electron';
import type { BackendEvent, PlaybackState, Track } from '../shared/backend';
import type { SubsonicSong } from '../shared/subsonic';
import { broadcast } from './music-assistant';
import type { NativeMethod } from './native';
import { Subsonic } from './subsonic';

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

/** A full play counts at half the track or 4 minutes, as Last.fm-style scrobbling does. */
const SUBMIT_AFTER_MS = 240_000;

/**
 * Subsonic in the app: settings and library IPC, adding songs to the local
 * playlist (played by libaudcore through the proxy), and play reporting.
 */
export function setUpSubsonic(native: Call | undefined): { subsonic: Subsonic; onNativeEvent(event: BackendEvent): void } {
  const subsonic = new Subsonic(
    (status) => broadcast('aud:subsonic-status', status),
    (settings) => broadcast('aud:subsonic-settings', settings),
  );

  ipcMain.handle('aud:subsonic-state', () => ({ settings: subsonic.getSettings(), status: subsonic.status }));
  ipcMain.handle('aud:subsonic-configure', (_e, update: Record<string, unknown>) => {
    const clean: { server?: string; username?: string; password?: string; apiKey?: string } = {};
    for (const key of ['server', 'username', 'password', 'apiKey'] as const) if (typeof update?.[key] === 'string') clean[key] = update[key] as string;
    return subsonic.configure(clean);
  });
  ipcMain.handle('aud:subsonic-sign-out', () => subsonic.signOut());
  ipcMain.handle('aud:subsonic-call', (_e, method: string, params: Record<string, string | number | boolean>) =>
    subsonic.call(String(method), params && typeof params === 'object' ? params : {}));

  // Play Now inserts after the current song and starts it; Next inserts
  // there without playing; Add appends.
  ipcMain.handle('aud:subsonic-play', async (_e, songs: SubsonicSong[], option: 'play' | 'next' | 'add') => {
    if (!native) throw new Error('Subsonic playback needs the Audacious engine');
    const base = subsonic.status.proxyBase;
    if (!base) throw new Error('Not connected to the Subsonic server');
    const entries = (Array.isArray(songs) ? songs : []).map((s) => ({
      uri: `${base}/stream/${encodeURIComponent(s.id)}.${(s.suffix || 'mp3').replace(/[^a-z0-9]/gi, '')}`,
      title: s.title,
      artist: s.artist,
      album: s.album,
      length: s.duration ? s.duration * 1000 : -1,
    }));
    if (!entries.length) return;
    let at = -1;
    if (option !== 'add') {
      const state = (await native('getState', [])) as PlaybackState;
      at = state.position >= 0 ? state.position + 1 : -1;
    }
    await native('insert', [entries, at, option === 'play']);
  });

  // Play reporting
  let tracks: Track[] = [];
  let current: { id: string; position: number; submitted: boolean } | null = null;
  const onNativeEvent = (event: BackendEvent) => {
    if (event.type === 'playlist') tracks = event.tracks;
    if (event.type !== 'state') return;
    const s = event.state;
    if (!s.playing) {
      current = null;
      return;
    }
    const id = s.position >= 0 && tracks[s.position] ? subsonic.songIdFromUri(tracks[s.position].uri) : null;
    if (!id) {
      current = null;
      return;
    }
    if (!current || current.id !== id || current.position !== s.position) {
      current = { id, position: s.position, submitted: false };
      subsonic.scrobble(id, false); // now playing
    }
    const threshold = s.length > 0 ? Math.min(s.length / 2, SUBMIT_AFTER_MS) : SUBMIT_AFTER_MS;
    if (!current.submitted && s.time >= threshold) {
      current.submitted = true;
      subsonic.scrobble(id, true);
    }
  };

  return { subsonic, onNativeEvent };
}
