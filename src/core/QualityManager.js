import { QUALITY_PRESETS, EVENTS } from './Constants.js';
import { bus } from './EventBus.js';

const ORDER = ['performance', 'balanced', 'high', 'ultra'];

/**
 * Keeps the frame budget under control.
 *
 * The simulator targets a locked 60 FPS. When the 95th-percentile frame time
 * creeps over budget we step the quality preset down; when we have comfortable
 * headroom for a sustained period we step back up. Hysteresis + cooldowns stop
 * the system oscillating between tiers.
 */
export class QualityManager {
  /**
   * @param {import('./PerfMonitor.js').PerfMonitor} perf
   */
  constructor(perf, { initial = 'high', auto = true, targetFps = 60 } = {}) {
    this.perf = perf;
    this.auto = auto;
    this.targetFps = targetFps;
    this.budgetMs = 1000 / targetFps;
    this.level = ORDER.indexOf(initial) >= 0 ? ORDER.indexOf(initial) : 2;
    this._cooldown = 2.5;
    this._goodTime = 0;
    this._badTime = 0;
    this.locked = false;
  }

  get presetName() {
    return ORDER[this.level];
  }

  get preset() {
    return QUALITY_PRESETS[this.presetName];
  }

  /** Manually pick a tier; disables auto-scaling. */
  setPreset(name, { auto = false } = {}) {
    const idx = ORDER.indexOf(name);
    if (idx < 0) return;
    this.auto = auto;
    if (idx === this.level) return;
    this.level = idx;
    this._cooldown = 3.0;
    bus.emit(EVENTS.QUALITY_CHANGED, { preset: this.presetName, auto: this.auto });
  }

  setAuto(enabled) {
    this.auto = enabled;
    this._cooldown = 2.0;
  }

  update(dt) {
    if (!this.auto || this.locked) return;
    if (this._cooldown > 0) {
      this._cooldown -= dt;
      return;
    }
    // Ignore the first moments after a preset change while render targets rebuild.
    const p95 = this.perf.frameMs95;

    if (p95 > this.budgetMs * 1.22) {
      this._badTime += dt;
      this._goodTime = 0;
    } else if (p95 < this.budgetMs * 0.72) {
      this._goodTime += dt;
      this._badTime = 0;
    } else {
      this._badTime *= 0.9;
      this._goodTime *= 0.9;
    }

    if (this._badTime > 1.0 && this.level > 0) {
      this.level--;
      this._reset();
      bus.emit(EVENTS.QUALITY_CHANGED, { preset: this.presetName, auto: true, reason: 'down' });
    } else if (this._goodTime > 5.0 && this.level < ORDER.length - 1) {
      this.level++;
      this._reset();
      bus.emit(EVENTS.QUALITY_CHANGED, { preset: this.presetName, auto: true, reason: 'up' });
    }
  }

  _reset() {
    this._badTime = 0;
    this._goodTime = 0;
    this._cooldown = 3.5;
    this.perf.reset();
  }
}

export { ORDER as QUALITY_ORDER };
