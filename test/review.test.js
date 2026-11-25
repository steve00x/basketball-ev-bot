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
