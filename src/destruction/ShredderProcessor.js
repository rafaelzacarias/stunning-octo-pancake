/**
 * CONTRACT (owned by the Physics sub-agent).
 * Drives the deform -> yield -> shear pipeline from physics contact events.
 */
export class ShredderProcessor {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.fragmentCount = 0;
  }
  update(_dt) {}
}
