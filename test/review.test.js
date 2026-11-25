import { test } from 'node:test';
import assert from 'node:assert/strict';
import { review, stats, verdict } from '../src/review.js';

const bet = (won, o = {}) => ({ live: true, status: 'placed', stake: 40, odds: 2.1, ev: 0.05, fairProb: 0.5, result: won ? 'won' : 'lost', profit: won ? 44 : -40, ...o });

test('review: wins against what the fair odds predicted, and an honest verdict', () => {
  const unlucky = [...Array(40)].map((_, i) => bet(i < 17));       // 17 of 40 at 50%: -1.0 sd
  const st = stats(unlucky);
  assert.deepEqual([st.n, st.won, st.expWins, Math.round(st.z * 10) / 10], [40, 17, 20, -0.9]);
  assert.match(verdict(st), /within normal luck/);
  assert.match(verdict(stats(unlucky.slice(0, 10))), /too few/);
  const broken = [...Array(60)].map((_, i) => bet(i < 18));        // 18 of 60: -3.1 sd
  assert.match(verdict(stats(broken)), /not real edges/);
  const text = review([...broken.map((b) => ({ ...b, inPlay: true })), bet(true, { live: false, status: 'dry_run', key: 'd' })]);
  assert.match(text, /IN-PLAY, real money: 60 settled/);
  assert.match(text, /PRE-MATCH, dry runs: 1 settled/);
});

test('tax check: the share of profit Betika withholds, from its own history; warns when the setting differs', async () => {
  const { taxCheck, taxLines } = await import('../src/review.js');
  const placed = (o) => ({ live: true, status: 'placed', stake: 40, odds: 2.2, ...o });
  const bets = [
    placed({ betikaPossibleWin: 88, betikaWht: 9.6, betikaStake: 40 }),          // open bet: 9.60 of 48 profit = 20%
    placed({ betikaPossibleWin: 70, betikaWht: 6, betikaStake: 40, betikaStatus: 'won' }),
    placed({ betikaStatus: 'won', betikaPayout: 78.4 }),                          // paid 78.40 of a 88 gross win -> 20%
    placed({ betikaPossibleWin: 88, betikaWht: 0 }),                              // no tax shown yet on an open bet: not counted
    { live: false, status: 'dry_run', betikaPossibleWin: 88, betikaWht: 30 },     // dry runs never count
  ];
  const t = taxCheck(bets);
  assert.equal(t.n, 3);
  assert.ok(Math.abs(t.rate - 0.2) < 1e-9);
  assert.match(taxLines(bets, 0).join('\n'), /set BETIKA_WINNINGS_TAX=0.2/);
  assert.match(taxLines(bets, 0.2).join('\n'), /OK/);
  assert.match(taxLines([], 0)[0], /no Betika history/);
});

test('strategy guard: pauses a pre-match strategy with negative CLV and an in-play one losing far beyond luck', async () => {
  const { strategyVerdicts, strategyOf } = await import('../src/insights.js');
  const s = { guardMinBets: 50, guardMinClv: -0.01, guardWindow: 100, guardMinBetsInPlay: 100 };
  const start = '2026-11-20T18:00:00Z';
  const pre = (i, fair, o = {}) => ({ key: 'k' + i, live: true, status: 'placed', at: '2026-11-20T15:00:00Z', odds: 2.0, stake: 40, ev: 0.04, fairProb: 0.52,
    grade: { commenceTime: start, market: 'h2h', winningsTax: 0 }, close: { fairProb: fair, at: '2026-11-20T17:55:00Z' }, ...o });
  // steam picks: closing fair 0.48 at odds 2.0 -> CLV -4%; normal picks: closing 0.52 -> +4%
  const bets = [...[...Array(60)].map((_, i) => pre(i, 0.48, { steam: 0.04 })), ...[...Array(60)].map((_, i) => pre(100 + i, 0.52))];
  // in play: 120 settled at fair 50%, only 35 won (-4.6 sd)
  for (let i = 0; i < 120; i++) bets.push({ key: 'ip' + i, live: true, status: 'placed', inPlay: true, stake: 40, fairProb: 0.5, result: i < 35 ? 'won' : 'lost', profit: 0 });
  const v = strategyVerdicts(bets, s);
  assert.deepEqual([...v.keys()].sort(), ['in-play: Pinnacle live', 'pre-match: steam']);
  assert.match(v.get('pre-match: steam'), /CLV -4.0%/);
  assert.equal(strategyOf({ market: 'soccer_props' }), 'pre-match: soccer goals model');
  assert.equal(strategyOf({ inPlay: true, model: { kind: 'inplay-model', late: true } }), 'in-play: model 80+ (test)');
  // too few picks: nothing judged
  assert.equal(strategyVerdicts(bets.slice(0, 30), s).size, 0);
});

test('paused strategy: the executor places it as a dry run even with real betting on', async () => {
  const { BetikaExecutor } = await import('../src/betika/executor.js');
  const { makeSettings } = await import('../src/config.js');
  const { Store } = await import('../src/store.js');
  let sent;
  const client = { placeBet: async (b) => { sent = b; return { status: b.live ? 'placed' : 'dry_run', odds: 2.2 }; } };
  const store = new Store(':memory:');
  const ex = new BetikaExecutor(makeSettings({ betikaLive: true, betikaFixedStake: 40, winningsTax: {} }), client, store, { log: { info() {}, warn() {}, error() {} }, notify: async () => {} });
  ex.pausedStrategy = (o) => (o.steam ? 'CLV -4.0%' : null);
  const opp = { book: 'betika', fairProb: 0.5, ev: 0.1, decimal: 2.2, stake: 40, eventId: 'e', market: 'h2h', outcome: 'A', homeTeam: 'A', awayTeam: 'B',
    betikaRef: { parentMatchId: '1', home: 'A', away: 'B', swapped: false } };
  await ex.execute({ ...opp, steam: { move: 0.04 } });
  assert.equal(sent.live, false);
  assert.equal(store.data.bets.at(-1).strategyPaused, 'CLV -4.0%');
  assert.ok(store.data.bets.at(-1).placeMs >= 0);
  await ex.execute({ ...opp, eventId: 'f' });
  assert.equal(sent.live, true);
});
