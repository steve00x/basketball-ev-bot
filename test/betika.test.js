import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BetikaAPI, parseEat, parseListings } from '../src/betika/api.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { attachBetikaOdds, betikaPick } from '../src/betika/odds.js';
import { DemoBetikaFeed, DemoBetikaPlacer, bookPlan, loadDemoEvents, runCycle } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { Notifier } from '../src/notifier.js';
import { afterTax, beforeTax } from '../src/oddsMath.js';
import { scanEvent } from '../src/scanner.js';
import { Store } from '../src/store.js';
import { findRow, teamSimilarity } from '../src/teamMatch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));
const REAL_219 = fixture('betika-api-219.json'); // real api.betika.com responses, 2026-11-23
const REAL_225 = fixture('betika-api-225.json');
const quiet = { info() {}, warn() {}, error() {} };

test('parses real Betika API responses', () => {
  const ms = parseListings(REAL_219, REAL_225);
  const philly = ms.find((m) => m.home === 'Philadelphia');
  assert.deepEqual([philly.away, philly.competition, philly.parentMatchId], ['Portland', 'NBA', '73719748']);
  assert.deepEqual(philly.winner, [1.64, 2.32]);
  assert.equal(philly.start.toISOString(), '2026-11-24T00:00:00.000Z'); // 03:00 EAT
  assert.deepEqual(philly.totals[0], { point: 228.5, over: 1.7, under: 2.22 });
  assert.equal(philly.totals.length, 7);
});

test('BetikaAPI paginates and merges both markets', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.searchParams.get('sub_type_id') === '219' ? REAL_219 : REAL_225;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const ms = await new BetikaAPI({ fetchImpl }).basketball();
  assert.equal(ms.length, 7);
  assert.deepEqual(calls.map((u) => u.searchParams.get('sport_id')), ['30', '30']);
});

test('parseEat', () => assert.equal(parseEat('2026-11-24 03:30:00').toISOString(), '2026-11-24T00:30:00.000Z'));

test('team matching with Betika short names', () => {
  assert.equal(teamSimilarity('Philadelphia', 'Philadelphia 76ers'), 0.9);
  assert.equal(teamSimilarity('Oklahoma', 'Oklahoma City Thunder'), 0.9);
  assert.equal(teamSimilarity('LA Lakers', 'Los Angeles Lakers'), 1);
  assert.ok(teamSimilarity('Los Angeles Clippers', 'Los Angeles Lakers') < 0.75);
  const ev = { home_team: 'New York Knicks', away_team: 'Denver Nuggets' };
  assert.equal(findRow(ev, [{ home: 'Denver', away: 'New York' }]).swapped, true);
});

const sharpEvent = (over = {}) => ({
  id: 'ev1', sport_key: 'basketball_nba', home_team: 'Philadelphia 76ers', away_team: 'Portland Trail Blazers',
  commence_time: '2026-11-24T00:10:00Z',
  bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: '2026-11-23T15:00:00Z', markets: [
    { key: 'h2h', outcomes: [{ name: 'Philadelphia 76ers', price: 1.55 }, { name: 'Portland Trail Blazers', price: 2.6 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: 1.95, point: 228.5 }, { name: 'Under', price: 1.95, point: 228.5 }] }] }],
  ...over,
});

test('attach real Betika odds: competition, time window and the Charlotte trap', () => {
  const ms = parseListings(REAL_219, REAL_225);
  const ev = sharpEvent();
  const hornets = { ...sharpEvent(), id: 'ev2', home_team: 'Charlotte Hornets', away_team: 'Memphis Grizzlies' };
  const r = attachBetikaOdds([ev, hornets], ms, new Date('2026-11-23T15:00:00Z'));
  assert.equal(r.matched, 2);
  assert.equal(ev.betikaRef.parentMatchId, '73719748');
  const bk = ev.bookmakers.find((b) => b.key === 'betika');
  assert.deepEqual(bk.markets.map((m) => m.key), ['h2h', 'totals']);
  assert.equal(hornets.betikaRef.home, 'Charlotte'); // the NBA game, not NCAA "Charlotte"
  assert.notEqual(ms.find((m) => m.parentMatchId === hornets.betikaRef.parentMatchId).competition, 'NCAA, Regular Season');

  const late = sharpEvent({ commence_time: '2026-11-24T04:00:00Z' }); // 4h off: different game
  assert.equal(attachBetikaOdds([late], ms).matched, 0);
});

test('tax: 20% on winnings turns a raw edge into a loss', () => {
  assert.ok(Math.abs(afterTax(2.32, 0.2) - 2.056) < 1e-9);
  assert.ok(Math.abs(beforeTax(afterTax(2.32, 0.2), 0.2) - 2.32) < 1e-9);
  const ms = parseListings(REAL_219, REAL_225);
  const ev = sharpEvent();
  attachBetikaOdds([ev], ms, new Date('2026-11-23T15:00:00Z'));
  const now = new Date('2026-11-23T15:00:30Z');
  const noTax = scanEvent(ev, makeSettings({ targetBooks: ['betika'], winningsTax: {}, maxLineAgeSeconds: 1e9 }), now);
  assert.ok(noTax.some((o) => o.outcome === 'Under' && o.point === 228.5)); // 2.22 vs fair 2.0
  const taxed = scanEvent(ev, makeSettings({ targetBooks: ['betika'], maxLineAgeSeconds: 1e9 }), now);
  assert.deepEqual(taxed, []); // after tax 2.22 pays 1.976 < 2.0
});

test('betikaPick maps outcomes to match-page buttons', () => {
  const ref = { parentMatchId: '1', swapped: false };
  const o = { market: 'h2h', outcome: 'H', homeTeam: 'H', betikaRef: ref };
  assert.deepEqual(betikaPick(o), { market: 'Winner (Incl. Overtime)', label: '1' });
  assert.equal(betikaPick({ ...o, outcome: 'A' }).label, '2');
  assert.equal(betikaPick({ ...o, betikaRef: { ...ref, swapped: true } }).label, '2');
  assert.deepEqual(betikaPick({ ...o, market: 'totals', outcome: 'Under', point: 228.5 }), { market: 'Total (Incl. Overtime)', label: 'Under 228.5' });
  assert.equal(betikaPick({ ...o, market: 'spreads' }), null);
});

test('bookPlan only buys sharp books when betting Betika', () => {
  assert.deepEqual(bookPlan(makeSettings({ betikaEnabled: true })), { apiBooks: ['pinnacle'], scanTargets: ['betika'] });
});

test('demo cycle: tax-aware bets, dry run, de-dup', async () => {
  const s = makeSettings({ betikaEnabled: true, bankroll: 20000 });
  const store = new Store(':memory:');
  const feed = new DemoBetikaFeed();
  const executor = new BetikaExecutor(s, new DemoBetikaPlacer(feed), store, { log: quiet });
  const run = () => runCycle({ events: loadDemoEvents(), s, store, notifier: new Notifier(s, { quiet: true }), betika: feed, executor, log: quiet });
  const first = await run();
  assert.deepEqual(first.opps.map((o) => [o.outcome, o.market]).sort(), [['Los Angeles Lakers', 'h2h'], ['Under', 'totals']]);
  assert.deepEqual(first.results.map((r) => r.result.status), ['dry_run', 'dry_run']);
  assert.equal((await run()).opps.length, 0);
});

const fakeOpp = (over = {}) => ({ book: 'betika', market: 'h2h', eventId: 'e', description: null, outcome: 'H', point: null,
  homeTeam: 'H', awayTeam: 'A', fairProb: 0.5, decimal: 2.7, winningsTax: 0.2, ev: 0.1, stake: 300,
  betikaRef: { parentMatchId: 'p1', home: 'H', away: 'A', swapped: false }, ...over });

test('executor: tax-adjusted price floor, limits, halting', async () => {
  const s = makeSettings({ betikaLive: true, betikaMaxStake: 250, betikaDailyStakeLimit: 600, minEv: 0.02 });
  const sent = [];
  let status = 'placed';
  const client = { async placeBet(b) { sent.push(b); return { status, odds: 2.7 }; } };
  const ex = new BetikaExecutor(s, client, new Store(':memory:'), { log: quiet });
  assert.equal((await ex.execute(fakeOpp({ eventId: 1 }))).status, 'placed');
  // fair 2.0 + 2% => 2.04 after tax => 2.30 posted
  assert.deepEqual([sent[0].minEffectiveOdds, sent[0].minOdds, sent[0].stake, sent[0].label], [2.04, 2.3, 250, '1']);
  assert.equal((await ex.execute(fakeOpp({ eventId: 1 }))).reason, 'already_bet');
  await ex.execute(fakeOpp({ eventId: 2 }));
  assert.equal((await ex.execute(fakeOpp({ eventId: 3 }))).reason, 'daily_stake_limit');
  assert.equal((await ex.execute(fakeOpp({ eventId: 4, stake: 5 }))).reason, 'stake_too_small');
  assert.equal((await ex.execute(fakeOpp({ eventId: 5, market: 'spreads' }))).reason, 'unsupported_market');

  // No confirmation: that match counts as possibly placed (never retried), others continue.
  const ex2 = new BetikaExecutor(makeSettings({ betikaLive: true }), client, new Store(':memory:'), { log: quiet });
  status = 'unknown';
  await ex2.execute(fakeOpp({ eventId: 9 }));
  assert.equal(ex2.halted, false);
  assert.equal((await ex2.execute(fakeOpp({ eventId: 9 }))).reason, 'already_bet');
  status = 'placed';
  assert.equal((await ex2.execute(fakeOpp({ eventId: 10 }))).status, 'placed');
});

test('dry runs do not consume limits; errors restart the browser, 3 in a row pause then resume', async () => {
  const s = makeSettings({ betikaLive: false, betikaMaxBetsPerDay: 1, betikaErrorPauseMinutes: 15 });
  const ok = new BetikaExecutor(s, { placeBet: async () => ({ status: 'dry_run' }) }, new Store(':memory:'), { log: quiet });
  for (let i = 0; i < 3; i++) assert.equal((await ok.execute(fakeOpp({ eventId: i }))).status, 'dry_run');

  let fail = true, closes = 0;
  const flaky = { placeBet: async () => { if (fail) throw new Error('boom'); return { status: 'dry_run' }; }, close: async () => { closes++; } };
  const ex = new BetikaExecutor(s, flaky, new Store(':memory:'), { log: quiet });
  await ex.execute(fakeOpp({ eventId: 'a' }));
  fail = false;
  assert.equal((await ex.execute(fakeOpp({ eventId: 'b' }))).status, 'dry_run'); // one failure doesn't stop the next match
  fail = true;
  for (const id of ['c', 'd', 'e']) await ex.execute(fakeOpp({ eventId: id }));
  assert.equal(closes, 4); // browser restarted after every error
  assert.equal(ex.halted, false);
  fail = false;
  assert.equal((await ex.execute(fakeOpp({ eventId: 'f' }))).reason, 'paused_after_errors');
  ex.pausedUntil = Date.now() - 1; // 15 minutes later...
  assert.equal((await ex.execute(fakeOpp({ eventId: 'f' }))).status, 'dry_run');
});

test('executor halts when Betika confirms a different stake; logs ticket and balance', async () => {
  const s = makeSettings({ betikaLive: true });
  const logs = [];
  const log = { info: (m) => logs.push(m), warn() {}, error: (m) => logs.push(m) };
  const ok = { async placeBet(b) { return { status: 'placed', odds: 2.7, betId: 'LDCH8C', balanceAfter: 1243.79, confirmedStake: b.stake }; } };
  const ex = new BetikaExecutor(s, ok, new Store(':memory:'), { log });
  await ex.execute(fakeOpp({ eventId: 'a', stake: 20 }));
  assert.equal(ex.halted, false);
  assert.ok(logs.some((m) => /PLACED ticket LDCH8C/.test(m) && /balance KES 1243.79/.test(m)), logs.join('\n'));

  const bad = { async placeBet() { return { status: 'placed', odds: 2.7, betId: 'X1', confirmedStake: 500, stakeMismatch: true }; } };
  const ex2 = new BetikaExecutor(s, bad, new Store(':memory:'), { log });
  await ex2.execute(fakeOpp({ eventId: 'b', stake: 20 }));
  assert.equal(ex2.halted, true);
});

test('unmatched reasons: missing game vs. similar names', () => {
  const at = new Date(Date.now() + 3600e3);
  const ev = (home, away) => ({ id: home, sport_key: 'basketball_nba', home_team: home, away_team: away, commence_time: at.toISOString(), bookmakers: [] });
  const betika = [{ parentMatchId: 'c', home: 'Chicago', away: 'Cleveland', competition: 'NBA', start: at, winner: [2, 2], totals: [] },
    { parentMatchId: 'h', home: 'Houston', away: 'LAC Clips', competition: 'NBA', start: at, winner: [2, 2], totals: [] }];
  const r = attachBetikaOdds([ev('Sacramento Kings', 'San Antonio Spurs'), ev('Houston Rockets', 'Los Angeles Clippers')], betika);
  assert.equal(r.unmatched[0], 'San Antonio Spurs @ Sacramento Kings (not on Betika right now)');
  assert.match(r.unmatched[1], /names did not match - Betika has "Houston v LAC Clips"/);
});

test('NCAAB and EuroLeague name styles (Betika short vs Odds API long)', () => {
  const pairs = [
    // [Odds API style, Betika style as seen on api.betika.com]
    ['Indiana St Sycamores', 'Indiana State'], ['Wright St Raiders', 'Wright'], ['St. Bonaventure Bonnies', 'St Bonaventure'],
    ['Appalachian St Mountaineers', 'Appalachian State'], ['William & Mary Tribe', 'William And Mary'],
    ['Florida Int\'l Golden Panthers', 'Florida Int.'], ['Ole Miss Rebels', 'Mississippi'], ['BYU Cougars', 'Brigham'],
    ['Stephen F. Austin Lumberjacks', 'SFA Lumberjacks'], ['Akron Zips', 'Akron Zips'], ['Temple Owls', 'Temple Owls'],
    ['Crvena Zvezda', 'CZ MTS'], ['Bayern Munich', 'B. Munich'], ['Olympiacos', 'Olympiakos Piraeus'],
    ['Partizan Belgrade', 'KK Partizan'], ['Maccabi Tel Aviv', 'Maccabi Tel-Aviv'], ['Virtus Bologna', 'Bologna'],
    ['Paris Basketball', 'Paris Basketball'], ['Valencia Basket', 'Valencia'], ['Panathinaikos', 'Panathinaikos'],
  ];
  for (const [odds, betika] of pairs) assert.ok(teamSimilarity(odds, betika) >= 0.75, `${odds} vs ${betika}: ${teamSimilarity(odds, betika)}`);
  // must stay apart
  for (const [a, b] of [['Georgia St Panthers', 'Georgia Bulldogs'], ['Maccabi Tel Aviv', 'Hapoel Tel-Aviv'], ['Los Angeles Clippers', 'LA Lakers']]) {
    assert.ok(teamSimilarity(a, b) < 0.75, `${a} vs ${b}: ${teamSimilarity(a, b)}`);
  }
});

test('BETIKA_FIXED_STAKE: every bet is the same stake, small edges included', async () => {
  const s = makeSettings({ betikaLive: true, betikaFixedStake: 40, betikaMaxStake: 10, betikaDailyStakeLimit: 100 });
  const sent = [];
  const client = { async placeBet(b) { sent.push(b.stake); return { status: 'placed', odds: 2.7, confirmedStake: b.stake }; } };
  const ex = new BetikaExecutor(s, client, new Store(':memory:'), { log: quiet });
  await ex.execute(fakeOpp({ eventId: 1, stake: 2.86 })); // Kelly said 2.86: would have been skipped
  await ex.execute(fakeOpp({ eventId: 2, stake: 300 }));  // Kelly said 300: not capped at 10
  assert.deepEqual(sent, [40, 40]);
  assert.equal((await ex.execute(fakeOpp({ eventId: 3 }))).reason, 'daily_stake_limit'); // 80 + 40 > 100
});

test('an opportunity alerted earlier but not bet is retried on later scans', async () => {
  const store = new Store(':memory:');
  const feed = new DemoBetikaFeed();
  const placer = new DemoBetikaPlacer(feed);
  const run = (s) => runCycle({ events: loadDemoEvents(), s, store, notifier: new Notifier(s, { quiet: true }), betika: feed,
    executor: new BetikaExecutor(s, placer, store, { log: quiet }), log: quiet });
  const small = makeSettings({ betikaEnabled: true, betikaLive: true, bankroll: 100 }); // Kelly stakes < KES 10: skipped
  const first = await run(small);
  assert.ok(first.results.every((r) => r.result.reason === 'stake_too_small'));
  placer.placeBet = async (b) => ({ status: 'placed', odds: 2.6, confirmedStake: b.stake });
  const second = await run({ ...small, betikaFixedStake: 40 });
  assert.equal(second.opps.length, 0); // no new alerts...
  assert.ok(second.results.length >= 1 && second.results.every((r) => r.result.status === 'placed')); // ...but bets placed
  const third = await run({ ...small, betikaFixedStake: 40 });
  assert.ok(third.results.every((r) => r.result.reason === 'already_bet')); // never twice
});

test('each scan logs a betting summary, including bets already placed', async () => {
  const store = new Store(':memory:');
  const feed = new DemoBetikaFeed();
  const placer = new DemoBetikaPlacer(feed);
  placer.placeBet = async (b) => ({ status: 'placed', odds: 2.6, confirmedStake: b.stake });
  const s = makeSettings({ betikaEnabled: true, betikaLive: true, betikaFixedStake: 40 });
  const lines = [];
  const log = { info: (m) => lines.push(m), warn() {}, error() {} };
  const run = () => runCycle({ events: loadDemoEvents(), s, store, notifier: new Notifier(s, { quiet: true }), betika: feed,
    executor: new BetikaExecutor(s, placer, store, { log: quiet }), log });
  await run();
  assert.ok(lines.some((m) => /^betika: 2 placed$/.test(m)), lines.join('\n'));
  lines.length = 0;
  await run();
  assert.ok(lines.some((m) => /^betika: 2 already bet \(already bet: .*Los Angeles Lakers/.test(m)), lines.join('\n'));
});
