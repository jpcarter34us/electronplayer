import path from 'node:path';
import type { BackendEvent } from '../shared/backend';

export interface NativeInfo {
  available: boolean;
  /** Plugin API version when loaded, otherwise why it could not be. */
  detail: string;
}

/** Backend methods the renderer may invoke over IPC. */
export const NATIVE_METHODS = [
  'play', 'pause', 'stop', 'next', 'prev', 'seek', 'setVolume',
  'add', 'open', 'insert', 'playLive', 'stopLive', 'remove', 'clear', 'getPlaylist', 'getState', 'listPlugins',
  'getConfig', 'setConfig', 'enablePlugin', 'pluginAbout', 'command',
  'openPrefs', 'prefsGet', 'prefsSet', 'prefsButton', 'prefsApply', 'closePrefs',
  'getEqualizer', 'setEqualizer', 'getEqPresets', 'saveEqPresets', 'visEnable',
] as const;

export type NativeMethod = (typeof NATIVE_METHODS)[number];

type Addon = Record<NativeMethod, (...args: unknown[]) => Promise<unknown>> & {
  version(): string;
  init(configHome: string, onEvent: (event: BackendEvent) => void): Promise<void>;
  shutdown(): void;
};

export interface NativeCore {
  info: NativeInfo;
  /** Resolves once libaudcore's main loop is running. */
  ready?: Promise<void>;
  call?(method: NativeMethod, args: unknown[]): Promise<unknown>;
  shutdown?(): void;
}

/**
 * Loads the libaudcore N-API bridge from native/build if it has been built
 * (`npm run build:native`) and starts the engine. Until then the renderer
 * falls back to the HTML5 backend.
 */
export function loadNativeCore(configHome: string, onEvent: (event: BackendEvent) => void): NativeCore {
  const addonPath = path.join(__dirname, '../../native/build/Release/audcore.node');
  let addon: Addon;
  try {
    addon = require(addonPath);
  } catch (err) {
    return { info: { available: false, detail: (err as Error).message.split('\n')[0] } };
  }

  const ready = addon.init(configHome, onEvent);
  return {
    info: { available: true, detail: addon.version() },
    ready,
    async call(method, args) {
      if (!NATIVE_METHODS.includes(method)) throw new Error(`Unknown method ${method}`);
      await ready;
      return addon[method](...args);
    },
    shutdown: () => addon.shutdown(),
  };
}
