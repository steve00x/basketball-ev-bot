import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BetikaExecutor } from '../src/betika/executor.js';
import { SettingsError, makeSettings, parseNumber, settingsFromEnv, validateSettings } from '../src/config.js';
import { scanEvent } from '../src/scanner.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {} };

test('numbers in .env: 0.02, 2%, 0,02 all mean 2%; junk is refused', () => {
  for (const v of ['0.02', '2%', '2 %', '0,02']) assert.equal(parseNumber(v, 'MIN_EV'), 0.02);
  for (const v of ['2 percent', 'abc', '']) assert.throws(() => parseNumber(v, 'MIN_EV'), SettingsError);
});

test('settings that would bet on everything are refused', () => {
  assert.throws(() => validateSettings(makeSettings({ minEv: NaN })), /not a number/);
  assert.throws(() => validateSettings(makeSettings({ minEv: -0.01 })), /negative/);
  assert.throws(() => validateSettings(makeSettings({ minEv: 2 })), /fraction/);
  assert.throws(() => validateSettings(makeSettings({ winningsTax: { betika: NaN } })), /TAX/);
  assert.doesNotThrow(() => validateSettings(makeSettings({ minEv: 0.02 })));
});

test('.env comments after a tab or spaces are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'MIN_EV=0.02\t# 2% edge\nMAX_DECIMAL_ODDS=6   # odds\n');
  const before = { ...process.env };
  try {
    delete process.env.MIN_EV; delete process.env.MAX_DECIMAL_ODDS;
    const s = settingsFromEnv(file);
    assert.deepEqual([s.minEv, s.maxDecimalOdds], [0.02, 6]);
    fs.writeFileSync(file, 'MIN_EV=2 percent\n');
    delete process.env.MIN_EV;
    assert.throws(() => settingsFromEnv(file), /MIN_EV=2 percent/);
  } finally {
    for (const k of ['MIN_EV', 'MAX_DECIMAL_ODDS']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});

test('a NaN threshold can never reach scanning or betting', async () => {
  const ev = { id: 'e', home_team: 'H', away_team: 'A', commence_time: new Date(Date.now() + 3600e3).toISOString(), bookmakers: [] };
  assert.throws(() => scanEvent(ev, makeSettings({ minEv: NaN })), /MIN_EV/);
  const placed = [];
  const ex = new BetikaExecutor(makeSettings({ minEv: NaN, betikaLive: true }), { placeBet: async (b) => { placed.push(b); return { status: 'placed' }; } },
    new Store(':memory:'), { log: quiet });
  const r = await ex.execute({ book: 'betika', market: 'h2h', eventId: 'e', outcome: 'H', homeTeam: 'H', awayTeam: 'A', point: null,
    fairProb: 0.5, decimal: 2, ev: 0.1, stake: 40, betikaRef: { parentMatchId: 'p', swapped: false } });
  assert.deepEqual([r.reason, placed.length], ['bad_settings', 0]);
});
