// The contract every playback engine implements. It mirrors the subset of
// libaudcore (drct.h / playlist.h / plugins.h) the UI needs, so the
// HTML5 stub and the native libaudcore bridge are interchangeable.

export interface Track {
  /** file:// or stream URI, as libaudcore's Playlist::entry_filename. */
  uri: string;
  title: string;
  artist?: string;
  album?: string;
  /** Milliseconds; -1 when unknown (same convention as Tuple::Length). */
  length: number;
}

export interface PlaybackState {
  playing: boolean;
  paused: boolean;
  /** Index into the active playlist, -1 when nothing is selected. */
  position: number;
  /** Milliseconds, as aud_drct_get_time(). */
  time: number;
  length: number;
  /** 0-100, as aud_drct_get_volume_main(). */
  volume: number;
}

/** Mirrors libaudcore's PluginType. */
export type PluginType =
  | 'transport' | 'playlist' | 'input' | 'effect'
  | 'output' | 'vis' | 'general' | 'iface';

export interface PluginInfo {
  id: string;
  name: string;
  type: PluginType;
  enabled: boolean;
  hasPrefs: boolean;
  hasAbout?: boolean;
}

/** libaudcore's 10-band equalizer; gains in dB, -12 to +12. */
export interface Equalizer {
  active: boolean;
  preamp: number;
  bands: number[];
}

export interface EqPreset {
  name: string;
  preamp: number;
  bands: number[];
}

/** One libaudcore visualization frame (~30 per second while playing). */
export interface VisFrame {
  /** Intensities of frequencies 1/512 ... 256/512 of the sample rate. */
  freq: Float32Array;
  /** 512 frames of mono PCM, -1 to 1. */
  pcm: Float32Array;
  /** Peak level per channel, 0 to 1. */
  levels: Float32Array;
}

export type BackendEvent =
  | { type: 'state'; state: PlaybackState }
  | { type: 'playlist'; tracks: Track[] }
  | { type: 'error'; message: string }
  // Native engine only:
  | { type: 'equalizer'; equalizer: Equalizer }
  | ({ type: 'vis' } & VisFrame)
  | { type: 'vis-clear' };

export interface AudBackend {
  readonly name: string;

  // aud_drct_*
  play(position?: number): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(volume: number): Promise<void>;

  // Playlist (active playlist only for now)
  add(uris: string[]): Promise<void>;
  remove(positions: number[]): Promise<void>;
  clear(): Promise<void>;
  getPlaylist(): Promise<Track[]>;
  getState(): Promise<PlaybackState>;

  // Plugin registry
  listPlugins(): Promise<PluginInfo[]>;

  subscribe(listener: (event: BackendEvent) => void): () => void;
}
