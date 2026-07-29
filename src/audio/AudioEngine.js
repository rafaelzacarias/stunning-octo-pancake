/**
 * CONTRACT (owned by the VFX/Juice sub-agent).
 * Fully procedural Web Audio stack: motor hum, scrape, crunch, strain.
 */
export class AudioEngine {
  constructor() {
    this.started = false;
    this.muted = false;
    this.masterVolume = 0.8;
  }
  async start() { this.started = true; }
  suspend() {}
  resume() {}
  update(_dt) {}
  setMasterVolume(v) { this.masterVolume = v; }
  setMuted(v) { this.muted = v; }
}
