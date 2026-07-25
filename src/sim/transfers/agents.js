// sim/transfers/agents.js
// Agent behavior system. Agents are persistent characters with personalities
// that change how personal terms resolve.
//
// Personalities (from AGENTS seed data):
//   - Greedy (Ferreira) — opens 25-40% above market, demands annual renegotiation
//   - Aggressive (Raggi) — hard deadlines, press leaks, theatrical walk-aways
//   - Loyal (Byrne) — reasonable opening, values playing-time guarantees
//   - Patient (Okonkwo) — takes weeks, wants structured deals with release clauses
//   - Famous (Hansen) — massive commission (12%+), but represents elite talent

import { clamp } from '../../core/prng.js';

export const AGENT_PERSONALITIES = Object.freeze({
  Greedy: {
    openingMult: 1.35,       // opens 35% above market wage
    patience: 4,             // max negotiation rounds
    commissionPct: 0.10,
    annualRenegotiation: true,
    pressureTactics: ['phantom_rival']
  },
  Aggressive: {
    openingMult: 1.20,
    patience: 2,              // hard deadlines
    commissionPct: 0.08,
    pressureTactics: ['press_leak', 'walk_away']
  },
  Loyal: {
    openingMult: 1.05,
    patience: 6,
    commissionPct: 0.06,
    valuesPlayingTime: true
  },
  Patient: {
    openingMult: 1.10,
    patience: 8,
    commissionPct: 0.07,
    wantsReleaseClause: true
  },
  Famous: {
    openingMult: 1.25,
    patience: 5,
    commissionPct: 0.12,      // massive commission
    representsElite: true
  },
  Unknown: {
    openingMult: 1.10,
    patience: 4,
    commissionPct: 0.08
  }
});

/**
 * Look up the agent's personality profile.
 */
export function agentProfile(agent) {
  return AGENT_PERSONALITIES[agent?.pers] || AGENT_PERSONALITIES.Unknown;
}

/**
 * Compute the agent's opening wage ask in a personal-terms negotiation.
 *
 * @param {Object} agent
 * @param {number} marketWage  the player's market wage
 * @returns {number}
 */
export function openingWageAsk(agent, marketWage) {
  const prof = agentProfile(agent);
  return Math.round(marketWage * prof.openingMult);
}

/**
 * Compute the agent's commission on a transfer fee.
 */
export function computeCommission(agent, transferFee) {
  const prof = agentProfile(agent);
  return Math.round(transferFee * prof.commissionPct);
}

/**
 * Decide whether the agent accepts the club's wage offer this round.
 * Returns { accept, counterWage, patienceDelta }.
 *
 * @param {Object} agent
 * @param {number} clubOffer   wage offered
 * @param {number} marketWage  the player's true market wage
 * @param {Object} ctx  { round, maxRounds, prng, playerDesire, deadlineDay }
 */
export function evaluateWageOffer(agent, clubOffer, marketWage, ctx = {}) {
  const prof = agentProfile(agent);
  const prng = ctx.prng || { next: () => 0.5 };
  const round = ctx.round || 1;
  const maxRounds = ctx.deadlineDay ? Math.min(2, prof.patience) : prof.patience;

  // Distance from market: how far below market is the offer?
  const ratio = clubOffer / marketWage;

  // Patience decays with each round
  const patienceRemaining = maxRounds - round + 1;
  if (patienceRemaining <= 0) {
    // Out of patience — final decision
    if (ratio >= 0.95) return { accept: true, counterWage: null, patienceDelta: -1 };
    return { accept: false, counterWage: null, patienceDelta: -1, reason: 'walked_away' };
  }

  // Greedy agents hold out longer
  const acceptThreshold = prof === AGENT_PERSONALITIES.Greedy ? 1.15 :
                          prof === AGENT_PERSONALITIES.Famous ? 1.10 :
                          0.95;

  if (ratio >= acceptThreshold) {
    return { accept: true, counterWage: null, patienceDelta: 0 };
  }

  // Counter-offer: between club offer and market wage, weighted toward market
  const counterWage = Math.round(clubOffer + (marketWage * prof.openingMult - clubOffer) * 0.5);
  return { accept: false, counterWage, patienceDelta: -1 };
}

/**
 * Agent memory — track how the user club treats their clients.
 *   - Pay fairly → future negotiations warmer
 *   - Lowball or break promises → all of agent's clients harder to sign
 *
 * @returns {Object} updated relationship score
 */
export function updateAgentMemory(agent, event, ctx = {}) {
  const memory = agent.memory || { warmth: 50, lastEvent: null };
  let warmth = memory.warmth;
  switch (event) {
    case 'fair_deal':          warmth = clamp(warmth + 5, 0, 100); break;
    case 'lowball':            warmth = clamp(warmth - 10, 0, 100); break;
    case 'broken_promise':     warmth = clamp(warmth - 20, 0, 100); break;
    case 'renewal_smooth':     warmth = clamp(warmth + 8, 0, 100); break;
    case 'client_unhappy':     warmth = clamp(warmth - 6, 0, 100); break;
  }
  return { warmth, lastEvent: event, lastEventDate: ctx.date };
}

/**
 * Apply agent memory warmth to a future negotiation's opening ask.
 * Warm agents (70+) reduce the opening by up to 10%.
 * Cold agents (30-) inflate the opening by up to 20%.
 */
export function warmthModifier(agent) {
  const warmth = agent.memory?.warmth ?? 50;
  if (warmth >= 70) return 0.92;
  if (warmth >= 50) return 1.0;
  if (warmth >= 30) return 1.10;
  return 1.20;
}
