import * as THREE from 'three';
import { METALS } from '../core/Constants.js';
import { ProceduralTextures } from './ProceduralTextures.js';
import { applyShearHeat, updateShearHeatTime, unregisterShearHeat } from './ShearHeatShader.js';

/**
 * Physically based metal material library.
 *
 * Wraps {@link ProceduralTextures} (runtime-baked brushed / rust / normal / ORM
 * / anisotropy maps) and the {@link module:materials/ShearHeatShader} emissive
 * injection into cached {@link THREE.MeshPhysicalMaterial}s. A mirror-polished
 * stainless bar and a rusty cast-iron block are visibly, physically different
 * under the studio HDRI.
 *
 * @example
 *   const lib = new MaterialLibrary(renderer, { environment, textureSize: 1024, anisotropy: 16 });
 *   await lib.build();
 *   mesh.material = lib.get('stainless');
 *   // per-frame:
 *   lib.update(dt);
 */
export class MaterialLibrary {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {Object} opts
   * @param {import('../render/StudioEnvironment.js').StudioEnvironment} [opts.environment]
   * @param {number} [opts.textureSize=1024]
   * @param {number} [opts.anisotropy=8]
   */
  constructor(renderer, { environment, textureSize = 1024, anisotropy = 8 } = {}) {
    this.renderer = renderer;
    this.environment = environment || null;
    this.textureSize = textureSize;
    this.anisotropy = anisotropy;
    this.envMapIntensity = 1.15;

    this._textures = new ProceduralTextures(renderer, { anisotropy });
    /** @type {Map<string, THREE.MeshPhysicalMaterial>} */
    this.cache = new Map();
    /** @type {Set<THREE.MeshPhysicalMaterial>} every material we own, for updates/dispose. */
    this._owned = new Set();
    this._time = 0;
  }

  /** Pre-generate shared maps and pre-compile the standard metal variants. */
  async build() {
    for (const id of Object.keys(METALS)) this.get(id);
    return this;
  }

  /** The current environment PMREM cube map, if the environment is ready. */
  get _envMap() {
    return this.environment && this.environment.envMap ? this.environment.envMap : null;
  }

  /**
   * Cached shared material for a metal id.
   * @param {string} metalId
   * @returns {THREE.MeshPhysicalMaterial}
   */
  get(metalId) {
    const key = metalId in METALS ? metalId : 'steel';
    let mat = this.cache.get(key);
    if (mat) return mat;
    mat = this._make(METALS[key], {});
    this.cache.set(key, mat);
    return mat;
  }

  /**
   * A fresh (non-shared) material variant — use when a piece needs its own wear.
   * @param {string} metalId
   * @param {Object} [opts]
   * @param {number} [opts.wear=0]      extra scratches / gouges 0..1
   * @param {number} [opts.rust]        override the metal's rust propensity
   * @param {number} [opts.scale=1]     texture repeat scale
   * @param {boolean} [opts.flatShading=false]
   * @returns {THREE.MeshPhysicalMaterial}
   */
  createFor(metalId, { wear = 0, rust, scale = 1, flatShading = false } = {}) {
    const spec = METALS[metalId] || METALS.steel;
    const effective = rust === undefined ? spec : { ...spec, rust };
    return this._make(effective, { wear, scale, flatShading });
  }

  /**
   * Build a metal material from a spec.
   * @private
   */
  _make(spec, { wear = 0, scale = 1, flatShading = false }) {
    const maps = this._textures.generate(spec, this.textureSize, { wear });
    if (scale !== 1) {
      for (const t of [maps.albedo, maps.normal, maps.orm, maps.anisotropy]) {
        t.repeat.setScalar(scale);
      }
    }

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, // tint already baked into the albedo map
      map: maps.albedo,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      aoMap: maps.orm,
      aoMapIntensity: 0.9,
      roughness: 1.0, // absolute value lives in the ORM green channel
      metalness: 1.0, // absolute value lives in the ORM blue channel
      // Real anisotropy — strength is carried per-texel in the anisotropy map.
      anisotropy: 1.0,
      anisotropyRotation: 0,
      anisotropyMap: maps.anisotropy,
      // Thin oxide / patina reads as a faint clearcoat.
      clearcoat: THREE.MathUtils.clamp((spec.oxide ?? 0) * 0.6, 0, 0.5),
      clearcoatRoughness: 0.35,
      // Subtle temper-colour iridescence.
      iridescence: THREE.MathUtils.clamp((spec.oxide ?? 0) * 0.4, 0, 0.35),
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [120, 420],
      envMapIntensity: this.envMapIntensity,
      flatShading
    });

    const env = this._envMap;
    if (env) mat.envMap = env;
    mat.userData.metalId = spec.id;
    mat.userData.wear = wear;

    applyShearHeat(mat);
    this._owned.add(mat);
    return mat;
  }

  /**
   * Dirty painted cast-iron — for engine blocks. Grime settles in the crevices,
   * paint is chipped and semi-gloss over a matte iron substrate.
   * @param {Object} [opts]
   * @param {number} [opts.color=0x2b2f33] paint colour
   * @param {number} [opts.wear=0.5]
   * @returns {THREE.MeshPhysicalMaterial}
   */
  createPaintedMaterial({ color = 0x2b2f33, wear = 0.5 } = {}) {
    const spec = { ...METALS.castIron, rust: 0.35 };
    const maps = this._textures.generate(spec, this.textureSize, { wear });
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: maps.orm,
      aoMap: maps.orm,
      aoMapIntensity: 1.0,
      roughness: 0.62,
      metalness: 0.15, // painted, so mostly dielectric
      clearcoat: 0.35, // semi-gloss enamel
      clearcoatRoughness: 0.5,
      envMapIntensity: this.envMapIntensity * 0.8
    });
    const env = this._envMap;
    if (env) mat.envMap = env;
    mat.userData.metalId = 'paintedIron';
    applyShearHeat(mat);
    this._owned.add(mat);
    return mat;
  }

  /**
   * Conveyor-belt rubber. The physics agent scrolls it by advancing
   * `material.map.offset` (mirrored on `material.userData.uvOffset`).
   * @param {Object} [opts]
   * @param {number} [opts.color=0x121316]
   * @returns {THREE.MeshPhysicalMaterial}
   */
  createBeltMaterial({ color = 0x121316 } = {}) {
    const spec = { ...METALS.castIron, rust: 0, oxide: 0, anisotropy: 0.1, roughness: 0.85 };
    const maps = this._textures.generate(spec, Math.min(this.textureSize, 512), { wear: 0.2 });
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.88,
      metalness: 0.0,
      sheen: 0.2,
      sheenRoughness: 0.9,
      envMapIntensity: this.envMapIntensity * 0.5
    });
    const env = this._envMap;
    if (env) mat.envMap = env;
    mat.userData.metalId = 'belt';
    mat.userData.uvOffset = maps.normal.offset; // physics agent advances this
    this._owned.add(mat);
    return mat;
  }

  /**
   * Advance the shear-heat animation for every live material.
   * @param {number} dt seconds
   */
  update(dt) {
    this._time += dt;
    updateShearHeatTime(this._time);
  }

  /**
   * Re-tune texture resolution / anisotropy for a quality preset. Regenerates
   * the shared maps and rebinds them on the owned metal materials without leaking.
   * @param {import('../core/Constants.js').QUALITY_PRESETS[keyof typeof import('../core/Constants.js').QUALITY_PRESETS]} preset
   */
  applyQuality(preset) {
    if (!preset) return;
    const nextSize = preset.textureSize || this.textureSize;
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const nextAniso = Math.min(maxAniso, preset.anisotropicFiltering || this.anisotropy);
    if (nextSize === this.textureSize && nextAniso === this.anisotropy) return;

    this.textureSize = nextSize;
    this.anisotropy = nextAniso;

    const oldTextures = this._textures;
    this._textures = new ProceduralTextures(this.renderer, { anisotropy: nextAniso });

    for (const mat of this._owned) {
      const id = mat.userData.metalId;
      const spec = METALS[id];
      if (!spec) continue; // painted / belt keep their maps
      const maps = this._textures.generate(spec, nextSize, { wear: mat.userData.wear || 0 });
      mat.map = maps.albedo;
      mat.normalMap = maps.normal;
      mat.roughnessMap = maps.orm;
      mat.metalnessMap = maps.orm;
      mat.aoMap = maps.orm;
      mat.anisotropyMap = maps.anisotropy;
      mat.needsUpdate = true;
    }
    oldTextures.dispose();
  }

  /** Refresh the environment map reference on every owned material. */
  refreshEnvironment() {
    const env = this._envMap;
    if (!env) return;
    for (const mat of this._owned) {
      mat.envMap = env;
      mat.needsUpdate = true;
    }
  }

  /** Dispose every owned material and all generated textures. */
  dispose() {
    for (const mat of this._owned) {
      unregisterShearHeat(mat);
      mat.dispose();
    }
    this._owned.clear();
    this.cache.clear();
    this._textures.dispose();
  }
}
