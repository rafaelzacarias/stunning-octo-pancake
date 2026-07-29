import { bus } from './EventBus.js';
import { EVENTS } from './Constants.js';

/**
 * Rolling frame-time statistics with hysteresis, used both for the on-screen
 * HUD and to drive adaptive quality scaling. Everything is stored in a
 * pre-allocated ring buffer so the monitor itself never causes GC spikes.
 */
export class PerfMonitor {
  constructor({ sampleCount = 180, emitInterval = 0.25 } = {}) {
    this.samples = new Float32Array(sampleCount);
    this.sampleCount = sampleCount;
    this._cursor = 0;
    this._filled = 0;
    this._emitAccum = 0;
    this.emitInterval = emitInterval;

    this.fps = 60;
    this.frameMs = 16.7;
    /** 95th percentile frame time — what actually causes visible hitching. */
    this.frameMs95 = 16.7;
    this.worstMs = 16.7;
    this.longFrames = 0;

    this._sorted = new Float32Array(sampleCount);
    this.extra = { bodies: 0, drawCalls: 0, tris: 0, fragments: 0, sparks: 0 };
  }

  /** @param {number} dt seconds */
  sample(dt) {
    const ms = dt * 1000;
    this.samples[this._cursor] = ms;
    this._cursor = (this._cursor + 1) % this.sampleCount;
    if (this._filled < this.sampleCount) this._filled++;
    if (ms > 33.4) this.longFrames++;

    this._emitAccum += dt;
    if (this._emitAccum >= this.emitInterval) {
      this._emitAccum = 0;
      this._recompute();
      bus.emit(EVENTS.STATS, {
        fps: this.fps,
        frameMs: this.frameMs,
        frameMs95: this.frameMs95,
        longFrames: this.longFrames,
        ...this.extra
      });
    }
  }

  _recompute() {
    const n = this._filled;
    if (n === 0) return;
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const v = this.samples[i];
      sum += v;
      if (v > worst) worst = v;
      this._sorted[i] = v;
    }
    const view = this._sorted.subarray(0, n);
    view.sort();
    this.frameMs = sum / n;
    this.frameMs95 = view[Math.min(n - 1, Math.floor(n * 0.95))];
    this.worstMs = worst;
    this.fps = 1000 / Math.max(0.0001, this.frameMs);
  }

  /** Median frame time over the window, immune to single-frame outliers. */
  get medianMs() {
    const n = this._filled;
    if (n === 0) return 16.7;
    return this._sorted[Math.floor(n / 2)] || this.frameMs;
  }

  reset() {
    this._filled = 0;
    this._cursor = 0;
    this.longFrames = 0;
  }
}
