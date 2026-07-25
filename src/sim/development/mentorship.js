// sim/development/mentorship.js
// Mentorship & the knowledge transfer system.
//
// Veterans convert into development accelerators:
//   - Pair a senior (28+, leadership 70+, professionalism 75+) with a prospect (U23)
//   - One mentor, up to two mentees
//   - Mentee gains +10-15% to mental attribute growth while paired
//   - Mentee's determination can be pulled upward toward mentor's (up to +8 over a season)
//   - Mentor's own development slows slightly (attention divided)
//   - Personality clash reduces or reverses gains

import { clamp } from '../../core/prng.js';
import { EVT } from '../../core/eventBus.js';

/**
 * Check if a player is eligible to be a mentor.
 *   - 28+ years old
 *   - Leadership 70+
 *   - Professionalism 75+
 */
export function canMentor(player) {
  return player.age >= 28 &&
         (player.pers?.lead ?? 0) >= 70 &&
         (player.hidden?.professionalism ?? 0) >= 75;
}

/**
 * Check if a player is eligible to be a mentee.
 *   - Under 23
 */
export function canBeMentee(player) {
  return player.age < 23;
}

/**
 * Evaluate compatibility between a mentor and a mentee.
 * Returns { compatible, score, reason }.
 *
 * Personality clash (e.g., fiery mentor with low-temperament kid) reduces
 * or reverses gains.
 */
export function evaluateCompatibility(mentor, mentee) {
  const mentorTemp = mentor.pers?.temp ?? 60;
  const menteeTemp = mentee.pers?.temp ?? 60;
  const tempDiff = Math.abs(mentorTemp - menteeTemp);
  // Big temperament gap → clash
  if (tempDiff > 30) {
    return { compatible: false, score: 0.3, reason: 'personality_clash' };
  }
  // Mentor professionalism should be >= mentee's, or the mentor pulls them down
  const mentorProf = mentor.hidden?.professionalism ?? 60;
  const menteeProf = mentee.hidden?.professionalism ?? 60;
  if (mentorProf < menteeProf - 10) {
    return { compatible: false, score: 0.5, reason: 'mentor_unprofessional' };
  }
  // Compatible — score reflects synergy
  const score = clamp(0.7 + (mentorProf - menteeProf) / 200, 0.7, 1.0);
  return { compatible: true, score, reason: 'good_fit' };
}

/**
 * Create a mentorship pairing. Returns the pairing object or null if invalid.
 */
export function createPairing(mentor, mentee) {
  if (!canMentor(mentor) || !canBeMentee(mentee)) return null;
  // One mentor, up to two mentees (caller enforces the limit)
  const compat = evaluateCompatibility(mentor, mentee);
  return {
    id: 'msh_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    mentorId: mentor.id,
    menteeId: mentee.id,
    startedAt: null,    // filled by caller (clock.date)
    weeksElapsed: 0,
    completedAt: null,
    compatibility: compat.score,
    determinationGained: 0,
    mentalGainsAccrued: 0
  };
}

/**
 * Tick a mentorship pairing by one week. Returns events to emit.
 * Mutates the pairing.
 */
export function tickPairing(pairing, mentor, mentee, prng) {
  if (pairing.completedAt) return [];
  const events = [];
  pairing.weeksElapsed++;

  // Apply weekly mental-attribute gain bonus to mentee (handled in growth.js
  // via mentorshipMultiplier — we just track weeks here)

  // Determination pull: slow, but the only way to raise determination
  // Up to +8 over a full season (≈36 weeks)
  if (pairing.determinationGained < 8) {
    const mentorDet = mentor.hidden?.determination ?? 60;
    const menteeDet = mentee.hidden?.determination ?? 60;
    if (mentorDet > menteeDet && prng.next() < 0.15 * pairing.compatibility) {
      // +1 determination every ~7 weeks at full compatibility
      mentee.hidden = mentee.hidden || {};
      mentee.hidden.determination = clamp(menteeDet + 0.15, 0, 99);
      pairing.determinationGained += 0.15;
    }
  }

  // Completion after ~1 season (36 weeks)
  if (pairing.weeksElapsed >= 36) {
    pairing.completedAt = 'now';  // caller fills with date
    // One-time mental attribute bump
    if (mentee.atts) {
      for (const attr of ['positioning', 'decisions', 'composure', 'vision']) {
        if (mentee.atts[attr] != null) {
          mentee.atts[attr] = clamp(mentee.atts[attr] + 2, 20, 99);
        }
      }
    }
    mentor.legacyFlags = mentor.legacyFlags || [];
    mentor.legacyFlags.push({ kind: 'mentorship_complete', mentee: mentee.name });
    events.push({ type: EVT.STATE_BATCH, payload: {
      panel: 'squad', milestone: 'mentorship_complete',
      mentorId: mentor.id, menteeId: mentee.id
    }});
  }
  return events;
}

/**
 * Compute the mentorship growth multiplier for a mentee.
 * Returns 1.0 if no active pairing, 1.10-1.25 if paired.
 */
export function mentorshipMultiplier(mentee, pairings) {
  const active = (pairings || []).find(p =>
    p.menteeId === mentee.id && !p.completedAt);
  if (!active) return 1.0;
  return 1.0 + 0.15 * active.compatibility;
}

/**
 * Compute the mentor's development slowdown while mentoring.
 * Returns 0.85 (15% slower) if currently mentoring, 1.0 otherwise.
 */
export function mentorSlowdown(mentor, pairings) {
  const active = (pairings || []).filter(p =>
    p.mentorId === mentor.id && !p.completedAt);
  if (!active.length) return 1.0;
  // One mentee: -10%, two mentees: -15%
  return active.length === 1 ? 0.90 : 0.85;
}
