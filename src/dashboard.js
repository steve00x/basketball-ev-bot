// Local dashboard: http://localhost:3000 while the bot runs. Listens on 127.0.0.1 only.
import http from 'node:http';
import { dedupeKey, matchup, selection } from './scanner.js';
import { resultsSummary } from './settle.js';

/** Live status the scan loop updates; the dashboard reads it. */
export const botState = {
  startedAt: new Date().toISOString(),
  mode: {}, lastScan: null, nextScan: null, credits: null, oddsPapi: null, opportunities: [], closest: null, scans: 0,
};

const LIVE_STATUSES = new Set(['placed', 'unknown']);

/** Everything the page shows, computed from the bet log and the latest scan. */
export function dashboardData(store, s, state = botState, now = new Date()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const bets = store.data.bets ?? [];
  const today = bets.filter((b) => new Date(b.at) >= midnight);
  const placedToday = today.filter((b) => b.live && LIVE_STATUSES.has(b.status));
  const count = (st) => today.filter((b) => b.status === st).length;
  const lastBalance = [...bets].reverse().find((b) => b.balanceAfter != null)?.balanceAfter ?? null;
  const placedAll = bets.filter((b) => b.live && b.status === 'placed');
  return {
    now: now.toISOString(),
    mode: state.mode,
    startedAt: state.startedAt,
    scans: state.scans,
    lastScan: state.lastScan,
    nextScan: state.nextScan,
    credits: state.credits,
    oddsPapi: state.oddsPapi,
    today: {
      placed: placedToday.length,
      staked: placedToday.reduce((t, b) => t + (b.stake ?? 0), 0),
      stakeLimit: s.betikaDailyStakeLimit,
      betLimit: s.betikaMaxBetsPerDay,
      dryRuns: count('dry_run'),
      rejected: count('rejected'),
      priceMoved: count('price_moved'),
      unknown: count('unknown'),
      expectedProfit: placedToday.reduce((t, b) => t + (b.stake ?? 0) * (b.ev ?? 0), 0),
    },
    allTime: {
      placed: placedAll.length,
      staked: placedAll.reduce((t, b) => t + (b.stake ?? 0), 0),
      expectedProfit: placedAll.reduce((t, b) => t + (b.stake ?? 0) * (b.ev ?? 0), 0),
    },
    balance: lastBalance,
    results: resultsSummary(bets),
    opportunities: state.opportunities,
    closest: state.closest,
    bets: [...bets].reverse().slice(0, 100).map((b) => ({
      at: b.at, matchup: b.matchup, selection: b.selection, odds: b.odds ?? b.expectedOdds, stake: b.stake, ev: b.ev,
      status: b.status, ticket: b.betId ?? null, live: !!b.live, inPlay: !!b.inPlay, message: b.status === 'placed' ? '' : (b.message ?? ''),
      result: b.result ?? null, profit: b.betikaProfit ?? b.profit ?? null, finalScore: b.finalScore ?? null,
      betika: b.betikaStatus ?? null, mismatch: !!b.mismatch,
    })),
  };
}

/** Compact copy of scan opportunities for the page. */
export function summarizeOpps(opps) {
  return opps.slice(0, 40).map((o) => ({
    key: dedupeKey(o), sport: o.sport, matchup: matchup(o), selection: selection(o), market: o.market,
    odds: o.decimal, fair: (1 - (o.pushProb ?? 0)) / o.fairProb, ev: o.ev, start: o.commenceTime, inPlay: !!o.inPlay, model: o.model?.kind ?? null,
  }));
}

export function startDashboard({ store, s, port = 3000, log = console, state = botState }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(dashboardData(store, s, state)));
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end('not found');
  });
  server.on('error', (e) => log.warn?.(`dashboard: ${e.code === 'EADDRINUSE' ? `port ${port} is busy - set DASHBOARD_PORT` : e.message}`));
  server.listen(port, '127.0.0.1', () => log.info?.(`dashboard: http://localhost:${port}`));
  return server;
}

// One self-contained page: no external scripts or fonts; all text inserted with textContent.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EV Bot Dashboard</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mut:#667085;--line:#e4e7ec;--ok:#067647;--okbg:#ecfdf3;--warn:#b54708;--warnbg:#fffaeb;--bad:#b42318;--badbg:#fef3f2;--acc:#3538cd;--accbg:#eef4ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e6e8ec;--mut:#98a2b3;--line:#2a2f3a;--ok:#47cd89;--okbg:#0c2a1c;--warn:#fdb022;--warnbg:#2b1e06;--bad:#f97066;--badbg:#2d1210;--acc:#8098f9;--accbg:#161b33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid var(--line);background:var(--card)}
h1{font-size:18px;margin:0}main{padding:16px;max-width:1200px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.pills{display:flex;flex-wrap:wrap;gap:6px}.pill{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--accbg);color:var(--acc)}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.bad{background:var(--badbg);color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.tile,.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}
.tile .k{color:var(--mut);font-size:12px}.tile .v{font-size:22px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}.tile .s{color:var(--mut);font-size:12px}
.bar{height:6px;border-radius:3px;background:var(--line);margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc)}
h2{font-size:15px;margin:0 0 10px}.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:600;font-size:12px}td.num,th.num{text-align:right}.muted{color:var(--mut)}.empty{color:var(--mut);padding:12px 0}
.pos{color:var(--ok);font-weight:600}.neg{color:var(--bad)}
</style></head><body>
<header><h1>EV Bot</h1><div class="pills" id="pills"></div><div class="muted" id="updated"></div></header>
<main>
<section class="tiles" id="tiles"></section>
<section class="card"><h2>Current +EV opportunities</h2><div class="scroll"><table id="opps"></table></div><div class="muted" id="closest"></div></section>
<section class="card"><h2>Recent bets</h2><div class="scroll"><table id="bets"></table></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const kes = (n) => 'KES ' + Math.round(n ?? 0).toLocaleString();
const pct = (x) => (x == null ? '' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const time = (t) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - new Date(t)) / 1000); return s < 90 ? s + 's ago' : Math.round(s / 60) + ' min ago'; };
function table(t, cols, rows, empty) {
  t.replaceChildren();
  if (!rows.length) { const tr = el('tr'); const td = el('td', empty, 'empty'); td.colSpan = cols.length; tr.append(td); t.append(tr); return; }
  const h = el('tr'); for (const c of cols) h.append(el('th', c.h, c.num ? 'num' : '')); t.append(h);
  for (const r of rows) { const tr = el('tr'); for (const c of cols) { const v = c.f(r); const td = el('td', v.t ?? v, (c.num ? 'num ' : '') + (v.c ?? '')); tr.append(td); } t.append(tr); }
}
function tile(k, v, s, ratio) {
  const d = el('div', null, 'tile'); d.append(el('div', k, 'k'), el('div', v, 'v')); if (s) d.append(el('div', s, 's'));
  if (ratio != null) { const b = el('div', null, 'bar'); const i = el('i'); i.style.width = Math.min(100, ratio * 100) + '%'; b.append(i); d.append(b); }
  return d;
}
function resultTile(k, r) {
  const d = tile(k, (r.profit >= 0 ? '+' : '') + kes(r.profit),
    r.won + 'W ' + r.lost + 'L ' + r.push + 'P · ROI ' + (r.roi == null ? '–' : pct(r.roi)) + ' · expected ' + kes(r.expected) + ' · ' + r.pending + ' unsettled');
  d.querySelector('.v').className = 'v ' + (r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : '');
  return d;
}
const statusClass = (s) => s === 'placed' ? 'pos' : (s === 'rejected' || s === 'error' || s === 'unknown') ? 'neg' : 'muted';
async function refresh() {
  let d; try { d = await (await fetch('/api/state', { cache: 'no-store' })).json(); } catch { $('updated').textContent = 'bot not reachable'; return; }
  const m = d.mode ?? {};
  const pills = $('pills'); pills.replaceChildren(
    el('span', m.betikaLive ? 'LIVE BETTING' : 'DRY RUN', 'pill ' + (m.betikaLive ? 'ok' : 'warn')),
    el('span', m.liveBetting ? (m.liveBetsLive && m.betikaLive ? 'in-play: real' : 'in-play: dry run') : 'in-play: off', 'pill'),
    el('span', 'min EV ' + pct(m.minEv), 'pill'),
    el('span', 'tax ' + Math.round((m.tax ?? 0) * 100) + '%', 'pill'));
  $('updated').textContent = 'last scan ' + ago(d.lastScan?.at) + (d.nextScan ? ' · next ' + d.nextScan.kind + ' ' + time(d.nextScan.at) : '');
  const t = d.today;
  $('tiles').replaceChildren(
    tile('Bets today', t.placed + ' / ' + t.betLimit, t.dryRuns + ' dry runs · ' + t.rejected + ' rejected · ' + t.priceMoved + ' price moved', t.placed / (t.betLimit || 1)),
    tile('Staked today', kes(t.staked), 'limit ' + kes(t.stakeLimit), t.staked / (t.stakeLimit || 1)),
    tile('Expected profit today', kes(t.expectedProfit), 'stake × EV of placed bets'),
    tile('Betika balance', d.balance != null ? kes(d.balance) : '–', 'from the last confirmed bet'),
    tile('Odds API credits', d.credits ?? '–', 'remaining'),
    tile('All time', d.allTime.placed + ' bets', kes(d.allTime.staked) + ' staked · ' + kes(d.allTime.expectedProfit) + ' expected'),
    resultTile('Actual profit (real bets)', d.results.real),
    resultTile('Dry-run profit (paper)', d.results.dryRun));
  table($('opps'), [
    { h: 'Game', f: (o) => o.matchup }, { h: 'Pick', f: (o) => o.selection + (o.inPlay ? '  · LIVE' : '') + (o.model ? '  · model' : '') },
    { h: 'Betika', num: 1, f: (o) => o.odds.toFixed(2) }, { h: 'Fair', num: 1, f: (o) => o.fair.toFixed(2) },
    { h: 'EV', num: 1, f: (o) => ({ t: pct(o.ev), c: 'pos' }) }, { h: 'Starts', f: (o) => o.inPlay ? 'in play' : time(o.start) }],
    d.opportunities ?? [], 'No +EV prices in the last scan.');
  $('closest').textContent = d.closest ? 'Closest last scan: ' + d.closest : '';
  table($('bets'), [
    { h: 'Time', f: (b) => time(b.at) }, { h: 'Game', f: (b) => b.matchup }, { h: 'Pick', f: (b) => b.selection + (b.inPlay ? '  · LIVE' : '') },
    { h: 'Odds', num: 1, f: (b) => b.odds ? Number(b.odds).toFixed(2) : '' }, { h: 'Stake', num: 1, f: (b) => b.stake ?? '' },
    { h: 'EV', num: 1, f: (b) => pct(b.ev) }, { h: 'Status', f: (b) => ({ t: (b.live || b.status === 'dry_run' ? '' : 'dry: ') + String(b.status).replace(/_/g, ' '), c: statusClass(b.status) }) },
    { h: 'Result', f: (b) => b.result ? ({ t: b.result + (b.finalScore ? ' (' + b.finalScore + ')' : ''), c: b.result === 'won' ? 'pos' : b.result === 'lost' ? 'neg' : 'muted' }) : '' },
    { h: 'Betika says', f: (b) => b.betika ? ({ t: b.betika + (b.mismatch ? '  ⚠ check' : ''), c: b.mismatch ? 'neg' : b.betika === 'won' ? 'pos' : 'muted' }) : '' },
    { h: 'Profit', num: 1, f: (b) => b.profit == null ? '' : ({ t: (b.profit > 0 ? '+' : '') + Math.round(b.profit), c: b.profit > 0 ? 'pos' : b.profit < 0 ? 'neg' : '' }) },
    { h: 'Ticket', f: (b) => b.ticket ?? '' }, { h: 'Note', f: (b) => ({ t: b.message ?? '', c: 'muted' }) }],
    d.bets ?? [], 'No bets yet.');
}
refresh(); setInterval(refresh, 10000);
</script></body></html>`;
