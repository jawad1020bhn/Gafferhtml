// sim/transfers/bosman.js
// Bosman & pre-contracts.
// From January 1st, any player with under 6 months on his contract can sign
// a pre-contract agreement with a foreign club, leaving free in summer.

import { clamp } from '../../core/prng.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Check if a player is Bosman-eligible (under 6 months on contract).
 */
export function isBosmanEligible(player, state) {
  const yearsLeft = (player.contractUntil || 2028) - (state.clock.seasonYear || 2026);
  // In the January window of the contract's final year
  const month = new Date(state.clock.date).getMonth() + 1;
  return yearsLeft <= 0 || (yearsLeft === 1 && month >= 1);
}

/**
 * Scan all players for Bosman risk and return at-risk players for the user.
 * Includes the user's own players (renewal defense) and Bosman targets
 * from other clubs (poaching opportunities).
 */
export function scanBosmanMarket(state) {
  const atRisk = [];
  const targets = [];
  const userId = state.meta.userClubId;
  for (const player of state.entities.players.values()) {
    if (player.inj) continue;
    if (!isBosmanEligible(player, state)) continue;
    const ownerClub = findOwningClub(state, player.id);
    if (!ownerClub) continue;
    if (ownerClub.id === userId) {
      atRisk.push({ player, club: ownerClub });
    } else {
      targets.push({ player, club: ownerClub });
    }
  }
  return { atRisk, targets };
}

function findOwningClub(state, playerId) {
  for (const club of state.entities.clubs.values()) {
    if (club.squadIds?.includes(playerId)) return club;
  }
  return null;
}

/**
 * Compute the probability a player accepts a Bosman pre-contract offer.
 * Driven by:
 *   - Wage offered vs current
 *   - Buying club's reputation vs selling club's
 *   - Player's ambition (ambitious players want bigger clubs)
 *   - Player's loyalty (high loyalty resists)
 */
export function bosmanAcceptanceProbability(player, buyerClub, sellerClub, wageOffer) {
  let p = 0.5;
  // Wage uplift
  if (wageOffer > player.wage * 1.3) p += 0.20;
  else if (wageOffer > player.wage * 1.1) p += 0.10;
  // Reputation
  if (buyerClub.rep > sellerClub.rep) p += 0.15;
  else if (buyerClub.rep < sellerClub.rep) p -= 0.10;
  // Ambition
  const amb = player.hidden?.ambition ?? 60;
  p += (amb - 60) / 200;
  // Loyalty
  const loy = player.pers?.loy ?? 60;
  p -= (loy - 60) / 300;
  return clamp(p, 0.05, 0.95);
}

/**
 * Execute a Bosman pre-contract signing. Player joins at end of season.
 */
export function signBosmanPreContract(state, player, buyerClub, wageOffer, opts = {}) {
  const prng = opts.prng || { next: () => 0.5 };
  const sellerClub = findOwningClub(state, player.id);
  if (!sellerClub) return null;
  const p = bosmanAcceptanceProbability(player, buyerClub, sellerClub, wageOffer);
  if (prng.next() > p) {
    return { accepted: false, reason: 'player_declined' };
  }
  // Pre-contract recorded — player joins buyer at season end
  const preContract = {
    id: 'bosman_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    playerId: player.id,
    buyerClubId: buyerClub.id,
    sellerClubId: sellerClub.id,
    wage: wageOffer,
    signedAt: state.clock.date,
    effectiveAt: seasonEnd(state)
  };
  state.bosmanPreContracts = state.bosmanPreContracts || [];
  state.bosmanPreContracts.push(preContract);
  return { accepted: true, preContract };
}

function seasonEnd(state) {
  // Typical season end: 30 June
  const year = state.clock.seasonYear || 2026;
  return `${year + 1}-06-30`;
}

/**
 * At season end, execute all pending Bosman pre-contracts.
 */
export function executeBosmanTransfers(state) {
  const events = [];
  state.bosmanPreContracts = state.bosmanPreContracts || [];
  for (const pc of state.bosmanPreContracts) {
    if (state.clock.date < pc.effectiveAt) continue;
    const player = state.entities.players.get(pc.playerId);
    const buyer = state.entities.clubs.get(pc.buyerClubId);
    const seller = state.entities.clubs.get(pc.sellerClubId);
    if (!player || !buyer || !seller) continue;
    // Move player
    seller.squadIds = (seller.squadIds || []).filter(id => id !== player.id);
    buyer.squadIds = buyer.squadIds || [];
    buyer.squadIds.push(player.id);
    player.wage = pc.wage;
    player.contractUntil = (state.clock.seasonYear || 2026) + 4;
    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'transfers', bosman_completed: true, player: player.name, to: buyer.code
    }});
  }
  // Remove executed pre-contracts
  state.bosmanPreContracts = state.bosmanPreContracts.filter(pc => state.clock.date < pc.effectiveAt);
  return events;
}
