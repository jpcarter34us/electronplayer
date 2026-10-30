import { BrowserWindow, ipcMain } from 'electron';
import type { SendspinState } from '../shared/ma';
import { rendererFile, webPreferences } from './windows';

// Hosts the Sendspin player (src/renderer/sendspin-host.ts) in a hidden
// window, so it keeps playing whichever app windows are open, and relays
// its state and commands.

const OFF: SendspinState = {
  enabled: false, connection: 'off', playing: false, progressMs: 0, durationMs: 0,
  progressAt: 0, speed: 0, volume: 100, muted: false, commands: [],
};

export interface PcmChunk {
  playAt: number;
  rate: number;
  channels: number;
  pcm: ArrayBuffer;
}

export type StreamEvent = { event: 'start' | 'clear' | 'end'; rate?: number; channels?: number };

export class SendspinHost {
  private win?: BrowserWindow;
  private config = { url: '', name: '', throughAudacious: false };
  private _state: SendspinState = { ...OFF };

  constructor(
    private onState: (state: SendspinState) => void,
    /** Decoded audio when playing through Audacious. */
    private onPcm: (chunk: PcmChunk) => void = () => {},
    private onStream: (event: StreamEvent) => void = () => {},
  ) {
    // Only the hidden host window may use these channels.
    const fromHost = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === this.win?.webContents;
    ipcMain.handle('aud:sendspin-config', (event) => (fromHost(event) ? this.config : null));
    ipcMain.on('aud:sendspin-state', (event, update: Partial<SendspinState>) => {
      if (!fromHost(event)) return;
      this._state = { ...this._state, ...update, enabled: true };
      this.onState(this.state);
    });
    ipcMain.on('aud:sendspin-pcm', (event, chunk: PcmChunk) => {
      if (fromHost(event) && chunk?.pcm instanceof ArrayBuffer) this.onPcm(chunk);
    });
    ipcMain.on('aud:sendspin-stream', (event, e: StreamEvent) => {
      if (fromHost(event)) this.onStream(e);
    });
  }

  get state(): SendspinState {
    return { ...this._state };
  }

  /** Starts, restarts (after a config change) or stops the player. */
  apply(enabled: boolean, url: string, name: string, throughAudacious = false): void {
    const changed = url !== this.config.url || name !== this.config.name || throughAudacious !== this.config.throughAudacious;
    this.config = { url, name, throughAudacious };
    if (!enabled || !url) return this.stop();
    if (this.win && !changed) return;

    this.stop();
    this._state = { ...OFF, enabled: true, connection: 'connecting' };
    this.onState(this.state);
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        ...webPreferences(),
        // Timers and audio scheduling must not be throttled while hidden.
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    const win = this.win;
    // close() finishes later: by then a restart may have replaced this.win.
    win.on('closed', () => {
      if (this.win === win) this.win = undefined;
    });
    void win.loadFile(rendererFile('sendspin.html'));
  }

  command(command: string, args?: Record<string, unknown>): void {
    this.win?.webContents.send('aud:sendspin-command', { command, args });
  }

  /** Whether the server accepts a controller command right now. */
  supports(command: string): boolean {
    return this._state.commands.includes(command);
  }

  stop(): void {
    // close() (not destroy()) lets the page send client/goodbye.
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = undefined;
    if (this._state.enabled || this._state.connection !== 'off') {
      this._state = { ...OFF };
      this.onState(this.state);
    }
  }
}
