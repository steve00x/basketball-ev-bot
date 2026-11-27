// OdiBets (odibets.com): odds read from its own site, built from a recording of it (2026-11-27).
// Its automated-browser test passed (2026-11-27): odds requests answer normally, nothing to disguise.
//   games   GET apis.odibets.com/odi/sportsbook?resource=sportevents&sport_id={soccer|basketball}&day={YYYY-MM-DD}
//   odds    GET apis.odibets.com/sportsbook/v1?resource=sportevent&id={parent_match_id}&sport_id={slug}
//   bet     POST betting-api.apps.odibets.com/betting-api/api/v1/betting/sports/bets  (needs the login header:
//           not recorded yet, so real OdiBets bets stay off - dry runs only)
// Market numbers are the same as Betika's (Sportradar): 1 = 1X2, 10 double chance, 11 draw no bet,
// 18 total, 29 BTTS; basketball 219 winner, 223 handicap, 225 total, 227/228 team totals (incl. overtime).
import puppeteer from 'puppeteer';
import { parseEat } from '../betika/api.js';
import { findRow } from '../teamMatch.js';

export const ODIBETS_HOME = 'https://odibets.com/';
const API = 'https://apis.odibets.com';
const LIST_CACHE_MS = 15 * 60_000;
// market types the bot compares (asked for separately when OdiBets doesn't send them up front)
const WANTED = { soccer: ['1', '10', '11', '18', '29'], basketball: ['219', '223', '225', '227', '228'] };

const spec = (s, k) => { const m = new RegExp(`${k}=([-+]?[\\d.]+)`).exec(s ?? ''); return m ? Number(m[1]) : null; };
const ou = (o) => { const t = `${o.outcome_key ?? ''} ${o.outcome_name ?? ''}`.toLowerCase(); return /\bover\b/.test(t) ? 'Over' : /\bunder\b/.test(t) ? 'Under' : null; };
const key = (o) => String(o.outcome_key ?? '').trim().toUpperCase();

/** One OdiBets game's markets -> the bot's market format, each outcome with `ref` for the bet slip. */
export function toMarkets(game, sport, home, away) {
  const out = new Map();
  const add = (k, o) => { if (!out.has(k)) out.set(k, []); out.get(k).push(o); };
  const sportNum = game.info?.sport_id ?? null;
  for (const m of game.markets ?? []) {
    if (String(m.status ?? '1') !== '1') continue;
    const st = Number(m.sub_type_id);
    for (const o of m.outcomes ?? []) {
      const price = Number(o.odd_value);
      if (!(price > 1) || String(o.active ?? '1') !== '1' || String(o.status ?? '1') !== '1') continue;
      const ref = { game: game.info?.parent_match_id ?? game.id, sub: String(m.sub_type_id), spec: m.specifiers ?? o.specifiers ?? '',
        oid: String(o.outcome_id), oname: o.outcome_name, odds: price, sportNum };
      const k = key(o);
      if (sport === 'soccer') {
        if (st === 1 && ['1', 'X', '2'].includes(k)) add('h2h', { name: k === '1' ? home : k === '2' ? away : 'Draw', price, ref });
        else if (st === 10) {
          const code = { '1X': 'HD', X2: 'DA', 12: 'HA' }[k.replace(/[^1X2]/g, '')];
          if (code) add('double_chance', { name: { HD: `${home} or Draw`, DA: `Draw or ${away}`, HA: `${home} or ${away}` }[code], code, price, ref });
        } else if (st === 11 && ['1', '2'].includes(k)) add('draw_no_bet', { name: k === '1' ? home : away, code: k === '1' ? 'H' : 'A', price, ref });
        else if (st === 18 && ou(o)) {
          const line = spec(ref.spec, 'total');
          if (line != null && Math.abs(line % 1) === 0.5) add('totals', { name: ou(o), point: line, price, ref });
        } else if (st === 29 && /^(YES|NO)$/.test(k || String(o.outcome_name).toUpperCase())) {
          const label = (k || String(o.outcome_name)).toUpperCase();
          add('soccer_props', { name: label, description: 'Both Teams To Score', betikaMarket: 'Both Teams To Score', betikaLabel: label,
            kind: 'btts', rule: { btts: label === 'YES' }, price, ref });
        }
      } else if (sport === 'basketball') {
        if (st === 219 && ['1', '2'].includes(k)) add('h2h', { name: k === '1' ? home : away, price, ref });
        // handicap buttons are "1 (-10.5)" / "2 (+10.5)": the side, then the line
        else if (st === 223 && ['1', '2'].includes(k.split(/\s+/)[0])) {
          const h = spec(ref.spec, 'hcp'); // the first team's handicap
          const first = k.split(/\s+/)[0] === '1';
          if (h != null && Math.abs(h % 1) === 0.5) add('spreads', { name: first ? home : away, point: first ? h : -h, price, ref });
        } else if (st === 225 && ou(o)) {
          const line = spec(ref.spec, 'total');
          if (line != null) add('totals', { name: ou(o), point: line, price, ref });
        } else if ((st === 227 || st === 228) && ou(o)) {
          const line = spec(ref.spec, 'total');
          if (line != null) add('team_totals', { name: ou(o), point: line, description: st === 227 ? home : away, price, ref });
        }
      }
    }
  }
  return [...out].map(([k, outcomes]) => ({ key: k, outcomes }));
}

/** OdiBets through a Chrome page on its own site. */
export class OdiBetsSite {
  constructor({ sessionDir = '.odibets-session', chromePath = '', headless = true, log = console, timeoutMs = 60000 } = {}) {
    Object.assign(this, { sessionDir, chromePath, headless, log, timeoutMs });
    this.browser = null; this.page = null;
  }

  async start() {
    if (this.page && this.browser?.connected) return this.page;
    this.browser = await puppeteer.launch({ headless: this.headless, userDataDir: this.sessionDir, executablePath: this.chromePath || undefined,
      defaultViewport: { width: 1366, height: 1000 }, args: ['--no-sandbox'] });
    const [page] = await this.browser.pages();
    this.page = page ?? (await this.browser.newPage());
    this.page.on('dialog', (d) => d.accept().catch(() => {}));
    await this.page.goto(ODIBETS_HOME, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs }).catch((e) => this.log.warn?.(`odibets: ${e.message}`));
    return this.page;
  }

  async get(url) {
    const page = await this.start();
    return page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        const text = await res.text();
        try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text: text.slice(0, 200) }; }
      } catch (e) { return { status: 0, json: null, text: String(e.message ?? e) }; }
    }, url);
  }

  /**
   * Upcoming games of a sport for the next `days` days. OdiBets lists a day's leagues but fills in the
   * games of only the top few, so the others are asked for one league at a time. The list changes
   * slowly: kept for LIST_CACHE_MS (prices are always fetched fresh).
   */
  async games(sport, { days = 2, now = new Date() } = {}) {
    const sid = { soccer: 1, basketball: 2 }[sport];
    this.listCache ??= new Map();
    const cached = this.listCache.get(sport);
    if (cached && +now - cached.at < LIST_CACHE_MS) return cached.rows;
    const base = { resource: 'sportevents', producer: '0', platform: 'desktop', mode: '1', sport_id: String(sid) };
    const out = [];
    const take = (lg, m) => out.push({ sport, gameId: String(m.parent_match_id), home: m.home_team, away: m.away_team,
      start: parseEat(String(m.start_time)), competition: m.competition_name ?? lg.competition_name ?? '' });
    for (let i = 0; i < days; i++) {
      const day = new Date(+now + 3 * 3600_000 + i * 86400_000).toISOString().slice(0, 10); // Kenya date
      const r = await this.get(`${API}/odi/sportsbook?${new URLSearchParams({ ...base, day })}`);
      if (r.status !== 200 || !r.json?.data) throw new Error(`games list HTTP ${r.status}${r.text ? `: ${r.text}` : ''}`);
      for (const lg of r.json.data.leagues ?? []) {
        let ms = lg.matches ?? [];
        if (ms.length < Number(lg.match_count ?? 0)) {
          const rl = await this.get(`${API}/odi/sportsbook?${new URLSearchParams({ ...base, day, competition_id: String(lg.competition_id) })}`);
          ms = (rl.json?.data?.leagues ?? []).flatMap((l) => l.matches ?? []);
        }
        for (const m of ms) take(lg, m);
      }
    }
    const rows = [...new Map(out.filter((g) => g.home && g.away && !Number.isNaN(+g.start)).map((g) => [g.gameId, g])).values()];
    this.listCache.set(sport, { at: +now, rows });
    return rows;
  }

  /**
   * A game's markets. OdiBets sends prices for its first ~10 market types only; the others come one
   * type per request (sub_type_id=225 gives all 16 total lines). Only the types the bot compares, and
   * only those OdiBets lists for this game. `only`: just that type (the price check before a bet).
   */
  async game(gameId, sport, { only = null } = {}) {
    const q = (extra = {}) => `${API}/sportsbook/v1?${new URLSearchParams({ resource: 'sportevent', id: gameId, sport_id: sport, sportsbook: 'sportsbook', builder: '0', ...extra })}`;
    const one = async (extra) => {
      const r = await this.get(q(extra));
      if (r.status !== 200 || !r.json?.data) throw new Error(`game ${gameId} HTTP ${r.status}`);
      return r.json.data;
    };
    if (only) return one({ sub_type_id: String(only) });
    const data = await one();
    const have = new Set((data.markets ?? []).map((m) => String(m.sub_type_id)));
    const listed = new Set((data.markets_list ?? []).map((m) => String(m.sub_type_id)));
    for (const st of WANTED[sport] ?? []) {
      if (have.has(st) || !listed.has(st)) continue;
      try { data.markets.push(...((await one({ sub_type_id: st })).markets ?? [])); } catch (e) { this.log.warn?.(`odibets: ${e.message}`); }
    }
    return data;
  }

  async close() {
    if (this.browser?.connected) await this.browser.close().catch(() => {});
    this.browser = this.page = null;
  }
}

/** Add an "odibets" bookmaker to the events OdiBets also has (pre-match football and basketball). */
export async function attachOdiBets(events, site, now = new Date(), log = console, { cacheMs = 180_000 } = {}) {
  const sportOf = (e) => (String(e.sport_key).startsWith('soccer_') ? 'soccer' : String(e.sport_key).startsWith('basketball_') ? 'basketball' : null);
  const groups = [...new Set(events.map(sportOf).filter(Boolean))];
  const rows = [];
  for (const g of groups) {
    try { rows.push(...await site.games(g, { now })); } catch (e) { log.warn?.(`odibets ${g}: ${e.message}`); }
  }
  site.cache ??= new Map();
  let matched = 0;
  for (const ev of events) {
    const sport = sportOf(ev);
    if (!sport || new Date(ev.commence_time) <= now) continue;
    const hit = findRow(ev, rows.filter((r) => r.sport === sport && Math.abs(r.start - new Date(ev.commence_time)) <= 90 * 60_000));
    if (!hit) continue;
    let game = site.cache.get(hit.row.gameId);
    if (!game || +now - game.at >= cacheMs) {
      try { game = { at: +now, data: await site.game(hit.row.gameId, sport) }; site.cache.set(hit.row.gameId, game); } catch (e) { log.warn?.(`odibets: ${e.message}`); continue; }
    }
    const [home, away] = hit.swapped ? [ev.away_team, ev.home_team] : [ev.home_team, ev.away_team];
    const markets = toMarkets(game.data, sport, home, away).map((m) => ({ ...m, last_update: now.toISOString() }));
    if (!markets.length) continue;
    if (hit.loose && !looksSame(ev, markets)) continue;
    ev.bookmakers = (ev.bookmakers ?? []).filter((b) => b.key !== 'odibets');
    ev.bookmakers.push({ key: 'odibets', title: 'OdiBets', last_update: now.toISOString(), markets });
    matched++;
  }
  log.info?.(`odibets: ${rows.length} games, ${matched} matched to ${events.length} sharp events`);
  return { games: rows.length, matched };
}

function looksSame(ev, markets) {
  const ob = markets.find((m) => m.key === 'h2h');
  const sharp = (ev.bookmakers ?? []).find((b) => !['betika', 'sportpesa', 'odibets'].includes(b.key) && b.markets?.some((x) => x.key === 'h2h'))?.markets.find((x) => x.key === 'h2h');
  if (!ob || !sharp) return false;
  return sharp.outcomes.every((o) => { const s = ob.outcomes.find((x) => x.name === o.name); return s && Math.abs(1 / s.price - 1 / o.price) < 0.15; });
}

/**
 * Bet placer (same interface as Betika's). Re-reads the selection's current price; a dry run stops
 * there. Real bets are not available yet (OdiBets' login header isn't recorded): always a dry run.
 */
export class OdiBetsClient {
  constructor(site, { log = console } = {}) { Object.assign(this, { site, log }); }

  async placeBet({ ref, sport, minOdds, live = false }) {
    let game;
    try { game = await this.site.game(ref.game, sport, { only: ref.sub }); } catch (e) { return { status: 'error', message: e.message }; }
    const m = (game.markets ?? []).find((x) => String(x.sub_type_id) === ref.sub && (x.specifiers ?? '') === (ref.spec ?? ''));
    const o = m?.outcomes?.find((x) => String(x.outcome_id) === ref.oid);
    if (!o || String(o.active ?? '1') !== '1') return { status: 'outcome_not_found' };
    const odds = Number(o.odd_value);
    if (!(odds >= minOdds)) return { status: 'price_moved', odds, minOdds };
    return { status: 'dry_run', odds, ...(live ? { message: 'real OdiBets bets are not switched on yet - dry run' } : {}) };
  }

  async close() { await this.site.close(); }
}

export const odibetsPickFor = (opp) => (opp.ref?.oid ? { ref: opp.ref, sport: String(opp.sport).startsWith('soccer_') ? 'soccer' : 'basketball', market: opp.market, label: opp.outcome } : null);
