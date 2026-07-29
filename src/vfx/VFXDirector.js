import * as THREE from 'three';
import { GPUParticles, PTYPE } from './GPUParticles.js';

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * VFXDirector — turns destruction events into particle jets, and feeds the
 * light that sparks cast back into the scene.
 */
export class VFXDirector {
  constructor(scene, renderer, quality = 'high') {
    this.scene = scene;
    const cap = quality === 'low' ? 4096 : quality === 'medium' ? 8192 : 16384;
    this.particles = new GPUParticles(renderer, { capacity: cap, maxEmitPerFrame: 2400 });
    scene.add(this.particles.mesh);

    // Sparks are a real light source in the throat; without this the machine
    // looks like a video composited over a photo. Intensity is candela, and
    // the emitter sits centimetres from the metal, so it stays tiny.
    this.sparkLight = new THREE.PointLight(0xff8a30, 0, 2.6, 2.0);
    this.sparkLight.position.set(0, 1.22, 0);
    scene.add(this.sparkLight);
    this._lightEnergy = 0;

    this.budget = quality === 'low' ? 90 : quality === 'medium' ? 160 : 260;
    this._spent = 0;
    this.liveEstimate = 0;
    this.intensityScale = 1;
    this.setQuality(quality);
  }

  setQuality(q) {
    this.particles.setQuality(q);
    this.budget = q === 'low' ? 90 : q === 'medium' ? 160 : 260;
    this.intensityScale = q === 'low' ? 0.6 : q === 'medium' ? 0.82 : 1;
  }

  /**
   * Grinding / shearing spark jet.
   * Sparks leave along the tooth's sweep, not along the contact normal — that
   * directionality is the single biggest tell of a believable spark shower.
   */
  spark(point, normal, intensity, spec, isTear = false) {
    if (this._spent >= this.budget) return;
    const amount = Math.min(1, intensity) * (spec?.sparkYield ?? 1) * this.intensityScale;
    if (amount < 0.02) return;

    const base = isTear ? 14 : 4;
    let count = Math.round(base * amount * (0.6 + Math.random() * 0.8));
    count = Math.min(count, this.budget - this._spent);
    if (count <= 0) return;
    this._spent += count;

    // Primary jet: tangential to the rotor, thrown up and out of the throat.
    _dir.copy(normal).multiplyScalar(0.45);
    _dir.y += 0.85;
    _dir.x += (point.x >= 0 ? 0.25 : -0.25);
    _dir.z += (point.z >= 0 ? 0.5 : -0.5) * (0.4 + Math.random() * 0.5);
    _dir.normalize();

    this.particles.emit(point, _dir, count, {
      type: PTYPE.SPARK,
      speed: 3.4 + amount * 6.5 + (isTear ? 3.5 : 0),
      speedVar: 0.75,
      spread: isTear ? 0.85 : 0.62,
      life: 0.55 + amount * 0.7,
      lifeVar: 0.65,
      jitter: 0.016,
    });

    // A secondary counter-jet down into the machine so the shower is not a
    // single fan; real shredders spray in every direction.
    if (Math.random() < 0.55) {
      const n = Math.max(2, Math.round(count * 0.35));
      _tmp.set(-_dir.x * 0.5, -0.25, -_dir.z * 0.8).normalize();
      this.particles.emit(point, _tmp, n, {
        type: PTYPE.SPARK,
        speed: 2.2 + amount * 3.4, speedVar: 0.8, spread: 1.0,
        life: 0.4 + amount * 0.5, lifeVar: 0.7, jitter: 0.014,
      });
      this._spent += n;
    }

    // Long-lived embers that arc away and settle on the deck.
    if (isTear || amount > 0.55) {
      const n = Math.max(1, Math.round(count * 0.12));
      this.particles.emit(point, _dir, n, {
        type: PTYPE.EMBER,
        speed: 2.0 + amount * 4.0, speedVar: 0.8, spread: 0.9,
        life: 1.8 + Math.random() * 1.4, lifeVar: 0.4, jitter: 0.02,
      });
      this._spent += n;
    }

    this._lightEnergy = Math.min(1.0, this._lightEnergy + amount * (isTear ? 0.55 : 0.18));
    this.sparkLight.position.lerp(point, 0.35);
  }

  dust(point, intensity, spec) {
    if (this._spent >= this.budget) return;
    const count = Math.min(Math.round(3 + intensity * 7), this.budget - this._spent);
    if (count <= 0) return;
    this._spent += count;
    _dir.set((Math.random() - 0.5) * 0.6, 1, (Math.random() - 0.5) * 0.6).normalize();
    this.particles.emit(point, _dir, count, {
      type: PTYPE.DUST,
      speed: 0.35 + intensity * 0.9, speedVar: 0.8, spread: 1.1,
      life: 1.1 + Math.random() * 1.3, lifeVar: 0.5, jitter: 0.05,
    });
  }

  shrapnel(point, count, spec) {
    const n = Math.min(count, Math.max(0, this.budget - this._spent));
    if (n <= 0) return;
    this._spent += n;
    _dir.set((Math.random() - 0.5), 0.9, (Math.random() - 0.5)).normalize();
    this.particles.emit(point, _dir, n, {
      type: PTYPE.SHRAPNEL,
      speed: 1.8 + Math.random() * 3.2, speedVar: 0.85, spread: 1.35,
      life: 2.2, lifeVar: 0.5, jitter: 0.03,
    });
    // A puff of dust always accompanies material actually being destroyed.
    this.dust(point, 0.6, spec);
  }

  impact(point, intensity, spec) {
    if (intensity < 0.25) return;
    const n = Math.min(Math.round(intensity * 9), Math.max(0, this.budget - this._spent));
    if (n <= 0) return;
    this._spent += n;
    _dir.set((Math.random() - 0.5) * 0.8, 1, (Math.random() - 0.5) * 0.8).normalize();
    this.particles.emit(point, _dir, n, {
      type: PTYPE.SPARK,
      speed: 1.6 + intensity * 3.4, speedVar: 0.9, spread: 1.2,
      life: 0.32 + intensity * 0.3, lifeVar: 0.6, jitter: 0.02,
    });
  }

  update(dt) {
    // Rolling estimate of live particles for the telemetry readout.
    this.liveEstimate = this.liveEstimate * Math.exp(-dt / 1.1) + this._spent;
    this._spent = 0;
    this._lightEnergy *= Math.exp(-dt * 7.5);
    // Flicker: an arc light is never steady.
    // Flicker: an arc light is never steady. Peaks at ~0.6 cd, which is about
    // 6 lx on metal 30 cm away - a visible pulse, not a flashbang.
    const flicker = 0.72 + Math.random() * 0.5;
    this.sparkLight.intensity = this._lightEnergy * 0.48 * flicker;
    this.particles.update(dt);
  }

  dispose() {
    this.scene.remove(this.particles.mesh);
    this.scene.remove(this.sparkLight);
    this.particles.dispose();
  }
}
