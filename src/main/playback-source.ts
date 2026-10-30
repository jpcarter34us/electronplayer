import { ipcMain } from 'electron';
import type { BackendEvent, PlaybackState } from '../shared/backend';
import type { MaSettings, PlaybackSource, SendspinState } from '../shared/ma';
import { broadcast, MusicAssistant } from './music-assistant';
import type { NativeMethod } from './native';
import { SendspinHost } from './sendspin';
import { LiveRouter } from './sendspin-live';

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

/** Transport methods that follow the active source. */
const TRANSPORT = new Set<string>(['play', 'pause', 'stop', 'next', 'prev', 'seek', 'setVolume']);

/**
 * Two engines can play: local libaudcore and the Sendspin player (Music
 * Assistant). Whichever started last is the active source. The transport
 * (main window buttons, menus, Touch Bar) controls it, and starting one
 * pauses the other.
 */
export class PlaybackSources {
  readonly ma: MusicAssistant;
  readonly sendspin: SendspinHost;
  private _source: PlaybackSource = 'local';
  private localPlaying = false;
  private maPlaying = false;
  /** Plays Music Assistant audio in libaudcore when "Play through the Audacious engine" is on. */
  readonly live?: LiveRouter;
  private listeners: ((source: PlaybackSource, sendspin: SendspinState) => void)[] = [];

  constructor(private native?: Call) {
    this.live = native ? new LiveRouter(native) : undefined;
    this.sendspin = new SendspinHost(
      (state) => this.onSendspinState(state),
      // Only while Music Assistant is the source: after local playback takes
      // over, audio still in flight must not restart the live stream.
      (chunk) => {
        if (this._source === 'ma') this.live?.push(chunk, [this.sendspin.state.artist, this.sendspin.state.title].filter(Boolean).join(' - ') || 'Music Assistant');
      },
      (e) => {
        if (e.event === 'start' && e.rate && e.channels) this.live?.streamStart(e.rate, e.channels);
        else if (e.event === 'clear') this.live?.streamClear();
        else if (e.event === 'end') void this.live?.end();
      },
    );
    this.ma = new MusicAssistant(
      (status) => broadcast('aud:ma-status', status),
      (event) => broadcast('aud:ma-event', event),
      (settings) => {
        broadcast('aud:ma-settings', settings);
        this.applySendspin(settings);
      },
    );
    this.registerIpc();
  }

  start(): void {
    void this.live?.start().then(() => {
      this.ma.start();
      this.applySendspin(this.ma.getSettings());
    });
  }

  stop(): void {
    this.sendspin.stop();
    this.live?.stop();
    this.ma.stop();
  }

  get source(): PlaybackSource {
    return this._source;
  }

  /** Called with the source and Sendspin state whenever either changes. */
  onChange(listener: (source: PlaybackSource, sendspin: SendspinState) => void): void {
    this.listeners.push(listener);
  }

  /** Feed every libaudcore event: local playback starting takes over. */
  onNativeEvent(event: BackendEvent): void {
    if (event.type !== 'state') return;
    // libaudcore playing Music Assistant's live stream is not local playback.
    const playing = event.state.playing && !event.state.paused && !event.state.live;
    if (playing && !this.localPlaying && this._source === 'ma') {
      void this.live?.end(); // local playback replaced the live stream in libaudcore
      if (this.sendspin.state.playing) this.sendCommand(this.sendspin.supports('pause') ? 'pause' : 'stop');
      this.setSource('local');
    }
    this.localPlaying = playing;
  }

  /**
   * libaudcore-style call that sends transport methods to the active
   * source. play(position) always means a local playlist entry.
   */
  readonly call: Call = async (method, args) => {
    if (this._source === 'ma' && TRANSPORT.has(method) && !(method === 'play' && typeof args[0] === 'number')) {
      return this.maTransport(method, args);
    }
    if (!this.native) throw new Error('libaudcore is not loaded');
    return this.native(method, args);
  };

  private maTransport(method: string, args: unknown[]): void {
    const playing = this.sendspin.state.playing;
    switch (method) {
      case 'play': return this.sendCommand('play');
      // The local pause toggles; do the same for Music Assistant.
      case 'pause': return this.sendCommand(playing ? 'pause' : 'play');
      case 'stop': return this.sendCommand(this.sendspin.supports('stop') ? 'stop' : 'pause');
      case 'next': return this.sendCommand('next');
      case 'prev': return this.sendCommand('previous');
      case 'seek': return this.sendCommand('seek', { position_ms: Math.max(0, Math.round(Number(args[0]) || 0)) });
      case 'setVolume': return this.sendspin.command('local-volume', { volume: Number(args[0]) });
    }
  }

  private sendCommand(command: string, args?: Record<string, unknown>): void {
    this.sendspin.command(command, args);
  }

  private onSendspinState(state: SendspinState): void {
    broadcast('aud:sendspin-state', state);
    // Switch only when Music Assistant *starts* playing, not on every update
    // while it plays: otherwise a stream still winding down after local
    // playback took over would grab the transport back.
    const started = state.playing && !this.maPlaying;
    if (!state.playing && this.maPlaying) void this.live?.end(); // paused or stopped
    this.maPlaying = state.playing;
    if (started && this._source !== 'ma') {
      // Music Assistant started streaming here: pause local playback.
      if (this.localPlaying && this.native) void this.native('pause', []);
      this.setSource('ma', state);
    } else if (!state.enabled && this._source === 'ma') this.setSource('local', state);
    else this.notify(state);
  }

  private setSource(source: PlaybackSource, state = this.sendspin.state): void {
    this._source = source;
    broadcast('aud:source', source);
    this.notify(state);
  }

  private notify(state: SendspinState): void {
    for (const l of this.listeners) l(this._source, state);
  }

  private applySendspin(settings: MaSettings): void {
    const throughAudacious = settings.throughAudacious && !!this.live;
    if (!throughAudacious) void this.live?.end();
    this.sendspin.apply(settings.sendspin, this.ma.sendspinUrl(), settings.playerName, throughAudacious);
  }

  private registerIpc(): void {
    ipcMain.handle('aud:ma-state', () => ({
      settings: this.ma.getSettings(),
      status: this.ma.status(),
      sendspin: this.sendspin.state,
      source: this._source,
    }));
    ipcMain.handle('aud:ma-configure', (_e, update: Partial<MaSettings> & { token?: string }) => {
      const clean: Partial<MaSettings> & { token?: string } = {};
      if (typeof update.server === 'string') clean.server = update.server.trim();
      if (typeof update.token === 'string') clean.token = update.token.trim();
      if (typeof update.sendspin === 'boolean') clean.sendspin = update.sendspin;
      if (typeof update.playerName === 'string') clean.playerName = update.playerName.trim() || this.ma.getSettings().playerName;
      if (typeof update.sendspinUrl === 'string') clean.sendspinUrl = update.sendspinUrl.trim();
      if (typeof update.throughAudacious === 'boolean') clean.throughAudacious = update.throughAudacious;
      return this.ma.configure(clean);
    });
    ipcMain.handle('aud:ma-forget-token', () => this.ma.forgetToken());
    ipcMain.handle('aud:ma-sign-out', () => this.ma.signOut());
    ipcMain.handle('aud:ma-providers', (_e, server: string) => this.ma.loginProviders(String(server ?? '')));
    ipcMain.handle('aud:ma-login', (_e, server: string, username: string, password: string) =>
      this.ma.loginWithPassword(String(server ?? ''), String(username ?? ''), String(password ?? '')));
    ipcMain.handle('aud:ma-login-browser', (_e, server: string, providerId: string) =>
      this.ma.loginWithBrowser(String(server ?? ''), String(providerId ?? '')));
    ipcMain.handle('aud:ma-command', (_e, command: string, args: Record<string, unknown>) =>
      this.ma.command(String(command), args && typeof args === 'object' ? args : {}));
  }
}

/** Touch Bar / display view of Music Assistant playback as local-style state. */
export function sendspinAsLocal(s: SendspinState): { title: string; state: PlaybackState } {
  const elapsed = s.speed ? (Date.now() - s.progressAt) * s.speed : 0;
  const time = Math.min(s.durationMs || Infinity, s.progressMs + elapsed);
  return {
    title: [s.artist, s.title].filter(Boolean).join(' - ') || 'Music Assistant',
    state: { playing: s.playing || s.speed === 0, paused: !s.playing, position: 0, time: Math.round(time), length: s.durationMs || -1, volume: s.volume },
  };
}
