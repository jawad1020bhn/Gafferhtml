// main.js — Bootstrap & wiring.
// Initialises GameState, syncs the legacy globals, hooks the Continue button
// to dispatch(ADVANCE_DAY), replaces the legacy kickOff() with the engine-
// backed version, and subscribes to events for re-rendering.

import { logger } from './core/logger.js';
import { bus, EVT } from './core/eventBus.js';
import { initNewGame, getState, setState, dispatch, A, sel, setSpeed } from './core/state.js';
import { load, save, listSaves } from './core/persistence.js';
import { syncLegacyGlobals, rerender } from './ui/panels.js';
import { engineKickOff } from './ui/matchOverlay.js';
// Import tick.js as a side effect — it registers the tick engine with
// state.js via registerTickEngine(). Without this, ADVANCE_DAY is a no-op.
import './sim/tick.js';

const $ = s => document.querySelector(s);

logger.setLevel('info');
logger.info('main', 'bootstrap starting');

// -------- 1. Initialise or load state --------
let state = null;
try {
  const autosave = load('autosave');
  if (autosave) {
    state = autosave;
    logger.info('main', 'loaded autosave', { saveId: state.meta.saveId });
  }
} catch (e) {
  logger.warn('main', 'autosave load failed, starting new game', { err: String(e) });
}

if (!state) {
  state = initNewGame();
  logger.info('main', 'started new game', { seed: state.meta.seed });
}
setState(state);

// -------- 2. Sync legacy globals (CLUBS, PLAYERS, STD, FIX, INBOX, etc.) --------
syncLegacyGlobals(state);

// -------- 3. Override legacy kickOff with engine-backed version --------
window.kickOff = engineKickOff;

// -------- 4. Hook Continue button to dispatch(ADVANCE_DAY) --------
const continueBtn = $('#btnContinue');
if (continueBtn) {
  continueBtn.onclick = () => {
    logger.info('main', 'Continue clicked — advancing day');
    // Disable briefly to prevent double-clicks
    continueBtn.disabled = true;
    setTimeout(() => { continueBtn.disabled = false; }, 300);
    const result = dispatch({ type: A.ADVANCE_DAY });
    // syncLegacyGlobals + rerender happens via event subscriptions below.
    // But also do an immediate sync in case events haven't fired yet.
    syncLegacyGlobals(getState());
    rerender();
    // If a matchday was reached, the user must play the match before continuing.
    // The tick engine sets state._pendingAI; the match overlay opens when the
    // user clicks KICK OFF.
    const today = getState().clock.date;
    const userClubId = getState().meta.userClubId;
    const fx = getState().competitions.league.fixtures.find(f =>
      f.status === 'scheduled' && f.date === today &&
      (f.homeId === userClubId || f.awayId === userClubId));
    if (fx) {
      if (typeof window.toast === 'function') {
        const opp = fx.homeId === userClubId ? fx.awayId : fx.homeId;
        const oppClub = getState().entities.clubs.get(opp);
        window.toast('MATCHDAY', `Today's match: ${oppClub?.name}. Click KICK OFF when ready.`, 'tl');
      }
    } else {
      // No match today — show ambient day-advance toast
      if (typeof window.toast === 'function') {
        const d = new Date(getState().clock.date);
        const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        window.toast('DAY ADVANCE', `${d.getDate()} ${months[d.getMonth()]} · Day ${getState().clock.dayNumber}`, '');
      }
    }
  };
}

// -------- 5. Subscribe to events for re-rendering --------
bus.on(EVT.STATE_BATCH, (payload) => {
  syncLegacyGlobals(getState());
  if (payload?.panel && typeof window.show === 'function') {
    // Optionally switch screens if the event suggests it
  }
  rerender();
});

bus.on(EVT.ADVANCE_DAY_END, () => {
  syncLegacyGlobals(getState());
  rerender();
});

bus.on(EVT.MATCH_REPORT, (payload) => {
  syncLegacyGlobals(getState());
  if (!payload.aiVsAi) {
    // User match — don't auto-rerender (overlay handles it)
    return;
  }
  rerender();
});

bus.on(EVT.LEAGUE_TABLE_UPDATED, () => {
  syncLegacyGlobals(getState());
  rerender();
});

bus.on(EVT.PLAYER_INJURED, (p) => {
  if (typeof window.toast === 'function') {
    const player = getState().entities.players.get(p.playerId);
    window.toast('INJURY', `${player?.name || 'Player'} — ${p.injury.type} (${p.injury.days} days)`, 'rd');
  }
});

bus.on(EVT.MEDIA_HEADLINE, (h) => {
  // Could show toast for high-importance headlines; skip for now
});

bus.on(EVT.INVARIANT_VIOLATION, (v) => {
  logger.warn('main', 'invariant violation', v);
  if (typeof window.toast === 'function') {
    window.toast('VALIDATION', `Action rejected: ${v.reason || v.rule}`, 'rd');
  }
});

// -------- 6. Wire keyboard shortcuts (mirror legacy) --------
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.ovl').forEach(o => o.classList.remove('on'));
  }
  const map = { '1':'dash','2':'squad','3':'tactics','4':'match','5':'transfers','6':'club','7':'academy','8':'world','9':'manager','0':'news' };
  if (map[e.key] && !e.target.closest('input,select') && !document.querySelector('.ovl.on')) {
    if (typeof window.show === 'function') window.show(map[e.key]);
  }
});

// -------- 7. Save on page unload --------
window.addEventListener('beforeunload', () => {
  save(getState(), 'autosave');
});

// -------- 8. Initial render --------
// The legacy script's initial render calls are disabled; we do them here.
if (typeof window.renderHeader === 'function') window.renderHeader();
if (typeof window.renderTicker === 'function') window.renderTicker();
if (typeof window.renderDash === 'function') window.renderDash();
// Show the dashboard
if (typeof window.show === 'function') window.show('dash');

logger.info('main', 'bootstrap complete', {
  userClubId: state.meta.userClubId,
  date: state.clock.date,
  dayNumber: state.clock.dayNumber,
  nextFixture: sel.nextFixture(state)?.id || 'none'
});

// Expose key APIs on window for debugging
window.GAME = {
  getState, dispatch, A, sel, bus, EVT,
  syncLegacyGlobals, rerender,
  save: () => save(getState(), 'manual'),
  load: () => load('manual'),
  newGame: () => { setState(initNewGame()); syncLegacyGlobals(getState()); rerender(); },
  listSaves,
  // Step 3+4 helpers for UI / debugging
  training: {
    computeMicrocycle: () => import('./sim/training/microcycle.js').then(m => m.computeMicrocycle(getState())),
    setSession: (date, sessionType) => dispatch({ type: A.SET_TRAINING_SESSION, payload: { date, sessionType } }),
    autoSchedule: () => dispatch({ type: A.AUTO_SCHEDULE_WEEK })
  },
  development: {
    setMentorship: (mentorId, menteeId) => dispatch({ type: A.SET_MENTORSHIP, payload: { mentorId, menteeId } }),
    endMentorship: (pairingId) => dispatch({ type: A.END_MENTORSHIP, payload: { pairingId } })
  },
  transfers: {
    submitBid: (negotiationId, bid, context) => dispatch({ type: A.SUBMIT_BID, payload: { negotiationId, bid, context } }),
    acceptCounter: (negotiationId) => dispatch({ type: A.ACCEPT_COUNTER, payload: { negotiationId } }),
    withdrawBid: (negotiationId) => dispatch({ type: A.WITHDRAW_BID, payload: { negotiationId } }),
    respondToBid: (bidId, action, counterAmount) => dispatch({ type: A.RESPOND_TO_BID, payload: { bidId, action, counterAmount } }),
    signFreeAgent: (freeAgentId, wage) => dispatch({ type: A.SIGN_FREE_AGENT, payload: { freeAgentId, wage } }),
    loanPlayer: (playerId, loaningClubId, opts) => dispatch({ type: A.LOAN_PLAYER, payload: { playerId, loaningClubId, ...opts } }),
    recallLoan: (loanId) => dispatch({ type: A.RECALL_LOAN, payload: { loanId } })
  }
};
