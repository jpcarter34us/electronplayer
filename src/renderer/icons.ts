// Toolbar icons as inline SVG. The Unicode media symbols (⏮ ⏸ ⏹ ...) are
// missing from the default fonts on many Linux systems and show as boxes.
const PATHS = {
  open: '<path d="M8 2 2 9h12z"/><rect x="2" y="11" width="12" height="2.5" rx=".5"/>',
  prev: '<rect x="2" y="3" width="2" height="10" rx=".5"/><path d="M14 3v10L5 8z"/>',
  play: '<path d="M4 2.5v11L13.5 8z"/>',
  pause: '<rect x="3.5" y="3" width="3.2" height="10" rx=".6"/><rect x="9.3" y="3" width="3.2" height="10" rx=".6"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>',
  next: '<path d="M2 3v10l9-5z"/><rect x="12" y="3" width="2" height="10" rx=".5"/>',
  library: '<path d="M6 2.5v8.1a2.3 2.3 0 1 0 1.5 2.1V5.6l6-1.5v5.5a2.3 2.3 0 1 0 1.5 2.1V1z"/>',
  settings:
    '<path fill-rule="evenodd" d="M6.9 1h2.2l.4 1.9 1.3.6 1.7-1 1.5 1.5-1 1.7.6 1.3 1.9.4v2.2l-1.9.4-.6 1.3 1 1.7-1.5 1.5-1.7-1-1.3.6-.4 1.9H6.9l-.4-1.9-1.3-.6-1.7 1-1.5-1.5 1-1.7-.6-1.3L1 9.1V6.9l1.9-.4.6-1.3-1-1.7 1.5-1.5 1.7 1 1.3-.6zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Puts the icon in a button, keeping its title as the accessible name. */
export function setIcon(button: HTMLElement, name: IconName): void {
  button.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">${PATHS[name]}</svg>`;
}
