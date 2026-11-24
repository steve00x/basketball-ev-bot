import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHistory, historyShape, matchHistory, normalizeStatus } from '../src/betika/history.js';
import { resultsSummary } from '../src/settle.js';

test('status words map to won / lost / void / pending; unclear stays unknown', () => {
  for (const [v, want] of [['WON', 'won'], ['Won', 'won'], ['lost', 'lost'], ['LOSS', 'lost'], ['Cancelled', 'void'], ['Refunded', 'void'],
    ['pending', 'pending'], ['Running', 'pending'], ['', 'unknown'], ['3', 'unknown']]) assert.equal(normalizeStatus(v), want, v);
});

test('finds our tickets in differently shaped responses, by short or long id', () => {
  const shapeA = { data: [
    { short_bet_id: 'LDCH8C', bet_id: 6691062283, status: 'WON', net_win: '22.20', stake: '10.00' },
    { short_bet_id: 'ZZZ111', status: 'LOST' }] };
  const shapeB = { bets: { items: [{ id: 7000001, details: { state: 'lost' } }, { id: 7000002, bet_status: 'Running' }] } };
  const found = matchHistory([shapeA, shapeB], [{ short: 'LDCH8C', long: 6691062283 }, { short: 'LR3HDC', long: 7000001 }, { short: 'NOPE', long: 1 }]);
  assert.deepEqual(found.get('LDCH8C'), { status: 'won', statusText: 'WON', payout: 22.2, fields: { status: 'status', payout: 'net_win' } });
  // the status sits one level deeper here: not guessed
  assert.equal(found.get('LR3HDC').status, 'unknown');
  assert.equal(found.has('NOPE'), false);
});

test('Betika is the final word on placed bets; disagreements are flagged; totals use it', () => {
  const bets = [
    { betId: 'A1', live: true, status: 'placed', stake: 40, odds: 2.0, result: 'won', profit: 40 },
    { betId: 'B2', live: true, status: 'placed', stake: 40, odds: 2.0, result: 'won', profit: 40 },
    { betId: 'C3', live: true, status: 'placed', stake: 40, odds: 2.0 },                     // no score result (e.g. OddsPapi-only game)
    { betId: 'D4', live: true, status: 'placed', stake: 40, odds: 2.0 },
  ];
  const found = new Map([
    ['A1', { status: 'won', statusText: 'WON', payout: 64 }],   // Betika paid 64 (tax taken), not 80
    ['B2', { status: 'lost', statusText: 'LOST', payout: null }], // disagrees with our grade
    ['C3', { status: 'void', statusText: 'Cancelled', payout: 40 }],
    ['D4', { status: 'pending', statusText: 'Running', payout: null }],
  ]);
  assert.equal(applyHistory(bets, found), 3);
  assert.deepEqual(bets.map((b) => [b.betikaStatus, b.betikaProfit, !!b.mismatch]),
    [['won', 24, false], ['lost', -40, true], ['void', 0, false], [undefined, undefined, false]]);
  const t = resultsSummary(bets).real;
  assert.deepEqual([t.won, t.lost, t.push, t.profit, t.pending], [1, 1, 1, -16, 1]);
});

test('shape report has field names and types only, never values', () => {
  const shape = historyShape({ data: [{ short_bet_id: 'LDCH8C', msisdn: '0712345678', stake: 10, status: 'WON', legs: [{ team: 'X' }] }] });
  assert.deepEqual(shape, { data: [{ short_bet_id: 'string', msisdn: 'string', stake: 'number', status: 'string', legs: [{ team: 'string' }] }] });
  assert.ok(!JSON.stringify(shape).includes('0712345678'));
});
