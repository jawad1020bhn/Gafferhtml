// sim/match/postmatch.js
// Post-match resolution. Produces a MatchReport and applies consequences
// to GameState (table, form, fitness, morale, injuries, suspensions,
// finance, board confidence, fan happiness, media cycle, manager XP).

import { logger } from '../../core/logger.js';
import { groupOf } from '../../domain/entities.js';

/**
 * Compute player ratings (1.0-10.0) for a match.
 *
 * Rating formula:
 *   base 6.0
 *   +0.5 per goal (ST), +0.3 per assist
 *   +0.4 for clean sheet (GK/DEF)
 *   +0.2 per key pass, +0.15 per successful tackle
 *   -0.5 per error leading to goal, -0.3 per yellow, -1.0 per red
 *   Modified by xG contribution, pass completion %, duels won
 *   MOTM: highest rating, tiebreak by goals then assists
 */
export function computePlayerRatings(matchData) {
  const ratings = [];
  for (const pStat of matchData.playerStats || []) {
    let r = 6.0;
    r += (pStat.goals || 0) * 0.5;
    r += (pStat.assists || 0) * 0.3;
    if (pStat.cs && (pStat.pos === 'GK' || pStat.pos === 'DEF')) r += 0.4;
    r += (pStat.keyPasses || 0) * 0.2;
    r += (pStat.tackles || 0) * 0.15;
    r -= (pStat.errors || 0) * 0.5;
    if (pStat.cards?.y) r -= 0.3 * pStat.cards.y;
    if (pStat.cards?.r) r -= 1.0;
    // xG overperformance (scored more than xG suggested)
    if (pStat.xg != null && pStat.goals != null) {
      r += Math.max(-0.5, Math.min(0.5, (pStat.goals - pStat.xg) * 0.3));
    }
    // Minutes played scaling (don't penalise subs heavily)
    if (pStat.mins < 15) r = Math.min(r, 6.5);
    r = Math.max(3.0, Math.min(10.0, r));
    ratings.push({ ...pStat, rating: +r.toFixed(1) });
  }
  // MOTM: highest rating, tiebreak by goals then assists
  if (ratings.length) {
    ratings.sort((a, b) =>
      b.rating - a.rating ||
      (b.goals || 0) - (a.goals || 0) ||
      (b.assists || 0) - (a.assists || 0));
    ratings[0].motm = true;
  }
  return ratings;
}

/**
 * Build the final MatchReport from the engine's raw event log.
 */
export function buildMatchReport(ctx) {
  const { setup, score, stats, events, playerStats, injuries, cards, fixture } = ctx;
  const userClubId = ctx.userClubId;
  const userIsHome = fixture.homeId === userClubId;

  const ratings = computePlayerRatings({ playerStats });
  const motm = ratings.find(r => r.motm) || null;

  return {
    fixtureId: fixture.id,
    date: fixture.date,
    competition: fixture.competition,
    homeId: fixture.homeId,
    awayId: fixture.awayId,
    isDerby: !!fixture.isDerby,
    score: { ...score },
    scorers: events.filter(e => e.type === 'goal').map(e => ({
      team: e.team, playerId: e.scorer?.playerId, name: e.scorer?.name, minute: e.minute,
      xg: e.xg, assistType: e.assistType
    })),
    stats: {
      possession: [stats.possession[0], stats.possession[1]],
      shots: [stats.shots[0], stats.shots[1]],
      sot:   [stats.sot[0], stats.sot[1]],
      corners: [stats.corners[0], stats.corners[1]],
      fouls: [stats.fouls[0], stats.fouls[1]],
      cards: { y: [cards.y[0], cards.y[1]], r: [cards.r[0], cards.r[1]] },
      xG: [stats.hXG, stats.aXG],
      passes: stats.passes ? [stats.passes[0], stats.passes[1]] : null,
      ppda: stats.ppda || null
    },
    events: events.map(e => ({ minute: e.minute, type: e.type, team: e.team, text: e.text || '' })),
    playerStats: ratings,
    injuries,
    motm: motm ? { playerId: motm.playerId, name: motm.name, rating: motm.rating } : null
  };
}

/**
 * Build post-match media headlines.
 */
export function buildPostMatchHeadlines(state, fixture, report) {
  const userClub = state.entities.clubs.get(state.meta.userClubId);
  const oppClubId = fixture.homeId === state.meta.userClubId ? fixture.awayId : fixture.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const userIsHome = fixture.homeId === state.meta.userClubId;
  const hs = report.score.hs, as = report.score.as;
  const userScored = userIsHome ? hs : as;
  const userConceded = userIsHome ? as : hs;
  const won = userScored > userConceded;
  const lost = userScored < userConceded;
  const headlines = [];

  // Main match report
  let title, body;
  if (won) {
    if (userScored >= 3) {
      title = `${userClub.code} hit ${oppClub.code} for ${userScored}`;
      body = `A convincing display${fixture.isDerby ? ' in the derby' : ''}. ${report.scorers.length} different goal threats — the kind of performance that sends a message.`;
    } else if (userConceded === 0) {
      title = `${userClub.code} see off ${oppClub.code}`;
      body = `Professional, controlled, clinical. Three points and a clean sheet.`;
    } else {
      title = `${userClub.code} edge ${oppClub.code} ${userScored}-${userConceded}`;
      body = `Tight affair decided by fine margins${fixture.isDerby ? ' — derby tension told' : ''}.`;
    }
  } else if (lost) {
    if (userConceded >= 3) {
      title = `${oppClub.code} put ${userClub.code} to the sword`;
      body = `A painful afternoon${fixture.isDerby ? ' in the derby' : ''}. The defensive shape never settled.`;
    } else {
      title = `${userClub.code} fall to ${oppClub.code}`;
      body = `Disappointment${fixture.isDerby ? ' — derby pain' : ''}. The margins didn't fall ${userClub.code}'s way.`;
    }
  } else {
    title = `${userClub.code} held by ${oppClub.code}`;
    body = `Points shared in a tense encounter. ${report.stats.xG[0] + report.stats.xG[1] < 2.0 ? 'A game of few clear chances.' : 'Plenty of goalmouth action but no winner.'}`;
  }
  headlines.push({ outlet: 'Sports Central', cat: 'MATCH REPORT', t: title, b: body, ago: '0h', likes: Math.floor(2000 + Math.abs(hs - as) * 1500 + (fixture.isDerby ? 3000 : 0)) });

  // xG analysis piece (if lopsided)
  const userXG = userIsHome ? report.stats.xG[0] : report.stats.xG[1];
  const oppXG = userIsHome ? report.stats.xG[1] : report.stats.xG[0];
  if (Math.abs(userXG - oppXG) > 1.0) {
    if (userXG > oppXG && lost) {
      headlines.push({ outlet: 'Tactics Weekly', cat: 'ANALYSIS', t: `${userClub.code} unfortunate on xG`, b: `${userXG.toFixed(1)} to ${oppXG.toFixed(1)} — the numbers flatter the winners.`, ago: '1h', likes: 1200 });
    } else if (oppXG > userXG && won) {
      headlines.push({ outlet: 'Tactics Weekly', cat: 'ANALYSIS', t: `${userClub.code} ride their luck`, b: `${oppXG.toFixed(1)} to ${userXG.toFixed(1)} on xG — the keeper earned his wages.`, ago: '1h', likes: 980 });
    }
  }

  // MOTM piece
  if (report.motm) {
    headlines.push({ outlet: 'The Meridian Times', cat: 'PLAYER FOCUS', t: `${report.motm.name} pulls the strings`, b: `A ${report.motm.rating.toFixed(1)} rating — the standout performance of the afternoon.`, ago: '2h', likes: 850 });
  }

  return headlines;
}
