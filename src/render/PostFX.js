import * as THREE from 'three';

/**
 * CONTRACT (owned by the Graphics sub-agent).
 * Owns the EffectComposer chain: render -> SSAO -> SSR -> selective bloom ->
 * DoF -> SMAA -> output.
 */
export class PostFX {
  constructor({ engine, quality }) {
    this.engine = engine;
    this.quality = quality;
    this.focusDistance = 4;
    this.aperture = 0.6;
  }

  async build() { return this; }
  applyQuality(_preset) {}
  setSize(_w, _h, _dpr) {}
  setFocus(distance, aperture = this.aperture) {
    this.focusDistance = distance;
    this.aperture = aperture;
  }
  update(_dt) {}
  render(_dt) {
    this.engine.renderer.render(this.engine.scene, this.engine.camera);
  }
}
