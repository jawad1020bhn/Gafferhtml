// sim/injuries/state.js
// Injury taxonomy and state machine. Injury is a state machine, not a
// countdown label.
//
// Taxonomy with base recovery windows:
//   - Knock / dead leg: 3-7 days
//   - Muscle strain (hamstring, calf, groin): 2-5 weeks
//   - Ligament (ankle sprain grade I-III): 2-8 weeks
//   - Fracture: 6-12 weeks
//   - ACL / serious knee: 6-9 months (career-event severity)

import { clamp } from '../../core/prng.js';
import { EVT } from '../../core/eventBus.js';

export const INJURY_TYPES = Object.freeze({
  KNOCK:        { label: 'Knock',                baseDays: 5,   category: 'minor',      reInjuryRisk: 1.0 },
  DEAD_LEG:     { label: 'Dead leg',             baseDays: 4,   category: 'minor',      reInjuryRisk: 1.0 },
  CRAMP:        { label: 'Cramp',                baseDays: 2,   category: 'minor',      reInjuryRisk: 1.0 },
  HAMSTRING:    { label: 'Hamstring strain',     baseDays: 21,  category: 'muscle',     reInjuryRisk: 2.0 },
  CALF:         { label: 'Calf strain',          baseDays: 18,  category: 'muscle',     reInjuryRisk: 1.8 },
  GROIN:        { label: 'Groin strain',         baseDays: 16,  category: 'muscle',     reInjuryRisk: 1.7 },
  ANKLE_I:      { label: 'Ankle sprain (Grade I)',  baseDays: 14,  category: 'ligament', reInjuryRisk: 1.5 },
  ANKLE_II:     { label: 'Ankle sprain (Grade II)', baseDays: 35,  category: 'ligament', reInjuryRisk: 2.0 },
  ANKLE_III:    { label: 'Ankle sprain (Grade III)',baseDays: 56,  category: 'ligament', reInjuryRisk: 2.5 },
  FRACTURE:     { label: 'Fracture',             baseDays: 63,  category: 'fracture',   reInjuryRisk: 1.2 },
  ACL:          { label: 'ACL tear',             baseDays: 210, category: 'serious',    reInjuryRisk: 3.0 },
  KNEE_CARTILAGE: { label: 'Knee cartilage',     baseDays: 84,  category: 'serious',    reInjuryRisk: 2.5 }
});

/**
 * Create an injury record. Returns a fresh injury object ready to attach
 * to a player.
 *
 * @param {string} typeKey  INJURY_TYPES key
 * @param {Object} opts  { severity, daysLeft, mechanism, sourceMatchId }
 */
export function createInjury(typeKey, opts = {}) {
  const def = INJURY_TYPES[typeKey];
  if (!def) throw new Error('Unknown injury type: ' + typeKey);
  const baseDays = opts.severity === 'Severe' ? def.baseDays * 1.5 :
                   opts.severity === 'Moderate' ? def.baseDays :
                   def.baseDays * 0.6;
  return {
    type: def.label,
    typeKey,
    category: def.category,
    severity: opts.severity || (def.category === 'serious' ? 'Severe' :
                                 def.category === 'minor' ? 'Minor' : 'Moderate'),
    daysLeft: Math.round(opts.daysLeft || baseDays),
    totalDays: Math.round(opts.daysLeft || baseDays),
    mechanism: opts.mechanism || 'muscle',  // muscle | impact | recurring
    sourceMatchId: opts.sourceMatchId || null,
    startedAt: null,        // filled by caller
    setbackCount: 0,
    reInjuryVulnerableUntil: null   // date 4 weeks after return
  };
}

/**
 * Tick an injury by one day. Returns events to emit.
 * Mutates the injury.
 *
 * @returns {Array<{type, payload}>}  events (recovered, setback)
 */
export function tickInjury(injury, prng, opts = {}) {
  if (!injury || injury.daysLeft <= 0) return [];
  const events = [];
  injury.daysLeft--;

  // Setback roll — base 6% per week, scaled to per-day
  // (per-day rate = 6% / 7 ≈ 0.85%)
  const medicalLevel = opts.medicalLevel ?? 5;
  const setbackChance = 0.0085 * (1 - (medicalLevel - 5) * 0.05) * (injury.category === 'serious' ? 1.5 : 1.0);
  if (prng.next() < setbackChance) {
    const extension = Math.round(injury.daysLeft * (0.25 + prng.next() * 0.25));
    injury.daysLeft += extension;
    injury.setbackCount++;
    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'squad', setback: true, injury: injury.type, extension
    }});
  }

  if (injury.daysLeft <= 0) {
    injury.daysLeft = 0;
    injury.recovered = true;
    // Re-injury vulnerability: 4 weeks after returning
    const reInjuryDays = 28;
    injury.reInjuryVulnerableUntilDays = reInjuryDays;
    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'squad', recovered: true, injury: injury.type
    }});
  }
  return events;
}

/**
 * Check if a player is currently re-injury vulnerable (within 4 weeks of
 * returning from a previous injury to the same body part).
 */
export function isReInjuryVulnerable(player) {
  if (!player.inj && player._lastInjuryReturnedAt) {
    const daysSince = player._daysSinceReturn || 999;
    return daysSince < 28;
  }
  return false;
}

/**
 * Apply recovery modifiers to a base injury duration.
 *   - Medical facility: up to -20%
 *   - Sports science: up to -12%
 *   - Player's natural recovery (age + professionalism): -10..+25%
 */
export function applyRecoveryModifiers(baseDays, opts = {}) {
  const { medicalLevel = 5, scienceLevel = 4, age = 25, professionalism = 60 } = opts;
  const medicalMod = 1 - clamp((medicalLevel - 1) * 0.04, 0, 0.20);
  const scienceMod = 1 - clamp((scienceLevel - 1) * 0.025, 0, 0.12);
  let ageMod = 1.0;
  if (age >= 30) ageMod = 1 + clamp((age - 29) * 0.04, 0, 0.25);
  else if (age <= 22) ageMod = 0.92;
  const profMod = 1 - clamp((professionalism - 60) / 500, -0.05, 0.10);
  return Math.round(baseDays * medicalMod * scienceMod * ageMod * profMod);
}
