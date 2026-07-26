// sim/shell/engine.js
// Gaffer '26 Save System, Settings, Game Shell & Texture Layer Engine.
// Models robust JSON save integrity, version migrations, settings/accessibility,
// Pause Season History/Records, End-of-Season Reviews, Manager Careers,
// and Step 9's Lived-in Texture Layer (International Breaks, Crisis Administrations,
// Fire Sales, Festive Pile-ups, and Deadline Day drama).

import { logger } from '../../core/logger.js';
import { generateSeason } from '../calendar.js';
import { recomputeLeagueTable } from '../../domain/invariants.js';

const CURRENT_SCHEMA_VERSION = 3;

/**
 * Structural save integrity validator.
 */
export function validateSaveIntegrity(saveObj) {
  if (!saveObj) return false;
  // Verify main state trees are present
  if (!saveObj.clock || !saveObj.meta || !saveObj.entities) {
    logger.error('shell', 'save validation failed: missing clock, meta, or entities trees');
    return false;
  }
  if (!saveObj.entities.clubs || !saveObj.entities.players) {
    logger.error('shell', 'save validation failed: missing clubs or players sub-trees');
    return false;
  }
  return true;
}

/**
 * Migration stepwise pipeline to run schema updates.
 */
export function migrateSave(state, fromVersion) {
  let s = { ...state };
  let current = fromVersion || 1;

  while (current < CURRENT_SCHEMA_VERSION) {
    if (current === 1) {
      // Migrate version 1 to 2: Add settings and career history arrays
      logger.info('shell', 'migrating save schema from version 1 to 2');
      s.settings = s.settings || {
        matchDetail: 'normal', // full | key | instant
        advancePacing: 'important', // all | important | critical
        colorblindMode: 'none', // none | redgreen | blueyellow
        typeScale: 'standard', // standard | compact | large
        uiDensity: 'comfortable', // comfortable | dense
        newsVolume: 'high',
        soundEffects: true
      };
      s.history = s.history || {
        seasons: [],
        records: {
          mostApps: { name: 'Marcus Thorne', val: 112, desc: 'All-time appearances' },
          mostGoals: { name: 'Viktor Kavanagh', val: 98, desc: 'All-time career goals' },
          biggestWin: { match: 'Ravensport 4-0 Wexcombe', val: 4, desc: 'Largest margin of victory' },
          youngestPlayer: { name: 'Felix Ndiaye', val: 17, desc: 'Youngest debutant' }
        },
        managerArc: [],
        milestones: []
      };
      s.careerState = s.careerArc || 'employed'; // employed | sacked | retired
      s.achievements = s.achievements || [];
      current = 2;
    }
    if (current === 2) {
      // Migrate version 2 to 3: Add texture settings, international breaks, and crises trackers
      logger.info('shell', 'migrating save schema from version 2 to 3');
      s.texture = s.texture || {
        internationalBreaksActive: false,
        administrationClubs: [],
        globalTransferRecordM: 120,
        festiveMultiplierActive: false,
        deadlineHour: null
      };
      current = 3;
    }
  }

  s.schemaVersion = CURRENT_SCHEMA_VERSION;
  return s;
}

/**
 * Generate lightweight preview data for the save slot gallery.
 */
export function generateSavePreview(state) {
  const userClub = state.entities?.clubs?.get(state.meta?.userClubId);
  const table = state.competitions?.league?.table || [];
  const pos = table.findIndex(r => r.clubId === state.meta?.userClubId) + 1 || 2;

  return {
    clubCode: userClub?.code || 'RAV',
    clubName: userClub?.name || 'Ravensport FC',
    managerName: state.manager?.name || 'Alex Mercer',
    date: state.clock?.date || '2026-08-15',
    season: state.clock?.seasonYear || 2026,
    leaguePosition: pos,
    savedAt: Date.now()
  };
}

/**
 * Export save state as a portable, encoded JSON string.
 */
export function exportSaveFile(state) {
  const data = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    preview: generateSavePreview(state),
    state
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

/**
 * Validate, decode, migrate and import an exported save string.
 */
export function importSaveFile(encodedStr) {
  try {
    const raw = decodeURIComponent(escape(atob(encodedStr)));
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.state) return null;

    if (!validateSaveIntegrity(parsed.state)) {
      throw new Error('imported state failed integrity checks');
    }

    const migrated = migrateSave(parsed.state, parsed.schemaVersion || 1);
    return migrated;
  } catch (e) {
    logger.error('shell', 'failed to import save file', { error: String(e) });
    return null;
  }
}

/**
 * Initialize default settings and history parameters.
 */
export function initSettingsAndHistory(state) {
  state.settings = state.settings || {
    matchDetail: 'normal',
    advancePacing: 'important',
    colorblindMode: 'none',
    typeScale: 'standard',
    uiDensity: 'comfortable',
    newsVolume: 'high',
    soundEffects: true
  };
  state.history = state.history || {
    seasons: [],
    records: {
      mostApps: { name: 'Marcus Thorne', val: 112, desc: 'All-time appearances' },
      mostGoals: { name: 'Viktor Kavanagh', val: 98, desc: 'All-time career goals' },
      biggestWin: { match: 'Ravensport 4-0 Wexcombe', val: 4, desc: 'Largest margin of victory' },
      youngestPlayer: { name: 'Felix Ndiaye', val: 17, desc: 'Youngest debutant' }
    },
    managerArc: [],
    milestones: []
  };
  state.careerState = state.careerState || 'employed';
  state.achievements = state.achievements || [];
  state.texture = state.texture || {
    internationalBreaksActive: false,
    administrationClubs: [],
    globalTransferRecordM: 120,
    festiveMultiplierActive: false,
    deadlineHour: null
  };
}

/**
 * Record a new broken club record if the value exceeds the previous.
 */
export function updateClubRecords(state, recordKey, value, name, desc) {
  initSettingsAndHistory(state);
  const rec = state.history.records[recordKey];
  if (!rec || value > rec.val) {
    state.history.records[recordKey] = { name, val: value, desc };
    logger.info('shell', `NEW CLUB RECORD DETECTED: ${desc} broken by ${name} (val: ${value})`);

    // Alert user via inbox
    state.inbox = state.inbox || [];
    state.inbox.unshift({
      id: 'msg_record_' + Date.now(),
      severity: 'high',
      sender: 'Club Historian · Boardroom',
      subject: `RECORD BROKEN: ${desc.toUpperCase()}`,
      body: `Alex,\n\nWe have written a new chapter of history today.\n\n${name} has officially broken the club's record for ${desc.toLowerCase()} with a new benchmark value of ${value}!\n\nThis historic achievement has been recorded in the permanent club archives.`,
      choices: [],
      done: true,
      opened: false
    });

    // Award career achievement
    unlockAchievement(state, 'Record Breaker');
  }
}

/**
 * Unlock a specific career achievement.
 */
export function unlockAchievement(state, title) {
  state.achievements = state.achievements || [];
  if (!state.achievements.includes(title)) {
    state.achievements.push(title);
    logger.info('shell', `ACHIEVEMENT UNLOCKED: ${title}`);
    state.inbox = state.inbox || [];
    state.inbox.unshift({
      id: 'msg_ach_' + Date.now(),
      severity: 'lo',
      sender: 'Manager Achievements',
      subject: `🏆 ACHIEVEMENT UNLOCKED: ${title}`,
      body: `Congratulations! You have unlocked the career achievement: "${title}". This badge is permanently added to your manager profile.`,
      choices: [],
      done: true,
      opened: false
    });
  }
}

/**
 * End of Season processing loop: May 31st boundary.
 */
export function processEndOfSeason(state) {
  initSettingsAndHistory(state);
  logger.info('shell', 'triggering End of Season flow and awards ceremony');

  const table = state.competitions.league.table || [];
  const userClubId = state.meta.userClubId;
  const userPos = table.findIndex(r => r.clubId === userClubId) + 1 || 2;
  const userClub = state.entities.clubs.get(userClubId);

  // 1. Log this season in history archives
  const topScorer = userClub ? userClub.squadIds
    .map(id => state.entities.players.get(id))
    .filter(Boolean)
    .sort((a, b) => (b.stats?.goals || 0) - (a.stats?.goals || 0))[0] : null;

  state.history.seasons.push({
    year: state.clock.seasonYear || 2026,
    position: userPos,
    cupRound: 'Round 4',
    topScorerName: topScorer ? topScorer.name : 'Viktor Kavanagh',
    topScorerGoals: topScorer ? (topScorer.stats?.goals || 7) : 7,
    balance: state.finance.balance
  });

  // 2. Compute Award Ceremony (Manager of the Year, Team of the Season)
  let moS = 'Alex Mercer';
  let goldenBoot = 'Viktor Kavanagh';
  if (userPos > 4) moS = 'Viktor Sørensen';

  // 3. European qualification payouts
  if (userPos <= 4) {
    unlockAchievement(state, 'Champions League');
  }

  // 4. Contract expirations & resets
  if (userClub) {
    for (const pid of userClub.squadIds || []) {
      const p = state.entities.players.get(pid);
      if (p) {
        // Reset season statistics
        p.stats = { apps: 0, goals: 0, assists: 0, cs: 0, motm: 0, mins: 0 };
        // Tick contracts remaining
        if (p.contractUntil <= state.clock.seasonYear) {
          // Release player as free agent
          p.onLoan = false;
          p.clubId = null;
          state.freeAgents = state.freeAgents || [];
          state.freeAgents.push(p);
          userClub.squadIds = userClub.squadIds.filter(id => id !== p.id);
          logger.info('shell', `Contract expired: ${p.name} released as free agent`);
        }
      }
    }
  }

  // 5. Calendar regeneration for the next season (increment seasonYear, schedule MW1..34)
  state.clock.seasonYear = (state.clock.seasonYear || 2026) + 1;
  state.clock.dayNumber = 1;
  state.clock.date = `${state.clock.seasonYear}-08-15`; // Kickoff next August 15th

  const clubIds = Array.from(state.entities.clubs.keys());
  const rivalries = state.relationships.rivalries.map(r => ({ a: r.a, b: r.b, intensity: r.intensity }));
  const nextSeasonFixtures = generateSeason(clubIds, rivalries, {
    startDate: state.clock.date,
    seed: state.meta.seed + state.clock.seasonYear
  });

  state.competitions.league.fixtures = nextSeasonFixtures.flatMap(mw => mw.fixtures);
  state.competitions.league.table = recomputeLeagueTable(state);

  // 6. Broadcast Season Review inbox message
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: 'msg_season_review_' + Date.now(),
    severity: 'high',
    sender: 'The Chairman · Boardroom',
    subject: `Season Review: Year ${state.clock.seasonYear - 1} Concluded`,
    body: `Alex,\n\nWe have officially closed the books for the ${state.clock.seasonYear - 1} season.\n\nWe finished in Position ${userPos}. The board evaluates this outcome as ${userPos <= 4 ? 'EXCELLENT. European football is secured!' : 'SATISFACTORY.'}\n\nOur cash reserves sit at £${(state.finance.balance/1e6).toFixed(1)}M.\n\nManager of the Season: ${moS}\nGolden Boot: ${goldenBoot}\n\nThe off-season summer bridge is now open. Let's build a squad capable of capturing the crown next season!`,
    choices: [],
    done: true,
    opened: false
  });

  logger.info('shell', `End of season processed successfully. Advanced to season ${state.clock.seasonYear}`);
}

/**
 * Dynamic Manager Career Security Audit: Ultimatums and Dismissals.
 */
export function updateJobSecurity(state) {
  initSettingsAndHistory(state);

  const table = state.competitions.league.table || [];
  const userClubId = state.meta.userClubId;
  const userPos = table.findIndex(r => r.clubId === userClubId) + 1 || 2;

  const matchConf = state.board?.confidence?.Matches ?? 74;

  if (matchConf < 35 && state.careerState === 'employed') {
    // Under ultimatum!
    state.careerState = 'ultimatum';
    state.inbox = state.inbox || [];
    state.inbox.unshift({
      id: 'msg_ultimatum_' + Date.now(),
      severity: 'high',
      sender: 'Boardroom · Owner Directive',
      subject: 'BOARD DIRECTIVE: Official Ultimatum Issued',
      body: `Alex,\n\nOur poor league form and position (${userPos}) have pushed board match confidence down to ${matchConf}%.\n\n"We are giving you three matches to turn this around. We expect a minimum of 4 points from our next 3 fixtures, or we will be forced to terminate your contract immediately."`,
      choices: [],
      done: true,
      opened: false
    });
    logger.warn('shell', 'Manager Alex Mercer placed under board ultimatum');
  } else if (matchConf < 20 && state.careerState === 'ultimatum') {
    // SACKED! Dismissal
    state.careerState = 'sacked';
    state.inbox = state.inbox || [];
    state.inbox.unshift({
      id: 'msg_dismiss_' + Date.now(),
      severity: 'high',
      sender: 'Boardroom · Contract Terminated',
      subject: 'SACKED: Your employment contract has been terminated',
      body: `Alex,\n\nFollowing a further collapse in results and failure to satisfy our ultimatum requirements, the board of Ravensport FC has terminated your employment contract with immediate effect.\n\n"We thank you for your contributions, particularly the League Cup win in 2025, but a change in direction is required. Best of luck in your future endeavors."\n\nYou are now 'Between Jobs'. Browse available opportunities in the Jobs Board to get back in the saddle.`,
      choices: [],
      done: true,
      opened: false
    });
    logger.warn('shell', 'Alex Mercer dismissed by Ravensport board');
  }
}

/**
 * Generate available approaches/job offers for unemployed or sacked managers.
 */
export function getAvailableJobs(state) {
  const jobs = [];
  const table = state.competitions.league.table || [];

  for (const club of state.entities.clubs.values()) {
    if (club.id === state.meta.userClubId) continue; // skip current
    const pos = table.findIndex(r => r.clubId === club.id) + 1 || 9;

    // Clubs struggling in lower table are actively looking for managers!
    if (pos >= 12) {
      jobs.push({
        clubId: club.id,
        clubName: club.name,
        clubCode: club.code,
        rep: club.rep,
        budget: club.budget,
        wageCeiling: club.wageCeiling || 4e6,
        situation: pos >= 16 ? 'Relegation candidates, seeking immediate survival' : 'Struggling mid-table, seeking stability'
      });
    }
  }

  // Default fallback jobs
  if (jobs.length === 0) {
    jobs.push({
      clubId: 'OAK', clubName: 'Oakmont Town', clubCode: 'OAK', rep: 1, budget: 3e6, wageCeiling: 3.5e6, situation: 'Relegation candidates, seeking immediate survival'
    });
  }

  return jobs;
}

// ==========================================
// ====== STEP 9 — THE LIVED-IN TEXTURE ======
// ==========================================

/**
 * International Break Disruptions.
 * Selects 2-3 players from user squad for call-ups. Small risk of injury or fatigue.
 */
export function processInternationalBreak(state, prng) {
  initSettingsAndHistory(state);
  const rng = prng || { next: () => Math.random(), pick: (a) => a[0] };

  const userClub = state.entities.clubs.get(state.meta.userClubId);
  if (!userClub) return;

  const squadPlayers = userClub.squadIds
    .map(id => state.entities.players.get(id))
    .filter(p => p && !p.inj && p.ovr >= 75);

  if (squadPlayers.length === 0) return;

  // Select 2 international representatives
  const calledUp = squadPlayers.slice(0, 2);
  const details = [];

  for (const p of calledUp) {
    const roll = rng.next();
    if (roll < 0.15) {
      // Injury on international duty!
      p.inj = { type: 'Bruised thigh', daysLeft: 5, severity: 'Minor' };
      p.fit = 55;
      p.sharp = Math.max(30, p.sharp - 10);
      details.push(`${p.name} picked up a minor knock (Bruised thigh, 5 days) while representing their country.`);
    } else if (roll < 0.40) {
      // Returned highly fatigued
      p.fit = 65;
      details.push(`${p.name} played 180 minutes and returned highly fatigued.`);
    } else {
      // Successful break, morale boost!
      p.mor = Math.min(100, p.mor + 10);
      details.push(`${p.name} starred in a 2-0 victory, boosting their morale.`);
    }
  }

  // Dispatch briefing
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: 'msg_intl_break_' + Date.now(),
    severity: 'md',
    sender: 'Assistant Manager · HQ Briefing',
    subject: 'INTERNATIONAL WINDOW: Squad Status Report',
    body: `Alex,\n\nThe international break has concluded. Here is the status of our players returning to Ironworks Park:\n\n${details.map(d => `• ${d}`).join('\n')}\n\nWe need to adjust our training microcycle intensity immediately to restore fitness before the upcoming fixture.`,
    choices: [],
    done: true,
    opened: false
  });

  logger.info('shell', 'processed international break squad disruptions', { calledUpCount: calledUp.length });
}

/**
 * AI Club Administration Crisis & Fire Sale.
 * Places a struggling AI club into administration (points deduction & 50% discount sale).
 */
export function triggerAIClubAdministration(state, targetClubCode) {
  initSettingsAndHistory(state);

  const code = targetClubCode || 'OAK';
  const club = Array.from(state.entities.clubs.values()).find(c => c.code === code);
  if (!club) return;

  // 1. Points deduction
  const table = state.competitions.league.table || [];
  const row = table.find(r => r.clubId === club.id);
  if (row) {
    row.Pts = Math.max(0, row.Pts - 9); // -9 penalty
    row.W = Math.max(0, row.W - 3); // adjust record for table constraints
    logger.info('shell', `[ADMINISTRATION] Deducted 9 points from ${club.name}`);
  }

  state.texture.administrationClubs.push(club.id);

  // 2. Transfer list their top players at a 50% discount!
  const fireSaleList = [];
  // For synthetic AI clubs, we simulate this by injecting 2 fire-sale transfer targets!
  const targetId1 = 'fire_t_1_' + code;
  const targetId2 = 'fire_t_2_' + code;

  state.transferTargets = state.transferTargets || [];

  const discountPlayer1 = {
    id: targetId1,
    n: `Finley Brooks`,
    pos: 'CB',
    age: 24,
    nat: 'ENG',
    club: club.name,
    lg: 'Meridian PD',
    ovr: 78,
    pot: 82,
    val: 4.5e6, // heavily discounted value (normally £9.0M!)
    wageAsk: 18000,
    conf: 'FullyKnown',
    agentPers: 'Patient',
    isFireSale: true
  };

  const discountPlayer2 = {
    id: targetId2,
    n: `Callum Reed`,
    pos: 'ST',
    age: 21,
    nat: 'ENG',
    club: club.name,
    lg: 'Meridian PD',
    ovr: 77,
    pot: 84,
    val: 3.8e6, // heavily discounted value (normally £7.6M!)
    wageAsk: 14000,
    conf: 'FullyKnown',
    agentPers: 'Loyal',
    isFireSale: true
  };

  state.transferTargets.push(discountPlayer1, discountPlayer2);

  // 3. Dispatch high-drama news bulletin
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: 'msg_admin_' + Date.now() + '_' + code,
    severity: 'high',
    sender: 'League Bulletin · Special Report',
    subject: `FINANCIAL CRISIS: ${club.name} Placed in Administration`,
    body: `Citing deep unpaid debts and failure to meet creditor deadlines, the league has officially placed ${club.name} into administration.\n\nSanctions Imposed immediately:\n- Immediate 9-point deduction applied to their Premier Division standings.\n- Total freeze of all operational budgets.\n- Forced Fire Sale of top assets at 50% discounts to meet payroll obligations.\n\n"The administrators have opened the doors. The club is fighting for its life, and all star players are up for immediate discount acquisition."`,
    choices: [],
    done: true,
    opened: false
  });

  logger.info('shell', `Triggered AI Club Administration for ${club.code}. Fire sale active.`);
}

/**
 * Festive Pile-up (December/January) fixture density.
 */
export function applyFestivePileupFatigue(state) {
  initSettingsAndHistory(state);
  state.texture.festiveMultiplierActive = true;
  logger.info('shell', 'festive pile-up active: doubling daily training and travel fatigue');
}

/**
 * End festive pile-up period.
 */
export function clearFestivePileup(state) {
  initSettingsAndHistory(state);
  state.texture.festiveMultiplierActive = false;
  logger.info('shell', 'festive pile-up ended: normal fatigue baseline restored');
}
