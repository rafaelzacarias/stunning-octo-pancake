/* ==================================================================
   shredding.io — TouchControls
   On-screen touch control bar for phones. Self-contained: injects its
   own <style> tag (style.css is owned by another agent) and owns no
   state outside its DOM root.

   Pure DOM + CSS. No `three`, no network, no module-scope DOM access
   (safe to `import` in Node — every document/window touch happens
   inside the constructor or later).
   ================================================================== */

const STYLE_ID_PREFIX = 'sio-touch-controls-style';

const FEED_HOLD_DELAY_MS = 400;
const FEED_REPEAT_MS = 333; // ~3 per second

/* ------------------------------------------------------------------
   Icons — static markup only, never interpolated with caller data.
   ------------------------------------------------------------------ */
const ICONS = {
  power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v8"/><path d="M6.8 6.4a7.5 7.5 0 1 0 10.4 0"/></svg>',
  feed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 18.5h16"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11"/><path d="M4 12h11"/><path d="M4 17h7"/><path d="m17.5 14.5 2.5 2.5 2.5-2.5" transform="translate(-2 0)"/></svg>',
  reverse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 1 0-2.4 5.7"/><path d="M20 5.5v6h-6"/></svg>',
  jam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2.5 4.5 13.5h6l-1 8 9-11h-6z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5h3.5L8.5 6h7l2 2.5H21v10H3z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18.5h16"/><path d="M12 3.5v9"/><path d="M8 9l4 4 4-4"/><path d="M3.5 14.5h2M18.5 14.5h2"/></svg>',
  shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16l-1.2 11.5H5.2z"/><path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/* ------------------------------------------------------------------
   Stylesheet — scoped to .sio-touch-bar.
   Colour tokens fall back to the spec palette when the host app's
   :root vars are absent (e.g. inside a test harness).
   ------------------------------------------------------------------ */
const CSS = `
.sio-touch-bar{
  --tc-amber: var(--sio-amber, #ffd23f);
  --tc-cyan: var(--sio-cyan, #4ad9e4);
  --tc-danger: var(--sio-danger, #ff3b30);
  --tc-text: var(--sio-text, #e6ebef);
  --tc-dim: var(--sio-dim, #8b969e);
  --tc-faint: var(--sio-faint, #5c666d);
  --tc-line: var(--sio-line, rgba(255,255,255,.08));
  --tc-line-strong: var(--sio-line-strong, rgba(255,255,255,.16));
  --tc-mono: var(--sio-mono, ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace);
  --tc-safe: env(safe-area-inset-bottom, 0px);
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 40;
  pointer-events: none;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.2;
  color: var(--tc-text);
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-font-smoothing: antialiased;
}
.sio-touch-bar *, .sio-touch-bar *::before, .sio-touch-bar *::after { box-sizing: border-box; }
.sio-touch-bar.is-hidden { display: none; }

/* ---- bar row ---- */
.sio-tc-row{
  position: relative;
  pointer-events: auto;
  display: flex;
  align-items: stretch;
  gap: 5px;
  padding: 7px 7px calc(7px + var(--tc-safe));
  background: linear-gradient(180deg, rgba(10,12,14,.80), rgba(6,8,10,.95));
  border-top: 1px solid var(--tc-line-strong);
  box-shadow: 0 -10px 30px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter: blur(12px) saturate(1.2);
  -webkit-backdrop-filter: blur(12px) saturate(1.2);
  touch-action: manipulation;
}

/* ---- buttons ---- */
.sio-touch-bar .sio-tc-btn{
  position: relative;
  overflow: hidden;
  flex: 1 1 0;
  min-width: 46px;
  min-height: 46px;
  height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  margin: 0;
  padding: 4px 2px;
  font: inherit;
  color: var(--tc-text);
  background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.015));
  border: 1px solid var(--tc-line-strong);
  border-radius: 4px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-user-select: none; user-select: none;
  transition: background .14s ease, border-color .14s ease, color .14s ease, transform .06s ease;
}
.sio-touch-bar .sio-tc-btn:focus-visible{ outline: 2px solid var(--tc-cyan); outline-offset: 2px; }
.sio-touch-bar .sio-tc-btn.is-press{
  transform: translateY(1px);
  background: linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.05));
}
.sio-tc-ico{ flex: 0 0 auto; display: block; width: 20px; height: 20px; color: var(--tc-dim); }
.sio-tc-ico svg{
  display: block; width: 20px; height: 20px;
  fill: none; stroke: currentColor; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round;
}
.sio-tc-lab{
  max-width: 100%;
  font-family: var(--tc-mono);
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--tc-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- power ---- */
.sio-tc-btn--power[aria-pressed="true"]{
  border-color: rgba(57,217,138,.55);
  background: linear-gradient(180deg, rgba(57,217,138,.22), rgba(57,217,138,.05));
}
.sio-tc-btn--power[aria-pressed="true"] .sio-tc-ico,
.sio-tc-btn--power[aria-pressed="true"] .sio-tc-lab{
  color: var(--sio-green, #39d98a);
  text-shadow: 0 0 12px rgba(57,217,138,.5);
}

/* ---- feed (primary) ---- */
.sio-touch-bar .sio-tc-btn--feed{
  flex: 2.2 1 0;
  min-width: 80px;
  border-color: color-mix(in srgb, var(--tc-amber) 45%, transparent);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--tc-amber) 24%, transparent),
    color-mix(in srgb, var(--tc-amber) 6%, transparent));
}
.sio-tc-btn--feed .sio-tc-ico, .sio-tc-btn--feed .sio-tc-lab{ color: var(--tc-amber); }
.sio-tc-btn--feed .sio-tc-lab{ font-size: 10px; letter-spacing: .14em; }
.sio-tc-btn--feed.is-press{
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--tc-amber) 40%, transparent),
    color-mix(in srgb, var(--tc-amber) 14%, transparent));
}

/* ---- item selector ---- */
.sio-tc-btn--item .sio-tc-lab{ color: var(--tc-cyan); }
.sio-tc-btn--item[aria-expanded="true"]{
  border-color: color-mix(in srgb, var(--tc-cyan) 55%, transparent);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--tc-cyan) 20%, transparent),
    color-mix(in srgb, var(--tc-cyan) 4%, transparent));
}

/* ---- reverse (held) ---- */
.sio-tc-btn--rev.is-on{
  border-color: color-mix(in srgb, var(--tc-amber) 55%, transparent);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--tc-amber) 26%, transparent),
    color-mix(in srgb, var(--tc-amber) 6%, transparent));
}
.sio-tc-btn--rev.is-on .sio-tc-ico, .sio-tc-btn--rev.is-on .sio-tc-lab{
  color: var(--tc-amber);
  text-shadow: 0 0 12px color-mix(in srgb, var(--tc-amber) 60%, transparent);
}

/* ---- jam-buster + cooldown ---- */
.sio-tc-cool{
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 0;
  background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.05));
  pointer-events: none;
  transition: height .12s linear;
}
.sio-tc-btn--jam[aria-disabled="true"]{ cursor: default; }
.sio-tc-btn--jam[aria-disabled="true"] .sio-tc-ico,
.sio-tc-btn--jam[aria-disabled="true"] .sio-tc-lab{ color: var(--tc-faint); }
.sio-tc-btn--jam.is-stalled{
  border-color: color-mix(in srgb, var(--tc-danger) 65%, transparent);
  animation: sio-tc-pulse 1s ease-in-out infinite;
}
.sio-tc-btn--jam.is-stalled .sio-tc-ico,
.sio-tc-btn--jam.is-stalled .sio-tc-lab{ color: var(--tc-danger); }
@keyframes sio-tc-pulse{
  0%, 100% { box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--tc-danger) 0%, transparent); }
  50%      { box-shadow: inset 0 0 14px 0 color-mix(in srgb, var(--tc-danger) 45%, transparent); }
}

/* ---- toggles in the overflow ---- */
.sio-tc-mbtn[aria-pressed="true"]{
  border-color: color-mix(in srgb, var(--tc-cyan) 55%, transparent);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--tc-cyan) 20%, transparent),
    color-mix(in srgb, var(--tc-cyan) 4%, transparent));
}
.sio-tc-mbtn[aria-pressed="true"] .sio-tc-ico,
.sio-tc-mbtn[aria-pressed="true"] .sio-tc-lab{ color: var(--tc-cyan); }

/* ---- overflow menu ---- */
.sio-tc-scrim{
  position: fixed; inset: 0;
  z-index: 1;
  display: none;
  background: rgba(4,6,8,.35);
}
.sio-tc-menu{
  position: absolute;
  right: 7px;
  bottom: 100%;
  z-index: 2;
  display: none;
  margin-bottom: 6px;
  padding: 6px;
  gap: 5px;
  grid-template-columns: repeat(2, 72px);
  background: linear-gradient(180deg, rgba(10,12,14,.92), rgba(6,8,10,.97));
  border: 1px solid var(--tc-line-strong);
  border-radius: 5px;
  box-shadow: 0 16px 40px rgba(0,0,0,.6);
  backdrop-filter: blur(12px) saturate(1.2);
  -webkit-backdrop-filter: blur(12px) saturate(1.2);
}
.sio-touch-bar.menu-open .sio-tc-scrim{ display: block; pointer-events: auto; }
.sio-touch-bar.menu-open .sio-tc-menu{ display: grid; pointer-events: auto; }
.sio-touch-bar .sio-tc-menu .sio-tc-btn{ flex: 0 0 auto; width: 72px; }

/* ---- item sheet ---- */
.sio-tc-sheet{
  position: fixed; inset: 0;
  z-index: 3;
  display: none;
}
.sio-touch-bar.sheet-open .sio-tc-sheet{ display: block; pointer-events: auto; }
.sio-tc-sheet-bd{ position: absolute; inset: 0; background: rgba(4,6,8,.62); }
.sio-tc-sheet-panel{
  position: absolute;
  left: 0; right: 0; bottom: 0;
  display: flex;
  flex-direction: column;
  max-height: min(62vh, 460px);
  padding-bottom: var(--tc-safe);
  background: linear-gradient(180deg, rgba(10,12,14,.96), rgba(6,8,10,.99));
  border-top: 1px solid var(--tc-line-strong);
  box-shadow: 0 -18px 44px rgba(0,0,0,.6);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
}
.sio-tc-sheet-head{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--tc-line);
  background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,0));
}
.sio-tc-sheet-title{
  font-family: var(--tc-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--tc-text);
}
.sio-touch-bar .sio-tc-x{
  flex: 0 0 auto;
  width: 44px; height: 44px;
  min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  margin: -6px -4px -6px 0;
  padding: 0;
  font: inherit;
  color: var(--tc-dim);
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  touch-action: manipulation;
}
.sio-tc-x:focus-visible{ outline: 2px solid var(--tc-cyan); outline-offset: 2px; }
.sio-tc-list{
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--tc-line-strong) transparent;
}
.sio-tc-list::-webkit-scrollbar{ width: 4px; }
.sio-tc-list::-webkit-scrollbar-track{ background: transparent; }
.sio-tc-list::-webkit-scrollbar-thumb{ background: var(--tc-line-strong); border-radius: 2px; }
.sio-touch-bar .sio-tc-item{
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 48px;
  padding: 8px 10px;
  font: inherit;
  text-align: left;
  color: var(--tc-text);
  background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.012));
  border: 1px solid var(--tc-line);
  border-radius: 4px;
  cursor: pointer;
  touch-action: manipulation;
}
.sio-tc-item:focus-visible{ outline: 2px solid var(--tc-cyan); outline-offset: 2px; }
.sio-tc-item.is-sel{
  border-color: color-mix(in srgb, var(--tc-cyan) 55%, transparent);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--tc-cyan) 18%, transparent),
    color-mix(in srgb, var(--tc-cyan) 4%, transparent));
}
.sio-tc-item-main{ flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sio-tc-item-name{
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sio-tc-item-cat{
  font-family: var(--tc-mono);
  font-size: 9px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--tc-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sio-tc-item-stats{
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  font-family: var(--tc-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.sio-tc-item-mass{ color: var(--tc-dim); }
.sio-tc-item-val{ color: var(--tc-amber); font-weight: 700; }
.sio-tc-empty{
  padding: 18px 12px;
  text-align: center;
  font-family: var(--tc-mono);
  font-size: 10px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--tc-faint);
}

@media (prefers-reduced-motion: reduce){
  .sio-touch-bar .sio-tc-btn,
  .sio-tc-cool{ transition: none; }
  .sio-tc-btn--jam.is-stalled{ animation: none; }
}
`;

let instanceSeq = 0;

/* ------------------------------------------------------------------ */

export class TouchControls {
  /**
   * @param {HTMLElement} parent  usually document.body
   * @param {object} opts
   * @param {Array<{id:string,label:string,mass:number,value:number,category:string}>} [opts.items]
   * @param {Array<{id:string,label:string}>} [opts.cameraPresets]
   * @param {object} [cb]
   * @param {(id:string)=>void}  [cb.onFeed]
   * @param {(on:boolean)=>void} [cb.onPower]
   * @param {(down:boolean)=>void} [cb.onReverse]
   * @param {()=>void}           [cb.onJamBuster]
   * @param {()=>void}           [cb.onShop]
   * @param {()=>void}           [cb.onClear]
   * @param {(id:string)=>void}  [cb.onCamera]
   * @param {(on:boolean)=>void} [cb.onAutoFeed]
   */
  constructor(parent, opts = {}, cb = {}) {
    const doc = (parent && parent.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('TouchControls requires a DOM document');

    this._doc = doc;
    this._parent = parent || doc.body;
    this._cb = cb || {};
    this._items = Array.isArray(opts.items) ? opts.items.slice() : [];
    this._presets = Array.isArray(opts.cameraPresets) ? opts.cameraPresets.slice() : [];

    this._disposed = false;
    this._listeners = [];
    this._itemRows = new Map();

    this._power = false;
    this._reverse = false;
    this._autoFeed = false;
    this._stalled = false;
    this._jamCool = 0;
    this._camIndex = 0;
    this._selectedId = this._items.length ? this._items[0].id : null;

    this._feedDelayTimer = null;
    this._feedRepeatTimer = null;
    this._revPointerId = null;

    this._injectStyle();
    this._build();
  }

  /* ---------------- internals: listener bookkeeping ---------------- */

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push({ target, type, fn, opts });
  }

  _emit(name, ...args) {
    const fn = this._cb && this._cb[name];
    if (typeof fn === 'function') fn(...args);
  }

  _injectStyle() {
    const doc = this._doc;
    this._styleEl = doc.createElement('style');
    this._styleEl.id = `${STYLE_ID_PREFIX}-${++instanceSeq}`;
    this._styleEl.setAttribute('data-sio-touch-controls', '');
    this._styleEl.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(this._styleEl);
  }

  /* ---------------- internals: DOM construction ---------------- */

  _el(tag, cls, parent) {
    const n = this._doc.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  /** Build a bar/menu button. Labels are set via textContent (never innerHTML). */
  _mkBtn(parent, { cls, icon, label, aria }) {
    const b = this._el('button', `sio-tc-btn${cls ? ' ' + cls : ''}`, parent);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    const ico = this._el('span', 'sio-tc-ico', b);
    ico.innerHTML = ICONS[icon] || '';
    const lab = this._el('span', 'sio-tc-lab', b);
    lab.textContent = label;
    b._labelEl = lab;
    return b;
  }

  _build() {
    const root = this._el('div', 'sio-touch-bar');
    root.setAttribute('data-sio-touch-controls', '');
    this.root = root;

    // Swallow the gesture so OrbitControls behind the bar never sees it.
    this._on(root, 'pointerdown', (e) => { e.preventDefault(); }, { passive: false });
    // Belt & braces: a finger lifting anywhere must not leave rotors reversed.
    this._on(root, 'contextmenu', (e) => e.preventDefault());

    /* --- overflow scrim (fixed, out of flow: no height contribution) --- */
    this._scrim = this._el('div', 'sio-tc-scrim', root);
    this._tap(this._scrim, () => this._setMenu(false));

    /* --- overflow menu --- */
    const menu = this._el('div', 'sio-tc-menu', root);
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'More controls');
    this._menu = menu;

    this._camBtn = this._mkBtn(menu, {
      cls: 'sio-tc-mbtn', icon: 'camera',
      label: this._presets.length ? shortLabel(this._presets[0].label) : 'Camera',
      aria: 'Cycle camera preset',
    });
    this._tap(this._camBtn, () => this._cycleCamera());

    this._shopBtn = this._mkBtn(menu, { cls: 'sio-tc-mbtn', icon: 'shop', label: 'Shop', aria: 'Open shop' });
    this._tap(this._shopBtn, () => { this._setMenu(false); this._emit('onShop'); });

    this._clearBtn = this._mkBtn(menu, { cls: 'sio-tc-mbtn', icon: 'clear', label: 'Clear', aria: 'Clear debris' });
    this._tap(this._clearBtn, () => { this._setMenu(false); this._emit('onClear'); });

    this._autoBtn = this._mkBtn(menu, { cls: 'sio-tc-mbtn', icon: 'auto', label: 'Auto', aria: 'Toggle auto-feed' });
    this._autoBtn.setAttribute('aria-pressed', 'false');
    this._tap(this._autoBtn, () => {
      this.setAutoFeed(!this._autoFeed);
      this._emit('onAutoFeed', this._autoFeed);
    });

    /* --- item sheet (fixed, out of flow) --- */
    this._buildSheet(root);

    /* --- the bar itself --- */
    const row = this._el('div', 'sio-tc-row', root);
    this._row = row;

    this._powerBtn = this._mkBtn(row, { cls: 'sio-tc-btn--power', icon: 'power', label: 'Power', aria: 'Toggle power' });
    this._powerBtn.setAttribute('aria-pressed', 'false');
    this._tap(this._powerBtn, () => {
      this.setPower(!this._power);
      this._emit('onPower', this._power);
    });

    this._feedBtn = this._mkBtn(row, { cls: 'sio-tc-btn--feed', icon: 'feed', label: 'Feed', aria: 'Feed one item' });
    this._wireFeed(this._feedBtn);

    this._itemBtn = this._mkBtn(row, { cls: 'sio-tc-btn--item', icon: 'list', label: 'Item', aria: 'Choose feed stock' });
    this._itemBtn.setAttribute('aria-haspopup', 'dialog');
    this._itemBtn.setAttribute('aria-expanded', 'false');
    this._tap(this._itemBtn, () => this._setSheet(true));

    this._revBtn = this._mkBtn(row, { cls: 'sio-tc-btn--rev', icon: 'reverse', label: 'Reverse', aria: 'Hold to reverse rotors' });
    this._wireReverse(this._revBtn);

    this._jamBtn = this._mkBtn(row, { cls: 'sio-tc-btn--jam', icon: 'jam', label: 'Jam', aria: 'Jam buster' });
    this._jamFill = this._el('span', 'sio-tc-cool', this._jamBtn);
    this._tap(this._jamBtn, () => {
      if (this._jamCool > 0) return;
      this._emit('onJamBuster');
    });

    this._moreBtn = this._mkBtn(row, { cls: 'sio-tc-btn--more', icon: 'more', label: 'More', aria: 'More controls' });
    this._moreBtn.setAttribute('aria-haspopup', 'true');
    this._moreBtn.setAttribute('aria-expanded', 'false');
    this._tap(this._moreBtn, () => this._setMenu(!this._menuOpen));

    this._parent.appendChild(root);
    this.setSelectedItem(this._selectedId);
    this.setJamCooldown(0);
  }

  _buildSheet(root) {
    const sheet = this._el('div', 'sio-tc-sheet', root);
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Feed stock');
    sheet.setAttribute('aria-modal', 'false');
    this._sheet = sheet;

    const bd = this._el('div', 'sio-tc-sheet-bd', sheet);
    this._tap(bd, () => this._setSheet(false));

    const panel = this._el('div', 'sio-tc-sheet-panel', sheet);
    const head = this._el('div', 'sio-tc-sheet-head', panel);
    const title = this._el('div', 'sio-tc-sheet-title', head);
    title.textContent = 'Feed stock';

    const x = this._el('button', 'sio-tc-x', head);
    x.type = 'button';
    x.setAttribute('aria-label', 'Close feed stock list');
    x.innerHTML = `<span class="sio-tc-ico">${ICONS.close}</span>`;
    this._tap(x, () => this._setSheet(false));

    const list = this._el('div', 'sio-tc-list', panel);
    this._list = list;

    if (!this._items.length) {
      const empty = this._el('div', 'sio-tc-empty', list);
      empty.textContent = 'No feed stock';
      return;
    }

    for (const item of this._items) {
      if (!item || item.id == null) continue;
      const rowEl = this._el('button', 'sio-tc-item', list);
      rowEl.type = 'button';
      rowEl.setAttribute('role', 'radio');
      rowEl.setAttribute('aria-checked', 'false');

      const main = this._el('div', 'sio-tc-item-main', rowEl);
      const name = this._el('div', 'sio-tc-item-name', main);
      name.textContent = String(item.label ?? item.id);
      const cat = this._el('div', 'sio-tc-item-cat', main);
      cat.textContent = String(item.category ?? '');

      const stats = this._el('div', 'sio-tc-item-stats', rowEl);
      const mass = this._el('div', 'sio-tc-item-mass', stats);
      mass.textContent = fmtMass(item.mass);
      const val = this._el('div', 'sio-tc-item-val', stats);
      val.textContent = fmtValue(item.value);

      const id = item.id;
      this._itemRows.set(id, rowEl);
      this._tap(rowEl, () => {
        this.setSelectedItem(id);
        this._setSheet(false);
      });
    }
  }

  /* ---------------- internals: pointer wiring ---------------- */

  /**
   * Simple tap: fires on pointerup when the press started on the element.
   * Pointer capture keeps the release attached even if the finger slides.
   * Also handles keyboard activation (click with detail === 0).
   */
  _tap(el, fn) {
    let active = null;

    const down = (e) => {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      active = e.pointerId;
      el.classList.add('is-press');
      capture(el, e.pointerId);
    };
    const up = (e) => {
      if (active === null || e.pointerId !== active) return;
      active = null;
      el.classList.remove('is-press');
      release(el, e.pointerId);
      if (this._disposed) return;
      // Only fire if the finger is still over the element.
      if (hits(el, e)) fn();
    };
    const cancel = (e) => {
      if (active === null || (e.pointerId != null && e.pointerId !== active)) return;
      active = null;
      el.classList.remove('is-press');
      release(el, e.pointerId);
    };

    this._on(el, 'pointerdown', down, { passive: false });
    this._on(el, 'pointerup', up);
    this._on(el, 'pointercancel', cancel);
    this._on(el, 'click', (e) => { if (e.detail === 0 && !this._disposed) fn(); });
  }

  /** FEED: fires immediately, then repeats ~3/s after a 400ms hold. */
  _wireFeed(el) {
    const fire = () => {
      if (this._disposed) return;
      if (this._selectedId == null) return;
      this._emit('onFeed', this._selectedId);
    };

    const stop = () => {
      if (this._feedDelayTimer !== null) { clearTimeout(this._feedDelayTimer); this._feedDelayTimer = null; }
      if (this._feedRepeatTimer !== null) { clearInterval(this._feedRepeatTimer); this._feedRepeatTimer = null; }
    };
    this._stopFeedRepeat = stop;

    let active = null;

    const down = (e) => {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (active !== null) return;
      active = e.pointerId;
      el.classList.add('is-press');
      capture(el, e.pointerId);
      fire();
      stop();
      this._feedDelayTimer = setTimeout(() => {
        this._feedDelayTimer = null;
        this._feedRepeatTimer = setInterval(fire, FEED_REPEAT_MS);
      }, FEED_HOLD_DELAY_MS);
    };
    const end = (e) => {
      if (active === null || (e.pointerId != null && e.pointerId !== active)) return;
      active = null;
      el.classList.remove('is-press');
      release(el, e.pointerId);
      stop();
    };

    this._on(el, 'pointerdown', down, { passive: false });
    this._on(el, 'pointerup', end);
    this._on(el, 'pointercancel', end);
    this._on(el, 'lostpointercapture', end);
    this._on(el, 'click', (e) => { if (e.detail === 0) fire(); });
  }

  /** REVERSE: momentary. pointerup AND pointercancel both release. */
  _wireReverse(el) {
    el.setAttribute('aria-pressed', 'false');

    const press = (e) => {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (this._revPointerId !== null) return;
      this._revPointerId = e.pointerId ?? -1;
      capture(el, e.pointerId);
      el.classList.add('is-press');
      this.setReverse(true);
      this._emit('onReverse', true);
    };
    const lift = (e) => {
      if (this._revPointerId === null) return;
      if (e && e.pointerId != null && this._revPointerId !== -1 && e.pointerId !== this._revPointerId) return;
      this._revPointerId = null;
      if (e) release(el, e.pointerId);
      el.classList.remove('is-press');
      this.setReverse(false);
      this._emit('onReverse', false);
    };
    this._releaseReverse = () => lift(null);

    this._on(el, 'pointerdown', press, { passive: false });
    this._on(el, 'pointerup', lift);
    this._on(el, 'pointercancel', lift);
    this._on(el, 'lostpointercapture', lift);
    // Keyboard parity for the momentary button.
    this._on(el, 'keydown', (e) => {
      if (e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return;
      e.preventDefault();
      if (this._revPointerId !== null) return;
      this._revPointerId = -1;
      this.setReverse(true);
      this._emit('onReverse', true);
    });
    this._on(el, 'keyup', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      lift(null);
    });
    this._on(el, 'blur', () => { if (this._revPointerId === -1) lift(null); });
  }

  /* ---------------- internals: panels ---------------- */

  _setSheet(open) {
    if (this._disposed) return;
    this._sheetOpen = !!open;
    this.root.classList.toggle('sheet-open', this._sheetOpen);
    this._itemBtn.setAttribute('aria-expanded', this._sheetOpen ? 'true' : 'false');
    if (this._sheetOpen) this._setMenu(false);
  }

  _setMenu(open) {
    if (this._disposed) return;
    this._menuOpen = !!open;
    this.root.classList.toggle('menu-open', this._menuOpen);
    this._moreBtn.setAttribute('aria-expanded', this._menuOpen ? 'true' : 'false');
  }

  _cycleCamera() {
    if (!this._presets.length) return;
    this._camIndex = (this._camIndex + 1) % this._presets.length;
    const p = this._presets[this._camIndex];
    this._camBtn._labelEl.textContent = shortLabel(p.label);
    this._emit('onCamera', p.id);
  }

  /* ---------------- public API ---------------- */

  setVisible(v) {
    if (this._disposed) return;
    const on = !!v;
    this.root.classList.toggle('is-hidden', !on);
    this.root.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (!on) {
      this._setSheet(false);
      this._setMenu(false);
      if (this._stopFeedRepeat) this._stopFeedRepeat();
      if (this._revPointerId !== null && this._releaseReverse) this._releaseReverse();
    }
  }

  setPower(on) {
    if (this._disposed) return;
    this._power = !!on;
    this._powerBtn.setAttribute('aria-pressed', this._power ? 'true' : 'false');
    this._powerBtn._labelEl.textContent = this._power ? 'On' : 'Off';
  }

  setReverse(on) {
    if (this._disposed) return;
    this._reverse = !!on;
    this._revBtn.classList.toggle('is-on', this._reverse);
    this._revBtn.setAttribute('aria-pressed', this._reverse ? 'true' : 'false');
  }

  setAutoFeed(on) {
    if (this._disposed) return;
    this._autoFeed = !!on;
    this._autoBtn.setAttribute('aria-pressed', this._autoFeed ? 'true' : 'false');
    this._autoBtn._labelEl.textContent = this._autoFeed ? 'Auto On' : 'Auto';
  }

  setSelectedItem(id) {
    if (this._disposed) return;
    const found = this._items.find((it) => it && it.id === id);
    if (found) this._selectedId = found.id;
    for (const [key, rowEl] of this._itemRows) {
      const sel = key === this._selectedId;
      rowEl.classList.toggle('is-sel', sel);
      rowEl.setAttribute('aria-checked', sel ? 'true' : 'false');
    }
    const label = found ? String(found.label ?? found.id) : (this._selectedId == null ? 'Item' : String(this._selectedId));
    this._itemBtn._labelEl.textContent = shortLabel(label);
    this._itemBtn.setAttribute('aria-label', `Feed stock: ${label}. Choose feed stock`);
  }

  setJamCooldown(frac01) {
    if (this._disposed) return;
    const f = Math.max(0, Math.min(1, Number(frac01) || 0));
    this._jamCool = f;
    this._jamFill.style.height = `${(f * 100).toFixed(2)}%`;
    this._jamBtn.setAttribute('aria-disabled', f > 0 ? 'true' : 'false');
  }

  setStalled(on) {
    if (this._disposed) return;
    this._stalled = !!on;
    this._jamBtn.classList.toggle('is-stalled', this._stalled);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this._feedDelayTimer !== null) { clearTimeout(this._feedDelayTimer); this._feedDelayTimer = null; }
    if (this._feedRepeatTimer !== null) { clearInterval(this._feedRepeatTimer); this._feedRepeatTimer = null; }

    // Never leave the rotors spinning backwards.
    if (this._revPointerId !== null) {
      this._revPointerId = null;
      this._emit('onReverse', false);
    }

    for (const { target, type, fn, opts } of this._listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this._listeners.length = 0;
    this._itemRows.clear();

    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this._styleEl && this._styleEl.parentNode) this._styleEl.parentNode.removeChild(this._styleEl);
    this.root = null;
    this._styleEl = null;
  }
}

/* ---------------- helpers ---------------- */

function capture(el, pointerId) {
  if (pointerId == null || !el.setPointerCapture) return;
  try { el.setPointerCapture(pointerId); } catch { /* synthetic / already-gone pointer */ }
}

function release(el, pointerId) {
  if (pointerId == null || !el.releasePointerCapture) return;
  try {
    if (!el.hasPointerCapture || el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  } catch { /* already released */ }
}

/** True when the pointer released inside the element (or coords are unavailable). */
function hits(el, e) {
  if (!e || typeof e.clientX !== 'number' || (e.clientX === 0 && e.clientY === 0)) return true;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return true;
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function shortLabel(s, max = 9) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

function fmtMass(m) {
  const n = Number(m);
  if (!isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} t`;
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} kg`;
}

function fmtValue(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(n >= 10 ? 0 : 2)}`;
}

export default TouchControls;
