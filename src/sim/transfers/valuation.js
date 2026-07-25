// sim/transfers/valuation.js
// Dynamic player valuation. A player's price is not a number on a card —
// it's a live estimate that the whole market recalculates constantly.
// Your scouting only ever sees an approximation of it.

import { clamp } from '../../core/prng.js';

/**
 * Compute a player's TRUE value (the engine's internal number).
 * The player only ever sees a scouted range whose width depends on
 * scouting confidence (see scout module).
 *
 * Value formula:
 *   base = abilityValue(ovr, pot, age) +
 *          formModifier(form) +
 *          contractModifier(yearsRemaining) +
 *          positionScarcity(pos) +
 *          provenanceModifiers(homegrown, internationalCaps, leagueRep) +
 *          marketConditions(inflation, tvRights) +
 *          distressDiscount(sellerClub)
 */
export function computeTrueValue(player, opts = {}) {
  const base = abilityValue(player, opts);
  const formMult = formModifier(player.form);
  const contractMult = contractModifier(opts.yearsRemaining ?? player.contractUntil - opts.currentYear);
  const scarcityMult = positionScarcity(player.pos);
  const provenanceMult = provenanceModifier(player, opts);
  const marketMult = marketConditions(opts.worldEcon);
  const distressMult = opts.distressSale ? 0.7 : 1.0;

  return Math.round(base * formMult * contractMult * scarcityMult *
                    provenanceMult * marketMult * distressMult);
}

/**
 * Base value from the ability/potential/age trinity.
 *   - Current ability sets the floor
 *   - Potential sets the ceiling for young players
 *   - Age curve: peaks at 24-27, collapses after 31, inflates at 17-21
 */
function abilityValue(player, opts = {}) {
  const ovr = player.ovr ?? 60;
  const pot = player.effectivePA ?? player.pot ?? ovr + 5;
  const age = player.age ?? 25;

  // Base: exponential scaling on OVR (75 → £5M, 80 → £15M, 85 → £40M, 90 → £80M)
  const ovrValue = Math.pow(Math.max(0, ovr - 50) / 10, 2.5) * 1.5e6;

  // Potential premium for young players
  const potentialPremium = age <= 21
    ? Math.pow(Math.max(0, pot - ovr) / 10, 1.8) * 3e6
    : age <= 24
      ? Math.pow(Math.max(0, pot - ovr) / 10, 1.4) * 1.5e6
      : 0;

  // Age multiplier
  const ageMult = ageMultiplier(age);

  return (ovrValue + potentialPremium) * ageMult;
}

function ageMultiplier(age) {
  // 17-21: potential premium inflation (1.1-1.4)
  // 22-23: peak buildup (1.2-1.3)
  // 24-27: peak + resale value (1.3-1.4)
  // 28-30: stable (1.0-1.1)
  // 31-32: collapse (0.6-0.8)
  // 33+: deep discount (0.3-0.5)
  if (age <= 18) return 1.4;
  if (age <= 21) return 1.3;
  if (age <= 23) return 1.25;
  if (age <= 24) return 1.30;
  if (age <= 27) return 1.35;
  if (age <= 28) return 1.20;
  if (age <= 29) return 1.05;
  if (age <= 30) return 0.90;
  if (age <= 31) return 0.75;
  if (age <= 32) return 0.60;
  if (age <= 33) return 0.45;
  if (age <= 35) return 0.30;
  return 0.20;
}

/**
 * Form modifier — rolling form over last 8 matches shifts value ±15%.
 */
function formModifier(form) {
  if (form == null) return 1.0;
  // Form 6.5 = neutral, 8.0 = +15%, 5.0 = -15%
  return clamp(1 + (form - 6.5) * 0.10, 0.85, 1.15);
}

/**
 * Contract-length modifier — the single sharpest knife.
 *   4+ years remaining: ×1.25
 *   2-3 years: ×1.0
 *   18 months: ×0.75
 *   <12 months: ×0.45 (Bosman looming)
 */
export function contractModifier(yearsRemaining) {
  if (yearsRemaining >= 4) return 1.25;
  if (yearsRemaining >= 2) return 1.0;
  if (yearsRemaining >= 1.5) return 0.75;
  if (yearsRemaining >= 1) return 0.60;
  if (yearsRemaining >= 0.5) return 0.45;
  return 0.30;  // <6 months — Bosman eligible
}

/**
 * Position scarcity premium — elite strikers, left-backs, and ball-playing
 * keepers are structurally rare.
 */
function positionScarcity(pos) {
  const premiums = {
    ST: 1.25,   // elite strikers rare
    LB: 1.20,   // left-backs in short supply
    GK: 1.15,   // ball-playing keepers
    CAM: 1.15,
    RW: 1.10,
    LW: 1.10,
    CB: 1.05,
    CM: 1.05,
    CDM: 1.05,
    RB: 1.00,
    LM: 1.00,
    RM: 1.00
  };
  return premiums[pos] || 1.0;
}

/**
 * Provenance modifiers:
 *   - Homegrown premium (+10% domestically)
 *   - International caps (+5% per major tournament)
 *   - Reputation of selling league
 */
function provenanceModifier(player, opts = {}) {
  let mult = 1.0;
  if (player.hg) mult += 0.10;
  if (player.international) mult += 0.05;
  // Selling league reputation (0..1)
  const leagueRep = opts.sellingLeagueRep ?? 0.7;
  mult *= 0.7 + leagueRep * 0.4;   // 0.7..1.1
  return mult;
}

/**
 * Market conditions from the World screen.
 *   - Transfer inflation lifts all boats
 *   - TV-rights boom inflates domestic prices
 *   - Financial crisis deflates
 */
function marketConditions(worldEcon) {
  if (!worldEcon) return 1.0;
  const infl = (worldEcon.tinfl || 4.5) / 100;   // transfer inflation ~4.5%
  const tv = (worldEcon.tvg || 3.5) / 100;       // TV growth ~3.5%
  return 1 + infl + tv * 0.5;
}

/**
 * Compute the scouted value range a club sees, given their scouting
 * confidence on the player.
 *
 *   FullyKnown: ±2% of true value
 *   WellKnown:  ±8%
 *   Scouted:    ±15%
 *   Rumored:    ±30%
 *
 * @returns {{ low, high, mid }}
 */
export function scoutedValueRange(trueValue, scoutingConfidence) {
  const widths = {
    FullyKnown: 0.02,
    WellKnown: 0.08,
    Scouted: 0.15,
    Rumored: 0.30,
    Unknown: 0.50
  };
  const w = widths[scoutingConfidence] || 0.30;
  return {
    low: Math.round(trueValue * (1 - w)),
    high: Math.round(trueValue * (1 + w)),
    mid: trueValue
  };
}

/**
 * Compute the asking price the selling club will open with.
 * Typically 110-130% of true value, depending on willingness to sell.
 */
export function computeAskingPrice(trueValue, willingnessToSell = 0.5) {
  // willingnessToSell: 0 = desperate (accepts 70%), 1 = no need to sell (asks 130%)
  const mult = 0.7 + willingnessToSell * 0.6;
  return Math.round(trueValue * mult);
}

/**
 * Compute the wage a player will ask for in personal terms.
 * Driven by OVR, age, and the buying club's wage structure.
 */
export function computeWageAsk(player, buyingClub) {
  const ovr = player.ovr ?? 60;
  // Base: OVR-driven
  let base = Math.pow(Math.max(0, ovr - 50) / 10, 2) * 4000;
  // Buying club's wage ceiling caps the ask
  base = Math.min(base, buyingClub?.wageCeiling ?? 1e6);
  // Current wage is the floor
  const current = player.wage ?? base;
  return Math.max(current, Math.round(base));
}
