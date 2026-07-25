// sim/match/ai.js
// AI in-match decision making. The opponent isn't passive — the AI manager
// makes tactical shifts, substitutions, and pressing-triggr decisions based
// on game state.
//
// Triggered every minute (cheaply) and at decision points (goals, red cards).

import { logger } from '../../core/logger.js';

/**
 * Decide AI manager actions for this minute. Returns a list of actions to
 * apply:
 *   { type: 'tactical_shift', payload: { mentality, formation } }
 *   { type: 'substitution', payload: { out, in, reason } }
 *   { type: 'pressing', payload: { intensity } }
 *   { type: 'time_waste', payload: { on: bool } }
 */
export function decideAIActions(ctx, side) {
  const actions = [];
  const aiClub = side === 0 ? ctx.setup.home : ctx.setup.away;
  const aiTactics = side === 0 ? ctx.tactics.home : ctx.tactics.away;
  const score = ctx.score;
  const minute = ctx.minute;
  const myGoals = side === 0 ? score.home : score.away;
  const oppGoals = side === 0 ? score.away : score.home;
  const isLosing = myGoals < oppGoals;
  const isWinning = myGoals > oppGoals;
  const isDrawing = myGoals === oppGoals;
  const isAway = side === 1;
  const personality = aiTactics?.personality || 'balanced';

  // ---- Tactical shifts ----
  if (isLosing && minute >= 60 && minute <= 80) {
    // Chase the game — but only once per match (avoid thrashing)
    if (!ctx._aiShifted?.[side]) {
      ctx._aiShifted = ctx._aiShifted || {};
      ctx._aiShifted[side] = true;
      actions.push({
        type: 'tactical_shift',
        payload: {
          mentality: 'attacking',
          pressing: 'high',
          width: 'wide',
          reason: 'chasing_equaliser'
        }
      });
    }
  } else if (isWinning && minute >= 70) {
    // Park the bus
    if (!ctx._aiParked?.[side]) {
      ctx._aiParked = ctx._aiParked || {};
      ctx._aiParked[side] = true;
      actions.push({
        type: 'tactical_shift',
        payload: {
          mentality: 'defensive',
          pressing: 'low',
          lineHeight: 'deep',
          reason: 'protect_lead'
        }
      });
      actions.push({ type: 'time_waste', payload: { on: true } });
    }
  } else if (isDrawing && isAway && minute >= 75) {
    // Settle for a point
    if (!ctx._aiSettled?.[side]) {
      ctx._aiSettled = ctx._aiSettled || {};
      ctx._aiSettled[side] = true;
      actions.push({
        type: 'tactical_shift',
        payload: {
          mentality: 'cautious',
          pressing: 'low',
          reason: 'settle_for_point'
        }
      });
    }
  }

  // ---- Substitutions ----
  // Fatigue-based: first player below 55% stamina gets hooked (60-70')
  if (minute >= 60 && minute <= 75) {
    const setup = side === 0 ? ctx.setup.home : ctx.setup.away;
    const tiredPlayer = setup.starting.find(s => (s.match?.stamina ?? 100) < 55 && !s.synthetic);
    if (tiredPlayer && setup.bench?.length > 0 && !ctx._aiSubbed?.[side]) {
      ctx._aiSubbed = ctx._aiSubbed || {};
      ctx._aiSubbed[side] = true;
      const sub = setup.bench[0];
      actions.push({
        type: 'substitution',
        payload: { out: tiredPlayer.playerId, in: sub.id, side, reason: 'fatigue' }
      });
    }
  }

  // Tactical sub: losing after 75' → attacking sub (ST for CM)
  if (isLosing && minute >= 75 && minute <= 85) {
    const setup = side === 0 ? ctx.setup.home : ctx.setup.away;
    if (setup.bench?.length > 0 && !ctx._aiAttSub?.[side]) {
      ctx._aiAttSub = ctx._aiAttSub || {};
      ctx._aiAttSub[side] = true;
      // Find a CM to take off
      const cm = setup.starting.find(s => s.slotPos === 'CM' && !s.synthetic);
      const st = setup.bench.find(p => p.pos === 'ST' || p.pos === 'CAM');
      if (cm && st) {
        actions.push({
          type: 'substitution',
          payload: { out: cm.playerId, in: st.id, side, reason: 'attacking' }
        });
      }
    }
  }

  // ---- Pressing triggers ----
  // AI presses higher when momentum is in their favour, drops when fatigued
  const myMomentum = side === 0 ? ctx.momentum.value : -ctx.momentum.value;
  if (myMomentum > 0.4 && !aiTactics?._aiPressed) {
    actions.push({ type: 'pressing', payload: { intensity: 'high', reason: 'momentum' } });
  } else if (myMomentum < -0.4 || minute > 80 && isWinning) {
    actions.push({ type: 'pressing', payload: { intensity: 'low', reason: 'fatigue_or_lead' } });
  }

  return actions;
}

/**
 * Apply an AI action to the match context. Mutates.
 */
export function applyAIAction(ctx, action, side) {
  const tacticsRef = side === 0 ? ctx.tactics.home : ctx.tactics.away;
  switch (action.type) {
    case 'tactical_shift':
      Object.assign(tacticsRef, action.payload);
      break;
    case 'substitution':
      // Swap player in starting array
      const setup = side === 0 ? ctx.setup.home : ctx.setup.away;
      const idx = setup.starting.findIndex(s => s.playerId === action.payload.out);
      if (idx >= 0) {
        const newPlayer = setup.bench.find(p => p.id === action.payload.in);
        if (newPlayer) {
          // Build a new starting slot entry from the bench player
          const slotPos = setup.starting[idx].slotPos;
          setup.starting[idx] = {
            playerId: newPlayer.id,
            slotIdx: idx,
            slotPos,
            oopPenalty: 0,
            effRating: newPlayer.ovr + ((newPlayer.form || 6) - 6) * 1.5,
            // Carry attributes for xG/shot
            finishing: newPlayer.ovr, composure: newPlayer.ovr,
            name: newPlayer.name,
            age: newPlayer.age,
            hidden: newPlayer.hidden,
            match: { stamina: 100, started: false, subbedIn: ctx.minute }
          };
          // Remove from bench
          setup.bench = setup.bench.filter(p => p.id !== action.payload.in);
        }
      }
      break;
    case 'pressing':
      tacticsRef.pressing = action.payload.intensity;
      break;
    case 'time_waste':
      ctx._timeWasting = ctx._timeWasting || {};
      ctx._timeWasting[side] = action.payload.on;
      break;
  }
}

/**
 * Immediate formation adjustment for a red card. Default: drop a striker
 * and add a defender (e.g. 4-4-2 → 4-4-1).
 */
export function adjustForRedCard(ctx, side) {
  // Simple: just decrement the formation's striker count visually.
  // The match engine doesn't care about formation shape beyond slot count.
  const tacticsRef = side === 0 ? ctx.tactics.home : ctx.tactics.away;
  tacticsRef.mentality = 'defensive';
  tacticsRef.pressing = 'low';
}
