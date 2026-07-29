import * as THREE from 'three';

/**
 * HeatShader — shared GLSL injection that gives every metal surface a
 * per-vertex incandescence channel.
 *
 * Geometry contract: each geometry carries two float attributes
 *   aHeat  — 0..1 peak temperature stamped at the moment of shearing
 *   aHeatT — the simulation time (seconds) at which it was stamped
 * The fragment shader reconstructs the cooling curve analytically, so glowing
 * tear edges cost zero CPU per frame no matter how many fragments exist.
 */

export const heatUniforms = {
  uTime: { value: 0 },
  uHeatDecay: { value: 1.05 },      // 1/s — Newtonian cooling rate
  uHeatIntensity: { value: 2.8 },   // sits above the bloom threshold (1.35)
  uHeatSpread: { value: 1.0 },
};

const BLACKBODY_GLSL = /* glsl */`
// Physically-motivated incandescence ramp: dull cherry -> orange -> straw ->
// white-hot, with a steep intensity curve so only genuinely hot metal blooms.
vec3 sio_blackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.32, 0.020, 0.002), vec3(0.95, 0.115, 0.004), smoothstep(0.00, 0.34, t));
  c = mix(c, vec3(1.00, 0.400, 0.040), smoothstep(0.30, 0.60, t));
  c = mix(c, vec3(1.00, 0.760, 0.290), smoothstep(0.56, 0.82, t));
  c = mix(c, vec3(1.00, 0.960, 0.860), smoothstep(0.80, 1.00, t));
  float power = t * t * (0.35 + 0.65 * t);
  return c * power;
}
`;

/**
 * Patch a MeshStandardMaterial/MeshPhysicalMaterial.
 *
 * @param {THREE.Material} material
 * @param {object} opts
 *   heat            include the incandescence channel (needs aHeat/aHeatT attrs)
 *   roughnessFloor  minimum roughness after the map is sampled. Authored
 *                   scratch texels can sit as low as 0.08, which on a fully
 *                   metallic surface is a mirror and turns every scratch into
 *                   a blown-out white glint under a studio probe.
 *   scorch          strength of the oxidised darkening around a cut
 */
export function patchMetalShader(material, opts = {}) {
  if (material.userData.__metalPatched) return material;
  material.userData.__metalPatched = true;

  const heat = opts.heat !== false;
  const roughnessFloor = opts.roughnessFloor ?? 0.16;
  const localScorch = { value: opts.scorch ?? 1.0 };
  material.userData.heatLocal = localScorch;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRoughFloor = { value: roughnessFloor };

    if (!heat) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n        uniform float uRoughFloor;')
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n        roughnessFactor = max(roughnessFactor, uRoughFloor);');
      return;
    }

    shader.uniforms.uTime = heatUniforms.uTime;
    shader.uniforms.uHeatDecay = heatUniforms.uHeatDecay;
    shader.uniforms.uHeatIntensity = heatUniforms.uHeatIntensity;
    shader.uniforms.uHeatSpread = heatUniforms.uHeatSpread;
    shader.uniforms.uScorch = localScorch;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aHeat;
        attribute float aHeatT;
        uniform float uTime;
        uniform float uHeatDecay;
        varying float vHeat;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        float _age = max(uTime - aHeatT, 0.0);
        // Two-term cooling: fast radiative drop, slow conductive tail.
        float _cool = 0.78 * exp(-_age * uHeatDecay * 2.2) + 0.22 * exp(-_age * uHeatDecay * 0.45);
        vHeat = aHeat * _cool;
        // Thermal expansion micro-bulge on the freshly sheared rim.
        transformed += normal * vHeat * 0.0016;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uHeatIntensity;
        uniform float uHeatSpread;
        uniform float uScorch;
        uniform float uRoughFloor;
        varying float vHeat;
        ${BLACKBODY_GLSL}
      `)
      // Hot metal loses its polish: oxidised, darker, rougher, non-metallic.
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        roughnessFactor = max(roughnessFactor, uRoughFloor);
        roughnessFactor = mix(roughnessFactor, 0.88, clamp(vHeat * 1.15, 0.0, 1.0) * uScorch);
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        #include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.18, clamp(vHeat * 1.3, 0.0, 1.0) * uScorch);
      `)
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        // Blue-black heat tint bleeding outward from the cut.
        float _scorchMask = clamp(vHeat * 2.4, 0.0, 1.0) * uScorch;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.30, 0.26, 0.30), _scorchMask * 0.7);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        float _h = clamp(vHeat * uHeatSpread, 0.0, 1.0);
        totalEmissiveRadiance += sio_blackbody(_h) * uHeatIntensity;
      `);
  };

  // Distinct cache key so patched/unpatched variants never share a program.
  const baseKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () =>
    `sioMetal|${heat ? 'h' : '-'}|${roughnessFloor}|${baseKey ? baseKey() : material.type}`;
  return material;
}

/** Back-compat alias: heat-enabled patch. */
export function injectHeatShader(material, opts = {}) {
  return patchMetalShader(material, { ...opts, heat: true });
}

/**
 * Guarantee the heat attributes exist. Called for every scrap/fragment
 * geometry before it is handed to a heat-patched material.
 */
export function ensureHeatAttributes(geometry, initialHeat = 0, time = -1000) {
  const count = geometry.attributes.position.count;
  if (!geometry.attributes.aHeat || geometry.attributes.aHeat.count !== count) {
    const heat = new Float32Array(count);
    const heatT = new Float32Array(count);
    heat.fill(initialHeat);
    heatT.fill(time);
    geometry.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1));
    geometry.setAttribute('aHeatT', new THREE.BufferAttribute(heatT, 1));
  }
  return geometry;
}

/**
 * Stamp heat into an existing geometry within a world-space radius of a point.
 * Used for grinding contact that does not (yet) split the mesh.
 */
export function stampHeat(mesh, worldPoint, radius, amount, time) {
  const geo = mesh.geometry;
  const aHeat = geo.attributes.aHeat;
  const aHeatT = geo.attributes.aHeatT;
  if (!aHeat) return;

  // Cheap rejection before touching any vertex data.
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  const bs = geo.boundingSphere;

  const local = _stampV.copy(worldPoint);
  mesh.worldToLocal(local);
  if (bs && local.distanceTo(bs.center) > bs.radius + radius) return;

  // Direct typed-array access: this runs on every grinding contact, and the
  // BufferAttribute accessor overhead is measurable at that rate.
  const pos = geo.attributes.position.array;
  const heat = aHeat.array;
  const heatT = aHeatT.array;
  const count = aHeat.count;
  const r2 = radius * radius;
  const lx = local.x, ly = local.y, lz = local.z;
  let touched = false;

  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const dx = pos[o] - lx;
    const dy = pos[o + 1] - ly;
    const dz = pos[o + 2] - lz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const falloff = 1 - Math.sqrt(d2) / radius;
    const v = amount * falloff * falloff;
    if (v <= heat[i] * 0.6) continue;
    if (v > heat[i]) heat[i] = v > 1 ? 1 : v;
    heatT[i] = time;
    touched = true;
  }
  if (touched) { aHeat.needsUpdate = true; aHeatT.needsUpdate = true; }
}

const _stampV = /* @__PURE__ */ new THREE.Vector3();

export function updateHeatTime(t) {
  heatUniforms.uTime.value = t;
}
