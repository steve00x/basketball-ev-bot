import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardData, startDashboard } from '../src/dashboard.js';
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

test('dashboard balance: the newer of the last bet and the balance read from Betika, with its time and source', () => {
  const now = new Date('2026-11-24T20:00:00Z');
  const store = new Store(':memory:');
  store.data.bets = [{ at: '2026-11-24T18:00:00Z', live: true, status: 'placed', stake: 40, betId: 'A', balanceAfter: 1233.79 }];
  const s = makeSettings({});
  const st = { mode: {}, opportunities: [] };
  let d = dashboardData(store, s, st, now);
  assert.deepEqual([d.balance, d.balanceSource, d.balanceAt], [1233.79, 'bet', '2026-11-24T18:00:00Z']);
  store.data.balance = { amount: 1310.5, at: '2026-11-24T19:00:00Z' }; // a win paid in since
  d = dashboardData(store, s, st, now);
  assert.deepEqual([d.balance, d.balanceSource], [1310.5, 'read']);
  store.data.bets.push({ at: '2026-11-24T19:30:00Z', live: true, status: 'placed', stake: 40, betId: 'B', balanceAfter: 1270.5 });
  d = dashboardData(store, s, st, now);
  assert.deepEqual([d.balance, d.balanceSource], [1270.5, 'bet']); // a bet after the read is newer
  assert.equal(dashboardData(new Store(':memory:'), s, st, now).balance, null);
});

test('dashboard access: this PC only without a key; with a key, ?key= once sets a cookie, wrong or missing key is refused', async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const s = makeSettings({});
  const listen = (srv) => new Promise((r) => srv.on('listening', () => r(srv.address())));
  // network host without a key: falls back to this PC only
  const errors = [];
  let srv = startDashboard({ store: new Store(':memory:'), s, port: 0, log: { ...quiet, error: (m) => errors.push(m) }, host: '0.0.0.0', key: '' });
  assert.equal((await listen(srv)).address, '127.0.0.1');
  assert.match(errors[0], /DASHBOARD_KEY/);
  srv.close();

  const key = 'k3y-0123456789abcdef';
  srv = startDashboard({ store: new Store(':memory:'), s, port: 0, log: quiet, host: '127.0.0.1', key });
  const base = `http://127.0.0.1:${(await listen(srv)).port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/?key=wrong`, { redirect: 'manual' })).status, 401);
    const ok = await fetch(`${base}/?key=${key}`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const api = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(api.status, 200);
    assert.ok(Array.isArray((await api.json()).bets));
  } finally { srv.close(); }
});
