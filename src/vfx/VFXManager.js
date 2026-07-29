import * as THREE from 'three';

import { bus } from '../core/EventBus.js';
import { EVENTS, METALS, SHREDDER } from '../core/Constants.js';
import { SparkSystem } from './SparkSystem.js';
import { DustSystem } from './DustSystem.js';
import { ShrapnelSystem } from './ShrapnelSystem.js';

/**
 * The VFX façade consumed by {@link main.js}.
 *
 * Owns the spark, dust and shrapnel systems, subscribes to the shared event
 * bus and translates physics/destruction events into particle emissions:
 *
 *  - {@link EVENTS.SHEAR}  -> a directional spark fan (count/speed/temperature
 *    scaled by the metal's `sparkYield`), a dust puff sized by the sheared area
 *    and a few shrapnel bits. Sparks spray **away from the cut along the tooth's
 *    tangential velocity**, biased downward/outward from the throat.
 *  - {@link EVENTS.IMPACT} -> a short spark burst + a small dust puff.
 *
 * All bus handlers are defensive: missing payload fields default sensibly and a
 * handler never throws (the bus also guards this, but we belt-and-braces it).
 */

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _throat = new THREE.Vector3(0, SHREDDER.shaftHeight, 0);

export class VFXManager {
  /**
   * @param {object} ctx
   * @param {THREE.Scene} ctx.scene
   * @param {THREE.WebGLRenderer} ctx.renderer
   * @param {THREE.PerspectiveCamera} ctx.camera
   * @param {number} ctx.maxSparks
   */
  constructor({ scene, renderer, camera, maxSparks }) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.maxSparks = maxSparks || 16000;

    this.liveSparkCount = 0;
    this._dt = 1 / 60;
    this._subs = [];
    this._built = false;
  }

  /** Construct the particle systems and subscribe to the bus. */
  async build() {
    this.sparks = new SparkSystem({ scene: this.scene, activeCap: this.maxSparks });
    this.dust = new DustSystem({ scene: this.scene });
    this.shrapnel = new ShrapnelSystem({
      scene: this.scene,
      capacity: 256,
      onBounce: (p, d) => {
        // Faint secondary spark when a chunk clatters.
        this.sparks.emitBurst(p, d, 2, {
          speed: 2.5,
          spread: 0.9,
          temperature: 0.5,
          life: 0.35,
          size: 0.014,
          fork: 0
        });
      }
    });

    this._subs.push(bus.on(EVENTS.SHEAR, (e) => this._onShear(e)));
    this._subs.push(bus.on(EVENTS.IMPACT, (e) => this._onImpact(e)));
    this._subs.push(bus.on(EVENTS.SCRAP_SPAWN, () => {}));

    this._built = true;
    return this;
  }

  /* ----------------------------------------------------------------- */

  _onShear(e) {
    if (!e) return;
    const metal = METALS[e.metal] || METALS.steel;
    const energy = clamp01(e.energy ?? 0.5);
    const area = Math.max(0, e.area ?? 0.001);

    _pos.copy(e.position || _throat);

    // Spray direction: primarily the tooth's tangential velocity, otherwise the
    // reverse of the cut normal, then bias outward from the throat and downward.
    if (e.velocity && e.velocity.lengthSq && e.velocity.lengthSq() > 1e-6) {
      _dir.copy(e.velocity).normalize();
    } else if (e.normal) {
      _nrm.copy(e.normal).normalize();
      _dir.copy(_nrm).multiplyScalar(-1);
    } else {
      _dir.set(0, -1, 0);
    }
    _vel.copy(_pos).sub(_throat).setY(0);
    if (_vel.lengthSq() > 1e-6) _dir.addScaledVector(_vel.normalize(), 0.5);
    _dir.y -= 0.6; // downward/outward from the cut
    if (_dir.lengthSq() < 1e-8) _dir.set(0, -1, 0);
    _dir.normalize();

    // Spark count & energetics scaled by yield and shear energy.
    const yieldFactor = metal.sparkYield ?? 1;
    const count = Math.round((14 + energy * 90) * yieldFactor);
    const speed = 5 + energy * 9;
    this.sparks.emitBurst(_pos, _dir, count, {
      speed,
      spread: 0.45 + energy * 0.35,
      temperature: 0.7 + energy * 0.3,
      color: metal.sparkColor ?? 0xffffff,
      life: 0.7 + energy * 0.5,
      size: 0.018 + energy * 0.01,
      gravityScale: 1,
      fork: 0.14 + energy * 0.18
    });

    // Dust volume tracks the sheared area; heavy cast iron smokes.
    const dustCount = Math.min(24, 2 + Math.round(area * 900 + energy * 6));
    const isHeavy = metal.id === 'castIron';
    this.dust.emit(_pos, dustCount, {
      color: dustColorFor(metal),
      size: 0.05 + energy * 0.05,
      life: 1.1 + energy * 0.6,
      smoke: isHeavy ? 0.7 : 0.15,
      rise: 0.3 + energy * 0.4,
      spread: 0.2 + energy * 0.3
    });

    // A few tiny bits fly off on harder shears.
    if (energy > 0.35) {
      const bits = 1 + Math.round(energy * 4 * yieldFactor);
      this.shrapnel.emit(_pos, _dir, bits, {
        speed: 3 + energy * 5,
        spread: 0.8,
        life: 3.5,
        size: 0.6 + energy * 0.8
      });
    }
  }

  _onImpact(e) {
    if (!e) return;
    const metal = METALS[e.metal] || METALS.steel;
    const impulse = Math.max(0, e.impulse ?? 0.5);
    const strength = clamp01(impulse / 6);
    _pos.copy(e.position || _throat);

    // Impacts throw sparks roughly upward/outward from the contact point.
    _dir.copy(_pos).sub(_throat).setY(0.4);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
    _dir.normalize();

    const count = Math.round((3 + strength * 22) * (metal.sparkYield ?? 1));
    this.sparks.emitBurst(_pos, _dir, count, {
      speed: 3 + strength * 7,
      spread: 0.7,
      temperature: 0.55 + strength * 0.35,
      color: metal.sparkColor ?? 0xffffff,
      life: 0.5 + strength * 0.35,
      size: 0.016,
      fork: 0.1
    });

    if (strength > 0.15) {
      this.dust.emit(_pos, 2 + Math.round(strength * 6), {
        color: dustColorFor(metal),
        size: 0.045,
        life: 0.9,
        smoke: 0.1,
        rise: 0.25
      });
    }
  }

  /* ----------------------------------------------------------------- */

  update(dt, camera) {
    this._dt = dt;
    const cam = camera || this.camera;
    this.sparks.update(dt, cam);
    this.dust.update(dt, cam);
    this.shrapnel.update(dt);
    this.liveSparkCount = this.sparks.liveCount;
  }

  /**
   * Resize / limit pools and disable systems on low presets. Never reallocates
   * GPU buffers — only adjusts soft caps so a preset change cannot hitch.
   * @param {object} preset a value from QUALITY_PRESETS
   */
  applyQuality(preset) {
    if (!this._built || !preset) return;
    this.maxSparks = preset.maxSparks || this.maxSparks;
    this.sparks.setActiveCap(this.maxSparks);

    const low = (preset.maxSparks || 0) <= 4500;
    // Shrapnel is the first system disabled on the performance preset.
    this.shrapnel.setEnabled(!low);
  }

  /** @param {number} w @param {number} h @param {number} dpr */
  setSize(w, h, dpr) {
    // Scale point-sprite size with vertical resolution so dust looks consistent.
    this.dust?.setPixelScale(320 * (h / 1080) * (dpr || 1));
  }

  dispose() {
    for (const off of this._subs) off();
    this._subs.length = 0;
    this.sparks?.dispose();
    this.dust?.dispose();
    this.shrapnel?.dispose();
  }
}

/* ------------------------------------------------------------------ */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const _GREY = new THREE.Color(0x8a8377);
const _dustCol = new THREE.Color();
function dustColorFor(metal) {
  // Muted, slightly warm metallic dust derived from the base colour.
  _dustCol.set(metal.color ?? 0x9a938a);
  _dustCol.lerp(_GREY, 0.55);
  return _dustCol;
}
