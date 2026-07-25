// core/state.js
// GameState shape, dispatch, reducer, selectors.
// This is the single chokepoint through which every mutation flows.

import { logger } from './logger.js';
import { bus, EVT } from './eventBus.js';
import { autosave, flushAutosave } from './persistence.js';
import { validateAction, validateState, autoCorrect, recomputeLeagueTable } from '../domain/invariants.js';
import { newSeedState } from '../data/seed.js';

// -------- Action types (kept as plain strings for ergonomics) --------
export const A = {
  ADVANCE_DAY:         'ADVANCE_DAY',
  SET_LINEUP:          'SET_LINEUP',
  SET_TACTICS:         'SET_TACTICS',
  TRANSFER_BID:        'TRANSFER_BID',
  DISMISS_MESSAGE:     'DISMISS_MESSAGE',
  RESOLVE_MESSAGE:     'RESOLVE_MESSAGE',
  SAVE:                'SAVE',
  LOAD:                'LOAD',
  SET_SPEED:           'SET_SPEED',
  PAUSE_MATCH:         'PAUSE_MATCH',
  RESUME_MATCH:        'RESUME_MATCH',
  SHOUT:               'SHOUT',
  // Step 3: training & development
  SET_TRAINING_SESSION:'SET_TRAINING_SESSION',
  AUTO_SCHEDULE_WEEK:  'AUTO_SCHEDULE_WEEK',
  SET_MENTORSHIP:      'SET_MENTORSHIP',
  END_MENTORSHIP:      'END_MENTORSHIP',
  COMMIT_GROWTH:       'COMMIT_GROWTH',
  COMMIT_DECLINE:      'COMMIT_DECLINE',
  COMMIT_FORM_CHANGE:  'COMMIT_FORM_CHANGE',
  // Step 4: transfers
  ENQUIRY_PLAYER:      'ENQUIRY_PLAYER',
  SUBMIT_BID:          'SUBMIT_BID',
  ACCEPT_COUNTER:      'ACCEPT_COUNTER',
  COUNTER_BACK:        'COUNTER_BACK',
  WITHDRAW_BID:        'WITHDRAW_BID',
  OFFER_WAGE:          'OFFER_WAGE',
  RUN_MEDICAL:         'RUN_MEDICAL',
  RESPOND_TO_BID:      'RESPOND_TO_BID',     // for sell-side
  LOAN_PLAYER:         'LOAN_PLAYER',
  RECALL_LOAN:         'RECALL_LOAN',
  SIGN_FREE_AGENT:     'SIGN_FREE_AGENT',
  BOSMAN_APPROACH:     'BOSMAN_APPROACH',
  RESET_MATCH_TRANSIENT:'RESET_MATCH_TRANSIENT',
  // Internal — used by sim modules to commit match results
  COMMIT_MATCH_RESULT: 'COMMIT_MATCH_RESULT',
  COMMIT_INJURY:       'COMMIT_INJURY',
  COMMIT_MORALE_SHIFT: 'COMMIT_MORALE_SHIFT',
  COMMIT_FINANCE:      'COMMIT_FINANCE',
  COMMIT_BOARD_CONF:   'COMMIT_BOARD_CONF',
  COMMIT_XP:           'COMMIT_XP',
  COMMIT_MEDIA:        'COMMIT_MEDIA',
  COMMIT_INBOX:        'COMMIT_INBOX'
};

// -------- The live state --------
let _state = null;
let _speed = 'normal';   // 'instant' | 'normal' | 'detailed'
let _pendingBatch = null;

export function getState() { return _state; }
export function setState(s) { _state = s; }
export function getSpeed() { return _speed; }
export function setSpeed(s) { _speed = s; }

/**
 * Initialise a brand-new game state from the seed module.
 * Optionally merge overrides (e.g. chosen club).
 */
export function initNewGame(overrides = {}) {
  _state = newSeedState(overrides);
  logger.info('state', 'new game initialised', { seed: _state.meta.seed, club: _state.meta.userClubId });
  return _state;
}

/**
 * The single dispatch entry point. Validates, reduces, persists, emits.
 * Returns the new state. If validation rejects, returns the prior state.
 */
export function dispatch(action) {
  if (!_state) {
    logger.error('state', 'dispatch before init', { type: action?.type });
    return null;
  }
  const prev = _state;

  // 1. Validate the action against the current state.
  const v = validateAction(prev, action);
  if (!v.ok) {
    if (v.autoFix) {
      action = { ...action, payload: v.autoFix };
      logger.warn('state', 'action auto-fixed', { type: action.type, reason: v.reason });
    } else {
      logger.warn('state', 'action rejected', { type: action.type, reason: v.reason });
      bus.emit(EVT.INVARIANT_VIOLATION, { type: action.type, reason: v.reason, action });
      return prev;
    }
  }

  // 2. Reduce. Reducer is pure: returns new state + events to emit.
  const { state: next, events } = reducer(prev, action);
  if (!next) {
    logger.error('state', 'reducer returned null', { type: action.type });
    return prev;
  }

  // 3. Validate the new state. Soft violations auto-correct; hard ones reject.
  const sv = validateState(next);
  if (!sv.ok) {
    const hard = sv.violations.find(x => x.severity !== 'soft');
    if (hard) {
      logger.error('state', 'hard invariant violated post-reduce', { rule: hard.rule });
      bus.emit(EVT.INVARIANT_VIOLATION, { phase: 'post', rule: hard.rule, violations: sv.violations });
      return prev;
    }
    // Soft violations: auto-correct
    const corrections = autoCorrect(next);
    if (corrections.length) {
      events.push({ type: EVT.STATE_BATCH, payload: { corrections } });
    }
  }

  // 4. Commit
  _state = next;

  // 5. Autosave (debounced) on meaningful mutations.
  if (action.type !== A.SAVE && action.type !== A.LOAD) {
    autosave(next);
  }

  // 6. Emit events. UI subscribes and re-renders.
  if (events && events.length) {
    for (const evt of events) bus.emit(evt.type, evt.payload);
  }

  return next;
}

// -------- Reducer --------
function reducer(state, action) {
  const events = [];
  switch (action.type) {
    case A.ADVANCE_DAY: {
      // Lazy-import to avoid circular deps at module load.
      // tick.js imports state.js for dispatch helpers.
      // Using dynamic import would be async; we instead resolve at call time
      // via a module-level singleton wired in sim/tick.js -> setDispatch.
      if (!_tick) {
        logger.error('state', 'tick engine not registered');
        return { state, events };
      }
      const result = _tick(state, action.payload || {});
      // tick returns {state, events, matchday?}
      if (result.state) state = result.state;
      if (result.events) events.push(...result.events);
      return { state, events };
    }

    case A.SET_LINEUP: {
      const { clubId, starting, bench } = action.payload;
      // Store lineup transiently on the club (resets each matchday in tick)
      const club = state.entities.clubs.get(clubId);
      if (!club) return { state, events };
      const updated = { ...club, _lineup: { starting: starting || [], bench: bench || [] } };
      state.entities.clubs.set(clubId, updated);
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'tactics' } });
      return { state, events };
    }

    case A.SET_TACTICS: {
      const { clubId, tactics } = action.payload;
      const club = state.entities.clubs.get(clubId);
      if (!club) return { state, events };
      const merged = { ...club.tactics, ...tactics };
      state.entities.clubs.set(clubId, { ...club, tactics: merged });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'tactics' } });
      return { state, events };
    }

    case A.SHOUT: {
      // Touchline shout during a match — engine reads via getter.
      state.transient = state.transient || {};
      state.transient.lastShout = { kind: action.payload.kind, ts: Date.now() };
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'match' } });
      return { state, events };
    }

    // -------- Step 3: Training & Development --------
    case A.SET_TRAINING_SESSION: {
      const { date, sessionType } = action.payload;
      state.training = state.training || { schedule: {} };
      state.training.schedule[date] = sessionType;
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'training' } });
      return { state, events };
    }

    case A.AUTO_SCHEDULE_WEEK: {
      // Handled by sim/training/microcycle.js via the tick engine; the action
      // is a signal that the user wants the assistant to take over.
      state.training = state.training || { schedule: {} };
      state.training.autoSchedule = true;
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'training' } });
      return { state, events };
    }

    case A.SET_MENTORSHIP: {
      const { mentorId, menteeId } = action.payload;
      state.relationships.mentorships = state.relationships.mentorships || [];
      // One mentor, up to two mentees
      const existingForMentor = state.relationships.mentorships.filter(
        m => m.mentorId === mentorId && !m.completedAt
      );
      if (existingForMentor.length >= 2) {
        events.push({ type: EVT.INVARIANT_VIOLATION, payload: { reason: 'mentor_full' } });
        return { state, events };
      }
      state.relationships.mentorships.push({
        id: 'msh_' + Date.now(),
        mentorId, menteeId,
        startedAt: state.clock.date,
        weeksElapsed: 0,
        completedAt: null,
        compatibility: 1.0,
        determinationGained: 0
      });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad' } });
      return { state, events };
    }

    case A.END_MENTORSHIP: {
      const { pairingId } = action.payload;
      state.relationships.mentorships = state.relationships.mentorships || [];
      const pairing = state.relationships.mentorships.find(m => m.id === pairingId);
      if (pairing) {
        pairing.completedAt = state.clock.date;
        pairing.endReason = 'manual';
      }
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad' } });
      return { state, events };
    }

    case A.COMMIT_GROWTH: {
      const { playerId, attributeGains, newOvr } = action.payload;
      const p = state.entities.players.get(playerId);
      if (!p) return { state, events };
      if (attributeGains) {
        p.atts = p.atts || {};
        for (const [attr, gain] of Object.entries(attributeGains)) {
          p.atts[attr] = Math.max(20, Math.min(99, (p.atts[attr] || 60) + gain));
        }
      }
      if (newOvr) p.ovr = newOvr;
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad', growth: true, playerId } });
      return { state, events };
    }

    case A.COMMIT_DECLINE: {
      const { playerId, attributeDeltas } = action.payload;
      const p = state.entities.players.get(playerId);
      if (!p) return { state, events };
      if (attributeDeltas) {
        p.atts = p.atts || {};
        for (const [attr, delta] of Object.entries(attributeDeltas)) {
          p.atts[attr] = Math.max(20, Math.min(99, (p.atts[attr] || 60) + delta));
        }
      }
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad', decline: true, playerId } });
      return { state, events };
    }

    case A.COMMIT_FORM_CHANGE: {
      const { playerId, delta, rating } = action.payload;
      const p = state.entities.players.get(playerId);
      if (!p) return { state, events };
      if (rating != null) {
        p.formHist = (p.formHist || []).slice(-9).concat([rating]);
      }
      if (delta != null) {
        p.form = Math.max(3, Math.min(10, (p.form || 6) + delta));
      }
      events.push({ type: EVT.PLAYER_FORM_CHANGED, payload: { playerId, form: p.form } });
      return { state, events };
    }

    // -------- Step 4: Transfers --------
    case A.SUBMIT_BID: {
      const { negotiationId, bid } = action.payload;
      state.negotiations = state.negotiations || [];
      let neg = state.negotiations.find(n => n.id === negotiationId);
      if (!neg) {
        // Create new negotiation
        neg = {
          id: negotiationId,
          ...action.payload.context,
          state: 'BID_SUBMITTED',
          rounds: 1,
          currentBid: bid,
          log: [{ round: 1, action: 'bid_submitted', bid }]
        };
        state.negotiations.push(neg);
      } else {
        neg.currentBid = bid;
        neg.state = 'BID_SUBMITTED';
        neg.rounds++;
        neg.log.push({ round: neg.rounds, action: 'bid_submitted', bid });
      }
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'transfers' } });
      return { state, events };
    }

    case A.ACCEPT_COUNTER: {
      const { negotiationId } = action.payload;
      const neg = (state.negotiations || []).find(n => n.id === negotiationId);
      if (!neg) return { state, events };
      neg.currentBid = { ...neg.currentCounter };
      neg.state = 'ACCEPTED';
      neg.log.push({ round: neg.rounds, action: 'accepted_counter' });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'transfers' } });
      return { state, events };
    }

    case A.WITHDRAW_BID: {
      const { negotiationId } = action.payload;
      const neg = (state.negotiations || []).find(n => n.id === negotiationId);
      if (!neg) return { state, events };
      neg.state = 'WITHDRAWN';
      neg.completedAt = state.clock.date;
      neg.collapseReason = 'buyer_withdrew';
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'transfers' } });
      return { state, events };
    }

    case A.OFFER_WAGE: {
      const { negotiationId, wage } = action.payload;
      const neg = (state.negotiations || []).find(n => n.id === negotiationId);
      if (!neg) return { state, events };
      neg.wageOffer = wage;
      neg.log.push({ action: 'wage_offered', wage });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'transfers' } });
      return { state, events };
    }

    case A.RESPOND_TO_BID: {
      const { bidId, action: bidAction, counterAmount } = action.payload;
      const bid = (state.incomingBids || []).find(b => b.id === bidId);
      if (!bid) return { state, events };
      bid.state = bidAction.toUpperCase();
      if (bidAction === 'counter') bid.counterAmount = counterAmount;
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'transfers' } });
      return { state, events };
    }

    case A.SIGN_FREE_AGENT: {
      const { freeAgentId, wage } = action.payload;
      const fa = (state.freeAgents || []).find(f => f.id === freeAgentId);
      if (!fa) return { state, events };
      // Convert to player entity and add to user squad
      const player = {
        ...fa,
        id: 'pl_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
        kind: 'player',
        wage,
        onLoan: false,
        hg: false,
        registered: true,
        match: null,
        formHist: [],
        stats: { apps: 0, goals: 0, assists: 0, cs: 0, motm: 0, mins: 0 }
      };
      delete player.signingOnBonus;
      delete player.status;
      state.entities.players.set(player.id, player);
      const userClub = state.entities.clubs.get(state.meta.userClubId);
      userClub.squadIds = userClub.squadIds || [];
      userClub.squadIds.push(player.id);
      // Remove from free agent pool
      state.freeAgents = (state.freeAgents || []).filter(f => f.id !== freeAgentId);
      // Deduct signing-on bonus
      state.finance.balance -= fa.signingOnBonus || 0;
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad', signed: player.name } });
      return { state, events };
    }

    case A.LOAN_PLAYER: {
      const { playerId, loaningClubId, type, wageSplitPct, optionFee } = action.payload;
      const player = state.entities.players.get(playerId);
      const parent = state.entities.clubs.get(state.meta.userClubId);
      const loaning = state.entities.clubs.get(loaningClubId);
      if (!player || !parent || !loaning) return { state, events };
      // Move player to loaning club
      parent.squadIds = (parent.squadIds || []).filter(id => id !== playerId);
      loaning.squadIds = loaning.squadIds || [];
      loaning.squadIds.push(playerId);
      player.onLoan = true;
      state.relationships.loans = state.relationships.loans || [];
      state.relationships.loans.push({
        id: 'loan_' + Date.now(),
        parentId: parent.id,
        loaningId: loaningClubId,
        playerId,
        type: type || 'dry_loan',
        startedAt: state.clock.date,
        endsAt: `${(state.clock.seasonYear || 2026) + 1}-06-30`,
        wageSplitPct: wageSplitPct ?? 50,
        optionFee: optionFee || null,
        recalledAt: null,
        minutesPlayed: 0,
        appearances: 0
      });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad' } });
      return { state, events };
    }

    case A.RECALL_LOAN: {
      const { loanId } = action.payload;
      state.relationships.loans = state.relationships.loans || [];
      const loan = state.relationships.loans.find(l => l.id === loanId && !l.recalledAt);
      if (!loan) return { state, events };
      const player = state.entities.players.get(loan.playerId);
      const parent = state.entities.clubs.get(loan.parentId);
      const loaning = state.entities.clubs.get(loan.loaningId);
      if (player && parent && loaning) {
        loaning.squadIds = (loaning.squadIds || []).filter(id => id !== loan.playerId);
        parent.squadIds = parent.squadIds || [];
        parent.squadIds.push(loan.playerId);
        player.onLoan = false;
        loan.recalledAt = state.clock.date;
      }
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad' } });
      return { state, events };
    }

    case A.PAUSE_MATCH: {
      state.transient = state.transient || {};
      state.transient.matchPaused = true;
      events.push({ type: EVT.MATCH_PAUSED, payload: {} });
      return { state, events };
    }
    case A.RESUME_MATCH: {
      state.transient = state.transient || {};
      state.transient.matchPaused = false;
      events.push({ type: EVT.MATCH_RESUMED, payload: {} });
      return { state, events };
    }
    case A.SET_SPEED: {
      _speed = action.payload.speed;
      return { state, events };
    }

    case A.COMMIT_MATCH_RESULT: {
      const { fixtureId, result, report } = action.payload;
      const fx = state.competitions.league.fixtures.find(f => f.id === fixtureId);
      if (!fx) return { state, events };
      fx.status = 'played';
      fx.result = result;
      fx._report = report;   // attached but not strictly required for table recompute
      // Recompute league table cache
      state.competitions.league.table = recomputeLeagueTable(state);
      events.push({ type: EVT.MATCH_REPORT, payload: { fixtureId, result, report } });
      events.push({ type: EVT.LEAGUE_TABLE_UPDATED, payload: { table: state.competitions.league.table } });
      return { state, events };
    }

    case A.COMMIT_INJURY: {
      const { playerId, injury } = action.payload;
      const p = state.entities.players.get(playerId);
      if (!p) return { state, events };
      p.inj = injury;
      events.push({ type: EVT.PLAYER_INJURED, payload: { playerId, injury } });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad' } });
      return { state, events };
    }

    case A.COMMIT_FORM_CHANGE: {
      const { playerId, delta } = action.payload;
      const p = state.entities.players.get(playerId);
      if (!p) return { state, events };
      p.form = Math.max(3, Math.min(10, (p.form || 6) + delta));
      p.formHist = (p.formHist || []).slice(-9).concat([p.form]);
      events.push({ type: EVT.PLAYER_FORM_CHANGED, payload: { playerId, form: p.form } });
      return { state, events };
    }

    case A.COMMIT_MORALE_SHIFT: {
      const { playerId, delta } = action.payload;
      const p = state.entities.players.get(playerId);
      if (!p) return { state, events };
      p.mor = Math.max(0, Math.min(100, (p.mor || 70) + delta));
      events.push({ type: EVT.MORALE_SHIFT, payload: { playerId, mor: p.mor } });
      return { state, events };
    }

    case A.COMMIT_FINANCE: {
      const { amount, category, note } = action.payload;
      state.finance.balance += amount;
      state.finance.transactions = state.finance.transactions || [];
      state.finance.transactions.push({
        id: 'tx_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
        date: state.clock.date,
        amount, category, note
      });
      // Keep transfer budget in sync for transfer-category transactions
      if (category === 'transfer') state.finance.transferBudget -= amount;
      events.push({ type: EVT.FINANCE_TRANSACTION, payload: { amount, category, note } });
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'club' } });
      return { state, events };
    }

    case A.COMMIT_BOARD_CONF: {
      const { deltas } = action.payload;  // {Matches, Finance, Squad}
      for (const k of Object.keys(deltas || {})) {
        state.board.confidence[k] = Math.max(0, Math.min(100,
          (state.board.confidence[k] || 50) + deltas[k]));
      }
      events.push({ type: EVT.BOARD_CONFIDENCE_SHIFT, payload: { deltas } });
      return { state, events };
    }

    case A.COMMIT_XP: {
      const { amount } = action.payload;
      const m = state.manager;
      m.xp = (m.xp || 0) + amount;
      while (m.xp >= m.xpNext && m.xpNext > 0) {
        m.xp -= m.xpNext;
        m.lvl = (m.lvl || 1) + 1;
        m.xpNext = Math.round(m.xpNext * 1.35);
        m.sp = (m.sp || 0) + 1;
      }
      events.push({ type: EVT.MANAGER_XP_GAIN, payload: { amount, lvl: m.lvl } });
      return { state, events };
    }

    case A.COMMIT_MEDIA: {
      const { headline } = action.payload;
      state.media = state.media || { headlines: [], fanSentiment: 60 };
      state.media.headlines = (state.media.headlines || []).slice(-49).concat([headline]);
      events.push({ type: EVT.MEDIA_HEADLINE, payload: headline });
      return { state, events };
    }

    case A.COMMIT_INBOX: {
      const { message } = action.payload;
      state.inbox = state.inbox || [];
      state.inbox.unshift(message);
      state.inbox = state.inbox.slice(0, 50);
      events.push({ type: EVT.INBOX_MESSAGE, payload: message });
      return { state, events };
    }

    case A.RESOLVE_MESSAGE: {
      const { messageId, choiceIndex } = action.payload;
      const m = state.inbox.find(x => x.id === messageId);
      if (!m) return { state, events };
      m.done = true;
      m.opened = true;
      // The choice's `effect` is dispatched by the UI panel — reducer just marks done.
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'inbox' } });
      return { state, events };
    }
    case A.DISMISS_MESSAGE: {
      const { messageId } = action.payload;
      state.inbox = state.inbox.filter(m => m.id !== messageId);
      events.push({ type: EVT.STATE_BATCH, payload: { panel: 'inbox' } });
      return { state, events };
    }

    case A.SAVE: {
      // Persistence handled by autosave + explicit save call in main.js
      flushAutosave(state);
      events.push({ type: EVT.SAVE_WRITTEN, payload: { slot: action.payload?.slot || 'manual' } });
      return { state, events };
    }
    case A.LOAD: {
      // Loaded state is committed by the persistence caller; reducer no-op.
      return { state, events };
    }

    default:
      // Unknown — log & no-op
      logger.debug('state', 'unhandled action', { type: action.type });
      return { state, events };
  }
}

// -------- Tick engine registration (breaks the circular dep) --------
let _tick = null;
export function registerTickEngine(fn) { _tick = fn; }

// -------- Selectors --------
export const sel = {
  userClub: (s) => s.entities.clubs.get(s.meta.userClubId),
  userSquad: (s) => {
    const c = s.entities.clubs.get(s.meta.userClubId);
    if (!c) return [];
    return c.squadIds.map(id => s.entities.players.get(id)).filter(Boolean);
  },
  playerById: (s, id) => s.entities.players.get(id),
  clubById: (s, id) => s.entities.clubs.get(id),
  nextFixture: (s) => {
    const uid = s.meta.userClubId;
    return s.competitions.league.fixtures.find(f =>
      f.status === 'scheduled' && (f.homeId === uid || f.awayId === uid)
    );
  },
  nextEventDay: (s) => {
    // Find the next day that has a meaningful event (fixture, deadline, etc.)
    const today = new Date(s.clock.date).getTime();
    const upcoming = s.competitions.league.fixtures
      .filter(f => f.status === 'scheduled' && new Date(f.date).getTime() >= today)
      .map(f => new Date(f.date).getTime())
      .sort((a, b) => a - b);
    return upcoming.length ? new Date(upcoming[0]).toISOString().slice(0, 10) : null;
  }
};
