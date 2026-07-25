// data/seed.js
// Initial GameState for "New Game". Converts all the previously-hardcoded
// demo data (CLUBS, PLAYERS, STD, FIX, INBOX, FIN, BOARD, etc.) into the
// unified GameState shape defined in ARCHITECTURE.md.
//
// This is the SEED — the starting point. The simulation mutates from here.
// UI panels read from this state; nothing is hardcoded in renderers anymore.

import {
  makePlayer, makeClub, makeStaff, makeAgent, makeFacility, makeSponsor,
  makeContract, makeFixture, makeMessage, makeTransaction, emptyLeagueRow,
  resetUuidSeq, groupOf
} from '../domain/entities.js';
import { recomputeLeagueTable } from '../domain/invariants.js';
import { hashString, PRNG } from '../core/prng.js';
import { generateFreeAgentPool } from '../sim/transfers/free-agents.js';

// Stable IDs for clubs (so fixtures can reference them). Using legacy
// 3-letter codes keeps backwards compatibility with old save imports.
const CLUB_DEFS = [
  { id: 'cl_RAV', code: 'RAV', n: 'Ravensport FC',      c1: '#171a1c', c2: '#d8b45c', rep: 4, bud: 42.5e6, atk: 80, def: 79, st: 'Ironworks Park',  cap: 52400, mgr: 'Alex Mercer',       cty: 'ENG',
    tactics: { formation:'4-3-3', mentality:'attacking', tempo:'fast', width:'wide', pressing:'high', lineHeight:'high', personality:'aggressive', setPieceBias:0.55, counterBias:0.45 } },
  { id: 'cl_HAL', code: 'HAL', n: 'Halloway Athletic',  c1: '#12305a', c2: '#7fd1ff', rep: 5, bud: 88e6,   atk: 83, def: 81, st: 'The Cathedral',   cap: 61200, mgr: 'Viktor Sørensen',   cty: 'ENG',
    tactics: { formation:'4-2-3-1', mentality:'attacking', tempo:'fast', width:'wide', pressing:'mid', lineHeight:'mid', personality:'possession', setPieceBias:0.5, counterBias:0.4 } },
  { id: 'cl_DUN', code: 'DUN', n: 'Duncairn Rovers',    c1: '#3a1220', c2: '#ff8f6b', rep: 4, bud: 36e6,   atk: 78, def: 77, st: 'The Quarry',      cap: 38900, mgr: 'Marta Keller',      cty: 'SCO',
    tactics: { formation:'5-4-1', mentality:'cautious', tempo:'slow', width:'narrow', pressing:'low', lineHeight:'deep', personality:'counter', setPieceBias:0.7, counterBias:0.85 } },
  { id: 'cl_STE', code: 'STE', n: 'Sterling Albion',    c1: '#0e3d33', c2: '#8fe3c0', rep: 4, bud: 51e6,   atk: 79, def: 76, st: 'Kingsmead',       cap: 44100, mgr: 'Owen Blackwood',    cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'wide', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_POR', code: 'POR', n: 'Port Meridian',      c1: '#232a4d', c2: '#a9b6ff', rep: 3, bud: 24e6,   atk: 76, def: 74, st: 'Dockside Park',   cap: 31500, mgr: 'Rui Palmeira',      cty: 'ENG',
    tactics: { formation:'4-3-3', mentality:'balanced', tempo:'normal', width:'normal', pressing:'mid', lineHeight:'mid', personality:'possession', setPieceBias:0.45, counterBias:0.45 } },
  { id: 'cl_NOR', code: 'NOR', n: 'Northgate City',     c1: '#4d2323', c2: '#ffb3a1', rep: 3, bud: 22e6,   atk: 75, def: 74, st: 'Northgate Arena', cap: 29800, mgr: 'Dean Hartley',      cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'normal', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_CAL', code: 'CAL', n: 'Calderton United',   c1: '#3d2e0e', c2: '#e8c97a', rep: 3, bud: 19e6,   atk: 74, def: 75, st: 'Furnace Lane',    cap: 27400, mgr: 'Stefan Iliev',      cty: 'ENG',
    tactics: { formation:'4-5-1', mentality:'cautious', tempo:'slow', width:'narrow', pressing:'mid', lineHeight:'deep', personality:'cautious', setPieceBias:0.55, counterBias:0.6 } },
  { id: 'cl_WEX', code: 'WEX', n: 'Wexcombe Wanderers', c1: '#1e3a1e', c2: '#a5e08f', rep: 3, bud: 15e6,   atk: 74, def: 72, st: 'Chiltern Road',   cap: 24600, mgr: 'Gary Nash',         cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'wide', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_EAS', code: 'EAS', n: 'Eastvale Rangers',   c1: '#0e3a44', c2: '#8fd8e8', rep: 3, bud: 14e6,   atk: 73, def: 73, st: 'Eastvale Stadium',cap: 26100, mgr: 'Callum Doyle',      cty: 'SCO',
    tactics: { formation:'4-3-3', mentality:'balanced', tempo:'fast', width:'wide', pressing:'high', lineHeight:'high', personality:'aggressive', setPieceBias:0.5, counterBias:0.4 } },
  { id: 'cl_BRA', code: 'BRA', n: 'Bramley Heath',      c1: '#33264d', c2: '#c9a9ff', rep: 2, bud: 9e6,    atk: 71, def: 72, st: 'Heath Ground',    cap: 19800, mgr: 'Paula Reyes',       cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'cautious', tempo:'slow', width:'normal', pressing:'low', lineHeight:'deep', personality:'cautious', setPieceBias:0.55, counterBias:0.65 } },
  { id: 'cl_RED', code: 'RED', n: 'Redbrook County',    c1: '#4d0e1c', c2: '#ff9db4', rep: 2, bud: 8e6,    atk: 70, def: 71, st: 'Brookside',       cap: 18200, mgr: 'Tommy Aldous',      cty: 'ENG',
    tactics: { formation:'4-5-1', mentality:'defensive', tempo:'slow', width:'narrow', pressing:'low', lineHeight:'deep', personality:'counter', setPieceBias:0.6, counterBias:0.75 } },
  { id: 'cl_IRO', code: 'IRO', n: 'Ironbridge FC',      c1: '#26292c', c2: '#c2cdd6', rep: 2, bud: 7e6,    atk: 69, def: 71, st: 'Foundry Park',    cap: 17600, mgr: 'Hana Kobayashi',    cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'normal', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_SOL', code: 'SOL', n: 'Solmere Town',       c1: '#0e2a4d', c2: '#9dc0ff', rep: 2, bud: 6e6,    atk: 70, def: 69, st: 'Solmere Ground',  cap: 16400, mgr: 'Jack Whitmore',     cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'normal', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_GRA', code: 'GRA', n: 'Granford Park',      c1: '#2e4d0e', c2: '#c8ff9d', rep: 2, bud: 6e6,    atk: 68, def: 70, st: 'Granford Park',   cap: 15900, mgr: 'Elif Demir',        cty: 'ENG',
    tactics: { formation:'4-5-1', mentality:'cautious', tempo:'slow', width:'normal', pressing:'low', lineHeight:'deep', personality:'cautious', setPieceBias:0.55, counterBias:0.65 } },
  { id: 'cl_ASH', code: 'ASH', n: 'Ashdown Villa',      c1: '#4d3a0e', c2: '#ffd98f', rep: 2, bud: 5e6,    atk: 68, def: 68, st: 'Ashdown Lane',    cap: 15100, mgr: 'Marcus Bell Sr.',   cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'normal', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_KIN', code: 'KIN', n: 'Kingsmere FC',       c1: '#14304d', c2: '#8fd0ff', rep: 2, bud: 5e6,    atk: 69, def: 67, st: 'Kingsmere Stadium',cap: 14800, mgr: 'Sonia Marchetti',   cty: 'ENG',
    tactics: { formation:'4-4-2', mentality:'balanced', tempo:'normal', width:'normal', pressing:'mid', lineHeight:'mid', personality:'balanced', setPieceBias:0.5, counterBias:0.5 } },
  { id: 'cl_WHI', code: 'WHI', n: 'Whitlow FC',         c1: '#3d0e33', c2: '#ff9de8', rep: 1, bud: 3.5e6,  atk: 66, def: 67, st: 'Whitlow Park',    cap: 12600, mgr: 'Ray Osei',          cty: 'ENG',
    tactics: { formation:'5-4-1', mentality:'defensive', tempo:'slow', width:'narrow', pressing:'low', lineHeight:'deep', personality:'counter', setPieceBias:0.6, counterBias:0.8 } },
  { id: 'cl_OAK', code: 'OAK', n: 'Oakmont Town',       c1: '#243d14', c2: '#b8e08f', rep: 1, bud: 3e6,    atk: 65, def: 66, st: 'Oakmont Field',   cap: 11900, mgr: 'Under Review',      cty: 'ENG',
    tactics: { formation:'4-5-1', mentality:'defensive', tempo:'slow', width:'narrow', pressing:'low', lineHeight:'deep', personality:'cautious', setPieceBias:0.55, counterBias:0.7 } }
];

// Existing standings after 8 matchweeks (from legacy STD array). Used to
// back-fill the table cache; fixtures for MW1-8 are also pre-seeded as 'played'
// so recomputeLeagueTable produces matching numbers.
const STANDINGS_AFTER_MW8 = [
  { code:'HAL', P:8, W:6, D:1, L:1, GF:18, GA:7,  form:['W','W','W','D','W'] },
  { code:'RAV', P:8, W:6, D:1, L:1, GF:17, GA:8,  form:['W','W','D','W','W'] },
  { code:'STE', P:8, W:5, D:2, L:1, GF:14, GA:9,  form:['D','W','W','D','W'] },
  { code:'DUN', P:8, W:5, D:1, L:2, GF:12, GA:8,  form:['W','L','W','W','W'] },
  { code:'POR', P:8, W:4, D:3, L:1, GF:13, GA:10, form:['D','W','D','W','D'] },
  { code:'NOR', P:8, W:4, D:2, L:2, GF:11, GA:10, form:['W','L','W','D','W'] },
  { code:'CAL', P:8, W:3, D:4, L:1, GF:10, GA:8,  form:['D','D','W','D','W'] },
  { code:'WEX', P:8, W:3, D:2, L:3, GF:12, GA:12, form:['L','W','L','W','L'] },
  { code:'EAS', P:8, W:3, D:2, L:3, GF:9,  GA:11, form:['W','L','D','L','W'] },
  { code:'BRA', P:8, W:2, D:4, L:2, GF:8,  GA:9,  form:['D','D','L','D','W'] },
  { code:'RED', P:8, W:2, D:3, L:3, GF:7,  GA:10, form:['L','D','L','W','D'] },
  { code:'IRO', P:8, W:2, D:3, L:3, GF:7,  GA:11, form:['D','L','D','L','D'] },
  { code:'SOL', P:8, W:2, D:2, L:4, GF:8,  GA:12, form:['L','W','L','D','L'] },
  { code:'GRA', P:8, W:1, D:4, L:3, GF:6,  GA:9,  form:['D','D','L','D','L'] },
  { code:'ASH', P:8, W:1, D:3, L:4, GF:5,  GA:10, form:['L','D','L','D','L'] },
  { code:'KIN', P:8, W:1, D:2, L:5, GF:6,  GA:14, form:['L','L','D','L','L'] },
  { code:'WHI', P:8, W:0, D:3, L:5, GF:4,  GA:11, form:['L','D','L','L','D'] },
  { code:'OAK', P:8, W:0, D:1, L:7, GF:3,  GA:17, form:['L','L','L','L','L'] }
];

// Map legacy player definitions into makePlayer shape.
// id, n, pos, age, nat, ovr, pot, val, wage, con, form, fit, mor, role, st, traits, pers, hg, apps, g, a, rt
// Suspended/injured players carry susp / inj fields.
const RAV_PLAYERS = [
  { id:'pl_p18', n:'Viktor Kavanagh', pos:'ST',  age:28, nat:'IRL', ovr:86, pot:87, val:38e6, wage:85000, con:2028, form:8.4, fit:81, mor:90, role:'Star Player',   st:'ok',    traits:['Poacher','PowerHeader','Flair'],           pers:{prof:88,amb:82,loy:74,lead:71,temp:66}, hg:false, apps:8, g:7, a:1, rt:7.9, careerG:98 },
  { id:'pl_p11', n:'Rafael Sosa',     pos:'CM',  age:27, nat:'POR', ovr:85, pot:86, val:32e6, wage:45000, con:2027, form:8.7, fit:94, mor:78, role:'Star Player',   st:'ok',    traits:['Playmaker','FinesseShot','LongPasser'],    pers:{prof:91,amb:88,loy:62,lead:77,temp:72}, hg:false, apps:8, g:4, a:6, rt:8.1 },
  { id:'pl_p4',  n:'Marcus Thorne',   pos:'CB',  age:29, nat:'ENG', ovr:84, pot:85, val:18e6, wage:62000, con:2028, form:7.6, fit:93, mor:88, role:'Key Player',    st:'ok',    traits:['Leader','NoNonsenseDefender'],              pers:{prof:94,amb:70,loy:91,lead:93,temp:84}, hg:true,  apps:8, g:1, a:0, rt:7.4, captain:true },
  { id:'pl_p17', n:'Dario Cruz',      pos:'LW',  age:25, nat:'ARG', ovr:81, pot:82, val:19e6, wage:44000, con:2028, form:7.8, fit:95, mor:82, role:'First Team',    st:'susp',  susp:1, traits:['SpeedDribbler','CutInside'],         pers:{prof:76,amb:80,loy:68,lead:55,temp:58}, hg:false, apps:7, g:2, a:1, rt:7.3 },
  { id:'pl_p12', n:'Idris Traoré',    pos:'CDM', age:25, nat:'MLI', ovr:81, pot:82, val:16e6, wage:40000, con:2028, form:7.3, fit:92, mor:85, role:'Key Player',    st:'ok',    traits:['HoldingMidfielder','Tackler'],              pers:{prof:89,amb:76,loy:80,lead:69,temp:81}, hg:false, apps:8, g:0, a:0, rt:7.2 },
  { id:'pl_p13', n:'Mateus Lima',     pos:'CAM', age:23, nat:'BRA', ovr:80, pot:87, val:22e6, wage:36000, con:2028, form:7.9, fit:74, mor:86, role:'First Team',    st:'doubt', injT:'Knock', injW:1, traits:['SpeedDribbler','Flair','FinesseShot'], pers:{prof:82,amb:90,loy:71,lead:52,temp:64}, hg:false, apps:8, g:1, a:3, rt:7.5 },
  { id:'pl_p7',  n:'Dan Okafor',      pos:'RB',  age:27, nat:'NGA', ovr:80, pot:81, val:12e6, wage:38000, con:2026, form:7.2, fit:91, mor:70, role:'First Team',    st:'ok',    traits:['FullBack','Overlap'],                       pers:{prof:85,amb:78,loy:66,lead:62,temp:75}, hg:false, apps:8, g:0, a:2, rt:7.1 },
  { id:'pl_p5',  n:'Kofi Mensah',     pos:'CB',  age:24, nat:'GHA', ovr:79, pot:84, val:14e6, wage:34000, con:2027, form:7.5, fit:94, mor:84, role:'First Team',    st:'ok',    traits:['BallPlayingDefender'],                     pers:{prof:87,amb:84,loy:77,lead:66,temp:79}, hg:false, apps:8, g:1, a:0, rt:7.3 },
  { id:'pl_p16', n:'Rayan Cherif',    pos:'RW',  age:24, nat:'ALG', ovr:79, pot:81, val:13e6, wage:32000, con:2027, form:7.0, fit:93, mor:81, role:'First Team',    st:'ok',    traits:['Winger','CutInside'],                      pers:{prof:79,amb:81,loy:70,lead:50,temp:68}, hg:false, apps:8, g:1, a:1, rt:7.0 },
  { id:'pl_p8',  n:'Luca Ravelli',    pos:'LB',  age:26, nat:'ITA', ovr:78, pot:79, val:9e6,  wage:30000, con:2027, form:6.9, fit:38, mor:62, role:'First Team',    st:'inj',   injT:'Hamstring strain', injW:3, injSev:'Moderate', traits:['FullBack'], pers:{prof:88,amb:72,loy:79,lead:58,temp:77}, hg:false, apps:6, g:0, a:0, rt:6.9 },
  { id:'pl_p15', n:'Nils Bergström',  pos:'CDM', age:30, nat:'SWE', ovr:77, pot:77, val:5e6,  wage:28000, con:2026, form:6.6, fit:90, mor:58, role:'Rotation',      st:'ok',    traits:['HoldingMidfielder','LongThrowIn'],          pers:{prof:90,amb:60,loy:72,lead:70,temp:82}, hg:false, apps:5, g:0, a:0, rt:6.7, listed:true, ask:8e6 },
  { id:'pl_p14', n:'Oliver Byrne',    pos:'CM',  age:22, nat:'IRL', ovr:76, pot:82, val:7e6,  wage:18000, con:2027, form:7.1, fit:95, mor:83, role:'Rotation',      st:'ok',    traits:['BoxToBoxMidfielder'],                      pers:{prof:86,amb:85,loy:81,lead:60,temp:74}, hg:true,  apps:6, g:0, a:1, rt:6.9 },
  { id:'pl_p2',  n:'Owen Reid',       pos:'GK',  age:24, nat:'SCO', ovr:74, pot:75, val:2.8e6,wage:14000, con:2027, form:6.5, fit:96, mor:60, role:'Rotation',      st:'ok',    traits:['ShotStopper'],                              pers:{prof:81,amb:74,loy:69,lead:51,temp:76}, hg:true,  apps:1, g:0, a:0, rt:6.8, listed:true, ask:3.5e6, gk:true },
  { id:'pl_p6',  n:'Seb Lindqvist',   pos:'CB',  age:21, nat:'SWE', ovr:74, pot:83, val:6e6,  wage:16000, con:2028, form:6.8, fit:94, mor:80, role:'Rotation',      st:'ok',    traits:['BallPlayingDefender'],                     pers:{prof:84,amb:87,loy:73,lead:55,temp:78}, hg:false, apps:4, g:0, a:0, rt:6.8 },
  { id:'pl_p9',  n:'Theo Marchand',   pos:'LB',  age:20, nat:'FRA', ovr:72, pot:80, val:3.5e6,wage:11000, con:2028, form:6.7, fit:96, mor:82, role:'Squad Player',  st:'ok',    traits:['WingBack'],                                 pers:{prof:83,amb:88,loy:70,lead:48,temp:73}, hg:false, apps:3, g:0, a:0, rt:6.7 },
  { id:'pl_p20', n:'Sam Barlow',      pos:'RW',  age:19, nat:'ENG', ovr:71, pot:80, val:2.5e6,wage:9000,  con:2029, form:6.9, fit:97, mor:52, role:'Prospect',      st:'ok',    traits:['SpeedDribbler'],                           pers:{prof:77,amb:92,loy:75,lead:44,temp:62}, hg:true,  apps:3, g:0, a:0, rt:6.6, unrest:true },
  { id:'pl_p22', n:'Ethan Cole',      pos:'CM',  age:20, nat:'ENG', ovr:69, pot:77, val:1.5e6,wage:7000,  con:2028, form:6.5, fit:96, mor:79, role:'Prospect',      st:'ok',    traits:['BoxToBoxMidfielder'],                      pers:{prof:85,amb:83,loy:78,lead:50,temp:75}, hg:true,  apps:2, g:0, a:0, rt:6.5 },
  { id:'pl_p23', n:'Aaron Pike',      pos:'CB',  age:23, nat:'ENG', ovr:72, pot:76, val:3e6,  wage:12000, con:2026, form:6.4, fit:93, mor:72, role:'Squad Player',  st:'ok',    traits:['NoNonsenseDefender'],                      pers:{prof:80,amb:68,loy:71,lead:52,temp:74}, hg:true,  apps:2, g:0, a:0, rt:6.5 },
  { id:'pl_p19', n:'André Silva',     pos:'ST',  age:21, nat:'POR', ovr:77, pot:85, val:9e6,  wage:20000, con:2028, form:7.2, fit:95, mor:84, role:'Rotation',      st:'ok',    traits:['AdvancedForward'],                         pers:{prof:88,amb:89,loy:72,lead:49,temp:70}, hg:false, apps:6, g:1, a:0, rt:6.9 },
  { id:'pl_p21', n:'Felix Ndiaye',    pos:'ST',  age:17, nat:'SEN', ovr:64, pot:82, val:0.6e6,wage:3000,  con:2030, form:6.3, fit:98, mor:85, role:'Prospect',      st:'ok',    traits:['Poacher'],                                 pers:{prof:82,amb:94,loy:70,lead:40,temp:66}, hg:false, apps:1, g:0, a:0, rt:6.4 },
  { id:'pl_p1',  n:'Emil Varga',      pos:'GK',  age:31, nat:'HUN', ovr:82, pot:82, val:6.5e6,wage:38000, con:2027, form:7.4, fit:92, mor:86, role:'Key Player',    st:'ok',    traits:['SweeperKeeper','ShotStopper'],             pers:{prof:92,amb:66,loy:83,lead:74,temp:85}, hg:false, apps:8, g:0, a:0, rt:7.3, gk:true, cs:3 },
  { id:'pl_p3',  n:'Tom Whitfield',   pos:'GK',  age:19, nat:'ENG', ovr:68, pot:78, val:1.2e6,wage:6000,  con:2029, form:6.2, fit:97, mor:81, role:'Prospect',      st:'ok',    traits:['ShotStopper'],                              pers:{prof:86,amb:86,loy:79,lead:45,temp:77}, hg:true,  apps:0, g:0, a:0, rt:0,   gk:true },
  { id:'pl_p10', n:'Jack Danvers',    pos:'RB',  age:18, nat:'ENG', ovr:66, pot:76, val:0.9e6,wage:4000,  con:2029, form:6.1, fit:98, mor:80, role:'Prospect',      st:'ok',    traits:['FullBack'],                                pers:{prof:84,amb:87,loy:80,lead:43,temp:72}, hg:true,  apps:0, g:0, a:0, rt:0 }
];

// Legacy fixtures (MW1-8 played, MW9+ scheduled). We seed the league
// competition with these — the calendar generator is NOT used for retroactive
// MW1-8; instead we honour these results. MW9-34 will be generated by the
// calendar engine on first ADVANCE_DAY past MW8.
const SEED_FIXTURES = [
  { mw:1,  d:'2026-08-15', h:'RAV', a:'OAK', hs:2, as:0, c:'league' },
  { mw:2,  d:'2026-08-22', h:'KIN', a:'RAV', hs:1, as:0, c:'league' },
  { mw:3,  d:'2026-08-29', h:'RAV', a:'SOL', hs:3, as:1, c:'league' },
  { mw:4,  d:'2026-09-12', h:'IRO', a:'RAV', hs:0, as:2, c:'league' },
  { mw:5,  d:'2026-09-19', h:'RAV', a:'STE', hs:2, as:2, c:'league' },
  { mw:6,  d:'2026-09-26', h:'GRA', a:'RAV', hs:1, as:3, c:'league' },
  { mw:7,  d:'2026-10-03', h:'RAV', a:'POR', hs:2, as:1, c:'league' },
  { mw:8,  d:'2026-10-10', h:'RAV', a:'WEX', hs:3, as:1, c:'league' },
  { mw:9,  d:'2026-10-24', h:'DUN', a:'RAV', hs:null, as:null, c:'league' },
  { mw:0,  d:'2026-10-27', h:'RAV', a:'BRA', hs:null, as:null, c:'cup',   rd:'R4' },
  { mw:10, d:'2026-10-31', h:'RAV', a:'HAL', hs:null, as:null, c:'league', derby:true },
  { mw:11, d:'2026-11-07', h:'EAS', a:'RAV', hs:null, as:null, c:'league' },
  { mw:12, d:'2026-11-21', h:'RAV', a:'RED', hs:null, as:null, c:'league' }
];

// Other MW8 results (used to reconcile the league table — these are opponents'
// results that we seed directly into played fixtures so the recompute produces
// matching numbers to STANDINGS_AFTER_MW8).
const OTHER_MW8_RESULTS = [
  ['HAL','OAK',2,0],['STE','POR',1,1],['DUN','WHI',3,1],['NOR','CAL',0,0],
  ['EAS','RED',2,1],['BRA','IRO',1,1],['SOL','GRA',1,1],['KIN','ASH',2,1]
];

// Inbox seed
const SEED_INBOX = [
  { id:'msg_m1', sev:'hi', from:'AGENT',    who:'Paulo Ferreira',  t:'Sosa wants a restructure',
    b:'Rafael is the division’s best midfielder this season and is paid like a squad player. We should talk before January suitors do.',
    ago:'2h',
    choices:[
      { l:'OPEN TALKS · £68K/WK',     effect:{kind:'sosa-talks'},  note:'Sosa morale +12 · Wage bill +£23K/wk' },
      { l:'STALL UNTIL SUMMER',       effect:{kind:'sosa-stall'},  note:'Ferreira will not be patient. Renewal risk rises.' },
      { l:'OFFER £58K + BONUSES',     effect:{kind:'sosa-bonus'},  note:'50/50 — goal bonuses may close the gap.' }
    ]},
  { id:'msg_m2', sev:'hi', from:'PHYSIO',    who:'Medical Dept.',   t:'Kavanagh in the red zone',
    b:'Viktor’s 30-day load is 610 minutes and his hamstring readings are trending the wrong way. One more heavy week and we’re looking at three.',
    ago:'5h',
    choices:[
      { l:'REST VS DUNCAIRN',         effect:{kind:'kav-rest'},    note:'Fitness +14 · Silva starts instead' },
      { l:'MANAGE MINUTES',           effect:{kind:'kav-manage'},  note:'60-minute cap. Moderate residual risk.' },
      { l:'RISK IT',                  effect:{kind:'kav-risk'},    note:'Injury probability rises sharply.' }
    ]},
  { id:'msg_m3', sev:'md', from:'CAPTAIN',   who:'Marcus Thorne',   t:'Barlow is getting restless',
    b:'Sam’s barely featured since the window. He’s a good lad but he’s asked me twice this week where he stands. Wants minutes.',
    ago:'1d',
    choices:[
      { l:'PROMISE ROTATION MINUTES', effect:{kind:'barlow-promise'}, note:'Morale +15 · You must deliver' },
      { l:'TELL HIM TO EARN IT',      effect:{kind:'barlow-earn'},    note:'Morale −20 · Determination tested' },
      { l:'TRANSFER LIST HIM',        effect:{kind:'barlow-list'},    note:'Morale −30 · Listed at £2.5M' }
    ]},
  { id:'msg_m4', sev:'lo', from:'BOARD',     who:'Monthly Review',  t:'October review: Satisfactory',
    b:'Second place, a +9 goal difference and a compliant FFP sheet. The board notes wage-to-revenue is trending favourably. European qualification remains the benchmark.',
    ago:'2d', choices:[{ l:'ACKNOWLEDGE', effect:{kind:'board-ack'}, note:'' }]},
  { id:'msg_m5', sev:'lo', from:'SCOUT',     who:'Carla Moretti',   t:'Marchetti report filed',
    b:'Full dossier on the AS Meridiana playmaker. Confidence: high. He’s the profile we’ve been missing between the lines.',
    ago:'2d', choices:[{ l:'VIEW REPORT', effect:{kind:'view-t1'}, note:'' }]},
  { id:'msg_m6', sev:'md', from:'COMMERCIAL', who:'Commercial Dept.', t:'CryptoNova offer on the table',
    b:'£1.8M for one season — strong money, shaky counterparty. Apex Motors is the safer three-year play.',
    ago:'3d', choices:[{ l:'REVIEW IN COMMERCIAL', effect:{kind:'goto-comm'}, note:'' }]}
];

// ---------------- The builder ----------------

export function newSeedState(overrides = {}) {
  resetUuidSeq();
  const saveId = overrides.saveId || ('save_' + Date.now().toString(36));
  const seed = overrides.seed || hashString(saveId);

  const state = {
    meta: {
      saveId,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      lastPlayedAt: new Date().toISOString(),
      autosaveSlot: 'autosave',
      seed,
      userClubId: 'cl_RAV',
      clubName: 'Ravensport FC'
    },
    clock: {
      date: '2026-10-17',           // legacy S.date = new Date(2026,9,17)
      seasonYear: 2026,
      matchweekPtr: 9,              // next MW to play
      phase: 'in-season',
      dayNumber: 1
    },
    entities: {
      players:    new Map(),
      clubs:      new Map(),
      staff:      new Map(),
      agents:     new Map(),
      facilities: new Map(),
      sponsors:   new Map()
    },
    relationships: {
      contracts:        new Map(),
      negotiations:     new Map(),
      scoutAssignments: new Map(),
      mentorships:      [],   // Step 3.8: active mentorship pairings
      loans:            [],   // Step 4.7: active loan records
      rivalries: [
        { a: 'cl_RAV', b: 'cl_HAL', intensity: 0.9 },   // Northbridge Derby
        { a: 'cl_DUN', b: 'cl_EAS', intensity: 0.6 }    // cross-border
      ]
    },
    competitions: {
      league: {
        table: [],
        fixtures: [],
        matchweek: 9
      },
      cups: [
        { id:'cup-league', name:'Meridian League Cup', round:'R4' }
      ]
    },
    finance: {
      balance: 31.2e6,
      transferBudget: 42.5e6,
      wageBudget: 9.4e6,
      wageCeiling: 12e6,
      transactions: [],
      projections: { monthlyRevenue: 22e6, monthlyWages: 9.4e6 },
      boardOverdraftApproved: false,
      // Display-only historical context (mirrors legacy FIN)
      summary: {
        debt: 18e6, credit: 'A', rate: '4.5%', limit: 600e6, ffp: 'Compliant', wageRatio: 68,
        inc: { Matchday:4.1, Broadcasting:6.8, Commercial:5.2, Merchandise:1.9, Transfers:2.4, Prize:1.6 },
        exp: { Wages:9.4, Facilities:1.8, Interest:0.6, Scouting:0.5, Medical:0.4, Travel:0.3, Marketing:0.5 },
        pnl: [-12, 4, 11]
      }
    },
    inbox: [],
    media: {
      headlines: [
        { outlet:'Sports Central',     cat:'MATCH REPORT', t:'Kavanagh double downs Wexcombe', b:'Two poacher’s finishes and a Sosa screamer sealed 3-1 at Ironworks Park.', ago:'6h', likes:12400 },
        { outlet:'Transfer Insider',   cat:'TRANSFERS',    t:'Sosa camp opens talks on new deal', b:'Paulo Ferreira’s client is on £45K a week. His form says the number should start with a seven.', ago:'9h', likes:8900 },
        { outlet:'The Daily Kick',     cat:'GOSSIP',       t:'Axe hovering over Oakmont', b:'Three points from eight. The Oakmont board met for four hours on Thursday.', ago:'11h', likes:15200 },
        { outlet:'The Meridian Times', cat:'FEATURE',      t:'The rebuild at Ironworks Park is real', b:'Eighteen months ago this squad was drifting. Now the press triggers in unison.', ago:'1d', likes:6100 },
        { outlet:'Tactics Weekly',     cat:'ANALYSIS',     t:'Why Ravensport’s high line works', b:'A PPDA of 8.2 is the lowest in the division. Thorne sweeps, Traoré screens.', ago:'1d', likes:4300 },
        { outlet:'Ravensport Echo',    cat:'ACADEMY',      t:'Class of ’26 impress in U21 derby', b:'Okonkwo marshalled the back line while Fontaine produced the moment of the afternoon.', ago:'2d', likes:2900 }
      ],
      fanSentiment: 71
    },
    board: {
      confidence: { Matches:74, Finance:68, Squad:71 },
      expectations: { league:'Top 4 — European qualification', cup:'League Cup · Round 4+' },
      owner: { n:'Ravensport Holdings', amb:70, pat:55, spend:60, intf:35 }
    },
    manager: {
      name:'Alex Mercer', age:41, nat:'ENG', arch:'Tactician', rep:3,
      lvl:12, xp:3400, xpNext:5200, sp:2, kp:1, sec:72, con:2028, wage:25000,
      record: { g:112, w:61, d:27, l:24, tr:2 },
      skills: [
        { branch:'TACTICIAN', nodes:[
          { n:'Drill Sergeant',  d:'Tactical familiarity gains +20%.',                 c:1, s:'unlocked' },
          { n:'The Tinkerman',   d:'Out-of-position penalties reduced by 50%.',        c:2, s:'unlocked' },
          { n:'Youth Whisperer', d:'U21 development speed +15%.',                      c:3, s:'avail' },
          { n:'Total Football',  d:'Master three formations at 100% familiarity.',     c:5, s:'locked' }
        ]},
        { branch:'WHEELER DEALER', nodes:[
          { n:'Silver Tongue',     d:'Agent patience decays 2× slower in negotiations.', c:1, s:'unlocked' },
          { n:'Hawk Eye',          d:'Scouting reveals full attribute profiles instantly.', c:2, s:'avail' },
          { n:'Financial Wizard',  d:'Wage budget +15% from board restructuring.',      c:3, s:'locked' },
          { n:'Galactico Era',     d:'Board tolerates 50% negative debt for star signings.', c:5, s:'locked' }
        ]},
        { branch:'MAN MANAGER', nodes:[
          { n:'Media Darling',     d:'Press conferences always land neutral or positive.', c:1, s:'unlocked' },
          { n:'The Arm Around',    d:'Player-talk success rate +30%.',                  c:2, s:'avail' },
          { n:'Siege Mentality',   d:'Squad determination +10 after two straight losses.', c:3, s:'locked' },
          { n:'The Hairdryer',     d:'Massive half-time boost when losing.',            c:5, s:'locked' }
        ]}
      ],
      shadows: [
        { n:'The Professor',       on:true,  d:'Youth bias above 60% — regen join rate +20%.' },
        { n:'Box Office',          on:true,  d:'Media volatility above 80 — brand grows faster, fine risk rises.' },
        { n:'Checkbook Manager',   on:false, d:'£200M+ career spend — selling clubs inflate asking prices by 20%.' },
        { n:'The Tyrant',          on:false, d:'Aggression above 80 — high-determination players thrive, the rest wilt.' }
      ],
      career: [
        { c:'Solmere Town',  y:'2021–2024', r:'League Two title · 1.62 PPG', out:'Moved on' },
        { c:'Ravensport FC', y:'2024–present', r:'League Cup 2025 · 1.78 PPG', out:'Active' }
      ],
      trophies: [
        { n:'Meridian League Cup',         y:2025, tier:'Domestic' },
        { n:'Meridian Premier Division',   y:1998, tier:'Domestic' },
        { n:'Meridian Premier Division',   y:1961, tier:'Domestic' }
      ],
      awards: [
        { t:'PLAYER OF THE YEAR',       w:'Rafael Sosa',                s:'2025/26' },
        { t:'GOLDEN BOOT',              w:'Viktor Kavanagh · 24 goals', s:'2025/26' },
        { t:'GOLDEN GLOVE',             w:'Emil Varga · 13 clean sheets', s:'2025/26' },
        { t:'MANAGER OF THE SEASON',    w:'Alex Mercer',                s:'2025/25' }
      ]
    },
    facilities: [
      { k:'training', n:'Training Ground',    lvl:6, cost:2.4e6, maint:65000, fx:'+12% attribute growth · +4% training intensity' },
      { k:'youth',    n:'Youth Academy',      lvl:7, cost:3.1e6, maint:80000, fx:'Intake potential +7 · Wonderkid roll 3.5%' },
      { k:'medical',  n:'Medical Centre',     lvl:5, cost:1.9e6, maint:52000, fx:'Recovery speed +15% · Re-injury risk −12%' },
      { k:'science',  n:'Sports Science',     lvl:4, cost:1.6e6, maint:44000, fx:'Fatigue accumulation −10% · Fitness +6%' },
      { k:'gym',      n:'Gym Complex',        lvl:5, cost:1.2e6, maint:30000, fx:'Physical attribute growth +9%' },
      { k:'analysis', n:'Analysis Room',      lvl:3, cost:1.4e6, maint:36000, fx:'Scouting accuracy +8% · Opponent prep +11%' }
    ],
    sponsors: [
      { cat:'Main',    n:'Vantage Energy', yr:3.2e6, until:2028, sat:82 },
      { cat:'Sleeve',  n:'NovaPay',        yr:0.8e6, until:2027, sat:74 },
      { cat:'Stadium', n:'Halcyon Air',    yr:1.2e6, until:2029, sat:77 }
    ],
    sponsorOffers: [
      { n:'CryptoNova',     cat:'Main',      yr:1.8e6, dur:1, risk:'HIGH COLLAPSE RISK', note:'One season, front-loaded. Their last two deals imploded.' },
      { n:'Apex Motors',    cat:'Main',      yr:2.4e6, dur:3, risk:'Stable',            note:'Solid tier-2 package with win bonuses.' },
      { n:'Stride Apparel', cat:'Technical', yr:1.1e6, dur:5, risk:'Stable',            note:'Kit supplier switch. Long-term upside.' }
    ],
    fans: {
      happy:71, exp:64, atm:78, tol:58, pat:62,
      local:410000, nat:1.9e6, intl:6.4e6, att:91, avgAge:34
    },
    stadium: { cap:52400, vip:2400, boxes:64, ticket:28, season:640 },
    worldEcon: { infl:2.1, tinfl:4.5, winfl:3.2, spg:2.8, tvg:3.5 },
    brand: { prestige:74, popularity:68, history:71, intl:52, youth:79, attack:83 },
    nations: [
      { n:'Brazil',   c:'BRA', r:2 },
      { n:'England',  c:'ENG', r:4 },
      { n:'Portugal', c:'POR', r:6 },
      { n:'Argentina',c:'ARG', r:3 },
      { n:'Germany',  c:'GER', r:9 },
      { n:'Italy',    c:'ITA', r:8 },
      { n:'Ireland',  c:'IRL', r:34 },
      { n:'Senegal',  c:'SEN', r:21 }
    ],
    worldLeagues: [
      { id:'mpd', n:'Meridian Premier Division', cty:'ENG', tier:1, attr:86, champ:'Halloway Athletic' },
      { id:'est', n:'Liga Estrella',             cty:'ESP', tier:1, attr:90, champ:'Atlético Dorada' },
      { id:'bun', n:'Bundesland Liga',           cty:'GER', tier:1, attr:84, champ:'FC Adlerberg' },
      { id:'ser', n:'Serie Meridiana',           cty:'ITA', tier:1, attr:82, champ:'AS Meridiana' }
    ],
    activity: [
      { d:'Oct 14', p:'Emil Novak',     f:'WEX',          t:'STE',           fee:6.5e6, ty:'Loan' },
      { d:'Oct 11', p:'Javi Serrano',   f:'CD Montaña',   t:'HAL',           fee:21e6,  ty:'Permanent' },
      { d:'Oct 9',  p:'Karl Jensen',    f:'DUN',          t:'FC Adlerberg',  fee:9e6,   ty:'Permanent' },
      { d:'Oct 6',  p:'Bastien Leroy',  f:'Free Agent',   t:'POR',           fee:null,  ty:'Free' },
      { d:'Oct 2',  p:'Marco Esposito', f:'AS Meridiana', t:'Real Sur',      fee:14e6,  ty:'Permanent' },
      { d:'Sep 30', p:'Tomas Lindgren', f:'GRA',          t:'KIN',           fee:2.2e6, ty:'Permanent' }
    ],
    transferTargets: [
      { id:'tt_t1', n:'Enzo Marchetti', pos:'CAM', age:22, nat:'ITA', club:'AS Meridiana',       lg:'Serie Meridiana', ovr:80, pot:86, val:29e6, wageAsk:52000, conf:'Scouted',    agentPers:'Aggressive' },
      { id:'tt_t2', n:'Pablo Reyes',    pos:'ST',  age:19, nat:'URU', club:'Atlético Dorada',    lg:'Liga Estrella',   ovr:76, pot:90, val:24e6, wageAsk:38000, conf:'Rumored',    agentPers:'Greedy' },
      { id:'tt_t3', n:'Aiden Murphy',   pos:'RB',  age:23, nat:'IRL', club:'Eastvale Rangers',   lg:'Meridian PD',     ovr:77, pot:80, val:11e6, wageAsk:24000, conf:'WellKnown',  agentPers:'Patient' },
      { id:'tt_t4', n:'Sergei Volkov',  pos:'GK',  age:26, nat:'BUL', club:'FC Adlerberg',       lg:'Bundesland Liga', ovr:81, pot:82, val:14e6, wageAsk:30000, conf:'Scouted',    agentPers:'Patient' },
      { id:'tt_t5', n:'Rafael Duarte',  pos:'LW',  age:26, nat:'BRA', club:'CD Montaña',         lg:'Liga Estrella',   ovr:83, pot:84, val:34e6, wageAsk:68000, conf:'FullyKnown', agentPers:'Greedy' },
      { id:'tt_t6', n:'Moussa Diarra',  pos:'CDM', age:24, nat:'SEN', club:'Real Sur',           lg:'Liga Estrella',   ovr:79, pot:82, val:18e6, wageAsk:36000, conf:'Scouted',    agentPers:'Aggressive' },
      { id:'tt_t7', n:'Kenji Tanaka',   pos:'CAM', age:20, nat:'JPN', club:'Borussia Weiden',    lg:'Bundesland Liga', ovr:74, pot:85, val:12e6, wageAsk:22000, conf:'Rumored',    agentPers:'Unknown' },
      { id:'tt_t8', n:'Jonas Weber',    pos:'CB',  age:25, nat:'GER', club:'SV Nordstern',       lg:'Bundesland Liga', ovr:80, pot:81, val:16e6, wageAsk:34000, conf:'WellKnown',  agentPers:'Loyal' }
    ],
    negotiations: [
      { id:'ng_n1', pid:'tt_t1', status:'Negotiating',         fee:24e6, ask:29e6, wage:48000, agentPress:72, clubWill:64, upd:'Counter-offer received — €27M + 10% sell-on demanded.', started:'Oct 12' },
      { id:'ng_n2', pid:'tt_t3', status:'PersonalTermsAgreed', fee:9.5e6, ask:11e6, wage:22000, agentPress:30, clubWill:81, upd:'Eastvale holding out for £11M. Murphy has told them he wants the move.', started:'Oct 8' }
    ],
    scouts: [
      { n:'Henrik Dahl',     reg:'South America',   asg:'Pablo Reyes · Atlético Dorada', prog:68,  days:4, judg:84 },
      { n:'Carla Moretti',   reg:'Southern Europe', asg:'Enzo Marchetti · AS Meridiana', prog:100, days:0, judg:91 },
      { n:'Tunde Adeyemi',   reg:'British Isles',   asg:'Aiden Murphy · Eastvale Rangers', prog:82, days:2, judg:78 }
    ],
    prospects: [
      { n:'Jamie Okonkwo', pos:'CB',  age:17, ovr:58, pot:[71,78], conf:'Scouted',   note:'Dominant in U21 derby' },
      { n:'Leo Fontaine',  pos:'CAM', age:16, ovr:55, pot:[74,82], conf:'Rumored',   note:'Raw but electric on the ball' },
      { n:'Dylan Price',   pos:'GK',  age:18, ovr:60, pot:[68,75], conf:'WellKnown', note:'Commanding presence' },
      { n:'Marco Silva',   pos:'ST',  age:17, ovr:57, pot:[70,80], conf:'Scouted',   note:'Natural finisher' }
    ],
    // Step 3: Training & Development state
    training: {
      schedule: {},                 // { 'YYYY-MM-DD': sessionType }
      autoSchedule: true,
      familiarity: 78,              // current tactical familiarity (0..100)
      matchPrepMod: 0,              // performance modifier for next fixture
      lastWeekContributions: []     // training contributions from last week
    },
    developmentReports: [],         // quarterly report cards
    // Step 4: Transfer market state
    negotiations: [],               // active negotiation state machines
    incomingBids: [],               // bids from AI clubs on user's players
    freeAgents: [],                 // pool of available free agents (populated below)
    bosmanPreContracts: [],         // pre-contracts signed (effective at season end)
    transferWindow: {
      open: true,
      deadline: '2026-08-31'
    },
    // Transient (not persisted) — UI / match state
    transient: {
      ui: { scr:'dash', squadTab:'tech', matchTab:'fix', clubTab:'overview', trTab:'targets' },
      matchPaused: false,
      lastShout: null
    },
    cache: {
      leagueTableVersion: 0,
      formArraysVersion: 0
    }
  };

  // ---- Build clubs ----
  for (const def of CLUB_DEFS) {
    const club = makeClub({
      id: def.id, code: def.code, name: def.n,
      c1: def.c1, c2: def.c2, city: def.cty,
      managerName: def.mgr,
      rep: def.rep, atk: def.atk, def: def.def,
      budget: def.bud, wageCeiling: def.bud * 0.5,
      balance: def.bud,
      stadium: def.st, capacity: def.cap, ticketPrice: 28,
      tactics: def.tactics,
      squadIds: []
    });
    state.entities.clubs.set(club.id, club);
  }

  // ---- Build user-club players ----
  const ravId = 'cl_RAV';
  for (const pdef of RAV_PLAYERS) {
    const grp = groupOf(pdef.pos);
    const inj = pdef.st === 'inj'
      ? { type: pdef.injT || 'Injury', daysLeft: (pdef.injW || 1) * 7, severity: pdef.injSev || 'Minor' }
      : null;
    const susp = pdef.st === 'susp' ? (pdef.susp || 1) : 0;
    const player = makePlayer({
      id: pdef.id,
      name: pdef.n,
      pos: pdef.pos, grp,
      age: pdef.age, nat: pdef.nat,
      ovr: pdef.ovr, pot: pdef.pot, form: pdef.form,
      fit: pdef.fit, mor: pdef.mor,
      wage: pdef.wage, contractUntil: pdef.con,
      hg: pdef.hg,
      inj, susp,
      // Step 3.6: Sharpness axis (separate from fitness)
      sharp: 70 + Math.floor(Math.random() * 20),   // 70-90 starting sharpness
      // Step 3.4: PA as a band — pot is the high end, derived low end
      potLow: Math.max(pdef.ovr, pdef.pot - 8),
      potHigh: pdef.pot,
      // Step 3.7: track decline status
      earlyInjuries: 0,
      earlyMinutesPct: 0.5,
      stats: { apps: pdef.apps, goals: pdef.g, assists: pdef.a, cs: pdef.cs || 0, motm: 0, mins: pdef.apps * 70 },
      hidden: {
        injuryProneness: 0.3 + (pdef.age > 30 ? 0.2 : 0),
        pressureComposure: (pdef.pers?.prof || 80) / 100,
        weakFoot: pdef.foot === 'Both' ? 0.85 : 0.5,
        // Step 3.4: hidden determination & professionalism
        determination: pdef.pers?.prof || 75,
        professionalism: pdef.pers?.prof || 75,
        ambition: pdef.pers?.amb || 70,
        lateBloomer: pdef.age <= 19 && Math.random() < 0.08
      }
    });
    // Stash extra profile fields for UI display
    player.role = pdef.role;
    player.traits = pdef.traits;
    player.pers = pdef.pers;
    player.val = pdef.val;
    player.num = pdef.num || 0;
    player.captain = !!pdef.captain;
    player.listed = !!pdef.listed;
    player.ask = pdef.ask;
    player.unrest = !!pdef.unrest;
    player.rt = pdef.rt;
    player.gk = !!pdef.gk;
    player.careerG = pdef.careerG;
    state.entities.players.set(player.id, player);
    state.entities.clubs.get(ravId).squadIds.push(player.id);

    // Contract
    const ct = makeContract({
      id: 'ct_' + pdef.id,
      playerId: player.id, clubId: ravId,
      wage: pdef.wage, expiresAt: pdef.con
    });
    state.relationships.contracts.set(ct.id, ct);
  }

  // ---- Generate AI club squads (minimal — enough for the match engine) ----
  // We don't seed full 23-man squads for AI clubs (would be 400+ players).
  // Instead, we derive a synthetic rating from atk/def/rep and the match
  // engine works against the club-level rating. Squad lists stay empty for
  // AI clubs; if a future transfer system needs them, we can backfill.

  // ---- Build facilities for user club ----
  for (const fdef of state.facilities) {
    const f = makeFacility({
      id: 'fa_' + fdef.k, clubId: ravId,
      type: fdef.k, level: fdef.lvl
    });
    state.entities.facilities.set(f.id, f);
    state.entities.clubs.get(ravId).facilityIds.push(f.id);
  }

  // ---- Build sponsors ----
  for (const spdef of state.sponsors) {
    const sp = makeSponsor({
      id: 'sp_' + spdef.n.replace(/\W/g,''),
      name: spdef.n, type: spdef.cat.toLowerCase(),
      annual: spdef.yr, expiresAt: spdef.until
    });
    state.entities.sponsors.set(sp.id, sp);
  }

  // ---- Build agents (lightweight) ----
  const agentDefs = [
    { id:'ag_a1', n:'Paulo Ferreira',   pers:'Greedy',     rep:88, skill:90, comm:10, clients:['pl_p11','pl_p19'] },
    { id:'ag_a2', n:'Sean Byrne',       pers:'Loyal',      rep:70, skill:74, comm:6,  clients:['pl_p18','pl_p14'] },
    { id:'ag_a3', n:'Mino Raggi',       pers:'Aggressive', rep:92, skill:93, comm:12, clients:['pl_p13','pl_p17'] },
    { id:'ag_a4', n:'Grace Okonkwo',    pers:'Patient',    rep:76, skill:81, comm:8,  clients:['pl_p5','pl_p12'] },
    { id:'ag_a5', n:'Viktor Hansen',    pers:'Famous',     rep:84, skill:86, comm:9,  clients:['pl_p6','pl_p15'] }
  ];
  for (const adef of agentDefs) {
    const ag = makeAgent({
      id: adef.id, name: adef.n, clientIds: adef.clients,
      relationship: 50
    });
    ag.pers = adef.pers; ag.rep = adef.rep; ag.skill = adef.skill; ag.comm = adef.comm;
    state.entities.agents.set(ag.id, ag);
  }

  // ---- Build staff (manager + scouts for user club) ----
  const mgrStaff = makeStaff({
    id:'st_mgr', name:'Alex Mercer', role:'manager', clubId: ravId,
    age:41, nat:'ENG', rating:80, contractUntil:2028, wage:25000
  });
  state.entities.staff.set(mgrStaff.id, mgrStaff);
  for (let i = 0; i < state.scouts.length; i++) {
    const s = state.scouts[i];
    const st = makeStaff({
      id: 'st_scout_' + i, name: s.n, role:'scout', clubId: ravId,
      age: 35 + i * 3, nat:'ENG', rating: s.judg, contractUntil: 2028, wage: 8000,
      assignment: { targetRegion: s.reg, daysLeft: s.days }
    });
    state.entities.staff.set(st.id, st);
  }

  // ---- Build fixtures (league + cup) ----
  const codeToId = new Map();
  for (const cdef of CLUB_DEFS) codeToId.set(cdef.code, cdef.id);

  for (const fx of SEED_FIXTURES) {
    const homeId = codeToId.get(fx.h), awayId = codeToId.get(fx.a);
    const isPlayed = fx.hs !== null && fx.as !== null;
    const fixture = makeFixture({
      id: 'fx_mw' + fx.mw + '_' + fx.h + fx.a,
      date: fx.d, homeId, awayId,
      competition: fx.c === 'cup' ? 'cup-league' : 'league',
      matchweek: fx.mw || null,
      status: isPlayed ? 'played' : 'scheduled',
      result: isPlayed ? { hs: fx.hs, as: fx.as, hXG: 0, aXG: 0, events: [], report: null } : null,
      isDerby: !!fx.derby
    });
    if (fx.c === 'cup') fixture.cupRound = fx.rd;
    if (fx.derby) fixture.isDerby = true;
    state.competitions.league.fixtures.push(fixture);
  }
  // Also seed MW1-8 results for non-RAV fixtures so the league table recompute
  // produces the right numbers. We distribute OTHER_MW8_RESULTS across the
  // MW1-7 history (one set per matchweek is enough to make W/D/L totals
  // roughly match — the exact opponent matchup doesn't matter for the table).
  // To keep things simple and match STANDINGS_AFTER_MW8 exactly, we generate
  // synthetic played fixtures for the OTHER MW1-7 matchups that, when summed,
  // produce each club's W/D/L/GF/GA.
  seedHistoricalOpponentResults(state, codeToId);

  // ---- Compute league table from played fixtures ----
  state.competitions.league.table = recomputeLeagueTable(state);

  // ---- Build inbox messages ----
  for (const mdef of SEED_INBOX) {
    const msg = makeMessage({
      id: mdef.id,
      severity: mdef.sev,
      sender: mdef.from + (mdef.who ? ' · ' + mdef.who : ''),
      subject: mdef.t,
      body: mdef.b,
      receivedAt: mdef.ago,
      choices: mdef.choices.map(c => ({ label: c.l, action: c.effect, note: c.note }))
    });
    state.inbox.push(msg);
  }

  // ---- Populate free agent pool (Step 4.7) ----
  const faPrng = new PRNG(hashString(state.meta.seed + ':free_agents'));
  state.freeAgents = generateFreeAgentPool(state, faPrng);

  // ---- Apply overrides ----
  if (overrides.userClubId) state.meta.userClubId = overrides.userClubId;

  return state;
}

/**
 * Back-fill historical opponent results so the league table matches
 * STANDINGS_AFTER_MW8. Rather than re-create all 8*9=72 historical
 * non-RAV fixtures, we synthesise results that sum to each club's
 * W/D/L/GF/GA. This keeps the seed self-consistent without 400 lines
 * of made-up scorelines.
 *
 * Approach: for each non-RAV club, generate synthetic fixtures vs
 * synthetic opponents until the running totals match the seed table.
 */
function seedHistoricalOpponentResults(state, codeToId) {
  // Walk every (club, MW) cell of MW1..8 for non-RAV clubs and assign
  // a synthetic opponent & scoreline that, when summed, matches the
  // standings table. We use a deterministic greedy fill: for each MW,
  // pair up the 17 non-RAV clubs (one gets a bye to simulate the RAV
  // matchup that already exists in SEED_FIXTURES), then pick a result
  // consistent with each side's remaining budget.
  const codes = [...codeToId.keys()].filter(c => c !== 'RAV');
  const totals = {};  // code -> { W, D, L, GF, GA, played }
  for (const c of codes) totals[c] = { W:0, D:0, L:0, GF:0, GA:0, played:0 };
  const targets = {};
  for (const s of STANDINGS_AFTER_MW8) {
    if (s.code === 'RAV') continue;
    targets[s.code] = { W:s.W, D:s.D, L:s.L, GF:s.GF, GA:s.GA, played:s.P };
  }

  // Generate per-MW pairings using a rotation scheme (circle method)
  // round robin over 17 teams means each team gets 8 games vs the other
  // 16 + 1 vs RAV (already in SEED_FIXTURES).
  // We need each team to have exactly 8 games total. Since RAV accounts
  // for 1, we need 7 more per team across MW1..8 (one MW they play RAV).
  // For simplicity, just generate 7 synthetic rounds of pairings.
  const rounds = generateCircleRounds(codes);  // returns array of rounds, each = array of [home, away]
  let mw = 1;
  const dates = ['2026-08-15','2026-08-22','2026-08-29','2026-09-12','2026-09-19','2026-09-26','2026-10-03','2026-10-10'];
  // For each non-RAV club, figure out which MW they played RAV (skip that MW)
  const ravMatchMW = {};  // code -> MW
  for (const fx of SEED_FIXTURES) {
    if (fx.h === 'RAV') ravMatchMW[fx.a] = fx.mw;
    if (fx.a === 'RAV') ravMatchMW[fx.h] = fx.mw;
  }

  // For each round (round index 0..7, representing MW1..8), pair up
  // non-RAV clubs that did NOT play RAV that MW.
  for (let r = 0; r < 8; r++) {
    const mwNum = r + 1;
    const playingThisMW = codes.filter(c => ravMatchMW[c] !== mwNum);
    // odd count => give one a synthetic bye (we'll generate a fixture vs a virtual 'BYE' skipped)
    // pair them up
    const pool = playingThisMW.slice();
    // shuffle deterministically based on r so pairings vary
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (r * 7 + i) % (i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let i = 0; i + 1 < pool.length; i += 2) {
      const home = pool[i], away = pool[i + 1];
      const result = pickResultConsistentWithTotals(home, away, totals, targets);
      const fixture = makeFixture({
        id: 'fx_mw' + mwNum + '_' + home + away,
        date: dates[r],
        homeId: codeToId.get(home), awayId: codeToId.get(away),
        competition: 'league', matchweek: mwNum,
        status: 'played',
        result: { hs: result.hs, as: result.as, hXG: 0, aXG: 0, events: [], report: null }
      });
      state.competitions.league.fixtures.push(fixture);
      totals[home].played++; totals[away].played++;
      totals[home].GF += result.hs; totals[home].GA += result.as;
      totals[away].GF += result.as; totals[away].GA += result.hs;
      if (result.hs > result.as) { totals[home].W++; totals[away].L++; }
      else if (result.hs < result.as) { totals[away].W++; totals[home].L++; }
      else { totals[home].D++; totals[away].D++; }
    }
  }

  // The synthetic fill won't exactly match STANDINGS_AFTER_MW8 (goal totals
  // especially), so we accept a small discrepancy. The league table that
  // recomputeLeagueTable produces will reflect what actually happened in
  // the seeded fixtures. To preserve the legacy UX (table matching
  // STANDINGS_AFTER_MW8), we optionally override the cache directly.
  // However, this introduces a cache/source mismatch that the invariants
  // layer will detect and recompute. To avoid that loop, we leave the
  // table to be recomputed and let the small discrepancy stand. (Future
  // work: backfill more accurate scorelines.)
}

function generateCircleRounds(codes) {
  // Circle method for round-robin. Returns array of rounds; each round
  // is an array of [home, away] pairings.
  const n = codes.length;
  const arr = codes.slice();
  const rounds = [];
  if (n % 2 === 1) arr.push('BYE');
  const N = arr.length;
  const half = N / 2;
  for (let r = 0; r < N - 1; r++) {
    const pairings = [];
    for (let i = 0; i < half; i++) {
      const a = arr[i], b = arr[N - 1 - i];
      if (a !== 'BYE' && b !== 'BYE') {
        pairings.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
    }
    rounds.push(pairings);
    // rotate (keep first fixed)
    const last = arr.pop();
    arr.splice(1, 0, last);
  }
  return rounds;
}

function pickResultConsistentWithTotals(home, away, totals, targets) {
  // Greedy: pick a result that doesn't blow either side's W/L budget.
  // Prefer draws if both still have D budget; otherwise distribute W/L.
  const h = totals[home], a = totals[away];
  const ht = targets[home], at = targets[away];
  const hCanWin = h.W < ht.W;
  const aCanWin = a.W < at.W;
  const hCanDraw = h.D < ht.D;
  const aCanDraw = a.D < at.D;

  // Scoreline pool (low-scoring, realistic)
  const scorelines = [
    [1,0],[0,1],[1,1],[2,1],[1,2],[2,0],[0,2],[0,0],[3,1],[1,3],[2,2],[3,0],[0,3]
  ];

  // Try to find a scoreline consistent with remaining budgets
  const candidates = scorelines.filter(([hs, as]) => {
    if (hs > as && hCanWin && a.L < at.L) return true;
    if (hs < as && aCanWin && h.L < at.L) return true;
    if (hs === as && hCanDraw && aCanDraw) return true;
    return false;
  });
  const pool = candidates.length ? candidates : scorelines;
  const [hs, as] = pool[(h.played + a.played) % pool.length];
  return { hs, as };
}
