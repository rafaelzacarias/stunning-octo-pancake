/**
 * GameHUD.js — Recycling-tycoon layer that sits on top of the ControlPanel.
 *
 * Owns the economy read-outs (bank, motor strain, contracts, upgrade shop,
 * jam-buster) while ControlPanel keeps owning the machine itself. Both mount
 * independently; this root sits at a higher z-index so the shop modal covers
 * the control room, but still below the boot / start-gate overlays.
 *
 * Self-contained: no imports, no dependencies, no network access.
 * Styles live in ./style.css under the `.sio-hud*` namespace.
 *
 * PERFORMANCE CONTRACT
 * Every setter is called once per frame by the sim. Nothing here creates,
 * removes or reorders a DOM node after construction: the contract rows,
 * upgrade rows, strain segments and toasts are all fixed-size pools that are
 * only ever mutated (text / class / transform / custom property), and every
 * write is guarded by a cached previous value. Number formatting and the
 * aria mirror are throttled to ~10 Hz; the count-up animation runs off a
 * self-cancelling rAF that stops as soon as everything has settled.
 */

/* ------------------------------------------------------------------ *
 * Tiny DOM helpers (mirrors ControlPanel's, kept local so the two
 * modules stay independently mountable)
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
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/* One shared formatter: constructing an Intl.NumberFormat per frame is the
   single most expensive thing a cash HUD can do. */
const CASH_FMT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtCash(v) {
  return CASH_FMT.format(Number.isFinite(v) ? v : 0);
}

/** Whole dollars for tight badges: `$1,240`. */
function fmtDollars(v) {
  if (!Number.isFinite(v)) return '$0';
  return '$' + Math.round(v).toLocaleString('en-US');
}

function fmtCount(v) {
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('en-US');
}

function fmtMassKg(kg) {
  if (!Number.isFinite(kg)) return '0 kg';
  if (kg >= 1000) return (kg / 1000).toFixed(kg >= 10000 ? 0 : 1) + ' t';
  if (kg >= 100) return kg.toFixed(0) + ' kg';
  return kg.toFixed(1) + ' kg';
}

/** Progress readouts may be fractional (kg contracts) or integral (counts). */
function fmtProgress(v) {
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v - Math.round(v)) < 0.05) return String(Math.round(v));
  return v.toFixed(1);
}

/** Upgrade effects arrive as a bare multiplier from GameDirector. */
function fmtEffect(effect) {
  if (typeof effect === 'string') return effect;
  if (!Number.isFinite(effect)) return '—';
  return '\u00d7' + effect.toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Inline SVG (no external icon files, ever)
 * ------------------------------------------------------------------ */

const ICON_SHOP = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-hud-ico-stroke" d="M4.4 8.2h15.2l-1.3 10.4H5.7z"/>
  <path class="sio-hud-ico-stroke" d="M8.8 8.2V6.4a3.2 3.2 0 0 1 6.4 0v1.8"/>
</svg>`;

const ICON_BOLT = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-hud-ico-fill" d="M13.6 2.6L5.4 13.4h5.1l-1.1 8 8.2-10.8h-5.1z"/>
</svg>`;

const ICON_CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-hud-ico-stroke" d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"/>
</svg>`;

const ICON_ARROW_UP = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-hud-ico-stroke" d="M12 19V6M6.5 11.5L12 5.6l5.5 5.9"/>
</svg>`;

const ICON_REVERSE = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="sio-hud-ico-stroke" d="M4.8 12a7.2 7.2 0 1 1 2.4 5.4"/>
  <path class="sio-hud-ico-stroke" d="M4.4 7.6v4.6h4.6"/>
</svg>`;

/* ------------------------------------------------------------------ *
 * Pool sizes / timings
 * ------------------------------------------------------------------ */

const SEGMENTS = 24;          // motor-strain bar cells
const SEG_AMBER = 14;         // first amber cell  (~58 %)
const SEG_RED = 20;           // first red cell    (~83 %)
const CONTRACT_SLOTS = 3;     // "up to 3 active contracts"
const UPGRADE_SLOTS = 6;      // 3 tracks today, headroom for 6
const PIP_SLOTS = 8;          // max pips drawn per upgrade track
const TOAST_SLOTS = 3;        // recycled ring — never allocates
const TOAST_MS = 2600;
const FLOURISH_MS = 950;      // completed-contract celebration hold
const GAIN_MS = 850;          // green cash flash
const SLOW_MS = 100;          // ~10 Hz throttle for formatted text
const CASH_MS = 50;           // ~20 Hz for the count-up (stays smooth)
/* Pooled nodes are seeded with a placeholder rather than '': assigning a
   non-empty string to an empty element would *create* its text node on first
   paint, which shows up as (one-off) DOM growth. Seeded, the node count is
   constant from construction onwards. Every seeded row starts hidden. */
const SEED = '\u2014';

export class GameHUD {
  /**
   * @param {HTMLElement} mount     container (usually document.body)
   * @param {{
   *   onPurchase?: (upgradeId: string) => void,
   *   onJamBuster?: () => void,
   *   onReverse?: (on: boolean) => void,
   *   onToggleShop?: (open: boolean) => void,
   *   onNotice?: (message: string, tone: string) => void,
   * }} [callbacks]
   */
  constructor(mount, callbacks = {}) {
    this.mount = mount || document.body;
    this.cb = callbacks || {};
    this.disposed = false;

    /* ---- economy ---- */
    this._cashTarget = 0;
    this._cashShown = 0;
    this._cashSeeded = false;
    this._gainAmount = 0;
    this._gainUntil = 0;

    /* ---- motor ---- */
    this._strainTarget = 0;
    this._strainShown = 0;
    this._stalled = false;

    /* ---- jam buster ---- */
    this._jamReady = true;
    this._jamActive = false;
    this._jamCooldown01 = 1;
    this._jamDuration01 = 0;
    this._reverse = false;

    /* ---- shop ---- */
    this._shopOpen = false;
    this._lastFocus = null;

    /* ---- data held for deferred re-application ---- */
    this._contractData = null;
    this._upgradeData = null;

    /* ---- paint caches (every DOM write is diffed against these) ---- */
    this._c = {
      cashText: fmtCash(0), gainText: '+' + fmtCash(0), gainOn: false,
      lit: -1, strainPct: -1, strainScale: -1, stalledClass: false,
      focusTitle: '', focusNums: '', focusScale: -1, focusEmpty: null,
      jamSweep: -1, jamDur: -1, jamState: '', jamSub: '', jamDisabled: null,
      items: -1, kg: -1, stalls: -1,
      toastSlot: 0,
    };

    /* ---- internals ---- */
    this._listeners = [];
    this._timers = new Set();
    this._raf = 0;
    this._lastTick = 0;
    this._lastSlow = 0;
    this._lastCashPaint = 0;

    this._contracts = [];   // pooled rows + per-slot paint cache
    this._upgrades = [];
    this._toasts = [];
    this._segments = [];

    this._motionQuery = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reducedMotion = !!(this._motionQuery && this._motionQuery.matches);
    if (this._motionQuery && this._motionQuery.addEventListener) {
      this._on(this._motionQuery, 'change', (e) => { this.reducedMotion = !!e.matches; });
    }

    this._build();
    this._bindKeys();
    this._paintCash(0, true);
    this._paintStrain(true);
    this._paintJam(true);
  }

  /* ================================================================ *
   * Public API
   * ================================================================ */

  /**
   * Bank balance. The read-out always eases toward `cash` — it never snaps.
   * @param {number} cash          current balance in dollars
   * @param {number|null} [deltaOrNull]  the change that produced it, if known
   */
  setCash(cash, deltaOrNull = null) {
    if (this.disposed) return;
    const next = num(cash, this._cashTarget);
    const explicit = Number.isFinite(deltaOrNull) ? deltaOrNull : null;
    const gain = explicit !== null ? explicit : next - this._cashTarget;

    this._cashTarget = next;
    if (!this._cashSeeded) {
      this._cashSeeded = true;
      /* Count up from zero on the first frame so a restored save still
         reads as an animation rather than a jump. */
      this._cashShown = 0;
    }

    if (gain > 0.004) {
      const now = this._now();
      /* Accumulate while a burst of payouts lands inside one flash. */
      this._gainAmount = now < this._gainUntil ? this._gainAmount + gain : gain;
      this._gainUntil = now + GAIN_MS;
    }
    this._requestAnim();
  }

  /**
   * Motor strain gauge. `stalled` pins the bar and flips the HUD into its
   * unmistakable red warning state.
   * @param {number} strain01
   * @param {boolean} [stalled]
   */
  setStrain(strain01, stalled = false) {
    if (this.disposed) return;
    this._strainTarget = clamp01(strain01);
    const isStalled = !!stalled;
    if (isStalled !== this._stalled) {
      this._stalled = isStalled;
      this.root.classList.toggle('is-stalled', isStalled);
      this.els.strainBar.setAttribute('aria-invalid', isStalled ? 'true' : 'false');
      this._paintJam(true); // the CTA label depends on the stall state
    }
    this._requestAnim();
  }

  /**
   * @param {Array<{id:string,name:string,blurb:string,level:number,maxLevel:number,
   *                cost:number|null,affordable:boolean,effect:number|string,maxed:boolean}>} list
   */
  setUpgrades(list) {
    if (this.disposed) return;
    this._upgradeData = Array.isArray(list) ? list : null;
    this._applyUpgrades();
  }

  /**
   * @param {Array<{id:string,title:string,description:string,progress:number,
   *                target:number,reward:number,done:boolean}>} list
   */
  setContracts(list) {
    if (this.disposed) return;
    this._contractData = Array.isArray(list) ? list : null;
    this._applyContracts();
  }

  /**
   * @param {{ready:boolean, active:boolean, cooldown01:number, duration01:number}} state
   */
  setJamBuster(state) {
    if (this.disposed) return;
    const s = state || {};
    this._jamReady = !!s.ready;
    this._jamActive = !!s.active;
    this._jamCooldown01 = clamp01(s.cooldown01);
    this._jamDuration01 = clamp01(s.duration01);
    this._paintJam(false);
  }

  /**
   * @param {{itemsDestroyed?:number, kgProcessed?:number, stalls?:number}} stats
   */
  setStats(stats) {
    if (this.disposed) return;
    const s = stats || {};
    const items = num(s.itemsDestroyed, this._c.items < 0 ? 0 : this._c.items);
    const kg = num(s.kgProcessed, this._c.kg < 0 ? 0 : this._c.kg);
    const stalls = num(s.stalls, this._c.stalls < 0 ? 0 : this._c.stalls);

    if (items !== this._c.items) {
      this._c.items = items;
      this.els.statItems.textContent = fmtCount(items);
    }
    /* kg drifts continuously — only repaint when the rendered string moves. */
    if (Math.abs(kg - this._c.kg) >= 0.05) {
      this._c.kg = kg;
      this.els.statKg.textContent = fmtMassKg(kg);
    }
    if (stalls !== this._c.stalls) {
      this._c.stalls = stalls;
      this.els.statStalls.textContent = fmtCount(stalls);
      this.els.stats.classList.toggle('has-stalls', stalls > 0);
    }
  }

  /**
   * Transient message in the HUD's own stack (ControlPanel keeps its own
   * bottom-centre toast for machine notices).
   * @param {string} message
   * @param {'info'|'good'|'warn'|'bad'} [tone]
   */
  toast(message, tone = 'info') {
    if (this.disposed) return;
    const text = String(message ?? '').trim();
    if (!text) return;
    const key = tone === 'good' || tone === 'warn' || tone === 'bad' ? tone : 'info';

    /* Fixed ring of slots: showing a fourth toast recycles the oldest node
       instead of allocating, so the node count is constant forever. */
    const slot = this._toasts[this._c.toastSlot % TOAST_SLOTS];
    this._c.toastSlot = (this._c.toastSlot + 1) % TOAST_SLOTS;

    slot.label.textContent = text;
    slot.node.className = `sio-hud-toast is-${key} is-shown`;
    slot.until = this._now() + TOAST_MS;
    /* Newest on top. Moving an existing node keeps the pool — and therefore the
       total node count — exactly as it was. */
    const stack = slot.node.parentNode;
    if (stack && stack.firstChild !== slot.node) stack.insertBefore(slot.node, stack.firstChild);
    this._emit('onNotice', text, key);
    this._requestAnim();
  }

  openShop() {
    if (this.disposed || this._shopOpen) return;
    this._shopOpen = true;
    this._lastFocus = document.activeElement;
    this.root.classList.add('shop-open');
    this.els.shop.classList.add('is-open');
    this.els.shop.setAttribute('aria-hidden', 'false');
    this.els.shopBtn.setAttribute('aria-expanded', 'true');
    this.els.shopBtn.classList.add('is-active');
    this._applyUpgrades();
    try { this.els.shopClose.focus({ preventScroll: true }); } catch { /* detached */ }
    this._emit('onToggleShop', true);
  }

  closeShop() {
    if (this.disposed || !this._shopOpen) return;
    this._shopOpen = false;
    this.root.classList.remove('shop-open');
    this.els.shop.classList.remove('is-open');
    this.els.shop.setAttribute('aria-hidden', 'true');
    this.els.shopBtn.setAttribute('aria-expanded', 'false');
    this.els.shopBtn.classList.remove('is-active');
    const back = this._lastFocus;
    this._lastFocus = null;
    if (back && typeof back.focus === 'function' && back.isConnected) {
      try { back.focus({ preventScroll: true }); } catch { /* gone */ }
    }
    this._emit('onToggleShop', false);
  }

  toggleShop() {
    if (this._shopOpen) this.closeShop();
    else this.openShop();
    return this._shopOpen;
  }

  /** @returns {boolean} */
  get isShopOpen() {
    return !!this._shopOpen && !this.disposed;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._shopOpen = false;

    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;

    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();

    for (const { target, type, handler, options } of this._listeners) {
      target.removeEventListener(type, handler, options);
    }
    this._listeners.length = 0;

    this._contracts.length = 0;
    this._upgrades.length = 0;
    this._toasts.length = 0;
    this._segments.length = 0;
    this._contractData = null;
    this._upgradeData = null;
    this._lastFocus = null;

    if (this.root && this.root.parentNode) this.root.remove();
    this.root = null;
    this.els = null;
  }

  /* ================================================================ *
   * Construction — every node in the HUD is created exactly once, here
   * ================================================================ */

  _build() {
    this.els = {};
    this.root = el('div', { class: 'sio-hud', 'data-sio': 'hud' });

    this.root.appendChild(this._buildTopBar());
    this.root.appendChild(this._buildContracts());
    this.root.appendChild(this._buildToasts());
    this.root.appendChild(this._buildShop());

    this.mount.appendChild(this.root);
  }

  /* ---------------- top bar ---------------- */

  _buildTopBar() {
    const bar = el('div', { class: 'sio-hud-top' });

    /* --- bank --- */
    this.els.cashValue = el('span', { class: 'sio-hud-cash-value', text: fmtCash(0) });
    this.els.cashDelta = el('span', { class: 'sio-hud-cash-delta', text: '+' + fmtCash(0), 'aria-hidden': 'true' });
    this.els.cash = el('div', { class: 'sio-hud-cash' }, [
      el('span', { class: 'sio-hud-cash-label', text: 'BANK' }),
      el('span', { class: 'sio-hud-cash-row' }, [this.els.cashValue, this.els.cashDelta]),
    ]);
    bar.appendChild(this.els.cash);

    bar.appendChild(el('span', { class: 'sio-hud-div', 'aria-hidden': 'true' }));

    /* --- motor strain --- */
    const segs = el('div', { class: 'sio-hud-segs', 'aria-hidden': 'true' });
    for (let i = 0; i < SEGMENTS; i++) {
      const band = i >= SEG_RED ? 'hi' : i >= SEG_AMBER ? 'mid' : 'lo';
      const seg = el('span', { class: `sio-hud-seg sio-hud-seg--${band}` });
      segs.appendChild(seg);
      this._segments.push(seg);
    }
    this.els.strainPct = el('span', { class: 'sio-hud-strain-pct', text: '0%' });
    this.els.strainLamp = el('span', { class: 'sio-hud-lamp' }, [
      el('span', { class: 'sio-hud-lamp-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'sio-hud-lamp-text', text: 'STALLED' }),
    ]);
    this.els.strainBar = el('div', {
      class: 'sio-hud-strain',
      role: 'progressbar',
      'aria-label': 'Motor strain',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    }, [
      el('div', { class: 'sio-hud-strain-head' }, [
        el('span', { class: 'sio-hud-strain-label', text: 'MOTOR STRAIN' }),
        this.els.strainLamp,
        this.els.strainPct,
      ]),
      segs,
    ]);
    bar.appendChild(this.els.strainBar);

    bar.appendChild(el('span', { class: 'sio-hud-div', 'aria-hidden': 'true' }));

    /* --- active contract summary --- */
    this.els.focusTitle = el('span', { class: 'sio-hud-focus-title', text: 'NO ACTIVE CONTRACT' });
    this.els.focusNums = el('span', { class: 'sio-hud-focus-nums', text: '—' });
    this.els.focusFill = el('span', { class: 'sio-hud-focus-fill' });
    this.els.focus = el('div', { class: 'sio-hud-focus is-empty' }, [
      el('span', { class: 'sio-hud-focus-label', text: 'CONTRACT' }),
      this.els.focusTitle,
      el('span', { class: 'sio-hud-focus-track' }, [this.els.focusFill]),
      this.els.focusNums,
    ]);
    bar.appendChild(this.els.focus);

    /* --- actions --- */
    bar.appendChild(this._buildActions());
    return bar;
  }

  _buildActions() {
    const wrap = el('div', { class: 'sio-hud-actions' });

    /* Upgrade shop */
    this.els.shopBtn = el('button', {
      class: 'sio-hud-btn sio-hud-btn--shop',
      type: 'button',
      title: 'Upgrade shop (U)',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    }, [
      el('span', { class: 'sio-hud-btn-ico', html: ICON_SHOP }),
      el('span', { class: 'sio-hud-btn-label', text: 'UPGRADES' }),
      el('span', { class: 'sio-hud-key', text: 'U' }),
    ]);
    this._on(this.els.shopBtn, 'click', () => this.toggleShop());
    wrap.appendChild(this.els.shopBtn);

    /* Jam buster — the emergency "unstick it" control */
    this.els.jamSweep = el('span', { class: 'sio-hud-jam-sweep', 'aria-hidden': 'true' });
    this.els.jamDur = el('span', { class: 'sio-hud-jam-dur', 'aria-hidden': 'true' });
    this.els.jamSub = el('span', { class: 'sio-hud-jam-sub', text: 'READY' });
    this.els.jamBtn = el('button', {
      class: 'sio-hud-jam is-ready',
      type: 'button',
      title: 'Jam buster — reverse burst (J)',
    }, [
      this.els.jamSweep,
      this.els.jamDur,
      el('span', { class: 'sio-hud-jam-face' }, [
        el('span', { class: 'sio-hud-jam-ico', html: ICON_BOLT }),
        el('span', { class: 'sio-hud-jam-text' }, [
          el('span', { class: 'sio-hud-jam-label', text: 'JAM BUSTER' }),
          this.els.jamSub,
        ]),
      ]),
      el('span', { class: 'sio-hud-key sio-hud-key--jam', text: 'J' }),
    ]);
    this._on(this.els.jamBtn, 'click', () => this._fireJamBuster());
    wrap.appendChild(this.els.jamBtn);

    /* Manual reverse */
    this.els.revBtn = el('button', {
      class: 'sio-hud-btn sio-hud-btn--rev',
      type: 'button',
      title: 'Reverse rotor',
      'aria-pressed': 'false',
    }, [
      el('span', { class: 'sio-hud-btn-ico', html: ICON_REVERSE }),
      el('span', { class: 'sio-hud-btn-label', text: 'REVERSE' }),
    ]);
    this._on(this.els.revBtn, 'click', () => {
      this._reverse = !this._reverse;
      this.els.revBtn.classList.toggle('is-active', this._reverse);
      this.els.revBtn.setAttribute('aria-pressed', this._reverse ? 'true' : 'false');
      this._emit('onReverse', this._reverse);
    });
    wrap.appendChild(this.els.revBtn);

    return wrap;
  }

  /* ---------------- contracts panel ---------------- */

  _buildContracts() {
    const panel = el('div', { class: 'sio-hud-panel sio-hud-contracts' });
    panel.appendChild(el('div', { class: 'sio-hud-panel-head' }, [
      el('span', { class: 'sio-hud-panel-title', text: 'CONTRACTS' }),
      el('span', { class: 'sio-hud-panel-sub', text: 'ACTIVE' }),
    ]));

    const body = el('div', { class: 'sio-hud-panel-body' });
    for (let i = 0; i < CONTRACT_SLOTS; i++) {
      const title = el('span', { class: 'sio-hud-ct-title', text: SEED });
      const reward = el('span', { class: 'sio-hud-ct-reward', text: SEED });
      const desc = el('span', { class: 'sio-hud-ct-desc', text: SEED });
      const fill = el('span', { class: 'sio-hud-ct-fill' });
      const nums = el('span', { class: 'sio-hud-ct-nums', text: SEED });
      const stamp = el('span', { class: 'sio-hud-ct-stamp', text: 'COMPLETE' });
      const node = el('div', { class: 'sio-hud-ct is-empty' }, [
        el('span', { class: 'sio-hud-ct-top' }, [title, reward]),
        desc,
        el('span', { class: 'sio-hud-ct-track' }, [fill]),
        nums,
        stamp,
      ]);
      body.appendChild(node);
      this._contracts.push({
        node, title, reward, desc, fill, nums,
        id: null, titleText: SEED, descText: SEED, rewardText: SEED, numsText: SEED,
        scale: -1, empty: null, done: false, holdUntil: 0, celebrating: false,
      });
    }

    this.els.statItems = el('span', { class: 'sio-hud-stat-value', text: '0' });
    this.els.statKg = el('span', { class: 'sio-hud-stat-value', text: '0.0 kg' });
    this.els.statStalls = el('span', { class: 'sio-hud-stat-value', text: '0' });
    this.els.stats = el('div', { class: 'sio-hud-stats' }, [
      el('span', { class: 'sio-hud-stat' }, [
        el('span', { class: 'sio-hud-stat-label', text: 'SHREDDED' }), this.els.statItems,
      ]),
      el('span', { class: 'sio-hud-stat' }, [
        el('span', { class: 'sio-hud-stat-label', text: 'PROCESSED' }), this.els.statKg,
      ]),
      el('span', { class: 'sio-hud-stat sio-hud-stat--stalls' }, [
        el('span', { class: 'sio-hud-stat-label', text: 'STALLS' }), this.els.statStalls,
      ]),
    ]);

    panel.appendChild(body);
    /* Footer, not part of `body`: the contract rows scroll, the run totals
       stay pinned to the bottom of the panel. */
    panel.appendChild(this.els.stats);
    return panel;
  }

  /* ---------------- right rail: stall CTA + toast stack ---------------- */

  _buildToasts() {
    /* Lives outside .sio-hud-top because that panel is clip-path'd — anything
       overflowing it (like a callout pointing at the jam buster) is cut off. */
    const rail = el('div', { class: 'sio-hud-rail' });

    this.els.cta = el('div', { class: 'sio-hud-cta', 'aria-hidden': 'true' }, [
      el('span', { class: 'sio-hud-cta-arrow', html: ICON_ARROW_UP }),
      el('span', { class: 'sio-hud-cta-text', text: 'JAMMED — HIT JAM BUSTER (J)' }),
    ]);
    rail.appendChild(this.els.cta);

    const stack = el('div', { class: 'sio-hud-toasts', role: 'status', 'aria-live': 'polite' });
    for (let i = 0; i < TOAST_SLOTS; i++) {
      const label = el('span', { class: 'sio-hud-toast-text', text: SEED });
      const node = el('div', { class: 'sio-hud-toast' }, [
        el('span', { class: 'sio-hud-toast-bar', 'aria-hidden': 'true' }),
        label,
      ]);
      stack.appendChild(node);
      this._toasts.push({ node, label, until: 0 });
    }
    rail.appendChild(stack);
    return rail;
  }

  /* ---------------- upgrade shop modal ---------------- */

  _buildShop() {
    const backdrop = el('div', { class: 'sio-hud-shop-backdrop' });
    this._on(backdrop, 'click', () => this.closeShop());

    this.els.shopClose = el('button', {
      class: 'sio-hud-shop-close',
      type: 'button',
      'aria-label': 'Close upgrade shop',
      html: ICON_CLOSE,
    });
    this._on(this.els.shopClose, 'click', () => this.closeShop());

    this.els.shopCash = el('span', { class: 'sio-hud-shop-cash', text: fmtCash(0) });

    const list = el('div', { class: 'sio-hud-shop-list' });
    for (let i = 0; i < UPGRADE_SLOTS; i++) {
      const name = el('span', { class: 'sio-hud-up-name', text: SEED });
      const pips = el('span', { class: 'sio-hud-up-pips', 'aria-hidden': 'true' });
      const pipNodes = [];
      for (let p = 0; p < PIP_SLOTS; p++) {
        const pip = el('span', { class: 'sio-hud-pip is-hidden' });
        pips.appendChild(pip);
        pipNodes.push(pip);
      }
      const levelText = el('span', { class: 'sio-hud-up-level', text: SEED });
      const blurb = el('span', { class: 'sio-hud-up-blurb', text: SEED });
      const effect = el('span', { class: 'sio-hud-up-effect', text: SEED });
      const buy = el('button', { class: 'sio-hud-up-buy', type: 'button', text: SEED });
      const node = el('div', { class: 'sio-hud-up is-empty' }, [
        el('span', { class: 'sio-hud-up-head' }, [name, levelText, pips]),
        blurb,
        el('span', { class: 'sio-hud-up-foot' }, [effect, buy]),
      ]);
      list.appendChild(node);

      const row = {
        node, name, pips: pipNodes, levelText, blurb, effect, buy,
        id: null, nameText: SEED, blurbText: SEED, levelLabel: SEED, effectText: SEED,
        buyText: SEED, buyDisabled: null, state: '', level: -1, maxLevel: -1, empty: null,
      };
      this._on(buy, 'click', () => {
        if (this.disposed || !row.id || buy.disabled) return;
        this._emit('onPurchase', row.id);
      });
      this._upgrades.push(row);
    }

    const panel = el('div', {
      class: 'sio-hud-shop-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Upgrade shop',
      tabIndex: -1,
    }, [
      el('div', { class: 'sio-hud-shop-head' }, [
        el('span', { class: 'sio-hud-shop-title', text: 'UPGRADE SHOP' }),
        el('span', { class: 'sio-hud-shop-bank' }, [
          el('span', { class: 'sio-hud-shop-bank-label', text: 'BANK' }),
          this.els.shopCash,
        ]),
        this.els.shopClose,
      ]),
      list,
      el('div', { class: 'sio-hud-shop-foot' }, [
        el('span', { class: 'sio-hud-shop-hint', text: 'ESC OR U TO CLOSE' }),
      ]),
    ]);

    this.els.shop = el('div', { class: 'sio-hud-shop', 'aria-hidden': 'true' }, [backdrop, panel]);
    this.els.shopPanel = panel;
    return this.els.shop;
  }

  /* ================================================================ *
   * Painting — all diffed against `this._c` / per-row caches
   * ================================================================ */

  _paintCash(now, force) {
    if (!this.els) return;
    if (!force && now - this._lastCashPaint < CASH_MS) return;
    this._lastCashPaint = now;

    const text = fmtCash(this._cashShown);
    if (text !== this._c.cashText) {
      this._c.cashText = text;
      this.els.cashValue.textContent = text;
      this.els.shopCash.textContent = text;
    }

    const showGain = now < this._gainUntil;
    if (showGain) {
      const gainText = '+' + fmtCash(this._gainAmount);
      if (gainText !== this._c.gainText) {
        this._c.gainText = gainText;
        this.els.cashDelta.textContent = gainText;
      }
    }
    if (showGain !== this._c.gainOn) {
      this._c.gainOn = showGain;
      this.els.cash.classList.toggle('is-gain', showGain);
    }
  }

  _paintStrain(force) {
    if (!this.els) return;
    const v = this._stalled ? 1 : clamp01(this._strainShown);

    const lit = Math.round(v * SEGMENTS);
    if (lit !== this._c.lit || force) {
      const from = Math.min(this._c.lit < 0 ? 0 : this._c.lit, lit);
      const to = Math.max(this._c.lit < 0 ? SEGMENTS : this._c.lit, lit);
      for (let i = from; i < to; i++) {
        this._segments[i].classList.toggle('is-lit', i < lit);
      }
      this._c.lit = lit;
    }

    const pct = Math.round(v * 100);
    if (pct !== this._c.strainPct || force) {
      this._c.strainPct = pct;
      this.els.strainPct.textContent = pct + '%';
      this.els.strainBar.setAttribute('aria-valuenow', String(pct));
    }
  }

  _paintJam(force) {
    if (!this.els) return;
    const cooldown = clamp01(this._jamCooldown01);
    const duration = clamp01(this._jamDuration01);
    const ready = this._jamReady && !this._jamActive;
    const state = this._jamActive ? 'active' : ready ? 'ready' : 'cool';

    if (state !== this._c.jamState || force) {
      this._c.jamState = state;
      this.els.jamBtn.className =
        `sio-hud-jam is-${state === 'cool' ? 'cooling' : state}` +
        (this._stalled && state === 'ready' ? ' is-urgent' : '');
    }

    const disabled = state === 'cool';
    if (disabled !== this._c.jamDisabled) {
      this._c.jamDisabled = disabled;
      this.els.jamBtn.disabled = disabled;
    }

    /* radial sweep: 0 just fired -> 1 fully recharged */
    const sweep = state === 'active' ? 1 : Math.round(cooldown * 100) / 100;
    if (sweep !== this._c.jamSweep || force) {
      this._c.jamSweep = sweep;
      this.els.jamSweep.style.setProperty('--sio-hud-sweep', String(sweep));
    }

    const dur = Math.round(duration * 100) / 100;
    if (dur !== this._c.jamDur || force) {
      this._c.jamDur = dur;
      this.els.jamDur.style.transform = `scaleX(${dur.toFixed(3)})`;
    }

    const sub = state === 'active'
      ? 'BURSTING'
      : state === 'ready'
        ? (this._stalled ? 'CLEAR IT' : 'READY')
        : `CHARGING ${Math.round(cooldown * 100)}%`;
    if (sub !== this._c.jamSub || force) {
      this._c.jamSub = sub;
      this.els.jamSub.textContent = sub;
    }
  }

  _applyContracts() {
    if (!this.els) return;
    const list = this._contractData;
    const now = this._now();

    for (let i = 0; i < CONTRACT_SLOTS; i++) {
      const slot = this._contracts[i];
      const row = list && i < list.length ? list[i] : null;

      /* A finished contract holds its slot for a beat so the completion is
         readable, then the replacement is adopted. */
      if (slot.holdUntil > now) continue;
      if (slot.celebrating) {
        slot.celebrating = false;
        slot.node.classList.remove('is-complete');
      }

      const empty = !row;
      if (empty !== slot.empty) {
        slot.empty = empty;
        slot.node.classList.toggle('is-empty', empty);
      }
      if (empty) {
        slot.id = null;
        slot.done = false;
        continue;
      }

      const id = String(row.id ?? i);
      const target = Math.max(1e-6, num(row.target, 1));
      const progress = Math.max(0, Math.min(num(row.progress, 0), target));
      const done = !!row.done || progress >= target;

      const titleText = String(row.title ?? '');
      if (titleText !== slot.titleText) {
        slot.titleText = titleText;
        slot.title.textContent = titleText;
      }
      const descText = String(row.description ?? '');
      if (descText !== slot.descText) {
        slot.descText = descText;
        slot.desc.textContent = descText;
      }
      const rewardText = '+' + fmtDollars(num(row.reward, 0));
      if (rewardText !== slot.rewardText) {
        slot.rewardText = rewardText;
        slot.reward.textContent = rewardText;
      }
      const numsText = `${fmtProgress(progress)} / ${fmtProgress(row.target)}`;
      if (numsText !== slot.numsText) {
        slot.numsText = numsText;
        slot.nums.textContent = numsText;
      }
      const scale = Math.round((progress / target) * 1000) / 1000;
      if (scale !== slot.scale) {
        slot.scale = scale;
        slot.fill.style.transform = `scaleX(${scale.toFixed(3)})`;
      }

      /* Completion = this slot flipped to done, or its id was swapped out
         while it was sitting at (or above) target. */
      const swapped = slot.id !== null && slot.id !== id;
      const finished = (!swapped && !slot.done && done) || (swapped && slot.done);
      slot.id = id;
      slot.done = done;
      if (finished) {
        slot.celebrating = true;
        slot.holdUntil = now + (this.reducedMotion ? 220 : FLOURISH_MS);
        slot.node.classList.add('is-complete');
        this._requestAnim();
      }
    }

    this._applyFocus(list);
  }

  /** Top-bar summary: the first unfinished contract, else the first slot. */
  _applyFocus(list) {
    let row = null;
    if (list && list.length) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c && !c.done) { row = c; break; }
      }
      if (!row) row = list[0] || null;
    }

    const empty = !row;
    if (empty !== this._c.focusEmpty) {
      this._c.focusEmpty = empty;
      this.els.focus.classList.toggle('is-empty', empty);
    }
    if (empty) {
      if (this._c.focusTitle !== 'NO ACTIVE CONTRACT') {
        this._c.focusTitle = 'NO ACTIVE CONTRACT';
        this.els.focusTitle.textContent = 'NO ACTIVE CONTRACT';
      }
      return;
    }

    const title = String(row.title ?? '');
    if (title !== this._c.focusTitle) {
      this._c.focusTitle = title;
      this.els.focusTitle.textContent = title;
    }
    const target = Math.max(1e-6, num(row.target, 1));
    const progress = Math.max(0, Math.min(num(row.progress, 0), target));
    const nums = `${fmtProgress(progress)}/${fmtProgress(row.target)}`;
    if (nums !== this._c.focusNums) {
      this._c.focusNums = nums;
      this.els.focusNums.textContent = nums;
    }
    const scale = Math.round((progress / target) * 1000) / 1000;
    if (scale !== this._c.focusScale) {
      this._c.focusScale = scale;
      this.els.focusFill.style.transform = `scaleX(${scale.toFixed(3)})`;
    }
  }

  _applyUpgrades() {
    if (!this.els) return;
    const list = this._upgradeData;

    for (let i = 0; i < UPGRADE_SLOTS; i++) {
      const slot = this._upgrades[i];
      const row = list && i < list.length ? list[i] : null;

      const empty = !row;
      if (empty !== slot.empty) {
        slot.empty = empty;
        slot.node.classList.toggle('is-empty', empty);
      }
      if (empty) {
        slot.id = null;
        if (slot.buyDisabled !== true) {
          slot.buyDisabled = true;
          slot.buy.disabled = true;
        }
        continue;
      }

      slot.id = String(row.id ?? '');

      const nameText = String(row.name ?? slot.id);
      if (nameText !== slot.nameText) {
        slot.nameText = nameText;
        slot.name.textContent = nameText;
      }
      const blurbText = String(row.blurb ?? '');
      if (blurbText !== slot.blurbText) {
        slot.blurbText = blurbText;
        slot.blurb.textContent = blurbText;
      }

      const maxLevel = Math.max(0, Math.min(PIP_SLOTS, Math.round(num(row.maxLevel, 0))));
      const level = Math.max(0, Math.min(maxLevel, Math.round(num(row.level, 0))));
      if (level !== slot.level || maxLevel !== slot.maxLevel) {
        /* Only runs on an actual purchase — a flat 8-iteration pass is
           cheaper to reason about than a windowed diff. */
        for (let p = 0; p < PIP_SLOTS; p++) {
          const cls = p >= maxLevel
            ? 'sio-hud-pip is-hidden'
            : p < level ? 'sio-hud-pip is-on' : 'sio-hud-pip';
          if (slot.pips[p].className !== cls) slot.pips[p].className = cls;
        }
        slot.level = level;
        slot.maxLevel = maxLevel;
        const levelLabel = `LV ${level}/${maxLevel}`;
        if (levelLabel !== slot.levelLabel) {
          slot.levelLabel = levelLabel;
          slot.levelText.textContent = levelLabel;
        }
      }

      const effectText = level > 0
        ? `NOW ${fmtEffect(row.effect)}`
        : `BASE ${fmtEffect(row.effect)}`;
      if (effectText !== slot.effectText) {
        slot.effectText = effectText;
        slot.effect.textContent = effectText;
      }

      const maxed = !!row.maxed;
      const affordable = !maxed && !!row.affordable;
      const buyText = maxed ? 'MAX' : Number.isFinite(row.cost) ? fmtDollars(row.cost) : '—';
      if (buyText !== slot.buyText) {
        slot.buyText = buyText;
        slot.buy.textContent = buyText;
      }
      const state = maxed ? 'maxed' : affordable ? 'ok' : 'poor';
      if (state !== slot.state) {
        slot.state = state;
        slot.buy.className = `sio-hud-up-buy is-${state}`;
        slot.node.classList.toggle('is-maxed', maxed);
        slot.node.classList.toggle('is-affordable', affordable);
      }
      const disabled = maxed || !affordable;
      if (disabled !== slot.buyDisabled) {
        slot.buyDisabled = disabled;
        slot.buy.disabled = disabled;
        slot.buy.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      }
    }
  }

  /* ================================================================ *
   * Animation — one self-cancelling rAF drives every easing curve
   * ================================================================ */

  _requestAnim() {
    if (this._raf || this.disposed) return;
    this._lastTick = this._now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick = () => {
    this._raf = 0;
    if (this.disposed || !this.els) return;

    const now = this._now();
    const dt = Math.min(0.1, Math.max(0, (now - this._lastTick) / 1000));
    this._lastTick = now;
    let busy = false;

    /* --- cash count-up --- */
    const dCash = this._cashTarget - this._cashShown;
    if (Math.abs(dCash) > 0.004) {
      if (this.reducedMotion) {
        this._cashShown = this._cashTarget;
      } else {
        const k = 1 - Math.exp(-dt * 9);
        const floor = Math.min(Math.abs(dCash), dt * 14); // no crawling cents
        this._cashShown += Math.sign(dCash) * Math.max(Math.abs(dCash) * k, floor);
      }
      busy = true;
    } else {
      this._cashShown = this._cashTarget;
    }
    if (now < this._gainUntil) busy = true;
    this._paintCash(now, false);

    /* --- strain easing --- */
    const dStrain = this._strainTarget - this._strainShown;
    if (Math.abs(dStrain) > 0.0008) {
      this._strainShown += dStrain * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 12));
      busy = true;
    } else {
      this._strainShown = this._strainTarget;
    }

    /* Formatted text + aria mirror at ~10 Hz; the segment bar follows the
       eased value directly because a class toggle is cheaper than a reflow. */
    const slow = now - this._lastSlow >= SLOW_MS;
    if (slow) this._lastSlow = now;
    this._paintStrain(false);
    if (slow) this._paintJam(false);

    /* --- toasts --- */
    for (const t of this._toasts) {
      if (!t.until) continue;
      if (now >= t.until) {
        t.until = 0;
        t.node.classList.remove('is-shown');
      } else busy = true;
    }

    /* --- contract completion holds --- */
    let holding = false;
    for (const slot of this._contracts) {
      if (slot.holdUntil && now >= slot.holdUntil) {
        slot.holdUntil = 0;
        holding = true; // a slot just freed up: re-apply the pending data
      } else if (slot.holdUntil) busy = true;
    }
    if (holding) this._applyContracts();

    if (busy) {
      this._raf = requestAnimationFrame(this._tick);
    }
  };

  /* ================================================================ *
   * Events / lifecycle plumbing
   * ================================================================ */

  _fireJamBuster() {
    if (this.disposed) return;
    if (!this._jamReady || this._jamActive) {
      this.toast('Jam buster still charging', 'warn');
      return;
    }
    this._emit('onJamBuster');
  }

  /**
   * `U` toggles the shop, `J` fires the jam buster, `Escape` closes the shop.
   * Everything the app already owns (Space, R, C, digits, F-keys, Tab) is left
   * strictly alone — no preventDefault, no swallow.
   */
  _bindKeys() {
    this._on(window, 'keydown', (e) => {
      if (this.disposed || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || ''))) return;

      const key = e.key;
      if (key === 'Escape') {
        if (!this._shopOpen) return;
        e.preventDefault();
        this.closeShop();
        return;
      }
      if (key === 'u' || key === 'U') {
        e.preventDefault();
        this.toggleShop();
        return;
      }
      if (key === 'j' || key === 'J') {
        e.preventDefault();
        this._fireJamBuster();
      }
    });
  }

  _now() {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  _on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push({ target, type, handler, options });
  }

  _emit(name, ...args) {
    const fn = this.cb && this.cb[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[GameHUD] ${name} handler threw`, err);
    }
  }
}

export default GameHUD;
