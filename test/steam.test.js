import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamTracker } from '../src/steam.js';

const S = { steamMinMove: 0.03, steamWindowMinutes: 15, steamWatchMinutes: 10, steamPollSeconds: 60, steamMaxEvents: 2, steamDailyCredits: 10 };
const pick = (eventId, outcome, p) => ({ eventId, sport: 'soccer_epl', market: 'h2h', outcome, point: null, fairProb: p });
const T = Date.parse('2026-11-25T12:00:00Z');

test('steam: a sharp move is noticed, the game watched; picks against the move are held back', () => {
  const st = new SteamTracker(S);
  assert.deepEqual(st.observe([pick('e1', 'Home', 0.50), pick('e1', 'Away', 0.30)], T), []);
  const moved = st.observe([pick('e1', 'Home', 0.545), pick('e1', 'Away', 0.26)], T + 4 * 60_000);
  assert.deepEqual(moved.map((m) => [m.eventId, m.what]), [['e1', 'Home']]);
  assert.equal(st.watch.size, 1);
  const opps = [pick('e1', 'Home', 0.545), pick('e1', 'Away', 0.26)];
  const dropped = st.apply(opps);
  assert.deepEqual(opps.map((o) => [o.outcome, !!o.steam]), [['Home', true]]);
  assert.deepEqual(dropped.map((o) => o.outcome), ['Away']);
  // an old move falls out of the window
  st.observe([pick('e1', 'Home', 0.545)], T + 25 * 60_000);
  assert.equal(st.moveOf(pick('e1', 'Home')), 0);
});

test('steam watch: re-priced every poll interval, ends after the watch time, stays within the credit budget', () => {
  const st = new SteamTracker(S);
  st.observe([pick('e1', 'Home', 0.5)], T);
  st.observe([pick('e1', 'Home', 0.56)], T + 60_000);
  assert.equal(st.nextDueAt(), T + 2 * 60_000);
  assert.deepEqual(st.due(T + 90_000), []);
  assert.deepEqual(st.due(T + 2 * 60_000).map((d) => d.eventId), ['e1']);
  st.polled('e1', 3, T + 2 * 60_000);
  assert.deepEqual(st.due(T + 2.5 * 60_000), []);
  st.polled('e1', 6, T + 3 * 60_000);                    // 9 of 10 credits used
  assert.deepEqual(st.due(T + 5 * 60_000, 3), []);       // the next poll would go over
  assert.equal(new SteamTracker(S).observe([{ ...pick('op-1', 'Home', 0.5) }], T).length, 0);
});
