/**
 * Trauma-based screen shake.
 *
 * Implements the classic game-feel model (Squirrel Eiserloh, "Math for Game
 * Programmers: Juicing Your Cameras With Math"): a single scalar `trauma`
 * decays linearly over time and the actual shake amplitude is `trauma²`, so
 * small residual trauma produces almost no motion while big impulses hit hard.
 *
 * The offset is sampled from layered value-noise (smoothly interpolated pseudo
 * random gradients) rather than raw random values, so the motion is continuous
 * and organic instead of buzzy per-frame jitter. It is produced as a *pure
 * offset* every frame and re-applied on top of the orbit solution, so it never
 * accumulates drift and never fights the OrbitControls maths.
 *
 * Two trauma channels are mixed:
 *  - impulse trauma  — decays quickly, used for discrete shears / hard hits.
 *  - rumble trauma   — a sustained target driven by continuous motor load.
 */

const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

/** Deterministic 1-D value noise in [-1, 1] built from a fixed permutation. */
function makeNoise(seed) {
  const size = 256;
  const table = new Float32Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // xorshift for a stable, well-distributed gradient table.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    table[i] = (s / 0xffffffff) * 2 - 1;
  }
  const fade = (t) => t * t * (3 - 2 * t); // smoothstep
  return (x) => {
    const xi = Math.floor(x);
    const xf = x - xi;
    const a = table[xi & (size - 1)];
    const b = table[(xi + 1) & (size - 1)];
    return a + (b - a) * fade(xf);
  };
}

export class ScreenShake {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPosition] Peak positional offset in metres.
   * @param {number} [opts.maxRotation] Peak rotational offset in radians.
   * @param {number} [opts.frequency]   Noise sampling frequency (Hz).
   * @param {number} [opts.decay]       Impulse trauma decay per second.
   */
  constructor({ maxPosition = 0.055, maxRotation = 0.028, frequency = 22, decay = 1.35 } = {}) {
    this.maxPosition = maxPosition;
    this.maxRotation = maxRotation;
    this.frequency = frequency;
    this.decay = decay;

    /** Discrete-impulse trauma (0..1), decays on its own. */
    this.impulse = 0;
    /** Continuous load-driven rumble target (0..1). */
    this.rumbleTarget = 0;
    this._rumble = 0;

    this._t = 0;
    // Six decorrelated noise channels: 3 position + 3 rotation.
    this._noise = [];
    for (let i = 0; i < 6; i++) this._noise.push(makeNoise(0x1234567 + i * 977));

    /** Latest offset, reused every frame (no per-frame allocation). */
    this.offsetPos = { x: 0, y: 0, z: 0 };
    this.offsetRot = { x: 0, y: 0, z: 0 };
  }

  get reducedMotion() {
    return !!(REDUCED_MOTION && REDUCED_MOTION.matches);
  }

  /**
   * Add a discrete impulse of trauma (e.g. a big shear). Strength is additive
   * and clamped; duration is folded into an effective magnitude so short, sharp
   * impulses still register.
   * @param {number} strength 0..1-ish
   * @param {number} [duration] seconds — longer taps land a little more trauma.
   */
  addImpulse(strength, duration = 0.25) {
    const mag = strength * (0.6 + Math.min(1, duration) * 0.8);
    this.impulse = Math.min(1, this.impulse + mag);
  }

  /**
   * Set the sustained rumble level from continuous motor load.
   * @param {number} load01 0..1
   * @param {boolean} [stalled] Stalls kick the rumble much harder.
   */
  setRumble(load01, stalled = false) {
    const base = Math.max(0, Math.min(1, load01));
    this.rumbleTarget = stalled ? Math.min(1, 0.55 + base * 0.6) : base * 0.42;
  }

  /**
   * Advance trauma + resample noise. Fills {@link offsetPos}/{@link offsetRot}.
   * @param {number} dt seconds
   */
  update(dt) {
    // Impulse trauma decays linearly; rumble eases toward its target.
    this.impulse = Math.max(0, this.impulse - this.decay * dt);
    this._rumble += (this.rumbleTarget - this._rumble) * Math.min(1, dt * 6);

    // Combine channels: rumble contributes a gentle constant floor, impulse the
    // punch. Both go through the trauma² curve.
    const trauma = Math.min(1, this.impulse + this._rumble * 0.75);
    const amount = trauma * trauma;

    if (amount < 1e-4 || this.reducedMotion) {
      this.offsetPos.x = this.offsetPos.y = this.offsetPos.z = 0;
      this.offsetRot.x = this.offsetRot.y = this.offsetRot.z = 0;
      return;
    }

    this._t += dt * this.frequency;
    const t = this._t;
    const p = this.maxPosition * amount;
    const r = this.maxRotation * amount;

    // Each channel sampled at a different phase so axes never lock in sync.
    this.offsetPos.x = this._noise[0](t) * p;
    this.offsetPos.y = this._noise[1](t + 11.3) * p;
    this.offsetPos.z = this._noise[2](t + 23.7) * p * 0.6;
    this.offsetRot.x = this._noise[3](t + 4.1) * r;
    this.offsetRot.y = this._noise[4](t + 17.9) * r;
    this.offsetRot.z = this._noise[5](t + 31.5) * r;
  }

  /** True while any perceptible shake remains. */
  get active() {
    return !this.reducedMotion && (this.impulse + this._rumble) > 1e-3;
  }
}
