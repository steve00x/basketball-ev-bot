// JSON-file store: alert de-duplication and a log of every bet attempt.
import fs from 'node:fs';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Store {
  /** path ':memory:' keeps everything in RAM (demo / tests). */
  constructor(path = 'ev-bot-store.json', { log = console, fsImpl = fs } = {}) {
    this.path = path;
    this.log = log;
    this.fs = fsImpl;
    this.data = { alerts: {}, bets: [] };
    if (path !== ':memory:' && fsImpl.existsSync(path)) {
      this.data = { ...this.data, ...JSON.parse(fsImpl.readFileSync(path, 'utf8')) };
    }
  }

  /**
   * Write to disk without ever throwing. On Windows the rename fails with EPERM/EBUSY while
   * another program (VS Code showing the file, antivirus) has it open, so retry briefly, then
   * write the file directly. Everything stays in memory either way, so a bet placed this run
   * is never forgotten (and never repeated) even if the disk write fails.
   */
  save() {
    if (this.path === ':memory:') return true;
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.path}.tmp`;
    try {
      this.fs.writeFileSync(tmp, json);
      for (let i = 0; i < 8; i++) {
        try {
          this.fs.renameSync(tmp, this.path); // atomic replace
          return true;
        } catch (e) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          pause(50 * (i + 1));
        }
      }
      this.fs.writeFileSync(this.path, json); // locked for rename: overwrite in place
      try { this.fs.unlinkSync(tmp); } catch { /* best effort */ }
      return true;
    } catch (e) {
      this.log.error?.(`could not save ${this.path} (${e.code ?? e.message}) - kept in memory; close the file if it's open in another program`);
      return false;
    }
  }

  /**
   * Re-read the file if another process (a running scan) has written it since we last looked.
   * Read-only use (the standalone dashboard): a half-written or locked file is skipped and the
   * last good copy kept. Returns true when new data was loaded.
   */
  reload() {
    if (this.path === ':memory:') return false;
    try {
      const mtime = this.fs.statSync(this.path).mtimeMs;
      if (mtime === this.loadedMtime) return false;
      const data = JSON.parse(this.fs.readFileSync(this.path, 'utf8'));
      this.data = { alerts: {}, bets: [], ...data };
      this.loadedMtime = mtime;
      return true;
    } catch {
      return false; // missing, mid-write or locked: try again on the next refresh
    }
  }

  shouldAlert(key, ev, delta) {
    const prev = this.data.alerts[key];
    return prev === undefined || ev >= prev + delta;
  }

  recordAlert(key, ev) {
    this.data.alerts[key] = ev;
    this.save();
  }

  hasBet(key) {
    return this.data.bets.some((b) => b.key === key && b.live && ['placed', 'unknown'].includes(b.status));
  }

  /** Live bets since local midnight whose status is in `statuses`. */
  liveBetsToday(statuses) {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    return this.data.bets.filter((b) => b.live && statuses.has(b.status) && new Date(b.at) >= midnight);
  }

  recordBet(bet) {
    this.data.bets.push(bet);
    this.save();
  }
}

/**
 * One bot at a time: two copies would each place the same bets. Creates `<store>.lock`
 * holding our process id; refuses if another live process holds it. Returns a release function.
 */
export function acquireLock(storePath, { fsImpl = fs, pid = process.pid } = {}) {
  if (storePath === ':memory:') return () => {};
  const lock = `${storePath}.lock`;
  try {
    const other = Number(fsImpl.readFileSync(lock, 'utf8'));
    if (other && other !== pid) {
      let alive = false;
      try { process.kill(other, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) throw new Error(`another copy of the bot is already running (process ${other}). Stop it first, or delete ${lock} if it isn't running.`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fsImpl.writeFileSync(lock, String(pid));
  return () => { try { if (Number(fsImpl.readFileSync(lock, 'utf8')) === pid) fsImpl.unlinkSync(lock); } catch { /* gone */ } };
}
