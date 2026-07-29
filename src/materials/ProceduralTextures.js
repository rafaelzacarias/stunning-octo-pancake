import * as THREE from 'three';

/* =====================================================================
 *  ProceduralTextures.js
 *
 *  Fully procedural PBR texture authoring for the metal shredder.
 *  Zero external assets, zero network access, zero extra dependencies.
 *
 *  Everything is built from:
 *    - mulberry32 seeded PRNG
 *    - periodic (tileable) Perlin-style gradient noise + fBm octaves
 *    - periodic Worley/cellular noise (galvanized spangle, concrete aggregate)
 *    - analytic segment-SDF rasterisation (scratches, diamond-plate lugs)
 *    - a real height field -> Sobel gradient -> tangent-space normal map
 *    - height-field cavity -> ambient occlusion
 *
 *  Performance strategy: low frequency noise layers are evaluated on a
 *  reduced lattice and bilinearly upsampled (wrap-aware); only the cheap
 *  fused composition pass runs at full resolution over flat typed arrays.
 * ===================================================================== */

/* ------------------------------------------------------------------ *
 * Canvas / texture plumbing
 * ------------------------------------------------------------------ */

const HAS_OFFSCREEN = typeof OffscreenCanvas !== 'undefined';

function createCanvas(w, h) {
  if (HAS_OFFSCREEN) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function dataToTexture(data, w, h, srgb, repeat) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Expand a single-channel 0..1 buffer into an RGBA byte buffer. */
function grayToRGBA(src, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = src[i] * 255;
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Math primitives
 * ------------------------------------------------------------------ */

function mulberry32(a) {
  let t = a >>> 0;
  return function random() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function wrapi(n, p) {
  const r = n % p;
  return r < 0 ? r + p : r;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/* ------------------------------------------------------------------ *
 * Colour space
 *
 * Every albedo is composited in LINEAR light and encoded to sRGB only
 * on the way into the canvas. Blending rust over steel in gamma space
 * is what made the old maps read as flat, over-dark stencils.
 * ------------------------------------------------------------------ */

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/* 4096-entry encode LUT: the composition loop calls this 3x per texel. */
const SRGB_ENCODE = new Uint8ClampedArray(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  SRGB_ENCODE[i] = (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
}

/** Linear 0..1 -> sRGB byte. */
function encodeSRGB(v) {
  return SRGB_ENCODE[(((v < 0 ? 0 : v > 1 ? 1 : v) * 4095) | 0)];
}

/** Author palettes as readable sRGB bytes, consume them as linear. */
function linRGB(bytes) {
  return [srgbToLinear(bytes[0] / 255), srgbToLinear(bytes[1] / 255), srgbToLinear(bytes[2] / 255)];
}

/* 8 unit-ish gradient directions -> avoids a switch in the inner loop. */
const GRAD_X = new Float32Array([1, -1, 1, -1, 0.7071, -0.7071, 0.7071, -0.7071]);
const GRAD_Y = new Float32Array([0.7071, 0.7071, -0.7071, -0.7071, 1, 1, -1, -1]);

/**
 * Periodic (seamlessly tileable) 2D gradient noise.
 * Lattice indices are wrapped modulo (px, py) so the field repeats exactly.
 * Output range ~[-0.707, 0.707].
 */
function perlin2(x, y, px, py, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const x0 = wrapi(ix, px);
  const x1 = wrapi(ix + 1, px);
  const y0 = wrapi(iy, py);
  const y1 = wrapi(iy + 1, py);

  const h00 = hash2i(x0, y0, seed) & 7;
  const h10 = hash2i(x1, y0, seed) & 7;
  const h01 = hash2i(x0, y1, seed) & 7;
  const h11 = hash2i(x1, y1, seed) & 7;

  const fx1 = fx - 1;
  const fy1 = fy - 1;

  const n00 = GRAD_X[h00] * fx + GRAD_Y[h00] * fy;
  const n10 = GRAD_X[h10] * fx1 + GRAD_Y[h10] * fy;
  const n01 = GRAD_X[h01] * fx + GRAD_Y[h01] * fy1;
  const n11 = GRAD_X[h11] * fx1 + GRAD_Y[h11] * fy1;

  const u = fade(fx);
  const v = fade(fy);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

const SQRT2 = 1.4142135623730951;

/**
 * fBm layer baked into a Float32Array in 0..1.
 * freqX/freqY are integer lattice periods, doubled each octave, so the
 * result tiles seamlessly over the [0,1) UV domain regardless of w/h.
 * w and h may differ (used for strongly anisotropic layers such as the
 * brushed grain, which is sampled coarsely across the grain direction).
 */
function fbmLayer(w, h, opts) {
  const freqX = opts.freqX !== undefined ? opts.freqX : 4;
  const freqY = opts.freqY !== undefined ? opts.freqY : 4;
  const octaves = opts.octaves !== undefined ? opts.octaves : 4;
  const gain = opts.gain !== undefined ? opts.gain : 0.5;
  const seed = opts.seed !== undefined ? opts.seed : 1;
  const ridged = !!opts.ridged;
  const billow = !!opts.billow;
  const warp = opts.warp !== undefined ? opts.warp : 0;
  const warpFreq = opts.warpFreq !== undefined ? opts.warpFreq : 2;

  const out = new Float32Array(w * h);

  let norm = 0;
  let a0 = 1;
  for (let o = 0; o < octaves; o++) {
    norm += a0;
    a0 *= gain;
  }
  const invNorm = 1 / norm;

  for (let y = 0; y < h; y++) {
    const v = y / h;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const u = x / w;

      let uu = u;
      let vv = v;
      if (warp > 0) {
        // Warping with a periodic field preserves tileability.
        uu = u + perlin2(u * warpFreq, v * warpFreq, warpFreq, warpFreq, seed + 7717) * warp;
        vv = v + perlin2(u * warpFreq, v * warpFreq, warpFreq, warpFreq, seed + 3313) * warp;
      }

      let amp = 1;
      let fx = freqX;
      let fy = freqY;
      let sum = 0;
      for (let o = 0; o < octaves; o++) {
        let n = perlin2(uu * fx, vv * fy, fx, fy, seed + o * 1013) * SQRT2;
        if (ridged) n = (1 - (n < 0 ? -n : n)) * 2 - 1;
        else if (billow) n = (n < 0 ? -n : n) * 2 - 1;
        sum += n * amp;
        amp *= gain;
        fx *= 2;
        fy *= 2;
      }

      out[row + x] = clamp01(0.5 + 0.5 * sum * invNorm);
    }
  }
  return out;
}

/** Wrap-aware bilinear resample of a scalar layer. */
function resampleWrap(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const rx = sw / dw;
  const ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * ry - 0.5;
    const iy0 = Math.floor(sy);
    const ty = sy - iy0;
    const y0 = wrapi(iy0, sh) * sw;
    const y1 = wrapi(iy0 + 1, sh) * sw;
    const row = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * rx - 0.5;
      const ix0 = Math.floor(sx);
      const tx = sx - ix0;
      const x0 = wrapi(ix0, sw);
      const x1 = wrapi(ix0 + 1, sw);
      const a = src[y0 + x0];
      const b = src[y0 + x1];
      const c = src[y1 + x0];
      const d = src[y1 + x1];
      out[row + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    }
  }
  return out;
}

/** Nearest resample — used for cell-id layers where interpolation is wrong. */
function resampleNearest(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const rx = sw / dw;
  const ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = wrapi(Math.floor((y + 0.5) * ry), sh) * sw;
    const row = y * dw;
    for (let x = 0; x < dw; x++) {
      out[row + x] = src[y0 + wrapi(Math.floor((x + 0.5) * rx), sw)];
    }
  }
  return out;
}

/** Separable wrap-around box blur (running-sum, O(n)). */
function boxBlurWrap(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (r * 2 + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + wrapi(k, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      sum += src[row + wrapi(x + r + 1, w)] - src[row + wrapi(x - r, w)];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[wrapi(k, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv;
      sum += tmp[wrapi(y + r + 1, h) * w + x] - tmp[wrapi(y - r, h) * w + x];
    }
  }
  return out;
}

/**
 * Periodic Worley / cellular noise.
 * Returns f1 and f2 normalised by cell size, plus a per-feature random id.
 */
function worleyLayer(w, h, opts) {
  const cells = opts.cells !== undefined ? opts.cells : 8;
  const seed = opts.seed !== undefined ? opts.seed : 1;
  const jitter = opts.jitter !== undefined ? opts.jitter : 0.9;

  const cw = w / cells;
  const ch = h / cells;
  const n = cells * cells;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pid = new Float32Array(n);

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const rnd = mulberry32(hash2i(cx, cy, seed));
      const k = cy * cells + cx;
      px[k] = (cx + 0.5 + (rnd() - 0.5) * jitter) * cw;
      py[k] = (cy + 0.5 + (rnd() - 0.5) * jitter) * ch;
      pid[k] = rnd();
    }
  }

  const f1 = new Float32Array(w * h);
  const f2 = new Float32Array(w * h);
  const id = new Float32Array(w * h);
  const invCell = 1 / Math.min(cw, ch);

  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / ch);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cw);
      let d1 = Infinity;
      let d2 = Infinity;
      let best = 0;

      for (let dy = -1; dy <= 1; dy++) {
        const ncy = cy + dy;
        const wcy = wrapi(ncy, cells);
        const oy = ((ncy - wcy) / cells) * h;
        for (let dx = -1; dx <= 1; dx++) {
          const ncx = cx + dx;
          const wcx = wrapi(ncx, cells);
          const ox = ((ncx - wcx) / cells) * w;
          const k = wcy * cells + wcx;
          const ddx = x - (px[k] + ox);
          const ddy = y - (py[k] + oy);
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = pid[k];
          } else if (d < d2) {
            d2 = d;
          }
        }
      }

      f1[row + x] = clamp01(d1 * invCell);
      f2[row + x] = clamp01(d2 * invCell);
      id[row + x] = best;
    }
  }
  return { f1, f2, id };
}

/**
 * Histogram threshold such that ~`coverage` of the field lies above it.
 * fBm never spans a full 0..1 range, so fixed cutoffs give wildly different
 * coverage per seed/preset; this makes the coverage parameters mean what
 * they say. Sampled with a stride — 1/5th of the pixels is plenty.
 *
 * `width` is the smoothstep ramp width as a fraction of the field's span.
 * Nothing in this file thresholds hard: masks ramp over `band` so the
 * derived roughness / metalness carry real tonal gradation.
 */
function coverageCutFn(length, get, coverage, width) {
  const w = width !== undefined ? width : 0.12;
  if (coverage <= 0.001) return { t0: Infinity, t1: Infinity, band: 1, span: 1 };
  const stride = 5;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < length; i += stride) {
    const v = get(i);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span < 1e-6) return { t0: Infinity, t1: Infinity, band: 1, span: 1 };

  const BINS = 256;
  const hist = new Uint32Array(BINS);
  const scale = (BINS - 1) / span;
  let total = 0;
  for (let i = 0; i < length; i += stride) {
    hist[((get(i) - min) * scale) | 0]++;
    total++;
  }

  const target = total * clamp01(coverage);
  let acc = 0;
  let bin = BINS - 1;
  for (; bin > 0; bin--) {
    acc += hist[bin];
    if (acc >= target) break;
  }

  const band = span * w;
  const t = min + (bin / (BINS - 1)) * span;
  return { t0: t - band * 0.5, t1: t + band * 0.5, band, span };
}

function coverageCut(field, coverage, width) {
  return coverageCutFn(field.length, (i) => field[i], coverage, width);
}

/**
 * Rasterise thin anisotropic scratches straight into a scalar buffer.
 * Indices are wrapped, so scratches tile across the seam.
 */
function stampScratches(dst, w, h, opts) {
  const rnd = opts.rnd;
  const count = opts.count | 0;
  const angle = opts.angle !== undefined ? opts.angle : 0;
  const jitter = opts.jitter !== undefined ? opts.jitter : 0.08;
  const minLen = opts.minLen !== undefined ? opts.minLen : w * 0.05;
  const maxLen = opts.maxLen !== undefined ? opts.maxLen : w * 0.5;
  const halfWidth = opts.halfWidth !== undefined ? opts.halfWidth : 0.9;
  const intensity = opts.intensity !== undefined ? opts.intensity : 0.8;
  const wobble = opts.wobble !== undefined ? opts.wobble : 1.5;

  for (let s = 0; s < count; s++) {
    const a = angle + (rnd() - 0.5) * 2 * jitter;
    const dirX = Math.cos(a);
    const dirY = Math.sin(a);
    const perpX = -dirY;
    const perpY = dirX;

    const len = minLen + rnd() * (maxLen - minLen);
    const steps = Math.max(2, Math.ceil(len));
    const sx = rnd() * w;
    const sy = rnd() * h;

    const amp = intensity * (0.18 + rnd() * 0.82);
    const hw = halfWidth * (0.45 + rnd() * 1.35);
    const rad = Math.ceil(hw);
    const invHw = 1 / (hw + 1e-4);

    const wobAmp = wobble * (0.2 + rnd() * 1.0);
    const wobFreq = (0.6 + rnd() * 2.4) / Math.max(8, len);
    const phase = rnd() * 6.283185307;
    const invSteps = 1 / steps;

    for (let t = 0; t < steps; t++) {
      const tt = t * invSteps;
      // taper both ends so scratches fade out instead of ending abruptly
      const taper = Math.min(1, (tt < 1 - tt ? tt : 1 - tt) * 9);
      if (taper <= 0) continue;
      const off = Math.sin(phase + t * wobFreq * 6.283185307) * wobAmp;
      const cx = sx + dirX * t + perpX * off;
      const cy = sy + dirY * t + perpY * off;
      const a2 = amp * taper;

      for (let k = -rad; k <= rad; k++) {
        const d = Math.abs(k) * invHw;
        if (d > 1) continue;
        const f = (1 - d * d) * a2;
        const ix = wrapi(Math.round(cx + perpX * k), w);
        const iy = wrapi(Math.round(cy + perpY * k), h);
        const idx = iy * w + ix;
        const v = dst[idx] + f;
        dst[idx] = v > 1 ? 1 : v;
      }
    }
  }
}

/**
 * Height field -> tangent-space normal map (RGBA bytes).
 * Sobel gradient; packed as (x*0.5+0.5, y*0.5+0.5, z).
 * Green is +Y because CanvasTexture uploads with flipY = true, which
 * inverts the row direction relative to the V axis (OpenGL convention).
 */
function heightToNormalData(height, w, h, strength) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const rm = wrapi(y - 1, h) * w;
    const r0 = y * w;
    const rp = wrapi(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const xm = wrapi(x - 1, w);
      const xp = wrapi(x + 1, w);

      const h00 = height[rm + xm];
      const h10 = height[rm + x];
      const h20 = height[rm + xp];
      const h01 = height[r0 + xm];
      const h21 = height[r0 + xp];
      const h02 = height[rp + xm];
      const h12 = height[rp + x];
      const h22 = height[rp + xp];

      const dx = h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02);
      const dy = h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20);

      const nx = -dx * strength;
      const ny = dy * strength;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + 1);

      const o = (r0 + x) * 4;
      out[o] = (nx * invLen * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * invLen * 0.5 + 0.5) * 255;
      out[o + 2] = invLen * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Cavity-style AO from the height field, sampled at two spatial scales.
 * Flat regions land on 1.0 (fully open); grooves, pits and plate valleys
 * fall below their local mean and darken.
 */
function heightToAO(height, w, h, strength) {
  const near = boxBlurWrap(height, w, h, Math.max(2, w >> 8));
  const far = boxBlurWrap(height, w, h, Math.max(4, w >> 5));
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const cav = (height[i] - near[i]) * 7 + (height[i] - far[i]) * 3.5;
    out[i] = clamp(1 + cav * strength, 0.1, 1);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Palettes and presets
 * ------------------------------------------------------------------ */

/* Corrosion palettes. Authored in sRGB bytes, stored linear.
 * Deliberately low-contrast: rust is a stain that sits ON steel, so the
 * dark end is a muted brown rather than near-black, and the spread from
 * `dark` to `bloom` is about half what it used to be. */
const RUST_PAL = {
  dark: linRGB([84, 50, 33]),
  mid: linRGB([124, 76, 48]),
  light: linRGB([154, 103, 70]),
  bloom: linRGB([172, 130, 98]),
};

const PATINA_PAL = {
  dark: linRGB([58, 82, 72]),
  mid: linRGB([84, 122, 105]),
  light: linRGB([116, 154, 136]),
  bloom: linRGB([144, 174, 158]),
};

const ALU_OXIDE_PAL = {
  dark: linRGB([124, 126, 129]),
  mid: linRGB([154, 157, 161]),
  light: linRGB([180, 183, 187]),
  bloom: linRGB([198, 201, 205]),
};

const ZINC_PAL = {
  dark: linRGB([112, 114, 118]),
  mid: linRGB([148, 147, 142]),
  light: linRGB([172, 160, 138]),
  bloom: linRGB([188, 178, 158]),
};

/**
 * Per-preset authoring constants.
 *
 *  colA/colB   - bare-metal albedo endpoints in LINEAR RGB. These are F0
 *                reflectances: steel lands at ~0.57 linear luminance with
 *                <4% saturation, aluminium slightly brighter and cooler.
 *  rust        - default rust coverage 0..1
 *  scratches   - default scratch density 0..1
 *  roughBase   - bare-metal roughness (rust drives this to ~0.93)
 *  roughVar    - half-swing of the smooth base roughness breathing (~0.06)
 *  metalBase   - bare-metal metalness (rust drives this to ~0.05)
 */
const PRESETS = {
  steel: {
    colA: [0.660, 0.676, 0.700], colB: [0.542, 0.556, 0.578],
    scratchCol: [0.860, 0.876, 0.900],
    roughBase: 0.30, roughVar: 0.060, metalBase: 0.99,
    rust: 0.12, scratches: 0.55,
    grain: 0.075, pitting: 0.10, spangle: false, paint: null, pal: RUST_PAL,
  },
  aluminum: {
    colA: [0.716, 0.732, 0.770], colB: [0.604, 0.620, 0.656],
    scratchCol: [0.900, 0.915, 0.945],
    roughBase: 0.28, roughVar: 0.052, metalBase: 0.99,
    rust: 0.02, scratches: 0.75,
    grain: 0.115, pitting: 0.06, spangle: false, paint: null, pal: ALU_OXIDE_PAL,
  },
  castIron: {
    colA: [0.378, 0.381, 0.390], colB: [0.288, 0.290, 0.297],
    scratchCol: [0.560, 0.566, 0.578],
    roughBase: 0.44, roughVar: 0.070, metalBase: 0.985,
    rust: 0.25, scratches: 0.35,
    grain: 0.03, pitting: 0.85, spangle: false, paint: null, pal: RUST_PAL,
  },
  galvanized: {
    colA: [0.688, 0.704, 0.734], colB: [0.558, 0.572, 0.598],
    scratchCol: [0.850, 0.866, 0.890],
    roughBase: 0.35, roughVar: 0.068, metalBase: 0.99,
    rust: 0.06, scratches: 0.40,
    grain: 0.035, pitting: 0.12, spangle: true, paint: null, pal: ZINC_PAL,
  },
  copper: {
    colA: [1.000, 0.678, 0.572], colB: [0.845, 0.560, 0.462],
    scratchCol: [1.000, 0.790, 0.672],
    roughBase: 0.27, roughVar: 0.055, metalBase: 0.99,
    rust: 0.10, scratches: 0.50,
    grain: 0.075, pitting: 0.08, spangle: false, paint: null, pal: PATINA_PAL,
  },
  paintedSteel: {
    colA: [0.645, 0.660, 0.684], colB: [0.529, 0.542, 0.564],
    scratchCol: [0.855, 0.870, 0.894],
    roughBase: 0.32, roughVar: 0.060, metalBase: 0.99,
    rust: 0.10, scratches: 0.45,
    grain: 0.06, pitting: 0.12, spangle: false,
    paint: { rough: 0.52, coverage: 0.51 }, pal: RUST_PAL,
  },
  rustedSteel: {
    colA: [0.618, 0.632, 0.656], colB: [0.505, 0.518, 0.540],
    scratchCol: [0.820, 0.836, 0.860],
    roughBase: 0.38, roughVar: 0.065, metalBase: 0.99,
    rust: 0.85, scratches: 0.30,
    grain: 0.045, pitting: 0.35, spangle: false, paint: null, pal: RUST_PAL,
  },
  /* Bright cast + machined aluminium alloy (wheel rims). Slightly brighter
   * and cooler than wrought aluminium, with sand-cast micro pitting left in
   * the unmachined pockets and a fine turned grain on the faces. */
  alloy: {
    colA: [0.762, 0.776, 0.806], colB: [0.638, 0.650, 0.678],
    scratchCol: [0.930, 0.942, 0.968],
    roughBase: 0.30, roughVar: 0.055, metalBase: 0.99,
    rust: 0.03, scratches: 0.42,
    grain: 0.055, pitting: 0.22, spangle: false, paint: null, pal: ALU_OXIDE_PAL,
  },
  /* White-enamelled appliance sheet steel. Near-total paint coverage, so the
   * metalness map reads ~0 everywhere except the handful of chips and the
   * gouges that cut back to bare, lightly corroded steel. */
  applianceSteel: {
    colA: [0.636, 0.650, 0.672], colB: [0.518, 0.530, 0.552],
    scratchCol: [0.848, 0.862, 0.886],
    roughBase: 0.34, roughVar: 0.055, metalBase: 0.99,
    rust: 0.08, scratches: 0.22,
    grain: 0.04, pitting: 0.06, spangle: false,
    paint: { rough: 0.31, coverage: 0.965, color: 'white' }, pal: RUST_PAL,
  },
};

/* Industrial machine enamels, linear. `grey` is a genuine neutral
 * machine grey (~#6a6f73) and `yellow` is safety yellow (~#d8a318). */
const PAINT_COLORS = {
  yellow: { a: linRGB([216, 163, 24]), b: linRGB([170, 126, 20]) },
  grey: { a: linRGB([106, 111, 115]), b: linRGB([78, 82, 86]) },
  orange: { a: linRGB([206, 106, 26]), b: linRGB([160, 80, 20]) },
  green: { a: linRGB([56, 108, 74]), b: linRGB([38, 78, 54]) },
  blue: { a: linRGB([48, 86, 132]), b: linRGB([34, 62, 98]) },
  /* Appliance enamel: an off-white that still has somewhere to go under a
   * bright key light instead of clipping at paper white. */
  white: { a: linRGB([232, 233, 229]), b: linRGB([203, 205, 202]) },
};

/* ------------------------------------------------------------------ *
 * Dielectric (non-metal) palettes and presets
 *
 * These run a completely separate composition path from the metal
 * presets: there is no rust model, no spangle, no paint film, and the
 * metalness channel is flat zero (the PCB is the one exception — its
 * exposed solder pads are genuinely metallic).
 * ------------------------------------------------------------------ */

const WOOD_PAL = {
  early: linRGB([138, 96, 58]),
  late: linRGB([62, 36, 19]),
  pore: linRGB([32, 18, 10]),
  sheen: linRGB([182, 140, 96]),
};

const PCB_PAL = {
  mask: linRGB([16, 58, 32]),
  maskHi: linRGB([38, 112, 62]),
  overCopper: linRGB([28, 92, 48]),
  solder: linRGB([178, 181, 186]),
  epoxy: linRGB([26, 26, 28]),
  silk: linRGB([224, 226, 220]),
  hole: linRGB([22, 20, 17]),
};

const RUBBER_BLOOM = linRGB([74, 71, 66]);
const FERRITE_FRESH = linRGB([104, 102, 106]);

/**
 * `kind`          selects the composition pass
 * `base`          LINEAR albedo of the intact surface
 * `roughBase`     roughness of the intact surface (absolute — the map is
 *                 authored absolute and the scalar stays at 1.0)
 * `microRes`      lattice for the pixel-scale detail layer; only the
 *                 presets whose read depends on grain pay for 384.
 */
const DIELECTRIC_PRESETS = {
  glass: {
    kind: 'glass', base: [0.043, 0.050, 0.053],
    roughBase: 0.055, scratches: 0.22,
    normalStrength: 1.3, aoStrength: 0.5, microRes: 256,
  },
  abs: {
    kind: 'plastic', base: [0.0172, 0.0174, 0.0190],
    roughBase: 0.44, scratches: 0.30,
    normalStrength: 3.2, aoStrength: 1.5, microRes: 384,
  },
  rubber: {
    kind: 'rubber', base: [0.0118, 0.0118, 0.0124],
    roughBase: 0.86, scratches: 0.45,
    normalStrength: 2.8, aoStrength: 1.4, microRes: 384,
  },
  mdf: {
    kind: 'wood', base: [0.090, 0.052, 0.027],
    roughBase: 0.36, scratches: 0.20,
    normalStrength: 2.2, aoStrength: 1.2, microRes: 256,
  },
  pcb: {
    kind: 'pcb', base: [0.020, 0.070, 0.038],
    roughBase: 0.30, scratches: 0.12,
    normalStrength: 3.4, aoStrength: 1.7, microRes: 256,
  },
  ferrite: {
    kind: 'ceramic', base: [0.0166, 0.0161, 0.0169],
    roughBase: 0.56, scratches: 0.25,
    normalStrength: 3.0, aoStrength: 1.6, microRes: 384,
  },
};

/* Floor palette, linear.
 *
 * Concrete is authored directly as a linear grey and hard-clamped to a
 * narrow band: real cured concrete lives around 0.20-0.28 reflectance and
 * never goes brown or orange. */
const CONCRETE_TONE = 0.238;
const CONCRETE_DUST = 0.276;
const CONCRETE_MIN = 0.160;
const CONCRETE_MAX = 0.340;

const PLATE_BASE = linRGB([118, 121, 126]);
const PLATE_POLISH = linRGB([196, 200, 206]);
const GRIME_COL = linRGB([54, 50, 45]);
const OIL_PLATE = linRGB([30, 26, 22]);
const SCUFF_PLATE = linRGB([176, 178, 180]);
const SCUFF_CONCRETE = linRGB([150, 150, 148]);

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

const textureCache = new Map();

function cacheSet(key, set) {
  const wrapped = set;
  const innerDispose = set.dispose;
  wrapped.dispose = function dispose() {
    textureCache.delete(key);
    innerDispose();
  };
  textureCache.set(key, wrapped);
  return wrapped;
}

function makeSet(parts, repeat, size) {
  const map = dataToTexture(parts.color, size, size, true, repeat);
  const normalMap = dataToTexture(parts.normal, size, size, false, repeat);
  const roughnessMap = dataToTexture(parts.rough, size, size, false, repeat);
  const metalnessMap = dataToTexture(parts.metal, size, size, false, repeat);
  const aoMap = dataToTexture(parts.ao, size, size, false, repeat);
  return {
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    aoMap,
    dispose() {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
      metalnessMap.dispose();
      aoMap.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Metal generation
 * ------------------------------------------------------------------ */

function buildScratchFields(size, seed, amount, anisotropic) {
  const rnd = mulberry32(hash2i(size, seed, 0x5c247c4));
  const scratch = new Float32Array(size * size);
  const gouge = new Float32Array(size * size);

  const primary = Math.round(size * 0.85 * amount) + 24;
  const secondary = Math.round(size * 0.35 * amount) + 12;
  const gouges = Math.round(4 + 22 * amount);

  const baseAngle = anisotropic ? 0.03 : rnd() * Math.PI;
  const spread = anisotropic ? 0.075 : Math.PI;

  stampScratches(scratch, size, size, {
    rnd, count: primary, angle: baseAngle, jitter: spread,
    minLen: size * 0.06, maxLen: size * 0.55,
    halfWidth: 0.75, intensity: 0.55, wobble: size / 640,
  });

  stampScratches(scratch, size, size, {
    rnd, count: secondary, angle: baseAngle - 0.09, jitter: spread * 1.8,
    minLen: size * 0.02, maxLen: size * 0.18,
    halfWidth: 1.15, intensity: 0.8, wobble: size / 400,
  });

  // Deep gouges crossing the brushed direction.
  stampScratches(gouge, size, size, {
    rnd, count: gouges, angle: baseAngle + (anisotropic ? 0.55 : 0),
    jitter: anisotropic ? 0.9 : Math.PI,
    minLen: size * 0.15, maxLen: size * 0.85,
    halfWidth: 1.7, intensity: 1.0, wobble: size / 260,
  });

  return { scratch, gouge };
}

function buildMetalMaps(preset, cfg) {
  const P = PRESETS[preset];
  const size = cfg.size;
  const seed = cfg.seed;
  const rustAmt = cfg.rust;
  const aniso = cfg.anisotropic;

  const LO = Math.max(64, size >> 2);
  const GW = Math.max(32, size >> 3);
  const N = size * size;

  // Each layer is evaluated on the smallest lattice that still clears its own
  // Nyquist limit (2x the highest octave it contains) and is then upsampled
  // wrap-aware. Sizing by bandwidth rather than by output resolution is what
  // keeps all seven presets at 1024² inside the time budget.
  const R_MOTTLE = Math.min(size, 128);   // max octave 3*8   = 24
  const R_MESO = Math.min(size, 256);     // max octave 13*8  = 104
  const R_MICRO = Math.min(size, 384);    // max octave 46*4  = 184
  const R_RUST = Math.min(size, 256);     // max octave 14*8  = 112
  const R_CHIP = Math.min(size, 256);     // max octave 24*4  = 96
  const R_ZONE = Math.min(size, 128);     // max octave 8*4   = 32
  const R_RUNW = Math.min(size, 256);     // max octave 30*4  = 120 across U
  const R_RUNH = Math.max(32, R_RUST >> 1); // tall enough that the 2x upsample
                                            // leaves no visible C0 banding

  /* ---- reusable noise layers (generated once, shared by every pass) -- */
  const mottleSrc = fbmLayer(R_MOTTLE, R_MOTTLE, { freqX: 3, freqY: 3, octaves: 4, seed: seed * 3 + 11, warp: 0.07, warpFreq: 2 });
  const mesoSrc = fbmLayer(R_MESO, R_MESO, { freqX: 13, freqY: 13, octaves: 4, seed: seed * 7 + 23 });
  const mottle = resampleWrap(mottleSrc, R_MOTTLE, R_MOTTLE, size, size);
  const meso = resampleWrap(mesoSrc, R_MESO, R_MESO, size, size);
  const micro = resampleWrap(
    fbmLayer(R_MICRO, R_MICRO, { freqX: 46, freqY: 46, octaves: 3, gain: 0.55, seed: seed * 13 + 41 }),
    R_MICRO, R_MICRO, size, size,
  );

  // Brushed/rolled grain: slow across X, fast along Y -> long directional
  // streaks. The Y frequency is capped so the finest octave still gets ~6
  // samples per cycle at 1024. Letting it scale freely with `size` put the
  // top octave at the Nyquist limit, which both aliased under mipmapping
  // (the "corrugation" look) and broke the horizontal wrap.
  const grainFreqY = Math.max(12, Math.min(40, size >> 4));
  let grain;
  if (aniso) {
    grain = resampleWrap(
      fbmLayer(GW, size, { freqX: 3, freqY: grainFreqY, octaves: 3, gain: 0.55, seed: seed * 17 + 5 }),
      GW, size, size, size,
    );
  } else {
    grain = resampleWrap(
      fbmLayer(R_MICRO, R_MICRO, { freqX: 60, freqY: 60, octaves: 2, gain: 0.55, seed: seed * 17 + 5 }),
      R_MICRO, R_MICRO, size, size,
    );
  }

  // Rust concentration field.
  //
  // The dominant patch frequency is ~3.5x what it used to be, so a tile
  // repeated 8-10x across a wall reads as surface staining instead of
  // camouflage. `runs` is strongly anisotropic (fast across U, slow along
  // V) which biases the corrosion into vertical weathering streaks.
  //
  // Every component is band-limited well below R_RUST, so the field is
  // assembled at low resolution and upsampled once, rather than upsampling
  // three layers and combining them per output texel.
  const RR = R_RUST;
  const RRN = RR * RR;
  const rustPatchL = fbmLayer(RR, RR, { freqX: 14, freqY: 12, octaves: 4, seed: seed * 29 + 3, warp: 0.09, warpFreq: 6 });
  const rustFineL = fbmLayer(RR, RR, { freqX: 30, freqY: 27, octaves: 3, gain: 0.5, seed: seed * 31 + 61 });
  const runsL = resampleWrap(
    fbmLayer(R_RUNW, R_RUNH, { freqX: 30, freqY: 2, octaves: 3, gain: 0.55, seed: seed * 23 + 9 }),
    R_RUNW, R_RUNH, RR, RR,
  );
  const mesoL = resampleWrap(mesoSrc, R_MESO, R_MESO, RR, RR);

  const rustFieldL = new Float32Array(RRN);
  for (let i = 0; i < RRN; i++) {
    const st = runsL[i];
    rustFieldL[i] = (rustPatchL[i] * 0.46 + rustFineL[i] * 0.21 + mesoL[i] * 0.10 + st * 0.23)
      * (0.56 + 0.44 * st);
  }
  const rustField = resampleWrap(rustFieldL, RR, RR, size, size);
  const rustCut = coverageCut(rustField, rustAmt, 0.12);

  // Sand-cast / corrosion pitting: small isolated craters.
  const pitCut = P.pitting > 0
    ? coverageCutFn(N, (i) => micro[i] * 0.65 + meso[i] * 0.35, P.pitting * 0.30, 0.14)
    : null;

  const { scratch, gouge } = buildScratchFields(size, seed, cfg.scratches, aniso);

  let chipField = null;
  let chipCut = null;
  let paintA = null;
  let paintB = null;
  if (P.paint) {
    // Paint failure is two-scale: broad `zone`s where the film has worn off
    // a rubbing face, plus a high-frequency `chip` layer that makes the zone
    // borders ragged and scatters small isolated chips across intact paint.
    // Using the detail layer alone produced a uniform lace/maze; using the
    // broad layer alone produced the ink-blot look the critic rejected.
    const CC = R_CHIP;
    const CCN = CC * CC;
    const chipL = fbmLayer(CC, CC, { freqX: 26, freqY: 24, octaves: 3, gain: 0.5, seed: seed * 31 + 77, warp: 0.08, warpFreq: 12 });
    const zoneL = resampleWrap(
      fbmLayer(R_ZONE, R_ZONE, { freqX: 8, freqY: 7, octaves: 3, seed: seed * 37 + 91, warp: 0.12, warpFreq: 4 }),
      R_ZONE, R_ZONE, CC, CC,
    );
    const mottleC = resampleWrap(mottleSrc, R_MOTTLE, R_MOTTLE, CC, CC);
    const chipCombined = new Float32Array(CCN);
    for (let i = 0; i < CCN; i++) {
      const wearPath = 1 - Math.abs(mottleC[i] - 0.5) * 2;
      chipCombined[i] = zoneL[i] * 0.58 + chipL[i] * 0.42 - wearPath * 0.10;
    }
    chipField = resampleWrap(chipCombined, CC, CC, size, size);
    chipCut = coverageCut(chipField, cfg.paintCoverage, 0.07);
    const pc = PAINT_COLORS[cfg.paintColor] || PAINT_COLORS.yellow;
    paintA = pc.a;
    paintB = pc.b;
  }

  let spF1 = null;
  let spF2 = null;
  let spId = null;
  if (P.spangle) {
    const wl = worleyLayer(LO, LO, { cells: 9, seed: seed * 41 + 19, jitter: 0.95 });
    spF1 = resampleWrap(wl.f1, LO, LO, size, size);
    spF2 = resampleWrap(wl.f2, LO, LO, size, size);
    spId = resampleNearest(wl.id, LO, LO, size, size);
  }

  /* ---- fused composition pass -------------------------------------- */
  const color = new Uint8ClampedArray(N * 4);
  const rough = new Uint8ClampedArray(N * 4);
  const metal = new Uint8ClampedArray(N * 4);
  const height = new Float32Array(N);

  const cA = P.colA;
  const cB = P.colB;
  const sCol = P.scratchCol;
  const pal = P.pal;
  const paintRough = P.paint ? P.paint.rough : 0;

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const mi = micro[i];
    const gr = grain[i];
    const sc = scratch[i];
    const go = gouge[i];
    const scr = clamp01(sc + go * 0.85);

    /* --- base metal albedo (LINEAR): mottling + grain + micro --- */
    const grainF = 1 + (gr - 0.5) * 2 * P.grain;
    const microF = 1 + (mi - 0.5) * 0.06;
    const shade = grainF * microF;
    let r = lerp(cA[0], cB[0], mo) * shade;
    let g = lerp(cA[1], cB[1], mo) * shade;
    let b = lerp(cA[2], cB[2], mo) * shade;

    // Four smooth octaves summing to roughly +/-0.06: the base "breathes"
    // under a moving highlight instead of being a flat plateau.
    let ro = P.roughBase
      + ((mo - 0.5) * 0.90 + (me - 0.5) * 0.60 + (mi - 0.5) * 0.40 + (gr - 0.5) * 0.35) * P.roughVar;
    // Bare metal keeps a live but very high metalness; the oxide film only
    // nudges it, so the map mean stays > 0.85 for clean presets.
    let mt = P.metalBase - (mi - 0.5) * 0.030 - (me - 0.5) * 0.018;
    let hh = (mo - 0.5) * 0.050 + (me - 0.5) * 0.028 + (mi - 0.5) * 0.015 + (gr - 0.5) * 0.018;

    /* --- galvanized spangle crystals --- */
    if (spId !== null) {
      const facet = 0.90 + spId[i] * 0.20;
      const edge = smoothstep(0.0, 0.075, spF2[i] - spF1[i]);
      const crystal = facet * (0.92 + 0.08 * edge);
      r *= crystal;
      g *= crystal;
      b *= crystal;
      ro += (1 - edge) * 0.07 - (spId[i] - 0.5) * 0.05;
      hh += (edge - 0.5) * 0.006;
    }

    /* --- cast/sand pitting --- */
    let pitM = 0;
    if (pitCut !== null) {
      pitM = smoothstep(pitCut.t0, pitCut.t1, mi * 0.65 + me * 0.35);
      const dk = 1 - pitM * 0.34;
      r *= dk;
      g *= dk;
      b *= dk;
      ro += pitM * 0.24;
      hh -= pitM * 0.042;
    }

    /* --- paint chips (computed first: chip edges seed the rust) --- */
    let paintM = 0;
    let chipEdge = 0;
    if (chipField !== null) {
      const cv = chipField[i];
      paintM = smoothstep(chipCut.t0, chipCut.t1, cv);
      // band immediately outside the film: bare, corroding chip rim
      chipEdge = smoothstep(chipCut.t0 - chipCut.band * 1.8, chipCut.t0, cv) * (1 - paintM);
      // gouges and heavy scratching strip the paint film
      paintM *= clamp01(1 - go * 1.15) * (1 - sc * 0.35);
      // Steel that has lost its paint is oxidised, not polished. Darkening it
      // keeps metalness at ~1 while stopping the chips from reading as a
      // high-contrast stencil against bright bare metal.
      const oxide = 1 - (1 - paintM) * 0.42;
      r *= oxide;
      g *= oxide;
      b *= oxide;
      ro += (1 - paintM) * 0.06;
    }

    /* --- rust ---------------------------------------------------------
     * Two nested masks. `rustCore` is the soft-thresholded stain (ramped
     * over a 0.12-wide window, never a hard cut) and drives the PBR
     * channels; `rustStain` adds a wide, weak halo so the corrosion fades
     * out over many texels instead of stencilling. Albedo is blended at
     * roughly half the old strength, so it tints the steel rather than
     * replacing it with a second material.                              */
    let rustCore = 0;
    let rustHalo = 0;
    if (rustAmt > 0.001) {
      const rf = rustField[i];
      rustCore = smoothstep(rustCut.t0, rustCut.t1, rf);
      rustHalo = smoothstep(rustCut.t0 - rustCut.band * 3.4, rustCut.t0 + rustCut.band * 0.6, rf);
    }
    if (chipEdge > 0) {
      const rim = chipEdge * (0.55 + 0.45 * rustAmt);
      rustCore = clamp01(rustCore + rim);
      rustHalo = clamp01(rustHalo + rim);
    }
    const rustStain = clamp01(rustCore * 0.75 + rustHalo * 0.25);

    if (rustStain > 0.002) {
      const core = rustCore * smoothstep(0.55, 0.95, 1 - mi);
      let rr = lerp(pal.light[0], pal.mid[0], me);
      let rg = lerp(pal.light[1], pal.mid[1], me);
      let rb = lerp(pal.light[2], pal.mid[2], me);
      rr = lerp(rr, pal.dark[0], core);
      rg = lerp(rg, pal.dark[1], core);
      rb = lerp(rb, pal.dark[2], core);
      const bloom = smoothstep(0.62, 0.96, mi) * 0.30;
      rr = lerp(rr, pal.bloom[0], bloom);
      rg = lerp(rg, pal.bloom[1], bloom);
      rb = lerp(rb, pal.bloom[2], bloom);

      // A light stain tints the steel; a genuinely rusted-through surface is
      // allowed to cover it. Roughly half the old contrast at low coverage.
      const tint = rustStain * (0.58 + 0.30 * rustAmt);
      r = lerp(r, rr, tint);
      g = lerp(g, rg, tint);
      b = lerp(b, rb, tint);

      ro = lerp(ro, 0.93, rustStain);
      // Metalness tracks the rust *core* only: bare steel stays ~1.0 and
      // just the corroded fraction drops to 0.05, so the map reads white
      // with dark stains rather than the other way round. The core is a
      // smoothstep over a 0.12-wide window, so the drop is still a ramp.
      mt = lerp(mt, 0.05, rustCore);
      hh += rustStain * 0.011 - core * 0.037;
    }

    /* --- scratches: brighter albedo, burnished (lower) roughness --- */
    if (scr > 0.001) {
      r = lerp(r, sCol[0], scr * 0.50);
      g = lerp(g, sCol[1], scr * 0.50);
      b = lerp(b, sCol[2], scr * 0.50);
      ro -= scr * 0.19;
      // A fresh scrape cuts back to bare metal even through rust/oxide.
      mt = clamp01(mt + scr * 0.30);
      hh -= sc * 0.022 + go * 0.080;
    }

    /* --- paint film on top --- */
    if (paintM > 0.001) {
      const wear = 1 - scr * 0.40;
      const tone = (0.94 + 0.12 * mo) * wear;
      const pr = lerp(paintA[0], paintB[0], me) * tone;
      const pg = lerp(paintA[1], paintB[1], me) * tone;
      const pb = lerp(paintA[2], paintB[2], me) * tone;
      r = lerp(r, pr, paintM);
      g = lerp(g, pg, paintM);
      b = lerp(b, pb, paintM);
      ro = lerp(ro, paintRough + (me - 0.5) * 0.09 + scr * 0.10, paintM);
      mt = lerp(mt, 0.0, paintM);
      hh += paintM * 0.017 - chipEdge * 0.010;
    }

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;

    const rv = clamp(ro, 0.04, 1) * 255;
    rough[o] = rv;
    rough[o + 1] = rv;
    rough[o + 2] = rv;
    rough[o + 3] = 255;

    const mv = clamp01(mt) * 255;
    metal[o] = mv;
    metal[o + 1] = mv;
    metal[o + 2] = mv;
    metal[o + 3] = 255;

    height[i] = clamp01(0.5 + hh);
  }

  // Height amplitudes above are half what they were; the renderer stacks a
  // normalScale of 1.25-1.6 on top, so these are baked conservatively.
  const normal = heightToNormalData(height, size, size, 3.0);
  const aoF = heightToAO(height, size, size, 1.9);
  for (let i = 0; i < N; i++) {
    aoF[i] = clamp(aoF[i] * (1 - gouge[i] * 0.3) * (1 - scratch[i] * 0.10), 0.06, 1);
  }
  const ao = grayToRGBA(aoF, N);

  return { color, normal, rough, metal, ao };
}

/* ------------------------------------------------------------------ *
 * Dielectric generation
 *
 * Shared skeleton: three band-limited noise layers, one fused
 * composition pass per material kind, then the same height -> normal ->
 * cavity-AO derivation the metal path uses.
 * ------------------------------------------------------------------ */

/** Max-blended, 1-texel-feathered disc into a 0..255 mask. */
function stampDisc(dst, w, h, cx, cy, radius, value) {
  const rad = Math.ceil(radius) + 1;
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  for (let oy = -rad; oy <= rad; oy++) {
    const row = wrapi(iy + oy, h) * w;
    for (let ox = -rad; ox <= rad; ox++) {
      const d = Math.sqrt(ox * ox + oy * oy);
      const f = clamp01(radius + 0.5 - d) * value;
      if (f <= 0) continue;
      const idx = row + wrapi(ix + ox, w);
      if (dst[idx] < f) dst[idx] = f;
    }
  }
}

/** Max-blended constant-width segment (a copper trace run). */
function stampSegment(dst, w, h, x0, y0, x1, y1, halfWidth, value) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
  const ux = dx / steps;
  const uy = dy / steps;
  for (let t = 0; t <= steps; t++) {
    stampDisc(dst, w, h, x0 + ux * t, y0 + uy * t, halfWidth, value);
  }
}

/** Max-blended filled axis-aligned rectangle. */
function stampRect(dst, w, h, cx, cy, hx, hy, value) {
  const y0 = Math.round(cy - hy);
  const y1 = Math.round(cy + hy);
  const x0 = Math.round(cx - hx);
  const x1 = Math.round(cx + hx);
  for (let y = y0; y <= y1; y++) {
    const row = wrapi(y, h) * w;
    for (let x = x0; x <= x1; x++) {
      const idx = row + wrapi(x, w);
      if (dst[idx] < value) dst[idx] = value;
    }
  }
}

/**
 * Seeded circuit-board artwork: routed traces on a 16x16 grid with 45°
 * dog-legs, through-hole vias, DIP/SOIC footprints with pad rows, a couple
 * of electrolytic cans, and a silkscreen layer. All masks tile.
 */
function pcbLayout(size, seed) {
  const rnd = mulberry32(hash2i(size, seed, 0x2c8b17));
  const n = size * size;
  const trace = new Uint8ClampedArray(n);
  const pad = new Uint8ClampedArray(n);
  const hole = new Uint8ClampedArray(n);
  const silk = new Uint8ClampedArray(n);
  const chip = new Uint8ClampedArray(n);

  const cells = 16;
  const pitch = size / cells;
  const tw = Math.max(0.9, size / 460);        // trace half width, px

  /* --- routed signal traces ------------------------------------------ */
  const routes = 30;
  for (let r = 0; r < routes; r++) {
    let x = (Math.floor(rnd() * cells) + 0.5) * pitch;
    let y = (Math.floor(rnd() * cells) + 0.5) * pitch;
    const legs = 3 + ((rnd() * 4) | 0);
    const wide = rnd() < 0.18 ? 2.2 : 1;       // occasional power rail
    for (let l = 0; l < legs; l++) {
      const ang = ((rnd() * 8) | 0) * Math.PI * 0.25;
      const len = pitch * (1 + ((rnd() * 3) | 0));
      const nx = x + Math.cos(ang) * len;
      const ny = y + Math.sin(ang) * len;
      stampSegment(trace, size, size, x, y, nx, ny, tw * wide, 255);
      x = nx;
      y = ny;
    }
    stampDisc(pad, size, size, x, y, tw * 2.7, 255);
    stampDisc(hole, size, size, x, y, tw * 1.15, 255);
  }

  /* --- component footprints ------------------------------------------ */
  const comps = 13;
  for (let c = 0; c < comps; c++) {
    const cx = (Math.floor(rnd() * cells) + 0.5) * pitch;
    const cy = (Math.floor(rnd() * cells) + 0.5) * pitch;
    const roll = rnd();

    if (roll < 0.45) {
      // DIP package: black epoxy body, two pad rows, silkscreen outline
      const pins = 3 + ((rnd() * 4) | 0);
      const step = pitch * 0.42;
      const bw = step * 1.15;
      const bh = step * (pins - 1) * 0.5 + step * 0.5;
      stampRect(silk, size, size, cx, cy, bw * 1.5, bh * 1.12, 190);
      stampRect(silk, size, size, cx, cy, bw * 1.5 - 1.6, bh * 1.12 - 1.6, 0);
      stampRect(chip, size, size, cx, cy, bw, bh, 255);
      for (let p = 0; p < pins; p++) {
        const py = cy - bh + step * 0.5 + p * step;
        for (const sx of [-1, 1]) {
          stampRect(pad, size, size, cx + sx * bw * 1.45, py, tw * 1.9, tw * 1.0, 255);
          stampSegment(trace, size, size, cx + sx * bw, py, cx + sx * bw * 1.45, py, tw, 255);
        }
      }
    } else if (roll < 0.72) {
      // electrolytic can: silkscreen circle marker + two through-hole pads
      const r = pitch * 0.5;
      for (let a = 0; a < 24; a++) {
        const a0 = (a / 24) * Math.PI * 2;
        const a1 = ((a + 1) / 24) * Math.PI * 2;
        stampSegment(silk, size, size,
          cx + Math.cos(a0) * r, cy + Math.sin(a0) * r,
          cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 0.9, 190);
      }
      for (const sx of [-1, 1]) {
        stampDisc(pad, size, size, cx + sx * pitch * 0.22, cy, tw * 3.0, 255);
        stampDisc(hole, size, size, cx + sx * pitch * 0.22, cy, tw * 1.3, 255);
      }
    } else {
      // SMD chip resistor / capacitor: two rectangular pads and a body
      const w2 = pitch * 0.10;
      stampRect(pad, size, size, cx - pitch * 0.16, cy, w2, w2 * 1.5, 255);
      stampRect(pad, size, size, cx + pitch * 0.16, cy, w2, w2 * 1.5, 255);
      stampRect(chip, size, size, cx, cy, pitch * 0.15, w2 * 1.35, 255);
    }
  }

  return { trace, pad, hole, silk, chip };
}

function composeGlass(c) {
  const { size, seed, N, mottle, meso, micro, color, rough, metal, height } = c;
  const P = c.P;
  const base = P.base;

  // Dust film and finger smudges: without them a screen panel renders as a
  // perfect analytic plane and reads as a hole in the frame. Kept subtle —
  // the body has to stay a dark smoked panel, not a dirty window.
  const smudgeCut = coverageCut(meso, 0.16, 0.40);
  const dustCut = coverageCutFn(N, (i) => mottle[i] * 0.6 + micro[i] * 0.4, 0.09, 0.34);

  const rnd = mulberry32(hash2i(size, seed, 0x91a557));
  const scratch = new Float32Array(N);
  stampScratches(scratch, size, size, {
    rnd, count: Math.round(size * 0.10 * P.scratches) + 8, angle: 0.55, jitter: Math.PI,
    minLen: size * 0.02, maxLen: size * 0.17,
    halfWidth: 0.7, intensity: 0.45, wobble: size / 900,
  });

  for (let i = 0; i < N; i++) {
    const mi = micro[i];
    const sc = scratch[i];
    const smudge = smoothstep(smudgeCut.t0, smudgeCut.t1, meso[i]);
    const dust = smoothstep(dustCut.t0, dustCut.t1, mottle[i] * 0.6 + mi * 0.4);

    // Everything that touches float glass *adds* scatter; nothing darkens it.
    const lift = 1 + smudge * 0.14 + dust * 0.30 + sc * 0.9;
    const r = base[0] * lift;
    const g = base[1] * lift;
    const b = base[2] * lift;

    const ro = P.roughBase + (mi - 0.5) * 0.014 + smudge * 0.09 + dust * 0.21 + sc * 0.20;
    const hh = 0.5 + smudge * 0.003 + dust * 0.005 - sc * 0.012;

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;
    const rv = clamp(ro, 0.03, 1) * 255;
    rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    metal[o] = 0; metal[o + 1] = 0; metal[o + 2] = 0; metal[o + 3] = 255;
    height[i] = clamp01(hh);
  }
}

function composePlastic(c) {
  const { size, seed, N, mottle, meso, micro, color, rough, metal, height } = c;
  const P = c.P;
  const base = P.base;

  // Moulded pebble/leather grain — the defining read of a black ABS bezel.
  const GR = Math.min(size, 256);
  const wl = worleyLayer(GR, GR, { cells: 44, seed: seed * 53 + 7, jitter: 1.0 });
  const f1 = resampleWrap(wl.f1, GR, GR, size, size);
  const f2 = resampleWrap(wl.f2, GR, GR, size, size);
  const cid = resampleNearest(wl.id, GR, GR, size, size);

  const rnd = mulberry32(hash2i(size, seed, 0x4b2c19));
  const scuff = new Float32Array(N);
  stampScratches(scuff, size, size, {
    rnd, count: Math.round(size * 0.22 * P.scratches) + 14, angle: 0.3, jitter: Math.PI,
    minLen: size * 0.02, maxLen: size * 0.22,
    halfWidth: 0.85, intensity: 0.6, wobble: size / 520,
  });

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const mi = micro[i];
    const sc = scuff[i];

    const dome = 1 - smoothstep(0.10, 0.58, f1[i]);
    const valley = 1 - smoothstep(0.0, 0.07, f2[i] - f1[i]);
    const facet = 0.86 + cid[i] * 0.30;

    // Deep black plastic: the only luminance information is the grain
    // shading and the polished scuffs, so both are pushed hard.
    const shade = facet * (1 - valley * 0.42) * (0.94 + dome * 0.16) * (1 + (mi - 0.5) * 0.10);
    let r = base[0] * shade;
    let g = base[1] * shade;
    let b = base[2] * shade;
    // Rubbed edges polish up and pick up a light grey haze.
    r = lerp(r, 0.052, sc * 0.55);
    g = lerp(g, 0.053, sc * 0.55);
    b = lerp(b, 0.056, sc * 0.55);

    const ro = P.roughBase - dome * 0.07 + valley * 0.20
      + (me - 0.5) * 0.07 + (mi - 0.5) * 0.05 - sc * 0.16 + (mo - 0.5) * 0.04;
    const hh = 0.5 + dome * 0.022 - valley * 0.030 + (mi - 0.5) * 0.006 - sc * 0.006;

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;
    const rv = clamp(ro, 0.10, 1) * 255;
    rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    metal[o] = 0; metal[o + 1] = 0; metal[o + 2] = 0; metal[o + 3] = 255;
    height[i] = clamp01(hh);
  }
}

function composeRubber(c) {
  const { size, seed, N, mottle, meso, micro, color, rough, metal, height } = c;
  const P = c.P;
  const base = P.base;

  // Mould flow lines run around the casing; a fine granular carbon-black
  // surface sits on top of them.
  const GW = Math.max(32, size >> 3);
  const flow = resampleWrap(
    fbmLayer(GW, size, { freqX: 2, freqY: 9, octaves: 3, gain: 0.5, seed: seed * 61 + 13 }),
    GW, size, size, size,
  );
  const nickCut = coverageCutFn(N, (i) => micro[i] * 0.7 + meso[i] * 0.3, 0.035, 0.10);
  const bloomCut = coverageCut(mottle, 0.28, 0.45);

  const rnd = mulberry32(hash2i(size, seed, 0x77ba31));
  const scuff = new Float32Array(N);
  stampScratches(scuff, size, size, {
    rnd, count: Math.round(size * 0.18 * P.scratches) + 10, angle: 0.1, jitter: Math.PI,
    minLen: size * 0.03, maxLen: size * 0.26,
    halfWidth: 1.1, intensity: 0.5, wobble: size / 380,
  });

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const mi = micro[i];
    const fl = flow[i];
    const sc = scuff[i];

    const nick = smoothstep(nickCut.t0, nickCut.t1, mi * 0.7 + me * 0.3);
    // Antiozonant bloom: the grey-brown dusty film old rubber wears.
    const bloom = smoothstep(bloomCut.t0, bloomCut.t1, mo) * (0.35 + 0.65 * me);

    const shade = (0.90 + (mi - 0.5) * 0.30) * (1 + (fl - 0.5) * 0.12);
    let r = base[0] * shade;
    let g = base[1] * shade;
    let b = base[2] * shade;
    r = lerp(r, RUBBER_BLOOM[0], bloom * 0.30);
    g = lerp(g, RUBBER_BLOOM[1], bloom * 0.30);
    b = lerp(b, RUBBER_BLOOM[2], bloom * 0.30);
    // Scuffed rubber burnishes to a slight sheen and lightens a touch.
    r = lerp(r, 0.030, sc * 0.40);
    g = lerp(g, 0.030, sc * 0.40);
    b = lerp(b, 0.031, sc * 0.40);

    const ro = P.roughBase + (mi - 0.5) * 0.09 + (me - 0.5) * 0.05
      + bloom * 0.06 + nick * 0.05 - sc * 0.20;
    const hh = 0.5 + (mi - 0.5) * 0.020 + (fl - 0.5) * 0.014 - nick * 0.035 - sc * 0.004;

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;
    const rv = clamp(ro, 0.35, 1) * 255;
    rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    metal[o] = 0; metal[o + 1] = 0; metal[o + 2] = 0; metal[o + 3] = 255;
    height[i] = clamp01(hh);
  }
}

function composeWood(c) {
  const { size, seed, N, mottle, meso, micro, color, rough, metal, height } = c;
  const P = c.P;

  // Veneer: fast variation across the grain, slow along it, so the iso-lines
  // run as long streaks. The warped ridged layer supplies cathedral figure.
  const GW = Math.max(32, size >> 3);
  const MID = Math.min(size, 256);
  const grain = resampleWrap(
    fbmLayer(GW, size, { freqX: 3, freqY: 24, octaves: 4, gain: 0.55, seed: seed * 17 + 5 }),
    GW, size, size, size,
  );
  const bands = resampleWrap(
    fbmLayer(GW, size, { freqX: 2, freqY: 11, octaves: 3, gain: 0.5, ridged: true, seed: seed * 43 + 29, warp: 0.05, warpFreq: 3 }),
    GW, size, size, size,
  );
  const pores = resampleWrap(
    fbmLayer(MID, size, { freqX: 26, freqY: 90, octaves: 2, gain: 0.5, seed: seed * 71 + 37 }),
    MID, size, size, size,
  );
  const poreCut = coverageCut(pores, 0.10, 0.22);

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const gr = grain[i];
    const bd = bands[i];
    const pore = smoothstep(poreCut.t0, poreCut.t1, pores[i]) * (0.3 + 0.7 * bd);

    // Latewood is the dark line; earlywood the open tan field.
    const late = clamp01(bd * 0.75 + (gr - 0.5) * 0.85 + 0.14);
    let r = lerp(WOOD_PAL.early[0], WOOD_PAL.late[0], late);
    let g = lerp(WOOD_PAL.early[1], WOOD_PAL.late[1], late);
    let b = lerp(WOOD_PAL.early[2], WOOD_PAL.late[2], late);

    // Chatoyance: the flecked sheen that makes veneer read as veneer.
    const sheen = smoothstep(0.62, 0.95, gr) * (0.35 + 0.65 * mo);
    r = lerp(r, WOOD_PAL.sheen[0], sheen * 0.28);
    g = lerp(g, WOOD_PAL.sheen[1], sheen * 0.28);
    b = lerp(b, WOOD_PAL.sheen[2], sheen * 0.28);

    r = lerp(r, WOOD_PAL.pore[0], pore * 0.8);
    g = lerp(g, WOOD_PAL.pore[1], pore * 0.8);
    b = lerp(b, WOOD_PAL.pore[2], pore * 0.8);

    const tone = 0.94 + (mo - 0.5) * 0.18 + (me - 0.5) * 0.08;
    r *= tone; g *= tone; b *= tone;

    // Satin lacquer: fairly even, opening up slightly in the pores.
    const ro = P.roughBase + pore * 0.26 + late * 0.05 + (me - 0.5) * 0.06 - sheen * 0.05;
    const hh = 0.5 - pore * 0.035 - late * 0.008 + (gr - 0.5) * 0.006;

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;
    const rv = clamp(ro, 0.14, 1) * 255;
    rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    metal[o] = 0; metal[o + 1] = 0; metal[o + 2] = 0; metal[o + 3] = 255;
    height[i] = clamp01(hh);
  }
}

function composePCB(c) {
  const { size, seed, N, mottle, meso, micro, color, rough, metal, height } = c;
  const P = c.P;
  const art = pcbLayout(size, seed);
  // Copper pour: broad regions where the mask sits over a ground plane and
  // reads a shade warmer than bare laminate.
  const pourCut = coverageCut(mottle, 0.42, 0.10);

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const mi = micro[i];

    const trace = art.trace[i] / 255;
    const padM = art.pad[i] / 255;
    const holeM = art.hole[i] / 255;
    const silkM = art.silk[i] / 255;
    const chipM = art.chip[i] / 255;
    const pour = smoothstep(pourCut.t0, pourCut.t1, mo);

    // 1. solder mask over laminate, tinted by whatever copper is under it
    const weave = 0.94 + (mi - 0.5) * 0.14 + (me - 0.5) * 0.06;
    let r = lerp(PCB_PAL.mask[0], PCB_PAL.overCopper[0], pour * 0.75) * weave;
    let g = lerp(PCB_PAL.mask[1], PCB_PAL.overCopper[1], pour * 0.75) * weave;
    let b = lerp(PCB_PAL.mask[2], PCB_PAL.overCopper[2], pour * 0.75) * weave;
    let ro = P.roughBase + (mi - 0.5) * 0.10 + pour * 0.02;
    let mt = 0;
    let hh = 0.5 + (mi - 0.5) * 0.004;

    // 2. routed traces: raised ridges, mask stretched thin over the copper
    if (trace > 0.01) {
      r = lerp(r, PCB_PAL.maskHi[0], trace * 0.85);
      g = lerp(g, PCB_PAL.maskHi[1], trace * 0.85);
      b = lerp(b, PCB_PAL.maskHi[2], trace * 0.85);
      ro = lerp(ro, 0.26, trace * 0.7);
      hh += trace * 0.020;
    }

    // 3. epoxy component bodies
    if (chipM > 0.01) {
      r = lerp(r, PCB_PAL.epoxy[0], chipM);
      g = lerp(g, PCB_PAL.epoxy[1], chipM);
      b = lerp(b, PCB_PAL.epoxy[2], chipM);
      ro = lerp(ro, 0.42 + (mi - 0.5) * 0.08, chipM);
      hh += chipM * 0.055;
    }

    // 4. silkscreen legend (matte white ink, barely any relief)
    if (silkM > 0.01) {
      r = lerp(r, PCB_PAL.silk[0], silkM * 0.9);
      g = lerp(g, PCB_PAL.silk[1], silkM * 0.9);
      b = lerp(b, PCB_PAL.silk[2], silkM * 0.9);
      ro = lerp(ro, 0.72, silkM * 0.9);
      hh += silkM * 0.003;
    }

    // 5. tinned pads: the one genuinely metallic thing on the board
    if (padM > 0.01) {
      const dome = padM * (0.85 + 0.3 * me);
      r = lerp(r, PCB_PAL.solder[0], padM);
      g = lerp(g, PCB_PAL.solder[1], padM);
      b = lerp(b, PCB_PAL.solder[2], padM);
      ro = lerp(ro, 0.24 + (mi - 0.5) * 0.12, padM);
      mt = padM;
      hh += dome * 0.026;
    }

    // 6. drill holes punch straight back through everything
    if (holeM > 0.01) {
      r = lerp(r, PCB_PAL.hole[0], holeM);
      g = lerp(g, PCB_PAL.hole[1], holeM);
      b = lerp(b, PCB_PAL.hole[2], holeM);
      ro = lerp(ro, 0.85, holeM);
      mt *= 1 - holeM;
      hh -= holeM * 0.075;
    }

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;
    const rv = clamp(ro, 0.10, 1) * 255;
    rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    const mv = clamp01(mt) * 255;
    metal[o] = mv; metal[o + 1] = mv; metal[o + 2] = mv; metal[o + 3] = 255;
    height[i] = clamp01(hh);
  }
}

function composeCeramic(c) {
  const { size, seed, N, mottle, meso, micro, color, rough, metal, height } = c;
  const P = c.P;
  const base = P.base;

  // Sintered ferrite: closed porosity everywhere, plus the chipped corners
  // every ceramic magnet in a scrapyard has, showing lighter fresh fracture.
  // The chip field is meso/micro driven so the breaks stay small and angular
  // rather than spreading into soft continental blobs.
  const poreCut = coverageCutFn(N, (i) => micro[i] * 0.75 + meso[i] * 0.25, 0.16, 0.16);
  const chipCut = coverageCutFn(N, (i) => meso[i] * 0.55 + micro[i] * 0.45, 0.06, 0.04);

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const mi = micro[i];
    const pore = smoothstep(poreCut.t0, poreCut.t1, mi * 0.75 + me * 0.25);
    const chip = smoothstep(chipCut.t0, chipCut.t1, me * 0.55 + mi * 0.45)
      * (0.45 + 0.55 * smoothstep(0.35, 0.75, mo));

    const shade = (0.88 + (mi - 0.5) * 0.34) * (1 - pore * 0.45);
    let r = base[0] * shade;
    let g = base[1] * shade;
    let b = base[2] * shade;
    // Fresh fracture is a much lighter, chalkier grey than the fired skin.
    r = lerp(r, FERRITE_FRESH[0] * 0.55, chip * 0.75);
    g = lerp(g, FERRITE_FRESH[1] * 0.55, chip * 0.75);
    b = lerp(b, FERRITE_FRESH[2] * 0.55, chip * 0.75);

    const ro = P.roughBase + pore * 0.28 + chip * 0.16 + (me - 0.5) * 0.07;
    const hh = 0.5 - pore * 0.030 + chip * 0.014 + (mi - 0.5) * 0.008;

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;
    const rv = clamp(ro, 0.20, 1) * 255;
    rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    metal[o] = 0; metal[o + 1] = 0; metal[o + 2] = 0; metal[o + 3] = 255;
    height[i] = clamp01(hh);
  }
}

function buildSurfaceMaps(preset, cfg) {
  const P = DIELECTRIC_PRESETS[preset];
  const size = cfg.size;
  const seed = cfg.seed;
  const N = size * size;

  const LO = Math.min(size, 128);
  const MID = Math.min(size, 256);
  const HI = Math.min(size, P.microRes);

  const mottle = resampleWrap(
    fbmLayer(LO, LO, { freqX: 3, freqY: 3, octaves: 4, seed: seed * 3 + 11, warp: 0.08, warpFreq: 2 }),
    LO, LO, size, size,
  );
  const meso = resampleWrap(
    fbmLayer(MID, MID, { freqX: 12, freqY: 12, octaves: 4, seed: seed * 7 + 23 }),
    MID, MID, size, size,
  );
  const micro = resampleWrap(
    fbmLayer(HI, HI, { freqX: 44, freqY: 44, octaves: 3, gain: 0.55, seed: seed * 13 + 41 }),
    HI, HI, size, size,
  );

  const ctx = {
    P, size, seed, N, mottle, meso, micro,
    color: new Uint8ClampedArray(N * 4),
    rough: new Uint8ClampedArray(N * 4),
    metal: new Uint8ClampedArray(N * 4),
    height: new Float32Array(N),
  };

  switch (P.kind) {
    case 'plastic': composePlastic(ctx); break;
    case 'rubber': composeRubber(ctx); break;
    case 'wood': composeWood(ctx); break;
    case 'pcb': composePCB(ctx); break;
    case 'ceramic': composeCeramic(ctx); break;
    default: composeGlass(ctx); break;
  }

  const normal = heightToNormalData(ctx.height, size, size, P.normalStrength);
  const aoF = heightToAO(ctx.height, size, size, P.aoStrength);
  const ao = grayToRGBA(aoF, N);

  return { color: ctx.color, normal, rough: ctx.rough, metal: ctx.metal, ao };
}

/* ------------------------------------------------------------------ *
 * Floor generation
 * ------------------------------------------------------------------ */

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Tileable diamond-plate tread: two opposed capsule lugs per cell. */
function diamondPlateField(size, cells) {
  const out = new Float32Array(size * size);
  const cw = size / cells;
  const halfLen = cw * 0.31;
  const halfW = cw * 0.085;
  const inner = halfW * 0.34;

  const lx = [0.26, 0.74];
  const ly = [0.26, 0.74];
  const ang = [Math.PI * 0.25, -Math.PI * 0.25];

  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / cw);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cw);
      let best = Infinity;

      for (let dy = -1; dy <= 1; dy++) {
        const oy = (cy + dy) * cw;
        for (let dx = -1; dx <= 1; dx++) {
          const ox = (cx + dx) * cw;
          for (let l = 0; l < 2; l++) {
            const mxp = ox + lx[l] * cw;
            const myp = oy + ly[l] * cw;
            const ca = Math.cos(ang[l]) * halfLen;
            const sa = Math.sin(ang[l]) * halfLen;
            const d = distToSegment(x, y, mxp - ca, myp - sa, mxp + ca, myp + sa);
            if (d < best) best = d;
          }
        }
      }

      // Beveled, domed lug profile.
      const t = smoothstep(halfW, inner, best);
      out[row + x] = Math.pow(t, 0.62);
    }
  }
  return out;
}

function buildFloorMaps(cfg) {
  const size = cfg.size;
  const seed = cfg.seed;
  const grime = cfg.grime;
  const oil = cfg.oil;
  const wear = cfg.wear;
  const N = size * size;

  const isPlate = cfg.style === 'diamondPlate';

  const LO = Math.max(64, size >> 2);
  const MID = Math.max(128, size >> 1);

  // Broad tonal drift of the slab pour. Deliberately shallow: concrete
  // varies by a few percent of reflectance, not by a full stop.
  const mottle = resampleWrap(
    fbmLayer(LO, LO, { freqX: 3, freqY: 3, octaves: 5, seed: seed * 5 + 3, warp: 0.10, warpFreq: 2 }),
    LO, LO, size, size,
  );
  const meso = resampleWrap(
    fbmLayer(MID, MID, { freqX: 14, freqY: 14, octaves: 4, seed: seed * 11 + 7 }),
    MID, MID, size, size,
  );
  // Sand / cement grit, evaluated at full resolution so the speckle is
  // genuinely pixel-scale rather than an upsampled blur.
  const micro = isPlate
    ? resampleWrap(
      fbmLayer(MID, MID, { freqX: 56, freqY: 56, octaves: 3, gain: 0.55, seed: seed * 19 + 13 }),
      MID, MID, size, size,
    )
    : fbmLayer(size, size, { freqX: Math.max(64, size >> 2), freqY: Math.max(64, size >> 2), octaves: 2, gain: 0.5, seed: seed * 19 + 13 });
  const stain = resampleWrap(
    fbmLayer(MID, MID, { freqX: 13, freqY: 12, octaves: 4, seed: seed * 23 + 31, warp: 0.12, warpFreq: 6 }),
    MID, MID, size, size,
  );
  // Fine hairline cracking: few octaves so the ridges stay as clean lines
  // instead of degenerating into a speckled network.
  const cracks = isPlate ? null : resampleWrap(
    fbmLayer(MID, MID, { freqX: 7, freqY: 7, octaves: 3, gain: 0.5, ridged: true, seed: seed * 29 + 17, warp: 0.05, warpFreq: 4 }),
    MID, MID, size, size,
  );

  let aggF1 = null;
  let aggId = null;
  let pitF1 = null;
  if (!isPlate) {
    // Exposed aggregate: high-frequency cellular speckle.
    const agg = worleyLayer(MID, MID, { cells: Math.max(48, MID >> 2), seed: seed * 37 + 5, jitter: 1.0 });
    aggF1 = resampleWrap(agg.f1, MID, MID, size, size);
    aggId = resampleNearest(agg.id, MID, MID, size, size);
    // A separate, much sparser cell layer supplies the handful of pits.
    const pit = worleyLayer(LO, LO, { cells: 13, seed: seed * 43 + 29, jitter: 1.0 });
    pitF1 = resampleWrap(pit.f1, LO, LO, size, size);
  }

  const plate = isPlate ? diamondPlateField(size, cfg.cells) : null;

  // Percentile cutoffs so grime / oil / wear read as real surface fractions.
  // Concrete oil is sparse and soft-edged (wide ramp); on steel plate it can
  // spread further because the deck is where everything gets dragged.
  const oilAt = isPlate
    ? (i) => (stain[i] * 0.55 + mottle[i] * 0.45) * (0.55 + 0.45 * smoothstep(0.3, 0.8, meso[i]))
    : (i) => stain[i] * 0.62 + meso[i] * 0.38;
  const oilCut = coverageCutFn(N, oilAt, oil * (isPlate ? 0.42 : 0.22), isPlate ? 0.14 : 0.30);
  const dustCut = coverageCut(stain, grime * (isPlate ? 0.75 : 0.45), 0.28);
  const crackCut = isPlate ? null : coverageCut(cracks, 0.020, 0.035);
  const pitCut = isPlate ? null : coverageCutFn(N, (i) => 1 - pitF1[i], 0.012, 0.05);
  const plateRustCut = isPlate
    ? coverageCutFn(N, (i) => stain[i] * 0.7 + meso[i] * 0.3, 0.10 + 0.40 * grime, 0.14)
    : null;

  const rnd = mulberry32(hash2i(size, seed, 0x10ade5));
  const scuff = new Float32Array(N);
  stampScratches(scuff, size, size, {
    rnd, count: Math.round(size * 0.55 * wear) + 30, angle: 0.2, jitter: Math.PI,
    minLen: size * 0.03, maxLen: size * 0.30,
    halfWidth: 1.0, intensity: 0.55, wobble: size / 300,
  });

  const color = new Uint8ClampedArray(N * 4);
  const rough = new Uint8ClampedArray(N * 4);
  const metal = new Uint8ClampedArray(N * 4);
  const height = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const mo = mottle[i];
    const me = meso[i];
    const mi = micro[i];
    const st = stain[i];
    const sc = scuff[i];

    let r;
    let g;
    let b;
    let ro;
    let mt;
    let hh;

    if (isPlate) {
      const lug = plate[i];
      // Worn steel plate: lug tops polished, valleys dark and grimy.
      const baseShade = 0.90 + 0.20 * mo + (mi - 0.5) * 0.07;
      r = PLATE_BASE[0] * baseShade;
      g = PLATE_BASE[1] * baseShade;
      b = PLATE_BASE[2] * baseShade;

      const polish = lug * wear * (0.55 + 0.45 * me);
      r = lerp(r, PLATE_POLISH[0], polish * 0.55);
      g = lerp(g, PLATE_POLISH[1], polish * 0.55);
      b = lerp(b, PLATE_POLISH[2], polish * 0.55);

      ro = 0.42 + (mo - 0.5) * 0.10 + (me - 0.5) * 0.06 + (mi - 0.5) * 0.05 - polish * 0.18;
      mt = 0.985 - (mi - 0.5) * 0.03;
      // Lug relief is genuine 3-4 mm tread and stays at full amplitude;
      // only the surface detail riding on top of it is halved.
      hh = 0.34 + lug * 0.62 + (mo - 0.5) * 0.015 + (mi - 0.5) * 0.010;

      // Rust creeps into the valleys between lugs.
      const rustCore = clamp01(smoothstep(plateRustCut.t0, plateRustCut.t1, st * 0.7 + me * 0.3) * (1 - lug * 0.85));
      const rustHalo = clamp01(
        smoothstep(plateRustCut.t0 - plateRustCut.band * 3.0, plateRustCut.t0 + plateRustCut.band * 0.6, st * 0.7 + me * 0.3)
        * (1 - lug * 0.85),
      );
      const rustStain = clamp01(rustCore * 0.75 + rustHalo * 0.25);
      if (rustStain > 0.002) {
        const core = rustCore * smoothstep(0.55, 0.9, 1 - mi);
        const tint = rustStain * 0.66;
        r = lerp(r, lerp(RUST_PAL.light[0], RUST_PAL.dark[0], core), tint);
        g = lerp(g, lerp(RUST_PAL.light[1], RUST_PAL.dark[1], core), tint);
        b = lerp(b, lerp(RUST_PAL.light[2], RUST_PAL.dark[2], core), tint);
        ro = lerp(ro, 0.93, rustStain);
        mt = lerp(mt, 0.05, clamp01(rustCore * 0.88 + rustHalo * 0.12));
        hh -= core * 0.025;
      }

      // Ground-in grime packed around the lug bases.
      const dirt = clamp01((1 - lug) * grime * (0.06 + 0.94 * smoothstep(0.30, 0.85, me)));
      r = lerp(r, GRIME_COL[0], dirt * 0.7);
      g = lerp(g, GRIME_COL[1], dirt * 0.7);
      b = lerp(b, GRIME_COL[2], dirt * 0.7);
      ro = lerp(ro, 0.92, dirt * 0.8);
      mt = lerp(mt, 0.08, dirt * 0.6);
    } else {
      /* --- poured industrial concrete -----------------------------------
       * Built as a single narrow-band grey tone in linear light:
       *   shallow low-frequency drift  (the pour)
       * + high-frequency aggregate speckle and sand grit
       * + hairline cracks, a few pits, soft dust
       * Everything darkening the slab does so multiplicatively, so nothing
       * bottoms out on the 0.16 clamp and flattens into a blob.           */
      const aggregate = smoothstep(0.62, 0.18, aggF1[i]);
      const grit = (mi - 0.5) * 2;                       // +/-1 pixel-scale grit
      const drift = (mo - 0.5) * 0.050 + (me - 0.5) * 0.026;

      let tone = CONCRETE_TONE + drift + grit * 0.034;
      // Individual stones read slightly darker/cooler than the cement matrix.
      tone = lerp(tone, CONCRETE_TONE * (0.74 + aggId[i] * 0.48), aggregate * 0.70);

      let warm = 1.0;                                    // r/b chroma ratio

      // Hairline cracks: thin, dark, barely any relief.
      const crack = smoothstep(crackCut.t0, crackCut.t1, cracks[i]);
      tone *= 1 - crack * 0.32;

      // A few small pits / pop-outs.
      const pit = smoothstep(pitCut.t0, pitCut.t1, 1 - pitF1[i]);
      tone *= 1 - pit * 0.26;

      // Dry dust film: lifts the tone very slightly and kills the gloss.
      const dust = smoothstep(dustCut.t0, dustCut.t1, st);
      tone = lerp(tone, CONCRETE_DUST, dust * 0.40);
      warm += dust * 0.03;

      r = tone * warm;
      g = tone;
      b = tone * (1 - (warm - 1) * 0.9);

      ro = 0.925 + (mo - 0.5) * 0.040 + (me - 0.5) * 0.028 + grit * 0.024
        - aggregate * 0.035 + crack * 0.018 + dust * 0.020;
      mt = 0.0;
      hh = 0.5 + (mo - 0.5) * 0.018 + (me - 0.5) * 0.013 + grit * 0.012
        + aggregate * 0.022 - crack * 0.055 - pit * 0.050;
    }

    /* --- oil: dark, soft-edged stain; only mildly slicker than the slab --- */
    const oilM = smoothstep(oilCut.t0, oilCut.t1, oilAt(i));
    if (oilM > 0.002) {
      const sheen = smoothstep(0.45, 0.9, mi) * 0.35;
      if (isPlate) {
        const amt = oilM * 0.85;
        r = lerp(r, OIL_PLATE[0] * (1 + sheen * 0.5), amt);
        g = lerp(g, OIL_PLATE[1] * (1 + sheen * 0.5), amt);
        b = lerp(b, OIL_PLATE[2] * (1 + sheen * 0.5), amt);
        ro = lerp(ro, 0.26 + sheen * 0.12, oilM * 0.9);
        mt = lerp(mt, 0.18, oilM * 0.5);
      } else {
        // Soaked-in oil: a multiplicative darkening that keeps all of the
        // aggregate and grit detail visible through the stain, and stays matte.
        const dark = 1 - oilM * (0.30 - sheen * 0.06);
        r *= dark * 1.02;
        g *= dark;
        b *= dark * 0.97;
        ro = lerp(ro, 0.74 + sheen * 0.08, oilM * 0.5);
      }
      hh += oilM * 0.002;
    }

    /* --- drag scuffs from decades of scrap being hauled across --- */
    if (sc > 0.001) {
      const scc = isPlate ? SCUFF_PLATE : SCUFF_CONCRETE;
      const amt = sc * (isPlate ? 0.30 : 0.16) * wear;
      r = lerp(r, scc[0], amt);
      g = lerp(g, scc[1], amt);
      b = lerp(b, scc[2], amt);
      ro -= sc * (isPlate ? 0.14 : 0.05);
      hh -= sc * 0.010;
    }

    if (!isPlate) {
      r = clamp(r, CONCRETE_MIN, CONCRETE_MAX);
      g = clamp(g, CONCRETE_MIN, CONCRETE_MAX);
      b = clamp(b, CONCRETE_MIN, CONCRETE_MAX);
      ro = clamp(ro, 0.85, 0.97);
      mt = 0;
    }

    const o = i * 4;
    color[o] = encodeSRGB(r);
    color[o + 1] = encodeSRGB(g);
    color[o + 2] = encodeSRGB(b);
    color[o + 3] = 255;

    const rv = clamp(ro, 0.05, 1) * 255;
    rough[o] = rv;
    rough[o + 1] = rv;
    rough[o + 2] = rv;
    rough[o + 3] = 255;

    const mv = clamp01(mt) * 255;
    metal[o] = mv;
    metal[o + 1] = mv;
    metal[o + 2] = mv;
    metal[o + 3] = 255;

    height[i] = clamp01(hh);
  }

  // Tread lugs are macro UV features, so their per-pixel gradient shrinks as
  // resolution grows — scale the Sobel strength to keep the bevel constant.
  // The lugs are real 3-4 mm relief and keep their full amplitude; concrete
  // detail is pixel-scale grit and is baked at half the old amplitude, so its
  // Sobel strength is raised only enough to keep the AO cavity readable.
  const normalStrength = isPlate ? 5.0 * (size / 512) : 3.0;
  const normal = heightToNormalData(height, size, size, normalStrength);
  const aoF = heightToAO(height, size, size, isPlate ? 0.5 : 1.7);
  const ao = grayToRGBA(aoF, N);

  return { color, normal, rough, metal, ao };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Build a cached, seamlessly tiling PBR texture set for a surface preset.
 *
 * Sets are memoised on `preset + JSON.stringify(options)`, so calling this
 * repeatedly (per shred fragment, per frame, ...) never re-allocates GPU
 * memory. Calling `dispose()` on the returned set frees the textures and
 * evicts the cache entry.
 *
 * Metal presets run the corrosion/paint/spangle pipeline; the dielectric
 * presets (`glass`, `abs`, `rubber`, `mdf`, `pcb`, `ferrite`) run their own
 * composition pass and return a flat-zero metalness map — except `pcb`,
 * whose tinned pads are genuinely metallic.
 *
 * @param {'steel'|'aluminum'|'castIron'|'galvanized'|'copper'|'paintedSteel'|'rustedSteel'|'alloy'|'applianceSteel'|'glass'|'abs'|'rubber'|'mdf'|'pcb'|'ferrite'} preset
 * @param {object} [options]
 * @param {number} [options.size=1024] Square texture resolution.
 * @param {number} [options.seed=1] PRNG seed; changes every feature layout.
 * @param {number[]} [options.repeat=[1,1]] UV repeat applied to every map.
 * @param {number} [options.rust] Rust coverage 0..1 (defaults per preset).
 * @param {number} [options.scratches] Scratch density 0..1 (defaults per preset).
 * @param {boolean} [options.anisotropic=true] Directional brushed grain + parallel scratches.
 * @param {'yellow'|'grey'|'orange'|'green'|'blue'|'white'} [options.paintColor] Painted presets only.
 * @param {number} [options.paintCoverage] Remaining paint fraction, painted presets only.
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture, metalnessMap: THREE.CanvasTexture, aoMap: THREE.CanvasTexture, dispose: () => void}}
 */
export function createMetalTextureSet(preset, options = {}) {
  const key = preset + JSON.stringify(options);
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = options.size !== undefined ? options.size : 1024;
  const seed = options.seed !== undefined ? options.seed : 1;
  const repeat = options.repeat !== undefined ? options.repeat : [1, 1];

  if (DIELECTRIC_PRESETS[preset]) {
    const parts = buildSurfaceMaps(preset, { size, seed, repeat });
    return cacheSet(key, makeSet(parts, repeat, size));
  }

  const P = PRESETS[preset] || PRESETS.steel;
  const cfg = {
    size,
    seed,
    repeat,
    rust: clamp01(options.rust !== undefined ? options.rust : P.rust),
    scratches: clamp01(options.scratches !== undefined ? options.scratches : P.scratches),
    anisotropic: options.anisotropic !== undefined ? options.anisotropic : true,
    paintColor: options.paintColor !== undefined
      ? options.paintColor
      : (P.paint && P.paint.color ? P.paint.color : 'yellow'),
    paintCoverage: options.paintCoverage !== undefined
      ? options.paintCoverage
      : (P.paint ? P.paint.coverage : 0),
  };

  const parts = buildMetalMaps(PRESETS[preset] ? preset : 'steel', cfg);
  return cacheSet(key, makeSet(parts, cfg.repeat, cfg.size));
}

/**
 * Standalone brushed-metal anisotropic normal map, derived by Sobel from a
 * real height field of parallel micro-grooves plus a few deeper gouges.
 *
 * @param {number} [size=512] Square resolution.
 * @param {number} [seed=1] PRNG seed.
 * @param {number} [density=1] Scratch density multiplier (roughly 0..2).
 * @returns {THREE.CanvasTexture} Tangent-space normal map, NoColorSpace.
 */
export function createScratchNormalMap(size = 512, seed = 1, density = 1) {
  const key = 'scratchNormal:' + size + ':' + seed + ':' + density;
  const cached = textureCache.get(key);
  if (cached) return cached;

  const N = size * size;
  const GW = Math.max(32, size >> 3);
  const MID = Math.max(128, size >> 1);

  const grain = resampleWrap(
    fbmLayer(GW, size, { freqX: 3, freqY: Math.max(12, Math.min(40, size >> 4)), octaves: 3, gain: 0.55, seed: seed * 17 + 5 }),
    GW, size, size, size,
  );
  const micro = resampleWrap(
    fbmLayer(MID, MID, { freqX: 40, freqY: 40, octaves: 2, gain: 0.55, seed: seed * 13 + 41 }),
    MID, MID, size, size,
  );
  const { scratch, gouge } = buildScratchFields(size, seed, clamp01(density * 0.6), true);

  const height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    height[i] = clamp01(
      0.5 + (grain[i] - 0.5) * 0.15 * density + (micro[i] - 0.5) * 0.03
      - scratch[i] * 0.15 * density - gouge[i] * 0.275,
    );
  }

  const data = heightToNormalData(height, size, size, 3.0);
  const tex = dataToTexture(data, size, size, false, [1, 1]);
  textureCache.set(key, tex);
  return tex;
}

/**
 * Grimy industrial factory-floor PBR set (same return shape as the metal sets).
 *
 * @param {object} [options]
 * @param {'concrete'|'diamondPlate'} [options.style='concrete'] Surface type.
 * @param {number} [options.size=1024] Square texture resolution.
 * @param {number} [options.seed=7] PRNG seed.
 * @param {number[]} [options.repeat=[1,1]] UV repeat applied to every map.
 * @param {number} [options.grime=0.6] Ground-in dirt amount 0..1.
 * @param {number} [options.oil=0.5] Oil-stain coverage 0..1.
 * @param {number} [options.wear=0.5] Polish / drag-scuff amount 0..1.
 * @param {number} [options.cells=4] Diamond-plate tread cells per tile.
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture, metalnessMap: THREE.CanvasTexture, aoMap: THREE.CanvasTexture, dispose: () => void}}
 */
export function createFloorTextureSet(options = {}) {
  const key = 'floor:' + JSON.stringify(options);
  const cached = textureCache.get(key);
  if (cached) return cached;

  const cfg = {
    style: options.style === 'diamondPlate' ? 'diamondPlate' : 'concrete',
    size: options.size !== undefined ? options.size : 1024,
    seed: options.seed !== undefined ? options.seed : 7,
    repeat: options.repeat !== undefined ? options.repeat : [1, 1],
    grime: clamp01(options.grime !== undefined ? options.grime : 0.6),
    oil: clamp01(options.oil !== undefined ? options.oil : 0.5),
    wear: clamp01(options.wear !== undefined ? options.wear : 0.5),
    cells: options.cells !== undefined ? options.cells : 4,
  };

  const parts = buildFloorMaps(cfg);
  return cacheSet(key, makeSet(parts, cfg.repeat, cfg.size));
}

/**
 * RGBA blue-noise-ish texture for dithering, TAA/SSAO jitter and particle
 * randomisation. Each channel is high-pass filtered white noise, then
 * rank-remapped back to a uniform distribution — cheap void-and-cluster
 * approximation with a well-behaved high-frequency spectrum.
 *
 * @param {number} [size=128] Square resolution (keep small; sampled unfiltered).
 * @param {number} [seed=1] PRNG seed.
 * @returns {THREE.CanvasTexture} NoColorSpace, RepeatWrapping, NearestFilter.
 */
export function createNoiseTexture(size = 128, seed = 1) {
  const key = 'noise:' + size + ':' + seed;
  const cached = textureCache.get(key);
  if (cached) return cached;

  const N = size * size;
  const data = new Uint8ClampedArray(N * 4);
  const order = new Uint32Array(N);

  for (let ch = 0; ch < 4; ch++) {
    const rnd = mulberry32(hash2i(seed, ch * 977 + 13, 0x51ed3a7));
    let buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = rnd();

    for (let pass = 0; pass < 3; pass++) {
      // High-pass: strip the low frequencies, then rank-remap back to uniform.
      const lp = boxBlurWrap(buf, size, size, pass === 0 ? 2 : 1);
      for (let i = 0; i < N; i++) buf[i] -= lp[i];

      for (let i = 0; i < N; i++) order[i] = i;
      const ref = buf;
      const arr = Array.from(order);
      arr.sort((a, c) => ref[a] - ref[c]);
      const next = new Float32Array(N);
      const invN = 1 / (N - 1);
      for (let i = 0; i < N; i++) next[arr[i]] = i * invN;
      buf = next;
    }

    for (let i = 0; i < N; i++) data[i * 4 + ch] = buf[i] * 255;
  }

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(size, size);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  textureCache.set(key, tex);
  return tex;
}

/**
 * Luminance statistics of a generated CanvasTexture, for render-pipeline
 * assertions and visual QA (e.g. "the metalness map of `steel` must have a
 * mean above 0.85").
 *
 * Values are reported in 0..1 over the texture's *stored* encoding: for the
 * linear data maps (roughness / metalness / AO) that is the PBR value
 * itself; for the sRGB albedo pass `{ linear: true }` to decode first.
 *
 * @param {THREE.CanvasTexture} tex Any texture produced by this module.
 * @param {object} [options]
 * @param {boolean} [options.linear=false] Decode sRGB before measuring.
 * @returns {{mean: number, min: number, max: number, stdDev: number}}
 */
export function textureStats(tex, options = {}) {
  const img = tex && tex.image;
  if (!img) return { mean: 0, min: 0, max: 0, stdDev: 0 };

  const w = img.width | 0;
  const h = img.height | 0;
  const ctx = img.getContext ? img.getContext('2d', { willReadFrequently: true }) : null;
  if (!ctx || !w || !h) return { mean: 0, min: 0, max: 0, stdDev: 0 };

  const data = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const decode = options.linear ? srgbToLinear : (v) => v;

  let sum = 0;
  let sum2 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = 0.2126 * decode(data[o] / 255)
      + 0.7152 * decode(data[o + 1] / 255)
      + 0.0722 * decode(data[o + 2] / 255);
    sum += v;
    sum2 += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  return { mean, min, max, stdDev: Math.sqrt(variance > 0 ? variance : 0) };
}

/**
 * Dispose every cached texture / texture set and empty the cache.
 * Call on scene teardown or when hot-swapping texture resolutions.
 */
export function clearTextureCache() {
  const entries = Array.from(textureCache.values());
  textureCache.clear();
  for (const entry of entries) {
    if (entry && typeof entry.dispose === 'function') entry.dispose();
  }
}
