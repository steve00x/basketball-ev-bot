// Betika's public odds API (what www.betika.com itself calls). No login needed.
// Verified against the live site on 2026-11-23.
export const BETIKA_API = 'https://api.betika.com/v1/uo';
export const BASKETBALL_SPORT_ID = 30;

/** Betika market ids (sub_type_id). Both include overtime, like Pinnacle's lines. */
export const MARKETS = {
  winner: 219, // "WINNER (INCL. OVERTIME)", two-way: compare to Pinnacle h2h
  total: 225,  // "TOTAL (INCL. OVERTIME)", several lines: compare to Pinnacle totals
};
// Not used: sub_type 1 "1X2" is regulation time with a draw, so it isn't a moneyline.

/** Which Betika competitions belong to each Odds API sport key. */
export const COMPETITIONS = {
  basketball_nba: (c) => c === 'NBA',
  basketball_wnba: (c) => c === 'WNBA',
  basketball_ncaab: (c) => /^NCAA(, |$)/.test(c) && !/women/i.test(c),
  basketball_euroleague: (c) => /euroleague/i.test(c),
};

/** Betika's start_time is Kenya time (EAT, UTC+3) with no zone marker. */
export const parseEat = (s) => new Date(`${s.replace(' ', 'T')}+03:00`);

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 1 ? n : null; };

/**
 * Merge the winner and total listings into one record per match:
 * { parentMatchId, matchId, home, away, start, competition, winner: [home, away] | null,
 *   totals: [{ point, over, under }] }
 */
export function parseListings(winnerJson, totalJson) {
  const byId = new Map();
  const base = (m) => {
    if (!byId.has(m.parent_match_id)) {
      byId.set(m.parent_match_id, {
        parentMatchId: String(m.parent_match_id), matchId: String(m.match_id),
        home: m.home_team, away: m.away_team, start: parseEat(m.start_time),
        competition: m.competition_name, category: m.category, winner: null, totals: [],
      });
    }
    return byId.get(m.parent_match_id);
  };
  for (const m of winnerJson?.data ?? []) {
    const mk = (m.odds ?? []).find((o) => Number(o.sub_type_id) === MARKETS.winner);
    if (!mk) continue;
    const home = num(mk.odds.find((o) => o.outcome_id === '4' || o.display === '1')?.odd_value);
    const away = num(mk.odds.find((o) => o.outcome_id === '5' || o.display === '2')?.odd_value);
    if (home && away) base(m).winner = [home, away];
  }
  for (const m of totalJson?.data ?? []) {
    const mk = (m.odds ?? []).find((o) => Number(o.sub_type_id) === MARKETS.total);
    if (!mk) continue;
    const lines = new Map();
    for (const o of mk.odds) {
      const [, side, pt] = /^(over|under)\s+([\d.]+)$/i.exec(o.odd_key ?? '') ?? [];
      const price = num(o.odd_value);
      if (!side || !price) continue;
      const point = Number(pt);
      if (!lines.has(point)) lines.set(point, { point });
      lines.get(point)[side.toLowerCase()] = price;
    }
    base(m).totals = [...lines.values()].filter((l) => l.over && l.under).sort((a, b) => a.point - b.point);
  }
  return [...byId.values()];
}

export class BetikaAPI {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    Object.assign(this, { fetchImpl, timeoutMs });
  }

  async listing(subTypeId, { maxPages = 10, limit = 100 } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(`${BETIKA_API}/matches`);
      Object.entries({ sport_id: BASKETBALL_SPORT_ID, sub_type_id: subTypeId, page, limit, tab: -2, sort_id: 1, period_id: -1, esports: false })
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

  /** All upcoming basketball matches with winner + total markets. */
  async basketball() {
    const [winner, total] = await Promise.all([this.listing(MARKETS.winner), this.listing(MARKETS.total)]);
    return parseListings(winner, total);
  }
}
