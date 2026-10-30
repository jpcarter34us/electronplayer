import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { PlaybackState } from '../shared/backend';
import type { NativeMethod } from './native';

type Call = (method: NativeMethod, args: unknown[]) => Promise<unknown>;

// "Play through the Audacious engine": Music Assistant (Sendspin) audio played by
// libaudcore, so Audacious effects, the equalizer and visualizations apply.
//
// The Sendspin page decodes audio and sends PCM chunks stamped with the
// local time each should be heard (from the server clock). This router
// serves them to libaudcore as an endless WAV over loopback HTTP, the way
// it plays internet radio, writing each chunk ahead of its time by
// libaudcore's measured pipeline delay (about 70 ms) so playback stays in
// sync with other Music Assistant speakers.

/** Initial guess for the delay from writing audio to hearing it. */
const DEFAULT_PIPELINE_MS = 80;
/** Chunks later than this are dropped rather than played out of sync. */
const MAX_LATE_MS = 300;

interface Chunk {
  playAt: number; // Date.now() time to be heard
  data: Buffer; // interleaved signed 16-bit PCM
  ms: number;
}

export class LiveRouter {
  private server?: Server;
  private key = randomBytes(16).toString('hex');
  private generation = 0;
  private format = { rate: 48000, channels: 2 };
  private queue: Chunk[] = [];
  private response?: ServerResponse;
  private writtenMs = 0;
  private pipelineMs = DEFAULT_PIPELINE_MS;
  private active = false;
  private pacer?: NodeJS.Timeout;
  private calibrator?: NodeJS.Timeout;

  constructor(private native: Call) {}

  get isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const m = (req.url ?? '').match(/^\/sendspin\/([0-9a-f]+)\/live\/(\d+)\.wav$/);
      if (!m || m[1] !== this.key || Number(m[2]) !== this.generation || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      // libaudcore probes, then plays: each new request takes over the stream.
      this.response?.end();
      this.response = res;
      this.writtenMs = 0;
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      res.write(this.wavHeader());
      res.on('close', () => {
        if (this.response === res) this.response = undefined;
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  stop(): void {
    void this.end();
    this.server?.close();
  }

  /** A new stream or format from the server. */
  streamStart(rate: number, channels: number): void {
    const changed = rate !== this.format.rate || channels !== this.format.channels;
    this.format = { rate, channels };
    this.queue = [];
    if (this.active && changed) this.restart();
  }

  /** Seek or track change: drop what has not been written yet. */
  streamClear(): void {
    this.queue = [];
  }

  /** Playback stopped or paused: stop libaudcore's live stream. */
  async end(): Promise<void> {
    this.queue = [];
    if (!this.active) return;
    this.active = false;
    clearInterval(this.pacer);
    clearInterval(this.calibrator);
    this.response?.end();
    this.response = undefined;
    await this.native('stopLive', []).catch(() => {});
  }

  push(chunk: { playAt: number; pcm: ArrayBuffer; rate: number; channels: number }, title: string): void {
    if (chunk.rate !== this.format.rate || chunk.channels !== this.format.channels) this.streamStart(chunk.rate, chunk.channels);
    const data = Buffer.from(chunk.pcm);
    const ms = (data.length / (2 * chunk.channels) / chunk.rate) * 1000;
    if (chunk.playAt + ms < Date.now() - MAX_LATE_MS) return; // too late to be in sync
    // Chunks arrive in order; keep it sorted anyway.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].playAt > chunk.playAt) i--;
    this.queue.splice(i, 0, { playAt: chunk.playAt, data, ms });
    if (!this.active) this.begin(title);
  }

  private begin(title: string): void {
    this.active = true;
    this.restart(title);
    this.pacer = setInterval(() => this.pace(), 5);
    this.calibrator = setInterval(() => void this.calibrate(), 1000);
  }

  private restart(title = 'Music Assistant'): void {
    this.generation++;
    this.response?.end();
    this.response = undefined;
    const url = `http://127.0.0.1:${(this.server!.address() as { port: number }).port}/sendspin/${this.key}/live/${this.generation}.wav`;
    void this.native('playLive', [url, title]).catch(() => {});
  }

  private pace(): void {
    const now = Date.now();
    while (this.queue.length && this.queue[0].playAt - this.pipelineMs <= now) {
      const chunk = this.queue.shift()!;
      if (!this.response) continue; // not connected yet: in sync means dropping
      if (chunk.playAt + chunk.ms < now - MAX_LATE_MS) continue;
      this.response.write(chunk.data);
      this.writtenMs += chunk.ms;
    }
  }

  // Delay from writing to hearing = what we have written minus what
  // libaudcore reports as heard. Smoothed, and bounded to sane values.
  private async calibrate(): Promise<void> {
    if (!this.response || this.writtenMs < 500) return;
    const state = (await this.native('getState', []).catch(() => null)) as PlaybackState | null;
    if (!state?.live || state.time <= 0) return;
    const measured = this.writtenMs - state.time;
    if (measured > 0 && measured < 2000) this.pipelineMs = Math.round(this.pipelineMs * 0.8 + measured * 0.2);
  }

  private wavHeader(): Buffer {
    const { rate, channels } = this.format;
    const b = Buffer.alloc(44);
    b.write('RIFF', 0);
    b.writeUInt32LE(0xffffffff, 4); // endless
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); // PCM
    b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * channels * 2, 28);
    b.writeUInt16LE(channels * 2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(0xffffffff, 40);
    return b;
  }
}
