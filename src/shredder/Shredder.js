import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAYOUT } from '../config.js';
import { createMetalTextureSet } from '../materials/ProceduralTextures.js';
import { patchMetalShader } from '../materials/HeatShader.js';
import { GeometryBatcher } from '../utils/GeometryBatcher.js';
import { DEVICE } from '../core/DeviceProfile.js';

/**
 * Dual-shaft, low-speed / high-torque industrial shredder.
 *
 * Geometry and collision are generated from one shared tooth profile so what
 * you see biting the metal is exactly what the solver is using.
 */

/** Ratio between the two shafts. Real dual-shaft shredders run a differential
 *  so the teeth wipe past each other and self-clean instead of jamming. */
export const SHAFT_RATIO = [1.0, 1.28];

/**
 * 2D outline of one cutter disc: N hook teeth around a scooped gullet.
 * Returns points in the disc plane, CCW, ready for extrusion.
 */
export function buildCutterProfile(rHub, rTip, teeth) {
  const pts = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    // Scooped gullet floor — this is the pocket that drags material down.
    const seg = 6;
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      const ang = a + t * step * 0.46;
      const r = rHub * (1 - 0.075 * Math.sin(t * Math.PI));
      pts.push(new THREE.Vector2(Math.cos(ang) * r, Math.sin(ang) * r));
    }
    // Leading hook face: slightly undercut so it grabs rather than skates.
    const angLead = a + step * 0.50;
    pts.push(new THREE.Vector2(
      Math.cos(angLead - step * 0.055) * (rHub * 1.28),
      Math.sin(angLead - step * 0.055) * (rHub * 1.28)
    ));
    pts.push(new THREE.Vector2(
      Math.cos(angLead - step * 0.012) * (rTip * 0.985),
      Math.sin(angLead - step * 0.012) * (rTip * 0.985)
    ));
    pts.push(new THREE.Vector2(Math.cos(angLead) * rTip, Math.sin(angLead) * rTip));
    // Tip land
    const angTip = a + step * 0.615;
    pts.push(new THREE.Vector2(Math.cos(angTip) * rTip, Math.sin(angTip) * rTip));
    // Back relief
    const angBack = a + step * 0.845;
    pts.push(new THREE.Vector2(Math.cos(angBack) * (rHub * 1.10), Math.sin(angBack) * (rHub * 1.10)));
    pts.push(new THREE.Vector2(Math.cos(a + step) * rHub, Math.sin(a + step) * rHub));
  }
  return pts;
}

/** Convex point cloud for one tooth, in cutter-local space (X = shaft axis). */
function toothHullPoints(rHub, rTip, teeth, index, halfThickness, phase) {
  const step = (Math.PI * 2) / teeth;
  const a = index * step + phase;
  const out = [];
  const push = (r, ang) => {
    // profile (u,v) -> (0, v, -u); rotation about X preserves radius
    const u = Math.cos(ang) * r;
    const v = Math.sin(ang) * r;
    out.push(halfThickness, v, -u);
    out.push(-halfThickness, v, -u);
  };
  push(rHub * 0.93, a + step * 0.30);
  push(rHub * 1.28, a + step * 0.445);
  push(rTip * 0.985, a + step * 0.488);
  push(rTip, a + step * 0.50);
  push(rTip, a + step * 0.615);
  push(rHub * 1.10, a + step * 0.845);
  push(rHub * 0.93, a + step * 0.95);
  return new Float32Array(out);
}

/** Open funnel between two rectangular rings. */function makeFunnel(topHX, topHZ, bottomHX, bottomHZ, topY, bottomY) {
  const top = [
    [-topHX, topY, -topHZ], [topHX, topY, -topHZ],
    [topHX, topY, topHZ], [-topHX, topY, topHZ],
  ];
  const bot = [
    [-bottomHX, bottomY, -bottomHZ], [bottomHX, bottomY, -bottomHZ],
    [bottomHX, bottomY, bottomHZ], [-bottomHX, bottomY, bottomHZ],
  ];
  const pos = [];
  const uv = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const a = top[i], b = top[j], c = bot[j], d = bot[i];
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

export class Shredder {  constructor(scene, quality = 'high') {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Shredder';
    scene.add(this.group);

    this.angle = 0;
    this.rpm = 0;
    this.beltOffset = 0;
    this.conveyorSpeed = 0.45;
    this.disposables = [];

    this._buildMaterials(quality);
    this._buildRotors(quality);
    this._buildHousing();
    this._buildConveyor();
    this._buildBin();

    /** X positions of the shear planes — the faces between adjacent discs.
     *  Slicing along these is what produces true shredder ribbon strips. */
    this.shearPlanes = [];
    const n = LAYOUT.cuttersPerShaft;
    const p = LAYOUT.cutterPitch;
    // Both shafts contribute shear faces, and they are offset by a quarter
    // pitch each, so usable shear planes occur every half pitch.
    const half = p / 2;
    for (let i = 0; i * half <= LAYOUT.throatWidth; i++) {
      this.shearPlanes.push(-LAYOUT.throatWidth / 2 + i * half);
    }
    this.stripPitch = half;
    void n;

    this.throatBox = new THREE.Box3(
      new THREE.Vector3(-LAYOUT.throatWidth / 2 - 0.06, LAYOUT.shaftY - LAYOUT.cutterRadius - 0.02, -LAYOUT.shaftSeparation / 2 - LAYOUT.cutterRadius),
      new THREE.Vector3(LAYOUT.throatWidth / 2 + 0.06, LAYOUT.shaftY + LAYOUT.cutterRadius + 0.10, LAYOUT.shaftSeparation / 2 + LAYOUT.cutterRadius)
    );
  }

  _track(t) { this.disposables.push(t); return t; }

  _buildMaterials(quality) {
    const size = Math.min(quality === 'low' ? 256 : 512, DEVICE.maxTextureSize);

    const bladeTex = this._track(createMetalTextureSet('steel', {
      size, seed: 91, repeat: [8, 8], rust: 0.05, scratches: 0.42,
    }));
    this.bladeMaterial = new THREE.MeshPhysicalMaterial({
      map: bladeTex.map,
      normalMap: bladeTex.normalMap,
      roughnessMap: bladeTex.roughnessMap,
      metalnessMap: bladeTex.metalnessMap,
      color: 0xa9b0b7,
      // maps are authoritative — see MetalMaterial.js
      roughness: 1.0, metalness: 1.0,
      envMapIntensity: 1.0,
      anisotropy: 0.9,
      anisotropyRotation: 0,
      normalScale: new THREE.Vector2(0.7, 0.7),
    });

    const bodyTex = this._track(createMetalTextureSet('paintedSteel', {
      size, seed: 17, repeat: [2.4, 2.4], paintColor: 'yellow', rust: 0.34,
    }));
    this.bodyMaterial = new THREE.MeshPhysicalMaterial({
      map: bodyTex.map,
      normalMap: bodyTex.normalMap,
      roughnessMap: bodyTex.roughnessMap,
      metalnessMap: bodyTex.metalnessMap,
      aoMap: bodyTex.aoMap,
      roughness: 1, metalness: 1,
      envMapIntensity: 0.95,
      clearcoat: 0.35, clearcoatRoughness: 0.55,
      normalScale: new THREE.Vector2(0.85, 0.85),
      side: THREE.DoubleSide,
    });

    const frameTex = this._track(createMetalTextureSet('galvanized', {
      size, seed: 5, repeat: [6, 6],
    }));
    this.frameMaterial = new THREE.MeshPhysicalMaterial({
      map: frameTex.map, normalMap: frameTex.normalMap,
      roughnessMap: frameTex.roughnessMap, metalnessMap: frameTex.metalnessMap,
      roughness: 1, metalness: 1, envMapIntensity: 0.9,
      normalScale: new THREE.Vector2(0.75, 0.75),
    });

    this.rubberMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x14161a, roughness: 0.86, metalness: 0.05,
      envMapIntensity: 0.4, sheen: 0.15, sheenRoughness: 0.9,
    });

    // Hopper/chute liner. The inside of a working hopper is never painted:
    // stock sliding through polishes it back to scuffed bare steel. Using the
    // yellow body paint in here made the whole interior read as bright noise.
    const linerTex = this._track(createMetalTextureSet('galvanized', {
      size, seed: 63, repeat: [3.2, 3.2], rust: 0.22, scratches: 0.85,
    }));
    this.linerMaterial = new THREE.MeshPhysicalMaterial({
      map: linerTex.map,
      normalMap: linerTex.normalMap,
      roughnessMap: linerTex.roughnessMap,
      metalnessMap: linerTex.metalnessMap,
      color: 0x8d9298,
      roughness: 1, metalness: 1,
      envMapIntensity: 0.7,
      normalScale: new THREE.Vector2(0.6, 0.6),
      side: THREE.DoubleSide,
    });

    // Hardened tooling is polished but never mirror-bright; the floor keeps
    // authored scratch texels from firing off as white specular confetti.
    patchMetalShader(this.bladeMaterial, { heat: false, roughnessFloor: 0.17 });
    patchMetalShader(this.bodyMaterial, { heat: false, roughnessFloor: 0.22 });
    patchMetalShader(this.frameMaterial, { heat: false, roughnessFloor: 0.22 });
    patchMetalShader(this.linerMaterial, { heat: false, roughnessFloor: 0.26 });
  }

  _buildRotors(quality) {
    const { hubRadius, cutterRadius, cutterThickness, cutterPitch, cuttersPerShaft, teethPerCutter, shaftY, shaftSeparation } = LAYOUT;

    // mergeGeometries() requires a uniform index state; ExtrudeGeometry is
    // non-indexed while the lathe primitives are indexed, so flatten both.
    const flatten = (g) => {
      const out = g.index ? g.toNonIndexed() : g;
      if (out !== g) g.dispose();
      if (!out.attributes.uv) {
        out.setAttribute('uv', new THREE.Float32BufferAttribute(
          new Float32Array(out.attributes.position.count * 2), 2
        ));
      }
      return out;
    };

    const profile = buildCutterProfile(hubRadius, cutterRadius, teethPerCutter);
    const shape = new THREE.Shape(profile);
    const bevel = quality === 'low' ? 0 : 0.0022;
    const baseGeo = new THREE.ExtrudeGeometry(shape, {
      depth: cutterThickness - bevel * 2,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: quality === 'ultra' ? 2 : 1,
      curveSegments: 1,
      steps: 1,
    });
    baseGeo.translate(0, 0, -(cutterThickness - bevel * 2) / 2);
    baseGeo.rotateY(Math.PI / 2);   // extrusion axis -> +X (shaft axis)
    baseGeo.computeVertexNormals();

    // Spacer rings between discs keep material from wandering along the shaft.
    const spacerGeo = new THREE.CylinderGeometry(hubRadius * 0.62, hubRadius * 0.62, cutterPitch - cutterThickness, 18, 1, false);
    spacerGeo.rotateZ(Math.PI / 2);

    this.shafts = [];
    this.cutterConfigs = [];

    for (let s = 0; s < 2; s++) {
      const shaftGroup = new THREE.Group();
      shaftGroup.position.set(0, shaftY, (s === 0 ? -1 : 1) * shaftSeparation / 2);
      this.group.add(shaftGroup);

      const parts = [];
      for (let i = 0; i < cuttersPerShaft; i++) {
        // Quarter-pitch offset in opposite directions puts each shaft's discs
        // into the other's gaps. Without this there is a straight vertical
        // path between aligned discs and thin stock falls through uncut.
        const x = (i - (cuttersPerShaft - 1) / 2) * cutterPitch + (s === 0 ? -1 : 1) * cutterPitch / 4;
        // Half-tooth stagger on alternate discs + a quarter-tooth offset
        // between shafts: teeth enter the stock one at a time.
        const phase = ((i % 2) * 0.5 + s * 0.25) * (Math.PI * 2 / teethPerCutter);

        const g = baseGeo.clone();
        g.rotateX(phase);
        g.translate(x, 0, 0);
        parts.push(flatten(g));

        if (i < cuttersPerShaft - 1) {
          const sp = spacerGeo.clone();
          sp.translate(x + cutterPitch / 2, 0, 0);
          parts.push(flatten(sp));
        }

        const teeth = [];
        for (let t = 0; t < teethPerCutter; t++) {
          teeth.push(toothHullPoints(hubRadius, cutterRadius, teethPerCutter, t, cutterThickness / 2, phase));
        }
        this.cutterConfigs.push({
          shaft: s,
          phase,
          position: [x, shaftY, (s === 0 ? -1 : 1) * shaftSeparation / 2],
          // The physics hub spans a full pitch so adjacent hubs abut and form
          // a continuous roll. A hub only as wide as the disc would leave a
          // 52 mm axial slot between discs for stock to escape through.
          hub: { halfHeight: cutterPitch / 2, radius: hubRadius * 0.97 },
          teeth,
          shearMin: x - cutterThickness / 2,
          shearMax: x + cutterThickness / 2,
        });
      }

      // End journals + shaft stub
      const journal = new THREE.CylinderGeometry(hubRadius * 0.5, hubRadius * 0.5, LAYOUT.throatWidth + 0.4, 20);
      journal.rotateZ(Math.PI / 2);
      parts.push(flatten(journal));

      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) throw new Error('Shredder: rotor geometry merge failed');
      // Keep the source normals: the extrusion already has crisp machined
      // faces and the journals keep their smooth lathe shading. Recomputing
      // here would facet the round parts.

      const mesh = new THREE.Mesh(merged, this.bladeMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      shaftGroup.add(mesh);
      this.shafts.push(shaftGroup);
    }
    baseGeo.dispose();
    spacerGeo.dispose();
  }

  _buildHousing() {
    const H = LAYOUT.housing;
    const P = LAYOUT.hopper;

    // Side cheeks. These must sit within a few millimetres of the outermost
    // cutter, otherwise the gap between the rotor end and the wall is an open
    // chute and stock bypasses the teeth entirely.
    const wallT = 0.07;
    const cheekX = LAYOUT.throatWidth / 2 + 0.014;
    this.cheekX = cheekX;
    const mk = (geo, x, y, z) => {
      const m = new THREE.Mesh(geo, this.bodyMaterial);
      m.position.set(x, y, z);
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    mk(new THREE.BoxGeometry(wallT, H.yMax, H.hz * 2), -cheekX - wallT / 2, H.yMax / 2, 0);
    mk(new THREE.BoxGeometry(wallT, H.yMax, H.hz * 2), cheekX + wallT / 2, H.yMax / 2, 0);
    mk(new THREE.BoxGeometry(LAYOUT.throatWidth + 0.3, H.yMax, wallT), 0, H.yMax / 2, -H.hz);
    mk(new THREE.BoxGeometry(LAYOUT.throatWidth + 0.3, H.yMax, wallT), 0, H.yMax / 2, H.hz);

    // Massive base frame / drive housing — every repeated frame part is
    // merged into a single mesh at the end of this method.
    const batcher = new GeometryBatcher();
    batcher.add(new THREE.BoxGeometry(LAYOUT.throatWidth + 0.85, 0.44, H.hz * 2 + 0.3), this.frameMaterial, [0, 0.22, 0]);
    batcher.add(new THREE.BoxGeometry(0.52, 0.68, 0.72), this.frameMaterial, [-LAYOUT.throatWidth / 2 - 0.44, 0.86, 0]);

    const motorGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.66, 24);
    batcher.add(motorGeo, this.frameMaterial, [-LAYOUT.throatWidth / 2 - 0.92, 0.86, 0], [0, 0, Math.PI / 2]);
    motorGeo.dispose();

    // Cooling fins on the motor can
    const finGeo = new THREE.CylinderGeometry(0.262, 0.262, 0.012, 20);
    for (let i = 0; i < 9; i++) {
      batcher.add(finGeo, this.frameMaterial, [-LAYOUT.throatWidth / 2 - 1.2 + i * 0.066, 0.86, 0], [0, 0, Math.PI / 2]);
    }
    finGeo.dispose();

    // Anti-jam comb bars that strip material off the rotors
    const combGeo = new THREE.BoxGeometry(LAYOUT.throatWidth + 0.1, 0.05, 0.06);
    for (const zSign of [-1, 1]) {
      batcher.add(combGeo, this.frameMaterial, [
        0,
        LAYOUT.shaftY - LAYOUT.cutterRadius - 0.055,
        zSign * (LAYOUT.shaftSeparation / 2 + LAYOUT.hubRadius * 1.15),
      ]);
    }
    combGeo.dispose();
    this._housingBatcher = batcher;

    // Hopper funnel (double sided so you can look into it)
    const funnel = makeFunnel(P.topHX, P.topHZ, P.bottomHX, P.bottomHZ, P.topY, P.bottomY);
    const funnelMesh = new THREE.Mesh(funnel, this.linerMaterial);
    funnelMesh.castShadow = true; funnelMesh.receiveShadow = true;
    this.group.add(funnelMesh);

    // Painted outer skin on the hopper so the machine still reads as a
    // safety-yellow industrial unit from the outside.
    const skin = makeFunnel(P.topHX + 0.02, P.topHZ + 0.02, P.bottomHX + 0.02, P.bottomHZ + 0.02, P.topY, P.bottomY);
    const skinMesh = new THREE.Mesh(skin, this.bodyMaterial);
    skinMesh.castShadow = true; skinMesh.receiveShadow = true;
    this.group.add(skinMesh);

    // Discharge chute under the rotors
    const C = LAYOUT.chute;
    const chute = makeFunnel(C.hx, C.hz, 0.75, 0.42, C.topY, C.bottomY);
    const chuteMesh = new THREE.Mesh(chute, this.linerMaterial);
    chuteMesh.receiveShadow = true;
    this.group.add(chuteMesh);


    // Warning plate
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.2),
      new THREE.MeshStandardMaterial({ map: this._makeWarningPlate(), roughness: 0.5, metalness: 0.4 })
    );
    plate.position.set(0.42, 1.0, LAYOUT.housing.hz + 0.038);
    this.group.add(plate);
  }

  _makeWarningPlate() {
    const c = document.createElement('canvas');
    c.width = 170; c.height = 100;
    const g = c.getContext('2d');
    g.fillStyle = '#e0b400'; g.fillRect(0, 0, 170, 100);
    g.fillStyle = '#111'; g.beginPath();
    g.moveTo(85, 14); g.lineTo(150, 74); g.lineTo(20, 74); g.closePath(); g.fill();
    g.fillStyle = '#e0b400'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center';
    g.fillText('!', 85, 68);
    g.fillStyle = '#111'; g.font = 'bold 13px sans-serif';
    g.fillText('DANGER — ROTATING', 85, 90);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _buildConveyor() {
    const C = LAYOUT.conveyor;
    const length = C.startZ - C.endZ;
    const midZ = (C.startZ + C.endZ) / 2;

    const beltTex = this._makeBeltTexture();
    this.beltTexture = beltTex;
    const beltMat = new THREE.MeshPhysicalMaterial({
      map: beltTex.map,
      normalMap: beltTex.normal,
      roughness: 0.85, metalness: 0.02,
      envMapIntensity: 0.4,
      normalScale: new THREE.Vector2(1.5, 1.5),
    });
    this.beltMaterial = beltMat;

    const belt = new THREE.Mesh(new THREE.BoxGeometry(C.halfWidth * 2, C.beltThickness, length), beltMat);
    belt.position.set(0, C.y, midZ);
    belt.castShadow = true; belt.receiveShadow = true;
    this.group.add(belt);
    this.beltMesh = belt;

    // Rollers: one instanced draw call, still individually spinning.
    const rollerGeo = new THREE.CylinderGeometry(0.075, 0.075, C.halfWidth * 2 + 0.06, 14);
    rollerGeo.rotateZ(Math.PI / 2);
    const rollerZ = [];
    for (let z = C.endZ + 0.12; z < C.startZ; z += 0.44) rollerZ.push(z);
    this.rollerMesh = new THREE.InstancedMesh(rollerGeo, this.frameMaterial, rollerZ.length);
    this.rollerMesh.castShadow = true;
    this.rollerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._rollerZ = rollerZ;
    this._rollerAngle = 0;
    this._rollerMatrix = new THREE.Matrix4();
    this._rollerQuat = new THREE.Quaternion();
    this._rollerPos = new THREE.Vector3();
    this._rollerScale = new THREE.Vector3(1, 1, 1);
    this._updateRollers();
    this.group.add(this.rollerMesh);

    // Side rails, legs and cross braces all merge into the frame batch.
    const batcher = this._housingBatcher || new GeometryBatcher();
    const railGeo = new THREE.BoxGeometry(0.055, 0.16, length);
    for (const sx of [-1, 1]) {
      batcher.add(railGeo, this.frameMaterial, [sx * (C.halfWidth + 0.04), C.y + 0.06, midZ]);
    }
    railGeo.dispose();

    const legGeo = new THREE.BoxGeometry(0.07, C.y - 0.1, 0.07);
    const braceGeo = new THREE.BoxGeometry(C.halfWidth * 2, 0.05, 0.05);
    for (let z = C.endZ + 0.3; z < C.startZ; z += 1.2) {
      for (const sx of [-1, 1]) {
        batcher.add(legGeo, this.frameMaterial, [sx * (C.halfWidth - 0.04), (C.y - 0.1) / 2, z]);
      }
      batcher.add(braceGeo, this.frameMaterial, [0, 0.28, z]);
    }
    legGeo.dispose();
    braceGeo.dispose();

    // Feed chute from the belt lip into the hopper
    const lipGeo = new THREE.BoxGeometry(C.halfWidth * 2 + 0.1, 0.03, 0.34);
    batcher.add(lipGeo, this.frameMaterial, [0, C.y - 0.045, C.endZ - 0.16], [0.42, 0, 0]);
    lipGeo.dispose();
    this._housingBatcher = batcher;
  }

  _updateRollers() {
    for (let i = 0; i < this._rollerZ.length; i++) {
      this._rollerPos.set(0, LAYOUT.conveyor.y - 0.055, this._rollerZ[i]);
      this._rollerQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this._rollerAngle);
      this._rollerMatrix.compose(this._rollerPos, this._rollerQuat, this._rollerScale);
      this.rollerMesh.setMatrixAt(i, this._rollerMatrix);
    }
    this.rollerMesh.instanceMatrix.needsUpdate = true;
  }

  _makeBeltTexture() {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#101215'; g.fillRect(0, 0, size, size);
    // transverse cleats
    for (let y = 0; y < size; y += 32) {
      g.fillStyle = '#191c20'; g.fillRect(0, y, size, 14);
      g.fillStyle = '#0b0d0f'; g.fillRect(0, y + 14, size, 3);
    }
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = 0.8 + Math.random() * 0.4;
      d[i] *= n; d[i + 1] *= n; d[i + 2] *= n;
    }
    g.putImageData(img, 0, 0);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(2, 8);
    map.anisotropy = 8;

    // Height -> normal for the cleats
    const nc = document.createElement('canvas');
    nc.width = nc.height = size;
    const ng = nc.getContext('2d');
    const nimg = ng.createImageData(size, size);
    const nd = nimg.data;
    const height = (x, y) => {
      const yy = ((y % 32) + 32) % 32;
      let h = yy < 14 ? 1 : yy < 17 ? 0.2 : 0.55;
      h += (Math.sin(x * 0.7) * 0.5 + 0.5) * 0.06;
      return h;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = height(x + 1, y) - height(x - 1, y);
        const dy = height(x, y + 1) - height(x, y - 1);
        const len = Math.hypot(dx * 3, dy * 3, 1);
        const i = (y * size + x) * 4;
        nd[i] = ((-dx * 3 / len) * 0.5 + 0.5) * 255;
        nd[i + 1] = ((-dy * 3 / len) * 0.5 + 0.5) * 255;
        nd[i + 2] = (1 / len * 0.5 + 0.5) * 255;
        nd[i + 3] = 255;
      }
    }
    ng.putImageData(nimg, 0, 0);
    const normal = new THREE.CanvasTexture(nc);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(2, 8);
    return { map, normal };
  }

  _buildBin() {
    const B = LAYOUT.bin;
    const t = 0.045;
    const batcher = this._housingBatcher || new GeometryBatcher();
    const [bx, by, bz] = B.center;
    const wall = (w, h, d, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d);
      batcher.add(g, this.frameMaterial, [bx + x, by + y, bz + z]);
      g.dispose();
    };
    wall(B.hx * 2, t, B.hz * 2, 0, t / 2, 0);
    wall(t, B.hy * 2, B.hz * 2, -B.hx, B.hy, 0);
    wall(t, B.hy * 2, B.hz * 2, B.hx, B.hy, 0);
    wall(B.hx * 2, B.hy * 2, t, 0, B.hy, -B.hz);
    wall(B.hx * 2, B.hy * 2, t, 0, B.hy, B.hz);

    // Everything accumulated across housing / conveyor / bin lands here.
    batcher.flush(this.group, { namePrefix: 'machine-frame' });
    this._housingBatcher = null;
  }

  /** Fixed colliders for hopper, housing, chute and bin. */
  colliderDescription() {
    const H = LAYOUT.housing;
    const P = LAYOUT.hopper;
    const C = LAYOUT.conveyor;
    const B = LAYOUT.bin;
    const items = [];
    const wallT = 0.05;

    // throat cheeks — flush with the ends of the rotors
    const cheekX = this.cheekX ?? (LAYOUT.throatWidth / 2 + 0.014);
    items.push({ position: [-cheekX - wallT, H.yMax / 2, 0], shapes: [{ type: 'box', he: [wallT, H.yMax / 2, H.hz] }], friction: 0.35 });
    items.push({ position: [cheekX + wallT, H.yMax / 2, 0], shapes: [{ type: 'box', he: [wallT, H.yMax / 2, H.hz] }], friction: 0.35 });

    // hopper: four slanted slabs
    const slant = (sx, sz) => {
      const topHalfX = P.topHX, topHalfZ = P.topHZ;
      const botHalfX = P.bottomHX, botHalfZ = P.bottomHZ;
      const dy = P.topY - P.bottomY;
      if (sz !== 0) {
        const dz = (topHalfZ - botHalfZ) * sz;
        const len = Math.hypot(dz, dy);
        const angle = Math.atan2(dz, dy);
        return {
          position: [0, (P.topY + P.bottomY) / 2, sz * (topHalfZ + botHalfZ) / 2],
          quaternion: axisQuat(1, 0, 0, sz > 0 ? -(Math.PI / 2 - angle) : (Math.PI / 2 - angle)),
          shapes: [{ type: 'box', he: [topHalfX + 0.06, 0.03, len / 2] }],
          // Low friction: scrap must keep sliding down the funnel rather than
          // parking on the slope and falling asleep.
          friction: 0.2, restitution: 0.14, reportImpacts: true, forceThreshold: 260,
        };
      }
      const dx = (topHalfX - botHalfX) * sx;
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dx, dy);
      return {
        position: [sx * (topHalfX + botHalfX) / 2, (P.topY + P.bottomY) / 2, 0],
        quaternion: axisQuat(0, 0, 1, sx > 0 ? (Math.PI / 2 - angle) : -(Math.PI / 2 - angle)),
        shapes: [{ type: 'box', he: [len / 2, 0.03, topHalfZ + 0.06] }],
        friction: 0.2, restitution: 0.14, reportImpacts: true, forceThreshold: 260,
      };
    };
    items.push(slant(0, -1), slant(0, 1), slant(-1, 0), slant(1, 0));
    // conveyor belt surface
    items.push({
      position: [0, C.y, (C.startZ + C.endZ) / 2],
      shapes: [{ type: 'box', he: [C.halfWidth, C.beltThickness / 2, (C.startZ - C.endZ) / 2] }],
      friction: 1.15, restitution: 0.04, reportImpacts: true, forceThreshold: 300,
    });
    // conveyor side rails
    for (const sx of [-1, 1]) {
      items.push({
        position: [sx * (C.halfWidth + 0.04), C.y + 0.06, (C.startZ + C.endZ) / 2],
        shapes: [{ type: 'box', he: [0.028, 0.08, (C.startZ - C.endZ) / 2] }],
        friction: 0.4,
      });
    }

    // discharge chute walls
    const Ch = LAYOUT.chute;
    for (const sx of [-1, 1]) {
      items.push({
        position: [sx * 0.74, (Ch.topY + Ch.bottomY) / 2, 0],
        quaternion: axisQuat(0, 0, 1, sx * 0.16),
        shapes: [{ type: 'box', he: [0.03, (Ch.topY - Ch.bottomY) / 2, Ch.hz] }],
        friction: 0.3, restitution: 0.3,
      });
    }
    for (const sz of [-1, 1]) {
      items.push({
        position: [0, (Ch.topY + Ch.bottomY) / 2, sz * 0.48],
        quaternion: axisQuat(1, 0, 0, -sz * 0.22),
        shapes: [{ type: 'box', he: [Ch.hx, (Ch.topY - Ch.bottomY) / 2, 0.03] }],
        friction: 0.3, restitution: 0.3,
      });
    }

    // collection bin
    const bx = B.center[0], by = B.center[1], bz = B.center[2];
    items.push({ position: [bx, by + 0.02, bz], shapes: [{ type: 'box', he: [B.hx, 0.025, B.hz] }], friction: 0.7, restitution: 0.25, reportImpacts: true, forceThreshold: 240 });
    items.push({ position: [bx - B.hx, by + B.hy, bz], shapes: [{ type: 'box', he: [0.025, B.hy, B.hz] }], friction: 0.5, restitution: 0.3 });
    items.push({ position: [bx + B.hx, by + B.hy, bz], shapes: [{ type: 'box', he: [0.025, B.hy, B.hz] }], friction: 0.5, restitution: 0.3 });
    items.push({ position: [bx, by + B.hy, bz - B.hz], shapes: [{ type: 'box', he: [B.hx, B.hy, 0.025] }], friction: 0.5, restitution: 0.3 });
    items.push({ position: [bx, by + B.hy, bz + B.hz], shapes: [{ type: 'box', he: [B.hx, B.hy, 0.025] }], friction: 0.5, restitution: 0.3 });

    return items;
  }

  shredderConfig() {
    return { cutters: this.cutterConfigs, ratio: SHAFT_RATIO };
  }

  applyEnvironment(envMap) {
    for (const m of [this.bladeMaterial, this.bodyMaterial, this.frameMaterial,
      this.rubberMaterial, this.beltMaterial, this.linerMaterial]) {
      m.envMap = envMap;
      m.needsUpdate = true;
    }
  }

  /** Drive the visual rotors from the authoritative angle produced by physics. */
  update(dt, angle, conveyorSpeed, running) {
    this.angle = angle;
    this.shafts[0].rotation.x = angle * SHAFT_RATIO[0];
    this.shafts[1].rotation.x = -angle * SHAFT_RATIO[1];

    this.conveyorSpeed = conveyorSpeed;
    if (running && conveyorSpeed > 0.001) {
      const v = conveyorSpeed * LAYOUT.conveyor.maxSpeed;
      this.beltOffset -= v * dt * 0.62;
      this.beltTexture.map.offset.y = this.beltOffset;
      this.beltTexture.normal.offset.y = this.beltOffset;
      this._rollerAngle -= (v / 0.075) * dt;
      this._updateRollers();
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.scene.remove(this.group);
  }
}

function axisQuat(ax, ay, az, angle) {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
}
