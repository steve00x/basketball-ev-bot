import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFrom, fitGoals, modelBook, pOver, readLive, recordAnchors, remainingShare, result, runModelCycle } from '../src/inplayModel.js';
import { LiveGuard } from '../src/liveGuard.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { makeSettings } from '../src/config.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {} };
const A = { pH: 0.48, pD: 0.27, pA: 0.25, line: 2.5, pOver: 0.52 };

test('model maths: fits Pinnacle before kick-off, goals left shrink with time, the score counts', () => {
  const g = fitGoals(A);
  const r = result(g.lH, g.lA);
  assert.ok(Math.abs(pOver(g.total, 2.5) - 0.52) < 1e-6);
  assert.ok(Math.abs((r.H - r.A) - (0.48 - 0.25)) < 1e-6);
  assert.equal(remainingShare(0, 1), 1);
  assert.equal(remainingShare(45, 'ht'), 0.55);
  assert.equal(remainingShare(95, 2), 0);
  const late = result(g.lH * remainingShare(85, 2), g.lA * remainingShare(85, 2), 1, 0);
  assert.ok(late.H > 0.85, 'a one-goal lead at 85 min wins most of the time');
});

test('live state from Betika: half, minute, score in our home/away order', () => {
  assert.deepEqual(readLive({ period: '2nd half', clock: '70:30', score: '1:0' }), { minute: 70, half: 2, hs: 1, as: 0 });
  assert.deepEqual(readLive({ period: '1st half', clock: '13:07', score: '0:1', swapped: true }), { minute: 13, half: 1, hs: 1, as: 0 });
  assert.equal(readLive({ period: 'Halftime', clock: '', score: '0:0' }).half, 'ht');
  assert.equal(readLive({ period: 'Extra time 1st half', clock: '95:00', score: '1:1' }), null);
  assert.equal(readLive({ period: '1st half', clock: '10:00', score: '-:-' }), null);
});

test('anchor: Pinnacle fair 1X2 and the total nearest 50%, stored before kick-off only', () => {
  const now = new Date('2026-11-25T17:00:00Z');
  const ev = { id: 'e1', sport_key: 'soccer_epl', home_team: 'H', away_team: 'A', commence_time: '2026-11-25T18:00:00Z', bookmakers: [{ key: 'pinnacle', markets: [
    { key: 'h2h', outcomes: [{ name: 'H', price: 2.0 }, { name: 'A', price: 3.8 }, { name: 'Draw', price: 3.5 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: 1.95, point: 2.5 }, { name: 'Under', price: 1.95, point: 2.5 },
      { name: 'Over', price: 1.40, point: 1.5 }, { name: 'Under', price: 3.0, point: 1.5 }] }] }] };
  const s = makeSettings({});
  const a = anchorFrom(ev, s);
  assert.equal(a.line, 2.5);
  assert.ok(Math.abs(a.pH + a.pD + a.pA - 1) < 1e-9 && a.pH > a.pA);
  const store = new Store(':memory:');
  assert.equal(recordAnchors(store, [ev, { ...ev, id: 'started', commence_time: '2026-11-25T16:00:00Z' }], s, now), 1);
  assert.deepEqual(Object.keys(store.data.anchors), ['e1']);
});

const s = makeSettings({ targetBooks: ['betika'], liveModelMinEv: 0.06, liveModelMaxMinute: 80, liveModelQuietMinutes: 3, liveModelMaxAnchorHours: 3, betikaFixedStake: 40, winningsTax: {} });
const NOW = new Date('2026-11-25T19:15:00Z');
const anchorEvent = (ref, betikaTotals = [2.5]) => ({
  id: 'e1', sport_key: 'soccer_epl', home_team: 'H', away_team: 'A', commence_time: '2026-11-25T18:00:00Z',
  anchor: { ...A, commence: '2026-11-25T18:00:00Z', at: '2026-11-25T17:55:00Z' }, betikaRef: ref,
  bookmakers: [{ key: 'betika', markets: [{ key: 'totals', outcomes: betikaTotals.flatMap((p) => [{ name: 'Over', price: 2, point: p }, { name: 'Under', price: 1.8, point: p }]) }] }],
});

test('model book: skips red cards, late minutes, recent goals, old pre-match prices; prices live lines', () => {
  const ref = { liveMatchId: '9', period: '2nd half', clock: '60:00', score: '1:0', redCards: 0 };
  const ok = modelBook(anchorEvent(ref, [0.5, 1.5, 2.5]), s, NOW, +NOW - 10 * 60_000);
  assert.ok(ok.book);
  assert.deepEqual(ok.book.markets.find((m) => m.key === 'totals').outcomes.map((o) => o.point), [1.5, 1.5, 2.5, 2.5]); // 0.5 already won
  assert.equal(modelBook(anchorEvent({ ...ref, redCards: 1 }), s, NOW).skip, 'red_card');
  assert.equal(modelBook(anchorEvent({ ...ref, clock: '82:10' }), s, NOW).skip, 'too_late_in_match');
  assert.equal(modelBook(anchorEvent(ref), s, NOW, +NOW - 60_000).skip, 'recent_goal');
  const old = anchorEvent(ref); old.anchor.at = '2026-11-25T08:00:00Z';
  assert.equal(modelBook(old, s, NOW).skip, 'no_recent_prematch_price');
  assert.equal(modelBook({ ...anchorEvent(ref), betikaRef: null }, s, NOW).skip, 'not_on_betika_live');
});

test('model cycle: Betika live odds vs model prices -> in-play dry-run bet on the mispriced side', async () => {
  const store = new Store(':memory:');
  store.data.anchors = { e1: { sport: 'soccer_epl', home: 'Home FC', away: 'Away FC', commence: '2026-11-25T18:00:00Z', at: '2026-11-25T17:55:00Z', ...A } };
  // 0-0 at 75 min: Draw ~60.8%, Under 1.5 ~87.6%, Over 1.5 ~12%
  const live = { sport: 'soccer', parentMatchId: '501', home: 'Home FC', away: 'Away FC', start: new Date('2026-11-25T18:00:00Z'), competition: 'EPL',
    winner: [3.6, 6.0], draw: 1.75, totals: [{ point: 1.5, over: 5.0, under: 1.25 }], live: true, liveMatchId: '9', clock: '75:00', period: '2nd half', score: '0:0', redCards: 0 };
  const feed = { allLiveMatches: async () => [live] };
  let placed = [];
  const client = { placeBet: async (b) => { placed.push(b); return { status: 'dry_run', odds: 1.5 }; } };
  const ex = new BetikaExecutor({ ...s, betikaLive: false }, client, store, { log: quiet, notify: async () => {} });
  const guard = new LiveGuard(s);
  const notifier = { sendOpportunities: async () => {} };
  // first look: the score was only just seen, so the quiet period blocks
  let r = await runModelCycle({ store, s, feed, executor: ex, notifier, log: quiet, guard, now: NOW });
  assert.equal(placed.length, 0);
  // 5 minutes later, same score
  r = await runModelCycle({ store, s, feed, executor: ex, notifier, log: quiet, guard, now: new Date(+NOW + 5 * 60_000) });
  // Draw: model ~60.8% (fair 1.65) vs Betika 1.75 = +6.4%; Under 1.5 is +EV too but 1.25 is below MIN_DECIMAL_ODDS
  assert.deepEqual(r.all.map((o) => [o.outcome, o.model.kind]), [['Draw', 'inplay-model']], JSON.stringify(r.all.map((o) => [o.outcome, o.point, o.ev])));
  assert.ok(placed.some((b) => b.label === 'X' && b.liveMatchId === '9'), JSON.stringify(placed));
  const bet = store.data.bets.find((b) => b.model === 'inplay-model');
  assert.equal(bet.inPlay, true);
  assert.equal(bet.status, 'dry_run');
});
