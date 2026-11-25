// Steam: sharp moves in Pinnacle's pre-match price. When Pinnacle moves a line a lot in a few
// minutes (team news, big money), Betika usually follows later, and Pinnacle often keeps moving
// the same way. The tracker:
//  - remembers each line's fair probability over the last STEAM_WINDOW_MINUTES,
//  - tags picks Pinnacle is moving towards (steam) and flags picks it is moving away from,
//  - puts games that just moved on a watch list, re-priced every STEAM_POLL_SECONDS for
//    STEAM_WATCH_MINUTES so a lagging Betika price is caught quickly (1 credit per market per poll).
const lineKey = (o) => [o.eventId, o.market, o.description ?? '', o.outcome, o.point ?? ''].join('|');

export class SteamTracker {
  constructor(s) {
    this.s = s;
    this.hist = new Map();  // line -> [{ t, p }]
    this.watch = new Map(); // eventId -> { sport, until, nextAt, reason }
    this.spent = { day: null, credits: 0 };
  }

  /** Feed every priced pre-match pick of a scan. Returns the events that just moved. */
  observe(priced, now = Date.now()) {
    const win = this.s.steamWindowMinutes * 60_000;
    const moved = new Map();
    for (const o of priced) {
      if (o.inPlay || !(o.fairProb > 0) || String(o.eventId).startsWith('op-')) continue; // OddsPapi-only games can't be re-priced
      const k = lineKey(o);
      const arr = (this.hist.get(k) ?? []).filter((x) => now - x.t <= win);
      arr.push({ t: now, p: o.fairProb });
      this.hist.set(k, arr);
      const move = o.fairProb - arr[0].p;
      if (move >= this.s.steamMinMove && !moved.has(o.eventId)) {
        moved.set(o.eventId, { sport: o.sport, move, what: `${o.outcome}${o.point != null ? ` ${o.point}` : ''}`, minutes: (now - arr[0].t) / 60_000 });
      }
    }
    for (const [k, arr] of this.hist) if (now - arr.at(-1).t > 2 * win) this.hist.delete(k);
    for (const [id, m] of moved) {
      const w = this.watch.get(id);
      if (w) { w.until = now + this.s.steamWatchMinutes * 60_000; continue; }
      if (this.watch.size >= this.s.steamMaxEvents) continue;
      this.watch.set(id, { sport: m.sport, until: now + this.s.steamWatchMinutes * 60_000, nextAt: now + this.s.steamPollSeconds * 1000, reason: m });
    }
    return [...moved].map(([eventId, m]) => ({ eventId, ...m }));
  }

  /** Signed move of this pick's fair probability over the window (+ = Pinnacle moving towards it). */
  moveOf(o) {
    const arr = this.hist.get(lineKey(o));
    return arr?.length > 1 ? arr.at(-1).p - arr[0].p : 0;
  }

  /** Tag picks with their move; drop those Pinnacle is still moving away from. Returns the dropped ones. */
  apply(opps) {
    const dropped = [];
    for (let i = opps.length - 1; i >= 0; i--) {
      const o = opps[i];
      if (o.inPlay) continue;
      const move = this.moveOf(o);
      if (move >= this.s.steamMinMove) o.steam = { move };
      else if (move <= -this.s.steamMinMove) dropped.push(...opps.splice(i, 1));
    }
    return dropped;
  }

  /** Watched games due for a re-price, within the daily credit budget. */
  due(now = Date.now(), creditsPerPoll = 2) {
    const day = new Date(now).toDateString();
    if (this.spent.day !== day) this.spent = { day, credits: 0 };
    for (const [id, w] of this.watch) if (w.until <= now) this.watch.delete(id);
    if (this.spent.credits + creditsPerPoll > this.s.steamDailyCredits) return [];
    return [...this.watch].filter(([, w]) => w.nextAt <= now).map(([eventId, w]) => ({ eventId, sport: w.sport }));
  }

  polled(eventId, credits, now = Date.now()) {
    this.spent.credits += credits;
    const w = this.watch.get(eventId);
    if (w) w.nextAt = now + this.s.steamPollSeconds * 1000;
  }

  /** When the next watched game is due (ms), or null. */
  nextDueAt() {
    if (this.spent.credits >= this.s.steamDailyCredits) return null;
    let t = null;
    for (const w of this.watch.values()) if (t === null || w.nextAt < t) t = w.nextAt;
    return t;
  }
}
