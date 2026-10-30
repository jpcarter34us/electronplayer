import type { MaImage, MaItem, MaPlayer, MaSettings, MaStatus, SendspinState } from '../shared/ma.js';
import { h } from './host.js';

// Music Assistant library browser: library sections, provider browsing and
// search, with Play Now / Play Next / Add to Queue on any Music Assistant
// player (this computer's Sendspin player by default).

const PAGE = 100;
const LIBRARY: [string, string, 'grid' | 'list'][] = [
  ['artists', 'Artists', 'grid'],
  ['albums', 'Albums', 'grid'],
  ['tracks', 'Tracks', 'list'],
  ['playlists', 'Playlists', 'grid'],
  ['radios', 'Radio', 'grid'],
  ['podcasts', 'Podcasts', 'grid'],
];
/** Items that open into a list instead of playing on click. */
const CONTAINERS = new Set(['artist', 'album', 'playlist', 'podcast', 'audiobook', 'folder', 'genre']);
const ICONS: Record<string, string> = { artist: '👤', album: '💿', track: '♪', playlist: '☰', radio: '📻', podcast: '🎙', folder: '📁', audiobook: '📖' };

interface View {
  title: string;
  layout: 'grid' | 'list';
  load(offset: number): Promise<MaItem[]>;
  /** Search results render as sections instead. */
  sections?: () => Promise<[string, MaItem[], 'grid' | 'list'][]>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const call = <T>(command: string, args: Record<string, unknown> = {}) => window.audHost.maCommand(command, args) as Promise<T>;

let status: MaStatus = { state: 'disconnected' };
let settings: MaSettings;
let sendspin: SendspinState;
let stack: View[] = [];
let players: MaPlayer[] = [];

// ---- images ----

function imageOf(item: MaItem): MaImage | undefined {
  return item.image ?? item.metadata?.images?.find((i) => i.type === 'thumb') ?? item.metadata?.images?.[0];
}

// As music_assistant_client's get_image_url, without the third-party resize service.
function imageUrl(image: MaImage | undefined, size = 256): string | undefined {
  if (!image?.path) return undefined;
  if (image.remotely_accessible) return image.path;
  if (!status.httpBase) return undefined;
  if (image.proxy_id) return `${status.httpBase}/imageproxy/${encodeURIComponent(image.proxy_id)}?size=${size}`;
  return `${status.httpBase}/imageproxy?path=${encodeURIComponent(encodeURIComponent(image.path))}&provider=${encodeURIComponent(image.provider)}&size=${size}`;
}

function art(item: MaItem, className: string): HTMLElement {
  const box = h('div', { className, textContent: ICONS[item.media_type] ?? '♪' });
  const url = imageUrl(imageOf(item));
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy' });
    img.onerror = () => img.remove(); // keep the icon
    box.append(img);
  }
  return box;
}

// ---- playback ----

const uriOf = (item: MaItem) => item.uri ?? `${item.provider}://${item.media_type}/${item.item_id}`;
const playerId = () => $<HTMLSelectElement>('player').value;
const playerName = () => players.find((p) => p.player_id === playerId())?.display_name ?? players.find((p) => p.player_id === playerId())?.name ?? 'player';

async function play(item: MaItem, option: 'play' | 'next' | 'add') {
  if (!playerId()) return toast('Choose a player first');
  try {
    await call('player_queues/play_media', { queue_id: playerId(), media: [uriOf(item)], option });
    const verb = option === 'play' ? 'Playing' : option === 'next' ? 'Playing next' : 'Added to queue';
    toast(`${verb} on ${playerName()}: ${item.name}`);
  } catch (err) {
    toast((err as Error).message, true);
  }
}

let toastTimer: number | undefined;
function toast(message: string, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500);
}

// ---- players ----

async function loadPlayers() {
  if (status.state !== 'connected') return;
  try {
    players = (await call<MaPlayer[]>('players/all'))
      .filter((p) => p.available && !p.hide_in_ui && !p.hidden && p.enabled !== false)
      .sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name));
  } catch {
    players = [];
  }
  const select = $<HTMLSelectElement>('player');
  const own = players.find((p) => p.player_id === sendspin?.clientId || p.name === settings.playerName);
  const wanted = select.value || localStorage.getItem('ma-player') || own?.player_id || players[0]?.player_id || '';
  select.replaceChildren(...players.map((p) =>
    h('option', { value: p.player_id, textContent: (p.display_name ?? p.name) + (p === own ? ' (this computer)' : '') })));
  select.value = players.some((p) => p.player_id === wanted) ? wanted : own?.player_id ?? players[0]?.player_id ?? '';
}

// ---- views ----

const library = (type: string, title: string, layout: 'grid' | 'list'): View => ({
  title, layout,
  load: (offset) => call<MaItem[]>(`music/${type}/library_items`, { limit: PAGE, offset }),
});

function viewFor(item: MaItem): View | undefined {
  const ref = { item_id: item.item_id, provider_instance_id_or_domain: item.provider };
  switch (item.media_type) {
    case 'artist':
      return {
        title: item.name, layout: 'grid', load: async () => [],
        sections: async () => {
          const [albums, tracks] = await Promise.all([
            call<MaItem[]>('music/artists/artist_albums', ref).catch(() => []),
            call<MaItem[]>('music/artists/artist_tracks', ref).catch(() => []),
          ]);
          return [['Albums', albums, 'grid'], ['Tracks', tracks, 'list']];
        },
      };
    case 'album': return { title: item.name, layout: 'list', load: (offset) => offset ? Promise.resolve([]) : call('music/albums/album_tracks', ref) };
    case 'playlist': return { title: item.name, layout: 'list', load: (offset) => call('music/playlists/playlist_tracks', { ...ref, offset, limit: PAGE }) };
    case 'podcast': return { title: item.name, layout: 'list', load: (offset) => offset ? Promise.resolve([]) : call('music/podcasts/podcast_episodes', ref) };
    case 'folder': return { title: item.label || item.name, layout: 'list', load: (offset) => call('music/browse', { path: item.path, offset, limit: PAGE }) };
  }
}

const subtitle = (item: MaItem) =>
  [item.artists?.map((a) => a.name).join(', '), item.media_type === 'track' ? item.album?.name : undefined].filter(Boolean).join(' · ');

const fmt = (sec?: number) => (sec ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '');

function actions(item: MaItem): HTMLElement {
  const b = (label: string, title: string, option: 'play' | 'next' | 'add') =>
    h('button', { textContent: label, title, onclick: (e: Event) => (e.stopPropagation(), void play(item, option)) });
  return h('span', { className: 'ma-actions' }, b('▶', 'Play now', 'play'), b('⤵', 'Play next', 'next'), b('+', 'Add to queue', 'add'));
}

// Enter opens an item. (Not `e.key === 'Enter' && open(item)`: an on*
// handler returning false cancels the key, blocking Tab, Space, Cmd+C...)
const onEnter = (item: MaItem) => (e: KeyboardEvent) => {
  if (e.key === 'Enter') open(item);
};

function open(item: MaItem) {
  const view = viewFor(item);
  if (view) push(view);
  else if (item.is_playable !== false) void play(item, 'play');
}

function renderItems(items: MaItem[], layout: 'grid' | 'list'): HTMLElement {
  if (layout === 'grid') {
    return h('div', { className: 'ma-grid' }, ...items.map((item) => {
      const card = h('div', { className: 'ma-card', tabIndex: 0, title: item.name, onclick: () => open(item), onkeydown: onEnter(item) },
        art(item, 'ma-art'), h('div', { className: 'ma-name', textContent: item.name }), h('div', { className: 'ma-sub', textContent: subtitle(item) }));
      if (item.is_playable !== false && item.media_type !== 'folder') card.append(actions(item));
      return card;
    }));
  }
  return h('div', { className: 'ma-list' }, ...items.map((item, i) => {
    const playable = item.is_playable !== false && item.media_type !== 'folder';
    return h('div', { className: 'ma-row', tabIndex: 0, ondblclick: () => open(item), onkeydown: onEnter(item), onclick: () => CONTAINERS.has(item.media_type) && open(item) },
      h('span', { className: 'ma-index', textContent: String(i + 1) }),
      art(item, 'ma-thumb'),
      h('span', { className: 'ma-text' }, h('span', { className: 'ma-name', textContent: item.name + (item.version ? ` (${item.version})` : '') }), h('span', { className: 'ma-sub', textContent: subtitle(item) })),
      h('span', { className: 'ma-duration', textContent: fmt(item.duration) }),
      playable ? actions(item) : h('span', { className: 'ma-actions' }));
  }));
}

let renderToken = 0;
async function render() {
  const content = $('content');
  const view = stack[stack.length - 1];
  $<HTMLButtonElement>('back').disabled = stack.length < 2;
  $('title').textContent = view?.title ?? '';
  document.querySelectorAll('#nav button').forEach((b) => b.setAttribute('aria-current', String(stack.length === 1 && (b as HTMLButtonElement).textContent === view?.title)));

  if (status.state !== 'connected') {
    content.replaceChildren(h('div', { className: 'ma-empty' },
      h('p', { textContent: status.state === 'connecting' ? 'Connecting to Music Assistant…' : status.error ? `Not connected: ${status.error}` : 'Not connected to Music Assistant.' }),
      h('button', { className: 'primary', textContent: 'Music Assistant Settings…', onclick: () => window.audHost.openWindow('settings', 'music-assistant') })));
    return;
  }
  if (!view) return;
  const token = ++renderToken;
  content.replaceChildren(h('p', { className: 'muted', textContent: 'Loading…' }));
  try {
    if (view.sections) {
      const sections = await view.sections();
      if (token !== renderToken) return;
      const nonEmpty = sections.filter(([, items]) => items.length);
      content.replaceChildren(...(nonEmpty.length
        ? nonEmpty.flatMap(([title, items, layout]) => [h('h2', { textContent: title }), renderItems(items, layout)])
        : [h('p', { className: 'muted', textContent: 'Nothing found.' })]));
      return;
    }
    let offset = 0;
    const items = await view.load(0);
    if (token !== renderToken) return;
    content.replaceChildren(items.length ? renderItems(items, view.layout) : h('p', { className: 'muted', textContent: 'Nothing here.' }));
    if (items.length >= PAGE) {
      const more = h('button', { textContent: 'Load More', className: 'ma-more' });
      more.onclick = async () => {
        more.disabled = true;
        offset += PAGE;
        const next = await view.load(offset).catch(() => []);
        const list = renderItems(next, view.layout);
        content.querySelector('.ma-grid, .ma-list')?.append(...list.children);
        if (next.length < PAGE) more.remove();
        else more.disabled = false;
      };
      content.append(more);
    }
  } catch (err) {
    if (token === renderToken) content.replaceChildren(h('p', { className: 'muted', textContent: `Could not load: ${(err as Error).message}` }));
  }
}

function push(view: View) {
  stack.push(view);
  void render();
}

function setRoot(view: View) {
  stack = [view];
  void render();
}

function search(query: string) {
  if (!query.trim()) return setRoot(library(...LIBRARY[0]));
  setRoot({
    title: `Search: ${query}`, layout: 'grid', load: async () => [],
    sections: async () => {
      const r = await call<Record<string, MaItem[]>>('music/search', {
        search_query: query, media_types: ['artist', 'album', 'track', 'playlist', 'radio'], limit: 25,
      });
      return [['Artists', r.artists ?? [], 'grid'], ['Albums', r.albums ?? [], 'grid'], ['Tracks', r.tracks ?? [], 'list'],
        ['Playlists', r.playlists ?? [], 'grid'], ['Radio', r.radio ?? [], 'grid']];
    },
  });
}

async function main() {
  ({ settings, status, sendspin } = await window.audHost.maState());

  const nav = $('nav');
  for (const [type, title, layout] of LIBRARY) nav.append(h('button', { textContent: title, onclick: () => setRoot(library(type, title, layout)) }));
  nav.append(h('button', { textContent: 'Browse', onclick: () => setRoot({ title: 'Browse', layout: 'list', load: (offset) => call('music/browse', { offset, limit: PAGE }) }) }));

  $('back').onclick = () => {
    if (stack.length > 1) stack.pop();
    void render();
  };
  let searchTimer: number | undefined;
  const input = $<HTMLInputElement>('search');
  input.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => search(input.value), 350);
  };
  $<HTMLSelectElement>('player').onchange = () => localStorage.setItem('ma-player', playerId());

  window.audHost.onMaStatus((s) => {
    const was = status.state;
    status = s;
    if (s.state !== was) {
      if (s.state === 'connected') void loadPlayers();
      void render();
    }
  });
  window.audHost.onMaSettings((s) => (settings = s));
  window.audHost.onSendspinState((s) => {
    const had = sendspin?.clientId;
    sendspin = s;
    if (s.clientId !== had) void loadPlayers();
  });
  let playersTimer: number | undefined;
  window.audHost.onMaEvent((e) => {
    if (e.event === 'player_added' || e.event === 'player_removed' || (e.event === 'player_updated' && !players.some((p) => p.player_id === e.object_id))) {
      clearTimeout(playersTimer);
      playersTimer = window.setTimeout(() => void loadPlayers(), 500);
    }
  });

  await loadPlayers();
  setRoot(library(...LIBRARY[0]));
}

void main();
