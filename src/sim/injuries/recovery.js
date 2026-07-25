// sim/injuries/recovery.js
// Match sharpness — a separate axis from fitness.
//
//   Fitness = physical readiness (recovers with rest, drains with play)
//   Sharpness = match rhythm (only built by playing minutes, decays without them)
//
// A player returning from 6 weeks out has 90% fitness but 40% sharpness —
// he looks rusty, makes errors, loses duels. You must ease him back through
// substitute appearances and U21 minutes.

import { clamp } from '../../core/prng.js';

/**
 * Apply match-minutes to a player's sharpness.
 *   +8 per 90' played
 *   +4 per 45'
 *   +2 per U21 appearance
 */
export function applyMatchMinutes(player, minutes, opts = {}) {
  if (player.inj) return;
  const isU21 = opts.isU21 || false;
  let gain;
  if (isU21) {
    gain = 2;
  } else {
    gain = (minutes / 90) * 8;
  }
  player.sharp = clamp((player.sharp || 60) + gain, 0, 100);
  player._lastMatchPlayedAt = opts.date || 'now';
}

/**
 * Decay sharpness for a player who hasn't played this week.
 *   -3 per week without minutes
 */
export function decaySharpness(player) {
  if (player.inj) return;
  player.sharp = clamp((player.sharp || 60) - 3, 0, 100);
}

/**
 * Compute the sharpness modifier for the match engine.
 * Returns -0.10..+0.05 added to effective attributes.
 *
 * Sharpness 100: +5% (peak rhythm)
 * Sharpness 70: 0 (normal)
 * Sharpness 40: -8% (rusty)
 * Sharpness < 20: -15% (clearly undercooked)
 */
export function sharpnessMod(player) {
  const s = player.sharp ?? 70;
  if (s >= 90) return 0.05;
  if (s >= 70) return 0;
  if (s >= 50) return -0.04;
  if (s >= 30) return -0.08;
  return -0.15;
}

/**
 * Compute the post-injury return-to-play recommendation.
 * Returns a verbal recommendation + a fitness/sharpness snapshot.
 */
export function returnToPlayAssessment(player) {
  if (player.inj) {
    return {
      status: 'injured',
      recommendation: 'Continue rehab. Do not return until cleared by medical.',
      daysRemaining: player.inj.daysLeft
    };
  }
  const fit = player.fit ?? 80;
  const sharp = player.sharp ?? 60;
  if (fit < 70) {
    return { status: 'unfit', recommendation: 'Not match-fit. Build fitness via U21s.' };
  }
  if (sharp < 40) {
    return { status: 'rusty', recommendation: 'Ease back via substitute appearances (15-30 mins).' };
  }
  if (sharp < 60) {
    return { status: 'returning', recommendation: 'Ready for 45-60 minutes. Monitor late-game fatigue.' };
  }
  return { status: 'ready', recommendation: 'Ready to start.' };
}

/**
 * Tick weekly sharpness decay for the whole squad.
 */
export function tickSquadSharpness(squad) {
  for (const p of squad) {
    if (!p.inj) decaySharpness(p);
  }
}
