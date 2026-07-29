import * as THREE from 'three';
import { ensureHeatAttribute, HEAT_ATTRIBUTE } from '../materials/HeatAttribute.js';

/**
 * Real-geometry shear splitting.
 *
 * {@link sliceGeometry} clips every triangle of a `BufferGeometry` against a
 * plane (given in the geometry's LOCAL space), interpolating all vertex
 * attributes across the cut, then caps the exposed section with a triangulated
 * polygon (ear clipping, multi-loop aware). Fresh cut vertices are tagged
 * `aHeat = 1` and `aCut = 1` for the shear-heat shader and given a little torn
 * jaggedness along the plane normal so shear edges do not look mirror-flat.
 *
 * @module MeshSlicer
 */

const EPS = 1e-6;
const CUT_ATTR = 'aCut';

/* Module-scope scratch — slices are budgeted and rare, but reuse avoids GC
 * pressure during a heavy shred. */
const _n = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _cross = new THREE.Vector3();

/**
 * @typedef {Object} SliceResult
 * @property {THREE.BufferGeometry|null} above  piece on the +normal side
 * @property {THREE.BufferGeometry|null} below  piece on the -normal side
 * @property {Array<number[]>|null} seam       raw seam segments (for debug)
 * @property {number} area                      total cap area (m^2)
 */

/**
 * Split a geometry by a plane.
 * @param {THREE.BufferGeometry} geometry local-space geometry
 * @param {THREE.Plane} plane local-space cut plane
 * @param {{jaggedness?:number, capHeat?:number}} [opts]
 * @returns {SliceResult}
 */
export function sliceGeometry(geometry, plane, opts = {}) {
  const jaggedness = opts.jaggedness ?? 0.0025;
  const capHeat = opts.capHeat ?? 1.0;

  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return { above: null, below: null, seam: null, area: 0 };

  // Attribute schema (position always present; aHeat / aCut always emitted).
  const names = [];
  const sizes = {};
  for (const name in geometry.attributes) {
    if (name === CUT_ATTR) continue;
    names.push(name);
    sizes[name] = geometry.attributes[name].itemSize;
  }
  if (!names.includes(HEAT_ATTRIBUTE)) {
    names.push(HEAT_ATTRIBUTE);
    sizes[HEAT_ATTRIBUTE] = 1;
  }
  names.push(CUT_ATTR);
  sizes[CUT_ATTR] = 1;

  const nx = plane.normal.x;
  const ny = plane.normal.y;
  const nz = plane.normal.z;
  const constant = plane.constant;

  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : posAttr.count / 3;

  // Quick reject: whole geometry on one side.
  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < posAttr.count; i++) {
    const d = nx * posAttr.getX(i) + ny * posAttr.getY(i) + nz * posAttr.getZ(i) + constant;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  if (minD >= -EPS) return { above: geometry, below: null, seam: null, area: 0 };
  if (maxD <= EPS) return { above: null, below: geometry, seam: null, area: 0 };

  const aboveB = new Builder(names, sizes);
  const belowB = new Builder(names, sizes);
  /** @type {number[]} directed seam edges: [ax,ay,az,bx,by,bz, ...] */
  const seamEdges = [];

  const readVertex = (vi) => {
    const vert = { _d: 0, _cut: false };
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      const size = sizes[name];
      const attr = geometry.getAttribute(name);
      const comp = new Array(size);
      if (attr) {
        for (let c = 0; c < size; c++) comp[c] = attr.getComponent(vi, c);
      } else {
        for (let c = 0; c < size; c++) comp[c] = 0;
      }
      vert[name] = comp;
    }
    const pos = vert.position;
    vert._d = nx * pos[0] + ny * pos[1] + nz * pos[2] + constant;
    return vert;
  };

  const triIdx = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    if (index) {
      triIdx[0] = index.getX(t * 3);
      triIdx[1] = index.getX(t * 3 + 1);
      triIdx[2] = index.getX(t * 3 + 2);
    } else {
      triIdx[0] = t * 3;
      triIdx[1] = t * 3 + 1;
      triIdx[2] = t * 3 + 2;
    }
    const v0 = readVertex(triIdx[0]);
    const v1 = readVertex(triIdx[1]);
    const v2 = readVertex(triIdx[2]);
    const tri = [v0, v1, v2];

    const posPoly = clip(tri, 1, names);
    const negPoly = clip(tri, -1, names);
    fanTriangulate(posPoly, aboveB);
    fanTriangulate(negPoly, belowB);

    // Seam edge = the two adjacent cut vertices in the above polygon.
    collectSeamEdge(posPoly, seamEdges);
  }

  if (seamEdges.length === 0) {
    // Coplanar / grazing cut — nothing separated cleanly.
    return { above: geometry, below: null, seam: null, area: 0 };
  }

  const area = capSeam(seamEdges, plane, aboveB, belowB, names, sizes, jaggedness);

  const above = aboveB.toGeometry(capHeat);
  const below = belowB.toGeometry(capHeat);
  return { above, below, seam: seamEdges, area };
}

/**
 * Sutherland–Hodgman clip of a triangle against the plane.
 * @param {object[]} poly vertices carrying `_d` signed distance
 * @param {number} keepSign +1 keep the positive half, -1 the negative half
 * @param {string[]} names attribute names
 * @returns {object[]} clipped polygon vertices (new cut verts flagged `_cut`)
 */
function clip(poly, keepSign, names) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = a._d * keepSign;
    const db = b._d * keepSign;
    const aIn = da >= -EPS;
    const bIn = db >= -EPS;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const denom = a._d - b._d;
      const tt = Math.abs(denom) < EPS ? 0.5 : a._d / denom;
      out.push(lerpVertex(a, b, tt, names));
    }
  }
  return out;
}

/** Linearly interpolate every attribute; result is flagged as a cut vertex. */
function lerpVertex(a, b, t, names) {
  const out = { _d: 0, _cut: true };
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    const ca = a[name];
    const cb = b[name];
    const size = ca.length;
    const comp = new Array(size);
    for (let c = 0; c < size; c++) comp[c] = ca[c] + (cb[c] - ca[c]) * t;
    out[name] = comp;
  }
  return out;
}

/** Fan-triangulate a convex polygon into the builder, preserving winding. */
function fanTriangulate(poly, builder) {
  if (poly.length < 3) return;
  for (let i = 1; i < poly.length - 1; i++) {
    builder.pushTri(poly[0], poly[i], poly[i + 1]);
  }
}

/** Record the on-plane edge of a clipped polygon (the two adjacent cut verts). */
function collectSeamEdge(poly, seamEdges) {
  const n = poly.length;
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a._cut && b._cut) {
      const pa = a.position;
      const pb = b.position;
      seamEdges.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
      return;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Cap generation: chain seam edges into loops and ear-clip them.
 * ------------------------------------------------------------------ */
function capSeam(seamEdges, plane, aboveB, belowB, names, sizes, jaggedness) {
  // Weld endpoints so edges chain reliably.
  const quant = 1e4;
  const key = (x, y, z) =>
    `${Math.round(x * quant)},${Math.round(y * quant)},${Math.round(z * quant)}`;

  /** @type {Map<string, number[]>} start key -> [endIndex...] into points */
  const adjacency = new Map();
  const points = []; // [x,y,z] per unique vertex
  const pointIndex = new Map();
  const edgeList = [];

  const idOf = (x, y, z) => {
    const k = key(x, y, z);
    let idx = pointIndex.get(k);
    if (idx === undefined) {
      idx = points.length;
      points.push([x, y, z]);
      pointIndex.set(k, idx);
    }
    return idx;
  };

  for (let i = 0; i < seamEdges.length; i += 6) {
    const a = idOf(seamEdges[i], seamEdges[i + 1], seamEdges[i + 2]);
    const b = idOf(seamEdges[i + 3], seamEdges[i + 4], seamEdges[i + 5]);
    if (a === b) continue;
    let list = adjacency.get(a);
    if (!list) {
      list = [];
      adjacency.set(a, list);
    }
    list.push(edgeList.length);
    edgeList.push([a, b, false]);
  }

  // Plane basis.
  _n.copy(plane.normal).normalize();
  if (Math.abs(_n.x) < 0.9) _u.set(1, 0, 0);
  else _u.set(0, 1, 0);
  _v.copy(_n).cross(_u).normalize();
  _u.copy(_v).cross(_n).normalize();

  const loops = [];
  for (let e = 0; e < edgeList.length; e++) {
    if (edgeList[e][2]) continue;
    const loop = [];
    let current = e;
    let guard = 0;
    while (current !== -1 && !edgeList[current][2] && guard++ < edgeList.length + 2) {
      edgeList[current][2] = true;
      const [, end] = edgeList[current];
      loop.push(end);
      // Find an unused edge starting at `end`.
      const cand = adjacency.get(end);
      current = -1;
      if (cand) {
        for (let c = 0; c < cand.length; c++) {
          if (!edgeList[cand[c]][2]) {
            current = cand[c];
            break;
          }
        }
      }
    }
    if (loop.length >= 3) loops.push(loop);
  }

  let area = 0;

  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    // Project to 2D plane coords.
    const poly2d = [];
    for (let i = 0; i < loop.length; i++) {
      const P = points[loop[i]];
      _p.set(P[0], P[1], P[2]);
      poly2d.push({ x: _p.dot(_u), y: _p.dot(_v), i: loop[i] });
    }
    const tris = earClip(poly2d);
    for (let ti = 0; ti < tris.length; ti++) {
      const A = points[tris[ti][0]];
      const B = points[tris[ti][1]];
      const C = points[tris[ti][2]];
      area += addCapTriangle(A, B, C, plane, aboveB, belowB, names, sizes, _u, _v, jaggedness);
    }
  }
  return area;
}

/** Build a cut-face vertex object at a world/local position on the plane. */
function makeCapVertex(x, y, z, plane, u, v, names, sizes, jaggedness, normalSign) {
  const vert = { _d: 0, _cut: true };
  // Deterministic jaggedness so both caps share the boundary and avoid gaps.
  const h = hash3(x, y, z);
  const disp = (h - 0.5) * 2 * jaggedness;
  const px = x + plane.normal.x * disp;
  const py = y + plane.normal.y * disp;
  const pz = z + plane.normal.z * disp;
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    const size = sizes[name];
    const comp = new Array(size).fill(0);
    if (name === 'position') {
      comp[0] = px;
      comp[1] = py;
      comp[2] = pz;
    } else if (name === 'normal') {
      comp[0] = plane.normal.x * normalSign;
      comp[1] = plane.normal.y * normalSign;
      comp[2] = plane.normal.z * normalSign;
    } else if (name === 'uv' && size >= 2) {
      _p.set(px, py, pz);
      comp[0] = _p.dot(u);
      comp[1] = _p.dot(v);
    } else if (name === HEAT_ATTRIBUTE) {
      comp[0] = 1;
    } else if (name === CUT_ATTR) {
      comp[0] = 1;
    }
    vert[name] = comp;
  }
  return vert;
}

/**
 * Add one cap triangle to both pieces with the correct facing.
 * @returns {number} the triangle area
 */
function addCapTriangle(A, B, C, plane, aboveB, belowB, names, sizes, u, v, jaggedness) {
  _e1.set(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
  _e2.set(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
  _cross.copy(_e1).cross(_e2);
  const twoArea = _cross.length();
  if (twoArea < EPS) return 0;
  const faceDot = _cross.dot(plane.normal);

  // Above piece: cut face points along -normal.
  const a0 = makeCapVertex(A[0], A[1], A[2], plane, u, v, names, sizes, jaggedness, -1);
  const a1 = makeCapVertex(B[0], B[1], B[2], plane, u, v, names, sizes, jaggedness, -1);
  const a2 = makeCapVertex(C[0], C[1], C[2], plane, u, v, names, sizes, jaggedness, -1);
  if (faceDot > 0) aboveB.pushTri(a0, a2, a1);
  else aboveB.pushTri(a0, a1, a2);

  // Below piece: cut face points along +normal (reverse winding).
  const b0 = makeCapVertex(A[0], A[1], A[2], plane, u, v, names, sizes, jaggedness, 1);
  const b1 = makeCapVertex(B[0], B[1], B[2], plane, u, v, names, sizes, jaggedness, 1);
  const b2 = makeCapVertex(C[0], C[1], C[2], plane, u, v, names, sizes, jaggedness, 1);
  if (faceDot > 0) belowB.pushTri(b0, b1, b2);
  else belowB.pushTri(b0, b2, b1);

  return twoArea * 0.5;
}

/** Cheap deterministic hash in [0,1) from a 3D point. */
function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  h -= Math.floor(h);
  return h;
}

/**
 * Ear-clipping triangulation of a simple polygon in 2D.
 * @param {{x:number,y:number,i:number}[]} poly
 * @returns {number[][]} triangles as triples of original vertex indices
 */
function earClip(poly) {
  const n = poly.length;
  const tris = [];
  if (n < 3) return tris;
  // Ensure CCW.
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    signedArea += a.x * b.y - b.x * a.y;
  }
  const verts = signedArea < 0 ? poly.slice().reverse() : poly.slice();

  const idx = [];
  for (let i = 0; i < verts.length; i++) idx.push(i);

  let guard = 0;
  while (idx.length > 3 && guard++ < verts.length * verts.length) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = verts[i0];
      const b = verts[i1];
      const c = verts[i2];
      // Convex?
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 0) continue;
      // No other vertex inside.
      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const ij = idx[j];
        if (ij === i0 || ij === i1 || ij === i2) continue;
        if (pointInTri(verts[ij], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      tris.push([a.i, b.i, c.i]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate; bail with what we have
  }
  if (idx.length === 3) {
    tris.push([verts[idx[0]].i, verts[idx[1]].i, verts[idx[2]].i]);
  }
  return tris;
}

function pointInTri(p, a, b, c) {
  const d1 = sign2(p, a, b);
  const d2 = sign2(p, b, c);
  const d3 = sign2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign2(p1, p2, p3) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

/* ------------------------------------------------------------------ *
 * Output geometry builder.
 * ------------------------------------------------------------------ */
class Builder {
  constructor(names, sizes) {
    this.names = names;
    this.sizes = sizes;
    /** @type {Object<string, number[]>} */
    this.data = {};
    for (let k = 0; k < names.length; k++) this.data[names[k]] = [];
    this.count = 0;
  }

  pushVertex(vert) {
    for (let k = 0; k < this.names.length; k++) {
      const name = this.names[k];
      const comp = vert[name];
      const arr = this.data[name];
      for (let c = 0; c < comp.length; c++) arr.push(comp[c]);
    }
    this.count++;
  }

  pushTri(a, b, c) {
    this.pushVertex(a);
    this.pushVertex(b);
    this.pushVertex(c);
  }

  toGeometry() {
    if (this.count === 0) return null;
    const geo = new THREE.BufferGeometry();
    for (let k = 0; k < this.names.length; k++) {
      const name = this.names[k];
      const size = this.sizes[name];
      const arr = new Float32Array(this.data[name]);
      const attr = new THREE.BufferAttribute(arr, size);
      if (name === HEAT_ATTRIBUTE) attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
    }
    ensureHeatAttribute(geo);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/* ------------------------------------------------------------------ *
 * Convex-hull point extraction + mass properties.
 * ------------------------------------------------------------------ */

/**
 * Positions suitable for a Rapier `convexHull` collider.
 * @param {THREE.BufferGeometry} geometry
 * @returns {Float32Array}
 */
export function convexHullPoints(geometry) {
  const pos = geometry.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  return out;
}

/**
 * Signed-tetrahedron volume + centroid of a closed triangle mesh.
 * @param {THREE.BufferGeometry} geometry
 * @returns {{volume:number, centroid:THREE.Vector3}}
 */
export function computeVolumeAndCentroid(geometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  let vol = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let t = 0; t < triCount; t++) {
    let i0;
    let i1;
    let i2;
    if (index) {
      i0 = index.getX(t * 3);
      i1 = index.getX(t * 3 + 1);
      i2 = index.getX(t * 3 + 2);
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }
    const ax = pos.getX(i0);
    const ay = pos.getY(i0);
    const az = pos.getZ(i0);
    const bx = pos.getX(i1);
    const by = pos.getY(i1);
    const bz = pos.getZ(i1);
    const dx = pos.getX(i2);
    const dy = pos.getY(i2);
    const dz = pos.getZ(i2);
    // v = a . (b x c) / 6
    const crossX = by * dz - bz * dy;
    const crossY = bz * dx - bx * dz;
    const crossZ = bx * dy - by * dx;
    const v = (ax * crossX + ay * crossY + az * crossZ) / 6;
    vol += v;
    cx += (ax + bx + dx) * 0.25 * v;
    cy += (ay + by + dy) * 0.25 * v;
    cz += (az + bz + dz) * 0.25 * v;
  }
  const centroid = new THREE.Vector3();
  if (Math.abs(vol) > 1e-12) {
    centroid.set(cx / vol, cy / vol, cz / vol);
  } else {
    // Fall back to bounding-box centre for degenerate input.
    geometry.computeBoundingBox();
    geometry.boundingBox.getCenter(centroid);
  }
  return { volume: Math.abs(vol), centroid };
}
