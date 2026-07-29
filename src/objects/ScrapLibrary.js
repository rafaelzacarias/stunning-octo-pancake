import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * ScrapLibrary — the feed stock.
 *
 * Every entry supplies render geometry, a primitive collider description
 * (much better behaved than a hull for I-beams and boxes), a target mass, and
 * the material key that drives both the shader and the fracture mechanics.
 */

function tagUV(geometry, scale = 1.4) {
  if (!geometry.attributes.uv) {
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const pos = geometry.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) - bb.min.x) * scale;
      uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) * scale;
    }
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  }
  return geometry;
}

function boxCollider(hx, hy, hz, offset, rotation) {
  return { type: 'box', he: [hx, hy, hz], offset, rotation };
}

function axisQuat(ax, ay, az, angle) {
  const h = angle * 0.5, s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
}

/* ------------------------------------------------------------- geometries */

function buildIBeam(length, height, flangeW, web, flange) {
  const parts = [];
  const top = new THREE.BoxGeometry(length, flange, flangeW);
  top.translate(0, height / 2 - flange / 2, 0);
  const bottom = new THREE.BoxGeometry(length, flange, flangeW);
  bottom.translate(0, -height / 2 + flange / 2, 0);
  const webG = new THREE.BoxGeometry(length, height - flange * 2, web);
  parts.push(top, bottom, webG);
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function buildPipe(length, outer, inner, segments = 20) {
  const g = new THREE.CylinderGeometry(outer, outer, length, segments, 1, true);
  const inn = new THREE.CylinderGeometry(inner, inner, length, segments, 1, true);
  // flip the inner wall
  const ip = inn.attributes.position;
  const idx = inn.index;
  if (idx) { const a = idx.array; for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; } }
  inn.computeVertexNormals();
  const inrm = inn.attributes.normal;
  for (let i = 0; i < inrm.count; i++) inrm.setXYZ(i, -inrm.getX(i), -inrm.getY(i), -inrm.getZ(i));

  // annular end caps
  const capPos = [];
  const capNrm = [];
  for (const sign of [1, -1]) {
    const y = (sign * length) / 2;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const o0 = [Math.cos(a0) * outer, y, Math.sin(a0) * outer];
      const o1 = [Math.cos(a1) * outer, y, Math.sin(a1) * outer];
      const i0 = [Math.cos(a0) * inner, y, Math.sin(a0) * inner];
      const i1 = [Math.cos(a1) * inner, y, Math.sin(a1) * inner];
      if (sign > 0) capPos.push(...o0, ...o1, ...i1, ...o0, ...i1, ...i0);
      else capPos.push(...o1, ...o0, ...i0, ...o1, ...i0, ...i1);
      for (let k = 0; k < 6; k++) capNrm.push(0, sign, 0);
    }
  }
  const caps = new THREE.BufferGeometry();
  caps.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
  caps.setAttribute('normal', new THREE.Float32BufferAttribute(capNrm, 3));
  caps.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((capPos.length / 3) * 2), 2));

  const merged = mergeGeometries([g.toNonIndexed(), inn.toNonIndexed(), caps], false);
  g.dispose(); inn.dispose(); caps.dispose();
  merged.rotateZ(Math.PI / 2);   // lie along X
  return merged;
}

function buildEngineBlock() {
  const parts = [];
  const deck = new THREE.BoxGeometry(0.44, 0.2, 0.38);
  parts.push(deck);
  // cylinder bank humps
  for (let i = 0; i < 4; i++) {
    const c = new THREE.CylinderGeometry(0.052, 0.052, 0.15, 14);
    c.translate(-0.15 + i * 0.1, 0.14, -0.075);
    parts.push(c);
    const c2 = new THREE.CylinderGeometry(0.052, 0.052, 0.15, 14);
    c2.translate(-0.15 + i * 0.1, 0.14, 0.075);
    parts.push(c2);
  }
  const sump = new THREE.BoxGeometry(0.36, 0.14, 0.3);
  sump.translate(0, -0.16, 0);
  parts.push(sump);
  const bell = new THREE.CylinderGeometry(0.15, 0.15, 0.09, 18);
  bell.rotateZ(Math.PI / 2);
  bell.translate(0.26, 0.0, 0);
  parts.push(bell);
  // bolt bosses
  for (let i = 0; i < 8; i++) {
    const b = new THREE.CylinderGeometry(0.016, 0.016, 0.03, 8);
    b.translate(-0.19 + (i % 4) * 0.127, 0.11, i < 4 ? -0.185 : 0.185);
    parts.push(b);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

function buildCan(radius, height) {
  const parts = [];
  const body = new THREE.CylinderGeometry(radius, radius, height * 0.78, 24, 3);
  parts.push(body);
  const topTaper = new THREE.CylinderGeometry(radius * 0.72, radius, height * 0.1, 24, 1);
  topTaper.translate(0, height * 0.44, 0);
  parts.push(topTaper);
  const lid = new THREE.CylinderGeometry(radius * 0.74, radius * 0.72, height * 0.03, 24, 1);
  lid.translate(0, height * 0.5, 0);
  parts.push(lid);
  const botTaper = new THREE.CylinderGeometry(radius, radius * 0.78, height * 0.1, 24, 1);
  botTaper.translate(0, -height * 0.44, 0);
  parts.push(botTaper);
  const base = new THREE.SphereGeometry(radius * 0.8, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  base.scale(1, 0.35, 1);
  base.translate(0, -height * 0.46, 0);
  parts.push(base);
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

function buildGear(radius, thickness, teeth) {
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  const rRoot = radius * 0.86;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [
      [rRoot, a], [rRoot, a + step * 0.18],
      [radius, a + step * 0.3], [radius, a + step * 0.62],
      [rRoot, a + step * 0.74], [rRoot, a + step],
    ];
    for (let k = 0; k < pts.length; k++) {
      const [r, ang] = pts[k];
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius * 0.22, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true,
    bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, steps: 1, curveSegments: 1,
  });
  g.translate(0, 0, -thickness / 2);
  g.rotateX(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

function buildRadiator() {
  const parts = [];
  const core = new THREE.BoxGeometry(0.42, 0.3, 0.04);
  parts.push(core);
  for (let i = 0; i < 16; i++) {
    const fin = new THREE.BoxGeometry(0.006, 0.28, 0.052);
    fin.translate(-0.2 + i * 0.0266, 0, 0);
    parts.push(fin);
  }
  const tankTop = new THREE.BoxGeometry(0.44, 0.05, 0.06);
  tankTop.translate(0, 0.17, 0);
  parts.push(tankTop);
  const tankBot = tankTop.clone(); tankBot.translate(0, -0.34, 0);
  parts.push(tankBot);
  const neck = new THREE.CylinderGeometry(0.022, 0.022, 0.05, 12);
  neck.translate(0.15, 0.21, 0);
  parts.push(neck);
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

function buildToolbox() {
  const parts = [];
  const body = new THREE.BoxGeometry(0.4, 0.2, 0.2);
  parts.push(body);
  const lid = new THREE.BoxGeometry(0.41, 0.03, 0.21);
  lid.translate(0, 0.105, 0);
  parts.push(lid);
  const handle = new THREE.TorusGeometry(0.05, 0.008, 6, 14, Math.PI);
  handle.rotateY(Math.PI / 2);
  handle.translate(0, 0.12, 0);
  parts.push(handle);
  for (const sx of [-1, 1]) {
    const latch = new THREE.BoxGeometry(0.03, 0.05, 0.012);
    latch.translate(sx * 0.14, 0.09, 0.104);
    parts.push(latch);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

function buildSheet(w, h, t) {
  const g = new THREE.BoxGeometry(w, t, h, 12, 1, 10);
  // slight pre-existing warp — nothing in a scrapyard is flat
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + Math.sin(x * 7) * 0.004 + Math.cos(z * 5.5) * 0.003);
  }
  g.computeVertexNormals();
  return g;
}

/* ---------------------------------------------------------------- library */

let cache = null;

export function getScrapLibrary() {
  if (cache) return cache;

  cache = [
    {
      id: 'can', label: 'Aluminium Can', hint: '330 ml · thin wall', mass: 0.016,
      material: 'aluminium', thickness: 0.0004, key: '1',
      build: () => {
        const g = tagUV(buildCan(0.033, 0.122));
        return {
          geometry: g,
          colliders: [{ type: 'cylinder', halfHeight: 0.061, radius: 0.033 }],
        };
      },
    },
    {
      id: 'sheet', label: 'Steel Panel', hint: '1.2 mm galvanised sheet', mass: 4.4,
      material: 'galvanised', thickness: 0.0012, key: '2',
      build: () => {
        const g = tagUV(buildSheet(0.52, 0.42, 0.012));
        return { geometry: g, colliders: [boxCollider(0.26, 0.006, 0.21)] };
      },
    },
    {
      id: 'pipe', label: 'Steel Pipe', hint: 'Ø60 × 3 mm wall', mass: 5.8,
      material: 'rustedSteel', thickness: 0.003, key: '3',
      build: () => {
        const g = tagUV(buildPipe(0.72, 0.03, 0.024, 22));
        return { geometry: g, colliders: [{ type: 'cylinder', halfHeight: 0.36, radius: 0.03, rotation: axisQuat(0, 0, 1, Math.PI / 2) }] };
      },
    },
    {
      id: 'rebar', label: 'Rebar Rod', hint: 'Ø16 solid, ribbed', mass: 2.1,
      material: 'rustedSteel', thickness: 0.008, key: '4',
      build: () => {
        const parts = [];
        const core = new THREE.CylinderGeometry(0.008, 0.008, 0.86, 12);
        parts.push(core);
        for (let i = 0; i < 26; i++) {
          const rib = new THREE.TorusGeometry(0.0085, 0.0016, 4, 10);
          rib.rotateX(Math.PI / 2);
          rib.rotateZ(0.4);
          rib.translate(0, -0.42 + i * 0.033, 0);
          parts.push(rib);
        }
        let g = mergeGeometries(parts, false);
        for (const p of parts) p.dispose();
        g.rotateZ(Math.PI / 2);
        g.computeVertexNormals();
        g = tagUV(g);
        return { geometry: g, colliders: [{ type: 'cylinder', halfHeight: 0.43, radius: 0.0095, rotation: axisQuat(0, 0, 1, Math.PI / 2) }] };
      },
    },
    {
      id: 'beam', label: 'I-Beam Offcut', hint: 'UB 100 × 900 mm', mass: 15.2,
      material: 'mildSteel', thickness: 0.006, key: '5',
      build: () => {
        const g = tagUV(buildIBeam(0.9, 0.11, 0.07, 0.008, 0.011));
        return {
          geometry: g,
          colliders: [
            boxCollider(0.45, 0.0055, 0.035, [0, 0.0495, 0]),
            boxCollider(0.45, 0.0055, 0.035, [0, -0.0495, 0]),
            boxCollider(0.45, 0.044, 0.004),
          ],
        };
      },
    },
    {
      id: 'toolbox', label: 'Tool Box', hint: 'Painted steel, empty', mass: 6.5,
      material: 'paintedSteel', thickness: 0.0012, key: '6',
      build: () => {
        const g = tagUV(buildToolbox());
        return { geometry: g, colliders: [boxCollider(0.2, 0.115, 0.105, [0, 0.005, 0])] };
      },
    },
    {
      id: 'gear', label: 'Cast Gear', hint: 'Brittle grey iron', mass: 7.9,
      material: 'castIron', thickness: 0.02, key: '7',
      build: () => {
        const g = tagUV(buildGear(0.13, 0.038, 18));
        return { geometry: g, colliders: [{ type: 'cylinder', halfHeight: 0.02, radius: 0.128 }] };
      },
    },
    {
      id: 'radiator', label: 'Copper Radiator', hint: 'Finned core, very ductile', mass: 3.4,
      material: 'copper', thickness: 0.0006, key: '8',
      build: () => {
        const g = tagUV(buildRadiator());
        return { geometry: g, colliders: [boxCollider(0.22, 0.19, 0.032)] };
      },
    },
    {
      id: 'engine', label: 'Engine Block', hint: 'The real test — 4 cyl', mass: 62,
      material: 'castIron', thickness: 0.014, key: '9',
      build: () => {
        const g = tagUV(buildEngineBlock());
        return {
          geometry: g,
          colliders: [
            boxCollider(0.22, 0.1, 0.19),
            boxCollider(0.18, 0.07, 0.15, [0, -0.16, 0]),
            boxCollider(0.2, 0.075, 0.09, [0, 0.14, -0.075]),
            boxCollider(0.2, 0.075, 0.09, [0, 0.14, 0.075]),
            { type: 'cylinder', halfHeight: 0.045, radius: 0.15, offset: [0.26, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
          ],
        };
      },
    },
  ];

  return cache;
}

export function getScrapDef(id) {
  return getScrapLibrary().find((s) => s.id === id) || getScrapLibrary()[0];
}
