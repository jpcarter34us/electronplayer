import { app, safeStorage } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { SubsonicSettings, SubsonicStatus } from '../shared/subsonic';

// OpenSubsonic / Subsonic servers (Navidrome, Gonic, Airsonic, ...).
//
// Auth (https://opensubsonic.netlify.app/docs/api-reference/): an API key
// (apiKeyAuthentication extension) when the user gives one, otherwise the
// salted token t = md5(password + salt); servers that reject tokens (error
// 41) get the hex-encoded password. Secrets are kept with safeStorage.
//
// Playback goes through libaudcore, which streams plain HTTP. Subsonic puts
// the credential in every URL, and libaudcore saves playlist URLs to disk,
// so playlists get loopback proxy URLs instead
// (http://127.0.0.1:<port>/subsonic/<key>/stream/<id>.<ext>) and the proxy
// adds the credential per request. The random key keeps other local
// software from guessing the URLs.

const API_VERSION = '1.16.1';
const CLIENT = 'ElectronPlayer';

/** Read-only calls the library window may make. */
const ALLOWED = new Set([
  'getArtists', 'getArtist', 'getAlbum', 'getAlbumList2', 'getPlaylists', 'getPlaylist',
  'search3', 'getRandomSongs', 'getStarred2', 'getMusicFolders', 'getGenres', 'getSongsByGenre',
]);

const settingsFile = () => path.join(app.getPath('userData'), 'subsonic.json');
const secretFile = () => path.join(app.getPath('userData'), 'subsonic-secret.bin');

interface Secret {
  password?: string;
  apiKey?: string;
}

interface Stored {
  server: string;
  username: string;
  proxyPort: number;
  proxyKey: string;
}

export class SubsonicError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** http(s)://host[:port][/base] from what the user typed. */
export function baseUrl(server: string): string {
  let url = server.trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/rest$/, '');
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export class Subsonic {
  private stored: Stored;
  private secret: Secret = {};
  private auth: 'apikey' | 'token' | 'hex' = 'token';
  private proxy?: Server;
  private _status: SubsonicStatus = { state: 'disconnected' };

  constructor(private onStatus: (status: SubsonicStatus) => void, private onSettings: (settings: SubsonicSettings) => void) {
    let stored: Partial<Stored> = {};
    try {
      stored = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    } catch {}
    this.stored = {
      server: stored.server ?? '',
      username: stored.username ?? '',
      proxyPort: stored.proxyPort ?? 0,
      proxyKey: stored.proxyKey ?? randomBytes(16).toString('hex'),
    };
  }

  get status(): SubsonicStatus {
    return { ...this._status };
  }

  getSettings(): SubsonicSettings {
    return { server: this.stored.server, username: this.stored.username, hasPassword: !!this.secret.password, hasApiKey: !!this.secret.apiKey };
  }

  /** Starts the proxy (so saved playlists play) and connects if configured. */
  async start(): Promise<void> {
    try {
      this.secret = JSON.parse(safeStorage.decryptString(readFileSync(secretFile())));
    } catch {}
    await this.startProxy();
    if (this.stored.server && (this.secret.password || this.secret.apiKey)) await this.connect().catch(() => {});
  }

  stop(): void {
    this.proxy?.close();
  }

  /** Saves server and credentials (only those given), then connects. */
  async configure(update: { server?: string; username?: string; password?: string; apiKey?: string }): Promise<SubsonicStatus> {
    if (update.server !== undefined) this.stored.server = update.server.trim();
    if (update.username !== undefined) this.stored.username = update.username.trim();
    if (update.apiKey) this.secret = { apiKey: update.apiKey.trim() };
    else if (update.password) this.secret = { password: update.password };
    if (update.apiKey || update.password) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable, so the credentials cannot be saved');
      writeFileSync(secretFile(), safeStorage.encryptString(JSON.stringify(this.secret)));
    }
    this.save();
    this.onSettings(this.getSettings());
    await this.connect().catch(() => {});
    return this.status;
  }

  signOut(): void {
    rmSync(secretFile(), { force: true });
    this.secret = {};
    this.setStatus({ state: 'disconnected' });
    this.onSettings(this.getSettings());
  }

  async connect(): Promise<void> {
    if (!this.stored.server) throw new Error('Enter the server address first');
    if (!this.secret.apiKey && !(this.stored.username && this.secret.password)) {
      this.setStatus({ state: 'disconnected', error: 'Enter your username and password, or an API key' });
      return;
    }
    this.setStatus({ state: 'connecting' });
    try {
      this.auth = this.secret.apiKey ? 'apikey' : 'token';
      let ping: Record<string, unknown>;
      try {
        ping = await this.raw('ping');
      } catch (err) {
        // Token auth not supported (41): fall back to the hex-encoded password.
        if (!(err instanceof SubsonicError && err.code === 41 && this.secret.password)) throw err;
        this.auth = 'hex';
        ping = await this.raw('ping');
      }
      let extensions: string[] = [];
      if (ping.openSubsonic) {
        const ext = await this.raw('getOpenSubsonicExtensions').catch(() => null);
        extensions = ((ext?.openSubsonicExtensions as { name: string }[]) ?? []).map((e) => e.name);
      }
      this.setStatus({
        state: 'connected',
        serverType: (ping.type as string) || 'Subsonic',
        serverVersion: (ping.serverVersion as string) || (ping.version as string),
        openSubsonic: !!ping.openSubsonic,
        apiKeySupported: extensions.includes('apiKeyAuthentication'),
        auth: this.auth === 'apikey' ? 'API key' : this.auth === 'token' ? 'password (salted token)' : 'password',
        proxyBase: this.proxyBase(),
      });
    } catch (err) {
      const e = err as SubsonicError;
      const error =
        e.code === 40 ? 'Wrong username or password'
        : e.code === 44 ? 'The API key is not valid'
        : e.code === 42 ? 'The server does not accept this sign-in method'
        : e.message;
      this.setStatus({ state: 'disconnected', error });
      throw err;
    }
  }

  /** A read-only API call for the library window. */
  call(method: string, params: Record<string, string | number | boolean | undefined>): Promise<Record<string, unknown>> {
    if (!ALLOWED.has(method)) return Promise.reject(new Error(`Not allowed: ${method}`));
    if (this._status.state !== 'connected') return Promise.reject(new Error('Not connected to the Subsonic server'));
    return this.raw(method, params);
  }

  /** Reports a play ("now playing" without submission, a full play with). */
  scrobble(id: string, submission: boolean): void {
    if (this._status.state === 'connected') void this.raw('scrobble', { id, submission }).catch(() => {});
  }

  /** Song id from a proxy stream URL, or null for anything else. */
  songIdFromUri(uri: string): string | null {
    const m = uri.match(/^http:\/\/127\.0\.0\.1:(\d+)\/subsonic\/([0-9a-f]+)\/stream\/([^/?#.]+)/);
    return m && m[2] === this.stored.proxyKey ? decodeURIComponent(m[3]) : null;
  }

  // ---- HTTP ----

  private authParams(): Record<string, string> {
    if (this.auth === 'apikey') return { apiKey: this.secret.apiKey! };
    const params: Record<string, string> = { u: this.stored.username };
    if (this.auth === 'token') {
      const salt = randomBytes(8).toString('hex');
      params.s = salt;
      params.t = createHash('md5').update((this.secret.password ?? '') + salt).digest('hex');
    } else params.p = 'enc:' + Buffer.from(this.secret.password ?? '', 'utf8').toString('hex');
    return params;
  }

  private url(method: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    const url = new URL(`${baseUrl(this.stored.server)}/rest/${method}`);
    for (const [k, v] of Object.entries({ ...this.authParams(), v: API_VERSION, c: CLIENT, f: 'json', ...params })) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async raw(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(this.url(method, params), { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new SubsonicError(`Cannot reach ${baseUrl(this.stored.server)} (${(err as Error).message})`);
    }
    let body: { 'subsonic-response'?: Record<string, unknown> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new SubsonicError(`Not a Subsonic server (HTTP ${res.status})`);
    }
    const r = body['subsonic-response'];
    if (!r) throw new SubsonicError('Not a Subsonic server');
    if (r.status !== 'ok') {
      const error = (r.error ?? {}) as { code?: number; message?: string };
      throw new SubsonicError(error.message || `Subsonic error ${error.code}`, error.code);
    }
    return r;
  }

  // ---- loopback proxy ----

  private proxyBase(): string {
    const port = (this.proxy?.address() as { port: number } | null)?.port ?? this.stored.proxyPort;
    return `http://127.0.0.1:${port}/subsonic/${this.stored.proxyKey}`;
  }

  private async startProxy(): Promise<void> {
    const server = createServer((req, res) => void this.handleProxy(req, res));
    const listen = (port: number) =>
      new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
    // Keep the same port across runs so saved playlist URLs keep working.
    if (!(this.stored.proxyPort && (await listen(this.stored.proxyPort)))) await listen(0);
    this.proxy = server;
    const port = (server.address() as { port: number }).port;
    if (port !== this.stored.proxyPort) {
      this.stored.proxyPort = port;
      this.save();
    }
  }

  private async handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/subsonic\/([0-9a-f]+)\/(stream|cover)\/([^/]+)$/);
    if (!m || m[1] !== this.stored.proxyKey || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    if (!this.stored.server || !(this.secret.apiKey || this.secret.password)) {
      res.writeHead(503).end('Subsonic is not configured');
      return;
    }
    const id = decodeURIComponent(m[3]).replace(/\.[a-z0-9]+$/i, '');
    const upstream = m[2] === 'stream'
      ? this.url('stream', { id })
      : this.url('getCoverArt', { id, size: url.searchParams.get('size') ?? undefined });
    const headers: Record<string, string> = {};
    if (req.headers.range) headers.Range = req.headers.range;
    try {
      const up = await fetch(upstream, { headers, method: req.method });
      const out: Record<string, string> = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      // A JSON body here is a Subsonic error, not audio or an image.
      if (out['content-type']?.includes('json') || out['content-type']?.includes('xml')) {
        res.writeHead(502).end();
        return;
      }
      res.writeHead(up.status, out);
      if (!up.body || req.method === 'HEAD') return void res.end();
      const body = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
      res.on('close', () => body.destroy());
      body.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }

  private save(): void {
    writeFileSync(settingsFile(), JSON.stringify(this.stored, null, 2));
  }

  private setStatus(status: SubsonicStatus): void {
    this._status = status.state === 'connected' ? status : { ...status, proxyBase: undefined };
    this.onStatus(this.status);
  }
}
