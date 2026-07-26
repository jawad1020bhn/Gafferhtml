// sim/ai/manager.js
// Persistent AI Manager & Rival Club Simulation Engine.
// Models persistent coachable manager characters, season strategy scoring,
// squad selection utility, tactical adaptation scouting, and sackings carousel.

import { logger } from '../../core/logger.js';
import { EVT } from '../../core/eventBus.js';

// Pool of default opponent manager profile attributes
const OPPONENT_MANAGERS_SEED = {
  'Viktor Sørensen': { age: 48, nat: 'DEN', philosophy: 'possession', preferredFormation: '4-2-3-1', temperament: 'bold', mediaPersona: 'philosophical', skills: { tacticalAcumen: 88, manManagement: 82, adaptability: 85, recruitmentEye: 86, mediaCommand: 80 } },
  'Marta Keller': { age: 44, nat: 'GER', philosophy: 'low-block', preferredFormation: '5-4-1', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 90, manManagement: 80, adaptability: 75, recruitmentEye: 81, mediaCommand: 60 } },
  'Owen Blackwood': { age: 52, nat: 'ENG', philosophy: 'gegenpress', preferredFormation: '4-4-2', temperament: 'bold', mediaPersona: 'combative', skills: { tacticalAcumen: 78, manManagement: 85, adaptability: 80, recruitmentEye: 74, mediaCommand: 88 } },
  'Rui Palmeira': { age: 50, nat: 'POR', philosophy: 'possession', preferredFormation: '4-3-3', temperament: 'bold', mediaPersona: 'charming', skills: { tacticalAcumen: 82, manManagement: 78, adaptability: 84, recruitmentEye: 85, mediaCommand: 92 } },
  'Dean Hartley': { age: 46, nat: 'ENG', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 72, manManagement: 75, adaptability: 70, recruitmentEye: 78, mediaCommand: 65 } },
  'Stefan Iliev': { age: 55, nat: 'BUL', philosophy: 'counter', preferredFormation: '4-5-1', temperament: 'cautious', mediaPersona: 'philosophical', skills: { tacticalAcumen: 80, manManagement: 72, adaptability: 74, recruitmentEye: 76, mediaCommand: 70 } },
  'Gary Nash': { age: 58, nat: 'ENG', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 68, manManagement: 74, adaptability: 65, recruitmentEye: 70, mediaCommand: 55 } },
  'Callum Doyle': { age: 41, nat: 'SCO', philosophy: 'gegenpress', preferredFormation: '4-3-3', temperament: 'bold', mediaPersona: 'combative', skills: { tacticalAcumen: 75, manManagement: 82, adaptability: 78, recruitmentEye: 80, mediaCommand: 74 } },
  'Paula Reyes': { age: 39, nat: 'ESP', philosophy: 'counter', preferredFormation: '4-4-2', temperament: 'cautious', mediaPersona: 'charming', skills: { tacticalAcumen: 83, manManagement: 86, adaptability: 82, recruitmentEye: 88, mediaCommand: 85 } },
  'Tommy Aldous': { age: 61, nat: 'ENG', philosophy: 'counter', preferredFormation: '4-5-1', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 74, manManagement: 70, adaptability: 62, recruitmentEye: 68, mediaCommand: 50 } },
  'Hana Kobayashi': { age: 43, nat: 'JPN', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'bold', mediaPersona: 'philosophical', skills: { tacticalAcumen: 84, manManagement: 80, adaptability: 86, recruitmentEye: 82, mediaCommand: 78 } },
  'Jack Whitmore': { age: 47, nat: 'ENG', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'cautious', mediaPersona: 'charming', skills: { tacticalAcumen: 70, manManagement: 78, adaptability: 72, recruitmentEye: 74, mediaCommand: 80 } },
  'Elif Demir': { age: 45, nat: 'TUR', philosophy: 'balanced', preferredFormation: '4-5-1', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 76, manManagement: 75, adaptability: 78, recruitmentEye: 76, mediaCommand: 60 } },
  'Marcus Bell Sr.': { age: 63, nat: 'ENG', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 65, manManagement: 68, adaptability: 55, recruitmentEye: 70, mediaCommand: 45 } },
  'Sonia Marchetti': { age: 49, nat: 'ITA', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'bold', mediaPersona: 'charming', skills: { tacticalAcumen: 78, manManagement: 84, adaptability: 80, recruitmentEye: 82, mediaCommand: 86 } },
  'Ray Osei': { age: 51, nat: 'GHA', philosophy: 'counter', preferredFormation: '5-4-1', temperament: 'cautious', mediaPersona: 'philosophical', skills: { tacticalAcumen: 70, manManagement: 75, adaptability: 74, recruitmentEye: 72, mediaCommand: 68 } }
};

// Generic names pool to generate new managers for the carousel
const NEW_MANAGERS_POOL = [
  { name: 'Aris Thorne', age: 45, nat: 'GRE', philosophy: 'possession', preferredFormation: '4-3-3', temperament: 'bold', mediaPersona: 'philosophical', skills: { tacticalAcumen: 78, manManagement: 75, adaptability: 82, recruitmentEye: 80, mediaCommand: 70 } },
  { name: 'Lucas Dubois', age: 51, nat: 'FRA', philosophy: 'gegenpress', preferredFormation: '4-2-3-1', temperament: 'bold', mediaPersona: 'charming', skills: { tacticalAcumen: 84, manManagement: 80, adaptability: 80, recruitmentEye: 78, mediaCommand: 85 } },
  { name: 'Bruno Silva', age: 49, nat: 'BRA', philosophy: 'possession', preferredFormation: '4-3-3', temperament: 'bold', mediaPersona: 'charming', skills: { tacticalAcumen: 82, manManagement: 85, adaptability: 84, recruitmentEye: 84, mediaCommand: 90 } },
  { name: 'Niels Hessel', age: 53, nat: 'NED', philosophy: 'balanced', preferredFormation: '4-4-2', temperament: 'cautious', mediaPersona: 'terse', skills: { tacticalAcumen: 75, manManagement: 78, adaptability: 72, recruitmentEye: 76, mediaCommand: 65 } },
  { name: 'Sean Gallagher', age: 47, nat: 'IRL', philosophy: 'counter', preferredFormation: '4-5-1', temperament: 'cautious', mediaPersona: 'combative', skills: { tacticalAcumen: 72, manManagement: 83, adaptability: 70, recruitmentEye: 70, mediaCommand: 75 } }
];

/**
 * Initialize persistent AI manager entities inside state.entities.staff.
 * Bridges opponent managers to actual GameState staff Map.
 */
export function initAIManagerState(state) {
  state.entities.staff = state.entities.staff || new Map();
  state.aiScoutingReads = state.aiScoutingReads || {}; // target scouting memory
  state.managerTacticalMemory = state.managerTacticalMemory || {}; // manager match memories

  // Map opponent clubs to managers
  for (const club of state.entities.clubs.values()) {
    if (club.id === state.meta.userClubId) continue; // Skip user club (manager is Alex Mercer)

    // Find if a manager already exists for this club
    let existingMgr = null;
    for (const st of state.entities.staff.values()) {
      if (st.role === 'manager' && st.clubId === club.id) {
        existingMgr = st;
        break;
      }
    }

    if (!existingMgr) {
      // Create new opponent manager
      const name = club.managerName || 'Under Review';
      const def = OPPONENT_MANAGERS_SEED[name] || {
        age: 45 + Math.floor(Math.random() * 15),
        nat: 'ENG',
        philosophy: 'balanced',
        preferredFormation: '4-4-2',
        temperament: 'cautious',
        mediaPersona: 'terse',
        skills: { tacticalAcumen: 65, manManagement: 70, adaptability: 68, recruitmentEye: 65, mediaCommand: 50 }
      };

      const managerId = 'st_mgr_' + club.code;
      const managerStaff = {
        id: managerId,
        kind: 'staff',
        role: 'manager',
        clubId: club.id,
        name,
        age: def.age,
        nat: def.nat,
        rating: Math.round((def.skills.tacticalAcumen + def.skills.manManagement) / 2),
        contractUntil: (state.clock.seasonYear || 2026) + 2,
        wage: 10000 + (def.skills.tacticalAcumen * 150),
        skills: def.skills,
        philosophy: def.philosophy,
        preferredFormation: def.preferredFormation,
        patience: 100, // board patience
        temperament: def.temperament,
        mediaPersona: def.mediaPersona
      };

      state.entities.staff.set(managerStaff.id, managerStaff);
      club.managerId = managerStaff.id;
      logger.debug('ai', `initialized AI manager ${name} for ${club.code}`, managerStaff);
    }
  }
}

/**
 * Utility helper that scores any option using weighted factors.
 */
export function scoreOption(weights, factors) {
  let total = 0;
  for (const k of Object.keys(weights)) {
    if (factors[k] != null) {
      total += weights[k] * factors[k];
    }
  }
  return total;
}

/**
 * Set up dynamic AI Season strategies (title challenge, survival, rebuild)
 * and recruitment strategy postures (contender, developer, opportunist).
 * Re-calculated at season start and mid-season (around January 1st / MW17).
 */
export function updateSeasonStrategies(state) {
  initAIManagerState(state);

  const table = state.competitions.league.table || [];

  for (const club of state.entities.clubs.values()) {
    if (club.id === state.meta.userClubId) continue; // skip user

    const mgr = state.entities.staff.get(club.managerId);
    const pos = table.findIndex(r => r.clubId === club.id) + 1 || 9;
    const budget = club.budget || 5e6;
    const rep = club.rep || 3;

    // Define weights based on manager personality
    const weights = {
      title: rep >= 4 ? 0.8 : 0.2,
      survival: pos >= 15 ? 0.9 : 0.1,
      rebuild: budget < 10e6 && pos >= 10 ? 0.7 : 0.2
    };

    // Define current factors
    const factors = {
      title: pos <= 4 ? 1.0 : 0.1,
      survival: pos >= 14 ? 1.0 : 0.1,
      rebuild: (mgr?.skills.adaptability || 50) > 75 ? 0.8 : 0.3
    };

    const titleScore = scoreOption({ title: weights.title }, { title: factors.title });
    const survivalScore = scoreOption({ survival: weights.survival }, { survival: factors.survival });
    const rebuildScore = scoreOption({ rebuild: weights.rebuild }, { rebuild: factors.rebuild });

    // Set objectives and transfer strategies
    let objective = 'mid_table';
    let transferStrategy = 'developer';

    if (titleScore > survivalScore && titleScore > rebuildScore && pos <= 5) {
      objective = 'title_challenge';
      transferStrategy = 'contender';
    } else if (survivalScore > rebuildScore && pos >= 14) {
      objective = 'survival';
      transferStrategy = 'opportunist';
    } else if (rebuildScore > 0.4) {
      objective = 'rebuild';
      transferStrategy = 'developer';
    }

    // distressed sellers (e.g. Oakmont Town in deep crisis)
    if (club.balance < 0 || (club.code === 'OAK' && pos >= 17)) {
      transferStrategy = 'distressed';
    }

    club.seasonObjective = objective;
    club.transferStrategy = transferStrategy;

    logger.debug('ai', `updated season strategy for ${club.code}`, { objective, transferStrategy });
  }
}

/**
 * Check if an AI club is experiencing fixture congestion (match within 4 days).
 * If congested, they apply a rotation penalty to starting lineups to represent fatigue or resting starters.
 */
export function checkAICongestion(state, clubId, dateStr) {
  const date = new Date(dateStr);
  const fourDaysMs = 4 * 24 * 60 * 60 * 1000;

  const fixtures = state.competitions.league.fixtures || [];
  for (const f of fixtures) {
    if (f.status === 'played' && (f.homeId === clubId || f.awayId === clubId)) {
      const fDate = new Date(f.date);
      const diff = Math.abs(date.getTime() - fDate.getTime());
      if (diff > 0 && diff <= fourDaysMs) {
        return true; // congested!
      }
    }
  }
  return false;
}

/**
 * Get congestion effective rating penalty for AI starting squads.
 * Returns -3.5 if congested, representing suboptimal starter rotation.
 */
export function getAICongestionPenalty(state, clubId, dateStr) {
  if (checkAICongestion(state, clubId, dateStr)) {
    logger.debug('ai', `fixture congestion detected for club ${clubId} on ${dateStr} - applying lineup rotation penalty`);
    return -3.5;
  }
  return 0.0;
}

/**
 * Keep record of match results for opponent managers to build "rivalry" and "adaptation memory".
 * If user beats them, their rivalry rises. They adapt their preferred tactics next match.
 */
export function recordTacticalResult(state, fixture) {
  state.managerTacticalMemory = state.managerTacticalMemory || {};

  const userClubId = state.meta.userClubId;
  const isUserHome = fixture.homeId === userClubId;
  const isUserAway = fixture.awayId === userClubId;

  if (!isUserHome && !isUserAway) return; // only care about user games

  const rivalClubId = isUserHome ? fixture.awayId : fixture.homeId;
  const rivalClub = state.entities.clubs.get(rivalClubId);
  if (!rivalClub) return;

  const rivalMgr = state.entities.staff.get(rivalClub.managerId);
  if (!rivalMgr) return;

  const userWon = (isUserHome && fixture.homeScore > fixture.awayScore) || (isUserAway && fixture.awayScore > fixture.homeScore);
  const memoryKey = rivalMgr.id;

  if (!state.managerTacticalMemory[memoryKey]) {
    state.managerTacticalMemory[memoryKey] = {
      rivalryRating: 0,
      lastUserFormation: null,
      adaptiveCounterMatches: 0,
      userWins: 0,
      userLosses: 0,
      draws: 0
    };
  }

  const mem = state.managerTacticalMemory[memoryKey];
  const userClub = state.entities.clubs.get(userClubId);
  mem.lastUserFormation = userClub?.tactics?.formation || '4-3-3';

  const isUserLoss = (isUserHome && fixture.homeScore < fixture.awayScore) || (isUserAway && fixture.awayScore < fixture.homeScore);
  const isDraw = fixture.homeScore === fixture.awayScore;

  if (userWon) {
    mem.userWins++;
    mem.rivalryRating = Math.min(100, mem.rivalryRating + 25);
    logger.info('ai', `AI manager ${rivalMgr.name} builds grudge against Alex Mercer. Rivalry rating now ${mem.rivalryRating} (H2H: Alex Mercer ${mem.userWins} - ${mem.userLosses} ${rivalMgr.name})`);
  } else if (isUserLoss) {
    mem.userLosses++;
    mem.rivalryRating = Math.max(0, mem.rivalryRating - 5);
    logger.info('ai', `AI manager ${rivalMgr.name} won against Alex Mercer. Rivalry rating: ${mem.rivalryRating} (H2H: Alex Mercer ${mem.userWins} - ${mem.userLosses} ${rivalMgr.name})`);
  } else if (isDraw) {
    mem.draws++;
    logger.info('ai', `Alex Mercer and ${rivalMgr.name} drew. (H2H: Alex Mercer ${mem.userWins} - ${mem.userLosses} ${rivalMgr.name}, ${mem.draws} Draws)`);
  }
}

/**
 * Update League Meta Trends based on final/current standings.
 * Flexible managers adapt their strategies to emulate success or counter the dominant meta.
 */
export function updateLeagueMetaTrends(state) {
  state.leagueMeta = state.leagueMeta || { dominantPhilosophy: 'possession', antiMetaShiftsCount: 0 };
  const table = state.competitions.league.table || [];
  if (table.length === 0) return;

  // 1. Analyze dominant philosophies in the top 5 clubs
  const topPhilosophies = {};
  for (let i = 0; i < Math.min(5, table.length); i++) {
    const club = state.entities.clubs.get(table[i].clubId);
    if (!club) continue;
    const mgr = state.entities.staff.get(club.managerId);
    if (mgr) {
      const phil = mgr.philosophy || 'balanced';
      topPhilosophies[phil] = (topPhilosophies[phil] || 0) + 1;
    }
  }

  // Find the philosophy with the most success
  let dominant = 'possession';
  let maxCount = 0;
  for (const [p, count] of Object.entries(topPhilosophies)) {
    if (count > maxCount) {
      maxCount = count;
      dominant = p;
    }
  }

  state.leagueMeta.dominantPhilosophy = dominant;

  // 2. Anti-meta shifts: if possession or gegenpress is dominant,
  // flexible lower-half managers shift their preferredFormation to neutralizing shapes (e.g., 5-4-1 or 4-5-1 counter)
  if (dominant === 'possession' || dominant === 'gegenpress') {
    for (let i = Math.floor(table.length * 0.6); i < table.length; i++) {
      const club = state.entities.clubs.get(table[i].clubId);
      if (!club || club.id === state.meta.userClubId) continue;

      const mgr = state.entities.staff.get(club.managerId);
      if (mgr && mgr.skills.adaptability >= 70 && mgr.philosophy !== 'counter' && mgr.philosophy !== 'low-block') {
        mgr.philosophy = 'counter';
        mgr.preferredFormation = '5-4-1';
        club.tactics = club.tactics || {};
        club.tactics.formation = '5-4-1';
        state.leagueMeta.antiMetaShiftsCount++;
        logger.info('ai', `[META SHIFT] Flexible manager ${mgr.name} of ${club.code} shifts to COUNTER/5-4-1 to neutralize the dominant ${dominant} league meta!`);
      }
    }
  }
}

/**
 * Dynamic tactical adaptation: if a rival manager's grudge/rivalry is high (>= 25),
 * they adapt their formation specifically to counter the player's last known formation.
 */
export function adaptTacticsToUser(state, rivalClubId) {
  const rivalClub = state.entities.clubs.get(rivalClubId);
  if (!rivalClub) return;

  const rivalMgr = state.entities.staff.get(rivalClub.managerId);
  if (!rivalMgr) return;

  const mem = state.managerTacticalMemory?.[rivalMgr.id];
  if (!mem || mem.rivalryRating < 25 || !mem.lastUserFormation) return;

  // Let's adapt tactics based on user's formation to counter them!
  const userForm = mem.lastUserFormation;
  let adaptedFormation = rivalClub.tactics?.formation || '4-4-2';

  if (userForm === '4-3-3') {
    // Stifle wing possession with 5-4-1 or 4-5-1 counter low-block
    adaptedFormation = rivalMgr.skills.adaptability > 75 ? '5-4-1' : '4-5-1';
  } else if (userForm === '4-2-3-1') {
    // Press hard in midfield with 4-4-2 or counter
    adaptedFormation = '4-4-2';
  } else if (userForm === '3-5-2' || userForm === '5-4-1') {
    // Stretch wide with 4-3-3 possession
    adaptedFormation = '4-3-3';
  }

  if (adaptedFormation !== rivalClub.tactics?.formation) {
    logger.info('ai', `[TACTICAL ADAPTATION] ${rivalMgr.name} of ${rivalClub.name} adapts tactics from ${rivalClub.tactics?.formation} to ${adaptedFormation} to counter Alex Mercer's ${userForm}!`);
    rivalClub.tactics = rivalClub.tactics || {};
    rivalClub.tactics.formation = adaptedFormation;
    mem.adaptiveCounterMatches += 1;
  }
}

/**
 * Simulates board patience updates and triggers sackings & manager carousel.
 * Sacked managers are replaced by another candidate, completely shifting club playstyle.
 */
export function simulateBoardPatienceAndCarousel(state) {
  initAIManagerState(state);

  const table = state.competitions.league.table || [];
  const inbox = state.inbox || [];

  for (const club of state.entities.clubs.values()) {
    if (club.id === state.meta.userClubId) continue; // skip user club (user has their own board trust)

    const mgr = state.entities.staff.get(club.managerId);
    if (!mgr) continue;

    const pos = table.findIndex(r => r.clubId === club.id) + 1 || 9;
    const obj = club.seasonObjective || 'mid_table';

    let delta = 0;

    // Evaluate position vs expectation
    if (obj === 'title_challenge') {
      if (pos > 5) {
        delta -= (pos - 4) * 2; // severe drop
      } else {
        delta += 4;
      }
    } else if (obj === 'survival') {
      if (pos >= 17) {
        delta -= 5;
      } else if (pos <= 14) {
        delta += 3;
      }
    } else if (obj === 'rebuild') {
      if (pos >= 16) {
        delta -= 3;
      } else {
        delta += 2;
      }
    } else { // mid_table
      if (pos >= 14) {
        delta -= 2;
      } else if (pos <= 8) {
        delta += 3;
      }
    }

    // Apply delta and clamp patience between 0 and 100
    mgr.patience = Math.max(0, Math.min(100, (mgr.patience || 100) + delta));
    logger.debug('ai', `board patience for ${mgr.name} (${club.code}): ${mgr.patience} (delta ${delta})`);

    // SACKED!
    if (mgr.patience < 20) {
      const oldName = mgr.name;

      // 1. Unemploy the old manager
      mgr.clubId = null;
      mgr.patience = 100; // reset for future jobs

      // 2. Select replacement (Check poaching first if elite club, else standard unemployed list)
      let replacement = null;
      let poachedFromClub = null;

      if (club.rep >= 4) {
        // High reputation club (elite) seeks to poach a high-performing manager from a smaller club!
        for (const sourceClub of state.entities.clubs.values()) {
          if (sourceClub.id === state.meta.userClubId || sourceClub.id === club.id) continue;
          if (sourceClub.rep < club.rep) {
            const potentialMgr = state.entities.staff.get(sourceClub.managerId);
            if (potentialMgr && potentialMgr.patience >= 75) {
              // Found a prime poaching candidate overperforming at a lower-rep club!
              replacement = potentialMgr;
              poachedFromClub = sourceClub;
              break;
            }
          }
        }
      }

      if (poachedFromClub && replacement) {
        // --- POACHING CAROUSEL TRIGGERED ---
        logger.info('ai', `[POACHING CAROUSEL] Elite club ${club.code} poached ${replacement.name} from ${poachedFromClub.code}!`);

        // Move the poached manager to the elite club
        replacement.clubId = club.id;
        replacement.patience = 100;
        club.managerId = replacement.id;
        club.managerName = replacement.name;
        club.tactics = club.tactics || {};
        club.tactics.formation = replacement.preferredFormation || '4-4-2';

        // Now, we must recruit a replacement manager for the vacancy left at poachedFromClub!
        let vacancyReplacement = null;
        for (const st of state.entities.staff.values()) {
          if (st.role === 'manager' && !st.clubId && st.name !== oldName && st.name !== replacement.name) {
            vacancyReplacement = st;
            break;
          }
        }

        if (!vacancyReplacement) {
          const candidateDef = NEW_MANAGERS_POOL.find(p => !Array.from(state.entities.staff.values()).some(s => s.name === p.name)) || {
            name: 'Jordi Alomar', age: 46, nat: 'ESP', philosophy: 'possession', preferredFormation: '4-3-3', temperament: 'bold', mediaPersona: 'charming', skills: { tacticalAcumen: 77, manManagement: 81, adaptability: 80, recruitmentEye: 76, mediaCommand: 82 }
          };

          const newId = 'st_mgr_carousel_' + Date.now() + '_vac_' + Math.floor(Math.random() * 1000);
          vacancyReplacement = {
            id: newId,
            kind: 'staff',
            role: 'manager',
            clubId: poachedFromClub.id,
            name: candidateDef.name,
            age: candidateDef.age,
            nat: candidateDef.nat,
            rating: Math.round((candidateDef.skills.tacticalAcumen + candidateDef.skills.manManagement) / 2),
            contractUntil: (state.clock.seasonYear || 2026) + 2,
            wage: 11000 + (candidateDef.skills.tacticalAcumen * 120),
            skills: candidateDef.skills,
            philosophy: candidateDef.philosophy,
            preferredFormation: candidateDef.preferredFormation,
            patience: 100,
            temperament: candidateDef.temperament,
            mediaPersona: candidateDef.mediaPersona
          };
          state.entities.staff.set(newId, vacancyReplacement);
        } else {
          vacancyReplacement.clubId = poachedFromClub.id;
          vacancyReplacement.patience = 100;
        }

        // Assign the vacancy replacement to the poached source club
        poachedFromClub.managerId = vacancyReplacement.id;
        poachedFromClub.managerName = vacancyReplacement.name;
        poachedFromClub.tactics = poachedFromClub.tactics || {};
        poachedFromClub.tactics.formation = vacancyReplacement.preferredFormation || '4-4-2';

        // Dispatch a high-drama poaching news item
        const headline = `POACHED! ${club.name} appoint ${replacement.name}`;
        const body = `Following the sacking of their previous manager, elite club ${club.name} has poached highly-rated tactician ${replacement.name} from ${poachedFromClub.name}.\n\nIn response, a shocked ${poachedFromClub.name} board immediately appointed ${vacancyReplacement.name} to fill the sudden vacancy at their helm. The carousel spins on!`;

        inbox.push({
          id: 'msg_poach_' + Date.now() + '_' + club.code,
          sender: 'League Bulletin · Special Report',
          subject: headline,
          body,
          date: state.clock.currentDate || '2026-09-01',
          category: 'news',
          read: false
        });
      } else {
        // --- STANDARD CAROUSEL SACKING RESOLUTION ---
        for (const st of state.entities.staff.values()) {
          if (st.role === 'manager' && !st.clubId && st.name !== oldName) {
            replacement = st;
            break;
          }
        }

        if (!replacement) {
          const candidateDef = NEW_MANAGERS_POOL.find(p => !Array.from(state.entities.staff.values()).some(s => s.name === p.name)) || {
            name: 'Jordi Alomar', age: 46, nat: 'ESP', philosophy: 'possession', preferredFormation: '4-3-3', temperament: 'bold', mediaPersona: 'charming', skills: { tacticalAcumen: 77, manManagement: 81, adaptability: 80, recruitmentEye: 76, mediaCommand: 82 }
          };

          const newId = 'st_mgr_carousel_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
          replacement = {
            id: newId,
            kind: 'staff',
            role: 'manager',
            clubId: club.id,
            name: candidateDef.name,
            age: candidateDef.age,
            nat: candidateDef.nat,
            rating: Math.round((candidateDef.skills.tacticalAcumen + candidateDef.skills.manManagement) / 2),
            contractUntil: (state.clock.seasonYear || 2026) + 2,
            wage: 11000 + (candidateDef.skills.tacticalAcumen * 120),
            skills: candidateDef.skills,
            philosophy: candidateDef.philosophy,
            preferredFormation: candidateDef.preferredFormation,
            patience: 100,
            temperament: candidateDef.temperament,
            mediaPersona: candidateDef.mediaPersona
          };
          state.entities.staff.set(newId, replacement);
        } else {
          replacement.clubId = club.id;
          replacement.patience = 100;
        }

        club.managerId = replacement.id;
        club.managerName = replacement.name;
        club.tactics = club.tactics || {};
        club.tactics.formation = replacement.preferredFormation || '4-4-2';

        const headline = `SACKED! ${club.name} dismiss ${oldName}`;
        const body = `Following a poor streak of form that left the club in position ${pos}, the board of ${club.name} has terminated the contract of manager ${oldName}.\n\nIn a swift appointment, ${replacement.name} has been hired on a 2-year deal. Under his leadership, the squad is expected to deploy a ${replacement.preferredFormation} formation playing ${replacement.philosophy} football.`;

        inbox.push({
          id: 'msg_sacking_' + Date.now() + '_' + club.code,
          sender: 'League Bulletin',
          subject: headline,
          body,
          date: state.clock.currentDate || '2026-09-01',
          category: 'news',
          read: false
        });

        logger.info('ai', `[CAROUSEL SACKING] ${club.code} sacked ${oldName}. Hired ${replacement.name}! Tactically shifting to ${replacement.preferredFormation}.`);
      }
    }
  }
}
