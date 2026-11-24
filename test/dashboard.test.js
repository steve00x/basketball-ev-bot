import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardData } from '../src/dashboard.js';
import { makeSettings } from '../src/config.js';
import { Store } from '../src/store.js';

test('dashboard numbers: today vs limits, balance, expected profit; dry runs never counted as placed', () => {
  const now = new Date('2026-11-24T20:00:00');
  const store = new Store(':memory:');
  store.data.bets = [
    { at: '2026-11-23T21:00:00', live: true, status: 'placed', stake: 40, ev: 0.04, betId: 'OLD1', balanceAfter: 1243.79 },
    { at: '2026-11-24T18:00:00', live: true, status: 'placed', stake: 40, ev: 0.05, betId: 'LR3HDC', balanceAfter: 1233.79 },
    { at: '2026-11-24T18:30:00', live: true, status: 'price_moved', stake: 40, ev: 0.03 },
    { at: '2026-11-24T19:00:00', live: false, status: 'dry_run', stake: 40, ev: 0.06, inPlay: true },
    { at: '2026-11-24T19:10:00', live: true, status: 'rejected', stake: 40, ev: 0.03, message: 'Odds have changed' },
  ];
  const d = dashboardData(store, makeSettings({ betikaDailyStakeLimit: 2000, betikaMaxBetsPerDay: 10 }), { mode: {}, opportunities: [] }, now);
  assert.deepEqual([d.today.placed, d.today.staked, d.today.dryRuns, d.today.rejected, d.today.priceMoved], [1, 40, 1, 1, 1]);
  assert.ok(Math.abs(d.today.expectedProfit - 2) < 1e-9);
  assert.equal(d.balance, 1233.79);
  assert.deepEqual([d.allTime.placed, d.allTime.staked], [2, 80]);
  assert.deepEqual(d.bets.map((b) => b.status), ['rejected', 'dry_run', 'price_moved', 'placed', 'placed']); // newest first
  assert.equal(d.bets[1].inPlay, true);
  assert.equal(d.bets[0].message, 'Odds have changed');
});
