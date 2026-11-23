// One scan cycle: fetch sharp odds -> read Betika -> find +EV -> alert -> bet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBetikaOdds } from './betika/odds.js';
import { SPORTS, resolveSportKeys, sportGroup } from './sports.js';
import { OddsAPIError } from './oddsApi.js';
import { dedupeKey, matchup, scanEvents, selection } from './scanner.js';

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

/**
 * Odds API sport keys to scan. SPORTS may hold groups ("soccer", "tennis", "icehockey", ...)
 * or exact keys ("soccer_epl"); groups expand to whatever is in season, via the free
 * /v4/sports call (cached for 6 hours).
 */
const sportsCache = { at: 0, list: null };
export async function resolveKeys(api, s, log = console) {
  const needsList = s.sports.some((e) => SPORTS[e.toLowerCase()] || ['soccer', 'soccer_small', 'soccer_all'].includes(e.toLowerCase()));
  if (!needsList) return s.sports;
  if (!sportsCache.list || Date.now() - sportsCache.at > 6 * 3600_000) {
    try {
      sportsCache.list = await api.getSports();
      sportsCache.at = Date.now();
    } catch (e) {
      log.error(`could not list Odds API sports: ${e.message}`);
      return s.sports.filter((e) => !SPORTS[e.toLowerCase()]);
    }
  }
  const { keys, missing } = resolveSportKeys(s.sports, sportsCache.list);
  if (missing.length) log.info(`no Pinnacle-priced events on The Odds API right now for: ${missing.join(', ')}`);
  return keys;
}

/** Markets worth paying for on a key: those Betika can compare, limited by MARKETS / MARKETS_<SPORT>. */
export const marketsFor = (key, s) => {
  const group = sportGroup(key) ?? '';
  const spec = SPORTS[group];
  const wanted = s.marketsBySport?.[group] ?? s.markets;
  return spec ? wanted.filter((m) => spec.oddsMarkets.includes(m)) : wanted;
};

/** Every in-season Odds API key of a sport group, from the cached /v4/sports list. */
export const activeKeysFor = (group) => (sportsCache.list ?? [])
  .filter((x) => x.active !== false && !x.has_outrights && sportGroup(x.key) === group).map((x) => x.key);

export async function fetchEvents(api, s, log = console) {
  const { apiBooks } = bookPlan(s);
  const now = new Date();
  const horizon = new Date(+now + s.maxHoursToStart * 3600_000);
  const all = [];
  const keys = await resolveKeys(api, s, log);
  const cost = keys.reduce((n, k) => n + marketsFor(k, s).length, 0);
  log.info(`scanning ${keys.length} leagues: ${keys.join(', ')} (~${cost} credits per scan)`);
  let skipped = 0;
  for (const sport of keys) {
    const markets = marketsFor(sport, s);
    if (!markets.length) continue;
    // Odds calls cost credits even when a league has no games; the events list is free.
    if (api.getEvents) {
      try {
        const upcoming = await api.getEvents(sport);
        if (!upcoming.some((ev) => { const t = new Date(ev.commence_time); return t > now && t <= horizon; })) {
          skipped++;
          continue;
        }
      } catch (e) {
        log.warn(`${sport}: event list failed (${e.message}), fetching odds anyway`);
      }
    }
    let events;
    try {
      events = await api.getOdds(sport, markets, s.regions, apiBooks);
    } catch (e) {
      if (!(e instanceof OddsAPIError)) throw e;
      log.error(`${sport}: ${e.message}`);
      continue;
    }
    events = events.filter((ev) => new Date(ev.commence_time) <= horizon);
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
  if (skipped) log.info(`skipped ${skipped} leagues with no games in the next ${s.maxHoursToStart}h (saved credits)`);
  return all;
}

export async function runCycle({ events, s, store, notifier, betika = null, executor = null, log = console }) {
  if (betika) {
    try {
      const groups = [...new Set(events.map((e) => sportGroup(e.sport_key ?? '') ?? 'basketball'))];
      const matches = betika.allMatches ? await betika.allMatches(groups, log) : await betika.basketball();
      const r = attachBetikaOdds(events, matches);
      log.info(`betika: ${r.matches} matches (${groups.join(', ')}), ${r.matched} matched to ${events.length} sharp events`);
      if (r.unmatched.length) log.info(`betika: unmatched: ${r.unmatched.join('; ')}`);
    } catch (e) {
      log.error(`betika: could not read odds: ${e.message}`);
    }
  }
  const scanSettings = { ...s, targetBooks: bookPlan(s).scanTargets };
  const opps = scanEvents(events, scanSettings);
  if (s.betikaFixedStake > 0) for (const o of opps) if (o.book === 'betika') o.stake = s.betikaFixedStake; // alerts show the real stake
  const fresh = opps.filter((o) => store.shouldAlert(dedupeKey(o), o.ev, s.realertEvDelta));
  log.info(`found ${opps.length} +EV bets (${fresh.length} new)`);
  if (!opps.length) {
    // Show the closest call so you can see prices really are being compared.
    const [best] = scanEvents(events, { ...scanSettings, minEv: -1 });
    if (best) {
      log.info(`closest: ${selection(best)} (${matchup(best)}) @ ${best.bookTitle} ${best.decimal} = `
        + `${(best.ev * 100).toFixed(1)}% EV after tax (${((best.fairProb * best.decimal - 1) * 100).toFixed(1)}% before tax) `
        + `vs fair ${(1 / best.fairProb).toFixed(2)} (need +${(s.minEv * 100).toFixed(1)}%)`);
    }
  }
  await notifier.sendOpportunities(fresh);
  for (const o of fresh) store.recordAlert(dedupeKey(o), o.ev);

  const results = [];
  if (executor) {
    for (const o of fresh) if (o.book === 'betika') results.push({ opp: o, result: await executor.execute(o) });
  }
  return { opps: fresh, results };
}
