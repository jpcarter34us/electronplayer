import { nativeImage, TouchBar } from 'electron';
import type { BackendEvent, PlaybackState, Track } from '../shared/backend';
import type { NativeMethod } from './native';

const { TouchBarButton, TouchBarLabel, TouchBarPopover, TouchBarSlider, TouchBarSpacer } = TouchBar;

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

/** How long position updates are ignored after the user moves the seek slider. */
const SCRUB_HOLD_MS = 700;
/** Seeks are sent once the slider has been still this long. */
const SEEK_DEBOUNCE_MS = 150;
const TITLE_MAX = 32;

const icon = (name: string) => nativeImage.createFromNamedImage(name);

const fmt = (ms: number) => {
  if (ms < 0) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const truncate = (s: string) => (s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1) + '…' : s);

/**
 * Touch Bar playback controls (prev, play/pause, next, title, seek, volume),
 * driven directly by libaudcore in the main process. Feed it every
 * BackendEvent via update().
 */
export function createPlaybackTouchBar(call: Call): { touchBar: TouchBar; update(event: BackendEvent): void } {
  const send = (method: NativeMethod, ...args: unknown[]) => void call(method, args).catch(() => {});

  let tracks: Track[] = [];
  let state: PlaybackState | undefined;
  let scrubUntil = 0;
  let seekTimer: NodeJS.Timeout | undefined;

  const playIcons = { play: icon('NSTouchBarPlayTemplate'), pause: icon('NSTouchBarPauseTemplate') };

  const prev = new TouchBarButton({ icon: icon('NSTouchBarSkipBackTemplate'), accessibilityLabel: 'Previous', click: () => send('prev') });
  const playPause = new TouchBarButton({
    icon: playIcons.play,
    accessibilityLabel: 'Play',
    // Same rule as the toolbar button: pause toggles while a song is loaded.
    click: () => send(state?.playing ? 'pause' : 'play'),
  });
  const next = new TouchBarButton({ icon: icon('NSTouchBarSkipAheadTemplate'), accessibilityLabel: 'Next', click: () => send('next') });

  const title = new TouchBarLabel({ label: 'Audacious' });

  // Slider units are seconds.
  const seek = new TouchBarSlider({
    label: fmt(-1),
    minValue: 0,
    maxValue: 1,
    value: 0,
    change: (seconds) => {
      scrubUntil = Date.now() + SCRUB_HOLD_MS;
      seek.label = fmt(seconds * 1000);
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => send('seek', Math.round(seconds * 1000)), SEEK_DEBOUNCE_MS);
    },
  });

  const volumeSlider = new TouchBarSlider({
    minValue: 0,
    maxValue: 100,
    value: 100,
    change: (volume) => send('setVolume', Math.round(volume)),
  });
  const volume = new TouchBarPopover({
    icon: icon('NSTouchBarAudioOutputVolumeHighTemplate'),
    items: new TouchBar({ items: [volumeSlider] }),
    showCloseButton: true,
  });

  const touchBar = new TouchBar({
    items: [prev, playPause, next, new TouchBarSpacer({ size: 'small' }), title, seek, volume],
  });

  // Only assign changed values: every assignment redraws the Touch Bar.
  function set<T extends object, K extends keyof T>(item: T, key: K, value: T[K]) {
    if (item[key] !== value) item[key] = value;
  }

  function render() {
    if (!state) return;
    const playing = state.playing && !state.paused;
    set(playPause, 'icon', playing ? playIcons.pause : playIcons.play);
    set(playPause, 'accessibilityLabel', playing ? 'Pause' : 'Play');

    const track = tracks[state.position];
    set(title, 'label', truncate(track ? (track.artist ? `${track.artist} – ${track.title}` : track.title) : 'Audacious'));

    if (Date.now() >= scrubUntil) {
      set(seek, 'maxValue', Math.max(1, Math.round(state.length / 1000)));
      set(seek, 'value', state.length > 0 ? Math.round(state.time / 1000) : 0);
      set(seek, 'label', fmt(state.length > 0 ? state.time : -1));
    }
    set(volumeSlider, 'value', state.volume);
  }

  return {
    touchBar,
    update(event) {
      if (event.type === 'state') state = event.state;
      else if (event.type === 'playlist') tracks = event.tracks;
      else return;
      render();
    },
  };
}
