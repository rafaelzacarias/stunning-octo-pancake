import * as THREE from 'three';

import { QUALITY_PRESETS } from '../core/Constants.js';

/**
 * Metallic dust and smoke.
 *
 * Camera-facing, alpha-blended point billboards with a fully procedural soft
 * sprite generated in the fragment shader (no external textures). Fine metallic
 * dust puffs are emitted at the shear line and catch the key light (rim-lit —
 * brighter when back-lit); heavier cast-iron chewing produces slow-rising smoke
 * wisps. Particles drift with cheap curl-noise turbulence, rise gently, expand
 * and fade over their life. Everything is simulated analytically in the vertex
 * shader from a static per-particle state, so the per-frame CPU cost is a single
 * uniform update.
 */

const HARD_MAX = Math.max(64, Math.round(Math.max(
  ...Object.values(QUALITY_PRESETS).map((p) => p.maxSparks || 0)
) * 0.12));

const _tmp = new THREE.Vector3();

const VERT = /* glsl */ `
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

attribute vec3 position;      // origin
attribute vec3 aVel;
attribute float aBirth;
attribute float aLife;
attribute float aSeed;
attribute float aSize;
attribute vec3 aColor;
attribute float aSmoke;

uniform float uTime;
uniform float uPixelScale;

varying float vAlpha;
varying vec3 vColor;
varying float vSeed;

void main() {
  float t = uTime - aBirth;
  float lf = clamp(t / max(aLife, 0.0001), 0.0, 1.0);
  float alive = step(0.0, t) * step(t, aLife);

  // Curl-ish turbulent drift approximated with layered sinusoids.
  float w = aSeed * 6.2831;
  vec3 curl = vec3(
    sin(t * 1.3 + w) + 0.5 * sin(t * 2.7 + w * 1.7),
    cos(t * 1.1 + w * 1.3),
    cos(t * 1.6 + w) + 0.5 * sin(t * 2.2 + w * 0.6)
  );
  float buoyancy = (0.35 + 0.9 * aSmoke) * t;
  vec3 pos = position + aVel * t + curl * (0.05 + 0.12 * aSmoke) * t + vec3(0.0, buoyancy, 0.0);

  vAlpha = alive * (1.0 - lf) * (0.15 + 0.85 * smoothstep(0.0, 0.12, lf));
  vColor = aColor;
  vSeed = aSeed;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float grow = aSize * (0.4 + 1.8 * lf);
  gl_PointSize = uPixelScale * grow / max(-mv.z, 0.05);
  gl_Position = projectionMatrix * mv;
  if (alive < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying float vAlpha;
varying vec3 vColor;
varying float vSeed;

uniform float uBacklit;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
}

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  // Soft gaussian core with a little procedural noise for a dusty edge.
  float soft = exp(-r * r * 7.0);
  float n = 0.75 + 0.25 * hash(floor((gl_PointCoord + vSeed) * 6.0));
  float a = vAlpha * soft * n;
  // Rim-lit: dust glows brighter when the key light sits behind it.
  vec3 c = vColor * (0.6 + 1.1 * uBacklit);
  gl_FragColor = vec4(c, a);
}
`;

export class DustSystem {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.Vector3} [opts.lightDir] world-space key-light direction
   */
  constructor({ scene, lightDir }) {
    this.scene = scene;
    this.capacity = HARD_MAX;
    this.enabled = true;

    this._time = 0;
    this._head = 0;
    this._tail = 0;
    this._dirty = false;
    this._lightDir = (lightDir || new THREE.Vector3(-0.4, -0.9, -0.3)).clone().normalize();

    this._build();
  }

  _build() {
    const cap = this.capacity;
    const geo = new THREE.BufferGeometry();

    const mk = (name, size) => {
      const arr = new Float32Array(cap * size);
      const attr = new THREE.BufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      return { arr, attr };
    };

    this._pos = mk('position', 3);
    this._vel = mk('aVel', 3);
    this._birth = mk('aBirth', 1);
    this._life = mk('aLife', 1);
    this._seed = mk('aSeed', 1);
    this._size = mk('aSize', 1);
    this._color = mk('aColor', 3);
    this._smoke = mk('aSmoke', 1);
    this._birth.arr.fill(-1000);
    this._life.arr.fill(0.001);

    geo.setDrawRange(0, 0);
    geo.frustumCulled = false;
    this.geometry = geo;

    this.material = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 320 },
        uBacklit: { value: 0.5 }
      },
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: true,
      depthWrite: false
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
    this.scene.add(this.points);
  }

  get liveCount() {
    return this._head - this._tail;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.points.visible = this.enabled;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} count
   * @param {object} [opts]
   * @param {number} [opts.spread=0.25] initial velocity spread (m/s)
   * @param {number} [opts.rise=0.4] upward bias (m/s)
   * @param {number} [opts.life=1.4] seconds
   * @param {number} [opts.size=0.06]
   * @param {THREE.Color|number} [opts.color=0x9a938a]
   * @param {number} [opts.smoke=0] 0 = fine dust, 1 = heavy smoke wisp
   */
  emit(position, count, opts = {}) {
    if (!this.enabled || count <= 0) return;
    const spread = opts.spread ?? 0.25;
    const rise = opts.rise ?? 0.4;
    const life = opts.life ?? 1.4;
    const size = opts.size ?? 0.06;
    const smoke = opts.smoke ?? 0;

    const col = opts.color instanceof THREE.Color
      ? opts.color
      : _dcol.set(opts.color ?? 0x9a938a);

    const n = Math.min(count | 0, this.capacity);
    for (let i = 0; i < n; i++) {
      const idx = this._alloc();
      this._pos.arr[idx * 3] = position.x + (Math.random() - 0.5) * 0.04;
      this._pos.arr[idx * 3 + 1] = position.y + (Math.random() - 0.5) * 0.04;
      this._pos.arr[idx * 3 + 2] = position.z + (Math.random() - 0.5) * 0.04;
      this._vel.arr[idx * 3] = (Math.random() - 0.5) * spread;
      this._vel.arr[idx * 3 + 1] = rise * (0.5 + Math.random());
      this._vel.arr[idx * 3 + 2] = (Math.random() - 0.5) * spread;
      this._birth.arr[idx] = this._time;
      this._life.arr[idx] = life * (0.7 + Math.random() * 0.6);
      this._seed.arr[idx] = Math.random();
      this._size.arr[idx] = size * (0.6 + Math.random() * 0.9);
      this._color.arr[idx * 3] = col.r;
      this._color.arr[idx * 3 + 1] = col.g;
      this._color.arr[idx * 3 + 2] = col.b;
      this._smoke.arr[idx] = smoke;
    }
    this._markDirty();
  }

  update(dt, camera) {
    this._time += dt;
    this.material.uniforms.uTime.value = this._time;

    // Back-lit factor: dust glows when the key light points toward the camera.
    if (camera) {
      camera.getWorldDirection(_tmp); // points where camera looks
      const backlit = THREE.MathUtils.clamp(this._lightDir.dot(_tmp) * 0.5 + 0.5, 0, 1);
      this.material.uniforms.uBacklit.value = backlit;
    }

    const life = this._life.arr;
    const birth = this._birth.arr;
    const cap = this.capacity;
    while (this._tail < this._head) {
      const i = this._tail % cap;
      if (birth[i] + life[i] <= this._time) this._tail++;
      else break;
    }
    this.geometry.setDrawRange(0, Math.min(this._head, cap));
    this._flush();
  }

  setPixelScale(px) {
    this.material.uniforms.uPixelScale.value = px;
  }

  _alloc() {
    const cap = this.capacity;
    const idx = this._head % cap;
    this._head++;
    if (this._head - this._tail > cap) this._tail = this._head - cap;
    return idx;
  }

  _markDirty() {
    this._dirty = true;
  }

  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this._pos.attr.needsUpdate = true;
    this._vel.attr.needsUpdate = true;
    this._birth.attr.needsUpdate = true;
    this._life.attr.needsUpdate = true;
    this._seed.attr.needsUpdate = true;
    this._size.attr.needsUpdate = true;
    this._color.attr.needsUpdate = true;
    this._smoke.attr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _dcol = new THREE.Color();
