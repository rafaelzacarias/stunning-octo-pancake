import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LAYOUT } from '../config.js';

/**
 * CameraDirector — orbit control, cinematic preset moves, trauma-driven
 * screen shake and autofocus for the depth-of-field pass.
 */

export const CAMERA_PRESETS = [
  { id: 'wide', label: 'Wide Factory', key: 'F1', pos: [5.4, 3.3, 6.8], target: [0, 1.15, 0.4], fov: 34, aperture: 0.00035 },
  { id: 'teeth', label: 'Teeth-Eye', key: 'F2', pos: [0.44, 1.74, 0.50], target: [0, 1.19, 0], fov: 36, aperture: 0.0016 },
  { id: 'topDown', label: 'Top-Down', key: 'F3', pos: [0.02, 3.35, 0.28], target: [0, 1.2, 0.1], fov: 40, aperture: 0.0008 },
  { id: 'chute', label: 'Discharge', key: 'F4', pos: [1.5, 1.05, -2.85], target: [0, 0.55, -1.2], fov: 38, aperture: 0.0013 },
  { id: 'operator', label: 'Operator', key: 'F5', pos: [-2.35, 2.25, 3.5], target: [0, 1.45, 0.9], fov: 42, aperture: 0.0005 },
];

const _v = new THREE.Vector3();

export class CameraDirector {
  constructor(camera, domElement, postfx) {
    this.camera = camera;
    this.postfx = postfx;

    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.rotateSpeed = 0.62;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.6;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 24;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 1.15, 0.4);

    this.trauma = 0;
    this.traumaDecay = 1.35;
    this._shakeOffset = new THREE.Vector3();
    this._shakeEuler = new THREE.Euler();
    this._baseQuat = new THREE.Quaternion();
    this._noiseT = Math.random() * 1000;

    this.transition = null;
    this.activePreset = 'wide';
    this.autoFocus = true;
    this._focus = 5.0;
    this._targetFov = camera.fov;

    this.apply('wide', true);
  }

  apply(id, instant = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    this.activePreset = id;

    const toPos = new THREE.Vector3(...preset.pos);
    const toTarget = new THREE.Vector3(...preset.target);
    this._targetFov = preset.fov;
    this._targetAperture = preset.aperture;

    if (instant) {
      this.camera.position.copy(toPos);
      this.controls.target.copy(toTarget);
      this.camera.fov = preset.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.transition = null;
      return;
    }

    this.transition = {
      t: 0,
      dur: 1.15,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      fromFov: this.camera.fov,
      toPos, toTarget, toFov: preset.fov,
    };
  }

  /** Add camera trauma. Squared response makes small hits subtle and big hits brutal. */
  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt, load) {
    // Undo last frame's shake before OrbitControls reads the transform.
    this.camera.position.sub(this._shakeOffset);

    if (this.transition) {
      const tr = this.transition;
      tr.t += dt;
      const k = Math.min(1, tr.t / tr.dur);
      // Smooth in/out with a slight overshoot-free ease.
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(tr.fromPos, tr.toPos, e);
      this.controls.target.lerpVectors(tr.fromTarget, tr.toTarget, e);
      this.camera.fov = THREE.MathUtils.lerp(tr.fromFov, tr.toFov, e);
      this.camera.updateProjectionMatrix();
      this.controls.enabled = false;
      if (k >= 1) { this.transition = null; this.controls.enabled = true; }
    }

    this.controls.update();

    // Sustained machine load feeds a low-level rumble on top of impact trauma.
    const rumble = Math.max(0, load - 0.18) * 0.24;
    const shake = Math.min(1, this.trauma + rumble);
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);

    if (shake > 0.0015) {
      this._noiseT += dt * 34;
      const s = shake * shake;
      const amp = 0.021 * s;
      const ox = (perlin1(this._noiseT) ) * amp;
      const oy = (perlin1(this._noiseT + 133.7)) * amp;
      const oz = (perlin1(this._noiseT + 421.9)) * amp * 0.6;
      this._shakeOffset.set(ox, oy, oz);
      this.camera.position.add(this._shakeOffset);

      // A touch of roll sells the impact without inducing nausea.
      const roll = perlin1(this._noiseT + 77.1) * 0.009 * s;
      this.camera.rotateZ(roll);
    } else {
      this._shakeOffset.set(0, 0, 0);
    }

    if (this.autoFocus && this.postfx) {
      // Focus on whatever the orbit target is, biased toward the throat when
      // the camera is looking into the machine.
      _v.copy(this.controls.target);
      const throat = new THREE.Vector3(...LAYOUT.throatCenter);
      const toThroat = this.camera.position.distanceTo(throat);
      const toTarget = this.camera.position.distanceTo(_v);
      const looking = this.camera.getWorldDirection(new THREE.Vector3())
        .dot(throat.clone().sub(this.camera.position).normalize());
      const want = looking > 0.86 ? THREE.MathUtils.lerp(toTarget, toThroat, 0.7) : toTarget;
      this._focus += (want - this._focus) * Math.min(1, dt * 3.4);
      this.postfx.setFocus(this._focus, this._targetAperture);
    }
  }

  onResize() { this.controls.update(); }

  dispose() { this.controls.dispose(); }
}

/** Cheap value-noise in 1D — smoother and less jittery than Math.random shake. */
function perlin1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i), b = hash1(i + 1);
  return (a + (b - a) * u) * 2 - 1;
}

function hash1(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
