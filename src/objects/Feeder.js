/**
 * CONTRACT (owned by the Physics sub-agent).
 * Conveyor belt + drop zone that feeds scrap into the shredder throat.
 */
export class Feeder {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.conveyorSpeed = 0.5;
    this.autoFeed = false;
  }
  async build() { return this; }
  update(_dt) {}
  spawn(_typeId) { return null; }
  setConveyorSpeed(v) { this.conveyorSpeed = v; }
  setAutoFeed(v) { this.autoFeed = v; }
  clearAll() {}
}
