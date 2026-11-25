import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveGuard, confirmLive } from '../src/liveGuard.js';
import { liveSettings } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { Store } from '../src/store.js';

const T0 = Date.parse('2026-11-25T20:00:00Z');
const ref = (score) => ({ liveMatchId: '77', parentMatchId: '1', score });
const opp = (o = {}) => ({ inPlay: true, ev: 0.07, lineAgeSeconds: 5, betikaRef: ref('1:0'), ...o });

test('live guard: no bet until Pinnacle has priced the game after the current score', () => {
  const g = new LiveGuard({ liveMaxEv: 0.15, liveScoreSettleSeconds: 10 });
  assert.equal(g.check(opp(), T0), 'score_unknown');
  g.observe([{ betikaRef: ref('1:0') }], T0);                 // first sighting counts as a fresh change
  assert.equal(g.check(opp(), T0 + 3000), 'pinnacle_older_than_score');
  assert.equal(g.check(opp(), T0 + 45_000), null);            // 45 s later, Pinnacle 5 s old: priced after the score
  g.observe([{ betikaRef: ref('1:0') }], T0 + 45_000);        // same score: no change
  assert.equal(g.check(opp(), T0 + 50_000), null);
  g.observe([{ betikaRef: ref('2:0') }], T0 + 90_000);        // a goal
  assert.equal(g.check(opp({ betikaRef: ref('2:0'), lineAgeSeconds: 20 }), T0 + 95_000), 'pinnacle_older_than_score');
  assert.equal(g.check(opp({ betikaRef: ref('2:0'), lineAgeSeconds: 2 }), T0 + 120_000), null);
  assert.equal(g.check(opp({ betikaRef: ref('3:0') }), T0 + 120_000), 'score_changed'); // pick from an older read
  assert.equal(g.check(opp({ betikaRef: ref('2:0'), ev: 0.22, lineAgeSeconds: 2 }), T0 + 120_000), 'edge_too_big_to_trust');
  assert.equal(g.check({ inPlay: false, ev: 0.4 }), null);    // pre-match picks are not affected
});

test('confirm: re-prices the pick with a fresh Pinnacle price; gone when the edge is gone', async () => {
  const now = new Date();
  const iso = now.toISOString();
  const event = { id: 'e1', sport_key: 'soccer_epl', home_team: 'A', away_team: 'B', commence_time: new Date(+now - 30 * 60_000).toISOString(),
    bookmakers: [{ key: 'betika', title: 'Betika', last_update: iso, markets: [{ key: 'h2h', last_update: iso, outcomes: [
      { name: 'A', price: 2.5 }, { name: 'B', price: 3.6 }, { name: 'Draw', price: 3.3 }] }] }],
    betikaRef: { liveMatchId: '77', parentMatchId: '1', score: '0:0' } };
  const pin = (home) => ({ bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: iso, markets: [{ key: 'h2h', last_update: iso, outcomes: [
    { name: 'A', price: home }, { name: 'B', price: 3.9 }, { name: 'Draw', price: 3.4 }] }] }] });
  const s = makeSettings({ targetBooks: ['betika'], winningsTax: {}, liveMinEv: 0.05, liveMaxOddsAgeSeconds: 30 });
  const ss = { ...liveSettings(s), targetBooks: ['betika'] };
  const base = { eventId: 'e1', book: 'betika', market: 'h2h', description: undefined, outcome: 'A', point: undefined, stake: 40 };
  let calls = 0;
  const api = (home) => ({ getEventOdds: async (sport, id, markets) => { calls++; assert.deepEqual([sport, id, markets], ['soccer_epl', 'e1', ['h2h']]); return pin(home); } });
  const ok = await confirmLive(api(2.2), s, base, event, ss);      // fair A ~0.44 vs 2.5: still +EV
  assert.ok(ok.opp && ok.opp.ev > 0.05, JSON.stringify(ok));
  const gone = await confirmLive(api(2.6), s, base, event, ss);    // Pinnacle moved: no edge any more
  assert.deepEqual(gone, { reason: 'no_edge_on_fresh_price' });
  const failed = await confirmLive({ getEventOdds: async () => { throw new Error('timeout'); } }, s, base, event, ss);
  assert.equal(failed.reason, 'confirm_failed');
  assert.equal(calls, 2);
});

test('in-play bets use LIVE_MIN_EV for the lowest accepted Betika price, not the pre-match MIN_EV', async () => {
  const s = makeSettings({ betikaLive: false, minEv: 0.02, liveMinEv: 0.05, betikaFixedStake: 40, winningsTax: {} });
  let sent = null;
  const client = { placeBet: async (b) => { sent = b; return { status: 'dry_run', odds: 2.3 }; } };
  const ex = new BetikaExecutor(s, client, new Store(':memory:'), { log: { info() {}, warn() {}, error() {} }, notify: async () => {} });
  const o = { book: 'betika', inPlay: true, fairProb: 0.5, ev: 0.1, decimal: 2.2, stake: 40, eventId: 'e', market: 'h2h', outcome: 'A', homeTeam: 'A', awayTeam: 'B',
    betikaRef: { parentMatchId: '1', liveMatchId: '77', home: 'A', away: 'B', swapped: false } };
  await ex.execute(o);
  assert.equal(sent.minOdds, 2.1);                     // (1 + 5%) / 0.5, not (1 + 2%) / 0.5 = 2.04
  await ex.execute({ ...o, inPlay: false, eventId: 'f' });
  assert.equal(sent.minOdds, 2.04);
});
