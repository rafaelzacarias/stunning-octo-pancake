import * as THREE from 'three';

/**
 * MeshSlicer — real-time plane splitting of arbitrary triangle soup.
 *
 * Features that matter for making shredded metal look sheared rather than
 * laser-cut:
 *  - full attribute interpolation (position / normal / uv / heat channel)
 *  - deterministic out-of-plane displacement applied at the *intersection
 *    point*, so the cap and the side-wall boundary stay welded and the two
 *    halves still interlock perfectly
 *  - ear-clipped caps with hole support (hollow pipes cut correctly)
 *  - fresh cut vertices are stamped white-hot for the heat shader
 */

const EPS = 1e-7;
// Below this the plane-intersection denominator carries no usable information:
// dividing by it produces |s| >> 1 or a NaN, which then poisons the fragment.
const DENOM_EPS = 1e-12;
// Squared length under which a normal counts as degenerate.
const NORMAL_EPS2 = 1e-12;

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Sanitation counters. A single NaN vertex makes a whole draw call's bounding
 * sphere NaN (silently culling the object) and, once rasterised, spreads
 * frame-wide through the bloom/GTAO blurs and blacks out the entire frame.
 * These counters exist so a test can assert the slicer never emits one.
 *
 *  droppedTriangles — triangles discarded for a non-finite position/uv/heat
 *  nullGeometries   — halves that sanitised down to nothing (caller gets null)
 *  nonFiniteFixes   — in-place repairs: clamped/skipped intersection
 *                     parameters and rebuilt degenerate normals
 */
const SLICER_STATS = { droppedTriangles: 0, nullGeometries: 0, nonFiniteFixes: 0 };

export function getSlicerStats() {
  return {
    droppedTriangles: SLICER_STATS.droppedTriangles,
    nullGeometries: SLICER_STATS.nullGeometries,
    nonFiniteFixes: SLICER_STATS.nonFiniteFixes,
  };
}

export function resetSlicerStats() {
  SLICER_STATS.droppedTriangles = 0;
  SLICER_STATS.nullGeometries = 0;
  SLICER_STATS.nonFiniteFixes = 0;
}

/** Deterministic hash -> [-1,1]; identical for both halves of a cut. */
function hash31(x, y, z) {
  let h = Math.imul(Math.round(x * 4096) ^ 0x27d4eb2d, 0x165667b1);
  h = Math.imul(h ^ (Math.round(y * 4096) + 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (Math.round(z * 4096) + 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

class VertexSink {
  constructor(hasUV) {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.heat = [];
    this.heatT = [];
    this.hasUV = hasUV;
  }
  push(p, n, uvx, uvy, h, ht) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(uvx, uvy);
    this.heat.push(h);
    this.heatT.push(ht);
  }
  get count() { return this.heat.length; }

  /**
   * Sanitising builder — runs up to `maxSlicesPerFrame` times per frame, so it
   * is a single linear pass with no per-vertex allocation.
   *
   *  - a triangle with any non-finite position / uv / heat component is DROPPED
   *    (that data cannot be repaired, and one NaN vertex poisons the whole draw)
   *  - a degenerate normal (zero length or non-finite) is REBUILT from the face
   *    normal — positions are already proven finite at that point, so the
   *    triangle stays visible instead of leaving a hole in the fragment
   *  - bounding volumes are computed here from the surviving, finite vertices,
   *    so `boundingSphere` can never come out NaN
   *
   * Compaction is in place: the write cursor never overtakes the read cursor.
   */
  build() {
    const triCount = (this.count / 3) | 0;
    if (triCount === 0) { SLICER_STATS.nullGeometries++; return null; }

    const pos = this.pos, nrm = this.nrm, uv = this.uv, heat = this.heat, heatT = this.heatT;
    let w = 0;   // write cursor, in vertices

    for (let t = 0; t < triCount; t++) {
      const v = t * 3;
      const p = v * 3;     // position / normal base (stride 3)
      const q = v * 2;     // uv base (stride 2)

      let ok = true;
      for (let k = 0; k < 9; k++) if (!Number.isFinite(pos[p + k])) { ok = false; break; }
      if (ok) for (let k = 0; k < 6; k++) if (!Number.isFinite(uv[q + k])) { ok = false; break; }
      if (ok) for (let k = 0; k < 3; k++) {
        if (!Number.isFinite(heat[v + k]) || !Number.isFinite(heatT[v + k])) { ok = false; break; }
      }
      if (!ok) { SLICER_STATS.droppedTriangles++; continue; }

      // Repair degenerate normals from the face normal (computed lazily: the
      // common case never touches this).
      let faceX = 0, faceY = 0, faceZ = 0, faceDone = false;
      for (let k = 0; k < 3; k++) {
        const n = p + k * 3;
        const nx = nrm[n], ny = nrm[n + 1], nz = nrm[n + 2];
        const len2 = nx * nx + ny * ny + nz * nz;
        if (len2 > NORMAL_EPS2 && Number.isFinite(len2)) continue;
        if (!faceDone) {
          const e1x = pos[p + 3] - pos[p], e1y = pos[p + 4] - pos[p + 1], e1z = pos[p + 5] - pos[p + 2];
          const e2x = pos[p + 6] - pos[p], e2y = pos[p + 7] - pos[p + 1], e2z = pos[p + 8] - pos[p + 2];
          const cx = e1y * e2z - e1z * e2y;
          const cy = e1z * e2x - e1x * e2z;
          const cz = e1x * e2y - e1y * e2x;
          const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
          if (l > 1e-12) { faceX = cx / l; faceY = cy / l; faceZ = cz / l; }
          else { faceX = 0; faceY = 1; faceZ = 0; }   // sliver: any unit vector will do
          faceDone = true;
        }
        nrm[n] = faceX; nrm[n + 1] = faceY; nrm[n + 2] = faceZ;
        SLICER_STATS.nonFiniteFixes++;
      }

      if (w !== v) {
        const dp = w * 3, dq = w * 2;
        for (let k = 0; k < 9; k++) { pos[dp + k] = pos[p + k]; nrm[dp + k] = nrm[p + k]; }
        for (let k = 0; k < 6; k++) uv[dq + k] = uv[q + k];
        for (let k = 0; k < 3; k++) { heat[w + k] = heat[v + k]; heatT[w + k] = heatT[v + k]; }
      }
      w += 3;
    }

    if (w < 3) { SLICER_STATS.nullGeometries++; return null; }

    if (w !== triCount * 3) {
      pos.length = w * 3; nrm.length = w * 3; uv.length = w * 2;
      heat.length = w; heatT.length = w;
    }

    const g = new THREE.BufferGeometry();
    const posAttr = new THREE.Float32BufferAttribute(pos, 3);
    g.setAttribute('position', posAttr);
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aHeat', new THREE.Float32BufferAttribute(heat, 1));
    g.setAttribute('aHeatT', new THREE.Float32BufferAttribute(heatT, 1));

    // Bounding volumes from the float32 data that actually reaches the GPU.
    // Doing it here rather than via computeBoundingSphere() keeps three from
    // logging "Computed radius is NaN" and guarantees the object is never
    // culled by a poisoned sphere.
    const a = posAttr.array;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    let maxR2 = 0;
    for (let i = 0; i < a.length; i += 3) {
      const dx = a[i] - cx, dy = a[i + 1] - cy, dz = a[i + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxR2) maxR2 = d2;
    }
    const radius = Math.sqrt(maxR2);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || !Number.isFinite(radius)) {
      // Unreachable given the per-triangle filter above; bail rather than hand
      // the renderer a geometry that would vanish or blow up the frame.
      g.dispose();
      SLICER_STATS.nullGeometries++;
      return null;
    }
    g.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), radius);

    return g;
  }
}

/**
 * @param {THREE.BufferGeometry} geometry  non-indexed or indexed, local space
 * @param {THREE.Vector3} normal           unit plane normal, local space
 * @param {number} constant                plane offset: dot(n,p) + constant = 0
 * @param {object} opts
 *   tear        out-of-plane raggedness amplitude (metres)
 *   heat        0..1 incandescence stamped on the new surface
 *   time        current simulation time for the cooling curve
 *   uvScale     cap texel density (uv units per metre)
 * @returns {{front: THREE.BufferGeometry|null, back: THREE.BufferGeometry|null}}
 */
export function sliceGeometry(geometry, normal, constant, opts = {}) {
  const tear = opts.tear ?? 0.004;
  const heat = opts.heat ?? 0.95;
  const time = opts.time ?? 0;
  const uvScale = opts.uvScale ?? 1.6;

  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const posAttr = src.attributes.position;
  const nrmAttr = src.attributes.normal;
  const uvAttr = src.attributes.uv;
  const heatAttr = src.attributes.aHeat;
  const heatTAttr = src.attributes.aHeatT;
  const triCount = posAttr.count / 3;

  const front = new VertexSink(!!uvAttr);
  const back = new VertexSink(!!uvAttr);

  // Plane basis for cap projection / triangulation.
  const nx = normal.x, ny = normal.y, nz = normal.z;
  _u.set(1, 0, 0);
  if (Math.abs(nx) > 0.9) _u.set(0, 1, 0);
  _u.crossVectors(_u, normal).normalize();
  _v.crossVectors(normal, _u).normalize();
  const ux = _u.x, uy = _u.y, uz = _u.z;
  const vx = _v.x, vy = _v.y, vz = _v.z;

  // Scratch vertex records: [x,y,z, nx,ny,nz, u,v, heat, heatT, dist, isCut]
  const VSTRIDE = 12;
  const poly = new Float32Array(4 * VSTRIDE);
  const polyF = new Float32Array(5 * VSTRIDE);
  const polyB = new Float32Array(5 * VSTRIDE);
  const _tmpV = new Float32Array(VSTRIDE);

  const cutEdges = [];   // flat: ax,ay,az, bx,by,bz (undisplaced, plane-exact)
  const cutDisp = new Map(); // quantized key -> displaced position

  const readVertex = (i, out, off) => {
    const px = posAttr.getX(i), py = posAttr.getY(i), pz = posAttr.getZ(i);
    out[off] = px; out[off + 1] = py; out[off + 2] = pz;
    out[off + 3] = nrmAttr ? nrmAttr.getX(i) : 0;
    out[off + 4] = nrmAttr ? nrmAttr.getY(i) : 1;
    out[off + 5] = nrmAttr ? nrmAttr.getZ(i) : 0;
    out[off + 6] = uvAttr ? uvAttr.getX(i) : 0;
    out[off + 7] = uvAttr ? uvAttr.getY(i) : 0;
    out[off + 8] = heatAttr ? heatAttr.getX(i) : 0;
    out[off + 9] = heatTAttr ? heatTAttr.getX(i) : -1000;
    out[off + 10] = px * nx + py * ny + pz * nz + constant;
    out[off + 11] = 0;
  };

  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();

  const emit = (sink, arr, off) => {
    _p.set(arr[off], arr[off + 1], arr[off + 2]);
    _n.set(arr[off + 3], arr[off + 4], arr[off + 5]);
    sink.push(_p, _n, arr[off + 6], arr[off + 7], arr[off + 8], arr[off + 9]);
  };

  const emitFan = (sink, arr, n) => {
    for (let i = 1; i < n - 1; i++) {
      emit(sink, arr, 0);
      emit(sink, arr, i * VSTRIDE);
      emit(sink, arr, (i + 1) * VSTRIDE);
    }
  };

  for (let t = 0; t < triCount; t++) {
    readVertex(t * 3, poly, 0);
    readVertex(t * 3 + 1, poly, VSTRIDE);
    readVertex(t * 3 + 2, poly, 2 * VSTRIDE);

    const d0 = poly[10], d1 = poly[VSTRIDE + 10], d2 = poly[2 * VSTRIDE + 10];

    if (d0 >= -EPS && d1 >= -EPS && d2 >= -EPS) {
      emit(front, poly, 0); emit(front, poly, VSTRIDE); emit(front, poly, 2 * VSTRIDE);
      continue;
    }
    if (d0 <= EPS && d1 <= EPS && d2 <= EPS) {
      emit(back, poly, 0); emit(back, poly, VSTRIDE); emit(back, poly, 2 * VSTRIDE);
      continue;
    }

    // Sutherland–Hodgman clip against the plane, both sides at once.
    let nf = 0, nb = 0;
    // The two intersections are pushed in CCW boundary order, so recording
    // them in push order yields a consistently-wound edge for every triangle.
    let i1x = 0, i1y = 0, i1z = 0, cuts = 0;
    let i2x = 0, i2y = 0, i2z = 0;
    for (let i = 0; i < 3; i++) {
      const ci = i * VSTRIDE;
      const ni = ((i + 1) % 3) * VSTRIDE;
      const dc = poly[ci + 10];
      const dn = poly[ni + 10];

      if (dc >= 0) { polyF.set(poly.subarray(ci, ci + VSTRIDE), nf * VSTRIDE); nf++; }
      if (dc <= 0) { polyB.set(poly.subarray(ci, ci + VSTRIDE), nb * VSTRIDE); nb++; }

      if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) {
        // The sign test guarantees a mathematical root, but the denominator can
        // still be denormal-small (near-coplanar sliver) — dividing by it emits
        // an intersection metres away from the edge, or a NaN outright.
        const den = dc - dn;
        if (!(Math.abs(den) > DENOM_EPS)) { SLICER_STATS.nonFiniteFixes++; continue; }
        let s = dc / den;
        if (!(s >= 0)) { s = 0; SLICER_STATS.nonFiniteFixes++; }        // catches NaN too
        else if (s > 1) { s = 1; SLICER_STATS.nonFiniteFixes++; }
        // exact intersection on the plane
        const ix = poly[ci] + (poly[ni] - poly[ci]) * s;
        const iy = poly[ci + 1] + (poly[ni + 1] - poly[ci + 1]) * s;
        const iz = poly[ci + 2] + (poly[ni + 2] - poly[ci + 2]) * s;

        // Ragged shear lip. Same value for both halves => they still mate.
        const disp = tear * (
          0.62 * hash31(ix * 7.3, iy * 7.3, iz * 7.3) +
          0.38 * hash31(ix * 23.1 + 5, iy * 23.1 + 5, iz * 23.1 + 5)
        );
        const dx = ix + nx * disp, dy = iy + ny * disp, dz = iz + nz * disp;

        _tmpV[0] = dx; _tmpV[1] = dy; _tmpV[2] = dz;
        _tmpV[3] = poly[ci + 3] + (poly[ni + 3] - poly[ci + 3]) * s;
        _tmpV[4] = poly[ci + 4] + (poly[ni + 4] - poly[ci + 4]) * s;
        _tmpV[5] = poly[ci + 5] + (poly[ni + 5] - poly[ci + 5]) * s;
        _tmpV[6] = poly[ci + 6] + (poly[ni + 6] - poly[ci + 6]) * s;
        _tmpV[7] = poly[ci + 7] + (poly[ni + 7] - poly[ci + 7]) * s;
        // The rim next to the cut glows a touch cooler than the cap itself.
        _tmpV[8] = Math.max(heat * 0.82, poly[ci + 8]);
        _tmpV[9] = time;
        _tmpV[10] = 0; _tmpV[11] = 1;

        polyF.set(_tmpV, nf * VSTRIDE); nf++;
        polyB.set(_tmpV, nb * VSTRIDE); nb++;

        cutDisp.set(quantKey(ix, iy, iz), [dx, dy, dz]);
        if (cuts === 0) { i1x = ix; i1y = iy; i1z = iz; }
        else if (cuts === 1) { i2x = ix; i2y = iy; i2z = iz; }
        cuts++;
      }
    }

    if (nf >= 3) emitFan(front, polyF, nf);
    if (nb >= 3) emitFan(back, polyB, nb);
    if (cuts === 2) cutEdges.push(i1x, i1y, i1z, i2x, i2y, i2z);
  }

  // ---------------------------------------------------------------- capping
  if (cutEdges.length >= 6) {
    const loops = buildLoops(cutEdges);
    if (loops.length) {
      capLoops(loops, cutDisp, front, back, {
        nx, ny, nz, ux, uy, uz, vx, vy, vz,
        heat, time, uvScale,
      });
    }
  }

  return { front: front.build(), back: back.build() };
}

function quantKey(x, y, z) {
  return `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
}

/** Chain directed segments into closed (or open) loops via a positional hash. */
function buildLoops(edges) {
  const startMap = new Map();
  const n = edges.length / 6;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const k = quantKey(edges[o], edges[o + 1], edges[o + 2]);
    let list = startMap.get(k);
    if (!list) { list = []; startMap.set(k, list); }
    list.push(i);
  }

  const used = new Uint8Array(n);
  const loops = [];

  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    const loop = [];
    let cur = i;
    let guard = 0;
    while (cur >= 0 && !used[cur] && guard++ < n + 4) {
      used[cur] = 1;
      const o = cur * 6;
      loop.push(edges[o], edges[o + 1], edges[o + 2]);
      const nk = quantKey(edges[o + 3], edges[o + 4], edges[o + 5]);
      const cand = startMap.get(nk);
      let next = -1;
      if (cand) {
        for (const c of cand) { if (!used[c]) { next = c; break; } }
      }
      cur = next;
    }
    if (loop.length >= 9) loops.push(loop);   // >= 3 points
  }
  return loops;
}

function capLoops(loops, cutDisp, front, back, B) {
  const projected = loops.map((loop) => {
    const pts = [];
    for (let i = 0; i < loop.length; i += 3) {
      const x = loop[i], y = loop[i + 1], z = loop[i + 2];
      pts.push(new THREE.Vector2(
        x * B.ux + y * B.uy + z * B.uz,
        x * B.vx + y * B.vy + z * B.vz
      ));
    }
    return pts;
  });

  const areas = projected.map((p) => THREE.ShapeUtils.area(p));
  // Largest loop is the outer contour; anything inside it is a hole.
  let outer = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[outer])) outer = i;
  }

  const groups = [];
  const consumed = new Uint8Array(loops.length);
  for (let i = 0; i < loops.length; i++) {
    if (consumed[i]) continue;
    const holes = [];
    for (let j = 0; j < loops.length; j++) {
      if (j === i || consumed[j]) continue;
      if (Math.abs(areas[j]) < Math.abs(areas[i]) && pointInPolygon(projected[j][0], projected[i])) {
        holes.push(j);
        consumed[j] = 1;
      }
    }
    consumed[i] = 1;
    groups.push({ outer: i, holes });
  }

  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();

  for (const grp of groups) {
    let contour = projected[grp.outer];
    let loop3 = loops[grp.outer];
    if (areas[grp.outer] < 0) { contour = contour.slice().reverse(); loop3 = reverseLoop(loop3); }

    const holeContours = [];
    const holeLoops = [];
    for (const h of grp.holes) {
      let hc = projected[h];
      let hl = loops[h];
      if (areas[h] > 0) { hc = hc.slice().reverse(); hl = reverseLoop(hl); }
      holeContours.push(hc);
      holeLoops.push(hl);
    }

    // Flatten contour + holes into one index space for ShapeUtils.
    const all2D = contour.slice();
    const all3D = loop3.slice();
    for (let h = 0; h < holeContours.length; h++) {
      all2D.push(...holeContours[h]);
      all3D.push(...holeLoops[h]);
    }

    let faces;
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
    } catch (e) {
      faces = null;
    }
    if (!faces || !faces.length) {
      // Fallback: centroid fan (always produces something watertight enough).
      faces = [];
      for (let i = 1; i < contour.length - 1; i++) faces.push([0, i, i + 1]);
    }

    const centroidU = all2D.reduce((s, p) => s + p.x, 0) / all2D.length;
    const centroidV = all2D.reduce((s, p) => s + p.y, 0) / all2D.length;

    for (const f of faces) {
      const idx = [f[0], f[1], f[2]];
      // back piece cap faces +n ; front piece cap faces -n
      emitCapTri(back, all3D, all2D, idx, B, +1, cutDisp, centroidU, centroidV, _p, _n);
      emitCapTri(front, all3D, all2D, [idx[2], idx[1], idx[0]], B, -1, cutDisp, centroidU, centroidV, _p, _n);
    }
  }
}

function emitCapTri(sink, loop3, loop2, idx, B, sign, cutDisp, cu, cv, _p, _n) {
  _n.set(B.nx * sign, B.ny * sign, B.nz * sign);
  for (let k = 0; k < 3; k++) {
    const i = idx[k];
    if (i * 3 + 2 >= loop3.length) return;
    const x = loop3[i * 3], y = loop3[i * 3 + 1], z = loop3[i * 3 + 2];
    const key = quantKey(x, y, z);
    const disp = cutDisp.get(key);
    if (disp) _p.set(disp[0], disp[1], disp[2]);
    else _p.set(x, y, z);
    const p2 = loop2[i];
    sink.push(_p, _n, (p2.x - cu) * B.uvScale + 0.5, (p2.y - cv) * B.uvScale + 0.5, B.heat, B.time);
  }
}

function reverseLoop(loop) {
  const out = [];
  for (let i = loop.length - 3; i >= 0; i -= 3) out.push(loop[i], loop[i + 1], loop[i + 2]);
  return out;
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-20) + xi) inside = !inside;
  }
  return inside;
}

/* ------------------------------------------------------------- measurement */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Signed-tetrahedron volume of a closed triangle soup. */
export function computeVolume(geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const n = idx ? idx.count : pos.count;
  let vol = 0;
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i;
    const i1 = idx ? idx.getX(i + 1) : i + 1;
    const i2 = idx ? idx.getX(i + 2) : i + 2;
    _a.fromBufferAttribute(pos, i0);
    _b.fromBufferAttribute(pos, i1);
    _c.fromBufferAttribute(pos, i2);
    vol += _a.dot(_b.clone().cross(_c));
  }
  return Math.abs(vol) / 6;
}

export function computeCentroid(geometry, target = new THREE.Vector3()) {
  const pos = geometry.attributes.position;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pos.count; i++) { x += pos.getX(i); y += pos.getY(i); z += pos.getZ(i); }
  return target.set(x / pos.count, y / pos.count, z / pos.count);
}

/** Recentre a geometry on its centroid, returning the offset that was removed. */
export function recenter(geometry, target = new THREE.Vector3()) {
  computeCentroid(geometry, target);
  geometry.translate(-target.x, -target.y, -target.z);
  return target;
}

/* ------------------------------------------------------------ hull sampling */

// 42-direction sphere used for support-point sampling: gives Rapier a compact,
// well-conditioned point cloud instead of thousands of near-duplicate verts.
const HULL_DIRS = (() => {
  const dirs = [];
  const phi = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
    [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi],
    [phi, 0, 1], [phi, 0, -1], [-phi, 0, 1], [-phi, 0, -1],
    [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
    [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [0.5, 1, 0.5], [-0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5],
    [0.5, -1, 0.5], [-0.5, -1, 0.5], [0.5, -1, -0.5], [-0.5, -1, -0.5],
    [1, 0.5, 0.5], [-1, 0.5, 0.5], [1, -0.5, 0.5], [-1, -0.5, 0.5],
    [0.5, 0.5, 1], [0.5, 0.5, -1], [-0.5, 0.5, 1], [-0.5, 0.5, -1],
  ];
  for (const d of raw) {
    const l = Math.hypot(d[0], d[1], d[2]);
    dirs.push(d[0] / l, d[1] / l, d[2] / l);
  }
  return new Float32Array(dirs);
})();

/**
 * Extract a convex point cloud approximating the geometry, for Rapier.
 * Support-mapped so the hull always encloses the real silhouette.
 */
export function hullPoints(geometry) {
  const pos = geometry.attributes.position;
  const count = pos.count;
  const dirCount = HULL_DIRS.length / 3;
  const best = new Int32Array(dirCount).fill(-1);
  const bestDot = new Float32Array(dirCount).fill(-Infinity);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    for (let d = 0; d < dirCount; d++) {
      const o = d * 3;
      const dot = x * HULL_DIRS[o] + y * HULL_DIRS[o + 1] + z * HULL_DIRS[o + 2];
      if (dot > bestDot[d]) { bestDot[d] = dot; best[d] = i; }
    }
  }

  const seen = new Set();
  const out = [];
  for (let d = 0; d < dirCount; d++) {
    const i = best[d];
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  return new Float32Array(out);
}
