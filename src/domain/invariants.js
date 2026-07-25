// domain/invariants.js
// Rules that must always hold in a valid GameState.
// `dispatch` calls validateAction(state, action) BEFORE mutating,
// and validateState(newState) AFTER. Violations are either auto-corrected
// (where safe) or rejected with an INVARIANT_VIOLATION event.

import { logger } from '../core/logger.js';

/**
 * Validate the GameState as a whole. Returns {ok, violations: []}.
 * Pure function — does not mutate.
 */
export function validateState(state) {
  const v = [];

  // Squad size 16..25 registered players per club (we check user club +
  // all clubs to keep AI honest too)
  for (const [cid, club] of state.entities.clubs) {
    const registered = (club.squadIds || [])
      .map(pid => state.entities.players.get(pid))
      .filter(p => p && p.registered && !p.onLoan);
    if (registered.length < 16) {
      v.push({ rule: 'squad_min', clubId: cid, n: registered.length });
    }
    if (registered.length > 25) {
      v.push({ rule: 'squad_max', clubId: cid, n: registered.length });
    }
  }

  // Wage bill vs ceiling (user club only — AI can manage its own)
  const userClubId = state.meta.userClubId;
  const userClub = state.entities.clubs.get(userClubId);
  if (userClub) {
    const wages = (userClub.squadIds || [])
      .map(pid => state.entities.players.get(pid))
      .filter(Boolean)
      .reduce((s, p) => s + p.wage, 0);
    if (wages > userClub.wageCeiling) {
      v.push({ rule: 'wage_ceiling', clubId: userClubId, wages, ceiling: userClub.wageCeiling });
    }
  }

  // Transfer budget cannot go negative without board approval flag
  if (state.finance.transferBudget < 0 && !state.finance.boardOverdraftApproved) {
    v.push({ rule: 'transfer_budget_negative', value: state.finance.transferBudget });
  }

  // A player cannot be in two places (starting XI + bench + injured list)
  // — only meaningful on matchday; checked when validating SET_LINEUP.
  // (Static check skipped here; enforced in validateAction below.)

  // Fixture results must be consistent with league table.
  // We recompute the table from played fixtures and compare Pts/GF/GA.
  // Cache mismatch is a soft violation — we recompute and overwrite.
  const recomputed = recomputeLeagueTable(state);
  const cached = state.competitions.league.table;
  let tableMismatch = false;
  for (const row of recomputed) {
    const c = cached.find(r => r.clubId === row.clubId);
    if (!c || c.P !== row.P || c.W !== row.W || c.D !== row.D || c.L !== row.L ||
        c.GF !== row.GF || c.GA !== row.GA || c.Pts !== row.Pts) {
      tableMismatch = true;
      break;
    }
  }
  if (tableMismatch) v.push({ rule: 'table_out_of_sync', severity: 'soft' });

  return { ok: v.length === 0, violations: v };
}

/**
 * Validate an action against the current state. Returns
 * { ok, reason, autoFix? }. If autoFix is provided, dispatch will
 * apply it (a modified action) instead of rejecting.
 */
export function validateAction(state, action) {
  switch (action.type) {
    case 'SET_LINEUP': {
      const { clubId, starting = [], bench = [] } = action.payload || {};
      // No player can appear in both starting and bench
      const ids = new Set(starting);
      for (const pid of bench) {
        if (ids.has(pid)) {
          return { ok: false, reason: 'player_in_two_places', pid };
        }
        ids.add(pid);
      }
      // Injured & suspended cannot be selected
      for (const pid of [...starting, ...bench]) {
        const p = state.entities.players.get(pid);
        if (!p) continue;
        if (p.inj) return { ok: false, reason: 'player_injured', pid };
        if (p.susp > 0) return { ok: false, reason: 'player_suspended', pid };
      }
      // Starting XI must be exactly 11 (allow less for testing / short squads)
      if (starting.length > 11) {
        return { ok: false, reason: 'too_many_starters', n: starting.length };
      }
      return { ok: true };
    }

    case 'SET_TACTICS': {
      // No hard rules — any club can adjust tactics freely. Could add
      // "must have 11 fit players for chosen formation" later.
      return { ok: true };
    }

    case 'TRANSFER_BID': {
      const { amount } = action.payload || {};
      if (amount == null || amount < 0) {
        return { ok: false, reason: 'invalid_amount' };
      }
      if (amount > state.finance.transferBudget && !state.finance.boardOverdraftApproved) {
        return { ok: false, reason: 'budget_exceeded', amount, budget: state.finance.transferBudget };
      }
      return { ok: true };
    }

    case 'ADVANCE_DAY':
    case 'SAVE':
    case 'LOAD':
    case 'RESET_MATCH_TRANSIENT':
    case 'DISMISS_MESSAGE':
    case 'RESOLVE_MESSAGE':
    case 'SET_SPEED':
    case 'PAUSE_MATCH':
    case 'RESUME_MATCH':
    case 'SHOUT':
      return { ok: true };

    default:
      // Unknown actions are not fatal — log and allow (extension point).
      logger.debug('invariants', 'unknown action type allowed through', { type: action.type });
      return { ok: true };
  }
}

/**
 * Recompute the league table from played fixtures. Pure function.
 * Returns a sorted array of league rows. The dispatch layer calls this
 * after any state mutation that could affect the table, and writes the
 * result back into state.competitions.league.table.
 */
export function recomputeLeagueTable(state) {
  const rows = new Map();
  for (const cid of state.entities.clubs.keys()) {
    rows.set(cid, {
      clubId: cid, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0, form: []
    });
  }
  const played = state.competitions.league.fixtures.filter(f => f.status === 'played' && f.result);
  for (const fx of played) {
    if (!rows.has(fx.homeId) || !rows.has(fx.awayId)) continue;
    const h = rows.get(fx.homeId), a = rows.get(fx.awayId);
    const hs = fx.result.hs, as = fx.result.as;
    h.P++; a.P++;
    h.GF += hs; h.GA += as; h.GD = h.GF - h.GA;
    a.GF += as; a.GA += hs; a.GD = a.GF - a.GA;
    if (hs > as) { h.W++; h.Pts += 3; a.L++; h.form.push('W'); a.form.push('L'); }
    else if (hs < as) { a.W++; a.Pts += 3; h.L++; h.form.push('L'); a.form.push('W'); }
    else { h.D++; a.D++; h.Pts++; h.form.push('D'); a.form.push('D'); }
  }
  // Trim form arrays to last 5
  for (const r of rows.values()) if (r.form.length > 5) r.form = r.form.slice(-5);
  // Sort: Pts desc, GD desc, GF desc, name asc
  const arr = [...rows.values()];
  arr.sort((a, b) =>
    b.Pts - a.Pts ||
    b.GD  - a.GD  ||
    b.GF  - a.GF  ||
    (state.entities.clubs.get(a.clubId)?.name || '').localeCompare(state.entities.clubs.get(b.clubId)?.name || '')
  );
  return arr;
}

/**
 * Auto-correct any soft violations in state. Mutates. Returns list of
 * corrections applied.
 */
export function autoCorrect(state) {
  const corrections = [];
  // Recompute league table cache if mismatched
  const recomputed = recomputeLeagueTable(state);
  const cached = state.competitions.league.table;
  const same = recomputed.length === cached.length &&
    recomputed.every((r, i) =>
      r.clubId === cached[i]?.clubId &&
      r.P === cached[i].P && r.W === cached[i].W && r.D === cached[i].D &&
      r.L === cached[i].L && r.GF === cached[i].GF && r.GA === cached[i].GA &&
      r.Pts === cached[i].Pts);
  if (!same) {
    state.competitions.league.table = recomputed;
    corrections.push({ rule: 'table_out_of_sync', action: 'recomputed' });
  }
  return corrections;
}
