// sim/development/aging.js
// Aging, decline & the adaptation layer.
//
// Players don't just get worse — they get *different*:
//   - Pace and acceleration drop first and fastest (-2 to -4 per year after onset)
//   - Stamina and recovery follow
//   - Strength declines slowly
//   - Mental attributes (vision, positioning, composure, decisions) can still
//     grow into the early 30s
//
// The adaptation mechanic: as physical tools fade, high-intelligence players
// (positioning + decisions + composure) compensate.

import { clamp } from '../../core/prng.js';
import { curveFor, lifeStage } from './curves.js';

/**
 * Compute yearly decline for a player past their decline-onset age.
 * Returns per-attribute deltas (negative = decline).
 *
 * @param {Object} player
 * @returns {Object}  { attributeDeltas: { pace: -3, ... }, adaptationMod }
 */
export function computeYearlyDecline(player) {
  const curve = curveFor(player);
  const onset = curve.declineOnset;
  if (player.age < onset) return { attributeDeltas: {}, adaptationMod: 1.0 };

  const yearsPastOnset = player.age - onset;
  // Decline accelerates with age
  const severity = Math.min(1.5, 1 + yearsPastOnset * 0.15);

  const deltas = {};
  // Pace drops fastest: -2 to -4 per year
  if (player.atts?.pace != null) deltas.pace = -2 * severity;
  if (player.atts?.acceleration != null) deltas.acceleration = -2 * severity;
  // Stamina and recovery follow
  if (player.atts?.stamina != null) deltas.stamina = -1.5 * severity;
  // Strength declines slowly
  if (player.atts?.strength != null) deltas.strength = -0.5 * severity;

  // Adaptation: high mental attributes compensate
  const positioning = player.atts?.positioning ?? 60;
  const decisions = player.atts?.decisions ?? 60;
  const composure = player.atts?.composure ?? 60;
  const mentalAvg = (positioning + decisions + composure) / 3;
  // adaptationMod ranges from 0.85 (low mental → big effective decline) to
  // 1.0 (elite mental → no effective decline despite raw attr loss)
  const adaptationMod = clamp(0.85 + (mentalAvg - 60) / 250, 0.85, 1.0);

  return { attributeDeltas: deltas, adaptationMod };
}

/**
 * Apply yearly decline to a player. Mutates.
 */
export function applyYearlyDecline(player) {
  const { attributeDeltas, adaptationMod } = computeYearlyDecline(player);
  for (const [attr, delta] of Object.entries(attributeDeltas)) {
    if (player.atts && player.atts[attr] != null) {
      // Apply adaptation: effective decline = raw decline × adaptationMod
      player.atts[attr] = clamp(player.atts[attr] + delta * adaptationMod, 20, 99);
    }
  }
  // Recompute overall from attributes (simplified: bump down by avg decline)
  const avgDecline = Object.values(attributeDeltas).reduce((a, b) => a + b, 0) /
                     Math.max(1, Object.keys(attributeDeltas).length);
  if (avgDecline < 0) {
    player.ovr = clamp(Math.round(player.ovr + avgDecline * adaptationMod * 0.5), 30, 99);
  }
  player._adaptationMod = adaptationMod;
}

/**
 * Check if a player is in the "sell-high window" — 18 months before decline
 * becomes obvious. The engine flags this so the player can sell at value.
 */
export function isInSellHighWindow(player) {
  const curve = curveFor(player);
  const onset = curve.declineOnset;
  // 18 months ≈ 1.5 years before onset
  return player.age >= onset - 2 && player.age < onset;
}

/**
 * Roll for retirement. At 33+, players with declining minutes + low ambition
 * retire. High-ambition veterans push on (and can be mentors).
 *
 * @returns {boolean} true if the player retires this off-season
 */
export function rollRetirement(prng, player, opts = {}) {
  if (player.age < 33) return false;
  const curve = curveFor(player);
  // GKs play longer
  const ageCutoff = player.pos === 'GK' ? 38 : 35;
  if (player.age >= ageCutoff) return prng.next() < 0.7;
  // 33-35: depends on minutes and ambition
  const amb = player.hidden?.ambition ?? 60;
  const minsPct = opts.minutesPct ?? 0.5;
  // Low ambition + low minutes = high retire chance
  const retireChance = (player.age - 32) * 0.10 * (1 - amb / 100) * (1 - minsPct);
  return prng.next() < clamp(retireChance, 0, 0.8);
}
