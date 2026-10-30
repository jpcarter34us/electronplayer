import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { DaapPlaylist, DaapSettings, DaapShare, DaapSong, DaapStatus } from '../shared/daap';
import { type DmapNode, parseDmap } from './dmap';
import { browse } from './mdns';

// DAAP, the protocol of iTunes music sharing: browse and play libraries
// shared by OwnTone (forked-daapd), Firefly/mt-daapd, Rhythmbox, Ampache and
// similar servers, found with Bonjour (_daap._tcp) or added by address.
//
// A session is /login (session-id), /update (revision), /databases (the
// library id); songs and playlists are DMAP lists (see dmap.ts). Shares with
// a password take it as HTTP Basic auth on every request. iTunes 7 and later
// (and Music.app) also require a proprietary request signature
// (Client-DAAP-Validation), which is not implemented.
//
// Playback goes through libaudcore, which streams plain HTTP. Song URLs
// need the session id, which ends when the session does, and libaudcore
// saves playlist URLs; so, as for Subsonic, playlists get loopback proxy URLs
// (http://127.0.0.1:<port>/daap/<key>/<share>/stream/<id>.<ext>) and the
// proxy signs in to the share as needed. The random key keeps other local
// software from guessing the URLs.

const DEFAULT_PORT = 3689;
const HEADERS = { 'Client-DAAP-Version': '3.0', 'Viewer-Only-Client': '1', Accept: '*/*', 'User-Agent': 'ElectronPlayer' };
const SONG_META = [
  'dmap.itemid', 'dmap.itemname', 'daap.songartist', 'daap.songalbumartist', 'daap.songalbum', 'daap.songgenre',
  'daap.songtime', 'daap.songtracknumber', 'daap.songdiscnumber', 'daap.songyear', 'daap.songformat', 'daap.songdatakind',
].join(',');
const PLAYLIST_META = 'dmap.itemid,dmap.itemname,dmap.itemcount,daap.baseplaylist,com.apple.itunes.smart-playlist';

const settingsFile = () => path.join(app.getPath('userData'), 'daap.json');
const secretFile = () => path.join(app.getPath('userData'), 'daap-secret.bin');

interface Stored extends DaapSettings {
  proxyPort: number;
  proxyKey: string;
}

interface Session {
  id: number;
  revision: number;
  db: number;
  name: string;
}

export class DaapError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** "host:port" from what the user typed ("host", "host:3689", "http://host:3689/", "[::1]:3689"). */
export function shareId(address: string): string {
  let a = address.trim();
  if (!/^[a-z]+:\/\//i.test(a)) a = `http://${a}`;
  const url = new URL(a);
  return `${url.hostname}:${url.port || DEFAULT_PORT}`;
}

/** URL hostnames keep IPv6 brackets, so a share id is always a valid authority. */
const baseUrl = (id: string) => `http://${id}`;

function song(item: DmapNode): DaapSong | null {
  const id = item.num('miid');
  if (id === undefined || item.num('asdk') === 1) return null; // asdk 1: an internet radio URL, not a file
  const ms = item.num('astm');
  return {
    id,
    title: item.text('minm') || `Track ${id}`,
    artist: item.text('asar') || undefined,
    albumArtist: item.text('asaa') || undefined,
    album: item.text('asal') || undefined,
    genre: item.text('asgn') || undefined,
    duration: ms ? ms / 1000 : undefined,
    track: item.num('astn') || undefined,
    disc: item.num('asdn') || undefined,
    year: item.num('asyr') || undefined,
    format: item.text('asfm')?.replace(/[^a-z0-9]/gi, '').toLowerCase() || undefined,
  };
}

export class Daap {
  private stored: Stored;
  private passwords: Record<string, string> = {};
  private sessions = new Map<string, Promise<Session>>();
  private discovered = new Map<string, { name: string; needsPassword: boolean }>();
  /** Shares that refused us for want of a (right) password. */
  private refused = new Set<string>();
  private songs: DaapSong[] = [];
  private proxy?: Server;
  private _status: DaapStatus = { state: 'disconnected' };
  private connecting = 0;

  constructor(private onStatus: (status: DaapStatus) => void, private onShares: (shares: DaapShare[]) => void) {
    let stored: Partial<Stored> = {};
    try {
      stored = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    } catch {}
    this.stored = {
      servers: Array.isArray(stored.servers) ? stored.servers.filter((s) => typeof s === 'string') : [],
      discover: stored.discover ?? true,
      lastShare: stored.lastShare ?? '',
      proxyPort: stored.proxyPort ?? 0,
      proxyKey: stored.proxyKey ?? randomBytes(16).toString('hex'),
    };
  }

  get status(): DaapStatus {
    return { ...this._status };
  }

  getSettings(): DaapSettings {
    return { servers: [...this.stored.servers], discover: this.stored.discover, lastShare: this.stored.lastShare };
  }

  shares(): DaapShare[] {
    const list = new Map<string, DaapShare>();
    for (const [id, d] of this.discovered) list.set(id, { id, name: d.name, discovered: true, needsPassword: d.needsPassword });
    for (const address of this.stored.servers) {
      let id: string;
      try {
        id = shareId(address);
      } catch {
        continue;
      }
      const found = list.get(id);
      if (found) found.address = address;
      else list.set(id, { id, name: address, discovered: false, address });
    }
    for (const share of list.values()) {
      share.hasPassword = !!this.passwords[share.id];
      if (this.refused.has(share.id)) share.needsPassword = true;
      if (this._status.share?.id === share.id && share.name === share.id) share.name = this._status.share.name;
    }
    return [...list.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Starts the proxy (so saved playlists play) and opens the last share. */
  async start(): Promise<void> {
    try {
      this.passwords = JSON.parse(safeStorage.decryptString(readFileSync(secretFile())));
    } catch {}
    await this.startProxy();
    if (this.stored.discover) void this.discover();
    if (this.stored.lastShare) void this.connect(this.stored.lastShare).catch(() => {});
  }

  stop(): void {
    this.proxy?.close();
    for (const [id, session] of this.sessions) {
      void session.then((s) => fetch(`${baseUrl(id)}/logout?session-id=${s.id}`, { headers: this.headers(id), signal: AbortSignal.timeout(1000) })).catch(() => {});
    }
  }

  /** Looks for shares on the local network. */
  async discover(): Promise<DaapShare[]> {
    const found = await browse('_daap._tcp.local').catch(() => []);
    this.discovered.clear();
    for (const s of found) {
      // The address, not the .local name: fewer lookups, and libaudcore can reach it.
      const id = `${s.address ?? s.host}:${s.port}`;
      this.discovered.set(id, { name: s.txt['Machine Name'] || s.name, needsPassword: /^(true|1)$/i.test(s.txt.Password ?? '') });
    }
    this.onShares(this.shares());
    return this.shares();
  }

  async configure(update: Partial<DaapSettings>): Promise<void> {
    if (Array.isArray(update.servers)) this.stored.servers = [...new Set(update.servers.map((s) => String(s).trim()).filter(Boolean))];
    if (typeof update.discover === 'boolean') this.stored.discover = update.discover;
    this.save();
    if (update.discover) await this.discover();
    else if (update.discover === false) this.discovered.clear();
    this.onShares(this.shares());
  }

  /** Opens a share; `password` (when given) is stored for it. */
  async connect(id: string, password?: string): Promise<DaapStatus> {
    id = shareId(id);
    const attempt = ++this.connecting;
    if (password !== undefined) {
      if (password) this.passwords[id] = password;
      else delete this.passwords[id];
      this.savePasswords();
    }
    this.stored.lastShare = id;
    this.save();
    this.sessions.delete(id);
    this.setStatus({ state: 'connecting', share: { id, name: this.shares().find((s) => s.id === id)?.name ?? id } });
    try {
      const session = await this.session(id);
      const items = await this.get(id, `/databases/${session.db}/items`, { type: 'music', meta: SONG_META });
      if (attempt !== this.connecting) return this.status;
      this.songs = (items.at('mlcl')?.all('mlit') ?? []).map(song).filter((s): s is DaapSong => !!s);
      this.refused.delete(id);
      this.setStatus({ state: 'connected', share: { id, name: session.name }, songCount: this.songs.length, proxyBase: this.proxyBase(id) });
    } catch (err) {
      if (attempt !== this.connecting) return this.status;
      const e = err as DaapError;
      if (e.status === 401) this.refused.add(id);
      this.songs = [];
      this.setStatus({
        state: 'disconnected',
        share: { id, name: this.shares().find((s) => s.id === id)?.name ?? id },
        needsPassword: e.status === 401,
        error: e.status === 401 ? (this.passwords[id] ? 'Wrong password' : 'This library needs a password')
          : e.status === 403 ? 'The share refused this app (iTunes and Music.app need a signature this app cannot make)'
          : e.status === 503 ? 'The share is busy (too many listeners)'
          : e.message,
      });
    }
    this.onShares(this.shares());
    return this.status;
  }

  disconnect(): void {
    this.connecting++;
    this.songs = [];
    this.stored.lastShare = '';
    this.save();
    this.setStatus({ state: 'disconnected' });
  }

  forgetPassword(id: string): void {
    delete this.passwords[shareId(id)];
    this.savePasswords();
    this.onShares(this.shares());
  }

  /** The open share's songs (all of them; the library window pages and groups them). */
  allSongs(): DaapSong[] {
    return this.songs;
  }

  async playlists(): Promise<DaapPlaylist[]> {
    const id = this.openShare();
    const session = await this.session(id);
    const list = await this.get(id, `/databases/${session.db}/containers`, { meta: PLAYLIST_META });
    return (list.at('mlcl')?.all('mlit') ?? [])
      .filter((p) => !p.num('abpl')) // the base playlist is the whole library
      .map((p) => ({ id: p.num('miid') ?? 0, name: p.text('minm') ?? '', count: p.num('mimc'), smart: !!p.num('aeSP') }));
  }

  /** Songs of a playlist, in order. */
  async playlistSongs(playlist: number): Promise<DaapSong[]> {
    const id = this.openShare();
    const session = await this.session(id);
    const list = await this.get(id, `/databases/${session.db}/containers/${playlist}/items`, { type: 'music', meta: 'dmap.itemid,dmap.containeritemid' });
    const byId = new Map(this.songs.map((s) => [s.id, s]));
    return (list.at('mlcl')?.all('mlit') ?? []).map((i) => byId.get(i.num('miid') ?? -1)).filter((s): s is DaapSong => !!s);
  }

  private openShare(): string {
    const id = this._status.state === 'connected' ? this._status.share?.id : undefined;
    if (!id) throw new Error('No shared library is open');
    return id;
  }

  // ---- HTTP ----

  private headers(id: string): Record<string, string> {
    const password = this.passwords[id];
    return password ? { ...HEADERS, Authorization: `Basic ${Buffer.from(`ElectronPlayer:${password}`).toString('base64')}` } : { ...HEADERS };
  }

  private async fetch(id: string, pathname: string, params: Record<string, string | number> = {}, init: RequestInit = {}): Promise<Response> {
    const url = new URL(`${baseUrl(id)}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    try {
      return await fetch(url, { ...init, headers: { ...this.headers(id), ...(init.headers as Record<string, string>) } });
    } catch (err) {
      throw new DaapError(`Cannot reach ${id} (${((err as Error).cause as Error)?.message ?? (err as Error).message})`);
    }
  }

  private async raw(id: string, pathname: string, params: Record<string, string | number> = {}): Promise<DmapNode> {
    const res = await this.fetch(id, pathname, params, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new DaapError(`${pathname}: HTTP ${res.status}`, res.status);
    try {
      return parseDmap(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      throw new DaapError(`Not a DAAP server (${(err as Error).message})`);
    }
  }

  /** A request in the share's session, signing in again once if the session ended. */
  private async get(id: string, pathname: string, params: Record<string, string | number> = {}): Promise<DmapNode> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.session(id);
      try {
        return await this.raw(id, pathname, { ...params, 'session-id': session.id, 'revision-number': session.revision });
      } catch (err) {
        if (attempt || ![401, 403].includes((err as DaapError).status ?? 0)) throw err;
        this.sessions.delete(id);
      }
    }
  }

  /** The share's session, signing in if there is none. */
  private session(id: string): Promise<Session> {
    let session = this.sessions.get(id);
    if (!session) {
      session = this.login(id);
      this.sessions.set(id, session);
      session.catch(() => this.sessions.get(id) === session && this.sessions.delete(id));
    }
    return session;
  }

  private async login(id: string): Promise<Session> {
    const info = await this.raw(id, '/server-info');
    if (info.tag !== 'msrv') throw new DaapError('Not a DAAP server');
    const login = await this.raw(id, '/login');
    const sessionId = login.num('mlid');
    if (sessionId === undefined) throw new DaapError('The share did not start a session');
    const update = await this.raw(id, '/update', { 'session-id': sessionId, 'revision-number': 1 });
    const revision = update.num('musr') ?? 1;
    const dbs = await this.raw(id, '/databases', { 'session-id': sessionId, 'revision-number': revision });
    const db = dbs.at('mlcl', 'mlit');
    if (db?.num('miid') === undefined) throw new DaapError('The share has no library');
    return { id: sessionId, revision, db: db.num('miid')!, name: info.text('minm') || db.text('minm') || id };
  }

  // ---- loopback proxy ----

  private proxyBase(id: string): string {
    const port = (this.proxy?.address() as { port: number } | null)?.port ?? this.stored.proxyPort;
    return `http://127.0.0.1:${port}/daap/${this.stored.proxyKey}/${encodeURIComponent(id)}`;
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
    const m = url.pathname.match(/^\/daap\/([0-9a-f]+)\/([^/]+)\/(stream|art)\/(\d+)(?:\.([a-z0-9]+))?$/i);
    if (!m || m[1] !== this.stored.proxyKey || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const id = decodeURIComponent(m[2]);
    const item = m[4];
    try {
      let up: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = await this.session(id);
        const headers: Record<string, string> = {};
        if (req.headers.range) headers.Range = req.headers.range;
        up = m[3] === 'stream'
          ? await this.fetch(id, `/databases/${session.db}/items/${item}.${m[5] || 'mp3'}`, { 'session-id': session.id }, { headers, method: req.method })
          : await this.fetch(id, `/databases/${session.db}/items/${item}/extra_data/artwork`, { 'session-id': session.id, mw: 300, mh: 300 }, { method: req.method });
        if (up.status !== 401 && up.status !== 403) break;
        this.sessions.delete(id); // session ended: sign in again
      }
      const out: Record<string, string> = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const v = up!.headers.get(h);
        if (v) out[h] = v;
      }
      if (m[3] === 'stream' && !out['content-type']) out['content-type'] = 'application/octet-stream';
      res.writeHead(up!.status, out);
      if (!up!.body || req.method === 'HEAD') return void res.end();
      const body = Readable.fromWeb(up!.body as import('node:stream/web').ReadableStream);
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

  private savePasswords(): void {
    if (!Object.keys(this.passwords).length) {
      writeFileSync(secretFile(), Buffer.alloc(0));
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable, so the password cannot be saved');
    writeFileSync(secretFile(), safeStorage.encryptString(JSON.stringify(this.passwords)));
  }

  private setStatus(status: DaapStatus): void {
    this._status = status;
    this.onStatus(this.status);
  }
}
