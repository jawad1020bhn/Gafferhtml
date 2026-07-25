// ui/panels.js
// Bridges the new GameState to the legacy render functions in index.html.
// The legacy script declares its data as `var CLUBS = {...}` etc., which
// attaches them to `window`. We overwrite these `window` properties from
// the GameState on every state change, so the legacy render functions
// read fresh data without being rewritten.
//
// This is the surgical preservation strategy: zero changes to render
// functions; only their data source is swapped.

import { groupOf } from '../domain/entities.js';
import { recomputeLeagueTable } from '../domain/invariants.js';

/**
 * Sync all legacy globals from the current GameState.
 * Call this after every state mutation.
 */
export function syncLegacyGlobals(state) {
  const userClub = state.entities.clubs.get(state.meta.userClubId);
  if (!userClub) return;

  // -------- CLUBS (keyed by 3-letter code) --------
  const clubsByCode = {};
  for (const c of state.entities.clubs.values()) {
    clubsByCode[c.code] = {
      n: c.name, code: c.code, c1: c.c1, c2: c.c2,
      rep: c.rep, bud: c.budget, atk: c.atk, def: c.def,
      st: c.stadium, cap: c.capacity, mgr: c.managerName, cty: c.city
    };
  }
  window.CLUBS = clubsByCode;

  // -------- PLAYERS (user club squad, in legacy field shape) --------
  // Map state.players → legacy shape {id, n, pos, grp, age, nat, ovr, pot, val, wage, con, form, fit, sharp, mor, role, st, traits, pers, hg, apps, g, a, rt, captain, listed, ask, unrest, gk, cs, careerG}
  const legacyPlayers = userClub.squadIds
    .map(id => state.entities.players.get(id))
    .filter(Boolean)
    .map(p => {
      const grp = p.grp || groupOf(p.pos);
      const st = p.inj ? 'inj' : (p.susp > 0 ? 'susp' : (p.fit < 70 ? 'doubt' : 'ok'));
      return {
        id: p.id,
        n: p.name,
        pos: p.pos, grp,
        age: p.age, nat: p.nat,
        ovr: p.ovr, pot: p.pot,
        val: p.val || 0,
        wage: p.wage,
        con: p.contractUntil,
        form: typeof p.form === 'number' ? p.form : 6.0,
        fit: p.fit,
        sharp: Math.round((p.fit + (p.form || 6) * 10) / 2),  // derive sharpness
        mor: p.mor,
        role: p.role || 'Squad Player',
        st,
        injT: p.inj?.type, injW: p.inj?.daysLeft ? Math.ceil(p.inj.daysLeft / 7) : 0, injSev: p.inj?.severity,
        suspD: p.susp || 0,
        traits: p.traits || [],
        pers: p.pers || { prof: 75, amb: 75, loy: 75, lead: 60, temp: 70 },
        hg: p.hg ? 1 : 0,
        apps: p.stats?.apps || 0,
        g: p.stats?.goals || 0,
        a: p.stats?.assists || 0,
        cs: p.stats?.cs || 0,
        rt: p.rt || (p.form || 6.5),
        captain: p.captain ? 1 : 0,
        listed: p.listed ? 1 : 0,
        ask: p.ask,
        unrest: p.unrest ? 1 : 0,
        gk: p.gk ? 1 : 0,
        careerG: p.careerG || p.stats?.goals || 0,
        conExp: p.contractUntil === state.clock.seasonYear + 1 ? 1 : 0,
        num: p.num || 0,
        foot: p.hidden?.weakFoot >= 0.7 ? 'Both' : 'Right'
      };
    });
  window.PLAYERS = legacyPlayers;
  // Re-attach helpers that close over PLAYERS — they're already window-scoped
  // via `var P = id => PLAYERS.find(...)` so they read the new array automatically.
  // But we need to refresh the `P` reference since `var P = ...` was assigned
  // at script load. Actually `var P = id => PLAYERS.find(...)` reads `PLAYERS`
  // from window at call time, so it works.
  // Re-attach GRP closure too
  if (typeof window.GRP === 'function') {
    // legacy GRP is already window-scoped; no action needed
  }

  // -------- STD (league table in legacy shape) --------
  const table = state.competitions.league.table.length
    ? state.competitions.league.table
    : recomputeLeagueTable(state);
  const std = table.map(row => {
    const club = state.entities.clubs.get(row.clubId);
    return {
      c: club?.code || '???',
      P: row.P, W: row.W, D: row.D, L: row.L,
      GF: row.GF, GA: row.GA, GD: row.GD, Pts: row.Pts,
      form: row.form || []
    };
  });
  window.STD = std;
  if (typeof window.sortSTD === 'function') window.sortSTD();

  // -------- FIX (user club fixtures, legacy shape) --------
  const userId = state.meta.userClubId;
  const fix = state.competitions.league.fixtures
    .filter(f => f.homeId === userId || f.awayId === userId)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(f => {
      const homeCode = state.entities.clubs.get(f.homeId)?.code || '???';
      const awayCode = state.entities.clubs.get(f.awayId)?.code || '???';
      const userIsHome = f.homeId === userId;
      const hs = f.result ? (userIsHome ? f.result.hs : f.result.as) : null;
      const as = f.result ? (userIsHome ? f.result.as : f.result.hs) : null;
      // Legacy FIX used user-perspective hs/as. We preserve that for compat.
      const realHomeScore = f.result?.hs;
      const realAwayScore = f.result?.as;
      return {
        mw: f.matchweek || 0,
        d: formatLegacyDate(f.date),
        h: homeCode,
        a: awayCode,
        hs: realHomeScore,
        as: realAwayScore,
        c: f.competition === 'cup-league' ? 'CUP' : 'PL',
        rd: f.cupRound,
        derby: f.isDerby ? 1 : undefined
      };
    });
  window.FIX = fix;
  // nextFix() reads window.FIX at call time, so it's already fresh.

  // -------- INBOX (legacy shape) --------
  const inbox = state.inbox.map(m => ({
    id: m.id,
    sev: m.severity,
    from: m.sender?.split(' · ')[0] || m.sender,
    who: m.sender?.split(' · ')[1] || '',
    t: m.subject,
    b: m.body,
    ago: m.receivedAt || '',
    done: m.done ? 1 : 0,
    choices: (m.choices || []).map(c => ({ l: c.label, e: c.note, k: c.action?.kind }))
  }));
  window.INBOX = inbox;

  // -------- S (UI state + transient flags) --------
  // Legacy S mixed UI flags with simulation state. We preserve the UI flags
  // and sync simulation state from GameState.
  const oldS = window.S || {};
  const newS = {
    ...oldS,                                    // preserve UI flags (scr, squadTab, etc.)
    scr: state.transient?.ui?.scr || oldS.scr || 'dash',
    date: new Date(state.clock.date),
    day: state.clock.dayNumber,
    budget: state.finance.transferBudget,
    wageFree: Math.max(0, (userClub.wageCeiling - userClub.squadIds
      .map(id => state.entities.players.get(id))
      .filter(Boolean)
      .reduce((s, p) => s + p.wage, 0))),
    formation: userClub.tactics.formation,
    mentality: capitalise(userClub.tactics.mentality),
    playStyle: userClub.tactics.personality === 'possession' ? 'Possession'
             : userClub.tactics.pressing === 'high' ? 'Gegenpress'
             : userClub.tactics.personality === 'counter' ? 'Counter-Attack'
             : 'Balanced',
    build: capitalise(userClub.tactics.tempo),
    line: capitalise(userClub.tactics.lineHeight),
    press: capitalise(userClub.tactics.pressing),
    fam: 78,                                    // familiarity — not yet simulated
    league: 'mpd',
    kickIdx: 8,
    matchPlayed: false
  };
  window.S = newS;

  // -------- FIN (finance summary) --------
  const fsum = state.finance.summary || {};
  window.FIN = {
    balance: state.finance.balance / 1e6,
    debt: fsum.debt / 1e6,
    credit: fsum.credit,
    rate: fsum.rate,
    limit: fsum.limit / 1e6,
    ffp: fsum.ffp,
    wageRatio: fsum.wageRatio,
    inc: fsum.inc,
    exp: fsum.exp,
    pnl: fsum.pnl
  };

  // -------- BOARD --------
  window.BOARD = {
    conf: { ...state.board.confidence },
    expL: state.board.expectations.league,
    expC: state.board.expectations.cup,
    owner: state.board.owner
  };

  // -------- FANS --------
  window.FANS = { ...state.fans };

  // -------- STADIUM --------
  window.STADIUM = { ...state.stadium };

  // -------- MANAGER --------
  const m = state.manager;
  window.MANAGER = {
    n: m.name, age: m.age, nat: m.nat, arch: m.arch, rep: m.rep,
    lvl: m.lvl, xp: m.xp, xpNext: m.xpNext, sp: m.sp, kp: m.kp, sec: m.sec,
    con: m.con, wage: m.wage,
    g: m.record.g, w: m.record.w, d: m.record.d, l: m.record.l, tr: m.record.tr
  };
  window.SKILLS = m.skills;
  window.SHADOWS = m.shadows;
  window.CAREER = m.career;
  window.TROPHIES = m.trophies;
  window.AWARDS = m.awards;

  // -------- Facilities / sponsors / etc. --------
  window.FACILITIES = state.facilities;
  window.SPONSORS = state.sponsors;
  window.OFFERS = state.sponsorOffers;
  window.SCOUTS = state.scouts;
  window.PROSPECTS = state.prospects;
  window.TARGETS = state.transferTargets;
  window.NEGOS = state.negotiations;
  window.LEAGUES = state.worldLeagues.map(l => ({ ...l, clubs: [] }));
  // Backfill league[0] clubs (Meridian PD = our league)
  if (window.LEAGUES[0]) {
    window.LEAGUES[0].clubs = [...state.entities.clubs.values()].map(c => ({ c: c.code }));
  }
  window.NATIONS = state.nations;
  window.ACTIVITY = state.activity;
  window.WORLDECON = state.worldEcon;
  window.BRAND = state.brand;
  window.OUTLETS = {
    'Sports Central': 'Major',
    'The Meridian Times': 'Quality',
    'The Daily Kick': 'Tabloid',
    'Transfer Insider': 'Insider',
    'Tactics Weekly': 'Analysis',
    'Ravensport Echo': 'Local'
  };
  // Agents (legacy shape) — with Step 4.4 memory warmth
  window.AGENTS = [...state.entities.agents.values()].map(a => ({
    id: a.id, n: a.name, pers: a.pers, rep: a.rep, skill: a.skill, comm: a.comm,
    clients: a.clientIds,
    warmth: a.memory?.warmth ?? 50      // Step 4.4: agent memory warmth
  }));

  // -------- NEWS / SOCIAL --------
  window.NEWS = state.media.headlines.map(h => ({
    o: h.outlet, cat: h.cat, t: h.t, b: h.b, ago: h.ago, likes: h.likes
  }));
  window.SOCIAL = [];  // not yet simulated; legacy UI gracefully handles empty

  // -------- LEADERS (scorers/assists) — derived from user club only for now --------
  const userScorers = window.PLAYERS
    .filter(p => p.g > 0)
    .sort((a, b) => b.g - a.g)
    .slice(0, 7)
    .map(p => ({ n: p.n, c: 'RAV', g: p.g }));
  const userAssisters = window.PLAYERS
    .filter(p => p.a > 0)
    .sort((a, b) => b.a - a.a)
    .slice(0, 5)
    .map(p => ({ n: p.n, c: 'RAV', a: p.a }));
  window.LEADERS = { scorers: userScorers, assists: userAssisters };

  // -------- LASTMATCH (most-recently-played user fixture) --------
  const userId2 = state.meta.userClubId;
  const lastPlayed = state.competitions.league.fixtures
    .filter(f => f.status === 'played' && (f.homeId === userId2 || f.awayId === userId2))
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  if (lastPlayed?.result) {
    const homeCode = state.entities.clubs.get(lastPlayed.homeId)?.code;
    const awayCode = state.entities.clubs.get(lastPlayed.awayId)?.code;
    window.LASTMATCH = {
      h: homeCode, a: awayCode,
      hs: lastPlayed.result.hs, as: lastPlayed.result.as,
      comp: lastPlayed.competition === 'cup-league' ? 'Meridian League Cup · R4' : 'Meridian Premier Division · MW' + (lastPlayed.matchweek || ''),
      att: Math.round((userClub.capacity || 30000) * 0.92),
      scorers: lastPlayed.result.events?.filter(e => e.type === 'goal').map(e => [e.scorer?.name || 'Goal', e.minute]) || [],
      stats: lastPlayed.result.report?.stats || { pos: [50, 50], sh: [0, 0], sot: [0, 0], cor: [0, 0], fouls: [0, 0], yc: [0, 0] },
      xg: lastPlayed.result.report?.stats?.xG || [0, 0],
      motm: lastPlayed.result.report?.motm ? { n: lastPlayed.result.report.motm.name, rt: lastPlayed.result.report.motm.rating } : null,
      rats: lastPlayed.result.report?.playerStats?.sort((a, b) => b.rating - a.rating).slice(0, 5).map(p => [p.name, p.rating]) || [],
      mom: generateMomentumArray(lastPlayed.result.report)
    };
  }

  // -------- OTHER_MW8 / OTHER_MW9 (legacy: not needed going forward) --------
  // These were used to display other MW results. We now derive them from state
  // on demand in renderMatch. Leave as empty arrays for safety.
  // -------- Step 3+4: Training, Development, Transfers --------
  // Training schedule (Step 3.1)
  window.TRAINING = {
    schedule: state.training?.schedule || {},
    autoSchedule: state.training?.autoSchedule ?? true,
    familiarity: state.training?.familiarity ?? 78,
    matchPrepMod: state.training?.matchPrepMod ?? 0
  };
  // Development reports (Step 3.9)
  window.DEV_REPORTS = state.developmentReports || [];
  // Mentorship pairings (Step 3.8)
  window.MENTORSHIPS = state.relationships?.mentorships || [];
  // Active loans (Step 4.7)
  window.LOANS = state.relationships?.loans || [];
  // Negotiations (Step 4.3)
  window.NEGOTIATIONS = state.negotiations || [];
  // Incoming bids on user's players (Step 4.6)
  window.INCOMING_BIDS = state.incomingBids || [];
  // Free agent pool (Step 4.7)
  window.FREE_AGENTS = state.freeAgents || [];
  // Bosman pre-contracts (Step 4.8)
  window.BOSMAN_PRECONTRACTS = state.bosmanPreContracts || [];
  // Transfer window status (Step 4.9)
  window.TRANSFER_WINDOW = state.transferWindow || { open: true };

  // Sharpness & form trend for each user player (Step 3.5 + 3.6)
  for (const p of window.PLAYERS || []) {
    const real = state.entities.players.get(p.id);
    if (real) {
      p.sharp = real.sharp ?? 70;
      p.sharpMod = (real.sharp ?? 70) >= 90 ? 0.05 :
                   (real.sharp ?? 70) >= 70 ? 0 :
                   (real.sharp ?? 70) >= 50 ? -0.04 :
                   (real.sharp ?? 70) >= 30 ? -0.08 : -0.15;
      p.formTrend = formTrendFor(real);
      p.effectivePA = real.effectivePA ?? real.pot;
      p.sellHighWindow = !!real._sellHighFlagged;
      p.wonderkidConfirmed = !!real._wonderkidConfirmed;
      p.unrestStage = real.unrestStage || 0;
    }
  }

  window.OTHER_MW8 = window.OTHER_MW8 || [];
  window.OTHER_MW9 = window.OTHER_MW9 || [];
}

function formatLegacyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return (d.getDate() + '').padStart(2, '0') + ' ' + months[d.getMonth()];
}

function capitalise(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Form trend arrow for a player (Step 3.5).
 * Returns 'up' | 'down' | 'flat'.
 */
function formTrendFor(player) {
  const recent = (player.formHist || []).slice(-3);
  if (recent.length < 3) return 'flat';
  const delta = recent[2] - recent[0];
  if (delta > 0.5) return 'up';
  if (delta < -0.5) return 'down';
  return 'flat';
}

function generateMomentumArray(report) {
  // Generate a per-minute momentum array for the momentum graph
  const arr = [];
  let v = 0.1;
  for (let i = 0; i < 90; i++) {
    v += (Math.random() - 0.5) * 0.2;
    v = Math.max(-1, Math.min(1, v));
    arr.push(v);
  }
  // Overlay spikes at goal events
  if (report?.events) {
    for (const evt of report.events) {
      if (evt.type === 'goal' && evt.minute < 90) {
        arr[evt.minute - 1] = evt.team === 0 ? 0.8 : -0.6;
      }
    }
  }
  return arr;
}

/**
 * Force a re-render of the currently-active screen.
 * Called after every state mutation.
 */
export function rerender() {
  if (typeof window.show !== 'function') return;
  const scr = window.S?.scr || 'dash';
  // The legacy `show()` function both switches tabs and calls the renderer.
  // We call it directly to re-render the active screen.
  // Avoid calling show() if the screen hasn't changed (it would reset scroll).
  // Instead, call the renderer directly.
  const fns = {
    dash: window.renderDash, squad: window.renderSquad, tactics: window.renderTactics,
    match: window.renderMatch, transfers: window.renderTransfers, club: window.renderClub,
    academy: window.renderAcademy, world: window.renderWorld, manager: window.renderManager,
    news: window.renderNews
  };
  const fn = fns[scr];
  if (typeof fn === 'function') {
    try { fn(); } catch (e) { console.error('rerender failed', scr, e); }
  }
  if (typeof window.renderHeader === 'function') {
    try { window.renderHeader(); } catch (_) {}
  }
}
