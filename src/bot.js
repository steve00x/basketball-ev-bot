// One scan cycle: fetch sharp odds -> read Betika -> find +EV -> alert -> bet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBetikaOdds } from './betika/odds.js';
import { OddsAPIError } from './oddsApi.js';
import { dedupeKey, scanEvents } from './scanner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE_EVENTS = path.join(ROOT, 'sample_data', 'nba_odds.json');
export const SAMPLE_BETIKA = path.join(ROOT, 'sample_data', 'betika_matches.json');

/** Sample data with timestamps shifted so games are upcoming and lines are fresh. */
export function loadDemoEvents(file = SAMPLE_EVENTS, now = new Date()) {
  const events = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fresh = new Date(+now - 30_000).toISOString();
  events.forEach((ev, i) => {
    ev.commence_time = new Date(+now + (2 + i) * 3600_000).toISOString();
    for (const bm of ev.bookmakers ?? []) {
      bm.last_update = fresh;
      for (const m of bm.markets ?? []) m.last_update = fresh;
    }
  });
  return events;
}

/**
 * Stand-ins for --demo: a saved Betika odds snapshot and a placer that never opens a browser.
 * Match start times are shifted to line up with loadDemoEvents().
 */
export class DemoBetikaFeed {
  constructor(file = SAMPLE_BETIKA, now = new Date()) {
    this.matches = JSON.parse(fs.readFileSync(file, 'utf8')).map((m, i) => ({
      ...m, start: new Date(+now + (2 + i) * 3600_000) }));
  }
  async basketball() { return structuredClone(this.matches); }
}

export class DemoBetikaPlacer {
  constructor(feed) { this.feed = feed; }
  async placeBet(bet) {
    const m = this.feed.matches.find((x) => x.parentMatchId === bet.parentMatchId);
    if (!m) return { status: 'match_unavailable' };
    let odds;
    if (/^winner/i.test(bet.market)) odds = m.winner?.[bet.label === '1' ? 0 : 1];
    else {
      const [side, pt] = bet.label.split(' ');
      odds = m.totals.find((l) => l.point === Number(pt))?.[side.toLowerCase()];
    }
    if (!odds) return { status: 'outcome_not_found' };
    if (odds < bet.minOdds) return { status: 'price_moved', odds, minOdds: bet.minOdds };
    return { status: 'dry_run', odds, stake: bet.stake };
  }
  async close() {}
}

/** Books to request from The Odds API, and books the scanner may flag. */
export function bookPlan(s) {
  if (s.betikaEnabled && !s.targetBooks.length) {
    // Betika prices come from the browser, so only pay The Odds API for the sharp books.
    return { apiBooks: s.sharpBooks, scanTargets: ['betika'] };
  }
  const targets = s.betikaEnabled ? [...s.targetBooks, 'betika'] : s.targetBooks;
  return { apiBooks: s.targetBooks.length ? [...s.sharpBooks, ...s.targetBooks] : null, scanTargets: targets };
}

export async function fetchEvents(api, s, log = console) {
  const { apiBooks } = bookPlan(s);
  const now = new Date();
  const horizon = new Date(+now + s.maxHoursToStart * 3600_000);
  const all = [];
  for (const sport of s.sports) {
    let events;
    try {
      events = await api.getOdds(sport, s.markets, s.regions, apiBooks);
    } catch (e) {
      if (!(e instanceof OddsAPIError)) throw e;
      log.error(`${sport}: ${e.message}`);
      continue;
    }
    log.info(`${sport}: ${events.length} events (credits remaining: ${api.requestsRemaining})`);
    if (s.propMarkets.length) {
      for (const ev of events) {
        const start = new Date(ev.commence_time);
        if (!(start > now && start <= horizon)) continue; // don't pay for games we'd skip
        let props;
        try {
          props = await api.getEventOdds(sport, ev.id, s.propMarkets, s.regions, apiBooks);
        } catch (e) {
          log.warn(`props for ${ev.id} failed: ${e.message}`);
          continue;
        }
        const byKey = new Map((ev.bookmakers ??= []).map((b) => [b.key, b]));
        for (const pb of props.bookmakers ?? []) {
          if (byKey.has(pb.key)) byKey.get(pb.key).markets.push(...(pb.markets ?? []));
          else ev.bookmakers.push(pb);
        }
      }
    }
    all.push(...events);
  }
  return all;
}

export async function runCycle({ events, s, store, notifier, betika = null, executor = null, log = console }) {
  if (betika) {
    try {
      const matches = await betika.basketball();
      const r = attachBetikaOdds(events, matches);
      log.info(`betika: ${r.matches} basketball matches, ${r.matched} matched to ${events.length} sharp events`);
    } catch (e) {
      log.error(`betika: could not read odds: ${e.message}`);
    }
  }
  const scanSettings = { ...s, targetBooks: bookPlan(s).scanTargets };
  const opps = scanEvents(events, scanSettings);
  const fresh = opps.filter((o) => store.shouldAlert(dedupeKey(o), o.ev, s.realertEvDelta));
  log.info(`found ${opps.length} +EV bets (${fresh.length} new)`);
  await notifier.sendOpportunities(fresh);
  for (const o of fresh) store.recordAlert(dedupeKey(o), o.ev);

  const results = [];
  if (executor) {
    for (const o of fresh) if (o.book === 'betika') results.push({ opp: o, result: await executor.execute(o) });
  }
  return { opps: fresh, results };
}
