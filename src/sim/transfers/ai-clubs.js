// sim/transfers/ai-clubs.js
// AI club behavior. The other 17 clubs in your division — and every club
// in every league — run their own transfer logic every day. You are not
// the protagonist of the market; you're one buyer among many.

import { clamp } from '../../core/prng.js';
import { computeTrueValue } from './valuation.js';
import { createNegotiation, submitBid, evaluateBid } from './negotiation.js';
import { EVT } from '../../core/eventBus.js';
import {
  addTransaction,
  processAgentFeeOnSigning,
  registerAmortization,
  writeOffAmortizationOnSale
} from '../finance/engine.js';

/**
 * Recruit identities for AI clubs.
 *   - developer: buys 17-21, sells at 26
 *   - contender: buys 24-28 ready-made
 *   - opportunist: loans, free agents, distress sales
 */
export const RECRUITMENT_IDENTITIES = Object.freeze({
  DEVELOPER: 'developer',
  CONTENDER: 'contender',
  OPPORTUNIST: 'opportunist'
});

/**
 * Assign a recruitment identity to each AI club based on rep + budget.
 */
export function deriveRecruitmentIdentity(club) {
  if (club.rep >= 5 && club.budget >= 50e6) return RECRUITMENT_IDENTITIES.CONTENDER;
  if (club.rep <= 2 && club.budget < 15e6) return RECRUITMENT_IDENTITIES.OPPORTUNIST;
  return RECRUITMENT_IDENTITIES.DEVELOPER;
}

/**
 * Assess an AI club's squad needs.
 * Returns a list of needs with urgency weights.
 *
 * Need types:
 *   - position_no_quality_starter (no player at this position with OVR >= club.atk-3 or def-3)
 *   - aging_starter (29+ in a pace role)
 *   - thin_depth (fewer than 2 senior options)
 *   - contract_run_down (under 18 months)
 */
export function assessSquadNeeds(state, club) {
  const needs = [];
  const squad = (club.squadIds || [])
    .map(id => state.entities.players.get(id))
    .filter(Boolean);

  // Group by position
  const byPos = {};
  for (const p of squad) {
    byPos[p.pos] = byPos[p.pos] || [];
    byPos[p.pos].push(p);
  }

  // Check each position group for needs
  const positionsToCheck = ['GK','CB','LB','RB','CDM','CM','CAM','LW','RW','ST'];
  const threshold = club.def - 3;
  for (const pos of positionsToCheck) {
    const players = byPos[pos] || [];
    const hasStarter = players.some(p => p.ovr >= threshold && !p.inj);
    if (!hasStarter) {
      needs.push({ kind: 'no_starter', pos, urgency: 0.9 });
    }
    // Thin depth
    if (players.length < 2) {
      needs.push({ kind: 'thin_depth', pos, urgency: 0.6 });
    }
    // Aging starter
    const agingStarter = players.find(p => p.age >= 29 && p.ovr >= threshold);
    if (agingStarter) {
      needs.push({ kind: 'aging_starter', pos, urgency: 0.5, playerId: agingStarter.id });
    }
    // Contract run-down
    const expiring = players.find(p => (p.contractUntil || 2028) - (state.clock.seasonYear || 2026) <= 1);
    if (expiring) {
      needs.push({ kind: 'contract_run_down', pos, urgency: 0.7, playerId: expiring.id });
    }
  }

  return needs;
}

/**
 * Shortlist targets for an AI club given its needs and budget.
 *
 * @returns {Array}  list of target players with fit scores
 */
export function shortlistTargets(state, club, needs, opts = {}) {
  const targets = [];
  const budget = club.budget;
  const identity = deriveRecruitmentIdentity(club);
  const wageCeiling = club.wageCeiling;

  // Pull from the same global player pool: all players in state
  // (excluding the club's own squad)
  const ownSquad = new Set(club.squadIds || []);
  for (const player of state.entities.players.values()) {
    if (ownSquad.has(player.id)) continue;
    if (player.inj) continue;

    // Match to a need
    const matchingNeeds = needs.filter(n => n.pos === player.pos);
    if (!matchingNeeds.length) continue;

    // Compute value
    const value = computeTrueValue(player, {
      yearsRemaining: (player.contractUntil || 2028) - (state.clock.seasonYear || 2026),
      currentYear: state.clock.seasonYear || 2026,
      worldEcon: state.worldEcon
    });

    // Budget filter
    if (value > budget) continue;
    // Wage filter
    if (player.wage > wageCeiling * 0.8) continue;

    // Identity filter
    if (identity === RECRUITMENT_IDENTITIES.DEVELOPER && player.age > 23) continue;
    if (identity === RECRUITMENT_IDENTITIES.CONTENDER && (player.age < 22 || player.age > 29)) continue;
    if (identity === RECRUITMENT_IDENTITIES.OPPORTUNIST && value > budget * 0.5) continue;

    // Fit score: urgency × value-for-money × age fit
    const urgency = Math.max(...matchingNeeds.map(n => n.urgency));
    const ageFit = identity === RECRUITMENT_IDENTITIES.DEVELOPER ? (player.age <= 21 ? 1.2 : 0.8) :
                   identity === RECRUITMENT_IDENTITIES.CONTENDER ? (player.age >= 24 && player.age <= 28 ? 1.2 : 0.8) :
                   1.0;
    const valueForMoney = clamp(0.5 + (budget * 0.6 - value) / (budget * 0.6), 0.5, 1.5);
    const fit = urgency * ageFit * valueForMoney;

    targets.push({ player, value, fit, matchingNeed: matchingNeeds[0] });
  }

  // Sort by fit, return top 10
  targets.sort((a, b) => b.fit - a.fit);
  return targets.slice(0, 10);
}

/**
 * AI club decides to bid on a target. Returns the bid structure.
 */
export function aiBid(club, target, opts = {}) {
  const prng = opts.prng || { next: () => 0.5 };
  const identity = deriveRecruitmentIdentity(club);
  // Opening bid: 80-95% of value
  const openingRatio = identity === RECRUITMENT_IDENTITIES.DEVELOPER ? 0.85 :
                       identity === RECRUITMENT_IDENTITIES.CONTENDER ? 0.90 :
                       0.75;
  const cash = Math.round(target.value * openingRatio * (0.95 + prng.next() * 0.1));
  // Developers love sell-ons; contenders want cash
  const sellOnPct = identity === RECRUITMENT_IDENTITIES.DEVELOPER ? 15 : 5;
  const addons = Math.round(target.value * 0.05);
  return { cash, addons, sellOnPct, loanFee: 0, obligation: false };
}

/**
 * Run the AI transfer market for one tick (one day).
 * Each AI club assesses needs, shortlists targets, and may submit bids.
 * AI-vs-AI deals complete silently and update the activity feed.
 *
 * @returns {Array}  events to emit (TRANSFERS_ACTIVITY entries)
 */
export function runAITransferMarket(state, opts = {}) {
  const events = [];
  const prng = opts.prng || { next: () => 0.5 };

  for (const club of state.entities.clubs.values()) {
    if (club.id === state.meta.userClubId) continue;   // skip user
    if (prng.next() > 0.10) continue;                   // 10% chance per day per club

    const needs = assessSquadNeeds(state, club);
    if (!needs.length) continue;

    const targets = shortlistTargets(state, club, needs, { prng });
    if (!targets.length) continue;

    // Pick the top target
    const target = targets[0];
    const sellerClub = findOwningClub(state, target.player.id);
    if (!sellerClub || sellerClub.id === club.id) continue;

    // Create negotiation and submit bid
    const neg = createNegotiation({
      state, buyerClubId: club.id, sellerClubId: sellerClub.id,
      playerId: target.player.id, deadlineDay: opts.deadlineDay
    });
    if (!neg) continue;

    submitBid(neg, aiBid(club, target, { prng }));
    const result = evaluateBid(neg, { prng, rivalBids: false });

    if (result.state === 'ACCEPTED') {
      // Personal terms — simplified AI vs AI: auto-agree on market wage
      neg.state = 'PERSONAL_TERMS';
      neg.wageOffer = target.player.wage * 1.1;   // small bump
      neg.state = 'AGREED';
      // Medical — simplified
      const proneness = target.player.hidden?.injuryProneness ?? 0.5;
      if (prng.next() < 0.02 + proneness * 0.06) {
        neg.state = 'COLLAPSED';
        neg.collapseReason = 'medical_failed';
        continue;
      }
      // ANNOUNCED — execute the transfer
      neg.state = 'ANNOUNCED';
      neg.completedAt = state.clock.date;
      executeTransfer(state, neg);
      // Add to activity feed
      state.activity = state.activity || [];
      state.activity.unshift({
        d: state.clock.date,
        p: target.player.name,
        f: sellerClub.code,
        t: club.code,
        fee: neg.currentBid.cash,
        ty: 'Permanent'
      });
      state.activity = state.activity.slice(0, 30);
      events.push({ type: EVT.STATE_BATCH, payload: {
        panel: 'transfers', transfer: { player: target.player.name, from: sellerClub.code, to: club.code, fee: neg.currentBid.cash }
      }});
    }
  }

  return events;
}

/**
 * Find the club that owns a given player.
 */
export function findOwningClub(state, playerId) {
  for (const club of state.entities.clubs.values()) {
    if (club.squadIds?.includes(playerId)) return club;
  }
  return null;
}

/**
 * Execute a completed transfer — move the player from seller to buyer,
 * deduct budget, add to squad, etc.
 */
export function executeTransfer(state, negotiation) {
  const player = state.entities.players.get(negotiation.playerId);
  const buyer = state.entities.clubs.get(negotiation.buyerClubId);
  const seller = state.entities.clubs.get(negotiation.sellerClubId);
  if (!player || !buyer || !seller) return;

  // Move player
  seller.squadIds = (seller.squadIds || []).filter(id => id !== player.id);
  buyer.squadIds = buyer.squadIds || [];
  buyer.squadIds.push(player.id);

  // Budget transfer
  const fee = negotiation.currentBid?.cash || 0;
  buyer.budget -= fee;
  buyer.balance -= fee;
  seller.budget += fee;
  seller.balance += fee;

  // Update contract
  player.wage = negotiation.wageOffer || player.wage;
  player.contractUntil = (state.clock.seasonYear || 2026) + 4;

  // Log transaction using the Step 5 Financial Engine
  if (negotiation.buyerClubId === state.meta.userClubId) {
    // 1. Process transfer fee cash out
    addTransaction(state, -fee, 'transfer_out', `Transfer fee paid to sign ${player.name}`);
    state.finance.transferBudget -= fee;

    // 2. Process agent commission fee (e.g. 8% commission)
    processAgentFeeOnSigning(state, player, fee, 8);

    // 3. Register transfer amortization schedule
    registerAmortization(state, player, fee, 5);

    // 4. Check if marquee signing global merchandise boost is unlocked
    if (player.ovr >= 82) {
      state.finance.marqueeSigningBoost = true;
      logger.info('finance', 'marquee signing global merchandise boost activated', { player: player.name });
    }
  } else if (negotiation.sellerClubId === state.meta.userClubId) {
    // 1. Process transfer fee cash in
    addTransaction(state, fee, 'transfer_in', `Transfer fee received for sale of ${player.name}`);
    state.finance.transferBudget += fee;

    // 2. Book unamortized write-off and disposal profit/loss
    const disposal = writeOffAmortizationOnSale(state, player, fee);
    logger.info('finance', 'disposal booked', disposal);

    // 3. Sell-on clause trigger (if ex-club has a sell-on clause, e.g. 10%)
    const sellOnPct = negotiation.currentBid?.sellOnPct || 10;
    const sellOnGain = Math.round(fee * (sellOnPct / 100));
    if (sellOnGain > 0) {
      addTransaction(state, sellOnGain, 'transfer_in', `Sell-on clause profit for ex-club disposal of ${player.name} (${sellOnPct}%)`);
    }
  }
}
