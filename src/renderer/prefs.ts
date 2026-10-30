import type { PrefValue } from '../shared/prefs.js';
import { native } from './host.js';
import { buildPrefs, type PrefsForm } from './prefs-form.js';

// A plugin's settings window (libaudqt's plugin_prefs). The location hash is
// the plugin id. Opening calls the plugin's init(), closing its cleanup();
// plugins with apply() get Set/Cancel, the rest apply each change at once.

const id = decodeURIComponent(location.hash.slice(1));
const content = document.getElementById('content')!;
const buttons = document.getElementById('buttons')!;

async function main(): Promise<void> {
  const prefs = await native.openPrefs(id);
  if (!prefs) {
    content.textContent = 'This plugin has no settings.';
    return;
  }
  document.title = `${prefs.name} Settings`;

  let values: Record<string, PrefValue> = prefs.values;
  let form: PrefsForm;
  const update = (next: Record<string, PrefValue> | null) => {
    if (next) values = next;
    form.refresh();
  };

  form = buildPrefs(prefs.widgets, {
    get: (w) => (w.id === undefined ? undefined : values[w.id]),
    async set(w, value) {
      if (w.id !== undefined) update(await native.prefsSet(prefs.session, w.id, value));
    },
    async button(w) {
      if (w.id !== undefined) update(await native.prefsButton(prefs.session, w.id));
    },
  });
  content.append(form.element);

  // Runs the plugin's cleanup() even if the window is closed directly.
  window.addEventListener('pagehide', () => void native.closePrefs(prefs.session));

  const button = (label: string, onclick: () => void, primary = false) => {
    const b = Object.assign(document.createElement('button'), { textContent: label, onclick });
    if (primary) b.className = 'primary';
    buttons.append(b);
  };
  if (prefs.hasApply) {
    button('Cancel', () => window.close());
    button('Set', async () => {
      await native.prefsApply(prefs.session);
      window.close();
    }, true);
  } else {
    button('Close', () => window.close(), true);
  }
}

void main();
