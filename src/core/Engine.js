import * as THREE from 'three';

/**
 * Owns the WebGL context, scene graph root and the main camera.
 * Kept deliberately thin — lighting lives in render/StudioEnvironment.js and
 * the effect chain lives in render/PostFX.js.
 */
export class Engine {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled by the post chain (SMAA)
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04050a);

    this.camera = new THREE.PerspectiveCamera(
      38,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.05,
      160
    );
    this.camera.position.set(3.05, 2.05, 3.35);
    this.camera.lookAt(0, 0.78, 0);

    this.clock = new THREE.Clock();
    /** Consumers push { onResize(w,h,dpr) } here. */
    this.resizeListeners = new Set();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
    }
  }

  get size() {
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight)
    };
  }

  setPixelRatio(ratio) {
    const clamped = Math.min(ratio, window.devicePixelRatio || 1);
    if (Math.abs(clamped - this.renderer.getPixelRatio()) < 0.01) return;
    this.renderer.setPixelRatio(clamped);
    this._onResize();
  }

  _onResize() {
    const { width, height } = this.size;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    const dpr = this.renderer.getPixelRatio();
    for (const listener of this.resizeListeners) {
      listener(width, height, dpr);
    }
  }

  onResize(fn) {
    this.resizeListeners.add(fn);
    return () => this.resizeListeners.delete(fn);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onResize);
    }
    this.renderer.dispose();
  }
}
