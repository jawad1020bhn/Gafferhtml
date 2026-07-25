// sim/match/narrative.js
// Event feed narrative layer. Translates raw match events (numbers) into
// the human-readable event feed the player reads.
//
// Templates vary by xG (tap-in vs screamer), scorer identity, assist type,
// game context ("against the run of play", "seals it", "consolation").
// Frequency control: not every minute gets an event; quiet stretches make
// big moments land. Tone shifts: derby (aggressive), cup (giant-killing),
// title-decider (weight).

/**
 * Build the event-feed text for a goal.
 * @param {Object} goalEvt  { scorer, assistType, xg, minute, isOwnGoal, isPenalty, isHeader, isVolley, team, context }
 * @returns {string} html-safe text
 */
export function goalNarrative(goalEvt) {
  const { scorer, assistType, xg, minute, isOwnGoal, isPenalty, isHeader, isVolley, team, context } = goalEvt;
  const name = scorer?.name || scorer?.playerId || 'Unknown';
  const surname = name.split(' ').slice(-1)[0];

  if (isOwnGoal) {
    return `OG — ${surname} turns it into his own net. ${contextLabel(goalEvt)}`;
  }
  if (isPenalty) {
    return `${surname} slots home from the spot. ${contextLabel(goalEvt)}`.trim();
  }

  // xG-based intensity
  let prefix;
  if (xg >= 0.5) prefix = 'tap-in';
  else if (xg >= 0.25) prefix = 'finish';
  else if (xg >= 0.12) prefix = 'strike';
  else if (xg >= 0.06) prefix = 'effort';
  else prefix = 'screamer';

  let assistClause = '';
  if (assistType === 'through') assistClause = ', played in by a defence-splitting through ball';
  else if (assistType === 'cross') assistClause = ', meeting the cross';
  else if (assistType === 'cutback') assistClause = ', sweeping home the cutback';
  else if (assistType === 'setPiece') assistClause = ', from the set-piece delivery';

  let shotClause = '';
  if (isHeader) shotClause = ' header';
  else if (isVolley) shotClause = ' volley';

  let body;
  if (xg >= 0.5) {
    body = `${surname} ${shotClause} ${assistClause} — can't miss from there.`;
  } else if (xg >= 0.25) {
    body = `${surname}${shotClause} ${prefix}${assistClause}.`;
  } else if (xg >= 0.12) {
    body = `${surname} ${prefix}${shotClause}${assistClause} — picks his spot.`;
  } else if (xg >= 0.06) {
    body = `${surname} unleashes a ${prefix}${shotClause}${assistClause}. The keeper never moved.`;
  } else {
    body = `${surname} with a ${prefix}${shotClause}${assistClause}! Sensational hit.`;
  }

  const ctx = contextLabel(goalEvt);
  return ctx ? `${body} ${ctx}` : body;
}

function contextLabel(evt) {
  const c = evt.context || {};
  if (c.consolation) return 'Consolation.';
  if (c.seals) return 'Seals it.';
  if (c.equaliser) return 'Equaliser.';
  if (c.opener) return 'Opens the scoring.';
  if (c.againstRunOfPlay) return 'Against the run of play.';
  if (c.giantKilling) return 'Giant-killing in the making!';
  return '';
}

/**
 * Save narrative.
 */
export function saveNarrative(evt) {
  const { goalkeeper, shooter, xg } = evt;
  const gkName = goalkeeper?.name || 'the keeper';
  const shName = (shooter?.name || 'the striker').split(' ').slice(-1)[0];
  if (xg >= 0.3) return `${gkName} denies ${shName} from point-blank range!`;
  if (xg >= 0.15) return `${gkName} tips ${shName}'s effort over.`;
  return `${gkName} gets down well to smother ${shName}'s shot.`;
}

/**
 * Miss narrative.
 */
export function missNarrative(evt) {
  const { shooter, xg, zone } = evt;
  const surname = (shooter?.name || 'the striker').split(' ').slice(-1)[0];
  if (xg >= 0.3) return `${surname} should have scored! Drags it wide.`;
  if (zone === 'long') return `${surname} fires over from distance.`;
  if (zone === 'wide') return `${surname} drags it wide of the near post.`;
  return `${surname} blazes over.`;
}

/**
 * Block narrative.
 */
export function blockNarrative(evt) {
  const { shooter } = evt;
  const surname = (shooter?.name || 'the striker').split(' ').slice(-1)[0];
  return `Blocked! ${surname}'s effort charged down.`;
}

/**
 * Post narrative.
 */
export function postNarrative(evt) {
  const { shooter } = evt;
  const surname = (shooter?.name || 'the striker').split(' ').slice(-1)[0];
  return `Off the woodwork! ${surname} inches away.`;
}

/**
 * Yellow card narrative.
 */
export function yellowCardNarrative(evt) {
  const reasons = ['cynical foul in midfield', 'dissent', 'time-wasting', 'reckless tackle', 'late challenge', 'tactical foul on the break'];
  const reason = evt.reason || reasons[Math.floor((evt.reasonIdx || 0) % reasons.length)];
  const name = (evt.player?.name || 'the offender').split(' ').slice(-1)[0];
  return `${name} into the book — ${reason}.`;
}

/**
 * Red card narrative.
 */
export function redCardNarrative(evt) {
  const name = (evt.player?.name || 'the offender').split(' ').slice(-1)[0];
  if (evt.reason === 'secondYellow') return `Second yellow! ${name} is off. They're down to ten.`;
  if (evt.reason === 'straight') return `Straight red! ${name} walks. Mayhem on the touchline.`;
  return `${name} sent off.`;
}

/**
 * Substitution narrative.
 */
export function subNarrative(evt) {
  const out = (evt.out?.name || 'the outgoing player').split(' ').slice(-1)[0];
  const inn = (evt.in?.name || 'the substitute').split(' ').slice(-1)[0];
  if (evt.reason === 'injury') return `Injury-enforced change: ${inn} on for ${out}.`;
  if (evt.reason === 'attacking') return `Attacking change: ${inn} on for ${out}.`;
  if (evt.reason === 'defensive') return `Defensive change: ${inn} on for ${out}.`;
  if (evt.reason === 'fatigue') return `Fresh legs: ${inn} replaces ${out}.`;
  return `${inn} comes on for ${out}.`;
}

/**
 * Injury narrative.
 */
export function injuryNarrative(evt) {
  const name = (evt.player?.name || 'the player').split(' ').slice(-1)[0];
  const mechanisms = {
    'Hamstring strain': `${name} pulls up holding the hamstring.`,
    'Calf strain':      `${name} is down clutching his calf.`,
    'Ankle sprain':     `${name} turns an ankle awkwardly.`,
    'Groin strain':     `${name} signals to the bench — groin.`,
    'Knock':            `${name} takes a knock and stays down.`,
    'Cramp':            `${name} cramps up — they'll have to come off.`,
    'Impact injury':    `${name} is down after a heavy challenge.`,
    'Dead leg':         `Dead leg for ${name}.`,
    'Head clash':       `Head clash — ${name} needs assessing.`
  };
  return mechanisms[evt.type] || `${name} is hurt.`;
}

/**
 * Half-time & full-time narrative.
 */
export function halfTimeNarrative(score) {
  return `Half-time. ${score.home}–${score.away}. The teams regroup in the tunnel.`;
}
export function fullTimeNarrative(score, isDerby, userIsHome, userWon, userLost) {
  let prefix = 'Full-time.';
  if (userWon) prefix = isDerby ? 'Full-time. Derby delight!' : 'Full-time. Three points in the bag.';
  else if (userLost) prefix = isDerby ? 'Full-time. A derby to forget.' : 'Full-time. Disappointment.';
  else prefix = 'Full-time. Honours even.';
  return `${prefix} ${score.home}–${score.away}.`;
}

/**
 * Tactical shift narrative (AI manager decision).
 */
export function tacticalShiftNarrative(side, club, reason) {
  const name = club?.managerName || 'The manager';
  if (reason === 'chasing_equaliser') return `${name} throws caution to the wind — attacking change.`;
  if (reason === 'protect_lead')      return `${name} shuts up shop. Defensive shift.`;
  if (reason === 'settle_for_point')  return `${name} settles for the point.`;
  return `${name} makes a tactical adjustment.`;
}

/**
 * Touchline shout narrative (from user).
 */
export function shoutNarrative(kind) {
  const map = {
    PUSH:  'You signal: push higher up the pitch.',
    CALM:  'You signal: keep the ball, be patient.',
    WIDE:  'You signal: stretch them wide.',
    PRESS: 'You signal: intensify the press!'
  };
  return map[kind] || 'You bark instructions from the touchline.';
}

/**
 * Quiet-stretch narrative. Not every minute gets an event — these fill
 * quiet stretches (5-12 mins of nothing) with ambient commentary.
 */
export function ambientNarrative(prng, minute, possPct, momentum) {
  const lines = [
    `Midfield battle intensifies.`,
    `The crowd finds its voice.`,
    `Patient build-up from both sides.`,
    `Tempo rising.`,
    `A lull as both benches reassess.`,
    `Possession swinging back and forth.`,
    `Heavy challenge goes unpunished.`,
    `The referee plays a good advantage.`,
    `Frustrations simmer on the touchline.`
  ];
  if (Math.abs(momentum) > 0.5) {
    const dom = momentum > 0 ? 'The home side' : 'The visitors';
    lines.push(`${dom} are firmly on top.`, `Siege mentality setting in.`, `Wave after wave of pressure.`);
  }
  return prng.pick(lines);
}
