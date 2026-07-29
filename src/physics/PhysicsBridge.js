/**
 * PhysicsBridge — main-thread proxy for the Rapier worker.
 *
 * Owns body-id allocation, keeps a mesh<->body registry, applies the latest
 * transform snapshot to the scene graph and fans contact events out to
 * listeners (destruction, VFX, audio).
 *
 * Zero-GC on the hot path: snapshot buffers ping-pong between the threads.
 */
import * as THREE from 'three';

export class PhysicsBridge {
  constructor() {
    this.worker = new Worker(new URL('./physics.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);

    this.ready = false;
    this._readyPromise = new Promise((res) => { this._readyResolve = res; });

    this._nextId = 1;
    /** @type {Map<number, {object3D: THREE.Object3D, meta: object}>} */
    this.registry = new Map();

    this.onContacts = null;   // (Float32Array view, count, stride) => void
    this.onRemoved = null;    // (ids[]) => void

    this.shredderAngle = 0;
    this.rpm = 0;
    this.load = 0;
    this.bodyCount = 0;
    this.stepMs = 0;

    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._pending = null;
  }

  async init(options = {}) {
    this.worker.postMessage({
      type: 'init',
      gravity: options.gravity || [0, -9.81, 0],
      fixedDt: options.fixedDt || 1 / 60,
      maxSubSteps: options.maxSubSteps || 3,
    });
    await this._readyPromise;
    return this;
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this._readyResolve?.();
        break;
      case 'snapshot':
        this._pending = msg;
        break;
      case 'removed':
        this.onRemoved?.(msg.ids);
        for (const id of msg.ids) this.registry.delete(id);
        break;
      default: break;
    }
  }

  /** Apply the newest snapshot to the scene graph. Call once per render frame. */
  sync(dt) {
    const msg = this._pending;
    if (!msg) return;
    this._pending = null;

    const view = new Float32Array(msg.buffer, 0, msg.count * msg.stride);
    const stride = msg.stride;
    // Critically damped smoothing hides the physics/render rate mismatch.
    const alpha = 1 - Math.exp(-dt * 42);

    for (let i = 0; i < msg.count; i++) {
      const o = i * stride;
      const id = view[o];
      const entry = this.registry.get(id);
      if (!entry) continue;
      const obj = entry.object3D;
      this._pos.set(view[o + 1], view[o + 2], view[o + 3]);
      this._quat.set(view[o + 4], view[o + 5], view[o + 6], view[o + 7]);

      if (entry.warm) {
        obj.position.lerp(this._pos, alpha);
        obj.quaternion.slerp(this._quat, alpha);
      } else {
        obj.position.copy(this._pos);
        obj.quaternion.copy(this._quat);
        entry.warm = true;
      }
      entry.speed = Math.hypot(view[o + 8], view[o + 9], view[o + 10]);
      entry.vel.set(view[o + 8], view[o + 9], view[o + 10]);
      entry.sleeping = view[o + 11] > 0.5;
      obj.updateMatrix();
    }

    if (msg.contacts && msg.contactCount > 0 && this.onContacts) {
      const cview = new Float32Array(msg.contacts, 0, msg.contactCount * msg.contactStride);
      this.onContacts(cview, msg.contactCount, msg.contactStride);
    }

    this.shredderAngle = msg.shredderAngle;
    this.rpm = msg.rpm;
    this.load = msg.load;
    this.bodyCount = msg.bodies;
    this.stepMs = msg.stepMs;

    // Hand the buffers back so the worker can reuse them.
    const transfer = [msg.buffer];
    if (msg.contacts) transfer.push(msg.contacts);
    this.worker.postMessage({ type: 'recycle', buffer: msg.buffer, contacts: msg.contacts }, transfer);
  }

  allocId() { return this._nextId++; }

  addBody(object3D, shapes, opts = {}) {
    const id = opts.id ?? this.allocId();
    this.registry.set(id, {
      object3D, meta: opts.meta || {}, warm: false,
      speed: 0, sleeping: false, vel: new THREE.Vector3(),
    });
    const p = object3D.position;
    const q = object3D.quaternion;
    this.worker.postMessage({
      type: 'addBody',
      id,
      kind: opts.kind || 'dynamic',
      shapes,
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
      density: opts.density ?? 7800,
      friction: opts.friction ?? 0.62,
      restitution: opts.restitution ?? 0.08,
      linearDamping: opts.linearDamping ?? 0.06,
      angularDamping: opts.angularDamping ?? 0.14,
      ccd: opts.ccd ?? false,
      linvel: opts.linvel,
      angvel: opts.angvel,
    });
    return id;
  }

  removeBody(id) {
    this.registry.delete(id);
    this.worker.postMessage({ type: 'removeBody', id });
  }

  removeBodies(ids) {
    for (const id of ids) this.registry.delete(id);
    this.worker.postMessage({ type: 'removeBodies', ids });
  }

  clearDynamic() {
    this.worker.postMessage({ type: 'clearDynamic' });
  }

  buildStatic(items) { this.worker.postMessage({ type: 'buildStatic', items }); }

  buildShredder(cfg) { this.worker.postMessage({ type: 'buildShredder', ...cfg }); }

  setShredder(state) { this.worker.postMessage({ type: 'setShredder', ...state }); }

  setConveyor(state) { this.worker.postMessage({ type: 'setConveyor', ...state }); }

  applyImpulse(id, impulse, point) {
    this.worker.postMessage({ type: 'applyImpulse', id, impulse, point });
  }

  getEntry(id) { return this.registry.get(id); }

  pause() { this.worker.postMessage({ type: 'pause' }); }
  resume() { this.worker.postMessage({ type: 'resume' }); }

  dispose() {
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
    this.registry.clear();
  }
}
