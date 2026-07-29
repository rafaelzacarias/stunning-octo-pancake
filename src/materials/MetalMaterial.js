import * as THREE from 'three';
import { METALS } from '../core/Constants.js';

/**
 * CONTRACT (owned by the Graphics sub-agent).
 * Caches physically based metal materials with procedural rust / scratch /
 * anisotropy maps and the shear-heat emissive injection.
 */
export class MaterialLibrary {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.opts = opts;
    this.cache = new Map();
  }

  async build() { return this; }

  get(metalId) {
    if (this.cache.has(metalId)) return this.cache.get(metalId);
    const spec = METALS[metalId] || METALS.steel;
    const mat = new THREE.MeshPhysicalMaterial({
      color: spec.color,
      metalness: spec.metalness,
      roughness: spec.roughness
    });
    this.cache.set(metalId, mat);
    return mat;
  }

  createFor(metalId) { return this.get(metalId); }
  update(_dt) {}
  applyQuality(_preset) {}
}
