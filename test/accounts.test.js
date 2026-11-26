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
  assert.deepEqual(sent.map(String).sort(), [['dad', 20, true], ['main', 40, false], ['main', 40, false]].map(String).sort());
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
  // the main account's pause is not shown on dad's view, dad's own is
  const paused = { ...state, pausedUntil: new Date(Date.now() + 600_000).toISOString(), accountState: { dad: { pausedUntil: null, halted: null } } };
  assert.ok(accountData(accts, 'main', paused).warnings.some((w) => /paused after errors/.test(w.title)));
  assert.ok(!accountData(accts, 'dad', paused).warnings.some((w) => /paused after errors/.test(w.title)));
});

test('multi-account: accounts place at the same time, not one after another', async () => {
  const slow = (who, log) => ({ placeBet: async () => { log.push(`${who} start`); await new Promise((r) => setTimeout(r, 50)); log.push(`${who} end`); return { status: 'dry_run', odds: 2.2 }; } });
  const log = [];
  const mk = (who) => { const s = makeSettings({ betikaLive: false, betikaFixedStake: 40, winningsTax: {} }); s.account = who;
    return new BetikaExecutor(s, slow(who, log), new Store(':memory:'), { log: quiet, notify: async () => {} }); };
  const multi = new MultiExecutor(mk('main'), [mk('dad')], quiet);
  multi.pausedStrategy = () => null;
  await multi.execute({ book: 'betika', fairProb: 0.5, ev: 0.1, decimal: 2.2, stake: 40, eventId: 'z', market: 'h2h', outcome: 'A', homeTeam: 'A', awayTeam: 'B',
    betikaRef: { parentMatchId: 'z', home: 'A', away: 'B', swapped: false } });
  assert.deepEqual(log.slice(0, 2).sort(), ['dad start', 'main start']);   // both started before either finished
});

test('several sportsbooks: each gets its own picks, and all books place at the same time', async () => {
  const { runCycle } = await import('../src/bot.js');
  const now = new Date(Date.now() + 0);
  const start = new Date(Date.now() + 3 * 3600_000).toISOString();
  const iso = now.toISOString();
  const book = (key, price, other = 1.5) => ({ key, title: key, last_update: iso, markets: [{ key: 'h2h', last_update: iso, outcomes: [{ name: 'A', price }, { name: 'B', price: other }] }] });
  const events = [{ id: 'e1', sport_key: 'basketball_nba', home_team: 'A', away_team: 'B', commence_time: start,
    betikaRef: { parentMatchId: '1', home: 'A', away: 'B', swapped: false },
    bookmakers: [book('pinnacle', 1.95, 1.95), book('betika', 2.3), book('odibets', 2.25)] }];  // fair 50%: +15% / +12.5%
  const log = [];
  const fake = (name) => ({ store: new Store(':memory:'), check: () => null,
    execute: async (o) => { log.push(`${name} start ${o.book}`); await new Promise((r) => setTimeout(r, 40)); log.push(`${name} end`); return { status: 'dry_run' }; } });
  const s = makeSettings({ betikaEnabled: true, ownFeedBooks: ['odibets'], minEv: 0.02, winningsTax: {}, maxLineAgeSeconds: 300, altTotals: false, teamTotals: false, soccerModel: false });
  const store = new Store(':memory:');
  await runCycle({ events, s, store, notifier: { sendOpportunities: async () => {} }, betika: null, executor: fake('betika'),
    executors: { odibets: fake('odibets') }, log: quiet, now });
  assert.deepEqual(log.slice(0, 2).sort(), ['betika start betika', 'odibets start odibets']); // both before either finished
  assert.equal(log.length, 4);
});
