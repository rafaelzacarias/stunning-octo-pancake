import * as THREE from 'three';
import './ui/style.css';

import { LAYOUT, SETTINGS } from './config.js';
import { Engine } from './core/Engine.js';
import { PostFX, QUALITY } from './core/PostFX.js';
import { PhysicsBridge } from './physics/PhysicsBridge.js';
import { Factory, createStudioEnvironment } from './env/FactoryEnvironment.js';
import { Shredder, SHAFT_RATIO } from './shredder/Shredder.js';
import { FragmentManager } from './destruction/FragmentManager.js';
import { VFXDirector } from './vfx/VFXDirector.js';
import { CameraDirector, CAMERA_PRESETS } from './camera/CameraDirector.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { GameHUD } from './ui/GameHUD.js';
import { GameDirector } from './game/GameDirector.js';
import { FloatingTextSystem } from './vfx/FloatingText.js';
import { getScrapLibrary, getScrapDef } from './objects/ScrapLibrary.js';
import { getMetalMaterial } from './materials/MetalMaterial.js';
import { updateHeatTime, ensureHeatAttributes } from './materials/HeatShader.js';
import { ThumbnailRenderer } from './ui/ThumbnailRenderer.js';

/**
 * Yield to the browser so the boot overlay can paint between heavy steps.
 *
 * Races requestAnimationFrame against a MessageChannel macrotask. A page
 * loaded in a background tab never fires rAF and clamps chained setTimeout to
 * roughly once per minute, either of which would stall boot indefinitely.
 * MessageChannel is not throttled, so boot always completes; rAF still wins
 * when the tab is visible, which is when we actually want to paint.
 */
const nextFrame = () => new Promise((resolve) => {
  let settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  requestAnimationFrame(finish);
  const ch = new MessageChannel();
  ch.port1.onmessage = finish;
  ch.port2.postMessage(0);
});

class ShreddingSim {
  constructor() {
    this.state = {
      power: false,
      reverse: false,
      conveyor: 0.45,
      quality: 'high',
      timeScale: 1,
      autoFeed: false,
      // Audio starts muted: nothing is allowed to make a sound until the user
      // explicitly switches the audio engine on.
      audioOn: false,
      selectedType: 'can',
      manualQuality: false,
    };
    this.load = 0;
    this.autoFeedTimer = 0;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._downPos = new THREE.Vector2();
    this._adaptTimer = 0;
    this._dynScale = 1;
    // Highest tier the guard is allowed to climb back to (index into
    // ['low','medium','high','ultra']). Raised when the user picks a tier.
    this._qualityCeiling = 2;
    this._headroom = 0;
    this._grindLevel = 0;
  }

  async boot() {
    const container = document.getElementById('app');
    this.engine = new Engine(container);

    const library = getScrapLibrary();
    this.ui = new ControlPanel(document.body, {
      objectTypes: library.map((s) => ({
        id: s.id, label: s.label, hint: s.hint, mass: s.mass,
        value: s.value, category: s.category,
      })),
      cameraPresets: CAMERA_PRESETS.map((p) => ({ id: p.id, label: p.label, key: p.key })),
      qualityLevels: [
        { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' }, { id: 'ultra', label: 'Ultra' },
      ],
      rpmScale: 48,
    }, this._uiCallbacks());
    this.ui.setLoadingProgress(0.04, 'Initialising renderer');
    await nextFrame();

    // ---- environment probe ----
    this.ui.setLoadingProgress(0.14, 'Baking studio environment');
    await nextFrame();
    this.envMap = createStudioEnvironment(this.engine.renderer);
    this.engine.scene.environment = this.envMap;
    this.engine.scene.background = new THREE.Color(0x05070a);
    this.engine.scene.fog = new THREE.FogExp2(0x0a0d12, 0.019);

    // ---- factory ----
    this.ui.setLoadingProgress(0.3, 'Generating factory textures');
    await nextFrame();
    this.factory = new Factory(this.engine.scene, this.state.quality);

    // ---- machine ----
    this.ui.setLoadingProgress(0.52, 'Machining cutter rotors');
    await nextFrame();
    this.shredder = new Shredder(this.engine.scene, this.state.quality);

    // ---- physics ----
    this.ui.setLoadingProgress(0.66, 'Starting physics worker');
    await nextFrame();
    this.physics = new PhysicsBridge();
    await this.physics.init({ gravity: [0, -9.81, 0], fixedDt: 1 / 60, maxSubSteps: 3 });
    this.physics.buildStatic([
      ...this.factory.colliderDescription(),
      ...this.shredder.colliderDescription(),
    ]);
    this.physics.buildShredder({ ...this.shredder.shredderConfig() });
    this.physics.setConveyor({
      enabled: true,
      speed: this.state.conveyor,
      aabb: {
        min: [-LAYOUT.conveyor.halfWidth - 0.1, LAYOUT.conveyor.y - 0.05, LAYOUT.conveyor.endZ - 0.2],
        max: [LAYOUT.conveyor.halfWidth + 0.1, LAYOUT.conveyor.y + 0.9, LAYOUT.conveyor.startZ + 0.3],
      },
      dir: [0, 0, -1],
    });

    // ---- post processing ----
    this.ui.setLoadingProgress(0.78, 'Compiling post-process chain');
    await nextFrame();
    this.postfx = new PostFX(this.engine);
    this.postfx.toggles.ssr = false;

    // ---- vfx + camera + audio ----
    this.ui.setLoadingProgress(0.88, 'Priming particle simulation');
    await nextFrame();
    this.vfx = new VFXDirector(this.engine.scene, this.engine.renderer, this.state.quality);
    this.camera = new CameraDirector(this.engine.camera, this.engine.renderer.domElement, this.postfx);
    this.audio = new AudioEngine();
    this.floaters = new FloatingTextSystem(this.engine.scene, { capacity: 48 });

    // ---- tycoon loop ----
    this.game = new GameDirector({
      onCash: (p) => this._onCash(p),
      onStall: () => {
        this.hud?.toast('MOTOR STALLED — hit the Jam-Buster', 'bad');
        this.ui?.setNotice('Motor stalled', 1800);
      },
      onRecover: () => this.hud?.toast('Rotors clear', 'good'),
      onContractComplete: (c) => this.hud?.toast(`Contract complete: ${c.title}`, 'good'),
      onNotice: (n) => this.hud?.toast(n.message, n.tone),
    });
    this.hud = new GameHUD(document.body, {
      onPurchase: (id) => {
        const r = this.game.purchase(id);
        if (!r.ok) this.hud.toast(r.reason === 'insufficient' ? 'Not enough cash' : 'Fully upgraded', 'warn');
        this._syncHud(true);
      },
      onJamBuster: () => {
        const r = this.game.triggerJamBuster();
        if (!r.ok) this.hud.toast(r.reason === 'cooldown' ? 'Jam-Buster recharging' : 'Already running', 'warn');
        else this.hud.toast('JAM-BUSTER ENGAGED', 'good');
      },
      onReverse: (on) => this._setReverse(on),
    });

    this.fragments = new FragmentManager(
      this.engine.scene, this.physics, this.shredder, this._destructionHooks()
    );
    this.fragments.setQuality(this.state.quality);

    this.physics.onContacts = (view, count, stride) => {
      this.fragments.handleContacts(view, count, stride, this._physDt || 1 / 60);
    };
    this.physics.onRemoved = (ids) => this.fragments.onPhysicsRemoved(ids);

    this.engine.onResize = (w, h) => {
      this.postfx.setSize(w, h);
      this.camera.onResize();
    };

    this._bindInput();

    this.ui.setLoadingProgress(0.96, 'Warming shader cache');
    await nextFrame();
    this.engine.renderer.compile(this.engine.scene, this.engine.camera);
    this.postfx.render(1 / 60, 0);

    this.ui.setLoadingProgress(0.98, 'Rendering item previews');
    await nextFrame();
    this._buildThumbnails();

    this.ui.setLoadingProgress(1, 'Ready');
    await nextFrame();
    this.ui.hideLoading();

    this.ui.showStartGate(() => this._start());
    this._loop();
  }

  async _start() {
    try {
      await this.audio.start();
      this.audio.setMasterVolume(0.72);
      // Graph is live but silenced. The UI audio button is the only thing that
      // lifts the mute, so page load and the seed drops below stay silent.
      this.audio.setMuted(!this.state.audioOn);
    } catch (e) {
      this.ui.setNotice('Audio unavailable in this browser', 3000);
    }
    // Seed the belt so there is something to watch immediately.
    this._spawn('can'); this._spawn('can');
    setTimeout(() => this._spawn('sheet'), 400);
    setTimeout(() => this._spawn('pipe'), 900);
    this._setPower(true);
    this.ui.setPower(true);
    this.ui.setNotice('Shredder online — feed stock on the right', 2600);
  }

  /* ------------------------------------------------------------------ hooks */

  _destructionHooks() {
    return {
      onSpark: (point, normal, intensity, spec, isTear) => {
        this.vfx.spark(point, normal, intensity, spec, isTear);
        if (intensity > 0.35) this.audio.sparkBurst(Math.round(2 + intensity * 8));
      },
      onDust: (point, intensity, spec) => this.vfx.dust(point, intensity, spec),
      onShrapnel: (point, count, spec) => this.vfx.shrapnel(point, count, spec),
      onGrind: (point, intensity) => {
        this._grindLevel = Math.max(this._grindLevel, intensity);
      },
      onImpact: (point, intensity, hardness) => {
        this.audio.impact(intensity, hardness);
        this.vfx.impact(point, intensity);
      },
      onTear: (point, intensity, spec, kind) => {
        this.audio.tear(intensity * (0.6 + spec.hardness * 0.5));
        if (kind === 'chop') this.audio.impact(intensity * 0.7, spec.hardness);
      },
      onDeform: () => {},

      // ---- economy ----
      onItemDestroyed: (evt) => {
        this.game.registerItemDestroyed(evt);
      },
      onFragment: (evt) => {
        this.game.registerFragment(evt);
      },
    };
  }

  /** Cash awarded: float a 3D popup above the throat. */
  _onCash(p) {
    if (!p || !(p.amount > 0)) return;
    const pos = p.position
      ? new THREE.Vector3(p.position.x, p.position.y, p.position.z)
      : new THREE.Vector3(...LAYOUT.throatCenter);
    pos.y = Math.max(pos.y, LAYOUT.shaftY + 0.35);
    const big = p.reason === 'item' || p.reason === 'contract';
    this.floaters?.spawn(
      `+$${p.amount.toFixed(2)}`,
      pos,
      {
        color: p.reason === 'contract' ? '#ffd23f' : big ? '#7CFF9B' : '#9fe8ff',
        scale: big ? 1.25 : 0.72,
        life: big ? 1.6 : 1.0,
      }
    );
  }

  _setReverse(on) {
    this.state.reverse = on;
    this.physics?.setShredder({ reverse: on });
    this.audio?.setReverse(on);
    this.ui?.setReverse(on);
  }

  _uiCallbacks() {
    return {
      onPower: (on) => this._setPower(on),
      onReverse: (on) => {
        this.state.reverse = on;
        this.physics?.setShredder({ reverse: on });
        this.audio?.setReverse(on);
      },
      onConveyorSpeed: (v) => {
        this.state.conveyor = v;
        this.physics?.setConveyor({ speed: v });
        this.audio?.setConveyorSpeed(v);
      },
      onSpawn: (id) => { this.state.selectedType = id; this._spawn(id); },
      onSpawnBurst: (id, n) => {
        this.state.selectedType = id;
        for (let i = 0; i < n; i++) setTimeout(() => this._spawn(id), i * 130);
      },
      onCameraPreset: (id) => this.camera?.apply(id),
      onQuality: (id) => {
        this.state.manualQuality = true;
        this._qualityCeiling = ['low', 'medium', 'high', 'ultra'].indexOf(id);
        this._setQuality(id);
      },
      onAudioToggle: (on) => { this.state.audioOn = on; this.audio?.setMuted(!on); },
      onVolume: (v) => this.audio?.setMasterVolume(v),
      onClear: () => {
        this.fragments?.clear();
        this.ui.setNotice('Debris cleared', 1400);
      },
      onToggleSetting: (key, on) => {
        switch (key) {
          case 'slowmo':
            this.state.timeScale = on ? 0.25 : 1;
            this.physics?.worker.postMessage({ type: 'timeScale', value: this.state.timeScale });
            break;
          case 'autoFeed': this.state.autoFeed = on; break;
          case 'bloom': this.postfx?.setToggle('bloom', on); break;
          case 'dof': this.postfx?.setToggle('dof', on); break;
          case 'ssao': this.postfx?.setToggle('gtao', on); break;
          case 'ssr':
            this.postfx?.setToggle('ssr', on);
            if (on) this.ui.setNotice('SSR is expensive — expect a frame-rate cost', 2600);
            break;
          default: break;
        }
      },
    };
  }

  /* ------------------------------------------------------------------ input */

  _bindInput() {
    const dom = this.engine.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      this._downPos.set(e.clientX, e.clientY);
    });
    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      if (moved > 6) return;   // it was an orbit drag
      this._dropAtPointer(e);
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const lib = getScrapLibrary();
      if (e.code === 'Space') { e.preventDefault(); this._setPower(!this.state.power); this.ui.setPower(this.state.power); }
      else if (e.code === 'KeyR') { const v = !this.state.reverse; this.state.reverse = v; this.physics.setShredder({ reverse: v }); this.audio.setReverse(v); this.ui.setReverse(v); }
      else if (e.code === 'KeyC') { this.fragments.clear(); }
      else if (e.code.startsWith('Digit')) {
        // Items carry their own `key` ('1'..'9','0'); the library is longer
        // than the number row, so the rest are click-only.
        const digit = e.code.slice(5);
        const def = lib.find((d) => d.key === digit);
        if (def) { this.state.selectedType = def.id; this._spawn(def.id); }
      } else if (/^F[1-5]$/.test(e.key)) {
        e.preventDefault();
        const p = CAMERA_PRESETS.find((x) => x.key === e.key);
        if (p) { this.camera.apply(p.id); this.ui.setCameraPreset(p.id); }
      }
    });
  }

  _dropAtPointer(e) {
    const rect = this.engine.renderer.domElement.getBoundingClientRect();
    this._pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._pointer, this.engine.camera);

    const dropY = LAYOUT.hopper.topY + 0.55;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dropY);
    const hit = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(plane, hit)) return;

    const inHopper = Math.abs(hit.x) < LAYOUT.hopper.topHX && Math.abs(hit.z) < LAYOUT.hopper.topHZ + 0.2;
    const onBelt = Math.abs(hit.x) < LAYOUT.conveyor.halfWidth + 0.2 &&
      hit.z > LAYOUT.conveyor.endZ && hit.z < LAYOUT.conveyor.startZ;
    if (!inHopper && !onBelt) return;

    this._spawnAt(this.state.selectedType, hit);
  }

  /* -------------------------------------------------------- item previews */

  /** Assemble a throwaway Object3D that mirrors how an item will look in-world. */
  _previewObject(def) {
    const makeMesh = (materialName, built, offset, rotation) => {
      const geometry = built.geometry;
      // Every metal material is heat-patched and reads these attributes.
      ensureHeatAttributes(geometry, 0, -1000);
      const mesh = new THREE.Mesh(geometry, getMetalMaterial(materialName, this.state.quality));
      if (rotation) mesh.rotation.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
      if (offset) mesh.position.set(offset[0] || 0, offset[1] || 0, offset[2] || 0);
      return mesh;
    };

    if (def.assembly && Array.isArray(def.parts)) {
      const group = new THREE.Group();
      for (const part of def.parts) {
        group.add(makeMesh(part.material, part.build(), part.offset, part.rotation));
      }
      return group;
    }
    return makeMesh(def.material, def.build());
  }

  /**
   * Render one thumbnail per feed-stock item into the palette.
   *
   * This spins up a second WebGL context, so it runs as a single batch and the
   * renderer is torn down immediately afterwards - browsers cap live contexts
   * and the main renderer must never lose its own. Work is spread across
   * frames so the start gate stays responsive while previews stream in.
   */
  async _buildThumbnails() {
    let tr = null;
    try {
      tr = new ThumbnailRenderer({ size: 112, pixelRatio: 2, envMap: this.envMap });
    } catch (e) {
      return;   // previews are a nicety; the cards degrade to their monogram
    }
    const items = getScrapLibrary();
    for (let i = 0; i < items.length; i++) {
      const def = items[i];
      let obj = null;
      try {
        obj = this._previewObject(def);
        const url = tr.render(obj);
        if (url) this.ui.setThumbnail(def.id, url);
      } catch (e) {
        /* skip this one, keep the rest */
      } finally {
        obj?.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      }
      if ((i & 3) === 3) await nextFrame();
    }
    tr.dispose();
  }

  /* ---------------------------------------------------------------- machine */

  _setPower(on) {
    this.state.power = on;
    this.physics?.setShredder({ enabled: on, rpm: 42 });
    this.audio?.setPower(on);
  }

  _setQuality(id) {
    if (!QUALITY[id]) return;
    this.state.quality = id;
    this.postfx.setQuality(id);
    this.vfx.setQuality(id);
    this.fragments.setQuality(id);
    this.factory.setShadowQuality(id);
    this.engine.setRenderScale(QUALITY[id].scale * this._dynScale);
    this.engine.renderer.shadowMap.needsUpdate = true;
    this.ui.setQuality(id);
  }

  _spawn(typeId) {
    const C = LAYOUT.conveyor;
    const pos = new THREE.Vector3(
      (Math.random() - 0.5) * (C.halfWidth * 1.1),
      C.y + 0.28 + Math.random() * 0.1,
      C.startZ - 0.55 - Math.random() * 0.7
    );
    this._spawnAt(typeId, pos);
  }

  _spawnAt(typeId, pos) {
    if (this.fragments.entries.size >= SETTINGS.maxScrapBodies) {
      this.ui.setNotice('Body budget reached — clearing space', 1400);
    }
    const def = getScrapDef(typeId);
    const velocity = new THREE.Vector3(0, -0.3, -0.15);
    if (def.assembly) this.fragments.spawnAssembly(typeId, pos, velocity);
    else this.fragments.spawn(typeId, pos, velocity);
    this.audio?.hydraulicHiss(0.35);
  }

  /* ------------------------------------------------------------------- loop */

  _loop = () => {
    requestAnimationFrame(this._loop);
    const rawDt = this.engine.beginFrame();
    const dt = rawDt * this.state.timeScale;
    this._physDt = 1 / 60;

    // physics -> scene graph
    this.physics.sync(rawDt);
    this.load = this.physics.load;

    // machine
    this.shredder.update(dt, this.physics.shredderAngle, this.state.conveyor, this.state.power);
    this.fragments.rpmNorm = Math.min(1, this.physics.rpm / 42);
    this.fragments.resistanceDivisor = this.game.resistanceDivisor;
    this.fragments.update(dt, this.engine.elapsed);
    this.vfx.update(dt);
    this.floaters.update(dt, this.engine.camera);
    updateHeatTime(this.engine.elapsed);

    // tycoon loop: strain, stalls, upgrades
    this.game.setLoad(this.load);
    this.game.update(rawDt);
    this._applyMachineUpgrades();

    // audio bed
    if (this.audio.isRunning) {
      this.audio.setThroatLoad(this.load);
      this.audio.scrape(this._grindLevel);
      this.audio.update(rawDt, this.engine.camera);
    }
    this._grindLevel *= Math.exp(-rawDt * 9);

    // camera + focus
    this.camera.update(rawDt);

    // auto feed
    if (this.state.autoFeed) {
      this.autoFeedTimer -= dt;
      if (this.autoFeedTimer <= 0) {
        // Back off when the scene is already at its body budget, otherwise the
        // feeder just churns bodies that get culled a moment later.
        this.autoFeedTimer = this.fragments.atCapacity() ? 0.5 : (0.9 + Math.random() * 1.1);
        if (!this.fragments.atCapacity()) {
          const lib = getScrapLibrary();
          this._spawn(lib[Math.floor(Math.random() * lib.length)].id);
        }
      }
    }

    this.postfx.render(rawDt, this.engine.elapsed);
    this.engine.endFrame(rawDt);

    this._updateHud(rawDt);
    this._syncHud(false);
    this._adaptQuality(rawDt);
  };

  /**
   * Push upgrade effects and the stall state into the machine. The rotors are
   * physically halted while stalled, which is what makes the Jam-Buster feel
   * like it is doing something.
   */
  _applyMachineUpgrades() {
    const stalled = this.game.isStalled;
    const shouldRun = this.state.power && !stalled;
    if (shouldRun !== this._rotorsRunning) {
      this._rotorsRunning = shouldRun;
      this.physics.setShredder({ enabled: shouldRun });
    }

    const beltTarget = this.state.conveyor * this.game.conveyorMultiplier;
    if (Math.abs(beltTarget - (this._beltApplied ?? -1)) > 0.01) {
      this._beltApplied = beltTarget;
      this.physics.setConveyor({ speed: Math.min(1, beltTarget) });
    }
  }

  /** HUD refresh. Cheap setters run every frame; lists only when they change. */
  _syncHud(force) {
    if (!this.hud) return;
    this.hud.setCash(this.game.cash);
    this.hud.setStrain(this.game.strain, this.game.isStalled);
    this.hud.setJamBuster(this.game.jamBuster);

    this._hudSlow = (this._hudSlow || 0) + 1;
    if (force || this._hudSlow % 12 === 0) {
      this.hud.setUpgrades(this.game.upgradeState);
      this.hud.setContracts(this.game.contracts);
      this.hud.setStats(this.game.stats);
    }
  }

  _updateHud(dt) {
    this._hudAccum = (this._hudAccum || 0) + dt;
    if (this._hudAccum < 0.1) return;
    this._hudAccum = 0;
    const info = this.engine.renderer.info;
    this.ui.setStats({
      fps: this.engine.fps,
      frameMs: this.engine.frameMs,
      physicsMs: this.physics.stepMs,
      bodies: this.physics.registry.size,
      fragments: this.fragments.stats.fragments,
      triangles: info.render.triangles,
      drawCalls: info.render.calls,
      particles: Math.round(this.vfx.liveEstimate || 0),
    });
    this.ui.setLoad(this.load);
    this.ui.setRPM(Math.min(1, this.physics.rpm / 48));
  }

  /**
   * Keep the frame budget. Resolution is sacrificed first because dropping a
   * quality tier costs SSAO/DoF/AA outright, which is far more visible than a
   * few percent of pixels. Only when resolution is exhausted do we step down.
   */
  _adaptQuality(dt) {
    if (this.state.manualQuality) return;
    this._adaptTimer += dt;
    if (this._adaptTimer < 1.4 || this.engine.elapsed < 5) return;
    this._adaptTimer = 0;

    const fps = this.engine.medianFps();
    const order = ['low', 'medium', 'high', 'ultra'];
    const tier = order.indexOf(this.state.quality);
    const tierScale = QUALITY[this.state.quality].scale;

    if (fps < 57.5) {
      this._headroom = 0;
      if (this._dynScale > 0.66) {
        this._dynScale = Math.max(0.66, this._dynScale - 0.07);
        this._applyRenderScale();
      } else if (tier > 0) {
        this._dynScale = 0.85;
        this._setQuality(order[tier - 1]);
        this._applyRenderScale();
        this.ui.setNotice(`Performance guard: quality → ${order[tier - 1]}`, 2200);
      }
      this.engine._fpsHistory.fill(0);
    } else if (fps > 58.5 && this._dynScale < 1) {
      this._headroom = 0;
      this._dynScale = Math.min(1, this._dynScale + 0.035);
      this._applyRenderScale();
    } else if (fps > 59 && this._dynScale >= 1 && tier < this._qualityCeiling) {
      // Sustained headroom at full resolution: give the tier back. Without
      // this the guard is a one-way ratchet - a brief hitch during load or a
      // background app permanently parks the user on Low.
      this._headroom = (this._headroom || 0) + 1;
      if (this._headroom >= 5) {
        this._headroom = 0;
        this._setQuality(order[tier + 1]);
        this._applyRenderScale();
        this.ui.setNotice(`Headroom available: quality → ${order[tier + 1]}`, 2000);
        this.engine._fpsHistory.fill(0);
      }
    } else {
      this._headroom = 0;
    }
    void tierScale;
  }

  _applyRenderScale() {
    this.engine.setRenderScale(QUALITY[this.state.quality].scale * this._dynScale);
    this.postfx.setSize(window.innerWidth, window.innerHeight);
  }
}

const sim = new ShreddingSim();
sim.boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('app');
  if (el) {
    el.innerHTML = `<pre style="color:#ff6b6b;font:13px ui-monospace,Menlo,monospace;padding:32px;white-space:pre-wrap">
Boot failed:

${err && err.stack ? err.stack : err}
</pre>`;
  }
});

if (import.meta.env?.DEV) window.__sim = sim;
