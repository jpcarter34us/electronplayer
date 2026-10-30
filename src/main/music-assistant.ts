import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { MaLoginProvider, MaSettings, MaStatus } from '../shared/ma';
import { httpBase, maAnonymousCommand, MaClient, type MaEvent } from './ma-client';

// Music Assistant connection: settings, the encrypted token, sign-in, and
// the commands the browser window may send.
//
// Sign-in follows the Music Assistant mobile app (music-assistant/mobile-app,
// Apache-2.0; composeApp/.../auth/AuthenticationManager.kt): username and
// password via auth/login, or a provider such as Home Assistant via
// auth/authorization_url, each yielding a session token (30 days, renewed on
// use, at most 90) that is then presented with `auth`. Where the app returns
// to itself through a custom URL scheme (allowed only over Remote Access), a
// desktop app uses a loopback return_url, which the server trusts and appends
// the token to as ?code=. Long-lived tokens still work.

const BROWSER_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

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

const hostName = () => os.hostname().replace(/\.local$/, '');

function loadSettings(): Omit<MaSettings, 'hasToken'> {
  const defaults: Omit<MaSettings, 'hasToken'> = {
    server: '', sendspin: true, playerName: `ElectronPlayer (${hostName()})`, sendspinUrl: '', tokenKind: '', throughAudacious: false,
  };
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
    this.client = new MaClient(() => this.onStatus(this.status()), (e) => this.onEvent(e), `ElectronPlayer on ${hostName()}`);
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
    if (s.state !== 'connected') {
      return s.state === 'disconnected' ? { state: s.state, error: s.error, needsSignIn: !!s.authFailed } : { state: s.state };
    }
    return {
      state: 'connected',
      user: s.user?.display_name || s.user?.username,
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
      this.saveToken(token, 'long-lived');
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
    this.settings.tokenKind = '';
    writeFileSync(settingsFile(), JSON.stringify(this.settings, null, 2));
    this.client.disconnect();
    this.onSettings(this.getSettings());
  }

  /** Signs out: revokes a session token on the server, then forgets it. */
  async signOut(): Promise<void> {
    if (this.settings.tokenKind === 'session' && this.client.status.state === 'connected') {
      await this.client.command('auth/logout').catch(() => {});
    }
    this.forgetToken();
  }

  /** Sign-in options the server offers besides username and password. */
  async loginProviders(server: string): Promise<MaLoginProvider[]> {
    this.setServer(server);
    const providers = await maAnonymousCommand<{ provider_id: string; provider_type: string; requires_redirect?: boolean }[]>(this.settings.server, 'auth/providers');
    return (providers ?? [])
      .filter((p) => p.requires_redirect)
      .map((p) => ({ id: p.provider_id, type: p.provider_type, label: p.provider_type === 'homeassistant' || p.provider_id === 'hass' ? 'Home Assistant' : p.provider_id }));
  }

  /** Username and password: the server returns a session token. */
  async loginWithPassword(server: string, username: string, password: string): Promise<MaStatus> {
    this.setServer(server);
    const result = await maAnonymousCommand<{ success?: boolean; access_token?: string; token?: string; error?: string }>(
      this.settings.server, 'auth/login', { username, password, device_name: `ElectronPlayer on ${hostName()}` });
    const token = result?.access_token ?? result?.token;
    if (!result?.success || !token) throw new Error(result?.error || 'Wrong username or password');
    return this.signedIn(token);
  }

  /**
   * Sign in with a provider (e.g. Home Assistant) in the system browser.
   * A one-off loopback page receives the token when the server redirects.
   */
  async loginWithBrowser(server: string, providerId: string): Promise<MaStatus> {
    this.setServer(server);
    const callback = createServer();
    await new Promise<void>((resolve, reject) => callback.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = (callback.address() as { port: number }).port;
    try {
      const codeArrived = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sign-in timed out')), BROWSER_SIGN_IN_TIMEOUT_MS);
        callback.on('request', (req, res) => {
          const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
          const code = url.searchParams.get('code');
          if (url.pathname !== '/callback' || !code) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
            '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
            '<body style="font:15px system-ui;padding:40px;text-align:center">' +
            '<h2>Signed in to Music Assistant</h2><p>You can close this tab and return to ElectronPlayer.</p></body>');
          clearTimeout(timer);
          resolve(code);
        });
      });
      const result = await maAnonymousCommand<{ authorization_url?: string | null; error?: string }>(
        this.settings.server, 'auth/authorization_url', { provider_id: providerId, return_url: `http://127.0.0.1:${port}/callback` });
      if (!result?.authorization_url) throw new Error(result?.error || 'This sign-in method is not available');
      await shell.openExternal(result.authorization_url);
      return this.signedIn(await codeArrived);
    } finally {
      callback.close();
    }
  }

  private setServer(server: string): void {
    const trimmed = server.trim();
    if (!trimmed) throw new Error('Enter the server address first');
    this.settings.server = trimmed;
  }

  private async signedIn(token: string): Promise<MaStatus> {
    this.saveToken(token, 'session');
    this.onSettings(this.getSettings());
    await this.client.connect(this.settings.server, this.token).catch(() => {});
    return this.status();
  }

  private saveToken(token: string, kind: 'session' | 'long-lived'): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable, so the sign-in cannot be saved');
    writeFileSync(tokenFile(), safeStorage.encryptString(token));
    this.token = token;
    this.settings.tokenKind = kind;
    writeFileSync(settingsFile(), JSON.stringify(this.settings, null, 2));
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
