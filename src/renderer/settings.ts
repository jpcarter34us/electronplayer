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
