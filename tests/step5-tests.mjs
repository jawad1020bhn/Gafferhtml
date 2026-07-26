// Step 5 verification tests.
// Runs in Node: `node tests/step5-tests.mjs`

import { PRNG, hashString } from '../src/core/prng.js';
import { newSeedState } from '../src/data/seed.js';
import { initNewGame, getState, setState, dispatch, A } from '../src/core/state.js';
import '../src/sim/tick.js'; // register tick engine

import {
  initFinanceState,
  addTransaction,
  calculateWeeklyWages,
  handleMatchdayFinance,
  handleTelevisedMatchFee,
  processSponsorsAndBroadcastingMonthly,
  processSponsorSatisfactionMatch,
  settleMayMeritPayments,
  processYearlySponsorRenewals,
  accrueDailyMerchandise,
  triggerAnnualKitRelease,
  handleCupProgressionPrize,
  processWeeklyWageRun,
  processMonthlyExpenses,
  processAgentFeeOnSigning,
  registerAmortization,
  processYearlyAmortization,
  writeOffAmortizationOnSale,
  runFFPAudit,
  triggerStadiumExpansion,
  tickDailyFinance
} from '../src/sim/finance/engine.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
}

console.log('\n=== STEP 5 Financial Simulation & Club Growth Tests ===\n');

// Initialize a standard test state
const state = newSeedState({ saveId: 's5' });
initFinanceState(state);

// ---------------- 5.1 MATCHDAY ECONOMICS ----------------
console.log('Step 5.1 — Matchday Economics:');
const fixture = state.competitions.league.fixtures.find(f => f.homeId === state.meta.userClubId && !f.isDerby);
const prng = new PRNG(12345);
const report = { score: { hs: 2, as: 1 }, playerStats: [] };

const normalFin = handleMatchdayFinance(state, fixture, report, prng);
check('Attendance is computed and is within reasonable bounds', normalFin.attendance > 10000 && normalFin.attendance <= 52400, `Got: ${normalFin.attendance}`);
check('VIP gate receipts and concessions revenues are computed', normalFin.gateReceipts > 0 && normalFin.concessionsRevenue > 0);

// Ticket pricing tension
const beforeTicketPrice = state.stadium.ticket;
state.stadium.ticket = 45; // significantly higher
const expensiveFin = handleMatchdayFinance(state, fixture, report, prng);
check('Higher ticket price reduces fill rate / attendance', expensiveFin.fillRate < normalFin.fillRate, `Expensive fill: ${expensiveFin.fillRate} vs Normal: ${normalFin.fillRate}`);
state.stadium.ticket = beforeTicketPrice; // restore

// Under construction capacity penalty (15% reduction)
state.stadium.expansionDaysLeft = 300;
const constructionFin = handleMatchdayFinance(state, fixture, report, prng);
check('Under-construction stadium has reduced attendance', constructionFin.attendance < normalFin.attendance, `Under construction: ${constructionFin.attendance} vs Normal: ${normalFin.attendance}`);
state.stadium.expansionDaysLeft = null; // restore

// Derby 100% capacity
const derbyFixture = { ...fixture, isDerby: true };
const derbyFin = handleMatchdayFinance(state, derbyFixture, report, prng);
check('Derby matches trigger 100% fill rate (sellout)', derbyFin.fillRate === 1.0, `Got fill rate: ${derbyFin.fillRate}`);


// ---------------- 5.2 BROADCASTING & COMMERCIALS ----------------
console.log('\nStep 5.2 — Broadcasting & Commercials:');
const beforeBal = state.finance.balance;
processSponsorsAndBroadcastingMonthly(state);
check('Monthly broadcasting installment and sponsor base are credited', state.finance.balance > beforeBal);

// Win bonus escalator
const beforeSponsorBal = state.finance.balance;
processSponsorSatisfactionMatch(state, fixture, { hs: 3, as: 1 });
check('Wins trigger win bonus payout from sponsors', state.finance.balance > beforeSponsorBal);


// ---------------- 5.3 MERCHANDISE ----------------
console.log('\nStep 5.3 — Merchandise Sales:');
const beforeMerchBal = state.finance.balance;
accrueDailyMerchandise(state);
check('Daily merchandise is accrued and added to balance', state.finance.balance > beforeMerchBal);

// Hat-trick shirt sales spike
state.finance.hatTrickSpikeDays = 14;
const beforeSpikeBal = state.finance.balance;
accrueDailyMerchandise(state);
const spikeGain = state.finance.balance - beforeSpikeBal;
state.finance.hatTrickSpikeDays = 0; // reset
const beforeNormalMerchBal = state.finance.balance;
accrueDailyMerchandise(state);
const normalGain = state.finance.balance - beforeNormalMerchBal;
check('Hat-trick shirt sales spike increases merchandise revenue', spikeGain > normalGain, `Spike gain: ${spikeGain} vs Normal: ${normalGain}`);


// ---------------- 5.4 EXPENDITURES & AMORTIZATION ----------------
console.log('\nStep 5.4 — Expenditures & Amortization:');
const weeklyWages = calculateWeeklyWages(state);
check('Weekly wages calculated to a positive sum', weeklyWages > 0, `Wages: £${weeklyWages}`);

const beforeWageBal = state.finance.balance;
processWeeklyWageRun(state);
check('Weekly wage run deducts wages from cash balance', state.finance.balance < beforeWageBal, `Before: ${beforeWageBal}, After: ${state.finance.balance}`);

// Amortization register and disposal write-off
const dummyPlayer = { id: 'pl_dummy', name: 'Amortized Player', ovr: 80 };
registerAmortization(state, dummyPlayer, 20e6, 5); // £20M on 5 years
const disposal = writeOffAmortizationOnSale(state, dummyPlayer, 15e6); // sold for £15M after 0 years elapsed
check('Remaining unamortized value calculated correctly on sale', disposal.unamortizedValue === 20e6, `Got unamortized value: ${disposal.unamortizedValue}`);
check('Book profit/loss calculated correctly (loss of £5M)', disposal.bookPnL === -5e6 && disposal.isLoss === true);


// ---------------- 5.5 FFP COMPLIANCE ----------------
console.log('\nStep 5.5 — FFP Compliance & Sanctions:');
runFFPAudit(state);
check('Initially compliant FFP status is reported', state.finance.summary.ffp === 'Compliant' && state.finance.transferBudgetFrozen === false);

// Level 3 violation (force high wage ratio by making revenue extremely small)
state.finance.summary.inc = { Matchday: 0, Broadcasting: 0.1, Commercial: 0.1, Merchandise: 0, Transfers: 0, Prize: 0 };
runFFPAudit(state);
check('Extreme wage-to-revenue ratio triggers Level 3 critical breach', state.finance.transferBanActive === true && state.finance.transferBudgetFrozen === true);


// ---------------- 5.6 STADIUM EXPANSION & CRISIS ----------------
console.log('\nStep 5.6 — Stadium Expansion & Crisis:');
state.finance.balance = 50e6;
state.stadium.expansionDaysLeft = null;
const expandRes = triggerStadiumExpansion(state);
check('Triggering stadium expansion approved and financed via debt', expandRes === true && state.stadium.expansionDaysLeft === 540);

// Crisis Mode trigger on 3 months negative cash
state.finance.balance = -10000;
state.finance.consecutiveNegativeMonths = 2; // already 2 months negative
state.finance.crisisModeActive = false;
state.clock.date = '2026-11-28'; // day of month 28 triggers monthly check
tickDailyFinance(state, prng);
check('Third consecutive month of negative cash triggers Crisis Mode', state.finance.crisisModeActive === true && state.finance.transferBanActive === true);

// Recovery from Crisis Mode (Restore to high positive cash to survive Operating upkeeps)
state.finance.balance = 10e6; // restored to positive £10M
tickDailyFinance(state, prng); // trigger Day 28 audit (clock date advances daily)
check('Restoring positive cash balance deactivates Crisis Mode', state.finance.crisisModeActive === false && state.finance.transferBanActive === false);


// Summary
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
