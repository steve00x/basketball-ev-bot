// Betika's public odds API (what www.betika.com itself calls). No login needed.
// Verified against the live site on 2026-11-23.
import { SPORTS } from '../sports.js';
import { competitionFilter } from '../sports.js';

export const BETIKA_API = 'https://api.betika.com/v1/uo';
export const BETIKA_LIVE_API = 'https://live.betika.com/v1/uo';
export const BASKETBALL_SPORT_ID = SPORTS.basketball.betikaSportId;
// period_id 9 = every upcoming match. Without it Betika returns only today's games
// (Kenya time), so late-night tip-offs were missing.
export const ALL_UPCOMING_PERIOD = 9;

/** Basketball market ids, kept for older callers. See sports.js for every sport. */
export const MARKETS = { winner: SPORTS.basketball.h2h.subType, total: SPORTS.basketball.totals.subType };

/** Kept for older callers: Betika competition filters for basketball keys. */
export const COMPETITIONS = Object.fromEntries(
  ['basketball_nba', 'basketball_wnba', 'basketball_ncaab', 'basketball_euroleague'].map((k) => [k, competitionFilter(k)]));

/** Betika's start_time is Kenya time (EAT, UTC+3) with no zone marker. */
export const parseEat = (s) => new Date(`${s.replace(' ', 'T')}+03:00`);

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 1 ? n : null; };

/** One Over/Under ladder (market `st`) of a listing row: [{ point, over, under }], sorted. */
function ladderOf(m, st) {
  const mk = (m.odds ?? []).find((o) => Number(o.sub_type_id) === st);
  if (!mk) return [];
  const lines = new Map();
  for (const o of mk.odds ?? []) {
    const side = /over|under/i.exec(`${o.odd_key ?? ''} ${o.display ?? ''}`)?.[0]?.toLowerCase();
    const pt = /total=([\d.]+)/.exec(o.special_bet_value ?? '')?.[1];
    const price = num(o.odd_value);
    if (!side || pt === undefined || !price) continue;
    if (!lines.has(Number(pt))) lines.set(Number(pt), { point: Number(pt) });
    lines.get(Number(pt))[side] = price;
  }
  return [...lines.values()].filter((l) => l.over && l.under).sort((a, b) => a.point - b.point);
}

/**
 * Merge a sport's winner (h2h) and totals listings into one record per match:
 * { sport, parentMatchId, matchId, home, away, start, competition, category,
 *   winner: [home, away] | null, draw: price | null, totals: [{ point, over, under }] }
 * For 1X2 markets `draw` holds the X price; for 2-way markets it is null.
 */
export function parseListings(winnerJson, totalJson, spec = SPORTS.basketball, sport = 'basketball') {
  const byId = new Map();
  const base = (m) => {
    if (!byId.has(m.parent_match_id)) {
      byId.set(m.parent_match_id, {
        sport, parentMatchId: String(m.parent_match_id), matchId: String(m.match_id),
        home: m.home_team, away: m.away_team, start: parseEat(m.start_time),
        competition: m.competition_name, category: m.category, winner: null, draw: null, totals: [],
        doubleChance: null, drawNoBet: null, teamTotals: null,
      });
    }
    return byId.get(m.parent_match_id);
  };
  for (const m of winnerJson?.data ?? []) {
    const mk = (m.odds ?? []).find((o) => Number(o.sub_type_id) === spec.h2h.subType);
    if (!mk) continue;
    const by = (d) => num(mk.odds.find((o) => String(o.display).trim().toUpperCase() === d)?.odd_value);
    const home = by('1'), away = by('2'), draw = by('X');
    if (!home || !away) continue;
    if (spec.h2h.draw && !draw) continue; // a 1X2 without its draw price is incomplete
    const rec = base(m);
    rec.winner = [home, away];
    rec.draw = spec.h2h.draw ? draw : null;
    // Double Chance / Draw No Bet arrive in the same listing call (sub_type_id=1,10,11)
    const extra = (st) => (m.odds ?? []).find((o) => Number(o.sub_type_id) === st);
    const dc = spec.doubleChance && extra(spec.doubleChance.subType);
    if (dc) {
      const p = (d) => num(dc.odds.find((o) => String(o.display).trim().toUpperCase() === d)?.odd_value);
      const v = { '1X': p('1/X'), 'X2': p('X/2'), '12': p('1/2') };
      if (v['1X'] && v.X2 && v['12']) rec.doubleChance = v;
    }
    const dnb = spec.drawNoBet && extra(spec.drawNoBet.subType);
    if (dnb) {
      const p = (d) => num(dnb.odds.find((o) => String(o.display).trim() === d)?.odd_value);
      if (p('1') && p('2')) rec.drawNoBet = [p('1'), p('2')];
    }
  }
  if (spec.totals) {
    for (const m of totalJson?.data ?? []) {
      const mk = (m.odds ?? []).find((o) => Number(o.sub_type_id) === spec.totals.subType);
      if (!mk) continue;
      const lines = new Map();
      for (const o of mk.odds) {
        const side = /over|under/i.exec(`${o.odd_key ?? ''} ${o.display ?? ''}`)?.[0]?.toLowerCase();
        const pt = /total=([\d.]+)/.exec(o.special_bet_value ?? '')?.[1] ?? /([\d.]+)\s*$/.exec(o.odd_key ?? '')?.[1];
        const price = num(o.odd_value);
        if (!side || pt === undefined || !price) continue;
        const point = Number(pt);
        if (!lines.has(point)) lines.set(point, { point });
        lines.get(point)[side] = price;
      }
      base(m).totals = [...lines.values()].filter((l) => l.over && l.under).sort((a, b) => a.point - b.point);
    }
    // Team totals arrive in the same listing call (sub_type_id=225,227,228)
    if (spec.teamTotals) {
      for (const m of totalJson?.data ?? []) {
        const ladder = (st) => {
          const mk = (m.odds ?? []).find((o) => Number(o.sub_type_id) === st);
          if (!mk) return [];
          const lines = new Map();
          for (const o of mk.odds) {
            const side = /over|under/i.exec(`${o.odd_key ?? ''} ${o.display ?? ''}`)?.[0]?.toLowerCase();
            const pt = /total=([\d.]+)/.exec(o.special_bet_value ?? '')?.[1];
            const price = num(o.odd_value);
            if (!side || pt === undefined || !price) continue;
            if (!lines.has(Number(pt))) lines.set(Number(pt), { point: Number(pt) });
            lines.get(Number(pt))[side] = price;
          }
          return [...lines.values()].filter((l) => l.over && l.under).sort((a, b) => a.point - b.point);
        };
        const h = ladder(spec.teamTotals.homeSubType), a = ladder(spec.teamTotals.awaySubType);
        if (h.length || a.length) base(m).teamTotals = { home: h, away: a };
      }
    }
    // 1st half / 1st quarter totals and team totals (same listing call)
    if (spec.periods) {
      for (const m of totalJson?.data ?? []) {
        for (const p of spec.periods) {
          const totals = ladderOf(m, p.totals), home = ladderOf(m, p.teamHome), away = ladderOf(m, p.teamAway);
          if (!totals.length && !home.length && !away.length) continue;
          const rec = base(m);
          (rec.periods ??= {})[p.key] = { totals, teamTotals: { home, away } };
        }
      }
    }
  }
  return [...byId.values()];
}

export class BetikaAPI {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    Object.assign(this, { fetchImpl, timeoutMs });
  }

  async listing(subTypeId, { sportId = BASKETBALL_SPORT_ID, maxPages = 15, limit = 100 } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(`${BETIKA_API}/matches`);
      Object.entries({ sport_id: sportId, sub_type_id: subTypeId, page, limit, sort_id: 1, period_id: ALL_UPCOMING_PERIOD, esports: false })
        .forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`Betika API ${url.pathname}: HTTP ${res.status}`);
      const json = await res.json();
      const rows = json.data ?? [];
      all.push(...rows);
      if (!rows.length || all.length >= Number(json.meta?.total ?? 0)) break;
    }
    return { data: all };
  }

  /** All upcoming matches of one sport group ("soccer", "tennis", ...) with its comparable markets. */
  async matches(sport) {
    const spec = SPORTS[sport];
    if (!spec) throw new Error(`unknown sport "${sport}"`);
    const opts = { sportId: spec.betikaSportId };
    const [winner, total] = await Promise.all([
      this.listing([spec.h2h.subType, spec.doubleChance?.subType, spec.drawNoBet?.subType].filter(Boolean).join(','), opts),
      spec.totals ? this.listing([spec.totals.subType, spec.teamTotals?.homeSubType, spec.teamTotals?.awaySubType,
        ...(spec.periods ?? []).flatMap((p) => [p.totals, p.teamHome, p.teamAway])].filter(Boolean).join(','), opts) : Promise.resolve(null),
    ]);
    return parseListings(winner, total, spec, sport);
  }

  /** Several sport groups at once; one failing sport doesn't stop the others. */
  async allMatches(sports, log = console) {
    const out = [];
    for (const sport of sports) {
      try {
        out.push(...(await this.matches(sport)));
      } catch (e) {
        log.warn?.(`betika: ${sport} odds unavailable: ${e.message}`);
      }
    }
    return out;
  }

  async basketball() { return this.matches('basketball'); }

  /**
   * In-play matches of one sport (Betika's live feed: same market ids as pre-game, filter `sport=`).
   * Only prices Betika takes right now are kept: bet_status STARTED, market_active 1, odd_active 1.
   */
  async liveMatches(sport) {
    const spec = SPORTS[sport];
    if (!spec) throw new Error(`unknown sport "${sport}"`);
    const subTypes = [spec.h2h.subType, spec.totals?.subType, spec.doubleChance?.subType, spec.drawNoBet?.subType].filter(Boolean);
    const url = new URL(`${BETIKA_LIVE_API}/matches`);
    Object.entries({ page: 1, limit: 1000, sub_type_id: subTypes.join(','), sport: spec.betikaSportId, sort: 1 })
      .forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Betika live API: HTTP ${res.status}`);
    const rows = (await res.json()).data ?? [];
    const open = rows.filter((m) => m.bet_status === 'STARTED' && Number(m.active) === 1 && Number(m.sport_id) === spec.betikaSportId)
      .map((m) => ({ ...m, odds: (m.odds ?? []).filter((o) => Number(o.market_active) === 1)
        .map((o) => ({ ...o, odds: (o.odds ?? []).filter((x) => Number(x.odd_active) === 1 && Number(x.odd_value) > 1) })) }));
    const byParent = new Map(open.map((m) => [String(m.parent_match_id), m]));
    return parseListings({ data: open }, { data: open }, spec, sport).map((rec) => {
      const m = byParent.get(rec.parentMatchId);
      return { ...rec, live: true, liveMatchId: String(m.match_id), clock: m.match_time, period: m.event_status, score: m.current_score,
        redCards: (Number(m.home_red_card) || 0) + (Number(m.away_red_card) || 0) };
    });
  }

  async allLiveMatches(sports, log = console) {
    const out = [];
    for (const sport of sports) {
      try { out.push(...(await this.liveMatches(sport))); } catch (e) { log.warn?.(`betika: ${sport} live odds unavailable: ${e.message}`); }
    }
    return out;
  }
}
