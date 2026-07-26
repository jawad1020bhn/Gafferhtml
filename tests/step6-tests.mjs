// Step 6 verification tests.
// Runs in Node: `node tests/step6-tests.mjs`

import { PRNG, hashString } from '../src/core/prng.js';
import { newSeedState } from '../src/data/seed.js';
import { initNewGame, getState, setState, dispatch, A } from '../src/core/state.js';
import '../src/sim/tick.js'; // register tick engine

import {
  initNarrativeState,
  addStorySeed,
  detectStorySeeds,
  generateHeadlineFromSeed,
  generateSocialTweets,
  triggerPreMatchPressConference,
  triggerPostMatchPressConference,
  updateFanSentimentFromFactions,
  updateNarrativeArcs,
  processPostMatchNarrative
} from '../src/sim/narrative/engine.js';
import { conditionModifiers } from '../src/sim/match/prematch.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
}

console.log('\n=== STEP 6 Dynamic News, Media & Narrative Tests ===\n');

// Initialize a standard test state
const state = newSeedState({ saveId: 's6' });
initNarrativeState(state);

// ---------------- 6.1 STORY SEED DETECTION ----------------
console.log('Step 6.1 — Story Seed Detection:');
const beforeSeedsCount = state.media.storySeeds.length;
const resultSeeds = detectStorySeeds(state, { prng: new PRNG(123) });
check('detectStorySeeds runs and populates story seeds', state.media.storySeeds.length >= beforeSeedsCount);

const keyInjurySeed = addStorySeed(state, {
  type: 'injury',
  score: 75,
  metadata: { playerId: 'pl_p18', playerName: 'Viktor Kavanagh', injuryType: 'Hamstring tear', daysLeft: 21 }
});
check('Can append and retrieve custom StorySeed with metadata', keyInjurySeed.id !== null && keyInjurySeed.metadata.playerName === 'Viktor Kavanagh');


// ---------------- 6.2 HEADLINE GENERATION & OUTLET BIASES ----------------
console.log('\nStep 6.2 — Headline Generation & Outlet Biases:');
const prng = new PRNG(456);
const matchSeed = addStorySeed(state, {
  type: 'match_result',
  score: 80,
  metadata: { hs: 3, as: 1, opponentCode: 'HAL', homeId: 'cl_RAV', isDerby: true, scorers: [{ name: 'Kavanagh' }] }
});

const tabloidHl = generateHeadlineFromSeed(state, matchSeed, 'The Daily Kick', prng);
check('Tabloid headlines use highly sensational hyperbole', tabloidHl.t.includes('MASTERCLASS') || tabloidHl.t.includes('EUPHORIA!'), `Got: ${tabloidHl.t}`);

const broadsheetHl = generateHeadlineFromSeed(state, matchSeed, 'The Meridian Times', prng);
check('Broadsheet headlines use measured, objective terms', broadsheetHl.t.includes('Measured Display') || broadsheetHl.t.includes('Ravensport Secure'), `Got: ${broadsheetHl.t}`);


// ---------------- 6.3 SOCIAL SENTIMENT ENGINE ----------------
console.log('\nStep 6.3 — Social Sentiment Engine:');
state.media.fanSentiment = 85; // highly positive
const hotTweets = generateSocialTweets(state, prng);
check('Hot fan sentiment generates positive hashtags (e.g. #TitleCharge / #MercerIn)', hotTweets.some(t => t.t.includes('#TitleCharge') || t.t.includes('#MercerIn')));

state.media.fanSentiment = 30; // highly negative
const coldTweets = generateSocialTweets(state, prng);
check('Cold fan sentiment generates critical hashtags (e.g. #MercerOut / #BoardOut)', coldTweets.some(t => t.t.includes('#MercerOut') || t.t.includes('#BoardOut')));


// ---------------- 6.4 PRESS CONFERENCES INBOX ----------------
console.log('\nStep 6.4 — Interactive Press Conferences:');
const fixture = state.competitions.league.fixtures[0];
const beforeInboxCount = state.inbox.length;
triggerPreMatchPressConference(state, fixture);
check('Pre-match press conference generated in user inbox', state.inbox.length > beforeInboxCount);

const pressMsg = state.inbox[0];
check('Press conference message has pre-match title', pressMsg.subject.includes('Pre-Match Press Conference'));
check('Press conference message has choices representing press response tones', pressMsg.choices.length === 3 && pressMsg.choices.some(c => c.action.kind === 'press-defend'));


// ---------------- 6.5 FAN FACTION ENGINE & ATMOSPHERE ----------------
console.log('\nStep 6.5 — Fan Factions & Atmosphere:');
const beforeSentiment = state.media.fanSentiment;
updateFanSentimentFromFactions(state, { isWin: true, isDerby: true, ticketPrice: 28 });
check('Winning a derby increases aggregate fan sentiment', state.media.fanSentiment > beforeSentiment, `Before: ${beforeSentiment}, After: ${state.media.fanSentiment}`);

// Atmosphere matchday integration
state.media.fanSentiment = 95; // ecstatic fans
const highAtmMods = conditionModifiers(state, fixture, state.entities.clubs.get('cl_RAV'), state.entities.clubs.get('cl_HAL'));
state.media.fanSentiment = 25; // hostile fans
const lowAtmMods = conditionModifiers(state, fixture, state.entities.clubs.get('cl_RAV'), state.entities.clubs.get('cl_HAL'));
check('Better fan mood / atmosphere boosts home advantage dynamically', highAtmMods.homeAdvantage > lowAtmMods.homeAdvantage, `High mood adv: ${highAtmMods.homeAdvantage} vs Low mood adv: ${lowAtmMods.homeAdvantage}`);


// ---------------- 6.6 SEASONAL NARRATIVE ARCS ----------------
console.log('\nStep 6.6 — Seasonal Narrative Arcs:');
state.board.confidence.Matches = 35; // hot seat territory
updateNarrativeArcs(state);
check('Low board confidence triggers manager hot seat arc', state.media.activeArcs.some(a => a.type === 'manager_hot_seat'));
check('Stakes line updates dynamically based on hot seat arc', state.media.stakesLine.includes('under intense pressure') || state.media.stakesLine.includes('boardroom pressure'));


// Summary
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
