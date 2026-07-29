/**
 * CONTRACT (owned by the Physics sub-agent).
 * Main-thread proxy for the Rapier3D simulation running in a Web Worker.
 */
export class PhysicsClient {
  constructor() {
    this.bodyCount = 0;
    this._bindings = new Map();
    this._nextId = 1;
  }

  async init(_opts) { return this; }
  addBody(_desc) { this.bodyCount++; return this._nextId++; }
  removeBody(_id) { this.bodyCount = Math.max(0, this.bodyCount - 1); }
  bind(id, object3D) { this._bindings.set(id, object3D); }
  unbind(id) { this._bindings.delete(id); }
  setLinearVelocity(_id, _v) {}
  setAngularVelocity(_id, _v) {}
  applyImpulse(_id, _v, _point) {}
  setKinematicRotation(_id, _q) {}
  setEnabled(_id, _on) {}
  beginFrame(_dt) {}
  applyTransforms() {}
  consumeContacts(_cb) {}
  getBodyState(_id) { return null; }
}
