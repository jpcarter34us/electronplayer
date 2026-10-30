import type { PluginInfo } from '../shared/backend.js';
import type { PrefValue, PrefWidget, VisId, VisSettings } from '../shared/prefs.js';
import { h, native } from './host.js';
import { buildPrefs, type PrefsForm, type PrefsStore } from './prefs-form.js';
import { PAGES, PLUGIN_TABS, TITLE_PRESETS } from './settings-pages.js';

// The Settings window (Qt's PrefsWindow): core pages from settings-pages.ts
// plus the Plugins page. Location hash selects the page: #audio,
// #plugins/effect, ...

const VISUALIZERS: [VisId, string, string][] = [
  ['spectrum', 'Spectrum Analyzer', 'Frequency bars (port of cairo-spectrum / qt-spectrum)'],
  ['scope', 'Blur Scope', 'Oscilloscope with fading trails (port of blur_scope)'],
  ['vu', 'VU Meter', 'Per-channel peak levels (port of vumeter)'],
];

const nav = document.getElementById('nav')!;
const content = document.getElementById('content')!;
const keyOf = (w: PrefWidget) => `${w.key![0] ?? ''}|${w.key![1]}`;

function keyed(widgets: PrefWidget[]): PrefWidget[] {
  return widgets.flatMap((w) => [...(w.key ? [w] : []), ...keyed(w.children ?? []), ...(w.tabs ?? []).flatMap((t) => keyed(t.children))]);
}

// ---- custom widgets ----

async function outputPlugin(): Promise<HTMLElement> {
  const select = h('select');
  const settings = h('button', { textContent: 'Settings…' });
  const about = h('button', { textContent: 'About' });
  let outputs: PluginInfo[] = [];

  async function load() {
    outputs = (await native.listPlugins()).filter((p) => p.type === 'output');
    select.replaceChildren(...outputs.map((p) => h('option', { textContent: p.name, selected: p.enabled })));
    const current = outputs.find((p) => p.enabled);
    settings.disabled = !current?.hasPrefs;
    about.disabled = !current?.hasAbout;
  }

  select.onchange = async () => {
    await native.enablePlugin(outputs[select.selectedIndex].id, true);
    await load();
  };
  settings.onclick = () => window.audHost.openWindow('plugin-prefs', outputs[select.selectedIndex].id);
  about.onclick = () => window.audHost.pluginAbout(outputs[select.selectedIndex].id);
  await load();
  return h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: 'Output plugin:' }), h('span', { className: 'row-control' }, select, settings, about));
}

function titleFormat(store: PrefsStore, form: PrefsForm): HTMLElement {
  const w: PrefWidget = { type: 'entry', cfg: 'string', key: [null, 'generic_title_format'] };
  const presets = h('select', {}, ...TITLE_PRESETS.map(([name]) => h('option', { textContent: name })), h('option', { textContent: 'Custom' }));
  const input = h('input', { type: 'text', onchange: () => void store.set(w, input.value) });
  presets.onchange = () => {
    const preset = TITLE_PRESETS[presets.selectedIndex];
    if (preset) void store.set(w, preset[1]);
  };
  const update = () => {
    const value = String(store.get(w) ?? '');
    if (document.activeElement !== input) input.value = value;
    const i = TITLE_PRESETS.findIndex(([, fmt]) => fmt === value);
    presets.selectedIndex = i < 0 ? TITLE_PRESETS.length : i;
  };
  const refresh = form.refresh;
  form.refresh = () => (refresh(), update());
  update();
  return h('div', { className: 'table' },
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: 'Title format:' }), h('span', { className: 'row-control' }, presets)),
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: 'Custom string:' }), h('span', { className: 'row-control' }, input)));
}

let visUnsubscribe: (() => void) | undefined;
let maUnsubscribe: (() => void)[] = [];

let ssUnsubscribe: (() => void)[] = [];

// OpenSubsonic servers (Navidrome, Gonic, ...).
async function subsonicPage(): Promise<HTMLElement> {
  const { settings, status } = await window.audHost.subsonicState();
  const row = (label: string, ...controls: (Node | string)[]) =>
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: label }), h('span', { className: 'row-control' }, ...controls));

  const server = h('input', { type: 'text', value: settings.server, placeholder: 'http://navidrome.local:4533', spellcheck: false });
  const username = h('input', { type: 'text', value: settings.username, autocomplete: 'username', spellcheck: false });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const apiKey = h('input', { type: 'password', autocomplete: 'off', placeholder: 'An API key from your server' });
  const connect = h('button', { textContent: 'Connect', className: 'primary' });
  const signOut = h('button', { textContent: 'Sign Out' });
  const openLibrary = h('button', { textContent: 'Open Library…', onclick: () => window.audHost.openWindow('library', 'subsonic') });
  const statusLine = h('p', { className: 'ma-status' });
  const hint = h('p', { className: 'muted' });
  const keyBox = h('details', { className: 'ma-advanced' },
    h('summary', { textContent: 'Use an API key instead (OpenSubsonic)' }),
    h('div', { className: 'table' }, row('API key:', apiKey)));

  const render = (st: typeof status, s = settings) => {
    statusLine.dataset.state = st.state;
    statusLine.textContent =
      st.state === 'connected' ? `Connected to ${st.serverType ?? 'Subsonic'}${st.serverVersion ? ` ${st.serverVersion}` : ''} · signed in with ${st.auth}`
      : st.state === 'connecting' ? 'Connecting…'
      : st.error ? `Not connected: ${st.error}` : 'Not connected';
    signOut.disabled = !(s.hasPassword || s.hasApiKey);
    password.placeholder = s.hasPassword ? 'Stored securely; leave blank to keep it' : '';
    if (s.hasApiKey) apiKey.placeholder = 'Stored securely; leave blank to keep it';
    hint.textContent = st.state === 'connected' && st.apiKeySupported && !s.hasApiKey
      ? 'This server supports API keys. Using one means your password is not kept on this computer.'
      : '';
  };

  connect.onclick = async () => {
    connect.disabled = true;
    try {
      render(await window.audHost.subsonicConfigure({ server: server.value, username: username.value, password: password.value, apiKey: apiKey.value }));
      password.value = apiKey.value = '';
    } catch (err) {
      statusLine.textContent = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      connect.disabled = false;
    }
  };
  for (const input of [server, username, password, apiKey]) {
    input.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') connect.click();
    };
  }
  signOut.onclick = () => window.audHost.subsonicSignOut();

  ssUnsubscribe.forEach((u) => u());
  ssUnsubscribe = [
    window.audHost.onSubsonicSettings((s) => { Object.assign(settings, s); render(status, s); }),
    window.audHost.onSubsonicStatus((st) => { Object.assign(status, st); render(st); }),
  ];
  render(status);

  return h('div', { className: 'prefs' },
    h('div', { className: 'pref-label section', innerHTML: '<b>Server</b>' }),
    h('p', { className: 'muted', textContent: 'Browse and play an OpenSubsonic or Subsonic server, such as Navidrome. Songs play in Audacious, so effects, the equalizer and visualizations apply.' }),
    h('div', { className: 'table' }, row('Server address:', server), row('Username:', username), row('Password:', password)),
    keyBox,
    h('div', { className: 'row' }, connect, signOut, openLibrary),
    statusLine,
    hint);
}

// Music Assistant connection and the Sendspin player.
async function musicAssistantPage(): Promise<HTMLElement> {
  const { settings, status, sendspin } = await window.audHost.maState();
  const row = (label: string, ...controls: (Node | string)[]) =>
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: label }), h('span', { className: 'row-control' }, ...controls));

  const server = h('input', { type: 'text', value: settings.server, placeholder: '192.168.1.20 or http://homeassistant.local:8095', spellcheck: false });
  const statusLine = h('p', { className: 'ma-status' });
  const busy = (button: HTMLButtonElement, work: () => Promise<unknown>) => async () => {
    button.disabled = true;
    try {
      await work();
    } catch (err) {
      statusLine.dataset.state = 'disconnected';
      statusLine.textContent = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      button.disabled = false;
    }
  };

  // Signed in
  const signOut = h('button', { textContent: 'Sign Out' });
  signOut.onclick = busy(signOut, () => window.audHost.maSignOut());
  const openLibrary = h('button', { textContent: 'Open Library…', onclick: () => window.audHost.openWindow('library', 'ma') });
  const signedInBox = h('div', { className: 'row' }, signOut, openLibrary);

  // Signing in: username/password, providers (Home Assistant...), or a long-lived token
  const username = h('input', { type: 'text', autocomplete: 'username', spellcheck: false });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const signIn = h('button', { textContent: 'Sign In', className: 'primary' });
  signIn.onclick = busy(signIn, async () => {
    renderStatus(await window.audHost.maLogin(server.value, username.value, password.value));
    password.value = '';
  });
  password.onkeydown = username.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') signIn.click();
  };
  const providerRow = h('div', { className: 'row' });
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste a long-lived token from your Music Assistant profile' });
  const connect = h('button', { textContent: 'Connect' });
  connect.onclick = busy(connect, async () => {
    renderStatus(await window.audHost.maConfigure({ server: server.value, token: token.value }));
    token.value = '';
  });
  token.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') connect.click();
  };
  const tokenBox = h('details', { className: 'ma-advanced' },
    h('summary', { textContent: 'Use a long-lived token instead' }),
    h('div', { className: 'table' }, row('Token:', token)),
    h('div', { className: 'row' }, connect));
  const signInBox = h('div', { className: 'prefs' },
    h('div', { className: 'table' }, row('Username:', username), row('Password:', password)),
    h('div', { className: 'row' }, signIn),
    providerRow,
    tokenBox);

  // Offer the server's other sign-in methods (e.g. Home Assistant) once it is known.
  let providersFor = '';
  const loadProviders = async () => {
    const address = server.value.trim();
    if (!address || address === providersFor) return;
    providersFor = address;
    providerRow.replaceChildren();
    const providers = await window.audHost.maProviders(address).catch(() => []);
    if (server.value.trim() !== address) return;
    providerRow.replaceChildren(...providers.map((p) => {
      const b = h('button', { textContent: `Sign in with ${p.label}…` });
      b.onclick = busy(b, async () => {
        statusLine.dataset.state = 'connecting';
        statusLine.textContent = `Finish signing in with ${p.label} in your browser…`;
        renderStatus(await window.audHost.maLoginBrowser(server.value, p.id));
      });
      return b;
    }));
  };
  let providerTimer: number | undefined;
  server.oninput = () => {
    clearTimeout(providerTimer);
    providerTimer = window.setTimeout(() => void loadProviders(), 600);
  };
  server.onchange = () => void loadProviders();

  const renderStatus = (st: typeof status) => {
    const signedIn = st.state === 'connected';
    signedInBox.hidden = !signedIn;
    signInBox.hidden = signedIn || st.state === 'connecting';
    statusLine.dataset.state = st.state;
    statusLine.textContent =
      signedIn ? `Signed in${st.user ? ` as ${st.user}` : ''} · ${st.serverName || 'Music Assistant'}${st.serverVersion ? ` ${st.serverVersion}` : ''}${settings.tokenKind === 'long-lived' ? ' (long-lived token)' : ''}`
      : st.state === 'connecting' ? 'Connecting…'
      : st.error ?? 'Not signed in';
    if (!signedIn) void loadProviders();
  };
  const enabled = h('input', { type: 'checkbox', checked: settings.sendspin });
  const playerName = h('input', { type: 'text', value: settings.playerName });
  const endpoint = h('input', { type: 'text', value: settings.sendspinUrl, spellcheck: false });
  const saveSpeaker = h('button', { textContent: 'Apply' });
  const speakerBox = h('fieldset', { className: 'children' },
    h('div', { className: 'table' }, row('Player name:', playerName), row('Sendspin address:', endpoint)),
    h('div', { className: 'row' }, saveSpeaker));
  speakerBox.disabled = !enabled.checked;
  const pairing = h('div', { className: 'ma-pairing', hidden: true });
  const speakerStatus = h('p', { className: 'ma-status' });

  const renderSpeaker = (sp: typeof sendspin) => {
    speakerStatus.dataset.state = sp.connection === 'connected' ? 'connected' : sp.connection === 'connecting' ? 'connecting' : 'disconnected';
    speakerStatus.textContent =
      !sp.enabled ? 'Off'
      : sp.connection === 'connected' ? `Connected as a Music Assistant player${sp.playing ? ' · playing' : ''}${sp.groupName ? ` · ${sp.groupName}` : ''}`
      : sp.connection === 'connecting' ? 'Connecting…'
      : `Not connected${sp.error ? `: ${sp.error}` : ''}`;
    pairing.hidden = !sp.pairingCode;
    pairing.replaceChildren(h('span', { textContent: 'To pair this player, enter this code in Music Assistant:' }), h('strong', { textContent: sp.pairingCode ?? '' }));
  };

  enabled.onchange = () => {
    speakerBox.disabled = !enabled.checked;
    void window.audHost.maConfigure({ sendspin: enabled.checked });
  };
  saveSpeaker.onclick = () => window.audHost.maConfigure({ playerName: playerName.value, sendspinUrl: endpoint.value });

  maUnsubscribe.forEach((u) => u());
  maUnsubscribe = [
    window.audHost.onMaSettings((s) => Object.assign(settings, s)),
    window.audHost.onMaStatus(renderStatus),
    window.audHost.onSendspinState(renderSpeaker),
  ];
  renderStatus(status);
  renderSpeaker(sendspin);

  return h('div', { className: 'prefs' },
    h('div', { className: 'pref-label section', innerHTML: '<b>Server</b>' }),
    h('p', { className: 'muted', textContent: 'Browse and play your Music Assistant library. Sign in with your Music Assistant account; only a session token is kept (in the Keychain), never your password.' }),
    h('div', { className: 'table' }, row('Server address:', server)),
    statusLine,
    signedInBox,
    signInBox,
    h('div', { className: 'pref-label section', innerHTML: '<b>This computer as a speaker</b>' }),
    h('label', { className: 'check' }, enabled, h('span', { textContent: 'Play Music Assistant audio on this computer (Sendspin)' })),
    speakerBox,
    pairing,
    speakerStatus);
}

async function pluginsPage(tab: string): Promise<HTMLElement> {
  const bar = h('div', { className: 'tabs', role: 'tablist' });
  const panel = h('div', { className: 'tab-panel plugin-list' });
  const current = PLUGIN_TABS.some((t) => t.id === tab) ? tab : 'general';

  for (const t of PLUGIN_TABS) {
    bar.append(h('button', {
      textContent: t.title, role: 'tab', ariaSelected: String(t.id === current),
      onclick: () => (location.hash = `plugins/${t.id}`),
    }));
  }

  if (current === 'vis') {
    const settings = await window.audHost.visConfig();
    const rows = VISUALIZERS.map(([id, name, detail]) => {
      const input = h('input', { type: 'checkbox', checked: settings.enabled[id], onchange: () => window.audHost.setVis(id, input.checked) });
      return { id, input, el: h('div', { className: 'plugin' }, h('label', { className: 'check' }, input, h('span', {}, h('strong', { textContent: name }), h('small', { textContent: detail })))) };
    });
    const separate = h('input', { type: 'checkbox', onchange: () => window.audHost.setVisOption('separate', separate.checked) });
    const onTop = h('input', { type: 'checkbox', onchange: () => window.audHost.setVisOption('onTop', onTop.checked) });
    const onTopBox = h('fieldset', { className: 'children' }, h('label', { className: 'check' }, onTop, h('span', { textContent: 'Keep visualization windows on top of other windows' })));
    const note = h('p', { className: 'muted' });
    const update = (s: VisSettings) => {
      rows.forEach((r) => (r.input.checked = s.enabled[r.id]));
      separate.checked = s.separate;
      onTop.checked = s.onTop;
      onTopBox.disabled = !s.separate;
      note.textContent = s.separate
        ? 'Each visualization opens in its own window; closing a window turns it off.'
        : 'Visualizations appear above the playlist in the main window.';
    };
    update(settings);
    visUnsubscribe?.();
    visUnsubscribe = window.audHost.onVisConfig(update);
    panel.append(...rows.map((r) => r.el),
      h('div', { className: 'prefs vis-options' }, h('label', { className: 'check' }, separate, h('span', { textContent: 'Show visualizations in separate windows' })), onTopBox),
      note);
  } else {
    const load = async () => {
      const plugins = (await native.listPlugins()).filter((p) => p.type === current).sort((a, b) => a.name.localeCompare(b.name));
      panel.replaceChildren(...plugins.map((p) => {
        const input = h('input', {
          type: 'checkbox', checked: p.enabled,
          onchange: async () => {
            await native.enablePlugin(p.id, input.checked);
            await load();
          },
        });
        return h('div', { className: 'plugin' },
          h('label', { className: 'check' }, input, h('strong', { textContent: p.name })),
          h('span', { className: 'plugin-actions' },
            h('button', { textContent: 'Settings…', disabled: !p.hasPrefs || !p.enabled, title: p.hasPrefs && !p.enabled ? 'Enable the plugin to change its settings' : '', onclick: () => window.audHost.openWindow('plugin-prefs', p.id) }),
            h('button', { textContent: 'About', disabled: !p.hasAbout, onclick: () => window.audHost.pluginAbout(p.id) })));
      }));
      if (!plugins.length) panel.append(h('p', { className: 'muted', textContent: 'No plugins of this type are installed.' }));
    };
    await load();
  }
  return h('div', { className: 'notebook' }, bar, panel);
}

// ---- pages ----

let showing = 0;

async function show(hash: string): Promise<void> {
  const [pageId, tab = ''] = hash.replace(/^#/, '').split('/');
  const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
  const token = ++showing;

  nav.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.page === page.id)));
  document.title = `${page.title} – Audacious Settings`;

  const values = new Map<string, PrefValue>();
  const widgets = keyed(page.widgets);
  const reload = async () => {
    const results = await Promise.all(widgets.map((w) => native.getConfig(w.key![0], w.key![1], w.cfg!)));
    widgets.forEach((w, i) => values.set(keyOf(w), results[i]));
  };
  await reload();

  const customs = new Map<PrefWidget, HTMLElement>();
  for (const w of page.widgets) {
    if (w.custom === 'output-plugin') customs.set(w, await outputPlugin());
    if (w.custom === 'plugins') customs.set(w, await pluginsPage(tab));
    if (w.custom === 'music-assistant') customs.set(w, await musicAssistantPage());
    if (w.custom === 'subsonic') customs.set(w, await subsonicPage());
  }
  if (token !== showing) return; // a newer navigation won

  let form: PrefsForm;
  const store: PrefsStore = {
    get: (w) => (w.key ? values.get(keyOf(w)) : undefined),
    async set(w, value) {
      if (!w.key) return;
      await native.setConfig(w.key[0], w.key[1], w.cfg!, value);
      values.set(keyOf(w), (await native.getConfig(w.key[0], w.key[1], w.cfg!)));
      form.refresh();
    },
    async button() {},
    custom(w, f) {
      if (w.custom === 'title-format') {
        values.set('|generic_title_format', values.get('|generic_title_format') ?? '');
        void native.getConfig(null, 'generic_title_format', 'string').then((v) => (values.set('|generic_title_format', v), f.refresh()));
        return titleFormat(store, f);
      }
      return customs.get(w);
    },
  };
  form = buildPrefs(page.widgets, store);
  content.replaceChildren(h('h1', { textContent: page.title }), form.element);
}

for (const p of PAGES) {
  const a = h('a', { href: `#${p.id}`, textContent: p.title });
  a.dataset.page = p.id;
  nav.append(a);
}

window.addEventListener('hashchange', () => void show(location.hash));
window.audHost.onNavigate((hash) => {
  if (location.hash.slice(1) === hash) void show(hash);
  else location.hash = hash;
});
void show(location.hash);
