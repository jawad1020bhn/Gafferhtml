// sim/development/potential.js
// Potential realization & the hidden ceiling.
//
// Potential Ability (PA) is a *range*, not a number. Scouting reveals the
// range; hidden factors decide where the player lands inside it:
//   - Determination (primary)
//   - Professionalism (gates weekly training efficiency)
//   - Injury history (each major injury before 23 reduces effective PA)
//   - Playing time in formative years (17-21)
//
// Late bloomers (~8% of prospects) get a second growth spurt at 24-26.

import { PRNG } from '../../core/prng.js';
import { clamp } from '../../core/prng.js';

/**
 * Resolve the player's effective PA from their scouted band + hidden attrs.
 *
 * @param {Object} player  { potLow, potHigh, hidden: { determination, professionalism, injuryProneness }, earlyInjuries, earlyMinutesPct }
 * @returns {number}  effective PA (the ceiling the player can actually reach)
 */
export function resolveEffectivePA(player) {
  const low = player.potLow ?? player.pot ?? player.ovr + 5;
  const high = player.potHigh ?? player.pot ?? player.ovr + 10;
  const det = player.hidden?.determination ?? 60;
  const prof = player.hidden?.professionalism ?? 60;

  // Determination maps the band: 90 det → top of band, 55 det → bottom
  const detT = clamp((det - 50) / 50, 0, 1);
  let effective = low + (high - low) * detT;

  // Professionalism adds a small bonus (efficient training realizes more)
  const profBonus = (prof - 60) / 200 * (high - low);   // ±20% of band width
  effective += profBonus;

  // Early injuries (before age 23) permanently reduce PA by 1-3 each
  const earlyInjuries = player.earlyInjuries || 0;
  effective -= earlyInjuries * 2;

  // Underplayed in formative years (17-21): lose a slice of ceiling
  if (player.earlyMinutesPct != null && player.earlyMinutesPct < 0.25) {
    effective -= 2;
  }

  return clamp(Math.round(effective), player.ovr, 99);
}

/**
 * Compute the growth rate scaling factor based on CA/PA gap.
 * Players far below their effective PA grow faster; those near it decelerate.
 *
 * @param {Object} player
 * @returns {number}  multiplier (0.1..1.6)
 */
export function gapMultiplier(player) {
  const ca = player.ovr;
  const pa = player.effectivePA ?? resolveEffectivePA(player);
  const gap = pa - ca;
  if (gap <= 0) return 0.1;       // at or above ceiling — minimal growth
  if (gap >= 15) return 1.6;      // massive upside — fast growth
  // Linear interpolation
  return 0.2 + (gap / 15) * 1.4;
}

/**
 * Roll for a late-bloomer flag at career start. ~8% of prospects.
 */
export function rollLateBloomer(prng, player) {
  if (player.lateBloomer != null) return player.lateBloomer;
  // Only prospects under 22 can be flagged
  if (player.age > 22) return false;
  const isLate = prng.next() < 0.08;
  return isLate;
}

/**
 * Late-bloomer second growth spurt at 24-26.
 * Returns the growth multiplier bump if applicable.
 */
export function lateBloomerBonus(player) {
  if (!player.lateBloomer) return 1.0;
  if (player.age < 24 || player.age > 26) return 1.0;
  return 1.4;   // +40% growth during the spurt window
}

/**
 * Roll for a breakout event. Fires rarely on big-match performances,
 * successful mentorship completions, or heavy-minute loan spells.
 *
 * @returns {Object|null}  { kind, paBoost } or null
 */
export function rollBreakout(prng, player, ctx = {}) {
  // Base chance ~2% per eligible event
  let chance = 0;
  if (ctx.bigMatchMOTM && player.age <= 21) chance += 0.10;
  if (ctx.mentorshipCompleted) chance += 0.25;
  if (ctx.loanSpell && ctx.loanMinutesPct > 0.7) chance += 0.15;
  if (chance <= 0) return null;
  if (prng.next() < chance) {
    const boost = prng.int(2, 4);
    return { kind: ctx.bigMatchMOTM ? 'big_match' : ctx.mentorshipCompleted ? 'mentorship' : 'loan', paBoost: boost };
  }
  return null;
}

/**
 * Apply a breakout event — raises effective PA by the boost amount.
 * Mutates player.
 */
export function applyBreakout(player, breakout) {
  if (!breakout) return;
  player.effectivePA = (player.effectivePA ?? resolveEffectivePA(player)) + breakout.paBoost;
  player.breakoutEvents = (player.breakoutEvents || []);
  player.breakoutEvents.push({ ...breakout, week: player._currentWeek, age: player.age });
}
