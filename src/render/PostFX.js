import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SelectiveBloom } from './SelectiveBloom.js';

/**
 * The full AAA post-processing chain:
 *
 *   RenderPass -> GTAO (contact SSAO) -> SSR (polished-floor reflections)
 *   -> selective bloom combine -> DoF (Bokeh) -> SMAA -> filmic grade
 *   -> OutputPass (tone map + colour space).
 *
 * All internal buffers are `HalfFloatType` (EffectComposer default) to avoid
 * banding. Expensive passes (SSR, DoF) are half-res / disabled on lower presets
 * and {@link #applyQuality} genuinely reclaims their cost.
 */

/** Filmic grade: chromatic aberration + vignette + film grain + lens-dirt streak. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uCA: { value: 0.0015 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.045 },
    uDirt: { value: 0.12 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uCA;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uDirt;

    float hash(vec2 p){
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r = length(c);

      // Chromatic aberration scaling toward the frame edges.
      vec2 dir = c * r * uCA * 2.0;
      float cr = texture2D(tDiffuse, uv - dir).r;
      vec4 cg = texture2D(tDiffuse, uv);
      float cb = texture2D(tDiffuse, uv + dir).b;
      vec3 col = vec3(cr, cg.g, cb);

      // Vignette.
      float vig = smoothstep(0.9, 0.35, r);
      col *= mix(1.0, vig, uVignette);

      // Subtle lens-dirt streak that only shows where the image is bright.
      float streak = smoothstep(0.6, 1.0, hash(vec2(floor(uv.x * 40.0), 3.0)));
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += streak * uDirt * smoothstep(0.6, 1.4, lum);

      // Animated film grain.
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, cg.a);
    }
  `
};

export class PostFX {
  /**
   * @param {Object} ctx
   * @param {import('../core/Engine.js').Engine} ctx.engine
   * @param {import('../core/QualityManager.js').QualityManager} ctx.quality
   */
  constructor({ engine, quality }) {
    this.engine = engine;
    this.quality = quality;
    this.renderer = engine.renderer;
    this.scene = engine.scene;
    this.camera = engine.camera;

    this.focusDistance = 4;
    this.aperture = 0.6;
    this._apertureScale = 0.0016;
    this._time = 0;
    this.exposure = this.renderer.toneMappingExposure;
  }

  /** Build the composer and every pass. */
  async build() {
    const { renderer, scene, camera } = this;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.composer = new EffectComposer(renderer);

    this.renderPass = new RenderPass(scene, camera);

    // --- GTAO: subtle, contact-focused ambient occlusion. -----------------
    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.9;
    this.gtao.updateGtaoMaterial({
      radius: 0.22,
      distanceExponent: 1.0,
      thickness: 1.0,
      scale: 1.0,
      samples: this.quality.preset.ssaoSamples,
      distanceFallOff: 1.0,
      screenSpaceRadius: false
    });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 8 });

    // --- SSR: wet/polished floor + machine reflections (half res). --------
    this.ssr = new SSRPass({
      renderer,
      scene,
      camera,
      width: Math.max(2, Math.floor(size.x * 0.5)),
      height: Math.max(2, Math.floor(size.y * 0.5)),
      groundReflector: null,
      selects: null
    });
    this.ssr.thickness = 0.02;
    this.ssr.opacity = 0.55;
    this.ssr.maxDistance = 3.0;
    this.ssr.blur = true;

    // --- Selective bloom (hot shear edges / sparks / lamps only). ---------
    this.bloom = new SelectiveBloom(renderer, scene, camera, {
      strength: 0.85,
      radius: 0.55,
      threshold: 0.0
    });
    this.bloomCombine = this.bloom.makeCombinePass(1.0);

    // --- DoF: cinematic, driven by setFocus. ------------------------------
    this.bokeh = new BokehPass(scene, camera, {
      focus: this.focusDistance,
      aperture: this.aperture * this._apertureScale,
      maxblur: 0.01
    });

    // --- SMAA (renderer created with antialias:false on purpose). ---------
    this.smaa = new SMAAPass();

    // --- Filmic grade + Output. -------------------------------------------
    this.grade = new ShaderPass(GradeShader);
    this.output = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtao);
    this.composer.addPass(this.ssr);
    this.composer.addPass(this.bloomCombine);
    this.composer.addPass(this.bokeh);
    this.composer.addPass(this.smaa);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);

    this.applyQuality(this.quality.preset);
    return this;
  }

  /**
   * Enable/disable passes and resize expensive targets for a preset without
   * leaking GPU memory.
   * @param {import('../core/Constants.js').QUALITY_PRESETS[keyof typeof import('../core/Constants.js').QUALITY_PRESETS]} preset
   */
  applyQuality(preset) {
    if (!preset || !this.composer) return;

    this.gtao.enabled = !!preset.ssao;
    if (preset.ssao) {
      this.gtao.updateGtaoMaterial({ samples: preset.ssaoSamples });
    }

    this.ssr.enabled = !!preset.ssr;
    this.bloom.enabled = !!preset.bloom;
    this.bloomCombine.enabled = !!preset.bloom;
    this.bokeh.enabled = !!preset.dof;

    // Stronger, wider bloom on higher tiers.
    this.bloom.strength = preset.bloom ? (preset.ssr ? 0.9 : 0.75) : 0;
  }

  /**
   * Resize the composer, bloom composer and every pass. Disposes the old
   * internal targets in the process (EffectComposer.setSize recreates them).
   * @param {number} w CSS width
   * @param {number} h CSS height
   * @param {number} dpr device pixel ratio
   */
  setSize(w, h, dpr) {
    if (!this.composer) return;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);

    const bw = Math.max(2, Math.floor(w * dpr));
    const bh = Math.max(2, Math.floor(h * dpr));
    this.gtao.setSize(bw, bh);
    this.ssr.setSize(Math.max(2, Math.floor(bw * 0.5)), Math.max(2, Math.floor(bh * 0.5)));
    this.bokeh.setSize(bw, bh);
    this.smaa.setSize(bw, bh);
    this.bloom.setSize(w, h, dpr);
    this.bloomCombine.uniforms.bloomTexture.value = this.bloom.texture;
  }

  /**
   * Camera agent hook: set the DoF focus distance (world units) and aperture.
   * @param {number} distance
   * @param {number} [aperture]
   */
  setFocus(distance, aperture = this.aperture) {
    this.focusDistance = distance;
    this.aperture = aperture;
    if (this.bokeh) {
      this.bokeh.uniforms.focus.value = distance;
      this.bokeh.uniforms.aperture.value = aperture * this._apertureScale;
    }
  }

  /** Overall bloom intensity. @param {number} v */
  setBloomStrength(v) {
    if (this.bloom) this.bloom.strength = v;
  }

  /** Advance animated uniforms. @param {number} dt */
  update(dt) {
    this._time += dt;
    if (this.grade) this.grade.uniforms.uTime.value = this._time;
    this.renderer.toneMappingExposure = this.exposure;
  }

  /**
   * Render the frame. main.js calls only this. Renders the selective-bloom
   * mask first, then the full beauty chain.
   * @param {number} _dt
   */
  render(_dt) {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.bloom.enabled) this.bloom.render();
    this.composer.render();
  }

  /** Dispose the composer, bloom and all pass render targets. */
  dispose() {
    if (this.composer) this.composer.dispose();
    if (this.bloom) this.bloom.dispose();
    if (this.gtao && this.gtao.dispose) this.gtao.dispose();
    if (this.ssr && this.ssr.dispose) this.ssr.dispose();
    if (this.smaa && this.smaa.dispose) this.smaa.dispose();
  }
}
