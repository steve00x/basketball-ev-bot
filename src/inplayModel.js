// In-play soccer model: our own fair odds from Pinnacle's pre-match price plus Betika's live score
// and minute. No delayed live feed involved: the score and clock are the ones Betika prices from.
//
// 1. Before kick-off, every scan stores Pinnacle's fair 1X2 and main total for each soccer game
//    (the "anchor"; the last one before the start is effectively the closing price).
// 2. From it: expected goals for each team over 90 minutes (Poisson, fitted to the 1X2 and total).
// 3. In play: the goals still to come = that rate x the share of the match left; add the current
//    score; price 1X2 and every total Betika offers.
// Games with a red card, a goal in the last few minutes, or late in the match are skipped: the
// model can't see what changes those.
import { attachBetikaOdds } from './betika/odds.js';
import { runCycle } from './bot.js';
import { devig } from './oddsMath.js';

const MAX_GOALS = 15;

function pmf(lambda) {
  const out = [Math.exp(-lambda)];
  for (let k = 1; k <= MAX_GOALS; k++) out.push(out[k - 1] * lambda / k);
  return out;
}

/** P(Poisson(lambda) > line) for a half line (2.5 -> 3 or more goals). */
export function pOver(lambda, line) {
  const p = pmf(lambda);
  let under = 0;
  for (let k = 0; k <= Math.floor(line); k++) under += p[k];
  return Math.max(0, 1 - under);
}

/** Home/draw/away from two independent Poisson goal counts, given a current score. */
export function result(lH, lA, hs = 0, as = 0) {
  const ph = pmf(lH), pa = pmf(lA);
  let H = 0, D = 0, A = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j], d = hs + i - (as + j);
      if (d > 0) H += p; else if (d < 0) A += p; else D += p;
    }
  }
  const t = H + D + A;
  return { H: H / t, D: D / t, A: A / t };
}

/**
 * Plain Poisson under-prices draws a little. Scale the draw so the model matches Pinnacle's
 * pre-match draw at kick-off (k = Pinnacle draw / model draw), fading as the match runs out
 * (share = part of the match's goals still to come); home/away share the rest as before.
 */
export function calibrateDraw(r, k, share) {
  const D = Math.min(0.97, r.D * (1 + (k - 1) * share));
  const rest = r.H + r.A;
  return rest > 0 ? { H: r.H / rest * (1 - D), D, A: r.A / rest * (1 - D) } : r;
}

const bisect = (f, lo, hi, n = 60) => { for (let i = 0; i < n; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; } return (lo + hi) / 2; };

/**
 * Expected goals per team over the match from Pinnacle's fair prices.
 * The total comes from the totals line (P(Over) at that line), the split from home vs away win chance.
 */
export function fitGoals({ pH, pA, line, pOver: po }) {
  const total = bisect((L) => pOver(L, line) - po, 0.05, 10);
  const share = bisect((x) => { const r = result(total * x, total * (1 - x)); return (r.H - r.A) - (pH - pA); }, 0.02, 0.98);
  return { lH: total * share, lA: total * (1 - share), total };
}

/**
 * Share of a match's goals still to come at this point. About 45% of goals come in the first half
 * and 55% in the second; with stoppage time a half runs about 47 and 50 minutes.
 */
export function remainingShare(minute, half) {
  if (half === 'ht') return 0.55;
  if (half === 1) return 0.45 * (1 - Math.min(minute, 47) / 47) + 0.55;
  if (half === 2) return 0.55 * (1 - Math.min(Math.max(minute - 45, 0), 50) / 50);
  return null;
}

/** Betika live state -> { minute, half, hs, as } from our home/away view, or null if unreadable. */
export function readLive(ref) {
  const period = String(ref?.period ?? '').toLowerCase();
  const half = /^1st half/.test(period) ? 1 : /^2nd half/.test(period) ? 2 : /half ?time|^ht$|pause|break/.test(period) ? 'ht' : null;
  if (!half) return null; // not started, extra time, penalties, interrupted...
  const minute = half === 'ht' ? 45 : parseInt(String(ref.clock ?? ''), 10);
  if (!Number.isFinite(minute)) return null;
  const m = String(ref.score ?? '').match(/^(\d+)\s*[:-]\s*(\d+)$/);
  if (!m) return null;
  let [hs, as] = [Number(m[1]), Number(m[2])];
  if (ref.swapped) [hs, as] = [as, hs];
  return { minute, half, hs, as };
}

/** Pinnacle's pre-match fair 1X2 and main total for one soccer event, or null. */
export function anchorFrom(event, s) {
  for (const book of event.bookmakers ?? []) {
    if (!s.sharpBooks.includes(book.key)) continue;
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    const tot = book.markets?.find((m) => m.key === 'totals');
    if (!h2h || h2h.outcomes?.length !== 3 || !tot) continue;
    const price = (name) => h2h.outcomes.find((o) => o.name === name)?.price;
    const prices = [price(event.home_team), price('Draw'), price(event.away_team)];
    if (prices.some((x) => !(x > 1))) continue;
    const [pH, pD, pA] = devig(prices, s.devigMethod);
    // main total: the half line whose fair Over is closest to 50%
    const byPoint = new Map();
    for (const o of tot.outcomes ?? []) {
      if (!byPoint.has(o.point)) byPoint.set(o.point, {});
      byPoint.get(o.point)[o.name] = o.price;
    }
    let best = null;
    for (const [point, x] of byPoint) {
      if (!(x.Over > 1 && x.Under > 1) || Number.isInteger(point)) continue;
      const [po] = devig([x.Over, x.Under], s.devigMethod);
      if (!best || Math.abs(po - 0.5) < Math.abs(best.pOver - 0.5)) best = { line: point, pOver: po };
    }
    if (best) return { pH, pD, pA, ...best };
  }
  return null;
}

/** After a pre-match scan: keep each soccer game's latest Pinnacle anchor (persisted in the store). */
export function recordAnchors(store, events, s, now = new Date()) {
  const anchors = (store.data.anchors ??= {});
  let n = 0;
  for (const e of events) {
    if (!String(e.sport_key ?? '').startsWith('soccer_') || new Date(e.commence_time) <= now) continue;
    const a = anchorFrom(e, s);
    if (!a) continue;
    anchors[e.id] = { sport: e.sport_key, home: e.home_team, away: e.away_team, commence: e.commence_time, ...a, at: now.toISOString() };
    n++;
  }
  for (const [id, a] of Object.entries(anchors)) if (now - new Date(a.commence) > 12 * 3600_000) delete anchors[id];
  return n;
}

/** Soccer games that have started (and could still be running) and have an anchor. */
export function anchoredLiveEvents(store, now = new Date()) {
  return Object.entries(store.data.anchors ?? {})
    .filter(([, a]) => new Date(a.commence) <= now && now - new Date(a.commence) <= 2.5 * 3600_000)
    .map(([id, a]) => ({ id, sport_key: a.sport, home_team: a.home, away_team: a.away, commence_time: a.commence, bookmakers: [], anchor: a }));
}

/**
 * The model's fair prices for one live game as a bookmaker ("model") next to Betika's,
 * or { skip: reason }. Totals are priced at every line Betika offers.
 */
export function modelBook(event, s, now = new Date(), quietSince = null) {
  const a = event.anchor, ref = event.betikaRef;
  if (!ref) return { skip: 'not_on_betika_live' };
  if (ref.redCards) return { skip: 'red_card' };
  if ((new Date(a.commence) - new Date(a.at)) / 3600_000 > s.liveModelMaxAnchorHours) return { skip: 'no_recent_prematch_price' };
  const st = readLive(ref);
  if (!st) return { skip: 'match_state_unknown' };
  if (st.minute >= s.liveModelMaxMinute) return { skip: 'too_late_in_match' };
  if (quietSince != null && (+now - quietSince) / 60_000 < s.liveModelQuietMinutes) return { skip: 'recent_goal' };
  const share = remainingShare(st.minute, st.half);
  const { lH, lA } = fitGoals(a);
  const k = a.pD > 0 ? a.pD / result(lH, lA).D : 1;
  const r = calibrateDraw(result(lH * share, lA * share, st.hs, st.as), k, share);
  const ts = now.toISOString();
  const fairPrice = (p) => (p > 0.01 && p < 0.99 ? Math.round((1 / p) * 10000) / 10000 : null);
  const markets = [];
  const h2h = [[event.home_team, r.H], ['Draw', r.D], [event.away_team, r.A]].map(([name, p]) => ({ name, price: fairPrice(p) }));
  if (h2h.every((o) => o.price)) markets.push({ key: 'h2h', last_update: ts, outcomes: h2h });
  const betikaLines = new Set((event.bookmakers.find((b) => b.key === 'betika')?.markets ?? [])
    .filter((m) => m.key === 'totals').flatMap((m) => m.outcomes.map((o) => o.point)));
  const goals = st.hs + st.as;
  const totals = [];
  for (const line of betikaLines) {
    if (Number.isInteger(line) || line < goals) continue; // whole lines can push; lines below the score are settled
    const po = pOver((lH + lA) * share, line - goals);
    const over = fairPrice(po), under = fairPrice(1 - po);
    if (over && under) totals.push({ name: 'Over', price: over, point: line }, { name: 'Under', price: under, point: line });
  }
  if (totals.length) markets.push({ key: 'totals', last_update: ts, outcomes: totals });
  if (!markets.length) return { skip: 'nothing_to_price' };
  return { book: { key: 'model', title: 'Model', last_update: ts, markets }, info: { minute: st.minute, score: `${st.hs}-${st.as}`, share, lH, lA } };
}

/**
 * One in-play model pass: anchored soccer games in progress, Betika's live odds, model prices,
 * then the usual scan and bet (in-play rules: dry run unless LIVE_BETS_LIVE).
 */
export async function runModelCycle({ store, s, feed, executor, notifier, log, guard, now = new Date() }) {
  const events = anchoredLiveEvents(store, now);
  if (!events.length || !feed) return null;
  const matches = await feed.allLiveMatches(['soccer'], log);
  attachBetikaOdds(events, matches, now, { live: true });
  guard?.observe(events, +now);
  const ready = [], skipped = {};
  for (const e of events) {
    const quiet = e.betikaRef?.liveMatchId ? guard?.seen.get(e.betikaRef.liveMatchId)?.changedAt ?? null : null;
    const m = modelBook(e, s, now, quiet);
    if (m.skip) { skipped[m.skip] = (skipped[m.skip] ?? 0) + 1; continue; }
    e.bookmakers.push(m.book);
    e.modelInfo = m.info;
    ready.push(e);
  }
  const why = Object.entries(skipped).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
  log.info(`live model: ${events.length} soccer games with a pre-match price, ${ready.length} priced${why ? ` (skipped: ${why})` : ''}`);
  if (!ready.length) return { found: 0, all: [], inPlay: events.length };
  const byId = new Map(ready.map((e) => [e.id, e]));
  const ms = { ...s, sharpBooks: ['model'], liveMinEv: s.liveModelMinEv, liveMaxOddsAgeSeconds: 120 };
  const r = await runCycle({ events: ready, s: ms, store, notifier, betika: null, executor, log, live: true, guard, confirm: null, now,
    decorate: (o) => { o.model = { kind: 'inplay-model', ...byId.get(o.eventId)?.modelInfo }; o.minEv = s.liveModelMinEv; } });
  return { ...r, inPlay: events.length };
}
