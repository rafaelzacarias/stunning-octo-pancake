import * as THREE from 'three';

/**
 * Runtime-generated PBR texture sets — zero external assets.
 *
 * Every map (brushed anisotropic scratches, worley rust/corrosion, a Sobel
 * derived tangent normal, a packed ORM data map and an anisotropy direction
 * map) is rendered on the GPU by baking fullscreen noise shaders into
 * {@link THREE.WebGLRenderTarget}s. All maps tile seamlessly (periodic noise),
 * use the correct colour spaces and are cached per `(metal, size)`.
 *
 * Public surface:
 *  - `new ProceduralTextures(renderer, { anisotropy })`
 *  - `generate(metalSpec, size, opts) -> MaterialMapSet`
 *  - `concrete(size) -> { albedo, normal, orm }` (factory-floor helper)
 *  - `dispose()`
 */

/* ------------------------------------------------------------------ *
 * Shared GLSL — periodic (seamless) noise primitives.
 * ------------------------------------------------------------------ */
const NOISE_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUv;

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Periodic value noise: tiles exactly with the given (integer) period.
float vnoise(vec2 x, vec2 period){
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i + vec2(0.0, 0.0), period);
  vec2 b = mod(i + vec2(1.0, 0.0), period);
  vec2 c = mod(i + vec2(0.0, 1.0), period);
  vec2 d = mod(i + vec2(1.0, 1.0), period);
  float va = hash21(a);
  float vb = hash21(b);
  float vc = hash21(c);
  float vd = hash21(d);
  return mix(mix(va, vb, f.x), mix(vc, vd, f.x), f.y);
}

// Anisotropic periodic FBM (independent per-axis frequency for brushed streaks).
float fbm(vec2 uv, vec2 freq, int octaves, float gain, float lac){
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  vec2 f = freq;
  for (int i = 0; i < 8; i++){
    if (i >= octaves) break;
    sum += amp * vnoise(uv * f, f);
    norm += amp;
    f *= lac;
    amp *= gain;
  }
  return sum / max(norm, 1e-3);
}

// Periodic Worley / cellular noise (F1 distance), anisotropic frequency.
float worley(vec2 uv, vec2 freq){
  vec2 p = uv * freq;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, freq);
      vec2 o = hash22(cell);
      vec2 r = g + o - f;
      d = min(d, dot(r, r));
    }
  }
  return sqrt(d);
}
`;

/* ------------------------------------------------------------------ *
 * Shared surface field — single source of truth used by every map.
 * Returns a packed description of the micro-surface at `uv`.
 *   height  : 0..1 relative surface height (grooves low, rust crust high)
 *   rust    : 0..1 corrosion coverage mask
 *   brushed : 0..1 tonal brushed-streak value
 *   aniso   : 0..1 local anisotropy strength (high on clean brushed metal)
 * ------------------------------------------------------------------ */
const SURFACE_GLSL = /* glsl */ `
uniform vec3  uColor;
uniform float uRust;     // metal base rust propensity 0..1
uniform float uWear;     // extra scratches / gouges 0..1
uniform float uOxide;    // oxide / patina 0..1
uniform float uAniso;    // brushed strength 0..1
uniform float uTexel;    // 1.0 / textureSize

struct Surface {
  float height;
  float rust;
  float brushed;
  float aniso;
  float pit;
};

Surface surface(vec2 uv){
  // --- Brushed anisotropic micro-scratches (run along U) --------------
  float b0 = vnoise(uv * vec2(4.0, 220.0),  vec2(4.0, 220.0));
  float b1 = vnoise(uv * vec2(8.0, 460.0),  vec2(8.0, 460.0));
  float b2 = vnoise(uv * vec2(3.0, 96.0),   vec2(3.0, 96.0));
  float brushed = 0.5 * b0 + 0.32 * b1 + 0.18 * b2;

  // Deep, sparse directional gouges.
  float gLine = worley(uv * vec2(2.0, 1.0), vec2(6.0, 40.0));
  float gouge = (1.0 - smoothstep(0.0, 0.05 + 0.08 * uWear, gLine));
  gouge *= step(0.55, hash21(floor(uv * vec2(6.0, 40.0))));

  // --- Rust / corrosion blotches (multi-octave worley) ----------------
  float w0 = worley(uv, vec2(4.0, 4.0));
  float w1 = worley(uv, vec2(9.0, 9.0));
  float w2 = worley(uv, vec2(19.0, 19.0));
  float blotch = 1.0 - (0.6 * w0 + 0.3 * w1 + 0.1 * w2);
  // Large-scale patchiness biases rust into bands (mimics edge / weld creep).
  float rustPatch = fbm(uv, vec2(3.0, 3.0), 4, 0.5, 2.0);
  float edgeBias = smoothstep(0.35, 0.85, rustPatch);
  float rustRaw = blotch * mix(0.35, 1.2, edgeBias);
  float rust = smoothstep(0.55, 0.92, rustRaw) * clamp(uRust + 0.25 * uWear, 0.0, 1.0);

  // Fine pitting inside rusted regions.
  float pitN = worley(uv, vec2(40.0, 40.0));
  float pit = (1.0 - smoothstep(0.0, 0.12, pitN)) * rust;

  // --- Compose height field ------------------------------------------
  float height = 0.62;
  height -= 0.10 * (1.0 - brushed);      // brushed grooves
  height -= 0.32 * gouge;                 // deep gouges
  height += 0.22 * rust;                  // crusty rust
  height -= 0.30 * pit;                   // pit craters
  height = clamp(height, 0.0, 1.0);

  float aniso = clamp(uAniso, 0.0, 1.0) * (1.0 - rust) * (1.0 - 0.7 * gouge);

  Surface s;
  s.height = height;
  s.rust = rust;
  s.brushed = brushed;
  s.aniso = aniso;
  s.pit = pit;
  return s;
}
`;

const FS_ALBEDO = /* glsl */ `
${NOISE_GLSL}
${SURFACE_GLSL}
void main(){
  Surface s = surface(vUv);
  vec3 base = uColor;
  // Subtle cavity darkening from the height field.
  base *= (0.80 + 0.20 * s.height);
  // Brushed tonal streaks.
  base *= (0.93 + 0.07 * s.brushed);
  // Temper / oxide tint (straw-blue iridescent sheen baked faintly in).
  vec3 oxideTint = mix(vec3(0.62, 0.66, 0.78), vec3(0.86, 0.74, 0.52), s.brushed);
  base = mix(base, base * oxideTint, uOxide * 0.35);
  // Rust colour: dark iron oxide in the centres, orange flakes at the edges.
  vec3 rustDark = vec3(0.22, 0.09, 0.04);
  vec3 rustBright = vec3(0.46, 0.22, 0.09);
  vec3 rustCol = mix(rustDark, rustBright, s.brushed);
  base = mix(base, rustCol, s.rust);
  base = mix(base, base * 0.4, s.pit);
  gl_FragColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;

const FS_NORMAL = /* glsl */ `
${NOISE_GLSL}
${SURFACE_GLSL}
uniform float uBump;
void main(){
  float e = uTexel;
  float hL = surface(vUv - vec2(e, 0.0)).height;
  float hR = surface(vUv + vec2(e, 0.0)).height;
  float hD = surface(vUv - vec2(0.0, e)).height;
  float hU = surface(vUv + vec2(0.0, e)).height;
  // Sobel-style tangent-space normal from the height derivatives.
  vec3 n = normalize(vec3((hL - hR) * uBump, (hD - hU) * uBump, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

const FS_ORM = /* glsl */ `
${NOISE_GLSL}
${SURFACE_GLSL}
uniform float uRough;
uniform float uMetal;
void main(){
  Surface s = surface(vUv);
  // Cheap cavity AO: compare centre height against a small neighbourhood.
  float e = uTexel * 2.0;
  float hAvg = 0.25 * (
    surface(vUv + vec2(e, 0.0)).height +
    surface(vUv - vec2(e, 0.0)).height +
    surface(vUv + vec2(0.0, e)).height +
    surface(vUv - vec2(0.0, e)).height);
  float ao = clamp(0.5 + (s.height - hAvg) * 4.0, 0.0, 1.0);
  ao = mix(1.0, ao, 0.85);
  ao *= (1.0 - 0.35 * s.pit);

  float rough = mix(uRough, 0.94, s.rust);
  rough += (s.brushed - 0.5) * 0.06;       // brushed micro-variation
  rough = mix(rough, 0.98, s.pit);
  rough = clamp(rough, 0.04, 1.0);

  float metal = mix(uMetal, 0.12, s.rust);
  metal = mix(metal, metal * 0.5, s.pit);
  metal = clamp(metal, 0.0, 1.0);

  // R = AO, G = roughness, B = metalness (standard ORM packing).
  gl_FragColor = vec4(ao, rough, metal, 1.0);
}
`;

const FS_ANISO = /* glsl */ `
${NOISE_GLSL}
${SURFACE_GLSL}
void main(){
  Surface s = surface(vUv);
  // Brushed direction runs along U, wandering slightly with a low-freq noise.
  float wobble = (vnoise(vUv * vec2(3.0, 12.0), vec2(3.0, 12.0)) - 0.5) * 0.35;
  vec2 dir = normalize(vec2(1.0, wobble));
  gl_FragColor = vec4(dir * 0.5 + 0.5, s.aniso, 1.0);
}
`;

/* Concrete factory-floor shaders (worn, dusty, subtle aggregate). */
const FS_CONCRETE_ALBEDO = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uColor;
void main(){
  float grain = fbm(vUv, vec2(48.0, 48.0), 5, 0.55, 2.0);
  float stains = fbm(vUv, vec2(5.0, 5.0), 4, 0.5, 2.0);
  float agg = 1.0 - smoothstep(0.0, 0.14, worley(vUv, vec2(64.0, 64.0)));
  vec3 col = uColor * (0.72 + 0.5 * grain);
  col = mix(col, col * 0.55, smoothstep(0.45, 0.85, stains));  // oil stains
  col = mix(col, col * 1.15, agg * 0.4);                        // aggregate flecks
  // Faint painted safety lines / wear streaks.
  col *= (0.9 + 0.1 * vnoise(vUv * vec2(2.0, 60.0), vec2(2.0, 60.0)));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const FS_CONCRETE_NORMAL = /* glsl */ `
${NOISE_GLSL}
uniform float uTexel;
float h(vec2 uv){
  return fbm(uv, vec2(48.0, 48.0), 5, 0.55, 2.0)
       + 0.4 * (1.0 - smoothstep(0.0, 0.14, worley(uv, vec2(64.0, 64.0))));
}
void main(){
  float e = uTexel;
  float hL = h(vUv - vec2(e, 0.0));
  float hR = h(vUv + vec2(e, 0.0));
  float hD = h(vUv - vec2(0.0, e));
  float hU = h(vUv + vec2(0.0, e));
  vec3 n = normalize(vec3((hL - hR) * 2.0, (hD - hU) * 2.0, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

const FS_CONCRETE_ORM = /* glsl */ `
${NOISE_GLSL}
void main(){
  float grain = fbm(vUv, vec2(48.0, 48.0), 5, 0.55, 2.0);
  float polish = fbm(vUv, vec2(6.0, 6.0), 3, 0.5, 2.0);
  float ao = clamp(0.75 + 0.25 * grain, 0.0, 1.0);
  float rough = clamp(0.82 - 0.25 * polish + 0.1 * grain, 0.3, 1.0);
  gl_FragColor = vec4(ao, rough, 0.0, 1.0);
}
`;

/**
 * A generated set of PBR maps for one metal at one resolution.
 * @typedef {Object} MaterialMapSet
 * @property {THREE.Texture} albedo       sRGB colour
 * @property {THREE.Texture} normal       tangent-space normal (linear)
 * @property {THREE.Texture} orm          R=AO, G=roughness, B=metalness (linear)
 * @property {THREE.Texture} anisotropy   RG=direction, B=strength (linear)
 * @property {() => void}    dispose
 */

export class ProceduralTextures {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ anisotropy?: number }} [opts]
   */
  constructor(renderer, { anisotropy = 8 } = {}) {
    this.renderer = renderer;
    this.anisotropy = anisotropy;

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geometry = new THREE.PlaneGeometry(2, 2);
    this._quad = new THREE.Mesh(this._geometry, null);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    /** @type {Map<string, MaterialMapSet>} */
    this._cache = new Map();
  }

  /**
   * Bake one fragment shader into a texture.
   * @private
   */
  _bake(fragmentShader, uniforms, size, colorSpace) {
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false
    });
    target.texture.anisotropy = this.anisotropy;

    const material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false
    });

    this._quad.material = material;
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._scene, this._camera);
    this.renderer.setRenderTarget(prevTarget);

    material.dispose();
    return target;
  }

  /**
   * Generate (or return cached) maps for a metal spec.
   * @param {import('../core/Constants.js').METALS[keyof typeof import('../core/Constants.js').METALS]} spec
   * @param {number} size power-of-two texture size
   * @param {{ wear?: number }} [opts]
   * @returns {MaterialMapSet}
   */
  generate(spec, size, { wear = 0 } = {}) {
    const key = `${spec.id}:${size}:${wear.toFixed(2)}:${this.anisotropy}`;
    const cached = this._cache.get(key);
    if (cached) return cached;

    const color = new THREE.Color(spec.color);
    const texel = 1 / size;
    const common = () => ({
      uColor: { value: color },
      uRust: { value: spec.rust ?? 0 },
      uWear: { value: wear },
      uOxide: { value: spec.oxide ?? 0 },
      uAniso: { value: spec.anisotropy ?? 0 },
      uTexel: { value: texel }
    });

    const albedoT = this._bake(FS_ALBEDO, common(), size, THREE.SRGBColorSpace);
    const normalT = this._bake(
      FS_NORMAL,
      { ...common(), uBump: { value: 1.4 } },
      size,
      THREE.NoColorSpace
    );
    const ormT = this._bake(
      FS_ORM,
      { ...common(), uRough: { value: spec.roughness }, uMetal: { value: spec.metalness } },
      size,
      THREE.NoColorSpace
    );
    const anisoT = this._bake(FS_ANISO, common(), size, THREE.NoColorSpace);

    const set = {
      albedo: albedoT.texture,
      normal: normalT.texture,
      orm: ormT.texture,
      anisotropy: anisoT.texture,
      dispose() {
        albedoT.dispose();
        normalT.dispose();
        ormT.dispose();
        anisoT.dispose();
      }
    };
    this._cache.set(key, set);
    return set;
  }

  /**
   * Worn-concrete factory-floor map set.
   * @param {number} size
   * @param {number} [tint]
   * @returns {{ albedo: THREE.Texture, normal: THREE.Texture, orm: THREE.Texture, dispose: () => void }}
   */
  concrete(size, tint = 0x3c3d40) {
    const key = `concrete:${size}:${tint}:${this.anisotropy}`;
    const cached = this._cache.get(key);
    if (cached) return cached;

    const color = new THREE.Color(tint);
    const albedoT = this._bake(
      FS_CONCRETE_ALBEDO,
      { uColor: { value: color } },
      size,
      THREE.SRGBColorSpace
    );
    const normalT = this._bake(
      FS_CONCRETE_NORMAL,
      { uTexel: { value: 1 / size } },
      size,
      THREE.NoColorSpace
    );
    const ormT = this._bake(FS_CONCRETE_ORM, {}, size, THREE.NoColorSpace);

    const set = {
      albedo: albedoT.texture,
      normal: normalT.texture,
      orm: ormT.texture,
      dispose() {
        albedoT.dispose();
        normalT.dispose();
        ormT.dispose();
      }
    };
    this._cache.set(key, set);
    return set;
  }

  /** Free every cached map set and the internal quad. */
  dispose() {
    for (const set of this._cache.values()) set.dispose();
    this._cache.clear();
    this._geometry.dispose();
  }
}
