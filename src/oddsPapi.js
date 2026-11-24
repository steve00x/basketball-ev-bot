// OddsPapi v4 client (https://oddspapi.io/docs): Pinnacle's extra lines (alternate totals,
// team totals) and extra leagues, converted into the same event format The Odds API gives us.
// Used as a second source when The Odds API finds few +EV bets (see bin/ev-bot.js).
//
// Documented facts this relies on:
//  - base https://api.oddspapi.io/v4, key in the `apiKey` query parameter
//  - every billable call = 1 request of the monthly quota (free plan: 250); /v4/account is free
//  - /v4/odds-by-tournaments: up to 5 leagues, exactly one bookmaker, all markets, 1 request
//  - Pinnacle on self-serve plans is `pinnacle+30` (30 s delay)
//  - markets: one marketId per (marketType, period, handicap). `result` = incl. overtime,
//    `fulltime` = regular time. `-team1` is the home side (participant1).
//  - 429 RATE_LIMITED (wait retryMs) vs 429 REQUEST_LIMIT_EXCEEDED (quota gone)
import fs from 'node:fs';
import { SPORTS } from './sports.js';

export const ODDSPAPI_BASE = 'https://api.oddspapi.io/v4';
export const PINNACLE_SLUG = 'pinnacle+30';

export class OddsPapiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400_000;

/** OddsPapi sport name -> our sport group ("Ice Hockey" -> icehockey). */
export function groupForSportName(name) {
  const n = String(name).toLowerCase().replace(/[^a-z]/g, '');
  const table = { soccer: 'soccer', football: 'soccer', basketball: 'basketball', icehockey: 'icehockey', tennis: 'tennis',
    tabletennis: 'tabletennis', volleyball: 'volleyball', cricket: 'cricket', boxing: 'boxing', handball: 'handball',
    rugby: 'rugby', rugbyunion: 'rugby', baseball: 'baseball' };
  return table[n] ?? null;
}

/** Which OddsPapi (marketType, period) feed which of our markets, for one sport group. */
export function marketPlan(group) {
  const spec = SPORTS[group];
  if (!spec) return [];
  const threeWay = spec.h2h.draw;
  const period = threeWay ? 'fulltime' : 'result'; // must settle like Betika's market
  const plan = [{ type: threeWay ? '1x2' : 'moneyline', period, ours: 'h2h' }];
  if (spec.totals) plan.push({ type: 'totals', period, ours: 'totals' });
  if (spec.teamTotals) {
    plan.push({ type: 'teamtotals-team1', period, ours: 'team_totals', side: 'H' });
    plan.push({ type: 'teamtotals-team2', period, ours: 'team_totals', side: 'A' });
  }
  return plan;
}

/** A synthetic sport key so the rest of the bot knows the sport and league (e.g. "basketball_nba"). */
export function sportKeyFor(group, tournament) {
  const name = `${tournament.categoryName ?? ''} ${tournament.tournamentName ?? ''}`.toLowerCase();
  if (group === 'basketball') {
    if (/\bnba\b/.test(name)) return 'basketball_nba';
    if (/euroleague/.test(name)) return 'basketball_euroleague';
    if (/ncaa/.test(name)) return /women/.test(name) ? 'basketball_wncaab' : 'basketball_ncaab';
  }
  const prefix = SPORTS[group].oddsApiPrefixes[0];
  return `${prefix}op${tournament.tournamentId}${/women/.test(name) ? '_women' : ''}`;
}

/**
 * Convert odds-by-tournaments fixtures into Odds-API-style events with a "pinnacle" bookmaker.
 * Only live (bookmakerIsActive, not suspended, active) prices are kept; stale ones are dropped.
 */
export function toEvents(fixtures, { markets, participants, tournaments, groupBySportId, now = new Date() }) {
  const out = [];
  for (const fx of fixtures ?? []) {
    if (fx.statusId !== 0) continue; // pre-game only
    const group = groupBySportId[fx.sportId];
    const tour = tournaments[fx.tournamentId];
    const home = participants[fx.participant1Id], away = participants[fx.participant2Id];
    if (!group || !tour || !home || !away) continue;
    const bk = fx.bookmakerOdds?.[PINNACLE_SLUG];
    if (!bk || !bk.bookmakerIsActive || bk.suspended) continue;
    const plan = marketPlan(group);
    const ts = now.toISOString();
    const bucket = {}; // ours -> outcomes
    for (const [marketId, mk] of Object.entries(bk.markets ?? {})) {
      if (mk.marketActive === false) continue;
      const meta = markets[marketId];
      if (!meta || meta.playerProp) continue;
      const rule = plan.find((p) => p.type === meta.marketType && p.period === meta.period);
      if (!rule) continue;
      const names = Object.fromEntries((meta.outcomes ?? []).map((o) => [String(o.outcomeId), String(o.outcomeName)]));
      for (const [outcomeId, oc] of Object.entries(mk.outcomes ?? {})) {
        const pr = oc.players?.['0'];
        if (!pr || pr.active === false || !(pr.price > 1)) continue;
        const label = names[outcomeId];
        let o = null;
        if (rule.ours === 'h2h') {
          const map = { 1: home, 2: away, X: 'Draw' };
          if (map[label]) o = { name: map[label], price: pr.price };
        } else if (/^(over|under)$/i.test(label ?? '')) {
          o = { name: /^over$/i.test(label) ? 'Over' : 'Under', price: pr.price, point: Number(meta.handicap) };
          if (rule.ours === 'team_totals') o.description = rule.side === 'H' ? home : away;
        }
        if (o) (bucket[rule.ours] ??= []).push(o);
      }
    }
    const mkts = Object.entries(bucket).map(([key, outcomes]) => ({ key, last_update: ts, outcomes }));
    if (!mkts.length) continue;
    out.push({
      id: `op-${fx.fixtureId}`, sport_key: sportKeyFor(group, tour), source: 'oddspapi',
      home_team: home, away_team: away, commence_time: new Date(fx.startTime).toISOString(),
      bookmakers: [{ key: 'pinnacle', title: 'Pinnacle (OddsPapi)', last_update: ts, markets: mkts }],
    });
  }
  return out;
}

export class OddsPapi {
  constructor(apiKey, { fetchImpl = globalThis.fetch, cachePath = 'oddspapi-cache.json', log = console, minGapMs = 1100 } = {}) {
    if (!apiKey) throw new OddsPapiError('ODDSPAPI_KEY is not set', 'NO_KEY');
    Object.assign(this, { apiKey, fetchImpl, cachePath, log, minGapMs });
    this.lastCall = {};
    this.exhaustedUntil = 0;
    this.requestsUsed = 0;
    this.cache = { at: {} };
    if (cachePath !== ':memory:') {
      try { this.cache = { at: {}, ...JSON.parse(fs.readFileSync(cachePath, 'utf8')) }; } catch { /* first run */ }
    }
  }

  saveCache() {
    if (this.cachePath === ':memory:') return;
    try { fs.writeFileSync(this.cachePath, JSON.stringify(this.cache)); } catch (e) { this.log.warn?.(`oddspapi: cache not saved (${e.message})`); }
  }

  /** Cached billable lookups (sports/markets/tournaments/participants change rarely). */
  async cached(name, ttlMs, fn) {
    if (this.cache[name] && Date.now() - (this.cache.at[name] ?? 0) < ttlMs) return this.cache[name];
    this.cache[name] = await fn();
    this.cache.at[name] = Date.now();
    this.saveCache();
    return this.cache[name];
  }

  get quotaGone() { return Date.now() < this.exhaustedUntil; }

  async get(path, params = {}, { gapMs = this.minGapMs, billable = true } = {}) {
    if (billable && this.quotaGone) throw new OddsPapiError('monthly request limit used up', 'REQUEST_LIMIT_EXCEEDED');
    const url = new URL(ODDSPAPI_BASE + path);
    for (const [k, v] of Object.entries({ ...params, apiKey: this.apiKey })) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const wait = (this.lastCall[path] ?? 0) + gapMs - Date.now(); // per-endpoint rate limit
      if (wait > 0) await sleep(wait);
      this.lastCall[path] = Date.now();
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      let body;
      try { body = await res.json(); } catch { body = null; }
      if (res.ok) { if (billable) this.requestsUsed++; return body; }
      const code = body?.error?.code ?? `HTTP_${res.status}`;
      if (code === 'RATE_LIMITED' && attempt < 3) { await sleep(Number(body?.error?.retryMs ?? 1500)); continue; }
      if (code === 'REQUEST_LIMIT_EXCEEDED') {
        const d = new Date(); this.exhaustedUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); // free quota resets on the 1st
      }
      throw new OddsPapiError(`${path}: ${code} ${body?.error?.message ?? ''}`.trim(), code);
    }
    throw new OddsPapiError(`${path}: rate limited`, 'RATE_LIMITED');
  }

  /** Free: plan, request_limit and request_count. */
  account() { return this.get('/account', {}, { billable: false, gapMs: 0 }); }

  async sports() { return this.cached('sports', 30 * DAY, () => this.get('/sports')); }

  async markets() {
    return this.cached('markets', 30 * DAY, async () => Object.fromEntries((await this.get('/markets')).map((m) => [String(m.marketId), m])));
  }

  async tournaments(sportId) { return this.cached(`tournaments_${sportId}`, DAY, () => this.get('/tournaments', { sportId })); }

  async participants(sportId) { return this.cached(`participants_${sportId}`, 7 * DAY, () => this.get('/participants', { sportId })); }

  /** Up to 5 leagues, Pinnacle only, one request. */
  async oddsByTournaments(ids) {
    const body = await this.get('/odds-by-tournaments', { tournamentIds: ids.slice(0, 5).join(','), bookmaker: PINNACLE_SLUG });
    return Array.isArray(body) ? body : (body?.data ?? (body?.fixtureId ? [body] : []));
  }

  /** sportId -> our group, for the groups we bet on. */
  async sportGroups(groups) {
    const map = {};
    for (const sp of await this.sports()) {
      const g = groupForSportName(sp.sportName ?? sp.slug);
      if (g && groups.includes(g)) map[sp.sportId] = g;
    }
    return map;
  }

  /**
   * Leagues to scan: explicit ODDSPAPI_TOURNAMENTS ids, or the busiest leagues of our sports
   * (by upcoming games), skipping women's/youth/virtual ones unless chosen explicitly.
   */
  async chooseTournaments(groupBySportId, { explicit = [], max = 5, priority = [] } = {}) {
    const all = {};
    const ranked = [];
    const rank = (g) => { const i = priority.indexOf(g); return i < 0 ? priority.length : i; };
    for (const [sportId, group] of Object.entries(groupBySportId)) {
      for (const t of await this.tournaments(sportId)) {
        all[t.tournamentId] = { ...t, sportId: Number(sportId), group };
        const upcoming = (t.upcomingFixtures ?? 0) + (t.futureFixtures ?? 0);
        const skip = /women|u\d{2}|youth|reserve|\bii\b|\biii\b|esoccer|srl|simulated|virtual|utr|itf|doubles/i.test(`${t.tournamentName} ${t.categoryName}`);
        if (upcoming > 0 && !skip) ranked.push({ id: t.tournamentId, group, upcoming: t.upcomingFixtures ?? 0, future: t.futureFixtures ?? 0 });
      }
    }
    // ODDSPAPI_SPORTS order first (e.g. basketball before soccer), then the busiest leagues of each sport
    const ids = explicit.length ? explicit.map(Number).filter((id) => all[id])
      : ranked.sort((a, b) => rank(a.group) - rank(b.group) || b.upcoming - a.upcoming || b.future - a.future).slice(0, max).map((r) => r.id);
    return { ids, all };
  }

  /** Everything for one scan: Pinnacle events for up to `requests` x 5 leagues. */
  async fetchEvents(s, groups) {
    // Only the sports chosen for OddsPapi (default basketball, soccer), in that priority order
    if (s.oddsPapiSports?.length) groups = s.oddsPapiSports.filter((g) => groups.includes(g));
    const groupBySportId = await this.sportGroups(groups);
    if (!Object.keys(groupBySportId).length) return [];
    const markets = await this.markets();
    const { ids, all } = await this.chooseTournaments(groupBySportId,
      { explicit: s.oddsPapiTournaments, max: 5 * s.oddsPapiRequestsPerScan, priority: s.oddsPapiSports ?? [] });
    this.lastLeagues = ids.map((id) => ({ id, name: all[id].tournamentName, country: all[id].categoryName, group: all[id].group }));
    const participants = {};
    for (const sportId of new Set(ids.map((id) => all[id].sportId))) Object.assign(participants, await this.participants(sportId));
    const events = [];
    for (let i = 0; i < ids.length; i += 5) {
      const fixtures = await this.oddsByTournaments(ids.slice(i, i + 5));
      events.push(...toEvents(fixtures, { markets, participants, tournaments: all, groupBySportId }));
    }
    this.log.info?.(`oddspapi: ${events.length} Pinnacle events from ${ids.length} leagues `
      + `(${ids.map((id) => all[id].tournamentName).join(', ')}) | requests this run: ${this.requestsUsed}`);
    return events;
  }
}

/**
 * Merge OddsPapi events into The Odds API's. The same game (same sport, start within 90 min,
 * both team names matching) becomes ONE event, so it can never be bet twice: OddsPapi's Pinnacle
 * markets are added to it, renamed to The Odds API's team names. Other games are added as new.
 */
export function mergeEvents(primary, extra, { similarity, groupOf }) {
  const merged = primary.map((e) => ({ ...e, bookmakers: (e.bookmakers ?? []).map((b) => ({ ...b, markets: [...(b.markets ?? [])] })) }));
  let joined = 0, added = 0;
  for (const x of extra) {
    const t = +new Date(x.commence_time);
    const hit = merged.find((e) => groupOf(e.sport_key ?? '') === groupOf(x.sport_key ?? '')
      && Math.abs(+new Date(e.commence_time) - t) <= 90 * 60_000
      && similarity(e.home_team, x.home_team) >= 0.75 && similarity(e.away_team, x.away_team) >= 0.75);
    if (!hit) { merged.push(x); added++; continue; }
    const rename = (n) => (n === x.home_team ? hit.home_team : n === x.away_team ? hit.away_team : n);
    const mkts = x.bookmakers[0].markets.map((m) => ({ ...m, outcomes: m.outcomes.map((o) => ({
      ...o, name: m.key === 'h2h' ? rename(o.name) : o.name, ...(o.description ? { description: rename(o.description) } : {}) })) }));
    let pin = hit.bookmakers.find((b) => b.key === 'pinnacle');
    if (!pin) { pin = { key: 'pinnacle', title: 'Pinnacle', last_update: x.bookmakers[0].last_update, markets: [] }; hit.bookmakers.push(pin); }
    pin.markets.push(...mkts);
    hit.sources = [...(hit.sources ?? ['theoddsapi']), 'oddspapi'];
    joined++;
  }
  return { events: merged, joined, added };
}

/**
 * Safe one-line summary of /v4/account: usage numbers and plan names only. The raw response
 * contains the API key and email address, so it must never be printed or logged.
 */
export function summarizeAccount(acc) {
  const found = {};
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (/key|email|token|secret|password/i.test(k)) continue;
      if (['request_limit', 'request_count'].includes(k) && typeof x === 'number') found[k] = Math.max(found[k] ?? 0, x);
      else if (/^(plan|plan_name|tier|product_name)$/i.test(k) && typeof x === 'string') found.plan = x;
      else if (/^(valid_until|current_period_end|expires_at)$/i.test(k) && typeof x === 'string') found.until = x.slice(0, 10);
      else walk(x);
    }
  };
  walk(acc);
  const used = found.request_count ?? '?', limit = found.request_limit ?? '?';
  return `requests used ${used} of ${limit}${found.plan ? ` | plan ${found.plan}` : ''}${found.until ? ` | until ${found.until}` : ''}`;
}
