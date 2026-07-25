// sim/development/curves.js
// Position-specific development curves.
// Each position group has: peak-age range, growth-rate shape, decline-onset
// age, and which attributes define its aging profile.

import { groupOf } from '../../domain/entities.js';

/**
 * Position-group development profiles.
 *   peakAge: [min, max]   — the prime years
 *   growthShape: function(age) → multiplier (0..1.6)
 *   declineOnset: age at which physical decline begins
 *   attributeProfile: which attribute categories dominate at each life stage
 */
export const POSITION_CURVES = Object.freeze({
  GK: {
    peakAge: [28, 32],
    declineOnset: 33,
    growthShape: (age) => {
      if (age <= 20) return 1.0;
      if (age <= 24) return 1.3;
      if (age <= 28) return 1.4;
      if (age <= 32) return 1.0;
      if (age <= 35) return 0.5;
      return 0.2;
    },
    attributeProfile: {
      young: { physical: 0.8, technical: 1.0, mental: 1.2 },
      prime: { physical: 0.7, technical: 1.0, mental: 1.3 },
      decline: { physical: 0.4, technical: 0.8, mental: 1.1 }
    }
  },
  DEF: {   // centre-backs primarily
    peakAge: [26, 30],
    declineOnset: 31,
    growthShape: (age) => {
      if (age <= 20) return 1.5;
      if (age <= 23) return 1.3;
      if (age <= 26) return 1.1;
      if (age <= 30) return 1.0;
      if (age <= 32) return 0.5;
      return 0.2;
    },
    attributeProfile: {
      young: { physical: 1.3, technical: 1.0, mental: 0.8 },
      prime: { physical: 1.0, technical: 1.0, mental: 1.2 },
      decline: { physical: 0.5, technical: 0.8, mental: 1.1 }
    }
  },
  FB: {   // full-backs / wing-backs (pace-dependent)
    peakAge: [23, 27],
    declineOnset: 29,
    growthShape: (age) => {
      if (age <= 19) return 1.6;
      if (age <= 22) return 1.4;
      if (age <= 25) return 1.1;
      if (age <= 27) return 0.9;
      if (age <= 30) return 0.5;
      return 0.2;
    },
    attributeProfile: {
      young: { physical: 1.5, technical: 1.0, mental: 0.8 },
      prime: { physical: 1.0, technical: 1.0, mental: 1.0 },
      decline: { physical: 0.4, technical: 0.7, mental: 1.0 }
    }
  },
  MID: {  // central midfielders
    peakAge: [25, 29],
    declineOnset: 30,
    growthShape: (age) => {
      if (age <= 20) return 1.6;
      if (age <= 23) return 1.3;
      if (age <= 26) return 1.1;
      if (age <= 29) return 1.0;
      if (age <= 32) return 0.6;
      return 0.2;
    },
    attributeProfile: {
      young: { physical: 1.3, technical: 1.2, mental: 0.9 },
      prime: { physical: 1.0, technical: 1.1, mental: 1.2 },
      decline: { physical: 0.5, technical: 1.0, mental: 1.2 }
    }
  },
  FWD: {  // wingers + strikers
    peakAge: [24, 28],
    declineOnset: 29,
    growthShape: (age) => {
      if (age <= 19) return 1.6;
      if (age <= 22) return 1.4;
      if (age <= 25) return 1.2;
      if (age <= 28) return 1.0;
      if (age <= 30) return 0.5;
      return 0.2;
    },
    attributeProfile: {
      young: { physical: 1.5, technical: 1.2, mental: 0.8 },
      prime: { physical: 1.0, technical: 1.1, mental: 1.1 },
      decline: { physical: 0.4, technical: 0.9, mental: 1.1 }
    }
  }
});

/**
 * Look up the position-group curve for a player.
 */
export function curveFor(player) {
  const pos = player.pos || 'CM';
  const grp = groupOf(pos);
  // Distinguish FB from CB
  if (grp === 'DEF' && ['LB','RB','LWB','RWB'].includes(pos)) return POSITION_CURVES.FB;
  return POSITION_CURVES[grp] || POSITION_CURVES.MID;
}

/**
 * Life-stage bucket for a player given age and curve.
 */
export function lifeStage(player) {
  const c = curveFor(player);
  const age = player.age;
  if (age < c.peakAge[0]) return 'young';
  if (age <= c.peakAge[1]) return 'prime';
  return 'decline';
}

/**
 * Get the attribute-category multiplier for a player at their current life
 * stage. Used by the growth model to weight physical/technical/mental gains.
 */
export function attributeCategoryMult(player) {
  const c = curveFor(player);
  const stage = lifeStage(player);
  return c.attributeProfile[stage] || c.attributeProfile.prime;
}

/**
 * Compute the age-curve growth multiplier for a player.
 * This is the single biggest driver of weekly growth.
 */
export function ageCurveMultiplier(player) {
  const c = curveFor(player);
  return c.growthShape(player.age);
}
