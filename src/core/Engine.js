import * as THREE from 'three';
import { DEVICE } from './DeviceProfile.js';

/**
 * Engine — renderer, scene, camera and frame-timing spine.
 * Owns the adaptive-resolution controller that keeps the frame budget locked.
 */
export class Engine {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,           // handled by SMAA in the composer
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      logarithmicDepthBuffer: false,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // A phone panel is dense enough that 1.5x is indistinguishable from 3x,
    // and every full-screen render target scales with the SQUARE of this
    // number. At DPR 3 the composer chain alone would cost 4x what it does
    // at 1.5 for no perceptible gain.
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, DEVICE.maxPixelRatio);
    this.renderScale = 1;
    this.renderer.setPixelRatio(this.maxPixelRatio);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('sio-canvas');

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    // Clip planes are as tight as the content allows: the room is 28 x 32 x 8.4
    // and the orbit rig never gets further than 24 m from its target, so the
    // longest sight line is ~45 m. Going from 0.05-220 to 0.1-100 cuts the
    // far/near ratio from 4400 to 1000, which is what keeps GTAO, DoF and the
    // shadow comparisons from banding on the cutter teeth.
    this.camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(3.6, 2.5, 4.4);

    this.clock = new THREE.Clock();
    this.elapsed = 0;

    // Frame timing
    this.fps = 60;
    this.frameMs = 16.7;
    this._frames = 0;
    this._accum = 0;
    this._fpsHistory = new Float32Array(90);
    this._fpsIndex = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    // Mobile browsers drop the WebGL context routinely — on memory pressure,
    // on backgrounding, on a GPU process restart. Without preventDefault() the
    // context can never come back, and without a restore handler the app is a
    // permanently black canvas. Both halves are required.
    this.contextLost = false;
    this.onContextRestored = null;
    this._onContextLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
    };
    this._onContextRestored = () => {
      this.contextLost = false;
      // Everything GPU-side was destroyed with the context. three re-uploads
      // geometry, textures and programs lazily, but the render targets and
      // sizes have to be re-pushed explicitly.
      this.resize();
      this.onContextRestored?.();
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this._onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this._onContextRestored);
  }

  get size() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  resize() {
    // A minimised window reports 0: 0/0 is NaN, and a NaN projection matrix
    // culls the entire scene, which shows up as a black frame on restore.
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(this.maxPixelRatio * this.renderScale);
    this.onResize?.(w, h);
  }

  setRenderScale(scale) {
    const s = THREE.MathUtils.clamp(scale, 0.6, 1);
    if (Math.abs(s - this.renderScale) < 0.01) return;
    this.renderScale = s;
    this.renderer.setPixelRatio(this.maxPixelRatio * s);
    this.onResize?.(window.innerWidth, window.innerHeight);
  }

  beginFrame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += dt;
    this.renderer.info.reset();
    return dt;
  }

  endFrame(dt) {
    this._accum += dt;
    this._frames++;
    if (this._accum >= 0.25) {
      this.fps = this._frames / this._accum;
      this.frameMs = (this._accum * 1000) / this._frames;
      this._accum = 0;
      this._frames = 0;
      this._fpsHistory[this._fpsIndex++ % this._fpsHistory.length] = this.fps;
    }
  }

  /** Median FPS over the recent window — resistant to single-frame spikes. */
  medianFps() {
    const vals = Array.from(this._fpsHistory).filter((v) => v > 0);
    if (!vals.length) return 60;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this._onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.renderer.dispose();
  }
}
