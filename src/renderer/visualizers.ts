import type { VisFrame } from '../shared/backend.js';
import type { VisId } from '../shared/prefs.js';

// Canvas ports of the GTK/Qt visualization plugins, fed by libaudcore's vis
// frames. Each processes one frame per render call, as the originals do.

export interface Visualizer {
  readonly canvas: HTMLCanvasElement;
  render(frame: VisFrame): void;
  clear(): void;
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b8def';

function fit(canvas: HTMLCanvasElement, scale = devicePixelRatio): boolean {
  const w = Math.max(1, Math.round(canvas.clientWidth * scale));
  const h = Math.max(1, Math.round(canvas.clientHeight * scale));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

// libaudcore's Visualizer::compute_log_xscale / compute_freq_band (util.cc).
function logXscale(bands: number): Float32Array {
  const xscale = new Float32Array(bands + 1);
  for (let i = 0; i <= bands; i++) xscale[i] = Math.pow(256, i / bands) - 0.5;
  return xscale;
}

function freqBand(freq: Float32Array, xscale: Float32Array, band: number, bands: number): number {
  let a = Math.ceil(xscale[band]);
  const b = Math.floor(xscale[band + 1]);
  let n = 0;
  if (b < a) n += freq[b] * (xscale[band + 1] - xscale[band]);
  else {
    if (a > 0) n += freq[a - 1] * (a - xscale[band]);
    for (; a < b; a++) n += freq[a];
    if (b < 256) n += freq[b] * (xscale[band + 1] - b);
  }
  n *= bands / 12;
  return 20 * Math.log10(n);
}

/** cairo-spectrum: log-spaced bars over a 40 dB range with peak falloff. */
class Spectrum implements Visualizer {
  readonly canvas = document.createElement('canvas');
  private bars: Float32Array = new Float32Array(0);
  private delay = new Int32Array(0);
  private xscale: Float32Array = new Float32Array(0);

  private static readonly DELAY = 2; // frames before falloff
  private static readonly FALLOFF = 2; // dB per frame

  render(frame: VisFrame): void {
    fit(this.canvas);
    const bands = Math.min(256, Math.max(12, Math.floor(this.canvas.clientWidth / 10)));
    if (bands !== this.bars.length) {
      this.bars = new Float32Array(bands);
      this.delay = new Int32Array(bands);
      this.xscale = logXscale(bands);
    }
    for (let i = 0; i < bands; i++) {
      const x = Math.min(40, Math.max(0, 40 + freqBand(frame.freq, this.xscale, i, bands)));
      this.bars[i] -= Math.max(0, Spectrum.FALLOFF - this.delay[i]);
      if (this.delay[i]) this.delay[i]--;
      if (x > this.bars[i]) {
        this.bars[i] = x;
        this.delay[i] = Spectrum.DELAY;
      }
    }
    this.draw();
  }

  clear(): void {
    this.bars.fill(0);
    this.delay.fill(0);
    this.draw();
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    const n = this.bars.length;
    if (!n) return;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, accent());
    gradient.addColorStop(1, '#e0f0ff');
    ctx.fillStyle = gradient;
    const step = width / n;
    for (let i = 0; i < n; i++) {
      const barHeight = (Math.max(0, this.bars[i]) / 40) * height;
      ctx.fillRect(i * step + 1, height - barHeight, Math.max(1, step - 2), barHeight);
    }
  }
}

/** blur_scope: an oscilloscope drawn into a buffer that blurs each frame. */
class BlurScope implements Visualizer {
  readonly canvas = document.createElement('canvas');
  private image?: ImageData;

  render(frame: VisFrame): void {
    // Low resolution like the original, scaled up by CSS.
    if (fit(this.canvas, 1) || !this.image) this.image = new ImageData(this.canvas.width, this.canvas.height);
    const { width, height, data } = this.image;
    this.blur(data, width, height);

    const color = this.color();
    let prev = -1;
    for (let x = 0; x < width; x++) {
      const sample = frame.pcm[Math.floor((x * frame.pcm.length) / width)];
      const y = Math.min(height - 1, Math.max(0, Math.round(height / 2 - (sample * height) / 2)));
      // Vertical run from the previous point, so steep edges stay connected.
      const [a, b] = prev < 0 ? [y, y] : [Math.min(prev, y), Math.max(prev, y)];
      for (let yy = a; yy <= b; yy++) data.set(color, (yy * width + x) * 4);
      prev = y;
    }
    this.canvas.getContext('2d')!.putImageData(this.image, 0, 0);
  }

  clear(): void {
    this.image?.data.fill(0);
    if (this.image) this.canvas.getContext('2d')!.putImageData(this.image, 0, 0);
  }

  // Average of the four neighbours, as in blur_scope's do_blur(). Alpha
  // fades with the colour so trails dissolve into the page background.
  private blur(p: Uint8ClampedArray, w: number, h: number): void {
    const src = p.slice();
    const row = w * 4;
    for (let i = row; i < p.length - row; i++) p[i] = (src[i - row] + src[i + row] + src[i - 4] + src[i + 4]) >> 2;
    p.fill(0, 0, row);
    p.fill(0, p.length - row);
  }

  private rgba?: [string, Uint8ClampedArray];

  // The accent colour as RGBA bytes; re-resolved only if the theme changes it.
  private color(): Uint8ClampedArray {
    const css = accent();
    if (this.rgba?.[0] !== css) {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      this.rgba = [css, ctx.getImageData(0, 0, 1, 1).data];
    }
    return this.rgba[1];
  }
}

/** vumeter: per-channel peak level in dB with a held peak marker. */
class VuMeter implements Visualizer {
  readonly canvas = document.createElement('canvas');
  private level: number[] = [];
  private peak: number[] = [];
  private peakAge: number[] = [];

  private static readonly RANGE = 40; // dB shown
  private static readonly FALLOFF = 1; // dB per frame
  private static readonly HOLD = 30; // frames (~1 s)

  render(frame: VisFrame): void {
    const channels = Math.max(1, frame.levels.length);
    for (let c = 0; c < channels; c++) {
      const db = Math.max(-VuMeter.RANGE, 20 * Math.log10(frame.levels[c] || 1e-6));
      this.level[c] = Math.max(db, (this.level[c] ?? -VuMeter.RANGE) - VuMeter.FALLOFF);
      if (db >= (this.peak[c] ?? -VuMeter.RANGE) || ++this.peakAge[c] > VuMeter.HOLD) {
        this.peak[c] = db;
        this.peakAge[c] = 0;
      }
    }
    this.level.length = this.peak.length = this.peakAge.length = channels;
    this.draw();
  }

  clear(): void {
    this.level = [];
    this.peak = [];
    this.peakAge = [];
    this.draw();
  }

  private draw(): void {
    fit(this.canvas);
    const ctx = this.canvas.getContext('2d')!;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    const n = this.level.length;
    if (!n) return;
    const gap = Math.max(2, height * 0.08);
    const barHeight = (height - gap * (n + 1)) / n;
    const toX = (db: number) => ((db + VuMeter.RANGE) / VuMeter.RANGE) * width;
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#3fb950');
    gradient.addColorStop(0.75, '#d29922');
    gradient.addColorStop(1, '#f85149');
    for (let c = 0; c < n; c++) {
      const y = gap + c * (barHeight + gap);
      ctx.fillStyle = 'rgb(127 127 127 / 0.15)';
      ctx.fillRect(0, y, width, barHeight);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, y, toX(this.level[c]), barHeight);
      ctx.fillRect(Math.max(0, toX(this.peak[c]) - 2), y, 2, barHeight);
    }
  }
}

export function createVisualizer(id: VisId): Visualizer {
  switch (id) {
    case 'spectrum': return new Spectrum();
    case 'scope': return new BlurScope();
    case 'vu': return new VuMeter();
  }
}
