import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BetikaWatch, marketKeys } from '../src/openers.js';

const T = Date.parse('2026-11-25T12:00:00Z');
const m = (id, o = {}) => ({ parentMatchId: id, winner: [2.0, 1.9], draw: null, totals: [], ...o });

test('betika watch: quiet at start-up, then new games, new markets and price changes are noticed', () => {
  const w = new BetikaWatch({ openersWindowMinutes: 30 });
  assert.deepEqual([...w.observe([m('1'), m('2')], T)], []);                       // first read: nothing is "new"
  assert.deepEqual([...w.observe([m('1'), m('2')], T + 60_000)], []);              // nothing changed
  const changed = w.observe([m('1', { winner: [2.1, 1.8] }), m('2', { totals: [{ point: 220.5, over: 1.9, under: 1.9 }] }), m('3')], T + 120_000);
  assert.deepEqual([...changed].sort(), ['1', '2', '3']);
  const pick = (id, market) => ({ betikaRef: { parentMatchId: id }, market });
  assert.equal(w.isOpener(pick('1', 'h2h'), T + 120_000), false);                 // listed before the bot started
  assert.equal(w.isOpener(pick('2', 'totals'), T + 130_000), true);               // totals just added
  assert.equal(w.isOpener(pick('3', 'h2h'), T + 130_000), true);                  // a brand-new game
  assert.equal(w.isOpener(pick('3', 'h2h'), T + 40 * 60_000), false);             // past the 30-minute window
});

test('betika watch: soccer goals markets count per Betika market title; old games are forgotten', () => {
  const props = [{ title: 'BOTH TEAMS TO SCORE (GG/NG)', label: 'YES', price: 1.9 }];
  assert.deepEqual(marketKeys(m('9', { props, draw: 3.2 })), ['h2h', 'soccer_props:BOTH TEAMS TO SCORE (GG/NG)']);
  const w = new BetikaWatch({ openersWindowMinutes: 30 });
  w.observe([m('9')], T);
  w.observe([m('9', { props })], T + 60_000);
  assert.equal(w.isOpener({ betikaRef: { parentMatchId: '9' }, market: 'soccer_props', betikaMarket: 'BOTH TEAMS TO SCORE (GG/NG)' }, T + 70_000), true);
  w.observe([m('10')], T + 3 * 86400_000);
  assert.equal(w.sig.has('9'), false);
});
