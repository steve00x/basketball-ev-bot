import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsError, accountSettings, makeSettings } from '../src/config.js';
import { BetikaExecutor, MultiExecutor } from '../src/betika/executor.js';
import { accountData } from '../src/dashboard.js';
import { Store } from '../src/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
const write = (name, text) => fs.writeFileSync(path.join(dir, `.env.${name}`), text);
const quiet = { info() {}, warn() {}, error() {} };

test('account settings: login, stake and limits from .env.NAME; everything else shared; clear errors', () => {
  const base = makeSettings({ minEv: 0.03, betikaFixedStake: 40, betikaSessionDir: '.betika-session', storePath: 'ev-bot-store.json' });
  write('dad', 'BETIKA_PHONE=0712000000\nBETIKA_PASSWORD="secret"   # comment\nBETIKA_FIXED_STAKE=20\nBETIKA_LIVE=true\n');
  const a = accountSettings(base, 'dad', dir);
  assert.deepEqual([a.account, a.betikaPhone, a.betikaPassword, a.betikaFixedStake, a.betikaLive, a.minEv], ['dad', '0712000000', 'secret', 20, true, 0.03]);
  assert.deepEqual([a.betikaSessionDir, a.storePath], ['.betika-session-dad', 'ev-bot-store-dad.json']);
  write('bad', 'BETIKA_PHONE=1\nBETIKA_PASSWORD=2\nMIN_EV=0.5\n');
  assert.throws(() => accountSettings(base, 'bad', dir), /MIN_EV can only be set in the main .env/);
  write('nologin', 'BETIKA_FIXED_STAKE=20\n');
  assert.throws(() => accountSettings(base, 'nologin', dir), /set BETIKA_PHONE and BETIKA_PASSWORD/);
  assert.throws(() => accountSettings(base, 'missing', dir), SettingsError);
  assert.throws(() => accountSettings(base, '../x', dir), /not a usable account name/);
});

test('multi-account: every pick goes to each account with its own stake, limits and bet log', async () => {
  const sent = [];
  const client = (who) => ({ placeBet: async (b) => { sent.push([who, b.stake, b.live]); return { status: b.live ? 'placed' : 'dry_run', odds: 2.2 }; } });
  const main = new BetikaExecutor(makeSettings({ betikaLive: false, betikaFixedStake: 40, winningsTax: {} }), client('main'), new Store(':memory:'), { log: quiet, notify: async () => {} });
  const dadS = makeSettings({ betikaLive: true, betikaFixedStake: 20, betikaMaxBetsPerDay: 1, winningsTax: {} });
  dadS.account = 'dad';
  const dad = new BetikaExecutor(dadS, client('dad'), new Store(':memory:'), { log: quiet, notify: async () => {} });
  const multi = new MultiExecutor(main, [dad], quiet);
  multi.pausedStrategy = () => null;
  const opp = (id) => ({ book: 'betika', fairProb: 0.5, ev: 0.1, decimal: 2.2, stake: 40, eventId: id, market: 'h2h', outcome: 'A', homeTeam: 'A', awayTeam: 'B',
    betikaRef: { parentMatchId: id, home: 'A', away: 'B', swapped: false } });
  await multi.execute(opp('1'));
  await multi.execute(opp('2'));                                   // dad's 1-bet daily limit is reached
  assert.deepEqual(sent, [['main', 40, false], ['dad', 20, true], ['main', 40, false]]);
  assert.equal(main.store.data.bets.length, 2);
  assert.equal(dad.store.data.bets.length, 1);
  assert.equal(multi.extraStores[0], dad.store);
  assert.ok(dad.pausedStrategy);                                   // the guard reaches every account
});

test('dashboard: each account shows its own bets, balance and real-money switch', () => {
  const mk = (bal, live) => { const st = new Store(':memory:'); st.data.balance = { amount: bal, at: new Date().toISOString() }; return { store: st, s: makeSettings({ betikaLive: live }) }; };
  const accts = [{ name: 'main', ...mk(345, true) }, { name: 'dad', ...mk(900, false) }];
  const state = { mode: { betikaLive: true }, opportunities: [] };
  const d = accountData(accts, 'dad', state);
  assert.deepEqual([d.account, d.accounts, d.balance, d.mode.betikaLive], ['dad', ['main', 'dad'], 900, false]);
  assert.equal(accountData(accts, null, state).balance, 345);       // main by default
  assert.equal(accountData(accts, 'nobody', state).account, 'main');
});
