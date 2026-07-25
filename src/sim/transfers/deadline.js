// sim/transfers/deadline.js
// Deadline day dynamics. The last 48 hours of the window are a distinct
// game mode:
//   - Compressed negotiation (counter rounds drop from 4 to 1-2)
//   - Panic dynamics (AI clubs overpay up to +30%, distress sales accept -30%)
//   - Event density accelerates
//   - Loan market spikes

import { clamp } from '../../core/prng.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Check if the current date is deadline day (last day of the window).
 * Windows close on 31 Jan (winter) and 31 Aug (summer).
 */
export function isDeadlineDay(state) {
  const d = new Date(state.clock.date);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return (month === 1 && day >= 30) || (month === 8 && day >= 30);
}

/**
 * Check if the transfer window is currently open.
 *   Summer: 1 June - 31 Aug
 *   Winter: 1 Jan - 31 Jan
 */
export function isWindowOpen(state) {
  const d = new Date(state.clock.date);
  const month = d.getMonth() + 1;
  return (month >= 6 && month <= 8) || (month === 1);
}

/**
 * Apply deadline-day modifiers to a negotiation.
 *   - maxRounds compressed to 2
 *   - AI clubs overpay (+30%) if they have unmet needs
 *   - Distress sales accept -30%
 */
export function applyDeadlineModifiers(negotiation, buyerClub, sellerClub) {
  if (!isDeadlineDay) return negotiation;
  negotiation.deadlineDay = true;
  negotiation.maxRounds = 2;
  // Panic premium
  if (buyerClub._urgentNeed) {
    negotiation.askingPrice = Math.round(negotiation.askingPrice * 1.20);
  }
  // Distress discount
  if (sellerClub._needsFunds) {
    negotiation.askingPrice = Math.round(negotiation.askingPrice * 0.75);
  }
  return negotiation;
}

/**
 * At window close, collapse all open negotiations.
 */
export function closeWindow(state) {
  const events = [];
  // Open negotiations either complete or collapse
  state.negotiations = state.negotiations || [];
  for (const neg of state.negotiations) {
    if (neg.state === 'ANNOUNCED' || neg.state === 'COLLAPSED' ||
        neg.state === 'REJECTED' || neg.state === 'WITHDRAWN') continue;
    // Auto-collapse
    neg.state = 'COLLAPSED';
    neg.collapseReason = 'window_closed';
    neg.completedAt = state.clock.date;
    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'transfers', collapsed: true, negId: neg.id
    }});
  }
  return events;
}

/**
 * Compute the panic-buy probability for an AI club on deadline day.
 * Clubs with unmet needs and budget remaining are likely to panic-buy.
 */
export function panicBuyProbability(club, needs) {
  if (!needs.length) return 0;
  if (club.budget < 5e6) return 0;
  // Higher needs + bigger budget = higher panic probability
  const urgency = Math.max(...needs.map(n => n.urgency));
  return clamp(urgency * 0.6, 0, 0.9);
}
