import { app, BrowserWindow, safeStorage } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MaSettings, MaStatus } from '../shared/ma';
import { httpBase, MaClient, type MaEvent } from './ma-client';

// Music Assistant connection: settings, the encrypted token, and the
// commands the browser window may send.

/** Read-only browsing plus playback; nothing that edits the library. */
const ALLOWED_COMMANDS = new Set([
  'music/artists/library_items', 'music/albums/library_items', 'music/tracks/library_items',
  'music/playlists/library_items', 'music/radios/library_items', 'music/podcasts/library_items',
  'music/audiobooks/library_items', 'music/artists/artist_albums', 'music/artists/artist_tracks',
  'music/albums/album_tracks', 'music/playlists/playlist_tracks', 'music/podcasts/podcast_episodes',
  'music/search', 'music/browse', 'music/recently_played_items', 'music/recommendations',
  'players/all', 'player_queues/all', 'player_queues/play_media',
]);

const settingsFile = () => path.join(app.getPath('userData'), 'music-assistant.json');
const tokenFile = () => path.join(app.getPath('userData'), 'music-assistant-token.bin');

function loadSettings(): Omit<MaSettings, 'hasToken'> {
  const defaults = { server: '', sendspin: true, playerName: `Audacious (${os.hostname().replace(/\.local$/, '')})`, sendspinUrl: '' };
  try {
    return { ...defaults, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function loadToken(): string {
  try {
    return safeStorage.decryptString(readFileSync(tokenFile()));
  } catch {
    return '';
  }
}

export class MusicAssistant {
  private client: MaClient;
  private settings = loadSettings();
  private token = '';

  constructor(
    private onStatus: (status: MaStatus) => void,
    private onEvent: (event: MaEvent) => void,
    private onSettings: (settings: MaSettings) => void,
  ) {
    this.client = new MaClient(() => this.onStatus(this.status()), (e) => this.onEvent(e));
  }

  /** Loads the stored token and connects if configured. */
  start(): void {
    this.token = loadToken();
    if (this.settings.server) void this.client.connect(this.settings.server, this.token).catch(() => {});
  }

  getSettings(): MaSettings {
    return { ...this.settings, hasToken: !!this.token };
  }

  status(): MaStatus {
    const s = this.client.status;
    if (s.state !== 'connected') return { state: s.state, error: s.state === 'disconnected' ? s.error : undefined };
    return {
      state: 'connected',
      serverName: s.server.name,
      serverVersion: s.server.server_version,
      schemaVersion: s.server.schema_version,
      httpBase: httpBase(this.settings.server),
    };
  }

  /**
   * Saves settings; `token` replaces the stored token when given ('' keeps
   * it). Reconnects when the server or token changed.
   */
  async configure(update: Partial<Omit<MaSettings, 'hasToken'>> & { token?: string }): Promise<MaStatus> {
    const { token, ...rest } = update;
    const before = this.settings.server;
    this.settings = { ...this.settings, ...rest };
    writeFileSync(settingsFile(), JSON.stringify(this.settings, null, 2));

    let tokenChanged = false;
    if (token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable, so the token cannot be saved');
      writeFileSync(tokenFile(), safeStorage.encryptString(token));
      this.token = token;
      tokenChanged = true;
    }
    this.onSettings(this.getSettings());

    if (!this.settings.server) this.client.disconnect();
    else if (tokenChanged || before !== this.settings.server || this.client.status.state === 'disconnected') {
      await this.client.connect(this.settings.server, this.token).catch(() => {});
    }
    return this.status();
  }

  forgetToken(): void {
    rmSync(tokenFile(), { force: true });
    this.token = '';
    this.client.disconnect();
    this.onSettings(this.getSettings());
  }

  command(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_COMMANDS.has(command)) return Promise.reject(new Error(`Command not allowed: ${command}`));
    return this.client.command(command, args);
  }

  /** Default Sendspin endpoint: the MA server's host, port 8927. */
  sendspinUrl(): string {
    if (this.settings.sendspinUrl) return this.settings.sendspinUrl;
    if (!this.settings.server) return '';
    try {
      return `ws://${new URL(httpBase(this.settings.server)).hostname}:8927/sendspin`;
    } catch {
      return '';
    }
  }

  stop(): void {
    this.client.disconnect();
  }
}

export function broadcast(channel: string, value: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, value);
}
