import * as THREE from 'three';

import { Engine } from './core/Engine.js';
import { PerfMonitor } from './core/PerfMonitor.js';
import { QualityManager } from './core/QualityManager.js';
import { bus } from './core/EventBus.js';
import { EVENTS, PHYSICS, SHREDDER } from './core/Constants.js';

import { StudioEnvironment } from './render/StudioEnvironment.js';
import { PostFX } from './render/PostFX.js';
import { MaterialLibrary } from './materials/MetalMaterial.js';

import { PhysicsClient } from './physics/PhysicsClient.js';
import { ShredderRig } from './physics/ShredderRig.js';
import { ShredderProcessor } from './destruction/ShredderProcessor.js';
import { Feeder } from './objects/Feeder.js';

import { VFXManager } from './vfx/VFXManager.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { CameraRig } from './ux/CameraRig.js';
import { UI } from './ux/UI.js';

const boot = {
  root: document.getElementById('boot'),
  bar: document.getElementById('boot-bar'),
  stage: document.getElementById('boot-stage'),
  error: document.getElementById('boot-error')
};

function progress(pct, label) {
  if (boot.bar) boot.bar.style.width = `${Math.round(pct * 100)}%`;
  if (boot.stage && label) boot.stage.textContent = label;
}

function fail(err) {
  console.error(err);
  if (boot.error) {
    boot.error.hidden = false;
    boot.error.textContent = `${err?.message || err}`;
  }
  if (boot.stage) boot.stage.textContent = 'Startup failed';
}

/**
 * The application root. Wires every subsystem together and owns the frame loop.
 */
class App {
  constructor() {
    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('viewport'));
    this.engine = new Engine(this.canvas);
    this.perf = new PerfMonitor();
    this.quality = new QualityManager(this.perf, { initial: 'high', auto: true });

    this.running = false;
    this._accum = 0;
    this._lastTime = 0;
    this._raf = 0;
    this._frame = 0;
  }

  async init() {
    const { engine } = this;

    progress(0.06, 'Building studio environment…');
    this.environment = new StudioEnvironment(engine.renderer, engine.scene);
    await this.environment.build();

    progress(0.2, 'Compiling metal shaders…');
    this.materials = new MaterialLibrary(engine.renderer, {
      environment: this.environment,
      textureSize: this.quality.preset.textureSize,
      anisotropy: Math.min(engine.maxAnisotropy, this.quality.preset.anisotropicFiltering)
    });
    await this.materials.build();

    progress(0.34, 'Starting physics worker…');
    this.physics = new PhysicsClient();
    await this.physics.init({
      gravity: PHYSICS.gravity,
      fixedDt: PHYSICS.fixedDt,
      maxBodies: PHYSICS.maxBodies
    });

    progress(0.5, 'Assembling shredder rig…');
    this.rig = new ShredderRig({
      scene: engine.scene,
      physics: this.physics,
      materials: this.materials
    });
    await this.rig.build();

    progress(0.62, 'Loading scrap library…');
    this.feeder = new Feeder({
      scene: engine.scene,
      physics: this.physics,
      materials: this.materials,
      rig: this.rig
    });
    await this.feeder.build();

    progress(0.72, 'Arming destruction solver…');
    this.processor = new ShredderProcessor({
      scene: engine.scene,
      physics: this.physics,
      materials: this.materials,
      rig: this.rig,
      feeder: this.feeder
    });

    progress(0.8, 'Igniting particle systems…');
    this.vfx = new VFXManager({
      scene: engine.scene,
      renderer: engine.renderer,
      camera: engine.camera,
      maxSparks: this.quality.preset.maxSparks
    });
    await this.vfx.build();

    progress(0.88, 'Tuning post-processing…');
    this.postfx = new PostFX({
      engine,
      quality: this.quality
    });
    await this.postfx.build();

    progress(0.93, 'Calibrating camera…');
    this.cameraRig = new CameraRig({
      camera: engine.camera,
      domElement: this.canvas,
      postfx: this.postfx,
      scene: engine.scene
    });

    this.audio = new AudioEngine();

    progress(0.98, 'Wiring controls…');
    this.ui = new UI({
      root: document.getElementById('ui-root'),
      app: this
    });
    this.ui.build();

    engine.onResize((w, h, dpr) => {
      this.postfx.setSize(w, h, dpr);
      this.vfx.setSize(w, h, dpr);
    });

    bus.on(EVENTS.QUALITY_CHANGED, ({ preset }) => this._applyQuality(preset));
    this._applyQuality(this.quality.presetName);

    // Warm the shader cache so the first shred does not hitch.
    engine.renderer.compile(engine.scene, engine.camera);
    progress(1, 'Ready');
    return this;
  }

  _applyQuality(presetName) {
    const preset = this.quality.preset;
    this.engine.setPixelRatio(preset.pixelRatio);
    this.postfx?.applyQuality(preset);
    this.vfx?.applyQuality(preset);
    this.rig?.applyQuality?.(preset);
    this.materials?.applyQuality?.(preset);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(loop);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio?.suspend();
      } else {
        this._lastTime = performance.now();
        this.audio?.resume();
      }
    });
  }

  _tick(now) {
    const rawDt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    // Clamp so a background-tab stall never explodes the simulation.
    const dt = Math.min(rawDt, 0.05);
    this._frame++;

    this.perf.sample(rawDt);
    this.quality.update(rawDt);

    // 1. Physics: pull the newest transform stream from the worker and push
    //    the current motor state back to it.
    this.physics.beginFrame(dt);
    this.rig.update(dt, this.physics);

    // 2. Destruction: consume contact events, apply plastic deformation and
    //    perform mesh shearing where the tooth pressure exceeded ultimate.
    this.processor.update(dt);

    // 3. Feed stock / conveyor motion.
    this.feeder.update(dt);

    // 4. Apply transforms to visual meshes.
    this.physics.applyTransforms();

    // 5. Juice.
    this.vfx.update(dt, this.engine.camera);
    this.audio.update(dt);

    // 6. Camera + effects.
    this.cameraRig.update(dt);
    this.postfx.update(dt);

    this.engine.renderer.info.reset();
    this.postfx.render(dt);

    const info = this.engine.renderer.info;
    this.perf.extra.drawCalls = info.render.calls;
    this.perf.extra.tris = info.render.triangles;
    this.perf.extra.bodies = this.physics.bodyCount;
    this.perf.extra.fragments = this.processor.fragmentCount;
    this.perf.extra.sparks = this.vfx.liveSparkCount;
  }

  /** Resumes the AudioContext — must happen inside a user gesture. */
  async engage() {
    await this.audio.start();
    this.rig.setPower(true);
  }
}

async function main() {
  try {
    const app = new App();
    window.__shredder = app; // handy for the QA harness + debugging
    await app.init();
    app.start();

    boot.root?.classList.add('hidden');

    const gate = document.getElementById('start-gate');
    const button = document.getElementById('start-button');
    gate?.classList.remove('hidden');
    const engage = async () => {
      gate?.classList.add('hidden');
      await app.engage();
    };
    button?.addEventListener('click', engage, { once: true });
  } catch (err) {
    fail(err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}

export { App, THREE, SHREDDER };
