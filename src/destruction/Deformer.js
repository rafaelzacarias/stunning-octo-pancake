import * as THREE from 'three';
import { depositHeat, ensureHeatAttribute } from '../materials/HeatAttribute.js';

/**
 * Plastic (permanent) deformation applied to a part BEFORE it actually shears.
 *
 * Real metal fed into a shear shredder bends, dents and necks before it
 * separates. This module pushes vertices around in place — denting under a
 * tooth tip and bending long stock gripped between two teeth — while tracking
 * accumulated plastic strain. When `state.strain` exceeds a metal's toughness
 * the {@link ShredderProcessor} takes over and slices the part.
 *
 * All methods mutate the geometry's `position` attribute in place and set
 * `needsUpdate`; per-vertex scratch is cached on the state object so a steady
 * shred does not allocate.
 *
 * @module Deformer
 */

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _lever = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

function smoothFalloff(t) {
  // t in [0,1]; classic smoothstep, 1 at centre -> 0 at edge.
  const s = 1 - t;
  return s * s * (3 - 2 * s);
}

export class Deformer {
  /**
   * Allocate per-body plastic state for a geometry.
   * @param {THREE.BufferGeometry} geometry
   * @returns {{strain:number, perVertex:Float32Array, touched:Uint8Array}}
   */
  static createState(geometry) {
    const count = geometry.getAttribute('position').count;
    return {
      strain: 0,
      perVertex: new Float32Array(count),
      touched: new Uint8Array(count)
    };
  }

  /**
   * Push vertices within `radius` of `localPoint` along `localDir`, forming a
   * dent with a compensating bulge ring so volume is roughly preserved. Only
   * the touched region has its normals recomputed. Heat and plastic strain are
   * deposited.
   *
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Vector3} localPoint dent centre (geometry-local)
   * @param {THREE.Vector3} localDir push direction (geometry-local)
   * @param {number} radius
   * @param {number} depth metres of indentation
   * @param {object} [state] per-body plastic state (from {@link createState})
   * @returns {number} the strain increment applied
   */
  static dent(geometry, localPoint, localDir, radius, depth, state) {
    const pos = geometry.getAttribute('position');
    if (!pos || radius <= 0) return 0;
    if (state && state.touched.length !== pos.count) {
      state.perVertex = new Float32Array(pos.count);
      state.touched = new Uint8Array(pos.count);
    }
    _dir.copy(localDir);
    if (_dir.lengthSq() < 1e-9) _dir.set(0, -1, 0);
    _dir.normalize();

    const r2 = radius * radius;
    const bulgeR = radius * 1.4;
    const bulgeR2 = bulgeR * bulgeR;
    const touched = state ? state.touched : null;
    if (touched) touched.fill(0);

    let strainDelta = 0;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const dx = px - localPoint.x;
      const dy = py - localPoint.y;
      const dz = pz - localPoint.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 <= r2) {
        const f = smoothFalloff(Math.sqrt(d2) / radius);
        const push = depth * f;
        pos.setXYZ(i, px + _dir.x * push, py + _dir.y * push, pz + _dir.z * push);
        if (touched) touched[i] = 1;
        if (state) {
          const add = f * depth * 6;
          state.perVertex[i] = Math.min(1, state.perVertex[i] + add);
          strainDelta += add;
        }
      } else if (d2 <= bulgeR2) {
        // Ring just outside the dent bulges opposite to the push (volume-ish).
        const dd = Math.sqrt(d2);
        const ring = (bulgeR - dd) / (bulgeR - radius);
        const push = -depth * 0.22 * ring;
        pos.setXYZ(i, px + _dir.x * push, py + _dir.y * push, pz + _dir.z * push);
        if (touched) touched[i] = 1;
      }
    }

    pos.needsUpdate = true;
    if (touched) recomputeTouchedNormals(geometry, touched);
    depositHeat(geometry, localPoint, radius * 1.1, Math.min(1, depth * 12));

    if (state) {
      strainDelta /= pos.count > 0 ? Math.max(8, pos.count * 0.05) : 1;
      state.strain = Math.min(1, state.strain + strainDelta);
    }
    return strainDelta;
  }

  /**
   * Bend a long part about a hinge line — the plastic response to being gripped
   * between two teeth. Vertices on the positive side of the hinge (along the
   * lever direction) rotate about `hingeAxis` by up to `angle`, scaled by how
   * far past yield the applied moment is.
   *
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Vector3} hingePoint local pivot
   * @param {THREE.Vector3} hingeAxis local rotation axis (unit)
   * @param {THREE.Vector3} leverDir local direction along the free arm
   * @param {number} angle maximum bend angle (radians)
   * @param {object} [state]
   * @returns {number} strain increment
   */
  static bend(geometry, hingePoint, hingeAxis, leverDir, angle, state) {
    const pos = geometry.getAttribute('position');
    if (!pos || Math.abs(angle) < 1e-4) return 0;
    _axis.copy(hingeAxis).normalize();
    _lever.copy(leverDir).normalize();

    // Half-extent of the free arm, for a graded (not rigid) bend.
    let maxLever = 1e-4;
    for (let i = 0; i < pos.count; i++) {
      _rel.set(pos.getX(i) - hingePoint.x, pos.getY(i) - hingePoint.y, pos.getZ(i) - hingePoint.z);
      const l = _rel.dot(_lever);
      if (l > maxLever) maxLever = l;
    }

    let strainDelta = 0;
    for (let i = 0; i < pos.count; i++) {
      _rel.set(pos.getX(i) - hingePoint.x, pos.getY(i) - hingePoint.y, pos.getZ(i) - hingePoint.z);
      const l = _rel.dot(_lever);
      if (l <= 0) continue;
      const frac = l / maxLever;
      _q.setFromAxisAngle(_axis, angle * frac);
      _rel.applyQuaternion(_q);
      pos.setXYZ(i, hingePoint.x + _rel.x, hingePoint.y + _rel.y, hingePoint.z + _rel.z);
      if (state) {
        const add = Math.abs(angle) * frac * 0.08;
        state.perVertex[i] = Math.min(1, state.perVertex[i] + add);
        strainDelta += add;
      }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    ensureHeatAttribute(geometry);
    depositHeat(geometry, hingePoint, maxLever * 0.35, Math.min(1, Math.abs(angle)));

    if (state) {
      strainDelta /= Math.max(8, pos.count * 0.1);
      state.strain = Math.min(1, state.strain + strainDelta);
    }
    return strainDelta;
  }
}

/**
 * Recompute vertex normals for the sub-set of vertices flagged in `touched`,
 * leaving the rest of the mesh untouched. Handles indexed + non-indexed input.
 * @param {THREE.BufferGeometry} geometry
 * @param {Uint8Array} touched
 */
function recomputeTouchedNormals(geometry, touched) {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  if (!nrm) {
    geometry.computeVertexNormals();
    return;
  }
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;

  // Zero the normals of touched vertices only.
  for (let i = 0; i < touched.length; i++) {
    if (touched[i]) nrm.setXYZ(i, 0, 0, 0);
  }

  for (let t = 0; t < triCount; t++) {
    let a;
    let b;
    let c;
    if (index) {
      a = index.getX(t * 3);
      b = index.getX(t * 3 + 1);
      c = index.getX(t * 3 + 2);
    } else {
      a = t * 3;
      b = t * 3 + 1;
      c = t * 3 + 2;
    }
    if (!touched[a] && !touched[b] && !touched[c]) continue;

    _e1.set(pos.getX(b) - pos.getX(a), pos.getY(b) - pos.getY(a), pos.getZ(b) - pos.getZ(a));
    _e2.set(pos.getX(c) - pos.getX(a), pos.getY(c) - pos.getY(a), pos.getZ(c) - pos.getZ(a));
    _fn.copy(_e1).cross(_e2);

    if (touched[a]) nrm.setXYZ(a, nrm.getX(a) + _fn.x, nrm.getY(a) + _fn.y, nrm.getZ(a) + _fn.z);
    if (touched[b]) nrm.setXYZ(b, nrm.getX(b) + _fn.x, nrm.getY(b) + _fn.y, nrm.getZ(b) + _fn.z);
    if (touched[c]) nrm.setXYZ(c, nrm.getX(c) + _fn.x, nrm.getY(c) + _fn.y, nrm.getZ(c) + _fn.z);
  }

  for (let i = 0; i < touched.length; i++) {
    if (!touched[i]) continue;
    _tmp.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (_tmp.lengthSq() > 1e-12) _tmp.normalize();
    else _tmp.set(0, 1, 0);
    nrm.setXYZ(i, _tmp.x, _tmp.y, _tmp.z);
  }
  nrm.needsUpdate = true;
}
