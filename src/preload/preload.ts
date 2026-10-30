import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

const api = {
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('aud:open-files'),
  nativeInfo: (): Promise<{ available: boolean; detail: string }> => ipcRenderer.invoke('aud:native-info'),
  /** Resolves a dropped File to its absolute path (sandboxed renderers can't). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Invokes a libaudcore backend method in the main process. */
  call: (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('aud:call', method, args),
  /** Subscribes to libaudcore events; returns an unsubscribe function. */
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: unknown) => listener(event);
    ipcRenderer.on('aud:event', handler);
    return () => ipcRenderer.removeListener('aud:event', handler);
  },
};

export type AudHostApi = typeof api;

contextBridge.exposeInMainWorld('audHost', api);
