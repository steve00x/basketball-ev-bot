// Drives src/betika/client.js with real Puppeteer against a local mock built from Betika's real markup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BetikaClient, DEFAULT_SELECTORS, classifyBetResponse, redact } from '../src/betika/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const chromePath = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '');
const html = fs.readFileSync(path.join(HERE, 'fixtures', 'betika-mock.html'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betika-test-'));

// Local server: serves the mock page and fakes the bet API.
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/v2/bet')) {
    const mode = new URL(req.url, 'http://x').searchParams.get('mode');
    if (mode === 'silent') return; // never answers
    res.writeHead(mode === 'reject' ? 400 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(mode === 'reject'
      ? { success: false, message: 'Insufficient balance' }
      : { success: true, message: 'Bet placed successfully', bet_id: 42 }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let client, base;
const go = (q) => { client.sel.urls.match = `${base}/m/{parentMatchId}?${q}`; };
const PICK = { parentMatchId: '73719748', market: 'Winner (Incl. Overtime)', label: '1' };

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const sel = JSON.parse(fs.readFileSync(DEFAULT_SELECTORS, 'utf8'));
  sel.urls = { home: `${base}/`, login: `${base}/login`, match: `${base}/m/{parentMatchId}` };
  sel.betApi = '127\\.0\\.0\\.1.*/v2/bet';
  const selectorsFile = path.join(tmp, 'selectors.json');
  fs.writeFileSync(selectorsFile, JSON.stringify(sel));
  client = new BetikaClient({ headless: true, chromePath, selectorsFile, sessionDir: path.join(tmp, 'session'), betResponseTimeoutMs: 3000, log: { info() {} } });
});
after(async () => { await client?.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('dry run: right market, odds, stake and after-tax payout', async () => {
  go('');
  const r = await client.placeBet({ ...PICK, minOdds: 1.6, minEffectiveOdds: 1.5, stake: 150 });
  assert.equal(r.status, 'dry_run');
  assert.equal(r.odds, 1.64);
  assert.equal(r.payout, 226.8); // 150*1.64 = 246, minus 20% of the 96 profit
  assert.ok(Math.abs(r.effectiveOdds - 1.512) < 1e-9);
  assert.equal(await client.page.evaluate(() => window.posted.length), 0);
});

test('totals pick and 1X2 is never confused with the winner market', async () => {
  go('');
  const r = await client.placeBet({ ...PICK, market: 'Total (Incl. Overtime)', label: 'Under 228.5', minOdds: 2, stake: 50 });
  assert.deepEqual([r.status, r.odds], ['dry_run', 2.22]);
  const winner2 = await client.placeBet({ ...PICK, label: '2', minOdds: 2, stake: 50 });
  assert.equal(winner2.odds, 2.32); // not the 1X2 price 2.42
});

test('refusals: price moved, payout after tax too low, missing outcome, not logged in', async () => {
  go('');
  assert.equal((await client.placeBet({ ...PICK, minOdds: 1.7, stake: 100 })).status, 'price_moved');
  const low = await client.placeBet({ ...PICK, minOdds: 1.6, minEffectiveOdds: 1.6, stake: 100 });
  assert.equal(low.status, 'payout_too_low');
  assert.equal((await client.placeBet({ ...PICK, label: '3', minOdds: 1, stake: 10 })).status, 'outcome_not_found');
  assert.equal((await client.placeBet({ ...PICK, market: 'Nope', minOdds: 1, stake: 10 })).status, 'market_not_found');
  assert.equal((await client.placeBet({ ...PICK, minOdds: 1, stake: 10, live: true })).status, 'not_logged_in');
});

test('live: clears old slip, places, reads bet API response', async () => {
  go('loggedin=1&preselected=1');
  const r = await client.placeBet({ ...PICK, minOdds: 1.6, stake: 200, live: true });
  assert.equal(r.status, 'placed', JSON.stringify(r));
  assert.match(r.message, /placed successfully/);
  assert.equal(r.response.bet_id, 42);
  const posted = await client.page.evaluate(() => window.posted);
  assert.deepEqual(posted.map((p) => [p.stake, p.odds]), [['200', 1.64]]);
});

test('accepts only the clear-betslip confirm; other dialogs are dismissed', async () => {
  go('preselected=1&alert=1');
  const r = await client.placeBet({ ...PICK, minOdds: 1.6, stake: 30 });
  assert.equal(r.status, 'dry_run'); // old selection was cleared through the confirm, page never froze
  assert.equal(await client.slipCount(), 1);
});

test('accepts the "Leave site?" prompt so navigation is not aborted', async () => {
  go('');
  const logs = [];
  client.log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  await client.goto(`${base}/m/1?x=1`, '.market');
  await client.page.click('.market__odds button.odd'); // real click: gives the page user activation
  await client.goto(`${base}/login`, '.market'); // would fail with ERR_ABORTED if the prompt were dismissed
  client.log = { info() {} };
  assert.ok(logs.some((m) => /accepted beforeunload/.test(m)), logs.join('\n'));
  assert.equal(client.page.url(), `${base}/login`);
});

test('live: rejection and silence are reported, never assumed placed', async () => {
  go('loggedin=1&mode=reject');
  const rej = await client.placeBet({ ...PICK, minOdds: 1.6, stake: 200, live: true });
  assert.deepEqual([rej.status, rej.message], ['rejected', 'Insufficient balance']);
  go('loggedin=1&mode=silent');
  const unk = await client.placeBet({ ...PICK, minOdds: 1.6, stake: 200, live: true });
  assert.equal(unk.status, 'unknown');
});

test('classifyBetResponse and redact', () => {
  assert.equal(classifyBetResponse(200, { success: true }).status, 'placed');
  assert.equal(classifyBetResponse(200, { message: 'Bet placed successfully' }).status, 'placed');
  assert.equal(classifyBetResponse(200, { success: false, message: 'x' }).status, 'rejected');
  assert.equal(classifyBetResponse(500, 'oops').status, 'rejected');
  assert.equal(classifyBetResponse(200, { foo: 1 }).status, 'unknown');
  assert.deepEqual(redact({ token: 'a', profile: { password: 'b', id: 1 } }), { token: '[redacted]', profile: { password: '[redacted]', id: 1 } });
});
