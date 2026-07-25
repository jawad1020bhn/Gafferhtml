// sim/training/microcycle.js
// Weekly training microcycle. The week between matches is divided into
// training days. A normal week (one fixture) yields 5 trainable days.
// A congested week (midweek fixture) yields 2-3, forcing triage.
// An empty week (international break) yields 7 but with internationals absent.

import { SESSION_TYPES, SESSION_DEFS, applySession, autoScheduleWeek } from './sessions.js';
import { logger } from '../../core/logger.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Compute the microcycle for the upcoming week.
 *
 * @param {Object} state  GameState
 * @param {Object} opts  { userClubId, upcomingFixtures: [], internationalBreak: bool }
 * @returns {Object}  { days: [{date, session, fixtureDay}], trainableDays }
 */
export function computeMicrocycle(state, opts = {}) {
  const userClubId = opts.userClubId || state.meta.userClubId;
  const today = new Date(state.clock.date);
  const upcoming = (opts.upcomingFixtures || [])
    .filter(f => f.homeId === userClubId || f.awayId === userClubId)
    .filter(f => f.status === 'scheduled')
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 2);  // this week's + midweek if any

  // Build day-by-day plan for the next 7 days
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const fixtureToday = upcoming.find(f => f.date === iso);
    days.push({
      date: iso,
      weekday: ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()],
      session: null,
      fixture: fixtureToday || null,
      isInternationalBreak: !!opts.internationalBreak,
      internationalsAbsent: 0
    });
  }

  // Count trainable days (days without a fixture)
  const trainableDays = days.filter(d => !d.fixture).length;

  // Default auto-schedule if user hasn't set one
  const squad = userClubId === state.meta.userClubId
    ? state.entities.clubs.get(userClubId).squadIds
        .map(id => state.entities.players.get(id))
        .filter(Boolean)
    : [];
  const avgFatigue = squad.length
    ? squad.reduce((s, p) => s + (100 - (p.fit || 80)), 0) / squad.length
    : 30;
  const fixtureDifficulty = upcoming[0]
    ? estimateDifficulty(state, userClubId, upcoming[0])
    : 0.5;

  // For each trainable day, assign a session
  const autoSchedule = autoScheduleWeek(avgFatigue, fixtureDifficulty, trainableDays);
  let scheduleIdx = 0;
  for (const day of days) {
    if (day.fixture) {
      day.session = null;   // matchdays don't get a session
      continue;
    }
    if (scheduleIdx < autoSchedule.length) {
      day.session = autoSchedule[scheduleIdx++];
    }
  }

  return { days, trainableDays, upcoming, avgFatigue, fixtureDifficulty };
}

function estimateDifficulty(state, userClubId, fixture) {
  const userClub = state.entities.clubs.get(userClubId);
  const oppId = fixture.homeId === userClubId ? fixture.awayId : fixture.homeId;
  const opp = state.entities.clubs.get(oppId);
  if (!userClub || !opp) return 0.5;
  const diff = (opp.atk + opp.def) / 2 - (userClub.atk + userClub.def) / 2;
  return Math.max(0.1, Math.min(0.9, 0.5 + diff / 40));
}

/**
 * Apply a week of training to the squad. Called by the tick engine when
 * a week has elapsed (or on demand for testing).
 *
 * Returns { growthContributions, fatigueDelta, performanceMods, events }.
 */
export function runTrainingWeek(state, opts = {}) {
  const userClubId = state.meta.userClubId;
  const club = state.entities.clubs.get(userClubId);
  if (!club) return { growthContributions: [], events: [] };

  const microcycle = computeMicrocycle(state, opts);
  const squad = club.squadIds.map(id => state.entities.players.get(id)).filter(Boolean);

  // Coach ratings & facility levels drive training quality
  const coachRatings = deriveCoachRatings(state, userClubId);
  const facilityLevels = deriveFacilityLevels(state, userClubId);

  const growthContributions = [];   // [{playerId, attributeGains, familiarityGain, performanceMod}]
  const events = [];
  let weeklyFamiliarityGain = 0;
  let weeklyPerformanceMod = 0;

  for (const day of microcycle.days) {
    if (!day.session) continue;
    const def = SESSION_DEFS[day.session];

    // Track per-day performance mod (only the last match-prep before a
    // fixture actually applies; we take the max)
    if (def.performanceMod > 0) {
      weeklyPerformanceMod = Math.max(weeklyPerformanceMod, def.performanceMod);
    }

    for (const player of squad) {
      // Internationals absent during international break
      if (day.isInternationalBreak && player.international) continue;
      // Injured players only do recovery
      if (player.inj && day.session !== SESSION_TYPES.RECOVERY) continue;

      const contribution = applySession(player, day.session, {
        coachRating: coachRatings.forSession(day.session, player),
        facilityLevel: facilityLevels.training,
        isU23: player.age <= 23
      });
      if (contribution) {
        growthContributions.push({
          playerId: player.id,
          ...contribution,
          week: state.clock.dayNumber
        });
        weeklyFamiliarityGain += contribution.familiarityGain;
      }
    }
  }

  // Stash weekly familiarity on the club for the match engine to read
  club._familiarity = Math.min(100, (club._familiarity || 70) + weeklyFamiliarityGain * 7);

  // Stash weekly performance mod for the next user fixture
  if (weeklyPerformanceMod > 0) {
    club._matchPrepMod = weeklyPerformanceMod;
    events.push({ type: EVT.STATE_BATCH, payload: { panel: 'match', note: 'match prep applied' } });
  }

  return {
    growthContributions,
    fatigueDelta: microcycle.avgFatigue,
    performanceMods: { familiarity: weeklyFamiliarityGain, matchPrep: weeklyPerformanceMod },
    events,
    microcycle
  };
}

function deriveCoachRatings(state, clubId) {
  // Pull coaching staff ratings; default to 70 if no coaches assigned.
  const coaches = [...state.entities.staff.values()]
    .filter(s => s.clubId === clubId && (s.role === 'coach' || s.role === 'assistant'));
  return {
    forSession: (sessionType, player) => {
      // Match session type to coach specialty (we don't yet have coach
      // specialties, so just return average coach rating)
      if (!coaches.length) return 70;
      return coaches.reduce((s, c) => s + (c.rating || 70), 0) / coaches.length;
    }
  };
}

function deriveFacilityLevels(state, clubId) {
  const club = state.entities.clubs.get(clubId);
  const levels = { training: 5, medical: 5, science: 4, youth: 5 };
  for (const fid of club.facilityIds || []) {
    const f = state.entities.facilities.get(fid);
    if (!f) continue;
    if (f.type === 'training') levels.training = f.level;
    if (f.type === 'medical')  levels.medical = f.level;
    if (f.type === 'science')  levels.science = f.level;
    if (f.type === 'youth')    levels.youth = f.level;
  }
  return levels;
}

/**
 * Override a single day's session (user-driven schedule change).
 * Returns a new microcycle with the override applied.
 */
export function overrideSession(microcycle, date, newSessionType) {
  return {
    ...microcycle,
    days: microcycle.days.map(d =>
      d.date === date ? { ...d, session: newSessionType } : d)
  };
}
