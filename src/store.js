// JSON-file store: alert de-duplication and a log of every bet attempt.
import fs from 'node:fs';

export class Store {
  /** path ':memory:' keeps everything in RAM (demo / tests). */
  constructor(path = 'ev-bot-store.json') {
    this.path = path;
    this.data = { alerts: {}, bets: [] };
    if (path !== ':memory:' && fs.existsSync(path)) {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(path, 'utf8')) };
    }
  }

  save() {
    if (this.path === ':memory:') return;
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.path); // atomic replace
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
