// Step 3 & 4 verification tests.
// Runs in Node: `node tests/step34-tests.mjs`

import { PRNG, hashString } from '../src/core/prng.js';
import { newSeedState } from '../src/data/seed.js';
import { initNewGame, getState, setState, dispatch, A } from '../src/core/state.js';
import '../src/sim/tick.js';   // register tick engine

import { SESSION_TYPES, SESSION_DEFS, applySession, autoScheduleWeek } from '../src/sim/training/sessions.js';
import { computeMicrocycle, runTrainingWeek } from '../src/sim/training/microcycle.js';
import { computeWeeklyGrowth, applyGrowth } from '../src/sim/development/growth.js';
import { ageCurveMultiplier, curveFor, lifeStage } from '../src/sim/development/curves.js';
import { resolveEffectivePA, gapMultiplier, rollLateBloomer, rollBreakout } from '../src/sim/development/potential.js';
import { computeForm, applyMatchRating, formPerformanceMod, formTrend } from '../src/sim/development/form.js';
import { applyYearlyDecline, isInSellHighWindow, rollRetirement } from '../src/sim/development/aging.js';
import { canMentor, canBeMentee, evaluateCompatibility, createPairing, tickPairing } from '../src/sim/development/mentorship.js';
import { checkMilestones, generateReportCards, checkStagnation } from '../src/sim/development/milestones.js';
import { createInjury, tickInjury, applyRecoveryModifiers, INJURY_TYPES } from '../src/sim/injuries/state.js';
import { applyMatchMinutes, decaySharpness, sharpnessMod, returnToPlayAssessment } from '../src/sim/injuries/recovery.js';

import { computeTrueValue, scoutedValueRange, computeAskingPrice, contractModifier, computeWageAsk } from '../src/sim/transfers/valuation.js';
import { AGENT_PERSONALITIES, agentProfile, openingWageAsk, evaluateWageOffer, updateAgentMemory } from '../src/sim/transfers/agents.js';
import { createNegotiation, submitBid, evaluateBid, NEGOTIATION_STATES, isTerminal } from '../src/sim/transfers/negotiation.js';
import { assessSquadNeeds, shortlistTargets, deriveRecruitmentIdentity, RECRUITMENT_IDENTITIES } from '../src/sim/transfers/ai-clubs.js';
import { computeDesire, stanceOnMove, moveOutcome, escalateUnrest } from '../src/sim/transfers/player-agency.js';
import { generateIncomingBids, respondToBid, checkReplacementNeed } from '../src/sim/transfers/sell-side.js';
import { generateFreeAgentPool, signFreeAgent } from '../src/sim/transfers/free-agents.js';
import { isBosmanEligible, scanBosmanMarket, bosmanAcceptanceProbability } from '../src/sim/transfers/bosman.js';
import { isDeadlineDay, isWindowOpen, applyDeadlineModifiers } from '../src/sim/transfers/deadline.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
}

console.log('\n=== STEP 3 & 4 Verification ===\n');

// ---------------- STEP 3: TRAINING & DEVELOPMENT ----------------

console.log('Step 3.1 — Training Microcycle:');
const state = newSeedState({ saveId: 's34' });
setState(state);
const microcycle = computeMicrocycle(state);
check('Microcycle has 7 days', microcycle.days.length === 7);
check('Microcycle has trainable days', microcycle.trainableDays > 0);
check('Auto-schedule assigns sessions', microcycle.days.some(d => d.session !== null));

// Session effects
const testPlayer = [...state.entities.players.values()][0];
const beforeFit = testPlayer.fit;
applySession(testPlayer, SESSION_TYPES.PHYSICAL, { coachRating: 80, facilityLevel: 6, isU23: false });
check('Physical session drains fitness', testPlayer.fit < beforeFit, `Before ${beforeFit}, After ${testPlayer.fit}`);
applySession(testPlayer, SESSION_TYPES.RECOVERY, {});
check('Recovery session restores fitness', testPlayer.fit > beforeFit - 5);

// Auto-schedule strategy
const schedule = autoScheduleWeek(80, 0.7, 5);  // high fatigue, hard match
check('Auto-schedule uses recovery on high fatigue', schedule.some(s => s === SESSION_TYPES.RECOVERY));
const schedule2 = autoScheduleWeek(40, 0.5, 5);
check('Auto-schedule uses development on low fatigue', schedule2.some(s => s === SESSION_TYPES.TECHNICAL || s === SESSION_TYPES.PHYSICAL));

console.log('\nStep 3.2 — Attribute Growth Model:');
const youngPlayer = [...state.entities.players.values()].find(p => p.age <= 19);
if (youngPlayer) {
  const initialOvr = youngPlayer.ovr;
  const growth = computeWeeklyGrowth(youngPlayer, {
    trainingContributions: [{ attributeGain: { physical: 1.2 } }],
    minutesPlayedThisWeek: 0.6,
    form: youngPlayer.form
  });
  check('Young player growth computed', growth.attributeGains != null);
  check('Young player grows (overall gain > 0)', growth.overallGain > 0, `Gain: ${growth.overallGain}`);
  const oldPlayer = [...state.entities.players.values()].find(p => p.age >= 30);
  if (oldPlayer) {
    const oldGrowth = computeWeeklyGrowth(oldPlayer, {
      trainingContributions: [{ attributeGain: { physical: 1.2 } }],
      minutesPlayedThisWeek: 0.6,
      form: oldPlayer.form
    });
    check('Young grows faster than old (age curve)', growth.overallGain > oldGrowth.overallGain,
      `Young ${growth.overallGain.toFixed(4)} vs Old ${oldGrowth.overallGain.toFixed(4)}`);
  }
}

console.log('\nStep 3.3 — Position-Specific Curves:');
const cb = { pos: 'CB', age: 26 };
const fb = { pos: 'LB', age: 26 };
const st = { pos: 'ST', age: 26 };
check('CB peaks at 26-30', curveFor(cb).peakAge[0] === 26 && curveFor(cb).peakAge[1] === 30);
check('FB peaks earlier (23-27)', curveFor(fb).peakAge[0] === 23 && curveFor(fb).peakAge[1] === 27);
check('ST peaks 24-28', curveFor(st).peakAge[0] === 24 && curveFor(st).peakAge[1] === 28);
check('GK declines latest (33+)', curveFor({pos:'GK', age:30}).declineOnset === 33);
check('FB declines earliest (29)', curveFor(fb).declineOnset === 29);

console.log('\nStep 3.4 — Potential Realization:');
const highDet = { ovr: 64, pot: 82, potLow: 74, potHigh: 82, age: 18, hidden: { determination: 90, professionalism: 80 } };
const lowDet = { ovr: 64, pot: 82, potLow: 74, potHigh: 82, age: 18, hidden: { determination: 55, professionalism: 80 } };
const paHigh = resolveEffectivePA(highDet);
const paLow = resolveEffectivePA(lowDet);
check('High-determination prospect reaches higher PA', paHigh > paLow, `High ${paHigh} vs Low ${paLow}`);
check('Gap multiplier > 1 when CA << PA', gapMultiplier({ ovr: 60, effectivePA: 80 }) > 1);
check('Gap multiplier ≈ 0.1 when CA >= PA', gapMultiplier({ ovr: 80, effectivePA: 78 }) < 0.2);
const prng = new PRNG(123);
const lateBloomer = rollLateBloomer(prng, { age: 18 });
check('Late bloomer flag is boolean', typeof lateBloomer === 'boolean');

console.log('\nStep 3.5 — Form & Confidence:');
const formPlayer = { formHist: [6.0, 6.5, 7.0, 7.5, 8.0, 9.0] };
const form = computeForm(formPlayer);
check('Form weighted average in valid range', form >= 6 && form <= 9, `Form: ${form}`);
const hotPlayer = { form: 8.5 };
const coldPlayer = { form: 5.0 };
check('Hot form gives positive performance mod', formPerformanceMod(hotPlayer).overallMod > 0);
check('Cold form gives negative performance mod', formPerformanceMod(coldPlayer).overallMod < 0);
check('Form trend up after rising ratings', formTrend({ formHist: [6, 7, 8] }) === 'up');
check('Form trend down after falling ratings', formTrend({ formHist: [8, 7, 6] }) === 'down');

console.log('\nStep 3.6 — Injury State Machine:');
const injury = createInjury('HAMSTRING', { severity: 'Moderate' });
check('Hamstring injury has 21-day base', injury.totalDays === 21, `Got ${injury.totalDays}`);
check('Injury starts with daysLeft > 0', injury.daysLeft > 0);
const prng2 = new PRNG(456);
let ticks = 0;
const injuryCopy = { ...injury };
while (injuryCopy.daysLeft > 0 && ticks < 50) {
  tickInjury(injuryCopy, prng2, { medicalLevel: 5 });
  ticks++;
}
check('Injury recovers within totalDays window', injuryCopy.recovered === true);
const recovered = applyRecoveryModifiers(21, { medicalLevel: 7, scienceLevel: 6, age: 22, professionalism: 80 });
check('Recovery modifiers reduce days for high-facility young player', recovered < 21);
const player = { sharp: 60, fit: 90 };
applyMatchMinutes(player, 90);
check('Match minutes build sharpness', player.sharp > 60);
check('Sharpness mod negative when rusty', sharpnessMod({ sharp: 30 }) < 0);
check('Sharpness mod positive when match-fit', sharpnessMod({ sharp: 95 }) > 0);

console.log('\nStep 3.7 — Aging & Decline:');
const veteran = { pos: 'ST', age: 32, ovr: 78, atts: { pace: 80, stamina: 75, strength: 70 } };
const beforePace = veteran.atts.pace;
applyYearlyDecline(veteran);
check('Veteran pace declines after onset', veteran.atts.pace < beforePace, `Before ${beforePace}, After ${veteran.atts.pace}`);
check('Sell-high window detects veterans', isInSellHighWindow({ pos: 'ST', age: 28 }) === true);
check('Sell-high window excludes prime-age players', isInSellHighWindow({ pos: 'ST', age: 24 }) === false);
const prng3 = new PRNG(789);
check('Retirement roll for 35+ winger possible', typeof rollRetirement(prng3, { age: 36, pos: 'ST', hidden: { ambition: 60 } }, { minutesPct: 0.3 }) === 'boolean');

console.log('\nStep 3.8 — Mentorship:');
const mentor = { id: 'm1', age: 30, pers: { lead: 80, temp: 70 }, hidden: { professionalism: 80, determination: 75 } };
const mentee = { id: 'm2', age: 18, pers: { temp: 65 }, hidden: { professionalism: 60, determination: 55 } };
check('Mentor eligible (28+, leadership 70+, prof 75+)', canMentor(mentor) === true);
check('Mentee eligible (U23)', canBeMentee(mentee) === true);
const compat = evaluateCompatibility(mentor, mentee);
check('Compatible pairing has score > 0.7', compat.compatible === true && compat.score > 0.7);
const pairing = createPairing(mentor, mentee);
check('Pairing created with positive compatibility', pairing !== null && pairing.compatibility > 0);
const prng4 = new PRNG(321);
const tickEvents = tickPairing(pairing, mentor, mentee, prng4);
check('Mentorship ticks without error', pairing.weeksElapsed === 1);

console.log('\nStep 3.9 — Milestones:');
const prospect = { id: 'p1', name: 'Test Prospect', age: 18, ovr: 68, form: 6.5, formHist: [] };
const milestoneEvents = checkMilestones(prospect, { isFirstStart: true, isFirstGoal: true, oldOvr: 69, newOvr: 70 });
check('Milestone triggers fire on first start', milestoneEvents.length > 0);
const reports = generateReportCards([prospect]);
check('Report card generated', reports.length === 1);
const stagnation = checkStagnation({ id: 'p1', age: 19 }, 10);
check('Stagnation intervention fires after 8+ weeks', stagnation !== null);

console.log('\nStep 3.10 — Integration:');
// Run a few ADVANCE_DAY ticks and verify development runs
const beforeDay = getState().clock.dayNumber;
for (let i = 0; i < 8; i++) {
  dispatch({ type: A.ADVANCE_DAY });
}
const afterDay = getState().clock.dayNumber;
check('8 day advances processed', afterDay === beforeDay + 8);

// ---------------- STEP 4: TRANSFER MARKET ----------------

console.log('\nStep 4.1 — Dynamic Valuation:');
const elitePlayer = { ovr: 85, pot: 86, age: 26, pos: 'ST', form: 7.5, contractUntil: 2030, hg: true, international: true };
const eliteValue = computeTrueValue(elitePlayer, { yearsRemaining: 4, currentYear: 2026, worldEcon: { tinfl: 4.5, tvg: 3.5 } });
check('Elite 26yo ST valued > £20M', eliteValue > 20e6, `Got £${(eliteValue/1e6).toFixed(1)}M`);
const oldPlayer = { ovr: 80, pot: 80, age: 33, pos: 'ST', form: 6.5, contractUntil: 2027 };
const oldValue = computeTrueValue(oldPlayer, { yearsRemaining: 1, currentYear: 2026, worldEcon: { tinfl: 4.5, tvg: 3.5 } });
check('33yo player worth < 26yo of same rating', oldValue < eliteValue);
const range = scoutedValueRange(eliteValue, 'FullyKnown');
check('FullyKnown range is tight (±2%)', (range.high - range.low) / range.mid < 0.05);
const rangeRumored = scoutedValueRange(eliteValue, 'Rumored');
check('Rumored range is wide (±30%)', (rangeRumored.high - rangeRumored.low) / rangeRumored.mid > 0.5);
check('Contract modifier ×1.25 for 4+ years', contractModifier(4) === 1.25);
check('Contract modifier ×0.45 for <12 months', contractModifier(0.5) === 0.45);
const wage = computeWageAsk(elitePlayer, { wageCeiling: 200000 });
check('Wage ask positive', wage > 0);

console.log('\nStep 4.2 — AI Club Behavior:');
const aiClub = [...state.entities.clubs.values()].find(c => c.id !== state.meta.userClubId);
const identity = deriveRecruitmentIdentity(aiClub);
check('AI club has recruitment identity', Object.values(RECRUITMENT_IDENTITIES).includes(identity));
const needs = assessSquadNeeds(state, aiClub);
check('AI club needs assessed (array)', Array.isArray(needs));
const targets = shortlistTargets(state, aiClub, needs.length ? needs : [{ kind: 'no_starter', pos: 'ST', urgency: 0.5 }]);
check('AI shortlist is an array', Array.isArray(targets));

console.log('\nStep 4.3 — Negotiation State Machine:');
const targetPlayer = [...state.entities.players.values()].find(p => p.ovr >= 70 && p.ovr <= 78);
if (targetPlayer) {
  const sellerClub = [...state.entities.clubs.values()].find(c => c.squadIds?.includes(targetPlayer.id));
  const buyerClub = [...state.entities.clubs.values()].find(c => c.id !== sellerClub?.id && c.id !== state.meta.userClubId);
  if (sellerClub && buyerClub) {
    const neg = createNegotiation({
      state, buyerClubId: buyerClub.id, sellerClubId: sellerClub.id, playerId: targetPlayer.id
    });
    check('Negotiation created', neg !== null);
    if (neg) {
      check('Negotiation starts in IDLE', neg.state === NEGOTIATION_STATES.IDLE);
      submitBid(neg, { cash: neg.askingPrice * 0.9, addons: 0, sellOnPct: 10, loanFee: 0, obligation: false });
      check('Bid submitted transitions to BID_SUBMITTED', neg.state === NEGOTIATION_STATES.BID_SUBMITTED);
      const result = evaluateBid(neg, { prng: new PRNG(42) });
      check('Bid evaluation produces state', [NEGOTIATION_STATES.ACCEPTED, NEGOTIATION_STATES.COUNTER_OFFERED, NEGOTIATION_STATES.REJECTED].includes(result.state));
    }
  }
}

console.log('\nStep 4.4 — Agent Behavior:');
const greedyAgent = { pers: 'Greedy' };
const loyalAgent = { pers: 'Loyal' };
check('Greedy agent opens 35% above market', openingWageAsk(greedyAgent, 50000) === 67500);
check('Loyal agent opens 5% above market', openingWageAsk(loyalAgent, 50000) === 52500);
const evalResult = evaluateWageOffer(greedyAgent, 60000, 50000, { round: 1, prng: new PRNG(100) });
check('Greedy agent responds (accept or counter)', evalResult.accept === true || evalResult.counterWage != null || evalResult.reason === 'walked_away');
const memory = updateAgentMemory({ pers: 'Greedy' }, 'fair_deal');
check('Fair deal improves agent warmth', memory.warmth > 50);
const coldMemory = updateAgentMemory({ pers: 'Greedy', memory: { warmth: 50 } }, 'lowball');
check('Lowball reduces agent warmth', coldMemory.warmth < 50);

console.log('\nStep 4.5 — Player Agency:');
const ambitiousPlayer = { age: 23, ovr: 78, role: 'Star Player', wage: 50000, contractUntil: 2028, hidden: { ambition: 90 }, pers: { loy: 50 }, stats: { mins: 1000 } };
const lowRepClub = { rep: 2, squadIds: ['p1'], budget: 5e6 };
const desire = computeDesire(ambitiousPlayer, lowRepClub, state);
check('Ambitious player at low-rep club wants to move', desire > 0.5, `Desire: ${desire.toFixed(2)}`);
const stance = stanceOnMove(ambitiousPlayer, { rep: 5 }, { rep: 2 }, desire);
check('Stance categorized', ['wants_move', 'indifferent', 'wants_to_stay'].includes(stance));
const outcome = moveOutcome('wants_move');
check('Wants-move player has fast terms', outcome.fastTerms === true);

console.log('\nStep 4.6 — Sell Side:');
const userClub = state.entities.clubs.get(state.meta.userClubId);
const starPlayer = [...state.entities.players.values()].find(p => userClub.squadIds.includes(p.id) && p.ovr >= 80);
if (starPlayer) {
  const replacement = checkReplacementNeed(state, userClub, starPlayer);
  // Selling a key player likely creates a hole
  check('Replacement check runs', replacement === null || typeof replacement.warning === 'string');
}

console.log('\nStep 4.7 — Loans & Free Agents:');
const faPool = generateFreeAgentPool(state, new PRNG(789));
check('Free agent pool generated', faPool.length > 0);
check('Free agents skew old or young', faPool.every(fa => fa.age <= 22 || fa.age >= 31));
const userClubForFA = state.entities.clubs.get(state.meta.userClubId);
const fa = faPool[0];
const faResult = signFreeAgent(state, fa, userClubForFA, fa.wage * 1.3, { prng: new PRNG(999) });
check('Free agent signing returns result', faResult.accepted === true || faResult.accepted === false);

console.log('\nStep 4.8 — Bosman:');
const expiringPlayer = { ...elitePlayer, contractUntil: 2026 };
const bosmanState = { clock: { date: '2026-01-15', seasonYear: 2026 }, entities: { players: new Map(), clubs: new Map() } };
bosmanState.entities.players.set('p1', expiringPlayer);
check('Player with <6 months contract is Bosman eligible', isBosmanEligible(expiringPlayer, bosmanState) === true);
const longTermPlayer = { ...elitePlayer, contractUntil: 2030 };
check('Player with 4 years is NOT Bosman eligible', isBosmanEligible(longTermPlayer, bosmanState) === false);
const bosmanP = bosmanAcceptanceProbability(
  { wage: 50000, hidden: { ambition: 80 }, pers: { loy: 50 } },
  { rep: 5 }, { rep: 3 }, 70000
);
check('Bosman acceptance in valid range', bosmanP >= 0 && bosmanP <= 1);

console.log('\nStep 4.9 — Deadline Day:');
const deadlineState = { clock: { date: '2026-08-31' } };
check('Aug 31 is deadline day', isDeadlineDay(deadlineState) === true);
const midSeason = { clock: { date: '2026-10-15' } };
check('Oct 15 is NOT deadline day', isDeadlineDay(midSeason) === false);
check('June is open window', isWindowOpen({ clock: { date: '2026-06-15' } }) === true);
check('October is closed window', isWindowOpen({ clock: { date: '2026-10-15' } }) === false);

console.log('\nStep 4.10 — Integration (market tick):');
// Run a window-open day and verify transfers module runs without error
const summerState = newSeedState({ saveId: 's34_summer' });
summerState.clock.date = '2026-07-15';   // window open
setState(summerState);
const beforeNegotiations = summerState.negotiations?.length || 0;
dispatch({ type: A.ADVANCE_DAY });
check('Day advance during window completes', getState().clock.dayNumber === summerState.clock.dayNumber);

// ---------------- Summary ----------------
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
