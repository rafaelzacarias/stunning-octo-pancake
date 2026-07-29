import * as THREE from 'three';

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
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
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

    this.camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 220);
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

    this._onContextLost = (e) => { e.preventDefault(); this.contextLost = true; };
    this.renderer.domElement.addEventListener('webglcontextlost', this._onContextLost);
  }

  get size() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
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
    this.renderer.dispose();
  }
}
