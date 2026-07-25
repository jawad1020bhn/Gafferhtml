// sim/transfers/free-agents.js
// Free agent market. Unattached players available year-round, outside the
// window too. Quality skews old (30+ veterans) or unproven (released youth).

import { clamp } from '../../core/prng.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Generate a free-agent pool. Called at game start.
 * Mix of aging veterans and released youth.
 */
export function generateFreeAgentPool(state, prng) {
  const pool = [];
  const firstNames = ['Marco','Luca','Diego','Andrei','Yuki','Sam','Tomas','Bjorn','Kwame','Ravi'];
  const lastNames = ['Silva','Romano','Costa','Petrov','Tanaka','Adeyemi','Lindgren','Okafor','Larsen','Mendes'];
  const positions = ['GK','CB','LB','RB','CDM','CM','CAM','LW','RW','ST'];

  for (let i = 0; i < 30; i++) {
    const age = prng.next() < 0.6 ? prng.int(31, 36) : prng.int(18, 22);
    const ovr = age >= 31 ? prng.int(68, 80) : prng.int(55, 70);
    const pos = prng.pick(positions);
    const name = prng.pick(firstNames) + ' ' + prng.pick(lastNames);

    pool.push({
      id: 'fa_' + i + '_' + Math.floor(prng.next() * 1e6),
      kind: 'free_agent',
      name,
      pos,
      grp: posGroup(pos),
      age,
      nat: 'ENG',
      ovr,
      pot: ovr + (age <= 21 ? prng.int(5, 15) : 0),
      form: 6.5,
      fit: 80,
      mor: 60,
      wage: Math.round(ovr * 800),
      val: 0,   // no transfer fee — value is in the wage
      signingOnBonus: Math.round(ovr * 20000),
      contractUntil: (state.clock.seasonYear || 2026) + (age >= 31 ? 2 : 3),
      hidden: {
        professionalism: prng.int(50, 90),
        ambition: prng.int(40, 80),
        determination: prng.int(50, 80),
        injuryProneness: age >= 32 ? prng.int(40, 70) : prng.int(20, 50)
      },
      status: 'available'
    });
  }
  return pool;
}

function posGroup(pos) {
  if (pos === 'GK') return 'GK';
  if (['CB','LB','RB','LWB','RWB'].includes(pos)) return 'DEF';
  if (['CDM','CM','CAM','LM','RM'].includes(pos)) return 'MID';
  return 'FWD';
}

/**
 * Sign a free agent. No transfer fee, but signing-on bonus + wages.
 * Available year-round (outside windows too).
 */
export function signFreeAgent(state, fa, club, wageOffer, opts = {}) {
  const prng = opts.prng || { next: () => 0.5 };
  // Acceptance: wage × signing bonus × club reputation
  let p = 0.5;
  if (wageOffer > fa.wage * 1.2) p += 0.25;
  if (wageOffer > fa.wage * 1.5) p += 0.15;
  if (club.rep >= 4) p += 0.15;
  if (wageOffer < fa.wage * 0.9) p -= 0.20;
  p = clamp(p, 0.05, 0.95);

  if (prng.next() > p) {
    return { accepted: false, reason: 'wage_too_low' };
  }

  // Execute
  const player = {
    ...fa,
    id: 'pl_' + Date.now() + '_' + Math.floor(prng.next() * 1e4),
    kind: 'player',
    wage: wageOffer,
    onLoan: false,
    hg: false,
    registered: true,
    match: null,
    formHist: [],
    stats: { apps: 0, goals: 0, assists: 0, cs: 0, motm: 0, mins: 0 }
  };
  delete player.signingOnBonus;
  delete player.status;
  state.entities.players.set(player.id, player);
  club.squadIds = club.squadIds || [];
  club.squadIds.push(player.id);

  // Signing-on bonus deduction
  if (club.id === state.meta.userClubId) {
    state.finance.balance -= fa.signingOnBonus || 0;
    state.finance.transactions = state.finance.transactions || [];
    state.finance.transactions.push({
      id: 'tx_' + Date.now(),
      date: state.clock.date,
      amount: -(fa.signingOnBonus || 0),
      category: 'transfer',
      note: `Signed ${player.name} (free agent, signing-on bonus)`
    });
  }
  return { accepted: true, player };
}
