// sim/training/sessions.js
// Session types & their effects on fatigue, attribute growth, and performance.
// Each session is a self-contained unit the scheduler (microcycle.js) assigns
// to a training day.

export const SESSION_TYPES = Object.freeze({
  TACTICAL:  'tactical',
  TECHNICAL: 'technical',
  PHYSICAL:  'physical',
  RECOVERY:  'recovery',
  SETPIECE: 'setpiece',
  MATCHPREP: 'matchprep'
});

/**
 * Per-session definition. `fatigueCost` is the load added to participating
 * players; `attributeGain` is the multiplier applied to growth for relevant
 * attributes; `performanceMod` is a one-off modifier for the next fixture.
 */
export const SESSION_DEFS = Object.freeze({
  tactical: {
    label: 'Tactical',
    fatigueCost: 0.06,
    attributeGain: { mental: 1.2, technical: 0.8 },
    familiarityGain: 0.05,
    performanceMod: 0,
    intensity: 'low'
  },
  technical: {
    label: 'Technical',
    fatigueCost: 0.12,
    attributeGain: { technical: 1.4, mental: 0.6 },
    familiarityGain: 0.02,
    performanceMod: 0,
    intensity: 'medium'
  },
  physical: {
    label: 'Physical',
    fatigueCost: 0.22,
    attributeGain: { physical: 1.6 },
    familiarityGain: 0,
    performanceMod: 0,
    intensity: 'high',
    injuryRiskMult: 1.8
  },
  recovery: {
    label: 'Recovery',
    fatigueCost: -0.18,           // negative = restores fitness
    attributeGain: {},
    familiarityGain: 0,
    performanceMod: 0,
    intensity: 'none',
    injuryRiskMult: 0.5
  },
  setpiece: {
    label: 'Set Pieces',
    fatigueCost: 0.05,
    attributeGain: { technical: 0.5, mental: 0.4 },
    familiarityGain: 0.01,
    performanceMod: 0,
    intensity: 'low',
    setPieceQualityGain: 0.04
  },
  matchprep: {
    label: 'Match Prep',
    fatigueCost: 0.08,
    attributeGain: {},
    familiarityGain: 0.03,
    performanceMod: 0.08,           // +8% performance for next fixture
    intensity: 'low',
    opponentSpecific: true
  }
});

/**
 * Apply a training session to a player. Mutates the player's transient
 * training-state (fitness, sharpness deltas). Returns growth contributions
 * the development system will pick up at the weekly growth tick.
 *
 * @param {Object} player  Player entity (mutated: fit, fatigueLoad)
 * @param {string} sessionType  SESSION_TYPES value
 * @param {Object} opts  { coachRating, facilityLevel, isU23 }
 * @returns {Object}  growth contribution for this session
 */
export function applySession(player, sessionType, opts = {}) {
  const def = SESSION_DEFS[sessionType];
  if (!def) return null;

  const coachRating = opts.coachRating ?? 70;
  const facilityLevel = opts.facilityLevel ?? 5;
  const isU23 = opts.isU23 ?? (player.age <= 23);

  // Fitness change
  const fatigueDelta = def.fatigueCost;
  player.fit = Math.max(0, Math.min(100, (player.fit || 80) - fatigueDelta * 100));

  // Sharpness builds slightly from non-recovery sessions (match rhythm
  // comes mostly from real minutes, but training helps)
  if (sessionType !== SESSION_TYPES.RECOVERY) {
    player.sharp = Math.min(100, (player.sharp || 70) + 0.5);
  }

  // Growth contribution — collected here, applied at weekly tick
  const coachMult = 1 + (coachRating - 70) / 200;       // ±15% at extremes
  const facilityMult = 1 + (facilityLevel - 5) / 30;    // ±10% at extremes
  const u23Mult = isU23 ? 1.1 : 1.0;
  const effectiveGain = Object.fromEntries(
    Object.entries(def.attributeGain || {}).map(([k, v]) =>
      [k, v * coachMult * facilityMult * u23Mult])
  );

  return {
    sessionType,
    attributeGain: effectiveGain,
    familiarityGain: def.familiarityGain * coachMult,
    performanceMod: def.performanceMod,
    fatigueDelta,
    injuryRiskMult: def.injuryRiskMult || 1.0,
    setPieceQualityGain: def.setPieceQualityGain || 0
  };
}

/**
 * Auto-schedule sessions for a week given squad state and upcoming fixture.
 * Used by the assistant-coach AI when the player opts out of micromanaging.
 *
 * Strategy:
 *   - Matchday-3: RECOVERY (or after a match)
 *   - Matchday-2: TACTICAL (build familiarity)
 *   - Matchday-1: MATCHPREP (opponent-specific)
 *   - Other days: rotate TECHNICAL / PHYSICAL based on squad fatigue
 *   - If squad fatigue > 75: force RECOVERY
 */
export function autoScheduleWeek(squadFatigue, fixtureDifficulty = 0.5, daysToFixture = 5) {
  const schedule = [];
  for (let i = 0; i < daysToFixture; i++) {
    const daysToMatch = daysToFixture - i;
    if (daysToMatch === 1) {
      schedule.push(SESSION_TYPES.MATCHPREP);
    } else if (daysToMatch === 2) {
      schedule.push(SESSION_TYPES.TACTICAL);
    } else if (i === 0 && squadFatigue > 60) {
      schedule.push(SESSION_TYPES.RECOVERY);
    } else if (squadFatigue > 80) {
      schedule.push(SESSION_TYPES.RECOVERY);
    } else if (fixtureDifficulty > 0.6 && daysToMatch <= 4) {
      schedule.push(SESSION_TYPES.TACTICAL);
    } else {
      // Rotate technical/physical for development
      schedule.push(i % 2 === 0 ? SESSION_TYPES.TECHNICAL : SESSION_TYPES.PHYSICAL);
    }
  }
  return schedule;
}
