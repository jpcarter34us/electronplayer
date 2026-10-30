import type { CfgType, PrefWidget } from '../shared/prefs.js';

// The core Settings pages, ported from libaudqt/prefs-window-qt.cc. Values
// live in libaudcore's config; `key: [null, name]` is a core setting.
// Custom widgets (output plugin chooser, title format) are drawn by
// settings.ts. The Qt-only Appearance page and the recording settings are
// not ported yet.

const cfg = (type: CfgType, name: string, section: string | null = null) => ({ cfg: type, key: [section, name] as [string | null, string] });

const check = (label: string, name: string, child = false): PrefWidget => ({ type: 'check', label, child, ...cfg('bool', name) });
const spin = (label: string, type: 'int' | 'float', name: string, min: number, max: number, step: number, unit?: string, child = false): PrefWidget =>
  ({ type: 'spin', label, child, min, max, step, unit, ...cfg(type, name) });
const entry = (label: string | undefined, name: string, password = false): PrefWidget => ({ type: 'entry', label, password, ...cfg('string', name) });
const section = (label: string): PrefWidget => ({ type: 'label', label: `<b>${label}</b>` });

export interface SettingsPage {
  id: string;
  title: string;
  widgets: PrefWidget[];
}

export const PAGES: SettingsPage[] = [
  {
    id: 'audio',
    title: 'Audio',
    widgets: [
      section('Output Settings'),
      { type: 'custom', custom: 'output-plugin' },
      {
        type: 'combo', label: 'Bit depth:', ...cfg('int', 'output_bit_depth'),
        items: [{ label: 'Automatic', value: -1 }, { label: '16', value: 16 }, { label: '24', value: 24 }, { label: '32', value: 32 }, { label: 'Floating point', value: 0 }],
      },
      spin('Buffer size:', 'int', 'output_buffer_size', 100, 10000, 1000, 'ms'),
      check('Soft clipping', 'soft_clipping'),
      check('Use software volume control (not recommended)', 'software_volume_control'),
      section('ReplayGain'),
      check('Enable ReplayGain', 'enable_replay_gain'),
      {
        type: 'combo', label: 'Mode:', child: true, ...cfg('int', 'replay_gain_mode'),
        items: [{ label: 'Track', value: 0 }, { label: 'Album', value: 1 }, { label: 'Based on shuffle', value: 2 }],
      },
      check('Prevent clipping (recommended)', 'enable_clipping_prevention', true),
      {
        type: 'table', child: true,
        children: [
          spin('Amplify all files:', 'float', 'replay_gain_preamp', -15, 15, 0.1, 'dB'),
          spin('Amplify untagged files:', 'float', 'default_gain', -15, 15, 0.1, 'dB'),
        ],
      },
    ],
  },
  {
    id: 'network',
    title: 'Network',
    widgets: [
      section('Network Settings'),
      spin('Buffer size:', 'int', 'net_buffer_kb', 16, 1024, 16, 'KiB'),
      section('Proxy Configuration'),
      check('Enable proxy usage', 'use_proxy'),
      { type: 'table', child: true, children: [entry('Proxy hostname:', 'proxy_host'), entry('Proxy port:', 'proxy_port')] },
      check('Use authentication with proxy', 'use_proxy_auth'),
      { type: 'table', child: true, children: [entry('Proxy username:', 'proxy_user'), entry('Proxy password:', 'proxy_pass', true)] },
      check('Use SOCKS proxy', 'socks_proxy'),
      { type: 'radio', label: 'SOCKS v4a', child: true, value: 0, ...cfg('int', 'socks_type') },
      { type: 'radio', label: 'SOCKS v5', child: true, value: 1, ...cfg('int', 'socks_type') },
    ],
  },
  {
    id: 'playlist',
    title: 'Playlist',
    widgets: [
      section('Behavior'),
      check('Resume playback on startup', 'resume_playback_on_startup'),
      check('Pause instead of resuming immediately', 'always_resume_paused', true),
      check('Advance when the current song is deleted', 'advance_on_delete'),
      check('Clear the playlist when opening files', 'clear_playlist'),
      check('Open files in a temporary playlist', 'open_to_temporary'),
      section('Song Display'),
      check('Show song numbers', 'show_numbers_in_pl'),
      check('Show leading zeroes (02:00 vs. 2:00)', 'leading_zero'),
      check('Show hours separately (1:30:00 vs. 90:00)', 'show_hours'),
      { type: 'custom', custom: 'title-format' },
      section('Export'),
      check('Use relative paths when possible', 'export_relative_paths'),
    ],
  },
  {
    id: 'song-info',
    title: 'Song Info',
    widgets: [
      section('Album Art'),
      { type: 'label', label: 'Search for images matching these words (comma-separated):' },
      entry(undefined, 'cover_name_include'),
      { type: 'label', label: 'Exclude images matching these words (comma-separated):' },
      entry(undefined, 'cover_name_exclude'),
      check('Search for images matching song file name', 'use_file_cover'),
      check('Search recursively', 'recurse_for_cover'),
      spin('Search depth:', 'int', 'recurse_for_cover_depth', 0, 100, 1, undefined, true),
    ],
  },
  { id: 'plugins', title: 'Plugins', widgets: [{ type: 'custom', custom: 'plugins' }] },
  {
    id: 'advanced',
    title: 'Advanced',
    widgets: [
      section('Compatibility'),
      check('Interpret \\ (backward slash) as a folder delimiter', 'convert_backslash'),
      {
        type: 'table',
        children: [
          {
            type: 'combo', label: 'Auto character encoding detector for:', ...cfg('string', 'chardet_detector'),
            items: [
              ['None', ''], ['Arabic', 'arabic'], ['Baltic', 'baltic'], ['Chinese', 'chinese'], ['Greek', 'greek'],
              ['Hebrew', 'hebrew'], ['Japanese', 'japanese'], ['Korean', 'korean'], ['Polish', 'polish'],
              ['Russian', 'russian'], ['Taiwanese', 'taiwanese'], ['Turkish', 'turkish'],
            ].map(([label, value]) => ({ label, value })),
          },
          entry('Fallback character encodings:', 'chardet_fallback'),
        ],
      },
      section('Playlist'),
      check('Add folders recursively', 'recurse_folders'),
      check('Add folders nested within playlist files', 'folders_in_playlist'),
      section('Metadata'),
      check('Guess missing metadata from file path', 'metadata_fallbacks'),
      check('Do not load metadata for songs until played', 'metadata_on_play'),
      check('Probe content of files with no recognized file name extension', 'slow_probe'),
      section('Miscellaneous'),
      spin('Step forward/backward by:', 'int', 'step_size', 1, 60, 1, 'seconds'),
      spin('Adjust volume by:', 'int', 'volume_delta', 1, 25, 1, 'percent'),
    ],
  },
];

/** Plugin tabs on the Plugins page; output plugins are chosen on Audio. */
export const PLUGIN_TABS = [
  { id: 'general', title: 'General' },
  { id: 'effect', title: 'Effect' },
  { id: 'vis', title: 'Visualization' },
  { id: 'input', title: 'Input' },
  { id: 'playlist', title: 'Playlist' },
  { id: 'transport', title: 'Transport' },
] as const;

export const TITLE_PRESETS: [string, string][] = [
  ['TITLE', '${title}'],
  ['TITLE - ARTIST', '${title}${?artist: - ${artist}}'],
  ['TITLE - ARTIST - ALBUM', '${title}${?artist: - ${artist}}${?album: - ${album}}'],
  ['ARTIST - TITLE', '${?artist:${artist} - }${title}'],
  ['ARTIST - ALBUM - TITLE', '${?artist:${artist} - }${?album:${album} - }${title}'],
  ['ARTIST - ALBUM - TRACK. TITLE', '${?artist:${artist} - }${?album:${album} - }${?track-number:${track-number}. }${title}'],
  ['ARTIST [ ALBUM ] - TRACK. TITLE', '${?artist:${artist} }${?album:[ ${album} ] }${?artist:- }${?track-number:${track-number}. }${title}'],
  ['ARTIST - ALBUM - DISC.TRACK. TITLE', '${?artist:${artist} - }${?album:${album} - }${?disc-number:${disc-number}. }${?track-number:${track-number}. }${title}'],
  ['ARTIST [ ALBUM ] - DISC.TRACK. TITLE', '${?artist:${artist} }${?album:[ ${album} ] }${?artist:- }${?disc-number:${disc-number}. }${?track-number:${track-number}. }${title}'],
  ['ALBUM - TITLE', '${?album:${album} - }${title}'],
];
