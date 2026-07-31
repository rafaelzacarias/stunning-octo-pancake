/**
 * ThumbnailRenderer.js — tiny offscreen studio that turns any THREE.Object3D
 * into a transparent PNG data URL for the feed-stock palette cards.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WEBGL CONTEXT BUDGET — READ THIS BEFORE USING
 * ──────────────────────────────────────────────────────────────────────────
 * Browsers cap the number of *simultaneously live* WebGL contexts (Chrome ≈ 16,
 * Safari/Firefox ≈ 8-16). When the cap is exceeded the oldest context is killed
 * — and the oldest context is the main simulation renderer, which would blank
 * the whole app. The main app already owns one context, so this renderer must
 * be treated as a short-lived batch tool:
 *
 *     await ThumbnailRenderer.batch({ enabled, envMap }, (tr) => {
 *       for (const item of items) ui.setThumbnail(item.id, tr.render(item.mesh));
 *     });
 *
 * `batch()` disposes in a `finally`, so the context comes back even if the loop
 * throws. Doing it by hand (`new` … `tr.dispose()`) leaks the context on a throw.
 *
 * On a memory-pressured phone a second context is a crash risk even when it is
 * legal, so pass `enabled: false` there: no canvas and no context are created
 * at all and `render()` simply returns null, which callers already handle.
 *
 * Never keep an instance alive across frames, and never create more than one
 * at a time. `dispose()` releases the context immediately via
 * `renderer.dispose()` + `renderer.forceContextLoss()`; relying on GC to
 * reclaim it is not good enough (it can take many seconds). A `webglcontextlost`
 * on the thumbnail canvas aborts the batch: every later `render()` returns null
 * rather than stalling, and the instance disposes itself on the next tick.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Notes:
 *  - A detached <canvas> is used rather than OffscreenCanvas because
 *    OffscreenCanvas has no toDataURL(); it only offers async convertToBlob().
 *  - `preserveDrawingBuffer: true` is mandatory — without it the back buffer may
 *    already be cleared by the time toDataURL() runs.
 *  - The object passed to render() is never mutated: it is cloned (geometries
 *    and materials are shared by reference and are NOT disposed here).
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Framing constants
 * ------------------------------------------------------------------ */

const FOV = 28;            // deg — long-ish lens keeps the silhouette readable
const FILL = 0.86;         // object occupies ~86 % of the frame
const AZIMUTH = 35;        // deg — pleasing 3/4 view
const ELEVATION = 22;      // deg — looking slightly down on the object

/* A 112 px icon gains nothing above 2x, and the backing store is the one
   allocation this class makes that scales with the device. */
const MAX_PIXEL_RATIO = 2;

/* scratch objects, allocated once per instance-free module scope */
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();
const _center = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

export class ThumbnailRenderer {
  /**
   * @param {object}  [options]
   * @param {number}  [options.size=112]        CSS-pixel size of the square icon
   * @param {number}  [options.pixelRatio]      backing-store multiplier;
   *                                            defaults to min(devicePixelRatio, 2)
   *                                            and is hard-capped at 2
   * @param {THREE.Texture|null} [options.envMap=null]  PMREM env for reflections
   * @param {boolean} [options.enabled=true]    when false NO second WebGL context
   *                                            is created and render() returns
   *                                            null, so callers need no branch
   */
  constructor({ size = 112, pixelRatio, envMap = null, enabled = true } = {}) {
    this.size = Math.max(16, Math.round(size) || 112);
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const wanted = Number(pixelRatio) > 0 ? Number(pixelRatio) : Math.min(dpr, MAX_PIXEL_RATIO);
    this.pixelRatio = Math.min(MAX_PIXEL_RATIO, Math.max(1, wanted));

    /** Public: false means this instance never touches the GPU. */
    this.enabled = enabled !== false;
    this.disposed = false;
    this.available = false;
    this.contextLost = false;
    /** Public: why thumbnails are unavailable, if they are. */
    this.reason = this.enabled ? '' : 'disabled by caller';

    this.renderer = null;
    this.canvas = null;
    this._envRT = null;
    this._onContextLost = null;
    this._lostTimer = 0;

    /* The single most dangerous line in the file: a second live context. Skip it
       entirely when the caller has told us the device cannot afford one. */
    if (this.enabled) this._createContext();

    if (this.available) {
      this._onContextLost = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        /* Abort the batch: every subsequent render() returns null immediately
           instead of stalling on a dead context, and the GPU-side resources are
           handed back on the next tick rather than at the caller's convenience. */
        this.contextLost = true;
        this.available = false;
        this.reason = 'thumbnail context lost';
        if (!this._lostTimer) {
          this._lostTimer = setTimeout(() => { this._lostTimer = 0; this.dispose(); }, 0);
        }
      };
      this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    }

    /* ---- scene rig (skipped entirely when disabled: nothing can use it) ---- */
    if (!this.enabled) {
      this.scene = null;
      this.camera = null;
      this.rig = null;
      return;
    }

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    /* Feed stock may live on a non-default layer (bloom masks etc.). */
    this.camera.layers.enableAll();

    this.rig = new THREE.Group();
    this.rig.name = 'ThumbnailRig';
    this.scene.add(this.rig);
    this._buildLights();

    /* icons live on a dark glass panel: lift reflections a little so raw metal
       does not read as a black blob */
    this.scene.environmentIntensity = 1.2;
    if (envMap) {
      this.scene.environment = envMap;
    } else if (this.available) {
      this._envRT = this._buildFallbackEnvironment();
      if (this._envRT) this.scene.environment = this._envRT.texture;
    }
  }

  /**
   * Borrow a thumbnail renderer for exactly one batch and guarantee the context
   * is handed back — even if the batch throws. This is the only correct way to
   * use the class; `new` + manual `dispose()` leaks the context on any throw.
   *
   *   const urls = await ThumbnailRenderer.batch({ enabled, envMap }, async (tr) => { … });
   *
   * @param {object}   options   constructor options
   * @param {function(ThumbnailRenderer): any} fn
   * @returns {Promise<any>} whatever `fn` returned, or null if it threw
   */
  static async batch(options, fn) {
    let tr = null;
    try {
      tr = new ThumbnailRenderer(options);
    } catch (err) {
      console.warn('[ThumbnailRenderer] construction failed — skipping batch', err);
      return null;
    }
    try {
      return await fn(tr);
    } catch (err) {
      console.warn('[ThumbnailRenderer] batch failed', err);
      return null;
    } finally {
      tr.dispose();
    }
  }

  /* ================================================================ *
   * Public API
   * ================================================================ */

  /**
   * Render one object to a transparent PNG.
   * @param   {THREE.Object3D} object3D
   * @returns {string|null} `data:image/png;base64,…`, or null when disabled,
   *          when WebGL is unavailable, or on any failure. Never throws.
   */
  render(object3D) {
    if (this.disposed || !this.enabled || !this.available || !this.renderer) return null;
    if (!object3D || !object3D.isObject3D) return null;

    let proxy = null;
    try {
      /* Clone so nothing on the caller's object (parent, matrixWorld,
         visibility) is ever touched. Geometry/material are shared. */
      proxy = object3D.clone(true);
      proxy.position.set(0, 0, 0);
      proxy.quaternion.identity();
      proxy.visible = true;
      this.scene.add(proxy);
      proxy.updateMatrixWorld(true);

      _box.makeEmpty();
      _box.setFromObject(proxy, true);
      if (_box.isEmpty()) return null;

      _box.getCenter(_center);
      _box.getBoundingSphere(_sphere);
      const radius = _sphere.radius;
      if (!(radius > 0) || !Number.isFinite(radius)) return null;

      this._frame(proxy, _box, _center, radius);

      this.renderer.render(this.scene, this.camera);
      return this.canvas.toDataURL('image/png');
    } catch (err) {
      console.warn('[ThumbnailRenderer] render failed', err);
      return null;
    } finally {
      if (proxy && proxy.parent === this.scene) this.scene.remove(proxy);
    }
  }

  /**
   * Release the WebGL context. Safe to call any number of times. After this the
   * instance is inert and render() returns null.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.available = false;

    if (this._lostTimer) {
      clearTimeout(this._lostTimer);
      this._lostTimer = 0;
    }

    if (this._envRT) {
      this._envRT.dispose();
      this._envRT = null;
    }
    if (this.scene) {
      this.scene.environment = null;
      this.scene.clear();
    }
    this.rig = null;
    this.scene = null;

    this._releaseContext();
  }

  /* ================================================================ *
   * Internals
   * ================================================================ */

  /**
   * Build the second WebGL context. Fails soft: any throw, or a renderer that
   * came back without a live GL context, leaves `available === false` and the
   * half-built context is handed straight back to the browser.
   */
  _createContext() {
    try {
      this.canvas = document.createElement('canvas');
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        premultipliedAlpha: true,
        powerPreference: 'low-power',
      });

      /* A renderer can construct and still hand back nothing usable when the
         browser is out of contexts or the GPU process has died. */
      const gl = typeof this.renderer.getContext === 'function' ? this.renderer.getContext() : null;
      if (!gl) throw new Error('getContext() returned null');

      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(this.size, this.size, false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.renderer.shadowMap.enabled = false;
      this.available = true;
    } catch (err) {
      /* No WebGL (blocked, out of contexts, software fallback disabled …).
         render() will return null and callers keep their text-only cards. */
      console.warn('[ThumbnailRenderer] WebGL unavailable — thumbnails disabled', err);
      this.reason = (err && err.message) ? err.message : 'WebGL unavailable';
      this.available = false;
      this._releaseContext();
    }
  }

  /** Hand the context back immediately; safe on a partially-built renderer. */
  _releaseContext() {
    if (this.canvas && this._onContextLost) {
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost, false);
    }
    this._onContextLost = null;

    if (this.renderer) {
      /* Both calls are required: dispose() frees GL objects, forceContextLoss()
         hands the context itself back to the browser straight away. */
      try {
        this.renderer.dispose();
        if (typeof this.renderer.forceContextLoss === 'function') {
          this.renderer.forceContextLoss();
        }
      } catch (err) {
        console.warn('[ThumbnailRenderer] context release failed', err);
      }
      this.renderer = null;
    }
    this.canvas = null;
  }

  /** Neutral 3-point studio: key + fill + rim, over a soft ambient base. */
  _buildLights() {
    /* Directional lights are parallel: only their direction matters, so the rig
       stays valid no matter where in the world the sampled object sits. */
    const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
    key.position.set(2.6, 3.2, 2.4);

    const fill = new THREE.DirectionalLight(0xcfe4ff, 1.15);
    fill.position.set(-3.0, 0.8, 2.0);

    const rim = new THREE.DirectionalLight(0xffffff, 2.0);
    rim.position.set(-1.4, 2.0, -3.2);

    const ambient = new THREE.AmbientLight(0xb9c7d4, 0.55);
    const sky = new THREE.HemisphereLight(0xdfe9f2, 0x1a1d21, 0.9);

    this.rig.add(key, fill, rim, ambient, sky);
  }

  /**
   * Small procedural PMREM probe so bare metal/glass has something to reflect
   * when the caller does not hand us the app's environment map.
   * @returns {THREE.WebGLRenderTarget|null}
   */
  _buildFallbackEnvironment() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const sky = ctx.createLinearGradient(0, 0, 0, 64);
      sky.addColorStop(0.0, '#8d9aa6');
      sky.addColorStop(0.42, '#4a545e');
      sky.addColorStop(0.52, '#20262c');
      sky.addColorStop(1.0, '#0b0d10');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 128, 64);

      /* two soft overhead softboxes → believable highlight roll-off on metal */
      const box = (cx, cy, r, alpha) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(255,255,255,${alpha})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      };
      box(34, 14, 26, 0.95);
      box(96, 20, 20, 0.5);

      const tex = new THREE.CanvasTexture(canvas);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      const rt = pmrem.fromEquirectangular(tex);
      pmrem.dispose();
      tex.dispose();
      return rt;
    } catch (err) {
      console.warn('[ThumbnailRenderer] fallback environment failed', err);
      return null;
    }
  }

  /**
   * Place the camera on the fixed 3/4 angle and dolly until the object fills
   * ~FILL of the frame. The dolly distance is solved analytically: for a point
   * at lateral offset `y` and axial offset `z` from the pivot, the distance that
   * lands it exactly on the FILL boundary is `z + y / (tan(fov/2) * FILL)`, so
   * the maximum over every point is the tightest distance that clips nothing.
   * Solving over real vertices (rather than the bounding box) keeps discs, rods
   * and boxes at a consistent optical weight; the box corners are a safe upper
   * bound and are used for geometry we cannot walk cheaply.
   */
  _frame(root, box, center, radius) {
    const cam = this.camera;
    cam.fov = FOV;
    cam.aspect = 1;
    cam.up.copy(_worldUp);

    const az = THREE.MathUtils.degToRad(AZIMUTH);
    const el = THREE.MathUtils.degToRad(ELEVATION);
    _dir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

    /* camera basis, matching Object3D.lookAt() with the default world up */
    _right.crossVectors(_worldUp, _dir);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_dir, _right).normalize();

    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5) * FILL;
    const tanH = tanV * cam.aspect;

    _min.copy(box.min);
    _max.copy(box.max);

    let dist = this._solveDistance(root, center, tanV, tanH);
    if (!Number.isFinite(dist) || dist <= 0) dist = radius * 3;
    dist = Math.max(dist, radius * 1.05);

    cam.position.copy(center).addScaledVector(_dir, dist);
    cam.lookAt(center);
    cam.near = Math.max(1e-4, (dist - radius) * 0.5);
    cam.far = dist + radius * 4 + 1;
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
  }

  /** Tightest non-clipping dolly distance for `root`, in world units. */
  _solveDistance(root, center, tanV, tanH) {
    let dist = -Infinity;
    let walkable = true;
    let budget = 250000; // vertices — beyond this the box bound is cheaper

    root.traverse((node) => {
      if (!walkable) return;
      /* Instancing / skinning / points put the real positions somewhere we
         cannot read cheaply, so fall back to the (always safe) box bound. */
      if (node.isInstancedMesh || node.isSkinnedMesh || node.isPoints || node.isSprite) {
        walkable = false;
        return;
      }
      if (!node.visible || !node.isMesh) return;
      const pos = node.geometry && node.geometry.attributes && node.geometry.attributes.position;
      if (!pos) return;
      if (pos.count > budget) {
        walkable = false;
        return;
      }
      budget -= pos.count;
      for (let i = 0; i < pos.count; i++) {
        _corner.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
        const need = this._distanceFor(_corner, center, tanV, tanH);
        if (need > dist) dist = need;
      }
    });

    if (walkable && Number.isFinite(dist)) return dist;

    dist = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? _max.x : _min.x, i & 2 ? _max.y : _min.y, i & 4 ? _max.z : _min.z);
      const need = this._distanceFor(_corner, center, tanV, tanH);
      if (need > dist) dist = need;
    }
    return dist;
  }

  _distanceFor(point, center, tanV, tanH) {
    _v.subVectors(point, center);
    const z = _v.dot(_dir); // + = toward the camera
    return Math.max(z + Math.abs(_v.dot(_up)) / tanV, z + Math.abs(_v.dot(_right)) / tanH);
  }
}

export default ThumbnailRenderer;
