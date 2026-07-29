import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LAYOUT } from '../config.js';

/**
 * CameraDirector — orbit control, cinematic preset moves and autofocus for the
 * depth-of-field pass.
 *
 * The camera transform is intentionally free of any impact/load-driven shake.
 * Nothing in this module perturbs position or rotation outside of user orbit
 * input and explicit preset transitions, so the view stays rock steady even
 * under a full throat jam.
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

  /**
   * Retained as a no-op so gameplay code can keep reporting impact severity
   * without the camera ever moving. Screen shake is deliberately disabled.
   */
  addTrauma() {}

  update(dt) {
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
