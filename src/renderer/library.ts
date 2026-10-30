import type { MaImage, MaItem, MaPlayer, MaSettings, MaStatus, SendspinState } from '../shared/ma.js';
import type { SubsonicSong, SubsonicStatus } from '../shared/subsonic.js';
import { h } from './host.js';

// The Library window: browse Music Assistant or an OpenSubsonic server
// (Navidrome, ...). Music Assistant plays on any of its players (this
// computer's Sendspin player by default); Subsonic songs go into the local
// Audacious playlist. The location hash picks the source: #ma or #subsonic.

type SourceId = 'ma' | 'subsonic';
type Option = 'play' | 'next' | 'add';
type Layout = 'grid' | 'list';

/** One browsable thing, whichever source it came from. */
interface Item {
  name: string;
  kind: string;
  subtitle?: string;
  duration?: number;
  image?: string;
  /** Opens into a view instead of playing on click. */
  open?: () => View;
  /** Plays (or queues) it; absent for things that only open. */
  play?: (option: Option) => Promise<string>;
}

interface View {
  title: string;
  layout: Layout;
  load(offset: number): Promise<Item[]>;
  sections?: () => Promise<[string, Item[], Layout][]>;
}

interface Source {
  id: SourceId;
  label: string;
  connected(): boolean;
  status(): string;
  settingsPage: string;
  sections(): [string, () => View][];
  search(query: string): View;
  /** Shown next to the search box: where items play. */
  target(): HTMLElement;
}

const PAGE = 100;
const ICONS: Record<string, string> = { artist: '👤', album: '💿', track: '♪', song: '♪', playlist: '☰', radio: '📻', podcast: '🎙', folder: '📁', audiobook: '📖' };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (sec?: number) => (sec ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '');

// ===================== Music Assistant =====================

let maStatus: MaStatus = { state: 'disconnected' };
let maSettings: MaSettings;
let sendspin: SendspinState;
let players: MaPlayer[] = [];
const maCall = <T>(command: string, args: Record<string, unknown> = {}) => window.audHost.maCommand(command, args) as Promise<T>;
const playerSelect = h('select', { id: 'player', ariaLabel: 'Play on' });

function maImage(item: MaItem, size = 256): string | undefined {
  const image: MaImage | undefined = item.image ?? item.metadata?.images?.find((i) => i.type === 'thumb') ?? item.metadata?.images?.[0];
  if (!image?.path) return undefined;
  if (image.remotely_accessible) return image.path;
  if (!maStatus.httpBase) return undefined;
  if (image.proxy_id) return `${maStatus.httpBase}/imageproxy/${encodeURIComponent(image.proxy_id)}?size=${size}`;
  return `${maStatus.httpBase}/imageproxy?path=${encodeURIComponent(encodeURIComponent(image.path))}&provider=${encodeURIComponent(image.provider)}&size=${size}`;
}

const maPlayerName = () => {
  const p = players.find((x) => x.player_id === playerSelect.value);
  return p?.display_name ?? p?.name ?? 'player';
};

function maItem(item: MaItem): Item {
  const ref = { item_id: item.item_id, provider_instance_id_or_domain: item.provider };
  const view = (layout: Layout, load: View['load']): (() => View) => () => ({ title: item.name, layout, load });
  let open: (() => View) | undefined;
  switch (item.media_type) {
    case 'artist':
      open = () => ({
        title: item.name, layout: 'grid', load: async () => [],
        sections: async () => {
          const [albums, tracks] = await Promise.all([
            maCall<MaItem[]>('music/artists/artist_albums', ref).catch(() => []),
            maCall<MaItem[]>('music/artists/artist_tracks', ref).catch(() => []),
          ]);
          return [['Albums', albums.map(maItem), 'grid'], ['Tracks', tracks.map(maItem), 'list']];
        },
      });
      break;
    case 'album': open = view('list', async (o) => (o ? [] : (await maCall<MaItem[]>('music/albums/album_tracks', ref)).map(maItem))); break;
    case 'playlist': open = view('list', async (o) => (await maCall<MaItem[]>('music/playlists/playlist_tracks', { ...ref, offset: o, limit: PAGE })).map(maItem)); break;
    case 'podcast': open = view('list', async (o) => (o ? [] : (await maCall<MaItem[]>('music/podcasts/podcast_episodes', ref)).map(maItem))); break;
    case 'folder':
      open = () => ({ title: item.label || item.name, layout: 'list', load: async (o) => (await maCall<MaItem[]>('music/browse', { path: item.path, offset: o, limit: PAGE })).map(maItem) });
      break;
  }
  const playable = item.is_playable !== false && item.media_type !== 'folder';
  return {
    name: item.name + (item.version ? ` (${item.version})` : ''),
    kind: item.media_type,
    subtitle: [item.artists?.map((a) => a.name).join(', '), item.media_type === 'track' ? item.album?.name : undefined].filter(Boolean).join(' · '),
    duration: item.duration,
    image: maImage(item),
    open,
    play: playable
      ? async (option) => {
          if (!playerSelect.value) throw new Error('Choose a player first');
          await maCall('player_queues/play_media', { queue_id: playerSelect.value, media: [item.uri ?? `${item.provider}://${item.media_type}/${item.item_id}`], option });
          return maPlayerName();
        }
      : undefined,
  };
}

async function loadPlayers() {
  if (maStatus.state !== 'connected') return;
  try {
    players = (await maCall<MaPlayer[]>('players/all'))
      .filter((p) => p.available && !p.hide_in_ui && !p.hidden && p.enabled !== false)
      .sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name));
  } catch {
    players = [];
  }
  const own = players.find((p) => p.player_id === sendspin?.clientId || p.name === maSettings.playerName);
  const wanted = playerSelect.value || localStorage.getItem('ma-player') || own?.player_id || players[0]?.player_id || '';
  playerSelect.replaceChildren(...players.map((p) =>
    h('option', { value: p.player_id, textContent: (p.display_name ?? p.name) + (p === own ? ' (this computer)' : '') })));
  playerSelect.value = players.some((p) => p.player_id === wanted) ? wanted : own?.player_id ?? players[0]?.player_id ?? '';
}
playerSelect.onchange = () => localStorage.setItem('ma-player', playerSelect.value);

const maSource: Source = {
  id: 'ma',
  label: 'Music Assistant',
  connected: () => maStatus.state === 'connected',
  status: () => (maStatus.state === 'connecting' ? 'Connecting to Music Assistant…' : maStatus.error ? `Not connected: ${maStatus.error}` : 'Not connected to Music Assistant.'),
  settingsPage: 'music-assistant',
  sections: () => [
    ...([['artists', 'Artists', 'grid'], ['albums', 'Albums', 'grid'], ['tracks', 'Tracks', 'list'], ['playlists', 'Playlists', 'grid'], ['radios', 'Radio', 'grid'], ['podcasts', 'Podcasts', 'grid']] as [string, string, Layout][])
      .map(([type, title, layout]): [string, () => View] => [title, () => ({ title, layout, load: async (offset) => (await maCall<MaItem[]>(`music/${type}/library_items`, { limit: PAGE, offset })).map(maItem) })]),
    ['Browse', () => ({ title: 'Browse', layout: 'list', load: async (offset) => (await maCall<MaItem[]>('music/browse', { offset, limit: PAGE })).map(maItem) })],
  ],
  search: (query) => ({
    title: `Search: ${query}`, layout: 'grid', load: async () => [],
    sections: async () => {
      const r = await maCall<Record<string, MaItem[]>>('music/search', { search_query: query, media_types: ['artist', 'album', 'track', 'playlist', 'radio'], limit: 25 });
      return [['Artists', r.artists ?? [], 'grid'], ['Albums', r.albums ?? [], 'grid'], ['Tracks', r.tracks ?? [], 'list'], ['Playlists', r.playlists ?? [], 'grid'], ['Radio', r.radio ?? [], 'grid']]
        .map(([t, items, l]) => [t, (items as MaItem[]).map(maItem), l] as [string, Item[], Layout]);
    },
  }),
  target: () => h('label', { className: 'ma-player' }, 'Play on ', playerSelect),
};

// ===================== OpenSubsonic =====================

let ssStatus: SubsonicStatus = { state: 'disconnected' };
const ssCall = <T = Record<string, unknown>>(method: string, params: Record<string, string | number | boolean> = {}) =>
  window.audHost.subsonicCall(method, params) as Promise<T>;
const cover = (id?: string, size = 256) => (id && ssStatus.proxyBase ? `${ssStatus.proxyBase}/cover/${encodeURIComponent(id)}?size=${size}` : undefined);

interface SsArtist { id: string; name: string; coverArt?: string; albumCount?: number }
interface SsAlbum { id: string; name: string; artist?: string; coverArt?: string; songCount?: number; year?: number }
interface SsPlaylist { id: string; name: string; songCount?: number; coverArt?: string; owner?: string }

const ssPlay = async (songs: SubsonicSong[], option: Option) => {
  await window.audHost.subsonicPlay(songs, option);
  return 'this computer';
};

function ssSong(s: SubsonicSong): Item {
  return { name: s.title, kind: 'song', subtitle: [s.artist, s.album].filter(Boolean).join(' · '), duration: s.duration, image: cover(s.coverArt, 96), play: (o) => ssPlay([s], o) };
}

const albumSongs = async (id: string) => ((await ssCall<{ album: { song?: SubsonicSong[] } }>('getAlbum', { id })).album.song ?? []);
const playlistSongs = async (id: string) => ((await ssCall<{ playlist: { entry?: SubsonicSong[] } }>('getPlaylist', { id })).playlist.entry ?? []);

function ssAlbum(a: SsAlbum): Item {
  return {
    name: a.name, kind: 'album', subtitle: [a.artist, a.year].filter(Boolean).join(' · '), image: cover(a.coverArt),
    open: () => ({ title: a.name, layout: 'list', load: async (o) => (o ? [] : (await albumSongs(a.id)).map(ssSong)) }),
    play: async (o) => ssPlay(await albumSongs(a.id), o),
  };
}

function ssArtist(a: SsArtist): Item {
  return {
    name: a.name, kind: 'artist', subtitle: a.albumCount ? `${a.albumCount} album${a.albumCount === 1 ? '' : 's'}` : undefined, image: cover(a.coverArt),
    open: () => ({ title: a.name, layout: 'grid', load: async (o) => (o ? [] : ((await ssCall<{ artist: { album?: SsAlbum[] } }>('getArtist', { id: a.id })).artist.album ?? []).map(ssAlbum)) }),
  };
}

function ssPlaylist(p: SsPlaylist): Item {
  return {
    name: p.name, kind: 'playlist', subtitle: p.songCount ? `${p.songCount} songs` : undefined, image: cover(p.coverArt),
    open: () => ({ title: p.name, layout: 'list', load: async (o) => (o ? [] : (await playlistSongs(p.id)).map(ssSong)) }),
    play: async (o) => ssPlay(await playlistSongs(p.id), o),
  };
}

const subsonicSource: Source = {
  id: 'subsonic',
  label: 'Subsonic',
  connected: () => ssStatus.state === 'connected',
  status: () => (ssStatus.state === 'connecting' ? 'Connecting to the Subsonic server…' : ssStatus.error ? `Not connected: ${ssStatus.error}` : 'Not connected to a Subsonic server.'),
  settingsPage: 'subsonic',
  sections: () => [
    ['Artists', () => ({
      title: 'Artists', layout: 'grid',
      load: async (o) => (o ? [] : ((await ssCall<{ artists: { index?: { artist?: SsArtist[] }[] } }>('getArtists')).artists.index ?? []).flatMap((i) => i.artist ?? []).map(ssArtist)),
    })],
    ['Albums', () => ({
      title: 'Albums', layout: 'grid',
      load: async (offset) => ((await ssCall<{ albumList2: { album?: SsAlbum[] } }>('getAlbumList2', { type: 'alphabeticalByName', size: PAGE, offset })).albumList2.album ?? []).map(ssAlbum),
    })],
    ['Recently Added', () => ({
      title: 'Recently Added', layout: 'grid',
      load: async (offset) => ((await ssCall<{ albumList2: { album?: SsAlbum[] } }>('getAlbumList2', { type: 'newest', size: PAGE, offset })).albumList2.album ?? []).map(ssAlbum),
    })],
    ['Playlists', () => ({
      title: 'Playlists', layout: 'grid',
      load: async (o) => (o ? [] : ((await ssCall<{ playlists: { playlist?: SsPlaylist[] } }>('getPlaylists')).playlists.playlist ?? []).map(ssPlaylist)),
    })],
    ['Starred', () => ({
      title: 'Starred', layout: 'grid', load: async () => [],
      sections: async () => {
        const s = (await ssCall<{ starred2: { artist?: SsArtist[]; album?: SsAlbum[]; song?: SubsonicSong[] } }>('getStarred2')).starred2;
        return [['Artists', (s.artist ?? []).map(ssArtist), 'grid'], ['Albums', (s.album ?? []).map(ssAlbum), 'grid'], ['Songs', (s.song ?? []).map(ssSong), 'list']];
      },
    })],
    ['Random Songs', () => ({
      title: 'Random Songs', layout: 'list',
      load: async (o) => (o ? [] : ((await ssCall<{ randomSongs: { song?: SubsonicSong[] } }>('getRandomSongs', { size: 50 })).randomSongs.song ?? []).map(ssSong)),
    })],
  ],
  search: (query) => ({
    title: `Search: ${query}`, layout: 'grid', load: async () => [],
    sections: async () => {
      const r = (await ssCall<{ searchResult3: { artist?: SsArtist[]; album?: SsAlbum[]; song?: SubsonicSong[] } }>('search3', { query, artistCount: 20, albumCount: 20, songCount: 50 })).searchResult3;
      return [['Artists', (r.artist ?? []).map(ssArtist), 'grid'], ['Albums', (r.album ?? []).map(ssAlbum), 'grid'], ['Songs', (r.song ?? []).map(ssSong), 'list']];
    },
  }),
  target: () => h('span', { className: 'ma-player', textContent: 'Plays in Audacious' }),
};

// ===================== Window =====================

const SOURCES: Source[] = [maSource, subsonicSource];
let source: Source = SOURCES[0];
let stack: View[] = [];

let toastTimer: number | undefined;
function toast(message: string, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500);
}

async function play(item: Item, option: Option) {
  try {
    const where = await item.play!(option);
    toast(`${option === 'play' ? 'Playing' : option === 'next' ? 'Playing next' : 'Added to queue'} on ${where}: ${item.name}`);
  } catch (err) {
    toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
}

function art(item: Item, className: string): HTMLElement {
  const box = h('div', { className, textContent: ICONS[item.kind] ?? '♪' });
  if (item.image) {
    const img = h('img', { src: item.image, alt: '', loading: 'lazy' });
    img.onerror = () => img.remove(); // keep the icon
    box.append(img);
  }
  return box;
}

function actions(item: Item): HTMLElement {
  const b = (label: string, title: string, option: Option) =>
    h('button', { textContent: label, title, onclick: (e: Event) => (e.stopPropagation(), void play(item, option)) });
  return h('span', { className: 'ma-actions' }, b('▶', 'Play now', 'play'), b('⤵', 'Play next', 'next'), b('+', 'Add to queue', 'add'));
}

function activate(item: Item) {
  if (item.open) push(item.open());
  else if (item.play) void play(item, 'play');
}

// Enter activates. (Not `e.key === 'Enter' && ...`: an on* handler that
// returns false cancels the key, blocking Tab, Space, Cmd+C...)
const onEnter = (item: Item) => (e: KeyboardEvent) => {
  if (e.key === 'Enter') activate(item);
};

function renderItems(items: Item[], layout: Layout): HTMLElement {
  if (layout === 'grid') {
    return h('div', { className: 'ma-grid' }, ...items.map((item) => {
      const card = h('div', { className: 'ma-card', tabIndex: 0, title: item.name, onclick: () => activate(item), onkeydown: onEnter(item) },
        art(item, 'ma-art'), h('div', { className: 'ma-name', textContent: item.name }), h('div', { className: 'ma-sub', textContent: item.subtitle ?? '' }));
      if (item.play) card.append(actions(item));
      return card;
    }));
  }
  return h('div', { className: 'ma-list' }, ...items.map((item, i) =>
    h('div', { className: 'ma-row', tabIndex: 0, ondblclick: () => activate(item), onkeydown: onEnter(item), onclick: () => item.open && activate(item) },
      h('span', { className: 'ma-index', textContent: String(i + 1) }),
      art(item, 'ma-thumb'),
      h('span', { className: 'ma-text' }, h('span', { className: 'ma-name', textContent: item.name }), h('span', { className: 'ma-sub', textContent: item.subtitle ?? '' })),
      h('span', { className: 'ma-duration', textContent: fmt(item.duration) }),
      item.play ? actions(item) : h('span', { className: 'ma-actions' }))));
}

let renderToken = 0;
async function render() {
  const content = $('content');
  const view = stack[stack.length - 1];
  $<HTMLButtonElement>('back').disabled = stack.length < 2;
  $('title').textContent = view?.title ?? source.label;
  document.querySelectorAll<HTMLButtonElement>('#nav .section').forEach((b) => b.setAttribute('aria-current', String(stack.length === 1 && b.textContent === view?.title)));
  document.querySelectorAll<HTMLButtonElement>('#sources button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.source === source.id)));
  $('target').replaceChildren(source.target());

  if (!source.connected()) {
    content.replaceChildren(h('div', { className: 'ma-empty' },
      h('p', { textContent: source.status() }),
      h('button', { className: 'primary', textContent: `${source.label} Settings…`, onclick: () => window.audHost.openWindow('settings', source.settingsPage) })));
    return;
  }
  if (!view) return;
  const token = ++renderToken;
  content.replaceChildren(h('p', { className: 'muted', textContent: 'Loading…' }));
  try {
    if (view.sections) {
      const sections = (await view.sections()).filter(([, items]) => items.length);
      if (token !== renderToken) return;
      content.replaceChildren(...(sections.length
        ? sections.flatMap(([title, items, layout]) => [h('h2', { textContent: title }), renderItems(items, layout)])
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
        content.querySelector('.ma-grid, .ma-list')?.append(...renderItems(next, view.layout).children);
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

function selectSource(id: string) {
  source = SOURCES.find((s) => s.id === id) ?? SOURCES[0];
  localStorage.setItem('library-source', source.id);
  if (location.hash.slice(1) !== source.id) history.replaceState(null, '', `#${source.id}`);
  $<HTMLInputElement>('search').value = '';
  $<HTMLInputElement>('search').placeholder = `Search ${source.label}`;
  const nav = $('nav-sections');
  const sections = source.sections();
  nav.replaceChildren(...sections.map(([title, make]) => h('button', { className: 'section', textContent: title, onclick: () => setRoot(make()) })));
  stack = sections.length ? [sections[0][1]()] : [];
  void render();
}

async function main() {
  ({ settings: maSettings, status: maStatus, sendspin } = await window.audHost.maState());
  ssStatus = (await window.audHost.subsonicState()).status;

  $('sources').append(...SOURCES.map((s) => {
    const b = h('button', { textContent: s.label, role: 'tab', onclick: () => selectSource(s.id) });
    b.dataset.source = s.id;
    return b;
  }));
  $('back').onclick = () => {
    if (stack.length > 1) stack.pop();
    void render();
  };
  let searchTimer: number | undefined;
  const input = $<HTMLInputElement>('search');
  input.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => (input.value.trim() ? setRoot(source.search(input.value.trim())) : selectSource(source.id)), 350);
  };

  const refreshIfShowing = (id: SourceId, was: string, now: string) => {
    if (was !== now && source.id === id) {
      if (now === 'connected') selectSource(id);
      else void render();
    }
  };
  window.audHost.onMaStatus((s) => {
    const was = maStatus.state;
    maStatus = s;
    if (s.state === 'connected' && was !== 'connected') void loadPlayers();
    refreshIfShowing('ma', was, s.state);
  });
  window.audHost.onMaSettings((s) => (maSettings = s));
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
  window.audHost.onSubsonicStatus((s) => {
    const was = ssStatus.state;
    ssStatus = s;
    refreshIfShowing('subsonic', was, s.state);
  });
  window.audHost.onNavigate((hash) => selectSource(hash));
  window.addEventListener('hashchange', () => selectSource(location.hash.slice(1)));

  await loadPlayers();
  selectSource(location.hash.slice(1) || localStorage.getItem('library-source') || (maStatus.state !== 'connected' && ssStatus.state === 'connected' ? 'subsonic' : 'ma'));
}

void main();
