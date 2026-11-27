// SportPesa (www.ke.sportpesa.com): odds and bets, built from recordings of its own site (2026-11-27).
//
// SportPesa only answers from Kenya and through a browser, so everything goes through a Chrome page
// on its site, logged in with the session from `record sportpesa` (.sportpesa-session):
//   games   GET  /api/highlights/{sport}                 1 = football, 2 = basketball
//   odds    GET  /api/games/markets?games={id}&markets=all
//   bet     POST /api/bets/place {amount, bets: [{id: selectionId, odds, coeff}], acceptOdds: false}
//           -> {return_code: 0, msgtext, bet_id, short_bet_id, balance, possible_win, amountValue, ...}
// Its taxes (global-config, bets/restrictions): no tax on winnings, no excise; 5% on withdrawals only.
import puppeteer from 'puppeteer';
import { findRow } from '../teamMatch.js';

export const SPORTPESA_HOME = 'https://www.ke.sportpesa.com/';
const SPORT_IDS = { soccer: 1, basketball: 2 };

/**
 * One game's SportPesa markets -> markets in the bot's (Odds API) format, each outcome carrying
 * `ref` { game, sel, odds } for the bet. `home`/`away` are our names for SportPesa's first/second team.
 * Only markets that settle like Pinnacle's: soccer 90 minutes, basketball including overtime.
 */
export function toMarkets(list, sport, home, away) {
  const out = new Map();
  const add = (key, o) => { if (!out.has(key)) out.set(key, []); out.get(key).push(o); };
  const price = (x) => { const v = Number(x.odds); return v > 1 ? v : null; };
  const ou = (x) => (/^(ov|over|o)\b/i.test(x.shortName ?? '') || /\bover\b/i.test(x.name ?? '') ? 'Over'
    : /^(un|under|u)\b/i.test(x.shortName ?? '') || /\bunder\b/i.test(x.name ?? '') ? 'Under' : null);
  const side = (x) => String(x.shortName ?? '').trim().toUpperCase();
  for (const m of list ?? []) {
    for (const x of m.selections ?? []) {
      const p = price(x);
      if (!p) continue;
      const ref = (game) => ({ game, sel: x.id, odds: x.odds });
      const r = ref(m.gameId);
      const s = side(x);
      if (sport === 'soccer') {
        if (m.id === 10 && ['1', 'X', '2'].includes(s)) add('h2h', { name: s === '1' ? home : s === '2' ? away : 'Draw', price: p, ref: r });
        else if (m.id === 46) {
          const code = { '1X': 'HD', X2: 'DA', 12: 'HA' }[s.replace(/[^1X2]/g, '')];
          if (code) add('double_chance', { name: { HD: `${home} or Draw`, DA: `Draw or ${away}`, HA: `${home} or ${away}` }[code], code, price: p, ref: r });
        } else if (m.id === 47 && ['1', '2'].includes(s)) add('draw_no_bet', { name: s === '1' ? home : away, code: s === '1' ? 'H' : 'A', price: p, ref: r });
        else if (m.id === 52 && ou(x) && Math.abs(m.specValue % 1) === 0.5) add('totals', { name: ou(x), point: Number(m.specValue), price: p, ref: r });
        else if (m.id === 43) {
          const yes = /^(yes|gg|y)$/i.test(x.name ?? '') || /^(yes|gg|y)$/i.test(s);
          const no = /^(no|ng|n)$/i.test(x.name ?? '') || /^(no|ng|n)$/i.test(s);
          if (yes || no) {
            const label = yes ? 'YES' : 'NO';
            add('soccer_props', { name: label, description: 'Both Teams To Score', betikaMarket: 'Both Teams To Score', betikaLabel: label,
              kind: 'btts', rule: { btts: yes }, price: p, ref: r });
          }
        }
      } else if (sport === 'basketball') {
        if (m.id === 382 && ['1', '2'].includes(s)) add('h2h', { name: s === '1' ? home : away, price: p, ref: r });
        // handicap incl. OT: specValue is the first team's handicap ("Pacific Tigers [-8.50]" with specValue -8.5)
        else if (m.id === 51 && ['1', '2'].includes(s) && Math.abs(m.specValue % 1) === 0.5) {
          add('spreads', { name: s === '1' ? home : away, point: s === '1' ? Number(m.specValue) : -Number(m.specValue), price: p, ref: r });
        } else if (m.id === 52 && ou(x)) add('totals', { name: ou(x), point: Number(m.specValue), price: p, ref: r });
        else if ((m.id === 353 || m.id === 352) && ou(x)) {
          add('team_totals', { name: ou(x), point: Number(m.specValue), description: m.id === 353 ? home : away, price: p, ref: r });
        }
      }
    }
  }
  return [...out].map(([key, outcomes]) => ({ key, outcomes }));
}

/** SportPesa through a Chrome page on its own site (requests go the way its pages send them). */
export class SportPesaSite {
  constructor({ sessionDir = '.sportpesa-session', chromePath = '', headless = true, log = console, timeoutMs = 60000 } = {}) {
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
    await this.page.goto(SPORTPESA_HOME, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs }).catch((e) => this.log.warn?.(`sportpesa: ${e.message}`));
    return this.page;
  }

  /** Same-origin request from the SportPesa page: { status, json }. */
  async api(path, { method = 'GET', body = null } = {}) {
    const page = await this.start();
    return page.evaluate(async (path, method, body) => {
      try {
        const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text: json ? null : text.slice(0, 200) };
      } catch (e) { return { status: 0, json: null, text: String(e.message ?? e) }; }
    }, path, method, body);
  }

  async games(sport) {
    const r = await this.api(`/api/highlights/${SPORT_IDS[sport]}`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`games list HTTP ${r.status}${r.text ? `: ${r.text}` : ''}`);
    return r.json.map((g) => ({ sport, gameId: g.id, home: g.competitors?.[0]?.name, away: g.competitors?.[1]?.name, start: new Date(g.date),
      competition: g.competition?.name ?? '' })).filter((g) => g.home && g.away);
  }

  async markets(gameId) {
    const r = await this.api(`/api/games/markets?games=${encodeURIComponent(gameId)}&markets=all`);
    if (r.status !== 200 || !r.json) throw new Error(`markets HTTP ${r.status}`);
    return (r.json[String(gameId)] ?? []).map((m) => ({ ...m, gameId }));
  }

  async close() {
    if (this.browser?.connected) await this.browser.close().catch(() => {});
    this.browser = this.page = null;
  }
}

/**
 * Add a "sportpesa" bookmaker to the events SportPesa also has (pre-match, football and basketball).
 * Games are matched by team names and kick-off; their markets are read for matched games only.
 */
export async function attachSportPesa(events, site, now = new Date(), log = console, { cacheMs = 60_000 } = {}) {
  const groups = [...new Set(events.map((e) => (String(e.sport_key).startsWith('soccer_') ? 'soccer' : String(e.sport_key).startsWith('basketball_') ? 'basketball' : null)).filter(Boolean))];
  const rows = [];
  for (const g of groups) {
    try { rows.push(...await site.games(g)); } catch (e) { log.warn?.(`sportpesa ${g}: ${e.message}`); }
  }
  site.cache ??= new Map();
  let matched = 0;
  for (const ev of events) {
    if (new Date(ev.commence_time) <= now) continue;
    const sport = String(ev.sport_key).startsWith('soccer_') ? 'soccer' : String(ev.sport_key).startsWith('basketball_') ? 'basketball' : null;
    const cands = rows.filter((r) => r.sport === sport && Math.abs(r.start - new Date(ev.commence_time)) <= 90 * 60_000);
    const hit = findRow(ev, cands);
    if (!hit) continue;
    const cached = site.cache.get(hit.row.gameId);
    let list;
    if (cached && +now - cached.at < cacheMs) list = cached.list;
    else {
      try { list = await site.markets(hit.row.gameId); site.cache.set(hit.row.gameId, { at: +now, list }); } catch (e) { log.warn?.(`sportpesa: ${e.message}`); continue; }
    }
    const [home, away] = hit.swapped ? [ev.away_team, ev.home_team] : [ev.home_team, ev.away_team];
    const markets = toMarkets(list, sport, home, away).map((m) => ({ ...m, last_update: now.toISOString() }));
    if (!markets.length) continue;
    // matched on one team + kick-off only: the winner prices must look like the same game
    if (hit.loose && !looksSame(ev, markets)) continue;
    ev.bookmakers = (ev.bookmakers ?? []).filter((b) => b.key !== 'sportpesa');
    ev.bookmakers.push({ key: 'sportpesa', title: 'SportPesa', last_update: now.toISOString(), markets });
    ev.sportpesaRef = { gameId: hit.row.gameId, home: hit.row.home, away: hit.row.away, swapped: hit.swapped };
    matched++;
  }
  log.info?.(`sportpesa: ${rows.length} games, ${matched} matched to ${events.length} sharp events`);
  return { games: rows.length, matched };
}

function looksSame(ev, markets) {
  const sp = markets.find((m) => m.key === 'h2h');
  const sharp = (ev.bookmakers ?? []).find((b) => b.key !== 'betika' && b.key !== 'sportpesa' && b.markets?.some((x) => x.key === 'h2h'))?.markets.find((x) => x.key === 'h2h');
  if (!sp || !sharp) return false;
  return sharp.outcomes.every((o) => { const s = sp.outcomes.find((x) => x.name === o.name); return s && Math.abs(1 / s.price - 1 / o.price) < 0.15; });
}

/**
 * Bet placer, same interface as Betika's: placeBet({ gameId, selectionId, minOdds, stake, live }).
 * Reads the selection's current price first; a dry run stops there. Real bets: POST /api/bets/place.
 */
export class SportPesaClient {
  constructor(site, { log = console } = {}) { Object.assign(this, { site, log }); }

  async placeBet({ gameId, selectionId, minOdds, stake, live = false }) {
    let list;
    try { list = await this.site.markets(gameId); } catch (e) { return { status: 'error', message: e.message }; }
    const sel = list.flatMap((m) => m.selections ?? []).find((x) => String(x.id) === String(selectionId));
    if (!sel) return { status: 'outcome_not_found' };
    const odds = Number(sel.odds);
    if (!(odds >= minOdds)) return { status: 'price_moved', odds, minOdds };
    if (!live) return { status: 'dry_run', odds };
    const r = await this.site.api('/api/bets/place', { method: 'POST',
      body: { amount: stake, bets: [{ id: Number(selectionId), odds: sel.odds, coeff: sel.odds }], acceptOdds: false, betSpinner: false } });
    return classifySportPesa(r, stake, odds);
  }

  async close() { await this.site.close(); }
}

/** What SportPesa's reply to a bet means. Anything unclear is 'unknown' (the bot then stops betting there). */
export function classifySportPesa(r, stake, odds) {
  const j = r?.json;
  if (!r || r.status === 0) return { status: 'error', message: r?.text ?? 'no reply' };
  if (r.status === 401 || r.status === 403) return { status: 'not_logged_in', message: `HTTP ${r.status}` };
  if (j && Number(j.return_code) === 0 && (j.bet_id || j.short_bet_id)) {
    const confirmed = Number(j.amountValue ?? j.stakeValue ?? stake);
    return { status: 'placed', odds, betId: String(j.short_bet_id ?? j.shortBetId ?? ''), betIdLong: j.bet_id ?? null,
      possibleWin: j.possible_win ?? null, balanceAfter: j.balance ?? null, confirmedStake: confirmed,
      ...(Math.abs(confirmed - stake) > 0.01 ? { stakeMismatch: true } : {}), message: j.msgtext ?? '' };
  }
  if (j && j.return_code != null && Number(j.return_code) !== 0) return { status: 'rejected', odds, message: j.msgtext ?? j.message ?? `code ${j.return_code}` };
  return { status: 'unknown', odds, message: `HTTP ${r.status} ${j ? JSON.stringify(j).slice(0, 150) : r.text ?? ''}` };
}

/** What the executor hands to placeBet for a SportPesa pick (null = no selection id = can't bet it). */
export const sportpesaPickFor = (opp) => (opp.ref?.sel ? { gameId: opp.ref.game, selectionId: opp.ref.sel, market: opp.market, label: opp.outcome } : null);
