import * as THREE from 'three';

/**
 * Deformer — plastic flow for sheet and structural metal.
 *
 * Metal does not shatter on contact: it yields, dents, wrinkles and bends,
 * and only then does it shear. This module supplies the "before" half of that
 * story. Normals are re-derived analytically from the displacement gradient
 * rather than via computeVertexNormals(), so hard machined edges stay hard.
 */

const _v = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();

function smootherstep(x) {
  x = Math.min(1, Math.max(0, x));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function noise3(x, y, z) {
  let h = Math.imul(Math.round(x * 512) ^ 0x1b873593, 0xcc9e2d51);
  h = Math.imul(h ^ (Math.round(y * 512) + 0x85ebca6b), 0x1b873593);
  h = Math.imul(h ^ (Math.round(z * 512) + 0xc2b2ae35), 0xe6546b64);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/**
 * Press a dent into the geometry around a local-space contact.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Vector3} point   contact point, local space
 * @param {THREE.Vector3} dir     unit push direction, local space
 * @param {number} radius         influence radius (m)
 * @param {number} depth          peak displacement (m)
 * @param {object} opts  { lip, wrinkle, ductility }
 * @returns {number} the volume of metal actually moved (used for damage bookkeeping)
 */
export function plasticDent(geometry, point, dir, radius, depth, opts = {}) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const lip = opts.lip ?? 0.32;
  const wrinkle = opts.wrinkle ?? 0.28;
  const ductility = opts.ductility ?? 0.6;

  const r2 = radius * radius;
  let moved = 0;
  let touched = false;

  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(point);
    const d2 = _v.lengthSq();
    if (d2 > r2) continue;

    const d = Math.sqrt(d2);
    const t = d / radius;

    // Crater profile with a raised rim — sheet metal always throws up a lip.
    const core = smootherstep(1 - t);
    const rim = Math.max(0, Math.sin(t * Math.PI * 1.35)) * lip;
    const amount = depth * (core - rim);

    // Tangential (radial) component, used both for the lip flow and the
    // analytic normal tilt.
    const along = _v.dot(dir);
    _r.copy(_v).addScaledVector(dir, -along);
    const rLen = _r.length();
    if (rLen > 1e-6) _r.multiplyScalar(1 / rLen); else _r.set(0, 0, 0);

    let dx = dir.x * amount, dy = dir.y * amount, dz = dir.z * amount;

    // Material displaced by the dent has to go somewhere: push it outward.
    const flow = depth * core * ductility * 0.35;
    dx += _r.x * flow; dy += _r.y * flow; dz += _r.z * flow;

    // High-frequency crumple, scaled by how hard this vertex was worked.
    if (wrinkle > 0) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const w = depth * wrinkle * core;
      dx += noise3(px * 41, py * 41, pz * 41) * w;
      dy += noise3(px * 41 + 17, py * 41 + 17, pz * 41 + 17) * w;
      dz += noise3(px * 41 + 91, py * 41 + 91, pz * 41 + 91) * w;
    }

    pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
    moved += Math.abs(amount);
    touched = true;

    // Tilt the normal along the new slope instead of rebuilding the mesh's
    // normals (which would round off every machined corner).
    if (nrm) {
      const slope = depth * smootherstepDerivative(1 - t) / Math.max(radius, 1e-4);
      _n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      _n.addScaledVector(_r, slope * 0.85);
      _n.addScaledVector(dir, -slope * 0.12);
      _n.normalize();
      nrm.setXYZ(i, _n.x, _n.y, _n.z);
    }
  }

  if (touched) {
    pos.needsUpdate = true;
    if (nrm) nrm.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
  return moved;
}

function smootherstepDerivative(x) {
  x = Math.min(1, Math.max(0, x));
  return 30 * x * x * (x - 1) * (x - 1);
}

/**
 * Progressive bend about an axis — long stock folding as it is dragged in.
 *
 * @param {THREE.Vector3} origin  hinge point, local space
 * @param {THREE.Vector3} axis    unit hinge axis, local space
 * @param {THREE.Vector3} measure unit direction along which the bend ramps up
 * @param {number} angle          maximum rotation (rad) at reach
 * @param {number} reach          distance over which the bend develops (m)
 */
const _q = new THREE.Quaternion();
const _tmp = new THREE.Vector3();

export function plasticBend(geometry, origin, axis, measure, angle, reach) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  let touched = false;

  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    _tmp.copy(_v).sub(origin);
    const s = _tmp.dot(measure);
    if (s <= 0) continue;
    const k = smootherstep(Math.min(1, s / reach));
    if (k <= 0.0005) continue;

    _q.setFromAxisAngle(axis, angle * k);
    _tmp.applyQuaternion(_q).add(origin);
    pos.setXYZ(i, _tmp.x, _tmp.y, _tmp.z);

    if (nrm) {
      _n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyQuaternion(_q).normalize();
      nrm.setXYZ(i, _n.x, _n.y, _n.z);
    }
    touched = true;
  }

  if (touched) {
    pos.needsUpdate = true;
    if (nrm) nrm.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
  return touched;
}

/**
 * Uniform crush toward an axis — what the throat does to a can or a tube
 * before the teeth get a purchase on it.
 */
export function crush(geometry, axis, amount, center) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const c = center || new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(c);
    const along = _v.dot(axis);
    _v.addScaledVector(axis, -along * amount);
    // buckling ripples so it folds rather than simply scales
    const ripple = Math.sin(along * 46) * amount * 0.09;
    _r.copy(_v).addScaledVector(axis, -_v.dot(axis)).normalize();
    _v.addScaledVector(_r, ripple);
    _v.add(c);
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  pos.needsUpdate = true;
  if (nrm) {
    geometry.computeVertexNormals();
    nrm.needsUpdate = true;
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}
