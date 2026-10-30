import type { AudBackend, PlaybackState, Track } from '../shared/backend.js';
import type { PlaybackSource, SendspinState } from '../shared/ma.js';
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

  // Music Assistant (Sendspin) as the active source; see playback-source.ts.
  let source: PlaybackSource = 'local';
  let ma: SendspinState | undefined;

  const renderMa = (m: SendspinState) => {
    const elapsed = m.speed ? (Date.now() - m.progressAt) * m.speed : 0;
    const time = m.durationMs ? Math.min(m.durationMs, m.progressMs + elapsed) : m.progressMs + elapsed;
    $('title').textContent = [m.artist, m.title].filter(Boolean).join(' – ') || 'Music Assistant';
    $('source').textContent = `Music Assistant${m.groupName ? ` · ${m.groupName}` : ''}${m.album ? ` · ${m.album}` : ''}`;
    $('time').textContent = `${fmt(time)} / ${fmt(m.durationMs || -1)}`;
    $('play').textContent = m.playing ? '⏸' : '▶';
    seek.max = String(m.durationMs || 0);
    $<HTMLInputElement>('volume').value = String(m.volume);
    if (!seeking) seek.value = String(time);
    const cover = $<HTMLImageElement>('cover');
    if (m.artworkUrl && cover.getAttribute('src') !== m.artworkUrl) cover.src = m.artworkUrl;
    cover.hidden = !m.artworkUrl;
  };

  const renderState = () => {
    const maActive = source === 'ma' && !!ma;
    $('source').hidden = !maActive;
    list.classList.toggle('inactive', maActive);
    if (maActive) return renderMa(ma!);
    $<HTMLImageElement>('cover').hidden = true;
    const t = tracks[state.position];
    $('title').textContent = t ? t.title : 'ElectronPlayer';
    $('time').textContent = `${fmt(state.time)} / ${fmt(state.length)}`;
    $('play').textContent = state.playing && !state.paused ? '⏸' : '▶';
    seek.max = String(Math.max(state.length, 0));
    $<HTMLInputElement>('volume').value = String(state.volume);
    if (!seeking) seek.value = String(state.time);
    list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('current', i === state.position));
  };

  const renderPairing = () => {
    $('status').textContent = ma?.pairingCode
      ? `Pair this player in Music Assistant with code ${ma.pairingCode}`
      : 'Drop files here or click ⏏ · right-click a song to remove it';
    $('status').classList.toggle('pairing', !!ma?.pairingCode);
  };

  if (native.available) {
    const st = await window.audHost.maState();
    source = st.source;
    ma = st.sendspin;
    $('library').hidden = false;
    $('library').onclick = () => window.audHost.openWindow('library');
    window.audHost.onSource((s) => { source = s; renderState(); });
    window.audHost.onSendspinState((s) => { ma = s; renderPairing(); if (source === 'ma') renderState(); });
    // Advance the time display between Music Assistant updates.
    setInterval(() => source === 'ma' && ma?.playing && !seeking && renderState(), 250);
    renderPairing();
  }

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
  // In Music Assistant mode pause() toggles the remote queue (playback-source.ts).
  $('play').onclick = () => (source === 'ma' || state.playing ? backend.pause() : backend.play());
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
