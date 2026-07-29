/**
 * CONTRACT (owned by the VFX/Juice sub-agent).
 * GPU-instanced sparks, dust and shrapnel driven by shear/impact events.
 */
export class VFXManager {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.liveSparkCount = 0;
  }
  async build() { return this; }
  update(_dt, _camera) {}
  applyQuality(_preset) {}
  setSize(_w, _h, _dpr) {}
}
