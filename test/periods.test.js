import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListings } from '../src/betika/api.js';
import { attachBetikaOdds, betikaPick } from '../src/betika/odds.js';
import { makeSettings } from '../src/config.js';
import { PeriodPrices } from '../src/periods.js';
import { scanEvent } from '../src/scanner.js';
import { pendingBets } from '../src/settle.js';
import { normCdf } from '../src/oddsMath.js';

// Betika listing rows as the API sends them (checked 2026-11-25), prices from a clean normal ladder
const ladder = (st, centre, sigma, points, margin = 1.06) => ({ sub_type_id: String(st), odds: points.flatMap((p) => {
  const pu = normCdf((p - centre) / sigma), po = 1 - pu;
  return [{ display: `OVER ${p}`, odd_key: `over ${p}`, odd_value: (1 / (po * margin)).toFixed(2), special_bet_value: `total=${p}` },
    { display: `UNDER ${p}`, odd_key: `under ${p}`, odd_value: (1 / (pu * margin)).toFixed(2), special_bet_value: `total=${p}` }];
}) });
const row = { parent_match_id: 73697026, match_id: 1, home_team: 'Philadelphia', away_team: 'Miami', start_time: '2026-11-26 01:00:00',
  competition_name: 'NBA', category: 'USA' };
const winner = { data: [{ ...row, odds: [{ sub_type_id: '219', odds: [{ display: '1', odd_value: '1.85' }, { display: '2', odd_value: '2.00' }] }] }] };
const totals = { data: [{ ...row, odds: [ladder(68, 124, 11, [118.5, 119.5, 120.5, 121.5, 122.5, 123.5, 124.5]),
  ladder(69, 61, 8, [58.5, 59.5, 60.5, 61.5, 62.5]), ladder(236, 61, 6, [61.5])] }] };

const NOW = new Date('2026-11-25T20:00:00Z');
const event = () => ({ id: 'nba1', sport_key: 'basketball_nba', home_team: 'Philadelphia 76ers', away_team: 'Miami Heat',
  commence_time: '2026-11-25T22:00:00Z', bookmakers: [] });

test('Betika 1st half / quarter ladders become totals_h1, team_totals_h1, totals_q1 with the right buttons', () => {
  const [m] = parseListings(winner, totals);
  assert.deepEqual(Object.keys(m.periods), ['h1', 'q1']);
  assert.equal(m.periods.h1.totals.length, 7);
  assert.equal(m.periods.h1.teamTotals.home.length, 5);
  const ev = event();
  attachBetikaOdds([ev], [m], NOW);
  const keys = ev.bookmakers[0].markets.map((x) => x.key);
  for (const k of ['totals_h1', 'team_totals_h1', 'totals_q1']) assert.ok(keys.includes(k), k);
  const base = { betikaRef: ev.betikaRef, homeTeam: ev.home_team, awayTeam: ev.away_team, betikaSport: 'basketball' };
  assert.deepEqual(betikaPick({ ...base, market: 'totals_h1', outcome: 'Over', point: 121.5 }), { market: '1st Half - Total', label: 'Over 121.5' });
  assert.deepEqual(betikaPick({ ...base, market: 'team_totals_h1', outcome: 'Under', point: 60.5, betikaTeam: 'Philadelphia' }),
    { market: '1st Half - Philadelphia Total', label: 'Under 60.5' });
  assert.deepEqual(betikaPick({ ...base, market: 'totals_q1', outcome: 'Over', point: 61.5 }), { market: '1st Quarter - Total', label: 'Over 61.5' });
});

test('scan: the same line is compared directly; other half lines priced from Pinnacle\'s line on Betika\'s ladder', () => {
  const [m] = parseListings(winner, totals);
  const ev = event();
  attachBetikaOdds([ev], [m], NOW);
  // Pinnacle's 1st half total: 121.5 at 1.80 / 2.05 -> fair Over ~53%; Betika's ladder is centred on 124
  ev.bookmakers.push({ key: 'pinnacle', title: 'Pinnacle', last_update: NOW.toISOString(), markets: [
    { key: 'totals_h1', last_update: NOW.toISOString(), outcomes: [{ name: 'Over', price: 2.05, point: 121.5 }, { name: 'Under', price: 1.80, point: 121.5 }] }] });
  const s = makeSettings({ targetBooks: ['betika'], winningsTax: {}, minEv: 0.02, altTotalsMinEv: 0.03, maxLineAgeSeconds: 300 });
  const opps = scanEvent(ev, s, NOW).filter((o) => o.market === 'totals_h1');
  // Pinnacle leans Under 121.5 while Betika's ladder is centred higher: Betika's Unders are the value
  assert.ok(opps.length > 0);
  assert.ok(opps.every((o) => o.outcome === 'Under'), JSON.stringify(opps.map((o) => [o.outcome, o.point, o.ev])));
  assert.ok(opps.some((o) => o.point === 121.5 && !o.model));             // exact line: direct comparison
  assert.ok(opps.some((o) => o.point !== 121.5 && o.model?.kind === 'alt-total')); // other lines: model
});

test('period prices: only games Betika lists them for, starting soon, not too often, within the credit budget', async () => {
  const [m] = parseListings(winner, totals);
  const soon = event(), later = { ...event(), id: 'nba2', commence_time: '2026-11-26T08:00:00Z' };
  attachBetikaOdds([soon], [m], NOW);
  attachBetikaOdds([later], [{ ...m }], NOW);
  const calls = [];
  const api = { lastCost: 2, getEventOdds: async (sport, id, markets) => { calls.push([id, markets]);
    return { bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'totals_h1', outcomes: [{ name: 'Over', price: 1.9, point: 121.5 }, { name: 'Under', price: 1.9, point: 121.5 }] }] }] }; } };
  const s = makeSettings({ periodMarkets: true, periodHoursBefore: 3, periodRefreshMinutes: 20, periodGamesPerScan: 3, periodDailyCredits: 3 });
  const pp = new PeriodPrices(api, s, { info() {}, warn() {} });
  const r = await pp.enrich([soon, later], +NOW);
  assert.deepEqual(calls.map((c) => c[0]), ['nba1']);                       // 'later' starts in 12 h
  assert.deepEqual(calls[0][1].sort(), ['team_totals_h1', 'totals_h1', 'totals_q1']);
  assert.deepEqual([r.got, r.asked], [1, 3]);
  assert.ok(soon.bookmakers.find((b) => b.key === 'pinnacle').markets.some((x) => x.key === 'totals_h1'));
  await pp.enrich([soon], +NOW + 5 * 60_000);                               // too soon again
  assert.equal(calls.length, 1);
  await pp.enrich([soon], +NOW + 25 * 60_000);                              // would pass 3 credits today
  assert.equal(calls.length, 1);
});

test('half / quarter bets are left to Betika\'s bet history, not graded from final scores', () => {
  const g = { sport: 'basketball_nba', eventId: 'x', commenceTime: '2026-11-20T00:00:00Z' };
  const bets = [{ live: true, status: 'placed', grade: { ...g, market: 'totals_h1' } }, { live: true, status: 'placed', grade: { ...g, market: 'totals' } }];
  assert.deepEqual(pendingBets(bets, Date.parse('2026-11-25T00:00:00Z')).map((b) => b.grade.market), ['totals']);
});
