/**
 * physics.worker.js — Rapier3D simulation running fully off the UI thread.
 *
 * Protocol (main -> worker):
 *   init            { gravity, subSteps }
 *   buildStatic     { colliders:[...] }              fixed world geometry
 *   buildShredder   { cutters:[...], throat }        kinematic counter-rotating cutters
 *   setConveyor     { enabled, speed, aabb, dir }
 *   addBody         { id, shapes, position, quaternion, density, ... }
 *   removeBody      { id }
 *   setShredder     { enabled, reverse, rpm }
 *   applyImpulse    { id, impulse, point }
 *   recycle         { buffer }                       returns a snapshot buffer to the pool
 *   pause / resume
 *
 * Protocol (worker -> main):
 *   ready
 *   snapshot        { buffer, count, time, stats }   transferable Float32Array
 *   contacts        { buffer, count }                transferable Float32Array
 *   removed         { ids }
 */

import RAPIER from '@dimforge/rapier3d-compat';

/* ------------------------------------------------------------------ layout */
// snapshot stride: id, px,py,pz, qx,qy,qz,qw, vx,vy,vz, flags
const STRIDE = 13;
// contact stride: idA, idB, px,py,pz, nx,ny,nz, force, speed, cutterFlag, planeX
const CSTRIDE = 12;

const GROUP_SCRAP = 0x0001;
const GROUP_WORLD = 0x0002;
const GROUP_CUTTER = 0x0004;

/* ------------------------------------------------------------------- state */
let world = null;
let eventQueue = null;
let ready = false;
let paused = false;
let loopHandle = null;

const bodies = new Map(); // id -> { rb, colliders:[], density, kind }
const colliderInfo = new Map(); // colliderHandle -> { bodyId, cutter, planeX, shaft }
/** bodyId -> ImpulseJoint[] welding it to the rest of its assembly. */
const bodyJoints = new Map();
let weldCount = 0;
let weldFailures = 0;

const bufferPool = [];
const contactPool = [];

const shredder = {
  enabled: false,
  reverse: false,
  rpm: 45,
  angle: 0,
  currentRpm: 0,
  ratio: [1.0, 1.28],
  cutters: [], // { rb, shaft, x, phase }
  load: 0,
  loadSmooth: 0,
};

const conveyor = {
  enabled: true,
  speed: 0.45,
  min: [-1.4, -0.2, 1.1],
  max: [1.4, 0.9, 4.6],
  dir: [0, 0, -1],
  maxSpeed: 2.2,
};

const KILL_Y = -14;
const MAX_CONTACTS = 512;

let stepAccumulator = 0;
let lastTime = 0;
let fixedDt = 1 / 60;
let maxSubSteps = 3;
let stepMsSmooth = 0;
let timeScale = 1;

/* ---------------------------------------------------------------- utilities */

function quatFromAxisAngle(ax, ay, az, angle) {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) };
}

function takeBuffer(pool, floats) {
  const bytes = floats * 4;
  for (let i = pool.length - 1; i >= 0; i--) {
    if (pool[i].byteLength >= bytes) return pool.splice(i, 1)[0];
  }
  return new ArrayBuffer(Math.max(bytes, 1024));
}

/**
 * Build a Rapier collider descriptor from a plain shape description.
 */
function descFromShape(shape) {
  let desc = null;
  switch (shape.type) {
    case 'box':
      desc = RAPIER.ColliderDesc.cuboid(shape.he[0], shape.he[1], shape.he[2]);
      break;
    case 'sphere':
      desc = RAPIER.ColliderDesc.ball(shape.radius);
      break;
    case 'cylinder':
      desc = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
      break;
    case 'capsule':
      desc = RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      break;
    case 'cone':
      desc = RAPIER.ColliderDesc.cone(shape.halfHeight, shape.radius);
      break;
    case 'hull': {
      const pts = shape.points instanceof Float32Array ? shape.points : new Float32Array(shape.points);
      desc = RAPIER.ColliderDesc.convexHull(pts);
      if (!desc) {
        // Degenerate hull (coplanar slivers) -> fall back to its AABB.
        const he = aabbHalfExtents(pts);
        desc = RAPIER.ColliderDesc.cuboid(
          Math.max(he[0], 0.004), Math.max(he[1], 0.004), Math.max(he[2], 0.004)
        );
        shape.offset = shape.offset || he[3];
      }
      break;
    }
    default:
      return null;
  }
  if (shape.offset) desc.setTranslation(shape.offset[0], shape.offset[1], shape.offset[2]);
  if (shape.rotation) {
    const r = shape.rotation;
    desc.setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] });
  }
  return desc;
}

function aabbHalfExtents(pts) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < minx) minx = pts[i];
    if (pts[i] > maxx) maxx = pts[i];
    if (pts[i + 1] < miny) miny = pts[i + 1];
    if (pts[i + 1] > maxy) maxy = pts[i + 1];
    if (pts[i + 2] < minz) minz = pts[i + 2];
    if (pts[i + 2] > maxz) maxz = pts[i + 2];
  }
  return [
    (maxx - minx) * 0.5, (maxy - miny) * 0.5, (maxz - minz) * 0.5,
    [(maxx + minx) * 0.5, (maxy + miny) * 0.5, (maxz + minz) * 0.5],
  ];
}

/* -------------------------------------------------------------------- init */

async function init(msg) {
  await RAPIER.init();
  const g = msg.gravity || [0, -9.81, 0];
  world = new RAPIER.World({ x: g[0], y: g[1], z: g[2] });
  eventQueue = new RAPIER.EventQueue(true);

  fixedDt = msg.fixedDt || 1 / 60;
  maxSubSteps = msg.maxSubSteps || 3;

  const ip = world.integrationParameters;
  ip.dt = fixedDt;
  if ('numSolverIterations' in ip) ip.numSolverIterations = 6;
  if ('numAdditionalFrictionIterations' in ip) ip.numAdditionalFrictionIterations = 6;
  if ('numInternalPgsIterations' in ip) ip.numInternalPgsIterations = 2;

  ready = true;
  lastTime = performance.now();
  self.postMessage({ type: 'ready' });
  loop();
}

/* ------------------------------------------------------------ world objects */

function buildStatic(list) {
  for (const item of list) {
    const rbDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      item.position[0], item.position[1], item.position[2]
    );
    if (item.quaternion) {
      rbDesc.setRotation({
        x: item.quaternion[0], y: item.quaternion[1],
        z: item.quaternion[2], w: item.quaternion[3],
      });
    }
    const rb = world.createRigidBody(rbDesc);
    const cols = [];
    for (const shape of item.shapes) {
      const desc = descFromShape(shape);
      if (!desc) continue;
      desc.setFriction(item.friction ?? 0.72);
      desc.setRestitution(item.restitution ?? 0.16);
      desc.setCollisionGroups((GROUP_WORLD << 16) | (GROUP_SCRAP | GROUP_WORLD));
      if (item.reportImpacts) {
        desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
        desc.setContactForceEventThreshold(item.forceThreshold ?? 380);
      }
      const col = world.createCollider(desc, rb);
      colliderInfo.set(col.handle, { bodyId: -1, cutter: false, planeX: 0, shaft: -1 });
      cols.push(col);
    }
    bodies.set(item.id ?? -(bodies.size + 1000), { rb, colliders: cols, kind: 'static' });
  }
}

/**
 * Each cutter disc is its own kinematic-position body so Rapier resolves
 * contacts with the correct surface velocity as it sweeps through material.
 */
function buildShredder(cfg) {
  shredder.cutters.length = 0;
  if (cfg.ratio) shredder.ratio = cfg.ratio;
  for (const c of cfg.cutters) {
    const rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(c.position[0], c.position[1], c.position[2]);
    const rb = world.createRigidBody(rbDesc);
    const cols = [];

    // Hub: Rapier cylinders are Y-aligned, rotate onto the X shaft axis.
    const hubRot = quatFromAxisAngle(0, 0, 1, Math.PI * 0.5);
    const hubDesc = RAPIER.ColliderDesc.cylinder(c.hub.halfHeight, c.hub.radius)
      .setRotation(hubRot)
      .setFriction(1.35)
      .setRestitution(0.02)
      .setCollisionGroups((GROUP_CUTTER << 16) | GROUP_SCRAP)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      // Low threshold on purpose: a 16 g aluminium can never presses hard
      // enough to trip a double-digit newton threshold, so it would register
      // zero damage and rattle on top of the rotors forever.
      .setContactForceEventThreshold(6);
    const hubCol = world.createCollider(hubDesc, rb);
    colliderInfo.set(hubCol.handle, { bodyId: -2, cutter: true, planeX: c.position[0], shaft: c.shaft, hub: true });
    cols.push(hubCol);

    for (const toothPts of c.teeth) {
      const pts = toothPts instanceof Float32Array ? toothPts : new Float32Array(toothPts);
      const desc = RAPIER.ColliderDesc.convexHull(pts);
      if (!desc) continue;
      desc.setFriction(1.55)
        .setRestitution(0.015)
        .setCollisionGroups((GROUP_CUTTER << 16) | GROUP_SCRAP)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(2);
      const col = world.createCollider(desc, rb);
      colliderInfo.set(col.handle, {
        bodyId: -2, cutter: true, planeX: c.position[0], shaft: c.shaft, hub: false,
        shearMin: c.shearMin, shearMax: c.shearMax,
      });
      cols.push(col);
    }
    shredder.cutters.push({ rb, shaft: c.shaft, x: c.position[0], phase: c.phase || 0, colliders: cols });
  }
}

function addBody(msg) {
  if (!world) return;
  const desc = (msg.kind === 'static'
    ? RAPIER.RigidBodyDesc.fixed()
    : RAPIER.RigidBodyDesc.dynamic())
    .setTranslation(msg.position[0], msg.position[1], msg.position[2])
    .setRotation({
      x: msg.quaternion[0], y: msg.quaternion[1],
      z: msg.quaternion[2], w: msg.quaternion[3],
    })
    .setLinearDamping(msg.linearDamping ?? 0.06)
    .setAngularDamping(msg.angularDamping ?? 0.14)
    .setCcdEnabled(msg.ccd ?? false);

  if (msg.linvel) desc.setLinvel(msg.linvel[0], msg.linvel[1], msg.linvel[2]);
  if (msg.angvel) desc.setAngvel({ x: msg.angvel[0], y: msg.angvel[1], z: msg.angvel[2] });

  const rb = world.createRigidBody(desc);
  const cols = [];
  for (const shape of msg.shapes) {
    const cd = descFromShape(shape);
    if (!cd) continue;
    cd.setDensity(msg.density ?? 7800);
    cd.setFriction(msg.friction ?? 0.62);
    cd.setRestitution(msg.restitution ?? 0.08);
    cd.setCollisionGroups((GROUP_SCRAP << 16) | (GROUP_SCRAP | GROUP_WORLD | GROUP_CUTTER));
    const col = world.createCollider(cd, rb);
    colliderInfo.set(col.handle, { bodyId: msg.id, cutter: false, planeX: 0, shaft: -1 });
    cols.push(col);
  }
  if (cols.length === 0) {
    world.removeRigidBody(rb);
    return;
  }
  bodies.set(msg.id, { rb, colliders: cols, kind: 'dynamic', density: msg.density ?? 7800 });
}

function removeBody(id) {
  const rec = bodies.get(id);
  if (!rec) return;
  breakJoints(id);
  for (const c of rec.colliders) colliderInfo.delete(c.handle);
  world.removeRigidBody(rec.rb);
  bodies.delete(id);
}

/* ------------------------------------------------- compound assemblies */

function qConj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }

function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function qRotate(q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/**
 * Weld two bodies in their current relative pose with a fixed joint.
 * Anchors are placed at the world midpoint between the two centres, expressed
 * in each body's local frame, and frame2 carries the relative rotation so the
 * pair is locked exactly as spawned.
 */
function weld(rbA, rbB) {
  const pa = rbA.translation(), qa = rbA.rotation();
  const pb = rbB.translation(), qb = rbB.rotation();
  const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 };

  const a1 = qRotate(qConj(qa), { x: mid.x - pa.x, y: mid.y - pa.y, z: mid.z - pa.z });
  const a2 = qRotate(qConj(qb), { x: mid.x - pb.x, y: mid.y - pb.y, z: mid.z - pb.z });
  const f1 = { x: 0, y: 0, z: 0, w: 1 };
  const f2 = qMul(qConj(qb), qa);

  const params = RAPIER.JointData.fixed(a1, f1, a2, f2);
  const joint = world.createImpulseJoint(params, rbA, rbB, true);
  // Sibling parts sit flush against each other; letting them also generate
  // contacts makes the joint fight the contact solver and the whole assembly
  // buzzes.
  joint.setContactsEnabled?.(false);
  return joint;
}

function registerJoint(id, joint) {
  let list = bodyJoints.get(id);
  if (!list) { list = []; bodyJoints.set(id, list); }
  list.push(joint);
}

/** Sever every weld touching this body. Safe to call repeatedly. */
function breakJoints(id) {
  const list = bodyJoints.get(id);
  if (!list) return;
  for (const joint of list) {
    try { world.removeImpulseJoint(joint, true); weldCount--; } catch (e) { /* already gone */ }
    // Drop the same joint from whichever sibling also referenced it.
    for (const [otherId, otherList] of bodyJoints) {
      if (otherId === id) continue;
      const i = otherList.indexOf(joint);
      if (i >= 0) otherList.splice(i, 1);
    }
  }
  bodyJoints.delete(id);
}

/**
 * Spawn a multi-part object as separate rigid bodies welded into one rigid
 * assembly. Star topology from the heaviest part, so severing one part never
 * silently detaches unrelated siblings.
 */
function addAssembly(msg) {
  const created = [];
  for (const part of msg.parts) {
    addBody(part);
    if (bodies.has(part.id)) created.push(part.id);
  }
  if (created.length < 2) return;

  const baseId = created[0];
  const base = bodies.get(baseId);
  for (let i = 1; i < created.length; i++) {
    const rec = bodies.get(created[i]);
    if (!rec) continue;
    let joint;
    try { joint = weld(base.rb, rec.rb); } catch (e) { weldFailures++; continue; }
    if (!joint) { weldFailures++; continue; }
    weldCount++;
    registerJoint(baseId, joint);
    registerJoint(created[i], joint);
  }
}

/* -------------------------------------------------------------------- step */

const _cv = { x: 0, y: 0, z: 0 };

function driveConveyor(dt) {
  if (!conveyor.enabled || conveyor.speed <= 0.001) return;
  const target = conveyor.speed * conveyor.maxSpeed;
  const [minX, minY, minZ] = conveyor.min;
  const [maxX, maxY, maxZ] = conveyor.max;
  const desiredX = conveyor.dir[0] * target;
  const desiredZ = conveyor.dir[2] * target;

  for (const rec of bodies.values()) {
    if (rec.kind !== 'dynamic') continue;
    const rb = rec.rb;
    const t = rb.translation();
    if (t.x < minX || t.x > maxX || t.y < minY || t.y > maxY || t.z < minZ || t.z > maxZ) continue;

    // A running belt must never let its load fall asleep, otherwise stock
    // parks itself halfway to the throat and the machine starves.
    if (rb.isSleeping()) rb.wakeUp();

    const v = rb.linvel();
    // Only drive along the belt direction; leave gravity/settling untouched.
    const gain = rb.mass() * 12.0 * dt;
    _cv.x = (desiredX - v.x) * gain;
    _cv.y = 0;
    _cv.z = (desiredZ - v.z) * gain;
    rb.applyImpulse(_cv, true);
  }
}

function driveShredder(dt) {
  const targetRpm = shredder.enabled ? shredder.rpm : 0;
  // Motor inertia + load-induced lag => audible/visible strain.
  const strain = 1 - Math.min(0.55, shredder.loadSmooth * 0.55);
  const accel = shredder.enabled ? 1.9 : 3.2;
  shredder.currentRpm += (targetRpm * strain - shredder.currentRpm) * Math.min(1, accel * dt);
  if (shredder.currentRpm < 0.01) shredder.currentRpm = 0;

  const dir = shredder.reverse ? -1 : 1;
  const omega = (shredder.currentRpm / 60) * Math.PI * 2 * dir;
  shredder.angle += omega * dt;

  for (const cutter of shredder.cutters) {
    // Shaft 0 runs forward, shaft 1 counter-rotates on a differential ratio so
    // the teeth wipe past each other and self-clean. The baked-in phase makes
    // teeth enter the stock one at a time instead of hammering in unison.
    const sign = cutter.shaft === 0 ? shredder.ratio[0] : -shredder.ratio[1];
    const q = quatFromAxisAngle(1, 0, 0, shredder.angle * sign + cutter.phase);
    cutter.rb.setNextKinematicRotation(q);
  }
}

let contactBuf = null;
let contactCount = 0;

function collectContacts() {
  contactCount = 0;
  const ab = takeBuffer(contactPool, MAX_CONTACTS * CSTRIDE);
  contactBuf = new Float32Array(ab, 0, MAX_CONTACTS * CSTRIDE);
  let load = 0;

  eventQueue.drainContactForceEvents((event) => {
    if (contactCount >= MAX_CONTACTS) return;
    const h1 = event.collider1();
    const h2 = event.collider2();
    const i1 = colliderInfo.get(h1);
    const i2 = colliderInfo.get(h2);
    if (!i1 || !i2) return;

    const cutterInfo = i1.cutter ? i1 : (i2.cutter ? i2 : null);
    const scrapId = i1.bodyId >= 0 ? i1.bodyId : (i2.bodyId >= 0 ? i2.bodyId : -1);
    if (scrapId < 0) return;

    const force = event.totalForceMagnitude();
    if (cutterInfo) load += force;

    const c1 = world.getCollider(h1);
    const c2 = world.getCollider(h2);
    if (!c1 || !c2) return;

    // Pull the real world-space contact point out of the narrow phase.
    let px = 0, py = 0, pz = 0, n = 0;
    world.contactPair(c1, c2, (manifold) => {
      const num = manifold.numContacts();
      for (let i = 0; i < num; i++) {
        const p = manifold.solverContactPoint(i);
        if (!p) continue;
        px += p.x; py += p.y; pz += p.z; n++;
      }
    });
    if (n === 0) return;
    px /= n; py /= n; pz /= n;

    const dir = event.maxForceDirection();
    const rec = bodies.get(scrapId);
    let speed = 0;
    if (rec) {
      const v = rec.rb.linvel();
      speed = Math.hypot(v.x, v.y, v.z);
    }

    const o = contactCount * CSTRIDE;
    contactBuf[o] = scrapId;
    contactBuf[o + 1] = cutterInfo ? -2 : -1;
    contactBuf[o + 2] = px;
    contactBuf[o + 3] = py;
    contactBuf[o + 4] = pz;
    contactBuf[o + 5] = dir.x;
    contactBuf[o + 6] = dir.y;
    contactBuf[o + 7] = dir.z;
    contactBuf[o + 8] = force;
    contactBuf[o + 9] = speed;
    contactBuf[o + 10] = cutterInfo ? 1 : 0;
    contactBuf[o + 11] = cutterInfo ? cutterInfo.planeX : 0;
    contactCount++;
  });

  // Normalised load: the throat saturates around 90kN of accumulated contact force.
  const norm = Math.min(1, load / 90000);
  shredder.load = norm;
  shredder.loadSmooth += (norm - shredder.loadSmooth) * 0.12;
}

function step(dt) {
  driveShredder(dt);
  driveConveyor(dt);
  world.integrationParameters.dt = dt;
  world.step(eventQueue);
  collectContacts();
}

/* ---------------------------------------------------------------- snapshot */

const removedIds = [];

function publish() {
  let count = 0;
  removedIds.length = 0;
  for (const [id, rec] of bodies) {
    if (rec.kind !== 'dynamic') continue;
    const t = rec.rb.translation();
    if (t.y < KILL_Y) { removedIds.push(id); continue; }
    count++;
  }
  if (removedIds.length) {
    for (const id of removedIds) removeBody(id);
    self.postMessage({ type: 'removed', ids: removedIds.slice() });
  }

  const ab = takeBuffer(bufferPool, count * STRIDE);
  const view = new Float32Array(ab, 0, count * STRIDE);
  let i = 0;
  for (const [id, rec] of bodies) {
    if (rec.kind !== 'dynamic') continue;
    const rb = rec.rb;
    const t = rb.translation();
    const q = rb.rotation();
    const v = rb.linvel();
    const o = i * STRIDE;
    view[o] = id;
    view[o + 1] = t.x; view[o + 2] = t.y; view[o + 3] = t.z;
    view[o + 4] = q.x; view[o + 5] = q.y; view[o + 6] = q.z; view[o + 7] = q.w;
    view[o + 8] = v.x; view[o + 9] = v.y; view[o + 10] = v.z;
    view[o + 11] = rb.isSleeping() ? 1 : 0;
    view[o + 12] = 0;
    i++;
  }

  const transfer = [ab];
  const cab = contactBuf ? contactBuf.buffer : null;
  if (cab) transfer.push(cab);

  self.postMessage({
    type: 'snapshot',
    buffer: ab,
    count,
    stride: STRIDE,
    contacts: cab,
    contactCount,
    contactStride: CSTRIDE,
    shredderAngle: shredder.angle,
    rpm: shredder.currentRpm,
    load: shredder.loadSmooth,
    bodies: bodies.size,
    welds: weldCount,
    weldFailures,
    stepMs: stepMsSmooth,
  }, transfer);
  contactBuf = null;
}

function loop() {
  const now = performance.now();
  let frameDt = (now - lastTime) / 1000;
  lastTime = now;
  if (frameDt > 0.25) frameDt = 0.25;

  if (!paused && ready) {
    stepAccumulator += frameDt * timeScale;
    let steps = 0;
    const t0 = performance.now();
    while (stepAccumulator >= fixedDt && steps < maxSubSteps) {
      step(fixedDt);
      stepAccumulator -= fixedDt;
      steps++;
    }
    if (steps === maxSubSteps) stepAccumulator = 0; // shed backlog, never spiral
    if (steps > 0) {
      const ms = performance.now() - t0;
      stepMsSmooth += (ms - stepMsSmooth) * 0.1;
      publish();
    }
  }
  loopHandle = setTimeout(loop, 2);
}

/* ----------------------------------------------------------------- message */

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': init(msg); break;
    case 'buildStatic': buildStatic(msg.items); break;
    case 'buildShredder': buildShredder(msg); break;
    case 'addBody': addBody(msg); break;
    case 'addBodies': for (const b of msg.items) addBody(b); break;
    case 'addAssembly': addAssembly(msg); break;
    case 'breakJoints': for (const id of msg.ids) breakJoints(id); break;
    case 'removeBody': removeBody(msg.id); break;
    case 'removeBodies': for (const id of msg.ids) removeBody(id); break;
    case 'setShredder':
      if (msg.enabled !== undefined) shredder.enabled = msg.enabled;
      if (msg.reverse !== undefined) shredder.reverse = msg.reverse;
      if (msg.rpm !== undefined) shredder.rpm = msg.rpm;
      break;
    case 'setConveyor':
      if (msg.enabled !== undefined) conveyor.enabled = msg.enabled;
      if (msg.speed !== undefined) conveyor.speed = msg.speed;
      if (msg.aabb) { conveyor.min = msg.aabb.min; conveyor.max = msg.aabb.max; }
      if (msg.dir) conveyor.dir = msg.dir;
      break;
    case 'applyImpulse': {
      const rec = bodies.get(msg.id);
      if (rec) {
        const imp = { x: msg.impulse[0], y: msg.impulse[1], z: msg.impulse[2] };
        if (msg.point) {
          rec.rb.applyImpulseAtPoint(imp, { x: msg.point[0], y: msg.point[1], z: msg.point[2] }, true);
        } else {
          rec.rb.applyImpulse(imp, true);
        }
      }
      break;
    }
    case 'clearDynamic': {
      const ids = [];
      for (const [id, rec] of bodies) if (rec.kind === 'dynamic') ids.push(id);
      for (const id of ids) removeBody(id);
      bodyJoints.clear();
      self.postMessage({ type: 'removed', ids });
      break;
    }
    case 'recycle':
      if (msg.buffer) bufferPool.push(msg.buffer);
      if (msg.contacts) contactPool.push(msg.contacts);
      break;
    case 'pause': paused = true; break;
    case 'timeScale': timeScale = Math.max(0.05, Math.min(1, msg.value)); break;
    case 'resume': paused = false; lastTime = performance.now(); stepAccumulator = 0; break;
    case 'dispose':
      if (loopHandle) clearTimeout(loopHandle);
      ready = false;
      break;
    default: break;
  }
};
