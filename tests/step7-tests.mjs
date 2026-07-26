// tests/step7-tests.mjs
// Comprehensive test suite for Step 7: AI Manager & Rival Club Simulation Engine.

import { newSeedState } from '../src/data/seed.js';
import {
  initAIManagerState,
  updateSeasonStrategies,
  checkAICongestion,
  getAICongestionPenalty,
  recordTacticalResult,
  adaptTacticsToUser,
  simulateBoardPatienceAndCarousel,
  updateLeagueMetaTrends
} from '../src/sim/ai/manager.js';
import { synthesizeAILineup } from '../src/sim/match/prematch.js';
import { triggerScoutPreMatchReport } from '../src/sim/narrative/engine.js';

console.log('\n=== STEP 7 AI Manager & Rival Club Simulation Tests ===');

// Helper to assert conditions
function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// 1. Initial State and Persistent Manager Profile Generation
{
  console.log('\nStep 7.1 — Persistent Manager Generation:');
  const state = newSeedState({ saveId: 's7' });
  initAIManagerState(state);

  const staffList = Array.from(state.entities.staff.values());
  const managers = staffList.filter(s => s.role === 'manager');

  assert(managers.length > 0, 'Opponent managers initialized as staff entities');

  // Test a known seeded manager, e.g., Viktor Sørensen of Halloway
  const halClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'HAL');
  const sorensen = state.entities.staff.get(halClub.managerId);

  assert(sorensen !== null, 'Viktor Sørensen mapped as manager staff entity');
  assert(sorensen.name === 'Viktor Sørensen', 'Manager name mapped correctly');
  assert(sorensen.skills.tacticalAcumen === 88, 'Tactical acumen mapped accurately');
  assert(sorensen.skills.manManagement === 82, 'Man management mapped accurately');
  assert(sorensen.preferredFormation === '4-2-3-1', 'Preferred formation mapped');
  assert(sorensen.philosophy === 'possession', 'Philosophy mapped');
  assert(sorensen.patience === 100, 'Board patience starts at 100');
}

// 2. Season Strategies & Dynamic Posture Utility Scoring
{
  console.log('\nStep 7.2 — Season Strategy Utility Scoring:');
  const state = newSeedState({ saveId: 's7' });
  initAIManagerState(state);

  // Manually mock league table
  const halClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'HAL');
  const oakClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'OAK');

  state.competitions.league.table = [
    { clubId: halClub.id, P: 10, W: 8, D: 2, L: 0, GF: 20, GA: 5, GD: 15, Pts: 26 },
    ...Array(15).fill(null).map((_, i) => ({ clubId: `dummy_${i}`, P: 10, W: 4, D: 3, L: 3, Pts: 15 })),
    { clubId: oakClub.id, P: 10, W: 1, D: 2, L: 7, GF: 5, GA: 22, GD: -17, Pts: 5 }
  ];

  updateSeasonStrategies(state);

  assert(halClub.seasonObjective === 'title_challenge', 'Top-table club mapped to title challenge');
  assert(halClub.transferStrategy === 'contender', 'Title challenger mapped to contender posture');
  assert(oakClub.seasonObjective === 'survival', 'Bottom-table club mapped to survival objective');
  assert(oakClub.transferStrategy === 'opportunist' || oakClub.transferStrategy === 'distressed', 'Survival club posture is opportunist/distressed');

  // Test distressed posture on negative cash balance
  oakClub.balance = -100000;
  updateSeasonStrategies(state);
  assert(oakClub.transferStrategy === 'distressed', 'Club in negative cash gets distressed posture');
}

// 3. Squad Rotation & Congestion Engine
{
  console.log('\nStep 7.3 — Squad Rotation & Congestion Engine:');
  const state = newSeedState({ saveId: 's7' });
  initAIManagerState(state);

  const halClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'HAL');

  // Clear existing fixtures to isolate the congestion test
  state.competitions.league.fixtures = [];

  // No congestion by default
  assert(checkAICongestion(state, halClub.id, '2026-09-10') === false, 'No congestion detected if no recent matches played');
  assert(getAICongestionPenalty(state, halClub.id, '2026-09-10') === 0, 'Congestion rating penalty is 0 when fresh');

  // Inject a fixture 3 days prior
  state.competitions.league.fixtures.push({
    id: 'f_test_congest',
    status: 'played',
    competition: 'league',
    date: '2026-09-07',
    homeId: halClub.id,
    awayId: 'other',
    homeScore: 1,
    awayScore: 0
  });

  assert(checkAICongestion(state, halClub.id, '2026-09-10') === true, 'Congestion detected if match played within last 4 days');
  assert(getAICongestionPenalty(state, halClub.id, '2026-09-10') === -3.5, 'Congestion penalty of -3.5 applied');

  // Set the current date to congested date before synthesizing lineup
  state.clock.currentDate = '2026-09-10';
  const lineup = synthesizeAILineup(state, halClub);
  const gk = lineup.starting[0];

  assert(gk.stamina < 75, 'Synthetic lineup stamina penalty applied under congestion');
}

// 4. Tactical Adaptation & Pre-match Scout Briefing Tells
{
  console.log('\nStep 7.4 — Tactical Adaptation & Scouting Alerts:');
  const state = newSeedState({ saveId: 's7' });
  initAIManagerState(state);

  const userClubId = state.meta.userClubId;
  const halClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'HAL');

  // Mock User victory in a fixture
  const fixture = {
    id: 'f_user_vs_hal',
    status: 'scheduled',
    date: '2026-09-15',
    homeId: userClubId,
    awayId: halClub.id,
    homeScore: 3,
    awayScore: 0,
    isDerby: true
  };

  recordTacticalResult(state, fixture);

  const sorensen = state.entities.staff.get(halClub.managerId);
  const mem = state.managerTacticalMemory[sorensen.id];

  assert(mem !== undefined, 'Rival manager memory initialized');
  assert(mem.userWins === 1, 'H2H tracks user wins correctly');
  assert(mem.rivalryRating === 25, 'Grudge/rivalry rating increases on defeat');

  // Run tactical adaptation
  adaptTacticsToUser(state, halClub.id);

  assert(halClub.tactics.formation === '5-4-1' || halClub.tactics.formation === '4-5-1', 'Rival manager counters user 4-3-3 with low-block / counter shape');

  // Trigger Scout Warning Tell in Inbox
  triggerScoutPreMatchReport(state, fixture);

  const alertMsg = state.inbox.find(m => m.id.startsWith('scout_brief_'));
  assert(alertMsg !== undefined, 'High-severity pre-match tactical alert sent to user inbox');
  assert(alertMsg.subject.includes('TACTICAL ALERT'), 'Alert message has prominent subject');
}

// 5. Board Patience, Carousel Sackings, and Poaching Cascade
{
  console.log('\nStep 7.5 — Board Patience & Poaching Carousel:');
  const state = newSeedState({ saveId: 's7' });
  initAIManagerState(state);

  const halClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'HAL');
  const oakClub = Array.from(state.entities.clubs.values()).find(c => c.code === 'OAK');

  // Setup Halloway (elite rep 5) and Oakmont (rep 2)
  halClub.rep = 5;
  oakClub.rep = 2;

  // Mock table where Halloway (seeded for title challenge) is severely underperforming in 10th
  state.competitions.league.table = [
    { clubId: oakClub.id, P: 10, W: 6, D: 2, L: 2, GF: 15, GA: 8, GD: 7, Pts: 20 },
    ...Array(8).fill(null).map((_, i) => ({ clubId: `dummy_${i}`, P: 10, W: 4, D: 3, L: 3, Pts: 15 })),
    { clubId: halClub.id, P: 10, W: 3, D: 3, L: 4, GF: 10, GA: 12, GD: -2, Pts: 12 }
  ];

  updateSeasonStrategies(state);

  // Isolate Gary Nash as the only poaching candidate by setting everyone else's patience to 50
  for (const st of state.entities.staff.values()) {
    if (st.role === 'manager' && st.name !== 'Gary Nash' && st.name !== 'Viktor Sørensen') {
      st.patience = 50;
    }
  }

  const sorensen = state.entities.staff.get(halClub.managerId);
  const nash = state.entities.staff.get(oakClub.managerId);

  // Set Sorensen's board patience to 15 (critical) and Nash's to 90 (loyal/high)
  sorensen.patience = 15;
  nash.patience = 90;

  // Run Board Patience & Carousel simulation
  simulateBoardPatienceAndCarousel(state);

  const finalHalMgr = state.entities.staff.get(halClub.managerId);
  const finalOakMgr = state.entities.staff.get(oakClub.managerId);

  assert(sorensen.clubId === null, 'Viktor Sørensen was sacked and became unemployed');
  assert(finalHalMgr.name === 'Gary Nash', 'Elite club Halloway successfully poached Gary Nash from Oakmont!');
  assert(finalOakMgr.name !== 'Gary Nash' && finalOakMgr.clubId === oakClub.id, 'Oakmont immediately filled their vacancy with a replacement manager');
  assert(halClub.tactics.formation === '4-4-2', "Halloway tactically shifted to Gary Nash's preferred formation");

  const poachMsg = state.inbox.find(m => m.id.startsWith('msg_poach_'));
  assert(poachMsg !== undefined, 'Poaching carousel generated high-drama news in the user inbox');
}

// 6. League Meta Trends
{
  console.log('\nStep 7.6 — League Meta Trends:');
  const state = newSeedState({ saveId: 's7' });
  initAIManagerState(state);

  const duncairn = Array.from(state.entities.clubs.values()).find(c => c.code === 'DUN');
  const halloway = Array.from(state.entities.clubs.values()).find(c => c.code === 'HAL');

  // Explicitly ensure top managers have Possession philosophy
  const duncairnMgr = state.entities.staff.get(duncairn.managerId);
  if (duncairnMgr) duncairnMgr.philosophy = 'possession';

  const hallowayMgr = state.entities.staff.get(halloway.managerId);
  if (hallowayMgr) hallowayMgr.philosophy = 'possession';

  // Mock table where Possession/Gegenpress clubs dominate the top positions
  state.competitions.league.table = [
    { clubId: duncairn.id, P: 10, W: 9, D: 1, L: 0, Pts: 28 },
    { clubId: halloway.id, P: 10, W: 8, D: 1, L: 1, Pts: 25 },
    ...Array(16).fill(null).map((_, i) => ({ clubId: `club_lower_${i}`, P: 10, W: 1, D: 2, L: 7, Pts: 5 }))
  ];

  // Set up lower-half flexible managers to observe adaptation
  for (let i = 0; i < 16; i++) {
    const code = `club_lower_${i}`;
    const cl = {
      id: code,
      code,
      name: `Club Lower ${i}`,
      rep: 2,
      budget: 1e6,
      balance: 1e6,
      atk: 60,
      def: 60,
      managerId: `st_mgr_${code}`,
      tactics: { formation: '4-4-2' }
    };
    state.entities.clubs.set(code, cl);

    const mStaff = {
      id: cl.managerId,
      kind: 'staff',
      role: 'manager',
      clubId: cl.id,
      name: `Mgr Lower ${i}`,
      skills: { tacticalAcumen: 75, adaptability: 85 }, // flexible
      preferredFormation: '4-4-2',
      philosophy: i < 3 ? 'possession' : 'balanced' // make sure possession dominates the top 5!
    };
    state.entities.staff.set(mStaff.id, mStaff);
  }

  updateLeagueMetaTrends(state);

  console.log(`  DEBUG: Dominant philosophy returned: ${state.leagueMeta?.dominantPhilosophy}`);
  console.log(`  DEBUG: Anti-meta shifts count: ${state.leagueMeta?.antiMetaShiftsCount}`);

  assert(state.leagueMeta.dominantPhilosophy === 'possession', 'Meta trend detector identified dominant philosophy');
  assert(state.leagueMeta.antiMetaShiftsCount > 0, 'Flexible struggling managers successfully adapted to counter the dominant meta');
}

console.log('\n=== All Step 7 tests passed successfully! ===\n');
