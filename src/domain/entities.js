// domain/entities.js
// Shape factories for all game entities. Each entity gets a stable UUID
// (never an array index). These factories are the ONLY sanctioned way to
// create entities that go into GameState.

let _seq = 0;
function uuid(prefix = 'id') {
  _seq = (_seq + 1) | 0;
  const r = Math.floor(Math.random() * 0xffffff);
  const t = Date.now().toString(36).slice(-4);
  return `${prefix}_${t}${(_seq).toString(36)}${r.toString(36)}`;
}
export const resetUuidSeq = () => { _seq = 0; };
export const makeUuid = uuid;

// -------- Position helpers (mirror legacy GRP/PCOL) --------
export const POSITION_GROUPS = {
  GK:  'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM:'MID', CM: 'MID', CAM:'MID', LM: 'MID', RM: 'MID',
  LW: 'FWD', RW:'FWD', ST: 'FWD', CF:'FWD'
};
export const groupOf = (pos) => POSITION_GROUPS[pos] || 'FWD';
export const groupColor = (g) => ({ GK:'var(--gk)', DEF:'var(--def)', MID:'var(--mid)', FWD:'var(--fwd)' }[g]);

// ---------------- Player ----------------
export function makePlayer(partial = {}) {
  return {
    id: partial.id || uuid('pl'),
    kind: 'player',
    name: partial.name || 'Unknown',
    pos:  partial.pos  || 'CM',
    grp:  groupOf(partial.pos || 'CM'),
    age:  partial.age  ?? 22,
    nat:  partial.nat  || 'ENG',
    // Profile
    ovr:  partial.ovr  ?? 60,
    pot:  partial.pot  ?? partial.ovr ?? 60,
    form: partial.form ?? 6.0,
    // Attributes (lazily generated in UI from seed — see ui panels). Stored as
    // a six-category summary plus a seed for detailed generation.
    atts: partial.atts || {
      pace: 60, shooting: 60, passing: 60, dribbling: 60, defending: 60, physical: 60
    },
    attrSeed: partial.attrSeed || Math.floor(Math.random() * 1e9),
    // Status
    fit:  partial.fit  ?? 100,    // fitness 0..100
    mor:  partial.mor  ?? 70,     // morale 0..100
    inj:  partial.inj  ?? null,   // {type, daysLeft} or null
    susp: partial.susp ?? 0,      // matches suspended
    cards: partial.cards ?? { y: 0, r: 0 },  // yellows accumulated this season
    hidden: partial.hidden || { injuryProneness: 0.5, pressureComposure: 0.5, weakFoot: 0.5 },
    // Contract
    wage: partial.wage ?? 5000,
    contractUntil: partial.contractUntil ?? 2028,
    clause: partial.clause ?? null,
    // Squad bookkeeping
    hg: partial.hg ?? false,    // home-grown
    registered: partial.registered ?? true,
    onLoan: partial.onLoan ?? false,
    // Match state (transient — not persisted; reset each match)
    match: null,
    // Form history (last 10 ratings)
    formHist: partial.formHist ?? [],
    // Career stats (this season)
    stats: partial.stats || { apps: 0, goals: 0, assists: 0, cs: 0, motm: 0, mins: 0 }
  };
}

// ---------------- Club ----------------
export function makeClub(partial = {}) {
  return {
    id: partial.id || uuid('cl'),
    kind: 'club',
    code: partial.code || 'XXX',
    name: partial.name || 'Unknown FC',
    c1:   partial.c1   || '#222',
    c2:   partial.c2   || '#888',
    city: partial.city || 'ENG',
    managerName: partial.managerName || 'Manager',
    managerId:   partial.managerId   || null,
    // Sporting
    rep: partial.rep ?? 3,
    atk: partial.atk ?? 70,
    def: partial.def ?? 70,
    // Finance
    budget: partial.budget ?? 10e6,
    wageCeiling: partial.wageCeiling ?? 1e6,
    balance: partial.balance ?? 5e6,
    // Stadium
    stadium: partial.stadium || 'Ground',
    capacity: partial.capacity ?? 30000,
    ticketPrice: partial.ticketPrice ?? 28,
    // Persistent tactical identity (drives AI manager in matches)
    tactics: partial.tactics || {
      formation: '4-4-2',
      mentality: 'balanced',     // defensive / cautious / balanced / attacking / all-out
      tempo: 'normal',           // slow / normal / fast
      width: 'normal',           // narrow / normal / wide
      pressing: 'mid',           // low / mid / high
      lineHeight: 'mid',         // deep / mid / high
      // Manager personality: drives in-match AI decisions
      personality: 'balanced',   // cautious / balanced / aggressive / counter / possession
      // Set-piece & transition biases 0..1
      setPieceBias: 0.5,
      counterBias: 0.5
    },
    // Form (last 5 results, e.g. ['W','D','L'])
    form: partial.form || [],
    // Squad IDs (player ids). Source of truth — table is recomputed.
    squadIds: partial.squadIds || [],
    // Honours / trophies
    trophies: partial.trophies || [],
    // Facilities (linked via facilities entities)
    facilityIds: partial.facilityIds || []
  };
}

// ---------------- Staff (manager / scouts / coaches) ----------------
export function makeStaff(partial = {}) {
  return {
    id: partial.id || uuid('st'),
    kind: 'staff',
    name: partial.name || 'Staff',
    role: partial.role || 'coach',     // manager / assistant / scout / coach / physio
    clubId: partial.clubId || null,
    age: partial.age ?? 40,
    nat: partial.nat ?? 'ENG',
    rating: partial.rating ?? 60,       // attribute relevant to role
    contractUntil: partial.contractUntil ?? 2028,
    wage: partial.wage ?? 8000,
    // Scout-only
    assignment: partial.assignment || null  // {targetRegion, daysLeft}
  };
}

// ---------------- Agent ----------------
export function makeAgent(partial = {}) {
  return {
    id: partial.id || uuid('ag'),
    kind: 'agent',
    name: partial.name || 'Agent',
    clientIds: partial.clientIds || [],
    relationship: partial.relationship ?? 50  // 0..100 warmth toward user club
  };
}

// ---------------- Facility ----------------
export function makeFacility(partial = {}) {
  return {
    id: partial.id || uuid('fa'),
    kind: 'facility',
    clubId: partial.clubId || null,
    type: partial.type || 'training',   // training / medical / youth / stadium
    level: partial.level ?? 1,
    upgradeUntil: partial.upgradeUntil ?? null
  };
}

// ---------------- Sponsor ----------------
export function makeSponsor(partial = {}) {
  return {
    id: partial.id || uuid('sp'),
    kind: 'sponsor',
    name: partial.name || 'Sponsor',
    type: partial.type || 'shirt',      // shirt / stadium / training-kit
    annual: partial.annual ?? 2e6,
    startedAt: partial.startedAt ?? null,
    expiresAt: partial.expiresAt ?? null
  };
}

// ---------------- Contract ----------------
export function makeContract(partial = {}) {
  return {
    id: partial.id || uuid('ct'),
    kind: 'contract',
    playerId: partial.playerId,
    clubId:   partial.clubId,
    wage: partial.wage ?? 5000,
    signingBonus: partial.signingBonus ?? 0,
    startedAt: partial.startedAt ?? null,
    expiresAt: partial.expiresAt ?? 2028,
    clauses: partial.clauses || { release: null, promotion: null, relegation: null }
  };
}

// ---------------- Fixture ----------------
export function makeFixture(partial = {}) {
  return {
    id: partial.id || uuid('fx'),
    kind: 'fixture',
    date: partial.date,                   // ISO date string
    homeId: partial.homeId,
    awayId: partial.awayId,
    competition: partial.competition || 'league',  // league / cup-fa / cup-league / super
    matchweek: partial.matchweek ?? null,
    status: partial.status || 'scheduled',          // scheduled / live / played / postponed
    result: partial.result ?? null,                 // {hs, as, hXG, aXG, events, report} once played
    isDerby: partial.isDerby ?? false,
    tvSlot: partial.tvSlot || null                  // FRI / SUN / null
  };
}

// ---------------- League Row (recomputable cache) ----------------
export function emptyLeagueRow(clubId) {
  return {
    clubId,
    P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0,
    form: []  // last 5: 'W' 'D' 'L'
  };
}

// ---------------- Message (inbox) ----------------
export function makeMessage(partial = {}) {
  return {
    id: partial.id || uuid('msg'),
    kind: 'message',
    severity: partial.severity || 'lo',     // lo / md / hi
    sender: partial.sender || 'Staff',
    subject: partial.subject || '',
    body: partial.body || '',
    receivedAt: partial.receivedAt ?? null,
    choices: partial.choices || [],         // [{label, action}]  action fed to dispatch
    done: partial.done ?? false,
    opened: partial.opened ?? false
  };
}

// ---------------- Transaction ----------------
export function makeTransaction(partial = {}) {
  return {
    id: partial.id || uuid('tx'),
    kind: 'transaction',
    date: partial.date,
    amount: partial.amount,            // +credit / -debit
    category: partial.category,        // wages / transfer / ticket / prize / sponsor / facility
    note: partial.note || ''
  };
}
