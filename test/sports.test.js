import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListings } from '../src/betika/api.js';
import { attachBetikaOdds, betikaPick } from '../src/betika/odds.js';
import { fetchEvents, marketsFor } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { OddsAPI } from '../src/oddsApi.js';
import { scanEvent } from '../src/scanner.js';
import { SPORTS, competitionFilter, resolveSportKeys, sportGroup } from '../src/sports.js';
import { qualifiers, teamSimilarity } from '../src/teamMatch.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date('2026-11-23T12:00:00Z');
const START = new Date('2026-11-23T20:00:00Z'); // 23:00 EAT
const eat = '2026-11-23 23:00:00';

// Betika listing rows in the real API shape (values made up)
const row = (id, home, away, comp, odds, subType = '1', name = '1X2', category = 'England') => ({
  parent_match_id: id, match_id: `m${id}`, home_team: home, away_team: away, start_time: eat,
  competition_name: comp, category, odds: [{ sub_type_id: subType, name, odds }] });
const x12 = (h, d, a) => [{ display: '1', odd_value: String(h) }, { display: 'X', odd_value: String(d) }, { display: '2', odd_value: String(a) }];
const w12 = (h, a) => [{ display: '1', odd_value: String(h) }, { display: '2', odd_value: String(a) }];

const pinnacle = (key, home, away, outcomes, extra = []) => ({
  id: `${key}-${home}`, sport_key: key, home_team: home, away_team: away, commence_time: START.toISOString(),
  bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: NOW.toISOString(), markets: [
    { key: 'h2h', outcomes }, ...extra] }],
});
const S = makeSettings({ targetBooks: ['betika'], minEv: 0.02, maxLineAgeSeconds: 1e9, maxHoursToStart: 48, winningsTax: { betika: 0.2 } });

test('sport groups and Odds API key expansion', () => {
  assert.equal(sportGroup('soccer_epl'), 'soccer');
  assert.equal(sportGroup('tennis_atp_paris'), 'tennis');
  assert.equal(sportGroup('rugbyleague_nrl'), null); // league is 2-way: never pairs with Betika's 1X2
  assert.equal(sportGroup('rugbyunion_six_nations'), 'rugby');
  assert.equal(sportGroup('icehockey_nhl'), 'icehockey');
  const active = [{ key: 'soccer_epl' }, { key: 'soccer_brazil_campeonato' }, { key: 'icehockey_nhl' },
    { key: 'tennis_atp_finals' }, { key: 'soccer_epl_winner', has_outrights: true }, { key: 'basketball_nba' }];
  assert.deepEqual(resolveSportKeys(['soccer'], active).keys, ['soccer_epl']); // top leagues only
  assert.deepEqual(resolveSportKeys(['soccer_all'], active).keys, ['soccer_epl', 'soccer_brazil_campeonato']);
  const r = resolveSportKeys(['icehockey', 'tennis', 'volleyball', 'basketball_nba', 'baseball_mlb'], active);
  assert.deepEqual(r.keys, ['icehockey_nhl', 'tennis_atp_finals', 'basketball_nba']);
  assert.deepEqual(r.missing, ['volleyball', 'baseball_mlb']);
  // leagues that can never pair with Betika aren't paid for
  const r2 = resolveSportKeys(['cricket', 'rugby'], [{ key: 'cricket_test_match' }, { key: 'cricket_big_bash' }, { key: 'rugbyleague_nrl' }]);
  assert.deepEqual([r2.keys, r2.missing], [['cricket_big_bash'], ['rugby']]);
});

test('only comparable markets are bought per sport', () => {
  const s = makeSettings({ markets: ['h2h', 'totals'] });
  assert.deepEqual(marketsFor('soccer_epl', s), ['h2h', 'totals']);
  assert.deepEqual(marketsFor('icehockey_nhl', s), ['h2h']); // Betika hockey totals are regulation-only
  assert.deepEqual(marketsFor('tennis_atp_finals', s), ['h2h']);
});

test('soccer: 3-way 1X2 with draw is parsed, matched and bet with label X', () => {
  const win = { data: [row('s1', 'Brentford', 'Everton', 'Premier League', x12(2.9, 3.4, 2.9))] };
  const tot = { data: [row('s1', 'Brentford', 'Everton', 'Premier League', [
    { odd_key: 'over 2.5', display: 'OVER 2.5', odd_value: '2.05', special_bet_value: 'total=2.5' },
    { odd_key: 'under 2.5', display: 'UNDER 2.5', odd_value: '1.80', special_bet_value: 'total=2.5' }], '18', 'TOTAL')] };
  const [m] = parseListings(win, tot, SPORTS.soccer, 'soccer');
  assert.deepEqual([m.sport, m.winner, m.draw, m.totals], ['soccer', [2.9, 2.9], 3.4, [{ point: 2.5, over: 2.05, under: 1.8 }]]);

  // Pinnacle fair: Draw priced 3.2/3.3 area; Betika's 3.4 draw is not enough after tax, but a mispriced 4.5 is
  const ev = pinnacle('soccer_epl', 'Brentford', 'Everton FC',
    [{ name: 'Brentford', price: 2.6 }, { name: 'Everton FC', price: 2.9 }, { name: 'Draw', price: 3.3 }]);
  const mis = { ...m, draw: 4.5 };
  const r = attachBetikaOdds([ev], [mis], NOW);
  assert.equal(r.matched, 1);
  const opps = scanEvent(ev, S, NOW);
  assert.deepEqual(opps.map((o) => o.outcome), ['Draw']);
  assert.deepEqual(betikaPick(opps[0]), { market: '1x2', label: 'X' });
});

test('3-way Betika vs 2-way Pinnacle never compare (e.g. baseball 9-inning 1X2 vs moneyline)', () => {
  const [m] = parseListings({ data: [row('b1', 'Tiburones', 'Cardenales', 'LVBP', x12(3, 12, 3))] }, null, SPORTS.baseball, 'baseball');
  const ev = pinnacle('baseball_mlb', 'Tiburones', 'Cardenales', [{ name: 'Tiburones', price: 1.95 }, { name: 'Cardenales', price: 1.95 }]);
  attachBetikaOdds([ev], [m], NOW);
  assert.ok(ev.bookmakers.some((b) => b.key === 'betika')); // matched...
  assert.deepEqual(scanEvent(ev, makeSettings({ ...S, winningsTax: {} }), NOW), []); // ...but 3.0 vs fair 2.0 is never compared
});

test('ice hockey uses the overtime+penalties winner market, not regulation 1X2', () => {
  const win = { data: [row('h1', 'New Jersey Devils', 'Columbus', 'NHL', w12(2.4, 1.6), '406', 'WINNER (INCL. OVERTIME AND PENALTIES)', 'USA')] };
  const [m] = parseListings(win, null, SPORTS.icehockey, 'icehockey');
  assert.deepEqual([m.winner, m.draw], [[2.4, 1.6], null]);
  const ev = pinnacle('icehockey_nhl', 'New Jersey Devils', 'Columbus Blue Jackets',
    [{ name: 'New Jersey Devils', price: 2.0 }, { name: 'Columbus Blue Jackets', price: 1.9 }]);
  attachBetikaOdds([ev], [m], NOW);
  const [o] = scanEvent(ev, S, NOW);
  assert.equal(o.outcome, 'New Jersey Devils');
  assert.deepEqual(betikaPick(o), { market: 'Winner (Incl. Overtime And Penalties)', label: '1' });
});

test('tennis: "Surname, First" names, ATP vs WTA, no UTR/doubles', () => {
  assert.equal(teamSimilarity('Carlos Alcaraz', 'Alcaraz, Carlos'), 1);
  assert.equal(teamSimilarity('Felix Auger-Aliassime', 'Auger-Aliassime, Felix'), 1);
  const atp = competitionFilter('tennis_atp_finals'), wta = competitionFilter('tennis_wta_finals');
  assert.equal(atp('ATP Finals, Italy Men Singles'), true);
  assert.equal(atp('WTA 125 Buenos Aires, Argentina Women Singles'), false);
  assert.equal(wta('WTA 125 Buenos Aires, Argentina Women Singles'), true);
  assert.equal(atp('UTR PTT Melbourne Men 05'), false);
  assert.equal(atp('ATP Paris, France Men Doubles'), false);
});

test('women, youth and reserve sides never match the first team', () => {
  assert.equal(teamSimilarity('Arsenal', 'Arsenal (W)'), 0);
  assert.equal(teamSimilarity('Arsenal', 'Arsenal Women'), 0);
  assert.equal(teamSimilarity('Chelsea', 'Chelsea U21'), 0);
  assert.equal(teamSimilarity('Ajax', 'Jong Ajax Amsterdam'), 0);
  assert.equal(teamSimilarity('Barcelona', 'Barcelona B'), 0);
  assert.ok(teamSimilarity('Arsenal Women', 'Arsenal (W)') >= 0.75);
  assert.equal(qualifiers('Manchester United'), '');
  const soccerEpl = competitionFilter('soccer_epl');
  assert.equal(soccerEpl('Premier League'), true);
  assert.equal(soccerEpl('Super League, Women'), false);
  assert.equal(soccerEpl('Premier League 2, U21'), false);
});

test('fetchEvents expands groups via /sports and buys only comparable markets', async () => {
  const start = new Date(Date.now() + 3 * 3600_000).toISOString();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.pathname.endsWith('/v4/sports')) {
      return new Response(JSON.stringify([{ key: 'icehockey_nhl', active: true }, { key: 'soccer_epl', active: true }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ id: 'e', sport_key: url.pathname.split('/')[3], commence_time: start, home_team: 'A', away_team: 'B', bookmakers: [] }]), { status: 200 });
  };
  const api = new OddsAPI('k', { fetchImpl });
  const s = makeSettings({ sports: ['icehockey', 'soccer'], markets: ['h2h', 'totals'], betikaEnabled: true });
  const evs = await fetchEvents(api, s, quiet);
  assert.equal(evs.length, 2);
  const odds = calls.filter((u) => u.pathname.endsWith('/odds')).map((u) => [u.pathname.split('/')[3], u.searchParams.get('markets')]);
  assert.deepEqual(odds, [['icehockey_nhl', 'h2h'], ['soccer_epl', 'h2h,totals']]);
});

test('soccer_small: lower leagues, only those in season; MARKETS_SOCCER halves the cost', async () => {
  const active = [{ key: 'soccer_epl' }, { key: 'soccer_england_league1' }, { key: 'soccer_germany_bundesliga2' },
    { key: 'soccer_usa_mls', active: false }, { key: 'soccer_some_new_league' }];
  const r = resolveSportKeys(['soccer_small'], active);
  assert.deepEqual(r.keys, ['soccer_england_league1', 'soccer_germany_bundesliga2']); // MLS out of season, EPL not "small"
  assert.deepEqual(resolveSportKeys(['soccer', 'soccer_small'], active).keys, ['soccer_epl', 'soccer_england_league1', 'soccer_germany_bundesliga2']);

  const s = makeSettings({ markets: ['h2h', 'totals'], marketsBySport: { soccer: ['h2h'] } });
  assert.deepEqual(marketsFor('soccer_england_league1', s), ['h2h']);
  assert.deepEqual(marketsFor('basketball_nba', s), ['h2h', 'totals']); // other sports unchanged

  const { settingsFromEnv } = await import('../src/config.js');
  process.env.MARKETS_SOCCER = 'h2h';
  try {
    assert.deepEqual(settingsFromEnv(null).marketsBySport.soccer, ['h2h']);
  } finally { delete process.env.MARKETS_SOCCER; }
});

test('name fixes from a real scan (Odds API name vs Betika name)', () => {
  const pairs = [['New York Islanders', 'NY Islanders'], ['North Florida Ospreys', 'N. Florida'], ['Central Arkansas Bears', 'Cent. Arkansas'],
    ['Northern Kentucky Norse', 'Nku Norse'], ['Loyola (Chi) Ramblers', 'Loyola Chicago'], ['UNC Greensboro Spartans', 'NC Greensboro'],
    ['FC Bayern München', 'B. Munich'], ['Bodø/Glimt', 'Bodoe/Glimt'], ['Everton U21', 'Everton Reserves'],
    ['Tottenham Hotspur U21', 'TOTTENHAM RESERVE'], ['Sport', 'Vaasan'], ['Arsenal Women', 'Arsenal (W)']];
  for (const [a, b] of pairs) assert.ok(teamSimilarity(a, b) >= 0.75, `${a} vs ${b}: ${teamSimilarity(a, b)}`);
  for (const [a, b] of [['Everton U21', 'Everton'], ['Arsenal', 'Arsenal (W)'], ['South Carolina St Bulldogs', 'Hawks']]) {
    assert.ok(teamSimilarity(a, b) < 0.75, `${a} vs ${b}`);
  }
});

test('free events check skips leagues with no games (no credits spent on them)', async () => {
  const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/v4/sports')) return new Response(JSON.stringify([{ key: 'soccer_epl' }, { key: 'soccer_spl' }]), { status: 200 });
    if (url.pathname.endsWith('/soccer_epl/events')) return new Response(JSON.stringify([{ id: 'x', commence_time: soon }]), { status: 200 });
    if (url.pathname.endsWith('/soccer_spl/events')) return new Response('[]', { status: 200 });
    return new Response(JSON.stringify([{ id: 'x', sport_key: 'soccer_epl', commence_time: soon, home_team: 'A', away_team: 'B', bookmakers: [] }]), { status: 200 });
  };
  const s = makeSettings({ sports: ['soccer_epl', 'soccer_spl'], markets: ['h2h'], betikaEnabled: true });
  await fetchEvents(new OddsAPI('k', { fetchImpl }), s, quiet);
  assert.deepEqual(calls.filter((p) => p.endsWith('/odds')), ['/v4/sports/soccer_epl/odds']); // spl had no games: not paid for
});

test('English football and other short forms from a real scan', () => {
  for (const [a, b] of [['Sheffield United', 'Sheffield Utd'], ['Sheffield Wednesday', 'Sheffield Wed'], ['Manchester City', 'Man City'],
    ['Wolverhampton Wanderers', 'Wolves'], ['Miami Hurricanes', 'Miami-Florida'], ['Fenerbahce SK', 'Fenerbahce Istanbul'],
    ['FC Barcelona Bàsquet', 'Barcelona']]) assert.ok(teamSimilarity(a, b) >= 0.75, `${a} vs ${b}`);
  for (const [a, b] of [['Manchester City', 'Manchester United'], ['Sheffield United', 'Sheffield Wednesday'], ['Miami (OH) RedHawks', 'Miami-Florida']]) {
    assert.ok(teamSimilarity(a, b) < 0.75, `${a} vs ${b}`);
  }
});

test('Double Chance and Draw No Bet: parsed from one listing, priced from Pinnacle 1X2, right buttons', async () => {
  const odds = [
    { sub_type_id: '1', name: '1X2', odds: x12(2.2, 3.6, 3.4) },
    { sub_type_id: '10', name: 'DOUBLE CHANCE', odds: [{ display: '1/X', odd_value: '1.40' }, { display: 'X/2', odd_value: '1.80' }, { display: '1/2', odd_value: '1.30' }] },
    { sub_type_id: '11', name: 'WHO WILL WIN? (IF DRAW, MONEY BACK)', odds: w12(1.70, 2.40) }];
  const listing = { data: [{ ...row('d1', 'Brentford', 'Everton', 'Premier League', []), odds }] };
  const [m] = parseListings(listing, null, SPORTS.soccer, 'soccer');
  assert.deepEqual(m.doubleChance, { '1X': 1.4, X2: 1.8, '12': 1.3 });
  assert.deepEqual(m.drawNoBet, [1.7, 2.4]);

  // Pinnacle fair (no vig, so devig keeps it): H 45%, D 27%, A 28%
  const ev = pinnacle('soccer_epl', 'Brentford', 'Everton',
    [{ name: 'Brentford', price: 1 / 0.45 }, { name: 'Everton', price: 1 / 0.28 }, { name: 'Draw', price: 1 / 0.27 }]);
  attachBetikaOdds([ev], [m], NOW);
  const opps = scanEvent(ev, makeSettings({ ...S, winningsTax: {} }), NOW);
  const dnbH = opps.find((o) => o.market === 'draw_no_bet' && o.code === 'H');
  // EV = 0.45 x 1.70 + 0.27 - 1 = +3.5%
  assert.ok(Math.abs(dnbH.ev - 0.035) < 1e-9, String(dnbH.ev));
  assert.deepEqual(betikaPick(dnbH), { market: 'Who Will Win? (If Draw, Money Back)', label: '1' });
  const dcHD = opps.find((o) => o.market === 'double_chance' && o.code === 'HD');
  // P = 0.72; 0.72 x 1.40 - 1 = +0.8% -> below 2%: not offered. X/2 at 1.80: 0.55 x 1.8 - 1 = -1% -> no.
  assert.equal(dcHD, undefined);
  assert.ok(!opps.some((o) => o.market === 'double_chance'));

  // Same game, Betika lists the teams the other way round: its "1/X" is OUR away-or-draw
  const swapped = { ...m, home: 'Everton', away: 'Brentford', doubleChance: { '1X': 1.95, X2: 1.20, '12': 1.30 }, drawNoBet: [2.4, 1.7] };
  const ev2 = pinnacle('soccer_epl', 'Brentford', 'Everton',
    [{ name: 'Brentford', price: 1 / 0.45 }, { name: 'Everton', price: 1 / 0.28 }, { name: 'Draw', price: 1 / 0.27 }]);
  attachBetikaOdds([ev2], [swapped], NOW);
  const o2 = scanEvent(ev2, makeSettings({ ...S, winningsTax: {} }), NOW);
  const dcDA = o2.find((o) => o.market === 'double_chance' && o.code === 'DA'); // Draw or Everton @ 1.95: 0.55 x 1.95 - 1 = +7.25%
  assert.ok(dcDA && Math.abs(dcDA.ev - 0.0725) < 1e-9);
  assert.deepEqual(betikaPick(dcDA), { market: 'Double Chance', label: '1/X' }); // Everton is Betika's "1"
  const dnbH2 = o2.find((o) => o.market === 'draw_no_bet' && o.code === 'H');
  assert.deepEqual(betikaPick(dnbH2), { market: 'Who Will Win? (If Draw, Money Back)', label: '2' });
});

test('Draw No Bet price floor counts the refund', async () => {
  const { BetikaExecutor } = await import('../src/betika/executor.js');
  const { Store } = await import('../src/store.js');
  const sent = [];
  const ex = new BetikaExecutor(makeSettings({ minEv: 0.02, betikaLive: true, betikaFixedStake: 40 }),
    { placeBet: async (b) => { sent.push(b); return { status: 'placed', confirmedStake: b.stake }; } }, new Store(':memory:'), { log: quiet });
  await ex.execute({ book: 'betika', market: 'draw_no_bet', code: 'H', eventId: 'e', outcome: 'H', homeTeam: 'H', awayTeam: 'A', point: null,
    fairProb: 0.45, pushProb: 0.27, decimal: 1.7, winningsTax: 0, ev: 0.035, stake: 1, betikaRef: { sport: 'soccer', parentMatchId: 'p', swapped: false } });
  // (1 + 0.02 - 0.27) / 0.45 = 1.6667
  assert.deepEqual([sent[0].label, sent[0].minEffectiveOdds, sent[0].minOdds], ['1', 1.667, 1.667]);
});
