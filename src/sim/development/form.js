// sim/development/form.js
// Form, confidence & the performance spiral.
//
// Form is the short-term layer riding on top of long-term ability:
//   - Form = weighted mean of last 6 match ratings (most recent weighted heaviest)
//   - Confidence feedback: form ≥ 8.0 → +4% decisions, +3% composure
//   - Morale × form interaction: high-form + low morale → 2× form decay
//   - Position-specific volatility: strikers streaky, CBs stable, GKs most stable

import { clamp } from '../../core/prng.js';

const FORM_WEIGHTS = [0.30, 0.22, 0.17, 0.13, 0.10, 0.08];  // most-recent first

/**
 * Compute form from a player's recent match ratings.
 * Players with no recent matches decay toward 6.5 (neutral).
 *
 * @param {Object} player
 * @returns {number}  form value 1.0..10.0
 */
export function computeForm(player) {
  const recent = (player.formHist || []).slice(-6).reverse();  // most-recent first
  if (recent.length === 0) return 6.5;
  let sum = 0, weightSum = 0;
  for (let i = 0; i < recent.length && i < FORM_WEIGHTS.length; i++) {
    sum += recent[i] * FORM_WEIGHTS[i];
    weightSum += FORM_WEIGHTS[i];
  }
  return clamp(sum / weightSum, 1.0, 10.0);
}

/**
 * Compute the form-based performance modifier for the match engine.
 * Returns { decisionMod, composureMod, overallMod }.
 *
 * Form ≥ 8.0: +4% decisions, +3% composure ("everything he touches turns to gold")
 * Form ≤ 5.8: -5% decisions, hesitancy in one-on-ones
 */
export function formPerformanceMod(player) {
  const form = player.form || computeForm(player);
  if (form >= 8.0) {
    return { decisionMod: 0.04, composureMod: 0.03, overallMod: 0.03 };
  }
  if (form <= 5.8) {
    return { decisionMod: -0.05, composureMod: -0.04, overallMod: -0.04 };
  }
  return { decisionMod: 0, composureMod: 0, overallMod: 0 };
}

/**
 * Apply a match rating to a player's form history.
 * Mutates the player. Triggers the morale × form interaction.
 */
export function applyMatchRating(player, rating, opts = {}) {
  rating = clamp(rating, 1.0, 10.0);
  player.formHist = (player.formHist || []).slice(-9).concat([rating]);
  // Recompute form
  player.form = computeForm(player);
  // Morale-form interaction
  if (player.mor != null && player.mor < 50 && player.form > 6.5) {
    // High-form player whose morale crashed → form decays 2× faster
    // We model this by reducing the most recent rating's effective weight
    const last = player.formHist.pop();
    if (last != null) {
      player.formHist.push(last * 0.85);
      player.form = computeForm(player);
    }
  }
  if (opts.moraleBoost && player.form < 6.5) {
    // Recovering player gets a morale boost → form recovers faster
    // (we already pushed the rating; this just nudges the running average)
    player.form = clamp(player.form + 0.1, 1.0, 10.0);
  }
}

/**
 * Decay form for a player who hasn't played in 3+ weeks.
 * Drift toward 6.5 (neutral).
 */
export function decayForm(player, weeksSinceLastMatch) {
  if (weeksSinceLastMatch < 3) return;
  if (player.form == null) return;
  const decay = (weeksSinceLastMatch - 2) * 0.15;
  player.form = clamp(player.form + (6.5 - player.form) * Math.min(1, decay / 3), 1.0, 10.0);
}

/**
 * Position-specific form volatility — used to inject noise into form changes
 * so that strikers streak and CBs stay stable.
 *
 * Returns the standard deviation to apply when nudging form.
 */
export function formVolatility(player) {
  const pos = player.pos || 'CM';
  if (pos === 'GK') return 0.3;
  if (['CB'].includes(pos)) return 0.6;
  if (['LB','RB','CDM','CM'].includes(pos)) return 0.9;
  if (['CAM','LM','RM'].includes(pos)) return 1.2;
  // ST, LW, RW — most streaky
  return 1.5;
}

/**
 * Compute the form trend arrow (rising/falling/stable) over last 3 matches.
 * Returns 'up' | 'down' | 'flat'.
 */
export function formTrend(player) {
  const recent = (player.formHist || []).slice(-3);
  if (recent.length < 3) return 'flat';
  const delta = recent[2] - recent[0];
  if (delta > 0.5) return 'up';
  if (delta < -0.5) return 'down';
  return 'flat';
}
