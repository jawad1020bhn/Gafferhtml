// sim/match/xg.js
// Expected Goals (xG) model. Every shot gets an xG value computed from
// context: zone, shot type, assist quality, defender pressure, shooter
// attributes. Not random assignment.

import { clamp } from '../../core/prng.js';

// Base xG by zone (0..1). Zones:
//   six_box    — inside 6-yard box
//   central    — central 12 yards
//   wide       — wide 12 yards
//   edge       — edge of box
//   long       — long range
const BASE_XG = {
  six_box: [0.55, 0.85],
  central: [0.25, 0.45],
  wide:    [0.12, 0.25],
  edge:    [0.06, 0.14],
  long:    [0.02, 0.06]
};

/**
 * Compute base xG for a shot from a zone. Returns a value within the
 * zone's range, scaled by the player's finishing attribute.
 *
 * @param {string} zone  six_box|central|wide|edge|long
 * @param {Object} shooter  { finishing: 0..99 }
 * @returns {number}  0.02..0.85
 */
export function baseXG(zone, shooter) {
  const range = BASE_XG[zone] || BASE_XG.edge;
  // Scale within range by finishing: 50 finishing -> low end, 90+ -> high end
  const t = clamp(((shooter?.finishing || 60) - 40) / 60, 0, 1);
  return range[0] + (range[1] - range[0]) * t;
}

/**
 * Apply shot-type modifiers to a base xG.
 *   header    — -0.05
 *   volley    — -0.08
 *   oneOnOne  — +0.20
 *   openGoal  — +0.40
 */
export function applyShotTypeMod(xg, type) {
  const mods = { header: -0.05, volley: -0.08, oneOnOne: 0.20, openGoal: 0.40 };
  return clamp(xg + (mods[type] || 0), 0.01, 0.95);
}

/**
 * Apply assist-quality modifiers. Values are additive but capped relative
 * to the base xG (no more than +60% of base) to avoid a 0.04 long-range
 * shot ballooning to 0.14 from a single through ball.
 *   through    — +0.08 (capped)
 *   cross      — +0.03 (capped)
 *   cutback    — +0.10 (capped)
 *   setPiece   — +0.05 (capped)
 *   none       — 0
 */
export function applyAssistMod(xg, assistType) {
  const mods = { through: 0.08, cross: 0.03, cutback: 0.10, setPiece: 0.05, none: 0 };
  const mod = mods[assistType] || 0;
  const cappedMod = Math.min(mod, xg * 0.6);
  return clamp(xg + cappedMod, 0.01, 0.95);
}

/**
 * Apply defender-pressure modifiers. Capped relative to base xG.
 *   0 defenders (open)        — +0.10 (capped at +50% of base)
 *   1 defender                 — 0
 *   2+ defenders               — -0.08 (capped at -50% of base)
 *   goalkeeper smothering      — -0.15 (capped at -70% of base)
 */
export function applyPressureMod(xg, pressure) {
  const mods = { open: 0.10, light: 0, heavy: -0.08, smothered: -0.15 };
  const mod = mods[pressure] || 0;
  let cappedMod;
  if (mod > 0) cappedMod = Math.min(mod, xg * 0.5);
  else cappedMod = Math.max(mod, -xg * 0.7);
  return clamp(xg + cappedMod, 0.01, 0.95);
}

/**
 * Apply shooter's composure (±0.04 at extremes).
 */
export function applyComposureMod(xg, shooter) {
  const comp = shooter?.composure || 60;
  const mod = (comp - 60) / 60 * 0.04;   // -0.04..+0.04
  return clamp(xg + mod, 0.01, 0.95);
}

/**
 * Apply weak-foot penalty. If shooter's weakFoot < 0.5 and shot is on
 * weak foot (caller must determine), -0.06.
 */
export function applyWeakFootMod(xg, shooter, onWeakFoot) {
  if (!onWeakFoot) return xg;
  const wf = shooter?.weakFoot ?? 0.5;
  if (wf >= 0.7) return xg;       // strong weak foot — no penalty
  return clamp(xg - 0.06, 0.01, 0.95);
}

/**
 * Convenience: full xG pipeline.
 *   shot = { zone, type, assistType, pressure, onWeakFoot }
 *   shooter = { finishing, composure, weakFoot }
 */
export function computeXG(shot, shooter) {
  let xg = baseXG(shot.zone, shooter);
  xg = applyShotTypeMod(xg, shot.type);
  xg = applyAssistMod(xg, shot.assistType);
  xg = applyPressureMod(xg, shot.pressure);
  xg = applyComposureMod(xg, shooter);
  xg = applyWeakFootMod(xg, shooter, shot.onWeakFoot);
  return clamp(xg, 0.01, 0.95);
}

/**
 * Map a possession's "shot context" to a zone. Possessions describe the
 * build-up; this picks a plausible shot zone weighted by the build-up
 * style and the tactical matchup.
 *
 * @param {Object} prng  PRNG instance (deterministic)
 * @param {Object} ctx  { possession: { style, counter, setPiece }, matchup }
 * @returns {string}  zone key
 */
export function pickShotZone(prng, ctx = {}) {
  // Counter-attacks produce more central / one-on-one chances
  // Set pieces produce more six_box headers
  // Patient build-ups: most shots come from edge/long range (real PL data:
  // ~60% of shots are from outside the box, ~30% from central/wide 12 yards,
  // ~10% from inside 6 yards).
  const isCounter = ctx.possession?.counter;
  const isSetPiece = ctx.possession?.setPiece;
  let weights;
  if (isSetPiece) {
    weights = [{ item: 'six_box', weight: 4 }, { item: 'central', weight: 2 }, { item: 'wide', weight: 1 }, { item: 'edge', weight: 1 }];
  } else if (isCounter) {
    weights = [{ item: 'central', weight: 4 }, { item: 'six_box', weight: 3 }, { item: 'edge', weight: 2 }, { item: 'wide', weight: 1 }, { item: 'long', weight: 1 }];
  } else {
    // Default: realistic distribution. Most shots from outside the box.
    weights = [{ item: 'long', weight: 5 }, { item: 'edge', weight: 4 }, { item: 'wide', weight: 2 }, { item: 'central', weight: 2 }, { item: 'six_box', weight: 1 }];
  }
  return prng.weighted(weights);
}

/**
 * Pick shot type based on zone & assist.
 */
export function pickShotType(prng, zone, assistType) {
  // Headers come mostly from crosses / set pieces
  if (assistType === 'cross' || assistType === 'setPiece') {
    return prng.weighted([
      { item: 'header', weight: zone === 'six_box' ? 5 : 3 },
      { item: 'volley', weight: 1 },
      { item: null, weight: 4 }
    ]);
  }
  if (zone === 'six_box') {
    return prng.weighted([
      { item: 'oneOnOne', weight: 2 },
      { item: null, weight: 5 }
    ]);
  }
  // Default: most shots are regular strikes (null type)
  return prng.weighted([
    { item: null, weight: 8 },
    { item: 'volley', weight: 1 }
  ]);
}

/**
 * Upset calibration helper. Given two club ratings, return the expected
 * win/draw/loss probability for the home side. Used by the engine to
 * sanity-check xG accumulation.
 *
 * Target: home win ~46%, draw ~26%, away win ~28% for evenly-matched sides.
 * Stronger side wins more, but a 20-point rating gap should still allow
 * ~12-15% upset rate for the underdog at home.
 */
export function expectedResultProbabilities(homeRating, awayRating, isHomeAdvantage = true) {
  const diff = (homeRating - awayRating) + (isHomeAdvantage ? 4 : 0);
  // Logistic mapping
  const homeWinP = 1 / (1 + Math.exp(-diff / 18));
  const awayWinP = 1 / (1 + Math.exp(diff / 18));
  let drawP = 1 - homeWinP - awayWinP;
  // Compress draw probability toward ~26% baseline
  drawP = drawP * 0.7 + 0.26 * 0.3;
  // Renormalise
  const total = homeWinP + drawP + awayWinP;
  return { home: homeWinP / total, draw: drawP / total, away: awayWinP / total };
}
