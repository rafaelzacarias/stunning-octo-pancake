import * as THREE from 'three';

/**
 * Per-vertex shear-heat channel.
 *
 * Freshly cut vertices are written with heat = 1.0; the shader maps this
 * through a black-body ramp so tear edges glow orange/white and feed the
 * selective bloom pass. Heat decays every frame like real thermal mass:
 * thin, high-conductivity metals (aluminium) shed it fast, cast iron holds it.
 *
 * The attribute is called `aHeat` and MUST exist on every geometry that uses
 * a metal material — call {@link ensureHeatAttribute} right after building or
 * slicing a geometry.
 */
export const HEAT_ATTRIBUTE = 'aHeat';

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [initial] value written to every vertex
 * @returns {THREE.BufferAttribute} the heat attribute
 */
export function ensureHeatAttribute(geometry, initial = 0) {
  const count = geometry.getAttribute('position')?.count ?? 0;
  let attr = geometry.getAttribute(HEAT_ATTRIBUTE);
  if (attr && attr.count === count) return attr;

  const array = new Float32Array(count);
  if (initial !== 0) array.fill(initial);
  attr = new THREE.BufferAttribute(array, 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(HEAT_ATTRIBUTE, attr);
  return attr;
}

/**
 * Deposit heat on every vertex within `radius` of a world-space-agnostic
 * (i.e. already local) point. Used by the slicer at the cut seam and by the
 * deformer when teeth grind without separating the part.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Vector3} localPoint
 * @param {number} radius
 * @param {number} amount 0..1
 */
export function depositHeat(geometry, localPoint, radius, amount = 1) {
  const heat = ensureHeatAttribute(geometry);
  const pos = geometry.getAttribute('position');
  if (!pos) return;
  const r2 = radius * radius;
  const arr = heat.array;
  let touched = false;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - localPoint.x;
    const dy = pos.getY(i) - localPoint.y;
    const dz = pos.getZ(i) - localPoint.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    // Smooth falloff so heat blooms outward from the contact rather than
    // producing a hard-edged disc.
    const f = 1 - d2 / r2;
    const v = amount * f * f;
    if (v > arr[i]) {
      arr[i] = Math.min(1, v);
      touched = true;
    }
  }
  if (touched) heat.needsUpdate = true;
}

/**
 * Exponential cool-down towards ambient. Call once per frame per hot geometry.
 * @param {THREE.BufferGeometry} geometry
 * @param {number} dt seconds
 * @param {number} rate 1/s — higher = cools faster
 * @returns {boolean} true while any vertex is still measurably hot
 */
export function coolGeometry(geometry, dt, rate = 0.55) {
  const heat = geometry.getAttribute(HEAT_ATTRIBUTE);
  if (!heat) return false;
  const arr = heat.array;
  const k = Math.exp(-rate * dt);
  let hot = false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v <= 0.0005) {
      if (v !== 0) arr[i] = 0;
      continue;
    }
    arr[i] = v * k;
    hot = true;
  }
  heat.needsUpdate = true;
  return hot;
}
