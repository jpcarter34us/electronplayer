import type { AudBackend, BackendEvent, PlaybackState, PluginInfo, Track } from '../../shared/backend.js';

/**
 * Stand-in engine built on <audio>. It only decodes what Chromium can
 * (MP3, FLAC, Vorbis, Opus, WAV, AAC) and has no effects or gapless
 * playback. It exists so UI work can proceed before the native libaudcore
 * bridge is ready; NativeBackend replaces it behind the same interface.
 */
export class Html5Backend implements AudBackend {
  readonly name = 'HTML5 (stub)';

  private audio = new Audio();
  private tracks: Track[] = [];
  private position = -1;
  private listeners = new Set<(e: BackendEvent) => void>();

  constructor() {
    this.audio.preload = 'metadata';
    for (const ev of ['play', 'pause', 'timeupdate', 'durationchange', 'volumechange', 'emptied']) {
      this.audio.addEventListener(ev, () => this.emitState());
    }
    this.audio.addEventListener('loadedmetadata', () => {
      const t = this.tracks[this.position];
      if (t) {
        t.length = Math.round(this.audio.duration * 1000);
        this.emitPlaylist();
      }
    });
    // Advance like Audacious does with "advance when the current song is deleted/ends".
    this.audio.addEventListener('ended', () => {
      if (this.position + 1 < this.tracks.length) void this.play(this.position + 1);
      else this.emitState();
    });
    this.audio.addEventListener('error', () => {
      this.emit({ type: 'error', message: `Cannot decode ${this.tracks[this.position]?.title ?? 'file'} with the HTML5 backend` });
    });
  }

  async play(position?: number): Promise<void> {
    if (position !== undefined && position !== this.position) {
      if (position < 0 || position >= this.tracks.length) return;
      this.position = position;
      this.audio.src = this.tracks[position].uri;
    } else if (this.position < 0 && this.tracks.length) {
      return this.play(0);
    }
    await this.audio.play().catch(() => {});
  }

  async pause(): Promise<void> {
    if (this.audio.paused) await this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  async stop(): Promise<void> {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  async next(): Promise<void> {
    if (this.position + 1 < this.tracks.length) await this.play(this.position + 1);
  }

  async prev(): Promise<void> {
    if (this.position > 0) await this.play(this.position - 1);
  }

  async seek(ms: number): Promise<void> {
    this.audio.currentTime = ms / 1000;
  }

  async setVolume(volume: number): Promise<void> {
    this.audio.volume = Math.min(100, Math.max(0, volume)) / 100;
  }

  async add(uris: string[]): Promise<void> {
    for (const uri of uris) {
      const file = decodeURIComponent(uri.split('/').pop() ?? uri);
      this.tracks.push({ uri, title: file.replace(/\.[^.]+$/, ''), length: -1 });
    }
    this.emitPlaylist();
  }

  async remove(positions: number[]): Promise<void> {
    const drop = new Set(positions);
    const current = this.tracks[this.position];
    this.tracks = this.tracks.filter((_, i) => !drop.has(i));
    this.position = current ? this.tracks.indexOf(current) : -1;
    if (this.position < 0) await this.stop();
    this.emitPlaylist();
  }

  async clear(): Promise<void> {
    await this.remove(this.tracks.map((_, i) => i));
  }

  async getPlaylist(): Promise<Track[]> {
    return [...this.tracks];
  }

  async getState(): Promise<PlaybackState> {
    const hasSrc = !!this.audio.currentSrc;
    return {
      playing: hasSrc,
      paused: hasSrc && this.audio.paused,
      position: this.position,
      time: Math.round(this.audio.currentTime * 1000),
      length: Number.isFinite(this.audio.duration) ? Math.round(this.audio.duration * 1000) : -1,
      volume: Math.round(this.audio.volume * 100),
    };
  }

  async listPlugins(): Promise<PluginInfo[]> {
    return [{ id: 'html5', name: 'Chromium media decoder', type: 'input', enabled: true, hasPrefs: false }];
  }

  subscribe(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: BackendEvent): void {
    for (const l of this.listeners) l(e);
  }

  private async emitState(): Promise<void> {
    this.emit({ type: 'state', state: await this.getState() });
  }

  private emitPlaylist(): void {
    this.emit({ type: 'playlist', tracks: [...this.tracks] });
  }
}
