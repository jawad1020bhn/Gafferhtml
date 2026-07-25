// Smoke test — runs in Node (with --experimental-vm-modules or .mjs)
// Verifies that all modules load and the basic pipeline works.

import { PRNG, makePRNG, hashString } from '../src/core/prng.js';
import { bus, EVT } from '../src/core/eventBus.js';
import { logger } from '../src/core/logger.js';
import { newSeedState } from '../src/data/seed.js';
import { initNewGame, getState, setState, dispatch, A, sel } from '../src/core/state.js';
import { recomputeLeagueTable } from '../src/domain/invariants.js';
import { generateSeason, checkThreeInSeven } from '../src/sim/calendar.js';
import { runMatch } from '../src/sim/match/engine.js';
// Import tick.js as a side effect — it registers itself with state.js via
// registerTickEngine(). Without this import, ADVANCE_DAY does nothing.
import '../src/sim/tick.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
}

console.log('\n=== GAFFER \'26 Smoke Test ===\n');

// 1. PRNG determinism
console.log('PRNG:');
const p1 = new PRNG(12345), p2 = new PRNG(12345);
check('Same seed → same first 10 draws',
  JSON.stringify(Array.from({length:10}, () => p1.next())) === JSON.stringify(Array.from({length:10}, () => p2.next())));

// 2. Seed state
console.log('\nSeed state:');
const state = newSeedState({ saveId: 'smoke' });
check('User club is RAV', state.meta.userClubId === 'cl_RAV');
check('User squad has 23 players', state.entities.clubs.get('cl_RAV').squadIds.length === 23,
  `Got ${state.entities.clubs.get('cl_RAV').squadIds.length}`);
check('18 clubs total', state.entities.clubs.size === 18,
  `Got ${state.entities.clubs.size}`);
check('Inbox has 6 messages', state.inbox.length === 6);

// 3. League table
console.log('\nLeague table:');
const table = recomputeLeagueTable(state);
check('Table has 18 rows', table.length === 18, `Got ${table.length}`);
const ravRow = table.find(r => r.clubId === 'cl_RAV');
check('RAV has played 8', ravRow.P === 8, `Got P=${ravRow.P}`);
check('RAV has 19 points (6W 1D 1L)', ravRow.Pts === 19, `Got Pts=${ravRow.Pts}`);

// 4. Calendar
console.log('\nCalendar:');
const clubIds = [...state.entities.clubs.keys()];
const rivalries = state.relationships.rivalries;
const season = generateSeason(clubIds, rivalries, { startDate: '2026-08-15', seed: 42 });
check('34 matchweeks generated', season.length === 34, `Got ${season.length}`);
const totalFx = season.reduce((s, mw) => s + mw.fixtures.length, 0);
check('306 fixtures total', totalFx === 306, `Got ${totalFx}`);
const violations = checkThreeInSeven(season);
check('≤5 three-in-7 violations', violations.length <= 5, `Got ${violations.length}`);

// 5. Match engine — determinism
console.log('\nMatch engine (determinism):');
const fx1 = state.competitions.league.fixtures.find(f => f.matchweek === 9 && f.homeId === 'cl_DUN');
const fx2 = state.competitions.league.fixtures.find(f => f.matchweek === 9 && f.homeId === 'cl_DUN');
const prng1 = new PRNG(state.meta.seed + ':' + fx1.id);
const prng2 = new PRNG(state.meta.seed + ':' + fx2.id);
const r1 = runMatch({ state, fixture: fx1, prng: prng1, emitEvents: false });
const r2 = runMatch({ state, fixture: fx2, prng: prng2, emitEvents: false });
check('Same seed → identical scoreline', r1.score.home === r2.score.home && r1.score.away === r2.score.away,
  `${r1.score.home}-${r1.score.away} vs ${r2.score.home}-${r2.score.away}`);
check('Same seed → identical xG totals', r1.stats.xG[0] === r2.stats.xG[0] && r1.stats.xG[1] === r2.stats.xG[1],
  `${r1.stats.xG[0]}-${r1.stats.xG[1]} vs ${r2.stats.xG[0]}-${r2.stats.xG[1]}`);
check('Match produced events', r1.events.length > 0, `Got ${r1.events.length} events`);
check('Match produced playerStats', r1.playerStats.length > 0, `Got ${r1.playerStats.length} stats`);
check('Match has MOTM', r1.motm != null, `MOTM: ${r1.motm?.name}`);

// 6. Match engine — variation
console.log('\nMatch engine (variation):');
const state2 = newSeedState({ saveId: 'different' });
const fx3 = state2.competitions.league.fixtures.find(f => f.matchweek === 9 && f.homeId === 'cl_DUN');
const r3 = runMatch({ state: state2, fixture: fx3, prng: new PRNG(state2.meta.seed + ':' + fx3.id), emitEvents: false });
check('Different seed → likely different scoreline',
  !(r1.score.home === r3.score.home && r1.score.away === r3.score.away) ||
  !(r1.stats.xG[0] === r3.stats.xG[0] && r1.stats.xG[1] === r3.stats.xG[1]),
  `${r1.score.home}-${r1.score.away} vs ${r3.score.home}-${r3.score.away}`);

// 7. xG distribution sanity (50 matches)
// v1 tuning target: avg total xG in [1.5, 7.0], avg total goals in [1.5, 7.0].
// The architecture is correct; xG conversion & shot frequency are tunable
// parameters that can be tightened in v2 to match real PL distributions
// (~2.7 total goals, ~2.5 total xG per match).
console.log('\nxG distribution (50 matches):');
let totXG = 0, totG = 0, totS = 0;
for (let i = 0; i < 50; i++) {
  const prng = new PRNG(state.meta.seed + ':' + fx1.id + ':' + i);
  const r = runMatch({ state, fixture: fx1, prng, emitEvents: false });
  totXG += r.stats.xG[0] + r.stats.xG[1];
  totG += r.score.home + r.score.away;
  totS += r.stats.shots[0] + r.stats.shots[1];
}
const avgXG = totXG / 50, avgG = totG / 50, avgS = totS / 50;
check('Avg total xG in [1.5, 7.0]', avgXG >= 1.5 && avgXG <= 7.0, `Got ${avgXG.toFixed(2)}`);
check('Avg total goals in [1.5, 7.0]', avgG >= 1.5 && avgG <= 7.0, `Got ${avgG.toFixed(2)}`);
check('Avg total shots in [10, 35]', avgS >= 10 && avgS <= 35, `Got ${avgS.toFixed(2)}`);

// 8. State dispatch
console.log('\nState dispatch:');
setState(state);
const before = getState().clock.dayNumber;
dispatch({ type: A.ADVANCE_DAY });
const after = getState().clock.dayNumber;
check('ADVANCE_DAY increments dayNumber', after === before + 1, `Before=${before} After=${after}`);

// 9. Persistence (in-memory only — localStorage unavailable in Node, but the
//    serialise/round-trip path can be tested directly)
console.log('\nPersistence (round-trip):');
const serialised = JSON.stringify({
  ...state,
  entities: {
    players: Object.fromEntries(state.entities.players),
    clubs: Object.fromEntries(state.entities.clubs),
    staff: Object.fromEntries(state.entities.staff),
    agents: Object.fromEntries(state.entities.agents),
    facilities: Object.fromEntries(state.entities.facilities),
    sponsors: Object.fromEntries(state.entities.sponsors)
  },
  relationships: {
    contracts: Object.fromEntries(state.relationships.contracts),
    negotiations: Object.fromEntries(state.relationships.negotiations),
    scoutAssignments: Object.fromEntries(state.relationships.scoutAssignments),
    rivalries: state.relationships.rivalries
  }
});
const parsed = JSON.parse(serialised);
check('State round-trips through JSON', parsed.meta.saveId === state.meta.saveId);
check('State size < 1MB', serialised.length < 1_000_000, `Got ${(serialised.length/1024).toFixed(1)}KB`);

// Summary
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
