import { SendspinPlayer } from '@sendspin/sendspin-js';
import type { SendspinState } from '../shared/ma.js';

// Runs in a hidden window (src/main/sendspin.ts): a Sendspin player that
// makes this app a Music Assistant speaker. Audio plays through Web Audio,
// clock-synchronized with the server. Bundled with esbuild (see
// scripts/bundle.mjs) because sendspin-js imports bare npm modules.

interface HostBridge {
  sendspinConfig(): Promise<{ url: string; name: string }>;
  sendspinState(state: Partial<SendspinState>): void;
  onSendspinCommand(listener: (command: { command: string; args?: Record<string, unknown> }) => void): () => void;
}

const host = (window as unknown as { audHost: HostBridge }).audHost;

// Some servers report speed x1000 (spec integer) and some as a ratio.
const speedOf = (raw: number | undefined) => (raw === undefined ? 1 : raw > 10 ? raw / 1000 : raw);

async function main(): Promise<void> {
  const { url, name } = await host.sendspinConfig();
  let pairingCode: string | null = null;
  let connection: SendspinState['connection'] = 'connecting';
  let error: string | undefined;

  const report = (extra: Partial<SendspinState> = {}) => host.sendspinState({ connection, error, pairingCode, ...extra });

  const player: SendspinPlayer = new SendspinPlayer({
    baseUrl: url,
    clientName: name,
    productName: 'Audacious for Electron',
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
        report({ clientId: player.clientId });
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
      report({
        playing: state.isPlaying && state.groupState?.playback_state !== 'stopped',
        title: meta?.title ?? undefined,
        artist: meta?.artist ?? undefined,
        album: meta?.album ?? undefined,
        artworkUrl: meta?.artwork_url ?? undefined,
        progressMs: progress?.track_progress ?? 0,
        durationMs: progress?.track_duration ?? 0,
        progressAt: Date.now(),
        speed: state.groupState?.playback_state === 'playing' ? speedOf(progress?.playback_speed) : 0,
        volume: state.volume,
        muted: state.muted,
        commands: ctrl?.supported_commands ?? [],
        groupName: state.groupState?.group_name,
      });
    },
  });

  host.onSendspinCommand(({ command, args }) => {
    try {
      if (command === 'local-volume') player.setVolume(Number(args?.volume ?? 100));
      else if (command === 'local-mute') player.setMuted(!!args?.muted);
      else player.sendCommand(command as never, args as never);
    } catch (err) {
      // e.g. a command the server does not list in supported_commands
      error = (err as Error).message;
      report();
    }
  });

  report({ clientId: player.clientId });
  try {
    // Electron allows this without a gesture (autoplayPolicy, see sendspin.ts).
    await player.unlock();
    await player.connect();
    connection = 'connected';
    error = undefined;
  } catch (err) {
    connection = 'error';
    error = (err as Error).message;
  }
  report({ clientId: player.clientId });

  window.addEventListener('pagehide', () => player.disconnect('shutdown'));
}

void main();
