// Soccer goals model shared by the pre-match soccer markets and the in-play model.
// From Pinnacle's fair 1X2 and main total: expected goals per team (Poisson), then a full
// score matrix P(home i, away j) calibrated so its home/draw/away and Over/Under match
// Pinnacle exactly. Any goals market (BTTS, team totals, 1X2 & Total, ...) is a sum of cells.
import { devig } from './oddsMath.js';

const MAX_GOALS = 15;

export function pmf(lambda, n = MAX_GOALS) {
  const out = [Math.exp(-lambda)];
  for (let k = 1; k <= n; k++) out.push(out[k - 1] * lambda / k);
  return out;
}

/** P(Poisson(lambda) > line) for a half line (2.5 -> 3 or more goals). */
export function pOver(lambda, line) {
  const p = pmf(lambda);
  let under = 0;
  for (let k = 0; k <= Math.floor(line); k++) under += p[k];
  return Math.max(0, 1 - under);
}

/** Home/draw/away from two independent Poisson goal counts, given a current score. */
export function result(lH, lA, hs = 0, as = 0) {
  const ph = pmf(lH), pa = pmf(lA);
  let H = 0, D = 0, A = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j], d = hs + i - (as + j);
      if (d > 0) H += p; else if (d < 0) A += p; else D += p;
    }
  }
  const t = H + D + A;
  return { H: H / t, D: D / t, A: A / t };
}

export const bisect = (f, lo, hi, n = 60) => { for (let i = 0; i < n; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; } return (lo + hi) / 2; };

/** Expected goals per team over the match from Pinnacle's fair prices (independent Poisson). */
export function fitGoals({ pH, pA, line, pOver: po }) {
  const total = bisect((L) => pOver(L, line) - po, 0.05, 10);
  const share = bisect((x) => { const r = result(total * x, total * (1 - x)); return (r.H - r.A) - (pH - pA); }, 0.02, 0.98);
  return { lH: total * share, lA: total * (1 - share), total, share };
}

/**
 * Plain Poisson under-prices draws a little. Scale the draw so the model matches Pinnacle's
 * pre-match draw at kick-off (k = Pinnacle draw / model draw), fading as the match runs out
 * (share = part of the match's goals still to come); home/away share the rest as before.
 */
export function calibrateDraw(r, k, share) {
  const D = Math.min(0.97, r.D * (1 + (k - 1) * share));
  const rest = r.H + r.A;
  return rest > 0 ? { H: r.H / rest * (1 - D), D, A: r.A / rest * (1 - D) } : r;
}

const N = 10; // score matrix size (0..10 goals each; the rest is negligible)

function rawMatrix(lH, lA) {
  const ph = pmf(lH, N), pa = pmf(lA, N);
  return ph.map((x) => pa.map((y) => x * y));
}

/** Rescale wins / draws / losses so they sum to exactly pH / pD / pA. */
function reweight(M, { pH, pD, pA }) {
  let H = 0, D = 0, A = 0;
  M.forEach((row, i) => row.forEach((p, j) => { if (i > j) H += p; else if (i === j) D += p; else A += p; }));
  return M.map((row, i) => row.map((p, j) => p * (i > j ? pH / H : i === j ? pD / D : pA / A)));
}

const overOf = (M, line) => M.reduce((t, row, i) => t + row.reduce((u, p, j) => u + (i + j > line ? p : 0), 0), 0);

/**
 * Score matrix for a match from Pinnacle's anchor { pH, pD, pA, line, pOver }: matches Pinnacle's
 * 1X2 exactly (by construction) and its main total (the total goals rate is re-fitted after the
 * 1X2 rescaling). Returns { M, total, share }.
 */
export function scoreMatrix(a) {
  const { share } = fitGoals(a);
  const build = (T) => reweight(rawMatrix(T * share, T * (1 - share)), a);
  const total = bisect((T) => overOf(build(T), a.line) - a.pOver, 0.05, 10);
  return { M: build(total), total, share };
}

/**
 * Does a final score (h home goals, a away goals) satisfy this rule? Every condition must hold.
 * rule: { res: 'H' | 'D' | 'A' | 'HD' | 'DA' | 'HA', total: { line, over }, btts: true | false,
 *         team: { side: 'H' | 'A', line, over }, zero: 'H' | 'A' (that team scores 0),
 *         range: [min, max] (total goals), neg: true (the opposite of all the above) }
 */
export function ruleHolds(rule, h, a) {
  const r = h > a ? 'H' : h < a ? 'A' : 'D';
  let ok = true;
  if (rule.res && !rule.res.includes(r)) ok = false;
  if (ok && rule.total && ((h + a > rule.total.line) !== rule.total.over)) ok = false;
  if (ok && rule.btts != null && ((h > 0 && a > 0) !== rule.btts)) ok = false;
  if (ok && rule.team && (((rule.team.side === 'H' ? h : a) > rule.team.line) !== rule.team.over)) ok = false;
  if (ok && rule.zero && (rule.zero === 'H' ? h : a) !== 0) ok = false;
  if (ok && rule.range && !(h + a >= rule.range[0] && h + a <= rule.range[1])) ok = false;
  return rule.neg ? !ok : ok;
}

/** Model probability of a rule from the score matrix. */
export function ruleProb(M, rule) {
  let p = 0;
  M.forEach((row, i) => row.forEach((q, j) => { if (ruleHolds(rule, i, j)) p += q; }));
  return p;
}

/** Pinnacle's pre-match fair 1X2 and main total for one soccer event, or null. */
export function anchorFrom(event, s) {
  for (const book of event.bookmakers ?? []) {
    if (!s.sharpBooks.includes(book.key)) continue;
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    const tot = book.markets?.find((m) => m.key === 'totals');
    if (!h2h || h2h.outcomes?.length !== 3 || !tot) continue;
    const price = (name) => h2h.outcomes.find((o) => o.name === name)?.price;
    const prices = [price(event.home_team), price('Draw'), price(event.away_team)];
    if (prices.some((x) => !(x > 1))) continue;
    const [pH, pD, pA] = devig(prices, s.devigMethod);
    // main total: the half line whose fair Over is closest to 50%
    const byPoint = new Map();
    for (const o of tot.outcomes ?? []) {
      if (!byPoint.has(o.point)) byPoint.set(o.point, {});
      byPoint.get(o.point)[o.name] = o.price;
    }
    let best = null;
    for (const [point, x] of byPoint) {
      if (!(x.Over > 1 && x.Under > 1) || Math.abs(point % 1) !== 0.5) continue; // half lines only (no pushes)
      const [po] = devig([x.Over, x.Under], s.devigMethod);
      if (!best || Math.abs(po - 0.5) < Math.abs(best.pOver - 0.5)) best = { line: point, pOver: po };
    }
    if (best) return { pH, pD, pA, ...best, sharps: [book.key], age: tot.last_update ?? book.last_update ?? null };
  }
  return null;
}
