// sim/transfers/negotiation.js
// The negotiation state machine. Every transfer is a finite state machine
// with real branching, walk-away points, and collapse risk.
//
// States:
//   IDLE → ENQUIRY → BID_SUBMITTED → ACCEPTED | COUNTER_OFFERED | REJECTED | WITHDRAWN
//   COUNTER_OFFERED → ACCEPT | COUNTER_BACK | WITHDRAW
//   ACCEPTED → PERSONAL_TERMS → AGREED | COLLAPSED
//   AGREED → MEDICAL → ANNOUNCED

import { clamp } from '../../core/prng.js';
import { computeTrueValue, computeAskingPrice, scoutedValueRange, computeWageAsk } from './valuation.js';
import { agentProfile, openingWageAsk, evaluateWageOffer, warmthModifier } from './agents.js';

export const NEGOTIATION_STATES = Object.freeze({
  IDLE: 'IDLE',
  ENQUIRY: 'ENQUIRY',
  BID_SUBMITTED: 'BID_SUBMITTED',
  COUNTER_OFFERED: 'COUNTER_OFFERED',
  ACCEPTED: 'ACCEPTED',              // club-to-club terms accepted
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
  PERSONAL_TERMS: 'PERSONAL_TERMS',
  AGREED: 'AGREED',                  // personal terms agreed
  COLLAPSED: 'COLLAPSED',
  MEDICAL: 'MEDICAL',
  ANNOUNCED: 'ANNOUNCED'
});

/**
 * Create a new negotiation record.
 *
 * @param {Object} opts  { buyerClubId, sellerClubId, playerId, prng, deadlineDay }
 */
export function createNegotiation(opts = {}) {
  const { state, buyerClubId, sellerClubId, playerId, deadlineDay = false } = opts;
  const player = state.entities.players.get(playerId);
  const sellerClub = state.entities.clubs.get(sellerClubId);
  const buyerClub = state.entities.clubs.get(buyerClubId);
  if (!player || !sellerClub || !buyerClub) return null;

  // Compute true value (engine-internal) and asking price
  const trueValue = computeTrueValue(player, {
    yearsRemaining: (player.contractUntil || 2028) - (state.clock.seasonYear || 2026),
    currentYear: state.clock.seasonYear || 2026,
    worldEcon: state.worldEcon,
    sellingLeagueRep: 0.85
  });
  const willingnessToSell = computeWillingnessToSell(player, sellerClub, state);
  const askingPrice = computeAskingPrice(trueValue, willingnessToSell);
  const marketWage = computeWageAsk(player, buyerClub);

  return {
    id: 'neg_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    buyerClubId,
    sellerClubId,
    playerId,
    createdAt: state.clock.date,
    deadlineDay,
    state: NEGOTIATION_STATES.IDLE,
    rounds: 0,
    maxRounds: deadlineDay ? 2 : 4,
    trueValue,
    askingPrice,
    currentBid: null,
    currentCounter: null,
    marketWage,
    wageOffer: null,
    agentId: null,             // set when entering PERSONAL_TERMS
    patience: 100,             // 0..100
    structure: { cash: 0, addons: 0, sellOnPct: 0, loanFee: 0, obligation: false },
    log: [],
    completedAt: null,
    collapseReason: null
  };
}

/**
 * Compute the seller club's willingness to sell (0..1).
 *   - Player wants out → higher
 *   - Contract running down → higher
 *   - Club needs funds → higher
 *   - Player is key → lower
 */
function computeWillingnessToSell(player, club, state) {
  let w = 0.5;
  if (player.unrest) w += 0.2;
  const yearsLeft = (player.contractUntil || 2028) - (state.clock.seasonYear || 2026);
  if (yearsLeft <= 1) w += 0.2;
  else if (yearsLeft <= 2) w += 0.1;
  else if (yearsLeft >= 4) w -= 0.15;
  if (club._needsFunds) w += 0.2;
  if (player.role === 'Star Player' || player.role === 'Key Player') w -= 0.15;
  return clamp(w, 0.1, 0.9);
}

/**
 * Submit a bid. Returns the new negotiation state.
 *
 * @param {Object} negotiation
 * @param {Object} bid  { cash, addons, sellOnPct, loanFee, obligation }
 */
export function submitBid(negotiation, bid) {
  negotiation.currentBid = bid;
  negotiation.state = NEGOTIATION_STATES.BID_SUBMITTED;
  negotiation.rounds++;
  negotiation.log.push({ round: negotiation.rounds, action: 'bid_submitted', bid });
  return negotiation;
}

/**
 * Seller evaluates the current bid. Returns the next state + counter if any.
 *
 * @returns {Object}  { state, counter, reason }
 */
export function evaluateBid(negotiation, ctx = {}) {
  const prng = ctx.prng || { next: () => 0.5 };
  const bid = negotiation.currentBid;
  if (!bid) return { state: NEGOTIATION_STATES.IDLE };

  const totalValue = (bid.cash || 0) + (bid.addons || 0) + (bid.loanFee || 0);
  const ratio = totalValue / negotiation.askingPrice;

  // Rival bids raise the floor
  const rivalMultiplier = ctx.rivalBids ? 1.10 : 1.0;
  const effectiveRatio = ratio / rivalMultiplier;

  // Acceptance probability driven by ratio
  // ratio >= 1.0 → accept
  // ratio >= 0.85 → counter
  // ratio < 0.85 → reject (but may counter if patience high)
  if (effectiveRatio >= 1.0) {
    negotiation.state = NEGOTIATION_STATES.ACCEPTED;
    negotiation.log.push({ round: negotiation.rounds, action: 'accepted', ratio });
    return { state: NEGOTIATION_STATES.ACCEPTED, reason: 'accepted' };
  }
  if (effectiveRatio >= 0.85) {
    // Counter-offer
    const counter = {
      cash: Math.round(negotiation.askingPrice * 0.95),
      addons: Math.round(negotiation.askingPrice * 0.05),
      sellOnPct: 10
    };
    negotiation.currentCounter = counter;
    negotiation.state = NEGOTIATION_STATES.COUNTER_OFFERED;
    negotiation.patience -= 20;
    negotiation.log.push({ round: negotiation.rounds, action: 'countered', counter, ratio });
    return { state: NEGOTIATION_STATES.COUNTER_OFFERED, counter, reason: 'countered' };
  }
  if (negotiation.patience > 30 && effectiveRatio >= 0.7) {
    // Counter with higher ask
    const counter = {
      cash: Math.round(negotiation.askingPrice * 1.0),
      addons: 0,
      sellOnPct: 15
    };
    negotiation.currentCounter = counter;
    negotiation.state = NEGOTIATION_STATES.COUNTER_OFFERED;
    negotiation.patience -= 30;
    negotiation.log.push({ round: negotiation.rounds, action: 'countered_higher', counter, ratio });
    return { state: NEGOTIATION_STATES.COUNTER_OFFERED, counter, reason: 'countered_higher' };
  }
  // Reject
  negotiation.state = NEGOTIATION_STATES.REJECTED;
  negotiation.log.push({ round: negotiation.rounds, action: 'rejected', ratio });
  return { state: NEGOTIATION_STATES.REJECTED, reason: 'rejected' };
}

/**
 * Buyer accepts the seller's counter.
 */
export function acceptCounter(negotiation) {
  negotiation.currentBid = { ...negotiation.currentCounter };
  negotiation.state = NEGOTIATION_STATES.ACCEPTED;
  negotiation.log.push({ round: negotiation.rounds, action: 'accepted_counter' });
  return negotiation;
}

/**
 * Buyer withdraws.
 */
export function withdraw(negotiation) {
  negotiation.state = NEGOTIATION_STATES.WITHDRAWN;
  negotiation.completedAt = 'now';
  negotiation.collapseReason = 'buyer_withdrew';
  negotiation.log.push({ round: negotiation.rounds, action: 'withdrawn' });
  return negotiation;
}

/**
 * Enter personal-terms negotiation with the player's agent.
 */
export function enterPersonalTerms(negotiation, agent) {
  negotiation.state = NEGOTIATION_STATES.PERSONAL_TERMS;
  negotiation.agentId = agent.id;
  // Apply warmth modifier from agent memory
  const warmthMult = warmthModifier(agent);
  negotiation.wageAsk = Math.round(openingWageAsk(agent, negotiation.marketWage) * warmthMult);
  negotiation.log.push({ action: 'personal_terms_started', agent: agent.pers, openingAsk: negotiation.wageAsk });
  return negotiation;
}

/**
 * Evaluate a wage offer during personal terms. Returns next state.
 */
export function evaluatePersonalTerms(negotiation, agent, clubOffer, ctx = {}) {
  const result = evaluateWageOffer(agent, clubOffer, negotiation.marketWage, {
    round: negotiation.rounds,
    deadlineDay: negotiation.deadlineDay,
    prng: ctx.prng
  });

  if (result.accept) {
    negotiation.wageOffer = clubOffer;
    negotiation.state = NEGOTIATION_STATES.AGREED;
    negotiation.log.push({ action: 'personal_terms_agreed', wage: clubOffer });
    return { state: NEGOTIATION_STATES.AGREED };
  }
  if (result.counterWage) {
    negotiation.wageAsk = result.counterWage;
    negotiation.log.push({ action: 'personal_terms_countered', counter: result.counterWage });
    return { state: NEGOTIATION_STATES.PERSONAL_TERMS, counter: result.counterWage };
  }
  // Walked away
  negotiation.state = NEGOTIATION_STATES.COLLAPSED;
  negotiation.collapseReason = result.reason || 'wage_gap';
  negotiation.completedAt = 'now';
  negotiation.log.push({ action: 'personal_terms_collapsed', reason: result.reason });
  return { state: NEGOTIATION_STATES.COLLAPSED, reason: result.reason };
}

/**
 * Run the medical. Small failure risk, higher for injury-prone players.
 */
export function runMedical(negotiation, player, ctx = {}) {
  const prng = ctx.prng || { next: () => 0.5 };
  negotiation.state = NEGOTIATION_STATES.MEDICAL;
  const proneness = player.hidden?.injuryProneness ?? 0.5;
  const failChance = 0.02 + proneness * 0.06;
  if (prng.next() < failChance) {
    negotiation.state = NEGOTIATION_STATES.COLLAPSED;
    negotiation.collapseReason = 'medical_failed';
    negotiation.completedAt = 'now';
    negotiation.log.push({ action: 'medical_failed' });
    return { state: NEGOTIATION_STATES.COLLAPSED, reason: 'medical_failed' };
  }
  negotiation.state = NEGOTIATION_STATES.ANNOUNCED;
  negotiation.completedAt = 'now';
  negotiation.log.push({ action: 'medical_passed' });
  return { state: NEGOTIATION_STATES.ANNOUNCED };
}

/**
 * Compute the patience meter display value (0..100) for the UI.
 */
export function patienceMeter(negotiation) {
  return clamp(negotiation.patience, 0, 100);
}

/**
 * Is the negotiation in a terminal state?
 */
export function isTerminal(negotiation) {
  return [NEGOTIATION_STATES.ANNOUNCED, NEGOTIATION_STATES.COLLAPSED,
          NEGOTIATION_STATES.REJECTED, NEGOTIATION_STATES.WITHDRAWN].includes(negotiation.state);
}
