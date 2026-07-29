/**
 * CONTRACT (owned by the UX sub-agent).
 * HUD: power, reverse, conveyor speed, camera presets, spawn menu, stats.
 */
export class UI {
  constructor({ root, app }) {
    this.root = root;
    this.app = app;
  }
  build() {}
  update(_dt) {}
}
