import type { AudBackend, PlaybackState, Track } from '../shared/backend.js';
import type { VisId, VisSettings } from '../shared/prefs.js';
import { Html5Backend } from './backends/html5.js';
import { NativeBackend } from './backends/native.js';
import './host.js';
import { createVisualizer, type Visualizer } from './visualizers.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fmt = (ms: number) => {
  if (ms < 0) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function main(): Promise<void> {
  const native = await window.audHost.nativeInfo();
  const backend: AudBackend = native.available ? new NativeBackend() : new Html5Backend();
  $('backend').textContent = native.available ? `libaudcore (${native.detail})` : backend.name;
  $('backend').title = native.detail;

  // libaudcore restores the last session's playlist, so start from it.
  let tracks: Track[] = await backend.getPlaylist();
  let state: PlaybackState = await backend.getState();
  let seeking = false;

  const list = $<HTMLOListElement>('playlist');
  const seek = $<HTMLInputElement>('seek');

  const renderPlaylist = () => {
    list.replaceChildren(
      ...tracks.map((t, i) => {
        const li = document.createElement('li');
        li.className = i === state.position ? 'current' : '';
        li.innerHTML = `<span class="n">${i + 1}.</span><span class="t"></span><span class="len">${fmt(t.length)}</span>`;
        li.querySelector('.t')!.textContent = t.title;
        li.ondblclick = () => backend.play(i);
        li.oncontextmenu = (e) => { e.preventDefault(); void backend.remove([i]); };
        return li;
      }),
    );
    $('count').textContent = `${tracks.length} song${tracks.length === 1 ? '' : 's'}`;
  };

  const renderState = () => {
    const t = tracks[state.position];
    $('title').textContent = t ? t.title : 'Audacious';
    $('time').textContent = `${fmt(state.time)} / ${fmt(state.length)}`;
    $('play').textContent = state.playing && !state.paused ? '⏸' : '▶';
    seek.max = String(Math.max(state.length, 0));
    $<HTMLInputElement>('volume').value = String(state.volume);
    if (!seeking) seek.value = String(state.time);
    list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('current', i === state.position));
  };

  // Visualizations (native engine only): one canvas per enabled visualizer,
  // unless they are shown in separate windows (vis.ts).
  const visualizers = new Map<VisId, Visualizer>();
  const showVis = (settings: VisSettings) => {
    const config = settings.enabled;
    for (const id of Object.keys(config) as VisId[]) {
      if (config[id] && !settings.separate && !visualizers.has(id)) {
        const vis = createVisualizer(id);
        vis.canvas.className = `vis vis-${id}`;
        visualizers.set(id, vis);
      } else if (!config[id] || settings.separate) visualizers.delete(id);
    }
    const order: VisId[] = ['spectrum', 'scope', 'vu'];
    $('vis').replaceChildren(...order.filter((id) => visualizers.has(id)).map((id) => visualizers.get(id)!.canvas));
    $('vis').hidden = visualizers.size === 0;
  };
  if (native.available) {
    showVis(await window.audHost.visConfig());
    window.audHost.onVisConfig(showVis);
  }

  backend.subscribe((e) => {
    if (e.type === 'state') { state = e.state; renderState(); }
    else if (e.type === 'playlist') { tracks = e.tracks; renderPlaylist(); renderState(); }
    else if (e.type === 'vis') visualizers.forEach((v) => v.render(e));
    else if (e.type === 'vis-clear') visualizers.forEach((v) => v.clear());
    else if (e.type === 'error') $('status').textContent = e.message;
  });

  $('open').onclick = async () => backend.add(await window.audHost.openFiles());
  $('play').onclick = () => (state.playing ? backend.pause() : backend.play());
  $('stop').onclick = () => backend.stop();
  $('prev').onclick = () => backend.prev();
  $('next').onclick = () => backend.next();
  $('clear').onclick = () => backend.clear();
  $<HTMLInputElement>('volume').oninput = (e) => backend.setVolume(Number((e.target as HTMLInputElement).value));
  seek.oninput = () => { seeking = true; };
  seek.onchange = async () => { await backend.seek(Number(seek.value)); seeking = false; };

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    const uris = files.map((f) => 'file://' + window.audHost.pathForFile(f).split('/').map(encodeURIComponent).join('/'));
    void backend.add(uris);
  });

  renderPlaylist();
  renderState();
}

void main();
