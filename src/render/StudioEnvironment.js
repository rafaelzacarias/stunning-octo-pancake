import * as THREE from 'three';

/**
 * CONTRACT (owned by the Graphics sub-agent).
 * Builds the procedural HDRI studio: a PMREM environment map plus the physical
 * key/fill/rim rig and the factory shell geometry.
 */
export class StudioEnvironment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.envMap = null;
    this.intensity = 1;
  }

  async build() {
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, 5, 2);
    this.scene.add(light);
    this.scene.add(new THREE.HemisphereLight(0x9fb6d4, 0x1a1712, 0.6));
    return this;
  }

  setIntensity(v) { this.intensity = v; }
  update(_dt) {}
  dispose() {}
}
