// `ev-bot review`: is the bot losing because of bad luck, or because the "edges" aren't real?
// Compares the wins you got with the wins the fair (Pinnacle) odds predicted, per group of bets.
import { clv, strategyOf, taxCheck } from './insights.js';
export { taxCheck };
import { finalOutcome, firstDryRuns } from './settle.js';
import { marketLabel, sportLabel } from './insights.js';

/** Settled-bet statistics for one list. */
export function stats(list) {
  const settled = list.filter((b) => ['won', 'lost', 'push'].includes(finalOutcome(b)) && b.fairProb > 0);
  const won = settled.filter((b) => finalOutcome(b) === 'won').length;
  const lost = settled.filter((b) => finalOutcome(b) === 'lost').length;
  const expWins = settled.reduce((t, b) => t + b.fairProb, 0);
  const sd = Math.sqrt(settled.reduce((t, b) => t + b.fairProb * (1 - b.fairProb), 0));
  const staked = settled.reduce((t, b) => t + (b.stake ?? 0), 0);
  const profit = settled.reduce((t, b) => t + (b.betikaProfit ?? b.profit ?? 0), 0);
  const expProfit = settled.reduce((t, b) => t + (b.stake ?? 0) * (b.ev ?? 0), 0);
  const odds = settled.map((b) => Number(b.odds ?? b.expectedOdds)).filter((x) => x > 1);
  const clvs = list.map(clv).filter((x) => x != null);
  return {
    n: settled.length, open: list.length - settled.length, won, lost, expWins, z: sd ? (won - expWins) / sd : null,
    staked, profit, expProfit, roi: staked ? profit / staked : null,
    avgOdds: odds.length ? odds.reduce((t, x) => t + x, 0) / odds.length : null,
    avgEv: settled.length ? settled.reduce((t, b) => t + (b.ev ?? 0), 0) / settled.length : null,
    clv: clvs.length ? clvs.reduce((t, x) => t + x, 0) / clvs.length : null, clvN: clvs.length,
  };
}

export function verdict(st) {
  if (st.n < 30) return `only ${st.n} settled - too few to judge; with odds around 2, losing 6 of 10 happens all the time`;
  if (st.z <= -2) return 'losing MORE than bad luck explains: these prices are probably not real edges';
  if (st.z <= -1) return 'below expectation, but still within normal bad luck';
  return 'within normal luck';
}

const pct = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const kes = (x) => `${x >= 0 ? '+' : '-'}KES ${Math.abs(Math.round(x))}`;

function block(title, list) {
  const st = stats(list);
  if (!list.length) return [`${title}: none`];
  return [
    `${title}: ${st.n} settled, ${st.open} open`,
    ...(st.n ? [
      `  won ${st.won}, lost ${st.lost} | fair odds predicted ${st.expWins.toFixed(1)} wins (luck: ${st.z == null ? '-' : `${st.z >= 0 ? '+' : ''}${st.z.toFixed(1)} sd`})`,
      `  profit ${kes(st.profit)} on KES ${Math.round(st.staked)} (ROI ${pct(st.roi)}) | expected ${kes(st.expProfit)} | avg odds ${st.avgOdds?.toFixed(2) ?? '-'}, avg EV ${pct(st.avgEv)}`,
      `  CLV ${st.clvN ? `${pct(st.clv)} over ${st.clvN} bets` : 'not available yet'}`,
    ] : []),
    `  => ${verdict(st)}`,
  ];
}

function table(title, list, labelOf) {
  const groups = new Map();
  for (const b of list) { const k = labelOf(b); groups.set(k, [...(groups.get(k) ?? []), b]); }
  const rows = [...groups].map(([k, bs]) => [k, stats(bs)]).filter(([, st]) => st.n).sort((a, b) => b[1].n - a[1].n);
  if (!rows.length) return [];
  return [title, ...rows.map(([k, st]) => `  ${k.padEnd(24)} ${String(st.n).padStart(4)} bets  W-L ${`${st.won}-${st.lost}`.padEnd(7)} `
    + `expected wins ${st.expWins.toFixed(1).padStart(5)}  profit ${kes(st.profit).padStart(10)}  ROI ${pct(st.roi).padStart(7)}`)];
}

const evBand = (b) => (b.ev < 0.05 ? 'EV under 5%' : b.ev < 0.1 ? 'EV 5-10%' : b.ev < 0.15 ? 'EV 10-15%' : 'EV 15% and more');

export function review(bets) {
  const real = bets.filter((b) => b.live && b.status === 'placed');
  const dry = firstDryRuns(bets);
  const inPlay = (l, yes) => l.filter((b) => !!b.inPlay === yes);
  const out = [
    ...block('IN-PLAY, real money', inPlay(real, true)), '',
    ...block('IN-PLAY, dry runs', inPlay(dry, true)), '',
    ...block('PRE-MATCH, real money', inPlay(real, false)), '',
    ...block('PRE-MATCH, dry runs', inPlay(dry, false)), '',
  ];
  const ip = [...inPlay(real, true), ...inPlay(dry, true)];
  out.push(...table('In-play by size of edge (real + dry runs) - if the biggest edges lose most, the prices were stale:', ip, evBand), '');
  out.push(...table('In-play by sport:', ip, sportLabel), '');
  out.push(...table('In-play by market:', ip, marketLabel), '');
  out.push(...table('Pre-match by sport (real money):', inPlay(real, false), sportLabel), '');
  out.push(...table('By strategy (real + dry runs):', [...real, ...dry], strategyOf), '');
  out.push(...placement(bets), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function taxLines(bets, setting) {
  const t = taxCheck(bets);
  if (!t) return ['TAX CHECK: no Betika history with tax details yet - it fills in after the hourly Betika history check'];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const out = [`TAX CHECK: Betika withholds about ${pct(t.rate)} of the profit on winning bets (${t.n} bets checked)`];
  if (Math.abs(t.rate - setting) > 0.02) {
    out.push(`  !! the bot prices bets with BETIKA_WINNINGS_TAX=${setting} - set BETIKA_WINNINGS_TAX=${Math.round(t.rate * 100) / 100} in .env`,
      `     otherwise it bets "edges" that are gone after tax (at odds 2.0, ${pct(t.rate)} tax on profit costs ${pct(t.rate / 2)} of EV)`);
  } else out.push(`  matches BETIKA_WINNINGS_TAX=${setting}: OK`);
  return out;
}

/**
 * Bet placement: of the bets the bot tried to place, how many went through at the price wanted,
 * and how long it took. Lots of "price moved" means the bot is too slow for that strategy.
 */
export function placement(bets) {
  const tried = bets.filter((b) => b.status && b.status !== 'skipped' && b.at);
  if (!tried.length) return [];
  const groups = new Map();
  for (const b of tried) { const k = strategyOf(b); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const rows = [...groups].sort((a, b) => b[1].length - a[1].length).map(([k, bs]) => {
    const n = (st) => bs.filter((b) => st.includes(b.status)).length;
    const ok = n(['placed', 'dry_run']), moved = n(['price_moved']), rej = n(['rejected']);
    const other = bs.length - ok - moved - rej;
    const secs = median(bs.filter((b) => ['placed', 'dry_run'].includes(b.status)).map((b) => b.placeMs));
    return `  ${k.padEnd(30)} ${String(bs.length).padStart(4)} tries  ${String(Math.round(ok / bs.length * 100)).padStart(3)}% through`
      + `  price moved ${String(moved).padStart(3)}  rejected ${String(rej).padStart(3)}  other ${String(other).padStart(3)}`
      + `  ${secs == null ? '' : `median ${(secs / 1000).toFixed(1)} s`}`;
  });
  return ['Bet placement (all attempts) - many "price moved" or "rejected" means the edge is gone before the bet lands:', ...rows];
}
