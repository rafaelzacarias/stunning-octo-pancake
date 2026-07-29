import * as THREE from 'three';
import {
  TRANSFORM_STRIDE,
  CONTACT_STRIDE,
  MAX_CONTACTS_PER_FRAME,
  PHYSICS
} from '../core/Constants.js';

/**
 * Main-thread proxy for the Rapier3D simulation running inside
 * {@link module:physics.worker}. Ids are allocated **synchronously** on the
 * main thread so callers can wire up bindings immediately; every mutating call
 * is queued and flushed to the worker once per frame in {@link beginFrame}.
 *
 * The worker streams transforms back as transferable buffers. This class keeps
 * the two most recent snapshots and interpolates between them in
 * {@link applyTransforms}, so visual motion stays silky regardless of the
 * render refresh rate.
 */
export class PhysicsClient {
  constructor() {
    /** @type {number} number of live (added, not yet removed) bodies. */
    this.bodyCount = 0;

    this._worker = null;
    this._ready = false;
    this._nextId = 1;

    /** id -> THREE.Object3D bound to receive interpolated transforms. */
    this._bindings = new Map();
    /** id -> arbitrary main-side userData (kind, metal, ...). */
    this._userData = new Map();
    /** ids known to physics (added, not yet removed). */
    this._live = new Set();

    /** Queued commands flushed to the worker each beginFrame. */
    this._commands = [];

    this._maxBodies = PHYSICS.maxBodies;

    // Double-buffered transform snapshots (main-owned, never transferred).
    this._prev = null;
    this._cur = null;
    this._prevCount = 0;
    this._curCount = 0;
    this._prevTime = 0;
    this._curTime = 0;
    /** id -> float offset within the prev / cur snapshot. */
    this._prevIndex = new Map();
    this._curIndex = new Map();

    // Accumulated contacts since the last consumeContacts().
    this._contacts = new Float32Array(MAX_CONTACTS_PER_FRAME * CONTACT_STRIDE * 4);
    this._contactCount = 0;

    // Scratch objects (reused; zero per-frame allocation).
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();

    this._pendingResolve = null;
  }

  /**
   * Boot the worker and wait for Rapier to finish initialising.
   * @param {{gravity?:number[], fixedDt?:number, maxBodies?:number}} opts
   * @returns {Promise<PhysicsClient>}
   */
  init(opts = {}) {
    this._maxBodies = opts.maxBodies || PHYSICS.maxBodies;
    this._prev = new Float32Array(this._maxBodies * TRANSFORM_STRIDE);
    this._cur = new Float32Array(this._maxBodies * TRANSFORM_STRIDE);

    this._worker = new Worker(new URL('./physics.worker.js', import.meta.url), { type: 'module' });
    this._worker.onmessage = (e) => this._onMessage(e.data);

    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      this._worker.postMessage({
        type: 'init',
        gravity: opts.gravity || PHYSICS.gravity,
        fixedDt: opts.fixedDt || PHYSICS.fixedDt,
        maxBodies: this._maxBodies,
        maxSubSteps: PHYSICS.maxSubSteps
      });
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._ready = true;
        if (this._pendingResolve) {
          this._pendingResolve(this);
          this._pendingResolve = null;
        }
        break;
      case 'frame':
        this._ingestFrame(msg);
        break;
      default:
        break;
    }
  }

  /** Consume a transferred physics frame and recycle its buffers. */
  _ingestFrame(msg) {
    const tf = msg.transforms;
    const cf = msg.contacts;

    // Promote current -> previous, then copy the newest into current.
    const swap = this._prev;
    this._prev = this._cur;
    this._cur = swap;
    this._prevCount = this._curCount;
    this._prevTime = this._curTime;
    const swapIdx = this._prevIndex;
    this._prevIndex = this._curIndex;
    this._curIndex = swapIdx;

    const count = msg.tCount;
    this._curCount = count;
    this._curTime = performance.now();
    const n = count * TRANSFORM_STRIDE;
    for (let i = 0; i < n; i++) this._cur[i] = tf[i];

    this._curIndex.clear();
    for (let i = 0; i < count; i++) {
      const o = i * TRANSFORM_STRIDE;
      this._curIndex.set(this._cur[o], o);
    }

    // Append contacts to the main-side accumulator (drained on consume).
    const cn = msg.cCount;
    const cap = this._contacts.length / CONTACT_STRIDE;
    for (let i = 0; i < cn; i++) {
      if (this._contactCount >= cap) break;
      const src = i * CONTACT_STRIDE;
      const dst = this._contactCount * CONTACT_STRIDE;
      for (let k = 0; k < CONTACT_STRIDE; k++) this._contacts[dst + k] = cf[src + k];
      this._contactCount++;
    }

    // Return the buffers to the worker pool.
    this._worker.postMessage({ type: 'recycle', transforms: tf, contacts: cf }, [tf.buffer, cf.buffer]);
  }

  /* ---------------------------------------------------------------- *
   * Body lifecycle. Ids are allocated synchronously.
   * ---------------------------------------------------------------- */

  /**
   * @param {object} desc body descriptor (see the task brief for the schema)
   * @returns {number} the new body id
   */
  addBody(desc) {
    const id = this._nextId++;
    desc.id = id;
    if (desc.userData) this._userData.set(id, desc.userData);
    this._live.add(id);
    this.bodyCount = this._live.size;
    this._commands.push(['add', desc]);
    return id;
  }

  removeBody(id) {
    if (!this._live.has(id)) return;
    this._live.delete(id);
    this._userData.delete(id);
    this._bindings.delete(id);
    this.bodyCount = this._live.size;
    this._commands.push(['remove', id]);
  }

  /** @param {number} id @param {THREE.Object3D} object3D */
  bind(id, object3D) {
    this._bindings.set(id, object3D);
  }

  unbind(id) {
    this._bindings.delete(id);
  }

  setLinearVelocity(id, v) {
    this._commands.push(['linvel', id, v[0], v[1], v[2]]);
  }

  setAngularVelocity(id, v) {
    this._commands.push(['angvel', id, v[0], v[1], v[2]]);
  }

  /** @param {number} id @param {number[]} v impulse @param {number[]} [point] world point */
  applyImpulse(id, v, point) {
    if (point) this._commands.push(['impulse', id, v[0], v[1], v[2], point[0], point[1], point[2]]);
    else this._commands.push(['impulse', id, v[0], v[1], v[2]]);
  }

  setKinematicRotation(id, q) {
    this._commands.push(['kinRot', id, q[0], q[1], q[2], q[3]]);
  }

  setKinematicPosition(id, p) {
    this._commands.push(['kinPos', id, p[0], p[1], p[2]]);
  }

  setEnabled(id, on) {
    this._commands.push(['enabled', id, !!on]);
  }

  /** Swap a body's colliders after a slice. @param {number} id @param {object} shapeDesc */
  replaceShape(id, shapeDesc) {
    this._commands.push(['replaceShape', id, shapeDesc]);
  }

  /** @param {number} id @returns {object|undefined} the main-side userData */
  getUserData(id) {
    return this._userData.get(id);
  }

  /* ---------------------------------------------------------------- *
   * Per-frame integration with the worker.
   * ---------------------------------------------------------------- */

  /** Flush queued commands to the worker. Called once per render frame. */
  beginFrame(_dt) {
    if (!this._worker) return;
    if (this._commands.length) {
      this._worker.postMessage({ type: 'commands', list: this._commands });
      this._commands = [];
    }
  }

  /**
   * Write interpolated transforms into every bound Object3D. Interpolation
   * runs one snapshot interval behind the newest data so motion is smooth; if
   * a body only exists in the newest snapshot it is applied directly.
   */
  applyTransforms() {
    if (this._curCount === 0 && this._prevCount === 0) return;
    const interval = this._curTime - this._prevTime;
    let alpha = 1;
    if (interval > 0) {
      const renderTime = performance.now() - interval;
      alpha = (renderTime - this._prevTime) / interval;
      if (alpha < 0) alpha = 0;
      else if (alpha > 1) alpha = 1;
    }

    this._bindings.forEach((obj, id) => {
      const co = this._curIndex.get(id);
      if (co === undefined) return;
      const cur = this._cur;
      const po = this._prevIndex.get(id);
      if (po === undefined || alpha >= 1) {
        obj.position.set(cur[co + 1], cur[co + 2], cur[co + 3]);
        obj.quaternion.set(cur[co + 4], cur[co + 5], cur[co + 6], cur[co + 7]);
        return;
      }
      const prev = this._prev;
      obj.position.set(
        prev[po + 1] + (cur[co + 1] - prev[po + 1]) * alpha,
        prev[po + 2] + (cur[co + 2] - prev[po + 2]) * alpha,
        prev[po + 3] + (cur[co + 3] - prev[po + 3]) * alpha
      );
      this._qa.set(prev[po + 4], prev[po + 5], prev[po + 6], prev[po + 7]);
      this._qb.set(cur[co + 4], cur[co + 5], cur[co + 6], cur[co + 7]);
      this._qa.slerp(this._qb, alpha);
      obj.quaternion.copy(this._qa);
    });
  }

  /**
   * Drain accumulated contact events.
   * @param {(idA:number, idB:number, px:number, py:number, pz:number,
   *   nx:number, ny:number, nz:number, impulse:number, relSpeed:number)=>void} cb
   */
  consumeContacts(cb) {
    const arr = this._contacts;
    const count = this._contactCount;
    for (let i = 0; i < count; i++) {
      const o = i * CONTACT_STRIDE;
      cb(arr[o], arr[o + 1], arr[o + 2], arr[o + 3], arr[o + 4], arr[o + 5], arr[o + 6], arr[o + 7], arr[o + 8], arr[o + 9]);
    }
    this._contactCount = 0;
  }

  /**
   * Best-effort synchronous body state from the interpolation snapshots.
   * Linear / angular velocity are finite-differenced from the last two frames.
   * @param {number} id
   * @returns {{position:number[], quaternion:number[], linvel:number[], angvel:number[]}|null}
   */
  getBodyState(id) {
    const co = this._curIndex.get(id);
    if (co === undefined) return null;
    const cur = this._cur;
    const position = [cur[co + 1], cur[co + 2], cur[co + 3]];
    const quaternion = [cur[co + 4], cur[co + 5], cur[co + 6], cur[co + 7]];
    let linvel = [0, 0, 0];
    let angvel = [0, 0, 0];
    const po = this._prevIndex.get(id);
    const dt = (this._curTime - this._prevTime) / 1000;
    if (po !== undefined && dt > 1e-4) {
      const prev = this._prev;
      const inv = 1 / dt;
      linvel = [
        (cur[co + 1] - prev[po + 1]) * inv,
        (cur[co + 2] - prev[po + 2]) * inv,
        (cur[co + 3] - prev[po + 3]) * inv
      ];
      // Angular velocity from the delta quaternion (cur * prev^-1).
      this._qa.set(prev[po + 4], prev[po + 5], prev[po + 6], prev[po + 7]);
      this._qb.set(cur[co + 4], cur[co + 5], cur[co + 6], cur[co + 7]);
      this._qa.invert().premultiply(this._qb);
      let angle = 2 * Math.acos(Math.min(1, Math.abs(this._qa.w)));
      const s = Math.sqrt(Math.max(0, 1 - this._qa.w * this._qa.w));
      if (s > 1e-4 && angle > 1e-4) {
        angle *= inv;
        const sign = this._qa.w < 0 ? -1 : 1;
        angvel = [(this._qa.x / s) * angle * sign, (this._qa.y / s) * angle * sign, (this._qa.z / s) * angle * sign];
      }
    }
    return { position, quaternion, linvel, angvel };
  }
}
