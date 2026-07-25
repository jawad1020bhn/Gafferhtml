// sim/transfers/loans.js
// Loan market: development loans for prospects, emergency cover, and
// loan-with-option-to-buy structures.

import { clamp } from '../../core/prng.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Loan types:
 *   - DRY_LOAN: wages split between parent and loaning club
 *   - LOAN_WITH_OPTION: price fixed now, optional buy at end
 *   - LOAN_WITH_OBLIGATION: becomes permanent if conditions met
 */
export const LOAN_TYPES = Object.freeze({
  DRY_LOAN: 'dry_loan',
  LOAN_WITH_OPTION: 'loan_with_option',
  LOAN_WITH_OBLIGATION: 'loan_with_obligation'
});

/**
 * Create a loan record.
 */
export function createLoan(opts = {}) {
  return {
    id: 'loan_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    parentId: opts.parentId,           // owning club
    loaningId: opts.loaningId,         // club receiving the player
    playerId: opts.playerId,
    type: opts.type || LOAN_TYPES.DRY_LOAN,
    startedAt: opts.startedAt,
    endsAt: opts.endsAt,               // typically 30 June
    wageSplitPct: opts.wageSplitPct ?? 50,   // parent pays this %
    optionFee: opts.optionFee || null,        // for LOAN_WITH_OPTION
    obligationConditions: opts.obligationConditions || null,  // for LOAN_WITH_OBLIGATION
    recalledAt: null,
    minutesPlayed: 0,
    appearances: 0
  };
}

/**
 * Tick a loan weekly. Returns events.
 */
export function tickLoan(loan, state, opts = {}) {
  const events = [];
  // Check if loan has ended
  if (state.clock.date >= loan.endsAt) {
    return endLoan(loan, state);
  }
  // Track minutes (would be fed from match engine — stubbed here)
  return events;
}

/**
 * End a loan — player returns to parent club.
 */
export function endLoan(loan, state) {
  const events = [];
  const player = state.entities.players.get(loan.playerId);
  const parent = state.entities.clubs.get(loan.parentId);
  const loaning = state.entities.clubs.get(loan.loaningId);
  if (player && parent && loaning) {
    loaning.squadIds = (loaning.squadIds || []).filter(id => id !== player.id);
    parent.squadIds = parent.squadIds || [];
    parent.squadIds.push(player.id);
    player.onLoan = false;
    loan.recalledAt = state.clock.date;
    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'squad', loanEnded: true, playerId: player.id
    }});
  }
  return events;
}

/**
 * Recall a player from loan early (only allowed in January window).
 */
export function recallFromLoan(loan, state) {
  return endLoan(loan, state);
}

/**
 * Convert a loan-with-option to a permanent transfer.
 */
export function exerciseLoanOption(loan, state) {
  if (loan.type !== LOAN_TYPES.LOAN_WITH_OPTION) return null;
  const player = state.entities.players.get(loan.playerId);
  const parent = state.entities.clubs.get(loan.parentId);
  const loaning = state.entities.clubs.get(loan.loaningId);
  if (!player || !parent || !loaning) return null;
  // Execute as a transfer at the optionFee
  loaning.squadIds = loaning.squadIds || [];  // already contains player
  parent.squadIds = (parent.squadIds || []).filter(id => id !== player.id);
  loaning.budget -= loan.optionFee;
  parent.budget += loan.optionFee;
  player.onLoan = false;
  player.contractUntil = (state.clock.seasonYear || 2026) + 4;
  return { playerId: player.id, fee: loan.optionFee };
}
