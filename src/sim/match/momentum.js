// sim/match/momentum.js
// Momentum as a driven oscillator with memory.
//   range: -1.0 (away dominant) .. +1.0 (home dominant)
//   base state: 0
//   drivers: goals (+0.35 scorer), big chance missed (+0.12 creator), saves
//            (+0.08 defender), red cards (-0.30 affected team), crowd roar
//            (+0.15 home on home goal), tactical sub (+0.10), conceding after
//            leading (-0.20 psychological blow).
//   decay: drifts toward 0 at 0.02/min of quiet play.

import { clamp } from '../../core/prng.js';

export class MomentumState {
  constructor() {
    this.value = 0;           // -1..+1
    this.drivers = [];        // [{team, magnitude, expireAt}] active decay drivers
    this.lastEventMinute = 0;
  }

  /** Apply a driver event. team: 0=home, 1=away. */
  push({ team, magnitude, decayMins = 8, sustained = false }) {
    const signedMag = team === 0 ? magnitude : -magnitude;
    this.value = clamp(this.value + signedMag, -1, 1);
    if (!sustained) {
      this.drivers.push({ magnitude: signedMag, expireAt: this.lastEventMinute + decayMins });
    } else {
      // Sustained (e.g. red card) — slow decay
      this.drivers.push({ magnitude: signedMag, expireAt: this.lastEventMinute + 30, sustained: true });
    }
  }

  /** Decay active drivers and drift toward 0. Called every minute. */
  tickMinute(minute) {
    this.lastEventMinute = minute;
    // Decay drivers
    this.drivers = this.drivers.filter(d => {
      if (minute >= d.expireAt) {
        this.value = clamp(this.value - d.magnitude, -1, 1);
        return false;
      }
      return true;
    });
    // Drift toward 0 at 0.02/min
    if (this.value > 0) this.value = Math.max(0, this.value - 0.02);
    else if (this.value < 0) this.value = Math.min(0, this.value + 0.02);
  }

  /** Returns |momentum| > 0.5 → pressing +15%, chance +10% for dominant team. */
  isDominant() { return Math.abs(this.value) > 0.5; }

  /** |momentum| > 0.7 → "siege mode": dominant team's final-third entries +25%. */
  isSiege() { return Math.abs(this.value) > 0.7; }

  /** Returns 0=home dominant, 1=away dominant, or null if neutral. */
  dominantTeam() {
    if (this.value > 0.5) return 0;
    if (this.value < -0.5) return 1;
    return null;
  }

  /** Snapshot for serialization / UI display. */
  snapshot() {
    return { value: this.value, drivers: this.drivers.length };
  }
}

/**
 * Standard momentum driver presets.
 */
export const DRIVERS = {
  GOAL_SCORED:        { magnitude: 0.35, decayMins: 8 },
  BIG_CHANCE_MISSED:  { magnitude: 0.12, decayMins: 5 },
  SAVE:               { magnitude: 0.08, decayMins: 4 },
  RED_CARD:           { magnitude: 0.30, decayMins: 30, sustained: true },
  CROWD_ROAR:         { magnitude: 0.15, decayMins: 6 },   // applied IN ADDITION to GOAL_SCORED for home
  TACTICAL_SUB:       { magnitude: 0.10, decayMins: 10 },
  CONCEDE_AFTER_LEAD: { magnitude: 0.20, decayMins: 12 }
};
