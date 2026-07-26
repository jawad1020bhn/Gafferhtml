// sim/finance/engine.js
// Core Financial Simulation & Club Growth Engine.
// Manages dynamic revenues, expenditures, amortizations, cash flow timing,
// FFP compliance, facility ROI, stadium economics, and crisis recovery.

import { logger } from '../../core/logger.js';
import { EVT } from '../../core/eventBus.js';

// Define core transaction categories and their mapping to PnL summaries
export const INC_KEYS = {
  matchday: 'Matchday',
  broadcasting: 'Broadcasting',
  commercial: 'Commercial',
  merchandise: 'Merchandise',
  transfer_in: 'Transfers',
  prize: 'Prize'
};

export const EXP_KEYS = {
  wages: 'Wages',
  operating: 'Facilities', // facility upkeeps
  interest: 'Interest',
  scouting: 'Scouting',
  medical: 'Medical',
  travel: 'Travel',
  marketing: 'Marketing',
  transfer_out: 'Transfers'
};

/**
 * Initialize state finance parameters if missing (migration safety).
 */
export function initFinanceState(state) {
  state.finance = state.finance || {};
  state.finance.balance = state.finance.balance ?? 31.2e6;
  state.finance.transferBudget = state.finance.transferBudget ?? 42.5e6;
  state.finance.wageBudget = state.finance.wageBudget ?? 9.4e6;
  state.finance.wageCeiling = state.finance.wageCeiling ?? 12e6;
  state.finance.transactions = state.finance.transactions || [];
  state.finance.amortizations = state.finance.amortizations || [];
  state.finance.hatTrickSpikeDays = state.finance.hatTrickSpikeDays ?? 0;
  state.finance.marqueeSigningBoost = state.finance.marqueeSigningBoost ?? false;
  state.finance.transferBudgetFrozen = state.finance.transferBudgetFrozen ?? false;
  state.finance.squadLimitReduced = state.finance.squadLimitReduced ?? false;
  state.finance.transferBanActive = state.finance.transferBanActive ?? false;
  state.finance.consecutiveNegativeMonths = state.finance.consecutiveNegativeMonths ?? 0;
  state.finance.crisisModeActive = state.finance.crisisModeActive ?? false;

  state.stadium = state.stadium || { cap: 52400, vip: 2400, boxes: 64, ticket: 28, season: 640 };
  state.stadium.expansionDaysLeft = state.stadium.expansionDaysLeft ?? null;

  state.finance.summary = state.finance.summary || {
    debt: 18e6,
    credit: 'A',
    rate: '4.5%',
    limit: 600e6,
    ffp: 'Compliant',
    wageRatio: 68,
    inc: { Matchday: 4.1, Broadcasting: 6.8, Commercial: 5.2, Merchandise: 1.9, Transfers: 2.4, Prize: 1.6 },
    exp: { Wages: 9.4, Facilities: 1.8, Interest: 0.6, Scouting: 0.5, Medical: 0.4, Travel: 0.3, Marketing: 0.5 },
    pnl: [-12, 4, 11]
  };
}

/**
 * Append a financial transaction and update cash on hand / summaries.
 */
export function addTransaction(state, amount, category, note) {
  initFinanceState(state);

  // Update absolute cash balance
  state.finance.balance += amount;

  // Append transaction log entry
  state.finance.transactions.push({
    id: 'tx_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    date: state.clock.date,
    amount,
    category,
    note: note || ''
  });

  // Prune transaction history to keep size manageable
  if (state.finance.transactions.length > 500) {
    state.finance.transactions = state.finance.transactions.slice(-500);
  }

  // Update Fsum / PnL totals (values stored in £M)
  const fsum = state.finance.summary;
  if (amount > 0 && INC_KEYS[category]) {
    const k = INC_KEYS[category];
    fsum.inc[k] = (fsum.inc[k] || 0) + amount / 1e6;
  } else if (amount < 0 && EXP_KEYS[category]) {
    const k = EXP_KEYS[category];
    fsum.exp[k] = (fsum.exp[k] || 0) + Math.abs(amount) / 1e6;
  }

  logger.debug('finance', 'transaction logged', { amount, category, note, balance: state.finance.balance });
}

/**
 * Calculate weekly wages for all playing squads, managers, and scouts.
 */
export function calculateWeeklyWages(state) {
  let totalWages = 0;

  // 1. Players on user squad (not loaned out)
  const userClub = state.entities.clubs.get(state.meta.userClubId);
  if (userClub) {
    for (const pid of userClub.squadIds || []) {
      const p = state.entities.players.get(pid);
      if (p && !p.onLoan) {
        totalWages += p.wage || 0;
      }
    }
  }

  // 2. Staff wages
  for (const staff of state.entities.staff.values()) {
    if (staff.clubId === state.meta.userClubId) {
      totalWages += staff.wage || 0;
    }
  }

  // 3. Manager wage
  totalWages += state.manager?.wage || 25000;

  // 4. Loan players wage splits
  state.relationships.loans = state.relationships.loans || [];
  for (const loan of state.relationships.loans) {
    if (loan.recalledAt) continue;
    const p = state.entities.players.get(loan.playerId);
    if (!p) continue;

    if (loan.parentId === state.meta.userClubId) {
      // User is the parent club. The other club pays wageSplitPct%.
      const userShare = 1 - (loan.wageSplitPct || 50) / 100;
      totalWages += p.wage * userShare;
    } else if (loan.loaningId === state.meta.userClubId) {
      // User is the loaning club. User pays wageSplitPct%.
      const userShare = (loan.wageSplitPct || 50) / 100;
      totalWages += p.wage * userShare;
    }
  }

  return Math.round(totalWages);
}

/**
 * Calculate and process matchday revenue for a single fixture.
 */
export function handleMatchdayFinance(state, fixture, report, prng) {
  initFinanceState(state);

  const userClubId = state.meta.userClubId;
  const userIsHome = fixture.homeId === userClubId;
  const userIsAway = fixture.awayId === userClubId;
  if (!userIsHome && !userIsAway) return null; // Only process user-involved fixtures

  const userClub = state.entities.clubs.get(userClubId);
  const oppClubId = userIsHome ? fixture.awayId : fixture.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const oppCode = oppClub?.code || 'OPP';

  // If user is AWAY, no matchday revenue is earned (belongs to home club).
  if (userIsAway) return null;

  // ---- 1. Stadium Capacity ----
  let capacity = state.stadium?.cap || 52400;
  if (state.stadium.expansionDaysLeft !== null && state.stadium.expansionDaysLeft > 0) {
    // Under construction: capacity is reduced by 15%
    capacity = Math.round(capacity * 0.85);
  }

  // ---- 2. Fill Rate & Attendance Components ----
  const baseFillRate = 0.85;

  // A. League position modifier
  const table = state.competitions.league.table || [];
  const position = table.findIndex(r => r.clubId === userClubId) + 1 || 2;
  const posMod = 1 + (9 - position) * 0.015;

  // B. Recent form modifier (average form points over last 5 matches)
  const userRow = table.find(r => r.clubId === userClubId);
  const formPts = userRow ? userRow.form.reduce((sum, f) => sum + (f === 'W' ? 3 : f === 'D' ? 1 : 0), 0) / Math.max(1, userRow.form.length) : 1.8;
  const formMod = 1 + (formPts - 1.5) * 0.05;

  // C. Opponent appeal
  let appeal = 0.88;
  if (fixture.isDerby) {
    appeal = 1.0;
  } else if (oppCode === 'OAK') {
    appeal = 0.82;
  } else if (oppClub) {
    // Map opponent rep (1-5) to appeal (0.82 to 0.96)
    appeal = 0.80 + (oppClub.rep || 3) * 0.03;
  }

  // D. Fan Happiness
  const fanSentiment = state.media?.fanSentiment ?? 71;
  const fanMod = 0.8 + (fanSentiment / 100) * 0.2;

  // E. Weather Deterministic Mod
  const weatherRoll = prng ? prng.next() : Math.random();
  let weather = 'Sunny';
  let weatherMod = 1.0;
  if (weatherRoll < 0.15) {
    weather = 'Snowing';
    weatherMod = 0.85;
  } else if (weatherRoll < 0.40) {
    weather = 'Rainy';
    weatherMod = 0.93;
  }

  // F. Ticket Pricing Tension
  const standardPrice = state.stadium?.ticket || 28;
  const priceDiff = standardPrice - 28;
  let priceMod = 1.0;
  if (priceDiff > 0) {
    priceMod = Math.max(0.5, 1 - priceDiff * 0.045);
  } else if (priceDiff < 0) {
    priceMod = Math.min(1.2, 1 + Math.abs(priceDiff) * 0.02);
  }

  // Compute final fill rate and attendance
  let fillRate = baseFillRate * posMod * formMod * appeal * fanMod * weatherMod * priceMod;
  if (fixture.isDerby) {
    fillRate = 1.0; // Derbies always sell out regardless of price/weather
  }
  fillRate = Math.max(0, Math.min(1.0, fillRate));
  const attendance = Math.round(capacity * fillRate);

  // ---- 3. Standard vs VIP Split ----
  const vipCount = state.stadium?.vip || 2400;
  const vipSold = Math.min(attendance, vipCount);
  const standardSold = Math.max(0, attendance - vipSold);
  const vipPrice = standardPrice * 4;

  const gateReceipts = (standardSold * standardPrice) + (vipSold * vipPrice);

  // ---- 4. Concessions Revenue ----
  const avgSpend = 6 + (fanSentiment / 100) * 8; // £6 to £14 range based on happiness
  const concessionsRevenue = attendance * avgSpend;

  const totalRevenue = Math.round(gateReceipts + concessionsRevenue);

  // Log matchday transaction
  addTransaction(state, totalRevenue, 'matchday', `Matchday revenue vs ${oppCode} (Att: ${attendance.toLocaleString()}, standard: ${standardSold}, VIP: ${vipSold}, weather: ${weather})`);

  logger.info('finance', 'processed matchday finance', { attendance, gateReceipts, concessionsRevenue, totalRevenue });

  return {
    attendance,
    fillRate,
    gateReceipts,
    concessionsRevenue,
    totalRevenue,
    weather
  };
}

/**
 * Handle televised match facility fee payout.
 * Televised derbies or matches against highly reputed opponents yield £1.2M.
 */
export function handleTelevisedMatchFee(state, fixture, prng) {
  const userClubId = state.meta.userClubId;
  const userIsHome = fixture.homeId === userClubId;
  if (!userIsHome) return; // facility fee paid to the home club

  const oppClubId = fixture.awayId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const oppRep = oppClub?.rep || 3;
  const oppCode = oppClub?.code || 'OPP';

  let televised = false;
  if (fixture.isDerby) {
    televised = true; // Derbies are always televised
  } else if (oppRep >= 4) {
    // 60% chance for matches vs high rep opponents
    const tvRoll = prng ? prng.next() : Math.random();
    televised = tvRoll < 0.60;
  }

  if (televised) {
    const televisedFee = 1200000;
    addTransaction(state, televisedFee, 'broadcasting', `Broadcasting televised facility fee vs ${oppCode}`);
    logger.info('finance', 'earned televised match facility fee', { televisedFee });
  }
}

/**
 * Accrue monthly sponsorships and broadcasting installments.
 */
export function processSponsorsAndBroadcastingMonthly(state) {
  initFinanceState(state);

  // 1. Broadcasting Equal-Share Base: £25M/year / 12 months = £2.083M/month
  const broadcastInstallment = 2083333;
  addTransaction(state, broadcastInstallment, 'broadcasting', 'Broadcasting monthly equal-share installment');

  // 2. Commercial Sponsors Monthly Base: sum of all annual sponsor deals / 12
  let annualSponsorSum = 0;
  if (state.sponsors) {
    for (const sp of state.sponsors) {
      annualSponsorSum += sp.yr || 0;
    }
  } else {
    // Default fallback to 5.2M if not populated
    annualSponsorSum = 5.2e6;
  }
  const monthlySponsorBase = Math.round(annualSponsorSum / 12);
  addTransaction(state, monthlySponsorBase, 'commercial', 'Commercial sponsorships monthly base accrual');

  logger.info('finance', 'monthly sponsors and broadcasting processed', { broadcastInstallment, monthlySponsorBase });
}

/**
 * Tick sponsor satisfaction and process escalators after matches.
 */
export function processSponsorSatisfactionMatch(state, fixture, result) {
  initFinanceState(state);
  const userClubId = state.meta.userClubId;
  const userIsHome = fixture.homeId === userClubId;
  const hs = result.hs;
  const as = result.as;
  const won = (userIsHome && hs > as) || (!userIsHome && as > hs);
  const lost = (userIsHome && hs < as) || (!userIsHome && hs > as);

  if (!state.sponsors) return;

  // 1. Satisfaction fluctuations
  let satDelta = 0;
  if (won) {
    satDelta = fixture.isDerby ? 3.0 : 1.0;
  } else if (lost) {
    satDelta = fixture.isDerby ? -3.0 : -1.5;
  } else {
    satDelta = -0.2; // slight drop on a draw
  }

  for (const sp of state.sponsors) {
    sp.sat = Math.max(0, Math.min(100, (sp.sat ?? 75) + satDelta));
  }

  // 2. Performance Escalator: win bonus (£50K per win)
  if (won) {
    const winBonus = 50000;
    addTransaction(state, winBonus, 'commercial', `Sponsor win bonus vs ${userIsHome ? 'AWAY' : 'HOME'} opponent`);
    logger.info('finance', 'earned sponsor match win bonus', { winBonus });
  }
}

/**
 * Settle May league position merit payments at season end.
 */
export function settleMayMeritPayments(state) {
  initFinanceState(state);

  const userClubId = state.meta.userClubId;
  const table = state.competitions.league.table || [];
  const position = table.findIndex(r => r.clubId === userClubId) + 1 || 2;

  // Each place ≈ £1.9M differential (1st gets 18 * £1.9M = £34.2M, 18th gets £1.9M)
  const meritPayment = (19 - position) * 1900000;

  addTransaction(state, meritPayment, 'broadcasting', `Broadcasting final merit payment (Finish position: ${position} of 18)`);
  logger.info('finance', 'settled May league position merit payment', { position, meritPayment });

  // European Qualification performance trigger escalator: £3.5M for top 4 finish
  if (position <= 4) {
    const europeBonus = 3500000;
    addTransaction(state, europeBonus, 'commercial', 'Commercial sponsor European qualification bonus');
    logger.info('finance', 'earned European qualification trigger bonus', { europeBonus });
  }

  // Trophy winner clause: £5.0M if finishing 1st
  if (position === 1) {
    const trophyBonus = 5000000;
    addTransaction(state, trophyBonus, 'commercial', 'Commercial sponsor league championship trophy clause');
    logger.info('finance', 'earned champion trophy escalator bonus', { trophyBonus });
  }
}

/**
 * Handle annual sponsor renewals at season end.
 * If satisfaction >= 82, they renew readily with a 15% raise.
 * If satisfaction between 50 and 81, 50% chance they renew at flat rates, 50% chance they ask for a renegotiation (15% discount).
 * If satisfaction < 50, they walk away, leaving a budget hole.
 */
export function processYearlySponsorRenewals(state, prng) {
  initFinanceState(state);
  const currentYear = state.clock.seasonYear || 2026;
  if (!state.sponsors) return;

  const expiredIndexes = [];
  for (let i = 0; i < state.sponsors.length; i++) {
    const sp = state.sponsors[i];
    if ((sp.until || sp.expiresAt) <= currentYear) {
      const roll = prng ? prng.next() : Math.random();
      const sat = sp.sat ?? 75;

      if (sat >= 82) {
        // High satisfaction: 15% raise, renews for 3 more years
        sp.yr = Math.round(sp.yr * 1.15);
        sp.until = currentYear + 3;
        sp.expiresAt = currentYear + 3;
        sp.sat = 75; // reset sat baseline

        // Notify user via inbox
        state.inbox = state.inbox || [];
        state.inbox.unshift({
          id: 'msg_renew_' + Date.now() + '_' + i,
          severity: 'lo',
          sender: 'Commercial Dept.',
          subject: `${sp.name} contract renewed`,
          body: `Due to strong performance and high partner satisfaction (${sat}), ${sp.name} has renewed their sponsorship for 3 years at an increased rate of £${(sp.yr/1e6).toFixed(1)}M/year.`,
          choices: [],
          done: true
        });
      } else if (sat >= 50) {
        // Moderate satisfaction: 50% flat renewal, 50% discount renewal
        if (roll < 0.5) {
          sp.until = currentYear + 2;
          sp.expiresAt = currentYear + 2;
          sp.sat = 60;
          state.inbox = state.inbox || [];
          state.inbox.unshift({
            id: 'msg_renew_' + Date.now() + '_' + i,
            severity: 'lo',
            sender: 'Commercial Dept.',
            subject: `${sp.name} contract renewed`,
            body: `${sp.name} has agreed to a flat 2-year renewal of £${(sp.yr/1e6).toFixed(1)}M/year.`,
            choices: [],
            done: true
          });
        } else {
          // Demands 15% discount
          sp.yr = Math.round(sp.yr * 0.85);
          sp.until = currentYear + 2;
          sp.expiresAt = currentYear + 2;
          sp.sat = 65;
          state.inbox = state.inbox || [];
          state.inbox.unshift({
            id: 'msg_renew_' + Date.now() + '_' + i,
            severity: 'md',
            sender: 'Commercial Dept.',
            subject: `${sp.name} demands discount`,
            body: `Citing average performance (satisfaction: ${sat}), ${sp.name} has negotiated a 2-year renewal but demanded a 15% rate discount to £${(sp.yr/1e6).toFixed(1)}M/year.`,
            choices: [],
            done: true
          });
        }
      } else {
        // Low satisfaction: sponsor walks away!
        expiredIndexes.push(i);
        state.inbox = state.inbox || [];
        state.inbox.unshift({
          id: 'msg_walk_' + Date.now() + '_' + i,
          severity: 'hi',
          sender: 'Commercial Dept.',
          subject: `${sp.name} contract terminated`,
          body: `Disastrous partner satisfaction (${sat}) has prompted ${sp.name} to invoke their exit clauses and decline contract renewal. We have lost £${(sp.yr/1e6).toFixed(1)}M of annual commercial revenue.`,
          choices: [],
          done: true
        });
      }
    }
  }

  // Remove sponsors who walked away
  if (expiredIndexes.length > 0) {
    state.sponsors = state.sponsors.filter((_, idx) => !expiredIndexes.includes(idx));
  }
}

/**
 * Process daily merchandise sales driven by brand value.
 * Brand value rises with results and star signings.
 */
export function accrueDailyMerchandise(state) {
  initFinanceState(state);

  const brand = state.brand || { prestige: 74, popularity: 68, history: 71, intl: 52, youth: 79, attack: 83 };
  const brandScore = ((brand.prestige || 70) + (brand.popularity || 70) + (brand.history || 70) + (brand.intl || 70) + (brand.youth || 70) + (brand.attack || 70)) / 6;

  // Base daily merchandise: £18 per brand point
  let dailyMerch = Math.round(brandScore * 18);

  // Hat-trick shirt spike (lasts 2 weeks = 14 days)
  if (state.finance.hatTrickSpikeDays > 0) {
    state.finance.hatTrickSpikeDays--;
    dailyMerch = Math.round(dailyMerch * 1.50);
  }

  // Marquee signing global merchandise boost (permanently 25% for the season)
  if (state.finance.marqueeSigningBoost) {
    dailyMerch = Math.round(dailyMerch * 1.25);
  }

  addTransaction(state, dailyMerch, 'merchandise', 'Daily merchandise sales');
}

/**
 * Handle new kit release revenue pulse (triggered annually on July 1st).
 */
export function triggerAnnualKitRelease(state) {
  const kitRevenue = 4500000; // £4.5M cash pulse
  addTransaction(state, kitRevenue, 'merchandise', 'Annual new kit release revenue pulse');
  logger.info('finance', 'annual kit release processed', { kitRevenue });
}

/**
 * Handle cup progression ladder prize money.
 */
export function handleCupProgressionPrize(state, fixture, result) {
  initFinanceState(state);

  // Check if fixture is a cup fixture and user won
  if (fixture.competition !== 'cup-league' && fixture.competition !== 'cup') return;
  const userClubId = state.meta.userClubId;
  const userIsHome = fixture.homeId === userClubId;
  const userWon = (userIsHome && result.hs > result.as) || (!userIsHome && result.as > result.hs);
  if (!userWon) return;

  const round = fixture.cupRound || 'R4';
  const prizeMap = {
    'R4': 250000,
    'QF': 500000,
    'SF': 1000000,
    'Final': 2500000
  };

  const prizeMoney = prizeMap[round] || 250000;
  addTransaction(state, prizeMoney, 'prize', `Meridian Cup ${round} win prize money`);
  logger.info('finance', 'awarded cup progression prize', { round, prizeMoney });
}

/**
 * Execute weekly wage run (dayNumber % 7 === 0).
 */
export function processWeeklyWageRun(state) {
  initFinanceState(state);
  const weeklyWages = calculateWeeklyWages(state);

  // Deduct from balance
  addTransaction(state, -weeklyWages, 'wages', 'Weekly wage run (players, coaching staff, manager)');
  logger.info('finance', 'processed weekly wage run', { weeklyWages });
}

/**
 * Process monthly facility upkeeps and operating costs (day Number % 28 === 0 or month-end).
 */
export function processMonthlyExpenses(state) {
  initFinanceState(state);

  // 1. Facility upkeeps based on facility levels
  let totalUpkeep = 0;
  const userClubId = state.meta.userClubId;
  const userClub = state.entities.clubs.get(userClubId);
  if (userClub && userClub.facilityIds) {
    for (const fid of userClub.facilityIds) {
      const fac = state.entities.facilities.get(fid);
      if (fac) {
        // Upkeep scales with level
        const baseMaint = {
          training: 65000,
          youth: 80000,
          medical: 52000,
          science: 44000,
          gym: 30000,
          analysis: 36000
        }[fac.type] || 40000;
        totalUpkeep += Math.round(baseMaint * (fac.level / 5));
      }
    }
  } else {
    totalUpkeep = 307000; // default total upkeep
  }
  addTransaction(state, -totalUpkeep, 'operating', 'Monthly facilities maintenance upkeep');

  // 2. Base operations (Travel, Marketing, Medical, Sports Science base)
  const travelCost = 25000;
  const marketingCost = 40000;
  const sportsScienceCost = 35000;
  addTransaction(state, -travelCost, 'travel', 'Monthly team travel expenses');
  addTransaction(state, -marketingCost, 'marketing', 'Monthly club marketing expenses');
  addTransaction(state, -sportsScienceCost, 'medical', 'Monthly sports science network upkeep');

  // 3. Scouting network expenses (£40K base + £15K per active assignment)
  let activeScoutingAssignments = 0;
  for (const st of state.entities.staff.values()) {
    if (st.role === 'scout' && st.assignment && st.assignment.daysLeft > 0) {
      activeScoutingAssignments++;
    }
  }
  const scoutingCost = 40000 + activeScoutingAssignments * 15000;
  addTransaction(state, -scoutingCost, 'scouting', `Monthly scouting network operations (${activeScoutingAssignments} active assignments)`);

  // 4. Monthly interest on debt (£18M at 4.5% annual = £67.5K)
  const fsum = state.finance.summary;
  const monthlyInterest = Math.round(fsum.debt * 0.045 / 12);
  addTransaction(state, -monthlyInterest, 'interest', 'Monthly interest payment on outstanding debt');

  // 5. Overdraft credit interest if balance is negative (5.5% annual on absolute balance)
  if (state.finance.balance < 0) {
    const overdraftInterest = Math.round(Math.abs(state.finance.balance) * 0.055 / 12);
    addTransaction(state, -overdraftInterest, 'interest', 'Monthly credit facility interest on negative cash balance');
  }

  logger.info('finance', 'processed monthly expenses');
}

/**
 * Process agent commission fee on signing (permanent purchase).
 */
export function processAgentFeeOnSigning(state, player, fee, agentCommPct) {
  const commPct = agentCommPct || 8; // 6-12% range
  const agentFee = Math.round(fee * (commPct / 100));

  addTransaction(state, -agentFee, 'transfer_out', `Agent commission fee for signing ${player.name} (${commPct}%)`);
  logger.info('finance', 'processed agent fee on signing', { player: player.name, agentFee });
}

/**
 * Register transfer amortization schedule on player purchase.
 */
export function registerAmortization(state, player, fee, contractLength) {
  initFinanceState(state);
  state.finance.amortizations.push({
    playerId: player.id,
    playerName: player.name,
    purchaseFee: fee,
    contractLength: contractLength || 5,
    yearsRemaining: contractLength || 5
  });
  logger.info('finance', 'registered player fee amortization', { player: player.name, fee, contractLength });
}

/**
 * Process yearly player fee amortization at season end (May 31st).
 * Sum of amortizations is booked as an expense on the books.
 */
export function processYearlyAmortization(state) {
  initFinanceState(state);
  let totalAmortizationExpense = 0;

  for (const am of state.finance.amortizations) {
    if (am.yearsRemaining > 0) {
      const yearlyAm = Math.round(am.purchaseFee / am.contractLength);
      totalAmortizationExpense += yearlyAm;
      am.yearsRemaining--;
    }
  }

  if (totalAmortizationExpense > 0) {
    // We book amortization as an operating expense (write-down) to the summary books
    const fsum = state.finance.summary;
    fsum.exp.Facilities = (fsum.exp.Facilities || 0) + totalAmortizationExpense / 1e6;
    logger.info('finance', 'booked yearly amortization expense', { totalAmortizationExpense });
  }
}

/**
 * Write off unamortized book value on player sale and calculate book profit/loss.
 * If sold for more than unamortized value, club registers a "profit" on disposal.
 * If sold for less, club registers a "loss" on disposal.
 */
export function writeOffAmortizationOnSale(state, player, saleFee) {
  initFinanceState(state);
  const amIdx = state.finance.amortizations.findIndex(a => a.playerId === player.id);

  let unamortizedValue = 0;
  if (amIdx !== -1) {
    const am = state.finance.amortizations[amIdx];
    unamortizedValue = Math.round(am.purchaseFee * (am.yearsRemaining / am.contractLength));
    // Remove from active amortizations
    state.finance.amortizations.splice(amIdx, 1);
  }

  const bookPnL = saleFee - unamortizedValue;
  const isLoss = bookPnL < 0;

  logger.info('finance', 'processed player amortization write-off on sale', {
    player: player.name,
    saleFee,
    unamortizedValue,
    bookPnL
  });

  return {
    unamortizedValue,
    bookPnL,
    isLoss
  };
}

/**
 * Monthly FFP Audit and Sanctioning check.
 * Called on Day 28 of each month.
 */
export function runFFPAudit(state) {
  initFinanceState(state);

  // 1. Calculate annualized wages: weekly wages * 52
  const weeklyWages = calculateWeeklyWages(state);
  const annualizedWages = weeklyWages * 52;

  // 2. Calculate annualized revenue: sum of current season income summary * 1e6
  const fsum = state.finance.summary;
  let totalRevenue = 0;
  for (const k of Object.keys(fsum.inc)) {
    totalRevenue += fsum.inc[k] * 1e6;
  }
  // Safe division floor
  totalRevenue = Math.max(1e6, totalRevenue);

  // 3. Compute wage-to-revenue ratio dynamically based on active annual projected revenue
  let projectedRevenue = totalRevenue * 2.25;
  if (totalRevenue > 15e6) {
    projectedRevenue = Math.max(54e6, projectedRevenue);
  }
  const wageRatio = Math.round((annualizedWages / projectedRevenue) * 100);
  fsum.wageRatio = wageRatio;

  // 4. Clear/Reset FFP sanctions by default
  state.finance.transferBudgetFrozen = false;
  state.finance.squadLimitReduced = false;
  state.finance.transferBanActive = false;
  fsum.ffp = 'Compliant';

  let statusText = 'COMPLIANT';
  let severity = 'lo';
  let sanctionText = 'None. Your wage bill remains fully compliant with UEFA Financial Fair Play regulations.';

  // 5. Apply sanction tiers if wage ratio crossed 70%
  if (wageRatio > 70) {
    if (wageRatio <= 80) {
      // Level 1: board warning, transfer budget frozen
      state.finance.transferBudgetFrozen = true;
      fsum.ffp = 'Level 1 Warning';
      statusText = 'WARNING (LEVEL 1)';
      severity = 'md';
      sanctionText = 'TRANSFER BUDGET FROZEN. The board has frozen all transfer funds until the wage ratio returns under 70%.';
    } else if (wageRatio <= 90) {
      // Level 2: £1M fine, frozen budget, squad registration limit reduced to 21 players
      state.finance.transferBudgetFrozen = true;
      state.finance.squadLimitReduced = true; // enforced in squads validation
      fsum.ffp = 'Level 2 Breach';
      statusText = 'BREACH (LEVEL 2)';
      severity = 'hi';
      sanctionText = 'TRANSFER BUDGET FROZEN + SQUAD REGISTRATION LIMIT REDUCED (Max: 21 players) + £1.0M FINE. Severe financial overreach detected.';

      // Deduct FFP Level 2 fine
      addTransaction(state, -1000000, 'operating', 'FFP Level 2 Violation Sanction Fine');
    } else {
      // Level 3: £3M fine, transfer ban, frozen budget, reduced squad limit
      state.finance.transferBudgetFrozen = true;
      state.finance.squadLimitReduced = true;
      state.finance.transferBanActive = true;
      fsum.ffp = 'Level 3 Violation';
      statusText = 'CRITICAL BREACH (LEVEL 3)';
      severity = 'hi';
      sanctionText = 'TRANSFER BAN IMPOSED + TRANSFER BUDGET FROZEN + SQUAD REGISTRATION LIMIT REDUCED + £3.0M FINE. Extreme financial danger. Clear players off the books immediately.';

      // Deduct FFP Level 3 fine
      addTransaction(state, -3000000, 'operating', 'FFP Level 3 Critical Violation Fine');
    }
  }

  // 6. Send compliance report to inbox
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: 'msg_ffp_' + Date.now(),
    severity,
    sender: 'Compliance Officer · FFP Regulatory Committee',
    subject: `Monthly FFP Compliance Audit: ${statusText}`,
    body: `We have completed our monthly financial compliance audit.
Projected Annualized Wages: £${(annualizedWages/1e6).toFixed(2)}M.
Projected Annualized Revenue: £${(projectedRevenue/1e6).toFixed(2)}M.
Current wage-to-revenue ratio: ${wageRatio}% (UEFA Cap Ceiling: 70%).

Sanctions applied: ${sanctionText}`,
    choices: [],
    done: true
  });

  // 7. Check rolling 3-year transfer balance limit ( deficit limit )
  // If current season deficit is over £25M, log owner warning
  const transferBalanceDeficit = (fsum.exp.Transfers - fsum.inc.Transfers) * 1e6;
  if (transferBalanceDeficit > 25e6) {
    state.inbox.unshift({
      id: 'msg_deficit_' + Date.now(),
      severity: 'md',
      sender: 'Boardroom · Owner Directive',
      subject: 'Critical 3-Year Transfer Deficit Warning',
      body: `Our transfer deficit this season has hit £${(transferBalanceDeficit/1e6).toFixed(1)}M, pushing us close to our rolling owner-approved multi-window deficit limit. You must generate player sale profits before requesting more transfer spending.`,
      choices: [],
      done: true
    });
  }

  logger.info('finance', 'completed monthly FFP compliance check', { wageRatio, statusText });
}

/**
 * Propose stadium expansion capital project (North Stand adding 6,000 seats).
 * Costs £45M, increases debt by £40M at 5% interest, takes 18 months (540 days),
 * and reduces capacity by 15% during construction.
 */
export function triggerStadiumExpansion(state) {
  initFinanceState(state);

  if (state.stadium.expansionDaysLeft !== null) {
    logger.warn('finance', 'stadium expansion already in progress');
    return false;
  }

  const expansionCost = 45000000;
  const debtAddition = 40000000;

  // Charge expansion cost
  addTransaction(state, -expansionCost, 'operating', 'North Stand stadium expansion capital expenditure');

  // Finance via debt
  state.finance.summary.debt += debtAddition;
  state.finance.summary.rate = '5.0%'; // Increase interest rate to 5% with stadium loan

  // Set construction timeline
  state.stadium.expansionDaysLeft = 540; // 18 months

  // Board confirmation message
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: 'msg_stadium_expand_' + Date.now(),
    severity: 'md',
    sender: 'Boardroom · Capital Projects',
    subject: 'Stadium Expansion Approved: North Stand Construction Begins',
    body: `The board has approved the North Stand stadium expansion project.
Total Capital Cost: £45.0M.
Financing: £40.0M added to outstanding club debt (Interest rate raised to 5.0%).
Timeline: 18 Months (540 Days).
Operational Impact: Capacity reduced by 15% during construction to ensure safety. On completion, capacity will increase by 6,000 general admission seats!`,
    choices: [],
    done: true
  });

  logger.info('finance', 'triggered stadium expansion project', { expansionCost, debtAddition });
  return true;
}

/**
 * Execute daily finance tick (called inside tick.js advancement).
 * Handles daily merchandise, weekly wage runs, monthly expense cycles, kit releases, and May settlements.
 */
export function tickDailyFinance(state, prng) {
  initFinanceState(state);

  // 1. Accrue daily merchandise sales
  accrueDailyMerchandise(state);

  // 2. Process stadium expansion construction progress
  if (state.stadium.expansionDaysLeft !== null && state.stadium.expansionDaysLeft > 0) {
    state.stadium.expansionDaysLeft--;
    if (state.stadium.expansionDaysLeft === 0) {
      state.stadium.expansionDaysLeft = null;
      state.stadium.cap += 6000; // Capacity increased by 6,000 seats!

      state.inbox = state.inbox || [];
      state.inbox.unshift({
        id: 'msg_expand_complete_' + Date.now(),
        severity: 'gr',
        sender: 'Stadium Operations',
        subject: 'North Stand Expansion Complete!',
        body: `Construction has finished successfully. The new North Stand is officially open, raising our total stadium capacity to ${state.stadium.cap.toLocaleString()} seats! Expect immediate matchday revenue growth in upcoming home fixtures.`,
        choices: [],
        done: true
      });
      logger.info('finance', 'stadium expansion construction complete!', { newCapacity: state.stadium.cap });
    }
  }

  // 3. Sunday/Weekly Wage Run
  if (state.clock.dayNumber % 7 === 0) {
    processWeeklyWageRun(state);
  }

  // 4. Month-end (Day 28) check: pay operating upkeeps, debt interest, FFP audit, and check cash flow
  const currentDate = new Date(state.clock.date);
  const dayOfMonth = currentDate.getDate();
  if (dayOfMonth === 28) {
    processSponsorsAndBroadcastingMonthly(state);
    processMonthlyExpenses(state);
    runFFPAudit(state);

    // Crisis Exhaustion & Recovery Scenarios Audit
    if (state.finance.balance < 0) {
      state.finance.consecutiveNegativeMonths++;
      if (state.finance.consecutiveNegativeMonths >= 3 && !state.finance.crisisModeActive) {
        // Trigger Crisis Mode
        state.finance.crisisModeActive = true;
        state.finance.transferBanActive = true; // freeze buying/registering
        state.finance.transferBudget = 0; // lock budget
        state.board.confidence.Finance = Math.max(0, state.board.confidence.Finance - 30);

        state.inbox = state.inbox || [];
        state.inbox.unshift({
          id: 'msg_crisis_trigger_' + Date.now(),
          severity: 'hi',
          sender: 'Boardroom · FINANCIAL ULTIMATUM',
          subject: 'CRITICAL: Club Placed Into Financial Crisis Recovery Mode',
          body: `WARNING: Citing three consecutive months of exhausted cash reserves and negative balance sheets, the board has officially taken control of club finances.
Crisis Recovery Measures Imposed immediately:
- Full transfer ban and freeze of all transfer budgets.
- All facility upkeeps and capital upgrades suspended.
- Forced sell-to-survive policy in upcoming windows.
We must return to a positive cash balance to restore normal manager operations.`,
          choices: [],
          done: true
        });
        logger.warn('finance', 'club placed into Crisis Recovery Mode due to cash exhaustion');
      }
    } else {
      // Cash is healthy (>= 0)
      if (state.finance.crisisModeActive) {
        // Recover from Crisis Mode
        state.finance.crisisModeActive = false;
        state.finance.transferBanActive = false;
        state.finance.transferBudget = 10e6; // give small recovery budget
        state.finance.consecutiveNegativeMonths = 0;

        state.inbox = state.inbox || [];
        state.inbox.unshift({
          id: 'msg_crisis_recovered_' + Date.now(),
          severity: 'gr',
          sender: 'Boardroom · Recovery Complete',
          subject: 'Board Advisory: Financial Crisis Mode Lifted',
          body: `Congratulations. Thanks to prudent cash management, our balance has returned to positive territory. The board has lifted crisis recovery measures, unlocked the transfer budget, and deactivated the transfer ban. Normal club operations are restored.`,
          choices: [],
          done: true
        });
        logger.info('finance', 'club recovered from Crisis Recovery Mode');
      }
      state.finance.consecutiveNegativeMonths = 0;
    }
  }

  // 5. May 31st (Season End) Merit Payouts and Amortization books
  const month = currentDate.getMonth(); // 0-indexed, 4 = May
  if (month === 4 && dayOfMonth === 31) {
    settleMayMeritPayments(state);
    processYearlySponsorRenewals(state, prng);
    processYearlyAmortization(state);
  }

  // 6. July 1st Kit Release Revenue Pulse
  if (month === 6 && dayOfMonth === 1) { // 6 = July
    triggerAnnualKitRelease(state);
  }
}
