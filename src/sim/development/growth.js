// sim/development/growth.js
// Attribute growth model. Computed per player, per week, from layered
// multipliers. No flat "+1 per season".
//
// Layered multipliers:
//   1. Base growth rate from CA/PA gap (gapMultiplier)
//   2. Age curve multiplier (ageCurveMultiplier — biggest driver)
//   3. Playing time multiplier (minutes are the real teacher)
//   4. Training quality multiplier (coach ratings + facility levels + session relevance)
//   5. Personality multiplier (professionalism + ambition + determination)
//   6. Late bloomer bonus (1.4x at ages 24-26 if flagged)
//
// Growth is attribute-specific:
//   - Physical attributes grow fastest at 16-22, plateau at 24, decline from 29
//   - Technical attributes grow steadily through 27
//   - Mental attributes grow into the early 30s

import { clamp } from '../../core/prng.js';
import { gapMultiplier, resolveEffectivePA, lateBloomerBonus } from './potential.js';
import { ageCurveMultiplier, attributeCategoryMult, lifeStage } from './curves.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Compute one week of growth for a player. Returns a growthDelta object
 * the caller applies to the player's attributes.
 *
 * @param {Object} player
 * @param {Object} ctx  { trainingContributions: [], minutesPlayedThisWeek, form, prng }
 * @returns {Object}  { attributeGains: { pace, shooting, ... }, overallGain, events }
 */
export function computeWeeklyGrowth(player, ctx = {}) {
  const events = [];

  // Resolve effective PA if not yet done
  if (player.effectivePA == null) {
    player.effectivePA = resolveEffectivePA(player);
  }

  // Layer 1: gap multiplier (CA/PA gap)
  const gapMult = gapMultiplier(player);

  // Layer 2: age curve
  const ageMult = ageCurveMultiplier(player);

  // Layer 3: playing time
  const minsPct = ctx.minutesPlayedThisWeek ?? 0;   // 0..1 (share of available minutes)
  const playingTimeMult = playingTimeMultiplier(minsPct);

  // Layer 4: training quality — sum of training contributions
  const trainingMult = trainingQualityMultiplier(ctx.trainingContributions || []);

  // Layer 5: personality
  const profMult = professionalismMultiplier(player);
  const ambMult = ambitionMultiplier(player, minsPct);

  // Layer 6: late bloomer
  const lateBloomerMult = lateBloomerBonus(player);

  // Attribute-category multiplier based on life stage
  const catMult = attributeCategoryMult(player);

  // Base weekly growth rate — small enough that meaningful change takes
  // months, large enough that it's visible on a season timescale.
  const BASE_WEEKLY = 0.08;   // attribute points per week at full multipliers

  // Combined multiplier
  const combined = gapMult * ageMult * playingTimeMult * trainingMult *
                   profMult * ambMult * lateBloomerMult;

  // Per-attribute gains — distributed across the player's attribute profile
  const attributeGains = {};
  const cats = ['physical', 'technical', 'mental'];
  for (const cat of cats) {
    const catGain = BASE_WEEKLY * combined * (catMult[cat] || 1);
    // Distribute across the 2-3 sub-attributes in this category for the player's position
    const subAttrs = subAttributesForCategory(cat, player.pos);
    if (subAttrs.length) {
      const perAttr = catGain / subAttrs.length;
      for (const attr of subAttrs) {
        attributeGains[attr] = (attributeGains[attr] || 0) + perAttr;
      }
    }
  }

  // Overall gain = average of attribute gains (weighted)
  const overallGain = Object.values(attributeGains).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(attributeGains).length);

  // Check for milestone crossings
  const oldOvr = player.ovr;
  const newOvr = clamp(Math.round(oldOvr + overallGain * 2), 30, 99);
  if (newOvr !== oldOvr) {
    if ((oldOvr < 70 && newOvr >= 70) ||
        (oldOvr < 75 && newOvr >= 75) ||
        (oldOvr < 80 && newOvr >= 80) ||
        (oldOvr < 85 && newOvr >= 85)) {
      events.push({ type: EVT.STATE_BATCH, payload: {
        panel: 'squad', milestone: 'ovr_tier', playerId: player.id, oldOvr, newOvr
      }});
    }
  }

  return { attributeGains, overallGain, events, newOvr };
}

/**
 * Apply computed growth to a player. Mutates.
 */
export function applyGrowth(player, growth) {
  for (const [attr, gain] of Object.entries(growth.attributeGains)) {
    if (player.atts && player.atts[attr] != null) {
      player.atts[attr] = clamp(player.atts[attr] + gain, 20, 99);
    }
  }
  if (growth.newOvr && growth.newOvr !== player.ovr) {
    player.ovr = growth.newOvr;
  }
}

// ---------------- Multipliers ----------------

function playingTimeMultiplier(minsPct) {
  if (minsPct < 0.25) return 0.5;   // stagnation risk
  if (minsPct < 0.50) return 0.8;
  if (minsPct < 0.75) return 1.0;
  return 1.15;                       // but fatigue accumulates
}

function trainingQualityMultiplier(contributions) {
  if (!contributions.length) return 0.3;   // no training = barely grows
  const sum = contributions.reduce((s, c) => {
    const gains = Object.values(c.attributeGain || {});
    return s + (gains.reduce((a, b) => a + b, 0));
  }, 0);
  // Normalize: 5 sessions of ~1.0 gain each → ~5.0 sum → mult 1.0
  return clamp(0.3 + sum / 5, 0.3, 1.5);
}

function professionalismMultiplier(player) {
  const prof = player.hidden?.professionalism ?? 60;
  return 1 + (prof - 60) / 200;   // 60 → 1.0, 90 → 1.15, 30 → 0.85
}

function ambitionMultiplier(player, minsPct) {
  const amb = player.hidden?.ambition ?? 60;
  // Ambitious players improve faster when given chances
  if (minsPct > 0.5) return 1 + (amb - 60) / 300;
  return 1.0;
}

// ---------------- Attribute mapping ----------------

const ATTR_BY_CATEGORY = {
  physical: {
    GK:  ['stamina', 'strength'],
    DEF: ['pace', 'stamina', 'strength', 'jumping'],
    FB:  ['pace', 'stamina', 'agility'],
    MID: ['stamina', 'strength'],
    FWD: ['pace', 'stamina', 'agility']
  },
  technical: {
    GK:  ['handling', 'kicking', 'reflexes'],
    DEF: ['passing', 'tackling', 'heading'],
    FB:  ['crossing', 'passing', 'tackling'],
    MID: ['passing', 'dribbling', 'shooting'],
    FWD: ['shooting', 'dribbling', 'finishing']
  },
  mental: {
    GK:  ['positioning', 'decisions', 'composure'],
    DEF: ['positioning', 'decisions', 'leadership'],
    FB:  ['decisions', 'workRate'],
    MID: ['vision', 'decisions', 'composure'],
    FWD: ['composure', 'positioning', 'decisions']
  }
};

function subAttributesForCategory(cat, pos) {
  // Map position to position-group key
  const grp = pos === 'GK' ? 'GK' :
              ['CB'].includes(pos) ? 'DEF' :
              ['LB','RB','LWB','RWB'].includes(pos) ? 'FB' :
              ['CDM','CM','CAM','LM','RM'].includes(pos) ? 'MID' : 'FWD';
  return ATTR_BY_CATEGORY[cat]?.[grp] || [];
}
