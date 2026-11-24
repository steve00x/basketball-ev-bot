import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BetikaAPI } from '../src/betika/api.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { attachBetikaOdds } from '../src/betika/odds.js';
import { liveSettings } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { scanEvent } from '../src/scanner.js';
import { Store } from '../src/store.js';

const quiet = { info() {}, warn() {}, error() {} };
// Shape of live.betika.com/v1/uo/matches rows (checked on the live site)
const liveRow = (over = {}) => ({
  match_id: 5402289, parent_match_id: 73700001, sport_id: 30, home_team: 'Asvel', away_team: 'Milano', competition_name: 'Euroleague',
  category: 'International', start_time: '2026-11-24 22:45:00', event_status: '1st quarter', match_time: '6:12', current_score: '14:15',
  bet_status: 'STARTED', active: 1,
  odds: [
    { sub_type_id: 219, name: 'WINNER (INCL. OVERTIME)', market_active: 1, odds: [
      { display: '1', odd_value: '2.40', odd_active: 1 }, { display: '2', odd_value: '1.62', odd_active: 1 }] },
    { sub_type_id: 225, name: 'TOTAL (INCL. OVERTIME)', market_active: 1, odds: [
      { display: 'OVER 182.5', odd_key: 'over 182.5', odd_value: '1.85', special_bet_value: 'total=182.5', odd_active: 1 },
      { display: 'UNDER 182.5', odd_key: 'under 182.5', odd_value: '1.90', special_bet_value: 'total=182.5', odd_active: 1 }] }],
  ...over,
});

test('Betika live feed: only prices Betika takes now; clock, score and live match id kept', async () => {
  const rows = [
    liveRow(),
    liveRow({ match_id: 2, parent_match_id: 2, home_team: 'A', away_team: 'B', bet_status: 'STOPPED' }),           // betting stopped
    liveRow({ match_id: 3, parent_match_id: 3, home_team: 'C', away_team: 'D', odds: [{ ...liveRow().odds[0], market_active: 0 }] }), // suspended
    liveRow({ match_id: 4, parent_match_id: 4, home_team: 'E', away_team: 'F', sport_id: 14 }),                     // other sport
  ];
  const calls = [];
  const api = new BetikaAPI({ fetchImpl: async (url) => { calls.push(url); return new Response(JSON.stringify({ data: rows }), { status: 200 }); } });
  const ms = await api.liveMatches('basketball');
  assert.equal(calls[0].hostname, 'live.betika.com');
  assert.equal(calls[0].searchParams.get('sport'), '30');
  assert.deepEqual(ms.map((m) => m.home), ['Asvel']);
  const [m] = ms;
  assert.deepEqual([m.live, m.liveMatchId, m.clock, m.score, m.winner, m.totals[0].point], [true, '5402289', '6:12', '14:15', [2.4, 1.62], 182.5]);
  // an inactive single price is dropped, the rest of the market stays
  const half = liveRow(); half.odds[0].odds[1].odd_active = 0;
  const api2 = new BetikaAPI({ fetchImpl: async () => new Response(JSON.stringify({ data: [half] }), { status: 200 }) });
  assert.equal((await api2.liveMatches('basketball'))[0].winner, null); // can't price a 2-way market with one side
});

test('in-play scan: started games only, Pinnacle price must be fresh, stricter edge, live page id carried', async () => {
  const NOW = new Date('2026-11-24T20:00:00Z');
  const fresh = new Date(+NOW - 10_000).toISOString(), stale = new Date(+NOW - 90_000).toISOString();
  const event = (pinUpdated, start = '2026-11-24T19:45:00Z') => ({
    id: 'el1', sport_key: 'basketball_euroleague', home_team: 'ASVEL Lyon Villeurbanne', away_team: 'Pallacanestro Olimpia Milano', commence_time: start,
    bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: pinUpdated, markets: [{ key: 'h2h', last_update: pinUpdated, outcomes: [
      { name: 'ASVEL Lyon Villeurbanne', price: 2.10 }, { name: 'Pallacanestro Olimpia Milano', price: 1.80 }] }] }],
  });
  const betika = { sport: 'basketball', parentMatchId: '73700001', home: 'Asvel', away: 'Milano', start: new Date('2026-11-24T19:45:00Z'),
    competition: 'Euroleague', winner: [2.40, 1.62], draw: null, totals: [], live: true, liveMatchId: '5402289', clock: '6:12', period: '1st quarter', score: '14:15' };
  const s = liveSettings(makeSettings({ targetBooks: ['betika'], winningsTax: {}, liveMinEv: 0.05, liveMaxOddsAgeSeconds: 30 }));

  const ev = event(fresh);
  assert.equal(attachBetikaOdds([ev], [betika], NOW, { live: true }).matched, 1);
  assert.equal(ev.betikaRef.liveMatchId, '5402289');
  const opps = scanEvent(ev, s, NOW);
  // Pinnacle 2.10/1.80 -> fair ASVEL ~0.4615; Betika 2.40 -> +10.8%
  assert.deepEqual(opps.map((o) => [o.outcome, o.inPlay]), [['ASVEL Lyon Villeurbanne', true]]);

  const old = event(stale);
  attachBetikaOdds([old], [betika], NOW, { live: true });
  assert.deepEqual(scanEvent(old, s, NOW), []); // Pinnacle price 90 s old: never trusted in play

  const notStarted = event(fresh, '2026-11-24T21:00:00Z');
  assert.equal(attachBetikaOdds([notStarted], [betika], NOW, { live: true }).matched, 0);
  assert.deepEqual(scanEvent(notStarted, s, NOW), []);
  // and the pre-game scan never sees started games
  assert.deepEqual(scanEvent(event(fresh), makeSettings({ targetBooks: ['betika'], winningsTax: {}, maxLineAgeSeconds: 1e9 }), NOW), []);
});

test('in-play bets go to the live match page and stay dry runs unless LIVE_BETS_LIVE', async () => {
  const sent = [];
  const client = { placeBet: async (b) => { sent.push(b); return { status: b.live ? 'placed' : 'dry_run', confirmedStake: b.stake }; } };
  const opp = { book: 'betika', market: 'h2h', eventId: 'el1', outcome: 'H', homeTeam: 'H', awayTeam: 'A', point: null, fairProb: 0.46, decimal: 2.4,
    winningsTax: 0, ev: 0.1, stake: 40, inPlay: true, betikaRef: { sport: 'basketball', parentMatchId: 'p', liveMatchId: '5402289', swapped: false } };
  const run = async (over) => new BetikaExecutor(makeSettings({ betikaFixedStake: 40, ...over }), client, new Store(':memory:'), { log: quiet }).execute({ ...opp });
  assert.equal((await run({ betikaLive: true, liveBetsLive: false })).status, 'dry_run');
  assert.deepEqual([sent[0].liveMatchId, sent[0].live], ['5402289', false]);
  assert.equal((await run({ betikaLive: true, liveBetsLive: true })).status, 'placed');
  assert.equal((await run({ betikaLive: false, liveBetsLive: true })).status, 'dry_run'); // BETIKA_LIVE off wins
  const noId = await new BetikaExecutor(makeSettings({ betikaLive: true, liveBetsLive: true }), client, new Store(':memory:'), { log: quiet })
    .execute({ ...opp, betikaRef: { ...opp.betikaRef, liveMatchId: undefined } });
  assert.equal(noId.reason, 'no_live_match');
});
