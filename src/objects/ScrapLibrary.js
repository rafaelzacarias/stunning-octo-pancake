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

    /* ------------------------------------------------- consumer assemblies */

    {
      id: 'tv', label: 'Flat Screen TV', hint: '0.95 m panel · glass, ABS, steel, PCB',
      key: '6', mass: 9.5, assembly: true,
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
      key: '7', mass: 14, assembly: true,
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
      key: '8', mass: 18, assembly: true,
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
      key: '9', mass: 15, assembly: true,
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
      material: 'paintedSteel', thickness: 0.0012,
      build: () => {
        const g = tagUV(buildToolbox());
        return { geometry: g, colliders: [boxCollider(0.2, 0.115, 0.105, [0, 0.005, 0])] };
      },
    },
    {
      id: 'gear', label: 'Cast Gear', hint: 'Brittle grey iron', mass: 7.9,
      material: 'castIron', thickness: 0.02,
      build: () => {
        const g = tagUV(buildGear(0.13, 0.038, 18));
        return { geometry: g, colliders: [{ type: 'cylinder', halfHeight: 0.02, radius: 0.128 }] };
      },
    },
    {
      id: 'radiator', label: 'Copper Radiator', hint: 'Finned core, very ductile', mass: 3.4,
      material: 'copper', thickness: 0.0006,
      build: () => {
        const g = tagUV(buildRadiator());
        return { geometry: g, colliders: [boxCollider(0.22, 0.19, 0.032)] };
      },
    },
  ];

  return cache;
}

export function getScrapDef(id) {
  return getScrapLibrary().find((s) => s.id === id) || getScrapLibrary()[0];
}
