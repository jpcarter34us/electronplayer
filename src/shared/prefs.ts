// Settings-dialog widget trees. The native addon serializes each plugin's
// PreferencesWidget array (libaudcore/preferences.h) into this shape; the
// core Settings pages are written in the same shape by hand
// (src/renderer/settings-pages.ts), so one renderer draws both.
//
// Types only: this file is compiled for both the main process (CommonJS)
// and the renderer (ES modules).

export type CfgType = 'bool' | 'int' | 'float' | 'string';
export type PrefValue = boolean | number | string;

export interface PrefWidget {
  /** Plugin widgets: index in the native session, used to read/write it. */
  id?: number;
  type:
    | 'label' | 'button' | 'check' | 'radio' | 'spin' | 'entry' | 'file'
    | 'combo' | 'font' | 'box' | 'table' | 'notebook' | 'separator' | 'custom';
  /** May contain GTK mnemonics (_File) and <b>/<i> markup. */
  label?: string;
  /** Indented, and enabled only while the preceding check/radio is on. */
  child?: boolean;
  /** Type of the setting this widget edits, if any. */
  cfg?: CfgType;
  /** Core settings: [section (null = core), name] in libaudcore's config. */
  key?: [string | null, string];
  /** Radio: value of `cfg` this button selects. */
  value?: number;
  // spin
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  // entry / file
  password?: boolean;
  mode?: 'file' | 'folder';
  // combo
  items?: { label: string; value: string | number }[];
  // box / table / notebook / separator
  horizontal?: boolean;
  frame?: boolean;
  children?: PrefWidget[];
  tabs?: { name: string; children: PrefWidget[] }[];
  /** Custom widgets drawn by the renderer (e.g. 'output-plugin'). */
  custom?: string;
}

export interface PluginPrefsSession {
  session: number;
  name: string;
  /** If true the dialog has Set/Cancel and Set calls the plugin's apply(). */
  hasApply: boolean;
  widgets: PrefWidget[];
  /** Current values by widget id. */
  values: Record<string, PrefValue>;
}

/** Visualizers implemented in the renderer (ports of the GTK/Qt plugins). */
export type VisId = 'spectrum' | 'scope' | 'vu';
export type VisConfig = Record<VisId, boolean>;
