// sim/tick.js
// Day resolution. A "day" in the simulation progresses through three phases:
//   morning  — training, fatigue, morale drift, scout progress
//   midday   — inbox generation, AI club decisions, media cycle
//   evening  — matchday: run match engine; else: recovery, finance accrual
//
// "Continue" advances ONE full day. On matchdays it pauses for the match
// overlay to run, then resumes post-match processing.
//
// Speed layer:
//   instant  — resolve everything silently, emit minimal events
//   normal   — emit key events (goals, injuries, big news)
//   detailed — emit every event

import { logger } from '../core/logger.js';
import { EVT } from '../core/eventBus.js';
import { PRNG } from '../core/prng.js';
import { recomputeLeagueTable } from '../domain/invariants.js';
import { nextFixtureForClub, generateSeason, injectCupRounds } from './calendar.js';
import { runMatch } from './match/engine.js';
import { dispatch as _dispatch, getState, getSpeed, registerTickEngine, A } from '../core/state.js';

// Step 3: training & development
import { computeWeeklyGrowth, applyGrowth } from './development/growth.js';
import { applyYearlyDecline, isInSellHighWindow } from './development/aging.js';
import { computeForm, applyMatchRating, decayForm } from './development/form.js';
import { tickPairing, mentorshipMultiplier, mentorSlowdown } from './development/mentorship.js';
import { checkMilestones, generateReportCards, checkStagnation } from './development/milestones.js';
import { resolveEffectivePA } from './development/potential.js';
import { applyMatchMinutes, decaySharpness } from './injuries/recovery.js';
import { tickInjury } from './injuries/state.js';

// Step 4: transfers
import { runAITransferMarket } from './transfers/ai-clubs.js';
import { generateIncomingBids, expireOldBids } from './transfers/sell-side.js';
import { isWindowOpen, isDeadlineDay, closeWindow } from './transfers/deadline.js';
import { executeBosmanTransfers, scanBosmanMarket } from './transfers/bosman.js';

// Register ourselves as the tick engine with state.js (breaks circular import).
registerTickEngine(tick);

// ---------------- The tick ----------------

export function tick(state, opts = {}) {
  const events = [];
  const speed = getSpeed();
  const prng = new PRNG(state.meta.seed).fork('day-' + state.clock.dayNumber);

  // Increment day
  state.clock.dayNumber++;
  const currentDate = new Date(state.clock.date);
  currentDate.setDate(currentDate.getDate() + 1);
  state.clock.date = currentDate.toISOString().slice(0, 10);

  events.push({ type: EVT.ADVANCE_DAY_START, payload: { date: state.clock.date, day: state.clock.dayNumber } });

  // -------- Calendar maintenance: generate MW9..34 if not yet present --------
  if (state.competitions.league.fixtures.filter(f => f.matchweek >= 9).length < 9 * 26) {
    // Generate the rest of the season (MW9..34 = 26 MWs × 9 fixtures = 234)
    const clubIds = [...state.entities.clubs.keys()];
    const rivalries = state.relationships.rivalries.map(r => ({ a: r.a, b: r.b, intensity: r.intensity }));
    const season = generateSeason(clubIds, rivalries, {
      startDate: '2026-08-15',
      seed: state.meta.seed + 1   // different seed from per-day RNG
    });
    // Append MW9..34 fixtures (skip MW1..8 which were already seeded as played)
    let added = 0;
    for (const mw of season) {
      if (mw.matchweek <= 8) continue;
      // Skip if a fixture with this ID already exists
      for (const fx of mw.fixtures) {
        if (state.competitions.league.fixtures.some(f => f.id === fx.id)) continue;
        // But preserve the seed's pre-defined RAV MW9..12 fixtures (with derbies etc.)
        const existing = state.competitions.league.fixtures.find(f =>
          f.matchweek === mw.matchweek &&
          ((f.homeId === fx.homeId && f.awayId === fx.awayId) ||
           (f.homeId === fx.awayId && f.awayId === fx.homeId)));
        if (existing) {
          // Replace the generated fixture's data into the existing one
          // (we want the generated dates/constraints to apply)
          existing.date = fx.date;
          existing.isDerby = fx.isDerby || existing.isDerby;
          continue;
        }
        state.competitions.league.fixtures.push(fx);
        added++;
      }
    }
    // Also inject cup rounds
    const cupRounds = injectCupRounds(season, state.meta.userClubId);
    // (Cup rounds are already partially seeded in seed.js — R4 fixture exists)
    logger.info('tick', 'generated remaining season fixtures', { added, cupRounds: cupRounds.length });
  }

  // -------- MORNING --------
  events.push(...morningPhase(state, prng, speed));

  // -------- MIDDAY --------
  events.push(...middayPhase(state, prng, speed));

  // -------- EVENING / MATCHDAY --------
  const userClubId = state.meta.userClubId;
  const today = state.clock.date;
  const userFixtureToday = state.competitions.league.fixtures.find(f =>
    f.status === 'scheduled' && f.date === today &&
    (f.homeId === userClubId || f.awayId === userClubId));
  const otherFixturesToday = state.competitions.league.fixtures.filter(f =>
    f.status === 'scheduled' && f.date === today && f.homeId !== userClubId && f.awayId !== userClubId);

  if (userFixtureToday) {
    events.push({ type: EVT.MATCHDAY_REACHED, payload: { fixtureId: userFixtureToday.id, date: today } });
    // Signal to UI: open match overlay. The match itself runs when the UI calls startMatch(fixtureId).
    // Other (AI vs AI) fixtures today are simulated silently post-match.
    events.push({ type: EVT.STATE_BATCH, payload: { panel: 'match', openMatchOverlay: userFixtureToday.id } });
    // Defer AI-vs-AI simulation until after the user match resolves (commitMatchResult triggers it).
    state._pendingAI = otherFixturesToday;
  } else {
    // No user match today — run AI-vs-AI if any, then evening recovery
    events.push(...simulateAIFixtures(state, otherFixturesToday, prng, speed));
    events.push(...eveningPhase(state, prng, speed));
  }

  // -------- Recompute league table cache --------
  state.competitions.league.table = recomputeLeagueTable(state);

  events.push({ type: EVT.ADVANCE_DAY_END, payload: { date: state.clock.date, day: state.clock.dayNumber } });

  // Update meta
  state.meta.lastPlayedAt = new Date().toISOString();

  return { state, events, matchday: !!userFixtureToday };
}

// ---------------- Phases ----------------

function morningPhase(state, prng, speed) {
  const events = [];
  events.push({ type: EVT.PHASE_MORNING, payload: { day: state.clock.dayNumber } });

  const userClub = state.entities.clubs.get(state.meta.userClubId);
  const facilitiesBonus = (userClub?.facilityIds?.length || 0) * 0.01;

  // Daily injury tick + fitness/morale drift
  for (const pid of (userClub?.squadIds || [])) {
    const p = state.entities.players.get(pid);
    if (!p) continue;
    // Injured players: use the injury state machine
    if (p.inj) {
      const injuryEvents = tickInjury(p.inj, prng, {
        medicalLevel: getFacilityLevel(state, userClub, 'medical')
      });
      events.push(...injuryEvents);
      if (p.inj.recovered) {
        p.inj = null;
        p.fit = 75;
        p.sharp = 40;   // rusty from layoff
        p._lastInjuryReturnedAt = state.clock.date;
        p._daysSinceReturn = 0;
        events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad', playerId: pid, recovered: true } });
      }
    }
    // Track days since return (for re-injury vulnerability)
    if (p._lastInjuryReturnedAt) p._daysSinceReturn = (p._daysSinceReturn || 0) + 1;
    // Suspended players tick down (per match, not per day — but no harm in clearing)
    if (p.susp > 0) p.susp = Math.max(0, p.susp - 0);
    // Fitness recovery (non-match day)
    if (!p.inj) {
      const rec = 3 + facilitiesBonus * 100;
      p.fit = Math.min(100, p.fit + rec);
    }
    // Morale drift toward 70 baseline
    if (p.mor < 70) p.mor = Math.min(70, p.mor + 0.5);
    else if (p.mor > 70) p.mor = Math.max(70, p.mor - 0.2);
    // Sharpness decay (only if not played today — applied here for whole squad)
    if (!p.inj) decaySharpness(p);
  }

  // Scout progress (every day)
  for (const st of state.entities.staff.values()) {
    if (st.role !== 'scout' || !st.assignment) continue;
    if (st.assignment.daysLeft > 0) st.assignment.daysLeft--;
  }

  // Weekly tick: training growth + mentorship + form decay (every 7 days)
  const dayNum = state.clock.dayNumber;
  if (dayNum % 7 === 0) {
    events.push(...weeklyDevelopmentTick(state, prng, speed));
  }

  // Sell-high window flag: check on weekly tick
  if (dayNum % 7 === 0) {
    for (const pid of (userClub?.squadIds || [])) {
      const p = state.entities.players.get(pid);
      if (!p) continue;
      if (isInSellHighWindow(p) && !p._sellHighFlagged) {
        p._sellHighFlagged = true;
        events.push({ type: EVT.STATE_BATCH, payload: {
          panel: 'squad', sellHighWindow: true, playerId: pid, playerName: p.name
        }});
      }
    }
  }

  if (speed === 'detailed') {
    events.push({ type: EVT.STATE_BATCH, payload: { panel: 'squad' } });
  }
  return events;
}

/**
 * Weekly development tick — runs every 7 days.
 * Applies training growth, mentorship progress, form decay for unplayed
 * players, and quarterly report cards.
 */
function weeklyDevelopmentTick(state, prng, speed) {
  const events = [];
  const userClub = state.entities.clubs.get(state.meta.userClubId);
  if (!userClub) return events;

  // Mentorship tick
  state.relationships.mentorships = state.relationships.mentorships || [];
  for (const pairing of state.relationships.mentorships) {
    if (pairing.completedAt) continue;
    const mentor = state.entities.players.get(pairing.mentorId);
    const mentee = state.entities.players.get(pairing.menteeId);
    if (!mentor || !mentee) continue;
    const pairingEvents = tickPairing(pairing, mentor, mentee, prng);
    events.push(...pairingEvents);
  }

  // Growth tick for each player
  for (const pid of userClub.squadIds) {
    const p = state.entities.players.get(pid);
    if (!p) continue;
    // Resolve effective PA if not done
    if (p.effectivePA == null) p.effectivePA = resolveEffectivePA(p);
    // Compute minutes this week (from last 7 days of matches)
    const minsThisWeek = p._minsThisWeek || 0;
    const totalPossibleMins = 90 * 1.5;   // ~1.5 matches per week
    const minsPct = Math.min(1, minsThisWeek / totalPossibleMins);
    // Training contributions (simplified: derived from club._trainingContributions)
    const trainingContributions = p._trainingContributions || [];
    // Apply mentorship multiplier
    const mentorMult = mentorshipMultiplier(p, state.relationships.mentorships);
    // Apply mentor slowdown
    const mentorSlow = mentorSlowdown(p, state.relationships.mentorships);
    // Compute growth
    const growth = computeWeeklyGrowth(p, {
      trainingContributions,
      minutesPlayedThisWeek: minsPct,
      form: p.form,
      prng
    });
    // Apply mentor multipliers
    if (growth.attributeGains) {
      for (const k of Object.keys(growth.attributeGains)) {
        growth.attributeGains[k] *= mentorMult * mentorSlow;
      }
    }
    applyGrowth(p, growth);

    // Form decay for unplayed players
    if (minsThisWeek === 0) decayForm(p, p._weeksSinceLastMatch || 1);
    p._weeksSinceLastMatch = minsThisWeek > 0 ? 0 : (p._weeksSinceLastMatch || 0) + 1;

    // Reset weekly accumulators
    p._minsThisWeek = 0;
    p._trainingContributions = [];

    // Check milestones
    const milestoneEvents = checkMilestones(p, {
      date: state.clock.date,
      form: p.form
    });
    events.push(...milestoneEvents);
  }

  // Quarterly: development report cards for prospects
  if (state.clock.dayNumber % (7 * 13) === 0) {   // ~quarterly
    const prospects = userClub.squadIds
      .map(id => state.entities.players.get(id))
      .filter(p => p && p.age <= 21);
    state.developmentReports = generateReportCards(prospects);
    events.push({ type: EVT.STATE_BATCH, payload: { panel: 'academy', reports: state.developmentReports.length }});
  }

  return events;
}

/**
 * Get a specific facility level for a club.
 */
function getFacilityLevel(state, club, type) {
  for (const fid of (club.facilityIds || [])) {
    const f = state.entities.facilities.get(fid);
    if (f && f.type === type) return f.level;
  }
  return 5;   // default
}

function middayPhase(state, prng, speed) {
  const events = [];
  events.push({ type: EVT.PHASE_MIDDAY, payload: { day: state.clock.dayNumber } });

  // AI club decisions: very light in v1 — random form drift for AI clubs
  for (const club of state.entities.clubs.values()) {
    if (club.id === state.meta.userClubId) continue;
    // 2% chance per day of a media headline about an AI club
    if (prng.chance(0.02)) {
      const headline = generateAIHeadline(club, prng);
      state.media.headlines.unshift(headline);
      state.media.headlines = state.media.headlines.slice(0, 50);
      events.push({ type: EVT.MEDIA_HEADLINE, payload: headline });
    }
  }

  // Step 4: Transfer market — runs every day when window is open
  if (isWindowOpen(state)) {
    // AI-vs-AI transfers
    events.push(...runAITransferMarket(state, { prng, deadlineDay: isDeadlineDay(state) }));
    // Incoming bids on user's players
    events.push(...generateIncomingBids(state, { prng }));
    // Expire old pending bids
    expireOldBids(state);
    // Bosman execution (only at season end)
    events.push(...executeBosmanTransfers(state));
  }

  // Window close: collapse all open negotiations
  const dayOfMonth = new Date(state.clock.date).getDate();
  const month = new Date(state.clock.date).getMonth() + 1;
  if ((month === 1 && dayOfMonth === 31) || (month === 8 && dayOfMonth === 31)) {
    events.push(...closeWindow(state));
  }

  return events;
}

function eveningPhase(state, prng, speed) {
  const events = [];
  events.push({ type: EVT.PHASE_EVENING, payload: { day: state.clock.dayNumber } });

  // Daily financial accrual (very small)
  const dailyWages = (state.finance.summary.exp.Wages || 9.4) * 1e6 / 365;
  const dailyRevenue = (state.finance.summary.inc.Matchday || 4.1) * 1e6 / 365 * 0.3; // ~30% of matchday revenue spread
  state.finance.balance += dailyRevenue - dailyWages;

  // Fan sentiment drift toward baseline
  state.media.fanSentiment = state.media.fanSentiment + (71 - state.media.fanSentiment) * 0.02;

  return events;
}

/**
 * Simulate AI-vs-AI fixtures silently. Uses the same match engine but with
 * reduced detail (no events emitted for individual match actions, only
 * the final result + key events like goals/injuries).
 */
function simulateAIFixtures(state, fixtures, prng, speed) {
  const events = [];
  for (const fx of fixtures) {
    const matchPRNG = prng.fork('match-' + fx.id);
    const report = runMatch({
      state, fixture: fx, prng: matchPRNG,
      emitEvents: false,    // silent: AI matches don't stream to UI
      userIsHome: false, userIsAway: false
    });
    fx.status = 'played';
    fx.result = {
      hs: report.score.hs, as: report.score.as,
      hXG: report.stats.hXG, aXG: report.stats.aXG,
      events: report.events, report
    };
    events.push({ type: EVT.MATCH_REPORT, payload: { fixtureId: fx.id, result: fx.result, report, aiVsAi: true } });
    // Apply post-match consequences
    applyPostMatch(state, fx, report, /*userInvolved*/ false);
  }
  return events;
}

/**
 * Called by the UI after a user match completes. The UI gets the MatchReport
 * from the match engine, calls this to commit the result + run AI-vs-AI
 * matches that were deferred.
 */
export function commitUserMatch(state, fixtureId, report) {
  const fx = state.competitions.league.fixtures.find(f => f.id === fixtureId);
  if (!fx) return;
  fx.status = 'played';
  fx.result = {
    hs: report.score.hs, as: report.score.as,
    hXG: report.stats.hXG, aXG: report.stats.aXG,
    events: report.events, report
  };
  applyPostMatch(state, fx, report, /*userInvolved*/ true);

  // Now simulate any deferred AI-vs-AI matches from the same day
  const prng = new PRNG(state.meta.seed).fork('day-' + state.clock.dayNumber);
  if (state._pendingAI && state._pendingAI.length) {
    const aiEvents = simulateAIFixtures(state, state._pendingAI, prng, getSpeed());
    state._pendingAI = null;
    // Recompute table after all today's matches
    state.competitions.league.table = recomputeLeagueTable(state);
    return aiEvents;
  }
  state.competitions.league.table = recomputeLeagueTable(state);
  return [];
}

/**
 * Apply post-match consequences to GameState. Mutates.
 */
function applyPostMatch(state, fx, report, userInvolved) {
  // Form & fitness updates for both squads (we only have user squad players
  // in state.entities.players; AI clubs don't have full squads. So we only
  // touch user players here.)
  if (!userInvolved) return;

  const userClubId = state.meta.userClubId;
  const userIsHome = fx.homeId === userClubId;

  // For each user player who played, update fitness/form/morale
  for (const pStat of report.playerStats || []) {
    const p = state.entities.players.get(pStat.playerId);
    if (!p) continue;
    // Step 3.6: Fitness drop based on minutes played
    p.fit = Math.max(20, p.fit - (pStat.mins || 0) * 0.15);
    // Step 3.5: Form drift based on rating (weighted form system)
    applyMatchRating(p, pStat.rating, {
      moraleBoost: pStat.rating >= 7.5
    });
    // Sharpness: apply match minutes
    applyMatchMinutes(p, pStat.mins || 0, { date: state.clock.date });
    // Track weekly minutes for development system
    p._minsThisWeek = (p._minsThisWeek || 0) + (pStat.mins || 0);
    // Morale shift based on result + rating
    const won = (userIsHome && report.score.hs > report.score.as) ||
                (!userIsHome && report.score.as > report.score.hs);
    const lost = (userIsHome && report.score.hs < report.score.as) ||
                (!userIsHome && report.score.as < report.score.hs);
    if (won) p.mor = Math.min(100, p.mor + 3 + (pStat.rating - 6.5));
    else if (lost) p.mor = Math.max(0, p.mor - 4 + (pStat.rating - 6.5));
    // Update season stats
    p.stats = p.stats || { apps:0, goals:0, assists:0, cs:0, motm:0, mins:0 };
    p.stats.apps += 1;
    p.stats.mins += pStat.mins || 0;
    p.stats.goals += pStat.goals || 0;
    p.stats.assists += pStat.assists || 0;
    if (pStat.cs) p.stats.cs += 1;
    if (pStat.motm) p.stats.motm += 1;
    // Yellow/red card accumulation
    if (pStat.cards?.y) p.cards = { ...(p.cards || {y:0,r:0}), y: (p.cards?.y || 0) + pStat.cards.y };
    if (pStat.cards?.r) {
      p.cards = { ...(p.cards || {y:0,r:0}), r: (p.cards?.r || 0) + pStat.cards.r };
      p.susp = Math.max(p.susp || 0, 3);  // red = 3 match ban
    }
    // 5th yellow = 1 match ban
    if ((p.cards?.y || 0) >= 5 && (p.cards?.y || 0) % 5 === 0) {
      p.susp = Math.max(p.susp || 0, 1);
    }
  }

  // Injuries from the match
  for (const inj of report.injuries || []) {
    const p = state.entities.players.get(inj.playerId);
    if (!p) continue;
    p.inj = { type: inj.type, daysLeft: inj.days, severity: inj.severity };
  }

  // Board confidence shift
  const won = (userIsHome && report.score.hs > report.score.as) ||
              (!userIsHome && report.score.as > report.score.hs);
  const lost = (userIsHome && report.score.hs < report.score.as) ||
              (!userIsHome && report.score.as > report.score.hs);
  const oppClubId = userIsHome ? fx.awayId : fx.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const userClub = state.entities.clubs.get(userClubId);
  const isDerby = fx.isDerby;
  const oppRep = oppClub?.rep || 3;
  const myRep = userClub?.rep || 3;
  if (won) {
    const swing = 2 + (oppRep - myRep) + (isDerby ? 2 : 0);
    state.board.confidence.Matches = Math.min(100, state.board.confidence.Matches + swing);
  } else if (lost) {
    const swing = -3 - (myRep - oppRep) - (isDerby ? 2 : 0);
    state.board.confidence.Matches = Math.max(0, state.board.confidence.Matches + swing);
  }

  // Matchday revenue (home matches only)
  if (userIsHome) {
    const attendance = Math.round((userClub.capacity || 30000) * 0.92);
    const revenue = attendance * (userClub.ticketPrice || 28);
    state.finance.balance += revenue;
  }

  // Media headline from result
  const headline = generateResultHeadline(state, fx, report, userIsHome);
  state.media.headlines.unshift(headline);
  state.media.headlines = state.media.headlines.slice(0, 50);

  // Manager XP
  const xpGain = won ? 100 + oppRep * 30 : lost ? 20 : 50;
  state.manager.xp += xpGain;
  while (state.manager.xp >= state.manager.xpNext && state.manager.xpNext > 0) {
    state.manager.xp -= state.manager.xpNext;
    state.manager.lvl++;
    state.manager.xpNext = Math.round(state.manager.xpNext * 1.35);
    state.manager.sp++;
  }

  // Manager record
  state.manager.record.g++;
  if (won) state.manager.record.w++;
  else if (lost) state.manager.record.l++;
  else state.manager.record.d++;
}

// ---------------- Headline generators ----------------

const AI_HEADLINES = [
  (c, p) => ({ outlet: 'Sports Central', cat: 'TRANSFER', t: `${c.managerName} considers January shake-up`, b: `${c.name} are rumoured to be chasing three new signings.`, ago: '1h', likes: 1200 }),
  (c, p) => ({ outlet: 'The Daily Kick', cat: 'GOSSIP', t: `Board patience wearing thin at ${c.name}`, b: `Three straight defeats and the chairman has gone quiet.`, ago: '3h', likes: 890 }),
  (c, p) => ({ outlet: 'Tactics Weekly', cat: 'ANALYSIS', t: `${c.name}'s pressing struggles laid bare`, b: `A PPDA of 14.3 says it all — the high line isn't working.`, ago: '5h', likes: 430 })
];

function generateAIHeadline(club, prng) {
  const fn = prng.pick(AI_HEADLINES);
  return fn(club, prng);
}

function generateResultHeadline(state, fx, report, userIsHome) {
  const userClub = state.entities.clubs.get(state.meta.userClubId);
  const oppClubId = userIsHome ? fx.awayId : fx.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const hs = report.score.hs, as = report.score.as;
  const won = (userIsHome && hs > as) || (!userIsHome && as > hs);
  const lost = (userIsHome && hs < as) || (!userIsHome && as < hs);
  const scored = userIsHome ? hs : as;
  const conceded = userIsHome ? as : hs;
  let t, b;
  if (won) {
    t = scored >= 3 ? `${userClub.code} hit ${oppClub.code} for ${scored}` :
        conceded === 0 ? `${userClub.code} see off ${oppClub.code} cleanly` :
        `${userClub.code} edge ${oppClub.code} ${scored}-${conceded}`;
    b = fx.isDerby ? `Derby delight at ${userIsHome ? userClub.stadium : oppClub.stadium}.` :
                     `Three points sealed${userIsHome ? ' at home' : ' on the road'}.`;
  } else if (lost) {
    t = `${userClub.code} fall to ${oppClub.code}`;
    b = fx.isDerby ? `A derby to forget. The away end empties early.`
                   : `Disappointment${userIsHome ? ' at home' : ' on the road'}.`;
  } else {
    t = `${userClub.code} held by ${oppClub.code}`;
    b = 'Points shared in a tight encounter.';
  }
  return { outlet: 'Sports Central', cat: 'MATCH REPORT', t, b, ago: '0h', likes: Math.floor(2000 + Math.abs(hs - as) * 1500) };
}

// Re-export dispatch for match engine to use.
export const dispatch = _dispatch;
export { A };
