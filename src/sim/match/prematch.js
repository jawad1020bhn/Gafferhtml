// sim/match/prematch.js
// Pre-match resolution: lineup lock, tactical matchup matrix, condition mods.
// Produces a `MatchSetup` consumed by the engine.

import { logger } from '../../core/logger.js';
import { groupOf } from '../../domain/entities.js';

// Formation slot definitions. Each slot has a position and a "zone" used by
// the possession model (def/mid/final/box).
const FORMATIONS = {
  '4-4-2':  ['GK','RB','CB','CB','LB','RM','CM','CM','LM','ST','ST'],
  '4-3-3':  ['GK','RB','CB','CB','LB','CDM','CM','CAM','RW','ST','LW'],
  '4-2-3-1':['GK','RB','CB','CB','LB','CDM','CDM','CAM','RW','LW','ST'],
  '3-5-2':  ['GK','CB','CB','CB','RWB','CDM','CM','CM','LWB','ST','ST'],
  '5-4-1':  ['GK','RWB','CB','CB','CB','LWB','RM','CM','CM','LM','ST'],
  '4-5-1':  ['GK','RB','CB','CB','LB','RM','CM','CAM','CM','LM','ST'],
  '3-4-3':  ['GK','CB','CB','CB','RWB','CM','CM','LWB','RW','ST','LW']
};

/**
 * Validate and lock the starting XI. Returns a `Lineup` object with
 * resolved player slot assignments, or {error} if invalid.
 *
 * lineupInput: { starting: [playerId...], bench: [playerId...], formation: '4-3-3' }
 */
export function lockLineup(state, clubId, lineupInput) {
  const club = state.entities.clubs.get(clubId);
  if (!club) return { error: 'club_not_found' };
  const formation = lineupInput.formation || club.tactics.formation;
  const slots = FORMATIONS[formation];
  if (!slots) return { error: 'unknown_formation', formation };
  const starting = lineupInput.starting || [];
  if (starting.length !== 11) return { error: 'wrong_xi_size', n: starting.length };

  // Validate each player is fit, not suspended, and belongs to the club
  const resolved = [];
  for (let i = 0; i < 11; i++) {
    const pid = starting[i];
    const p = state.entities.players.get(pid);
    if (!p) return { error: 'player_not_found', pid };
    if (p.inj) return { error: 'player_injured', pid, injury: p.inj };
    if (p.susp > 0) return { error: 'player_suspended', pid, susp: p.susp };
    if (!club.squadIds.includes(pid)) return { error: 'player_not_in_squad', pid };

    const slotPos = slots[i];
    const slotGroup = groupOf(slotPos);
    const playerGroup = p.grp || groupOf(p.pos);
    // Out-of-position penalty: 0 if same group, scaled if cross-group
    let oopPenalty = 0;
    if (slotPos !== p.pos) {
      if (slotGroup === playerGroup) oopPenalty = 0.05;  // same line, different role
      else oopPenalty = 0.15;                              // cross-line (e.g. CB at ST)
    }
    // "Tinkerman" skill reduces OOP penalty by 50%
    const hasTinkerman = (state.manager.skills
      .find(b => b.branch === 'TACTICIAN')?.nodes || [])
      .some(n => n.n === 'The Tinkerman' && n.s === 'unlocked');
    if (hasTinkerman) oopPenalty *= 0.5;

    resolved.push({
      playerId: pid,
      slotIdx: i,
      slotPos,
      oopPenalty,
      // Effective rating for match: ovr adjusted by form and fitness
      effRating: effectiveRating(p, slotPos)
    });
  }

  return {
    formation,
    slots,
    starting: resolved,
    bench: (lineupInput.bench || []).map(pid => state.entities.players.get(pid)).filter(Boolean)
  };
}

/**
 * Effective rating for a player in a slot, accounting for form and fitness.
 */
function effectiveRating(p, slotPos) {
  const formMod = ((p.form || 6) - 6) * 1.5;   // ±6 at form extremes
  const fitMod = p.fit >= 70 ? 0 : -(70 - p.fit) * 0.3;
  const groupMatch = (groupOf(slotPos) === (p.grp || groupOf(p.pos))) ? 0 : -3;
  return Math.max(20, Math.min(99, (p.ovr || 60) + formMod + fitMod + groupMatch));
}

/**
 * Compare two sides across five tactical axes. Each axis returns a modifier
 * (-1..+1, positive = home advantage).
 *
 *   width       — wing play vs narrow defense
 *   tempo       — high press vs build-from-back
 *   lineHeight  — high line vulnerability to through balls vs compactness
 *   setPiece    — aerial strength vs zonal marking
 *   transition  — counter-attack rating vs recovery pace
 */
export function tacticalMatchupMatrix(homeSetup, awaySetup, homeClub, awayClub) {
  const hT = homeClub.tactics, aT = awayClub.tactics;
  const hOvr = avgRating(homeSetup.starting);
  const aOvr = avgRating(awaySetup.starting);

  // WIDTH: attacking width vs defensive narrowness (and vice versa)
  const hWidthAttack = widthScore(hT);
  const aWidthDefense = 1 - widthScore(aT);
  const width = (hWidthAttack - aWidthDefense) * 0.5 + (hOvr - aOvr) * 0.02;

  // TEMPO: high press vs slow build
  const hTempo = tempoScore(hT);
  const aTempo = tempoScore(aT);
  const tempo = (hTempo - aTempo) * 0.4 + (hOvr - aOvr) * 0.02;

  // LINE HEIGHT: high line is vulnerable to through balls
  const hLine = lineHeightScore(hT);
  const aLine = lineHeightScore(aT);
  // If home plays higher line, they're more vulnerable to away counters
  const lineHeight = (aLine - hLine) * 0.3 + (hOvr - aOvr) * 0.02;

  // SET PIECE: aerial threat vs marking quality
  const hSP = (homeClub.tactics.setPieceBias || 0.5) + aerialThreat(homeSetup) * 0.3;
  const aSP = (awayClub.tactics.setPieceBias || 0.5) + aerialThreat(awaySetup) * 0.3;
  const setPiece = (hSP - aSP) * 0.5;

  // TRANSITION: counter-attack vs recovery
  const hCounter = (homeClub.tactics.counterBias || 0.5) + counterThreat(homeSetup) * 0.3;
  const aCounter = (awayClub.tactics.counterBias || 0.5) + counterThreat(awaySetup) * 0.3;
  const transition = (hCounter - aCounter) * 0.4;

  // Overall strength differential (used for possession baseline)
  const strength = (hOvr - aOvr) / 100;

  return {
    width: clamp(width, -1, 1),
    tempo: clamp(tempo, -1, 1),
    lineHeight: clamp(lineHeight, -1, 1),
    setPiece: clamp(setPiece, -1, 1),
    transition: clamp(transition, -1, 1),
    strength: clamp(strength, -1, 1)
  };
}

function widthScore(t) {
  return ({ narrow: -0.5, normal: 0, wide: 0.5 }[t.width] || 0)
       + ({ slow: -0.2, normal: 0, fast: 0.2 }[t.tempo] || 0);
}
function tempoScore(t) {
  return ({ low: -0.5, mid: 0, high: 0.5 }[t.pressing] || 0)
       + ({ slow: -0.3, normal: 0, fast: 0.3 }[t.tempo] || 0);
}
function lineHeightScore(t) {
  return ({ deep: -0.5, mid: 0, high: 0.5 }[t.lineHeight] || 0);
}
function aerialThreat(setup) {
  // CBs and STs with high physical contribute
  let sum = 0, n = 0;
  for (const s of setup.starting) {
    if (s.slotPos === 'CB' || s.slotPos === 'ST') {
      sum += s.effRating;
      n++;
    }
  }
  return n ? (sum / n - 60) / 30 : 0;   // -0.5..+0.5 roughly
}
function counterThreat(setup) {
  // Wingers + ST pace
  let sum = 0, n = 0;
  for (const s of setup.starting) {
    if (['LW','RW','ST','CAM'].includes(s.slotPos)) {
      sum += s.effRating;
      n++;
    }
  }
  return n ? (sum / n - 60) / 30 : 0;
}
function avgRating(starting) {
  return starting.reduce((a, s) => a + s.effRating, 0) / starting.length;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/**
 * Condition modifiers applied to the match context.
 *   home advantage: +4% possession baseline, crowd pressure on away decisions
 *   derby: +15% foul rate, +10% card probability, compressed momentum swings
 *   weather: rain → -8% short passing accuracy, +12% long-ball frequency
 *   pitch quality: from facilities data
 */
export function conditionModifiers(state, fixture, homeClub, awayClub) {
  const mods = {
    homeAdvantage: 0.04,
    derbyFoulMult: 1.0,
    derbyCardMult: 1.0,
    passAccMod: 0,
    longBallFreqMod: 0,
    pitchQuality: 1.0,
    weather: 'clear'
  };
  if (fixture.isDerby) {
    mods.derbyFoulMult = 1.15;
    mods.derbyCardMult = 1.10;
  }
  // Weather: deterministic per fixture (no random — derived from date)
  const month = new Date(fixture.date).getMonth() + 1;
  if (month >= 11 || month <= 2) {
    // Winter: more rain/snow
    mods.weather = 'rain';
    mods.passAccMod = -0.08;
    mods.longBallFreqMod = 0.12;
  }
  // Pitch quality from home club's facilities
  const homeFac = state.entities.facilities;
  let facilitySum = 0, facilityN = 0;
  for (const fid of (homeClub.facilityIds || [])) {
    const f = homeFac.get(fid);
    if (f && f.type === 'training') { facilitySum += f.level; facilityN++; }
  }
  if (facilityN) mods.pitchQuality = 0.9 + (facilitySum / facilityN) / 60;  // ~0.9..1.1
  return mods;
}

/**
 * AI opponent tactical profile — returns the away club's persistent tactics.
 * This isn't random per match — it's a persistent identity that the player
 * can scout and prepare for. We just read it off the club entity.
 */
export function aiTacticalProfile(club) {
  return club.tactics;
}

/**
 * Pick a starting XI for an AI club (which doesn't have full player entities).
 * Generates a synthetic lineup from club rating — the match engine works
 * against club-level ratings when player-level data isn't available.
 *
 * NOTE: Accepts a PRNG to keep synthetic variation deterministic. Without it,
 * replaying a match would produce different synthetic ratings.
 */
export function synthesizeAILineup(state, club, prng) {
  const slots = FORMATIONS[club.tactics.formation] || FORMATIONS['4-4-2'];
  const rng = prng || { next: () => 0.5, range: (a, b) => (a + b) / 2 };
  // Synthetic ratings: club atk/def drive FWD/MID/DEF respectively
  const starting = slots.map((slotPos, i) => {
    const grp = groupOf(slotPos);
    const base = grp === 'GK' ? 70 : grp === 'DEF' ? club.def : grp === 'MID' ? (club.atk + club.def) / 2 : club.atk;
    return {
      playerId: null,           // synthetic — no player entity
      synthetic: true,
      clubId: club.id,
      slotIdx: i,
      slotPos,
      oopPenalty: 0,
      effRating: base + (rng.next() - 0.5) * 6,  // deterministic variation
      // Synthetic player attributes used by xG/shot models
      name: `${club.code} ${slotPos}${i}`,
      finishing: base, composure: base, pace: base,
      crossing: base, freeKickAccuracy: base,
      heading: base, jumping: base,
      tackling: base, marking: base,
      reflexes: base, positioning: base,
      stamina: 75 + rng.range(0, 15)
    };
  });
  return {
    formation: club.tactics.formation,
    slots,
    starting,
    bench: [],
    synthetic: true
  };
}

export { FORMATIONS };
