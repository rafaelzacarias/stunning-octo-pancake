import * as THREE from 'three';
import { LAYOUT } from '../config.js';

/**
 * GPUParticles — a single GPGPU particle system that drives sparks, shrapnel
 * and metallic dust in one instanced draw call.
 *
 * State lives in two float render targets (position+life, velocity+type) that
 * ping-pong through a simulation shader every frame. The CPU only ever writes
 * newly spawned particles, so tens of thousands of colliding sparks cost
 * essentially nothing on the main thread.
 *
 * Type is packed into velocity.w as `type + seed` (integer part = type,
 * fractional part = per-particle random seed).
 */

export const PTYPE = { SPARK: 0, SHRAPNEL: 1, DUST: 2, EMBER: 3 };

const SIM_VS = /* glsl */`
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SIM_FS = /* glsl */`
precision highp float;
precision highp sampler2D;

in vec2 vUv;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDt;
uniform float uTime;
uniform vec3 uGravity;
uniform vec4 uDeck;      // deckY, halfX, centerZ, halfZ
uniform vec4 uBelt;      // beltY, halfX, minZ, maxZ
uniform float uFloorY;

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 P = texture(uPos, vUv);
  vec4 V = texture(uVel, vUv);

  float life = P.w;
  if (life <= 0.0) { oPos = vec4(P.xyz, 0.0); oVel = V; return; }

  float typ = floor(V.w + 0.5);
  float seed = fract(V.w);

  // Per-type ballistics. Sparks are tiny and hot: huge drag, so they
  // decelerate hard instead of drifting like confetti.
  float drag, gscale, rest, tangential;
  if (typ < 0.5)        { drag = 3.6;  gscale = 1.0;  rest = 0.34; tangential = 0.55; } // spark
  else if (typ < 1.5)   { drag = 0.85; gscale = 1.0;  rest = 0.40; tangential = 0.72; } // shrapnel
  else if (typ < 2.5)   { drag = 5.4;  gscale = 0.10; rest = 0.02; tangential = 0.9;  } // dust
  else                  { drag = 2.1;  gscale = 0.35; rest = 0.30; tangential = 0.6;  } // ember

  vec3 p = P.xyz;
  vec3 v = V.xyz;
  float dt = uDt;

  v += uGravity * gscale * dt;
  v *= exp(-drag * dt);

  // Dust curls upward in the machine's own thermal plume.
  if (typ > 1.5 && typ < 2.5) {
    v.y += 0.35 * dt;
    v.x += sin(uTime * 1.7 + seed * 31.0) * 0.09 * dt;
    v.z += cos(uTime * 1.3 + seed * 17.0) * 0.09 * dt;
  }

  vec3 next = p + v * dt;

  // ---- collision: layered horizontal planes (floor / steel deck / belt) ----
  float ground = uFloorY;
  if (abs(next.x) < uDeck.y && abs(next.z - uDeck.z) < uDeck.w) ground = uDeck.x;
  bool onBelt = abs(next.x) < uBelt.y && next.z > uBelt.z && next.z < uBelt.w;
  if (onBelt && p.y >= uBelt.x - 0.02) ground = max(ground, uBelt.x);

  if (next.y < ground && v.y < 0.0) {
    next.y = ground + 0.0006;
    v.y = -v.y * rest;
    v.xz *= tangential;
    // Skitter: real sparks scatter unpredictably off steel.
    float h = hash12(vUv * 91.7 + uTime);
    v.x += (h - 0.5) * 0.55 * (1.0 - rest);
    v.z += (hash12(vUv * 37.1 - uTime) - 0.5) * 0.55 * (1.0 - rest);
    life -= (typ < 0.5) ? 0.14 : 0.05;
    if (typ > 1.5 && typ < 2.5) life -= 0.35;
  }

  // Bounce off the machine's outer cheeks so sparks stay in the throat.
  if (abs(next.x) > 0.62 && abs(next.x) < 0.78 && next.y > 0.9 && next.y < 1.6 && abs(next.z) < 0.9) {
    v.x = -v.x * 0.4;
    next.x = clamp(next.x, -0.62, 0.62) + sign(next.x) * 0.001;
  }

  life -= dt;
  oPos = vec4(next, max(life, 0.0));
  oVel = vec4(v, V.w);
}
`;

const EMIT_VS = /* glsl */`
precision highp float;
in vec2 aClip;
in vec3 aPos;
in vec4 aVel;
in float aLife;
out vec3 vPos;
out vec4 vVel;
out float vLife;
void main() {
  vPos = aPos;
  vVel = aVel;
  vLife = aLife;
  gl_Position = vec4(aClip, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const EMIT_FS = /* glsl */`
precision highp float;
in vec3 vPos;
in vec4 vVel;
in float vLife;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  oPos = vec4(vPos, vLife);
  oVel = vVel;
}
`;

const RENDER_VS = /* glsl */`
precision highp float;
attribute vec2 aRef;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uSizeScale;
uniform float uStretch;
uniform vec2 uViewport;

varying vec2 vQuad;
varying float vLife;
varying float vType;
varying float vSeed;
varying float vSpeed;

void main() {
  vQuad = uv;
  vec4 P = texture2D(uPos, aRef);
  vec4 V = texture2D(uVel, aRef);
  vLife = P.w;
  vType = floor(V.w + 0.5);
  vSeed = fract(V.w);
  vSpeed = length(V.xyz);

  if (P.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // cull offscreen
    return;
  }

  vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);

  float size = uSizeScale * (0.005 + vSeed * 0.005);
  float stretch = 1.0;
  if (vType < 0.5) {
    size *= 0.42;
    stretch = clamp(vSpeed * uStretch, 1.0, 6.0);   // motion-streaked spark
  } else if (vType < 1.5) {
    size *= 1.9;
    stretch = clamp(vSpeed * uStretch * 0.25, 1.0, 3.0);
  } else if (vType < 2.5) {
    size *= 5.5 + (1.0 - clamp(vLife, 0.0, 1.0)) * 9.0;  // dust puffs expand
  } else {
    size *= 1.15;
    stretch = clamp(vSpeed * uStretch * 0.4, 1.0, 4.0);
  }

  vec3 velView = (viewMatrix * vec4(V.xyz, 0.0)).xyz;
  vec2 dir = normalize(velView.xy + vec2(1e-5, 1e-5));
  vec2 right = vec2(dir.y, -dir.x);

  vec2 corner = position.xy;
  mv.xy += right * (corner.x * size) + dir * (corner.y * size * stretch);

  gl_Position = projectionMatrix * mv;
}
`;

const RENDER_FS = /* glsl */`
precision highp float;
varying vec2 vQuad;
varying float vLife;
varying float vType;
varying float vSeed;
varying float vSpeed;
uniform float uIntensity;
uniform float uTime;

vec3 blackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.42, 0.03, 0.004), vec3(1.0, 0.16, 0.01), smoothstep(0.0, 0.32, t));
  c = mix(c, vec3(1.0, 0.44, 0.06), smoothstep(0.28, 0.58, t));
  c = mix(c, vec3(1.0, 0.80, 0.34), smoothstep(0.54, 0.82, t));
  c = mix(c, vec3(1.0, 0.97, 0.90), smoothstep(0.80, 1.0, t));
  return c;
}

void main() {
  vec2 d = (vQuad - 0.5) * 2.0;
  float r = length(d);

  if (vType < 0.5) {
    // Spark: hot core with a tight halo, cooling along its life.
    float core = exp(-r * r * 9.0);
    float halo = exp(-r * r * 2.4) * 0.16;
    float heat = clamp(vLife / 0.9, 0.0, 1.0);
    heat = pow(heat, 0.65);
    // A few sparks flare as trapped carbon combusts.
    float flare = step(0.965, vSeed) * (0.5 + 0.5 * sin(uTime * 58.0 + vSeed * 100.0));
    vec3 col = blackbody(heat * (0.88 + flare * 0.3)) * (2.4 + flare * 2.2);
    float a = (core + halo) * clamp(vLife * 3.2, 0.0, 1.0);
    gl_FragColor = vec4(col * a * uIntensity, 0.0);      // premultiplied -> additive
  } else if (vType < 1.5) {
    // Shrapnel: dark tumbling metal with a hot leading edge.
    float mask = smoothstep(1.0, 0.55, r);
    if (mask <= 0.001) discard;
    float heat = clamp(vLife / 1.6, 0.0, 1.0) * 0.55;
    vec3 col = mix(vec3(0.045, 0.048, 0.055), blackbody(heat) * 1.4, heat);
    float a = mask * clamp(vLife * 2.5, 0.0, 1.0);
    gl_FragColor = vec4(col * a, a * 0.95);
  } else if (vType < 2.5) {
    // Dust: soft grey puff that fades as it disperses.
    float mask = exp(-r * r * 2.3);
    float a = mask * clamp(vLife, 0.0, 1.0) * 0.30;
    vec3 col = mix(vec3(0.30, 0.29, 0.28), vec3(0.62, 0.60, 0.58), vSeed);
    gl_FragColor = vec4(col * a, a);
  } else {
    // Ember: long-lived glowing fleck.
    float core = exp(-r * r * 5.0);
    float heat = clamp(vLife / 2.4, 0.0, 1.0);
    vec3 col = blackbody(heat * 0.8) * 1.8;
    float a = core * clamp(vLife * 1.6, 0.0, 1.0);
    gl_FragColor = vec4(col * a * uIntensity, 0.0);
  }
}
`;

export class GPUParticles {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    const cap = options.capacity || 16384;
    this.side = Math.max(8, Math.ceil(Math.sqrt(cap)));
    this.capacity = this.side * this.side;
    this.cursor = 0;
    this.time = 0;

    const hasFloat = renderer.capabilities.isWebGL2 &&
      renderer.extensions.has('EXT_color_buffer_float');
    this.dataType = hasFloat ? THREE.FloatType : THREE.HalfFloatType;

    this.rtA = this._makeTarget();
    this.rtB = this._makeTarget();

    this._buildSim();
    this._buildEmit(options.maxEmitPerFrame || 2400);
    this._buildRender();

    this._clearTargets();
  }

  _makeTarget() {
    const rt = new THREE.WebGLRenderTarget(this.side, this.side, {
      count: 2,
      type: this.dataType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.textures[0].name = 'particles.pos';
    rt.textures[1].name = 'particles.vel';
    return rt;
  }

  _buildSim() {
    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SIM_VS,
      fragmentShader: SIM_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPos: { value: null },
        uVel: { value: null },
        uDt: { value: 1 / 60 },
        uTime: { value: 0 },
        uGravity: { value: new THREE.Vector3(0, -9.81, 0) },
        uDeck: { value: new THREE.Vector4(0.094, 3.7, 0.6, 3.7) },
        uBelt: {
          value: new THREE.Vector4(
            LAYOUT.conveyor.y + LAYOUT.conveyor.beltThickness * 0.5,
            LAYOUT.conveyor.halfWidth,
            LAYOUT.conveyor.endZ,
            LAYOUT.conveyor.startZ
          ),
        },
        uFloorY: { value: 0.0 },
      },
    });
    const quad = new THREE.PlaneGeometry(2, 2);
    this.simMesh = new THREE.Mesh(quad, this.simMaterial);
    this.simMesh.frustumCulled = false;
    this.simScene.add(this.simMesh);
  }

  _buildEmit(maxEmit) {
    this.maxEmit = maxEmit;
    this.emitCount = 0;

    this.emitClip = new Float32Array(maxEmit * 2);
    this.emitPos = new Float32Array(maxEmit * 3);
    this.emitVel = new Float32Array(maxEmit * 4);
    this.emitLife = new Float32Array(maxEmit);

    const g = new THREE.BufferGeometry();
    this.aClip = new THREE.BufferAttribute(this.emitClip, 2).setUsage(THREE.DynamicDrawUsage);
    this.aPos = new THREE.BufferAttribute(this.emitPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.BufferAttribute(this.emitVel, 4).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(this.emitLife, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aClip', this.aClip);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aLife', this.aLife);
    g.setDrawRange(0, 0);
    this.emitGeometry = g;

    this.emitMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: EMIT_VS,
      fragmentShader: EMIT_FS,
      depthTest: false,
      depthWrite: false,
    });

    this.emitScene = new THREE.Scene();
    this.emitPoints = new THREE.Points(g, this.emitMaterial);
    this.emitPoints.frustumCulled = false;
    this.emitScene.add(this.emitPoints);
  }

  _buildRender() {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    geo.attributes.normal = base.attributes.normal;

    const refs = new Float32Array(this.capacity * 2);
    for (let i = 0; i < this.capacity; i++) {
      refs[i * 2] = ((i % this.side) + 0.5) / this.side;
      refs[i * 2 + 1] = (Math.floor(i / this.side) + 0.5) / this.side;
    }
    geo.setAttribute('aRef', new THREE.InstancedBufferAttribute(refs, 2));
    geo.instanceCount = this.capacity;
    base.dispose();

    this.renderMaterial = new THREE.ShaderMaterial({
      vertexShader: RENDER_VS,
      fragmentShader: RENDER_FS,
      uniforms: {
        uPos: { value: this.rtA.textures[0] },
        uVel: { value: this.rtA.textures[1] },
        uSizeScale: { value: 1.0 },
        uStretch: { value: 0.026 },
        uIntensity: { value: 1.0 },
        uTime: { value: 0 },
        uViewport: { value: new THREE.Vector2(1, 1) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.renderMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'GPUParticles';
  }

  _clearTargets() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const rt of [this.rtA, this.rtB]) {
      r.setRenderTarget(rt);
      r.clear(true, false, false);
    }
    r.setRenderTarget(prev);
    r.setClearColor(prevClear, prevAlpha);
  }

  /**
   * Queue particles for the next simulation step.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir    primary ejection direction (unit)
   * @param {number} count
   * @param {object} o  { type, speed, speedVar, spread, life, lifeVar, jitter }
   */
  emit(origin, dir, count, o = {}) {
    const type = o.type ?? PTYPE.SPARK;
    const speed = o.speed ?? 5.5;
    const speedVar = o.speedVar ?? 0.7;
    const spread = o.spread ?? 0.55;
    const life = o.life ?? 0.9;
    const lifeVar = o.lifeVar ?? 0.5;
    const jitter = o.jitter ?? 0.012;

    const dx = dir.x, dy = dir.y, dz = dir.z;
    // Orthonormal basis around the ejection axis.
    let ax = 0, ay = 0, az = 0;
    if (Math.abs(dx) < 0.9) { ax = 1; } else { ay = 1; }
    let ux = ay * dz - az * dy, uy = az * dx - ax * dz, uz = ax * dy - ay * dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;

    for (let i = 0; i < count; i++) {
      if (this.emitCount >= this.maxEmit) return;
      const k = this.emitCount++;
      const slot = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;

      this.emitClip[k * 2] = ((slot % this.side) + 0.5) / this.side * 2 - 1;
      this.emitClip[k * 2 + 1] = (Math.floor(slot / this.side) + 0.5) / this.side * 2 - 1;

      // Cone sampling, biased toward the axis so the jet reads as directional.
      const theta = Math.random() * Math.PI * 2;
      const rad = Math.pow(Math.random(), 0.65) * spread;
      const cx = dx + (ux * Math.cos(theta) + vx * Math.sin(theta)) * rad;
      const cy = dy + (uy * Math.cos(theta) + vy * Math.sin(theta)) * rad;
      const cz = dz + (uz * Math.cos(theta) + vz * Math.sin(theta)) * rad;
      const cl = Math.hypot(cx, cy, cz) || 1;

      const sp = speed * (1 - speedVar + Math.random() * speedVar * 2);

      this.emitPos[k * 3] = origin.x + (Math.random() - 0.5) * jitter;
      this.emitPos[k * 3 + 1] = origin.y + (Math.random() - 0.5) * jitter;
      this.emitPos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * jitter;

      this.emitVel[k * 4] = (cx / cl) * sp;
      this.emitVel[k * 4 + 1] = (cy / cl) * sp;
      this.emitVel[k * 4 + 2] = (cz / cl) * sp;
      this.emitVel[k * 4 + 3] = type + Math.min(0.999, Math.random());

      this.emitLife[k] = life * (1 - lifeVar + Math.random() * lifeVar * 2);
    }
  }

  update(dt) {
    this.time += dt;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevXR = r.xr.enabled;
    r.xr.enabled = false;

    // ---- simulate: A -> B ----
    this.simMaterial.uniforms.uPos.value = this.rtA.textures[0];
    this.simMaterial.uniforms.uVel.value = this.rtA.textures[1];
    this.simMaterial.uniforms.uDt.value = Math.min(dt, 1 / 30);
    this.simMaterial.uniforms.uTime.value = this.time;

    r.autoClear = false;
    r.setRenderTarget(this.rtB);
    r.clear(true, false, false);
    r.render(this.simScene, this.simCamera);

    // ---- inject newly spawned particles into the same target ----
    if (this.emitCount > 0) {
      this.aClip.addUpdateRange(0, this.emitCount * 2);
      this.aPos.addUpdateRange(0, this.emitCount * 3);
      this.aVel.addUpdateRange(0, this.emitCount * 4);
      this.aLife.addUpdateRange(0, this.emitCount);
      this.aClip.needsUpdate = true;
      this.aPos.needsUpdate = true;
      this.aVel.needsUpdate = true;
      this.aLife.needsUpdate = true;
      this.emitGeometry.setDrawRange(0, this.emitCount);
      r.render(this.emitScene, this.simCamera);
      this.emitCount = 0;
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.xr.enabled = prevXR;

    const tmp = this.rtA; this.rtA = this.rtB; this.rtB = tmp;

    this.renderMaterial.uniforms.uPos.value = this.rtA.textures[0];
    this.renderMaterial.uniforms.uVel.value = this.rtA.textures[1];
    this.renderMaterial.uniforms.uTime.value = this.time;
  }

  setQuality(q) {
    const scale = q === 'low' ? 0.8 : q === 'medium' ? 0.9 : 1.0;
    this.renderMaterial.uniforms.uSizeScale.value = scale;
    this.renderMaterial.uniforms.uIntensity.value = q === 'low' ? 0.8 : 1.0;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.simMaterial.dispose();
    this.simMesh.geometry.dispose();
    this.emitMaterial.dispose();
    this.emitGeometry.dispose();
    this.renderMaterial.dispose();
    this.mesh.geometry.dispose();
  }
}
