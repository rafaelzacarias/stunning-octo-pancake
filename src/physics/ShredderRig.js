/**
 * CONTRACT (owned by the Physics sub-agent).
 * Twin counter-rotating shafts with interleaved hardened-steel cutter teeth.
 */
export class ShredderRig {
  constructor({ scene, physics, materials }) {
    this.scene = scene;
    this.physics = physics;
    this.materials = materials;
    this.power = false;
    this.throttle = 1;
    this.reverse = false;
    this.load = 0;
    this.rpm = 0;
    this.stalled = false;
    this.toothMeshes = [];
  }

  async build() { return this; }
  update(_dt) {}
  setPower(on) { this.power = on; }
  setThrottle(v) { this.throttle = v; }
  setReverse(v) { this.reverse = v; }
  applyQuality(_preset) {}
  getShearPlaneFor() { return null; }
}
