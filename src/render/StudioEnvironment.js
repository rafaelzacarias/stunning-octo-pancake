import * as THREE from 'three';
import { ProceduralTextures } from '../materials/ProceduralTextures.js';
import { SHREDDER } from '../core/Constants.js';

/**
 * Procedural, HDRI-grade industrial lighting — no external assets.
 *
 * Builds an off-screen "environment scene" of emissive softboxes, overhead
 * fluorescent strips and a warm sodium bounce, runs it through
 * {@link THREE.PMREMGenerator} to produce a filtered environment map, and lays
 * analytic key / fill / rim / throat lights on top. It also builds the factory
 * shell (worn concrete floor, back wall) and atmospheric haze so the machine
 * reads with depth. It does NOT build the shredder or conveyor (Agent 1 owns
 * those).
 *
 * @example
 *   const env = new StudioEnvironment(renderer, scene);
 *   await env.build();
 *   // scene.environment is now set; materials pick it up automatically.
 */

const PRESETS = {
  studio: {
    envIntensity: 1.0,
    key: { color: 0xfff4e6, intensity: 3.1 },
    fill: { color: 0x8fb2d8, intensity: 0.55 },
    rim: { color: 0xff8a3c, intensity: 1.6 },
    throat: { color: 0xffe9c8, intensity: 6.0 },
    fog: { color: 0x0a0c12, density: 0.012 },
    background: 0x05060a
  },
  factory: {
    envIntensity: 1.15,
    key: { color: 0xdfe8ff, intensity: 3.6 },
    fill: { color: 0x7f97b8, intensity: 0.7 },
    rim: { color: 0xffa030, intensity: 1.9 },
    throat: { color: 0xfff0d0, intensity: 7.5 },
    fog: { color: 0x0c0f16, density: 0.02 },
    background: 0x070910
  },
  dusk: {
    envIntensity: 0.75,
    key: { color: 0xffcaa0, intensity: 2.2 },
    fill: { color: 0x5c6f9c, intensity: 0.4 },
    rim: { color: 0xff6a2a, intensity: 2.4 },
    throat: { color: 0xffdcae, intensity: 5.0 },
    fog: { color: 0x120a08, density: 0.028 },
    background: 0x0a0705
  }
};

export class StudioEnvironment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    /** @type {THREE.Texture|null} PMREM environment map. */
    this.envMap = null;
    this.intensity = 1;
    this.presetId = 'factory';

    this._root = new THREE.Group();
    this._root.name = 'StudioEnvironment';
    this._lights = {};
    this._pmrem = null;
    this._textures = new ProceduralTextures(renderer, { anisotropy: 8 });
    this._floorMat = null;
    this._time = 0;
    this._flickerBase = 1;
  }

  /** Build the PMREM env map, analytic lights, shell geometry and fog. */
  async build() {
    this.scene.add(this._root);
    this._buildEnvMap();
    this._buildLights();
    this._buildShell();
    this.setPreset(this.presetId);
    return this;
  }

  /**
   * Construct the off-screen industrial lighting scene and filter it to a PMREM.
   * @private
   */
  _buildEnvMap() {
    const envScene = new THREE.Scene();

    // Cool overhead sky gradient + warm floor bounce, painted onto a big shell.
    const shellGeo = new THREE.SphereGeometry(12, 24, 16);
    const shellMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x243247) },
        uHorizon: { value: new THREE.Color(0x11151d) },
        uBottom: { value: new THREE.Color(0x1a120a) }
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom;
        void main(){
          float h = vDir.y;
          vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.7, h));
          c = mix(c, uBottom, smoothstep(0.0, -0.5, h));
          gl_FragColor = vec4(c, 1.0);
        }
      `
    });
    envScene.add(new THREE.Mesh(shellGeo, shellMat));

    // Large soft rectangular sources — these give brushed metal its streaks.
    const softbox = (w, h, d, color, intensity, pos, rot) => {
      const mat = new THREE.MeshBasicMaterial({ color });
      mat.color.multiplyScalar(intensity);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(pos[0], pos[1], pos[2]);
      if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
      envScene.add(mesh);
      return mesh;
    };

    // Overhead cold fluorescent strips.
    for (let i = -2; i <= 2; i++) {
      softbox(0.5, 0.06, 6.0, 0xdfeaff, 7.5, [i * 2.4, 6.5, 0], [0, 0, 0]);
    }
    // Big warm side softboxes.
    softbox(0.1, 4.0, 6.0, 0xffdca8, 5.0, [-7.5, 3.0, 0], [0, Math.PI / 2, 0]);
    softbox(0.1, 4.0, 6.0, 0xbfd2ff, 3.5, [7.5, 3.2, 0], [0, -Math.PI / 2, 0]);
    // Warm sodium bounce low behind the machine (discharge glow).
    softbox(6.0, 0.1, 4.0, 0xff8a30, 2.4, [0, 0.1, -4.0], [Math.PI / 2, 0, 0]);
    // Front fill card.
    softbox(6.0, 3.0, 0.1, 0x2a3140, 1.4, [0, 2.5, 7.0], [0, 0, 0]);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromScene(envScene, 0.04);
    this.envMap = rt.texture;
    this._pmrem = pmrem;

    this.scene.environment = this.envMap;

    shellGeo.dispose();
    shellMat.dispose();
    envScene.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }

  /**
   * Analytic lights: a tight shadow-casting key, a cool fill, a warm rim from
   * the chute and two spotlights aimed into the throat.
   * @private
   */
  _buildLights() {
    const shear = SHREDDER.shaftHeight;

    // Key — tight, well-fitted shadow camera around the shredder.
    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    key.position.set(3.4, 5.4, 2.6);
    key.target.position.set(0, shear, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const cam = key.shadow.camera;
    cam.near = 1.5;
    cam.far = 14;
    cam.left = -2.2;
    cam.right = 2.2;
    cam.top = 2.2;
    cam.bottom = -2.2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this._root.add(key, key.target);
    this._lights.key = key;

    // Cool fill — no shadow.
    const fill = new THREE.DirectionalLight(0x8fb2d8, 0.55);
    fill.position.set(-4.0, 2.6, 3.2);
    fill.target.position.set(0, shear, 0);
    this._root.add(fill, fill.target);
    this._lights.fill = fill;

    // Warm rim from the discharge chute (back).
    const rim = new THREE.DirectionalLight(0xff8a3c, 1.6);
    rim.position.set(-1.5, 1.6, -3.6);
    rim.target.position.set(0, shear, 0);
    this._root.add(rim, rim.target);
    this._lights.rim = rim;

    // Ambient bounce so shadow cores are never pure black.
    const hemi = new THREE.HemisphereLight(0x9fb6d4, 0x140f0a, 0.35);
    this._root.add(hemi);
    this._lights.hemi = hemi;

    // Two spotlights aimed into the throat with soft volumetric-looking falloff.
    const throatL = new THREE.SpotLight(0xffe9c8, 6.0, 4.5, Math.PI / 7, 0.6, 1.4);
    throatL.position.set(-0.9, 2.4, 1.1);
    throatL.target.position.set(-0.12, shear, 0);
    this._root.add(throatL, throatL.target);
    const throatR = new THREE.SpotLight(0xffe9c8, 6.0, 4.5, Math.PI / 7, 0.6, 1.4);
    throatR.position.set(0.9, 2.4, 1.1);
    throatR.target.position.set(0.12, shear, 0);
    this._root.add(throatR, throatR.target);
    this._lights.throat = [throatL, throatR];
  }

  /**
   * Factory shell: worn concrete floor + back wall.
   * @private
   */
  _buildShell() {
    const concrete = this._textures.concrete(512);
    concrete.albedo.repeat.set(8, 8);
    concrete.normal.repeat.set(8, 8);
    concrete.orm.repeat.set(8, 8);

    const floorMat = new THREE.MeshStandardMaterial({
      map: concrete.albedo,
      normalMap: concrete.normal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughnessMap: concrete.orm,
      aoMap: concrete.orm,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.5
    });
    this._floorMat = floorMat;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.001;
    floor.receiveShadow = true;
    floor.name = 'FactoryFloor';
    this._root.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x1a1e26,
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: 0.35
    });
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(40, 14), wallMat);
    backWall.position.set(0, 7, -8);
    backWall.receiveShadow = true;
    this._root.add(backWall);

    const sideWall = new THREE.Mesh(new THREE.PlaneGeometry(16, 14), wallMat);
    sideWall.rotation.y = Math.PI / 2;
    sideWall.position.set(-8, 7, 0);
    this._root.add(sideWall);
  }

  /**
   * Switch lighting mood. Adjusts analytic light colours/intensities, fog and
   * background without rebuilding the PMREM.
   * @param {'studio'|'factory'|'dusk'} id
   */
  setPreset(id) {
    const p = PRESETS[id] || PRESETS.factory;
    this.presetId = id in PRESETS ? id : 'factory';

    const L = this._lights;
    if (L.key) {
      L.key.color.set(p.key.color);
      L.key.intensity = p.key.intensity;
    }
    if (L.fill) {
      L.fill.color.set(p.fill.color);
      L.fill.intensity = p.fill.intensity;
    }
    if (L.rim) {
      L.rim.color.set(p.rim.color);
      L.rim.intensity = p.rim.intensity;
    }
    if (L.throat) {
      for (const s of L.throat) {
        s.color.set(p.throat.color);
        s.intensity = p.throat.intensity;
      }
    }
    this._flickerBase = p.throat.intensity;

    this.scene.environmentIntensity = p.envIntensity * this.intensity;
    this.scene.background = new THREE.Color(p.background);
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(p.fog.color, p.fog.density);
    else {
      this.scene.fog.color.set(p.fog.color);
      this.scene.fog.density = p.fog.density;
    }
  }

  /**
   * Overall environment brightness multiplier.
   * @param {number} v
   */
  setIntensity(v) {
    this.intensity = v;
    const p = PRESETS[this.presetId] || PRESETS.factory;
    this.scene.environmentIntensity = p.envIntensity * v;
  }

  /**
   * Subtle fluorescent flicker on the throat spots so the light feels alive.
   * @param {number} dt seconds
   */
  update(dt) {
    this._time += dt;
    const L = this._lights;
    if (L.throat) {
      const flick = 0.97 + 0.03 * Math.sin(this._time * 47.0) * Math.sin(this._time * 13.0);
      for (const s of L.throat) s.intensity = this._flickerBase * flick;
    }
  }

  /** Dispose the PMREM map, generated textures and shell geometry. */
  dispose() {
    if (this._pmrem) this._pmrem.dispose();
    if (this.envMap) this.envMap.dispose();
    this._textures.dispose();
    this._root.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    this.scene.remove(this._root);
    this.scene.environment = null;
  }
}
