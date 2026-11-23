import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSettings } from '../src/config.js';
import { groupLines, scanEvent } from '../src/scanner.js';

const NOW = new Date('2026-11-23T12:00:00Z');
const at = (sec) => new Date(+NOW + sec * 1000).toISOString();
const S = makeSettings({ minEv: 0.02 });

const event = (books, start = at(3 * 3600)) => ({
  id: 'e1', sport_key: 'basketball_nba', home_team: 'H', away_team: 'A', commence_time: start,
  bookmakers: Object.entries(books).map(([key, markets]) => ({ key, title: key, last_update: at(-10), markets })),
});
const h2h = (h, a) => [{ key: 'h2h', outcomes: [{ name: 'H', price: h }, { name: 'A', price: a }] }];
const spread = (pt, h, a) => [{ key: 'spreads', outcomes: [{ name: 'H', price: h, point: pt }, { name: 'A', price: a, point: -pt }] }];

test('finds moneyline edge', () => {
  const [o, ...rest] = scanEvent(event({ pinnacle: h2h(1.95, 1.95), draftkings: h2h(2.1, 1.75) }), S, NOW);
  assert.equal(rest.length, 0);
  assert.deepEqual([o.book, o.outcome, o.decimal], ['draftkings', 'H', 2.1]);
  assert.ok(Math.abs(o.ev - 0.05) < 1e-9);
});

test('no edge below threshold', () => {
  assert.deepEqual(scanEvent(event({ pinnacle: h2h(1.95, 1.95), draftkings: h2h(2.0, 1.8) }), S, NOW), []);
});

test('spread lines must match exactly (incl. reversed)', () => {
  assert.deepEqual(scanEvent(event({ pinnacle: spread(2.5, 1.95, 1.95), b: spread(3.5, 2.2, 1.7) }), S, NOW), []);
  assert.deepEqual(scanEvent(event({ pinnacle: spread(2.5, 1.95, 1.95), b: spread(-2.5, 2.3, 1.6) }), S, NOW), []);
  const [o] = scanEvent(event({ pinnacle: spread(2.5, 1.95, 1.95), b: spread(2.5, 2.1, 1.7) }), S, NOW);
  assert.deepEqual([o.outcome, o.point], ['H', 2.5]);
});

test('props grouped per player', () => {
  const m = (a, b) => [{ key: 'player_points', outcomes: [
    { name: 'Over', description: 'P1', price: a, point: 20.5 }, { name: 'Under', description: 'P1', price: b, point: 20.5 },
    { name: 'Over', description: 'P2', price: 1.9, point: 10.5 }, { name: 'Under', description: 'P2', price: 1.9, point: 10.5 }] }];
  assert.equal(groupLines('player_points', m(1.9, 1.9)[0].outcomes).size, 2);
  const opps = scanEvent(event({ pinnacle: m(1.95, 1.95), fanduel: m(2.12, 1.7) }), S, NOW);
  assert.deepEqual(opps.map((o) => [o.description, o.outcome]), [['P1', 'Over']]);
});

test('skips started, far-off and stale', () => {
  const books = { pinnacle: h2h(1.95, 1.95), draftkings: h2h(2.1, 1.75) };
  assert.deepEqual(scanEvent(event(books, at(-300)), S, NOW), []);
  assert.deepEqual(scanEvent(event(books, at(48 * 3600)), S, NOW), []);
  const stale = event(books);
  stale.bookmakers[1].last_update = at(-3600);
  assert.deepEqual(scanEvent(stale, S, NOW), []);
});

test('target books, odds bounds, no sharp', () => {
  const books = { pinnacle: h2h(1.95, 1.95), draftkings: h2h(2.1, 1.75) };
  assert.deepEqual(scanEvent(event(books), makeSettings({ targetBooks: ['fanduel'] }), NOW), []);
  assert.deepEqual(scanEvent(event(books), makeSettings({ maxDecimalOdds: 2 }), NOW), []);
  assert.deepEqual(scanEvent(event({ draftkings: h2h(2.5, 2.5) }), S, NOW), []);
});

test('multiple sharps averaged', () => {
  const ev = event({ pinnacle: h2h(1.9, 2.0), circasports: h2h(2.0, 1.9), draftkings: h2h(2.1, 1.75) });
  const [o] = scanEvent(ev, makeSettings({ sharpBooks: ['pinnacle', 'circasports'] }), NOW);
  assert.ok(Math.abs(o.fairProb - 0.5) < 1e-9);
});
