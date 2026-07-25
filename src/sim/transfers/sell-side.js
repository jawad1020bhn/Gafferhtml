// sim/transfers/sell-side.js
// The sell side: defending your assets.
//   - Incoming bids from AI clubs on your players
//   - Bid-response options: reject, counter, accept, stall
//   - Replacement planning warnings
//   - Sell-high discipline (decline flag → sell at value)

import { clamp } from '../../core/prng.js';
import { computeTrueValue, computeAskingPrice } from './valuation.js';
import { computeDesire } from './player-agency.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Generate incoming bids on the user's players from AI clubs.
 * Called daily during transfer windows.
 *
 * @returns {Array}  events + new incoming bids
 */
export function generateIncomingBids(state, opts = {}) {
  const events = [];
  const prng = opts.prng || { next: () => 0.5 };
  const userId = state.meta.userClubId;
  const userClub = state.entities.clubs.get(userId);
  if (!userClub) return events;

  // For each user player, compute attractiveness to other clubs
  for (const playerId of userClub.squadIds || []) {
    const player = state.entities.players.get(playerId);
    if (!player) continue;
    if (player.inj) continue;

    // Probability of an incoming bid today
    const form = player.form || 6.5;
    const formBoost = (form - 6.5) * 0.02;   // hot streak → more approaches
    const bidChance = 0.005 + formBoost;
    if (prng.next() > bidChance) continue;

    // Find an interested AI club
    const interestedClubs = [...state.entities.clubs.values()].filter(c =>
      c.id !== userId &&
      c.budget >= (player.val || 10e6) &&
      c.budget <= userClub.budget * 3   // not absurdly richer
    );
    if (!interestedClubs.length) continue;

    const buyerClub = prng.pick(interestedClubs);
    const trueValue = computeTrueValue(player, {
      yearsRemaining: (player.contractUntil || 2028) - (state.clock.seasonYear || 2026),
      currentYear: state.clock.seasonYear || 2026,
      worldEcon: state.worldEcon
    });
    const askingPrice = computeAskingPrice(trueValue, 0.7);   // assume moderate willingness
    // Opening bid: 80-95% of asking price
    const openingBid = Math.round(askingPrice * (0.80 + prng.next() * 0.15));

    const bid = {
      id: 'bid_' + Date.now() + '_' + Math.floor(prng.next() * 1e4),
      buyerClubId: buyerClub.id,
      sellerClubId: userId,
      playerId,
      amount: openingBid,
      addons: Math.round(openingBid * 0.05),
      sellOnPct: 0,
      submittedAt: state.clock.date,
      state: 'PENDING',   // PENDING | ACCEPTED | REJECTED | COUNTERED | STALLED | EXPIRED
      expiresAt: addDays(state.clock.date, 3)
    };
    state.incomingBids = state.incomingBids || [];
    state.incomingBids.push(bid);

    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'transfers', incoming_bid: true, player: player.name, club: buyerClub.code, amount: openingBid
    }});
  }

  return events;
}

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * User responds to an incoming bid.
 *   action: 'accept' | 'reject' | 'counter' | 'stall'
 */
export function respondToBid(state, bidId, action, opts = {}) {
  const bid = (state.incomingBids || []).find(b => b.id === bidId);
  if (!bid) return null;
  const player = state.entities.players.get(bid.playerId);
  if (!player) return null;
  const buyerClub = state.entities.clubs.get(bid.buyerClubId);

  switch (action) {
    case 'accept':
      bid.state = 'ACCEPTED';
      // Check replacement planning
      const userId = state.meta.userClubId;
      const userClub = state.entities.clubs.get(userId);
      const replacementWarning = checkReplacementNeed(state, userClub, player);
      return { state: 'ACCEPTED', bid, replacementWarning };

    case 'reject':
      bid.state = 'REJECTED';
      // Player may agitate if he wanted the move
      const desire = computeDesire(player, state.entities.clubs.get(bid.sellerClubId), state);
      if (desire > 0.6) {
        player.unrest = true;
        player.unrestStage = (player.unrestStage || 0) + 1;
      }
      return { state: 'REJECTED', bid };

    case 'counter':
      bid.state = 'COUNTERED';
      const counterAmount = opts.counterAmount || Math.round(bid.amount * 1.15);
      bid.counterAmount = counterAmount;
      return { state: 'COUNTERED', bid, counterAmount };

    case 'stall':
      bid.state = 'STALLED';
      bid.stalledAt = state.clock.date;
      return { state: 'STALLED', bid };
  }
}

/**
 * Check if selling this player creates a hole the user can't fill.
 */
export function checkReplacementNeed(state, club, player) {
  const squad = (club.squadIds || []).map(id => state.entities.players.get(id)).filter(Boolean);
  const samePosPlayers = squad.filter(p => p.pos === player.pos && p.id !== player.id);
  if (samePosPlayers.length === 0) {
    return { warning: 'no_replacement', position: player.pos, severity: 'high' };
  }
  const adequate = samePosPlayers.filter(p => p.ovr >= player.ovr - 5);
  if (!adequate.length) {
    return { warning: 'inadequate_replacement', position: player.pos, severity: 'medium' };
  }
  return null;
}

/**
 * Expire old pending bids.
 */
export function expireOldBids(state) {
  if (!state.incomingBids) return;
  state.incomingBids = state.incomingBids.filter(b => {
    if (b.state !== 'PENDING') return true;
    if (state.clock.date > b.expiresAt) {
      b.state = 'EXPIRED';
      return false;
    }
    return true;
  });
}
