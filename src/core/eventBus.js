// core/eventBus.js
// Typed event emitter. Simulation emits events; UI subscribes by type.
// Simulation never touches the DOM — it only emits.

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} type -> handlers */
    this._subs = new Map();
    /** @type {Array<{type, payload, ts}>} ring buffer of recent emissions */
    this._history = [];
    this._historyCap = 500;
    /** @type {Array<{type, payload}>} events emitted before any subscriber attached */
    this._orphanQueue = [];
    this._replayToNewSubs = true;
  }

  /**
   * Subscribe to events of a given type (or '*' for all).
   * Handler receives (payload, meta) where meta = {type, ts, seq}.
   * Returns an unsubscribe function.
   */
  on(type, handler) {
    const key = type || '*';
    if (!this._subs.has(key)) this._subs.set(key, new Set());
    this._subs.get(key).add(handler);
    // Replay recent history to late subscribers (UI panels mounting after sim events)
    if (this._replayToNewSubs && key !== '*') {
      for (const evt of this._history) {
        if (evt.type === type) {
          try { handler(evt.payload, { type: evt.type, ts: evt.ts, seq: evt.seq }); }
          catch (_) { /* swallow handler errors in replay */ }
        }
      }
    }
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const key = type || '*';
    this._subs.get(key)?.delete(handler);
  }

  /**
   * Emit one event. Handlers run synchronously; exceptions are isolated
   * so one bad handler does not break siblings.
   */
  emit(type, payload = {}) {
    const evt = { type, payload, ts: Date.now(), seq: this._history.length };
    this._history.push(evt);
    if (this._history.length > this._historyCap) {
      this._history.splice(0, this._history.length - this._historyCap);
    }
    const dispatch = (set) => {
      if (!set) return;
      for (const h of set) {
        try { h(payload, { type: evt.type, ts: evt.ts, seq: evt.seq }); }
        catch (e) { /* isolated */ }
      }
    };
    dispatch(this._subs.get(type));
    dispatch(this._subs.get('*'));
  }

  /** Emit many events in order. */
  emitAll(events) {
    for (const { type, payload } of events) this.emit(type, payload);
  }

  /** Recent emissions (newest last). */
  history(filterType) {
    return filterType ? this._history.filter(e => e.type === filterType) : this._history.slice();
  }

  /** Clear all subscriptions and history (used in tests). */
  reset() {
    this._subs.clear();
    this._history.length = 0;
  }
}

/** Singleton bus for the app. Imported by both sim and UI. */
export const bus = new EventBus();

/** Canonical event type registry. Keep alphabetised. Add new types here. */
export const EVT = Object.freeze({
  // Day / calendar
  ADVANCE_DAY_START:    'ADVANCE_DAY_START',
  ADVANCE_DAY_END:      'ADVANCE_DAY_END',
  PHASE_MORNING:        'PHASE_MORNING',
  PHASE_MIDDAY:         'PHASE_MIDDAY',
  PHASE_EVENING:        'PHASE_EVENING',
  MATCHDAY_REACHED:     'MATCHDAY_REACHED',
  MATCH_PAUSED:         'MATCH_PAUSED',
  MATCH_RESUMED:        'MATCH_RESUMED',
  // Match engine
  MATCH_KICKOFF:        'MATCH_KICKOFF',
  MATCH_EVENT:          'MATCH_EVENT',          // generic match feed event
  GOAL_SCORED:          'GOAL_SCORED',
  SHOT_SAVED:           'SHOT_SAVED',
  SHOT_MISSED:          'SHOT_MISSED',
  SHOT_BLOCKED:         'SHOT_BLOCKED',
  SHOT_POST:            'SHOT_POST',
  CORNER_AWARDED:       'CORNER_AWARDED',
  FOUL_COMMITTED:       'FOUL_COMMITTED',
  YELLOW_CARD:          'YELLOW_CARD',
  RED_CARD:             'RED_CARD',
  SUBSTITUTION_MADE:    'SUBSTITUTION_MADE',
  INJURY_OCCURRED:      'INJURY_OCCURRED',
  MOMENTUM_SHIFT:       'MOMENTUM_SHIFT',
  TACTICAL_SHIFT:       'TACTICAL_SHIFT',
  HALF_TIME:            'HALF_TIME',
  FULL_TIME:            'FULL_TIME',
  // Post-match
  MATCH_REPORT:         'MATCH_REPORT',
  LEAGUE_TABLE_UPDATED: 'LEAGUE_TABLE_UPDATED',
  PLAYER_FORM_CHANGED:  'PLAYER_FORM_CHANGED',
  PLAYER_FITNESS_CHANGED:'PLAYER_FITNESS_CHANGED',
  PLAYER_INJURED:       'PLAYER_INJURED',
  PLAYER_SUSPENDED:     'PLAYER_SUSPENDED',
  MORALE_SHIFT:         'MORALE_SHIFT',
  BOARD_CONFIDENCE_SHIFT:'BOARD_CONFIDENCE_SHIFT',
  MEDIA_HEADLINE:       'MEDIA_HEADLINE',
  FINANCE_TRANSACTION:  'FINANCE_TRANSACTION',
  MANAGER_XP_GAIN:      'MANAGER_XP_GAIN',
  // Persistence
  SAVE_WRITTEN:         'SAVE_WRITTEN',
  SAVE_LOADED:          'SAVE_LOADED',
  SAVE_MIGRATED:        'SAVE_MIGRATED',
  // Inbound
  INBOX_MESSAGE:        'INBOX_MESSAGE',
  // Validation
  INVARIANT_VIOLATION:  'INVARIANT_VIOLATION',
  // UI re-render fan-out
  STATE_BATCH:          'STATE_BATCH'
});
