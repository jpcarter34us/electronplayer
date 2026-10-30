import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('aud:open-files'),
  nativeInfo: (): Promise<{ available: boolean; detail: string }> => ipcRenderer.invoke('aud:native-info'),
  /** Resolves a dropped File to its absolute path (sandboxed renderers can't). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Invokes a libaudcore backend method in the main process. */
  call: (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('aud:call', method, args),
  /** Subscribes to libaudcore events; returns an unsubscribe function. */
  onEvent: (listener: (event: unknown) => void): (() => void) => on('aud:event', listener),

  /** Opens the Settings ("settings", page), Equalizer or a plugin's settings window. */
  openWindow: (kind: 'settings' | 'equalizer' | 'plugin-prefs' | 'library', arg?: string): Promise<void> =>
    ipcRenderer.invoke('aud:open-window', kind, arg),
  pluginAbout: (id: string): Promise<void> => ipcRenderer.invoke('aud:plugin-about', id),
  /** Returns a file:// URI, or null if cancelled. */
  choosePath: (mode: 'file' | 'folder', current?: string): Promise<string | null> =>
    ipcRenderer.invoke('aud:choose-path', mode, current),
  /** Settings window: the main process asks to show another page. */
  onNavigate: (listener: (hash: string) => void): (() => void) => on('aud:navigate', listener),

  /** { enabled: { spectrum, scope, vu }, separate, onTop } */
  visConfig: (): Promise<unknown> => ipcRenderer.invoke('aud:vis-config'),
  setVis: (id: string, on: boolean): Promise<void> => ipcRenderer.invoke('aud:set-vis', id, on),
  setVisOption: (option: 'separate' | 'onTop', on: boolean): Promise<void> => ipcRenderer.invoke('aud:set-vis-option', option, on),
  onVisConfig: (listener: (settings: unknown) => void): (() => void) => on('aud:vis-config', listener),

  // Music Assistant (see src/main/music-assistant.ts)
  /** { settings, status, sendspin, source } */
  maState: (): Promise<unknown> => ipcRenderer.invoke('aud:ma-state'),
  /** Saves settings; a non-empty `token` replaces the stored one. */
  maConfigure: (update: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('aud:ma-configure', update),
  maForgetToken: (): Promise<void> => ipcRenderer.invoke('aud:ma-forget-token'),
  maSignOut: (): Promise<void> => ipcRenderer.invoke('aud:ma-sign-out'),
  maProviders: (server: string): Promise<unknown> => ipcRenderer.invoke('aud:ma-providers', server),
  /** The password goes to the server once; only the returned session token is stored. */
  maLogin: (server: string, username: string, password: string): Promise<unknown> => ipcRenderer.invoke('aud:ma-login', server, username, password),
  maLoginBrowser: (server: string, providerId: string): Promise<unknown> => ipcRenderer.invoke('aud:ma-login-browser', server, providerId),
  maCommand: (command: string, args?: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('aud:ma-command', command, args ?? {}),
  onMaStatus: (listener: (status: unknown) => void): (() => void) => on('aud:ma-status', listener),
  onMaSettings: (listener: (settings: unknown) => void): (() => void) => on('aud:ma-settings', listener),
  onMaEvent: (listener: (event: unknown) => void): (() => void) => on('aud:ma-event', listener),
  onSendspinState: (listener: (state: unknown) => void): (() => void) => on('aud:sendspin-state', listener),
  onSource: (listener: (source: string) => void): (() => void) => on('aud:source', listener),

  // OpenSubsonic (see src/main/subsonic.ts)
  /** { settings, status } */
  subsonicState: (): Promise<unknown> => ipcRenderer.invoke('aud:subsonic-state'),
  /** Saves settings; a password or API key, when given, replaces the stored one. */
  subsonicConfigure: (update: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('aud:subsonic-configure', update),
  subsonicSignOut: (): Promise<void> => ipcRenderer.invoke('aud:subsonic-sign-out'),
  subsonicCall: (method: string, params?: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('aud:subsonic-call', method, params ?? {}),
  /** Adds songs to the local playlist: "play" (after the current song, and plays), "next", "add". */
  subsonicPlay: (songs: unknown[], option: string): Promise<void> => ipcRenderer.invoke('aud:subsonic-play', songs, option),
  onSubsonicStatus: (listener: (status: unknown) => void): (() => void) => on('aud:subsonic-status', listener),
  onSubsonicSettings: (listener: (settings: unknown) => void): (() => void) => on('aud:subsonic-settings', listener),

  // Hidden Sendspin host window only (src/renderer/sendspin-host.ts)
  sendspinConfig: (): Promise<unknown> => ipcRenderer.invoke('aud:sendspin-config'),
  sendspinState: (state: unknown): void => ipcRenderer.send('aud:sendspin-state', state),
  onSendspinCommand: (listener: (command: unknown) => void): (() => void) => on('aud:sendspin-command', listener),
};

export type AudHostApi = typeof api;

contextBridge.exposeInMainWorld('audHost', api);
