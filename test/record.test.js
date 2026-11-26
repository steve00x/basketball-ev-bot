import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sample, scrub, summarize } from '../src/books/record.js';

test('recordings never keep personal data: secret keys, phone numbers, tokens, account pages', () => {
  const s = scrub({ token: 'abc', user_id: 99, data: [{ home: 'Arsenal', away: 'Chelsea', odds: { '1': 2.1 }, note: 'call 0712345678 or +254712345678' }],
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF', first_name: 'Jane', msisdn: '254712345678' });
  assert.equal(s.token, '[redacted]');
  assert.equal(s.user_id, '[redacted]');
  assert.equal(s.first_name, '[redacted]');
  assert.equal(s.msisdn, '[redacted]');
  assert.equal(s.jwt, '[redacted]');
  assert.equal(s.data[0].note, 'call [phone] or [phone]');
  assert.equal(s.data[0].home, 'Arsenal');                          // team names and odds stay
  const text = summarize([
    { url: 'https://api.x.com/v1/matches?sport_id=1&token=zz', method: 'GET', status: 200, request: null, response: { data: [{ home: 'A', odds: 1.9 }] } },
    { url: 'https://api.x.com/v1/account/balance', method: 'GET', status: 200, request: null, response: null },
  ], 'X');
  assert.match(text, /GET api\.x\.com\/v1\/matches/);
  assert.match(text, /sport_id=1&token=\[redacted\]/);
  assert.match(text, /account endpoint: contents not recorded/);
  assert.ok(!/zz/.test(text));
});

test('samples stay short: first two items of long lists', () => {
  const s = sample({ data: [...Array(50)].map((_, i) => ({ id: i, name: 'Team ' + i })) });
  assert.match(s, /\.\.\. 50 items/);
  assert.ok(s.length < 400);
});
