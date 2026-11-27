import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OdiBetsClient, attachOdiBets, odibetsPickFor, toMarkets } from '../src/books/odibets.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { runCycle } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {} };
const o = (sub, spec, key, name, id, odds) => ({ sub_type_id: sub, outcome_key: key, outcome_name: name, outcome_id: id, specifiers: spec, odd_value: odds, active: '1', status: '1' });
// shapes seen on odibets.com (2026-11-27)
const nba = { info: { parent_match_id: '9001', sport_id: '2' }, markets: [
  { sub_type_id: '1', specifiers: '', status: '1', outcomes: [o('1', '', '1', 'New York Knicks', '1', '1.67'), o('1', '', 'X', 'draw', '2', '18.00'), o('1', '', '2', 'Miami Heat', '3', '2.45')] },
  { sub_type_id: '18', specifiers: 'total=220.5', status: '1', outcomes: [o('18', 'total=220.5', 'over 220.5', 'over 220.5', '12', '1.69'), o('18', 'total=220.5', 'under 220.5', 'under 220.5', '13', '2.04')] },
  { sub_type_id: '219', specifiers: '', status: '1', outcomes: [o('219', '', '1', 'New York Knicks', '4', '1.62'), o('219', '', '2', 'Miami Heat', '5', '2.37')] },
  { sub_type_id: '223', specifiers: 'hcp=-7.5', status: '1', outcomes: [o('223', 'hcp=-7.5', '1 (-7.5)', 'New York Knicks (-7.5)', '1714', '2.31'), o('223', 'hcp=-7.5', '2 (+7.5)', 'Miami Heat (+7.5)', '1715', '1.54')] },
  { sub_type_id: '225', specifiers: 'total=221.5', status: '1', outcomes: [o('225', 'total=221.5', 'over 221.5', 'over 221.5', '12', '1.74'), o('225', 'total=221.5', 'under 221.5', 'under 221.5', '13', '2.07')] },
  { sub_type_id: '227', specifiers: 'total=112.5', status: '1', outcomes: [o('227', 'total=112.5', 'over 112.5', 'over 112.5', '12', '1.75'), o('227', 'total=112.5', 'under 112.5', 'under 112.5', '13', '2.01')] },
] };

test('OdiBets basketball: only overtime-inclusive markets; regulation 1X2 and total are left out', () => {
  const m = Object.fromEntries(toMarkets(nba, 'basketball', 'New York Knicks', 'Miami Heat').map((x) => [x.key, x.outcomes]));
  assert.deepEqual(Object.keys(m).sort(), ['h2h', 'spreads', 'team_totals', 'totals']);
  assert.deepEqual(m.h2h.map((x) => [x.name, x.price]), [['New York Knicks', 1.62], ['Miami Heat', 2.37]]); // 219, not the 3-way 1X2
  assert.deepEqual(m.totals.map((x) => x.point), [221.5, 221.5]);                                         // 225 only (incl. OT), not 220.5
  assert.deepEqual(m.spreads.map((x) => [x.name, x.point, x.ref.oid, x.ref.spec]), [['New York Knicks', -7.5, '1714', 'hcp=-7.5'], ['Miami Heat', 7.5, '1715', 'hcp=-7.5']]);
  assert.equal(m.team_totals[0].description, 'New York Knicks');
});

test('OdiBets football: 1X2, double chance, draw no bet, totals, BTTS', () => {
  const g = { info: { parent_match_id: '72221428', sport_id: '1' }, markets: [
    { sub_type_id: '1', specifiers: '', outcomes: [o('1', '', '1', 'Nottingham Forest', '1', '2.70'), o('1', '', 'X', 'draw', '2', '3.50'), o('1', '', '2', 'Chelsea FC', '3', '2.70')] },
    { sub_type_id: '10', specifiers: '', outcomes: [o('10', '', '1 or X', 'Nottingham Forest or draw', '9', '1.48'), o('10', '', 'X or 2', 'draw or Chelsea FC', '11', '1.49'), o('10', '', '1 or 2', 'x', '10', '1.33')] },
    { sub_type_id: '11', specifiers: '', outcomes: [o('11', '', '1', 'Nottingham Forest', '4', '1.92'), o('11', '', '2', 'Chelsea FC', '5', '1.93')] },
    { sub_type_id: '18', specifiers: 'total=2.5', outcomes: [o('18', 'total=2.5', 'over 2.5', 'over 2.5', '12', '1.74'), o('18', 'total=2.5', 'under 2.5', 'under 2.5', '13', '2.02')] },
    { sub_type_id: '29', specifiers: '', outcomes: [o('29', '', 'yes', 'yes', '74', '1.59'), o('29', '', 'no', 'no', '76', '2.21')] },
  ] };
  const m = Object.fromEntries(toMarkets(g, 'soccer', 'Nottingham Forest', 'Chelsea').map((x) => [x.key, x.outcomes]));
  assert.deepEqual(m.h2h.map((x) => x.name), ['Nottingham Forest', 'Draw', 'Chelsea']);
  assert.deepEqual(m.double_chance.map((x) => x.code), ['HD', 'DA', 'HA']);
  assert.deepEqual(m.totals.map((x) => [x.name, x.point]), [['Over', 2.5], ['Under', 2.5]]);
  assert.deepEqual(m.soccer_props.map((x) => [x.betikaLabel, x.rule.btts]), [['YES', true], ['NO', false]]);
});

test('OdiBets end to end: matched, priced against Pinnacle, price re-checked; always a dry run for now', async () => {
  const now = new Date('2026-11-27T10:00:00Z');
  const iso = now.toISOString();
  const calls = [];
  const site = {
    games: async (sport) => (sport === 'basketball' ? [{ sport, gameId: '9001', home: 'New York Knicks', away: 'Miami Heat', start: new Date('2026-11-28T00:30:00Z'), competition: 'NBA' }] : []),
    game: async (id, sport, { only } = {}) => { calls.push(only ?? 'all'); return nba; },
  };
  const ev = { id: 'e1', sport_key: 'basketball_nba', home_team: 'New York Knicks', away_team: 'Miami Heat', commence_time: '2026-11-28T00:30:00Z',
    bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: iso, markets: [{ key: 'h2h', last_update: iso, outcomes: [{ name: 'New York Knicks', price: 1.75 }, { name: 'Miami Heat', price: 2.15 }] }] }] };
  await attachOdiBets([ev], site, now, quiet);
  assert.ok(ev.bookmakers.some((b) => b.key === 'odibets'));
  const s = makeSettings({ betikaEnabled: false, ownFeedBooks: ['odibets'], minEv: 0.02, winningsTax: {}, maxLineAgeSeconds: 300, altTotals: false, teamTotals: false, soccerModel: false });
  const ex = new BetikaExecutor({ ...s, betikaLive: true, betikaFixedStake: 40 }, new OdiBetsClient(site, { log: quiet }), new Store(':memory:'),
    { log: quiet, book: 'odibets', title: 'OdiBets', pickFor: odibetsPickFor });
  const r = await runCycle({ events: [ev], s, store: new Store(':memory:'), notifier: { sendOpportunities: async () => {} }, executors: { odibets: ex }, log: quiet, now });
  // Pinnacle 1.75 / 2.15 -> fair Heat ~45%; OdiBets 2.37 = +6%
  const heat = r.results.find((x) => x.opp.outcome === 'Miami Heat');
  assert.equal(heat?.result.status, 'dry_run', JSON.stringify(r.results.map((x) => [x.opp.outcome, x.result])));
  assert.equal(calls.at(-1), '219');                         // price re-checked for that one market type
});
