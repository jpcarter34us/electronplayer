import type { AudBackend, BackendEvent, PlaybackState, PluginInfo, Track } from '../../shared/backend.js';

/**
 * The real Audacious engine: libaudcore and its plugins running in the main
 * process (native/src/addon.cc), reached over IPC.
 */
export class NativeBackend implements AudBackend {
  readonly name = 'libaudcore';

  private call<T = void>(method: keyof AudBackend, ...args: unknown[]): Promise<T> {
    return window.audHost.call(method, ...args) as Promise<T>;
  }

  play(position?: number) { return this.call('play', position); }
  pause() { return this.call('pause'); }
  stop() { return this.call('stop'); }
  next() { return this.call('next'); }
  prev() { return this.call('prev'); }
  seek(ms: number) { return this.call('seek', ms); }
  setVolume(volume: number) { return this.call('setVolume', volume); }

  add(uris: string[]) { return this.call('add', uris); }
  remove(positions: number[]) { return this.call('remove', positions); }
  clear() { return this.call('clear'); }
  getPlaylist() { return this.call<Track[]>('getPlaylist'); }
  getState() { return this.call<PlaybackState>('getState'); }

  listPlugins() { return this.call<PluginInfo[]>('listPlugins'); }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    return window.audHost.onEvent((e) => listener(e as BackendEvent));
  }
}
