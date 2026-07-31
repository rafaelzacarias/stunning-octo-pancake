import * as THREE from 'three';

/**
 * FloatingTextSystem — pooled 3D "+$3.00" popups drawn with canvas-generated
 * textures. No external fonts, no external assets, no allocations after warm-up.
 *
 * Textures are cached by the rendered string so a stream of identical payouts
 * shares one texture; the cache is refcounted and LRU-evicted.
 */

const FONT_STACK = '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_PX = 64;          // canvas-space glyph height; world size comes from BASE_HEIGHT
const BASE_HEIGHT = 0.13;    // metres of world height for a scale-1 popup
const RISE = 0.6;            // metres travelled over a full life
const FADE_FROM = 0.6;       // start fading at 60 % of life -> fades over the last 40 %
const REF_DIST = 3.5;        // distance at which a popup renders at its nominal size
const MAX_CACHE = 64;

const _camPos = new THREE.Vector3();

export class FloatingTextSystem {
  /**
   * @param {THREE.Scene} scene Scene to attach the popup group to.
   * @param {{capacity?:number, pixelRatio?:number}} [opts]
   */
  constructor(scene, { capacity = 48, pixelRatio = 2 } = {}) {
    this.scene = scene ?? null;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.pixelRatio = Math.min(3, Math.max(1, pixelRatio));

    this.group = new THREE.Group();
    this.group.name = 'FloatingText';
    this.group.frustumCulled = false;
    if (this.scene) this.scene.add(this.group);

    /** @type {Array<{sprite:THREE.Sprite, entry:object|null, age:number, life:number, scale:number, base:THREE.Vector3, drift:number}>} */
    this._live = [];
    /** @type {Array<THREE.Sprite>} */
    this._free = [];
    this._created = 0;

    /** @type {Map<string,{texture:THREE.Texture, aspect:number, refs:number}>} */
    this._cache = new Map();
    this._measure = null;
    this._disposed = false;
  }

  /**
   * Spawn a popup at a world position.
   * @param {string} text
   * @param {THREE.Vector3|number[]|{x:number,y:number,z:number}} worldPosition
   * @param {{color?:string, scale?:number, life?:number}} [opts]
   */
  spawn(text, worldPosition, { color = '#7CFF9B', scale = 1, life = 1.4 } = {}) {
    if (this._disposed) return;
    const label = String(text ?? '').trim();
    if (!label) return;

    const entry = this._acquireTexture(label, color);
    if (!entry) return;

    const sprite = this._acquireSprite();
    if (!sprite) {
      entry.refs--;
      return;
    }

    const p = readVec(worldPosition);
    sprite.position.copy(p);
    sprite.material.map = entry.texture;
    sprite.material.opacity = 1;
    sprite.material.needsUpdate = true;
    sprite.visible = true;

    this._live.push({
      sprite,
      entry,
      age: 0,
      life: Math.max(0.15, Number.isFinite(life) ? life : 1.4),
      scale: Math.max(0.05, Number.isFinite(scale) ? scale : 1),
      base: p,
      drift: (Math.random() - 0.5) * 0.12,
    });
  }

  /**
   * Advance every live popup.
   * @param {number} dt Seconds.
   * @param {THREE.Camera} [camera] Used for distance-compensated sizing.
   */
  update(dt, camera) {
    if (this._disposed || this._live.length === 0) return;
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    if (camera) _camPos.setFromMatrixPosition(camera.matrixWorld);

    for (let i = this._live.length - 1; i >= 0; i--) {
      const p = this._live[i];
      p.age += step;
      const t = p.age / p.life;
      if (t >= 1) {
        this._retire(i);
        continue;
      }

      // Ease-out rise plus a touch of lateral drift so stacked popups separate.
      const ease = 1 - Math.pow(1 - t, 3);
      p.sprite.position.set(
        p.base.x + p.drift * ease,
        p.base.y + RISE * ease,
        p.base.z,
      );

      // Overshoot pop-in over the first 12 % of life.
      const pop = t < 0.12 ? 0.6 + 0.48 * (t / 0.12) : 1 + 0.08 * Math.max(0, 1 - (t - 0.12) / 0.18);
      let dist = 1;
      if (camera) {
        const d = _camPos.distanceTo(p.sprite.position);
        dist = Math.min(2.5, Math.max(0.7, Math.pow(d / REF_DIST, 0.45)));
      }

      const h = BASE_HEIGHT * p.scale * pop * dist;
      p.sprite.scale.set(h * (p.entry?.aspect ?? 3), h, 1);
      p.sprite.material.opacity = t < FADE_FROM ? 1 : Math.max(0, 1 - (t - FADE_FROM) / (1 - FADE_FROM));
    }
  }

  /** Remove everything from the scene and release all GPU resources. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (let i = this._live.length - 1; i >= 0; i--) this._retire(i);
    this._live.length = 0;

    for (const sprite of this._free) {
      this.group.remove(sprite);
      sprite.material.map = null;
      sprite.material.dispose();
    }
    this._free.length = 0;

    for (const entry of this._cache.values()) entry.texture.dispose();
    this._cache.clear();

    this.group.parent?.remove(this.group);
    this.group.clear();
    this._measure = null;
    this.scene = null;
  }

  // -------------------------------------------------------------- internals

  _acquireSprite() {
    const sprite = this._free.pop();
    if (sprite) return sprite;

    if (this._created < this.capacity) {
      const material = new THREE.SpriteMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        sizeAttenuation: true,
      });
      const s = new THREE.Sprite(material);
      s.renderOrder = 1000;
      s.frustumCulled = false;
      s.visible = false;
      this.group.add(s);
      this._created++;
      return s;
    }

    // At capacity: steal the oldest live popup rather than allocating.
    this._retire(0);
    return this._free.pop() ?? null;
  }

  _retire(index) {
    const p = this._live[index];
    if (!p) return;
    this._live.splice(index, 1);
    if (p.entry) p.entry.refs = Math.max(0, p.entry.refs - 1);
    p.sprite.visible = false;
    p.sprite.material.map = null;
    p.sprite.material.opacity = 0;
    this._free.push(p.sprite);
  }

  _acquireTexture(text, color) {
    const cacheKey = `${text}\u0000${color}`;
    const hit = this._cache.get(cacheKey);
    if (hit) {
      // Refresh LRU position.
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, hit);
      hit.refs++;
      return hit;
    }

    const built = this._render(text, color);
    if (!built) return null;
    built.refs = 1;
    this._cache.set(cacheKey, built);
    this._evict();
    return built;
  }

  _evict() {
    if (this._cache.size <= MAX_CACHE) return;
    for (const [k, entry] of this._cache) {
      if (this._cache.size <= MAX_CACHE) break;
      if (entry.refs > 0) continue;      // still on screen — skip it
      entry.texture.dispose();
      this._cache.delete(k);
    }
  }

  _render(text, color) {
    if (typeof document === 'undefined') return null;

    const font = `900 ${FONT_PX}px ${FONT_STACK}`;
    if (!this._measure) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      this._measure = c.getContext('2d');
    }
    if (!this._measure) return null;

    this._measure.font = font;
    const m = this._measure.measureText(text);
    const asc = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : FONT_PX * 0.72;
    const desc = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : FONT_PX * 0.28;

    const padX = FONT_PX * 0.36;
    const padY = FONT_PX * 0.3;
    const w = Math.max(8, Math.ceil(m.width + padX * 2));
    const h = Math.max(8, Math.ceil(asc + desc + padY * 2));

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * this.pixelRatio);
    canvas.height = Math.ceil(h * this.pixelRatio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.scale(this.pixelRatio, this.pixelRatio);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const x = w * 0.5;
    const y = padY + asc;

    // Dark outline keeps the text legible against sparks and bright metal.
    ctx.lineWidth = FONT_PX * 0.17;
    ctx.strokeStyle = 'rgba(4, 7, 10, 0.88)';
    ctx.strokeText(text, x, y);

    ctx.shadowColor = color;
    ctx.shadowBlur = FONT_PX * 0.34;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = FONT_PX * 0.16;
    ctx.fillText(text, x, y);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    return { texture, aspect: w / h, refs: 0 };
  }
}

/** Accept a Vector3, an {x,y,z} literal, or an [x,y,z] array. */
function readVec(src) {
  const v = new THREE.Vector3();
  if (!src) return v;
  if (Array.isArray(src)) return v.set(src[0] ?? 0, src[1] ?? 0, src[2] ?? 0);
  return v.set(src.x ?? 0, src.y ?? 0, src.z ?? 0);
}
