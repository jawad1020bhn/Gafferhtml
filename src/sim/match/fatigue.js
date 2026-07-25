// sim/match/fatigue.js
// Stamina drain & injury events over 90 minutes.
//
// Drain rate per player, based on position, tactical demand, stamina
// attribute, recent match load, age. Threshold effects at 70%/50%/30%.

import { clamp } from '../../core/prng.js';

const POSITION_DRAIN = {
  // Per-minute base drain
  GK: 0.15, CB: 0.18, LB: 0.35, RB: 0.35, LWB: 0.40, RWB: 0.40,
  CDM: 0.30, CM: 0.40, CAM: 0.35, LM: 0.35, RM: 0.35,
  LW: 0.40, RW: 0.40, ST: 0.32, CF: 0.32
};

/**
 * Per-minute drain for a player given the tactical context.
 * Returns a fraction (0..1) of stamina to subtract per minute.
 */
export function drainPerMinute(player, slotPos, tactics) {
  let rate = POSITION_DRAIN[slotPos] || 0.30;
  // Tactical demand
  if (tactics?.pressing === 'high') rate *= 1.5;
  if (tactics?.pressing === 'low')  rate *= 0.8;
  if (tactics?.tempo === 'fast')    rate *= 1.2;
  if (tactics?.tempo === 'slow')    rate *= 0.85;
  // Player's stamina attribute (90 stamina → 30% slower drain than 60)
  const staminaAttr = player?.stamina || (player?.effRating || 70);
  const staminaMod = 1 - (staminaAttr - 60) / 100;   // 60 → 1.0, 90 → 0.7
  rate *= staminaMod;
  // Recent match load (played 90' three days ago → starts at 85% instead of 100%)
  // Encoded in player.fit (which is the starting fitness); we already
  // account for it in effRating, but we don't double-penalise drain.
  // Age modifier (31+)
  if ((player?.age || 25) >= 31) rate *= 1.10;
  return rate / 100;
}

/**
 * Apply fatigue threshold effects to a player's effective attributes.
 * Returns a multiplier object.
 */
export function fatigueEffects(currentStaminaPct) {
  // 100% = no effect. Below 70%: -8% sprint, -4% passing. Below 50%: -12%
  // tackle, +15% positioning errors. Below 30%: injury risk spike.
  if (currentStaminaPct >= 70) return { sprint: 1, pass: 1, tackle: 1, errorRate: 1, injuryRisk: 0 };
  if (currentStaminaPct >= 50) return { sprint: 0.92, pass: 0.96, tackle: 1,    errorRate: 1.0,  injuryRisk: 0.005 };
  if (currentStaminaPct >= 30) return { sprint: 0.85, pass: 0.92, tackle: 0.88, errorRate: 1.15, injuryRisk: 0.02 };
  return                          { sprint: 0.78, pass: 0.88, tackle: 0.76, errorRate: 1.30, injuryRisk: 0.08 };
}

/**
 * Tick fatigue for a single player for one minute. Mutates the slot's
 * `match.stamina` field (NOT the player entity). The slot may carry a
 * `playerSnapshot` for attribute lookup (age, hidden, etc.).
 */
export function tickPlayerFatigue(slot, slotPos, tactics) {
  if (!slot) return 100;
  if (!slot.match) slot.match = { stamina: 100, started: true };
  const drain = drainPerMinute(slot.playerSnapshot || slot, slotPos, tactics);
  slot.match.stamina = clamp(slot.match.stamina - drain * 100, 0, 100);
  return slot.match.stamina;
}

/**
 * Squad-level fatigue summary for the momentum / possession model.
 * Returns { home: 0..1, away: 0..1, homeMid: 0..1, awayMid: 0..1 }.
 * 1.0 = full fitness, 0 = exhausted.
 */
export function squadFatigueSummary(setup) {
  if (!setup || !setup.starting) return 1;
  let sum = 0, n = 0;
  let midSum = 0, midN = 0;
  for (const s of setup.starting) {
    const stam = s.match?.stamina ?? (s.stamina || 90);
    sum += stam; n++;
    if (['CM','CDM','CAM','LM','RM'].includes(s.slotPos)) {
      midSum += stam; midN++;
    }
  }
  return {
    avg: n ? sum / n / 100 : 1,
    mid: midN ? midSum / midN / 100 : 1
  };
}

/**
 * Roll for an injury event on a player this minute. Returns an injury
 * object or null. Accepts a slot (with .match and .playerSnapshot) or a
 * plain player entity.
 */
export function rollInjury(prng, slot, slotPos, minute, club, facilitiesLevel = 1) {
  const player = slot?.playerSnapshot || slot;
  const stamPct = (slot?.match?.stamina ?? 100) / 100;
  const effects = fatigueEffects(stamPct * 100);
  let risk = effects.injuryRisk;
  if (risk <= 0) return null;
  // Medical facility level reduces base risk
  risk *= clamp(1 - (facilitiesLevel - 1) * 0.05, 0.5, 1);
  // Player's injury proneness (hidden attribute, 0..1)
  risk *= (player?.hidden?.injuryProneness ?? 0.5) * 1.2;
  if (prng.next() < risk) {
    // Injury type
    const type = prng.weighted([
      { item: 'Hamstring strain',  weight: 3 },
      { item: 'Calf strain',       weight: 2 },
      { item: 'Ankle sprain',      weight: 2 },
      { item: 'Groin strain',      weight: 1 },
      { item: 'Knock',             weight: 2 },
      { item: 'Cramp',             weight: 2 }
    ]);
    const severity = prng.weighted([
      { item: 'Minor',     weight: 4 },
      { item: 'Moderate',  weight: 2 },
      { item: 'Severe',    weight: 1 }
    ]);
    const days = severity === 'Minor' ? prng.int(3, 10) :
                 severity === 'Moderate' ? prng.int(14, 28) :
                 prng.int(45, 90);
    return { playerId: player?.id || null, type, severity, days, minute, mechanism: 'muscle' };
  }
  return null;
}

/**
 * Roll for an injury from a foul (hard tackle). 15% base, modified by
 * tackler's aggression.
 */
export function rollFoulInjury(prng, victim, tacklerAggression = 0.5) {
  const risk = 0.15 * (0.5 + tacklerAggression);
  if (prng.next() < risk) {
    const type = prng.weighted([
      { item: 'Impact injury', weight: 3 },
      { item: 'Dead leg', weight: 2 },
      { item: 'Head clash', weight: 1 }
    ]);
    const severity = prng.weighted([
      { item: 'Minor', weight: 5 },
      { item: 'Moderate', weight: 2 },
      { item: 'Severe', weight: 1 }
    ]);
    const days = severity === 'Minor' ? prng.int(2, 7) :
                 severity === 'Moderate' ? prng.int(10, 21) :
                 prng.int(28, 60);
    return { playerId: victim?.id || null, type, severity, days, mechanism: 'impact' };
  }
  return null;
}
