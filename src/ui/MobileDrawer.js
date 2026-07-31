/* ==================================================================
   shredding.io — MobileDrawer  (src/ui/MobileDrawer.js)

   On a phone the two desktop side rails (.sio-col--left / .sio-col--right)
   are redundant for *gameplay* — TouchControls already exposes power,
   feed, item picker, reverse, jam-buster, camera, shop, clear and
   auto-feed. What the rails uniquely still carry is settings + telemetry.
   This module hides them from the play surface and re-homes them in a
   full-height slide-in sheet behind a single gear button.

   Contract:
     - It MOVES the caller's elements (appendChild re-parents, it never
       clones), so every live reference ControlPanel holds — and updates
       every frame — keeps working.
     - dispose() is idempotent and puts each element back at its exact
       original parent + sibling position, so desktop / orientation
       changes can never be corrupted.
     - Presentation lives entirely in style.css (`.sio-drawer*`), which is
       gated behind the mobile media queries / capability classes. This
       file only adds and removes classes.
     - No `three`, no network, no module-scope DOM access (safe to
       `import` in Node — every document touch happens in the
       constructor or later).
   ================================================================== */

/* Static markup only — never interpolated with caller data. */
const ICON_GEAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="3.1"/>' +
  '<path d="M19.5 13.5a7.7 7.7 0 0 0 0-3l1.9-1.5-1.9-3.3-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14.2 3H9.8l-.4 2.1a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-1.9 3.3 1.9 1.5a7.7 7.7 0 0 0 0 3l-1.9 1.5 1.9 3.3 2.3-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.1h4.4l.4-2.1a7.6 7.6 0 0 0 2.6-1.5l2.3.9 1.9-3.3z"/>' +
  '</svg>';

const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M6 6l12 12M18 6L6 18"/></svg>';

let uid = 0;

export class MobileDrawer {
  /**
   * @param {HTMLElement} parent      usually document.body
   * @param {object} [opts]
   * @param {HTMLElement[]} [opts.panels]  elements to MOVE into the drawer body
   * @param {string} [opts.title]
   */
  constructor(parent, opts = {}) {
    const doc = parent && parent.ownerDocument;
    if (!doc) throw new TypeError('MobileDrawer: parent must be a DOM element');

    this.doc = doc;
    this.parent = parent;
    this.title = typeof opts.title === 'string' && opts.title.trim()
      ? opts.title.trim()
      : 'Settings';

    this.disposed = false;
    this._open = false;
    /** @type {{el: Element, parent: Node|null, next: Node|null}[]} */
    this._slots = [];
    this._listeners = [];

    const id = `sio-drawer-${++uid}`;

    /* ---------------- backdrop (z 49) ---------------- */
    this.backdrop = this._el('div', 'sio-drawer-bd');
    this.backdrop.setAttribute('aria-hidden', 'true');

    /* ---------------- sheet (z 50) ---------------- */
    this.root = this._el('aside', 'sio-drawer');
    this.root.id = id;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.setAttribute('aria-labelledby', `${id}-title`);

    const head = this._el('div', 'sio-drawer-head');
    const titleEl = this._el('span', 'sio-drawer-title');
    titleEl.id = `${id}-title`;
    titleEl.textContent = this.title;

    this.closeBtn = this._el('button', 'sio-drawer-close');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', `Close ${this.title}`);
    this.closeBtn.innerHTML = ICON_CLOSE;

    head.appendChild(titleEl);
    head.appendChild(this.closeBtn);

    this.body = this._el('div', 'sio-drawer-body');

    this.root.appendChild(head);
    this.root.appendChild(this.body);

    /* ---------------- floating open button (z 41) ---------------- */
    this.fab = this._el('button', 'sio-drawer-fab');
    this.fab.type = 'button';
    this.fab.setAttribute('aria-label', `Open ${this.title}`);
    this.fab.setAttribute('aria-controls', id);
    this.fab.setAttribute('aria-expanded', 'false');
    this.fab.innerHTML = ICON_GEAR;

    /* ---------------- adopt the caller's panels ----------------
       appendChild MOVES the element. Never clone, never innerHTML —
       ControlPanel holds live references into this subtree. */
    const panels = Array.isArray(opts.panels) ? opts.panels : [];
    for (const node of panels) {
      if (!node || node.nodeType !== 1) continue;
      this._slots.push({ el: node, parent: node.parentNode, next: node.nextSibling });
      this.body.appendChild(node);
    }

    parent.appendChild(this.backdrop);
    parent.appendChild(this.root);
    parent.appendChild(this.fab);

    /* Tells the stylesheet to reserve a gutter for the button so it can
       never overlap the HUD bar / contracts panel. */
    doc.documentElement.classList.add('sio-drawer-ready');

    this._bind(this.fab, 'click', () => this.toggle());
    this._bind(this.closeBtn, 'click', () => this.close());
    this._bind(this.backdrop, 'click', () => this.close());
    this._bind(doc, 'keydown', (e) => {
      if (!this._open) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopPropagation();
        this.close();
      }
    }, true);
  }

  /* ================================================================ *
   * Public API
   * ================================================================ */

  get isOpen() {
    return this._open;
  }

  open() {
    if (this.disposed || this._open) return;
    this._open = true;
    this._lastFocus = this.doc.activeElement;
    this.root.classList.add('is-open');
    this.backdrop.classList.add('is-open');
    this.root.setAttribute('aria-hidden', 'false');
    this.fab.setAttribute('aria-expanded', 'true');
    try { this.closeBtn.focus({ preventScroll: true }); } catch (e) { /* older WebKit */ }
  }

  close() {
    if (this.disposed || !this._open) return;
    this._open = false;
    this.root.classList.remove('is-open');
    this.backdrop.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.fab.setAttribute('aria-expanded', 'false');
    /* only steal focus back if it is still inside the sheet we just hid */
    const active = this.doc.activeElement;
    if (active && this.root.contains(active)) {
      try { this.fab.focus({ preventScroll: true }); } catch (e) { /* older WebKit */ }
    }
    this._lastFocus = null;
  }

  toggle() {
    if (this.disposed) return;
    if (this._open) this.close();
    else this.open();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._open = false;

    for (const [target, type, fn, capture] of this._listeners) {
      target.removeEventListener(type, fn, capture);
    }
    this._listeners.length = 0;

    /* Reverse order so each element's recorded reference sibling is back
       in place before the element that pointed at it is re-inserted. */
    for (let i = this._slots.length - 1; i >= 0; i--) {
      const slot = this._slots[i];
      const { el, parent, next } = slot;
      if (!parent) {
        if (el.parentNode) el.parentNode.removeChild(el);
        continue;
      }
      if (next && next.parentNode === parent) parent.insertBefore(el, next);
      else parent.appendChild(el);
    }
    this._slots.length = 0;

    for (const node of [this.fab, this.root, this.backdrop]) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    this.doc.documentElement.classList.remove('sio-drawer-ready');

    this.fab = null;
    this.root = null;
    this.backdrop = null;
    this.body = null;
    this.closeBtn = null;
    this._lastFocus = null;
  }

  /* ================================================================ *
   * Internals
   * ================================================================ */

  _el(tag, cls) {
    const node = this.doc.createElement(tag);
    node.className = cls;
    return node;
  }

  _bind(target, type, fn, capture = false) {
    target.addEventListener(type, fn, capture);
    this._listeners.push([target, type, fn, capture]);
  }
}

export default MobileDrawer;
