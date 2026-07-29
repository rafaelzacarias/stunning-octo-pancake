/**
 * ControlPanel.js — Industrial control-room HUD for the metal shredding simulator.
 *
 * Self-contained: no imports, no dependencies, no network access.
 * The stylesheet lives in ./style.css and is imported separately by main.js.
 *
 * Visual language: Hardspace: Shipbreaker style — near-black glass panels,
 * amber (#ffb020) + cyan (#33d6ff) accents, monospace tabular readouts.
 */

/* ------------------------------------------------------------------ *
 * Tiny DOM helpers
 * ------------------------------------------------------------------ */

/**
 * Minimal element factory.
 * `html` is only ever fed author-controlled SVG markup (never caller data).
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const key in props) {
    const value = props[key];
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const lerp = (a, b, t) => a + (b - a) * t;

function fmtInt(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return fmtInt(n);
}

function fmtMs(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(n < 10 ? 2 : 1);
}

function fmtMass(mass) {
  if (!Number.isFinite(mass)) return null;
  if (mass >= 1000) return (mass / 1000).toFixed(mass % 1000 === 0 ? 0 : 1) + ' t';
  if (mass < 1) return (mass * 1000).toFixed(0) + ' g';
  return (mass % 1 === 0 ? mass.toFixed(0) : mass.toFixed(1)) + ' kg';
}

/**
 * Placeholder monogram for a feed-stock card whose 3D thumbnail never arrives.
 * "Aluminium Can" → "AC"; single words collapse to their first two letters.
 */
function monogram(label, id) {
  const source = String(label ?? '').trim() || String(id ?? '').trim();
  const words = source.split(/[\s_\-/·]+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Gauge geometry (inline SVG, authored here so the CSS can hook onto it)
 * ------------------------------------------------------------------ */

const GAUGE = { cx: 100, cy: 88, r: 68, a0: 212, a1: -32 };
const GAUGE_SWEEP = GAUGE.a1 - GAUGE.a0; // negative: clockwise on screen
const GAUGE_LEN = GAUGE.r * Math.abs(GAUGE_SWEEP) * (Math.PI / 180);

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

function arcPath(cx, cy, r, from, to) {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to < from ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function gaugeTicks() {
  const { cx, cy, r } = GAUGE;
  const major = [];
  const minor = [];
  const STEPS = 40;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const deg = GAUGE.a0 + GAUGE_SWEEP * t;
    const isMajor = i % 5 === 0;
    const [xa, ya] = polar(cx, cy, r + 4, deg);
    const [xb, yb] = polar(cx, cy, r + (isMajor ? -8 : -3), deg);
    const seg = `M ${xa.toFixed(2)} ${ya.toFixed(2)} L ${xb.toFixed(2)} ${yb.toFixed(2)}`;
    (isMajor ? major : minor).push(seg);
  }
  return { major: major.join(' '), minor: minor.join(' ') };
}

function gaugeMarkup() {
  const { cx, cy, r, a0, a1 } = GAUGE;
  const ticks = gaugeTicks();
  const redlineStart = a0 + GAUGE_SWEEP * 0.85;
  return `
<svg class="sio-gauge-svg" viewBox="0 0 200 132" role="img" aria-label="Motor load gauge" focusable="false">
  <defs>
    <linearGradient id="sioGaugeGrad" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#39d98a"/>
      <stop offset="45%" stop-color="#9ad84a"/>
      <stop offset="72%" stop-color="#ffb020"/>
      <stop offset="100%" stop-color="#ff3b30"/>
    </linearGradient>
    <radialGradient id="sioGaugeHub" cx="50%" cy="35%" r="70%">
      <stop offset="0%" stop-color="#3a4249"/>
      <stop offset="100%" stop-color="#0d1013"/>
    </radialGradient>
  </defs>
  <path class="sio-gauge-track" d="${arcPath(cx, cy, r, a0, a1)}"/>
  <path class="sio-gauge-redline" d="${arcPath(cx, cy, r, redlineStart, a1)}"/>
  <path class="sio-gauge-ticks-minor" d="${ticks.minor}"/>
  <path class="sio-gauge-ticks-major" d="${ticks.major}"/>
  <path class="sio-gauge-value" d="${arcPath(cx, cy, r, a0, a1)}"
        stroke-dasharray="${GAUGE_LEN.toFixed(2)} ${(GAUGE_LEN + 2).toFixed(2)}"
        stroke-dashoffset="${GAUGE_LEN.toFixed(2)}"/>
  <g class="sio-gauge-needle">
    <path class="sio-gauge-needle-body" d="M ${cx - 4} ${cy} L ${cx} ${cy - r + 10} L ${cx + 4} ${cy} Z"/>
    <path class="sio-gauge-needle-tail" d="M ${cx - 3} ${cy} L ${cx} ${cy + 13} L ${cx + 3} ${cy} Z"/>
  </g>
  <circle class="sio-gauge-hub" cx="${cx}" cy="${cy}" r="9" fill="url(#sioGaugeHub)"/>
  <circle class="sio-gauge-hub-dot" cx="${cx}" cy="${cy}" r="2.4"/>
</svg>`;
}

const ICON_AUDIO_ON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-ico-stroke" d="M4 9.5h3.6L12.5 5.4v13.2L7.6 14.5H4z"/>
  <path class="sio-ico-wave sio-ico-wave-1" d="M15.8 9.2a4 4 0 0 1 0 5.6"/>
  <path class="sio-ico-wave sio-ico-wave-2" d="M18.4 6.6a7.6 7.6 0 0 1 0 10.8"/>
</svg>`;

const ICON_AUDIO_MUTED = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-ico-stroke" d="M4 9.5h3.6L12.5 5.4v13.2L7.6 14.5H4z"/>
  <path class="sio-ico-mute" d="M16.2 9.4l5.4 5.2M21.6 9.4l-5.4 5.2"/>
</svg>`;

const ICON_CUBE = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-ico-stroke" d="M12 3.2l7.4 4.2v9.2L12 20.8 4.6 16.6V7.4z"/>
  <path class="sio-ico-stroke" d="M4.6 7.4L12 11.6l7.4-4.2M12 11.6v9.2"/>
</svg>`;

const ICON_CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-ico-stroke" d="M7 10l5 5 5-5"/>
</svg>`;

const ICON_TRASH = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-ico-stroke" d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12h9l1-12M10 10.5v5.5M14 10.5v5.5"/>
</svg>`;

/* ------------------------------------------------------------------ *
 * Static content tables
 * ------------------------------------------------------------------ */

const SETTINGS = [
  { key: 'slowmo', label: 'Slow Motion', hint: '0.25× time scale', on: false },
  { key: 'autoFeed', label: 'Auto Feed', hint: 'Continuous stock drop', on: false },
  { key: 'bloom', label: 'Bloom', hint: 'Spark & emissive glow', on: true },
  { key: 'dof', label: 'Depth of Field', hint: 'Cinematic focus', on: true },
  { key: 'ssao', label: 'SSAO', hint: 'Contact occlusion', on: true },
  { key: 'ssr', label: 'SSR', hint: 'Screen-space reflect', on: false },
];

const SHORTCUTS = [
  ['Space', 'Toggle main power'],
  ['R', 'Reverse rotor direction'],
  ['C', 'Clear all debris'],
  ['1 – 9', 'Spawn feed stock item'],
  ['F1 – F4', 'Camera presets'],
  ['Tab', 'Hide / show interface'],
];

const TELEMETRY_ROWS = [
  ['bodies', 'RIGID BODIES'],
  ['fragments', 'FRAGMENTS'],
  ['particles', 'PARTICLES'],
  ['triangles', 'TRIANGLES'],
];

const PERF_ROWS = [
  ['frameMs', 'FRAME', 'ms'],
  ['physicsMs', 'PHYS', 'ms'],
  ['bodies', 'BODY', ''],
  ['fragments', 'FRAG', ''],
  ['triangles', 'TRIS', ''],
  ['drawCalls', 'CALLS', ''],
];

const SPARK_SAMPLES = 120;
const SPARK_W = 120;
const SPARK_H = 34;
const READOUT_INTERVAL = 100; // ms → ~10 Hz

/* ------------------------------------------------------------------ *
 * ControlPanel
 * ------------------------------------------------------------------ */

export class ControlPanel {
  /**
   * @param {HTMLElement} mount        host element (usually document.body)
   * @param {object}      config       { objectTypes, cameraPresets, qualityLevels }
   * @param {object}      callbacks    see module docs / main.js
   */
  constructor(mount, config = {}, callbacks = {}) {
    this.mount = mount || document.body;
    this.config = {
      objectTypes: Array.isArray(config.objectTypes) ? config.objectTypes : [],
      cameraPresets: Array.isArray(config.cameraPresets) ? config.cameraPresets : [],
      qualityLevels: Array.isArray(config.qualityLevels) ? config.qualityLevels : [],
    };
    this.rpmScale = Number.isFinite(config.rpmScale) ? config.rpmScale : 1800;
    this.cb = callbacks || {};

    /* ---- state ---- */
    this.power = false;
    this.reverse = false;
    /* Audio boots MUTED: nothing may make a sound until the user asks for it.
       The button reflects this at build time WITHOUT emitting onAudioToggle. */
    this.audio = false;
    this.uiHidden = false;
    this.helpOpen = true;
    this.disposed = false;
    this.settings = Object.create(null);
    for (const s of SETTINGS) this.settings[s.key] = s.on;
    this.settings.showHelp = true;

    this.loadTarget = 0;
    this.loadCurrent = 0;
    this.rpmTarget = 0;
    this.rpmCurrent = 0;
    this.overload = false;

    this.stats = {
      fps: 0, frameMs: 0, physicsMs: 0, bodies: 0,
      fragments: 0, triangles: 0, drawCalls: 0, particles: 0,
    };

    /* ---- internals ---- */
    this._listeners = [];
    this._timers = new Set();
    this._raf = 0;
    this._samples = new Float32Array(SPARK_SAMPLES);
    this._sampleCount = 0;
    this._lastSparkDraw = 0;
    this._lastReadout = 0;
    this._lastTabToggle = 0;
    this._noticeTimer = 0;
    this._cameraButtons = new Map();
    this._settingInputs = new Map();
    this._thumbs = new Map();
    this._loading = null;
    this._gate = null;

    this._motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reducedMotion = !!(this._motionQuery && this._motionQuery.matches);
    if (this._motionQuery && this._motionQuery.addEventListener) {
      this._on(this._motionQuery, 'change', (e) => { this.reducedMotion = e.matches; });
    }

    this._build();
    this._bindGlobalKeys();
    this._renderGauge();
    this._drawSparkline(true);
  }

  /* ================================================================ *
   * Public API
   * ================================================================ */

  setStats(stats = {}) {
    if (this.disposed) return;
    Object.assign(this.stats, stats);

    const fps = Number.isFinite(stats.fps) ? stats.fps : this.stats.fps;
    this._samples.copyWithin(0, 1);
    this._samples[SPARK_SAMPLES - 1] = fps;
    if (this._sampleCount < SPARK_SAMPLES) this._sampleCount++;

    const now = performance.now();
    if (now - this._lastReadout >= READOUT_INTERVAL) {
      this._lastReadout = now;
      this._paintReadouts();
    }
    if (now - this._lastSparkDraw >= READOUT_INTERVAL) {
      this._lastSparkDraw = now;
      this._drawSparkline();
    }
  }

  setLoad(load01) {
    if (this.disposed) return;
    this.loadTarget = clamp01(load01);
    const over = this.loadTarget > 0.85;
    if (over !== this.overload) {
      this.overload = over;
      this.root.classList.toggle('is-overload', over);
      this.els.overloadLamp.classList.toggle('is-on', over);
      this.els.overloadLamp.setAttribute('aria-hidden', over ? 'false' : 'true');
    }
    this._requestAnim();
  }

  setRPM(rpm01) {
    if (this.disposed) return;
    this.rpmTarget = clamp01(rpm01);
    this._requestAnim();
  }

  setPower(on) {
    this._applyPower(!!on, false);
  }

  setReverse(on) {
    this._applyReverse(!!on, false);
  }

  setQuality(id) {
    if (this.disposed || !this.els.quality) return;
    this.els.quality.value = String(id);
  }

  setCameraPreset(id) {
    if (this.disposed) return;
    for (const [key, btn] of this._cameraButtons) {
      const active = key === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  /**
   * Attach a rendered preview to a feed-stock card. Idempotent and total:
   * unknown ids, empty values, calls before the cards exist and calls after
   * dispose() are all no-ops that leave the placeholder monogram in place.
   *
   * @param   {string} id       feed-stock id (as passed in config.objectTypes)
   * @param   {string} dataUrl  `data:image/…` (or blob:) URL — local sources only
   * @returns {boolean} true when the card now points at this image
   */
  setThumbnail(id, dataUrl) {
    if (this.disposed || !this._thumbs) return false;
    const entry = this._thumbs.get(String(id));
    if (!entry) return false;

    const url = typeof dataUrl === 'string' ? dataUrl.trim() : '';
    /* The UI never issues network requests: only in-document sources allowed. */
    if (!/^(?:data:image\/|blob:)/i.test(url)) {
      if (entry.url !== null) {
        entry.url = null;
        entry.img.removeAttribute('src');
      }
      entry.well.classList.remove('is-ready');
      return false;
    }

    if (entry.url === url) return true; // already showing it — no reflow, no flash
    entry.url = url;
    entry.img.src = url; // the build-time 'load' listener cross-fades it in
    return true;
  }

  setNotice(text, ms = 2200) {
    if (this.disposed) return;
    const toast = this.els.toast;
    toast.textContent = String(text ?? '');
    toast.classList.add('is-visible');
    if (this._noticeTimer) this._clearTimer(this._noticeTimer);
    this._noticeTimer = this._setTimer(() => {
      toast.classList.remove('is-visible');
      this._noticeTimer = 0;
    }, Math.max(400, ms | 0));
  }

  setLoadingProgress(p01, label) {
    if (this.disposed) return;
    if (!this._loading) this._buildLoading();
    const p = clamp01(p01);
    const boot = this._loading;
    boot.overlay.classList.remove('is-hidden');
    boot.overlay.classList.toggle('is-indeterminate', p <= 0.0001);
    boot.fill.style.transform = `scaleX(${p.toFixed(4)})`;
    boot.percent.textContent = `${Math.round(p * 100)}%`;
    if (label !== undefined && label !== null) boot.label.textContent = String(label);
  }

  hideLoading() {
    if (!this._loading) return;
    const boot = this._loading;
    boot.overlay.classList.add('is-hidden');
    this._setTimer(() => {
      if (boot.overlay.parentNode) boot.overlay.remove();
      if (this._loading === boot) this._loading = null;
    }, 620);
  }

  showStartGate(onStart) {
    if (this.disposed) return;
    if (this._gate) this._destroyGate();

    const title = el('div', { class: 'sio-gate-title', text: 'SHREDDING.IO' });
    const sub = el('div', { class: 'sio-gate-sub', text: 'INDUSTRIAL SHREDDER — SIMULATION TERMINAL' });
    const button = el('button', {
      class: 'sio-gate-btn',
      type: 'button',
      'aria-label': 'Click to initialize the simulation',
    }, [
      el('span', { class: 'sio-gate-btn-ring' }),
      el('span', { class: 'sio-gate-btn-label', text: 'CLICK TO INITIALIZE' }),
    ]);
    const note = el('div', {
      class: 'sio-gate-note',
      text: 'Audio engine requires a user gesture · headphones recommended',
    });

    const overlay = el('div', { class: 'sio-gate', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'sio-gate-grid', 'aria-hidden': 'true' }),
      el('div', { class: 'sio-gate-inner' }, [title, sub, button, note]),
    ]);

    const fire = () => {
      if (!this._gate) return;
      overlay.classList.add('is-leaving');
      this._setTimer(() => this._destroyGate(), 460);
      if (typeof onStart === 'function') {
        try { onStart(); } catch (err) { console.error('[ControlPanel] onStart failed', err); }
      }
    };

    const onClick = () => fire();
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        fire();
      }
    };
    button.addEventListener('click', onClick);
    overlay.addEventListener('keydown', onKey);

    this._gate = { overlay, button, onClick, onKey };
    this.mount.appendChild(overlay);
    button.focus({ preventScroll: true });
  }

  /** Extra convenience — main.js may drive UI visibility explicitly. */
  setUIVisible(visible) {
    this.uiHidden = !visible;
    this.root.classList.toggle('ui-hidden', this.uiHidden);
  }

  toggleUI() {
    this.setUIVisible(this.uiHidden);
    return !this.uiHidden;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;

    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();

    for (const { target, type, handler, options } of this._listeners) {
      target.removeEventListener(type, handler, options);
    }
    this._listeners.length = 0;

    this._destroyGate();
    if (this._loading && this._loading.overlay.parentNode) this._loading.overlay.remove();
    this._loading = null;

    this._cameraButtons.clear();
    this._settingInputs.clear();
    this._thumbs.clear();

    if (this.root && this.root.parentNode) this.root.remove();
    this.root = null;
    this.els = null;
  }

  /* ================================================================ *
   * Construction
   * ================================================================ */

  _build() {
    this.els = {};

    this.root = el('div', { class: 'sio-ui', 'data-sio': 'root' });
    this.root.appendChild(this._buildLeftColumn());
    this.root.appendChild(this._buildRightColumn());
    this.root.appendChild(this._buildPerfHud());
    this.root.appendChild(this._buildCameraBar());
    this.root.appendChild(this._buildHelpPanel());

    this.els.toast = el('div', { class: 'sio-toast', role: 'status', 'aria-live': 'polite' });
    this.root.appendChild(this.els.toast);

    this.mount.appendChild(this.root);
  }

  /* ---------------- left column: machine controls ---------------- */

  _buildLeftColumn() {
    const col = el('div', { class: 'sio-col sio-col--left' });
    col.appendChild(this._buildMachinePanel());
    return col;
  }

  _buildMachinePanel() {
    const panel = this._panel('sio-panel--machine', 'MACHINE CONTROL', 'MK-IV ROTARY SHEAR');

    /* POWER rocker + REVERSE */
    const led = el('span', { class: 'sio-led' });
    const rocker = el('button', {
      class: 'sio-rocker',
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': 'Main power',
      title: 'Main power (Space)',
    }, [
      el('span', { class: 'sio-rocker-body' }, [
        el('span', { class: 'sio-rocker-lever' }, [
          el('span', { class: 'sio-rocker-ridges', 'aria-hidden': 'true' }),
        ]),
      ]),
      el('span', { class: 'sio-rocker-meta' }, [
        el('span', { class: 'sio-rocker-title', text: 'MAIN POWER' }),
        el('span', { class: 'sio-rocker-state', text: 'OFFLINE' }),
      ]),
      led,
    ]);
    this._on(rocker, 'click', () => this._applyPower(!this.power, true));
    this.els.rocker = rocker;
    this.els.rockerState = rocker.querySelector('.sio-rocker-state');

    const reverse = el('button', {
      class: 'sio-btn sio-btn--reverse',
      type: 'button',
      'aria-pressed': 'false',
      title: 'Reverse rotor (R)',
    }, [
      el('span', { class: 'sio-btn-key', text: 'R' }),
      el('span', { class: 'sio-btn-label', text: 'REVERSE ROTORS' }),
      el('span', { class: 'sio-btn-state', text: 'FWD' }),
    ]);
    this._on(reverse, 'click', () => this._applyReverse(!this.reverse, true));
    this.els.reverse = reverse;
    this.els.reverseState = reverse.querySelector('.sio-btn-state');

    panel.body.appendChild(el('div', { class: 'sio-group sio-group--power' }, [rocker, reverse]));

    /* Conveyor speed */
    const conveyor = this._slider({
      id: 'sio-conveyor',
      label: 'CONVEYOR FEED',
      value: 0.6,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this._emit('onConveyorSpeed', v),
    });
    this.els.conveyor = conveyor;
    panel.body.appendChild(conveyor.wrap);

    panel.body.appendChild(el('div', { class: 'sio-divider', 'aria-hidden': 'true' }));

    /* Quality */
    const select = el('select', { class: 'sio-select', id: 'sio-quality' });
    const levels = this.config.qualityLevels.length
      ? this.config.qualityLevels
      : [{ id: 'medium', label: 'Medium' }];
    for (const level of levels) {
      select.appendChild(el('option', { value: String(level.id), text: String(level.label ?? level.id) }));
    }
    this._on(select, 'change', () => this._emit('onQuality', select.value));
    this.els.quality = select;
    panel.body.appendChild(el('div', { class: 'sio-field' }, [
      el('label', { class: 'sio-field-label', htmlFor: 'sio-quality', text: 'RENDER QUALITY' }),
      el('div', { class: 'sio-select-wrap' }, [select, el('span', { class: 'sio-select-arrow', html: ICON_CHEVRON })]),
    ]));

    /* Audio — starts MUTED (see constructor). No callback fires on build. */
    const audioBtn = el('button', {
      class: 'sio-btn sio-btn--audio',
      type: 'button',
      'aria-pressed': 'false',
      title: 'Toggle audio',
    }, [
      el('span', { class: 'sio-btn-ico', html: ICON_AUDIO_MUTED }),
      el('span', { class: 'sio-btn-label', text: 'AUDIO ENGINE' }),
      el('span', { class: 'sio-btn-state', text: 'MUTED' }),
    ]);
    this._on(audioBtn, 'click', () => this._applyAudio(!this.audio, true));
    this.els.audioBtn = audioBtn;
    this.els.audioIco = audioBtn.querySelector('.sio-btn-ico');
    this.els.audioState = audioBtn.querySelector('.sio-btn-state');

    const volume = this._slider({
      id: 'sio-volume',
      label: 'MASTER VOLUME',
      value: 0.8,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this._emit('onVolume', v),
    });
    this.els.volume = volume;
    /* Match exactly what the click handler does when toggling audio off. */
    volume.wrap.classList.add('is-disabled');
    volume.input.disabled = true;

    panel.body.appendChild(el('div', { class: 'sio-group sio-group--audio' }, [audioBtn, volume.wrap]));

    panel.body.appendChild(el('div', { class: 'sio-divider', 'aria-hidden': 'true' }));

    /* Setting toggles */
    const toggles = el('div', { class: 'sio-toggles' });
    for (const setting of SETTINGS) {
      toggles.appendChild(this._toggle(setting));
    }
    toggles.appendChild(this._toggle({
      key: 'showHelp', label: 'Shortcut Help', hint: 'Keyboard overlay', on: true,
    }));
    panel.body.appendChild(el('div', { class: 'sio-field' }, [
      el('span', { class: 'sio-field-label', text: 'SIMULATION & POST' }),
      toggles,
    ]));

    /* Clear */
    const clear = el('button', {
      class: 'sio-btn sio-btn--danger',
      type: 'button',
      title: 'Clear all debris (C)',
    }, [
      el('span', { class: 'sio-btn-ico', html: ICON_TRASH }),
      el('span', { class: 'sio-btn-label', text: 'CLEAR DEBRIS' }),
      el('span', { class: 'sio-btn-key', text: 'C' }),
    ]);
    this._on(clear, 'click', () => this._emit('onClear'));
    panel.body.appendChild(clear);

    return panel.root;
  }

  /* ---------------- right column: feed stock + telemetry ---------------- */

  _buildRightColumn() {
    const col = el('div', { class: 'sio-col sio-col--right' });
    col.appendChild(this._buildFeedPanel());
    col.appendChild(this._buildTelemetryPanel());
    return col;
  }

  _buildFeedPanel() {
    const panel = this._panel('sio-panel--feed', 'FEED STOCK', 'CLICK TO DROP');
    const list = el('div', { class: 'sio-cards' });

    this.config.objectTypes.forEach((type) => {
      const id = String(type.id);
      const label = String(type.label ?? id);
      const mass = fmtMass(Number(type.mass));
      /* Only the first ten items carry a keyboard binding. Anything without a
         `key` simply gets no badge — never a blank box or an invented number. */
      const keyLabel = type.key === undefined || type.key === null || type.key === ''
        ? null
        : String(type.key);

      const img = el('img', {
        class: 'sio-thumb-img',
        alt: '',
        decoding: 'async',
        draggable: false,
      });
      const well = el('span', { class: 'sio-thumb', 'aria-hidden': 'true' }, [
        el('span', { class: 'sio-thumb-ph' }, [
          el('span', { class: 'sio-thumb-glyph', html: ICON_CUBE }),
          el('span', { class: 'sio-thumb-mono', text: monogram(label, id) }),
        ]),
        el('span', { class: 'sio-thumb-shimmer' }),
        img,
        el('span', { class: 'sio-thumb-vignette' }),
        keyLabel ? el('span', { class: 'sio-card-key', text: keyLabel }) : null,
      ]);

      /* Registered once, at build time, so setThumbnail() stays side-effect
         free and dispose() still tears every listener down. */
      this._on(img, 'load', () => well.classList.add('is-ready'));
      this._on(img, 'error', () => {
        const entry = this._thumbs.get(id);
        if (entry) entry.url = null;
        well.classList.remove('is-ready');
        img.removeAttribute('src');
      });
      this._thumbs.set(id, { well, img, url: null });

      const main = el('button', {
        class: 'sio-card-main',
        type: 'button',
        title: `Spawn ${label}`,
      }, [
        well,
        el('span', { class: 'sio-card-text' }, [
          el('span', { class: 'sio-card-label', text: label }),
          type.hint ? el('span', { class: 'sio-card-hint', text: String(type.hint) }) : null,
        ]),
        mass ? el('span', { class: 'sio-card-mass', text: mass }) : null,
      ]);
      this._on(main, 'click', () => this._emit('onSpawn', id));

      const burst = el('button', {
        class: 'sio-card-burst',
        type: 'button',
        title: `Spawn 5 × ${label}`,
        'aria-label': `Spawn five ${label}`,
        text: '×5',
      });
      this._on(burst, 'click', (e) => {
        e.stopPropagation();
        this._emit('onSpawnBurst', id, 5);
      });

      list.appendChild(el('div', { class: 'sio-card', dataset: { id } }, [main, burst]));
    });

    if (!this.config.objectTypes.length) {
      list.appendChild(el('div', { class: 'sio-empty', text: 'NO FEED STOCK CONFIGURED' }));
    }

    panel.body.appendChild(list);
    return panel.root;
  }

  _buildTelemetryPanel() {
    const panel = this._panel('sio-panel--telemetry', 'TELEMETRY', 'LIVE');

    /* Load gauge */
    const gauge = el('div', { class: 'sio-gauge', html: gaugeMarkup() });
    this.els.gaugeNeedle = gauge.querySelector('.sio-gauge-needle');
    this.els.gaugeValue = gauge.querySelector('.sio-gauge-value');

    const gaugeValue = el('div', { class: 'sio-gauge-readout' }, [
      el('span', { class: 'sio-gauge-num', text: '0' }),
      el('span', { class: 'sio-gauge-unit', text: '%' }),
    ]);
    this.els.gaugeNum = gaugeValue.querySelector('.sio-gauge-num');

    const lamp = el('div', { class: 'sio-lamp', 'aria-hidden': 'true' }, [
      el('span', { class: 'sio-lamp-dot' }),
      el('span', { class: 'sio-lamp-text', text: 'OVERLOAD' }),
    ]);
    this.els.overloadLamp = lamp;

    panel.body.appendChild(el('div', { class: 'sio-gauge-wrap' }, [
      lamp,
      gauge,
      gaugeValue,
      el('div', { class: 'sio-gauge-caption', text: 'MOTOR LOAD / AMPERAGE' }),
    ]));

    /* RPM */
    const rpmTrack = el('div', { class: 'sio-rpm-track' }, [
      el('span', { class: 'sio-rpm-fill' }),
      el('span', { class: 'sio-rpm-needle' }),
    ]);
    this.els.rpmFill = rpmTrack.querySelector('.sio-rpm-fill');
    this.els.rpmNeedle = rpmTrack.querySelector('.sio-rpm-needle');
    const rpmValue = el('span', { class: 'sio-rpm-value', text: '0' });
    this.els.rpmValue = rpmValue;

    panel.body.appendChild(el('div', { class: 'sio-rpm' }, [
      el('div', { class: 'sio-rpm-head' }, [
        el('span', { class: 'sio-rpm-label', text: 'ROTOR RPM' }),
        el('span', { class: 'sio-rpm-readout' }, [rpmValue, el('span', { class: 'sio-rpm-unit', text: 'rpm' })]),
      ]),
      rpmTrack,
    ]));

    /* Counters */
    const grid = el('div', { class: 'sio-telemetry-grid' });
    this.els.telemetry = {};
    for (const [key, label] of TELEMETRY_ROWS) {
      const value = el('span', { class: 'sio-stat-value', text: '0' });
      this.els.telemetry[key] = value;
      grid.appendChild(el('div', { class: 'sio-stat' }, [
        el('span', { class: 'sio-stat-label', text: label }),
        value,
      ]));
    }
    panel.body.appendChild(grid);

    return panel.root;
  }

  /* ---------------- top-right: perf HUD ---------------- */

  _buildPerfHud() {
    const panel = el('div', { class: 'sio-panel sio-panel--perf' });

    const fpsValue = el('span', { class: 'sio-fps-value', text: '––' });
    this.els.fpsValue = fpsValue;

    const canvas = el('canvas', { class: 'sio-spark' });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(SPARK_W * dpr);
    canvas.height = Math.round(SPARK_H * dpr);
    canvas.style.width = SPARK_W + 'px';
    canvas.style.height = SPARK_H + 'px';
    canvas.setAttribute('aria-hidden', 'true');
    this.els.spark = canvas;
    this._sparkCtx = canvas.getContext('2d');
    this._sparkDpr = dpr;

    panel.appendChild(el('div', { class: 'sio-perf-head' }, [
      el('div', { class: 'sio-fps' }, [fpsValue, el('span', { class: 'sio-fps-unit', text: 'FPS' })]),
      canvas,
    ]));

    const grid = el('div', { class: 'sio-perf-grid' });
    this.els.perf = {};
    for (const [key, label, unit] of PERF_ROWS) {
      const value = el('span', { class: 'sio-perf-value', text: '0' });
      this.els.perf[key] = value;
      grid.appendChild(el('div', { class: 'sio-perf-cell' }, [
        el('span', { class: 'sio-perf-label', text: label }),
        el('span', { class: 'sio-perf-num' }, [value, unit ? el('span', { class: 'sio-perf-unit', text: unit }) : null]),
      ]));
    }
    panel.appendChild(grid);
    return panel;
  }

  /* ---------------- bottom-center: camera presets ---------------- */

  _buildCameraBar() {
    const panel = el('div', { class: 'sio-panel sio-panel--camera', role: 'group', 'aria-label': 'Camera presets' });
    panel.appendChild(el('span', { class: 'sio-camera-label', text: 'CAM' }));

    const seg = el('div', { class: 'sio-seg' });
    for (const preset of this.config.cameraPresets) {
      const id = String(preset.id);
      const btn = el('button', {
        class: 'sio-seg-btn',
        type: 'button',
        'aria-pressed': 'false',
        dataset: { id },
      }, [
        el('span', { class: 'sio-seg-label', text: String(preset.label ?? id) }),
        preset.key ? el('span', { class: 'sio-seg-key', text: String(preset.key) }) : null,
      ]);
      this._on(btn, 'click', () => {
        this.setCameraPreset(id);
        this._emit('onCameraPreset', id);
      });
      this._cameraButtons.set(id, btn);
      seg.appendChild(btn);
    }
    panel.appendChild(seg);

    const first = this.config.cameraPresets[0];
    if (first) this.setCameraPreset(String(first.id));

    return panel;
  }

  /* ---------------- collapsible help ---------------- */

  _buildHelpPanel() {
    const panel = el('div', { class: 'sio-panel sio-panel--help' });

    const toggle = el('button', {
      class: 'sio-help-head',
      type: 'button',
      'aria-expanded': 'true',
    }, [
      el('span', { class: 'sio-help-title', text: 'KEYBOARD' }),
      el('span', { class: 'sio-help-chevron', html: ICON_CHEVRON }),
    ]);
    const body = el('div', { class: 'sio-help-body' });
    for (const [keys, desc] of SHORTCUTS) {
      body.appendChild(el('div', { class: 'sio-help-row' }, [
        el('kbd', { class: 'sio-kbd', text: keys }),
        el('span', { class: 'sio-help-desc', text: desc }),
      ]));
    }
    this._on(toggle, 'click', () => {
      this.helpOpen = !this.helpOpen;
      panel.classList.toggle('is-collapsed', !this.helpOpen);
      toggle.setAttribute('aria-expanded', this.helpOpen ? 'true' : 'false');
    });

    panel.append(toggle, body);
    this.els.help = panel;
    return panel;
  }

  /* ---------------- boot overlay ---------------- */

  _buildLoading() {
    const label = el('div', { class: 'sio-boot-label', text: 'INITIALIZING' });
    const fill = el('span', { class: 'sio-boot-fill' });
    const percent = el('div', { class: 'sio-boot-percent', text: '0%' });

    const overlay = el('div', { class: 'sio-boot is-indeterminate', role: 'status', 'aria-live': 'polite' }, [
      el('div', { class: 'sio-boot-grid', 'aria-hidden': 'true' }),
      el('div', { class: 'sio-boot-scan', 'aria-hidden': 'true' }),
      el('div', { class: 'sio-boot-inner' }, [
        el('div', { class: 'sio-boot-brand', text: 'SHREDDING.IO' }),
        el('div', { class: 'sio-boot-sub', text: 'MK-IV ROTARY SHEAR · SIMULATION CORE' }),
        el('div', { class: 'sio-boot-bar' }, [fill, el('span', { class: 'sio-boot-sweep', 'aria-hidden': 'true' })]),
        el('div', { class: 'sio-boot-meta' }, [label, percent]),
      ]),
    ]);

    this._loading = { overlay, fill, percent, label };
    this.mount.appendChild(overlay);
  }

  /* ================================================================ *
   * Reusable widget builders
   * ================================================================ */

  _panel(modifier, title, tag) {
    const root = el('div', { class: `sio-panel ${modifier}` });
    const head = el('div', { class: 'sio-panel-head' }, [
      el('span', { class: 'sio-panel-title', text: title }),
      tag ? el('span', { class: 'sio-panel-tag', text: tag }) : null,
    ]);
    const body = el('div', { class: 'sio-panel-body' });
    root.append(head, body);
    return { root, head, body };
  }

  _slider({ id, label, value, format, onInput }) {
    const readout = el('span', { class: 'sio-slider-value', text: format(value) });
    const input = el('input', {
      class: 'sio-range',
      type: 'range',
      id,
      min: '0',
      max: '1',
      step: '0.01',
      value: String(value),
    });
    const fill = el('span', { class: 'sio-range-fill' });
    const setFill = (v) => { fill.style.transform = `scaleX(${v.toFixed(3)})`; };
    setFill(value);

    this._on(input, 'input', () => {
      const v = clamp01(parseFloat(input.value));
      readout.textContent = format(v);
      setFill(v);
      onInput(v);
    });

    const wrap = el('div', { class: 'sio-field sio-slider' }, [
      el('div', { class: 'sio-slider-head' }, [
        el('label', { class: 'sio-field-label', htmlFor: id, text: label }),
        readout,
      ]),
      el('div', { class: 'sio-range-wrap' }, [
        el('span', { class: 'sio-range-track', 'aria-hidden': 'true' }, [fill]),
        input,
      ]),
    ]);

    return { wrap, input, readout, setFill };
  }

  _toggle({ key, label, hint, on }) {
    const input = el('input', {
      class: 'sio-switch-input',
      type: 'checkbox',
      id: `sio-set-${key}`,
      checked: !!on,
    });
    this._on(input, 'change', () => {
      const next = input.checked;
      this.settings[key] = next;
      if (key === 'showHelp') this._applyHelpVisible(next);
      this._emit('onToggleSetting', key, next);
    });
    this._settingInputs.set(key, input);

    return el('label', { class: 'sio-switch', htmlFor: `sio-set-${key}`, title: hint || label }, [
      input,
      el('span', { class: 'sio-switch-track', 'aria-hidden': 'true' }, [el('span', { class: 'sio-switch-knob' })]),
      el('span', { class: 'sio-switch-text' }, [
        el('span', { class: 'sio-switch-label', text: label }),
        hint ? el('span', { class: 'sio-switch-hint', text: hint }) : null,
      ]),
    ]);
  }

  /* ================================================================ *
   * State application
   * ================================================================ */

  _applyPower(on, emit) {
    if (this.disposed) return;
    this.power = on;
    this.root.classList.toggle('is-live', on);
    this.els.rocker.classList.toggle('is-on', on);
    this.els.rocker.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.els.rockerState.textContent = on ? 'LIVE' : 'OFFLINE';
    if (emit) this._emit('onPower', on);
  }

  _applyReverse(on, emit) {
    if (this.disposed) return;
    this.reverse = on;
    this.root.classList.toggle('is-reverse', on);
    this.els.reverse.classList.toggle('is-on', on);
    this.els.reverse.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.els.reverseState.textContent = on ? 'REV' : 'FWD';
    if (emit) this._emit('onReverse', on);
  }

  _applyHelpVisible(visible) {
    this.settings.showHelp = visible;
    this.els.help.classList.toggle('is-hidden', !visible);
    const input = this._settingInputs.get('showHelp');
    if (input && input.checked !== visible) input.checked = visible;
  }

  _applyAudio(on, emit) {
    if (this.disposed) return;
    this.audio = !!on;
    const btn = this.els.audioBtn;
    btn.classList.toggle('is-on', this.audio);
    btn.setAttribute('aria-pressed', this.audio ? 'true' : 'false');
    this.els.audioState.textContent = this.audio ? 'ON' : 'MUTED';
    this.els.audioIco.innerHTML = this.audio ? ICON_AUDIO_ON : ICON_AUDIO_MUTED;
    this.els.volume.wrap.classList.toggle('is-disabled', !this.audio);
    this.els.volume.input.disabled = !this.audio;
    if (emit) this._emit('onAudioToggle', this.audio);
  }

  /* ================================================================ *
   * Painting
   * ================================================================ */

  _paintReadouts() {
    const s = this.stats;
    const fps = Number.isFinite(s.fps) ? s.fps : 0;

    this.els.fpsValue.textContent = fps > 0 ? String(Math.round(fps)) : '––';
    this.els.fpsValue.dataset.tier = fps >= 58 ? 'good' : fps >= 40 ? 'warn' : 'bad';

    this.els.perf.frameMs.textContent = fmtMs(s.frameMs);
    this.els.perf.physicsMs.textContent = fmtMs(s.physicsMs);
    this.els.perf.bodies.textContent = fmtCompact(s.bodies);
    this.els.perf.fragments.textContent = fmtCompact(s.fragments);
    this.els.perf.triangles.textContent = fmtCompact(s.triangles);
    this.els.perf.drawCalls.textContent = fmtCompact(s.drawCalls);

    this.els.telemetry.bodies.textContent = fmtInt(s.bodies);
    this.els.telemetry.fragments.textContent = fmtInt(s.fragments);
    this.els.telemetry.particles.textContent = fmtInt(s.particles);
    this.els.telemetry.triangles.textContent = fmtCompact(s.triangles);
  }

  _drawSparkline(force) {
    const ctx = this._sparkCtx;
    if (!ctx) return;
    const dpr = this._sparkDpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);

    /* backdrop + 60fps reference line */
    ctx.fillStyle = 'rgba(255,255,255,0.028)';
    ctx.fillRect(0, 0, SPARK_W, SPARK_H);

    const MAXV = 120;
    const y60 = SPARK_H - (60 / MAXV) * SPARK_H;
    ctx.strokeStyle = 'rgba(51,214,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y60) + 0.5);
    ctx.lineTo(SPARK_W, Math.round(y60) + 0.5);
    ctx.stroke();

    if (force && this._sampleCount === 0) return;

    const colorFor = (v) => (v >= 58 ? '57,217,138' : v >= 40 ? '255,176,32' : '255,59,48');
    const step = SPARK_W / SPARK_SAMPLES;

    for (let i = 0; i < SPARK_SAMPLES; i++) {
      const v = this._samples[i];
      if (!(v > 0)) continue;
      const h = Math.max(1, Math.min(SPARK_H, (v / MAXV) * SPARK_H));
      const x = i * step;
      const rgb = colorFor(v);
      ctx.fillStyle = `rgba(${rgb},0.30)`;
      ctx.fillRect(x, SPARK_H - h, Math.max(1, step), h);
      ctx.fillStyle = `rgba(${rgb},0.95)`;
      ctx.fillRect(x, SPARK_H - h, Math.max(1, step), 1.5);
    }
  }

  _requestAnim() {
    if (this._raf || this.disposed) return;
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick = () => {
    this._raf = 0;
    if (this.disposed) return;

    const k = this.reducedMotion ? 1 : 0.16;
    let busy = false;

    const dl = this.loadTarget - this.loadCurrent;
    if (Math.abs(dl) > 0.0004) { this.loadCurrent = lerp(this.loadCurrent, this.loadTarget, k); busy = true; }
    else this.loadCurrent = this.loadTarget;

    const dr = this.rpmTarget - this.rpmCurrent;
    if (Math.abs(dr) > 0.0004) { this.rpmCurrent = lerp(this.rpmCurrent, this.rpmTarget, k); busy = true; }
    else this.rpmCurrent = this.rpmTarget;

    this._renderGauge();
    if (busy) this._raf = requestAnimationFrame(this._tick);
  };

  _renderGauge() {
    if (!this.els) return;
    const v = clamp01(this.loadCurrent);
    const deg = GAUGE.a0 + GAUGE_SWEEP * v;

    /* needle: SVG "up" is -90° in our polar space → rotate from vertical */
    this.els.gaugeNeedle.style.transform = `rotate(${(90 - deg).toFixed(2)}deg)`;
    this.els.gaugeValue.style.strokeDashoffset = (GAUGE_LEN * (1 - v)).toFixed(2);
    this.els.gaugeNum.textContent = String(Math.round(v * 100));

    const rpm = clamp01(this.rpmCurrent);
    this.els.rpmFill.style.transform = `scaleX(${rpm.toFixed(4)})`;
    this.els.rpmNeedle.style.left = `${(rpm * 100).toFixed(2)}%`;
    this.els.rpmValue.textContent = fmtInt(rpm * this.rpmScale);
  }

  /* ================================================================ *
   * Events / lifecycle plumbing
   * ================================================================ */

  _bindGlobalKeys() {
    this._on(window, 'keydown', (e) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || ''))) return;
      e.preventDefault();
      /* debounce so a duplicate handler in main.js cannot cancel this out */
      const now = performance.now();
      if (now - this._lastTabToggle < 120) return;
      this._lastTabToggle = now;
      this.toggleUI();
    });
  }

  _on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push({ target, type, handler, options });
  }

  _setTimer(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _clearTimer(id) {
    clearTimeout(id);
    this._timers.delete(id);
  }

  _destroyGate() {
    if (!this._gate) return;
    const { overlay, button, onClick, onKey } = this._gate;
    button.removeEventListener('click', onClick);
    overlay.removeEventListener('keydown', onKey);
    if (overlay.parentNode) overlay.remove();
    this._gate = null;
  }

  _emit(name, ...args) {
    const fn = this.cb && this.cb[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[ControlPanel] ${name} handler threw`, err);
    }
  }
}

export default ControlPanel;
