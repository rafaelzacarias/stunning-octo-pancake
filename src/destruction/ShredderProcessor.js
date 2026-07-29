import * as THREE from 'three';
import { EVENTS, PHYSICS, METALS, FILTER } from '../core/Constants.js';
import { bus } from '../core/EventBus.js';
import { sliceGeometry, convexHullPoints, computeVolumeAndCentroid } from './MeshSlicer.js';
import { Deformer } from './Deformer.js';
import { coolGeometry } from '../materials/HeatAttribute.js';

/**
 * Drives the deform → yield → shear pipeline from physics contact events.
 *
 * Each frame it drains tooth↔part contacts, converts impulse into a plastic
 * response (dent/bend + heat below fracture, a mesh slice above it), reports
 * motor load back to the rig, retires spent fragments and cools hot geometry.
 * Slices are budgeted (≤2/frame) and events throttled so audio/VFX are not
 * machine-gunned.
 *
 * @module ShredderProcessor
 */

/** Below this volume a piece becomes non-sliceable shrapnel (m^3). */
const MIN_VOLUME = 1.2e-6;
/** Max slices performed per frame (keeps a frame under budget). */
const MAX_SLICES_PER_FRAME = 2;
/** Max shear events emitted per second. */
const MAX_SHEAR_EVENTS_PER_SEC = 30;
/** Impulse (N·s) below which a tooth is merely tapping, not biting. */
const BITE_FLOOR = 0.04;
/** Global strain accrual factor (tuned so a shred takes ~0.3–1.5 s). */
const STRAIN_K = 3.0;
/** Divides MPa ultimate into a gameplay-scale reference impulse (~1–10 N·s). */
const GAMEPLAY_STRESS_DIVISOR = 200;

/** Per-metal cool-down rate (1/s): thin/conductive metals shed heat fast. */
const COOL_RATE = {
  aluminium: 2.6,
  copper: 2.2,
  stainless: 1.0,
  galvanised: 1.1,
  steel: 0.9,
  hardened: 0.8,
  castIron: 0.4
};

// Module scratch — zero per-frame allocation in the hot path.
const _wp = new THREE.Vector3();
const _wn = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _centroid = new THREE.Vector3();
const _worldCentroid = new THREE.Vector3();
const _n = new THREE.Vector3();
const _bendAxis = new THREE.Vector3();
const _size = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _normalMat = new THREE.Matrix3();

export class ShredderProcessor {
  constructor(ctx) {
    this.scene = ctx.scene;
    this.physics = ctx.physics;
    this.materials = ctx.materials;
    this.rig = ctx.rig;
    this.feeder = ctx.feeder;

    /** id -> fragment record. */
    this.fragments = new Map();
    this.fragmentCount = 0;

    /** Records queued for slicing this frame (deferred, budgeted). */
    this._sliceQueue = [];
    /** Records queued for retirement (fade + free). */
    this._retiring = [];

    this._shearWindowStart = 0;
    this._shearWindowCount = 0;
    this._impactWindowStart = 0;
    this._impactWindowCount = 0;

    // Bind the contact handler once (reused each frame).
    this._toothLoad = 0;
    this._onContact = this._handleContact.bind(this);
  }

  /** @param {number} id @returns {object|undefined} scrap or fragment record */
  _record(id) {
    return this.feeder.items.get(id) || this.fragments.get(id);
  }

  /**
   * Lazily compute a record's dominant (longest) local axis and elongation
   * ratio, used to decide whether a part should bend rather than just dent.
   * @param {object} rec
   * @returns {{axis:THREE.Vector3, ratio:number}}
   */
  _ensureLong(rec) {
    if (rec.long) return rec.long;
    const geo = rec.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    geo.boundingBox.getSize(_size);
    const s = [Math.abs(_size.x), Math.abs(_size.y), Math.abs(_size.z)];
    let maxI = 0;
    if (s[1] > s[maxI]) maxI = 1;
    if (s[2] > s[maxI]) maxI = 2;
    const others = [s[0], s[1], s[2]].filter((_, i) => i !== maxI);
    const second = Math.max(others[0], others[1], 1e-4);
    const axis = new THREE.Vector3(maxI === 0 ? 1 : 0, maxI === 1 ? 1 : 0, maxI === 2 ? 1 : 0);
    rec.long = { axis, ratio: s[maxI] / second };
    return rec.long;
  }

  /**
   * Main tick.
   * @param {number} dt
   */
  update(dt) {
    this._dt = dt;
    this._toothLoad = 0;

    this.physics.consumeContacts(this._onContact);

    // Feed motor load to the rig (used on its next update).
    this.rig.reportLoad(this._toothLoad);

    // Perform up to MAX_SLICES_PER_FRAME queued slices.
    let budget = MAX_SLICES_PER_FRAME;
    while (budget-- > 0 && this._sliceQueue.length) {
      const rec = this._sliceQueue.shift();
      if (rec._queuedSlice) {
        rec._queuedSlice = false;
        this._performSlice(rec);
      }
    }

    this._retirePass(dt);
    this._coolPass(dt);

    this.fragmentCount = this.fragments.size;
  }

  /* ---------------------------------------------------------------- *
   * Contact handling.
   * ---------------------------------------------------------------- */
  _handleContact(idA, idB, px, py, pz, nx, ny, nz, impulse, relSpeed) {
    const uA = this.physics.getUserData(idA);
    const uB = this.physics.getUserData(idB);
    if (!uA || !uB) return;

    let partId = -1;
    let toothContact = false;
    if (uA.kind === 'tooth' && (uB.kind === 'scrap' || uB.kind === 'fragment')) {
      partId = idB;
      toothContact = true;
    } else if (uB.kind === 'tooth' && (uA.kind === 'scrap' || uA.kind === 'fragment')) {
      partId = idA;
      toothContact = true;
    }

    if (toothContact) this._toothLoad += impulse;

    // Hard non-biting hits still make sparks/clank.
    if (impulse < BITE_FLOOR) {
      if (impulse >= PHYSICS.hardHitImpulse * 0.25 && toothContact && this._impactBudget()) {
        _wp.set(px, py, pz);
        bus.emit(EVENTS.IMPACT, { position: _wp.clone(), impulse, metal: (partId === idA ? uA : uB).metal, relSpeed });
      }
      return;
    }
    if (!toothContact) return;

    const rec = this._record(partId);
    if (!rec || rec.debris || rec.retiring) return;

    const spec = METALS[rec.metal] || METALS.steel;

    // --- Plastic deformation (dent) ---
    rec.mesh.updateMatrixWorld();
    _wp.set(px, py, pz);
    _lp.copy(_wp);
    rec.mesh.worldToLocal(_lp);

    _wn.set(nx, ny, nz);
    rec.mesh.getWorldQuaternion(_q);
    _q.invert();
    _ld.copy(_wn).applyQuaternion(_q).normalize();
    // Ensure the dent pushes INTO the part (towards its centroid/origin).
    _c.copy(_lp).multiplyScalar(-1);
    if (_ld.dot(_c) < 0) _ld.multiplyScalar(-1);

    // Softer/ductile metals dent deeper; harder (high yield) barely move.
    const dentDepth = Math.min(0.012, (impulse * 0.006 * 200) / spec.yieldStrength);
    const radius = 0.03 + relSpeed * 0.004;
    Deformer.dent(rec.geometry, _lp, _ld, radius, dentDepth, rec.deform);
    rec.hot = true;

    // --- Bending: a long part gripped by teeth folds about the shear line ---
    const lng = this._ensureLong(rec);
    const now = performance.now();
    if (lng.ratio > 1.8 && impulse > 0.5 && now - (rec._lastBend || 0) > 140) {
      rec._lastBend = now;
      _bendAxis.copy(lng.axis).cross(_ld);
      if (_bendAxis.lengthSq() < 1e-6) _bendAxis.set(0, 0, 1);
      _bendAxis.normalize();
      const preFracture = rec.deform.strain < spec.toughness ? 1 : 0.3;
      const angle = Math.min(0.18, impulse * 0.05) * preFracture;
      Deformer.bend(rec.geometry, _lp, _bendAxis, lng.axis, angle, rec.deform);
    }

    // Accumulate strain toward fracture (cast iron reaches it almost at once).
    // Rapier's raw contact impulses are gameplay-scale (order 0.1–5 N·s), far
    // below real MPa stresses, so normalise ultimate into a gameplay reference
    // impulse (≈1–10) rather than dividing by hundreds.
    const shearRef = spec.ultimate / GAMEPLAY_STRESS_DIVISOR;
    const strainInc = (impulse / shearRef) * STRAIN_K * 0.02;
    rec.deform.strain = Math.min(1, rec.deform.strain + strainInc);

    // Grinding sparks.
    if (this._impactBudget()) {
      bus.emit(EVENTS.IMPACT, { position: _wp.clone(), impulse, metal: rec.metal, relSpeed });
    }

    // Ready to shear? (strain past toughness, or a single huge bite past ultimate)
    const bigBite = impulse > 3.5;
    if ((rec.deform.strain >= spec.toughness || bigBite) && !rec._queuedSlice) {
      if (rec.volume <= MIN_VOLUME * 2) {
        rec.debris = true; // too small to keep subdividing
        return;
      }
      rec._queuedSlice = true;
      rec._sliceWorldPoint = _wp.clone();
      rec._sliceRelSpeed = relSpeed;
      this._sliceQueue.push(rec);
    }
  }

  _impactBudget() {
    const now = performance.now();
    if (now - this._impactWindowStart > 1000) {
      this._impactWindowStart = now;
      this._impactWindowCount = 0;
    }
    if (this._impactWindowCount >= 45) return false;
    this._impactWindowCount++;
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Slicing.
   * ---------------------------------------------------------------- */
  _performSlice(rec) {
    if (!this._record(rec.id)) return; // already gone
    const spec = METALS[rec.metal] || METALS.steel;
    const mesh = rec.mesh;
    mesh.updateMatrixWorld();

    // World-space shear plane from the rig, transformed into the mesh's local
    // frame for the slicer.
    const planeWorld = this.rig.getShearPlaneFor(rec._sliceWorldPoint);
    _mat.copy(mesh.matrixWorld).invert();
    _normalMat.getNormalMatrix(_mat);
    const planeLocal = planeWorld.clone().applyMatrix4(_mat, _normalMat);

    let result;
    try {
      result = sliceGeometry(rec.geometry, planeLocal, { jaggedness: 0.002 });
    } catch (err) {
      console.warn('[ShredderProcessor] slice failed', err);
      return;
    }
    if (!result.above || !result.below) return;

    // Inherit motion from the parent body.
    const st = this.physics.getBodyState(rec.id);
    const linvel = st ? st.linvel : [0, 0, 0];
    const angvel = st ? st.angvel : [0, 0, 0];

    // World-space plane normal for the separation kick.
    _n.copy(planeWorld.normal).normalize();
    const energy = Math.min(1, result.area * 60 + rec._sliceRelSpeed * 0.05);
    const sep = 0.12 + energy * 0.25;

    this._spawnPiece(result.above, mesh, rec.metal, spec, linvel, angvel, _n, sep);
    this._spawnPiece(result.below, mesh, rec.metal, spec, linvel, angvel, _n, -sep);

    // Free the parent.
    if (rec.isFragment) {
      this.fragments.delete(rec.id);
      this.physics.removeBody(rec.id);
      if (mesh.parent) mesh.parent.remove(mesh);
      rec.geometry.dispose();
    } else {
      this.feeder.removeItem(rec.id);
    }

    // Events (throttled).
    _worldCentroid.copy(rec._sliceWorldPoint);
    if (this._shearBudget()) {
      bus.emit(EVENTS.SHEAR, {
        position: _worldCentroid.clone(),
        normal: _n.clone(),
        energy,
        area: result.area,
        metal: rec.metal,
        velocity: Math.hypot(linvel[0], linvel[1], linvel[2])
      });
      if (energy > 0.5 || spec.density > 7000) {
        bus.emit(EVENTS.SHAKE, { strength: Math.min(1, energy * 0.8 + 0.15), duration: 0.18 });
      }
    }
  }

  /**
   * Build a physics body + mesh for one sliced piece, recentred on its own
   * centroid so it spins correctly.
   */
  _spawnPiece(geo, parentMesh, metal, spec, linvel, angvel, worldNormal, sepAlong) {
    const vc = computeVolumeAndCentroid(geo);
    _centroid.copy(vc.centroid);
    geo.translate(-_centroid.x, -_centroid.y, -_centroid.z);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    // World placement of the recentred piece.
    _worldCentroid.copy(_centroid);
    parentMesh.localToWorld(_worldCentroid);
    parentMesh.getWorldQuaternion(_q);

    const material = this.materials.get(metal);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(_worldCentroid);
    mesh.quaternion.copy(_q);
    this.scene.add(mesh);

    const isDebris = vc.volume < MIN_VOLUME;
    const points = convexHullPoints(geo);
    const id = this.physics.addBody({
      type: 'dynamic',
      shapes: [{ type: 'convexHull', points, density: spec.density, friction: 0.5, restitution: 0.12 }],
      position: [_worldCentroid.x, _worldCentroid.y, _worldCentroid.z],
      quaternion: [_q.x, _q.y, _q.z, _q.w],
      ccd: true,
      linearDamping: 0.04,
      angularDamping: 0.06,
      collisionGroups: isDebris ? FILTER.DEBRIS : FILTER.FRAGMENT,
      userData: { kind: 'fragment', metal }
    });
    this.physics.bind(id, mesh);

    // Inherit velocity + a small separation kick along the cut normal.
    this.physics.setLinearVelocity(id, [
      linvel[0] + worldNormal.x * sepAlong,
      linvel[1] + worldNormal.y * sepAlong,
      linvel[2] + worldNormal.z * sepAlong
    ]);
    this.physics.setAngularVelocity(id, angvel);

    const rec = {
      id,
      mesh,
      geometry: geo,
      metal,
      volume: vc.volume,
      isFragment: true,
      debris: isDebris,
      deform: Deformer.createState(geo),
      hot: true,
      retiring: false,
      born: performance.now()
    };
    this.fragments.set(id, rec);
    bus.emit(EVENTS.FRAGMENT_SPAWN, { id });
    return rec;
  }

  /* ---------------------------------------------------------------- *
   * Retirement / culling.
   * ---------------------------------------------------------------- */
  _retirePass(dt) {
    // Flag fragments that fell out the discharge or are stale + tiny.
    this.fragments.forEach((rec) => {
      if (rec.retiring) return;
      const st = this.physics.getBodyState(rec.id);
      if (st && st.position[1] < PHYSICS.dischargeY) {
        this._beginRetire(rec);
      }
    });

    // Cap total dynamic bodies: retire the oldest/smallest fragments first.
    const total = this.feeder.items.size + this.fragments.size;
    if (total > PHYSICS.maxBodies * 0.95) {
      let toCull = total - Math.floor(PHYSICS.maxBodies * 0.85);
      const candidates = [];
      this.fragments.forEach((rec) => {
        if (!rec.retiring) candidates.push(rec);
      });
      candidates.sort((a, b) => a.volume - b.volume || a.born - b.born);
      for (let i = 0; i < candidates.length && toCull > 0; i++, toCull--) {
        this._beginRetire(candidates[i]);
      }
    }

    // Advance fades.
    for (let i = this._retiring.length - 1; i >= 0; i--) {
      const rec = this._retiring[i];
      rec._fade -= dt;
      const s = Math.max(0, rec._fade / rec._fadeDur);
      rec.mesh.scale.setScalar(s);
      if (rec._fade <= 0) {
        this.fragments.delete(rec.id);
        this.physics.removeBody(rec.id);
        if (rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
        rec.geometry.dispose();
        this._retiring.splice(i, 1);
      }
    }
  }

  _beginRetire(rec) {
    rec.retiring = true;
    rec._fadeDur = 0.4;
    rec._fade = 0.4;
    this.physics.setEnabled(rec.id, false);
    this._retiring.push(rec);
  }

  /* ---------------------------------------------------------------- *
   * Heat cooling (only iterate geometries still flagged hot).
   * ---------------------------------------------------------------- */
  _coolPass(dt) {
    const coolOne = (rec) => {
      if (!rec.hot) return;
      const rate = COOL_RATE[rec.metal] || 0.9;
      const stillHot = coolGeometry(rec.geometry, dt, rate);
      if (!stillHot) rec.hot = false;
    };
    this.feeder.items.forEach(coolOne);
    this.fragments.forEach(coolOne);
  }

  _shearBudget() {
    const now = performance.now();
    if (now - this._shearWindowStart > 1000) {
      this._shearWindowStart = now;
      this._shearWindowCount = 0;
    }
    if (this._shearWindowCount >= MAX_SHEAR_EVENTS_PER_SEC) return false;
    this._shearWindowCount++;
    return true;
  }
}
