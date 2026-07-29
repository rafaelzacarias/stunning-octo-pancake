import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * CONTRACT (owned by the UX sub-agent).
 * Orbit controls + cinematic presets + load-driven screen shake + DoF focus.
 */
export class CameraRig {
  constructor({ camera, domElement, postfx, scene }) {
    this.camera = camera;
    this.postfx = postfx;
    this.scene = scene;
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.78, 0);
  }
  update(_dt) { this.controls.update(); }
  setPreset(_id) {}
  addShake(_strength, _duration) {}
}
