import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, acquireLock } from '../src/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
const quiet = { error() {} };
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

test('Windows EPERM on rename: retries, then writes in place; never throws', () => {
  const file = path.join(dir, 'a.json');
  let renames = 0;
  const lockedFs = { ...fs, renameSync: () => { renames++; throw eperm(); } };
  const store = new Store(file, { log: quiet, fsImpl: lockedFs });
  store.recordBet({ key: 'k1', live: true, status: 'placed', at: new Date().toISOString(), stake: 40 });
  assert.ok(renames > 1); // retried
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bets.length, 1); // written in place
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('even a total disk failure keeps the bet in memory, so it is never repeated', () => {
  const brokenFs = { ...fs, writeFileSync: () => { throw eperm(); }, existsSync: () => false };
  const errors = [];
  const store = new Store(path.join(dir, 'b.json'), { log: { error: (m) => errors.push(m) }, fsImpl: brokenFs });
  assert.doesNotThrow(() => store.recordBet({ key: 'k2', live: true, status: 'placed', at: new Date().toISOString(), stake: 40 }));
  assert.equal(store.hasBet('k2'), true);
  assert.match(errors[0], /kept in memory/);
  assert.doesNotThrow(() => store.recordAlert('x', 0.03));
});

test('only one bot at a time', () => {
  const file = path.join(dir, 'c.json');
  const release = acquireLock(file);
  // a different live process holding the lock (use our parent's pid, which is alive)
  fs.writeFileSync(`${file}.lock`, String(process.ppid));
  assert.throws(() => acquireLock(file), /already running/);
  // a stale lock from a process that's gone is taken over
  fs.writeFileSync(`${file}.lock`, '999999');
  const release2 = acquireLock(file);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), String(process.pid));
  release2();
  assert.equal(fs.existsSync(`${file}.lock`), false);
  release();
});

test('reload: a second reader picks up what a running scan saves, and keeps the last good copy on a bad read', async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'evstore-')), 'store.json');
  const quiet = { error() {} };
  const scan = new Store(path, { log: quiet });
  scan.data.bets.push({ key: 'a', status: 'placed' });
  scan.save();
  const view = new Store(path, { log: quiet });
  assert.equal(view.data.bets.length, 1);
  assert.equal(view.reload(), true);  // first look records the file's time
  assert.equal(view.reload(), false); // unchanged: no re-read
  scan.data.bets.push({ key: 'b', status: 'placed' });
  scan.save();
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // make sure the time moves on fast disks
  assert.equal(view.reload(), true);
  assert.deepEqual(view.data.bets.map((b) => b.key), ['a', 'b']);
  writeFileSync(path, '{"bets": [ {"key"'); // caught mid-write
  utimesSync(path, new Date(), new Date(Date.now() + 10000));
  assert.equal(view.reload(), false);
  assert.equal(view.data.bets.length, 2);
});
