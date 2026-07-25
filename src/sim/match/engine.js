// sim/match/engine.js
// Match simulation engine. Orchestrates prematch -> possession stream ->
// shot/xG resolution -> momentum/fatigue -> set pieces -> AI decisions ->
// narrative -> postmatch.
//
// Determinism: every random draw uses the supplied PRNG (forked from the
// save seed + fixture ID + day). Same seed → same match.
//
// Two modes:
//   emitEvents: true  — stream events to the UI bus (user match)
//   emitEvents: false — silent (AI vs AI), only returns the final report

import { logger } from '../../core/logger.js';
import { bus, EVT } from '../../core/eventBus.js';
import { PRNG } from '../../core/prng.js';

import { lockLineup, tacticalMatchupMatrix, conditionModifiers, aiTacticalProfile, synthesizeAILineup, FORMATIONS } from './prematch.js';
import { allocatePossession, simulatePossession, isCounterAttack } from './possession.js';
import { computeXG, pickShotZone, pickShotType } from './xg.js';
import { resolveShot, resolveRebound, gkDistribution } from './shot.js';
import { MomentumState, DRIVERS } from './momentum.js';
import { tickPlayerFatigue, squadFatigueSummary, rollInjury, rollFoulInjury, fatigueEffects } from './fatigue.js';
import { resolveCorner, resolveFreeKick, resolvePenalty, resolveThrowOrGoalKick } from './setpiece.js';
import { decideAIActions, applyAIAction, adjustForRedCard } from './ai.js';
import * as narrative from './narrative.js';
import { buildMatchReport, buildPostMatchHeadlines } from './postmatch.js';

/**
 * Run a full match.
 *
 * @param {Object} opts
 *   state, fixture, prng, emitEvents=true, userIsHome, userIsAway,
 *   userLineup (optional — for user match; if absent, derived from club tactics)
 *
 * @returns {Object} MatchReport
 */
export function runMatch(opts) {
  const { state, fixture, prng, emitEvents = true, userIsHome = false, userIsAway = false } = opts;

  const homeClub = state.entities.clubs.get(fixture.homeId);
  const awayClub = state.entities.clubs.get(fixture.awayId);
  if (!homeClub || !awayClub) {
    logger.error('match', 'club not found for fixture', { fixtureId: fixture.id });
    return null;
  }

  // ---- 1. Prematch: lineups, tactics, conditions ----
  const homeSetup = opts.homeSetup || (userIsHome
    ? lockLineup(state, fixture.homeId, opts.userLineup || { formation: homeClub.tactics.formation, starting: pickAutoXI(state, fixture.homeId), bench: pickAutoBench(state, fixture.homeId) })
    : synthesizeAILineup(state, homeClub, prng));
  const awaySetup = opts.awaySetup || (userIsAway
    ? lockLineup(state, fixture.awayId, opts.userLineup || { formation: awayClub.tactics.formation, starting: pickAutoXI(state, fixture.awayId), bench: pickAutoBench(state, fixture.awayId) })
    : synthesizeAILineup(state, awayClub, prng));

  if (homeSetup?.error) {
    logger.warn('match', 'home lineup error, falling back to synthetic', { error: homeSetup.error });
    return runMatch({ ...opts, homeSetup: synthesizeAILineup(state, homeClub, prng) });
  }
  if (awaySetup?.error) {
    logger.warn('match', 'away lineup error, falling back to synthetic', { error: awaySetup.error });
    return runMatch({ ...opts, awaySetup: synthesizeAILineup(state, awayClub, prng) });
  }

  const matchup = tacticalMatchupMatrix(homeSetup, awaySetup, homeClub, awayClub);
  const conditions = conditionModifiers(state, fixture, homeClub, awayClub);
  const tactics = {
    home: { ...homeClub.tactics },
    away: { ...awayClub.tactics }
  };

  // ---- 2. Match context ----
  // IMPORTANT: clone any state entities we're going to mutate during the
  // match (player.match, tactics). The engine must NOT mutate state.*.
  for (const s of [...homeSetup.starting, ...awaySetup.starting]) {
    if (!s.synthetic && s.playerId) {
      // Stash a transient match-state object on the slot — never on the player.
      s.playerSnapshot = state.entities.players.get(s.playerId);
      s.match = { stamina: 100, started: true, subbedIn: null };
    }
  }
  const ctx = {
    state, fixture,
    setup: { home: homeSetup, away: awaySetup },
    tactics,
    matchup, conditions,
    userClubId: state.meta.userClubId,
    userIsHome, userIsAway,
    minute: 0,
    half: 1,
    score: { home: 0, away: 0 },
    momentum: new MomentumState(),
    stats: {
      possession: [50, 50],     // running average
      shots: [0, 0], sot: [0, 0], corners: [0, 0], fouls: [0, 0],
      hXG: 0, aXG: 0,
      passes: [0, 0], ppda: [10, 10]
    },
    cards: { y: [0, 0], r: [0, 0] },
    events: [],
    playerStats: [],
    injuries: [],
    possessionCount: [0, 0],
    lastPossession: null,
    timeWasting: { 0: false, 1: false },
    _aiShifted: {}, _aiParked: {}, _aiSettled: {}, _aiSubbed: {}, _aiAttSub: {},
    _minuteEvents: 0
  };

  // Initialise player stats trackers (include synthetic players for AI-vs-AI)
  for (const s of [...homeSetup.starting, ...awaySetup.starting]) {
    const stat = {
      playerId: s.playerId || ('syn_' + s.clubId + '_' + s.slotIdx),
      name: s.synthetic ? `${s.slotPos} (${state.entities.clubs.get(s.clubId)?.code || '?'})` : getPlayerName(state, s.playerId),
      synthetic: !!s.synthetic,
      pos: s.slotPos, mins: 0, goals: 0, assists: 0, cs: false,
      keyPasses: 0, tackles: 0, errors: 0, cards: { y: 0, r: 0 },
      xg: 0, motm: false, rating: 6.0
    };
    // Stash the stat reference on the slot for in-loop updates
    s._stat = stat;
    ctx.playerStats.push(stat);
  }

  if (emitEvents) bus.emit(EVT.MATCH_KICKOFF, { fixtureId: fixture.id, home: homeClub.code, away: awayClub.code });
  if (emitEvents) pushEvent(ctx, 0, '', 'kickoff', null, `${homeClub.code} v ${awayClub.code} — kickoff.`);

  // ---- 3. Main loop: 90 minutes + stoppage ----
  const stoppage = computeStoppage(prng, ctx);
  const maxMinute = 90 + stoppage;

  let minute = 1;
  while (minute <= maxMinute) {
    ctx.minute = minute;
    ctx._minuteEvents = 0;

    // Half-time at 45'
    if (minute === 46) {
      ctx.half = 2;
      if (emitEvents) bus.emit(EVT.HALF_TIME, { score: ctx.score });
      pushEvent(ctx, 45, narrative.halfTimeNarrative(ctx.score), 'halftime', null, '');
    }

    // Momentum tick
    ctx.momentum.tickMinute(minute);

    // Fatigue: tick every player. We pass the slot itself (which has .match
    // and a .playerSnapshot for attribute lookup). The engine NEVER mutates
    // state.entities.players during a match.
    for (const s of ctx.setup.home.starting) {
      tickPlayerFatigue(s, s.slotPos, ctx.tactics.home);
      if (s.synthetic) s.match = { stamina: Math.max(0, 100 - minute * 0.3) };
    }
    for (const s of ctx.setup.away.starting) {
      tickPlayerFatigue(s, s.slotPos, ctx.tactics.away);
      if (s.synthetic) s.match = { stamina: Math.max(0, 100 - minute * 0.3) };
    }

    // Update possession-based fatigue summary for possession model
    const homeFatigue = squadFatigueSummary(ctx.setup.home);
    const awayFatigue = squadFatigueSummary(ctx.setup.away);
    ctx.fatigue = {
      home: homeFatigue.avg, away: awayFatigue.avg,
      homeMid: homeFatigue.mid, awayMid: awayFatigue.mid
    };

    // ---- Possession ----
    const possessionTeam = allocatePossession(prng, ctx);
    ctx.possessionCount[possessionTeam]++;
    const poss = simulatePossession(prng, ctx, possessionTeam);

    // Update running possession % (weighted average)
    const total = ctx.possessionCount[0] + ctx.possessionCount[1];
    ctx.stats.possession[0] = (ctx.possessionCount[0] / total) * 100;
    ctx.stats.possession[1] = (ctx.possessionCount[1] / total) * 100;

    // Apply momentum effects: dominant team presses more, creates more
    const dominant = ctx.momentum.dominantTeam();
    if (dominant === possessionTeam && ctx.momentum.isSiege() && prng.chance(0.25)) {
      // Siege mode: extra final-third entry
      if (emitEvents) pushEvent(ctx, minute, `${ctx.setup[possessionTeam === 0 ? 'home' : 'away'].clubTactics?.code || ''} pour forward in siege mode.`, 'ambient', possessionTeam, '');
    }

    // Process possession outcome
    processPossessionOutcome(ctx, poss, prng, emitEvents);

    // Increment minutes by possession duration
    minute += Math.max(1, Math.round(poss.durationMins));

    // ---- AI manager decisions ----
    if (!userIsHome) {
      for (const action of decideAIActions(ctx, 0)) applyAIAction(ctx, action, 0);
    }
    if (!userIsAway) {
      for (const action of decideAIActions(ctx, 1)) applyAIAction(ctx, action, 1);
    }

    // ---- Random events: fouls, cards, injuries ----
    if (prng.chance(0.04 * ctx.conditions.derbyFoulMult)) {
      const team = prng.next() < 0.5 ? 0 : 1;
      commitFoul(ctx, prng, team, emitEvents);
    }

    // ---- Player touchline shout effects (if user shouted this match) ----
    if (state.transient?.lastShout && Date.now() - state.transient.lastShout.ts < 10000) {
      applyShoutEffect(ctx, state.transient.lastShout.kind, userIsHome ? 0 : 1);
    }

    // ---- Ambient commentary (only in detailed speed) ----
    if (emitEvents && minute % 8 === 0 && ctx._minuteEvents === 0 && getSpeed(state) === 'detailed') {
      pushEvent(ctx, minute, narrative.ambientNarrative(prng, minute, ctx.stats.possession[0], ctx.momentum.value), 'ambient', null, '');
    }

    // Minute markers
    if (emitEvents && minute === 30) pushEvent(ctx, 30, `Half-hour: ${ctx.stats.possession[0].toFixed(0)}%–${ctx.stats.possession[1].toFixed(0)}% possession.`, 'marker', null, '');
    if (emitEvents && minute === 60) pushEvent(ctx, 60, `Hour mark: ${ctx.score.home}–${ctx.score.away}.`, 'marker', null, '');
    if (emitEvents && minute === 75 && ctx.score.home === ctx.score.away) pushEvent(ctx, 75, 'Quarter-hour left. The tension is palpable.', 'marker', null, '');
  }

  // ---- Full time ----
  ctx.minute = 90;
  if (emitEvents) bus.emit(EVT.FULL_TIME, { score: ctx.score, fixtureId: fixture.id });
  const userClub = state.entities.clubs.get(state.meta.userClubId);
  const userWon = (userIsHome && ctx.score.home > ctx.score.away) || (userIsAway && ctx.score.away > ctx.score.home);
  const userLost = (userIsHome && ctx.score.home < ctx.score.away) || (userIsAway && ctx.score.away < ctx.score.home);
  pushEvent(ctx, 90, narrative.fullTimeNarrative(ctx.score, fixture.isDerby, userIsHome, userWon, userLost), 'fulltime', null, '');

  // ---- Build report ----
  const report = buildMatchReport(ctx);
  report.headlines = buildPostMatchHeadlines(state, fixture, report);

  // Emit final report event
  if (emitEvents) bus.emit(EVT.MATCH_REPORT, { fixtureId: fixture.id, result: fixture.result, report });

  return report;
}

// ---------------- Helpers ----------------

function pushEvent(ctx, minute, text, type, team, extra = '') {
  const evt = { minute, text, type, team, ...(extra ? { extra } : {}) };
  ctx.events.push(evt);
  ctx._minuteEvents++;
  if (ctx.emitEvents !== false) {
    bus.emit(EVT.MATCH_EVENT, { minute, text, type, team, fixtureId: ctx.fixture.id });
  }
}

function processPossessionOutcome(ctx, poss, prng, emitEvents) {
  switch (poss.outcome) {
    case 'shot':
    case 'cross': {
      // Generate a shot
      const shotCtx = poss.shotContext || { assistType: 'none', pressure: 'light' };
      const zone = pickShotZone(prng, { possession: poss, matchup: ctx.matchup });
      const shotType = pickShotType(prng, zone, shotCtx.assistType) || null;
      const attackingSetup = poss.team === 0 ? ctx.setup.home : ctx.setup.away;
      const defendingSetup = poss.team === 0 ? ctx.setup.away : ctx.setup.home;
      const shooter = pickShooter(attackingSetup, prng);
      const goalkeeper = defendingSetup.starting.find(s => s.slotPos === 'GK') || defendingSetup.starting[0];

      const xg = computeXG({
        zone, type: shotType,
        assistType: shotCtx.assistType,
        pressure: shotCtx.pressure,
        onWeakFoot: false   // simplification
      }, shooter);

      // Resolve
      const result = resolveShot(prng, {
        xg, shooter, zone, type: shotType, minute: ctx.minute,
        isDerby: ctx.fixture.isDerby, isBigMoment: ctx.fixture.isDerby
      }, goalkeeper);

      // Update stats
      ctx.stats.shots[poss.team]++;
      ctx.stats[poss.team === 0 ? 'hXG' : 'aXG'] += xg;
      updatePlayerStat(ctx, shooter?.playerId, p => { p.xg = (p.xg || 0) + xg; });

      if (result.outcome === 'goal') {
        ctx.score[poss.team === 0 ? 'home' : 'away']++;
        ctx.stats.sot[poss.team]++;
        // Momentum push
        ctx.momentum.push({ team: poss.team, ...DRIVERS.GOAL_SCORED });
        // Crowd roar if home goal
        if (poss.team === 0) ctx.momentum.push({ team: 0, ...DRIVERS.CROWD_ROAR });
        if (emitEvents) bus.emit(EVT.GOAL_SCORED, { team: poss.team, scorer: shooter, xg, minute: ctx.minute, fixtureId: ctx.fixture.id });
        const isHeader = shotType === 'header';
        const isVolley = shotType === 'volley';
        pushEvent(ctx, ctx.minute, `⚽ ${narrative.goalNarrative({
          scorer: shooter, assistType: shotCtx.assistType, xg, minute: ctx.minute,
          isHeader, isVolley, team: poss.team,
          context: goalContext(ctx, poss.team)
        })}`, 'goal', poss.team);
        updatePlayerStat(ctx, shooter?.playerId, p => { p.goals++; });
        // Assist tracking
        if (shotCtx.assistType !== 'none' && shotCtx.assistType) {
          const assister = pickAssister(attackingSetup, prng);
          if (assister) updatePlayerStat(ctx, assister.playerId, p => { p.assists++; });
        }
      } else if (result.outcome === 'save') {
        ctx.stats.sot[poss.team]++;
        ctx.momentum.push({ team: 1 - poss.team, ...DRIVERS.SAVE });
        if (emitEvents) bus.emit(EVT.SHOT_SAVED, { team: poss.team, shooter, xg, minute: ctx.minute });
        pushEvent(ctx, ctx.minute, `🧤 ${narrative.saveNarrative({ goalkeeper, shooter, xg })}`, 'save', poss.team);
        // Rebound
        if (result.rebound) {
          const reboundResult = resolveRebound(prng, {
            xg: result.rebound.xg, shooter, minute: ctx.minute
          }, goalkeeper);
          if (reboundResult.outcome === 'goal') {
            ctx.score[poss.team === 0 ? 'home' : 'away']++;
            ctx.momentum.push({ team: poss.team, ...DRIVERS.GOAL_SCORED });
            pushEvent(ctx, ctx.minute, `⚽ ${narrative.goalNarrative({ scorer: shooter, assistType: 'none', xg: result.rebound.xg, minute: ctx.minute, context: goalContext(ctx, poss.team) })}`, 'goal', poss.team);
            updatePlayerStat(ctx, shooter?.playerId, p => { p.goals++; });
          }
        }
      } else if (result.outcome === 'miss') {
        if (emitEvents) bus.emit(EVT.SHOT_MISSED, { team: poss.team, shooter, xg, minute: ctx.minute });
        pushEvent(ctx, ctx.minute, `↗ ${narrative.missNarrative({ shooter, xg, zone })}`, 'miss', poss.team);
      } else if (result.outcome === 'block') {
        if (emitEvents) bus.emit(EVT.SHOT_BLOCKED, { team: poss.team, shooter, minute: ctx.minute });
        pushEvent(ctx, ctx.minute, `🚫 ${narrative.blockNarrative({ shooter })}`, 'block', poss.team);
      } else if (result.outcome === 'post') {
        if (emitEvents) bus.emit(EVT.SHOT_POST, { team: poss.team, shooter, minute: ctx.minute });
        pushEvent(ctx, ctx.minute, `🥅 ${narrative.postNarrative({ shooter })}`, 'post', poss.team);
      }
      break;
    }
    case 'foul_won': {
      // Set piece
      const isDirect = poss.setPieceContext?.type === 'freekick_direct';
      const distance = isDirect ? 20 : 35;
      const result = resolveFreeKick(prng, ctx, poss.team, distance);
      if (result.outcome === 'shot') {
        // Run through shot resolution
        ctx.stats.shots[poss.team]++;
        ctx.stats[poss.team === 0 ? 'hXG' : 'aXG'] += result.xg;
        const goalkeeper = (poss.team === 0 ? ctx.setup.away : ctx.setup.home).starting.find(s => s.slotPos === 'GK');
        const shotResult = resolveShot(prng, {
          xg: result.xg, shooter: result.shooter, zone: result.shotContext.zone,
          type: result.shotContext.type, minute: ctx.minute,
          isDerby: ctx.fixture.isDerby, isBigMoment: false
        }, goalkeeper);
        if (shotResult.outcome === 'goal') {
          ctx.score[poss.team === 0 ? 'home' : 'away']++;
          ctx.momentum.push({ team: poss.team, ...DRIVERS.GOAL_SCORED });
          pushEvent(ctx, ctx.minute, `⚽ ${narrative.goalNarrative({ scorer: result.shooter, assistType: 'setPiece', xg: result.xg, minute: ctx.minute, context: goalContext(ctx, poss.team) })}`, 'goal', poss.team);
          updatePlayerStat(ctx, result.shooter?.playerId, p => { p.goals++; });
        } else {
          pushEvent(ctx, ctx.minute, `🧤 Free kick saved.`, 'save', poss.team);
        }
      }
      break;
    }
    case 'turnover_def':
    case 'turnover_mid':
    case 'turnover_final': {
      // Counter-attack chance?
      const counterTeam = 1 - poss.team;
      if (isCounterAttack(prng, ctx, poss.team, counterTeam)) {
        // Quick counter — generate a higher-xG chance
        const counterPoss = {
          team: counterTeam, durationMins: 0.5, outcome: 'shot', zone: 'box',
          shotContext: { assistType: 'through', pressure: 'open' },
          counter: true
        };
        processPossessionOutcome(ctx, counterPoss, prng, emitEvents);
      }
      break;
    }
    case 'recycle':
      // Possession continues — no event emitted
      break;
  }

  // Clean sheet flag
  if (ctx.score.home === 0) markCleanSheet(ctx, 0);
  if (ctx.score.away === 0) markCleanSheet(ctx, 1);
}

function pickShooter(setup, prng) {
  // Prefer FWD, then MID
  const fwds = setup.starting.filter(s => ['ST','CF','LW','RW','CAM'].includes(s.slotPos));
  const mids = setup.starting.filter(s => ['CM','CDM','LM','RM'].includes(s.slotPos));
  const pool = (fwds.length ? fwds : mids) || setup.starting;
  return prng.pick(pool);
}

function pickAssister(setup, prng) {
  // Prefer MID, then FWD
  const mids = setup.starting.filter(s => ['CM','CAM','LM','RM','CDM','LW','RW'].includes(s.slotPos));
  const pool = mids.length ? mids : setup.starting;
  return prng.pick(pool);
}

function commitFoul(ctx, prng, team, emitEvents) {
  ctx.stats.fouls[team]++;
  const victimSetup = team === 0 ? ctx.setup.away : ctx.setup.home;
  const victim = prng.pick(victimSetup.starting.filter(s => !s.synthetic)) || prng.pick(victimSetup.starting);
  const tacklerAggression = prng.range(0.3, 0.9);

  // Card probability
  const cardP = 0.18 * ctx.conditions.derbyCardMult;
  if (prng.next() < cardP) {
    // Yellow or red?
    const redP = 0.08;
    if (prng.next() < redP) {
      ctx.cards.r[team]++;
      const player = pickFouler(ctx, team, prng);
      if (emitEvents) bus.emit(EVT.RED_CARD, { team, player, minute: ctx.minute });
      pushEvent(ctx, ctx.minute, `🟥 ${narrative.redCardNarrative({ player, reason: 'straight' })}`, 'redcard', team);
      if (player) updatePlayerStat(ctx, player.playerId, p => { p.cards.r++; });
      adjustForRedCard(ctx, team);
      ctx.momentum.push({ team: 1 - team, ...DRIVERS.RED_CARD });
    } else {
      ctx.cards.y[team]++;
      const player = pickFouler(ctx, team, prng);
      if (emitEvents) bus.emit(EVT.YELLOW_CARD, { team, player, minute: ctx.minute });
      pushEvent(ctx, ctx.minute, `🟨 ${narrative.yellowCardNarrative({ player, reasonIdx: ctx.minute })}`, 'yellowcard', team);
      if (player) updatePlayerStat(ctx, player.playerId, p => { p.cards.y++; });
    }
  }

  // Foul injury roll
  const foulInj = rollFoulInjury(prng, victim, tacklerAggression);
  if (foulInj) {
    ctx.injuries.push({ ...foulInj, minute: ctx.minute });
    if (emitEvents) bus.emit(EVT.INJURY_OCCURRED, { playerId: victim?.playerId, injury: foulInj, minute: ctx.minute });
    pushEvent(ctx, ctx.minute, `🏥 ${narrative.injuryNarrative({ player: victim, type: foulInj.type })}`, 'injury', 1 - team);
  }
}

function pickFouler(ctx, team, prng) {
  const setup = team === 0 ? ctx.setup.home : ctx.setup.away;
  const defs = setup.starting.filter(s => ['CB','LB','RB','CDM'].includes(s.slotPos));
  const pool = defs.length ? defs : setup.starting;
  return prng.pick(pool);
}

function applyShoutEffect(ctx, kind, side) {
  // PUSH / PRESS → +momentum for user, +fatigue cost
  // CALM / WIDE → small momentum + shape effect
  if (kind === 'PUSH' || kind === 'PRESS') {
    ctx.momentum.push({ team: side, ...DRIVERS.TACTICAL_SUB });
  } else if (kind === 'CALM') {
    // Reduce fatigue penalty briefly
    for (const s of ctx.setup[side === 0 ? 'home' : 'away'].starting) {
      if (s.match) s.match.stamina = Math.min(100, s.match.stamina + 1);
    }
  }
}

function goalContext(ctx, scoringTeam) {
  const c = {};
  const myGoals = ctx.score[scoringTeam === 0 ? 'home' : 'away'];
  const oppGoals = ctx.score[scoringTeam === 0 ? 'away' : 'home'];
  if (myGoals === 1 && oppGoals === 0) c.opener = true;
  if (myGoals === oppGoals) c.equaliser = true;
  if (myGoals > oppGoals && ctx.minute > 80) c.seals = true;
  if (myGoals < oppGoals && ctx.minute > 85) c.consolation = true;
  // Against run of play: scoring team has worse momentum
  const scoringMomentum = scoringTeam === 0 ? ctx.momentum.value : -ctx.momentum.value;
  if (scoringMomentum < -0.3) c.againstRunOfPlay = true;
  return c;
}

function updatePlayerStat(ctx, playerId, fn) {
  if (!playerId) return;
  const stat = ctx.playerStats.find(s => s.playerId === playerId);
  if (stat) fn(stat);
}

function markCleanSheet(ctx, side) {
  // Mark all GK/DEF on `side` as having a clean sheet so far
  const setup = side === 0 ? ctx.setup.home : ctx.setup.away;
  for (const s of setup.starting) {
    if (['GK','CB','LB','RB','LWB','RWB'].includes(s.slotPos) && s.playerId) {
      const stat = ctx.playerStats.find(p => p.playerId === s.playerId);
      if (stat) stat.cs = true;
    }
  }
}

function pickAutoXI(state, clubId) {
  const club = state.entities.clubs.get(clubId);
  if (!club) return [];
  const slots = FORMATIONS[club.tactics.formation] || FORMATIONS['4-4-2'];
  const squad = club.squadIds.map(id => state.entities.players.get(id)).filter(Boolean);
  // Filter fit & not suspended
  const available = squad.filter(p => !p.inj && p.susp <= 0);
  // For each slot, pick the best player in the same group
  const xi = [];
  const used = new Set();
  for (const slotPos of slots) {
    const grp = groupOf(slotPos);
    const candidates = available
      .filter(p => !used.has(p.id) && p.grp === grp)
      .sort((a, b) => (b.ovr + b.form) - (a.ovr + a.form));
    if (candidates.length) {
      xi.push(candidates[0].id);
      used.add(candidates[0].id);
    } else {
      // Cross-group fallback
      const any = available.filter(p => !used.has(p.id)).sort((a, b) => (b.ovr + b.form) - (a.ovr + a.form));
      if (any.length) { xi.push(any[0].id); used.add(any[0].id); }
    }
  }
  return xi;
}

function pickAutoBench(state, clubId) {
  const club = state.entities.clubs.get(clubId);
  if (!club) return [];
  const xi = pickAutoXI(state, clubId);
  return club.squadIds
    .map(id => state.entities.players.get(id))
    .filter(p => p && !p.inj && p.susp <= 0 && !xi.includes(p.id))
    .sort((a, b) => (b.ovr + b.form) - (a.ovr + a.form))
    .slice(0, 7);
}

function getPlayerName(state, playerId) {
  if (!playerId) return 'Synthetic';
  return state.entities.players.get(playerId)?.name || 'Unknown';
}

function syntheticToPlayer(s) {
  return { stamina: s.match?.stamina || 100, age: 25, hidden: { injuryProneness: 0.5 } };
}

function computeStoppage(prng, ctx) {
  // 1-5 minutes based on events in the half
  let base = 1;
  base += Math.floor(ctx.cards.y[0] + ctx.cards.y[1] + (ctx.cards.r[0] + ctx.cards.r[1]) * 2);
  base += Math.floor(ctx.injuries.length * 0.5);
  return Math.min(6, Math.max(1, base + prng.int(0, 2)));
}

function getSpeed(state) {
  // Read speed from a transient setting on state (set by main.js)
  return state.transient?.speed || 'normal';
}

// Re-export for tick.js
export { runMatch as runMatchEngine };
