// Odds conversion, de-vigging, expected value and Kelly sizing.

export function americanToDecimal(american) {
  if (american >= 100) return 1 + american / 100;
  if (american <= -100) return 1 + 100 / Math.abs(american);
  throw new RangeError(`invalid American odds: ${american}`);
}

export function decimalToAmerican(decimal) {
  if (!(decimal > 1)) throw new RangeError(`invalid decimal odds: ${decimal}`);
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const normalise = (xs) => { const t = sum(xs); return xs.map((x) => x / t); };

/** Scale implied probabilities so they sum to 1. */
export function devigMultiplicative(decimals) {
  return normalise(decimals.map((d) => 1 / d));
}

/** Subtract the overround equally from every outcome. */
export function devigAdditive(decimals) {
  const imp = decimals.map((d) => 1 / d);
  const margin = (sum(imp) - 1) / imp.length;
  return normalise(imp.map((p) => Math.max(p - margin, 1e-6)));
}

/**
 * Find k so that sum(p_i ** k) == 1. Puts more of the vig on longshots,
 * matching how books really price markets (favourite/longshot bias).
 */
export function devigPower(decimals, tol = 1e-10) {
  const imp = decimals.map((d) => 1 / d);
  if (Math.abs(sum(imp) - 1) < tol) return imp;
  let lo = 0.01, hi = 10, k = 1;
  for (let i = 0; i < 200; i++) {
    k = (lo + hi) / 2;
    const s = sum(imp.map((p) => p ** k));
    if (Math.abs(s - 1) < tol) break;
    if (s > 1) lo = k; else hi = k; // sum decreases as k grows
  }
  return normalise(imp.map((p) => p ** k));
}

export const DEVIG_METHODS = {
  multiplicative: devigMultiplicative,
  additive: devigAdditive,
  power: devigPower,
};

export function devig(decimals, method = 'power') {
  const fn = DEVIG_METHODS[method];
  if (!fn) throw new Error(`unknown devig method "${method}"; use ${Object.keys(DEVIG_METHODS).join(', ')}`);
  if (decimals.length < 2) throw new Error('need at least two outcomes to de-vig');
  return fn(decimals);
}

/** EV per unit staked: 0.035 means +3.5%. */
export const expectedValue = (fairProb, decimal) => fairProb * decimal - 1;

/** Full-Kelly fraction of bankroll (0 when there is no edge). */
export function kellyFraction(fairProb, decimal) {
  const b = decimal - 1;
  return Math.max((b * fairProb - (1 - fairProb)) / b, 0);
}

export function stake(fairProb, decimal, bankroll, kellyMult = 0.25, maxPct = 0.02) {
  const pct = Math.min(kellyFraction(fairProb, decimal) * kellyMult, maxPct);
  return Math.round(bankroll * pct * 100) / 100;
}

/** Lowest decimal price that still clears the EV threshold. */
export const minAcceptableOdds = (fairProb, minEv) => (1 + minEv) / fairProb;

/** Decimal odds after a tax on net winnings, e.g. Kenya's 20%: 2.32 -> 2.056. */
export const afterTax = (decimal, winningsTax = 0) => 1 + (1 - winningsTax) * (decimal - 1);

/** Inverse of afterTax: the posted price needed to get `effective` after tax. */
export const beforeTax = (effective, winningsTax = 0) => 1 + (effective - 1) / (1 - winningsTax);

/** Kelly stake when a bet can also be refunded (Draw No Bet): win pW, push pP, lose the rest. */
export function stakeWithPush(pW, pP, decimal, bankroll, kellyMult = 0.25, maxPct = 0.02) {
  const b = decimal - 1, pL = 1 - pW - pP;
  const f = Math.max((pW * b - pL) / (b * (pW + pL)), 0);
  return Math.round(bankroll * Math.min(f * kellyMult, maxPct) * 100) / 100;
}

/** Fair decimal odds of a bet that wins with pW and is refunded with pP. */
export const fairOddsWithPush = (pW, pP = 0) => (1 - pP) / pW;
