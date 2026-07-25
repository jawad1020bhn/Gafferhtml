// sim/match/shot.js
// Shot resolution. A shot becomes a goal, save, miss, or block through
// layered probability. Goal probability = xG, modified by GK & shooter
// attributes; if not a goal, the outcome is determined by weighted roll.

import { clamp } from '../../core/prng.js';

/**
 * Resolve a shot. Returns:
 *   { outcome: 'goal'|'save'|'miss'|'block'|'post',
 *     xg, scorer?, goalkeeper?, rebound? }
 *
 * @param {Object} prng
 * @param {Object} shot   { xg, shooter, zone, type, minute, isDerby, isBigMoment, ageContext }
 * @param {Object} goalkeeper  { reflexes, positioning, name }  (defending side's GK)
 */
export function resolveShot(prng, shot, goalkeeper) {
  // ---- Goal probability = xG, modified ----
  let goalP = shot.xg;
  // GK reflexes + positioning: elite keepers reduce by up to 0.12
  const gkReflex = goalkeeper?.reflexes ?? 60;
  const gkPos = goalkeeper?.positioning ?? 60;
  const gkSave = (gkReflex - 60) / 30 * 0.06 + (gkPos - 60) / 30 * 0.06;
  goalP = clamp(goalP - gkSave, 0.005, 0.95);
  // Shooter's finishing attribute (already in baseXG but we add a thin layer here)
  const finish = shot.shooter?.finishing ?? 60;
  goalP += (finish - 60) / 200;   // ±0.2 at extremes
  // Fatigue of shooter (tired legs: -0.04 after 75')
  if (shot.minute > 75) goalP -= 0.04;
  // Pressure context (derby, title decider): composure tax for young players
  if (shot.isBigMoment && (shot.shooter?.age || 25) < 24) goalP -= 0.03;
  goalP = clamp(goalP, 0.005, 0.95);

  if (prng.next() < goalP) {
    return { outcome: 'goal', xg: shot.xg, scorer: shot.shooter, goalP };
  }

  // ---- Not a goal: determine outcome ----
  // Save 55%, miss 25%, block 15%, post 5%
  // Adjust: better keeper → more saves; better composure → fewer misses
  const gkAdjust = clamp((gkReflex - 60) / 200, -0.1, 0.1);
  const compAdjust = clamp(((shot.shooter?.composure || 60) - 60) / 400, -0.05, 0.05);
  let saveP = 0.55 + gkAdjust;
  let missP = 0.25 - compAdjust;
  let blockP = 0.15;
  let postP = 0.05;
  // High-xG chances: more saves (closer range → keeper more involved)
  if (shot.xg > 0.3) { saveP += 0.05; missP -= 0.05; }
  // Long range: more blocks
  if (shot.zone === 'long' || shot.zone === 'edge') { blockP += 0.10; saveP -= 0.05; missP -= 0.05; }
  // Normalise
  const total = saveP + missP + blockP + postP;
  saveP /= total; missP /= total; blockP /= total; postP /= total;

  const r = prng.next();
  let outcome;
  if (r < saveP) outcome = 'save';
  else if (r < saveP + missP) outcome = 'miss';
  else if (r < saveP + missP + blockP) outcome = 'block';
  else outcome = 'post';

  const result = { outcome, xg: shot.xg, shooter: shot.shooter, goalkeeper };

  // Save → 30% chance of rebound (second-chance xG at 0.15)
  if (outcome === 'save' && prng.next() < 0.30) {
    result.rebound = { xg: 0.15, followUp: true };
  }
  return result;
}

/**
 * After a save, decide the goalkeeper's distribution.
 *   quick_throw  — counter-attack trigger (15%)
 *   short_pass   — reset possession (50%)
 *   long_kick    — 50/50 aerial duel in midfield (35%)
 */
export function gkDistribution(prng, goalkeeper) {
  // Better GKs distribute more accurately
  const gkDist = (goalkeeper?.positioning ?? 60) + (goalkeeper?.reflexes ?? 60);
  const t = clamp((gkDist - 110) / 70, -0.5, 0.5);
  return prng.weighted([
    { item: 'quick_throw', weight: 0.15 + t * 0.1 },
    { item: 'short_pass',   weight: 0.50 + t * 0.15 },
    { item: 'long_kick',    weight: 0.35 - t * 0.2 }
  ]);
}

/**
 * Resolve a rebound (second-chance shot). Lower xG, often a tap-in.
 */
export function resolveRebound(prng, reboundCtx, goalkeeper) {
  const shot = { ...reboundCtx, xg: reboundCtx.xg, shooter: reboundCtx.shooter, minute: reboundCtx.minute };
  // Rebounds are usually closer range — convert to goal more often than pure xG suggests
  const boostedXG = clamp(reboundCtx.xg * 1.3, 0.05, 0.6);
  return resolveShot(prng, { ...shot, xg: boostedXG }, goalkeeper);
}
