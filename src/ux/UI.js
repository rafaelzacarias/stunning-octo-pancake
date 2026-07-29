import * as THREE from 'three';

import './ui.css';
import { bus } from '../core/EventBus.js';
import { EVENTS, CAMERA_PRESETS, QUALITY_PRESETS, SHREDDER } from '../core/Constants.js';
import { QUALITY_ORDER } from '../core/QualityManager.js';
import { SCRAP_TYPES } from '../objects/ScrapLibrary.js';
import { Hotkeys } from './Hotkeys.js';

/** Fallback scrap ids if the ScrapLibrary has not populated yet. */
const FALLBACK_SCRAP = [
  { id: 'can', label: 'Drinks Can', metal: 'aluminium' },
  { id: 'beam', label: 'I-Beam', metal: 'steel' },
  { id: 'pipe', label: 'Pipe', metal: 'stainless' },
  { id: 'engineBlock', label: 'Engine Block', metal: 'castIron' },
  { id: 'plate', label: 'Plate', metal: 'steel' },
  { id: 'bar', label: 'Round Bar', metal: 'copper' }
];

/**
 * Tiny hyperscript helper. Builds real DOM nodes — never uses innerHTML, so no
 * value can ever be injected as markup.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...(Node|string|null)} kids
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const key in attrs) {
    const v = attrs[key];
    if (v == null || v === false) continue;
    if (key === 'class') node.className = v;
    else if (key === 'text') node.textContent = v;
    else if (key === 'onClick') node.addEventListener('click', v);
    else if (key === 'onInput') node.addEventListener('input', v);
    else if (key === 'onChange') node.addEventListener('change', v);
    else if (key === 'onPointerDown') node.addEventListener('pointerdown', v);
    else if (v === true) node.setAttribute(key, '');
    else node.setAttribute(key, v);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/**
 * The heads-up display: every player-facing control plus live telemetry.
 * The HUD is entirely event-driven (no per-frame work): stats come from the
 * ~4 Hz {@link EVENTS.STATS} bus event and the load gauge from
 * {@link EVENTS.MOTOR_LOAD}. DOM is only written when a value actually changes.
 */
export class UI {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root  Mount point (#ui-root).
   * @param {import('../main.js').App} opts.app
   */
  constructor({ root, app }) {
    this.root = root;
    this.app = app;

    // --- control state (single source of truth) -----------------------
    // Power defaults ON: the start-gate's engage() turns the rig on before the
    // HUD becomes interactive (the gate overlays the HUD until dismissed).
    this._power = true;
    this._reverse = false;
    this._throttle = 1.0;
    this._conveyor = 0.5;
    this._autoFeed = false;
    this._muted = false;
    this._volume = 0.8;
    this._hudHidden = false;
    this._cinematic = false;

    this._presets = Object.values(CAMERA_PRESETS);
    this._scrap = this._normaliseScrap(SCRAP_TYPES);
    this._selectedScrap = this._scrap[0] ? this._scrap[0].id : 'can';

    /** @type {Map<string, HTMLElement>} */
    this._refs = new Map();
    /** Cached last-rendered strings so we never write unchanged DOM. */
    this._last = {};

    this._hotkeys = new Hotkeys({ ui: this });

    // Pointer bookkeeping for click-to-drop vs. orbit disambiguation.
    this._ptr = { id: -1, x: 0, y: 0, t: 0, moved: false };
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._dropPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SHREDDER.hopperTop);
    this._hit = new THREE.Vector3();

    this._offStats = null;
    this._offMotor = null;
    this._offQuality = null;
    this._disposed = false;
  }

  /** Construct the HUD, wire events, sync initial control state. */
  build() {
    if (this.hud || this._disposed) return; // idempotent / post-dispose guard
    const hud = el('div', { class: 'msx-hud', role: 'region', 'aria-label': 'Shredder controls' });
    this.hud = hud;

    hud.append(this._buildTopBar());
    hud.append(this._buildLeftPanel());
    hud.append(this._buildRightPanel());
    hud.append(this._buildHelp());

    this.root?.append(hud);

    this._bindViewportPointer();
    this._hotkeys.attach();

    // Bus subscriptions (defensive: payloads may be partial early on).
    this._offStats = bus.on(EVENTS.STATS, (s) => this._renderStats(s));
    this._offMotor = bus.on(EVENTS.MOTOR_LOAD, (m) => this._renderLoad(m));
    this._offQuality = bus.on(EVENTS.QUALITY_CHANGED, (q) => this._syncQuality(q));

    // Push initial control values to the (possibly still-loading) subsystems.
    this._apply('rig', (r) => { r.setPower?.(this._power); r.setThrottle?.(this._throttle); });
    this._apply('feeder', (f) => f.setConveyorSpeed?.(this._conveyor));
    this._syncPowerButton();
    this._applyHudVisibility(); // reflect any visibility set before build()
  }

  /* ================================================================== *
   *  Layout builders
   * ================================================================== */

  /** @private */
  _buildTopBar() {
    const hudBtn = el('button', {
      class: 'msx-btn', type: 'button', 'aria-pressed': 'false',
      'aria-label': 'Hide HUD (H)', title: 'Hide HUD (H)', text: 'Hide',
      onClick: () => this.toggleHud()
    });
    this._refs.set('hudBtn', hudBtn);

    const cine = el('button', {
      class: 'msx-btn', type: 'button', 'aria-pressed': 'false',
      'aria-label': 'Cinematic camera (K)', title: 'Cinematic camera (K)', text: 'Cinematic',
      onClick: () => this.toggleCinematic()
    });
    this._refs.set('cineBtn', cine);

    return el('div', { class: 'msx-fab' }, hudBtn, cine);
  }

  /** @private */
  _buildLeftPanel() {
    const power = el('button', {
      class: 'msx-btn msx-power msx-btn--wide', type: 'button', 'aria-pressed': 'true',
      'aria-label': 'Shredder power (Space)', title: 'Power (Space)',
      onClick: () => this.togglePower()
    }, el('span', { class: 'msx-led', 'aria-hidden': 'true' }), el('span', { text: 'Power' }));
    this._refs.set('power', power);

    const reverse = el('button', {
      class: 'msx-btn msx-btn--danger msx-btn--wide', type: 'button', 'aria-pressed': 'false',
      'aria-label': 'Reverse gear (hold R)', title: 'Reverse (hold R)', text: 'Reverse',
      onClick: () => this.toggleReverse()
    });
    this._refs.set('reverse', reverse);

    const drive = this._group('Drive', el('div', { class: 'msx-row' }, power), el('div', { class: 'msx-row' }, reverse),
      this._slider('throttle', 'Motor throttle', this._throttle, (v) => this.setThrottle(v)),
      this._slider('conveyor', 'Conveyor speed', this._conveyor, (v) => this.setConveyor(v))
    );

    // Camera presets 1..5.
    const camRow = el('div', { class: 'msx-row--grid' });
    this._presets.forEach((p, i) => {
      const b = el('button', {
        class: 'msx-btn', type: 'button', 'aria-pressed': i === 0 ? 'true' : 'false',
        'aria-label': `${p.label} camera (${i + 1})`, title: `${p.label} (${i + 1})`,
        text: p.label, onClick: () => this.cameraPreset(p.id)
      });
      this._refs.set(`cam:${p.id}`, b);
      camRow.append(b);
    });
    const camera = this._group('Camera', camRow);

    // Scrap palette.
    const palette = el('div', { class: 'msx-row--grid' });
    for (const s of this._scrap) {
      const b = el('button', {
        class: 'msx-btn', type: 'button', 'aria-pressed': s.id === this._selectedScrap ? 'true' : 'false',
        'aria-label': `Select ${s.label} (${s.metal})`, title: `${s.label} — ${s.metal}`,
        onClick: () => this.selectScrap(s.id)
      }, el('span', { text: s.label }));
      this._refs.set(`scrap:${s.id}`, b);
      palette.append(b);
    }
    const autoFeed = el('button', {
      class: 'msx-btn', type: 'button', 'aria-pressed': 'false',
      'aria-label': 'Auto-feed (A)', title: 'Auto-feed (A)', text: 'Auto-feed',
      onClick: () => this.toggleAutoFeed()
    });
    this._refs.set('autoFeed', autoFeed);
    const clear = el('button', {
      class: 'msx-btn', type: 'button',
      'aria-label': 'Clear all scrap (C)', title: 'Clear all (C)', text: 'Clear',
      onClick: () => this.clearAll()
    });
    const dropBtn = el('button', {
      class: 'msx-btn', type: 'button',
      'aria-label': 'Drop selected scrap (F)', title: 'Drop selected (F)', text: 'Drop',
      onClick: () => this.spawnSelected()
    });
    const feed = this._group('Feed stock', palette, el('div', { class: 'msx-row' }, dropBtn, autoFeed, clear),
      el('div', { class: 'msx-legend', text: 'Tip: click the hopper to drop the selected scrap.' }));

    const body = el('div', { class: 'msx-body' }, drive, camera, feed);
    return el('div', { class: 'msx-panel msx-panel--left' },
      el('div', { class: 'msx-hdr' }, el('strong', { text: 'Shredder' }), el('span', { text: 'Controls' })),
      body);
  }

  /** @private */
  _buildRightPanel() {
    // Load gauge.
    const gaugeBar = el('i');
    const gauge = el('div', { class: 'msx-gauge', role: 'meter', 'aria-label': 'Motor load', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, gaugeBar);
    const gaugeLabel = el('div', { class: 'msx-gauge-label' }, el('span', { text: 'Load' }), el('span', { class: 'msx-stallword', text: 'STALL' }));
    this._refs.set('gauge', gauge);
    this._refs.set('gaugeBar', gaugeBar);
    this._refs.set('gaugeLabel', gaugeLabel);
    const loadGroup = this._group('Motor', gaugeLabel, gauge);

    // Stats.
    const stat = (key, label) => {
      const val = el('b', { text: '—' });
      this._refs.set(`stat:${key}`, val);
      return el('div', { class: 'msx-stat' }, el('span', { text: label }), val);
    };
    const stats = this._group('Telemetry',
      stat('fps', 'FPS'),
      stat('frame', 'Frame ms'),
      stat('draw', 'Draw calls'),
      stat('tris', 'Triangles'),
      stat('bodies', 'Rigid bodies'),
      stat('frag', 'Fragments'),
      stat('spark', 'Live sparks')
    );

    // Audio.
    const mute = el('button', {
      class: 'msx-btn msx-btn--wide', type: 'button', 'aria-pressed': 'false',
      'aria-label': 'Mute audio (M)', title: 'Mute (M)', text: 'Mute',
      onClick: () => this.toggleMute()
    });
    this._refs.set('mute', mute);
    const audio = this._group('Audio',
      this._slider('volume', 'Master volume', this._volume, (v) => this.setVolume(v)),
      el('div', { class: 'msx-row' }, mute));

    // Quality.
    const select = el('select', {
      class: 'msx-btn msx-btn--wide', 'aria-label': 'Quality preset',
      onChange: (e) => this.setQuality(e.target.value)
    });
    for (const name of QUALITY_ORDER) {
      const opt = el('option', { value: name, text: QUALITY_PRESETS[name].label });
      select.append(opt);
    }
    select.value = this.app?.quality?.presetName || 'high';
    this._refs.set('quality', select);
    const auto = el('button', {
      class: 'msx-btn', type: 'button', 'aria-pressed': this.app?.quality?.auto ? 'true' : 'false',
      'aria-label': 'Auto quality scaling', title: 'Auto quality', text: 'Auto'
    });
    auto.addEventListener('click', () => this.toggleAutoQuality());
    this._refs.set('autoQuality', auto);
    const quality = this._group('Quality', select, el('div', { class: 'msx-row' }, auto));

    const body = el('div', { class: 'msx-body' }, loadGroup, stats, audio, quality);
    return el('div', { class: 'msx-panel msx-panel--right' },
      el('div', { class: 'msx-hdr' }, el('strong', { text: 'Telemetry' }), el('span', { text: 'Live' })),
      body);
  }

  /** @private */
  _buildHelp() {
    const keys = [
      ['Space', 'Power'], ['R', 'Reverse (hold)'], ['1–5', 'Cameras'], ['F', 'Drop scrap'],
      ['A', 'Auto-feed'], ['C', 'Clear'], ['H', 'Hide HUD'], ['M', 'Mute'],
      ['+ / −', 'Throttle'], ['K', 'Cinematic']
    ];
    const help = el('div', { class: 'msx-panel msx-help', role: 'note', 'aria-label': 'Keyboard shortcuts' });
    for (const [k, label] of keys) {
      help.append(el('div', { class: 'msx-key' }, el('span', { text: label }), el('kbd', { text: k })));
    }
    this._refs.set('help', help);
    return help;
  }

  /** @private Group with an uppercase legend. */
  _group(legend, ...kids) {
    return el('div', { class: 'msx-group', role: 'group', 'aria-label': legend },
      el('div', { class: 'msx-legend', text: legend }), ...kids);
  }

  /** @private Labelled range slider (0..1) with a live value readout. */
  _slider(key, label, value, onChange) {
    const valSpan = el('span', { class: 'msx-val', text: `${Math.round(value * 100)}%` });
    const input = el('input', {
      class: 'msx-slider', type: 'range', min: '0', max: '1', step: '0.01',
      value: String(value), 'aria-label': label
    });
    input.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      valSpan.textContent = `${Math.round(v * 100)}%`;
      onChange(v);
    });
    this._refs.set(`slider:${key}`, input);
    this._refs.set(`sliderVal:${key}`, valSpan);
    return el('div', { class: 'msx-field' },
      el('label', {}, el('span', { text: label }), valSpan), input);
  }

  /* ================================================================== *
   *  Control actions (also called by Hotkeys)
   * ================================================================== */

  /** Toggle shredder power. */
  togglePower() {
    this._power = !this._power;
    this._apply('rig', (r) => r.setPower?.(this._power));
    this._syncPowerButton();
  }

  /** Toggle latching reverse gear. */
  toggleReverse() { this.setReverseHeld(!this._reverse); }

  /**
   * Set reverse state (momentary hold from the R key or latching from the button).
   * @param {boolean} on
   */
  setReverseHeld(on) {
    this._reverse = !!on;
    this._apply('rig', (r) => r.setReverse?.(this._reverse));
    this._refs.get('reverse')?.setAttribute('aria-pressed', String(this._reverse));
  }

  /** @param {number} v 0..1 */
  setThrottle(v) {
    this._throttle = Math.max(0, Math.min(1, v));
    this._apply('rig', (r) => r.setThrottle?.(this._throttle));
    this._reflectSlider('throttle', this._throttle);
  }

  /** Nudge throttle by a delta (+/- keys). @param {number} d */
  nudgeThrottle(d) { this.setThrottle(this._throttle + d); }

  /** @param {number} v 0..1 */
  setConveyor(v) {
    this._conveyor = Math.max(0, Math.min(1, v));
    this._apply('feeder', (f) => f.setConveyorSpeed?.(this._conveyor));
    this._reflectSlider('conveyor', this._conveyor);
  }

  /** @param {string} id */
  cameraPreset(id) {
    this._apply('cameraRig', (c) => c.setPreset?.(id));
    if (this._cinematic) this._setCinematic(false);
    for (const p of this._presets) {
      this._refs.get(`cam:${p.id}`)?.setAttribute('aria-pressed', String(p.id === id));
    }
  }

  /** @param {number} i 0-based preset index (keys 1..5). */
  cameraPresetByIndex(i) {
    const p = this._presets[i];
    if (p) this.cameraPreset(p.id);
  }

  /** @param {string} id */
  selectScrap(id) {
    this._selectedScrap = id;
    for (const s of this._scrap) {
      this._refs.get(`scrap:${s.id}`)?.setAttribute('aria-pressed', String(s.id === id));
    }
  }

  /** Spawn one piece of the selected scrap type. */
  spawnSelected() {
    this._apply('feeder', (f) => f.spawn?.(this._selectedScrap));
  }

  /** Toggle continuous auto-feed. */
  toggleAutoFeed() {
    this._autoFeed = !this._autoFeed;
    this._apply('feeder', (f) => f.setAutoFeed?.(this._autoFeed));
    this._refs.get('autoFeed')?.setAttribute('aria-pressed', String(this._autoFeed));
  }

  /** Remove all live scrap + fragments. */
  clearAll() { this._apply('feeder', (f) => f.clearAll?.()); }

  /** @param {number} v 0..1 */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    this._apply('audio', (a) => a.setMasterVolume?.(this._volume));
    this._reflectSlider('volume', this._volume);
  }

  /** Toggle audio mute. */
  toggleMute() {
    this._muted = !this._muted;
    this._apply('audio', (a) => a.setMuted?.(this._muted));
    const b = this._refs.get('mute');
    if (b) { b.setAttribute('aria-pressed', String(this._muted)); b.textContent = this._muted ? 'Unmute' : 'Mute'; }
  }

  /** @param {string} name performance|balanced|high|ultra */
  setQuality(name) {
    this._apply('quality', (q) => q.setPreset?.(name));
    const auto = this._refs.get('autoQuality');
    if (auto) auto.setAttribute('aria-pressed', 'false');
  }

  /** Toggle adaptive quality scaling. */
  toggleAutoQuality() {
    const q = this.app?.quality;
    const next = !(q?.auto);
    this._apply('quality', (qq) => qq.setAuto?.(next));
    this._refs.get('autoQuality')?.setAttribute('aria-pressed', String(next));
  }

  /** @returns {boolean} whether the collapsible HUD panels are visible. */
  get hudVisible() { return !this._hudHidden; }

  /**
   * Explicitly show or hide the collapsible HUD panels. Idempotent — safe to
   * call repeatedly with the same value, and safe to call before {@link build}
   * (the state is recorded and applied once the DOM exists). Used by the
   * headless visual-QA harness to guarantee a clean screenshot plate. The small
   * top bar always stays visible so the HUD can be brought back.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._hudHidden = !visible;
    this._applyHudVisibility();
  }

  /** @private Reflect {@link _hudHidden} onto the DOM (no-op before build). */
  _applyHudVisibility() {
    if (!this.hud) return;
    const hidden = this._hudHidden;
    for (const sel of ['.msx-panel--left', '.msx-panel--right', '.msx-help']) {
      const node = this.hud.querySelector(sel);
      if (node) node.hidden = hidden;
    }
    const b = this._refs.get('hudBtn');
    if (b) {
      b.setAttribute('aria-pressed', String(hidden));
      b.textContent = hidden ? 'Show' : 'Hide';
    }
  }

  /** Toggle HUD panel visibility (H key). */
  toggleHud() { this.setVisible(this._hudHidden); }

  /** Toggle the cinematic showcase camera (K key). */
  toggleCinematic() { this._setCinematic(!this._cinematic); }

  /** @private */
  _setCinematic(on) {
    this._cinematic = !!on;
    this._apply('cameraRig', (c) => c.setCinematic?.(this._cinematic));
    this._refs.get('cineBtn')?.setAttribute('aria-pressed', String(this._cinematic));
  }

  /* ================================================================== *
   *  Live telemetry (event-driven, change-gated DOM writes)
   * ================================================================== */

  /** @private @param {object} s STATS payload */
  _renderStats(s) {
    if (!s) return;
    const fps = Math.round(s.fps ?? 0);
    if (this._last.fps !== fps) {
      this._last.fps = fps;
      const node = this._refs.get('stat:fps');
      if (node) {
        node.textContent = String(fps);
        node.className = fps >= 55 ? 'msx-fps--good' : fps >= 40 ? 'msx-fps--warn' : 'msx-fps--bad';
        // Preserve the bold element styling by keeping tag <b>; class adds colour.
        node.classList.add('msx-fps');
      }
    }
    this._setStat('frame', `${(s.frameMs ?? 0).toFixed(1)} · p95 ${(s.frameMs95 ?? 0).toFixed(1)}`);
    this._setStat('draw', this._int(s.drawCalls));
    this._setStat('tris', this._compact(s.tris));
    this._setStat('bodies', this._int(s.bodies));
    this._setStat('frag', this._int(s.fragments));
    this._setStat('spark', this._int(s.sparks));
  }

  /** @private @param {object} m MOTOR_LOAD payload */
  _renderLoad(m) {
    if (!m) return;
    const load = Math.max(0, Math.min(1, m.load ?? 0));
    const stalled = !!m.stalled;
    const pct = Math.round(load * 100);
    if (this._last.load !== pct || this._last.stall !== stalled) {
      this._last.load = pct;
      this._last.stall = stalled;
      const bar = this._refs.get('gaugeBar');
      const gauge = this._refs.get('gauge');
      const label = this._refs.get('gaugeLabel');
      if (bar) bar.style.width = `${pct}%`;
      if (gauge) {
        gauge.classList.toggle('msx-hot', load >= 0.6 && !stalled);
        gauge.classList.toggle('msx-stall', stalled);
        gauge.setAttribute('aria-valuenow', String(pct));
      }
      if (label) label.classList.toggle('msx-stall', stalled);
    }
  }

  /** @private Reflect an auto quality change back into the select/auto button. */
  _syncQuality(q) {
    if (!q) return;
    const sel = this._refs.get('quality');
    if (sel && q.preset && sel.value !== q.preset) sel.value = q.preset;
    if (typeof q.auto === 'boolean') {
      this._refs.get('autoQuality')?.setAttribute('aria-pressed', String(q.auto));
    }
  }

  /* ================================================================== *
   *  Click-to-drop
   * ================================================================== */

  /** @private Distinguish a tap (drop) from an orbit drag on the viewport. */
  _bindViewportPointer() {
    const canvas = this.app?.engine?.canvas;
    if (!canvas) return;
    canvas.addEventListener('pointerdown', (e) => {
      this._ptr.id = e.pointerId;
      this._ptr.x = e.clientX;
      this._ptr.y = e.clientY;
      this._ptr.t = performance.now();
      this._ptr.moved = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._ptr.id) return;
      const dx = e.clientX - this._ptr.x;
      const dy = e.clientY - this._ptr.y;
      if (dx * dx + dy * dy > 36) this._ptr.moved = true; // >6px counts as an orbit
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this._ptr.id) return;
      const quick = performance.now() - this._ptr.t < 350;
      if (!this._ptr.moved && quick && e.button === 0) this._dropAt(e, canvas);
      this._ptr.id = -1;
    });
  }

  /** @private Raycast the hopper plane and spawn the selected scrap there. */
  _dropAt(e, canvas) {
    const cam = this.app?.engine?.camera;
    const feeder = this.app?.feeder;
    if (!cam || !feeder) return;
    const rect = canvas.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, cam);
    const hit = this._raycaster.ray.intersectPlane(this._dropPlane, this._hit);
    if (!hit) return;
    if (typeof feeder.spawnAt === 'function') feeder.spawnAt(this._hit, this._selectedScrap);
    else feeder.spawn?.(this._selectedScrap);
  }

  /* ================================================================== *
   *  Helpers
   * ================================================================== */

  /**
   * @private Coerce the (possibly empty / partially-populated) ScrapLibrary
   * export into a stable list of `{ id, label, metal }`. Entries missing an
   * `id` are dropped; missing `label`/`metal` are backfilled so the palette can
   * never render `undefined` or throw.
   * @param {Array<{id?:string,label?:string,metal?:string}>|undefined} list
   * @returns {Array<{id:string,label:string,metal:string}>}
   */
  _normaliseScrap(list) {
    const src = Array.isArray(list) && list.length ? list : FALLBACK_SCRAP;
    const out = [];
    const seen = new Set();
    for (const raw of src) {
      const id = raw && raw.id != null ? String(raw.id) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: raw.label != null ? String(raw.label) : id,
        metal: raw.metal != null ? String(raw.metal) : 'metal'
      });
    }
    return out.length ? out : FALLBACK_SCRAP.slice();
  }

  /** @private Safely call a method on a possibly-not-yet-ready subsystem. */
  _apply(name, fn) {
    const sub = this.app?.[name];
    if (!sub) return;
    try { fn(sub); } catch (err) { console.warn(`[UI] ${name} call failed`, err); }
  }

  /** @private Write a stat only if it changed. */
  _setStat(key, value) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    const node = this._refs.get(`stat:${key}`);
    if (node) node.textContent = value;
  }

  /** @private Keep a slider + its readout in sync after a programmatic change. */
  _reflectSlider(key, v) {
    const input = this._refs.get(`slider:${key}`);
    const val = this._refs.get(`sliderVal:${key}`);
    if (input && input.value !== String(v)) input.value = String(v);
    if (val) val.textContent = `${Math.round(v * 100)}%`;
  }

  /** @private */
  _syncPowerButton() {
    const b = this._refs.get('power');
    if (!b) return;
    b.setAttribute('aria-pressed', String(this._power));
    const text = b.querySelector('span:last-child');
    if (text) text.textContent = this._power ? 'Power On' : 'Power Off';
  }

  /** @private */
  _int(v) { return v == null ? '—' : String(Math.round(v)); }

  /** @private Compact large integers (e.g. 1.2M). */
  _compact(v) {
    if (v == null) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  }

  /** No-op per-frame hook (the HUD is event-driven and costs nothing here). */
  update(_dt) {}

  /** Tear down listeners + DOM. Safe to call more than once. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._offStats?.();
    this._offMotor?.();
    this._offQuality?.();
    this._offStats = this._offMotor = this._offQuality = null;
    this._hotkeys?.detach();
    this.hud?.remove();
    this.hud = null;
  }
}
