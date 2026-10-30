import { app, BrowserWindow, screen } from 'electron';
import type { VisId, VisSettings } from '../shared/prefs';
import type { NativeMethod } from './native';
import { rendererFile, webPreferences } from './windows';

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

const IDS: VisId[] = ['spectrum', 'scope', 'vu'];
const TITLES: Record<VisId, string> = { spectrum: 'Spectrum Analyzer', scope: 'Blur Scope', vu: 'VU Meter' };
const DEFAULT_SIZE: Record<VisId, [number, number]> = { spectrum: [480, 160], scope: [480, 160], vu: [320, 110] };

/**
 * Renderer visualizers: which are on, and whether they draw in the main
 * window or each in its own window (like qtui's floating vis docks).
 * Stored in libaudcore's config under [electron]: vis_<id>, vis_separate,
 * vis_on_top and vis_bounds_<id>. libaudcore streams vis frames only while
 * one is on.
 */
export class VisState {
  private settings: VisSettings = { enabled: { spectrum: false, scope: false, vu: false }, separate: false, onTop: false };
  private windows = new Map<VisId, BrowserWindow>();
  private quitting = false;

  constructor(
    private call: Call,
    private onChange: (settings: VisSettings) => void,
  ) {
    // Windows closing because the app quits must not turn visualizers off.
    app.on('before-quit', () => (this.quitting = true));
  }

  async load(): Promise<void> {
    const get = (name: string) => this.call('getConfig', ['electron', name, 'bool']) as Promise<boolean>;
    for (const id of IDS) this.settings.enabled[id] = await get(`vis_${id}`);
    this.settings.separate = await get('vis_separate');
    this.settings.onTop = await get('vis_on_top');
    await this.sync();
  }

  get(): VisSettings {
    return { ...this.settings, enabled: { ...this.settings.enabled } };
  }

  /** Windows that should receive vis frames. */
  targets(mainWindow: BrowserWindow | undefined): BrowserWindow[] {
    if (!this.settings.separate) return mainWindow ? [mainWindow] : [];
    return [...this.windows.values()].filter((w) => !w.isDestroyed() && w.isVisible());
  }

  async set(id: VisId, on: boolean): Promise<void> {
    if (!IDS.includes(id)) return;
    this.settings.enabled[id] = on;
    await this.save(`vis_${id}`, on);
  }

  async setOption(option: 'separate' | 'onTop', on: boolean): Promise<void> {
    this.settings[option] = on;
    await this.save(option === 'separate' ? 'vis_separate' : 'vis_on_top', on);
  }

  private async save(name: string, on: boolean): Promise<void> {
    await this.call('setConfig', ['electron', name, 'bool', on]);
    await this.sync();
    this.onChange(this.get());
  }

  private async sync(): Promise<void> {
    const { enabled, separate, onTop } = this.settings;
    for (const id of IDS) {
      const win = this.windows.get(id);
      if (separate && enabled[id]) {
        if (!win) await this.openWindow(id);
        else win.setAlwaysOnTop(onTop, 'floating');
      } else if (win) {
        this.windows.delete(id);
        win.close();
      }
    }
    await this.call('visEnable', [IDS.some((id) => enabled[id])]);
  }

  private async openWindow(id: VisId): Promise<void> {
    const saved = String(await this.call('getConfig', ['electron', `vis_bounds_${id}`, 'string']));
    const [x, y, width, height] = saved.split(',').map(Number);
    const [defaultWidth, defaultHeight] = DEFAULT_SIZE[id];
    // Use saved bounds only if they are still on a connected display.
    const onScreen = saved && screen.getAllDisplays().some(({ workArea: a }) => x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height);

    const win = new BrowserWindow({
      title: TITLES[id],
      ...(onScreen ? { x, y, width, height } : { width: defaultWidth, height: defaultHeight }),
      minWidth: 160,
      minHeight: 60,
      backgroundColor: '#1e1f22',
      alwaysOnTop: this.settings.onTop,
      fullscreenable: false,
      show: false,
      webPreferences: webPreferences(),
    });
    if (this.settings.onTop) win.setAlwaysOnTop(true, 'floating');
    // Keep "Spectrum Analyzer" etc. rather than the page's generic <title>.
    win.on('page-title-updated', (e) => e.preventDefault());
    this.windows.set(id, win);
    win.once('ready-to-show', () => win.show());
    win.loadFile(rendererFile('vis.html'), { hash: id });

    win.on('close', () => {
      const b = win.getBounds();
      void this.call('setConfig', ['electron', `vis_bounds_${id}`, 'string', `${b.x},${b.y},${b.width},${b.height}`]);
    });
    win.on('closed', () => {
      // Closed by the user (not by sync() or quitting): turn it off.
      if (this.windows.get(id) === win) {
        this.windows.delete(id);
        if (!this.quitting) void this.set(id, false);
      }
    });
  }
}
