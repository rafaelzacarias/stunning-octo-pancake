/**
 * Physics worker — the entire Rapier3D simulation lives here, off the main
 * thread. The main thread ({@link PhysicsClient}) allocates numeric body ids
 * synchronously and streams commands in; the worker owns the `World`, steps it
 * on a fixed timestep and ping-pongs transferable `Float32Array`s back with the
 * latest transforms and contact events.
 *
 * PROTOCOL (main -> worker)
 *   { type:'init', gravity, fixedDt, maxBodies, maxSubSteps }
 *   { type:'commands', list:[ ...command ] }   // batched, applied before step
 *   { type:'recycle', transforms:Float32Array, contacts:Float32Array }
 *
 * PROTOCOL (worker -> main)
 *   { type:'ready' }
 *   { type:'frame', tCount, cCount, seq, transforms, contacts }  // transferred
 *
 * Zero steady-state allocation: transform/contact buffers are pooled and
 * cycled between the two threads.
 */

import RAPIER from '@dimforge/rapier3d-compat';

const TRANSFORM_STRIDE = 9; // [id, px,py,pz, qx,qy,qz,qw, sleeping]
const CONTACT_STRIDE = 10; // [idA, idB, px,py,pz, nx,ny,nz, impulse, relSpeed]
const MAX_CONTACTS_PER_FRAME = 192;
const POOL_SIZE = 3;

const state = {
  world: null,
  eventQueue: null,
  gravity: { x: 0, y: -9.82, z: 0 },
  fixedDt: 1 / 120,
  maxSubSteps: 4,
  maxBodies: 420,
  accumulator: 0,
  lastTime: 0,
  seq: 0,
  running: false
};

/** id -> { body, colliders:number[], type } */
const bodies = new Map();
/** colliderHandle -> bodyId */
const colliderToId = new Map();

/** Pending command list applied at the head of the next step batch. */
let pendingCommands = [];

/* ------------------------------------------------------------------ *
 * Transferable buffer pool. Each entry holds a transform + contact
 * buffer. A pool entry is either free (available to fill and post) or
 * in-flight (owned by the main thread until recycled).
 * ------------------------------------------------------------------ */
const pool = [];
/** Contacts accumulated across steps since the last successful post. */
let pendingContacts = null;
let pendingContactCount = 0;

function initPool(maxBodies) {
  pool.length = 0;
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push({
      transforms: new Float32Array(maxBodies * TRANSFORM_STRIDE),
      contacts: new Float32Array(MAX_CONTACTS_PER_FRAME * CONTACT_STRIDE),
      free: true
    });
  }
  pendingContacts = new Float32Array(MAX_CONTACTS_PER_FRAME * CONTACT_STRIDE);
  pendingContactCount = 0;
}

function acquire() {
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].free) return pool[i];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Collider construction from a shape descriptor.
 * ------------------------------------------------------------------ */
function buildColliderDesc(s) {
  let desc = null;
  switch (s.type) {
    case 'box':
      desc = RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
      break;
    case 'ball':
      desc = RAPIER.ColliderDesc.ball(s.radius);
      break;
    case 'cylinder':
      desc = RAPIER.ColliderDesc.cylinder(s.halfHeight, s.radius);
      break;
    case 'roundCylinder':
      desc = RAPIER.ColliderDesc.roundCylinder(s.halfHeight, s.radius, s.borderRadius ?? 0.005);
      break;
    case 'capsule':
      desc = RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius);
      break;
    case 'cone':
      desc = RAPIER.ColliderDesc.cone(s.halfHeight, s.radius);
      break;
    case 'convexHull':
      desc = RAPIER.ColliderDesc.convexHull(s.points);
      break;
    case 'trimesh':
      desc = RAPIER.ColliderDesc.trimesh(s.vertices, s.indices);
      break;
    default:
      desc = RAPIER.ColliderDesc.cuboid(s.hx ?? 0.05, s.hy ?? 0.05, s.hz ?? 0.05);
  }
  if (!desc) return null;

  if (s.position) desc.setTranslation(s.position[0], s.position[1], s.position[2]);
  if (s.quaternion) {
    desc.setRotation({ x: s.quaternion[0], y: s.quaternion[1], z: s.quaternion[2], w: s.quaternion[3] });
  }
  if (s.density != null) desc.setDensity(s.density);
  if (s.friction != null) desc.setFriction(s.friction);
  if (s.restitution != null) desc.setRestitution(s.restitution);
  if (s.sensor) desc.setSensor(true);
  return desc;
}

function attachColliders(id, body, shapes, defaults, collisionGroups) {
  const list = bodies.get(id).colliders;
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    if (s.density == null && defaults.density != null) s.density = defaults.density;
    if (s.friction == null && defaults.friction != null) s.friction = defaults.friction;
    if (s.restitution == null && defaults.restitution != null) s.restitution = defaults.restitution;
    const desc = buildColliderDesc(s);
    if (!desc) continue;
    if (collisionGroups != null) desc.setCollisionGroups(collisionGroups);
    desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    desc.setContactForceEventThreshold(0.5);
    const col = state.world.createCollider(desc, body);
    list.push(col.handle);
    colliderToId.set(col.handle, id);
  }
}

function addBody(desc) {
  const id = desc.id;
  let bd;
  switch (desc.type) {
    case 'fixed':
      bd = RAPIER.RigidBodyDesc.fixed();
      break;
    case 'kinematicPosition':
      bd = RAPIER.RigidBodyDesc.kinematicPositionBased();
      break;
    case 'kinematicVelocity':
      bd = RAPIER.RigidBodyDesc.kinematicVelocityBased();
      break;
    case 'dynamic':
    default:
      bd = RAPIER.RigidBodyDesc.dynamic();
  }
  const p = desc.position || [0, 0, 0];
  bd.setTranslation(p[0], p[1], p[2]);
  if (desc.quaternion) {
    bd.setRotation({ x: desc.quaternion[0], y: desc.quaternion[1], z: desc.quaternion[2], w: desc.quaternion[3] });
  }
  if (desc.linearDamping != null) bd.setLinearDamping(desc.linearDamping);
  if (desc.angularDamping != null) bd.setAngularDamping(desc.angularDamping);
  if (desc.ccd) bd.setCcdEnabled(true);
  if (desc.canSleep === false) bd.setCanSleep(false);

  const body = state.world.createRigidBody(bd);
  bodies.set(id, { body, colliders: [], type: desc.type || 'dynamic' });
  attachColliders(id, body, desc.shapes || [], desc, desc.collisionGroups);
  return id;
}

function removeBody(id) {
  const entry = bodies.get(id);
  if (!entry) return;
  for (let i = 0; i < entry.colliders.length; i++) colliderToId.delete(entry.colliders[i]);
  state.world.removeRigidBody(entry.body);
  bodies.delete(id);
}

function replaceShape(id, shapeDesc) {
  const entry = bodies.get(id);
  if (!entry) return;
  for (let i = 0; i < entry.colliders.length; i++) {
    const col = state.world.getCollider(entry.colliders[i]);
    if (col) state.world.removeCollider(col, false);
    colliderToId.delete(entry.colliders[i]);
  }
  entry.colliders.length = 0;
  attachColliders(id, entry.body, shapeDesc.shapes || [], shapeDesc, shapeDesc.collisionGroups);
}

/* ------------------------------------------------------------------ *
 * Command application.
 * ------------------------------------------------------------------ */
function applyCommand(c) {
  const op = c[0];
  if (op === 'add') {
    addBody(c[1]);
    return;
  }
  const entry = bodies.get(c[1]);
  const body = entry ? entry.body : null;
  switch (op) {
    case 'remove':
      removeBody(c[1]);
      break;
    case 'replaceShape':
      replaceShape(c[1], c[2]);
      break;
    case 'linvel':
      if (body) body.setLinvel({ x: c[2], y: c[3], z: c[4] }, true);
      break;
    case 'angvel':
      if (body) body.setAngvel({ x: c[2], y: c[3], z: c[4] }, true);
      break;
    case 'impulse':
      if (body) {
        if (c[5] != null) {
          body.applyImpulseAtPoint({ x: c[2], y: c[3], z: c[4] }, { x: c[5], y: c[6], z: c[7] }, true);
        } else {
          body.applyImpulse({ x: c[2], y: c[3], z: c[4] }, true);
        }
      }
      break;
    case 'kinPos':
      if (body) body.setNextKinematicTranslation({ x: c[2], y: c[3], z: c[4] });
      break;
    case 'kinRot':
      if (body) body.setNextKinematicRotation({ x: c[2], y: c[3], z: c[4], w: c[5] });
      break;
    case 'enabled':
      if (body) body.setEnabled(!!c[2]);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Contact sampling. Rapier reports contact-force events above the
 * threshold; for each we probe the manifold for a representative point,
 * world normal and impulse magnitude.
 * ------------------------------------------------------------------ */
const _relA = { x: 0, y: 0, z: 0 };
const _relB = { x: 0, y: 0, z: 0 };

function sampleContacts() {
  const arr = pendingContacts;
  state.eventQueue.drainContactForceEvents((event) => {
    if (pendingContactCount >= MAX_CONTACTS_PER_FRAME) return;
    const h1 = event.collider1();
    const h2 = event.collider2();
    const idA = colliderToId.get(h1);
    const idB = colliderToId.get(h2);
    if (idA === undefined || idB === undefined) return;
    const col1 = state.world.getCollider(h1);
    const col2 = state.world.getCollider(h2);
    if (!col1 || !col2) return;

    let px = 0;
    let py = 0;
    let pz = 0;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let impulse = 0;
    let samples = 0;

    state.world.contactPair(col1, col2, (manifold) => {
      const n = manifold.normal();
      nx = n.x;
      ny = n.y;
      nz = n.z;
      const num = manifold.numSolverContacts();
      if (num > 0) {
        for (let i = 0; i < num; i++) {
          const pt = manifold.solverContactPoint(i);
          px += pt.x;
          py += pt.y;
          pz += pt.z;
          samples++;
        }
      }
      const nc = manifold.numContacts();
      for (let i = 0; i < nc; i++) impulse += manifold.contactImpulse(i);
    });

    if (samples > 0) {
      px /= samples;
      py /= samples;
      pz /= samples;
    } else {
      // Fall back to the reporting collider centroid.
      const t = col1.translation();
      px = t.x;
      py = t.y;
      pz = t.z;
    }
    if (impulse <= 0) impulse = event.maxForceMagnitude() * state.fixedDt;

    // Relative speed along the contact normal.
    const ea = bodies.get(idA);
    const eb = bodies.get(idB);
    let relSpeed = 0;
    if (ea && eb) {
      const va = ea.body.linvel();
      const vb = eb.body.linvel();
      _relA.x = va.x - vb.x;
      _relA.y = va.y - vb.y;
      _relA.z = va.z - vb.z;
      relSpeed = Math.abs(_relA.x * nx + _relA.y * ny + _relA.z * nz);
    }

    const o = pendingContactCount * CONTACT_STRIDE;
    arr[o] = idA;
    arr[o + 1] = idB;
    arr[o + 2] = px;
    arr[o + 3] = py;
    arr[o + 4] = pz;
    arr[o + 5] = nx;
    arr[o + 6] = ny;
    arr[o + 7] = nz;
    arr[o + 8] = impulse;
    arr[o + 9] = relSpeed;
    pendingContactCount++;
  });
}

/* ------------------------------------------------------------------ *
 * Frame post: fill a free pool entry with the latest transforms +
 * accumulated contacts, then transfer it to the main thread.
 * ------------------------------------------------------------------ */
function postFrame() {
  const slot = acquire();
  if (!slot) return; // main thread is behind; keep simulating, post next tick.
  slot.free = false;

  const tf = slot.transforms;
  let count = 0;
  const max = state.maxBodies;
  bodies.forEach((entry, id) => {
    if (entry.type === 'fixed') return;
    if (count >= max) return;
    const t = entry.body.translation();
    const r = entry.body.rotation();
    const o = count * TRANSFORM_STRIDE;
    tf[o] = id;
    tf[o + 1] = t.x;
    tf[o + 2] = t.y;
    tf[o + 3] = t.z;
    tf[o + 4] = r.x;
    tf[o + 5] = r.y;
    tf[o + 6] = r.z;
    tf[o + 7] = r.w;
    tf[o + 8] = entry.body.isSleeping() ? 1 : 0;
    count++;
  });

  const cf = slot.contacts;
  cf.set(pendingContacts.subarray(0, pendingContactCount * CONTACT_STRIDE));
  const cCount = pendingContactCount;
  pendingContactCount = 0;

  state.seq++;
  self.postMessage(
    { type: 'frame', tCount: count, cCount, seq: state.seq, transforms: tf, contacts: cf },
    [tf.buffer, cf.buffer]
  );
}

/* ------------------------------------------------------------------ *
 * Self-driven fixed-timestep loop.
 * ------------------------------------------------------------------ */
function step() {
  if (pendingCommands.length) {
    const list = pendingCommands;
    pendingCommands = [];
    for (let i = 0; i < list.length; i++) applyCommand(list[i]);
  }
  state.world.step(state.eventQueue);
  sampleContacts();
}

function loop() {
  if (!state.running) return;
  const now = performance.now();
  let frameDt = (now - state.lastTime) / 1000;
  state.lastTime = now;
  if (frameDt > 0.1) frameDt = 0.1;
  state.accumulator += frameDt;

  let sub = 0;
  while (state.accumulator >= state.fixedDt && sub < state.maxSubSteps) {
    step();
    state.accumulator -= state.fixedDt;
    sub++;
  }
  if (sub === state.maxSubSteps && state.accumulator > state.fixedDt) {
    state.accumulator = 0; // clamp: avoid the spiral of death
  }
  postFrame();

  // Target the fixed step; the accumulator absorbs jitter.
  setTimeout(loop, Math.max(0, state.fixedDt * 1000 - 1));
}

/* ------------------------------------------------------------------ */
async function init(msg) {
  await RAPIER.init();
  state.gravity = { x: msg.gravity[0], y: msg.gravity[1], z: msg.gravity[2] };
  state.fixedDt = msg.fixedDt || 1 / 120;
  state.maxSubSteps = msg.maxSubSteps || 4;
  state.maxBodies = msg.maxBodies || 420;
  state.world = new RAPIER.World(state.gravity);
  state.world.integrationParameters.dt = state.fixedDt;
  state.world.numSolverIterations = 4;
  state.eventQueue = new RAPIER.EventQueue(true);
  initPool(state.maxBodies);
  state.running = true;
  state.lastTime = performance.now();
  self.postMessage({ type: 'ready' });
  loop();
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init(msg);
      break;
    case 'commands':
      // Concatenate to preserve ordering across bursts within one frame.
      if (pendingCommands.length === 0) pendingCommands = msg.list;
      else for (let i = 0; i < msg.list.length; i++) pendingCommands.push(msg.list[i]);
      break;
    case 'recycle': {
      // Return buffers to the pool by matching the underlying arrays.
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].transforms.buffer.byteLength === 0) {
          pool[i].transforms = msg.transforms;
          pool[i].contacts = msg.contacts;
          pool[i].free = true;
          return;
        }
      }
      // Fallback: assign to any in-flight slot.
      for (let i = 0; i < pool.length; i++) {
        if (!pool[i].free) {
          pool[i].transforms = msg.transforms;
          pool[i].contacts = msg.contacts;
          pool[i].free = true;
          return;
        }
      }
      break;
    }
    default:
      break;
  }
};
