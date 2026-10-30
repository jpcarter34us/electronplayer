import type { VisConfig, VisId } from '../shared/prefs';
import type { NativeMethod } from './native';

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

const IDS: VisId[] = ['spectrum', 'scope', 'vu'];

/**
 * Which renderer visualizers are on. Stored in libaudcore's config under
 * [electron] vis_<id>, like the upstream plugin registry remembers enabled
 * vis plugins; libaudcore streams vis frames only while one is on.
 */
export class VisState {
  private config: VisConfig = { spectrum: false, scope: false, vu: false };

  constructor(
    private call: Call,
    private onChange: (config: VisConfig) => void,
  ) {}

  async load(): Promise<void> {
    for (const id of IDS) this.config[id] = (await this.call('getConfig', ['electron', `vis_${id}`, 'bool'])) as boolean;
    await this.sync();
  }

  get(): VisConfig {
    return { ...this.config };
  }

  async set(id: VisId, on: boolean): Promise<void> {
    if (!IDS.includes(id)) return;
    this.config[id] = on;
    await this.call('setConfig', ['electron', `vis_${id}`, 'bool', on]);
    await this.sync();
    this.onChange(this.get());
  }

  private sync(): Promise<unknown> {
    return this.call('visEnable', [IDS.some((id) => this.config[id])]);
  }
}
