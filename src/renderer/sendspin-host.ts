import { SendspinCore, SendspinPlayer, type SendspinPlayerConfig } from '@sendspin/sendspin-js';
import type { SendspinState } from '../shared/ma.js';

// Runs in a hidden window (src/main/sendspin.ts): a Sendspin player that
// makes this app a Music Assistant speaker. Bundled with esbuild (see
// scripts/bundle.mjs) because sendspin-js imports bare npm modules.
//
// Two output modes:
//  - Web Audio (default): SendspinPlayer plays, clock-synchronized.
//  - Through the Audacious engine: SendspinCore only decodes; each PCM chunk goes to
//    the main process stamped with the local time it should be heard, and
//    libaudcore plays it (src/main/sendspin-live.ts), so Audacious effects,
//    the equalizer and visualizations apply.

interface HostBridge {
  sendspinConfig(): Promise<{ url: string; name: string; throughAudacious: boolean }>;
  sendspinState(state: Partial<SendspinState>): void;
  sendspinStream(event: { event: 'start' | 'clear' | 'end'; rate?: number; channels?: number }): void;
  sendspinPcm(chunk: { playAt: number; rate: number; channels: number; pcm: ArrayBuffer }): void;
  onSendspinCommand(listener: (command: { command: string; args?: Record<string, unknown> }) => void): () => void;
}

const host = (window as unknown as { audHost: HostBridge }).audHost;

// Some servers report speed x1000 (spec integer) and some as a ratio.
const speedOf = (raw: number | undefined) => (raw === undefined ? 1 : raw > 10 ? raw / 1000 : raw);

/** What both modes offer: SendspinPlayer and SendspinCore share these. */
type Client = Pick<SendspinCore, 'connect' | 'disconnect' | 'setVolume' | 'setMuted' | 'sendCommand' | 'clientId'>;

/** Float32 planar samples -> interleaved signed 16-bit, with volume applied. */
function toInt16(samples: Float32Array[], gain: number): ArrayBuffer {
  const channels = samples.length;
  const frames = samples[0]?.length ?? 0;
  const out = new Int16Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    const ch = samples[c];
    for (let i = 0; i < frames; i++) {
      const v = ch[i] * gain;
      out[i * channels + c] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
    }
  }
  return out.buffer;
}

async function main(): Promise<void> {
  const { url, name, throughAudacious } = await host.sendspinConfig();
  let pairingCode: string | null = null;
  let connection: SendspinState['connection'] = 'connecting';
  let error: string | undefined;
  const report = (extra: Partial<SendspinState> = {}) => host.sendspinState({ connection, error, pairingCode, ...extra });
  // Track position is anchored when the server sends a new one; other state
  // changes (volume, controller) must not reset the clock it advances from.
  let progressKey = '';
  let progressAt = 0;

  // eslint-disable-next-line prefer-const
  let client: Client;
  const config: SendspinPlayerConfig = {
    baseUrl: url,
    clientName: name,
    productName: 'ElectronPlayer',
    // Persist identity and pairing (sendspin-js keeps them in memory otherwise).
    storage: localStorage,
    correctionMode: 'sync',
    pinOutChannels: ['display'],
    onPairingPin: (pin) => {
      pairingCode = pin;
      report();
    },
    onPairing: (event, detail) => {
      if (event === 'finalized' || event === 'aborted') pairingCode = null;
      if (event === 'aborted' && detail) error = `Pairing aborted: ${detail}`;
      report();
    },
    reconnect: {
      onReconnecting: () => {
        connection = 'connecting';
        report();
      },
      onReconnected: () => {
        connection = 'connected';
        error = undefined;
        report({ clientId: client.clientId });
      },
      onExhausted: () => {
        connection = 'error';
        error = `Cannot reach ${url}`;
        report();
      },
    },
    onStateChange: (state) => {
      const meta = state.serverState?.metadata;
      const ctrl = state.serverState?.controller;
      const progress = meta?.progress;
      // group_update may not have arrived yet: playing unless it says stopped.
      const playingNow = state.isPlaying && state.groupState?.playback_state !== 'stopped';
      const key = `${progress?.track_progress}|${progress?.track_duration}|${progress?.playback_speed}|${meta?.timestamp}|${playingNow}`;
      if (key !== progressKey) {
        progressKey = key;
        progressAt = Date.now();
      }
      report({
        playing: playingNow,
        title: meta?.title ?? undefined,
        artist: meta?.artist ?? undefined,
        album: meta?.album ?? undefined,
        artworkUrl: meta?.artwork_url ?? undefined,
        progressMs: progress?.track_progress ?? 0,
        durationMs: progress?.track_duration ?? 0,
        progressAt,
        speed: playingNow ? speedOf(progress?.playback_speed) : 0,
        volume: state.volume,
        muted: state.muted,
        commands: ctrl?.supported_commands ?? [],
        groupName: state.groupState?.group_name,
      });
    },
  };

  let unlock = async () => {};
  if (throughAudacious) {
    const core = new SendspinCore(config);
    core.onAudioData = (chunk) => {
      // When to be heard, on this computer's clock (Date.now(), which the
      // main process shares), including any delay the server asked for.
      const dueInMs = (chunk.serverTimeUs - core.getCurrentServerTimeUs()) / 1000 + core.getSyncDelayMs();
      const gain = core.muted ? 0 : core.volume / 100;
      host.sendspinPcm({ playAt: Date.now() + dueInMs, rate: chunk.sampleRate, channels: chunk.samples.length, pcm: toInt16(chunk.samples, gain) });
    };
    core.onStreamStart = (format) => host.sendspinStream({ event: 'start', rate: format.sample_rate, channels: format.channels });
    core.onStreamClear = () => host.sendspinStream({ event: 'clear' });
    core.onStreamEnd = () => host.sendspinStream({ event: 'end' });
    client = core;
  } else {
    const player = new SendspinPlayer(config);
    // Electron allows this without a gesture (autoplayPolicy, see sendspin.ts).
    unlock = () => player.unlock();
    client = player;
  }

  host.onSendspinCommand(({ command, args }) => {
    try {
      if (command === 'local-volume') client.setVolume(Number(args?.volume ?? 100));
      else if (command === 'local-mute') client.setMuted(!!args?.muted);
      else client.sendCommand(command as never, args as never);
    } catch (err) {
      // e.g. a command the server does not list in supported_commands
      error = (err as Error).message;
      report();
    }
  });

  report({ clientId: client.clientId });
  try {
    await unlock();
    await client.connect();
    connection = 'connected';
    error = undefined;
  } catch (err) {
    connection = 'error';
    error = (err as Error).message;
  }
  report({ clientId: client.clientId });

  window.addEventListener('pagehide', () => client.disconnect('shutdown'));
}

void main();
