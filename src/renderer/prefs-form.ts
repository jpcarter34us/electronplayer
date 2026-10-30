import type { PrefValue, PrefWidget } from '../shared/prefs.js';
import { h, labelHtml, plainLabel } from './host.js';

// Builds a settings form from a PreferencesWidget tree, following libaudqt's
// prefs-builder.cc: a "child" widget is indented and enabled only while the
// check/radio button before it is on, and radio buttons group by level.

export interface PrefsStore {
  get(w: PrefWidget): PrefValue | undefined;
  /** Writes a value; the caller refreshes the form once values reload. */
  set(w: PrefWidget, value: PrefValue): Promise<void>;
  button(w: PrefWidget): Promise<void>;
  /** Draws `type: 'custom'` widgets it knows; undefined for the rest. */
  custom?(w: PrefWidget, form: PrefsForm): HTMLElement | undefined;
}

export interface PrefsForm {
  element: HTMLElement;
  /** Re-reads every control from the store. */
  refresh(): void;
}

const uriToPath = (uri: string) => (uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri);
const pathToUri = (path: string) =>
  path.startsWith('/') ? 'file://' + path.split('/').map(encodeURIComponent).join('/') : path;

export function buildPrefs(widgets: PrefWidget[], store: PrefsStore): PrefsForm {
  const updaters: (() => void)[] = [];
  let groups = 0;
  const form: PrefsForm = { element: h('div', { className: 'prefs' }), refresh: () => updaters.forEach((u) => u()) };

  // Don't overwrite a text field the user is typing in.
  const editing = (el: Element) => document.activeElement === el;

  function row(label: string | undefined, ...controls: (Node | string)[]) {
    return h('div', { className: 'row' }, h('span', { className: 'row-label', innerHTML: label ? labelHtml(label) : '' }), h('span', { className: 'row-control' }, ...controls));
  }

  function control(w: PrefWidget, radioGroup: () => string): HTMLElement {
    const get = () => store.get(w);
    const set = (v: PrefValue) => void store.set(w, v);

    switch (w.type) {
      case 'label': {
        const el = h('div', { className: 'pref-label', innerHTML: labelHtml(w.label ?? '') });
        if (/^\s*<b>/.test(w.label ?? '')) el.classList.add('section');
        return el;
      }
      case 'button': {
        return h('div', { className: 'pref-button' }, h('button', { textContent: plainLabel(w.label ?? ''), onclick: () => void store.button(w) }));
      }
      case 'check': {
        const input = h('input', { type: 'checkbox', onchange: () => set(input.checked) });
        updaters.push(() => (input.checked = !!get()));
        return h('label', { className: 'check' }, input, h('span', { innerHTML: labelHtml(w.label ?? '') }));
      }
      case 'radio': {
        const input = h('input', { type: 'radio', name: radioGroup(), onchange: () => input.checked && set(w.value ?? 0) });
        updaters.push(() => (input.checked = get() === w.value));
        return h('label', { className: 'check' }, input, h('span', { innerHTML: labelHtml(w.label ?? '') }));
      }
      case 'spin': {
        const isInt = w.cfg !== 'float';
        const input = h('input', {
          type: 'number', min: String(w.min ?? ''), max: String(w.max ?? ''), step: String(w.step || (isInt ? 1 : 0.1)),
          onchange: () => {
            let v = Number(input.value);
            if (!Number.isFinite(v)) return;
            v = Math.min(w.max ?? v, Math.max(w.min ?? v, isInt ? Math.round(v) : v));
            set(v);
          },
        });
        updaters.push(() => !editing(input) && (input.value = String(get() ?? '')));
        return row(w.label, input, w.unit ? h('span', { className: 'unit', textContent: plainLabel(w.unit) }) : '');
      }
      case 'entry':
      case 'font': {
        const input = h('input', { type: w.password ? 'password' : 'text', onchange: () => set(input.value) });
        updaters.push(() => !editing(input) && (input.value = String(get() ?? '')));
        return row(w.label, input);
      }
      case 'file': {
        const input = h('input', { type: 'text', onchange: () => set(pathToUri(input.value)) });
        const browse = h('button', {
          textContent: 'Browse…',
          onclick: async () => {
            const uri = await window.audHost.choosePath(w.mode ?? 'file', String(get() ?? ''));
            if (uri) set(uri);
          },
        });
        updaters.push(() => !editing(input) && (input.value = uriToPath(String(get() ?? ''))));
        return row(w.label, input, browse);
      }
      case 'combo': {
        const items = w.items ?? [];
        const select = h('select', { onchange: () => items[select.selectedIndex] && set(items[select.selectedIndex].value) },
          ...items.map((it) => h('option', { textContent: plainLabel(it.label) })));
        updaters.push(() => (select.selectedIndex = items.findIndex((it) => String(it.value) === String(get()))));
        return row(w.label, select);
      }
      case 'box': {
        const box = w.frame ? h('fieldset', { className: 'frame' }) : h('div');
        box.classList.add('box', w.horizontal ? 'horizontal' : 'vertical');
        build(w.children ?? [], box);
        return box;
      }
      case 'table': {
        const table = h('div', { className: 'table' });
        build(w.children ?? [], table);
        return table;
      }
      case 'notebook': {
        const tabs = w.tabs ?? [];
        const bar = h('div', { className: 'tabs', role: 'tablist' });
        const panels = tabs.map((t) => {
          const panel = h('div', { className: 'tab-panel', role: 'tabpanel' });
          build(t.children, panel);
          return panel;
        });
        const select = (i: number) => {
          bar.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
          panels.forEach((p, j) => (p.hidden = i !== j));
        };
        tabs.forEach((t, i) => bar.append(h('button', { textContent: plainLabel(t.name), role: 'tab', onclick: () => select(i) })));
        select(0);
        return h('div', { className: 'notebook' }, bar, ...panels);
      }
      case 'separator':
        return h('hr', { className: w.horizontal === false ? 'vertical' : '' });
      case 'custom':
        return store.custom?.(w, form) ?? h('div', { className: 'pref-label muted', textContent: 'This setting is not available in this version.' });
    }
  }

  function build(list: PrefWidget[], container: HTMLElement) {
    // Radio groups per level (0 = top level, 1 = child), as in prefs-builder.cc.
    const radio: (string | null)[] = [null, null];
    let parent: PrefWidget | null = null;
    let childBox: HTMLFieldSetElement | null = null;

    for (const w of list) {
      const level = w.child ? 1 : 0;
      if (w.type !== 'radio') radio[level] = null;
      const el = control(w, () => (radio[level] ??= `radio-${groups++}`));

      if (w.child) {
        if (!childBox) {
          // A disabled fieldset disables everything inside, nested ones included.
          const box = (childBox = h('fieldset', { className: 'children' }));
          const owner = parent;
          if (owner) updaters.push(() => (box.disabled = owner.type === 'radio' ? store.get(owner) !== owner.value : !store.get(owner)));
          container.append(box);
        }
        childBox.append(el);
      } else {
        container.append(el);
        childBox = null;
        parent = w.type === 'check' || w.type === 'radio' ? w : null;
      }
    }
  }

  build(widgets, form.element);
  form.refresh();
  return form;
}
