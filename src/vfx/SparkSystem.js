import * as THREE from 'three';

import { LAYER, SHREDDER, QUALITY_PRESETS } from '../core/Constants.js';

/**
 * GPU-instanced incandescent grinding sparks.
 *
 * Every spark is a single quad instance that is simulated **entirely in the
 * vertex shader**: analytic ballistic motion with linear air drag, analytic
 * reflection ("folding") against a handful of world planes so sparks ricochet
 * off the floor / conveyor / side plates, velocity-stretched streaks and a
 * black-body colour ramp (white-hot -> yellow -> orange -> dull red -> out).
 *
 * The GPU buffers are allocated **once** at the maximum quality budget and
 * never resized; {@link SparkSystem#setActiveCap} only changes a soft limit so
 * quality changes never reallocate or hitch mid-shred. Emission uses a
 * lock-free ring allocator — the oldest sparks are transparently overwritten,
 * so there is no per-frame allocation and no free-list bookkeeping.
 */

const HARD_MAX = Math.max(
  ...Object.values(QUALITY_PRESETS).map((p) => p.maxSparks || 0)
);

const GRAVITY = 9.82;
const MAX_PLANES = 6;

/* Module-scope scratch — never allocate inside hot paths. */
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const VERT = /* glsl */ `
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

attribute vec3 position;
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute float aBirth;
attribute float aLife;
attribute float aSeed;
attribute float aTemp;
attribute vec3 aTint;
attribute float aGravity;
attribute float aSize;

uniform float uTime;
uniform float uDrag;
uniform float uStretch;
uniform vec3 uCameraPos;

uniform int uPlaneCount;
uniform vec3 uPlaneN[${MAX_PLANES}];
uniform vec3 uPlaneP[${MAX_PLANES}];
uniform vec3 uPlaneT1[${MAX_PLANES}];
uniform vec3 uPlaneT2[${MAX_PLANES}];
uniform vec2 uPlaneExt[${MAX_PLANES}];
uniform float uPlaneRest[${MAX_PLANES}];

varying float vAlpha;
varying vec3 vColor;
varying vec2 vUv;

// Physically-motivated black-body-ish ramp from a normalised temperature.
vec3 blackBody(float h) {
  h = clamp(h, 0.0, 1.0);
  vec3 red = vec3(0.6, 0.02, 0.0);
  vec3 orange = vec3(1.0, 0.32, 0.02);
  vec3 yellow = vec3(1.0, 0.78, 0.28);
  vec3 white = vec3(1.0, 0.98, 0.92);
  vec3 c = mix(red, orange, smoothstep(0.0, 0.35, h));
  c = mix(c, yellow, smoothstep(0.3, 0.7, h));
  c = mix(c, white, smoothstep(0.68, 1.0, h));
  return c;
}

void main() {
  float t = uTime - aBirth;
  float alive = step(0.0, t) * step(t, aLife);
  vUv = position.xy + 0.5;

  // Analytic projectile with linear drag:  m dv/dt = -k v + g
  float k = max(uDrag, 0.0001);
  vec3 g = vec3(0.0, -${GRAVITY.toFixed(2)} * aGravity, 0.0);
  float ek = exp(-k * t);
  vec3 vt = (aVel + g / k) * ek - g / k;
  vec3 pt = aOrigin + (aVel + g / k) * (1.0 - ek) / k - (g / k) * t;

  // Fold the trajectory against world planes so sparks ricochet.
  for (int i = 0; i < ${MAX_PLANES}; i++) {
    if (i >= uPlaneCount) break;
    vec3 n = uPlaneN[i];
    vec3 rel = pt - uPlaneP[i];
    float d = dot(rel, n);
    if (d < 0.0) {
      bool inside = true;
      vec2 ext = uPlaneExt[i];
      if (ext.x > 0.0) {
        float u = dot(rel, uPlaneT1[i]);
        float v = dot(rel, uPlaneT2[i]);
        inside = (abs(u) <= ext.x) && (abs(v) <= ext.y);
      }
      if (inside) {
        float rest = uPlaneRest[i];
        pt -= (1.0 + rest) * d * n;
        float vn = dot(vt, n);
        if (vn < 0.0) vt -= (1.0 + rest) * vn * n;
      }
    }
  }

  float lifeFrac = clamp(t / max(aLife, 0.0001), 0.0, 1.0);
  float speed = length(vt);

  // Orient a camera-facing quad along the velocity for a motion-blur streak.
  vec3 fwd = speed > 1e-4 ? vt / speed : vec3(0.0, 1.0, 0.0);
  vec3 toCam = normalize(uCameraPos - pt);
  vec3 side = cross(fwd, toCam);
  float sideLen = length(side);
  side = sideLen > 1e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);

  float streak = aSize * (0.35 + speed * uStretch);
  streak = min(streak, aSize * 24.0);
  float width = aSize * (0.6 + 0.4 * (1.0 - lifeFrac));

  // position.x in [0,1] runs from the hot head backward along the trail.
  vec3 world = pt - fwd * (position.x * streak) + side * (position.y * width);

  // Cooling: temperature drops along life and slightly with a per-spark seed.
  float temp = aTemp * (1.0 - lifeFrac * lifeFrac) - 0.08 * aSeed;
  vColor = blackBody(temp) * aTint * (1.2 + 1.6 * temp);

  float fadeIn = smoothstep(0.0, 0.06, lifeFrac);
  float fadeOut = 1.0 - smoothstep(0.55, 1.0, lifeFrac);
  vAlpha = alive * fadeIn * fadeOut;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  // Collapse dead instances to a degenerate point (cheap cull).
  if (alive < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying float vAlpha;
varying vec3 vColor;
varying vec2 vUv;

void main() {
  // Soft across the width, bright at the leading head.
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float along = vUv.x;
  float head = smoothstep(0.0, 0.4, 1.0 - along);
  float core = pow(across, 1.5);
  float a = vAlpha * core * (0.35 + 0.65 * head);
  vec3 c = vColor * (0.6 + 0.8 * head);
  gl_FragColor = vec4(c, a);
}
`;

export class SparkSystem {
  /**
   * @param {object} opts
   * @param {THREE.Scene}  opts.scene
   * @param {number}       opts.activeCap  initial soft cap on live sparks
   */
  constructor({ scene, activeCap = 16000 }) {
    this.scene = scene;
    this.capacity = HARD_MAX;
    this._activeCap = Math.min(activeCap, this.capacity);
    this.enabled = true;

    this._time = 0;
    this._lastDt = 1 / 60;
    this._head = 0; // monotonic write cursor
    this._tail = 0; // monotonic oldest-live cursor
    this._uploadHead = 0; // head at the last GPU upload
    this._streamAccum = 0;

    this._buildGeometry();
    this._buildMesh();
    this._buildPlanes();
  }

  /* ----------------------------------------------------------------- */
  _buildGeometry() {
    const cap = this.capacity;
    const geo = new THREE.InstancedBufferGeometry();

    // Base quad: x in [0,1] (along trail), y in [-0.5,0.5] (across width).
    const quad = new Float32Array([
      0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const mk = (name, size) => {
      const arr = new Float32Array(cap * size);
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      return { arr, attr };
    };

    this._aOrigin = mk('aOrigin', 3);
    this._aVel = mk('aVel', 3);
    this._aBirth = mk('aBirth', 1);
    this._aLife = mk('aLife', 1);
    this._aSeed = mk('aSeed', 1);
    this._aTemp = mk('aTemp', 1);
    this._aTint = mk('aTint', 3);
    this._aGravity = mk('aGravity', 1);
    this._aSize = mk('aSize', 1);

    // Flat list of instanced attributes for batched partial uploads.
    this._attrs = [
      this._aOrigin.attr, this._aVel.attr, this._aBirth.attr, this._aLife.attr,
      this._aSeed.attr, this._aTemp.attr, this._aTint.attr, this._aGravity.attr,
      this._aSize.attr
    ];

    // Birth everything far in the past so nothing renders until emitted.
    this._aBirth.arr.fill(-1000);
    this._aLife.arr.fill(0.001);

    geo.instanceCount = 0;
    geo.frustumCulled = false;
    this.geometry = geo;
  }

  _buildMesh() {
    this.material = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uDrag: { value: 1.6 },
        uStretch: { value: 0.018 },
        uCameraPos: { value: new THREE.Vector3() },
        uPlaneCount: { value: 0 },
        uPlaneN: { value: [] },
        uPlaneP: { value: [] },
        uPlaneT1: { value: [] },
        uPlaneT2: { value: [] },
        uPlaneExt: { value: [] },
        uPlaneRest: { value: [] }
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(LAYER.BLOOM);
    this.mesh.renderOrder = 10;
    this.scene.add(this.mesh);
  }

  _buildPlanes() {
    const c = SHREDDER.conveyor;
    /** @type {Array<{n:number[],p:number[],t1:number[],t2:number[],ext:number[],rest:number}>} */
    const planes = [
      // Factory floor — infinite.
      { n: [0, 1, 0], p: [0, 0, 0], t1: [1, 0, 0], t2: [0, 0, 1], ext: [-1, -1], rest: 0.42 },
      // Conveyor deck top — bounded rectangle.
      {
        n: [0, 1, 0],
        p: [-0.35, c.height, 0.6],
        t1: [1, 0, 0],
        t2: [0, 0, 1],
        ext: [c.width * 0.5, c.length * 0.5],
        rest: 0.3
      },
      // Machine side plates — bounded vertical planes near the throat.
      {
        n: [1, 0, 0],
        p: [-SHREDDER.hopperWidth * 0.5, 0, 0],
        t1: [0, 1, 0],
        t2: [0, 0, 1],
        ext: [SHREDDER.hopperTop, SHREDDER.chamberDepth * 0.5],
        rest: 0.35
      },
      {
        n: [-1, 0, 0],
        p: [SHREDDER.hopperWidth * 0.5, 0, 0],
        t1: [0, 1, 0],
        t2: [0, 0, 1],
        ext: [SHREDDER.hopperTop, SHREDDER.chamberDepth * 0.5],
        rest: 0.35
      }
    ];

    const u = this.material.uniforms;
    u.uPlaneCount.value = Math.min(planes.length, MAX_PLANES);

    // Uniform arrays must be fully populated to MAX_PLANES or THREE's uniform
    // flattener dereferences undefined slots. Pad unused planes with harmless
    // placeholders; uPlaneCount keeps the shader from ever reading them.
    const N = [];
    const P = [];
    const T1 = [];
    const T2 = [];
    const EXT = [];
    const REST = [];
    for (let i = 0; i < MAX_PLANES; i++) {
      const pl = planes[i];
      if (pl) {
        N.push(new THREE.Vector3().fromArray(pl.n));
        P.push(new THREE.Vector3().fromArray(pl.p));
        T1.push(new THREE.Vector3().fromArray(pl.t1));
        T2.push(new THREE.Vector3().fromArray(pl.t2));
        EXT.push(new THREE.Vector2(pl.ext[0], pl.ext[1]));
        REST.push(pl.rest);
      } else {
        N.push(new THREE.Vector3(0, 1, 0));
        P.push(new THREE.Vector3(0, -1000, 0));
        T1.push(new THREE.Vector3(1, 0, 0));
        T2.push(new THREE.Vector3(0, 0, 1));
        EXT.push(new THREE.Vector2(-1, -1));
        REST.push(0);
      }
    }
    u.uPlaneN.value = N;
    u.uPlaneP.value = P;
    u.uPlaneT1.value = T1;
    u.uPlaneT2.value = T2;
    u.uPlaneExt.value = EXT;
    u.uPlaneRest.value = REST;
  }

  /* ----------------------------------------------------------------- */

  /** @returns {number} number of currently live sparks. */
  get liveCount() {
    return this._head - this._tail;
  }

  /** Soft-limit the pool without reallocating GPU buffers. */
  setActiveCap(cap) {
    this._activeCap = Math.max(0, Math.min(cap | 0, this.capacity));
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.mesh.visible = this.enabled;
  }

  /**
   * Emit a burst of sparks.
   * @param {THREE.Vector3} position spawn origin (world)
   * @param {THREE.Vector3} direction primary spray direction
   * @param {number} count
   * @param {object} [opts]
   * @param {number} [opts.speed=7]
   * @param {number} [opts.spread=0.5] radians of cone half-angle
   * @param {number} [opts.temperature=1] 0..1 starting incandescence
   * @param {THREE.Color|number} [opts.color=0xffffff] metal tint
   * @param {number} [opts.life=0.9] seconds
   * @param {number} [opts.gravityScale=1]
   * @param {number} [opts.size=0.02]
   * @param {number} [opts.fork=0.18] fraction of sparks that fork into children
   */
  emitBurst(position, direction, count, opts = {}) {
    if (!this.enabled || count <= 0) return;

    const speed = opts.speed ?? 7;
    const spread = opts.spread ?? 0.5;
    const temperature = opts.temperature ?? 1;
    const life = opts.life ?? 0.9;
    const gravityScale = opts.gravityScale ?? 1;
    const size = opts.size ?? 0.02;
    const fork = opts.fork ?? 0.18;

    let r = 0;
    let g = 0;
    let b = 0;
    if (opts.color != null) {
      const col = opts.color instanceof THREE.Color ? opts.color : _col(opts.color);
      r = col.r;
      g = col.g;
      b = col.b;
    } else {
      r = g = b = 1;
    }

    _dir.copy(direction);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, -1, 0);
    _dir.normalize();

    const n = Math.min(count | 0, this._activeCap);
    for (let i = 0; i < n; i++) {
      // Cone-spread direction biased along `direction`.
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * spread;
      _tmp.copy(_up);
      if (Math.abs(_dir.dot(_up)) > 0.95) _tmp.set(1, 0, 0);
      const t1 = _scratchA.copy(_tmp).cross(_dir).normalize();
      const t2 = _scratchB.copy(_dir).cross(t1).normalize();
      const sinS = Math.sin(s);
      _scratchC
        .copy(_dir)
        .multiplyScalar(Math.cos(s))
        .addScaledVector(t1, sinS * Math.cos(a))
        .addScaledVector(t2, sinS * Math.sin(a));

      const spd = speed * (0.55 + Math.random() * 0.75);
      const vx = _scratchC.x * spd;
      const vy = _scratchC.y * spd;
      const vz = _scratchC.z * spd;
      const lf = life * (0.6 + Math.random() * 0.7);
      const tp = Math.min(1, temperature * (0.75 + Math.random() * 0.4));

      const idx = this._alloc();
      this._write(idx, position.x, position.y, position.z, vx, vy, vz, lf, tp, r, g, b, gravityScale, size * (0.7 + Math.random() * 0.9));

      // Carbon burst: fork a fraction of sparks into short-lived children.
      if (fork > 0 && Math.random() < fork) {
        const kids = 3 + ((Math.random() * 4) | 0);
        const forkT = lf * (0.35 + Math.random() * 0.4);
        // Predict parent position/velocity at the fork instant (drag+gravity).
        this._ballistic(position.x, position.y, position.z, vx, vy, vz, gravityScale, forkT);
        for (let j = 0; j < kids && this.liveCount < this._activeCap; j++) {
          const jt = 4 + Math.random() * 6;
          const kvx = _pv.x * 0.4 + (Math.random() - 0.5) * jt;
          const kvy = _pv.y * 0.4 + (Math.random() - 0.5) * jt + 1.5;
          const kvz = _pv.z * 0.4 + (Math.random() - 0.5) * jt;
          const kIdx = this._alloc();
          // Delay the child's birth so it appears at the fork instant.
          this._write(
            kIdx,
            _pp.x,
            _pp.y,
            _pp.z,
            kvx,
            kvy,
            kvz,
            lf * 0.5 * (0.6 + Math.random() * 0.6),
            Math.min(1, tp + 0.15),
            r,
            g,
            b,
            gravityScale,
            size * 0.6,
            this._time + forkT
          );
        }
      }
    }
  }

  /**
   * Continuous grinding contact stream. Uses the frame dt captured in update().
   * @param {THREE.Vector3} position
   * @param {THREE.Vector3} direction
   * @param {number} ratePerSecond
   * @param {object} [opts] same shape as {@link SparkSystem#emitBurst}
   */
  emitStream(position, direction, ratePerSecond, opts = {}) {
    if (!this.enabled) return;
    this._streamAccum += ratePerSecond * this._lastDt;
    const count = this._streamAccum | 0;
    if (count > 0) {
      this._streamAccum -= count;
      this.emitBurst(position, direction, count, opts);
    }
  }

  /* ----------------------------------------------------------------- */

  update(dt, camera) {
    this._lastDt = dt;
    this._time += dt;
    this.material.uniforms.uTime.value = this._time;
    if (camera) this.material.uniforms.uCameraPos.value.copy(camera.position);

    // Retire expired sparks (amortised, cheap) and advance the draw window.
    const life = this._aLife.arr;
    const birth = this._aBirth.arr;
    const cap = this.capacity;
    while (this._tail < this._head) {
      const i = this._tail % cap;
      if (birth[i] + life[i] <= this._time) this._tail++;
      else break;
    }
    this.geometry.instanceCount = Math.min(this._head, this.capacity);
    this._flush();
  }

  /* ----------------------------------------------------------------- */

  _alloc() {
    const cap = this.capacity;
    const idx = this._head % cap;
    this._head++;
    // Overwrite the oldest live spark if we lapped the ring.
    if (this._head - this._tail > cap) this._tail = this._head - cap;
    return idx;
  }

  _write(idx, ox, oy, oz, vx, vy, vz, life, temp, r, g, b, grav, size, birth) {
    this._aOrigin.arr[idx * 3] = ox;
    this._aOrigin.arr[idx * 3 + 1] = oy;
    this._aOrigin.arr[idx * 3 + 2] = oz;
    this._aVel.arr[idx * 3] = vx;
    this._aVel.arr[idx * 3 + 1] = vy;
    this._aVel.arr[idx * 3 + 2] = vz;
    this._aBirth.arr[idx] = birth ?? this._time;
    this._aLife.arr[idx] = life;
    this._aSeed.arr[idx] = Math.random();
    this._aTemp.arr[idx] = temp;
    this._aTint.arr[idx * 3] = r;
    this._aTint.arr[idx * 3 + 1] = g;
    this._aTint.arr[idx * 3 + 2] = b;
    this._aGravity.arr[idx] = grav;
    this._aSize.arr[idx] = size;
  }

  // Upload only the instance slots written since the last frame (partial
  // updateRange), or the whole buffer if the ring wrapped.
  _flush() {
    const cap = this.capacity;
    const from = this._uploadHead;
    const to = this._head;
    this._uploadHead = to;
    if (to <= from) return;

    const attrs = this._attrs;
    if (to - from >= cap) {
      for (let a = 0; a < attrs.length; a++) {
        attrs[a].clearUpdateRanges?.();
        attrs[a].needsUpdate = true;
      }
      return;
    }

    const start = from % cap;
    const end = (to - 1) % cap; // inclusive
    for (let a = 0; a < attrs.length; a++) {
      const attr = attrs[a];
      const s = attr.itemSize;
      attr.clearUpdateRanges?.();
      if (start <= end) {
        attr.addUpdateRange?.(start * s, (end - start + 1) * s);
      } else {
        attr.addUpdateRange?.(start * s, (cap - start) * s);
        attr.addUpdateRange?.(0, (end + 1) * s);
      }
      attr.needsUpdate = true;
    }
  }

  // JS mirror of the shader's analytic projectile, used to place fork children.
  _ballistic(ox, oy, oz, vx, vy, vz, grav, t) {
    const k = this.material.uniforms.uDrag.value;
    const gy = -GRAVITY * grav;
    const ek = Math.exp(-k * t);
    _pp.set(
      ox + (vx / k) * (1 - ek),
      oy + ((vy + gy / k) * (1 - ek)) / k - (gy / k) * t,
      oz + (vz / k) * (1 - ek)
    );
    _pv.set(
      vx * ek,
      (vy + gy / k) * ek - gy / k,
      vz * ek
    );
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* Extra module-scope scratch. */
const _scratchA = new THREE.Vector3();
const _scratchB = new THREE.Vector3();
const _scratchC = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _colCache = new THREE.Color();
function _col(hex) {
  return _colCache.set(hex);
}
