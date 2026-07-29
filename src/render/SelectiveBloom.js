import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LAYER } from '../core/Constants.js';
import { setShearHeatBloomPass } from '../materials/ShearHeatShader.js';

/**
 * Two-pass selective bloom.
 *
 * The scene is rendered a second time with every non-bloom object blacked out;
 * only objects on {@link LAYER}.BLOOM (sparks, warning lamps) keep their real
 * material and shear-heat materials output ONLY their emissive contribution
 * (via the `uBloomPass` uniform). {@link UnrealBloomPass} blurs that mask and it
 * is additively composited over the beauty buffer with {@link #makeCombinePass}.
 * This prevents the classic amateur look of the whole bright metal scene
 * blooming.
 */
export class SelectiveBloom {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {Object} [opts]
   * @param {number} [opts.strength=0.9]
   * @param {number} [opts.radius=0.5]
   * @param {number} [opts.threshold=0.0]
   */
  constructor(renderer, scene, camera, { strength = 0.9, radius = 0.5, threshold = 0.0 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this._black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this._stash = new Map();
    this._hidden = [];

    this._renderPass = new RenderPass(scene, camera);
    this._renderPass.clearColor = new THREE.Color(0x000000);
    this._renderPass.clearAlpha = 1;

    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      strength,
      radius,
      threshold
    );

    this.composer = new EffectComposer(renderer);
    this.composer.renderToScreen = false;
    this.composer.addPass(this._renderPass);
    this.composer.addPass(this._bloomPass);
  }

  get strength() {
    return this._bloomPass.strength;
  }
  set strength(v) {
    this._bloomPass.strength = v;
  }

  /** The blurred bloom-mask texture (stable reference across frames). */
  get texture() {
    return this.composer.renderTarget2.texture;
  }

  /** @private Replace every non-bloom object's contribution with black. */
  _darken() {
    this._stash.clear();
    this._hidden.length = 0;
    this._bg = this.scene.background;
    this.scene.background = null;
    setShearHeatBloomPass(true);

    this.scene.traverse((obj) => {
      if (!obj.material) return;
      const mat = obj.material;
      if (mat.userData && mat.userData.shearHeat) return; // emits only heat
      if (obj.layers.isEnabled(LAYER.BLOOM)) return; // genuine bloom source
      if (obj.isMesh) {
        this._stash.set(obj, mat);
        obj.material = this._black;
      } else {
        this._hidden.push(obj);
        obj.visible = false;
      }
    });
  }

  /** @private Undo {@link _darken}. */
  _restore() {
    for (const [obj, mat] of this._stash) obj.material = mat;
    for (const obj of this._hidden) obj.visible = true;
    this._stash.clear();
    this._hidden.length = 0;
    setShearHeatBloomPass(false);
    this.scene.background = this._bg;
  }

  /** Render the bloom mask for this frame. */
  render() {
    if (!this.enabled) return;
    this._darken();
    this.composer.render();
    this._restore();
  }

  /**
   * A {@link ShaderPass} that additively composites the bloom texture over the
   * beauty buffer. Insert it into the main composer chain.
   * @param {number} [strength=1]
   * @returns {ShaderPass}
   */
  makeCombinePass(strength = 1) {
    const pass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          bloomTexture: { value: this.texture },
          uStrength: { value: strength }
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform sampler2D tDiffuse;
          uniform sampler2D bloomTexture;
          uniform float uStrength;
          void main(){
            vec4 base = texture2D(tDiffuse, vUv);
            vec4 bloom = texture2D(bloomTexture, vUv);
            gl_FragColor = base + uStrength * bloom;
          }
        `
      })
    );
    this._combinePass = pass;
    return pass;
  }

  /** @param {number} w @param {number} h @param {number} dpr */
  setSize(w, h, dpr) {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    // Rebind the (recreated) mask texture on the combine pass.
    if (this._combinePass) this._combinePass.uniforms.bloomTexture.value = this.texture;
  }

  dispose() {
    this.composer.dispose();
    this._black.dispose();
  }
}
