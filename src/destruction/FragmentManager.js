import * as THREE from 'three';
import { LAYOUT, SETTINGS } from '../config.js';
import { sliceGeometry, computeVolume, recenter, hullPoints } from './MeshSlicer.js';
import { plasticDent, plasticBend } from './Deformer.js';
import { getMetalMaterial, getMaterialSpec } from '../materials/MetalMaterial.js';
import { ensureHeatAttributes, stampHeat } from '../materials/HeatShader.js';
import { getScrapDef } from '../objects/ScrapLibrary.js';

const _wp = new THREE.Vector3();
const _wn = new THREE.Vector3();
const _ln = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _c = new THREE.Vector3();
const _box = new THREE.Box3();
const _mat3 = new THREE.Matrix3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();

const WORLD_X = new THREE.Vector3(1, 0, 0);

/**
 * FragmentManager — owns every piece of scrap in the world and decides, from
 * accumulated contact impulse, whether a piece should dent, bend or shear.
 */
export class FragmentManager {
  constructor(scene, physics, shredder, hooks = {}) {
    this.scene = scene;
    this.physics = physics;
    this.shredder = shredder;
    this.hooks = hooks;
    this.quality = 'high';

    this.group = new THREE.Group();
    this.group.name = 'Scrap';
    scene.add(this.group);

    /** @type {Map<number, object>} */
    this.entries = new Map();
    this.sliceQueue = [];
    this.time = 0;
    /** Normalised rotor speed (0..1), fed from the physics snapshot. */
    this.rpmNorm = 0;
    this.stats = { fragments: 0, slices: 0, triangles: 0 };

    // per-frame contact aggregation
    this._agg = new Map();
  }

  setQuality(q) { this.quality = q; }

  /* ------------------------------------------------------------- spawning */

  spawn(typeId, position, velocity) {
    if (this.entries.size >= SETTINGS.maxScrapBodies) this._cullOldest(8);

    const def = getScrapDef(typeId);
    const built = def.build();
    const geometry = built.geometry.clone();
    built.geometry.dispose();

    ensureHeatAttributes(geometry, 0, -1000);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = getMetalMaterial(def.material, this.quality);
    const spec = getMaterialSpec(def.material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.position.copy(position);
    mesh.quaternion.setFromEuler(new THREE.Euler(
      Math.random() * 0.6 - 0.3,
      Math.random() * Math.PI * 2,
      Math.random() * 0.6 - 0.3
    ));
    mesh.updateMatrix();
    this.group.add(mesh);

    const volume = Math.max(computeVolume(geometry), 1e-6);
    const density = def.mass / volume;

    const id = this.physics.addBody(mesh, built.colliders, {
      density,
      friction: 0.66,
      restitution: 0.06,
      ccd: def.thickness < 0.003,
      linvel: velocity ? [velocity.x, velocity.y, velocity.z] : undefined,
      angvel: [(Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2],
    });

    const entry = {
      id, mesh, def, spec, density,
      material: def.material,
      mass: def.mass,
      damage: 0,
      work: 0,
      generation: 0,
      birth: this.time,
      lastDeform: -1,
      lastSlice: -1,
      volume,
      thickness: def.thickness,
      pendingSlice: false,
    };
    this.entries.set(id, entry);
    this._refreshStats();
    return entry;
  }

  /* -------------------------------------------------------------- contacts */

  /**
   * @param {Float32Array} view flat contact records from the physics worker
   */
  handleContacts(view, count, stride, dt) {
    this._agg.clear();

    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const id = view[o];
      const entry = this.entries.get(id);
      if (!entry) continue;

      const force = view[o + 8];
      const isCutter = view[o + 10] > 0.5;

      let rec = this._agg.get(id);
      if (!rec) {
        rec = { entry, force: 0, cutterForce: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, planeX: 0, speed: 0, samples: 0 };
        this._agg.set(id, rec);
      }
      rec.samples++;
      rec.force += force;
      if (isCutter) {
        rec.cutterForce += force;
        if (force > rec.peakCutter || rec.peakCutter === undefined) {
          rec.peakCutter = force;
          rec.px = view[o + 2]; rec.py = view[o + 3]; rec.pz = view[o + 4];
          rec.nx = view[o + 5]; rec.ny = view[o + 6]; rec.nz = view[o + 7];
          rec.planeX = view[o + 11];
        }
      } else if (rec.cutterForce === 0 && force > (rec.peakWorld || 0)) {
        rec.peakWorld = force;
        rec.px = view[o + 2]; rec.py = view[o + 3]; rec.pz = view[o + 4];
        rec.nx = view[o + 5]; rec.ny = view[o + 6]; rec.nz = view[o + 7];
      }
      rec.speed = Math.max(rec.speed, view[o + 9]);
    }

    for (const rec of this._agg.values()) {
      if (rec.cutterForce > 0) this._processCut(rec, dt);
      else this._processImpact(rec, dt);
    }
  }

  _processImpact(rec, dt) {
    const { entry } = rec;
    const intensity = Math.min(1, rec.force / 5200);
    if (intensity < 0.06) return;
    _wp.set(rec.px, rec.py, rec.pz);
    this.hooks.onImpact?.(_wp, intensity, entry.spec.hardness, entry.material);
    if (intensity > 0.4 && entry.spec.sparkYield > 0.5) {
      _wn.set(rec.nx, rec.ny, rec.nz).normalize();
      this.hooks.onSpark?.(_wp, _wn, intensity * 0.35 * entry.spec.sparkYield, entry.spec);
    }
    // A hard landing works the metal a little, but nowhere near as much as
    // sustained shearing.
    entry.damage += Math.min(0.05, intensity * 0.06);
    if (intensity > 0.5) this._maybeDeform(entry, rec, dt, 0.5);
  }

  /**
   * Cut progress model.
   *
   * `entry.damage` is normalised 0..1, where 1 means sheared through, and it
   * accrues mainly from ENGAGEMENT TIME rather than contact force.
   *
   * Force alone cannot work across this mass range: a 16 g drinks can
   * physically cannot press hard enough to build kilonewton-seconds, so it
   * would never shear, while a 62 kg engine block would shear instantly under
   * its own weight. What actually decides the outcome in a real shredder is
   * how long a tooth stays buried in the stock, scaled by section thickness
   * and the material's shear strength - which is exactly what this models.
   */
  _processCut(rec, dt) {
    const { entry } = rec;
    const spec = entry.spec;
    const resist = this._resistance(entry);

    _wp.set(rec.px, rec.py, rec.pz);
    _wn.set(rec.nx, rec.ny, rec.nz);
    if (_wn.lengthSq() < 1e-8) _wn.set(0, -1, 0); else _wn.normalize();

    // Teeth sweeping through the stock: the dominant term.
    const geometric = dt * Math.max(0.12, this.rpmNorm) * 1.35;
    // Bonus when the machine is really biting, so heavy jams still progress.
    const forced = (rec.cutterForce * dt) / (2600 * resist);
    entry.damage += geometric / resist + forced;
    entry.work += rec.cutterForce * dt;

    const grind = Math.min(1, 0.25 + rec.cutterForce / 9000);

    // Grinding heat + sparks scale with contact force and material hardness.
    if (grind > 0.02) {
      this.hooks.onGrind?.(_wp, grind, spec);
      const sparkAmount = grind * spec.sparkYield;
      if (sparkAmount > 0.03) {
        this.hooks.onSpark?.(_wp, _wn, sparkAmount, spec);
      }
      if (grind > 0.12) this.hooks.onDust?.(_wp, grind * 0.5, spec);

      if (this.time - (entry.lastHeat || 0) > 0.05) {
        entry.lastHeat = this.time;
        // Tight, low-amplitude: only the metal actually in the shear zone
        // gets hot. Stamping a wide radius turns whole panels incandescent.
        stampHeat(entry.mesh, _wp, 0.012 + grind * 0.020, Math.min(0.5, grind * 0.85), this.time);
      }
    }

    if (entry.damage >= 1 && !entry.pendingSlice) {
      entry.pendingSlice = true;
      this.sliceQueue.push({ entry, point: _wp.clone(), normal: _wn.clone(), force: rec.cutterForce });
    } else if (entry.damage > 0.18) {
      this._maybeDeform(entry, rec, dt, grind);
    }
  }

  _maybeDeform(entry, rec, dt, grind) {
    if (this.time - entry.lastDeform < 0.06) return;
    entry.lastDeform = this.time;

    const spec = entry.spec;
    const mesh = entry.mesh;
    mesh.updateMatrixWorld();

    _lp.set(rec.px, rec.py, rec.pz);
    mesh.worldToLocal(_lp);

    _ln.set(rec.nx, rec.ny, rec.nz);
    if (_ln.lengthSq() < 1e-8) _ln.set(0, -1, 0); else _ln.normalize();
    _mat3.setFromMatrix4(mesh.matrixWorld).invert().transpose();
    // world normal -> local direction (rotation only)
    _ln.applyQuaternion(_q.copy(mesh.quaternion).invert()).normalize();

    mesh.geometry.computeBoundingSphere();
    const size = mesh.geometry.boundingSphere?.radius || 0.1;

    const severity = Math.min(1, grind * 1.4);
    const depth = Math.min(size * 0.28, 0.0016 + severity * spec.ductility * 0.02);
    const radius = Math.min(size * 0.85, 0.045 + severity * 0.05);

    plasticDent(mesh.geometry, _lp, _ln, radius, depth, {
      lip: 0.28 + spec.ductility * 0.3,
      wrinkle: 0.18 + spec.ductility * 0.35,
      ductility: spec.ductility,
    });

    // Long, ductile stock folds around the throat instead of only denting.
    if (spec.ductility > 0.45 && size > 0.18 && Math.random() < 0.35) {
      mesh.geometry.computeBoundingBox();
      _box.copy(mesh.geometry.boundingBox);
      _box.getSize(_v3);
      const longest = _v3.x > _v3.y && _v3.x > _v3.z ? new THREE.Vector3(1, 0, 0)
        : _v3.y > _v3.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const axis = new THREE.Vector3().crossVectors(longest, _ln);
      if (axis.lengthSq() > 1e-6) {
        axis.normalize();
        const dir = longest.clone().multiplyScalar(_lp.dot(longest) >= 0 ? 1 : -1);
        plasticBend(mesh.geometry, _lp, axis, dir,
          severity * spec.ductility * 0.32 * (Math.random() < 0.5 ? -1 : 1),
          Math.max(0.08, _v3.length() * 0.5));
      }
    }

    this.hooks.onDeform?.(entry, severity);
  }

  /* ---------------------------------------------------------------- slicing */

  processSliceQueue() {
    let budget = SETTINGS.maxSlicesPerFrame;
    while (this.sliceQueue.length && budget-- > 0) {
      const job = this.sliceQueue.shift();
      if (!this.entries.has(job.entry.id)) continue;
      this._executeSlice(job);
    }
    // Anything left waiting more than a moment is stale; drop it.
    if (this.sliceQueue.length > 24) this.sliceQueue.length = 24;
  }

  _choosePlane(entry, contactPoint, out) {
    const mesh = entry.mesh;
    mesh.updateMatrixWorld();
    mesh.geometry.computeBoundingBox();
    _box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    _box.getSize(_v3);
    _box.getCenter(_c);

    const pitch = this.shredder.stripPitch ?? LAYOUT.cutterPitch;

    // A ribbon wider than one disc pitch gets sheared between the discs —
    // this is what produces the characteristic shredder strips.
    if (_v3.x > pitch * 1.25) {
      let best = 0, bestD = Infinity;
      for (const px of this.shredder.shearPlanes) {
        const d = Math.abs(px - contactPoint.x);
        if (d < bestD && px > _box.min.x + pitch * 0.35 && px < _box.max.x - pitch * 0.35) {
          bestD = d; best = px;
        }
      }
      if (bestD < Infinity) {
        out.normal.copy(WORLD_X);
        out.point.set(best, contactPoint.y, contactPoint.z);
        out.kind = 'strip';
        return true;
      }
    }

    // Otherwise chop the piece across its longest remaining axis.
    const axes = [
      [_v3.x, new THREE.Vector3(1, 0, 0), _box.min.x, _box.max.x, contactPoint.x],
      [_v3.y, new THREE.Vector3(0, 1, 0), _box.min.y, _box.max.y, contactPoint.y],
      [_v3.z, new THREE.Vector3(0, 0, 1), _box.min.z, _box.max.z, contactPoint.z],
    ];
    axes.sort((a, b) => b[0] - a[0]);
    const [len, axis, mn, mx, cp] = axes[0];
    if (len < 0.02) return false;

    // Keep the cut away from the extremes so neither half is a sliver.
    const lo = mn + len * 0.24;
    const hi = mx - len * 0.24;
    const at = THREE.MathUtils.clamp(cp, lo, hi);

    out.normal.copy(axis);
    // Teeth do not cut square: tilt the shear plane a little.
    out.normal.x += (Math.random() - 0.5) * 0.34;
    out.normal.y += (Math.random() - 0.5) * 0.34;
    out.normal.z += (Math.random() - 0.5) * 0.34;
    out.normal.normalize();
    out.point.copy(_c);
    out.point[axis.x ? 'x' : axis.y ? 'y' : 'z'] = at;
    out.kind = 'chop';
    return true;
  }

  _executeSlice(job) {
    const entry = job.entry;
    const mesh = entry.mesh;
    entry.pendingSlice = false;

    const plane = { normal: new THREE.Vector3(), point: new THREE.Vector3(), kind: '' };
    if (!this._choosePlane(entry, job.point, plane)) {
      entry.damage = 0.6;
      return;
    }

    // World plane -> local plane: n_local = R^-1 n ; c = n·T - n·P
    mesh.updateMatrixWorld();
    _ln.copy(plane.normal).applyQuaternion(_q.copy(mesh.quaternion).invert()).normalize();
    const nDotT = plane.normal.dot(mesh.position);
    const nDotP = plane.normal.dot(plane.point);
    const constant = nDotT - nDotP;

    const spec = entry.spec;
    const tear = THREE.MathUtils.clamp(
      0.0016 + spec.ductility * 0.006 + entry.thickness * 0.6, 0.0012, 0.011
    );

    let result;
    try {
      result = sliceGeometry(mesh.geometry, _ln, constant, {
        tear,
        heat: THREE.MathUtils.clamp(0.55 + (job.force / 22000) * 0.6, 0.35, 1.0) * (0.5 + spec.hardness * 0.6),
        time: this.time,
        uvScale: 2.2,
      });
    } catch (e) {
      entry.damage = 0.6;
      return;
    }

    if (!result.front || !result.back) {
      // Grazing cut — leave it worked but intact, and back the damage off so
      // it does not retrigger every frame.
      entry.damage = 0.45;
      result.front?.dispose();
      result.back?.dispose();
      return;
    }

    const parentVel = this.physics.getEntry(entry.id)?.vel;
    const worldNormal = plane.normal;

    const kick = 0.22 + Math.min(1.4, job.force / 16000);
    const a = this._emitFragment(result.front, entry, worldNormal, +kick, parentVel);
    const b = this._emitFragment(result.back, entry, worldNormal, -kick, parentVel);

    this.hooks.onTear?.(job.point, Math.min(1, job.force / 14000), spec, plane.kind);
    this.hooks.onSpark?.(job.point, worldNormal, Math.min(1, 0.5 + job.force / 9000) * spec.sparkYield, spec, true);

    this._destroy(entry);
    this.stats.slices++;

    if (!a && !b) {
      // Both halves were dust.
      this.hooks.onShrapnel?.(job.point, 14, spec);
    }
    this._refreshStats();
  }

  _emitFragment(geometry, parent, worldNormal, kick, parentVel) {
    const volume = computeVolume(geometry);

    // Stop endless subdivision: deep-generation offcuts become shrapnel and
    // dust rather than yet another rigid body.
    const tooDeep = parent.generation >= 4;

    if (tooDeep || volume < SETTINGS.minFragmentVolume || geometry.attributes.position.count < 12) {
      // Too small (or too far down the chain) to be worth a rigid body.
      recenter(geometry, _c);
      parent.mesh.localToWorld(_c);
      this.hooks.onShrapnel?.(_c, 5 + Math.round(volume * 4e5), parent.spec);
      geometry.dispose();
      return null;
    }

    if (this.entries.size >= SETTINGS.maxFragments) this._cullOldest(6);

    recenter(geometry, _c);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, parent.mesh.material);
    const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 1;
    mesh.castShadow = radius >= SETTINGS.shadowCasterMinRadius;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.quaternion.copy(parent.mesh.quaternion);
    _wp.copy(_c).applyQuaternion(parent.mesh.quaternion).add(parent.mesh.position);
    mesh.position.copy(_wp);
    mesh.updateMatrix();
    this.group.add(mesh);

    const pts = hullPoints(geometry);
    if (pts.length < 12) {
      this.group.remove(mesh);
      geometry.dispose();
      return null;
    }

    const vx = (parentVel ? parentVel.x : 0) + worldNormal.x * kick;
    const vy = (parentVel ? parentVel.y : 0) + worldNormal.y * kick + 0.12;
    const vz = (parentVel ? parentVel.z : 0) + worldNormal.z * kick;

    const id = this.physics.addBody(mesh, [{ type: 'hull', points: pts }], {
      density: parent.density,
      friction: 0.7,
      restitution: 0.1,
      ccd: true,
      linvel: [vx, vy, vz],
      angvel: [(Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6],
    });

    const entry = {
      id, mesh,
      def: parent.def,
      spec: parent.spec,
      material: parent.material,
      density: parent.density,
      mass: volume * parent.density,
      damage: 0,
      work: parent.work * 0.35,
      generation: parent.generation + 1,
      birth: this.time,
      lastDeform: -1,
      lastSlice: this.time,
      volume,
      thickness: parent.thickness * 0.92,
      pendingSlice: false,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /* -------------------------------------------------------------- lifecycle */

  _destroy(entry) {
    this.group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    this.entries.delete(entry.id);
    this.physics.removeBody(entry.id);
  }

  onPhysicsRemoved(ids) {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      this.entries.delete(id);
    }
    this._refreshStats();
  }

  /** Retire the oldest debris that has come to rest away from the throat. */
  _cullOldest(n) {
    const candidates = [];
    for (const e of this.entries.values()) {
      const p = e.mesh.position;
      const inThroat = this.shredder.throatBox.containsPoint(p) || p.y > LAYOUT.chute.topY;
      if (inThroat) continue;
      candidates.push(e);
    }
    candidates.sort((a, b) => (a.birth - b.birth) || (a.volume - b.volume));
    const ids = [];
    for (let i = 0; i < Math.min(n, candidates.length); i++) {
      const e = candidates[i];
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      this.entries.delete(e.id);
      ids.push(e.id);
    }
    if (ids.length) this.physics.removeBodies(ids);
  }

  clear() {
    for (const e of this.entries.values()) {
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
    }
    this.entries.clear();
    this.sliceQueue.length = 0;
    this.physics.clearDynamic();
    this._refreshStats();
  }

  /**
   * Resistance of a piece to being sheared through: section thickness times
   * material toughness. Shared by the contact and proximity paths.
   */
  _resistance(entry) {
    const thickness = 1 + entry.thickness * 90;
    const toughness = Math.max(0.25, entry.spec.shearImpulse / 1200);
    return thickness * toughness;
  }

  /**
   * Throat engagement.
   *
   * Long or bulky stock lands across the tooth tips like a bar on a bed of
   * nails: dozens of light contacts, none of which individually clears the
   * solver's contact-force reporting threshold, so a purely contact-driven
   * model sees nothing and the piece sits there forever. If a body is inside
   * the throat while the rotors are turning, it *is* being cut - so accrue
   * progress from occupancy directly.
   */
  _engageThroat(dt) {
    if (this.rpmNorm <= 0.05) return;
    const box = this.shredder.throatBox;

    for (const entry of this.entries.values()) {
      if (entry.pendingSlice) continue;
      const geo = entry.mesh.geometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const bs = geo.boundingSphere;
      if (!bs) continue;

      const p = entry.mesh.position;
      if (box.distanceToPoint(p) > bs.radius) continue;

      const resist = this._resistance(entry);
      // Deliberately slower than a well-reported contact: this path exists so
      // nothing can sit in the throat untouched, not to do the cutting.
      entry.damage += (dt * this.rpmNorm * 0.55) / resist;

      if (this.time - (entry.lastAmbient || 0) > 0.09) {
        entry.lastAmbient = this.time;
        _wp.copy(p);
        _wp.y = Math.min(_wp.y, LAYOUT.shaftY + LAYOUT.cutterRadius * 0.6);
        box.clampPoint(_wp, _wp);
        const g = 0.25 + 0.45 * this.rpmNorm;
        this.hooks.onGrind?.(_wp, g, entry.spec);
        if (entry.spec.sparkYield > 0.2) {
          _wn.set((Math.random() - 0.5), 0.6, (Math.random() - 0.5)).normalize();
          this.hooks.onSpark?.(_wp, _wn, g * 0.5, entry.spec);
        }
        stampHeat(entry.mesh, _wp, 0.02, 0.35, this.time);
      }

      // Metal bends before it lets go: work the section as damage builds.
      if (entry.damage > 0.18 && entry.damage < 1) {
        this._maybeDeform(entry, {
          px: _wp.x, py: _wp.y, pz: _wp.z,
          nx: 0, ny: -1, nz: 0,
        }, dt, 0.35 + entry.damage * 0.5);
      }

      if (entry.damage >= 1) {
        entry.pendingSlice = true;
        this.sliceQueue.push({
          entry,
          point: _wp.copy(p).clamp(box.min, box.max).clone(),
          normal: new THREE.Vector3(0, -1, 0),
          force: 4000,
        });
      }
    }
  }

  update(dt, time) {
    this.time = time;
    this._engageThroat(dt);
    this.processSliceQueue();

    // Cut progress bleeds off slowly so stock that escapes the teeth heals its
    // "fatigue", but stays worked long enough to finish a cut it has started.
    const decay = Math.exp(-dt * 0.28);
    for (const e of this.entries.values()) {
      e.damage *= decay;
      e.mesh.matrixWorldNeedsUpdate = true;
    }

    if (this.entries.size > SETTINGS.maxFragments) {
      this._cullOldest(this.entries.size - SETTINGS.maxFragments);
    }
  }

  _refreshStats() {
    this.stats.fragments = this.entries.size;
    let tris = 0;
    for (const e of this.entries.values()) {
      tris += e.mesh.geometry.attributes.position.count / 3;
    }
    this.stats.triangles = tris | 0;
  }
}
