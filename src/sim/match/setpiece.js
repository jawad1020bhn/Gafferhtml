// sim/match/setpiece.js
// Set piece engine: corners, free kicks, penalties, throw-ins, goal kicks.
// Each is a mini-simulation, not flat probability.

import { clamp } from '../../core/prng.js';
import { computeXG } from './xg.js';

/**
 * Corner kick resolution.
 *   delivery quality: crosser's crossing + set-piece bonus
 *   aerial duel: attacker heading+jumping vs defender heading+marking
 *   outcomes: header on target (35%), cleared (40%), short recycle (15%), foul (10%)
 *   if header on target: xG 0.18..0.30
 *
 * @returns { outcome, xg?, scorer?, setPiece: true }
 */
export function resolveCorner(prng, ctx, attackingTeam) {
  const atkSetup = attackingTeam === 0 ? ctx.setup.home : ctx.setup.away;
  const defSetup = attackingTeam === 0 ? ctx.setup.away : ctx.setup.home;
  // Pick crosser and target
  const crosser = atkSetup.starting.find(s => ['LM','RM','LW','RW','CAM'].includes(s.slotPos)) || atkSetup.starting[5];
  const target = pickAerialTarget(atkSetup, prng);
  const marker = pickAerialMarker(defSetup, prng);

  // Delivery quality
  const delivery = clamp(((crosser?.crossing || crosser?.effRating || 70) + (atkSetup.clubTactics?.setPieceBias || 0.5) * 20) / 100, 0.3, 0.95);
  // Aerial duel
  const atkAerial = (target?.heading || target?.effRating || 70) + (target?.jumping || 0);
  const defAerial = (marker?.marking || marker?.effRating || 70) + (marker?.heading || 0);
  const duelOutcome = prng.weighted([
    { item: 'on_target', weight: 0.35 * delivery * (atkAerial / (atkAerial + defAerial + 1)) },
    { item: 'cleared',   weight: 0.40 * (defAerial / (atkAerial + defAerial + 1)) },
    { item: 'recycle',   weight: 0.15 },
    { item: 'foul',      weight: 0.10 }
  ]);

  if (duelOutcome === 'on_target') {
    // xG: 0.18 (near post) to 0.30 (unmarked at back post)
    const xg = clamp(0.18 + prng.next() * 0.12 + (delivery - 0.5) * 0.05, 0.05, 0.4);
    return {
      outcome: 'shot', setPiece: true, setPieceType: 'corner',
      xg, shooter: target,
      shotContext: { zone: 'six_box', type: 'header', assistType: 'cross', pressure: 'light' }
    };
  } else if (duelOutcome === 'cleared') {
    return { outcome: 'cleared', setPiece: true, setPieceType: 'corner' };
  } else if (duelOutcome === 'recycle') {
    return { outcome: 'recycle', setPiece: true, setPieceType: 'corner' };
  } else {
    return { outcome: 'foul', setPiece: true, setPieceType: 'corner' };
  }
}

function pickAerialTarget(setup, prng) {
  const candidates = setup.starting.filter(s => ['CB','ST','CF'].includes(s.slotPos));
  const pool = candidates.length ? candidates : setup.starting;
  const rng = prng || { next: () => 0.5 };
  return pool[Math.floor(rng.next() * pool.length)] || setup.starting[0];
}
function pickAerialMarker(setup, prng) {
  const candidates = setup.starting.filter(s => ['CB','CDM'].includes(s.slotPos));
  const pool = candidates.length ? candidates : setup.starting;
  const rng = prng || { next: () => 0.5 };
  return pool[Math.floor(rng.next() * pool.length)] || setup.starting[0];
}

/**
 * Free kick resolution.
 *   direct (within 25 yards): taker's FK accuracy vs wall + keeper
 *     xG: 0.04..0.12
 *   indirect / wide: treated as a cross with +10% delivery
 */
export function resolveFreeKick(prng, ctx, attackingTeam, distance) {
  const atkSetup = attackingTeam === 0 ? ctx.setup.home : ctx.setup.away;
  const defSetup = attackingTeam === 0 ? ctx.setup.away : ctx.setup.home;
  const taker = atkSetup.starting.find(s => ['CAM','LM','RM','LW','RW'].includes(s.slotPos)) || atkSetup.starting[5];

  if (distance <= 25) {
    // Direct free kick
    const fkAccuracy = (taker?.freeKickAccuracy || taker?.effRating || 70);
    const wallStrength = avgDefensiveRating(defSetup);
    const xg = clamp(0.04 + (fkAccuracy - wallStrength) / 500, 0.03, 0.14);
    return {
      outcome: 'shot', setPiece: true, setPieceType: 'freekick_direct',
      xg, shooter: taker,
      shotContext: { zone: 'edge', type: null, assistType: 'setPiece', pressure: 'open' }
    };
  } else {
    // Indirect / wide — treated as a cross with delivery bonus
    const target = pickAerialTarget(atkSetup, prng);
    const xg = clamp(0.10 + prng.next() * 0.08, 0.05, 0.20);
    return {
      outcome: 'shot', setPiece: true, setPieceType: 'freekick_wide',
      xg, shooter: target,
      shotContext: { zone: 'six_box', type: 'header', assistType: 'setPiece', pressure: 'light' }
    };
  }
}

function avgDefensiveRating(setup) {
  const defs = setup.starting.filter(s => ['CB','LB','RB','CDM'].includes(s.slotPos));
  if (!defs.length) return 70;
  return defs.reduce((a, s) => a + s.effRating, 0) / defs.length;
}

/**
 * Penalty kick resolution.
 *   base conversion: 76%
 *   elite taker +8%, elite keeper -6%, high-pressure (85'+ title decider) -5% for young players
 *   outcomes: goal, saved (keeper guesses right + reflex check), missed, post
 */
export function resolvePenalty(prng, ctx, attackingTeam, isHighPressure = false) {
  const atkSetup = attackingTeam === 0 ? ctx.setup.home : ctx.setup.away;
  const defSetup = attackingTeam === 0 ? ctx.setup.away : ctx.setup.home;
  const taker = atkSetup.starting.find(s => s.slotPos === 'ST' || s.slotPos === 'CAM') || atkSetup.starting[10];
  const keeper = defSetup.starting.find(s => s.slotPos === 'GK') || defSetup.starting[0];

  const takerSkill = taker?.finishing || taker?.effRating || 75;
  const keeperSkill = keeper?.reflexes || keeper?.effRating || 70;
  let goalP = 0.76;
  if (takerSkill >= 80) goalP += 0.08;
  if (keeperSkill >= 80) goalP -= 0.06;
  if (isHighPressure && (taker?.age || 25) < 24) goalP -= 0.05;
  goalP = clamp(goalP, 0.5, 0.92);

  if (prng.next() < goalP) {
    return { outcome: 'goal', setPiece: true, setPieceType: 'penalty', xg: 0.76, scorer: taker };
  }
  // Not a goal: saved (40%), missed (40%), post (20%)
  const r = prng.next();
  if (r < 0.40) {
    // Saved: keeper guessed right AND made reflex check
    return { outcome: 'save', setPiece: true, setPieceType: 'penalty', xg: 0.76, shooter: taker, goalkeeper: keeper };
  } else if (r < 0.80) {
    return { outcome: 'miss', setPiece: true, setPieceType: 'penalty', xg: 0.76, shooter: taker };
  } else {
    return { outcome: 'post', setPiece: true, setPieceType: 'penalty', xg: 0.76, shooter: taker };
  }
}

/**
 * Throw-in or goal kick. Returns a possession reset outcome.
 *   short: keeps possession
 *   long: 50/50 aerial duel in midfield
 */
export function resolveThrowOrGoalKick(prng, ctx, attackingTeam) {
  // Default: 70% short (keeps possession), 30% long (50/50)
  if (prng.next() < 0.70) {
    return { outcome: 'recycle', setPiece: false, possessionTeam: attackingTeam };
  } else {
    // 50/50 in midfield
    const winner = prng.next() < 0.5 ? attackingTeam : (1 - attackingTeam);
    return { outcome: 'recycle', setPiece: false, possessionTeam: winner };
  }
}
