import * as THREE from 'three';
import { SHREDDER, FILTER, EVENTS } from '../core/Constants.js';
import { bus } from '../core/EventBus.js';
import { createScrap } from './ScrapLibrary.js';
import { Deformer } from '../destruction/Deformer.js';
import { computeVolumeAndCentroid } from '../destruction/MeshSlicer.js';

/**
 * Conveyor feeder + drop zone.
 *
 * A belt deck carries feed stock towards the hopper mouth. The belt surface is
 * a scrolling texture whose UV offset tracks the real belt speed, and any
 * dynamic body resting on the deck is nudged forward at that speed so items
 * ride the belt into the throat. Items can also be dropped directly via
 * {@link spawnAt} (click-to-drop) or {@link spawn}.
 *
 * Spawned scrap is tracked in {@link items} (id -> record) which the
 * {@link ShredderProcessor} reads and mutates when a part shears.
 *
 * @module Feeder
 */

const _v = new THREE.Vector3();

export class Feeder {
  constructor({ scene, physics, materials, rig }) {
    this.scene = scene;
    this.physics = physics;
    this.materials = materials;
    this.rig = rig;

    this.conveyorSpeed = 0.5; // 0..1
    this.autoFeed = false;
    this._autoTimer = 0;
    this._autoInterval = 1.4;

    /** @type {Map<number, object>} live scrap records. */
    this.items = new Map();

    const C = SHREDDER.conveyor;
    this._beltTopY = C.height;
    this._dropX = -0.02; // belt discharge edge, right over the throat
    this._centerX = this._dropX - C.length / 2;
    this._minX = this._centerX - C.length / 2;
    this._halfW = C.width / 2;

    this.group = new THREE.Group();
    this.group.name = 'Feeder';
    this._beltTexture = null;
  }

  /** @returns {Promise<Feeder>} */
  async build() {
    this.scene.add(this.group);
    this._buildDeck();
    return this;
  }

  _buildDeck() {
    const C = SHREDDER.conveyor;

    // Scrolling belt surface.
    const tex = this._makeBeltTexture();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(C.length / 0.14, C.width / 0.14);
    this._beltTexture = tex;
    const beltMat = new THREE.MeshStandardMaterial({ map: tex, color: 0x1b1c1f, roughness: 0.85, metalness: 0.05 });

    const belt = new THREE.Mesh(new THREE.BoxGeometry(C.length, 0.04, C.width), beltMat);
    belt.position.set(this._centerX, this._beltTopY - 0.02, 0);
    belt.receiveShadow = true;
    this.group.add(belt);

    // Belt collider (fixed): items ride on top of this.
    this.physics.addBody({
      type: 'fixed',
      shapes: [{ type: 'box', hx: C.length / 2, hy: 0.02, hz: C.width / 2, friction: 0.7, restitution: 0.02 }],
      position: [this._centerX, this._beltTopY - 0.02, 0],
      quaternion: [0, 0, 0, 1],
      collisionGroups: FILTER.WORLD,
      userData: { kind: 'belt' }
    });

    // Side rails + support frame.
    const railMat = this.materials.get('steel');
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(C.length, 0.05, 0.03), railMat);
      rail.position.set(this._centerX, this._beltTopY + 0.005, sz * (this._halfW + 0.02));
      rail.castShadow = true;
      this.group.add(rail);
      this.physics.addBody({
        type: 'fixed',
        shapes: [{ type: 'box', hx: C.length / 2, hy: 0.025, hz: 0.015, friction: 0.5, restitution: 0.05 }],
        position: [this._centerX, this._beltTopY + 0.005, sz * (this._halfW + 0.02)],
        quaternion: [0, 0, 0, 1],
        collisionGroups: FILTER.WORLD,
        userData: { kind: 'world' }
      });
    }
    // Legs (visual only).
    const legMat = this.materials.get('steel');
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, this._beltTopY, 0.05), legMat);
      leg.position.set(this._centerX + sx * (C.length / 2 - 0.15), this._beltTopY / 2, 0);
      leg.castShadow = true;
      this.group.add(leg);
    }
  }

  _makeBeltTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#202226';
    ctx.fillRect(0, 0, size, size);
    // Cross cleats.
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 4, size, 8);
    ctx.fillStyle = '#303338';
    ctx.fillRect(0, 12, size, 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    return tex;
  }

  /* ---------------------------------------------------------------- *
   * Spawning.
   * ---------------------------------------------------------------- */

  /**
   * Drop a scrap item at the head of the belt.
   * @param {string} [typeId] scrap id; random if omitted
   * @returns {number|null} the new body id
   */
  spawn(typeId) {
    const z = (Math.random() - 0.5) * this._halfW;
    return this.spawnAt(_v.set(this._minX + 0.28, this._beltTopY + 0.09, z), typeId);
  }

  /**
   * Drop a scrap item at a specific world position (click-to-drop).
   * @param {THREE.Vector3} worldPosition
   * @param {string} [typeId]
   * @returns {number|null}
   */
  spawnAt(worldPosition, typeId) {
    const built = createScrap(typeId, this.materials);
    const { geometry, shapes, mesh, type } = built;
    mesh.position.copy(worldPosition);
    mesh.quaternion.setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.6, Math.random() * Math.PI, (Math.random() - 0.5) * 0.6));
    this.scene.add(mesh);

    const id = this.physics.addBody({
      type: 'dynamic',
      shapes,
      position: [worldPosition.x, worldPosition.y, worldPosition.z],
      quaternion: [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
      ccd: true,
      linearDamping: 0.05,
      angularDamping: 0.08,
      collisionGroups: FILTER.SCRAP,
      userData: { kind: 'scrap', metal: type.metal }
    });
    this.physics.bind(id, mesh);

    const vc = computeVolumeAndCentroid(geometry);
    const record = {
      id,
      mesh,
      geometry,
      metal: type.metal,
      type,
      deform: Deformer.createState(geometry),
      volume: vc.volume,
      isFragment: false,
      born: performance.now()
    };
    this.items.set(id, record);

    bus.emit(EVENTS.SCRAP_SPAWN, { metal: type.metal, name: type.label });
    return id;
  }

  /** Remove a scrap record + its body + mesh (used by the processor on shear). */
  removeItem(id) {
    const rec = this.items.get(id);
    if (!rec) return;
    this.items.delete(id);
    this.physics.removeBody(id);
    if (rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
    rec.geometry.dispose();
  }

  /** Remove every live feed item. */
  clearAll() {
    for (const id of Array.from(this.items.keys())) this.removeItem(id);
  }

  /** @param {number} v 0..1 */
  setConveyorSpeed(v) {
    this.conveyorSpeed = Math.max(0, Math.min(1, v));
  }

  /** @param {boolean} v */
  setAutoFeed(v) {
    this.autoFeed = !!v;
  }

  /**
   * Advance the belt: scroll the texture and nudge on-belt bodies forward.
   * @param {number} dt
   */
  update(dt) {
    const speed = this.conveyorSpeed * SHREDDER.conveyor.maxSpeed;

    if (this._beltTexture) {
      this._beltTexture.offset.x -= (speed * dt) / 0.14;
    }

    // Carry bodies that are resting on the belt.
    if (speed > 1e-4) {
      this.items.forEach((rec) => {
        const st = this.physics.getBodyState(rec.id);
        if (!st) return;
        const [x, y, z] = st.position;
        if (x > this._minX && x < this._dropX && Math.abs(z) < this._halfW + 0.05 && Math.abs(y - this._beltTopY) < 0.14) {
          this.physics.setLinearVelocity(rec.id, [speed, st.linvel[1], st.linvel[2] * 0.5]);
        }
      });
    }

    // Auto feed.
    if (this.autoFeed) {
      this._autoTimer += dt;
      if (this._autoTimer >= this._autoInterval && this.items.size < 40) {
        this._autoTimer = 0;
        this.spawn();
      }
    }
  }
}
