import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvents } from '../src/bot.js';
import { makeSettings } from '../src/config.js';
import { OddsAPI, OddsAPIError } from '../src/oddsApi.js';

const quiet = { info() {}, warn() {}, error() {} };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'x-requests-remaining': '480', 'x-requests-used': '20' } });

test('fetchEvents asks only for sharp books when betting Betika, and merges props', async () => {
  const start = new Date(Date.now() + 3 * 3600_000).toISOString();
  const game = { id: 'g1', commence_time: start, home_team: 'H', away_team: 'A',
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [] }] }] };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.pathname.endsWith('/basketball_nba/odds')) return json([game]);
    if (url.pathname.endsWith('/events/g1/odds')) return json({ bookmakers: [{ key: 'pinnacle', markets: [{ key: 'player_points', outcomes: [] }] }] });
    return json({}, 404);
  };
  const api = new OddsAPI('k', { fetchImpl });
  const s = makeSettings({ betikaEnabled: true, propMarkets: ['player_points'] });
  const [ev] = await fetchEvents(api, s, quiet);
  assert.deepEqual(ev.bookmakers[0].markets.map((m) => m.key), ['h2h', 'player_points']);
  assert.equal(calls[0].searchParams.get('bookmakers'), 'pinnacle');
  assert.equal(calls[0].searchParams.get('regions'), null);
  assert.equal(calls[0].searchParams.get('oddsFormat'), 'decimal');
  assert.equal(api.requestsRemaining, '480');
});

test('retries 5xx then fails; 401 fails fast', async () => {
  let n = 0;
  const api = new OddsAPI('k', { fetchImpl: async () => { n++; return json({}, 503); }, backoffMs: 1 });
  await assert.rejects(api.getOdds('x', ['h2h'], ['eu']), OddsAPIError);
  assert.equal(n, 3);
  const api2 = new OddsAPI('k', { fetchImpl: async () => json({ message: 'bad key' }, 401) });
  await assert.rejects(api2.getOdds('x', ['h2h'], ['eu']), /401/);
  assert.throws(() => new OddsAPI(''), OddsAPIError);
});
