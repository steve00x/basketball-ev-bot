import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, clv, clvSummary, marketLabel, recordClosing, warnings } from '../src/insights.js';
import { dedupeKey } from '../src/scanner.js';

const START = '2026-11-25T19:00:00Z';
const opp = { eventId: 'e1', book: 'betika', market: 'totals', description: null, outcome: 'Over', point: 221.5, fairProb: 0.5, pushProb: 0, decimal: 2.0 };
const bet = (o = {}) => ({ key: dedupeKey(opp), at: '2026-11-25T15:00:00Z', live: true, status: 'placed', stake: 40, ev: 0.04, odds: 2.08,
  grade: { sport: 'basketball_nba', eventId: 'e1', commenceTime: START, market: 'totals', outcome: 'Over', point: 221.5, winningsTax: 0 }, ...o });

test('closing price: the latest sharp fair price before the start, from the scan, for pending bets only', () => {
  const b = bet(), started = bet({ grade: { ...bet().grade, commenceTime: '2026-11-25T10:00:00Z' } }), lost = bet({ status: 'price_moved' });
  const now = new Date('2026-11-25T18:40:00Z');
  assert.equal(recordClosing([b, started, lost], [{ ...opp, fairProb: 0.52 }], now), 1);
  assert.deepEqual([b.close.fairProb, b.close.at], [0.52, now.toISOString()]);
  assert.equal(started.close, undefined);
  assert.equal(lost.close, undefined);
  recordClosing([b], [{ ...opp, fairProb: 0.53 }], new Date('2026-11-25T18:55:00Z')); // a later scan replaces it
  assert.equal(b.close.fairProb, 0.53);
});

test('CLV: odds taken against the closing fair price; none if the price is not a close', () => {
  const b = bet({ close: { fairProb: 0.5, pushProb: 0, at: '2026-11-25T18:55:00Z' } });
  assert.ok(Math.abs(clv(b) - 0.04) < 1e-9);                       // 2.08 x 0.5 - 1
  assert.ok(clv({ ...b, close: { ...b.close, fairProb: 0.46 } }) < 0); // market moved away from us
  assert.equal(clv({ ...b, close: { ...b.close, at: '2026-11-25T16:00:00Z' } }), null); // 3h before start
  assert.equal(clv({ ...b, close: { ...b.close, at: '2026-11-25T15:00:20Z' } }), null); // same moment as the bet
  assert.equal(clv(bet()), null);
  const s = clvSummary([b, { ...b, close: { ...b.close, fairProb: 0.46 } }, bet()]);
  assert.deepEqual([s.n, s.of, s.beat], [2, 3, 0.5]);
});

test('breakdown: per sport and market, Betika result first, real and dry runs apart', () => {
  const bets = [
    bet({ result: 'won', profit: 43.2, close: { fairProb: 0.5, at: '2026-11-25T18:55:00Z' } }),
    bet({ result: 'won', profit: 40, betikaStatus: 'lost', betikaProfit: -40, key: 'x' }),        // Betika says lost: counts as lost
    bet({ key: 'y', grade: { sport: 'soccer_epl', market: 'h2h', commenceTime: START }, result: 'lost', profit: -40 }),
    bet({ key: 'z', model: 'alt-total' }),                                    // still open
    bet({ key: 'd', live: false, status: 'dry_run', result: 'won', profit: 40 }),
  ];
  const b = breakdown(bets);
  const nba = b.real.bySport.find((r) => r.name === 'Basketball');
  assert.deepEqual([nba.bets, nba.settled, nba.won, nba.lost, nba.profit], [3, 2, 1, 1, 3.2]);
  assert.deepEqual([nba.clvN, Math.round(nba.clv * 1000)], [1, 40]);
  assert.deepEqual(b.real.byMarket.map((r) => r.name).sort(), ['1X2', 'Alt totals (model)', 'Totals']);
  assert.equal(b.dryRun.bySport[0].profit, 40);
  assert.equal(marketLabel({ inPlay: true, grade: { market: 'h2h', sport: 'basketball_nba' } }), 'In-play Winner');
});

test('warnings: critical first; quiet when all is well', () => {
  const now = new Date('2026-11-25T20:00:00Z');
  const s = { betikaFixedStake: 40, creditsWarnBelow: 1000 };
  const ok = warnings({ bets: [bet()], state: { mode: { betikaLive: true }, credits: '18000' }, s, balance: { amount: 345 }, now });
  assert.deepEqual(ok, []);
  const w = warnings({
    bets: [bet({ status: 'unknown', at: '2026-11-25T19:00:00Z' }), bet({ mismatch: true, betId: 'AB12' }), bet({ status: 'not_logged_in', at: '2026-11-25T19:30:00Z' })],
    state: { mode: { betikaLive: true }, credits: '150', pausedUntil: '2026-11-25T20:10:00Z' }, s, balance: { amount: 30 }, now,
  });
  const titles = w.map((x) => x.level + ': ' + x.title);
  assert.ok(titles.indexOf(titles.find((t) => t.startsWith('warning'))) > titles.lastIndexOf(titles.filter((t) => t.startsWith('critical')).at(-1)));
  for (const want of ['Betting paused', 'Logged out of Betika', 'no confirmation', 'disagree', 'credits low', 'balance low']) {
    assert.ok(titles.some((t) => t.includes(want)), want + ' missing in ' + titles.join(' | '));
  }
  assert.ok(titles.includes('critical: Betika balance low: KES 30'));
});
