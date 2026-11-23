import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as om from '../src/oddsMath.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('american <-> decimal', () => {
  for (const [am, dec] of [[100, 2], [150, 2.5], [-200, 1.5], [-110, 1.9091]]) {
    close(om.americanToDecimal(am), dec);
    assert.equal(om.decimalToAmerican(om.americanToDecimal(am)), am);
  }
});

for (const m of Object.keys(om.DEVIG_METHODS)) {
  test(`devig ${m} sums to one`, () => {
    const even = om.devig([1.909, 1.909], m);
    close(even[0], 0.5); close(even[1], 0.5);
    const f = om.devig([1.5, 2.6], m);
    close(f[0] + f[1], 1);
    assert.ok(f[0] > f[1]);
  });
}

test('power shades longshot more than multiplicative', () => {
  assert.ok(om.devig([1.25, 4], 'power')[1] < om.devig([1.25, 4], 'multiplicative')[1]);
});

test('devig errors', () => {
  assert.throws(() => om.devig([2], 'power'));
  assert.throws(() => om.devig([2, 2], 'nope'));
});

test('EV, Kelly, stake, min odds', () => {
  close(om.expectedValue(0.5, 2.1), 0.05);
  close(om.kellyFraction(0.5, 2.1), 0.05 / 1.1);
  assert.equal(om.kellyFraction(0.4, 2), 0);
  close(om.stake(0.5, 2.1, 1000, 0.25, 0.02), 11.36, 0.01);
  assert.equal(om.stake(0.7, 2, 1000, 1, 0.02), 20);
  close(om.minAcceptableOdds(0.5, 0.02), 2.04);
});
