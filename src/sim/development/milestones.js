// sim/development/milestones.js
// Development milestones & narrative beats.
// Growth must be visible and celebrated, or it's just numbers ticking.

import { EVT } from '../../core/eventBus.js';
import { clamp } from '../../core/prng.js';

/**
 * Check a player for milestone triggers after a match or growth tick.
 * Returns events to emit.
 *
 * @param {Object} player  the player entity (post-match, post-growth)
 * @param {Object} ctx  { matchStats, wasMOTM, isFirstStart, isFirstGoal, ... }
 * @returns {Array<{type, payload}>}
 */
export function checkMilestones(player, ctx = {}) {
  const events = [];
  const milestones = [];

  if (ctx.isFirstStart) {
    milestones.push({ kind: 'first_start', label: 'First senior start', playerId: player.id, playerName: player.name });
  }
  if (ctx.isFirstGoal) {
    milestones.push({ kind: 'first_goal', label: 'First senior goal', playerId: player.id, playerName: player.name });
  }
  if (ctx.isFirstAssist) {
    milestones.push({ kind: 'first_assist', label: 'First senior assist', playerId: player.id, playerName: player.name });
  }
  if (ctx.isFirst90) {
    milestones.push({ kind: 'first_90', label: 'First full 90 minutes', playerId: player.id, playerName: player.name });
  }
  if (ctx.wasMOTM && player.age <= 21 && ctx.isBigMatch) {
    milestones.push({ kind: 'big_match_motm', label: 'Big-match MOTM at 21 or younger', playerId: player.id, playerName: player.name });
  }

  // OVR tier crossings
  if (ctx.oldOvr != null && ctx.newOvr != null) {
    if (ctx.oldOvr < 70 && ctx.newOvr >= 70) {
      milestones.push({ kind: 'ovr_70', label: 'Reached 70 overall', playerId: player.id, playerName: player.name });
    }
    if (ctx.oldOvr < 75 && ctx.newOvr >= 75) {
      milestones.push({ kind: 'ovr_75', label: 'Reached 75 overall', playerId: player.id, playerName: player.name });
    }
    if (ctx.oldOvr < 80 && ctx.newOvr >= 80) {
      milestones.push({ kind: 'ovr_80', label: 'Reached 80 overall — elite tier', playerId: player.id, playerName: player.name });
    }
    if (ctx.oldOvr < 85 && ctx.newOvr >= 85) {
      milestones.push({ kind: 'ovr_85', label: 'Reached 85 overall — world-class', playerId: player.id, playerName: player.name });
    }
  }

  // International call-up (rare, requires high form + reputation)
  if (ctx.form >= 8.0 && player.ovr >= 75 && player.age <= 28 && !player.international) {
    if (Math.random() < 0.05) {  // 5% chance per check
      player.international = true;
      milestones.push({ kind: 'international_callup', label: 'First international call-up', playerId: player.id, playerName: player.name });
    }
  }

  // Wonderkid confirmed — effective PA resolves into top band
  if (player.effectivePA >= 85 && !player._wonderkidConfirmed && player.age <= 21) {
    player._wonderkidConfirmed = true;
    milestones.push({ kind: 'wonderkid', label: 'Wonderkid confirmed — elite potential', playerId: player.id, playerName: player.name });
  }

  for (const m of milestones) {
    player.milestones = player.milestones || [];
    player.milestones.push({ ...m, date: ctx.date });
    events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad', milestone: m.kind, ...m }});
  }

  return events;
}

/**
 * Quarterly development report card from the academy director.
 * Returns a per-prospect summary with trajectory, recommendation, and risk flag.
 *
 * @param {Array} prospects  list of player entities (U21 or flagged as prospects)
 * @returns {Array}  report cards
 */
export function generateReportCards(prospects) {
  return prospects.map(p => {
    const recentForm = (p.formHist || []).slice(-6);
    const avgForm = recentForm.length ? recentForm.reduce((a, b) => a + b, 0) / recentForm.length : 6.5;
    const minutesPct = p.stats?.apps ? Math.min(1, p.stats.mins / (p.stats.apps * 90 * 10)) : 0;
    const trajectory = avgForm > 7.0 ? 'accelerating' :
                       avgForm < 5.5 ? 'stalling' :
                       minutesPct < 0.25 ? 'stagnating' :
                       'steady';
    const recommendation =
      trajectory === 'stalling' ? 'patience' :
      trajectory === 'stagnating' ? 'loan' :
      minutesPct > 0.5 ? 'integrate' :
      'rotate';
    const risk =
      p.fit < 60 ? 'burnout' :
      minutesPct < 0.15 && p.age >= 19 ? 'stagnation' :
      p.unrest ? 'homesickness' : null;

    return {
      playerId: p.id, playerName: p.name,
      trajectory, recommendation, risk,
      avgForm: +avgForm.toFixed(2),
      minutesPct: +minutesPct.toFixed(2),
      age: p.age, ovr: p.ovr, effectivePA: p.effectivePA || p.pot
    };
  });
}

/**
 * Stagnation intervention event. A prospect with <25% minutes for 8+ weeks
 * gets a decision event.
 */
export function checkStagnation(prospect, weeksSinceLastStart = 0) {
  if (prospect.age > 22) return null;
  if (weeksSinceLastStart < 8) return null;
  return {
    kind: 'stagnation_intervention',
    playerId: prospect.id,
    playerName: prospect.name,
    choices: [
      { label: 'LOAN OUT', note: 'Minutes elsewhere, less control' },
      { label: 'PLAY IN CUPS', note: 'Controlled minutes, slower development' },
      { label: 'SELL', note: 'Recoup value before he stalls' }
    ]
  };
}
