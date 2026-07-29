import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { METALS } from '../core/Constants.js';
import { ensureHeatAttribute } from '../materials/HeatAttribute.js';

/**
 * Procedural feed stock. Every item is generated from primitives (no external
 * assets), chamfered so it reads as solid, and returned as a fresh geometry +
 * physics shape set + mesh so each spawned instance can be deformed and sliced
 * independently.
 *
 * A scrap entry:
 * ```
 * { id, label, metal, mass, build(materials) -> { geometry, shapes, mesh } }
 * ```
 * `shapes` are Rapier collider descriptors expressed in the geometry's local
 * (centred) frame. Effective density is scaled per part so hollow items (cans,
 * pipes) are not modelled as solid billets.
 *
 * @module ScrapLibrary
 */

const _box = new THREE.Box3();
const _center = new THREE.Vector3();

/** Merge parts, centre on the origin and tag with the heat channel. */
function finalize(parts) {
  const geo = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  parts.forEach((p) => p.dispose());
  geo.computeVertexNormals();
  _box.setFromBufferAttribute(geo.getAttribute('position'));
  _box.getCenter(_center);
  geo.translate(-_center.x, -_center.y, -_center.z);
  ensureHeatAttribute(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, offset: _center.clone() };
}

function make(metal, geometry, shapes, materials, extraFriction) {
  const material = materials.get(metal);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const density = METALS[metal].density;
  for (const s of shapes) {
    if (s.friction == null) s.friction = extraFriction ?? 0.45;
    if (s.restitution == null) s.restitution = 0.1;
    if (s._fill != null) {
      s.density = density * s._fill;
      delete s._fill;
    } else if (s.density == null) {
      s.density = density;
    }
  }
  return { geometry, shapes, mesh };
}

/* ------------------------------------------------------------------ *
 * Builders.
 * ------------------------------------------------------------------ */

function buildCan(materials) {
  // Aluminium drink can: tapered neck + domed base via a lathe profile.
  const r = 0.033;
  const h = 0.115;
  const pts = [
    new THREE.Vector2(0, -h / 2),
    new THREE.Vector2(r * 0.55, -h / 2),
    new THREE.Vector2(r * 0.95, -h / 2 + 0.012),
    new THREE.Vector2(r, -h / 2 + 0.03),
    new THREE.Vector2(r, h / 2 - 0.03),
    new THREE.Vector2(r * 0.95, h / 2 - 0.016),
    new THREE.Vector2(r * 0.72, h / 2 - 0.004),
    new THREE.Vector2(r * 0.7, h / 2)
  ];
  const geo = new THREE.LatheGeometry(pts, 28);
  geo.computeVertexNormals();
  ensureHeatAttribute(geo);
  const shapes = [{ type: 'cylinder', halfHeight: h / 2, radius: r, _fill: 0.1 }];
  return make('aluminium', geo, shapes, materials, 0.4);
}

function buildIBeam(materials) {
  // Steel I-beam via an extruded I cross-section.
  const L = 0.62;
  const fw = 0.09; // flange width
  const fh = 0.014; // flange thickness
  const wh = 0.12; // web height (between flanges)
  const wt = 0.014; // web thickness
  const half = fw / 2;
  const s = new THREE.Shape();
  s.moveTo(-half, -wh / 2 - fh);
  s.lineTo(half, -wh / 2 - fh);
  s.lineTo(half, -wh / 2);
  s.lineTo(wt / 2, -wh / 2);
  s.lineTo(wt / 2, wh / 2);
  s.lineTo(half, wh / 2);
  s.lineTo(half, wh / 2 + fh);
  s.lineTo(-half, wh / 2 + fh);
  s.lineTo(-half, wh / 2);
  s.lineTo(-wt / 2, wh / 2);
  s.lineTo(-wt / 2, -wh / 2);
  s.lineTo(-half, -wh / 2);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: L, steps: 16, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1 });
  geo.translate(0, 0, -L / 2);
  geo.computeVertexNormals();
  ensureHeatAttribute(geo);
  const shapes = [
    { type: 'box', hx: half, hy: fh / 2, hz: L / 2, position: [0, -wh / 2 - fh / 2, 0] },
    { type: 'box', hx: half, hy: fh / 2, hz: L / 2, position: [0, wh / 2 + fh / 2, 0] },
    { type: 'box', hx: wt / 2, hy: wh / 2, hz: L / 2, position: [0, 0, 0] }
  ];
  return make('steel', geo, shapes, materials, 0.5);
}

function buildPipe(materials) {
  // Hollow galvanised tube from a rectangular ring lathe profile.
  const ro = 0.036;
  const ri = 0.028;
  const L = 0.5;
  const pts = [
    new THREE.Vector2(ri, -L / 2),
    new THREE.Vector2(ro, -L / 2),
    new THREE.Vector2(ro, L / 2),
    new THREE.Vector2(ri, L / 2),
    new THREE.Vector2(ri, -L / 2)
  ];
  const geo = new THREE.LatheGeometry(pts, 30);
  geo.rotateX(Math.PI / 2); // lathe axis Y -> lie along Z
  geo.computeVertexNormals();
  ensureHeatAttribute(geo);
  const shapes = [
    {
      type: 'cylinder',
      halfHeight: L / 2,
      radius: ro,
      quaternion: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], // Y-axis -> Z-axis
      _fill: 0.45
    }
  ];
  return make('galvanised', geo, shapes, materials, 0.5);
}

function buildEngineBlock(materials) {
  // The heavy hero object: a blocky V-configuration cast-iron block with bores,
  // bolt bosses and casting ribs.
  const parts = [];
  const bw = 0.26;
  const bh = 0.2;
  const bd = 0.3;
  // Main crankcase.
  parts.push(new THREE.BoxGeometry(bw, bh, bd));
  // Two angled cylinder banks forming a V.
  for (const sx of [-1, 1]) {
    const bank = new THREE.BoxGeometry(0.11, 0.16, bd);
    bank.rotateZ(sx * 0.5);
    bank.translate(sx * 0.09, bh / 2 + 0.05, 0);
    parts.push(bank);
  }
  // Cylinder bores (visual) on top of each bank.
  const shapes = [{ type: 'box', hx: bw / 2, hy: bh / 2, hz: bd / 2 }];
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const bore = new THREE.CylinderGeometry(0.035, 0.038, 0.11, 16);
      bore.rotateZ(sx * 0.5);
      bore.translate(sx * 0.11, bh / 2 + 0.11, -bd / 4 + i * (bd / 2));
      parts.push(bore);
    }
    // Bank collider.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sx * 0.5);
    shapes.push({ type: 'box', hx: 0.055, hy: 0.08, hz: bd / 2, position: [sx * 0.09, bh / 2 + 0.05, 0], quaternion: [q.x, q.y, q.z, q.w] });
  }
  // Bolt bosses + ribs.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const boss = new THREE.CylinderGeometry(0.012, 0.014, 0.05, 8);
      boss.translate(sx * (bw / 2 - 0.02), -bh / 2 + 0.025, sz * (bd / 2 - 0.03));
      parts.push(boss);
    }
    const rib = new THREE.BoxGeometry(0.02, bh * 0.8, bd * 0.9);
    rib.translate(sx * (bw / 2 + 0.008), 0, 0);
    parts.push(rib);
  }

  const { geo, offset } = finalize(parts);
  // finalize() recentres the geometry on its bounding-box centre; shapes were
  // authored around the crankcase origin, so shift them by the same offset.
  for (const s of shapes) {
    const p = s.position || [0, 0, 0];
    s.position = [p[0] - offset.x, p[1] - offset.y, p[2] - offset.z];
  }
  return make('castIron', geo, shapes, materials, 0.55);
}

function buildPlate(materials) {
  // Steel sheet / plate.
  const geo = new THREE.BoxGeometry(0.34, 0.008, 0.26, 14, 2, 11);
  geo.computeVertexNormals();
  ensureHeatAttribute(geo);
  const shapes = [{ type: 'box', hx: 0.17, hy: 0.004, hz: 0.13 }];
  return make('steel', geo, shapes, materials, 0.45);
}

function buildBar(materials) {
  // Thick stainless bar stock, subdivided along its length so it can bend/dent.
  const geo = new THREE.BoxGeometry(0.5, 0.05, 0.05, 28, 4, 4);
  geo.computeVertexNormals();
  ensureHeatAttribute(geo);
  const shapes = [{ type: 'box', hx: 0.25, hy: 0.025, hz: 0.025 }];
  return make('stainless', geo, shapes, materials, 0.5);
}

/**
 * The registry. Masses are rough physical estimates (kg) for UI display only —
 * the actual simulated mass comes from collider density × volume.
 * @type {Array<{id:string,label:string,metal:string,mass:number,build:Function}>}
 */
export const SCRAP_TYPES = [
  { id: 'can', label: 'Aluminium Can', metal: 'aluminium', mass: 0.015, build: buildCan },
  { id: 'ibeam', label: 'Steel I-Beam', metal: 'steel', mass: 4.2, build: buildIBeam },
  { id: 'pipe', label: 'Metal Pipe', metal: 'galvanised', mass: 1.1, build: buildPipe },
  { id: 'engine', label: 'Engine Block', metal: 'castIron', mass: 34, build: buildEngineBlock },
  { id: 'plate', label: 'Steel Plate', metal: 'steel', mass: 5.6, build: buildPlate },
  { id: 'bar', label: 'Bar Stock', metal: 'stainless', mass: 9.8, build: buildBar }
];

const _byId = new Map(SCRAP_TYPES.map((s) => [s.id, s]));

/**
 * Build a scrap instance.
 * @param {string} id one of {@link SCRAP_TYPES}; random if unknown/omitted
 * @param {object} materials MaterialLibrary
 * @returns {{ geometry:THREE.BufferGeometry, shapes:object[], mesh:THREE.Mesh, type:object }}
 */
export function createScrap(id, materials) {
  let entry = _byId.get(id);
  if (!entry) entry = SCRAP_TYPES[(Math.random() * SCRAP_TYPES.length) | 0];
  const built = entry.build(materials);
  built.type = entry;
  return built;
}
