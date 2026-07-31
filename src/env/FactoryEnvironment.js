import * as THREE from 'three';
import { LAYOUT } from '../config.js';
import { createFloorTextureSet, createMetalTextureSet } from '../materials/ProceduralTextures.js';
import { patchMetalShader } from '../materials/HeatShader.js';
import { GeometryBatcher } from '../utils/GeometryBatcher.js';
import { DEVICE } from '../core/DeviceProfile.js';

/**
 * Builds a fully procedural HDR studio/factory environment (no external .hdr
 * assets) plus the visible room geometry and the practical lighting rig.
 */

function areaLightMaterial(intensity, color = 0xffffff) {
  const mat = new THREE.MeshBasicMaterial();
  mat.color.set(color);
  // THREE.Color happily holds values > 1 — that is what makes this an HDR probe.
  mat.color.multiplyScalar(intensity);
  mat.toneMapped = false;
  return mat;
}

/** Shadow map resolution ladder — shared by the initial build and by
 *  setShadowQuality() so a runtime tier change lands on the same value the
 *  lamp would have been built with. Clamped by the device budget: a 4096 map
 *  is 67 MB of depth texture, which a phone cannot spare even at 'ultra'. */
function shadowMapSize(quality) {
  const want = quality === 'ultra' ? 4096 : quality === 'high' ? 2048 : quality === 'medium' ? 1536 : 1024;
  return Math.min(want, DEVICE.shadowMapCap);
}

function box(w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

/**
 * The environment scene is rendered into a cube map and pre-filtered by the
 * PMREM generator. Its job is purely to produce believable specular
 * reflections and image-based ambient on the metal.
 */
function buildEnvScene() {
  const scene = new THREE.Scene();

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ side: THREE.BackSide, color: 0x0e1013, roughness: 1, metalness: 0 })
  );
  shell.scale.set(30, 15, 34);
  shell.position.y = 5.5;
  scene.add(shell);

  // Dark, slightly warm floor bounce.
  scene.add(box(30, 0.1, 34, areaLightMaterial(0.16, 0xb0a496), 0, -0.05, 0));

  // Overhead high-bay strips — long and thin so metal picks up the elongated
  // streak highlights that sell an anisotropic brushed finish.
  //
  // These values are radiance, and a metal surface reflects the environment
  // almost in full: an over-bright probe makes every metallic object read as
  // uniform white no matter how good its maps are. Keep the emitters modest
  // and let the *contrast* between them and the dark shell do the work.
  const bay = areaLightMaterial(7, 0xf2f7ff);
  for (let i = -2; i <= 2; i++) {
    scene.add(box(16, 0.16, 0.5, bay, 0, 10.6, i * 5.2));
  }
  // Cross strips give a second highlight axis.
  const bayB = areaLightMaterial(3.2, 0xe6f0ff);
  scene.add(box(0.45, 0.14, 24, bayB, -7.5, 10.2, 0));
  scene.add(box(0.45, 0.14, 24, bayB, 7.5, 10.2, 0));

  // Big soft key panel front-left: the primary shaping light.
  const key = areaLightMaterial(4.6, 0xfff4e2);
  const keyMesh = box(9, 6.5, 0.2, key, -8.6, 5.6, 7.2);
  keyMesh.rotation.y = Math.PI * 0.22;
  scene.add(keyMesh);

  // Warm sodium practicals low on the right — the orange rim on the metal.
  const sodium = areaLightMaterial(5.5, 0xffa243);
  scene.add(box(0.55, 0.55, 0.55, sodium, 9.2, 4.2, -3.4));
  scene.add(box(0.55, 0.55, 0.55, sodium, 8.4, 3.0, 5.0));
  scene.add(box(4.5, 0.2, 0.2, areaLightMaterial(2.4, 0xff8a2a), 6.5, 6.4, -8));

  // Cold rim from behind, teal — separates silhouettes from the dark room.
  const rim = areaLightMaterial(2.6, 0x5fa8ff);
  const rimMesh = box(11, 5, 0.2, rim, 3.2, 4.4, -12.5);
  scene.add(rimMesh);

  // Faint bounce cards to avoid pure-black reflections in the roughness lobes.
  scene.add(box(0.2, 7, 20, areaLightMaterial(0.32, 0x8d99a8), -12, 4, 0));
  scene.add(box(0.2, 7, 20, areaLightMaterial(0.24, 0x7e8794), 12, 4, 0));

  return scene;
}

export function createStudioEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = buildEnvScene();
  const rt = pmrem.fromScene(envScene, 0.035, 0.1, 120);
  envScene.traverse((o) => {
    if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
  });
  pmrem.dispose();
  return rt.texture;
}

/* ------------------------------------------------------------------ factory */

export class Factory {
  constructor(scene, quality = 'high') {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Factory';
    scene.add(this.group);
    this.lights = [];
    this.disposables = [];
    this._build(quality);
  }

  _track(x) { this.disposables.push(x); return x; }

  _build(quality) {
    const R = LAYOUT.room;
    const texSize = Math.min(quality === 'low' ? 512 : 1024, DEVICE.maxTextureSize);

    /* ---- floor ----
     * Repeats are derived from real surface size: the concrete tile covers
     * ~0.9 m, so the aggregate speckle lands at centimetre scale instead of
     * smearing into metre-wide blobs. */
    const floorTex = this._track(createFloorTextureSet({ style: 'concrete', size: texSize, seed: 11, repeat: [R.hx * 2 / 0.9, R.hz * 2 / 0.9], grime: 0.72, oil: 0.6 }));
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex.map,
      normalMap: floorTex.normalMap,
      roughnessMap: floorTex.roughnessMap,
      metalnessMap: floorTex.metalnessMap,
      aoMap: floorTex.aoMap,
      roughness: 1, metalness: 1,
      envMapIntensity: 0.4,
      normalScale: new THREE.Vector2(0.7, 0.7),
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(R.hx * 2, R.hz * 2), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);
    this.floorMaterial = floorMat;

    /* ---- steel deck around the machine ----
     * 5 tread lugs per tile at a 0.2 m tile = ~40 mm lugs, which is what real
     * checker plate measures. */
    const deckTex = this._track(createFloorTextureSet({ style: 'diamondPlate', size: texSize, seed: 3, repeat: [7.4 / 0.2, 7.4 / 0.2], wear: 0.7, cells: 5 }));
    const deckMat = new THREE.MeshStandardMaterial({
      map: deckTex.map, normalMap: deckTex.normalMap,
      roughnessMap: deckTex.roughnessMap, metalnessMap: deckTex.metalnessMap, aoMap: deckTex.aoMap,
      roughness: 1, metalness: 1, envMapIntensity: 0.85,
      normalScale: new THREE.Vector2(1.15, 1.15),
    });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.09, 7.4), deckMat);
    deck.position.set(0, 0.045, 0.6);
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.group.add(deck);
    this.deckMaterial = deckMat;

    /* ---- walls ---- */
    const wallTex = this._track(createMetalTextureSet('paintedSteel', { size: texSize, seed: 42, repeat: [R.hx * 2 / 1.2, R.height / 1.2], paintColor: 'grey', rust: 0.28 }));
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTex.map, normalMap: wallTex.normalMap,
      roughnessMap: wallTex.roughnessMap, metalnessMap: wallTex.metalnessMap,
      roughness: 1, metalness: 1, envMapIntensity: 0.42,
      normalScale: new THREE.Vector2(0.6, 0.6),
      side: THREE.FrontSide,
    });
    const mkWall = (w, h, x, y, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z); m.rotation.y = ry;
      m.receiveShadow = true;
      this.group.add(m);
    };
    mkWall(R.hx * 2, R.height, 0, R.height / 2, -R.hz, 0);
    mkWall(R.hx * 2, R.height, 0, R.height / 2, R.hz, Math.PI);
    mkWall(R.hz * 2, R.height, -R.hx, R.height / 2, 0, Math.PI / 2);
    mkWall(R.hz * 2, R.height, R.hx, R.height / 2, 0, -Math.PI / 2);

    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(R.hx * 2, R.hz * 2),
      new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.95, metalness: 0.1 })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = R.height;
    this.group.add(ceil);

    /* ---- structure: columns + roof trusses (batched into one mesh) ---- */
    const structMat = new THREE.MeshStandardMaterial({
      color: 0x3a3e44, roughness: 0.62, metalness: 0.95, envMapIntensity: 0.85,
    });
    this.structMaterial = structMat;

    const batcher = new GeometryBatcher();
    const colGeo = new THREE.BoxGeometry(0.32, R.height, 0.32);
    const baseGeo = new THREE.BoxGeometry(0.72, 0.12, 0.72);
    for (const [cx, cz] of [[-8, -9], [8, -9], [-8, 9], [8, 9], [-8, 0], [8, 0]]) {
      batcher.add(colGeo, structMat, [cx, R.height / 2, cz]);
      batcher.add(baseGeo, structMat, [cx, 0.06, cz]);
    }
    const trussGeo = new THREE.BoxGeometry(R.hx * 2, 0.22, 0.16);
    const webGeo = new THREE.BoxGeometry(0.06, 0.06, 0.9);
    for (let i = -3; i <= 3; i++) {
      batcher.add(trussGeo, structMat, [0, R.height - 0.5, i * 4.2]);
      for (let j = -6; j <= 6; j++) {
        batcher.add(webGeo, structMat, [j * 2.1, R.height - 0.78, i * 4.2], [(j % 2 ? 1 : -1) * 0.6, 0, 0]);
      }
    }
    // Overhead crane rail — kept high and slim so it does not read as a pillar.
    batcher.add(new THREE.BoxGeometry(0.22, 0.3, R.hz * 2 - 2), structMat, [-5.6, R.height - 0.95, 0]);
    batcher.flush(this.group, { namePrefix: 'structure' });
    colGeo.dispose(); baseGeo.dispose(); trussGeo.dispose(); webGeo.dispose();

    /* ---- hazard striping on the deck ---- */
    const hazard = this._makeHazardTexture();
    const hazMat = new THREE.MeshStandardMaterial({
      map: hazard, roughness: 0.72, metalness: 0.3,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      transparent: true,
    });
    const hazGeo = new THREE.PlaneGeometry(7.4, 0.42);
    for (const [hz, rot] of [[4.36, 0], [-3.16, 0]]) {
      const s = new THREE.Mesh(hazGeo, hazMat);
      s.rotation.x = -Math.PI / 2; s.rotation.z = rot;
      s.position.set(0, 0.095, hz);
      s.receiveShadow = true;
      this.group.add(s);
    }
    const hazSide = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 0.42), hazMat);
    hazSide.rotation.x = -Math.PI / 2; hazSide.rotation.z = Math.PI / 2;
    hazSide.position.set(3.5, 0.095, 0.6);
    this.group.add(hazSide);
    const hazSide2 = hazSide.clone(); hazSide2.position.x = -3.5;
    this.group.add(hazSide2);

    /* ---- practical lamp fixtures ---- */
    this._buildLamps(quality);
    this._buildAmbientProps(structMat);

    for (const m of [floorMat, deckMat, wallMat]) {
      patchMetalShader(m, { heat: false, roughnessFloor: 0.24 });
    }
  }

  _makeHazardTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#161616'; g.fillRect(0, 0, 256, 32);
    g.strokeStyle = '#d8a318'; g.lineWidth = 13;
    for (let x = -32; x < 300; x += 26) {
      g.beginPath(); g.moveTo(x, 40); g.lineTo(x + 44, -8); g.stroke();
    }
    // scuff it up so it does not look like a decal sticker
    const img = g.getImageData(0, 0, 256, 32);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = 0.72 + Math.random() * 0.42;
      d[i] *= n; d[i + 1] *= n; d[i + 2] *= n;
      if (Math.random() < 0.06) d[i + 3] = 90 + Math.random() * 120;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(9, 1);
    tex.anisotropy = 8;
    return tex;
  }

  _buildLamps(quality) {
    const R = LAYOUT.room;
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.55, metalness: 0.9, side: THREE.DoubleSide });
    const bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1dc).multiplyScalar(9) });
    bulbMat.toneMapped = false;
    this.bulbMaterial = bulbMat;

    const mkLamp = (x, z, intensity, color, shadow) => {
      const g = new THREE.Group();
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.52, 0.36, 20, 1, true), shadeMat);
      shade.position.y = R.height - 1.5;
      shade.rotation.x = Math.PI;
      g.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), bulbMat);
      bulb.position.y = R.height - 1.62;
      g.add(bulb);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.4, 6), shadeMat);
      rod.position.y = R.height - 0.8;
      g.add(rod);

      const light = new THREE.SpotLight(color, intensity, 26, Math.PI * 0.36, 0.55, 1.5);
      light.position.set(0, R.height - 1.62, 0);
      light.target.position.set(0, 0, 0);
      g.add(light, light.target);
      if (shadow) {
        light.castShadow = true;
        const size = shadowMapSize(quality);
        light.shadow.mapSize.set(size, size);
        /* The shadow camera is bound to the machine, not to the room.
         *
         * near: the fixture hangs at y = R.height - 1.62 (6.78 m) and the
         *   closest real caster along the light axis is stock riding the belt
         *   at ~2.3 m; the hopper mouth is ~5 m down. 1.6 m leaves margin and
         *   buys ~2.7x the depth resolution that 0.6 m did.
         * far: three's SpotLightShadow overwrites camera.far with
         *   `light.distance` on every update, so the only way to shorten it is
         *   to shorten the light's range — which would visibly change the
         *   falloff across the floor. Left at the light's 26 m on purpose.
         * focus: fov is derived as light.angle * focus. The full 129 deg cone
         *   spends most of its texels on bare floor; 0.85 keeps the deck, the
         *   hopper and the loaded half of the belt inside the map at ~2.2x the
         *   texel density. What falls outside is only ever lit at <15% by the
         *   spot's penumbra, so no shadow visibly pops.
         */
        light.shadow.camera.near = 1.6;
        light.shadow.focus = 0.85;
        // With the tighter frustum the depth values are accurate enough for a
        // small constant bias; normalBias does the heavy lifting against acne
        // on the near-tangent surfaces (deck plate, hopper walls).
        light.shadow.bias = -0.0005;
        light.shadow.normalBias = 0.022;
        light.shadow.radius = 2.2;
      }
      g.position.set(x, 0, z);
      this.group.add(g);
      this.lights.push(light);
      return light;
    };

    // Key light directly over the throat: the one that casts the hero shadows.
    this.keyLight = mkLamp(0.6, 2.0, 190, 0xfff0dc, true);
    this.keyLight.target.position.set(-0.6, 1.0, -2.0);
    mkLamp(-6.5, -5.5, 90, 0xffc98a, false);
    mkLamp(6.5, 5.5, 80, 0xd8e8ff, false);

    // Sodium wall packs for the warm industrial rim.
    const rim1 = new THREE.PointLight(0xff8a2a, 55, 18, 2);
    rim1.position.set(8.4, 4.0, -5.5);
    this.group.add(rim1); this.lights.push(rim1);
    const rim2 = new THREE.PointLight(0x4f9dff, 34, 20, 2);
    rim2.position.set(-7.5, 3.4, -8.5);
    this.group.add(rim2); this.lights.push(rim2);

    // Tight throat fill so the cutting zone never goes muddy.
    // NOTE: all practical intensities below are candela and must stay in scale
    // with the key light (190 cd at ~6.8 m => ~4 lx on the machine). Short-
    // range lights blow out catastrophically if this is ignored.
    const throat = new THREE.SpotLight(0xfff6e8, 18, 7.5, Math.PI * 0.4, 0.9, 2);
    throat.position.set(0, 3.4, 1.2);
    throat.target.position.set(0, LAYOUT.shaftY, 0);
    this.group.add(throat, throat.target);
    this.lights.push(throat);
    this.throatLight = throat;

    // Machine work lamp just inside the hopper mouth. ~0.8 cd at 0.5 m gives
    // roughly 3 lx on the teeth: a lift, not a floodlight.
    const work = new THREE.PointLight(0xffe4c2, 0.8, 3.0, 2.0);
    work.position.set(0, LAYOUT.hopper.bottomY + 0.52, 0.16);
    this.group.add(work);
    this.lights.push(work);
    this.workLight = work;

    const hemi = new THREE.HemisphereLight(0x93a7c4, 0x2b2622, 0.32);
    this.group.add(hemi);
    this.lights.push(hemi);
  }

  _buildAmbientProps(structMat) {
    // Background clutter: pallets of stock, control cabinets, a scrap pile.
    // All of it is merged per material so it costs three draw calls, not fifty.
    const rustMat = new THREE.MeshStandardMaterial({ color: 0x6b5347, roughness: 0.85, metalness: 0.75, envMapIntensity: 0.7 });
    const cabinetMat = new THREE.MeshStandardMaterial({ color: 0x2f4a3c, roughness: 0.5, metalness: 0.85, envMapIntensity: 0.9 });
    const scrapPileMat = new THREE.MeshStandardMaterial({ color: 0x7d7f84, roughness: 0.6, metalness: 1.0, envMapIntensity: 1.0 });

    const batcher = new GeometryBatcher();
    const plankGeo = new THREE.BoxGeometry(1.7, 0.1, 0.6);

    for (const [sx, sz, sr] of [[-5.6, 3.2, 0.34], [-6.4, -1.4, -0.2]]) {
      for (let i = 0; i < 5; i++) {
        const local = new THREE.Vector3(0, 0.1 + i * 0.11, (i % 2) * 0.05);
        local.applyEuler(new THREE.Euler(0, sr, 0));
        batcher.add(plankGeo, rustMat,
          [sx + local.x, local.y, sz + local.z],
          [0, sr + (Math.random() - 0.5) * 0.06, 0]);
      }
    }
    plankGeo.dispose();

    const cabGeo = new THREE.BoxGeometry(0.8, 1.9, 0.55);
    const ventGeo = new THREE.BoxGeometry(0.5, 0.5, 0.02);
    for (let i = 0; i < 3; i++) {
      batcher.add(cabGeo, cabinetMat, [5.2 + i * 0.86, 0.95, -6.4]);
      batcher.add(ventGeo, structMat, [5.2 + i * 0.86, 1.5, -6.11]);
    }
    cabGeo.dispose(); ventGeo.dispose();

    const rnd = mulberry32(1337);
    const scrapGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 26; i++) {
      const s = 0.06 + rnd() * 0.14;
      batcher.add(scrapGeo, scrapPileMat,
        [6.0 + (rnd() - 0.5) * 1.7, 0.05 + rnd() * 0.3, 2.8 + (rnd() - 0.5) * 1.1],
        [rnd() * 3, rnd() * 3, rnd() * 3],
        [s * (1 + rnd() * 3), s * 0.4, s]);
    }
    scrapGeo.dispose();

    batcher.flush(this.group, { namePrefix: 'props' });

    // Status LEDs stay separate: they are emissive and must not be batched
    // into a shadow-casting mesh.
    const ledGroup = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.028, 8, 6),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(i === 1 ? 0xff3020 : 0x30ff70).multiplyScalar(4) })
      );
      led.material.toneMapped = false;
      led.position.set(5.2 + i * 0.86, 1.82, -6.1);
      ledGroup.add(led);
    }
    this.group.add(ledGroup);
  }

  /** Point every opaque material at the environment probe. */
  applyEnvironment(envMap) {
    this.group.traverse((o) => {
      if (o.isMesh && o.material && o.material.isMeshStandardMaterial) {
        o.material.envMap = envMap;
        o.material.needsUpdate = true;
      }
    });
  }

  /** Static colliders describing the room for the physics worker. */
  colliderDescription() {
    const R = LAYOUT.room;
    return [
      {
        position: [0, -0.5, 0], shapes: [{ type: 'box', he: [R.hx, 0.5, R.hz] }],
        friction: 0.85, restitution: 0.12, reportImpacts: true, forceThreshold: 420,
      },
      { position: [0, 0.0, 0.6], shapes: [{ type: 'box', he: [3.7, 0.048, 3.7], offset: [0, 0.045, 0] }], friction: 0.8, restitution: 0.2, reportImpacts: true, forceThreshold: 380 },
      { position: [0, R.height / 2, -R.hz - 0.5], shapes: [{ type: 'box', he: [R.hx, R.height, 0.5] }], friction: 0.6 },
      { position: [0, R.height / 2, R.hz + 0.5], shapes: [{ type: 'box', he: [R.hx, R.height, 0.5] }], friction: 0.6 },
      { position: [-R.hx - 0.5, R.height / 2, 0], shapes: [{ type: 'box', he: [0.5, R.height, R.hz] }], friction: 0.6 },
      { position: [R.hx + 0.5, R.height / 2, 0], shapes: [{ type: 'box', he: [0.5, R.height, R.hz] }], friction: 0.6 },
    ];
  }

  setShadowQuality(quality) {
    const size = shadowMapSize(quality);
    const shadow = this.keyLight?.shadow;
    if (!shadow || !this.keyLight.castShadow) return;
    if (shadow.mapSize.width === size && shadow.mapSize.height === size) return;

    shadow.mapSize.set(size, size);
    // The old map is a live framebuffer + texture. dispose() fires the event
    // WebGLTextures listens for, which deletes both immediately; dropping the
    // reference without it would leak one FBO per quality change. The renderer
    // reallocates at the new size because the reference is null.
    if (shadow.map) {
      shadow.map.dispose();
      shadow.map = null;
    }
    if (shadow.mapPass) {
      shadow.mapPass.dispose();
      shadow.mapPass = null;
    }
    shadow.needsUpdate = true;
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.group.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); }
    });
    this.scene.remove(this.group);
  }
}

/** Seeded PRNG so the prop layout is identical on every reload. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
