import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHistory, historyShape, matchHistory, normalizeStatus } from '../src/betika/history.js';
import { resultsSummary } from '../src/settle.js';

test('status words map to won / lost / void / pending; unclear stays unknown', () => {
  for (const [v, want] of [['WON', 'won'], ['Won', 'won'], ['lost', 'lost'], ['LOSS', 'lost'], ['Cancelled', 'void'], ['Refunded', 'void'],
    ['pending', 'pending'], ['Running', 'pending'], ['', 'unknown'], ['3', 'unknown']]) assert.equal(normalizeStatus(v), want, v);
});

test('reads Betika /v1/uo/bethistory bets (real field names): betStatus.text first, payout minus withholding tax', () => {
  // field names as seen on the live site; values made up
  const page = { product: 'sports', period: '7', page: 1, limit: '15', bets: [
    { short_bet_id: 'LDCH8C', bet_id: '6691062283', bet_amount: '10.00', possible_win: '22.20', status: '1', betStatus: { text: 'Won' }, wht_tax: '2.44', tax_amount: null },
    { short_bet_id: 'LR3HDC', bet_id: '6700000001', bet_amount: '10.00', possible_win: '14.10', status: '2', betStatus: { text: 'Lost' } },
    { short_bet_id: 'PEND01', bet_id: '6700000002', bet_amount: '40.00', possible_win: '86.00', status: '0', betStatus: { text: 'Pending' } },
    { short_bet_id: 'ZZZ111', bet_id: '1', bet_amount: '5', possible_win: '9', status: '1', betStatus: { text: 'Won' } }] };
  const found = matchHistory([page], [{ short: 'LDCH8C', long: 6691062283 }, { short: 'LR3HDC' }, { short: 'PEND01' }, { short: 'NOPE', long: 2 }]);
  assert.deepEqual(found.get('LDCH8C'), { status: 'won', statusText: 'Won', payout: 19.76, fields: { status: 'betStatus.text' } });
  assert.equal(found.get('LR3HDC').status, 'lost');
  assert.equal(found.get('PEND01').status, 'pending');
  assert.equal(found.has('NOPE'), false);
  // only the plain status code (no betStatus.text): unclear numbers are never guessed
  const codeOnly = matchHistory([{ bets: [{ short_bet_id: 'X1', status: '3' }] }], [{ short: 'X1' }]);
  assert.equal(codeOnly.get('X1').status, 'unknown');
});

test('status word summary: words and counts only', async () => {
  const { statusWords } = await import('../src/betika/history.js');
  const lines = statusWords([{ bets: [
    { short_bet_id: 'A', status: '1', betStatus: { text: 'Won' }, bet_amount: '500' },
    { short_bet_id: 'B', status: '1', betStatus: { text: 'Won' } },
    { short_bet_id: 'C', status: '2', betStatus: { text: 'Lost' } }] }]);
  assert.deepEqual(lines, ['2 x status="1" betStatus.text="Won" -> won', '1 x status="2" betStatus.text="Lost" -> lost']);
  assert.ok(!lines.join().includes('500'));
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
