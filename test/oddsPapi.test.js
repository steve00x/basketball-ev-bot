import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OddsPapi, OddsPapiError, groupForSportName, marketPlan, mergeEvents, toEvents } from '../src/oddsPapi.js';
import { makeSettings } from '../src/config.js';
import { scanEvent } from '../src/scanner.js';
import { sportGroup } from '../src/sports.js';
import { teamSimilarity } from '../src/teamMatch.js';

// Shapes from https://oddspapi.io/docs (get-markets, get-odds-by-tournaments, get-participants)
const M = (marketId, sportId, marketType, period, handicap, outs) => ({ marketId, sportId, marketType, period, handicap, playerProp: false,
  outcomes: outs.map(([outcomeId, outcomeName]) => ({ outcomeId, outcomeName })) });
const markets = Object.fromEntries([
  M(111, 11, 'moneyline', 'result', 0, [[111, '1'], [112, '2']]),
  M(113, 11, '1x2', 'fulltime', 0, [[113, '1'], [114, 'X'], [115, '2']]),     // regulation: must be ignored for basketball
  M(116, 11, 'totals', 'result', 228.5, [[116, 'Over'], [117, 'Under']]),
  M(118, 11, 'totals', 'result', 231.5, [[118, 'Over'], [119, 'Under']]),
  M(120, 11, 'totals', 'fulltime', 220.5, [[120, 'Over'], [121, 'Under']]),  // regulation-only: ignored
  M(130, 11, 'teamtotals-team1', 'result', 117.5, [[130, 'Over'], [131, 'Under']]),
  M(140, 11, 'teamtotals-team2', 'result', 111.5, [[140, 'Over'], [141, 'Under']]),
  M(101, 10, '1x2', 'fulltime', 0, [[101, '1'], [102, 'X'], [103, '2']]),
  M(106, 10, 'totals', 'fulltime', 2.5, [[106, 'Over'], [107, 'Under']]),
].map((m) => [String(m.marketId), m]));
const price = (p, extra = {}) => ({ players: { 0: { active: true, price: p, bookmakerOutcomeId: 'x', ...extra } } });
const fixture = (over = {}) => ({
  fixtureId: 'id1', participant1Id: 3409, participant2Id: 3410, sportId: 11, tournamentId: 132, statusId: 0, hasOdds: true,
  startTime: '2026-11-25T00:30:00.000Z',
  bookmakerOdds: { 'pinnacle+30': { bookmakerIsActive: true, suspended: false, markets: {
    111: { marketActive: true, outcomes: { 111: price(1.80), 112: price(2.10) } },
    113: { marketActive: true, outcomes: { 113: price(1.70), 114: price(15), 115: price(2.2) } },
    116: { marketActive: true, outcomes: { 116: price(1.95), 117: price(1.95) } },
    118: { marketActive: true, outcomes: { 118: price(2.20), 119: price(1.72) } },
    120: { marketActive: true, outcomes: { 120: price(1.9), 121: price(1.9) } },
    130: { marketActive: true, outcomes: { 130: price(1.93), 131: price(1.93) } },
    140: { marketActive: true, outcomes: { 140: price(1.90), 141: price(1.96, { active: false }) } },
  } } },
  ...over,
});
const ctx = { markets, participants: { 3409: 'Chicago Bulls', 3410: 'Milwaukee Bucks' },
  tournaments: { 132: { tournamentId: 132, tournamentName: 'NBA', categoryName: 'USA' } }, groupBySportId: { 11: 'basketball' } };

test('sport names and market plans follow the settlement rules', () => {
  assert.equal(groupForSportName('Ice Hockey'), null); // removed from the bot
  assert.equal(groupForSportName('Soccer'), 'soccer');
  assert.deepEqual(marketPlan('basketball').map((p) => `${p.type}/${p.period}`),
    ['moneyline/result', 'totals/result', 'teamtotals-team1/result', 'teamtotals-team2/result']); // incl. overtime, like Betika
  assert.deepEqual(marketPlan('soccer').map((p) => `${p.type}/${p.period}`), ['1x2/fulltime', 'totals/fulltime']); // 90 minutes
});

test('odds-by-tournaments -> events: right periods, all lines, team totals, inactive prices dropped', () => {
  const [e] = toEvents([fixture()], ctx);
  assert.deepEqual([e.sport_key, e.home_team, e.away_team], ['basketball_nba', 'Chicago Bulls', 'Milwaukee Bucks']);
  const m = Object.fromEntries(e.bookmakers[0].markets.map((x) => [x.key, x.outcomes]));
  assert.deepEqual(m.h2h, [{ name: 'Chicago Bulls', price: 1.8 }, { name: 'Milwaukee Bucks', price: 2.1 }]); // no regulation 1X2
  assert.deepEqual(m.totals.map((o) => `${o.name} ${o.point}`), ['Over 228.5', 'Under 228.5', 'Over 231.5', 'Under 231.5']); // no 220.5 regulation line
  assert.deepEqual(m.team_totals.map((o) => `${o.description} ${o.name} ${o.point}`),
    ['Chicago Bulls Over 117.5', 'Chicago Bulls Under 117.5', 'Milwaukee Bucks Over 111.5']); // inactive Under dropped
  assert.deepEqual(toEvents([fixture({ statusId: 1 })], ctx), []); // live: skipped
  const stale = fixture(); stale.bookmakerOdds['pinnacle+30'].bookmakerIsActive = false;
  assert.deepEqual(toEvents([stale], ctx), []);
});

test('merge: same game becomes one event with The Odds API names; Pinnacle alt and team-total lines compare exactly', async () => {
  const NOW = new Date('2026-11-24T18:00:00Z');
  const [op] = toEvents([fixture()], { ...ctx, now: NOW });
  const theOddsApi = { id: 'toa1', sport_key: 'basketball_nba', home_team: 'Chicago Bulls', away_team: 'Milwaukee Bucks',
    commence_time: '2026-11-25T00:40:00Z', betikaRef: { sport: 'basketball', swapped: false },
    bookmakers: [
      { key: 'pinnacle', title: 'Pinnacle', last_update: NOW.toISOString(), markets: [
        { key: 'h2h', outcomes: [{ name: 'Chicago Bulls', price: 1.80 }, { name: 'Milwaukee Bucks', price: 2.10 }] }] },
      { key: 'betika', title: 'Betika', last_update: NOW.toISOString(), markets: [
        { key: 'totals', outcomes: [{ name: 'Over', price: 2.45, point: 231.5 }, { name: 'Under', price: 1.55, point: 231.5 }] },
        { key: 'team_totals', outcomes: [{ name: 'Over', price: 2.10, point: 117.5, description: 'Chicago Bulls', side: 'H', betikaTeam: 'Chicago' },
          { name: 'Under', price: 1.70, point: 117.5, description: 'Chicago Bulls', side: 'H', betikaTeam: 'Chicago' }] }] }],
  };
  const other = { ...op, id: 'op-x', home_team: 'Boston Celtics', away_team: 'New York Knicks' };
  const { events, joined, added } = mergeEvents([theOddsApi], [op, other], { similarity: teamSimilarity, groupOf: sportGroup });
  assert.deepEqual([events.length, joined, added], [2, 1, 1]);
  const ev = events[0];
  assert.equal(ev.id, 'toa1'); // one event, one id: a bet can't be placed twice through two sources
  const s = makeSettings({ targetBooks: ['betika'], minEv: 0.02, winningsTax: {}, maxLineAgeSeconds: 1e9, maxHoursToStart: 48, maxDecimalOdds: 5 });
  const opps = scanEvent(ev, s, NOW);
  // Over 231.5: Pinnacle 2.20/1.72 -> fair ~0.433, Betika 2.45 -> +6%; team total Over 117.5 at 2.10 vs fair 0.5 -> +5%
  const tot = opps.find((o) => o.market === 'totals' && o.point === 231.5 && o.outcome === 'Over');
  const tt = opps.find((o) => o.market === 'team_totals' && o.point === 117.5 && o.outcome === 'Over');
  assert.ok(tot && !tot.model, 'exact Pinnacle alt line, no model');
  assert.ok(tt && !tt.model && Math.abs(tt.ev - 0.05) < 1e-9, 'exact Pinnacle team total, no model');
  // ...and it must be placeable: Betika's own team name gives the market title on the page
  const { betikaPick } = await import('../src/betika/odds.js');
  assert.deepEqual(betikaPick(tt), { market: 'Chicago Total (Incl. Overtime)', label: 'Over 117.5' });
  assert.equal(opps.filter((o) => o.market === 'team_totals' && o.point === 117.5 && o.outcome === 'Over').length, 1);
});

test('client: rate limit retried, quota exhaustion stops further billable calls, /account is free', async () => {
  const calls = [];
  let mode = 'rate';
  const fetchImpl = async (url) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/account')) return new Response(JSON.stringify({ request_limit: 250, request_count: 12 }), { status: 200 });
    if (mode === 'rate') { mode = 'ok'; return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', retryMs: 5 } }), { status: 429 }); }
    if (mode === 'ok') return new Response(JSON.stringify([{ sportId: 11, sportName: 'Basketball' }]), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'REQUEST_LIMIT_EXCEEDED', message: 'Request limit exceeded' } }), { status: 429 });
  };
  const api = new OddsPapi('k', { fetchImpl, cachePath: ':memory:', log: { info() {}, warn() {} }, minGapMs: 1 });
  assert.deepEqual(await api.sportGroups(['basketball']), { 11: 'basketball' });
  assert.equal(api.requestsUsed, 1);
  mode = 'limit';
  await assert.rejects(api.markets(), (e) => e instanceof OddsPapiError && e.code === 'REQUEST_LIMIT_EXCEEDED');
  assert.equal(api.quotaGone, true);
  const before = calls.length;
  await assert.rejects(api.tournaments(11), /used up/);
  assert.equal(calls.length, before); // not even sent
  assert.equal((await api.account()).request_count, 12); // still allowed
  assert.equal(new URL(`https://x${calls[0]}`).pathname, '/v4/sports');
});

test('league choice: sport priority first (basketball before table tennis), then busiest; II/women skipped', async () => {
  const tours = {
    11: [{ tournamentId: 1, tournamentName: 'NCAA, Regular Season', categoryName: 'USA', upcomingFixtures: 60 },
      { tournamentId: 2, tournamentName: 'NBA', categoryName: 'USA', upcomingFixtures: 10 },
      { tournamentId: 3, tournamentName: 'NCAA Women', categoryName: 'USA', upcomingFixtures: 90 }],
    25: [{ tournamentId: 7, tournamentName: 'TT Elite Series', categoryName: 'Poland', upcomingFixtures: 400 }],
    10: [{ tournamentId: 4, tournamentName: 'Premier League', categoryName: 'England', upcomingFixtures: 10 },
      { tournamentId: 5, tournamentName: 'Feeder Dusseldorf II', categoryName: 'Germany', upcomingFixtures: 300 }],
  };
  const api = new OddsPapi('k', { cachePath: ':memory:', log: { info() {} } });
  api.tournaments = async (id) => tours[id];
  const { ids } = await api.chooseTournaments({ 11: 'basketball', 10: 'soccer', 25: 'tabletennis' }, { max: 5, priority: ['basketball', 'soccer'] });
  assert.deepEqual(ids, [1, 2, 4, 7]); // NCAA, NBA, EPL, then table tennis last; women's and "II" never
});

test('account summary never contains the API key or email', async () => {
  const { summarizeAccount } = await import('../src/oddsPapi.js');
  const acc = { api_key: '7cea-SECRET', email: 'someone@example.com', customer_segment: 'user',
    subscriptions: [{ subscription_id: 'abc', currency: 'USD', price: null, request_limit: 250, request_count: 14, plan_name: 'Free', valid_until: '2026-12-24T00:00:00Z' }] };
  const line = summarizeAccount(acc);
  assert.equal(line, 'requests used 14 of 250 | plan Free | until 2026-12-24');
  assert.ok(!/SECRET|example\.com|abc/.test(line));
});

test('exact team-total opportunity reaches the bet placer (not "unsupported_market")', async () => {
  const { BetikaExecutor } = await import('../src/betika/executor.js');
  const { Store } = await import('../src/store.js');
  const sent = [];
  const ex = new BetikaExecutor(makeSettings({ betikaLive: false, betikaFixedStake: 40 }), { placeBet: async (b) => { sent.push(b); return { status: 'dry_run' }; } },
    new Store(':memory:'), { log: { info() {}, warn() {}, error() {} } });
  const NOW = new Date('2026-11-24T18:00:00Z');
  const ev = { id: 'e1', sport_key: 'basketball_ncaab', home_team: 'Marist Red Foxes', away_team: 'Siena Saints', commence_time: '2026-11-25T00:00:00Z',
    betikaRef: { sport: 'basketball', parentMatchId: 'p9', swapped: true },
    bookmakers: [
      { key: 'pinnacle', last_update: NOW.toISOString(), markets: [{ key: 'team_totals', outcomes: [
        { name: 'Over', price: 1.95, point: 64.5, description: 'Marist Red Foxes' }, { name: 'Under', price: 1.95, point: 64.5, description: 'Marist Red Foxes' }] }] },
      { key: 'betika', last_update: NOW.toISOString(), markets: [{ key: 'team_totals', outcomes: [
        { name: 'Over', price: 1.70, point: 64.5, description: 'Marist Red Foxes', side: 'H', betikaTeam: 'Marist' },
        { name: 'Under', price: 2.15, point: 64.5, description: 'Marist Red Foxes', side: 'H', betikaTeam: 'Marist' }] }] }],
  };
  const [o] = scanEvent(ev, makeSettings({ targetBooks: ['betika'], minEv: 0.02, winningsTax: {}, maxLineAgeSeconds: 1e9, maxHoursToStart: 48 }), NOW)
    .filter((x) => x.market === 'team_totals');
  assert.equal(o.outcome, 'Under');
  const r = await ex.execute(o);
  assert.equal(r.status, 'dry_run');
  assert.deepEqual([sent[0].market, sent[0].label, sent[0].parentMatchId], ['Marist Total (Incl. Overtime)', 'Under 64.5', 'p9']);
});
