// One scan cycle: fetch sharp odds -> read Betika -> find +EV -> alert -> bet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBetikaOdds } from './betika/odds.js';
import { SPORTS, isRemovedSport, resolveSportKeys, sportGroup } from './sports.js';
import { OddsAPIError } from './oddsApi.js';
import { dedupeKey, matchup, scanEvents, selection } from './scanner.js';
import { recordClosing } from './insights.js';

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
  // Sportsbooks whose odds the bot reads itself (Betika, and others added later): no Odds API cost.
  const own = [...(s.betikaEnabled ? ['betika'] : []), ...(s.ownFeedBooks ?? [])];
  if (own.length && !s.targetBooks.length) {
    // their prices come from their own feeds, so only pay The Odds API for the sharp books.
    return { apiBooks: s.sharpBooks, scanTargets: own };
  }
  const targets = [...s.targetBooks, ...own];
  return { apiBooks: s.targetBooks.length ? [...s.sharpBooks, ...s.targetBooks] : null, scanTargets: targets };
}

/**
 * Odds API sport keys to scan. SPORTS may hold groups ("soccer", "tennis", "basketball", ...)
 * or exact keys ("soccer_epl"); groups expand to whatever is in season, via the free
 * /v4/sports call (cached for 6 hours).
 */
// The in-season list is cached per Odds API client (6 hours); `lastSportsList` serves the sports command.
let lastSportsList = null;
let removedNoted = false;
export async function resolveKeys(api, s, log = console) {
  const removed = s.sports.filter(isRemovedSport);
  if (removed.length && !removedNoted) {
    removedNoted = true;
    log.info(`ice hockey is no longer part of the bot - ignoring ${removed.join(', ')} in SPORTS (you can delete it from .env)`);
  }
  const sports = s.sports.filter((e) => !isRemovedSport(e));
  const needsList = sports.some((e) => SPORTS[e.toLowerCase()] || ['soccer', 'soccer_small', 'soccer_all'].includes(e.toLowerCase()));
  if (!needsList) return sports;
  const sportsCache = (api.sportsCache ??= { at: 0, list: null });
  if (!sportsCache.list || Date.now() - sportsCache.at > 6 * 3600_000) {
    try {
      sportsCache.list = await api.getSports();
      sportsCache.at = Date.now();
    } catch (e) {
      log.error(`could not list Odds API sports: ${e.message}`);
      return sports.filter((e) => !SPORTS[e.toLowerCase()]);
    }
  }
  lastSportsList = sportsCache.list;
  const { keys, missing } = resolveSportKeys(sports, sportsCache.list);
  if (missing.length) log.info(`no Pinnacle-priced events on The Odds API right now for: ${missing.join(', ')}`);
  return keys;
}

/** Markets worth paying for on a key: those Betika can compare, limited by MARKETS / MARKETS_<SPORT>. */
export const marketsFor = (key, s) => {
  const group = sportGroup(key) ?? '';
  const spec = SPORTS[group];
  let wanted = s.marketsBySport?.[group] ?? s.markets;
  // Team totals need Pinnacle's point spread (the expected margin): +1 credit per basketball league.
  if (group === 'basketball' && s.teamTotals && wanted.includes('totals') && !wanted.includes('spreads')) wanted = [...wanted, 'spreads'];
  return spec ? wanted.filter((m) => spec.oddsMarkets.includes(m) || (m === 'spreads' && group === 'basketball' && s.teamTotals)) : wanted;
};

/** Every in-season Odds API key of a sport group, from the cached /v4/sports list. */
export const activeKeysFor = (group) => (lastSportsList ?? [])
  .filter((x) => x.active !== false && !x.has_outrights && sportGroup(x.key) === group).map((x) => x.key);

/**
 * opts.onlyGroups: only these sport groups (fast pre-start scans);
 * opts.horizonHours: look only this far ahead (leagues without a game that soon are skipped for free).
 */
export async function fetchEvents(api, s, log = console, opts = {}) {
  const { apiBooks } = bookPlan(s);
  const now = new Date();
  const horizon = new Date(+now + (opts.horizonHours ?? s.maxHoursToStart) * 3600_000);
  const all = [];
  let keys = await resolveKeys(api, s, log);
  if (opts.onlyGroups) keys = keys.filter((k) => opts.onlyGroups.includes(sportGroup(k)));
  const cost = keys.reduce((n, k) => n + marketsFor(k, s).length, 0);
  if (!opts.quietKeys) log.info(`scanning ${keys.length} leagues: ${keys.join(', ')} (~${cost} credits per scan)`);
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
    // Pre-game only: games already under way are on Betika's live page, not its pre-game list
    events = events.filter((ev) => { const t = new Date(ev.commence_time); return t > now && t <= horizon; });
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
  if (skipped && !opts.quietKeys) log.info(`skipped ${skipped} leagues with no games in the next ${opts.horizonHours ?? s.maxHoursToStart}h (saved credits)`);
  return all;
}

/**
 * Live Pinnacle prices for games under way. The free event list says which leagues have a game
 * in progress, so credits are only spent on those (h2h + totals; no models in play).
 */
export async function fetchLiveEvents(api, s, log = console) {
  const { apiBooks } = bookPlan(s);
  const now = Date.now();
  const inWindow = (t) => t <= now && now - t <= s.liveMaxHoursSinceStart * 3600_000;
  const keys = (await resolveKeys(api, s, log)).filter((k) => s.liveSports.includes(sportGroup(k)));
  const all = [];
  for (const key of keys) {
    try {
      const evs = await api.getEvents(key);
      if (!evs.some((e) => inWindow(+new Date(e.commence_time)))) continue;
      const markets = marketsFor(key, s).filter((m) => m === 'h2h' || m === 'totals');
      if (!markets.length) continue;
      const odds = await api.getOdds(key, markets, s.regions, apiBooks);
      all.push(...odds.filter((e) => inWindow(+new Date(e.commence_time))));
    } catch (e) {
      if (!(e instanceof OddsAPIError)) throw e;
      log.warn(`live ${key}: ${e.message}`);
    }
  }
  if (all.length) log.info(`live: ${all.length} games in progress (credits remaining: ${api.requestsRemaining})`);
  return all;
}

/** Settings for an in-play scan: started games, fresh Pinnacle prices, stricter edge, no models. */
export const liveSettings = (s) => ({ ...s, inPlay: true, minEv: Math.max(s.liveMinEv, s.minEv),
  maxLineAgeSeconds: s.liveMaxOddsAgeSeconds, altTotals: false, teamTotals: false });

/**
 * One scan + bet pass. In play, `guard` (LiveGuard) blocks picks priced before the current score
 * and `confirm(opp, event, scanSettings)` re-prices a pick with a fresh Pinnacle price before betting.
 */
export async function runCycle({ events, s, store, notifier, betika = null, executor = null, log = console, live = false, guard = null, confirm = null,
  steam = null, decorate = null, now = new Date(), enrich = null, executors = null }) {
  if (live) s = liveSettings(s);
  if (betika) {
    try {
      const groups = [...new Set(events.map((e) => sportGroup(e.sport_key ?? '') ?? 'basketball'))];
      const matches = live ? await betika.allLiveMatches(groups, log)
        : betika.allMatches ? await betika.allMatches(groups, log) : await betika.basketball();
      const r = attachBetikaOdds(events, matches, new Date(), { live });
      log.info(`betika${live ? ' live' : ''}: ${r.matches} matches (${groups.join(', ')}), ${r.matched} matched to ${events.length} sharp events`);
      if (r.unmatched.length && !live) log.info(`betika: unmatched: ${r.unmatched.join('; ')}`);
    } catch (e) {
      log.error(`betika: could not read odds: ${e.message}`);
    }
  }
  if (live && guard) guard.observe(events);
  // extra sharp prices that depend on which markets Betika has (1st half / quarter)
  if (enrich && !live) { try { await enrich(events); } catch (e) { log.warn(`periods: ${e.message}`); } }
  const scanSettings = { ...s, targetBooks: bookPlan(s).scanTargets };
  const opps = scanEvents(events, scanSettings, now);
  if (decorate) opps.forEach(decorate);
  if (s.betikaFixedStake > 0) for (const o of opps) if (o.book === 'betika') o.stake = s.betikaFixedStake; // alerts show the real stake
  const fresh = opps.filter((o) => store.shouldAlert(dedupeKey(o), o.ev, s.realertEvDelta));
  log.info(`found ${opps.length} +EV ${live ? 'LIVE ' : ''}bets (${fresh.length} new)`);
  // Every priced pick at any EV: the closest call (below) and closing prices for CLV
  const priced = scanEvents(events, { ...scanSettings, minEv: -1, altTotalsMinEv: -1, teamTotalsMinEv: -1, soccerModelMinEv: -1, soccerModelMaxEv: Infinity }, now);
  if (!live) for (const st of [store, ...(executor?.extraStores ?? [])]) if (recordClosing(st.data.bets, priced)) st.save();
  if (!live && steam) {
    // Pinnacle moving towards a pick: tagged; moving away: not bet until it settles
    steam.observe(priced);
    const dropped = steam.apply(opps);
    if (dropped.length) log.info(`steam: not betting ${dropped.length} pick(s) Pinnacle is moving away from (${dropped.slice(0, 3).map(selection).join('; ')})`);
  }
  let closest = null;
  if (!opps.length) {
    // Show the closest call so you can see prices really are being compared.
    const [best] = priced;
    if (best) {
      closest = `${selection(best)} (${matchup(best)}) @ ${best.bookTitle} ${best.decimal}: ${(best.ev * 100).toFixed(1)}% EV`;
      log.info(`closest: ${selection(best)} (${matchup(best)}) @ ${best.bookTitle} ${best.decimal} = `
        + `${(best.ev * 100).toFixed(1)}% EV after tax (${((best.fairProb * best.decimal + (best.pushProb ?? 0) - 1) * 100).toFixed(1)}% before tax) `
        + `vs fair ${((1 - (best.pushProb ?? 0)) / best.fairProb).toFixed(2)} (need +${(s.minEv * 100).toFixed(1)}%)`);
    }
  }
  await notifier.sendOpportunities(fresh);
  for (const o of fresh) store.recordAlert(dedupeKey(o), o.ev);

  const results = [];
  // One bet queue per sportsbook, all running at the same time: executor (Betika) plus any in
  // `executors` ({ bookKey: executor }). Within a book, picks go one after another (one browser).
  const books = { ...(executor ? { betika: executor } : {}), ...(executors ?? {}) };
  if (Object.keys(books).length) {
    // Every current opportunity not yet bet gets a try, not only new alerts: one skipped earlier
    // (stake too small, price moved, error) can qualify now. Already-placed bets are skipped.
    const byId = new Map(events.map((e) => [e.id, e]));
    const queue = async (book, ex) => {
      for (let o of opps) {
        if (o.book !== book) continue;
        if (o.inPlay) {
          // in play: only when Pinnacle has priced the current score, then once more with a fresh price
          const why = guard?.check(o, +now);
          if (why) { results.push({ opp: o, result: { status: 'skipped', reason: why } }); continue; }
          if (confirm && !ex.store.hasBet(dedupeKey(o)) && !ex.check(o, s.betikaFixedStake || o.stake)) {
            const c = await confirm(o, byId.get(o.eventId), scanSettings);
            const why2 = c.opp ? guard?.check(c.opp, +now) : c.reason;
            if (why2) {
              log.info(`live: skip ${selection(o)} (${why2.replace(/_/g, ' ')}${c.error ? `: ${c.error}` : ''})`);
              results.push({ opp: o, result: { status: 'skipped', reason: why2 } });
              continue;
            }
            o = c.opp;
          }
        }
        results.push({ opp: o, result: await ex.execute(o) });
      }
    };
    const done = await Promise.allSettled(Object.entries(books).map(([book, ex]) => queue(book, ex)));
    done.forEach((d, i) => { if (d.status === 'rejected') log.error(`${Object.keys(books)[i]}: ${d.reason?.stack ?? d.reason}`); });
    if (results.length) {
      const count = {};
      for (const { result: r } of results) { const k = r.status === 'skipped' ? r.reason : r.status; count[k] = (count[k] ?? 0) + 1; }
      const already = results.filter((r) => r.result.reason === 'already_bet').map((r) => selection(r.opp));
      log.info(`betika: ${Object.entries(count).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}`
        + (already.length ? ` (already bet: ${already.slice(0, 5).join('; ')}${already.length > 5 ? '; ...' : ''})` : ''));
    }
  }
  return { opps: fresh, found: opps.length, all: opps, closest, results };
}

/**
 * When to scan next. A full scan every POLL_SECONDS; in between, if a game of a FAST_SCAN_SPORTS
 * sport starts within FAST_SCAN_MINUTES, a fast scan (only those leagues, only that window)
 * every FAST_POLL_SECONDS. `upcoming` = start times (ms) of fast-sport games from the last scans.
 */
export function nextScanPlan({ now, lastFull, s, upcoming = [] }) {
  const fullDue = lastFull + s.pollSeconds * 1000;
  if (now >= fullDue) return { kind: 'full', waitMs: 0 };
  if (s.fastScanMinutes > 0) {
    const windowMs = s.fastScanMinutes * 60_000;
    const soon = upcoming.filter((t) => t > now).sort((a, b) => a - b)[0];
    if (soon !== undefined) {
      // fast scans while a game is inside the window; else wake up when the first game enters it
      const enters = Math.max(soon - windowMs, now);
      const wait = enters > now ? enters - now : s.fastPollSeconds * 1000;
      if (now + wait < fullDue) return { kind: 'fast', waitMs: wait };
    }
  }
  return { kind: 'full', waitMs: fullDue - now };
}
