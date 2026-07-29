import * as THREE from 'three';
import { createMetalTextureSet } from './ProceduralTextures.js';
import { injectHeatShader } from './HeatShader.js';

/**
 * Physical material library. Every entry carries both its render description
 * and the mechanical constants the destruction solver needs, so "aluminium"
 * means one thing across graphics, physics and audio.
 */
export const MATERIAL_LIBRARY = {
  mildSteel: {
    texture: 'steel',
    density: 7850,
    roughness: 0.42, metalness: 1.0,
    anisotropy: 0.65, anisotropyRotation: Math.PI * 0.5,
    envMapIntensity: 1.15,
    tint: 0xb9bec4,
    // mechanical: impulse (N·s) accumulated at the teeth before the metal
    // yields, then shears. Calibrated so stock tears within ~0.3-0.8 s of
    // real engagement rather than grinding indefinitely.
    yieldImpulse: 780,
    shearImpulse: 2600,
    ductility: 0.55,        // how much it bends before letting go
    hardness: 0.78,         // audio timbre + spark yield
    sparkYield: 1.0,
    heatCapacity: 0.9,
  },
  hardenedSteel: {
    texture: 'steel',
    density: 7900,
    roughness: 0.28, metalness: 1.0,
    anisotropy: 0.75, anisotropyRotation: Math.PI * 0.5,
    envMapIntensity: 1.3,
    tint: 0xd2d8de,
    yieldImpulse: 1560, shearImpulse: 5200, ductility: 0.22,
    hardness: 1.0, sparkYield: 1.6, heatCapacity: 1.0,
  },
  aluminium: {
    texture: 'aluminum',
    density: 2700,
    roughness: 0.34, metalness: 1.0,
    anisotropy: 0.85, anisotropyRotation: 0,
    envMapIntensity: 1.2,
    tint: 0xdfe4e8,
    yieldImpulse: 160, shearImpulse: 520, ductility: 0.88,
    hardness: 0.24, sparkYield: 0.25, heatCapacity: 0.45,
  },
  castIron: {
    texture: 'castIron',
    density: 7200,
    roughness: 0.56, metalness: 1.0,
    anisotropy: 0.25, anisotropyRotation: 0,
    envMapIntensity: 0.95,
    tint: 0x8f9296,
    yieldImpulse: 950, shearImpulse: 1900, ductility: 0.08, // brittle: snaps early
    hardness: 0.9, sparkYield: 1.35, heatCapacity: 0.85,
  },
  galvanised: {
    texture: 'galvanized',
    density: 7850,
    roughness: 0.4, metalness: 1.0,
    anisotropy: 0.45, anisotropyRotation: Math.PI * 0.25,
    envMapIntensity: 1.25,
    tint: 0xc7cdd2,
    yieldImpulse: 400, shearImpulse: 1200, ductility: 0.72,
    hardness: 0.6, sparkYield: 0.8, heatCapacity: 0.75,
  },
  copper: {
    texture: 'copper',
    density: 8960,
    roughness: 0.3, metalness: 1.0,
    anisotropy: 0.6, anisotropyRotation: Math.PI * 0.5,
    envMapIntensity: 1.35,
    tint: 0xc98a5e,
    yieldImpulse: 240, shearImpulse: 720, ductility: 0.95,
    hardness: 0.3, sparkYield: 0.15, heatCapacity: 0.5,
  },
  paintedSteel: {
    texture: 'paintedSteel',
    density: 7850,
    roughness: 0.5, metalness: 1.0,
    anisotropy: 0.2, anisotropyRotation: 0,
    envMapIntensity: 1.0,
    clearcoat: 0.55, clearcoatRoughness: 0.42,
    tint: 0xffffff,
    yieldImpulse: 500, shearImpulse: 1600, ductility: 0.66,
    hardness: 0.66, sparkYield: 0.85, heatCapacity: 0.8,
  },
  rustedSteel: {
    texture: 'rustedSteel',
    density: 7600,
    roughness: 0.78, metalness: 1.0,
    anisotropy: 0.15, anisotropyRotation: 0,
    envMapIntensity: 0.8,
    tint: 0xa08272,
    yieldImpulse: 320, shearImpulse: 950, ductility: 0.3,
    hardness: 0.55, sparkYield: 0.55, heatCapacity: 0.7,
  },
};

const materialCache = new Map();
const textureCache = new Map();
let sharedEnvMap = null;

export function setEnvironmentMap(envMap) {
  sharedEnvMap = envMap;
  for (const mat of materialCache.values()) {
    mat.envMap = envMap;
    mat.needsUpdate = true;
  }
}

function getTextures(spec, quality) {
  const size = quality === 'low' ? 256 : quality === 'medium' ? 512 : 1024;
  const key = `${spec.texture}:${size}`;
  let set = textureCache.get(key);
  if (!set) {
    set = createMetalTextureSet(spec.texture, {
      size,
      seed: hashString(spec.texture),
      // ScrapLibrary lays down 1.4 uv per metre, so this puts one texture
      // tile every ~20 cm of real surface.
      repeat: [3.5, 3.5],
    });
    textureCache.set(key, set);
  }
  return set;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/**
 * Shared, heat-enabled physical material for a library entry.
 * Fragments reuse the parent material so slicing never adds a draw-call batch.
 */
export function getMetalMaterial(name, quality = 'high') {
  const key = `${name}:${quality}`;
  const cached = materialCache.get(key);
  if (cached) return cached;

  const spec = MATERIAL_LIBRARY[name] || MATERIAL_LIBRARY.mildSteel;
  const tex = getTextures(spec, quality);

  const mat = new THREE.MeshPhysicalMaterial({
    color: spec.tint,
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    metalnessMap: tex.metalnessMap,
    aoMap: tex.aoMap,
    // The generated maps encode ABSOLUTE roughness/metalness per preset.
    // three multiplies map * scalar, so the scalars must stay at 1.0 —
    // anything lower drives scratch texels into mirror-polish territory and
    // the surface breaks up into blown-out white streaks.
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: spec.envMapIntensity,
    normalScale: new THREE.Vector2(0.85, 0.85),
    aoMapIntensity: 0.85,
    emissive: 0x000000,
    side: THREE.FrontSide,
    dithering: true,
  });

  // KHR-style anisotropic specular: this is what makes brushed steel read as
  // brushed steel instead of chrome under the studio HDRI.
  if (quality !== 'low') {
    mat.anisotropy = spec.anisotropy;
    mat.anisotropyRotation = spec.anisotropyRotation;
  }
  if (spec.clearcoat) {
    mat.clearcoat = spec.clearcoat;
    mat.clearcoatRoughness = spec.clearcoatRoughness;
  }
  if (sharedEnvMap) mat.envMap = sharedEnvMap;

  injectHeatShader(mat, { scorch: 1.0 });
  mat.userData.spec = spec;
  materialCache.set(key, mat);
  return mat;
}

export function getMaterialSpec(name) {
  return MATERIAL_LIBRARY[name] || MATERIAL_LIBRARY.mildSteel;
}

export function disposeMaterials() {
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
  for (const t of textureCache.values()) t.dispose?.();
  textureCache.clear();
}
