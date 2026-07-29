import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SHREDDER, FILTER, EVENTS, LAYER } from '../core/Constants.js';
import { bus } from '../core/EventBus.js';
import { ensureHeatAttribute } from '../materials/HeatAttribute.js';

/**
 * Twin-shaft, low-speed / high-torque shear shredder.
 *
 * Two counter-rotating shafts run along Z at `±shaftSpacing/2`, each carrying
 * `discCount` cutter discs with hooked teeth. The two shafts' discs interleave
 * (the left shaft's discs sit in the right shaft's gaps) so material is sheared
 * into strips and dragged down into the throat.
 *
 * Each shaft is a single merged visual mesh (draw-call efficient) plus a
 * kinematic-velocity physics body whose compound collider is one convex hull
 * per tooth and one cylinder per disc. A torque-limited motor model makes the
 * RPM sag under load and drives an auto anti-jam reverse.
 *
 * @module ShredderRig
 */

const _plane = new THREE.Plane();
const _pt = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _yUp = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Rotation that maps a Y-axis cylinder onto the Z shaft axis. */
const CYL_TO_Z = new THREE.Quaternion().setFromUnitVectors(_yUp, _zAxis);

export class ShredderRig {
  constructor({ scene, physics, materials }) {
    this.scene = scene;
    this.physics = physics;
    this.materials = materials;

    // Public motor state.
    this.power = false;
    this.throttle = 1;
    this.reverse = false;
    this.load = 0;
    this.rpm = 0;
    this.stalled = false;

    this.toothMeshes = [];
    this.rotors = []; // { mesh, bodyId, dir, angle }

    // Motor internals.
    this._omega = 0; // current shaft angular speed magnitude (rad/s)
    this._pendingLoad = 0; // impulse sum reported by the processor this frame
    this._stallTimer = 0;
    this._reverseBurst = 0;

    this.group = new THREE.Group();
    this.group.name = 'ShredderRig';

    // Derived geometry.
    this._pitch = SHREDDER.discThickness + SHREDDER.discGap;
    this._toothLOD = SHREDDER.teethPerDisc;
  }

  /** Build all rotor + static machine geometry. @returns {Promise<ShredderRig>} */
  async build() {
    this.scene.add(this.group);
    this._buildRotor(-1); // left shaft
    this._buildRotor(1); // right shaft
    this._buildStaticShell();
    return this;
  }

  /* ---------------------------------------------------------------- *
   * Rotor construction.
   * ---------------------------------------------------------------- */
  _buildRotor(side) {
    const S = SHREDDER;
    const shaftX = (side * S.shaftSpacing) / 2;
    const shaftY = S.shaftHeight;
    // Interleave: the right shaft (+1) is phase-shifted by half a pitch.
    const phase = side > 0 ? this._pitch * 0.5 : 0;
    const zStart = -((S.discCount - 1) * this._pitch) / 2 + phase;

    const teethMat = this.materials.get('hardened');
    const visualParts = [];
    const shapes = [];

    for (let d = 0; d < S.discCount; d++) {
      const z = zStart + d * this._pitch;

      // Disc body (visual) — a Z-axis cylinder.
      const disc = new THREE.CylinderGeometry(S.discRadius, S.discRadius, S.discThickness, 28, 1);
      disc.rotateX(Math.PI / 2); // Y-axis -> Z-axis
      disc.translate(0, 0, z);
      visualParts.push(disc.toNonIndexed());

      // Disc collider (cylinder about Z).
      shapes.push({
        type: 'cylinder',
        halfHeight: S.discThickness / 2,
        radius: S.discRadius * 0.98,
        position: [0, 0, z],
        quaternion: [CYL_TO_Z.x, CYL_TO_Z.y, CYL_TO_Z.z, CYL_TO_Z.w],
        friction: 0.85,
        restitution: 0.03
      });

      // Teeth around the disc.
      const teeth = this._toothLOD;
      for (let t = 0; t < teeth; t++) {
        const angle = (t / teeth) * Math.PI * 2 + d * 0.4; // stagger per disc
        const toothGeo = this._buildToothGeometry();
        toothGeo.rotateZ(angle);
        toothGeo.translate(0, 0, z);
        visualParts.push(toothGeo);

        // Convex-hull collider from the same geometry's points.
        const pos = toothGeo.getAttribute('position');
        const pts = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          pts[i * 3] = pos.getX(i);
          pts[i * 3 + 1] = pos.getY(i);
          pts[i * 3 + 2] = pos.getZ(i);
        }
        shapes.push({ type: 'convexHull', points: pts, friction: 0.95, restitution: 0.02 });
      }
    }

    let merged = mergeGeometries(visualParts, false);
    if (!merged) merged = visualParts[0];
    merged.computeVertexNormals();
    ensureHeatAttribute(merged);
    for (const g of visualParts) g.dispose();

    const mesh = new THREE.Mesh(merged, teethMat);
    mesh.name = side < 0 ? 'RotorLeft' : 'RotorRight';
    mesh.position.set(shaftX, shaftY, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(LAYER.DEFAULT);
    this.group.add(mesh);
    this.toothMeshes.push(mesh);

    const bodyId = this.physics.addBody({
      type: 'kinematicVelocity',
      shapes,
      position: [shaftX, shaftY, 0],
      quaternion: [0, 0, 0, 1],
      collisionGroups: FILTER.TEETH,
      userData: { kind: 'tooth', metal: 'hardened', side }
    });

    this.rotors.push({ mesh, bodyId, dir: side < 0 ? -1 : 1, angle: 0 });
  }

  /**
   * A single hooked cutter tooth as an extruded claw profile (radial = X,
   * tangential = Y, extruded along Z by the disc thickness and centred).
   * @returns {THREE.BufferGeometry}
   */
  _buildToothGeometry() {
    const S = SHREDDER;
    const rBase = S.discRadius - 0.012;
    const rTip = S.discRadius + S.toothHeight;
    const w = 0.022;

    const shape = new THREE.Shape();
    shape.moveTo(rBase, -w);
    shape.lineTo(rTip - 0.012, -w * 0.55);
    shape.lineTo(rTip, 0.004); // sharp tip
    shape.lineTo(rTip - 0.016, w * 1.25); // hook overhang (the grabbing claw)
    shape.lineTo(rBase + 0.02, w * 0.9);
    shape.lineTo(rBase, w);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: S.discThickness,
      bevelEnabled: true,
      bevelThickness: 0.004,
      bevelSize: 0.004,
      bevelSegments: 1,
      steps: 1
    });
    geo.translate(0, 0, -S.discThickness / 2);
    return geo;
  }

  /* ---------------------------------------------------------------- *
   * Static factory geometry: hopper, side plates, chamber shell, chute.
   * ---------------------------------------------------------------- */
  _buildStaticShell() {
    const S = SHREDDER;
    const steel = this.materials.get('steel');
    const halfDepth = S.chamberDepth / 2 + 0.02;
    const throatHalfX = S.shaftSpacing / 2 + S.discRadius + S.toothHeight + 0.03;

    // Hopper walls funnel from the wide mouth down towards the throat.
    const wallLen = Math.hypot(S.hopperTop - S.shaftHeight, S.hopperWidth / 2 - throatHalfX);
    const tilt = Math.atan2(S.hopperWidth / 2 - throatHalfX, S.hopperTop - S.shaftHeight);
    const midY = (S.hopperTop + S.shaftHeight) / 2 + 0.02;
    const midX = (S.hopperWidth / 2 + throatHalfX) / 2;

    // +X and -X sloped hopper walls.
    for (const sx of [-1, 1]) {
      this._addStaticBox(
        [0.02, wallLen, S.chamberDepth],
        [sx * midX, midY, 0],
        new THREE.Quaternion().setFromAxisAngle(_zAxis, sx * -tilt),
        steel
      );
    }
    // Z end plates (side plates) closing the chamber ends.
    for (const sz of [-1, 1]) {
      this._addStaticBox(
        [S.hopperWidth, S.hopperTop - S.shaftHeight + 0.2, 0.03],
        [0, (S.hopperTop + S.shaftHeight) / 2, sz * halfDepth],
        null,
        steel
      );
    }

    // Cutting-chamber shell side walls hugging the rotor sweep.
    for (const sx of [-1, 1]) {
      this._addStaticBox(
        [0.03, 0.42, S.chamberDepth],
        [sx * (throatHalfX + 0.015), S.shaftHeight - 0.14, 0],
        null,
        steel
      );
    }

    // Discharge chute below the throat, flaring outward.
    const chuteTilt = 0.5;
    const chuteLen = 0.5;
    for (const sx of [-1, 1]) {
      this._addStaticBox(
        [0.02, chuteLen, S.chamberDepth * 0.9],
        [sx * (throatHalfX * 0.7), (S.shaftHeight - 0.34 + SHREDDER.dischargeY) / 2 + 0.1, 0],
        new THREE.Quaternion().setFromAxisAngle(_zAxis, sx * chuteTilt),
        steel
      );
    }

    // Rear support / base plate under everything.
    this._addStaticBox([S.hopperWidth + 0.4, 0.06, S.chamberDepth + 0.3], [0, SHREDDER.dischargeY - 0.05, 0], null, steel);
  }

  /**
   * Create a static (fixed) box: a visual mesh + a matching fixed physics body.
   * @param {number[]} size full extents [x,y,z]
   * @param {number[]} position
   * @param {THREE.Quaternion|null} quaternion
   * @param {THREE.Material} material
   */
  _addStaticBox(size, position, quaternion, material) {
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    ensureHeatAttribute(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(position[0], position[1], position[2]);
    if (quaternion) mesh.quaternion.copy(quaternion);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    const q = quaternion || _q.identity();
    this.physics.addBody({
      type: 'fixed',
      shapes: [{ type: 'box', hx: size[0] / 2, hy: size[1] / 2, hz: size[2] / 2, friction: 0.6, restitution: 0.05 }],
      position,
      quaternion: [q.x, q.y, q.z, q.w],
      collisionGroups: FILTER.WORLD,
      userData: { kind: 'world' }
    });
  }

  /* ---------------------------------------------------------------- *
   * Motor + control.
   * ---------------------------------------------------------------- */

  /**
   * Report the summed tooth↔scrap contact impulse for this frame. Called by
   * {@link ShredderProcessor} before the rig's own update runs.
   * @param {number} impulseSum
   */
  reportLoad(impulseSum) {
    this._pendingLoad = impulseSum;
  }

  /**
   * Advance the motor model and drive the rotors.
   * @param {number} dt
   */
  update(dt) {
    const S = SHREDDER;

    // Demanded torque ≈ contact force × tooth lever arm.
    const contactForce = this._pendingLoad / Math.max(dt, 1e-3);
    const demandedTorque = contactForce * (S.discRadius + S.toothHeight);
    this._pendingLoad = 0;

    let load = demandedTorque / S.stallTorque;
    if (load > 1.5) load = 1.5;
    this.load = Math.min(1, load);

    // Anti-jam: sustained stall triggers a brief reverse burst.
    const trulyStalled = this.power && load >= 0.98;
    if (trulyStalled) this._stallTimer += dt;
    else this._stallTimer = Math.max(0, this._stallTimer - dt * 1.5);

    if (this._reverseBurst > 0) {
      this._reverseBurst -= dt;
    } else if (this._stallTimer > 0.9) {
      this._reverseBurst = 0.5;
      this._stallTimer = 0;
    }
    const autoReverse = this._reverseBurst > 0;

    // Target speed, sagging when the demanded torque exceeds what the motor
    // can deliver (this is the audible strain).
    let targetOmega = this.power ? S.nominalOmega * this.throttle : 0;
    if (load > 1) targetOmega *= Math.max(0.05, 1 / load);
    else if (load > 0.4) targetOmega *= 1 - (load - 0.4) * 0.5;

    // Smoothly approach the target so RPM changes have inertia.
    this._omega += (targetOmega - this._omega) * Math.min(1, dt * 6);
    this.stalled = trulyStalled || (this.power && this._omega < S.nominalOmega * 0.12 && load > 0.5);

    const dirSign = (this.reverse ? -1 : 1) * (autoReverse ? -1 : 1);
    this.rpm = (this._omega * 60) / (Math.PI * 2);

    // Drive each rotor (opposite senses so material is pulled down).
    for (let i = 0; i < this.rotors.length; i++) {
      const rotor = this.rotors[i];
      const signedOmega = this._omega * rotor.dir * dirSign;
      rotor.angle += signedOmega * dt;
      rotor.mesh.rotation.z = rotor.angle;
      this.physics.setAngularVelocity(rotor.bodyId, [0, 0, signedOmega]);
    }

    bus.emit(EVENTS.MOTOR_LOAD, {
      load: this.load,
      rpm: this.rpm,
      stalled: this.stalled,
      throttle: this.throttle,
      reverse: this.reverse || autoReverse
    });
  }

  /** @param {boolean} on */
  setPower(on) {
    this.power = !!on;
  }

  /** @param {number} v 0..1 */
  setThrottle(v) {
    this.throttle = Math.max(0, Math.min(1, v));
  }

  /** @param {boolean} v */
  setReverse(v) {
    this.reverse = !!v;
  }

  /** Reduce tooth LOD / shadow casting on lower presets. @param {object} preset */
  applyQuality(preset) {
    const perf = preset && (preset.label === 'Performance' || preset.shadowMapSize <= 1024);
    for (let i = 0; i < this.toothMeshes.length; i++) {
      this.toothMeshes[i].castShadow = !perf;
    }
  }

  /**
   * The local shear plane for a world-space point in the throat. Planes are
   * snapped to the disc-spacing grid so cuts fall along the interleaved discs
   * and produce the shredder's characteristic strip fragments. The normal is
   * mostly along Z with a slight tilt reflecting the tooth helix.
   *
   * @param {THREE.Vector3} worldPoint
   * @returns {THREE.Plane} world-space plane
   */
  getShearPlaneFor(worldPoint) {
    const spacing = this._pitch * 0.5; // ~5 cm strips
    // Snap to the nearest cut line, biased so the plane actually crosses the part.
    let z = Math.round(worldPoint.z / spacing) * spacing;
    if (Math.abs(z - worldPoint.z) < 1e-3) z += spacing * 0.5;

    // Slight helix tilt, alternating side to side.
    const tiltSign = ((Math.round(worldPoint.z / spacing) % 2) === 0) ? 1 : -1;
    _plane.normal.set(0.14 * tiltSign, 0, 1).normalize();
    _pt.set(worldPoint.x, SHREDDER.shaftHeight, z);
    _plane.setFromNormalAndCoplanarPoint(_plane.normal, _pt);
    return _plane;
  }
}
