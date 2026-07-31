import { UPGRADES, costFor, effectFor } from './Upgrades.js';
import { makeContractPool } from './Contracts.js';

/**
 * GameDirector — the "Recycling Tycoon" loop that sits on top of the shredder
 * simulation. Pure logic: it imports nothing from three, touches no DOM, and
 * every public getter is safe before any input arrives and after dispose().
 *
 * The simulation pushes events in (`registerItemDestroyed`, `registerFragment`,
 * `setLoad`, `update`) and reads machine parameters back out
 * (`resistanceDivisor`, `conveyorMultiplier`, `cashMultiplier`, `isStalled`).
 */

const TUNING = {
  // Strain smoothing (exponential, separate rise/fall time constants).
  strainRiseTau: 0.22,
  strainFallTau: 0.42,

  // Stall model.
  stallThreshold: 0.82,   // effective strain that counts as an overload
  stallHoldTime: 1.2,     // seconds of sustained overload before jamming
  stallRelief: 1.7,       // overload timer bleeds off this much faster than it fills
  stallDuration: 4.0,     // automatic recovery timeout
  stallGrace: 1.2,        // no re-stall for this long after recovering
  stallStrainAfter: 0.35, // strain the gauge drops to on recovery

  // Jam-buster.
  jamBurst: 2.0,
  jamCooldown: 10.0,
  jamBoost: 2.6,          // extra resistance division during the burst

  // Economy.
  valuePerKg: 2.2,        // fallback when the sim does not price an item
  valueFloor: 0.75,
  fragmentRate: 900,      // dollars per cubic metre of shredded fragment
  fragmentCap: 0.6,       // per-fragment ceiling, keeps the trickle a trickle
  trickleFlush: 0.25,     // pay out accumulated micro-income at this amount...
  trickleInterval: 0.6,   // ...or after this long, whichever comes first

  activeContracts: 3,
};

/** Scrap grade multipliers for per-fragment micro-income. */
const MATERIAL_VALUE = {
  copper: 2.4, brass: 2.0, bronze: 1.9, pcb: 1.8, alloy: 1.6,
  aluminium: 1.6, aluminum: 1.6, stainless: 1.35, galvanised: 1.05,
  galvanized: 1.05, mildsteel: 1.0, appliancesteel: 1.0, steel: 1.0,
  castiron: 0.9, iron: 0.9, ferrite: 0.8, rubber: 0.3, abs: 0.3,
  plastic: 0.3, glass: 0.25, mdf: 0.15, wood: 0.15,
};

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const key = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/[\s_-]+/g, '') : '');

export class GameDirector {
  /**
   * @param {object} [opts]
   * @param {(payload:object)=>void} [opts.onCash] Fired for every payout: `{ amount, cash, totalEarned, reason, label, category, position }`.
   * @param {(payload:object)=>void} [opts.onStall] Fired when the motor jams.
   * @param {(payload:object)=>void} [opts.onRecover] Fired when the jam clears.
   * @param {(contract:object)=>void} [opts.onContractComplete]
   * @param {(notice:object)=>void} [opts.onNotice] HUD toast: `{ type, message, tone }`.
   * @param {number} [opts.startingCash=0]
   * @param {()=>number} [opts.rng=Math.random] Injectable RNG for deterministic tests.
   */
  constructor(opts = {}) {
    this.onCash = opts.onCash ?? null;
    this.onStall = opts.onStall ?? null;
    this.onRecover = opts.onRecover ?? null;
    this.onContractComplete = opts.onContractComplete ?? null;
    this.onNotice = opts.onNotice ?? null;
    this._rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

    this._disposed = false;
    this._time = 0;

    this._cash = Math.max(0, round2(num(opts.startingCash, 0)));
    this._totalEarned = 0;

    this._levels = new Map();
    for (const u of UPGRADES) this._levels.set(u.id, 0);

    this._rawLoad = 0;
    this._strain = 0;

    this._stalled = false;
    this._overload = 0;
    this._stallTimer = 0;
    this._grace = 0;

    this._jamActive = false;
    this._jamTimer = 0;
    this._jamCooldown = 0;

    this._trickle = 0;
    this._trickleAge = 0;
    this._tricklePos = null;

    this._stats = { itemsDestroyed: 0, byCategory: Object.create(null), kgProcessed: 0, stalls: 0 };

    this._pool = makeContractPool();
    this._used = new Set();
    this._active = [];
    this._seedContracts();
  }

  // ------------------------------------------------------------------ inputs

  /**
   * A feed item was fully consumed. Pays `value * cashMultiplier`, advances
   * stats and contracts.
   * @param {{id?:string,label?:string,category?:string,mass?:number,value?:number}} item
   * @returns {number} The amount paid out, in dollars.
   */
  registerItemDestroyed(item) {
    if (this._disposed || !item || typeof item !== 'object') return 0;

    const mass = Math.max(0, num(item.mass, 0));
    const raw = num(item.value, NaN);
    const value = Number.isFinite(raw) && raw > 0
      ? raw
      : Math.max(TUNING.valueFloor, mass * TUNING.valuePerKg + 1.2);

    const evt = {
      id: typeof item.id === 'string' ? item.id : '',
      label: typeof item.label === 'string' ? item.label : (typeof item.id === 'string' ? item.id : 'Scrap'),
      category: typeof item.category === 'string' ? item.category : '',
      mass,
      value: round2(value),
    };

    const amount = round2(clamp(value * this.cashMultiplier, 0, 1e7));
    this._credit(amount);

    this._stats.itemsDestroyed += 1;
    this._stats.kgProcessed = round2(this._stats.kgProcessed + mass);
    const cat = key(evt.category) || 'misc';
    this._stats.byCategory[cat] = (this._stats.byCategory[cat] ?? 0) + 1;

    this._fire(this.onCash, {
      amount,
      cash: this.cash,
      totalEarned: this.totalEarned,
      reason: 'item',
      label: evt.label,
      category: evt.category,
      position: item.worldPosition ?? null,
    });

    this._progressContracts(evt);
    return amount;
  }

  /**
   * A single slice/fragment was produced. Pays a small amount scaled by volume
   * and scrap grade; payouts are batched so the HUD is not spammed.
   * @param {{material?:string,volume?:number,worldPosition?:*}} frag
   * @returns {number} The micro-amount accrued, in dollars.
   */
  registerFragment(frag) {
    if (this._disposed || !frag || typeof frag !== 'object') return 0;

    const volume = Math.max(0, num(frag.volume, 0));
    if (volume <= 0) return 0;

    const grade = MATERIAL_VALUE[key(frag.material)] ?? 1;
    const amount = clamp(volume * TUNING.fragmentRate * grade * this.cashMultiplier, 0, TUNING.fragmentCap * 4);
    if (!(amount > 0)) return 0;

    this._trickle += amount;
    if (frag.worldPosition) this._tricklePos = frag.worldPosition;
    if (this._trickle >= TUNING.trickleFlush) this._flushTrickle();
    return round2(amount);
  }

  /**
   * Raw motor load from physics, 0..1. Feeds the smoothed strain gauge.
   * @param {number} load01
   */
  setLoad(load01) {
    if (this._disposed) return;
    this._rawLoad = clamp(num(load01, 0), 0, 1);
  }

  /**
   * Advance timers: strain smoothing, stall/recovery, jam-buster, payout batching.
   * @param {number} dt Seconds.
   */
  update(dt) {
    if (this._disposed) return;
    const step = clamp(num(dt, 0), 0, 0.25);
    if (step <= 0) return;

    this._time += step;
    this._updateJam(step);
    this._updateStrain(step);
    this._updateStall(step);

    this._trickleAge += step;
    if (this._trickle > 0 && this._trickleAge >= TUNING.trickleInterval) this._flushTrickle();
  }

  // -------------------------------------------------------- machine readouts

  /** Divide cut resistance by this. Torque upgrade, boosted during a jam-buster burst. */
  get resistanceDivisor() {
    const base = effectFor('torque', this.levelOf('torque'));
    return this._jamActive ? round2(base * TUNING.jamBoost) : base;
  }

  /** Conveyor speed multiplier from the belt upgrade. */
  get conveyorMultiplier() {
    return effectFor('beltSpeed', this.levelOf('beltSpeed'));
  }

  /** Payout multiplier from the teeth upgrade. */
  get cashMultiplier() {
    return effectFor('teeth', this.levelOf('teeth'));
  }

  /** True while the machine is jammed; the sim should hold the rotors. */
  get isStalled() {
    return this._stalled;
  }

  /** Smoothed 0..1 strain for the HUD gauge. Relieved by torque, pinned while jammed. */
  get strain() {
    return round2(clamp(this._strain, 0, 1));
  }

  // --------------------------------------------------------- player actions

  /**
   * Fire the jam-buster: a short high-torque burst that instantly clears a
   * stall, followed by a cooldown.
   * @returns {{ok:boolean, reason:string|null, duration:number, cooldown:number}}
   */
  triggerJamBuster() {
    if (this._disposed) return { ok: false, reason: 'disposed', duration: 0, cooldown: 0 };
    if (this._jamActive) return { ok: false, reason: 'active', duration: this._jamTimer, cooldown: 0 };
    if (this._jamCooldown > 0) return { ok: false, reason: 'cooldown', duration: 0, cooldown: round2(this._jamCooldown) };

    this._jamActive = true;
    this._jamTimer = TUNING.jamBurst;
    this._overload = 0;
    if (this._stalled) this._recover('jamBuster');

    this._fire(this.onNotice, { type: 'jam', message: 'Jam-buster engaged', tone: 'good' });
    return { ok: true, reason: null, duration: TUNING.jamBurst, cooldown: TUNING.jamCooldown };
  }

  /**
   * Jam-buster UI state.
   * `cooldown01` is readiness (0 just used -> 1 ready), `duration01` is the
   * remaining fraction of an active burst (0 when idle).
   * @returns {{ready:boolean, active:boolean, cooldown01:number, duration01:number}}
   */
  get jamBuster() {
    const ready = !this._disposed && !this._jamActive && this._jamCooldown <= 0;
    return {
      ready,
      active: this._jamActive,
      cooldown01: round2(clamp(1 - this._jamCooldown / TUNING.jamCooldown, 0, 1)),
      duration01: this._jamActive ? round2(clamp(this._jamTimer / TUNING.jamBurst, 0, 1)) : 0,
    };
  }

  /**
   * Buy the next level of an upgrade.
   * @param {string} upgradeId
   * @returns {{ok:boolean, reason:string|null, level:number, cost:number}}
   */
  purchase(upgradeId) {
    const level = this.levelOf(upgradeId);
    if (this._disposed) return { ok: false, reason: 'disposed', level, cost: Infinity };

    const def = UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return { ok: false, reason: 'unknown', level: 0, cost: Infinity };
    if (level >= def.maxLevel) return { ok: false, reason: 'maxed', level, cost: Infinity };

    const cost = costFor(def, level + 1);
    if (cost > this._cash) return { ok: false, reason: 'insufficient', level, cost };

    this._cash = Math.max(0, round2(this._cash - cost));
    this._levels.set(def.id, level + 1);

    this._fire(this.onNotice, {
      type: 'upgrade',
      message: `${def.name} Mk${level + 1}`,
      tone: 'good',
    });
    return { ok: true, reason: null, level: level + 1, cost };
  }

  /**
   * Owned level of an upgrade track.
   * @param {string} upgradeId
   * @returns {number}
   */
  levelOf(upgradeId) {
    return this._levels.get(upgradeId) ?? 0;
  }

  // ----------------------------------------------------------- HUD readouts

  /** Spendable cash, rounded to cents. */
  get cash() {
    return round2(this._cash);
  }

  /** Lifetime earnings, rounded to cents. */
  get totalEarned() {
    return round2(this._totalEarned);
  }

  /** Immutable snapshot: `{ itemsDestroyed, byCategory, kgProcessed, stalls }`. */
  get stats() {
    return {
      itemsDestroyed: this._stats.itemsDestroyed,
      byCategory: { ...this._stats.byCategory },
      kgProcessed: round2(this._stats.kgProcessed),
      stalls: this._stats.stalls,
    };
  }

  /** Active contracts as plain HUD rows. */
  get contracts() {
    return this._active.map((slot) => ({
      id: slot.def.id,
      title: slot.def.title,
      description: slot.def.description,
      progress: round2(Math.min(slot.progress, slot.def.target)),
      target: slot.def.target,
      reward: slot.def.reward,
      done: slot.progress >= slot.def.target,
    }));
  }

  /** Upgrade rows for the shop. `cost` is `null` once a track is maxed. */
  get upgradeState() {
    return UPGRADES.map((u) => {
      const level = this.levelOf(u.id);
      const maxed = level >= u.maxLevel;
      const cost = maxed ? null : costFor(u, level + 1);
      return {
        id: u.id,
        name: u.name,
        blurb: u.blurb,
        level,
        maxLevel: u.maxLevel,
        cost,
        affordable: !maxed && !this._disposed && cost <= this._cash,
        effect: u.effectAt(level),
        maxed,
      };
    });
  }

  // ----------------------------------------------------------- persistence

  /**
   * JSON-safe snapshot of all progress.
   * @returns {object}
   */
  serialize() {
    const levels = {};
    for (const [id, lv] of this._levels) levels[id] = lv;
    return {
      version: 1,
      cash: this.cash,
      totalEarned: this.totalEarned,
      levels,
      stats: this.stats,
      contracts: this._active.map((s) => ({ id: s.def.id, progress: round2(s.progress) })),
      usedContracts: [...this._used],
      jamCooldown: round2(this._jamCooldown),
    };
  }

  /**
   * Rebuild a director from `serialize()` output.
   * @param {object} json
   * @param {object} [opts] Fresh callbacks/rng; the same shape as the constructor.
   * @returns {GameDirector}
   */
  static deserialize(json, opts = {}) {
    const d = new GameDirector({ ...opts, startingCash: 0 });
    if (!json || typeof json !== 'object') return d;

    d._cash = Math.max(0, round2(num(json.cash, 0)));
    d._totalEarned = Math.max(0, round2(num(json.totalEarned, 0)));

    if (json.levels && typeof json.levels === 'object') {
      for (const u of UPGRADES) {
        const lv = Math.floor(num(json.levels[u.id], 0));
        d._levels.set(u.id, clamp(Number.isFinite(lv) ? lv : 0, 0, u.maxLevel));
      }
    }

    const s = json.stats;
    if (s && typeof s === 'object') {
      d._stats.itemsDestroyed = Math.max(0, Math.floor(num(s.itemsDestroyed, 0)));
      d._stats.kgProcessed = Math.max(0, round2(num(s.kgProcessed, 0)));
      d._stats.stalls = Math.max(0, Math.floor(num(s.stalls, 0)));
      if (s.byCategory && typeof s.byCategory === 'object') {
        for (const [k, v] of Object.entries(s.byCategory)) {
          const n = Math.floor(num(v, 0));
          if (n > 0) d._stats.byCategory[key(k) || 'misc'] = n;
        }
      }
    }

    if (Array.isArray(json.usedContracts)) {
      for (const id of json.usedContracts) if (typeof id === 'string') d._used.add(id);
    }

    if (Array.isArray(json.contracts)) {
      d._active = [];
      for (const entry of json.contracts) {
        const def = d._pool.find((c) => c.id === entry?.id);
        if (!def || d._active.some((slot) => slot.def.id === def.id)) continue;
        d._active.push({ def, progress: Math.max(0, num(entry.progress, 0)) });
      }
      d._fillContracts();
    }

    d._jamCooldown = clamp(num(json.jamCooldown, 0), 0, TUNING.jamCooldown);
    return d;
  }

  /** Drop callbacks and stop reacting to input. Getters stay safe to read. */
  dispose() {
    this._disposed = true;
    this.onCash = null;
    this.onStall = null;
    this.onRecover = null;
    this.onContractComplete = null;
    this.onNotice = null;
    this._trickle = 0;
    this._tricklePos = null;
    this._jamActive = false;
    this._jamTimer = 0;
    this._stalled = false;
  }

  // -------------------------------------------------------------- internals

  _updateJam(dt) {
    if (this._jamActive) {
      this._jamTimer -= dt;
      if (this._jamTimer <= 0) {
        this._jamActive = false;
        this._jamTimer = 0;
        this._jamCooldown = TUNING.jamCooldown;
      }
      return;
    }
    if (this._jamCooldown > 0) this._jamCooldown = Math.max(0, this._jamCooldown - dt);
  }

  _updateStrain(dt) {
    // Torque scales the effective load down, which is what keeps dense stock
    // from tripping the stall threshold. The gauge shows that relief directly.
    const target = this._stalled ? 1 : clamp(this._rawLoad / this.resistanceDivisor, 0, 1);
    const tau = target > this._strain ? TUNING.strainRiseTau : TUNING.strainFallTau;
    this._strain += (target - this._strain) * (1 - Math.exp(-dt / tau));
    if (!Number.isFinite(this._strain)) this._strain = 0;
  }

  _updateStall(dt) {
    if (this._stalled) {
      this._stallTimer -= dt;
      if (this._stallTimer <= 0) this._recover('timeout');
      return;
    }

    if (this._grace > 0) {
      this._grace = Math.max(0, this._grace - dt);
      return;
    }

    if (!this._jamActive && this._strain > TUNING.stallThreshold) {
      this._overload += dt;
      if (this._overload >= TUNING.stallHoldTime) this._stall();
    } else {
      this._overload = Math.max(0, this._overload - dt * TUNING.stallRelief);
    }
  }

  _stall() {
    this._stalled = true;
    this._overload = 0;
    this._stallTimer = TUNING.stallDuration;
    this._strain = 1;
    this._stats.stalls += 1;

    for (const slot of this._active) {
      if (typeof slot.def.notifyStall !== 'function') continue;
      try {
        const p = slot.def.notifyStall(slot.progress);
        if (Number.isFinite(p)) slot.progress = Math.max(0, p);
      } catch (err) {
        console.error('[GameDirector] contract notifyStall failed', err);
      }
    }

    this._fire(this.onStall, { stalls: this._stats.stalls, duration: TUNING.stallDuration });
    this._fire(this.onNotice, { type: 'stall', message: 'MOTOR STALLED', tone: 'bad' });
  }

  _recover(reason) {
    this._stalled = false;
    this._stallTimer = 0;
    this._overload = 0;
    this._grace = TUNING.stallGrace;
    this._strain = Math.min(this._strain, TUNING.stallStrainAfter);

    this._fire(this.onRecover, { reason, stalls: this._stats.stalls });
    this._fire(this.onNotice, {
      type: 'recover',
      message: reason === 'jamBuster' ? 'Jam cleared' : 'Motor recovered',
      tone: 'good',
    });
  }

  _credit(amount) {
    const a = num(amount, 0);
    if (!(a > 0)) return;
    this._cash = round2(this._cash + a);
    this._totalEarned = round2(this._totalEarned + a);
  }

  _flushTrickle() {
    const amount = round2(this._trickle);
    this._trickle = 0;
    this._trickleAge = 0;
    if (!(amount > 0)) {
      this._tricklePos = null;
      return;
    }
    this._credit(amount);
    const position = this._tricklePos;
    this._tricklePos = null;
    this._fire(this.onCash, {
      amount,
      cash: this.cash,
      totalEarned: this.totalEarned,
      reason: 'fragment',
      label: 'Scrap',
      category: '',
      position,
    });
  }

  _seedContracts() {
    this._active = [];
    this._fillContracts();
  }

  _fillContracts() {
    while (this._active.length < TUNING.activeContracts) {
      const def = this._draw();
      if (!def) break;
      this._active.push({ def, progress: 0 });
    }
  }

  _draw() {
    const live = new Set(this._active.map((s) => s.def.id));
    let choices = this._pool.filter((d) => !this._used.has(d.id) && !live.has(d.id));
    if (choices.length === 0) {
      this._used.clear();
      choices = this._pool.filter((d) => !live.has(d.id));
    }
    if (choices.length === 0) return null;
    const r = clamp(num(this._rng(), 0), 0, 0.999999);
    return choices[Math.min(choices.length - 1, Math.floor(r * choices.length))];
  }

  _progressContracts(evt) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const slot = this._active[i];
      let add = 0;
      try {
        const r = slot.def.match(evt);
        add = r === true ? 1 : (Number.isFinite(r) ? Math.max(0, r) : 0);
      } catch (err) {
        console.error('[GameDirector] contract match failed', err);
      }
      if (add <= 0) continue;
      slot.progress += add;
      if (slot.progress >= slot.def.target) this._completeContract(i);
    }
  }

  _completeContract(index) {
    const [slot] = this._active.splice(index, 1);
    if (!slot) return;
    this._used.add(slot.def.id);

    const reward = Math.max(0, num(slot.def.reward, 0));
    this._credit(reward);

    const snapshot = {
      id: slot.def.id,
      title: slot.def.title,
      description: slot.def.description,
      progress: slot.def.target,
      target: slot.def.target,
      reward,
      done: true,
    };

    this._fire(this.onCash, {
      amount: round2(reward),
      cash: this.cash,
      totalEarned: this.totalEarned,
      reason: 'contract',
      label: slot.def.title,
      category: 'contract',
      position: null,
    });
    this._fire(this.onContractComplete, snapshot);
    this._fire(this.onNotice, { type: 'contract', message: `Contract complete: ${slot.def.title}`, tone: 'good' });

    const next = this._draw();
    if (next) this._active.splice(index, 0, { def: next, progress: 0 });
  }

  _fire(fn, payload) {
    if (typeof fn !== 'function') return;
    try {
      fn(payload);
    } catch (err) {
      console.error('[GameDirector] callback failed', err);
    }
  }
}
