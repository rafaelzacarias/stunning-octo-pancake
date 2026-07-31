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

/* ------------------------------------------------------ multi-part assets */

/**
 * mergeGeometries() demands a uniform index state and an identical attribute
 * set across every input. ExtrudeGeometry arrives non-indexed, Box/Cylinder/
 * Lathe arrive indexed, and hand-built surfaces may carry no uv at all — so
 * flatten, pad and strip before merging.
 *
 * Normals are NOT recomputed afterwards: the merged result is non-indexed, so
 * recomputing would flatten every lathe and cylinder into facets.
 */
function mergeParts(parts) {
  const flat = [];
  for (const src of parts) {
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    g.clearGroups();
    flat.push(g);
  }
  const merged = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  return merged;
}

/** Rapier cylinders are Y-aligned; this lays one along Z instead. */
const CYL_Z = axisQuat(1, 0, 0, Math.PI / 2);

/* ------------------------------------------------- 1. flat-screen television */

function buildTvScreen() {
  // Cover glass plus the LCD/diffuser stack behind it, so a cut through the
  // panel exposes layers rather than a single wafer.
  const front = new THREE.BoxGeometry(0.92, 0.53, 0.0026, 10, 6, 1);
  front.translate(0, 0, 0.0017);
  const stack = new THREE.BoxGeometry(0.904, 0.515, 0.0022, 5, 3, 1);
  stack.translate(0, 0, -0.0018);
  return mergeParts([front, stack]);
}

function buildTvBezel() {
  const W = 0.95, H = 0.56, t = 0.011, d = 0.024;
  const parts = [];
  const top = new THREE.BoxGeometry(W, t, d);
  top.translate(0, H / 2 - t / 2, 0);
  parts.push(top);
  const chin = new THREE.BoxGeometry(W, t * 2.4, d);
  chin.translate(0, -H / 2 + t * 1.2, 0);
  parts.push(chin);
  for (const sx of [-1, 1]) {
    const side = new THREE.BoxGeometry(t, H - t * 3.4, d);
    side.translate(sx * (W / 2 - t / 2), -t * 0.7, 0);
    parts.push(side);
    // rear return that wraps over the chassis edge
    const lip = new THREE.BoxGeometry(t * 0.7, H - t * 3.4, 0.011);
    lip.translate(sx * (W / 2 - t * 0.35), -t * 0.7, -d / 2 - 0.0055);
    parts.push(lip);
  }
  const logo = new THREE.BoxGeometry(0.075, 0.0085, 0.004);
  logo.translate(-0.3, -H / 2 + t * 1.25, d / 2);
  parts.push(logo);
  const ir = new THREE.BoxGeometry(0.026, 0.011, 0.005);
  ir.translate(0, -H / 2 + t * 0.8, d / 2);
  parts.push(ir);
  const led = new THREE.CylinderGeometry(0.0035, 0.0035, 0.006, 8);
  led.rotateX(Math.PI / 2);
  led.translate(0.048, -H / 2 + t * 0.8, d / 2);
  parts.push(led);
  return mergeParts(parts);
}

function buildTvChassis() {
  const parts = [];
  const back = new THREE.BoxGeometry(0.9, 0.51, 0.0016, 8, 5, 1);
  parts.push(back);
  // stamped stiffening ribs — the reason a 0.8 mm back panel holds its shape
  for (let i = 0; i < 5; i++) {
    const rib = new THREE.BoxGeometry(0.86, 0.013, 0.007);
    rib.translate(0, -0.2 + i * 0.1, -0.0043);
    parts.push(rib);
  }
  for (let i = 0; i < 4; i++) {
    const rib = new THREE.BoxGeometry(0.011, 0.48, 0.006);
    rib.translate(-0.3 + i * 0.2, 0, -0.0038);
    parts.push(rib);
  }
  // electronics bay bulge + IO cut-out surround
  const bay = new THREE.BoxGeometry(0.44, 0.21, 0.026);
  bay.translate(0, -0.115, -0.0138);
  parts.push(bay);
  const io = new THREE.BoxGeometry(0.13, 0.05, 0.03);
  io.translate(0.3, -0.14, -0.0158);
  parts.push(io);
  // VESA mount bosses
  for (let i = 0; i < 4; i++) {
    const b = new THREE.CylinderGeometry(0.013, 0.013, 0.009, 10);
    b.rotateX(Math.PI / 2);
    b.translate((i % 2 ? 1 : -1) * 0.1, (i < 2 ? 1 : -1) * 0.1, -0.005);
    parts.push(b);
  }
  return mergeParts(parts);
}

function buildTvBoard() {
  const parts = [];
  const board = new THREE.BoxGeometry(0.34, 0.17, 0.0016, 6, 3, 1);
  parts.push(board);
  // RF shield can over the tuner/SoC
  const shield = new THREE.BoxGeometry(0.085, 0.062, 0.007);
  shield.translate(-0.075, 0.022, 0.0043);
  parts.push(shield);
  // finned heatsink
  const hsBase = new THREE.BoxGeometry(0.062, 0.05, 0.004);
  hsBase.translate(0.05, 0.012, 0.0028);
  parts.push(hsBase);
  for (let i = 0; i < 7; i++) {
    const fin = new THREE.BoxGeometry(0.0035, 0.048, 0.014);
    fin.translate(0.023 + i * 0.009, 0.012, 0.0118);
    parts.push(fin);
  }
  // electrolytic cans
  for (let i = 0; i < 4; i++) {
    const cap = new THREE.CylinderGeometry(0.0085, 0.0085, 0.021, 10);
    cap.rotateX(Math.PI / 2);
    cap.translate(-0.14 + i * 0.032, -0.052, 0.0113);
    parts.push(cap);
  }
  // ribbon connectors and the IO stack
  for (let i = 0; i < 2; i++) {
    const con = new THREE.BoxGeometry(0.09, 0.008, 0.006);
    con.translate(-0.06 + i * 0.14, 0.076, 0.0038);
    parts.push(con);
  }
  for (let i = 0; i < 3; i++) {
    const port = new THREE.BoxGeometry(0.021, 0.011, 0.014);
    port.translate(0.11 + i * 0.025, -0.07, 0.0078);
    parts.push(port);
  }
  return mergeParts(parts);
}

function buildTvStand() {
  const parts = [];
  const foot = new THREE.BoxGeometry(0.28, 0.014, 0.17);
  foot.translate(0, -0.048, 0.02);
  parts.push(foot);
  const pad = new THREE.BoxGeometry(0.3, 0.006, 0.02);
  pad.translate(0, -0.055, 0.08);
  parts.push(pad);
  const neck = new THREE.BoxGeometry(0.095, 0.095, 0.032);
  neck.translate(0, 0.008, 0);
  parts.push(neck);
  const gusset = new THREE.BoxGeometry(0.02, 0.06, 0.11);
  gusset.translate(0, -0.02, 0.03);
  parts.push(gusset);
  return mergeParts(parts);
}

/* ------------------------------------------------------- 2. sound system */

function buildSpeakerCabinet() {
  const W = 0.34, H = 0.55, D = 0.32, t = 0.015;
  const parts = [];

  // Ported front baffle: a real extrusion with the driver cut-outs and the
  // port slot taken out as holes, not two discs stuck on a plate.
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, -H / 2);
  shape.lineTo(W / 2, -H / 2);
  shape.lineTo(W / 2, H / 2);
  shape.lineTo(-W / 2, H / 2);
  shape.closePath();
  const woofer = new THREE.Path();
  woofer.absarc(0, -0.1, 0.108, 0, Math.PI * 2, true);
  shape.holes.push(woofer);
  const tweeter = new THREE.Path();
  tweeter.absarc(0, 0.155, 0.045, 0, Math.PI * 2, true);
  shape.holes.push(tweeter);
  const port = new THREE.Path();
  port.moveTo(-0.07, 0.085);
  port.lineTo(0.07, 0.085);
  port.lineTo(0.07, 0.055);
  port.lineTo(-0.07, 0.055);
  port.closePath();
  shape.holes.push(port);
  const baffle = new THREE.ExtrudeGeometry(shape, {
    depth: t, bevelEnabled: false, steps: 1, curveSegments: 16,
  });
  baffle.translate(0, 0, D / 2 - t);
  parts.push(baffle);

  const back = new THREE.BoxGeometry(W, H, t);
  back.translate(0, 0, -D / 2 + t / 2);
  parts.push(back);
  for (const sx of [-1, 1]) {
    const side = new THREE.BoxGeometry(t, H, D - t * 2);
    side.translate(sx * (W / 2 - t / 2), 0, 0);
    parts.push(side);
  }
  for (const sy of [-1, 1]) {
    const cap = new THREE.BoxGeometry(W - t * 2, t, D - t * 2);
    cap.translate(0, sy * (H / 2 - t / 2), 0);
    parts.push(cap);
  }
  // internal brace and the port duct behind the slot
  const brace = new THREE.BoxGeometry(W - t * 2, t * 0.7, D - t * 2);
  brace.translate(0, 0.02, 0);
  parts.push(brace);
  for (const sy of [-1, 1]) {
    const duct = new THREE.BoxGeometry(0.16, 0.006, 0.12);
    duct.translate(0, 0.07 + sy * 0.018, 0.09);
    parts.push(duct);
  }
  // binding-post cup on the back panel
  const cup = new THREE.BoxGeometry(0.08, 0.05, 0.008);
  cup.translate(0, -0.19, -D / 2 + 0.004);
  parts.push(cup);
  // rubber-ish feet
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.CylinderGeometry(0.014, 0.016, 0.008, 10);
    foot.translate((i % 2 ? 1 : -1) * 0.13, -H / 2 - 0.003, (i < 2 ? 1 : -1) * 0.12);
    parts.push(foot);
  }
  return mergeParts(parts);
}

/**
 * Cone driver as a genuine surface of revolution: closed at the rear pole,
 * out along the basket, over the rolled rubber surround, back down the cone
 * face to the dust cap. Revolving a closed profile keeps the mesh watertight.
 */
function buildSpeakerDriver(scale, segments) {
  const prof = [
    [0.000, -0.040], [0.030, -0.040], [0.036, -0.032], [0.062, -0.008],
    [0.104, 0.014], [0.113, 0.018], [0.113, 0.028], [0.106, 0.030],
    [0.101, 0.038], [0.094, 0.030], [0.088, 0.026], [0.026, -0.006],
    [0.022, -0.001], [0.016, 0.008], [0.008, 0.013], [0.000, 0.015],
  ];
  const pts = prof.map((p) => new THREE.Vector2(p[0] * scale, p[1] * scale));
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateX(Math.PI / 2);          // lathe axis Y -> +Z (out of the baffle)
  return g;
}

function buildSpeakerMagnet(scale, segments) {
  const parts = [];
  const ring = new THREE.CylinderGeometry(0.062 * scale, 0.062 * scale, 0.022 * scale, segments);
  parts.push(ring);
  const topPlate = new THREE.CylinderGeometry(0.058 * scale, 0.058 * scale, 0.006 * scale, segments);
  topPlate.translate(0, 0.014 * scale, 0);
  parts.push(topPlate);
  const backPlate = new THREE.CylinderGeometry(0.06 * scale, 0.06 * scale, 0.007 * scale, segments);
  backPlate.translate(0, -0.0145 * scale, 0);
  parts.push(backPlate);
  const pole = new THREE.CylinderGeometry(0.021 * scale, 0.021 * scale, 0.03 * scale, 10);
  pole.translate(0, 0.006 * scale, 0);
  parts.push(pole);
  const g = mergeParts(parts);
  g.rotateX(Math.PI / 2);
  return g;
}

function buildSpeakerGrille() {
  const W = 0.32, H = 0.53, t = 0.0045;
  const parts = [];
  const frameTop = new THREE.BoxGeometry(W, 0.012, t);
  frameTop.translate(0, H / 2 - 0.006, 0);
  parts.push(frameTop);
  const frameBot = frameTop.clone();
  frameBot.translate(0, -H + 0.012, 0);
  parts.push(frameBot);
  for (const sx of [-1, 1]) {
    const rail = new THREE.BoxGeometry(0.012, H - 0.024, t);
    rail.translate(sx * (W / 2 - 0.006), 0, 0);
    parts.push(rail);
  }
  // woven mesh: two crossed sets of fine wires
  const cols = 11, rows = 17;
  for (let i = 0; i < cols; i++) {
    const wire = new THREE.BoxGeometry(0.0022, H - 0.024, 0.002);
    wire.translate(-0.14 + i * 0.028, 0, 0.0008);
    parts.push(wire);
  }
  for (let j = 0; j < rows; j++) {
    const wire = new THREE.BoxGeometry(W - 0.024, 0.0022, 0.002);
    wire.translate(0, -0.248 + j * 0.031, -0.0008);
    parts.push(wire);
  }
  return mergeParts(parts);
}

/* ---------------------------------------------------------- 3. car wheel */

/**
 * Tyre as a revolved closed cross-section (outer casing bead-to-bead, then
 * the inner liner back), so the mesh encloses the rubber only and not the
 * air cavity. The tread blocks are cut by dropping whole angular segments to
 * a lower radius, which keeps the groove walls crisp instead of aliasing
 * against the angular sampling.
 */
function buildTyre(na) {
  const P = [
    [0.206, -0.100, 0], [0.240, -0.104, 0], [0.262, -0.100, 0], [0.288, -0.090, 0],
    [0.303, -0.079, 0], [0.309, -0.070, 1], [0.311, -0.048, 1],
    [0.298, -0.043, 0], [0.298, -0.033, 0],
    [0.311, -0.028, 1], [0.311, 0.028, 1],
    [0.298, 0.033, 0], [0.298, 0.043, 0],
    [0.311, 0.048, 1], [0.309, 0.070, 1],
    [0.303, 0.079, 0], [0.288, 0.090, 0], [0.262, 0.100, 0], [0.240, 0.104, 0],
    [0.206, 0.100, 0],
    [0.250, 0.092, 0], [0.286, 0.070, 0], [0.297, 0.000, 0], [0.286, -0.070, 0], [0.250, -0.092, 0],
  ];
  const np = P.length;

  const vAt = new Float32Array(np + 1);
  for (let j = 1; j <= np; j++) {
    const a = P[j - 1], b = P[j % np];
    vAt[j] = vAt[j - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  const verts = new Float32Array((na + 1) * np * 3);
  const uvs = new Float32Array((na + 1) * np * 2);
  const idx = [];
  let vo = 0, uo = 0;
  for (let i = 0; i <= na; i++) {
    const t = i % na;
    const ang = (t / na) * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let j = 0; j < np; j++) {
      const p = P[j];
      let r = p[0];
      if (p[2]) {
        // 12 blocks per row, the two halves staggered against each other
        const phase = (t + (p[1] > 0 ? 3 : 0)) % 6;
        if (phase < 2) r -= 0.013;
      }
      verts[vo] = ca * r; verts[vo + 1] = p[1]; verts[vo + 2] = -sa * r;
      vo += 3;
      uvs[uo] = (i / na) * 1.76 * 1.4;   // ~one tile per 0.2 m of tread
      uvs[uo + 1] = vAt[j] * 1.4;
      uo += 2;
    }
  }
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < np; j++) {
      const j1 = (j + 1) % np;
      const a = i * np + j, b = i * np + j1;
      const c = (i + 1) * np + j, d = (i + 1) * np + j1;
      idx.push(a, c, d, a, d, b);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildRim() {
  const parts = [];

  // Five-spoke face, cut as one extruded shape: centre bore, lug holes and
  // the windows between the spokes are all holes in the same profile.
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 0.202, 0, Math.PI * 2, false);
  const bore = new THREE.Path();
  bore.absarc(0, 0, 0.033, 0, Math.PI * 2, true);
  shape.holes.push(bore);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const lug = new THREE.Path();
    lug.absarc(Math.cos(a) * 0.058, Math.sin(a) * 0.058, 0.0105, 0, Math.PI * 2, true);
    shape.holes.push(lug);
  }
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * Math.PI * 2 + 0.34;
    const a1 = ((i + 1) / 5) * Math.PI * 2 - 0.34;
    const win = new THREE.Path();
    win.absarc(0, 0, 0.184, a0, a1, false);
    win.absarc(0, 0, 0.088, a1, a0, true);
    shape.holes.push(win);
  }
  const face = new THREE.ExtrudeGeometry(shape, {
    depth: 0.014, bevelEnabled: false, steps: 1, curveSegments: 10,
  });
  face.rotateX(-Math.PI / 2);      // extrusion depth Z -> +Y
  face.translate(0, 0.028, 0);
  parts.push(face);

  // barrel + the two rim lips the tyre beads seat against
  const barrel = new THREE.CylinderGeometry(0.205, 0.205, 0.164, 24, 1, true);
  parts.push(barrel);
  for (const sy of [-1, 1]) {
    const lip = new THREE.TorusGeometry(0.208, 0.0105, 4, 24);
    lip.rotateX(Math.PI / 2);
    lip.translate(0, sy * 0.082, 0);
    parts.push(lip);
  }
  // hub register + valve stem
  const hub = new THREE.CylinderGeometry(0.05, 0.05, 0.016, 14);
  hub.translate(0, 0.03, 0);
  parts.push(hub);
  const valve = new THREE.CylinderGeometry(0.006, 0.006, 0.022, 8);
  valve.rotateZ(Math.PI / 2);
  valve.translate(0.208, -0.05, 0);
  parts.push(valve);

  return mergeParts(parts);
}

/* ---------------------------------------------------- 4. microwave oven */

function buildMicrowaveShell() {
  const W = 0.5, H = 0.29, D = 0.38, t = 0.004;
  const parts = [];
  const top = new THREE.BoxGeometry(W, t, D, 5, 1, 4);
  top.translate(0, H / 2 - t / 2, 0);
  parts.push(top);
  const bottom = new THREE.BoxGeometry(W, t, D, 5, 1, 4);
  bottom.translate(0, -H / 2 + t / 2, 0);
  parts.push(bottom);
  for (const sx of [-1, 1]) {
    const side = new THREE.BoxGeometry(t, H - t * 2, D, 1, 4, 4);
    side.translate(sx * (W / 2 - t / 2), 0, 0);
    parts.push(side);
  }
  const back = new THREE.BoxGeometry(W - t * 2, H - t * 2, t, 5, 4, 1);
  back.translate(0, 0, -D / 2 + t / 2);
  parts.push(back);

  // front flange around the door aperture
  const flangeTop = new THREE.BoxGeometry(W, 0.03, t);
  flangeTop.translate(0, H / 2 - 0.015, D / 2 - t / 2);
  parts.push(flangeTop);
  const flangeBot = new THREE.BoxGeometry(W, 0.03, t);
  flangeBot.translate(0, -H / 2 + 0.015, D / 2 - t / 2);
  parts.push(flangeBot);
  const flangeLeft = new THREE.BoxGeometry(0.015, H, t);
  flangeLeft.translate(-W / 2 + 0.0075, 0, D / 2 - t / 2);
  parts.push(flangeLeft);
  const flangeRight = new THREE.BoxGeometry(0.17, H, t);
  flangeRight.translate(0.165, 0, D / 2 - t / 2);
  parts.push(flangeRight);

  // inner cavity liner and the divider to the magnetron bay
  const liner = [
    [0.325, 0.003, 0.345, -0.0725, 0.1175, 0.0125],
    [0.325, 0.003, 0.345, -0.0725, -0.1175, 0.0125],
    [0.003, 0.235, 0.345, -0.2335, 0, 0.0125],
    [0.003, 0.235, 0.345, 0.0885, 0, 0.0125],
    [0.325, 0.235, 0.003, -0.0725, 0, -0.1585],
  ];
  for (const l of liner) {
    const b = new THREE.BoxGeometry(l[0], l[1], l[2]);
    b.translate(l[3], l[4], l[5]);
    parts.push(b);
  }
  // side vent louvres
  for (let i = 0; i < 7; i++) {
    const lv = new THREE.BoxGeometry(0.005, 0.008, 0.13);
    lv.translate(W / 2 - 0.004, -0.06 + i * 0.02, -0.06);
    parts.push(lv);
  }
  // feet
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.CylinderGeometry(0.012, 0.014, 0.008, 8);
    foot.translate((i % 2 ? 1 : -1) * 0.2, -H / 2 - 0.003, (i < 2 ? 1 : -1) * 0.14);
    parts.push(foot);
  }
  return mergeParts(parts);
}

function buildMicrowaveDoor() {
  const W = 0.345, H = 0.27;
  const parts = [];
  const pane = new THREE.BoxGeometry(W, H, 0.004, 6, 5, 1);
  pane.translate(0, 0, 0.006);
  parts.push(pane);
  const inner = new THREE.BoxGeometry(W - 0.05, H - 0.05, 0.003, 4, 3, 1);
  inner.translate(0, 0, -0.008);
  parts.push(inner);
  // perforated RF screen between the panes
  const cols = 15, rows = 11;
  for (let i = 0; i < cols; i++) {
    const wire = new THREE.BoxGeometry(0.0016, H - 0.06, 0.0014);
    wire.translate(-0.128 + i * 0.0183, 0, -0.0015);
    parts.push(wire);
  }
  for (let j = 0; j < rows; j++) {
    const wire = new THREE.BoxGeometry(W - 0.06, 0.0016, 0.0014);
    wire.translate(0, -0.105 + j * 0.021, -0.0035);
    parts.push(wire);
  }
  // frame lip and handle
  for (const sy of [-1, 1]) {
    const bar = new THREE.BoxGeometry(W, 0.014, 0.02);
    bar.translate(0, sy * (H / 2 - 0.007), 0);
    parts.push(bar);
  }
  for (const sx of [-1, 1]) {
    const bar = new THREE.BoxGeometry(0.014, H - 0.028, 0.02);
    bar.translate(sx * (W / 2 - 0.007), 0, 0);
    parts.push(bar);
  }
  const handle = new THREE.BoxGeometry(0.022, H - 0.06, 0.016);
  handle.translate(W / 2 - 0.006, 0, 0.024);
  parts.push(handle);
  for (const sy of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.016, 0.02, 0.02);
    post.translate(W / 2 - 0.014, sy * (H / 2 - 0.04), 0.014);
    parts.push(post);
  }
  return mergeParts(parts);
}

function buildMicrowavePanel() {
  const parts = [];
  const face = new THREE.BoxGeometry(0.15, 0.27, 0.006, 3, 5, 1);
  parts.push(face);
  const display = new THREE.BoxGeometry(0.11, 0.032, 0.004);
  display.translate(0, 0.095, 0.004);
  parts.push(display);
  for (let r = 0; r < 4; r++) {
    for (let ccol = 0; ccol < 3; ccol++) {
      const btn = new THREE.BoxGeometry(0.026, 0.015, 0.004);
      btn.translate(-0.036 + ccol * 0.036, 0.03 - r * 0.026, 0.004);
      parts.push(btn);
    }
  }
  const dial = new THREE.CylinderGeometry(0.026, 0.028, 0.014, 14);
  dial.rotateX(Math.PI / 2);
  dial.translate(0, -0.095, 0.008);
  parts.push(dial);
  return mergeParts(parts);
}

function buildMicrowaveTransformer() {
  const parts = [];
  // laminated E-I core
  for (let i = 0; i < 9; i++) {
    const lam = new THREE.BoxGeometry(0.0105, 0.1, 0.086);
    lam.translate(-0.044 + i * 0.011, 0, 0);
    parts.push(lam);
  }
  for (const sy of [-1, 1]) {
    const winding = new THREE.BoxGeometry(0.104, 0.03, 0.05);
    winding.translate(0, sy * 0.031, 0);
    parts.push(winding);
  }
  for (const sy of [-1, 1]) {
    const foot = new THREE.BoxGeometry(0.11, 0.008, 0.016);
    foot.translate(0, sy * 0.054, 0.04);
    parts.push(foot);
  }
  return mergeParts(parts);
}

function buildMicrowaveTurntable() {
  const parts = [];
  const plate = new THREE.CylinderGeometry(0.135, 0.135, 0.005, 26);
  parts.push(plate);
  const rim = new THREE.TorusGeometry(0.132, 0.0045, 5, 26);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.001, 0);
  parts.push(rim);
  const hub = new THREE.CylinderGeometry(0.026, 0.03, 0.012, 12);
  hub.translate(0, -0.008, 0);
  parts.push(hub);
  // roller ring underneath
  const ring = new THREE.TorusGeometry(0.075, 0.0035, 4, 20);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, -0.013, 0);
  parts.push(ring);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const roller = new THREE.CylinderGeometry(0.009, 0.009, 0.006, 8);
    roller.rotateZ(Math.PI / 2);
    roller.rotateY(-a);
    roller.translate(Math.cos(a) * 0.075, -0.013, Math.sin(a) * 0.075);
    parts.push(roller);
  }
  return mergeParts(parts);
}

/* ------------------------------------------------ 5. kitchen & housewares */

/**
 * Blender jug: a closed lathe profile (floor, up the outside, over the rim,
 * back down the inside, across the floor) so the shell encloses the glass
 * wall only and `computeVolume` returns the mass of glass, not of air.
 */
function buildBlenderJug() {
  const prof = [
    [0.000, -0.094], [0.056, -0.094], [0.062, -0.088], [0.072, -0.034],
    [0.084, 0.048], [0.090, 0.096], [0.082, 0.096], [0.077, 0.048],
    [0.065, -0.030], [0.055, -0.080], [0.000, -0.080],
  ];
  const parts = [new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), 22)];
  const handle = new THREE.TorusGeometry(0.05, 0.0085, 6, 12, Math.PI * 1.15);
  handle.rotateZ(-Math.PI * 0.575);
  handle.translate(0.078, 0.014, 0);
  parts.push(handle);
  const spout = new THREE.BoxGeometry(0.03, 0.02, 0.032);
  spout.rotateZ(0.34);
  spout.translate(-0.084, 0.09, 0);
  parts.push(spout);
  const collar = new THREE.TorusGeometry(0.086, 0.003, 4, 20);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 0.074, 0);
  parts.push(collar);
  return mergeParts(parts);
}

function buildBlenderLid() {
  const parts = [];
  const disc = new THREE.CylinderGeometry(0.086, 0.09, 0.012, 20);
  parts.push(disc);
  const skirt = new THREE.CylinderGeometry(0.092, 0.092, 0.014, 20);
  skirt.translate(0, -0.011, 0);
  parts.push(skirt);
  const cap = new THREE.CylinderGeometry(0.024, 0.028, 0.014, 12);
  cap.translate(0, 0.012, 0);
  parts.push(cap);
  const tab = new THREE.BoxGeometry(0.028, 0.009, 0.018);
  tab.translate(0.096, 0.003, 0);
  parts.push(tab);
  return mergeParts(parts);
}

function buildBlenderBase() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.07, 0.094, 0.15, 18);
  parts.push(body);
  const collar = new THREE.CylinderGeometry(0.062, 0.062, 0.018, 18);
  collar.translate(0, 0.082, 0);
  parts.push(collar);
  const panel = new THREE.BoxGeometry(0.072, 0.054, 0.012);
  panel.translate(0, -0.018, 0.079);
  parts.push(panel);
  for (let i = 0; i < 3; i++) {
    const btn = new THREE.CylinderGeometry(0.009, 0.009, 0.008, 10);
    btn.rotateX(Math.PI / 2);
    btn.translate(-0.022 + i * 0.022, -0.018, 0.087);
    parts.push(btn);
  }
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.CylinderGeometry(0.012, 0.014, 0.01, 8);
    foot.translate((i % 2 ? 1 : -1) * 0.055, -0.079, (i < 2 ? 1 : -1) * 0.055);
    parts.push(foot);
  }
  return mergeParts(parts);
}

function buildBlenderBlade() {
  const parts = [];
  const hub = new THREE.CylinderGeometry(0.014, 0.016, 0.026, 12);
  parts.push(hub);
  const shaft = new THREE.CylinderGeometry(0.007, 0.007, 0.054, 10);
  shaft.translate(0, -0.032, 0);
  parts.push(shaft);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const blade = new THREE.BoxGeometry(0.05, 0.0018, 0.013);
    blade.rotateZ(i < 2 ? 0.34 : -0.34);
    blade.rotateY(-a);
    blade.translate(Math.cos(a) * 0.03, i < 2 ? 0.006 : -0.006, -Math.sin(a) * 0.03);
    parts.push(blade);
  }
  const nut = new THREE.CylinderGeometry(0.01, 0.01, 0.008, 6);
  nut.translate(0, 0.016, 0);
  parts.push(nut);
  return mergeParts(parts);
}

/** Universal motor: stator can, two end windings, armature shaft, fan. */
function buildMotorCan(radius, length, segments) {
  const parts = [];
  const can = new THREE.CylinderGeometry(radius, radius, length, segments);
  parts.push(can);
  for (const sy of [-1, 1]) {
    const winding = new THREE.TorusGeometry(radius * 0.8, radius * 0.28, 6, segments);
    winding.rotateX(Math.PI / 2);
    winding.translate(0, sy * length * 0.5, 0);
    parts.push(winding);
  }
  const shaft = new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, length * 1.45, 8);
  parts.push(shaft);
  const fan = new THREE.CylinderGeometry(radius * 0.84, radius * 0.84, length * 0.09, 12);
  fan.translate(0, -length * 0.63, 0);
  parts.push(fan);
  return mergeParts(parts);
}

function buildToasterShell() {
  const W = 0.26, H = 0.19, D = 0.164, t = 0.0035;
  const parts = [];
  for (const sz of [-1, 1]) {
    const face = new THREE.BoxGeometry(W, H, t, 5, 4, 1);
    face.translate(0, 0, sz * (D / 2 - t / 2));
    parts.push(face);
  }
  // Top deck: three strips framing the two bread slots, plus the end lands.
  const deckY = H / 2 - t / 2;
  for (const spec of [[W, 0.03, 0.066], [W, 0.036, 0], [W, 0.03, -0.066]]) {
    const strip = new THREE.BoxGeometry(spec[0], t, spec[1]);
    strip.translate(0, deckY, spec[2]);
    parts.push(strip);
  }
  for (const sx of [-1, 1]) {
    const land = new THREE.BoxGeometry(0.06, t, D);
    land.translate(sx * (W / 2 - 0.03), deckY, 0);
    parts.push(land);
  }
  const pan = new THREE.BoxGeometry(W, t, D);
  pan.translate(0, -H / 2 + t / 2, 0);
  parts.push(pan);
  // carriage lever slot surround and the crumb-tray lip
  const slot = new THREE.BoxGeometry(0.014, 0.11, 0.006);
  slot.translate(0.088, 0.01, D / 2);
  parts.push(slot);
  const tray = new THREE.BoxGeometry(W - 0.02, 0.012, 0.006);
  tray.translate(0, -H / 2 + 0.016, D / 2);
  parts.push(tray);
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.CylinderGeometry(0.009, 0.011, 0.008, 8);
    foot.translate((i % 2 ? 1 : -1) * 0.1, -H / 2 - 0.004, (i < 2 ? 1 : -1) * 0.055);
    parts.push(foot);
  }
  return mergeParts(parts);
}

function buildToasterEnds() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const cap = new THREE.BoxGeometry(0.012, 0.192, 0.166, 1, 4, 4);
    cap.translate(sx * 0.136, 0, 0);
    parts.push(cap);
  }
  const lever = new THREE.BoxGeometry(0.03, 0.016, 0.012);
  lever.translate(0.088, 0.055, 0.088);
  parts.push(lever);
  const stem = new THREE.BoxGeometry(0.012, 0.09, 0.006);
  stem.translate(0.088, 0.014, 0.086);
  parts.push(stem);
  const dial = new THREE.CylinderGeometry(0.016, 0.018, 0.014, 12);
  dial.rotateX(Math.PI / 2);
  dial.translate(0.088, -0.05, 0.088);
  parts.push(dial);
  return mergeParts(parts);
}

/** Nichrome ribbon zig-zagged across mica boards — four element planes. */
function buildToasterElements() {
  const parts = [];
  for (const z of [-0.052, -0.017, 0.017, 0.052]) {
    const board = new THREE.BoxGeometry(0.2, 0.13, 0.0016);
    board.translate(0, 0, z);
    parts.push(board);
    for (let i = 0; i < 6; i++) {
      const wire = new THREE.BoxGeometry(0.204, 0.0026, 0.0034);
      wire.translate(0, -0.05 + i * 0.02, z + 0.0025);
      parts.push(wire);
    }
    for (const sx of [-1, 1]) {
      const rail = new THREE.BoxGeometry(0.004, 0.13, 0.005);
      rail.translate(sx * 0.102, 0, z);
      parts.push(rail);
    }
  }
  return mergeParts(parts);
}

function buildSmallBoard(w, h, seedComponents) {
  const parts = [];
  const board = new THREE.BoxGeometry(w, h, 0.0016, 4, 3, 1);
  parts.push(board);
  for (let i = 0; i < seedComponents; i++) {
    const t = i / seedComponents;
    if (i % 3 === 0) {
      const cap = new THREE.CylinderGeometry(0.007, 0.007, 0.016, 8);
      cap.rotateX(Math.PI / 2);
      cap.translate(-w * 0.4 + t * w * 0.8, h * 0.22, 0.0088);
      parts.push(cap);
    } else if (i % 3 === 1) {
      const ic = new THREE.BoxGeometry(0.018, 0.01, 0.003);
      ic.translate(-w * 0.4 + t * w * 0.8, -h * 0.1, 0.0023);
      parts.push(ic);
    } else {
      const relay = new THREE.BoxGeometry(0.014, 0.014, 0.012);
      relay.translate(-w * 0.4 + t * w * 0.8, -h * 0.3, 0.0068);
      parts.push(relay);
    }
  }
  const header = new THREE.BoxGeometry(w * 0.3, 0.007, 0.008);
  header.translate(0, h * 0.42, 0.0048);
  parts.push(header);
  return mergeParts(parts);
}

function buildCoffeeShell() {
  const parts = [];
  // reservoir tower behind, brew basket housing in front
  const tower = new THREE.BoxGeometry(0.17, 0.3, 0.14, 3, 5, 3);
  tower.translate(0, 0.03, -0.055);
  parts.push(tower);
  const head = new THREE.BoxGeometry(0.17, 0.07, 0.15);
  head.translate(0, 0.152, 0.035);
  parts.push(head);
  const plinth = new THREE.BoxGeometry(0.17, 0.05, 0.24);
  plinth.translate(0, -0.145, 0.02);
  parts.push(plinth);
  const basket = new THREE.CylinderGeometry(0.058, 0.05, 0.05, 14);
  basket.translate(0, 0.09, 0.04);
  parts.push(basket);
  const lidPanel = new THREE.BoxGeometry(0.16, 0.012, 0.13);
  lidPanel.translate(0, 0.186, -0.055);
  parts.push(lidPanel);
  const gauge = new THREE.BoxGeometry(0.03, 0.2, 0.008);
  gauge.translate(0.06, 0.03, 0.016);
  parts.push(gauge);
  const rocker = new THREE.BoxGeometry(0.03, 0.016, 0.008);
  rocker.translate(-0.05, -0.14, 0.142);
  parts.push(rocker);
  return mergeParts(parts);
}

function buildCarafe() {
  const prof = [
    [0.000, -0.072], [0.056, -0.072], [0.062, -0.066], [0.07, -0.02],
    [0.074, 0.05], [0.078, 0.078], [0.07, 0.078], [0.067, 0.05],
    [0.063, -0.016], [0.055, -0.058], [0.000, -0.058],
  ];
  const parts = [new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), 20)];
  const handle = new THREE.TorusGeometry(0.042, 0.008, 6, 12, Math.PI * 1.2);
  handle.rotateZ(-Math.PI * 0.6);
  handle.translate(0.07, 0.01, 0);
  parts.push(handle);
  const lid = new THREE.CylinderGeometry(0.066, 0.07, 0.014, 18);
  lid.translate(0, 0.083, 0);
  parts.push(lid);
  const knob = new THREE.CylinderGeometry(0.014, 0.018, 0.012, 10);
  knob.translate(0, 0.094, 0);
  parts.push(knob);
  return mergeParts(parts);
}

function buildHotPlate() {
  const parts = [];
  const plate = new THREE.CylinderGeometry(0.078, 0.078, 0.006, 20);
  parts.push(plate);
  const rim = new THREE.TorusGeometry(0.076, 0.004, 4, 20);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.003, 0);
  parts.push(rim);
  const element = new THREE.TorusGeometry(0.05, 0.0055, 5, 18);
  element.rotateX(Math.PI / 2);
  element.translate(0, -0.006, 0);
  parts.push(element);
  const bracket = new THREE.BoxGeometry(0.09, 0.014, 0.05);
  bracket.translate(0, -0.012, -0.05);
  parts.push(bracket);
  return mergeParts(parts);
}

/** Copper feed loop: a chain of closed tube segments so the volume is real. */
function buildCopperTubing() {
  const parts = [];
  const R = 0.075;
  for (let i = 0; i < 9; i++) {
    const a = -0.35 + (i / 8) * Math.PI * 1.15;
    const seg = new THREE.CylinderGeometry(0.0065, 0.0065, 0.036, 8);
    seg.rotateZ(a);
    seg.translate(Math.cos(a) * R, Math.sin(a) * R, 0);
    parts.push(seg);
  }
  const riser = new THREE.CylinderGeometry(0.0065, 0.0065, 0.13, 8);
  riser.translate(-0.072, 0.03, 0);
  parts.push(riser);
  for (const sy of [-1, 1]) {
    const union = new THREE.CylinderGeometry(0.009, 0.009, 0.012, 8);
    union.translate(-0.072, sy * 0.07 + 0.03, 0);
    parts.push(union);
  }
  return mergeParts(parts);
}

function buildVacuumBody() {
  const parts = [];
  const barrel = new THREE.CylinderGeometry(0.13, 0.13, 0.26, 20);
  barrel.rotateZ(Math.PI / 2);
  parts.push(barrel);
  for (const sx of [-1, 1]) {
    const dome = new THREE.SphereGeometry(0.13, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.scale(1, 0.42, 1);
    dome.rotateZ(sx * Math.PI / 2);
    dome.translate(sx * 0.13, 0, 0);
    parts.push(dome);
  }
  const handle = new THREE.TorusGeometry(0.06, 0.012, 6, 14, Math.PI);
  handle.rotateY(Math.PI / 2);
  handle.translate(0, 0.13, 0);
  parts.push(handle);
  const inlet = new THREE.CylinderGeometry(0.03, 0.034, 0.05, 12);
  inlet.rotateZ(Math.PI / 2);
  inlet.translate(0.17, 0.03, 0);
  parts.push(inlet);
  const latch = new THREE.BoxGeometry(0.03, 0.05, 0.02);
  latch.translate(0.02, -0.005, 0.13);
  parts.push(latch);
  // plastic castor wheels
  for (let i = 0; i < 4; i++) {
    const wheel = new THREE.CylinderGeometry(0.028, 0.028, 0.016, 10);
    wheel.rotateX(Math.PI / 2);
    wheel.translate((i % 2 ? 1 : -1) * 0.09, -0.115, (i < 2 ? 1 : -1) * 0.075);
    parts.push(wheel);
  }
  return mergeParts(parts);
}

function buildVacuumHose() {
  const parts = [];
  const R = 0.155;
  for (let i = 0; i < 10; i++) {
    const a = -0.25 + (i / 9) * Math.PI * 1.05;
    const seg = new THREE.CylinderGeometry(0.024, 0.024, 0.055, 10);
    seg.rotateZ(a);
    seg.translate(Math.cos(a) * R, Math.sin(a) * R, 0);
    parts.push(seg);
    if (i % 2 === 0) {
      const rib = new THREE.TorusGeometry(0.026, 0.005, 5, 10);
      rib.rotateX(Math.PI / 2);
      rib.rotateZ(a);
      rib.translate(Math.cos(a) * R, Math.sin(a) * R, 0);
      parts.push(rib);
    }
  }
  for (const a of [-0.25, Math.PI * 1.05 - 0.25]) {
    const cuff = new THREE.CylinderGeometry(0.03, 0.03, 0.04, 10);
    cuff.rotateZ(a);
    cuff.translate(Math.cos(a) * R, Math.sin(a) * R, 0);
    parts.push(cuff);
  }
  return mergeParts(parts);
}

/* ---------------------------------------------------- 6. tools & hardware */

function buildDrillBody() {
  const parts = [];
  const housing = new THREE.CylinderGeometry(0.036, 0.033, 0.16, 14);
  housing.rotateZ(Math.PI / 2);
  parts.push(housing);
  const shoulder = new THREE.SphereGeometry(0.036, 12, 8);
  shoulder.scale(0.6, 1, 1);
  shoulder.translate(-0.08, 0, 0);
  parts.push(shoulder);
  const grip = new THREE.BoxGeometry(0.05, 0.13, 0.042, 1, 3, 1);
  grip.rotateZ(0.16);
  grip.translate(-0.028, -0.085, 0);
  parts.push(grip);
  const trigger = new THREE.BoxGeometry(0.022, 0.03, 0.026);
  trigger.translate(0.006, -0.036, 0);
  parts.push(trigger);
  const clutch = new THREE.CylinderGeometry(0.032, 0.032, 0.018, 14);
  clutch.rotateZ(Math.PI / 2);
  clutch.translate(0.072, 0, 0);
  parts.push(clutch);
  const vent = new THREE.BoxGeometry(0.05, 0.03, 0.07);
  vent.translate(-0.05, 0.012, 0);
  parts.push(vent);
  return mergeParts(parts);
}

function buildDrillGearcase() {
  const parts = [];
  const nose = new THREE.CylinderGeometry(0.026, 0.031, 0.05, 14);
  nose.rotateZ(Math.PI / 2);
  parts.push(nose);
  const chuck = new THREE.CylinderGeometry(0.022, 0.026, 0.052, 14);
  chuck.rotateZ(Math.PI / 2);
  chuck.translate(0.05, 0, 0);
  parts.push(chuck);
  const collar = new THREE.TorusGeometry(0.024, 0.005, 5, 14);
  collar.rotateY(Math.PI / 2);
  collar.translate(0.07, 0, 0);
  parts.push(collar);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const jaw = new THREE.BoxGeometry(0.026, 0.008, 0.008);
    jaw.rotateX(a);
    jaw.translate(0.084, Math.cos(a) * 0.009, Math.sin(a) * 0.009);
    parts.push(jaw);
  }
  const bit = new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8);
  bit.rotateZ(Math.PI / 2);
  bit.translate(0.12, 0, 0);
  parts.push(bit);
  return mergeParts(parts);
}

function buildDrillBattery() {
  const parts = [];
  const pack = new THREE.BoxGeometry(0.078, 0.05, 0.068, 3, 2, 2);
  parts.push(pack);
  const tongue = new THREE.BoxGeometry(0.042, 0.022, 0.04);
  tongue.translate(0.004, 0.034, 0);
  parts.push(tongue);
  for (let i = 0; i < 5; i++) {
    const cell = new THREE.CylinderGeometry(0.009, 0.009, 0.05, 8);
    cell.rotateX(Math.PI / 2);
    cell.translate(-0.03 + i * 0.015, -0.004, 0);
    parts.push(cell);
  }
  const latch = new THREE.BoxGeometry(0.014, 0.014, 0.07);
  latch.translate(-0.036, 0.012, 0);
  parts.push(latch);
  return mergeParts(parts);
}

/**
 * Sledge head: an octagonal billet with a tapered striking face at one end,
 * a chamfered peen at the other and a raised eye boss where the handle
 * passes through. Nothing here is thin, which is the whole point.
 */
function buildSledgeHead() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.032, 0.032, 0.17, 8);
  body.rotateZ(Math.PI / 2);
  parts.push(body);
  for (const sx of [-1, 1]) {
    const face = new THREE.CylinderGeometry(0.028, 0.032, 0.016, 8);
    face.rotateZ(sx * Math.PI / 2);
    face.translate(sx * 0.093, 0, 0);
    parts.push(face);
  }
  const eye = new THREE.CylinderGeometry(0.019, 0.019, 0.05, 12);
  parts.push(eye);
  const boss = new THREE.CylinderGeometry(0.023, 0.026, 0.012, 12);
  boss.translate(0, 0.021, 0);
  parts.push(boss);
  return mergeParts(parts);
}

function buildSledgeHandle() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.019, 0.016, 0.86, 12);
  parts.push(shaft);
  const swell = new THREE.CylinderGeometry(0.023, 0.019, 0.09, 12);
  swell.translate(0, -0.43, 0);
  parts.push(swell);
  const shoulder = new THREE.CylinderGeometry(0.023, 0.02, 0.11, 12);
  shoulder.translate(0, 0.4, 0);
  parts.push(shoulder);
  for (let i = 0; i < 3; i++) {
    const wrap = new THREE.TorusGeometry(0.021, 0.0022, 4, 12);
    wrap.rotateX(Math.PI / 2);
    wrap.translate(0, -0.3 + i * 0.03, 0);
    parts.push(wrap);
  }
  return mergeParts(parts);
}

function buildPipeWrench() {
  const parts = [];
  // handle: hex bar, swelling into the frame
  const handle = new THREE.CylinderGeometry(0.017, 0.022, 0.3, 6);
  handle.translate(0, -0.16, 0);
  parts.push(handle);
  const butt = new THREE.CylinderGeometry(0.02, 0.014, 0.03, 6);
  butt.translate(0, -0.32, 0);
  parts.push(butt);
  const frame = new THREE.BoxGeometry(0.05, 0.13, 0.024, 2, 3, 1);
  frame.translate(0, 0.045, 0);
  parts.push(frame);
  // fixed hook jaw
  const hook = new THREE.BoxGeometry(0.086, 0.026, 0.024);
  hook.rotateZ(-0.12);
  hook.translate(0.036, 0.135, 0);
  parts.push(hook);
  const hookTooth = new THREE.BoxGeometry(0.07, 0.012, 0.022);
  hookTooth.rotateZ(-0.12);
  hookTooth.translate(0.03, 0.117, 0);
  parts.push(hookTooth);
  // movable jaw riding the frame
  const jaw = new THREE.BoxGeometry(0.078, 0.024, 0.022);
  jaw.rotateZ(0.1);
  jaw.translate(0.032, 0.056, 0);
  parts.push(jaw);
  const jawPost = new THREE.BoxGeometry(0.028, 0.05, 0.02);
  jawPost.translate(-0.004, 0.038, 0);
  parts.push(jawPost);
  // knurled adjusting nut
  const nut = new THREE.CylinderGeometry(0.026, 0.026, 0.022, 14);
  nut.translate(0, 0.006, 0);
  parts.push(nut);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const knurl = new THREE.BoxGeometry(0.004, 0.022, 0.006);
    knurl.rotateY(-a);
    knurl.translate(Math.cos(a) * 0.026, 0.006, Math.sin(a) * 0.026);
    parts.push(knurl);
  }
  const g = mergeParts(parts);
  // Single-body items tumble about their own origin, so sit the wrench on it.
  g.translate(0, 0.091, 0);
  return g;
}

function buildMowerDeck() {
  const parts = [];
  const pan = new THREE.CylinderGeometry(0.255, 0.275, 0.1, 22);
  parts.push(pan);
  const lip = new THREE.TorusGeometry(0.274, 0.009, 5, 22);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, -0.05, 0);
  parts.push(lip);
  const chute = new THREE.BoxGeometry(0.15, 0.09, 0.14);
  chute.rotateY(0.5);
  chute.translate(0.24, -0.005, -0.2);
  parts.push(chute);
  const boss = new THREE.CylinderGeometry(0.06, 0.07, 0.05, 14);
  boss.translate(0, 0.06, 0);
  parts.push(boss);
  for (let i = 0; i < 4; i++) {
    const bracket = new THREE.BoxGeometry(0.05, 0.07, 0.03);
    bracket.rotateY((i < 2 ? 0 : 1) * Math.PI);
    bracket.translate((i % 2 ? 1 : -1) * 0.21, -0.05, (i < 2 ? 1 : -1) * 0.19);
    parts.push(bracket);
  }
  return mergeParts(parts);
}

function buildMowerShroud() {
  const parts = [];
  const cowl = new THREE.BoxGeometry(0.28, 0.15, 0.26, 3, 2, 3);
  parts.push(cowl);
  const scoop = new THREE.BoxGeometry(0.16, 0.06, 0.1);
  scoop.rotateX(0.3);
  scoop.translate(0, 0.085, 0.1);
  parts.push(scoop);
  for (let i = 0; i < 6; i++) {
    const louvre = new THREE.BoxGeometry(0.2, 0.008, 0.012);
    louvre.translate(0, 0.02 + i * 0.018, 0.128);
    parts.push(louvre);
  }
  const cap = new THREE.CylinderGeometry(0.03, 0.032, 0.02, 12);
  cap.translate(-0.08, 0.084, -0.06);
  parts.push(cap);
  return mergeParts(parts);
}

function buildMowerEngine() {
  const parts = [];
  const block = new THREE.CylinderGeometry(0.075, 0.082, 0.13, 16);
  parts.push(block);
  for (let i = 0; i < 6; i++) {
    const fin = new THREE.CylinderGeometry(0.09, 0.09, 0.006, 16);
    fin.translate(0, -0.05 + i * 0.02, 0);
    parts.push(fin);
  }
  const head = new THREE.BoxGeometry(0.12, 0.07, 0.11);
  head.translate(0.05, 0.085, 0);
  parts.push(head);
  const tank = new THREE.BoxGeometry(0.13, 0.07, 0.12, 2, 1, 2);
  tank.translate(-0.06, 0.09, 0);
  parts.push(tank);
  const muffler = new THREE.CylinderGeometry(0.03, 0.03, 0.09, 12);
  muffler.rotateZ(Math.PI / 2);
  muffler.translate(0.075, -0.01, 0.06);
  parts.push(muffler);
  const recoil = new THREE.CylinderGeometry(0.06, 0.06, 0.03, 14);
  recoil.translate(0, 0.075, 0);
  parts.push(recoil);
  const shaft = new THREE.CylinderGeometry(0.014, 0.014, 0.11, 8);
  shaft.translate(0, -0.1, 0);
  parts.push(shaft);
  return mergeParts(parts);
}

function buildMowerBlade() {
  const parts = [];
  const bar = new THREE.BoxGeometry(0.44, 0.008, 0.05, 8, 1, 1);
  parts.push(bar);
  for (const sx of [-1, 1]) {
    const lift = new THREE.BoxGeometry(0.06, 0.024, 0.048);
    lift.rotateX(sx * 0.5);
    lift.translate(sx * 0.19, 0.008, 0);
    parts.push(lift);
    const edge = new THREE.BoxGeometry(0.12, 0.003, 0.03);
    edge.translate(sx * 0.15, -0.004, 0.016);
    parts.push(edge);
  }
  const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.012, 12);
  parts.push(hub);
  return mergeParts(parts);
}

/** A pair of tread-moulded wheels merged into one body. */
function buildMowerWheels(radius, width, offsetX, offsetZ) {
  const parts = [];
  for (const sx of [-1, 1]) {
    const tyre = new THREE.CylinderGeometry(radius, radius, width, 16);
    tyre.rotateZ(Math.PI / 2);
    tyre.translate(sx * offsetX, 0, offsetZ);
    parts.push(tyre);
    const hub = new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, width * 1.15, 12);
    hub.rotateZ(Math.PI / 2);
    hub.translate(sx * offsetX, 0, offsetZ);
    parts.push(hub);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const lug = new THREE.BoxGeometry(width * 0.9, 0.012, radius * 0.5);
      lug.rotateX(a);
      lug.translate(sx * offsetX, Math.cos(a) * radius, offsetZ + Math.sin(a) * radius);
      parts.push(lug);
    }
  }
  return mergeParts(parts);
}

function buildMowerHandle() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.CylinderGeometry(0.013, 0.013, 0.62, 8);
    arm.rotateX(-0.62);
    arm.translate(sx * 0.19, 0, -0.02);
    parts.push(arm);
    const upper = new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8);
    upper.rotateX(-0.62);
    upper.translate(sx * 0.19, 0.4, -0.29);
    parts.push(upper);
  }
  const cross = new THREE.CylinderGeometry(0.012, 0.012, 0.4, 8);
  cross.rotateZ(Math.PI / 2);
  cross.translate(0, 0.53, -0.38);
  parts.push(cross);
  const bail = new THREE.CylinderGeometry(0.008, 0.008, 0.36, 6);
  bail.rotateZ(Math.PI / 2);
  bail.translate(0, 0.46, -0.31);
  parts.push(bail);
  for (const sx of [-1, 1]) {
    const knob = new THREE.CylinderGeometry(0.018, 0.018, 0.02, 8);
    knob.rotateZ(Math.PI / 2);
    knob.translate(sx * 0.19, 0.13, -0.16);
    parts.push(knob);
  }
  return mergeParts(parts);
}

/* ------------------------------------------------------ 7. office & home */

/**
 * A clustered block of keycaps.
 *
 * Modelled as one merged body per cluster on purpose: 100 individual rigid
 * bodies would eat the entire scene budget on its own. The material carries
 * `shatter` 0.9 / `fragmentScale` 0.22, so the block still bursts into a lot
 * of small pieces the instant a tooth reaches it.
 */
function buildKeycapCluster(cols, rows, pitch, functionRow) {
  const parts = [];
  const x0 = -((cols - 1) * pitch) / 2;
  const z0 = -((rows - 1) * pitch) / 2;
  for (let r = 0; r < rows; r++) {
    for (let ccol = 0; ccol < cols; ccol++) {
      // the F-key row is broken into groups of four
      if (functionRow && r === 0 && ccol % 4 === 3) continue;
      const cap = new THREE.CylinderGeometry(0.0102, 0.012, 0.008, 4);
      cap.rotateY(Math.PI / 4);
      cap.translate(x0 + ccol * pitch, 0, z0 + r * pitch);
      parts.push(cap);
    }
  }
  return mergeParts(parts);
}

function buildKeyboardTray() {
  const parts = [];
  const pan = new THREE.BoxGeometry(0.45, 0.006, 0.155, 8, 1, 4);
  parts.push(pan);
  for (const sz of [-1, 1]) {
    const wall = new THREE.BoxGeometry(0.45, 0.016, 0.007);
    wall.translate(0, 0.008, sz * 0.074);
    parts.push(wall);
  }
  for (const sx of [-1, 1]) {
    const wall = new THREE.BoxGeometry(0.007, 0.016, 0.155);
    wall.translate(sx * 0.2215, 0.008, 0);
    parts.push(wall);
  }
  for (let i = 0; i < 3; i++) {
    const led = new THREE.BoxGeometry(0.006, 0.003, 0.004);
    led.translate(0.13 + i * 0.012, 0.014, -0.065);
    parts.push(led);
  }
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.BoxGeometry(0.022, 0.008, 0.014);
    foot.translate((i % 2 ? 1 : -1) * 0.19, -0.007, (i < 2 ? 1 : -1) * 0.06);
    parts.push(foot);
  }
  return mergeParts(parts);
}

function buildLaptopLid() {
  const parts = [];
  const shell = new THREE.BoxGeometry(0.345, 0.006, 0.235, 6, 1, 4);
  parts.push(shell);
  for (const sz of [-1, 1]) {
    const edge = new THREE.BoxGeometry(0.345, 0.012, 0.008);
    edge.translate(0, 0.003, sz * 0.1135);
    parts.push(edge);
  }
  for (const sx of [-1, 1]) {
    const edge = new THREE.BoxGeometry(0.008, 0.012, 0.235);
    edge.translate(sx * 0.1685, 0.003, 0);
    parts.push(edge);
  }
  for (const sx of [-1, 1]) {
    const hinge = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 10);
    hinge.rotateZ(Math.PI / 2);
    hinge.translate(sx * 0.1, -0.002, 0.117);
    parts.push(hinge);
  }
  return mergeParts(parts);
}

function buildLaptopBase() {
  const parts = [];
  const pan = new THREE.BoxGeometry(0.345, 0.004, 0.235, 6, 1, 4);
  pan.translate(0, -0.007, 0);
  parts.push(pan);
  for (const sz of [-1, 1]) {
    const wall = new THREE.BoxGeometry(0.345, 0.018, 0.005);
    wall.translate(0, 0.002, sz * 0.115);
    parts.push(wall);
  }
  for (const sx of [-1, 1]) {
    const wall = new THREE.BoxGeometry(0.005, 0.018, 0.235);
    wall.translate(sx * 0.17, 0.002, 0);
    parts.push(wall);
  }
  const spine = new THREE.BoxGeometry(0.28, 0.02, 0.02);
  spine.translate(0, 0.004, -0.107);
  parts.push(spine);
  for (let i = 0; i < 3; i++) {
    const port = new THREE.BoxGeometry(0.006, 0.008, 0.016);
    port.translate(0.17, 0.001, -0.05 + i * 0.03);
    parts.push(port);
  }
  const vent = new THREE.BoxGeometry(0.09, 0.006, 0.01);
  vent.translate(-0.04, 0.004, -0.106);
  parts.push(vent);
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.CylinderGeometry(0.008, 0.009, 0.004, 8);
    foot.translate((i % 2 ? 1 : -1) * 0.145, -0.011, (i < 2 ? 1 : -1) * 0.095);
    parts.push(foot);
  }
  return mergeParts(parts);
}

function buildLaptopDeck() {
  const parts = [];
  const deck = new THREE.BoxGeometry(0.33, 0.004, 0.22, 6, 1, 4);
  parts.push(deck);
  const pad = new THREE.BoxGeometry(0.1, 0.003, 0.06);
  pad.translate(0, 0.003, 0.07);
  parts.push(pad);
  const pitch = 0.0175;
  for (let r = 0; r < 5; r++) {
    for (let ccol = 0; ccol < 16; ccol++) {
      const cap = new THREE.CylinderGeometry(0.0074, 0.0082, 0.004, 4);
      cap.rotateY(Math.PI / 4);
      cap.translate(-0.131 + ccol * pitch, 0.004, -0.062 + r * pitch);
      parts.push(cap);
    }
  }
  return mergeParts(parts);
}

function buildChairCushion(w, h, d, dish) {
  const g = new THREE.BoxGeometry(w, h, d, 7, 2, 7);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (w * 0.5);
    const z = pos.getZ(i) / (d * 0.5);
    const y = pos.getY(i);
    const f = (1 - x * x) * (1 - z * z);
    // top face dishes in, sides bulge out — a foam pad under a fabric skin
    pos.setY(i, y - (y > 0 ? f * dish : -f * dish * 0.4));
    pos.setX(i, pos.getX(i) * (1 + (1 - Math.abs(y) / (h * 0.5)) * 0.03));
  }
  g.computeVertexNormals();
  return g;
}

function buildChairBase() {
  const parts = [];
  const hub = new THREE.CylinderGeometry(0.05, 0.056, 0.06, 14);
  parts.push(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const arm = new THREE.BoxGeometry(0.28, 0.026, 0.05);
    arm.rotateZ(-0.06);
    arm.rotateY(-a);
    arm.translate(Math.cos(a) * 0.15, -0.012, -Math.sin(a) * 0.15);
    parts.push(arm);
    const tip = new THREE.CylinderGeometry(0.02, 0.018, 0.03, 8);
    tip.translate(Math.cos(a) * 0.28, -0.022, -Math.sin(a) * 0.28);
    parts.push(tip);
  }
  return mergeParts(parts);
}

function buildChairPiston() {
  const parts = [];
  const outer = new THREE.CylinderGeometry(0.028, 0.03, 0.16, 14);
  parts.push(outer);
  const inner = new THREE.CylinderGeometry(0.018, 0.018, 0.13, 12);
  inner.translate(0, 0.13, 0);
  parts.push(inner);
  const shroud = new THREE.CylinderGeometry(0.036, 0.042, 0.1, 14);
  shroud.translate(0, 0.03, 0);
  parts.push(shroud);
  const plate = new THREE.BoxGeometry(0.19, 0.014, 0.16, 2, 1, 2);
  plate.translate(0, 0.2, 0);
  parts.push(plate);
  const lever = new THREE.CylinderGeometry(0.008, 0.008, 0.11, 6);
  lever.rotateZ(Math.PI / 2);
  lever.translate(0.09, 0.18, 0.06);
  parts.push(lever);
  return mergeParts(parts);
}

function buildChairCastors() {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const cx = Math.cos(a) * 0.28;
    const cz = -Math.sin(a) * 0.28;
    const stem = new THREE.CylinderGeometry(0.008, 0.008, 0.036, 8);
    stem.translate(cx, 0.03, cz);
    parts.push(stem);
    const fork = new THREE.BoxGeometry(0.05, 0.028, 0.03);
    fork.rotateY(-a);
    fork.translate(cx, 0.004, cz);
    parts.push(fork);
    for (const s of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.026, 0.026, 0.012, 12);
      wheel.rotateZ(Math.PI / 2);
      wheel.rotateY(-a);
      wheel.translate(cx - Math.sin(a) * s * 0.017, -0.014, cz - Math.cos(a) * s * 0.017);
      parts.push(wheel);
    }
  }
  return mergeParts(parts);
}

function buildChairArms() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.03, 0.15, 0.036);
    post.rotateZ(sx * 0.08);
    post.translate(sx * 0.265, 0.02, -0.02);
    parts.push(post);
    const pad = new THREE.BoxGeometry(0.05, 0.02, 0.19, 1, 1, 3);
    pad.translate(sx * 0.275, 0.105, 0.01);
    parts.push(pad);
    const knuckle = new THREE.BoxGeometry(0.048, 0.05, 0.05);
    knuckle.translate(sx * 0.262, -0.055, -0.03);
    parts.push(knuckle);
  }
  return mergeParts(parts);
}

/**
 * White monobloc garden chair — one moulding, so one body, and the whole
 * thing is `hardPlastic`: it does not bend, it goes off like a bag of glass.
 */
function buildLawnChair() {
  const parts = [];
  const pan = new THREE.BoxGeometry(0.44, 0.02, 0.42, 6, 1, 6);
  const pos = pan.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / 0.22;
    const z = pos.getZ(i) / 0.21;
    pos.setY(i, pos.getY(i) - (1 - x * x) * (1 - z * z) * 0.014);
  }
  pan.computeVertexNormals();
  pan.translate(0, 0.2, 0);
  parts.push(pan);

  // back: two uprights, a top rail and five slats, merged then leant back
  const back = [];
  for (const sx of [-1, 1]) {
    const upright = new THREE.BoxGeometry(0.03, 0.4, 0.024);
    upright.translate(sx * 0.2, 0.2, 0);
    back.push(upright);
  }
  const rail = new THREE.BoxGeometry(0.43, 0.05, 0.026);
  rail.translate(0, 0.395, 0);
  back.push(rail);
  for (let i = 0; i < 5; i++) {
    const slat = new THREE.BoxGeometry(0.05, 0.34, 0.016);
    slat.translate(-0.14 + i * 0.07, 0.19, 0);
    back.push(slat);
  }
  const backG = mergeParts(back);
  backG.rotateX(0.22);
  backG.translate(0, 0.2, -0.2);
  parts.push(backG);

  for (const sx of [-1, 1]) {
    const arm = new THREE.BoxGeometry(0.05, 0.022, 0.36);
    arm.translate(sx * 0.215, 0.35, -0.03);
    parts.push(arm);
    const armFront = new THREE.BoxGeometry(0.042, 0.16, 0.05);
    armFront.translate(sx * 0.215, 0.27, 0.145);
    parts.push(armFront);
  }
  for (let i = 0; i < 4; i++) {
    const sx = i % 2 ? 1 : -1;
    const sz = i < 2 ? 1 : -1;
    const leg = new THREE.CylinderGeometry(0.018, 0.026, 0.21, 8);
    leg.rotateZ(-sx * 0.1);
    leg.rotateX(sz * 0.1);
    leg.translate(sx * 0.2, 0.09, sz * 0.185);
    parts.push(leg);
  }
  const stretcher = new THREE.BoxGeometry(0.4, 0.018, 0.02);
  stretcher.translate(0, 0.03, 0.185);
  parts.push(stretcher);
  const g = mergeParts(parts);
  // Authored standing on the floor; drop it onto its own centroid so it
  // spawns and tumbles about the seat rather than about its feet.
  g.translate(0, -0.298, 0);
  return g;
}

/* ---------------------------------------------------------------- library */

let cache = null;

export function getScrapLibrary() {
  if (cache) return cache;

  cache = [
    {
      id: 'can', label: 'Aluminium Can', hint: '330 ml · thin wall', mass: 0.016,
      value: 0.15, category: 'raw',
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
      value: 2.50, category: 'raw',
      material: 'galvanised', thickness: 0.0012, key: '2',
      build: () => {
        const g = tagUV(buildSheet(0.52, 0.42, 0.012));
        return { geometry: g, colliders: [boxCollider(0.26, 0.006, 0.21)] };
      },
    },
    {
      id: 'pipe', label: 'Steel Pipe', hint: 'Ø60 × 3 mm wall', mass: 5.8,
      value: 3.20, category: 'raw',
      material: 'rustedSteel', thickness: 0.003, key: '3',
      build: () => {
        const g = tagUV(buildPipe(0.72, 0.03, 0.024, 22));
        return { geometry: g, colliders: [{ type: 'cylinder', halfHeight: 0.36, radius: 0.03, rotation: axisQuat(0, 0, 1, Math.PI / 2) }] };
      },
    },
    {
      id: 'rebar', label: 'Rebar Rod', hint: 'Ø16 solid, ribbed', mass: 2.1,
      value: 1.80, category: 'raw',
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
      value: 9.00, category: 'raw',
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

    /* ------------------------------------------------- consumer assemblies */

    {
      id: 'tv', label: 'Flat Screen TV', hint: '0.95 m panel · glass, ABS, steel, PCB',
      key: '6', mass: 9.5, value: 12.00, category: 'office', assembly: true,
      // dominant material, for anything that asks the assembly as a whole
      material: 'applianceSteel', thickness: 0.0008,
      parts: [
        {
          name: 'screen', material: 'glass', thickness: 0.003, mass: 3.8,
          offset: [0, 0, 0.008], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildTvScreen()),
            colliders: [boxCollider(0.46, 0.2525, 0.0028)],
          }),
        },
        {
          name: 'bezel', material: 'abs', thickness: 0.006, mass: 1.2,
          offset: [0, 0, 0.004], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildTvBezel()),
            colliders: [
              boxCollider(0.475, 0.0055, 0.012, [0, 0.2745, 0]),
              boxCollider(0.475, 0.0132, 0.012, [0, -0.2668, 0]),
              boxCollider(0.0055, 0.2613, 0.012, [-0.4695, -0.0077, 0]),
              boxCollider(0.0055, 0.2613, 0.012, [0.4695, -0.0077, 0]),
            ],
          }),
        },
        {
          name: 'chassis', material: 'applianceSteel', thickness: 0.0008, mass: 3.4,
          offset: [0, 0, -0.014], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildTvChassis()),
            colliders: [boxCollider(0.45, 0.255, 0.004, [0, 0, -0.004])],
          }),
        },
        {
          name: 'board', material: 'pcb', thickness: 0.0016, mass: 0.6,
          offset: [0, -0.1, -0.038], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildTvBoard()),
            colliders: [boxCollider(0.17, 0.085, 0.007, [0, 0, 0.005])],
          }),
        },
        {
          name: 'stand', material: 'abs', thickness: 0.012, mass: 0.5,
          offset: [0, -0.338, -0.004], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildTvStand()),
            colliders: [
              boxCollider(0.14, 0.007, 0.085, [0, -0.048, 0.02]),
              boxCollider(0.0475, 0.0475, 0.016, [0, 0.008, 0]),
            ],
          }),
        },
      ],
    },
    {
      id: 'speaker', label: 'Sound System', hint: 'MDF cabinet · cone drivers · ferrite',
      key: '7', mass: 14, value: 16.00, category: 'furniture', assembly: true,
      material: 'mdf', thickness: 0.015,
      parts: [
        {
          name: 'cabinet', material: 'mdf', thickness: 0.015, mass: 9.1,
          offset: [0, 0, 0], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildSpeakerCabinet()),
            colliders: [
              boxCollider(0.17, 0.275, 0.0075, [0, 0, -0.1525]),
              boxCollider(0.0075, 0.275, 0.145, [-0.1625, 0, 0]),
              boxCollider(0.0075, 0.275, 0.145, [0.1625, 0, 0]),
              boxCollider(0.155, 0.0075, 0.145, [0, 0.2675, 0]),
              boxCollider(0.155, 0.0075, 0.145, [0, -0.2675, 0]),
              // baffle, cut around the driver apertures so the drivers can
              // sit in their holes without interpenetrating the cabinet
              boxCollider(0.031, 0.275, 0.0075, [-0.139, 0, 0.1525]),
              boxCollider(0.031, 0.275, 0.0075, [0.139, 0, 0.1525]),
              boxCollider(0.108, 0.036, 0.0075, [0, 0.239, 0.1525]),
              boxCollider(0.108, 0.0495, 0.0075, [0, 0.0575, 0.1525]),
              boxCollider(0.108, 0.0335, 0.0075, [0, -0.2415, 0.1525]),
            ],
          }),
        },
        {
          name: 'driverLow', material: 'rubber', thickness: 0.004, mass: 1.35,
          offset: [0, -0.1, 0.144], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildSpeakerDriver(1, 20)),
            colliders: [{ type: 'cylinder', halfHeight: 0.024, radius: 0.108, offset: [0, 0, -0.006], rotation: CYL_Z }],
          }),
        },
        {
          name: 'driverHigh', material: 'rubber', thickness: 0.003, mass: 0.5,
          offset: [0, 0.155, 0.152], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildSpeakerDriver(0.42, 16)),
            colliders: [{ type: 'cylinder', halfHeight: 0.012, radius: 0.046, offset: [0, 0, -0.003], rotation: CYL_Z }],
          }),
        },
        {
          name: 'magnetLow', material: 'ferrite', thickness: 0.022, mass: 1.7,
          offset: [0, -0.1, 0.082], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildSpeakerMagnet(1, 16)),
            colliders: [{ type: 'cylinder', halfHeight: 0.019, radius: 0.062, rotation: CYL_Z }],
          }),
        },
        {
          name: 'magnetHigh', material: 'ferrite', thickness: 0.012, mass: 0.55,
          offset: [0, 0.155, 0.122], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildSpeakerMagnet(0.5, 14)),
            colliders: [{ type: 'cylinder', halfHeight: 0.011, radius: 0.031, rotation: CYL_Z }],
          }),
        },
        {
          name: 'grille', material: 'galvanised', thickness: 0.0009, mass: 0.8,
          offset: [0, 0, 0.188], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildSpeakerGrille()),
            colliders: [boxCollider(0.16, 0.265, 0.0045)],
          }),
        },
      ],
    },
    {
      id: 'wheel', label: 'Car Wheel', hint: 'Ø620 tyre on a 5-spoke alloy',
      key: '8', mass: 18, value: 22.00, category: 'tools', assembly: true,
      material: 'rubber', thickness: 0.012,
      parts: [
        {
          name: 'tyre', material: 'rubber', thickness: 0.012, mass: 10.5,
          offset: [0, 0, 0], rotation: [0, 0, 0],
          build: () => {
            const colliders = [];
            const R = 0.2595;
            for (let i = 0; i < 12; i++) {
              const a = (i / 12) * Math.PI * 2;
              colliders.push({
                type: 'box',
                he: [0.0679, 0.106, 0.0515],
                offset: [Math.sin(a) * R, 0, Math.cos(a) * R],
                rotation: axisQuat(0, 1, 0, a),
              });
            }
            return { geometry: buildTyre(72), colliders };
          },
        },
        {
          name: 'rim', material: 'alloy', thickness: 0.009, mass: 7.5,
          offset: [0, 0, 0], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildRim()),
            colliders: [{ type: 'cylinder', halfHeight: 0.082, radius: 0.206 }],
          }),
        },
      ],
    },
    {
      id: 'microwave', label: 'Microwave Oven', hint: '900 W · enamel, glass, transformer',
      key: '9', mass: 15, value: 14.00, category: 'appliance', assembly: true,
      material: 'applianceSteel', thickness: 0.0007,
      parts: [
        {
          name: 'shell', material: 'applianceSteel', thickness: 0.0007, mass: 6.4,
          offset: [0, 0, 0], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildMicrowaveShell()),
            colliders: [
              boxCollider(0.25, 0.002, 0.19, [0, 0.143, 0]),
              boxCollider(0.25, 0.002, 0.19, [0, -0.143, 0]),
              boxCollider(0.002, 0.141, 0.19, [-0.248, 0, 0]),
              boxCollider(0.002, 0.141, 0.19, [0.248, 0, 0]),
              boxCollider(0.246, 0.141, 0.002, [0, 0, -0.188]),
              boxCollider(0.0015, 0.1175, 0.1725, [0.09, 0, 0.0125]),
            ],
          }),
        },
        {
          name: 'door', material: 'glass', thickness: 0.004, mass: 2.4,
          offset: [-0.0775, 0, 0.2], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildMicrowaveDoor()),
            colliders: [boxCollider(0.1725, 0.135, 0.014, [0, 0, 0.006])],
          }),
        },
        {
          name: 'panel', material: 'abs', thickness: 0.003, mass: 0.9,
          offset: [0.1725, 0, 0.197], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildMicrowavePanel()),
            colliders: [boxCollider(0.075, 0.135, 0.005)],
          }),
        },
        {
          name: 'transformer', material: 'mildSteel', thickness: 0.006, mass: 4.5,
          offset: [0.168, -0.06, -0.05], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildMicrowaveTransformer()),
            colliders: [boxCollider(0.055, 0.052, 0.045)],
          }),
        },
        {
          name: 'turntable', material: 'glass', thickness: 0.005, mass: 0.8,
          offset: [-0.0725, -0.098, 0.012], rotation: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildMicrowaveTurntable()),
            colliders: [{ type: 'cylinder', halfHeight: 0.012, radius: 0.135, offset: [0, -0.006, 0] }],
          }),
        },
      ],
    },

    {
      id: 'engine', label: 'Engine Block', hint: 'The real test — 4 cyl', mass: 62,
      value: 65.00, category: 'tools',
      material: 'castIron', thickness: 0.014, key: '0',
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
    {
      id: 'toolbox', label: 'Tool Box', hint: 'Painted steel, empty', mass: 6.5,
      value: 11.00, category: 'tools',
      material: 'paintedSteel', thickness: 0.0012,
      build: () => {
        const g = tagUV(buildToolbox());
        return { geometry: g, colliders: [boxCollider(0.2, 0.115, 0.105, [0, 0.005, 0])] };
      },
    },
    {
      id: 'gear', label: 'Cast Gear', hint: 'Brittle grey iron', mass: 7.9,
      value: 7.00, category: 'tools',
      material: 'castIron', thickness: 0.02,
      build: () => {
        const g = tagUV(buildGear(0.13, 0.038, 18));
        return { geometry: g, colliders: [{ type: 'cylinder', halfHeight: 0.02, radius: 0.128 }] };
      },
    },
    {
      id: 'radiator', label: 'Copper Radiator', hint: 'Finned core, very ductile', mass: 3.4,
      value: 8.50, category: 'appliance',
      material: 'copper', thickness: 0.0006,
      build: () => {
        const g = tagUV(buildRadiator());
        return { geometry: g, colliders: [boxCollider(0.22, 0.19, 0.032)] };
      },
    },

    /* -------------------------------------------- kitchen and housewares */

    {
      id: 'blender', label: 'Blender', hint: 'Glass jug · ABS base · copper motor',
      mass: 2.4, value: 6.00, category: 'kitchen', assembly: true,
      material: 'abs', thickness: 0.003,
      parts: [
        {
          name: 'jug', material: 'glass', thickness: 0.004, mass: 0.95,
          offset: [0, 0.076, 0],
          build: () => ({
            geometry: tagUV(buildBlenderJug()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.095, radius: 0.09, offset: [0, 0.001, 0] },
              boxCollider(0.028, 0.05, 0.011, [0.107, 0.014, 0]),
            ],
          }),
        },
        {
          name: 'lid', material: 'hardPlastic', thickness: 0.005, mass: 0.08,
          offset: [0, 0.178, 0],
          build: () => ({
            geometry: tagUV(buildBlenderLid()),
            colliders: [{ type: 'cylinder', halfHeight: 0.019, radius: 0.092, offset: [0, -0.004, 0] }],
          }),
        },
        {
          name: 'base', material: 'abs', thickness: 0.003, mass: 0.75,
          offset: [0, -0.1, 0],
          build: () => ({
            geometry: tagUV(buildBlenderBase()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.075, radius: 0.082 },
              { type: 'cylinder', halfHeight: 0.009, radius: 0.062, offset: [0, 0.082, 0] },
            ],
          }),
        },
        {
          name: 'blade', material: 'hardenedSteel', thickness: 0.002, mass: 0.12,
          offset: [0, -0.004, 0],
          build: () => ({
            geometry: tagUV(buildBlenderBlade()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.014, radius: 0.033 },
              { type: 'cylinder', halfHeight: 0.027, radius: 0.008, offset: [0, -0.032, 0] },
            ],
          }),
        },
        {
          name: 'motor', material: 'copperWinding', thickness: 0.008, mass: 0.5,
          offset: [0, -0.09, 0],
          build: () => ({
            geometry: tagUV(buildMotorCan(0.038, 0.07, 16)),
            colliders: [{ type: 'cylinder', halfHeight: 0.043, radius: 0.04 }],
          }),
        },
      ],
    },
    {
      id: 'toaster', label: '2-Slice Toaster', hint: 'Chrome shell · nichrome element rack',
      mass: 1.4, value: 3.00, category: 'kitchen', assembly: true,
      material: 'chrome', thickness: 0.0035,
      parts: [
        {
          name: 'shell', material: 'chrome', thickness: 0.0035, mass: 0.7,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildToasterShell()),
            colliders: [
              boxCollider(0.13, 0.095, 0.00175, [0, 0, 0.08025]),
              boxCollider(0.13, 0.095, 0.00175, [0, 0, -0.08025]),
              boxCollider(0.13, 0.00175, 0.082, [0, 0.09325, 0]),
              boxCollider(0.13, 0.00175, 0.082, [0, -0.09325, 0]),
            ],
          }),
        },
        {
          name: 'ends', material: 'hardPlastic', thickness: 0.006, mass: 0.22,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildToasterEnds()),
            colliders: [
              boxCollider(0.006, 0.096, 0.083, [-0.136, 0, 0]),
              boxCollider(0.006, 0.096, 0.083, [0.136, 0, 0]),
              boxCollider(0.016, 0.055, 0.011, [0.088, 0.03, 0.086]),
            ],
          }),
        },
        {
          name: 'elements', material: 'nichrome', thickness: 0.0016, mass: 0.3,
          offset: [0, 0.01, 0],
          build: () => ({
            geometry: tagUV(buildToasterElements()),
            colliders: [
              boxCollider(0.102, 0.065, 0.0026, [0, 0, -0.052]),
              boxCollider(0.102, 0.065, 0.0026, [0, 0, -0.017]),
              boxCollider(0.102, 0.065, 0.0026, [0, 0, 0.017]),
              boxCollider(0.102, 0.065, 0.0026, [0, 0, 0.052]),
            ],
          }),
        },
        {
          name: 'board', material: 'pcb', thickness: 0.0016, mass: 0.18,
          offset: [0, -0.07, -0.02],
          build: () => ({
            geometry: tagUV(buildSmallBoard(0.12, 0.05, 5)),
            colliders: [boxCollider(0.062, 0.028, 0.008, [0, 0, 0.004])],
          }),
        },
      ],
    },
    {
      id: 'coffeeMaker', label: 'Coffee Maker', hint: 'ABS shell · glass carafe · copper line',
      mass: 2.2, value: 5.00, category: 'kitchen', assembly: true,
      material: 'abs', thickness: 0.003,
      parts: [
        {
          name: 'shell', material: 'abs', thickness: 0.003, mass: 0.95,
          offset: [0, 0.02, 0],
          build: () => ({
            geometry: tagUV(buildCoffeeShell()),
            colliders: [
              boxCollider(0.085, 0.15, 0.07, [0, 0.03, -0.055]),
              boxCollider(0.085, 0.035, 0.075, [0, 0.152, 0.035]),
              boxCollider(0.085, 0.025, 0.12, [0, -0.145, 0.02]),
            ],
          }),
        },
        {
          name: 'carafe', material: 'glass', thickness: 0.004, mass: 0.62,
          offset: [0, -0.028, 0.1],
          build: () => ({
            geometry: tagUV(buildCarafe()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.085, radius: 0.078, offset: [0, 0.011, 0] },
              boxCollider(0.024, 0.042, 0.01, [0.094, 0.01, 0]),
            ],
          }),
        },
        {
          name: 'hotplate', material: 'mildSteel', thickness: 0.003, mass: 0.4,
          offset: [0, -0.104, 0.1],
          build: () => ({
            geometry: tagUV(buildHotPlate()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.008, radius: 0.078 },
              boxCollider(0.045, 0.007, 0.025, [0, -0.012, -0.05]),
            ],
          }),
        },
        {
          name: 'tubing', material: 'copper', thickness: 0.0008, mass: 0.23,
          offset: [0.0, 0.03, -0.03],
          build: () => ({
            geometry: tagUV(buildCopperTubing()),
            colliders: [
              boxCollider(0.082, 0.082, 0.008, [0.01, 0.01, 0]),
              boxCollider(0.008, 0.075, 0.008, [-0.072, 0.03, 0]),
            ],
          }),
        },
      ],
    },
    {
      id: 'vacuum', label: 'Vacuum Cleaner', hint: 'Canister · rubber hose · steel motor',
      mass: 5.6, value: 9.00, category: 'kitchen', assembly: true,
      material: 'abs', thickness: 0.004,
      parts: [
        {
          name: 'body', material: 'abs', thickness: 0.004, mass: 2.6,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildVacuumBody()),
            colliders: [{ type: 'cylinder', halfHeight: 0.155, radius: 0.13, rotation: axisQuat(0, 0, 1, Math.PI / 2) }],
          }),
        },
        {
          name: 'hose', material: 'rubber', thickness: 0.004, mass: 0.9,
          offset: [-0.1, 0.16, 0.0], rotation: [0, 0, 0.5],
          build: () => {
            const colliders = [];
            const R = 0.155;
            for (const i of [1, 4, 7]) {
              const a = -0.25 + (i / 9) * Math.PI * 1.05;
              colliders.push({
                type: 'cylinder', halfHeight: 0.085, radius: 0.027,
                offset: [Math.cos(a) * R, Math.sin(a) * R, 0],
                rotation: axisQuat(0, 0, 1, a),
              });
            }
            return { geometry: tagUV(buildVacuumHose()), colliders };
          },
        },
        {
          name: 'motor', material: 'mildSteel', thickness: 0.006, mass: 1.85,
          offset: [-0.06, -0.02, 0], rotation: [0, 0, Math.PI / 2],
          build: () => ({
            geometry: tagUV(buildMotorCan(0.052, 0.1, 16)),
            colliders: [{ type: 'cylinder', halfHeight: 0.062, radius: 0.055 }],
          }),
        },
        {
          name: 'board', material: 'pcb', thickness: 0.0016, mass: 0.25,
          offset: [0.06, -0.06, 0.06],
          build: () => ({
            geometry: tagUV(buildSmallBoard(0.11, 0.06, 6)),
            colliders: [boxCollider(0.057, 0.032, 0.008, [0, 0, 0.004])],
          }),
        },
      ],
    },

    /* ------------------------------------------------- tools and hardware */

    {
      id: 'powerDrill', label: 'Cordless Drill', hint: '18 V · alloy gearcase · dense pack',
      mass: 1.9, value: 18.00, category: 'tools', assembly: true,
      material: 'abs', thickness: 0.004,
      parts: [
        {
          name: 'body', material: 'abs', thickness: 0.004, mass: 0.55,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildDrillBody()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.085, radius: 0.036, rotation: axisQuat(0, 0, 1, Math.PI / 2) },
              boxCollider(0.026, 0.065, 0.021, [-0.028, -0.085, 0], axisQuat(0, 0, 1, 0.16)),
            ],
          }),
        },
        {
          name: 'gearcase', material: 'aluminium', thickness: 0.005, mass: 0.42,
          offset: [0.088, 0, 0],
          build: () => ({
            geometry: tagUV(buildDrillGearcase()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.052, radius: 0.03, offset: [0.026, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
              { type: 'cylinder', halfHeight: 0.035, radius: 0.006, offset: [0.12, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
            ],
          }),
        },
        {
          name: 'battery', material: 'mildSteel', thickness: 0.01, mass: 0.62,
          offset: [-0.05, -0.176, 0],
          build: () => ({
            geometry: tagUV(buildDrillBattery()),
            colliders: [boxCollider(0.039, 0.025, 0.034)],
          }),
        },
        {
          name: 'motor', material: 'copperWinding', thickness: 0.006, mass: 0.31,
          offset: [-0.03, 0, 0], rotation: [0, 0, Math.PI / 2],
          build: () => ({
            geometry: tagUV(buildMotorCan(0.026, 0.05, 14)),
            colliders: [{ type: 'cylinder', halfHeight: 0.031, radius: 0.028 }],
          }),
        },
      ],
    },
    {
      id: 'sledgehammer', label: 'Sledgehammer', hint: '4 kg hardened head — motor killer',
      mass: 5.4, value: 12.00, category: 'tools', assembly: true,
      material: 'hardenedSteel', thickness: 0.03,
      parts: [
        {
          name: 'head', material: 'hardenedSteel', thickness: 0.032, mass: 4.2,
          offset: [0, 0.42, 0],
          build: () => ({
            geometry: tagUV(buildSledgeHead()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.1, radius: 0.034, rotation: axisQuat(0, 0, 1, Math.PI / 2) },
              { type: 'cylinder', halfHeight: 0.031, radius: 0.024 },
            ],
          }),
        },
        {
          name: 'handle', material: 'wood', thickness: 0.018, mass: 1.2,
          offset: [0, -0.04, 0],
          build: () => ({
            geometry: tagUV(buildSledgeHandle()),
            colliders: [{ type: 'cylinder', halfHeight: 0.45, radius: 0.021 }],
          }),
        },
      ],
    },
    {
      id: 'pipeWrench', label: 'Pipe Wrench', hint: 'Drop-forged solid — nothing gives',
      mass: 3.2, value: 10.00, category: 'tools',
      material: 'hardenedSteel', thickness: 0.022,
      build: () => {
        const g = tagUV(buildPipeWrench());
        return {
          geometry: g,
          colliders: [
            boxCollider(0.022, 0.165, 0.012, [0, -0.069, 0]),
            boxCollider(0.026, 0.065, 0.012, [0, 0.136, 0]),
            boxCollider(0.045, 0.017, 0.012, [0.036, 0.223, 0]),
            boxCollider(0.04, 0.015, 0.011, [0.032, 0.147, 0]),
            { type: 'cylinder', halfHeight: 0.011, radius: 0.027, offset: [0, 0.097, 0] },
          ],
        };
      },
    },
    {
      id: 'lawnmower', label: 'Lawn Mower', hint: 'The boss — deck, engine, blade, four wheels',
      mass: 32, value: 65.00, category: 'tools', assembly: true,
      material: 'mildSteel', thickness: 0.0022,
      parts: [
        {
          name: 'deck', material: 'mildSteel', thickness: 0.0022, mass: 12.5,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildMowerDeck()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.05, radius: 0.265 },
              boxCollider(0.075, 0.045, 0.07, [0.24, -0.005, -0.2], axisQuat(0, 1, 0, 0.5)),
            ],
          }),
        },
        {
          name: 'shroud', material: 'abs', thickness: 0.004, mass: 2.4,
          offset: [0, 0.13, 0],
          build: () => ({
            geometry: tagUV(buildMowerShroud()),
            colliders: [
              boxCollider(0.14, 0.075, 0.006, [0, 0, 0.124]),
              boxCollider(0.14, 0.075, 0.006, [0, 0, -0.124]),
              boxCollider(0.006, 0.075, 0.118, [-0.134, 0, 0]),
              boxCollider(0.006, 0.075, 0.118, [0.134, 0, 0]),
            ],
          }),
        },
        {
          name: 'engine', material: 'aluminium', thickness: 0.008, mass: 8,
          offset: [0, 0.125, 0],
          build: () => ({
            geometry: tagUV(buildMowerEngine()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.065, radius: 0.082 },
              boxCollider(0.06, 0.035, 0.055, [0.05, 0.085, 0]),
              boxCollider(0.065, 0.035, 0.06, [-0.06, 0.09, 0]),
            ],
          }),
        },
        {
          name: 'blade', material: 'hardenedSteel', thickness: 0.004, mass: 1.6,
          offset: [0, -0.068, 0],
          build: () => ({
            geometry: tagUV(buildMowerBlade()),
            colliders: [
              boxCollider(0.22, 0.004, 0.025),
              boxCollider(0.03, 0.012, 0.024, [-0.19, 0.008, 0]),
              boxCollider(0.03, 0.012, 0.024, [0.19, 0.008, 0]),
            ],
          }),
        },
        {
          name: 'wheelsFront', material: 'rubber', thickness: 0.012, mass: 2.2,
          offset: [0, -0.055, 0.19],
          build: () => ({
            geometry: tagUV(buildMowerWheels(0.085, 0.05, 0.3, 0)),
            colliders: [
              { type: 'cylinder', halfHeight: 0.028, radius: 0.09, offset: [-0.3, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
              { type: 'cylinder', halfHeight: 0.028, radius: 0.09, offset: [0.3, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
            ],
          }),
        },
        {
          name: 'wheelsRear', material: 'rubber', thickness: 0.014, mass: 2.6,
          offset: [0, -0.04, -0.19],
          build: () => ({
            geometry: tagUV(buildMowerWheels(0.1, 0.055, 0.3, 0)),
            colliders: [
              { type: 'cylinder', halfHeight: 0.031, radius: 0.106, offset: [-0.3, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
              { type: 'cylinder', halfHeight: 0.031, radius: 0.106, offset: [0.3, 0, 0], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
            ],
          }),
        },
        {
          name: 'handle', material: 'mildSteel', thickness: 0.0015, mass: 2.7,
          offset: [0, 0.16, -0.26],
          build: () => ({
            geometry: tagUV(buildMowerHandle()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.31, radius: 0.014, offset: [-0.19, 0, -0.02], rotation: axisQuat(1, 0, 0, -0.62) },
              { type: 'cylinder', halfHeight: 0.31, radius: 0.014, offset: [0.19, 0, -0.02], rotation: axisQuat(1, 0, 0, -0.62) },
              { type: 'cylinder', halfHeight: 0.2, radius: 0.02, offset: [0, 0.5, -0.355], rotation: axisQuat(0, 0, 1, Math.PI / 2) },
            ],
          }),
        },
      ],
    },

    /* -------------------------------------------------- office and living */

    {
      id: 'keyboard', label: 'Keyboard', hint: 'Alloy tray · PCB · 120 keycaps',
      mass: 0.9, value: 4.00, category: 'office', assembly: true,
      material: 'aluminium', thickness: 0.0012,
      parts: [
        {
          name: 'tray', material: 'aluminium', thickness: 0.0012, mass: 0.34,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildKeyboardTray()),
            colliders: [boxCollider(0.225, 0.004, 0.0775, [0, 0.001, 0])],
          }),
        },
        {
          name: 'board', material: 'pcb', thickness: 0.0016, mass: 0.18,
          offset: [0, -0.007, 0],
          build: () => ({
            geometry: tagUV(buildSmallBoard(0.4, 0.13, 8)),
            colliders: [boxCollider(0.205, 0.068, 0.0015)],
          }),
        },
        {
          name: 'keysLeft', material: 'hardPlastic', thickness: 0.0025, mass: 0.15,
          offset: [-0.145, 0.009, 0],
          build: () => ({
            geometry: tagUV(buildKeycapCluster(8, 6, 0.019, true)),
            colliders: [boxCollider(0.077, 0.004, 0.058)],
          }),
        },
        {
          name: 'keysRight', material: 'hardPlastic', thickness: 0.0025, mass: 0.15,
          offset: [0.007, 0.009, 0],
          build: () => ({
            geometry: tagUV(buildKeycapCluster(8, 6, 0.019, true)),
            colliders: [boxCollider(0.077, 0.004, 0.058)],
          }),
        },
        {
          name: 'keysPad', material: 'hardPlastic', thickness: 0.0025, mass: 0.08,
          offset: [0.153, 0.009, 0.01],
          build: () => ({
            geometry: tagUV(buildKeycapCluster(5, 5, 0.019, false)),
            colliders: [boxCollider(0.05, 0.004, 0.05)],
          }),
        },
      ],
    },
    {
      id: 'laptop', label: 'Laptop', hint: 'Glass panel · aluminium unibody · PCB',
      mass: 2.1, value: 15.00, category: 'office', assembly: true,
      material: 'aluminium', thickness: 0.0015,
      parts: [
        {
          name: 'base', material: 'aluminium', thickness: 0.0015, mass: 0.62,
          offset: [0, 0, 0],
          build: () => ({
            geometry: tagUV(buildLaptopBase()),
            colliders: [boxCollider(0.1725, 0.006, 0.1175, [0, -0.004, 0])],
          }),
        },
        {
          name: 'deck', material: 'hardPlastic', thickness: 0.002, mass: 0.28,
          offset: [0, 0.012, 0.005],
          build: () => ({
            geometry: tagUV(buildLaptopDeck()),
            colliders: [boxCollider(0.165, 0.004, 0.11)],
          }),
        },
        {
          name: 'board', material: 'pcb', thickness: 0.0016, mass: 0.3,
          offset: [0, -0.016, -0.02],
          build: () => ({
            geometry: tagUV(buildSmallBoard(0.26, 0.13, 9)),
            colliders: [boxCollider(0.132, 0.068, 0.0018)],
          }),
        },
        {
          name: 'lid', material: 'aluminium', thickness: 0.0015, mass: 0.48,
          offset: [0, 0.117, -0.165], rotation: [1.15, 0, 0],
          build: () => ({
            geometry: tagUV(buildLaptopLid()),
            colliders: [boxCollider(0.1725, 0.008, 0.1175)],
          }),
        },
        {
          name: 'screen', material: 'glass', thickness: 0.0028, mass: 0.42,
          offset: [0, 0.1215, -0.155], rotation: [1.15, 0, 0],
          build: () => {
            const parts = [];
            const glass = new THREE.BoxGeometry(0.31, 0.0028, 0.2, 8, 1, 5);
            parts.push(glass);
            const stack = new THREE.BoxGeometry(0.3, 0.0022, 0.192, 4, 1, 3);
            stack.translate(0, -0.0026, 0);
            parts.push(stack);
            return {
              geometry: tagUV(mergeParts(parts)),
              colliders: [boxCollider(0.155, 0.0032, 0.1, [0, -0.0013, 0])],
            };
          },
        },
      ],
    },
    {
      id: 'officeChair', label: 'Office Chair', hint: 'Mesh seat · chrome star · gas piston',
      mass: 11, value: 13.00, category: 'furniture', assembly: true,
      material: 'fabric', thickness: 0.012,
      parts: [
        {
          name: 'seat', material: 'fabric', thickness: 0.012, mass: 2.1,
          offset: [0, 0.07, 0],
          build: () => ({
            geometry: tagUV(buildChairCushion(0.46, 0.09, 0.44, 0.012)),
            colliders: [boxCollider(0.235, 0.045, 0.22)],
          }),
        },
        {
          name: 'back', material: 'fabric', thickness: 0.01, mass: 1.4,
          offset: [0, 0.35, -0.215], rotation: [-0.18, 0, 0],
          build: () => {
            const g = buildChairCushion(0.42, 0.075, 0.44, 0.01);
            g.rotateX(-Math.PI / 2);
            return { geometry: tagUV(g), colliders: [boxCollider(0.215, 0.22, 0.038)] };
          },
        },
        {
          name: 'base', material: 'chrome', thickness: 0.013, mass: 3.6,
          offset: [0, -0.3, 0],
          build: () => {
            const colliders = [{ type: 'cylinder', halfHeight: 0.03, radius: 0.056 }];
            for (let i = 0; i < 5; i++) {
              const a = (i / 5) * Math.PI * 2;
              colliders.push(boxCollider(0.14, 0.013, 0.025,
                [Math.cos(a) * 0.15, -0.012, -Math.sin(a) * 0.15], axisQuat(0, 1, 0, a)));
            }
            return { geometry: tagUV(buildChairBase()), colliders };
          },
        },
        {
          name: 'piston', material: 'mildSteel', thickness: 0.014, mass: 2.2,
          offset: [0, -0.19, 0],
          build: () => ({
            geometry: tagUV(buildChairPiston()),
            colliders: [
              { type: 'cylinder', halfHeight: 0.08, radius: 0.042 },
              { type: 'cylinder', halfHeight: 0.065, radius: 0.018, offset: [0, 0.13, 0] },
              boxCollider(0.095, 0.007, 0.08, [0, 0.2, 0]),
            ],
          }),
        },
        {
          name: 'castors', material: 'hardPlastic', thickness: 0.006, mass: 1,
          offset: [0, -0.355, 0],
          build: () => {
            const colliders = [];
            for (let i = 0; i < 5; i++) {
              const a = (i / 5) * Math.PI * 2;
              colliders.push({
                type: 'cylinder', halfHeight: 0.024, radius: 0.026,
                offset: [Math.cos(a) * 0.28, -0.014, -Math.sin(a) * 0.28],
                rotation: axisQuat(0, 0, 1, Math.PI / 2),
              });
            }
            return { geometry: tagUV(buildChairCastors()), colliders };
          },
        },
        {
          name: 'armrests', material: 'hardPlastic', thickness: 0.005, mass: 0.7,
          offset: [0, 0.14, 0],
          build: () => ({
            geometry: tagUV(buildChairArms()),
            colliders: [
              boxCollider(0.025, 0.075, 0.018, [-0.265, 0.02, -0.02]),
              boxCollider(0.025, 0.075, 0.018, [0.265, 0.02, -0.02]),
              boxCollider(0.025, 0.01, 0.095, [-0.275, 0.105, 0.01]),
              boxCollider(0.025, 0.01, 0.095, [0.275, 0.105, 0.01]),
            ],
          }),
        },
      ],
    },
    {
      id: 'lawnChair', label: 'Lawn Chair', hint: 'Brittle white monobloc — goes off like glass',
      mass: 2.6, value: 3.00, category: 'furniture',
      material: 'hardPlastic', thickness: 0.008,
      build: () => {
        const g = tagUV(buildLawnChair());
        const colliders = [
          boxCollider(0.22, 0.012, 0.21, [0, -0.1, 0]),
          boxCollider(0.215, 0.21, 0.026, [0, 0.097, -0.238], axisQuat(1, 0, 0, 0.22)),
          boxCollider(0.025, 0.012, 0.18, [-0.215, 0.052, -0.03]),
          boxCollider(0.025, 0.012, 0.18, [0.215, 0.052, -0.03]),
          boxCollider(0.021, 0.08, 0.025, [-0.215, -0.028, 0.145]),
          boxCollider(0.021, 0.08, 0.025, [0.215, -0.028, 0.145]),
        ];
        for (let i = 0; i < 4; i++) {
          const sx = i % 2 ? 1 : -1;
          const sz = i < 2 ? 1 : -1;
          colliders.push({
            type: 'cylinder', halfHeight: 0.105, radius: 0.024,
            offset: [sx * 0.2, -0.208, sz * 0.185],
            rotation: axisQuat(0, 0, 1, -sx * 0.1),
          });
        }
        return { geometry: g, colliders };
      },
    },
  ];

  return cache;
}

export function getScrapDef(id) {
  return getScrapLibrary().find((s) => s.id === id) || getScrapLibrary()[0];
}
