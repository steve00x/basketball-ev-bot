import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SportPesaClient, attachSportPesa, classifySportPesa, sportpesaPickFor, toMarkets } from '../src/books/sportpesa.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { runCycle } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { gradePick } from '../src/settle.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {} };
// shapes from the recorded /api/games/markets?games=9537917&markets=all (2026-11-27)
const sel = (id, name, odds, shortName, specValue = 0) => ({ id, name, odds, shortName, specValue });
const bball = [
  { id: 382, specValue: 0, name: '2 Way - OT incl.', selections: [sel(1, 'UC Davis Aggies', '2.10', '1'), sel(2, 'Jacksonville State Gamecocks', '1.51', '2')] },
  { id: 51, specValue: 2.5, name: 'Handicap - OT incl.', selections: [sel(3, 'UC Davis Aggies [+2.50]', '1.80', '1', 2.5), sel(4, 'Jacksonville State Gamecocks [-2.50]', '1.68', '2', 2.5)] },
  { id: 52, specValue: 137.5, name: 'Total Points - OT incl.', selections: [sel(5, 'Over 137.5', '1.90', 'ov', 137.5), sel(6, 'Under 137.5', '1.85', 'un', 137.5)] },
  { id: 353, specValue: 67.5, name: 'Home Team Over/Under Total Points - Full Time OT incl', selections: [sel(7, 'Over 67.5', '1.87', 'ov', 67.5), sel(8, 'Under 67.5', '1.87', 'un', 67.5)] },
  { id: 54, specValue: 64.5, name: 'Total Points - First Half', selections: [sel(9, 'Over 64.5', '1.85', 'ov', 64.5), sel(10, 'Under 64.5', '1.9', 'un', 64.5)] },
].map((m) => ({ ...m, gameId: 9537917 }));
const soccer = [
  { id: 10, specValue: 0, name: '1X2', selections: [sel(11, 'Nottingham', '3.40', '1'), sel(12, 'Draw', '3.50', 'X'), sel(13, 'Chelsea', '2.15', '2')] },
  { id: 46, specValue: 0, name: 'Double Chance', selections: [sel(14, '1 or X', '1.70', '1X'), sel(15, 'X or 2', '1.33', 'X2'), sel(16, '1 or 2', '1.30', '12')] },
  { id: 52, specValue: 2.5, name: 'Over/Under 2.5', selections: [sel(17, 'Over 2.5', '1.80', 'ov', 2.5), sel(18, 'Under 2.5', '2.00', 'un', 2.5)] },
  { id: 43, specValue: 0, name: 'Both Teams To Score', selections: [sel(19, 'Yes', '1.70', 'GG'), sel(20, 'No', '2.05', 'NG')] },
].map((m) => ({ ...m, gameId: 9466503 }));

test('SportPesa markets: same settlement as Pinnacle, each price with its selection id', () => {
  const b = Object.fromEntries(toMarkets(bball, 'basketball', 'UC Davis Aggies', 'Jacksonville St Gamecocks').map((m) => [m.key, m.outcomes]));
  assert.deepEqual(Object.keys(b).sort(), ['h2h', 'spreads', 'team_totals', 'totals']);    // 1st half total left out (Betika-history only)
  assert.deepEqual(b.spreads.map((o) => [o.name, o.point, o.price, o.ref.sel]), [['UC Davis Aggies', 2.5, 1.8, 3], ['Jacksonville St Gamecocks', -2.5, 1.68, 4]]);
  assert.deepEqual(b.team_totals.map((o) => [o.description, o.name, o.point]), [['UC Davis Aggies', 'Over', 67.5], ['UC Davis Aggies', 'Under', 67.5]]);
  const s = Object.fromEntries(toMarkets(soccer, 'soccer', 'Nottingham Forest', 'Chelsea').map((m) => [m.key, m.outcomes]));
  assert.deepEqual(s.h2h.map((o) => o.name), ['Nottingham Forest', 'Draw', 'Chelsea']);
  assert.deepEqual(s.double_chance.map((o) => o.code), ['HD', 'DA', 'HA']);
  assert.deepEqual(s.soccer_props.map((o) => [o.betikaLabel, o.rule.btts, o.ref.sel]), [['YES', true, 19], ['NO', false, 20]]);
});

test('SportPesa bet replies (recorded): placed, rejected, anything else unknown', () => {
  const ok = { status: 200, json: { return_code: 0, msgtext: 'BET:7599 Amnt:KSH10.00, Possible Win:KSH18.12 S-PESA balance:KSH9.36', balance: 9.36,
    possible_win: 18.12, bet_id: 24459539626, short_bet_id: 7599, taxPercentage: 0, amountValue: 10 } };
  assert.deepEqual(['status', 'betId', 'balanceAfter', 'confirmedStake'].map((k) => classifySportPesa(ok, 10, 1.81)[k]), ['placed', '7599', 9.36, 10]);
  assert.equal(classifySportPesa(ok, 40, 1.81).stakeMismatch, true);
  assert.equal(classifySportPesa({ status: 200, json: { return_code: 3, msgtext: 'Odds changed' } }, 10, 1.8).status, 'rejected');
  assert.equal(classifySportPesa({ status: 401, json: null }, 10, 1.8).status, 'not_logged_in');
  assert.equal(classifySportPesa({ status: 200, json: { ok: true } }, 10, 1.8).status, 'unknown');
});

const fakeSite = (list, posted = []) => ({
  games: async (sport) => (sport === 'basketball' ? [{ sport, gameId: 9537917, home: 'UC Davis Aggies', away: 'Jacksonville State Gamecocks', start: new Date('2026-11-27T01:00:00Z'), competition: 'NCAA, Regular' }] : []),
  markets: async () => list,
  api: async (path, { body }) => { posted.push([path, body]); return { status: 200, json: { return_code: 0, bet_id: 1, short_bet_id: 77, balance: 50, amountValue: body.amount } }; },
});

test('SportPesa end to end: games matched, priced against Pinnacle, bet placed by selection id (dry run, then real)', async () => {
  const now = new Date('2026-11-26T20:00:00Z');
  const iso = now.toISOString();
  const ev = { id: 'e1', sport_key: 'basketball_ncaab', home_team: 'UC Davis Aggies', away_team: 'Jacksonville St Gamecocks', commence_time: '2026-11-27T01:00:00Z',
    bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: iso, markets: [
      { key: 'h2h', last_update: iso, outcomes: [{ name: 'UC Davis Aggies', price: 1.95 }, { name: 'Jacksonville St Gamecocks', price: 1.95 }] }] }] };
  const posted = [];
  const site = fakeSite(bball, posted);
  await attachSportPesa([ev], site, now, quiet);
  assert.ok(ev.bookmakers.some((b) => b.key === 'sportpesa'));
  const s = makeSettings({ betikaEnabled: false, ownFeedBooks: ['sportpesa'], minEv: 0.02, winningsTax: {}, maxLineAgeSeconds: 300, altTotals: false, teamTotals: false, soccerModel: false });
  const mk = (live) => new BetikaExecutor({ ...s, betikaLive: live, betikaFixedStake: 40 }, new SportPesaClient(site, { log: quiet }), new Store(':memory:'),
    { log: quiet, book: 'sportpesa', title: 'SportPesa', pickFor: sportpesaPickFor });
  const dry = mk(false);
  const r = await runCycle({ events: [ev], s, store: new Store(':memory:'), notifier: { sendOpportunities: async () => {} }, executors: { sportpesa: dry }, log: quiet, now });
  // fair 50% vs SportPesa 2.10 on UC Davis = +5%
  assert.deepEqual(r.results.map((x) => [x.opp.book, x.opp.outcome, x.result.status]), [['sportpesa', 'UC Davis Aggies', 'dry_run']]);
  assert.equal(posted.length, 0);
  const real = mk(true);
  await real.execute(r.results[0].opp);
  assert.deepEqual(posted, [['/api/bets/place', { amount: 40, bets: [{ id: 1, odds: '2.10', coeff: '2.10' }], acceptOdds: false, betSpinner: false }]]);
  assert.equal(real.store.data.bets[0].betId, '77');
  assert.equal(real.store.data.balance.amount, 50);
});

test('handicap bets settle from the final score', () => {
  const g = { market: 'spreads', homeTeam: 'H', awayTeam: 'A' };
  assert.equal(gradePick({ ...g, outcome: 'H', point: -8.5 }, 100, 90), 'won');
  assert.equal(gradePick({ ...g, outcome: 'H', point: -8.5 }, 100, 93), 'lost');
  assert.equal(gradePick({ ...g, outcome: 'A', point: 3 }, 93, 90), 'push');
});
