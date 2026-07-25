// sim/transfers/player-agency.js
// Player agency & desire. Players are not cargo — they have preferences,
// and those preferences move deals.

import { clamp } from '../../core/prng.js';

/**
 * Compute a player's desire to move.
 * Returns a value 0..1 (0 = happy to stay, 1 = desperate to leave).
 *
 * Drivers:
 *   - Ambition vs club status (90-ambition player at non-European club → high)
 *   - Playing time vs expectation (Barlow's unrest is this, quantified)
 *   - Contract situation and wage relativities (Sosa sees peers earn more)
 *   - Loyalty and personality
 */
export function computeDesire(player, club, state) {
  let desire = 0.3;   // baseline

  // Ambition vs club status
  const amb = player.hidden?.ambition ?? 60;
  if (amb >= 80 && club.rep <= 3) desire += 0.25;
  else if (amb >= 70 && club.rep <= 2) desire += 0.20;

  // Playing time
  const expectedMins = player.role === 'Star Player' ? 0.85 :
                       player.role === 'Key Player' ? 0.70 :
                       player.role === 'First Team' ? 0.55 :
                       player.role === 'Rotation' ? 0.35 :
                       0.15;
  const actualMins = player.stats?.mins
    ? Math.min(1, player.stats.mins / (38 * 90))
    : 0;
  if (actualMins < expectedMins * 0.5) desire += 0.25;
  else if (actualMins < expectedMins * 0.7) desire += 0.10;

  // Wage relativities — Sosa sees peers earn more
  const squadAvgWage = club.squadIds?.length
    ? club.squadIds
        .map(id => state.entities.players.get(id)?.wage || 0)
        .reduce((a, b) => a + b, 0) / club.squadIds.length
    : player.wage;
  if (player.wage < squadAvgWage * 0.7 && player.ovr >= 78) desire += 0.15;

  // Contract situation
  const yearsLeft = (player.contractUntil || 2028) - (state.clock.seasonYear || 2026);
  if (yearsLeft <= 1 && !player._renewalOffered) desire += 0.15;

  // Loyalty resists moves
  const loy = player.pers?.loy ?? 60;
  desire -= (loy - 60) / 200;

  // Existing unrest flag (set by inbox decisions)
  if (player.unrest) desire += 0.20;

  return clamp(desire, 0, 1);
}

/**
 * Categorize a player's stance toward a specific move.
 * Returns 'wants_move' | 'indifferent' | 'wants_to_stay'.
 */
export function stanceOnMove(player, buyerClub, sellerClub, desire) {
  // If buyer is bigger/more prestigious, desire bumps up
  let effectiveDesire = desire;
  if (buyerClub.rep > sellerClub.rep) effectiveDesire += 0.15;
  if (buyerClub.rep < sellerClub.rep) effectiveDesire -= 0.20;

  if (effectiveDesire >= 0.65) return 'wants_move';
  if (effectiveDesire >= 0.35) return 'indifferent';
  return 'wants_to_stay';
}

/**
 * Player outcomes in a deal:
 *   wants_move — agrees personal terms fast, may push club to accept lower bid
 *   indifferent — pure wage/role negotiation
 *   wants_to_stay — rejects approach; must overpay massively on wages to tempt
 *
 * Returns a wage multiplier and a willingness to push seller.
 */
export function moveOutcome(stance) {
  switch (stance) {
    case 'wants_move':
      return { wageMult: 0.95, pushSeller: true, fastTerms: true };
    case 'indifferent':
      return { wageMult: 1.05, pushSeller: false, fastTerms: false };
    case 'wants_to_stay':
      return { wageMult: 1.30, pushSeller: false, fastTerms: false };
    default:
      return { wageMult: 1.0, pushSeller: false, fastTerms: false };
  }
}

/**
 * Escalation: mishandled players go unhappy → unsettled → formal transfer request.
 * A formal request forces the manager's hand.
 *
 * @returns {Object}  { stage, escalated }
 */
export function escalateUnrest(player, ctx = {}) {
  player.unrestStage = player.unrestStage || 0;
  // Each week of unresolved unhappiness → escalate
  if (ctx.trigger) {
    player.unrestStage++;
  }
  const stages = ['happy', 'unhappy', 'unsettled', 'formal_request'];
  const stage = stages[Math.min(player.unrestStage, 3)];
  return { stage, escalated: player.unrestStage > 0 };
}

/**
 * Apply a manager action (from inbox decision) to player unrest.
 */
export function applyUnrestAction(player, action) {
  switch (action) {
    case 'promise_minutes':
      player.unrest = false;
      player.unrestStage = 0;
      player._minutesPromised = true;
      break;
    case 'tell_to_earn':
      // Morale drops, unrest may rise
      player.mor = Math.max(0, (player.mor || 70) - 20);
      player.unrestStage = (player.unrestStage || 0) + 1;
      break;
    case 'transfer_list':
      player.listed = true;
      player.ask = player.val ? Math.round(player.val * 0.7) : 5e6;
      player.mor = Math.max(0, (player.mor || 70) - 30);
      player.unrestStage = 3;   // formal request equivalent
      break;
  }
}
