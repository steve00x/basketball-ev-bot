import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradePick, payout, pendingBets, resultsSummary, settlePending } from '../src/settle.js';
import { Store } from '../src/store.js';

const g = (over) => ({ homeTeam: 'H', awayTeam: 'A', market: 'h2h', outcome: 'H', point: null, description: null, code: null, ...over });

test('grading every market from a final score', () => {
  assert.equal(gradePick(g({}), 102, 99), 'won');
  assert.equal(gradePick(g({ outcome: 'A' }), 102, 99), 'lost');
  assert.equal(gradePick(g({ outcome: 'Draw' }), 1, 1), 'won');
  assert.equal(gradePick(g({ outcome: 'Draw' }), 2, 1), 'lost');
  assert.equal(gradePick(g({ market: 'totals', outcome: 'Over', point: 228.5 }), 120, 110), 'won');
  assert.equal(gradePick(g({ market: 'totals', outcome: 'Under', point: 228.5 }), 120, 110), 'lost');
  assert.equal(gradePick(g({ market: 'totals', outcome: 'Over', point: 3 }), 2, 1), 'push');
  assert.equal(gradePick(g({ market: 'team_totals', outcome: 'Under', point: 64.5, description: 'H' }), 60, 75), 'won');
  assert.equal(gradePick(g({ market: 'team_totals', outcome: 'Under', point: 64.5, description: 'A' }), 60, 75), 'lost');
  assert.equal(gradePick(g({ market: 'double_chance', code: 'DA' }), 1, 1), 'won');
  assert.equal(gradePick(g({ market: 'double_chance', code: 'DA' }), 2, 1), 'lost');
  assert.equal(gradePick(g({ market: 'double_chance', code: 'HA' }), 0, 0), 'lost');
  assert.equal(gradePick(g({ market: 'draw_no_bet', code: 'H' }), 1, 1), 'push');
  assert.equal(gradePick(g({ market: 'draw_no_bet', code: 'A' }), 0, 2), 'won');
  assert.equal(gradePick(g({}), NaN, 3), null);
});

test('payout: odds x stake, winnings tax on profit only, refunds and losses', () => {
  assert.deepEqual(payout({ stake: 40, odds: 2.15, grade: { winningsTax: 0 } }, 'won'), { payout: 86, profit: 46 });
  assert.deepEqual(payout({ stake: 40, odds: 2.15, grade: { winningsTax: 0.2 } }, 'won'), { payout: 76.8, profit: 36.8 });
  assert.deepEqual(payout({ stake: 40, odds: 2.15 }, 'push'), { payout: 40, profit: 0 });
  assert.deepEqual(payout({ stake: 40, odds: 2.15 }, 'lost'), { payout: 0, profit: -40 });
});

test('settle: one scores call per sport, real bets and first dry run only, totals per group', async () => {
  const now = Date.parse('2026-11-25T10:00:00Z');
  const bet = (over) => ({ at: '2026-11-24T20:00:00Z', stake: 40, odds: 2.0, ev: 0.04, live: true, status: 'placed',
    grade: { sport: 'basketball_nba', eventId: 'e1', commenceTime: '2026-11-25T00:30:00Z', homeTeam: 'H', awayTeam: 'A', market: 'h2h', outcome: 'H', winningsTax: 0 }, ...over });
  const store = new Store(':memory:');
  store.data.bets = [
    bet({ key: 'k1' }),                                                                         // real, wins
    bet({ key: 'k2', status: 'dry_run', live: false, grade: { ...bet().grade, outcome: 'A' } }), // dry run, loses
    bet({ key: 'k2', status: 'dry_run', live: false, grade: { ...bet().grade, outcome: 'A' } }), // repeat of k2: not counted
    bet({ key: 'k3', status: 'price_moved' }),                                                  // never placed: ignored
    bet({ key: 'k4', grade: { ...bet().grade, sport: 'soccer_epl', eventId: 's1', market: 'totals', outcome: 'Under', point: 2.5 } }),
    bet({ key: 'k5', grade: { ...bet().grade, commenceTime: '2026-11-25T09:00:00Z' } }),          // started 1h ago: too early
  ];
  assert.equal(pendingBets(store.data.bets, now).length, 3);
  const calls = [];
  const api = { getScores: async (sport) => {
    calls.push(sport);
    if (sport === 'basketball_nba') return [{ id: 'e1', completed: true, home_team: 'H', away_team: 'A', scores: [{ name: 'H', score: '110' }, { name: 'A', score: '101' }] }];
    return [{ id: 's1', completed: true, home_team: 'H', away_team: 'A', scores: [{ name: 'H', score: '1' }, { name: 'A', score: '0' }] }];
  } };
  const r = await settlePending(api, store, { info() {}, warn() {} }, now);
  assert.deepEqual(calls.sort(), ['basketball_nba', 'soccer_epl']);
  assert.equal(r.settled, 3);
  const b = Object.fromEntries(store.data.bets.filter((x) => x.result).map((x) => [x.key, [x.result, x.profit, x.finalScore]]));
  assert.deepEqual(b, { k1: ['won', 40, '110-101'], k2: ['lost', -40, '110-101'], k4: ['won', 40, '1-0'] });
  const t = resultsSummary(store.data.bets);
  assert.deepEqual([t.real.won, t.real.lost, t.real.profit, t.real.roi, t.real.pending], [2, 0, 80, 1, 1]);
  assert.deepEqual([t.dryRun.settled, t.dryRun.profit], [1, -40]); // the repeated dry run counted once
});
