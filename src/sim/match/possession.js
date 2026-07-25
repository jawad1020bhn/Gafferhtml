// sim/match/possession.js
// Possession phase model. A match is a sequence of possessions, each
// lasting a variable number of minutes (0.5..4). Each possession moves
// through zones (def/mid/final/box) with turnover probabilities.
//
// Outputs a stream of possession objects the engine uses to drive
// chance creation, shot generation, and the event feed.

import { clamp } from '../../core/prng.js';

const ZONES = ['def', 'mid', 'final', 'box'];

/**
 * Allocate possession at the start of a new possession. Returns the team
 * index (0=home, 1=away) that has the ball.
 *
 * Base probability from midfield rating comparison, modified by:
 *   current momentum, tactical instruction, fatigue differential, game state.
 */
export function allocatePossession(prng, ctx) {
  const { setup, matchup, momentum, minute, score, tactics, fatigue } = ctx;
  // Base from strength differential
  let homeBase = 0.5 + matchup.strength * 0.6;
  // Momentum: positive = home dominant
  homeBase += momentum * 0.12;
  // Tactical instruction: possession style +8%, counter -5-8%
  homeBase += possessionBias(tactics.home) - possessionBias(tactics.away);
  // Game state: team leading after 70' drops deeper, concedes possession
  if (minute > 70) {
    if (score.home > score.away) homeBase -= 0.05;
    else if (score.away > score.home) homeBase += 0.05;
  }
  // Fatigue differential: tired midfield loses the ball more
  const fitDiff = (fatigue.homeMid - fatigue.awayMid) / 100;
  homeBase += fitDiff * 0.06;

  homeBase = clamp(homeBase, 0.2, 0.8);
  return prng.next() < homeBase ? 0 : 1;
}

function possessionBias(tactics) {
  if (!tactics) return 0;
  if (tactics.mentality === 'defensive' || tactics.mentality === 'cautious') return -0.03;
  if (tactics.mentality === 'attacking' || tactics.mentality === 'all-out') return 0.04;
  if (tactics.personality === 'possession') return 0.08;
  if (tactics.personality === 'counter') return -0.06;
  return 0;
}

/**
 * Simulate a single possession. Returns:
 *   { team, durationMins, outcome, zone, turnover?, shotContext?, setPieceContext? }
 *
 * outcome types:
 *   turnover_mid, turnover_final, shot, cross_recycle, foul_won,
 *   corner, setPiece, goalKick, throwIn
 */
export function simulatePossession(prng, ctx, attackingTeam) {
  const { setup, matchup, tactics, momentum, fatigue } = ctx;
  // Duration: 0.5..4 minutes, skewed short
  const durationMins = prng.range(0.5, 4);

  // Walk through zones: def -> mid -> final -> box
  let zone = 'def';
  const atkTactics = attackingTeam === 0 ? tactics.home : tactics.away;
  const defTactics = attackingTeam === 0 ? tactics.away : tactics.home;
  const atkFatigue = attackingTeam === 0 ? fatigue.home : fatigue.away;
  const defFatigue = attackingTeam === 0 ? fatigue.away : fatigue.home;
  const atkSetup = attackingTeam === 0 ? setup.home : setup.away;
  const defSetup = attackingTeam === 0 ? setup.away : setup.home;

  // Tempo: high-press + fast-build → faster progression but higher turnover
  const tempoRisk = tempoRiskScore(atkTactics);
  const pressIntensity = pressIntensityScore(defTactics);

  while (zone !== 'box') {
    const next = nextZone(zone);
    // Turnover probability at this transition
    const turnoverP = turnoverProbability(zone, next, atkTactics, defTactics, matchup, atkFatigue, defFatigue, atkSetup, defSetup, tempoRisk, pressIntensity);
    if (prng.next() < turnoverP) {
      return {
        team: attackingTeam,
        durationMins,
        outcome: zone === 'def' ? 'turnover_def' : zone === 'mid' ? 'turnover_mid' : 'turnover_final',
        zone,
        turnover: true
      };
    }
    zone = next;
  }

  // Reached the box. Decide outcome: shot (35%), cross/cutback (15%),
  // recycled possession (40%), foul won (5%), turnover (5%).
  // Real matches average ~12 shots per team — tuned down from the v1 spec
  // numbers (60% shot / 20% cross) which produced ~25 shots/match.
  const r = prng.next();
  if (r < 0.35) {
    return {
      team: attackingTeam, durationMins, outcome: 'shot', zone: 'box',
      shotContext: { assistType: pickAssistType(prng, atkTactics), pressure: pickPressure(prng, defSetup) }
    };
  } else if (r < 0.50) {
    // Cross / cutback — may produce a shot from a different zone
    return {
      team: attackingTeam, durationMins, outcome: 'cross', zone: 'box',
      shotContext: { assistType: prng.next() < 0.5 ? 'cross' : 'cutback', pressure: pickPressure(prng, defSetup) }
    };
  } else if (r < 0.90) {
    // Recycled possession — restart from final third
    return {
      team: attackingTeam, durationMins, outcome: 'recycle', zone: 'final'
    };
  } else if (r < 0.95) {
    // Foul won — set piece in a dangerous area
    return {
      team: attackingTeam, durationMins, outcome: 'foul_won', zone: 'final',
      setPieceContext: { type: prng.next() < 0.3 ? 'freekick_direct' : 'freekick_wide' }
    };
  } else {
    // Turnover in the box
    return {
      team: attackingTeam, durationMins, outcome: 'turnover_final', zone: 'box',
      turnover: true
    };
  }
}

function nextZone(zone) {
  const idx = ZONES.indexOf(zone);
  return ZONES[Math.min(idx + 1, ZONES.length - 1)];
}

function turnoverProbability(fromZone, toZone, atkTactics, defTactics, matchup, atkFatigue, defFatigue, atkSetup, defSetup, tempoRisk, pressIntensity) {
  // Base by zone transition
  const baseByFrom = { def: 0.15, mid: 0.22, final: 0.32 };
  let p = baseByFrom[fromZone] || 0.2;
  // Pressing intensity vs ball-playing ability
  p += pressIntensity * 0.15;
  p -= (avgPassing(atkSetup) - 60) / 200;     // better passers turn over less
  p += (avgInterception(defSetup) - 60) / 200;
  // Tactical risk: fast build-up → higher turnover, higher reward
  p += tempoRisk * 0.10;
  // Fatigue: tired attackers give ball away more
  p += (1 - atkFatigue) * 0.05;
  // Tired defenders press less effectively
  p -= (1 - defFatigue) * 0.04;
  return clamp(p, 0.05, 0.55);
}

function avgPassing(setup) {
  if (setup.synthetic) {
    return setup.starting.reduce((a, s) => a + (s.effRating || 60), 0) / setup.starting.length;
  }
  // For user squads: derive from ovr + form
  return setup.starting.reduce((a, s) => a + s.effRating, 0) / setup.starting.length;
}
function avgInterception(setup) {
  if (setup.synthetic) return avgPassing(setup);
  // Same approximation
  return setup.starting.filter(s => s.slotPos === 'CB' || s.slotPos === 'CDM')
    .reduce((a, s) => a + s.effRating, 0) / Math.max(1, setup.starting.filter(s => s.slotPos === 'CB' || s.slotPos === 'CDM').length);
}

function tempoRiskScore(tactics) {
  if (!tactics) return 0;
  let s = 0;
  if (tactics.tempo === 'fast') s += 0.5;
  if (tactics.tempo === 'slow') s -= 0.5;
  if (tactics.build === 'Fast') s += 0.3;
  if (tactics.mentality === 'attacking') s += 0.3;
  if (tactics.mentality === 'defensive') s -= 0.3;
  return clamp(s, -1, 1);
}
function pressIntensityScore(tactics) {
  if (!tactics) return 0;
  if (tactics.pressing === 'high') return 0.7;
  if (tactics.pressing === 'mid') return 0.4;
  if (tactics.pressing === 'low') return 0.1;
  return 0.4;
}

function pickAssistType(prng, atkTactics) {
  // Most shots are unassisted solo efforts. Wide/possession tactics skew
  // the assist mix when one does occur.
  if (atkTactics?.width === 'wide') {
    return prng.weighted([{ item: 'none', weight: 6 }, { item: 'cross', weight: 3 }, { item: 'through', weight: 1 }, { item: 'cutback', weight: 1 }]);
  }
  if (atkTactics?.personality === 'possession') {
    return prng.weighted([{ item: 'none', weight: 6 }, { item: 'cutback', weight: 2 }, { item: 'through', weight: 1 }, { item: 'cross', weight: 1 }]);
  }
  return prng.weighted([{ item: 'none', weight: 7 }, { item: 'through', weight: 1 }, { item: 'cross', weight: 1 }, { item: 'cutback', weight: 1 }]);
}

function pickPressure(prng, defSetup) {
  // Better defSetup → more heavy pressure
  const defRating = avgInterception(defSetup);
  const t = (defRating - 60) / 30;   // -0.5..+0.5
  if (prng.next() < 0.3 + t * 0.2) return 'heavy';
  if (prng.next() < 0.1) return 'smothered';
  if (prng.next() < 0.2) return 'open';
  return 'light';
}

/**
 * Decide whether a counter-attack is triggered off a turnover.
 */
export function isCounterAttack(prng, ctx, turnoverTeam, possessionTeam) {
  const atkTactics = turnoverTeam === 0 ? ctx.tactics.home : ctx.tactics.away;
  const counterBias = atkTactics?.counterBias || 0.5;
  // Counter triggered if the recovering team's counterBias is high
  return prng.next() < (counterBias * 0.6);
}
