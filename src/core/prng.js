// core/prng.js
// Deterministic pseudo-random number generator.
// All simulation randomness MUST flow through this module.
// UI code may use Math.random() for non-sim cosmetics only.

/** Clamp v to [a, b]. */
export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * mulberry32 — small, fast, deterministic PRNG.
 * Same seed -> same sequence, forever. Period ~2^32.
 * @param {number} seed  32-bit unsigned integer
 * @returns {() => number}  function returning float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash an arbitrary string into a 32-bit unsigned integer.
 * Used to derive deterministic seeds from save IDs, fixture IDs, etc.
 * (FNV-1a variant — stable across runs and JS engines.)
 */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A forkable PRNG stream. Forks are deterministic: the same parent
 * at the same call count, forked with the same key, produces the
 * same child sequence — independent of how the parent is consumed
 * after forking (because we hash (parentSeed, forkKey) into a new seed
 * rather than chaining from current internal state).
 *
 * Usage:
 *   const root = makePRNG(saveSeed);
 *   const day  = root.fork('day-42');
 *   const match = day.fork('match-fx-007');
 *   const evt  = match.fork('evt-3');
 */
export class PRNG {
  constructor(seed) {
    // Accept either a number (used directly) or a string (hashed).
    this._seed = (typeof seed === 'number' ? seed >>> 0 : hashString(String(seed)));
    this._next = mulberry32(this._seed);
    this._draws = 0;
  }

  /** Float in [0, 1). */
  next() {
    this._draws++;
    return this._next();
  }

  /** Float in [a, b). */
  range(a, b) {
    return a + this.next() * (b - a);
  }

  /** Integer in [a, b] inclusive. */
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }

  /** Boolean true with probability p (default 0.5). */
  chance(p = 0.5) {
    return this.next() < p;
  }

  /** Pick a random element from a non-empty array. */
  pick(arr) {
    if (arr.length === 0) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Pick k distinct elements from arr (Fisher-Yates partial shuffle). */
  sample(arr, k) {
    const a = arr.slice();
    const n = Math.min(k, a.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.next() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  }

  /** Shuffle a copy of arr. Original untouched. */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Approximate Gaussian (Box-Muller). Mean μ, stddev σ.
   * Clamped to [μ - 4σ, μ + 4σ] to avoid extreme tails.
   */
  gauss(μ = 0, σ = 1) {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(μ - 4 * σ, Math.min(μ + 4 * σ, μ + z * σ));
  }

  /** Weighted pick. items: [{item, weight}]. Returns item. */
  weighted(items) {
    let total = 0;
    for (const it of items) total += Math.max(0, it.weight);
    if (total <= 0) return items[0]?.item;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, it.weight);
      if (r <= 0) return it.item;
    }
    return items[items.length - 1].item;
  }

  /**
   * Fork a child stream. The child's seed is derived from THIS stream's
   * original seed + the fork key, NOT from the current internal state —
   * so consuming the parent before/after forking does not change the
   * child's sequence. This is the determinism guarantee.
   */
  fork(key) {
    const childSeed = hashString(this._seed + ':' + key);
    return new PRNG(childSeed);
  }

  /** Seed value (for debugging / display). */
  get seed() { return this._seed; }
  get drawCount() { return this._draws; }
}

/** Convenience: build a root PRNG from any string seed (save ID etc.). */
export function makePRNG(seedStringOrNumber) {
  const seed = typeof seedStringOrNumber === 'number'
    ? seedStringOrNumber >>> 0
    : hashString(String(seedStringOrNumber));
  return new PRNG(seed);
}
