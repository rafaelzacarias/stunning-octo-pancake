import * as THREE from 'three';

import { SHREDDER } from '../core/Constants.js';

/**
 * Tiny flying metal bits.
 *
 * A single {@link THREE.InstancedMesh} of low-poly angular chunks, simulated on
 * the CPU with real rotation, gravity, air drag and damped floor / wall bounces
 * so the pieces clatter and settle. These are purely visual (no rigid-body
 * cost). The live count is hard-capped and the oldest piece is retired when the
 * pool is full. Each bounce can optionally emit a faint spark.
 */

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _sparkPos = new THREE.Vector3();
const _sparkDir = new THREE.Vector3();

const GRAVITY = 9.82;
const FLOOR_Y = 0;

export class ShrapnelSystem {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {number} [opts.capacity=256]
   * @param {(pos:THREE.Vector3, dir:THREE.Vector3)=>void} [opts.onBounce]
   */
  constructor({ scene, capacity = 256, onBounce = null }) {
    this.scene = scene;
    this.capacity = capacity;
    this.onBounce = onBounce;
    this.enabled = true;

    this._head = 0; // monotonic allocation cursor
    this._live = 0;

    // Per-instance state (structure-of-arrays, no per-frame allocation).
    this._px = new Float32Array(capacity);
    this._py = new Float32Array(capacity);
    this._pz = new Float32Array(capacity);
    this._vx = new Float32Array(capacity);
    this._vy = new Float32Array(capacity);
    this._vz = new Float32Array(capacity);
    this._qx = new Float32Array(capacity);
    this._qy = new Float32Array(capacity);
    this._qz = new Float32Array(capacity);
    this._qw = new Float32Array(capacity);
    this._wx = new Float32Array(capacity); // angular velocity
    this._wy = new Float32Array(capacity);
    this._wz = new Float32Array(capacity);
    this._scale = new Float32Array(capacity);
    this._age = new Float32Array(capacity);
    this._life = new Float32Array(capacity);
    this._active = new Uint8Array(capacity);
    this._rest = new Float32Array(capacity);

    this._build();
  }

  _build() {
    // A small irregular chunk: an icosahedron squashed on random axes gives
    // an angular, faceted silhouette that catches specular highlights.
    const geo = new THREE.IcosahedronGeometry(0.018, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (0.7 + Math.random() * 0.6),
        pos.getY(i) * (0.5 + Math.random() * 0.7),
        pos.getZ(i) * (0.7 + Math.random() * 0.6)
      );
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b6f75,
      metalness: 1.0,
      roughness: 0.45,
      flatShading: true
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = this.capacity;

    // Park every instance offscreen until spawned.
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.scene.add(this.mesh);
  }

  get liveCount() {
    return this._live;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.mesh.visible = this.enabled;
  }

  /**
   * Spawn a spray of shrapnel bits.
   * @param {THREE.Vector3} position
   * @param {THREE.Vector3} direction primary launch direction
   * @param {number} count
   * @param {object} [opts]
   * @param {number} [opts.speed=4]
   * @param {number} [opts.spread=0.7] radians
   * @param {number} [opts.life=3.5] seconds
   * @param {number} [opts.size=1] scale multiplier
   */
  emit(position, direction, count, opts = {}) {
    if (!this.enabled || count <= 0) return;
    const speed = opts.speed ?? 4;
    const spread = opts.spread ?? 0.7;
    const life = opts.life ?? 3.5;
    const size = opts.size ?? 1;

    _sparkDir.copy(direction);
    if (_sparkDir.lengthSq() < 1e-8) _sparkDir.set(0, 1, 0);
    _sparkDir.normalize();

    const n = count | 0;
    for (let i = 0; i < n; i++) {
      const idx = this._alloc();
      const spd = speed * (0.5 + Math.random());
      this._px[idx] = position.x;
      this._py[idx] = position.y;
      this._pz[idx] = position.z;
      this._vx[idx] = _sparkDir.x * spd + (Math.random() - 0.5) * spread * spd;
      this._vy[idx] = _sparkDir.y * spd + (Math.random() - 0.5) * spread * spd + 1.0;
      this._vz[idx] = _sparkDir.z * spd + (Math.random() - 0.5) * spread * spd;
      this._qx[idx] = 0;
      this._qy[idx] = 0;
      this._qz[idx] = 0;
      this._qw[idx] = 1;
      this._wx[idx] = (Math.random() - 0.5) * 40;
      this._wy[idx] = (Math.random() - 0.5) * 40;
      this._wz[idx] = (Math.random() - 0.5) * 40;
      this._scale[idx] = size * (0.5 + Math.random() * 1.1);
      this._age[idx] = 0;
      this._life[idx] = life * (0.7 + Math.random() * 0.6);
      this._rest[idx] = 0.35 + Math.random() * 0.2;
      if (this._active[idx] === 0) {
        this._active[idx] = 1;
        this._live++;
      }
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const drag = Math.exp(-0.9 * dt);
    const wallX = SHREDDER.hopperWidth * 0.5 + 0.3;
    const wallZ = SHREDDER.chamberDepth * 0.5 + 0.6;
    const im = this.mesh.instanceMatrix;

    for (let i = 0; i < this.capacity; i++) {
      if (this._active[i] === 0) continue;

      this._age[i] += dt;
      if (this._age[i] >= this._life[i]) {
        this._retire(i);
        continue;
      }

      // Integrate linear motion with gravity + drag.
      this._vy[i] -= GRAVITY * dt;
      this._vx[i] *= drag;
      this._vy[i] *= drag;
      this._vz[i] *= drag;
      this._px[i] += this._vx[i] * dt;
      this._py[i] += this._vy[i] * dt;
      this._pz[i] += this._vz[i] * dt;

      let bounced = false;
      // Floor.
      if (this._py[i] < FLOOR_Y) {
        this._py[i] = FLOOR_Y;
        if (this._vy[i] < 0) {
          this._vy[i] = -this._vy[i] * this._rest[i];
          this._vx[i] *= 0.7;
          this._vz[i] *= 0.7;
          bounced = Math.abs(this._vy[i]) > 0.4;
        }
      }
      // Side walls.
      if (this._px[i] < -wallX) { this._px[i] = -wallX; this._vx[i] = Math.abs(this._vx[i]) * this._rest[i]; bounced = true; }
      else if (this._px[i] > wallX) { this._px[i] = wallX; this._vx[i] = -Math.abs(this._vx[i]) * this._rest[i]; bounced = true; }
      if (this._pz[i] < -wallZ) { this._pz[i] = -wallZ; this._vz[i] = Math.abs(this._vz[i]) * this._rest[i]; bounced = true; }
      else if (this._pz[i] > wallZ) { this._pz[i] = wallZ; this._vz[i] = -Math.abs(this._vz[i]) * this._rest[i]; bounced = true; }

      if (bounced) {
        // Bleed angular momentum on impact and optionally spit a spark.
        this._wx[i] *= 0.6;
        this._wy[i] *= 0.6;
        this._wz[i] *= 0.6;
        if (this.onBounce) {
          _sparkPos.set(this._px[i], this._py[i], this._pz[i]);
          _sparkDir.set(this._vx[i], Math.abs(this._vy[i]) + 0.5, this._vz[i]);
          this.onBounce(_sparkPos, _sparkDir);
        }
      }

      // Integrate orientation from angular velocity.
      _q.set(this._qx[i], this._qy[i], this._qz[i], this._qw[i]);
      _dq.set(this._wx[i] * dt * 0.5, this._wy[i] * dt * 0.5, this._wz[i] * dt * 0.5, 0);
      _dq.multiply(_q);
      _q.x += _dq.x;
      _q.y += _dq.y;
      _q.z += _dq.z;
      _q.w += _dq.w;
      _q.normalize();
      this._qx[i] = _q.x;
      this._qy[i] = _q.y;
      this._qz[i] = _q.z;
      this._qw[i] = _q.w;

      // Settle: once resting and slow, freeze angular jitter.
      const restingSpeed = this._vx[i] * this._vx[i] + this._vy[i] * this._vy[i] + this._vz[i] * this._vz[i];
      if (this._py[i] <= FLOOR_Y + 1e-3 && restingSpeed < 0.02) {
        this._wx[i] *= 0.5;
        this._wy[i] *= 0.5;
        this._wz[i] *= 0.5;
      }

      _p.set(this._px[i], this._py[i], this._pz[i]);
      _s.setScalar(this._scale[i]);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }

    im.needsUpdate = true;
  }

  _alloc() {
    // Round-robin; overwrite the oldest live slot when full.
    const idx = this._head % this.capacity;
    this._head++;
    return idx;
  }

  _retire(i) {
    this._active[i] = 0;
    this._live = Math.max(0, this._live - 1);
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _m);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
