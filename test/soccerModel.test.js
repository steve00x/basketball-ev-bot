import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListings, propRule } from '../src/betika/api.js';
import { attachBetikaOdds, betikaPick } from '../src/betika/odds.js';
import { makeSettings } from '../src/config.js';
import { ruleHolds, ruleProb, scoreMatrix } from '../src/goalModel.js';
import { scanEvent } from '../src/scanner.js';
import { gradePick } from '../src/settle.js';
import { SPORTS } from '../src/sports.js';

const A = { pH: 0.48, pD: 0.27, pA: 0.25, line: 2.5, pOver: 0.52 };

test('score matrix matches Pinnacle\'s 1X2 and total exactly', () => {
  const { M } = scoreMatrix(A);
  const close = (x, y) => Math.abs(x - y) < 1e-6;
  assert.ok(close(ruleProb(M, { res: 'H' }), 0.48) && close(ruleProb(M, { res: 'D' }), 0.27) && close(ruleProb(M, { res: 'A' }), 0.25));
  assert.ok(close(ruleProb(M, { total: { line: 2.5, over: true } }), 0.52));
  const btts = ruleProb(M, { btts: true });
  assert.ok(btts > 0.45 && btts < 0.6, String(btts));
  // consistency: BTTS yes + no = 1; home & over <= home
  assert.ok(close(btts + ruleProb(M, { btts: false }), 1));
  assert.ok(ruleProb(M, { res: 'H', total: { line: 2.5, over: true } }) < 0.48);
});

test('Betika button labels become score rules (as on the site)', () => {
  assert.deepEqual(propRule('res_total', 'X & OVER 1.5'), { res: ['X'], total: { line: 1.5, over: true } });
  assert.deepEqual(propRule('dc_btts', 'X/2 & NO'), { res: ['X', '2'], btts: false });
  assert.deepEqual(propRule('total_btts', 'OVER 2.5 & YES'), { total: { line: 2.5, over: true }, btts: true });
  assert.deepEqual(propRule('team_total', 'UNDER 1.5', '2'), { team: { side: '2', line: 1.5, over: false } });
  assert.deepEqual(propRule('win_to_nil', 'NO', '1'), { res: ['1'], zero: '2', neg: true });
  assert.deepEqual(propRule('multigoals', '2-4'), { range: [2, 4] });
  assert.deepEqual(propRule('multigoals', 'NO GOAL'), { range: [0, 0] });
  assert.equal(propRule('res_total', 'X/2 & OVER 1.5'), null); // a DC label in the 1X2 market: not trusted
  assert.ok(ruleHolds({ res: 'H', zero: 'A', neg: true }, 1, 1));   // home win to nil NO, 1-1
  assert.ok(!ruleHolds({ res: 'H', zero: 'A', neg: true }, 2, 0));
});

test('scan: Betika goals markets vs the model; teams swapped on Betika handled; graded from the final score', () => {
  const row = (st, name, odds) => ({ sub_type_id: String(st), name, odds: odds.map(([display, v]) => ({ display, odd_value: String(v) })) });
  // Betika lists the away team first here (swapped)
  const listing = { data: [{ parent_match_id: 9, match_id: 9, home_team: 'Away FC', away_team: 'Home FC', start_time: '2026-11-26 18:00:00',
    competition_name: 'EPL', category: 'England', odds: [
      row(1, '1X2', [['1', 3.9], ['X', 3.6], ['2', 2.05]]),
      row(29, 'BOTH TEAMS TO SCORE (GG/NG)', [['YES', 2.1], ['NO', 1.55]]),   // model BTTS ~55% -> YES 2.10 = +16%
      row(19, 'AWAY FC TOTAL', [['OVER 0.5', 1.40], ['UNDER 0.5', 2.9]]),
      row(33, 'AWAY FC WIN TO NIL', [['YES', 4.0], ['NO', 1.2]]) ] }] };
  const [m] = parseListings(listing, null, SPORTS.soccer, 'soccer');
  assert.equal(m.props.length, 6);
  const now = new Date('2026-11-25T12:00:00Z');
  const ev = { id: 'e1', sport_key: 'soccer_epl', home_team: 'Home FC', away_team: 'Away FC', commence_time: '2026-11-26T15:00:00Z',
    bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: now.toISOString(), markets: [
      { key: 'h2h', last_update: now.toISOString(), outcomes: [{ name: 'Home FC', price: 2.02 }, { name: 'Away FC', price: 3.85 }, { name: 'Draw', price: 3.55 }] },
      { key: 'totals', last_update: now.toISOString(), outcomes: [{ name: 'Over', price: 1.88, point: 2.5 }, { name: 'Under', price: 2.0, point: 2.5 }] }] }] };
  attachBetikaOdds([ev], [m], now);
  assert.equal(ev.betikaRef.swapped, true);
  const s = makeSettings({ targetBooks: ['betika'], winningsTax: {}, soccerModelMinEv: 0.05, soccerModelMaxEv: 0.25, maxLineAgeSeconds: 300 });
  const opps = scanEvent(ev, s, now).filter((o) => o.market === 'soccer_props');
  const btts = opps.find((o) => o.betikaLabel === 'YES' && o.propKind === 'btts');
  assert.ok(btts && btts.ev > 0.05 && btts.ev <= 0.25, JSON.stringify(opps.map((o) => [o.betikaMarket, o.betikaLabel, o.ev])));
  // Betika's "AWAY FC TOTAL" is its first team = our away team
  const awayOver = scanEvent(ev, { ...s, minEv: -1, soccerModelMinEv: -1, soccerModelMaxEv: 9 }, now).find((o) => o.betikaMarket === 'AWAY FC TOTAL' && o.betikaLabel === 'OVER 0.5');
  assert.deepEqual(awayOver.rule.team, { side: 'A', line: 0.5, over: true });
  assert.deepEqual(betikaPick(btts), { market: 'BOTH TEAMS TO SCORE (GG/NG)', label: 'YES' });
  // market 33 = Betika's first team (here our away team): away wins and our home team scores 0
  const wtn = scanEvent(ev, { ...s, minEv: -1, soccerModelMinEv: -1, soccerModelMaxEv: 9 }, now).find((o) => o.betikaMarket === 'AWAY FC WIN TO NIL' && o.betikaLabel === 'YES');
  assert.equal(wtn.rule.res, 'A');
  assert.equal(wtn.rule.zero, 'H');
  const g = { market: 'soccer_props', rule: btts.rule };
  assert.equal(gradePick(g, 1, 1), 'won');
  assert.equal(gradePick(g, 2, 0), 'lost');
});
