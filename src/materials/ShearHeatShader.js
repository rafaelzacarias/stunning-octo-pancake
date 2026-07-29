import * as THREE from 'three';
import { LAYER } from '../core/Constants.js';

/**
 * Shear-heat emissive injection for any {@link THREE.MeshPhysicalMaterial}.
 *
 * Reads the per-vertex `attribute float aHeat` (0..1, written by the slicer at
 * the tear seam — see {@link module:materials/HeatAttribute}) and the optional
 * `attribute float aCut` (1 on freshly separated faces) and:
 *
 *  - Maps heat through a physically-plausible black-body ramp
 *    (dark cherry -> orange -> yellow -> white-hot) with emissive intensity
 *    rising ~T^4 so hot edges blow out into the selective-bloom pass.
 *  - Adds a sub-surface glow bleed a few millimetres in from the tear edge, an
 *    animated heat shimmer (fragment normal perturbation + scrolling noise) and
 *    a straw/blue temper-oxide ring just outside the glowing band.
 *  - Roughens (and slightly de-metals) the surface where `aCut == 1` — a torn
 *    edge is matte and crystalline, never a mirror.
 *  - Exposes `uBloomPass`: when the selective-bloom pre-pass sets it to 1 the
 *    fragment outputs ONLY the emissive heat contribution (everything else is
 *    black), which is exactly what the bloom mask needs.
 *
 * Missing attributes degrade gracefully: an absent `aHeat`/`aCut` vertex
 * attribute is supplied by WebGL as 0, so the shader always compiles and simply
 * produces no heat.
 *
 * @module materials/ShearHeatShader
 */

/** Live registry so {@link updateShearHeatTime} can tick every instance at once. */
const REGISTRY = new Set();

const VERT_HEAD = /* glsl */ `
attribute float aHeat;
attribute float aCut;
varying float vHeat;
varying float vCut;
varying vec3 vShPos;
uniform float uTime;
`;

const FRAG_HEAD = /* glsl */ `
varying float vHeat;
varying float vCut;
varying vec3 vShPos;
uniform float uTime;
uniform float uBloomPass;
uniform float uHeatGain;
uniform float uOxideStrength;
uniform float uShimmer;

// Cheap hash noise for the shimmer band.
float shHash(vec2 p){
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float shNoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = shHash(i);
  float b = shHash(i + vec2(1.0, 0.0));
  float c = shHash(i + vec2(0.0, 1.0));
  float d = shHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Black-body-ish ramp: dark cherry red -> orange -> yellow -> white.
vec3 blackBody(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 cherry = vec3(0.35, 0.02, 0.0);
  vec3 orange = vec3(1.0, 0.22, 0.02);
  vec3 yellow = vec3(1.0, 0.72, 0.18);
  vec3 white  = vec3(1.0, 0.98, 0.92);
  vec3 c = mix(cherry, orange, smoothstep(0.0, 0.35, t));
  c = mix(c, yellow, smoothstep(0.3, 0.7, t));
  c = mix(c, white, smoothstep(0.65, 1.0, t));
  return c;
}
`;

/**
 * Apply the shear-heat injection to a physical material (idempotent).
 *
 * @param {THREE.MeshPhysicalMaterial} material
 * @param {Object} [opts]
 * @param {number} [opts.heatGain=6]      emissive multiplier at white-hot
 * @param {number} [opts.oxideStrength=1] temper-colour ring intensity
 * @param {number} [opts.shimmer=1]       heat-shimmer intensity
 * @param {number} [opts.cutRoughness=0.4] roughness added on torn faces
 * @returns {THREE.MeshPhysicalMaterial} the same material, for chaining
 */
export function applyShearHeat(material, opts = {}) {
  if (material.userData && material.userData.shearHeat) return material;

  const uniforms = {
    uTime: { value: 0 },
    uBloomPass: { value: 0 },
    uHeatGain: { value: opts.heatGain ?? 6 },
    uOxideStrength: { value: opts.oxideStrength ?? 1 },
    uShimmer: { value: opts.shimmer ?? 1 }
  };
  const cutRoughness = opts.cutRoughness ?? 0.4;

  const prevOnBeforeCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prevOnBeforeCompile === 'function') {
      prevOnBeforeCompile.call(material, shader, renderer);
    }
    Object.assign(shader.uniforms, uniforms);

    /* ---- vertex ---- */
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vHeat = aHeat;
        vCut = aCut;
        vShPos = position.xyz;
        // Sub-millimetre thermal expansion / shimmer on the hottest band.
        float shHeatV = vHeat * vHeat;
        transformed += objectNormal * shHeatV * 0.0016 *
          (0.6 + 0.4 * sin(uTime * 26.0 + position.y * 40.0));
        `
      );

    /* ---- fragment ---- */
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + vCut * ${cutRoughness.toFixed(3)}, 0.04, 1.0);
        `
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
        #include <metalnessmap_fragment>
        metalnessFactor *= (1.0 - 0.28 * vCut);
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        if (vHeat > 0.02) {
          float shBand = shNoise(vShPos.xz * 26.0 + vec2(0.0, uTime * 3.0));
          float shAmt = vHeat * uShimmer * 0.08;
          normal = normalize(normal + vec3((shBand - 0.5) * shAmt, (shNoise(vShPos.xz * 22.0 - uTime * 2.0) - 0.5) * shAmt, 0.0));
        }
        `
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        // Glow bleed: conduct heat a little inward from the very tear edge.
        float shHeat = clamp(vHeat * 1.05, 0.0, 1.0);
        float shGlow = shHeat * shHeat;                     // sub-surface falloff
        float shEmitT = pow(shHeat, 1.6);                    // perceptual ramp
        vec3 shColor = blackBody(shEmitT);
        // Super-linear (~T^4) intensity so hot edges bloom out.
        float shIntensity = uHeatGain * pow(shHeat, 4.0) + 1.4 * shGlow;
        // Animated flicker as gas/plasma boils off the cut.
        float shFlicker = 0.88 + 0.12 * shNoise(vShPos.xz * 9.0 + uTime * 5.0);
        vec3 shEmissive = shColor * shIntensity * shFlicker;
        // Straw/blue temper-oxide ring just OUTSIDE the glowing zone.
        float shRing = smoothstep(0.08, 0.28, shHeat) * (1.0 - smoothstep(0.32, 0.6, shHeat));
        vec3 shOxide = mix(vec3(0.55, 0.42, 0.14), vec3(0.16, 0.22, 0.55),
          shNoise(vShPos.xz * 6.0));
        totalEmissiveRadiance += shEmissive;
        `
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        // Temper-oxide darkening ring applied to the lit surface colour.
        diffuseColor.rgb = mix(diffuseColor.rgb, shOxide, shRing * uOxideStrength * 0.6);
        #include <opaque_fragment>
        // Selective-bloom pre-pass: output ONLY the emissive heat.
        if (uBloomPass > 0.5) {
          gl_FragColor = vec4(shEmissive, diffuseColor.a);
        }
        `
      );

    material.userData.shearHeatShader = shader;
  };

  // Force a unique program per material so each keeps its own uniform values
  // (materials that share an onBeforeCompile program otherwise share uniforms).
  const cacheKey = `shearHeat-${material.uuid}`;
  material.customProgramCacheKey = () => cacheKey;
  material.defines = material.defines || {};
  material.defines.USE_SHEAR_HEAT = '';
  material.userData = material.userData || {};
  material.userData.shearHeat = { uniforms };
  material.needsUpdate = true;

  REGISTRY.add(material);
  return material;
}

/**
 * Advance the animated time uniform on every live shear-heat material.
 * @param {number} time seconds (monotonic)
 */
export function updateShearHeatTime(time) {
  for (const mat of REGISTRY) {
    const sh = mat.userData && mat.userData.shearHeat;
    if (sh) sh.uniforms.uTime.value = time;
  }
}

/**
 * Toggle the bloom-mask output on every live shear-heat material. Called by the
 * selective-bloom pre-pass (1 before rendering the mask, 0 after).
 * @param {boolean} on
 */
export function setShearHeatBloomPass(on) {
  const v = on ? 1 : 0;
  for (const mat of REGISTRY) {
    const sh = mat.userData && mat.userData.shearHeat;
    if (sh) sh.uniforms.uBloomPass.value = v;
  }
}

/**
 * Flag a mesh (and its material) as a bloom participant so the selective-bloom
 * pass keeps its real material instead of blacking it out.
 * @param {THREE.Object3D} object
 */
export function enableBloomLayer(object) {
  object.layers.enable(LAYER.BLOOM);
}

/** Drop a material from the registry (call before disposing it). */
export function unregisterShearHeat(material) {
  REGISTRY.delete(material);
}
