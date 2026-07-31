import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSRPass } from 'three/examples/jsm/postprocessing/SSRPass.js';

/**
 * Final colour-grade: vignette, lateral chromatic aberration, filmic grain and
 * a gentle contrast/saturation lift. Cheap, and it does most of the work of
 * making a real-time frame read as "captured" rather than "rendered".
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uAberration: { value: 0.0016 },
    uGrain: { value: 0.022 },
    uContrast: { value: 1.055 },
    uSaturation: { value: 1.06 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uAberration, uGrain, uContrast, uSaturation;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Lateral chromatic aberration grows toward the frame edge, like glass.
      vec2 offset = centred * uAberration * (0.35 + r2 * 2.2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + offset).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - offset).b;

      // Vignette
      float vig = 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 1.9);
      col *= vig;

      // Contrast about mid-grey, then saturation
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // Animated film grain, stronger in the shadows where sensors are noisy
      float g = hash12(uv * uResolution + fract(uTime) * 971.0) - 0.5;
      col += g * uGrain * (1.0 - smoothstep(0.0, 0.6, luma));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export const QUALITY = {
  low: { gtao: false, bloom: false, dof: false, smaa: false, grade: true, scale: 0.75, shadow: 1024, bloomStrength: 0 },
  medium: { gtao: false, bloom: true, dof: false, smaa: true, grade: true, scale: 0.9, shadow: 1536, bloomStrength: 0.2 },
  high: { gtao: true, bloom: true, dof: true, smaa: true, grade: true, scale: 1.0, shadow: 2048, bloomStrength: 0.24 },
  ultra: { gtao: true, bloom: true, dof: true, smaa: true, grade: true, scale: 1.0, shadow: 4096, bloomStrength: 0.28 },
};

const _size = new THREE.Vector2();
const _rsize = new THREE.Vector2();

export class PostFX {
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;
    this.scene = engine.scene;
    this.camera = engine.camera;
    this.quality = 'high';
    this.toggles = { bloom: true, gtao: true, dof: true, ssr: false };

    // Last size actually pushed into the chain. setSize() is a no-op unless one
    // of these changes, so the adaptive-resolution guard can call it every
    // frame without reallocating a single render target.
    this._sizeW = 0;
    this._sizeH = 0;
    this._pixelRatio = 0;

    this.composer = new EffectComposer(this.renderer, this._makeTarget());

    this._build();
  }

  _makeTarget() {
    const size = this.renderer.getDrawingBufferSize(_size);
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,      // HDR through the whole chain -> real bloom
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.texture.name = 'PostFX.beauty';
    return target;
  }

  _build() {
    const q = QUALITY[this.quality];
    const size = this.renderer.getSize(_rsize);
    const w = size.x;
    const h = size.y;

    // Tear down the previous chain.
    for (const p of this.composer.passes.slice()) {
      this.composer.removePass(p);
      p.dispose?.();
    }
    this.renderPass = this.ssrPass = this.gtaoPass = this.bloomPass = null;
    this.bokehPass = this.outputPass = this.smaaPass = this.gradePass = null;

    // Size the composer BEFORE the passes exist. addPass() sizes each new pass
    // from the composer's current dimensions, so if those are stale every pass
    // allocates its targets at the wrong resolution and reallocates a moment
    // later — and until the second resize lands, the chain is inconsistent.
    this.setSize(w, h, true);
    const pr = this._pixelRatio;
    const bw = this._sizeW * pr;
    const bh = this._sizeH * pr;

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // SSR renders its own beauty pass, so it stands in for RenderPass rather
    // than stacking on top of it. Expensive: gated to high/ultra + opt-in.
    if (this.toggles.ssr && (this.quality === 'high' || this.quality === 'ultra')) {
      this.renderPass.enabled = false;
      this.ssrPass = new SSRPass({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        width: bw, height: bh,
        groundReflector: null,
        selects: null,
      });
      this.ssrPass.thickness = 0.016;
      this.ssrPass.maxDistance = 3.2;
      this.ssrPass.opacity = 0.55;
      this.ssrPass.blur = true;
      this.composer.addPass(this.ssrPass);
    } else {
      this.renderPass.enabled = true;
      this.ssrPass = null;
    }

    if (q.gtao && this.toggles.gtao) {
      this.gtaoPass = new GTAOPass(this.scene, this.camera, bw, bh);
      this.gtaoPass.output = GTAOPass.OUTPUT.Default;
      this.gtaoPass.updateGtaoMaterial({
        radius: 0.32,
        distanceExponent: 1.6,
        thickness: 0.6,
        scale: 1.15,
        samples: this.quality === 'ultra' ? 24 : 16,
        distanceFallOff: 1.0,
        screenSpaceRadius: false,
      });
      this.gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
      this.gtaoPass.blendIntensity = 1.0;
      this.composer.addPass(this.gtaoPass);
    } else {
      this.gtaoPass = null;
    }

    if (q.bloom && this.toggles.bloom) {
      // Truly selective bloom. Brightly-lit metal peaks around 1.0-1.2 in the
      // HDR buffer, so the threshold sits above that: only sparks, tear-edge
      // incandescence and lamp filaments (2-5) are allowed to glow. Without
      // this, bloom veils the entire frame and everything reads as white.
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(bw, bh), q.bloomStrength, 0.4, 1.35);
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }

    if (q.dof && this.toggles.dof) {
      this.bokehPass = new BokehPass(this.scene, this.camera, {
        focus: 4.2,
        aperture: 0.0006,
        maxblur: 0.0034,
      });
      this.composer.addPass(this.bokehPass);
    } else {
      this.bokehPass = null;
    }

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // SMAA must run before the grade: feeding it film grain makes the edge
    // detector fire on every grain sample and smears them into visible specks.
    if (q.smaa) {
      this.smaaPass = new SMAAPass(bw, bh);
      this.composer.addPass(this.smaaPass);
    } else {
      this.smaaPass = null;
    }

    if (q.grade) {
      this.gradePass = new ShaderPass(GradeShader);
      this.gradePass.material.uniforms.uResolution.value.set(bw, bh);
      this.composer.addPass(this.gradePass);
    } else {
      this.gradePass = null;
    }
  }

  setQuality(id) {
    if (!QUALITY[id] || id === this.quality) return;
    this.quality = id;
    this.engine.setRenderScale(QUALITY[id].scale);
    this._build();
  }

  setToggle(key, on) {
    if (this.toggles[key] === on) return;
    this.toggles[key] = on;
    this._build();
  }

  /** Cinematic focus pull toward a world-space target. */
  setFocus(distance, aperture) {
    if (!this.bokehPass) return;
    const u = this.bokehPass.materialBokeh.uniforms;
    u.focus.value = distance;
    if (aperture !== undefined) u.aperture.value = aperture;
  }

  getFocus() {
    return this.bokehPass ? this.bokehPass.materialBokeh.uniforms.focus.value : 0;
  }

  setBloomStrength(v) {
    if (this.bloomPass) this.bloomPass.strength = v;
  }

  /**
   * Resize the whole chain. Idempotent: if the renderer's size and pixel ratio
   * are unchanged this returns without touching a render target.
   *
   * The RENDERER is the authority, not the arguments: the composer's buffers
   * have to match the drawing buffer, and a caller passing `window.innerWidth`
   * is only right as long as the canvas happens to fill the window. The
   * arguments are accepted for call-site compatibility and used only as a
   * fallback if the renderer reports nothing.
   *
   * Every pass is sized from ONE place — `EffectComposer.setSize()` forwards
   * `width * pixelRatio` to `renderTarget1/2` and to every pass it owns. The
   * passes must therefore NOT be re-sized here at CSS resolution afterwards:
   * doing that leaves GTAO/bloom/bokeh running at a different resolution than
   * the buffers they read and write, which is a classic single-frame black.
   */
  setSize(w, h, force = false) {
    const rs = this.renderer.getSize(_rsize);
    const width = Math.max(1, Math.round(rs.x || w || 1));
    const height = Math.max(1, Math.round(rs.y || h || 1));
    const pr = this.renderer.getPixelRatio();

    const sizeChanged = force || width !== this._sizeW || height !== this._sizeH;
    const ratioChanged = force || pr !== this._pixelRatio;
    if (!sizeChanged && !ratioChanged) return;

    this._sizeW = width;
    this._sizeH = height;
    this._pixelRatio = pr;

    // setPixelRatio() re-runs setSize() internally with the stored dimensions,
    // so ordering it last means the common case (adaptive resolution: ratio
    // changes, window does not) costs exactly one reallocation, not two.
    if (sizeChanged) this.composer.setSize(width, height);
    if (ratioChanged) this.composer.setPixelRatio(pr);

    if (this.gradePass) {
      this.gradePass.material.uniforms.uResolution.value.set(width * pr, height * pr);
    }
  }

  render(dt, elapsed) {
    // A zero-sized drawing buffer (minimise/restore, or a devicePixelRatio
    // change landing between resize and render) means every target in the
    // chain is 0 x 0. Rendering into that produces a black frame at best.
    const buffer = this.renderer.getDrawingBufferSize(_size);
    if (buffer.x < 1 || buffer.y < 1) return;

    // Integrity check: the composer's buffers must match the drawing buffer.
    // If anything resized the renderer without telling us, resync here rather
    // than render a frame through a mismatched chain. The 1px tolerance is
    // required because the drawing buffer is floor(css * pixelRatio) while the
    // composer's targets keep the fractional product — without it a fractional
    // pixel ratio would trigger a reallocation on every single frame.
    const rt = this.composer.renderTarget1;
    if (Math.abs(rt.width - buffer.x) >= 1 || Math.abs(rt.height - buffer.y) >= 1) {
      this.setSize(this._sizeW, this._sizeH, true);
    }

    if (this.gradePass) this.gradePass.material.uniforms.uTime.value = elapsed;
    this.composer.render(dt);
    // EffectComposer.render() restores whatever target was bound on entry; make
    // the post-condition explicit so a pass that throws cannot leave the
    // renderer pointing at an offscreen target for the rest of the frame.
    this.renderer.setRenderTarget(null);
  }

  dispose() {
    for (const p of this.composer.passes) p.dispose?.();
    this.composer.dispose();
  }
}
