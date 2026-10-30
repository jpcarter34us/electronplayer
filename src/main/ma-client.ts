import { randomUUID } from 'node:crypto';

// Client for the Music Assistant server's WebSocket API (ws://host:8095/ws),
// following music-assistant/client (music_assistant_client/client.py):
//
//  1. The server sends its ServerInfo as the first message.
//  2. Schema >= 28 requires an `auth` command with a long-lived token.
//  3. Commands are {message_id, command, args}; replies carry the same
//     message_id with `result` (possibly streamed with `partial: true`) or
//     `error_code` + `details`.
//  4. Everything else is an event: {event, object_id, data}.

export interface MaServerInfo {
  server_id: string;
  server_version: string;
  schema_version: number;
  min_supported_schema_version: number;
  base_url?: string;
  name?: string;
}

export interface MaEvent {
  event: string;
  object_id?: string;
  data?: unknown;
}

export interface MaUser {
  username: string;
  display_name?: string;
}

export type MaStatus =
  | { state: 'disconnected'; error?: string; authFailed?: boolean }
  | { state: 'connecting' }
  | { state: 'connected'; server: MaServerInfo; user?: MaUser };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  partial: unknown[] | null;
  timer: NodeJS.Timeout;
}

const COMMAND_TIMEOUT_MS = 30_000;

/** ws://host:port/ws from what the user typed ("host", "http://host:8095", ...). */
export function wsUrl(server: string): string {
  let url = server.trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = '8095';
  parsed.protocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/ws$/, '') + '/ws';
  return parsed.toString();
}

/** http(s)://host:port for image URLs. */
export function httpBase(server: string): string {
  const url = new URL(wsUrl(server));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Runs one command that needs no authentication (auth/login,
 * auth/providers, auth/authorization_url) on its own short connection.
 */
export function maAnonymousCommand<T>(server: string, command: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(server));
    } catch {
      return reject(new Error('Invalid server address'));
    }
    const message_id = randomUUID().replace(/-/g, '');
    let gotInfo = false;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('Music Assistant did not answer'))), timeoutMs);
    ws.onerror = () => done(() => reject(new Error(`Cannot reach ${wsUrl(server)}`)));
    ws.onclose = () => done(() => reject(new Error('Connection closed')));
    ws.onmessage = (msg) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!gotInfo) {
        gotInfo = true;
        if (typeof data.schema_version !== 'number') return done(() => reject(new Error('Not a Music Assistant server')));
        ws.send(JSON.stringify({ message_id, command, args }));
        return;
      }
      if (data.message_id !== message_id || data.partial) return;
      if ('error_code' in data) done(() => reject(new Error(String(data.details ?? 'Request failed'))));
      else done(() => resolve(data.result as T));
    };
  });
}

export class MaClient {
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = 1000;
  private stopped = true;
  private _status: MaStatus = { state: 'disconnected' };

  constructor(
    private onStatus: (status: MaStatus) => void,
    private onEvent: (event: MaEvent) => void,
    /** Sent with `auth`, so the sign-in is labelled in Music Assistant. */
    private deviceName = '',
  ) {}

  get status(): MaStatus {
    return this._status;
  }

  /** Connects (and keeps reconnecting) until disconnect(). */
  connect(server: string, token: string): Promise<MaServerInfo> {
    this.disconnect();
    this.stopped = false;
    this.server = server;
    this.token = token;
    return this.open();
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
    this.failPending(new Error('Disconnected'));
    this.setStatus({ state: 'disconnected' });
  }

  async command<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this._status.state !== 'connected') throw new Error('Not connected to Music Assistant');
    return this.send<T>(command, args);
  }

  private server = '';
  private token = '';

  private open(): Promise<MaServerInfo> {
    this.setStatus({ state: 'connecting' });
    return new Promise((resolve, reject) => {
      let url: string;
      try {
        url = wsUrl(this.server);
      } catch {
        const error = 'Invalid server address';
        this.stopped = true;
        this.setStatus({ state: 'disconnected', error });
        return reject(new Error(error));
      }

      const ws = (this.ws = new WebSocket(url));
      let handshake = true;
      let settled = false;
      const fail = (error: string, retry: boolean, authFailed = false) => {
        if (!settled) {
          settled = true;
          reject(new Error(error));
        }
        if (this.ws === ws) {
          this.ws = undefined;
          ws.close();
          this.failPending(new Error(error));
          this.setStatus({ state: 'disconnected', error, authFailed });
          if (retry && !this.stopped) this.scheduleReconnect();
          else this.stopped = true;
        }
      };

      ws.onmessage = async (msg) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (!handshake) return this.dispatch(data);

        // First message: server info, then authenticate.
        handshake = false;
        const info = data as unknown as MaServerInfo;
        if (typeof info.schema_version !== 'number') return fail('Not a Music Assistant server', false);
        let user: MaUser | undefined;
        try {
          if (info.schema_version >= 28) {
            if (!this.token) return fail('Sign in to this Music Assistant server', false, true);
            const result = await this.send<{ user?: MaUser } | boolean>('auth', {
              token: this.token,
              ...(this.deviceName ? { device_name: this.deviceName } : {}),
            });
            if (!result) return fail('Your sign-in has expired or was revoked. Sign in again.', false, true);
            if (typeof result === 'object') user = result.user;
          }
        } catch (err) {
          return fail(`Your sign-in was not accepted (${(err as Error).message}). Sign in again.`, false, true);
        }
        settled = true;
        this.reconnectDelay = 1000;
        this.setStatus({ state: 'connected', server: info, user });
        resolve(info);
      };
      ws.onerror = () => fail(`Cannot reach ${url}`, true);
      ws.onclose = () => fail('Connection closed', true);
    });
  }

  private send<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to Music Assistant'));
    const message_id = randomUUID().replace(/-/g, '');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message_id);
        reject(new Error(`${command} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(message_id, { resolve: resolve as (v: unknown) => void, reject, partial: null, timer });
      ws.send(JSON.stringify({ message_id, command, args }));
    });
  }

  private dispatch(data: Record<string, unknown>): void {
    const id = data.message_id as string | undefined;
    if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      if ('error_code' in data) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(String(data.details ?? `Music Assistant error ${data.error_code}`)));
        return;
      }
      // Chunked results: accumulate until the final message.
      if (data.partial) {
        (p.partial ??= []).push(...((data.result as unknown[]) ?? []));
        return;
      }
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(p.partial ? [...p.partial, ...((data.result as unknown[]) ?? [])] : data.result);
      return;
    }
    if (typeof data.event === 'string') this.onEvent(data as unknown as MaEvent);
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.open().catch(() => {}), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private setStatus(status: MaStatus): void {
    this._status = status;
    this.onStatus(status);
  }
}
