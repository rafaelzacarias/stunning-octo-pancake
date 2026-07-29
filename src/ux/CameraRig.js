import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { bus } from '../core/EventBus.js';
import { EVENTS, CAMERA_PRESETS } from '../core/Constants.js';
import { ScreenShake } from './ScreenShake.js';

/** Smoothstep ease in [0,1]. */
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Camera rig for the shredder viewport.
 *
 * Responsibilities:
 *  - OrbitControls with damping and floor/ceiling limits tuned for a ~2 m rig.
 *  - Smooth, interruptible cinematic transitions between named presets
 *    (position + target + fov all eased together over ~0.9 s).
 *  - Dynamic depth of field: raycasts the scene centre so focus snaps onto
 *    whatever is currently being shredded, then pushes it into PostFX.
 *  - Load-driven + impulse screen shake, applied as a drift-free offset after
 *    the orbit solve.
 *  - Optional "cinematic" showcase mode (slow auto-orbit + handheld micro-motion).
 */
export class CameraRig {
  /**
   * @param {object}                    opts
   * @param {THREE.PerspectiveCamera}   opts.camera
   * @param {HTMLElement}               opts.domElement
   * @param {import('../render/PostFX.js').PostFX} opts.postfx
   * @param {THREE.Scene}               opts.scene
   */
  constructor({ camera, domElement, postfx, scene }) {
    this.camera = camera;
    this.postfx = postfx;
    this.scene = scene;

    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.6;
    controls.minDistance = 0.55;
    controls.maxDistance = 8.5;
    // Keep the eye above the floor and out of the ceiling.
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 0.78, 0);
    controls.autoRotateSpeed = 0.55;
    this.controls = controls;

    this.shake = new ScreenShake();

    // --- preset / transition state -------------------------------------
    this.presetId = 'wide';
    this._aperture = CAMERA_PRESETS.wide.aperture;
    this._transition = null;
    // A preset fly-to is a suggestion — any user drag interrupts it.
    controls.addEventListener('start', () => {
      if (this._transition) this._transition.abort = true;
    });

    // --- depth of field ------------------------------------------------
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2(0, 0);
    this._focusDist = CAMERA_PRESETS.wide.focusDistance;
    this._focusOverride = null;
    this._focusOverrideTtl = 0;
    this._dofFrame = 0;

    // --- cinematic -----------------------------------------------------
    this.cinematic = false;
    this._handheldT = Math.random() * 1000;

    // --- shake offset bookkeeping (drift-free) -------------------------
    this._basePos = new THREE.Vector3().copy(camera.position);
    this._baseQuat = new THREE.Quaternion().copy(camera.quaternion);
    this._shakeApplied = false;

    this._offMotor = bus.on(EVENTS.MOTOR_LOAD, (p) => {
      if (!p) return;
      this.shake.setRumble(p.load || 0, !!p.stalled);
    });
    this._offShake = bus.on(EVENTS.SHAKE, (p) => {
      if (!p) return;
      this.addShake(p.strength || 0, p.duration || 0.25);
    });

    // Lock the very first frame exactly onto the default preset (deterministic
    // for the capture harness; also seeds DoF focus + aperture).
    this.setPreset('wide', { instant: true });
  }

  /**
   * Fly to a named camera preset.
   * @param {'wide'|'topDown'|'teeth'|'conveyor'|'discharge'} id
   * @param {object} [opts]
   * @param {boolean} [opts.instant] Snap immediately with no 0.9 s ease (used
   *   by the capture harness and to lock the very first frame onto `wide`).
   */
  setPreset(id, { instant = false } = {}) {
    const preset = CAMERA_PRESETS[id];
    if (!preset) return;
    this.presetId = id;
    if (this.cinematic) this.setCinematic(false);
    this._focusOverride = null;
    this._focusOverrideTtl = 0;

    if (instant) {
      this._transition = null;
      this._snapTo(preset);
      return;
    }

    this._transition = {
      t: 0,
      dur: 0.9,
      abort: false,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      fromFov: this.camera.fov,
      fromAperture: this._aperture,
      toPos: new THREE.Vector3().fromArray(preset.position),
      toTarget: new THREE.Vector3().fromArray(preset.target),
      toFov: preset.fov,
      toAperture: preset.aperture
    };
  }

  /** @private Hard-set camera + controls + DoF to a preset, no interpolation. */
  _snapTo(preset) {
    const cam = this.camera;
    cam.position.fromArray(preset.position);
    this.controls.target.fromArray(preset.target);
    if (Math.abs(preset.fov - cam.fov) > 1e-6) {
      cam.fov = preset.fov;
      cam.updateProjectionMatrix();
    }
    this._aperture = preset.aperture;
    this._focusDist = preset.focusDistance;
    cam.lookAt(this.controls.target);
    this.controls.update();
    this._basePos.copy(cam.position);
    this._baseQuat.copy(cam.quaternion);
    this._shakeApplied = false;
    if (this.postfx && typeof this.postfx.setFocus === 'function') {
      this.postfx.setFocus(this._focusDist, this._aperture);
    }
  }

  /**
   * Add a discrete screen-shake impulse (big shear / hard hit).
   * @param {number} strength 0..1-ish
   * @param {number} [duration] seconds
   */
  addShake(strength, duration = 0.25) {
    this.shake.addImpulse(strength, duration);
  }

  /**
   * Retarget the orbit pivot and depth-of-field onto a world point (e.g. the
   * piece currently under the teeth).
   * @param {THREE.Vector3} worldPosition
   */
  focusOn(worldPosition) {
    if (!worldPosition) return;
    this._focusOverride = this._focusOverride || new THREE.Vector3();
    this._focusOverride.copy(worldPosition);
    this._focusOverrideTtl = 1.5;
    this._transition = {
      t: 0,
      dur: 0.7,
      abort: false,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      fromFov: this.camera.fov,
      fromAperture: this._aperture,
      toPos: this.camera.position.clone(),
      toTarget: worldPosition.clone(),
      toFov: this.camera.fov,
      toAperture: this._aperture
    };
  }

  /**
   * Toggle the slow auto-orbit showcase mode.
   * @param {boolean} on
   */
  setCinematic(on) {
    this.cinematic = !!on;
    this.controls.autoRotate = !!on && !this.shake.reducedMotion;
  }

  /**
   * Advance the rig one frame. Called by the main loop after physics/VFX.
   * @param {number} dt seconds
   */
  update(dt) {
    const cam = this.camera;

    // 1. Undo last frame's shake so OrbitControls never reads a shaken pose
    //    (prevents feedback drift).
    if (this._shakeApplied) {
      cam.position.copy(this._basePos);
      cam.quaternion.copy(this._baseQuat);
      this._shakeApplied = false;
    }

    // 2. Cinematic preset transition. User input still applies through the
    //    OrbitControls damping below, and a drag aborts the move.
    const tr = this._transition;
    if (tr && !tr.abort) {
      tr.t += dt;
      const k = ease(tr.t / tr.dur);
      cam.position.lerpVectors(tr.fromPos, tr.toPos, k);
      this.controls.target.lerpVectors(tr.fromTarget, tr.toTarget, k);
      const fov = tr.fromFov + (tr.toFov - tr.fromFov) * k;
      if (Math.abs(fov - cam.fov) > 1e-3) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
      this._aperture = tr.fromAperture + (tr.toAperture - tr.fromAperture) * k;
      if (tr.t >= tr.dur) this._transition = null;
    } else if (tr && tr.abort) {
      this._transition = null;
    }

    // 3. Orbit solve (applies damping + any user/auto-rotate deltas).
    this.controls.update();

    // 4. Record the clean base pose before shake.
    this._basePos.copy(cam.position);
    this._baseQuat.copy(cam.quaternion);

    // 5. Dynamic depth of field.
    this._updateDof(dt);

    // 6. Screen shake + handheld micro-motion → drift-free offset.
    this.shake.update(dt);
    this._applyOffsets(dt);
  }

  /** @private Raycast the frame centre, smooth the hit distance, push to DoF. */
  _updateDof(dt) {
    let measured;

    if (this._focusOverrideTtl > 0 && this._focusOverride) {
      this._focusOverrideTtl -= dt;
      measured = this.camera.position.distanceTo(this._focusOverride);
    } else if ((this._dofFrame++ % 3) === 0) {
      // A single centre ray is cheap; throttle to every 3rd frame and smooth.
      this._ray.setFromCamera(this._ndc, this.camera);
      let hit = null;
      try {
        const hits = this._ray.intersectObject(this.scene, true);
        for (let i = 0; i < hits.length; i++) {
          const o = hits[i].object;
          if (o && o.visible && !o.isLine && o.type !== 'GridHelper') { hit = hits[i]; break; }
        }
      } catch (_) { /* scene mid-mutation by another agent — ignore */ }
      measured = hit
        ? hit.distance
        : this.camera.position.distanceTo(this.controls.target);
    } else {
      measured = this.camera.position.distanceTo(this.controls.target);
    }

    // Exponential (critically-damped) smoothing so focus glides, never pops.
    const s = 1 - Math.exp(-dt * 6);
    this._focusDist += (measured - this._focusDist) * s;

    if (this.postfx && typeof this.postfx.setFocus === 'function') {
      this.postfx.setFocus(this._focusDist, this._aperture);
    }
  }

  /** @private Apply shake + handheld motion in camera-local space. */
  _applyOffsets(dt) {
    const cam = this.camera;
    let px = this.shake.offsetPos.x;
    let py = this.shake.offsetPos.y;
    let pz = this.shake.offsetPos.z;
    let rx = this.shake.offsetRot.x;
    let ry = this.shake.offsetRot.y;
    let rz = this.shake.offsetRot.z;

    // Subtle handheld drift in cinematic mode for a "filmed" feel.
    if (this.cinematic && !this.shake.reducedMotion) {
      this._handheldT += dt;
      const h = this._handheldT;
      px += Math.sin(h * 0.7) * 0.006;
      py += Math.sin(h * 0.9 + 1.7) * 0.006;
      rx += Math.sin(h * 0.6 + 0.4) * 0.0016;
      ry += Math.sin(h * 0.5 + 2.1) * 0.0016;
    }

    if (px === 0 && py === 0 && pz === 0 && rx === 0 && ry === 0 && rz === 0) {
      return;
    }

    cam.translateX(px);
    cam.translateY(py);
    cam.translateZ(pz);
    cam.rotateX(rx);
    cam.rotateY(ry);
    cam.rotateZ(rz);
    this._shakeApplied = true;
  }

  /** Detach bus listeners and controls. */
  dispose() {
    this._offMotor?.();
    this._offShake?.();
    this.controls.dispose();
  }
}
