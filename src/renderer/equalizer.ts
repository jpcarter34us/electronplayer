import type { Equalizer, EqPreset } from '../shared/backend.js';
import { h, native } from './host.js';

// The Equalizer window (libaudqt's equalizer-qt.cc + eq-preset-qt.cc):
// on/off, preamp and 10 bands of +-12 dB, plus presets saved to the same
// eq.preset file upstream Audacious uses.

const BANDS = ['31 Hz', '63 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'];
const MAX = 12;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)}`;

function slider(label: string, onInput: (db: number) => void) {
  const value = h('span', { className: 'eq-value' });
  const input = h('input', { type: 'range', min: String(-MAX), max: String(MAX), step: '0.5', ariaLabel: label });
  input.oninput = () => {
    value.textContent = fmt(Number(input.value));
    onInput(Number(input.value));
  };
  // Double-click resets to 0 dB.
  input.ondblclick = () => {
    input.value = '0';
    input.dispatchEvent(new Event('input'));
  };
  const set = (db: number) => {
    if (document.activeElement !== input) input.value = String(db);
    value.textContent = fmt(db);
  };
  return { el: h('div', { className: 'eq-band' }, value, input, h('span', { className: 'eq-label', textContent: label })), set };
}

async function main(): Promise<void> {
  let eq: Equalizer = await native.getEqualizer();
  let presets: EqPreset[] = await native.getEqPresets();

  // Coalesce slider drags into one engine update per ~30 ms. (Not
  // requestAnimationFrame: it is paused while the window is covered.)
  let pending: Partial<Equalizer> = {};
  let scheduled = false;
  const push = (change: Partial<Equalizer>) => {
    Object.assign(pending, change);
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const change = pending;
      pending = {};
      void native.setEqualizer(change);
    }, 30);
  };

  const active = $<HTMLInputElement>('active');
  active.onchange = () => push({ active: active.checked });

  const preamp = slider('Preamp', (db) => push({ preamp: db }));
  const bands = BANDS.map((label, i) =>
    slider(label, (db) => {
      eq.bands[i] = db;
      push({ bands: [...eq.bands] });
    }),
  );
  $('sliders').append(preamp.el, h('div', { className: 'eq-divider' }), ...bands.map((b) => b.el));

  const render = () => {
    active.checked = eq.active;
    preamp.set(eq.preamp);
    eq.bands.forEach((db, i) => bands[i].set(db));
  };

  // ---- presets ----
  const select = $<HTMLSelectElement>('preset');
  const name = $<HTMLInputElement>('preset-name');
  const renderPresets = () => {
    select.replaceChildren(h('option', { textContent: presets.length ? 'Load preset…' : 'No saved presets', value: '' }),
      ...presets.map((p, i) => h('option', { textContent: p.name, value: String(i) })));
    $<HTMLButtonElement>('delete').disabled = true;
  };
  select.onchange = () => {
    const preset = presets[Number(select.value)];
    $<HTMLButtonElement>('delete').disabled = !preset;
    if (!preset) return;
    name.value = preset.name;
    push({ preamp: preset.preamp, bands: [...preset.bands] });
  };
  const savePresets = async () => {
    presets.sort((a, b) => a.name.localeCompare(b.name));
    await native.saveEqPresets(presets);
    renderPresets();
  };
  $('save').onclick = async () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    const preset = { name: n, preamp: eq.preamp, bands: [...eq.bands] };
    const existing = presets.findIndex((p) => p.name === n);
    if (existing >= 0) presets[existing] = preset;
    else presets.push(preset);
    await savePresets();
    select.value = String(presets.findIndex((p) => p.name === n));
  };
  $('delete').onclick = async () => {
    const i = Number(select.value);
    if (!presets[i]) return;
    presets.splice(i, 1);
    await savePresets();
  };
  $('reset').onclick = () => push({ preamp: 0, bands: Array(10).fill(0) });

  window.audHost.onEvent((e) => {
    const event = e as { type: string; equalizer?: Equalizer };
    if (event.type === 'equalizer' && event.equalizer) {
      eq = event.equalizer;
      render();
    }
  });

  render();
  renderPresets();
}

void main();
