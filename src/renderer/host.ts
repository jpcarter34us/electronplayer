import type { Equalizer, EqPreset, PluginInfo } from '../shared/backend.js';
import type { SubsonicSettings, SubsonicSong, SubsonicStatus } from '../shared/subsonic.js';
import type { MaLoginProvider, MaSettings, MaStatus, PlaybackSource, SendspinState } from '../shared/ma.js';
import type { CfgType, PluginPrefsSession, PrefValue, VisId, VisSettings } from '../shared/prefs.js';

/** The preload bridge (src/preload/preload.ts). */
declare global {
  interface Window {
    audHost: {
      openFiles(): Promise<string[]>;
      nativeInfo(): Promise<{ available: boolean; detail: string }>;
      pathForFile(file: File): string;
      call(method: string, ...args: unknown[]): Promise<unknown>;
      onEvent(listener: (event: unknown) => void): () => void;
      openWindow(kind: 'settings' | 'equalizer' | 'plugin-prefs' | 'library', arg?: string): Promise<void>;
      pluginAbout(id: string): Promise<void>;
      choosePath(mode: 'file' | 'folder', current?: string): Promise<string | null>;
      onNavigate(listener: (hash: string) => void): () => void;
      visConfig(): Promise<VisSettings>;
      setVis(id: VisId, on: boolean): Promise<void>;
      setVisOption(option: 'separate' | 'onTop', on: boolean): Promise<void>;
      onVisConfig(listener: (settings: VisSettings) => void): () => void;
      maState(): Promise<{ settings: MaSettings; status: MaStatus; sendspin: SendspinState; source: PlaybackSource }>;
      maConfigure(update: Partial<Omit<MaSettings, 'hasToken'>> & { token?: string }): Promise<MaStatus>;
      maForgetToken(): Promise<void>;
      maSignOut(): Promise<void>;
      maProviders(server: string): Promise<MaLoginProvider[]>;
      maLogin(server: string, username: string, password: string): Promise<MaStatus>;
      maLoginBrowser(server: string, providerId: string): Promise<MaStatus>;
      maCommand(command: string, args?: Record<string, unknown>): Promise<unknown>;
      onMaStatus(listener: (status: MaStatus) => void): () => void;
      onMaSettings(listener: (settings: MaSettings) => void): () => void;
      onMaEvent(listener: (event: { event: string; object_id?: string; data?: unknown }) => void): () => void;
      onSendspinState(listener: (state: SendspinState) => void): () => void;
      onSource(listener: (source: PlaybackSource) => void): () => void;
      subsonicState(): Promise<{ settings: SubsonicSettings; status: SubsonicStatus }>;
      subsonicConfigure(update: { server?: string; username?: string; password?: string; apiKey?: string }): Promise<SubsonicStatus>;
      subsonicSignOut(): Promise<void>;
      subsonicCall(method: string, params?: Record<string, string | number | boolean>): Promise<unknown>;
      subsonicPlay(songs: SubsonicSong[], option: 'play' | 'next' | 'add'): Promise<void>;
      onSubsonicStatus(listener: (status: SubsonicStatus) => void): () => void;
      onSubsonicSettings(listener: (settings: SubsonicSettings) => void): () => void;
    };
  }
}

const call = <T>(method: string, ...args: unknown[]) => window.audHost.call(method, ...args) as Promise<T>;

/** Native-engine features used by the Settings, plugin and Equalizer windows. */
export const native = {
  getConfig: (section: string | null, name: string, type: CfgType) => call<PrefValue>('getConfig', section, name, type),
  setConfig: (section: string | null, name: string, type: CfgType, value: PrefValue) =>
    call<void>('setConfig', section, name, type, value),

  listPlugins: () => call<PluginInfo[]>('listPlugins'),
  enablePlugin: (id: string, enable: boolean) => call<boolean>('enablePlugin', id, enable),

  openPrefs: (id: string) => call<PluginPrefsSession | null>('openPrefs', id),
  prefsSet: (session: number, widget: number, value: PrefValue) =>
    call<Record<string, PrefValue> | null>('prefsSet', session, widget, value),
  prefsButton: (session: number, widget: number) => call<Record<string, PrefValue> | null>('prefsButton', session, widget),
  prefsApply: (session: number) => call<Record<string, PrefValue> | null>('prefsApply', session),
  closePrefs: (session: number) => call<void>('closePrefs', session),

  getEqualizer: () => call<Equalizer>('getEqualizer'),
  setEqualizer: (eq: Partial<Equalizer>) => call<void>('setEqualizer', eq),
  getEqPresets: () => call<EqPreset[]>('getEqPresets'),
  saveEqPresets: (presets: EqPreset[]) => call<boolean>('saveEqPresets', presets),
};

/** Creates an element, assigns `props` (textContent, onclick, ...) and appends children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

/** Strips GTK mnemonics: "_Open" -> "Open", "__" -> "_". */
export const plainLabel = (label: string) => label.replace(/_(_?)/g, (_m, keep) => keep);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Label markup as safe HTML: everything escaped except <b> and <i>. */
export const labelHtml = (label: string) =>
  escapeHtml(plainLabel(label)).replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
