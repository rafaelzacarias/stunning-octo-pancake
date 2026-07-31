import * as THREE from 'three';
import { createMetalTextureSet } from './ProceduralTextures.js';
import { patchMetalShader } from './HeatShader.js';

/**
 * Physical material library. Every entry carries both its render description
 * and the mechanical constants the destruction solver needs, so "aluminium"
 * means one thing across graphics, physics and audio.
 *
 * Mechanical contract:
 *   shearImpulse   N·s at the teeth before the section lets go. The solver
 *                  derives `toughness = max(0.25, shearImpulse / 1200)`, so
 *                  LOWER shreds FASTER.
 *   yieldImpulse   advisory only in the current model.
 *   ductility      0..1 — dent/bend amplitude and how ragged a torn edge is.
 *   hardness       0..1 — audio timbre.
 *   sparkYield     0..1.6 — spark count. NON-METALS ARE ZERO.
 *   shatter        0..1 — tendency to burst into many pieces at once rather
 *                  than shear cleanly along the tooth path.
 *   fragmentScale  multiplier on the minimum surviving fragment volume;
 *                  below 1 keeps smaller debris alive as real bodies.
 *
 * Render contract: the generated roughness/metalness maps are ABSOLUTE, so
 * `getMetalMaterial` pins both scalars and never scales them down. Entries
 * flagged `dielectric` get metalness 0 and no metalness map at all.
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
    shatter: 0.08, fragmentScale: 1.0,
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
    shatter: 0.06, fragmentScale: 1.0,
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
    shatter: 0.04, fragmentScale: 1.0,
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
    shatter: 0.45, fragmentScale: 0.9,
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
    shatter: 0.1, fragmentScale: 1.0,
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
    shatter: 0.02, fragmentScale: 1.0,
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
    shatter: 0.1, fragmentScale: 1.0,
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
    shatter: 0.2, fragmentScale: 1.0,
  },

  /* ------------------------------------------------- consumer-goods set */

  /* Screen / door / turntable glass. Reads as a real panel: a sharp
   * clearcoat lobe over a near-black smoked body with genuine transmission.
   * Almost no ductility, the lowest shear resistance in the library, and it
   * bursts rather than tears — hence shatter 1.0 and the smallest surviving
   * fragment volume of anything here. */
  glass: {
    texture: 'glass',
    textureRepeat: [1.6, 1.6],
    density: 2500,
    dielectric: true,
    roughness: 0.06, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 1.5,
    tint: 0xdfeae8,
    transmission: 0.45, ior: 1.52, thicknessMeters: 0.006,
    clearcoat: 0.85, clearcoatRoughness: 0.05,
    doubleSided: true,
    normalScale: 0.35, roughnessFloor: 0.12, scorch: 0.3,
    yieldImpulse: 200, shearImpulse: 260, ductility: 0.02,
    hardness: 0.85, sparkYield: 0.0, heatCapacity: 0.35,
    shatter: 1.0, fragmentScale: 0.18,
  },
  /* Textured black ABS: bezels, control panels, stands. Moulded pebble
   * grain, a whisper of clearcoat, no metalness map anywhere near it. */
  abs: {
    texture: 'abs',
    textureRepeat: [4.5, 4.5],
    density: 1050,
    dielectric: true,
    roughness: 0.44, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 1.0,
    tint: 0xffffff,
    clearcoat: 0.25, clearcoatRoughness: 0.5,
    normalScale: 1.0, roughnessFloor: 0.18, scorch: 0.3,
    yieldImpulse: 260, shearImpulse: 600, ductility: 0.25,
    hardness: 0.35, sparkYield: 0.0, heatCapacity: 0.25,
    shatter: 0.55, fragmentScale: 0.7,
  },
  /* Tyre rubber and driver surrounds. Deliberately the toughest non-metal
   * in shear: it stretches, necks and drags on the teeth for a long time
   * before it finally tears, and it never shatters or sparks. */
  rubber: {
    texture: 'rubber',
    textureRepeat: [6.0, 6.0],
    density: 1100,
    dielectric: true,
    roughness: 0.88, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 0.55,
    tint: 0xffffff,
    sheen: 0.25, sheenRoughness: 0.9,
    normalScale: 1.15, roughnessFloor: 0.3, scorch: 0.3,
    yieldImpulse: 900, shearImpulse: 2100, ductility: 0.98,
    hardness: 0.1, sparkYield: 0.0, heatCapacity: 0.3,
    shatter: 0.0, fragmentScale: 1.0,
  },
  /* Speaker cabinet: veneered MDF under satin lacquer. Splinters into
   * chunks along the board rather than bending. */
  mdf: {
    texture: 'mdf',
    textureRepeat: [2.2, 2.2],
    density: 750,
    dielectric: true,
    roughness: 0.36, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 0.9,
    tint: 0xffffff,
    clearcoat: 0.35, clearcoatRoughness: 0.28,
    normalScale: 0.9, roughnessFloor: 0.16, scorch: 0.3,
    yieldImpulse: 300, shearImpulse: 700, ductility: 0.15,
    hardness: 0.2, sparkYield: 0.0, heatCapacity: 0.2,
    shatter: 0.7, fragmentScale: 0.6,
  },
  /* Populated circuit board. The one "non-metal" that keeps a metalness
   * map: its tinned pads are real solder and are what allow the token
   * 0.1 spark yield. The laminate itself is glass-epoxy and disintegrates. */
  pcb: {
    texture: 'pcb',
    textureRepeat: [5.0, 5.0],
    density: 1900,
    roughness: 0.3, metalness: 1.0,
    anisotropy: 0,
    envMapIntensity: 1.0,
    tint: 0xffffff,
    normalScale: 1.0, roughnessFloor: 0.14, scorch: 0.3,
    yieldImpulse: 160, shearImpulse: 350, ductility: 0.06,
    hardness: 0.45, sparkYield: 0.1, heatCapacity: 0.25,
    shatter: 0.85, fragmentScale: 0.3,
  },
  /* Bright cast aluminium wheel rim: lacquered, machined faces, ductile
   * enough to fold before it finally parts. */
  alloy: {
    texture: 'alloy',
    textureRepeat: [3.0, 3.0],
    density: 2700,
    roughness: 0.3, metalness: 1.0,
    anisotropy: 0.5, anisotropyRotation: 0,
    envMapIntensity: 1.3,
    tint: 0xe6eaee,
    clearcoat: 0.18, clearcoatRoughness: 0.26,
    normalScale: 0.85, roughnessFloor: 0.24, scorch: 1.0,
    yieldImpulse: 520, shearImpulse: 1500, ductility: 0.75,
    hardness: 0.4, sparkYield: 0.4, heatCapacity: 0.45,
    shatter: 0.05, fragmentScale: 1.0,
  },
  /* White-enamelled appliance sheet steel. Thin, ductile, folds and tears
   * like a beer can with a paint film on it. */
  applianceSteel: {
    texture: 'applianceSteel',
    textureRepeat: [2.6, 2.6],
    density: 7850,
    roughness: 0.34, metalness: 1.0,
    anisotropy: 0.15, anisotropyRotation: 0,
    envMapIntensity: 1.05,
    tint: 0xffffff,
    clearcoat: 0.6, clearcoatRoughness: 0.28,
    normalScale: 0.8, roughnessFloor: 0.16, scorch: 0.9,
    yieldImpulse: 380, shearImpulse: 1100, ductility: 0.7,
    hardness: 0.62, sparkYield: 0.8, heatCapacity: 0.8,
    shatter: 0.1, fragmentScale: 1.0,
  },
  /* Sintered ceramic magnet. Hard, dense, utterly brittle: it explodes into
   * dark grit the moment a tooth loads it, and being a ceramic it cannot
   * spark no matter how hard it is. */
  ferrite: {
    texture: 'ferrite',
    textureRepeat: [5.0, 5.0],
    density: 4900,
    dielectric: true,
    roughness: 0.56, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 0.7,
    tint: 0xffffff,
    normalScale: 1.0, roughnessFloor: 0.25, scorch: 0.3,
    yieldImpulse: 260, shearImpulse: 400, ductility: 0.04,
    hardness: 0.95, sparkYield: 0.0, heatCapacity: 0.4,
    shatter: 0.9, fragmentScale: 0.35,
  },

  /* --------------------------------------- housewares / tools / office */

  /* Decorative chrome plate over steel: toaster shells, chair columns,
   * wrench flats. Bright enough that the roughness floor has to be held at
   * 0.24 — at 0.16 the scratch texels reach mirror polish and the surface
   * breaks out in white specular confetti. */
  chrome: {
    texture: 'chrome',
    textureRepeat: [3.2, 3.2],
    density: 7800,
    roughness: 0.25, metalness: 1.0,
    anisotropy: 0.3, anisotropyRotation: 0,
    envMapIntensity: 1.45,
    tint: 0xeef2f6,
    clearcoat: 0.3, clearcoatRoughness: 0.14,
    normalScale: 0.7, roughnessFloor: 0.24, scorch: 1.0,
    yieldImpulse: 380, shearImpulse: 1200, ductility: 0.55,
    hardness: 0.85, sparkYield: 1.3, heatCapacity: 0.95,
    shatter: 0.15, fragmentScale: 0.9,
  },
  /* Nichrome heating element ribbon. Thin, already embrittled by a few
   * thousand thermal cycles, so it lets go early and comes apart into short
   * lengths rather than folding. */
  nichrome: {
    texture: 'nichrome',
    textureRepeat: [4.0, 4.0],
    density: 8400,
    roughness: 0.52, metalness: 1.0,
    anisotropy: 0.35, anisotropyRotation: Math.PI * 0.5,
    envMapIntensity: 0.85,
    tint: 0x9d968c,
    normalScale: 1.0, roughnessFloor: 0.2, scorch: 1.0,
    yieldImpulse: 220, shearImpulse: 700, ductility: 0.35,
    hardness: 0.7, sparkYield: 0.9, heatCapacity: 0.6,
    shatter: 0.35, fragmentScale: 0.5,
  },
  /* Enamelled magnet wire wound on a stator. Mechanically it behaves like
   * a rope of soft copper: it necks, stretches and drags off the core in
   * long strands, and it barely sparks at all. */
  copperWinding: {
    texture: 'copperWinding',
    textureRepeat: [3.6, 3.6],
    density: 8900,
    roughness: 0.29, metalness: 1.0,
    anisotropy: 0.7, anisotropyRotation: Math.PI * 0.5,
    envMapIntensity: 1.2,
    tint: 0xc98a4e,
    clearcoat: 0.22, clearcoatRoughness: 0.3,
    normalScale: 0.95, roughnessFloor: 0.18, scorch: 1.0,
    yieldImpulse: 170, shearImpulse: 500, ductility: 0.95,
    hardness: 0.28, sparkYield: 0.1, heatCapacity: 0.5,
    shatter: 0.02, fragmentScale: 0.8,
  },
  /* Brittle white/beige injection moulding: garden furniture, keycaps,
   * castors, appliance end caps. The most explosive material in the
   * library — it bursts into a cloud of small sharp shards, hence the
   * 0.22 fragment floor that keeps those shards alive as real bodies. */
  hardPlastic: {
    texture: 'hardPlastic',
    textureRepeat: [4.0, 4.0],
    density: 1150,
    dielectric: true,
    roughness: 0.42, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 0.95,
    tint: 0xffffff,
    clearcoat: 0.2, clearcoatRoughness: 0.42,
    normalScale: 0.95, roughnessFloor: 0.16, scorch: 0.3,
    yieldImpulse: 190, shearImpulse: 450, ductility: 0.12,
    hardness: 0.4, sparkYield: 0.0, heatCapacity: 0.22,
    shatter: 0.9, fragmentScale: 0.22,
  },
  /* Upholstery / mesh weave. The single toughest thing here in shear: the
   * weave stretches, necks and wraps the teeth before it finally tears, and
   * it never shatters, never sparks and never keeps a crease. */
  fabric: {
    texture: 'fabric',
    textureRepeat: [3.0, 3.0],
    density: 400,
    dielectric: true,
    roughness: 0.86, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 0.5,
    tint: 0xffffff,
    sheen: 0.85, sheenRoughness: 0.75,
    normalScale: 1.2, roughnessFloor: 0.3, scorch: 0.3,
    yieldImpulse: 620, shearImpulse: 1500, ductility: 0.99,
    hardness: 0.05, sparkYield: 0.0, heatCapacity: 0.25,
    shatter: 0.0, fragmentScale: 1.0,
  },
  /* Solid timber tool handle. Splits along the grain: it barely bends, and
   * once a tooth is in it the whole handle lets go in long splinters. */
  wood: {
    texture: 'wood',
    textureRepeat: [2.0, 1.2],
    density: 700,
    dielectric: true,
    roughness: 0.48, metalness: 0.0,
    anisotropy: 0,
    envMapIntensity: 0.75,
    tint: 0xffffff,
    clearcoat: 0.15, clearcoatRoughness: 0.5,
    normalScale: 1.0, roughnessFloor: 0.18, scorch: 0.3,
    yieldImpulse: 300, shearImpulse: 800, ductility: 0.2,
    hardness: 0.3, sparkYield: 0.0, heatCapacity: 0.2,
    shatter: 0.5, fragmentScale: 0.55,
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
  // ScrapLibrary lays down 1.4 uv per metre, so the default puts one texture
  // tile every ~20 cm of real surface. Presets whose features have a real
  // physical size (circuit traces, tyre grain, veneer figure) override it.
  const repeat = spec.textureRepeat || [3.5, 3.5];
  const key = `${spec.texture}:${size}:${repeat[0]}x${repeat[1]}`;
  let set = textureCache.get(key);
  if (!set) {
    set = createMetalTextureSet(spec.texture, {
      size,
      seed: hashString(spec.texture),
      repeat,
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
  const dielectric = !!spec.dielectric;
  const ns = spec.normalScale !== undefined ? spec.normalScale : 0.85;

  const mat = new THREE.MeshPhysicalMaterial({
    color: spec.tint,
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    aoMap: tex.aoMap,
    // The generated maps encode ABSOLUTE roughness/metalness per preset.
    // three multiplies map * scalar, so the scalars must stay at 1.0 —
    // anything lower drives scratch texels into mirror-polish territory and
    // the surface breaks up into blown-out white streaks.
    roughness: 1.0,
    metalness: dielectric ? 0.0 : 1.0,
    envMapIntensity: spec.envMapIntensity,
    normalScale: new THREE.Vector2(ns, ns),
    aoMapIntensity: 0.85,
    emissive: 0x000000,
    side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    dithering: true,
  });

  // A dielectric gets NO metalness map at all. Pinning the scalar to 0 is
  // not enough on its own — an assigned map would still be sampled, and a
  // single stray bright texel turns glass or black plastic into chrome.
  if (!dielectric) mat.metalnessMap = tex.metalnessMap;

  // KHR-style anisotropic specular: this is what makes brushed steel read as
  // brushed steel instead of chrome under the studio HDRI.
  if (quality !== 'low' && spec.anisotropy) {
    mat.anisotropy = spec.anisotropy;
    mat.anisotropyRotation = spec.anisotropyRotation || 0;
  }
  if (spec.clearcoat) {
    mat.clearcoat = spec.clearcoat;
    mat.clearcoatRoughness = spec.clearcoatRoughness !== undefined ? spec.clearcoatRoughness : 0.3;
  }
  if (spec.sheen) {
    mat.sheen = spec.sheen;
    mat.sheenRoughness = spec.sheenRoughness !== undefined ? spec.sheenRoughness : 0.8;
  }
  // Transmission costs a whole extra scene pass, so only the materials that
  // genuinely have to read as glass opt in, and never at low quality.
  if (spec.transmission && quality !== 'low') {
    mat.transmission = spec.transmission;
    mat.thickness = spec.thicknessMeters !== undefined ? spec.thicknessMeters : 0.005;
  }
  if (spec.ior) mat.ior = spec.ior;
  if (spec.transparent) {
    mat.transparent = true;
    mat.opacity = spec.opacity !== undefined ? spec.opacity : 1.0;
  }
  if (sharedEnvMap) mat.envMap = sharedEnvMap;

  // Every material goes through the patch: it enables the shear-heat channel
  // and, just as importantly, clamps the authored roughness floor. Non-metals
  // char instead of glowing, so they run a much weaker scorch term.
  patchMetalShader(mat, {
    heat: true,
    roughnessFloor: spec.roughnessFloor !== undefined ? spec.roughnessFloor : 0.16,
    scorch: spec.scorch !== undefined ? spec.scorch : 1.0,
  });
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
