/**
 * Upgrade tracks for the recycling-tycoon loop.
 *
 * Pure data + pure functions. This module imports nothing (not even three) and
 * touches no globals, so it is trivially unit-testable and safe to import from
 * a worker or a headless script.
 *
 * Cost model: `baseCost * costGrowth^(level-1)` for the Nth level, rounded to a
 * value that reads well in an arcade HUD.
 * Effect model: a normalised curve over `level / maxLevel`, always 1.0 at
 * level 0 so an un-upgraded machine behaves exactly like the base simulation.
 */

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** Prices under $100 land on the dollar, above that on a $5 step. */
function roundCost(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 100 ? Math.round(raw) : Math.round(raw / 5) * 5;
}

/** Clamp + integerise a requested level into [0, maxLevel]. */
function safeLevel(level, maxLevel) {
  const n = Math.floor(Number(level));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > maxLevel ? maxLevel : n;
}

export const UPGRADES = [
  {
    id: 'torque',
    name: 'Motor Torque',
    blurb: 'Bigger drive motor. Divides cutting resistance so dense stock keeps feeding instead of stalling the shafts.',
    maxLevel: 5,
    baseCost: 40,
    costGrowth: 2.15,
    /**
     * Resistance divisor, 1.0 -> 2.2. Front-loaded: the first level is the one
     * that stops cans-and-pipes play from jamming on the first engine block.
     * @param {number} level
     * @returns {number}
     */
    effectAt(level) {
      const t = safeLevel(level, this.maxLevel) / this.maxLevel;
      return t <= 0 ? 1 : round2(1 + 1.2 * Math.pow(t, 0.85));
    },
  },
  {
    id: 'beltSpeed',
    name: 'Conveyor Drive',
    blurb: 'Geared belt head. Multiplies conveyor speed so stock reaches the throat faster and the hopper never runs dry.',
    maxLevel: 5,
    baseCost: 30,
    costGrowth: 1.95,
    /**
     * Belt speed multiplier, 1.0 -> 2.0. Linear: the player should be able to
     * predict throughput exactly.
     * @param {number} level
     * @returns {number}
     */
    effectAt(level) {
      const t = safeLevel(level, this.maxLevel) / this.maxLevel;
      return t <= 0 ? 1 : round2(1 + 1.0 * t);
    },
  },
  {
    id: 'teeth',
    name: 'Hardened Teeth',
    blurb: 'Tungsten-faced cutters. Cleaner separation means higher grade scrap — multiplies every payout.',
    maxLevel: 5,
    baseCost: 55,
    costGrowth: 2.3,
    /**
     * Cash multiplier, 1.0 -> 3.0. Back-loaded so the final level is a real
     * payday rather than another 20 % nudge.
     * @param {number} level
     * @returns {number}
     */
    effectAt(level) {
      const t = safeLevel(level, this.maxLevel) / this.maxLevel;
      return t <= 0 ? 1 : round2(1 + 2.0 * Math.pow(t, 1.25));
    },
  },
];

/** Accept either an upgrade object or its id. */
function resolve(upgrade) {
  if (typeof upgrade === 'string') return UPGRADES.find((u) => u.id === upgrade) ?? null;
  if (upgrade && typeof upgrade === 'object' && typeof upgrade.effectAt === 'function') return upgrade;
  return null;
}

/**
 * Price of buying the Nth level of an upgrade (1-indexed).
 * @param {object|string} upgrade Upgrade definition or id.
 * @param {number} level The level being bought, i.e. `currentLevel + 1`.
 * @returns {number} Cost in dollars. `0` for level <= 0, `Infinity` past maxLevel or for an unknown id.
 */
export function costFor(upgrade, level) {
  const u = resolve(upgrade);
  if (!u) return Infinity;
  const n = Math.floor(Number(level));
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > u.maxLevel) return Infinity;
  return roundCost(u.baseCost * Math.pow(u.costGrowth, n - 1));
}

/**
 * Machine effect at a given owned level.
 * @param {object|string} upgrade Upgrade definition or id.
 * @param {number} level Owned level, 0 = not purchased.
 * @returns {number} Multiplier/divisor for the track. `1` for an unknown id.
 */
export function effectFor(upgrade, level) {
  const u = resolve(upgrade);
  if (!u) return 1;
  return u.effectAt(level);
}
