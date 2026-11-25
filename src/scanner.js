// Find +EV bets by comparing soft-book prices to de-vigged sharp prices.
import { anchorFrom, ruleProb, scoreMatrix } from './goalModel.js';
import * as om from './oddsMath.js';
import { sportGroup } from './sports.js';

const outcomeKey = (name, point) => JSON.stringify([name, point]);

/**
 * Split one bookmaker market into complementary lines.
 * A market can hold many lines (alt spreads, several players' props), so outcomes
 * are bucketed by player + line; each bucket is identified by its exact set of
 * (name, point) outcomes. Two books only match if those sets are identical,
 * e.g. Lakers +2.5 / Celtics -2.5.
 * Returns Map<lineKey, {market, description, prices: Map<outcomeKey, {name, point, price}>}>
 */
export function groupLines(marketKey, outcomes = []) {
  const spreadLike = /spread|handicap/.test(marketKey);
  const buckets = new Map();
  for (const o of outcomes) {
    const point = o.point === undefined || o.point === null ? null : Number(o.point);
    const bucketPoint = spreadLike && point !== null ? Math.abs(point) : point;
    const desc = o.description ?? null;
    const bk = JSON.stringify([desc, bucketPoint]);
    if (!buckets.has(bk)) buckets.set(bk, { description: desc, prices: new Map() });
    // Keep the bookmaker's own details (e.g. Betika's team name for team totals) for the bet placer.
    buckets.get(bk).prices.set(outcomeKey(o.name, point), {
      name: o.name, point, price: Number(o.price),
      ...(o.betikaTeam ? { betikaTeam: o.betikaTeam } : {}), ...(o.side ? { side: o.side } : {}), ...(o.code ? { code: o.code } : {}),
    });
  }
  const lines = new Map();
  for (const { description, prices } of buckets.values()) {
    if (prices.size < 2) continue;
    const key = JSON.stringify([marketKey, description, [...prices.keys()].sort()]);
    lines.set(key, { market: marketKey, description, prices });
  }
  return lines;
}

const ageSeconds = (bm, mkt, now) => {
  const ts = mkt.last_update || bm.last_update;
  return ts ? (now - new Date(ts)) / 1000 : 0;
};

export function scanEvent(event, s, now = new Date()) {
  // A NaN threshold would let every price through as "+EV" (ev < NaN is always false).
  if (!Number.isFinite(s.minEv)) throw new Error(`MIN_EV is not a number (${s.minEv}) - fix it in .env`);
  const start = new Date(event.commence_time);
  if (Number.isNaN(+start)) return [];
  if (s.inPlay) {
    // live scan: only games under way (and not long finished)
    if (start > now || (now - start) / 1000 > (s.liveMaxHoursSinceStart ?? 4) * 3600) return [];
  } else {
    if (start <= now) return []; // pre-game only
    if ((start - now) / 1000 > s.maxHoursToStart * 3600) return [];
  }

  const sharpSet = new Set(s.sharpBooks);
  const targetSet = new Set(s.targetBooks);

  // lineKey -> { market, description, books: Map<bookKey, {prices, age, title}> }
  const lines = new Map();
  for (const bm of event.bookmakers ?? []) {
    for (const mkt of bm.markets ?? []) {
      if (mkt.key.endsWith('_lay')) continue; // exchange lays are not back bets
      const age = ageSeconds(bm, mkt, now);
      if (age > s.maxLineAgeSeconds) continue;
      for (const [key, line] of groupLines(mkt.key, mkt.outcomes)) {
        if (!lines.has(key)) lines.set(key, { market: line.market, description: line.description, books: new Map() });
        lines.get(key).books.set(bm.key, { prices: line.prices, age, title: bm.title ?? bm.key });
      }
    }
  }

  const opps = [];
  let threeWay = null;
  let mainTotal = null;
  const mainTotals = new Map();   // 'totals' | 'totals_h1' | 'totals_q1' -> sharp main line
  const exactTotalPoints = new Map();
  let mainSpread = null;
  const sharpTotalPoints = new Set();
  const sharpTeamTotals = new Set();
  for (const { market, description, books } of lines.values()) {
    const sharps = [...books.keys()].filter((b) => sharpSet.has(b));
    if (!sharps.length) continue;

    // Average de-vigged probabilities across all sharp books quoting this line.
    const fair = new Map();
    for (const b of sharps) {
      const entries = [...books.get(b).prices];
      const probs = om.devig(entries.map(([, o]) => o.price), s.devigMethod);
      entries.forEach(([k], i) => fair.set(k, (fair.get(k) ?? 0) + probs[i] / sharps.length));
    }

    // Lines the sharp quotes exactly are priced from its real price, never from the models.
    const totalsFamily = /^totals(_h1|_q1)?$/.test(market) && !description;
    if (market === 'totals' && !description) for (const [, o] of books.get(sharps[0]).prices) sharpTotalPoints.add(o.point);
    if (totalsFamily) {
      if (!exactTotalPoints.has(market)) exactTotalPoints.set(market, new Set());
      for (const [, o] of books.get(sharps[0]).prices) exactTotalPoints.get(market).add(o.point);
    }
    if (market === 'team_totals') for (const [, o] of books.get(sharps[0]).prices) sharpTeamTotals.add(`${description}|${o.point}`);

    // Remember the sharp main spread (home line, fair P(home covers)) for team totals.
    if (market === 'spreads' && !description) {
      const home = [...books.get(sharps[0]).prices].find(([, o]) => o.name === event.home_team);
      if (home) {
        const p = fair.get(home[0]);
        if (p && (!mainSpread || Math.abs(p - 0.5) < Math.abs(mainSpread.pCover - 0.5))) mainSpread = { homePoint: home[1].point, pCover: p };
      }
    }

    // Remember the sharp main total (fair P(Over) at its line) for the alternate-totals model.
    // (also the 1st-half / 1st-quarter totals, each its own ladder)
    if (totalsFamily) {
      const [[k1, o1], [k2, o2]] = [...books.get(sharps[0]).prices];
      const over = o1.name === 'Over' ? [k1, o1] : [k2, o2];
      const pOver = fair.get(over[0]);
      const cur = mainTotals.get(market);
      if (pOver && (!cur || Math.abs(pOver - 0.5) < Math.abs(cur.pOver - 0.5))) mainTotals.set(market, { line: over[1].point, pOver, sharps });
      if (market === 'totals') mainTotal = mainTotals.get('totals');
    }

    // Remember the sharp 3-way 1X2 (home/draw/away): Double Chance and Draw No Bet derive from it.
    if (market === 'h2h' && !description) {
      const pH = fair.get(outcomeKey(event.home_team, null)), pA = fair.get(outcomeKey(event.away_team, null));
      const pD = fair.get(outcomeKey('Draw', null));
      if (pH && pA && pD && fair.size === 3) threeWay = { H: pH, D: pD, A: pA, sharps };
    }

    for (const [book, { prices, age, title }] of books) {
      if (sharpSet.has(book) || (targetSet.size && !targetSet.has(book))) continue;
      const tax = s.winningsTax?.[book] ?? 0;
      for (const [k, o] of prices) {
        if (o.price < s.minDecimalOdds || o.price > s.maxDecimalOdds) continue;
        const p = fair.get(k);
        const effective = om.afterTax(o.price, tax); // what you really get paid
        const ev = om.expectedValue(p, effective);
        if (ev < s.minEv) continue;
        opps.push({
          sport: event.sport_key ?? '',
          eventId: event.id,
          homeTeam: event.home_team ?? '',
          awayTeam: event.away_team ?? '',
          commenceTime: start,
          market, description,
          outcome: o.name, point: o.point,
          ...(o.betikaTeam ? { betikaTeam: o.betikaTeam } : {}), ...(o.code ? { code: o.code } : {}),
          book, bookTitle: title,
          decimal: o.price,
          effectiveDecimal: effective,
          winningsTax: tax,
          fairProb: p,
          ev,
          stake: om.stake(p, effective, s.bankroll, s.kellyFraction, s.maxStakePct),
          sharpBooks: sharps,
          lineAgeSeconds: age,
          betikaRef: event.betikaRef ?? null,
          ...(s.inPlay ? { inPlay: true } : {}),
        });
      }
    }
  }
  if (threeWay) opps.push(...scanDerived(event, s, now, start, threeWay, sharpSet, targetSet));
  if (s.soccerModel && String(event.sport_key ?? '').startsWith('soccer_') && !s.inPlay) opps.push(...scanSoccerModel(event, s, now, start, targetSet));
  if (s.altTotals && sportGroup(event.sport_key ?? '') === 'basketball') {
    for (const [key, main] of mainTotals) {
      opps.push(...scanAltTotals(event, s, now, start, main, sharpSet, targetSet, exactTotalPoints.get(key) ?? new Set(), key));
    }
  }
  if (mainTotal && mainSpread && s.teamTotals && sportGroup(event.sport_key ?? '') === 'basketball') {
    opps.push(...scanTeamTotals(event, s, now, start, mainTotal, mainSpread, sharpSet, targetSet, sharpTeamTotals));
  }
  return opps;
}

/**
 * Soccer goals markets (BTTS, team goals, 1X2 & Total, ...) priced from a score matrix fitted to
 * Pinnacle's fair 1X2 and main total (src/goalModel.js). No extra API cost. Stricter EV floor,
 * and an EV ceiling: a huge "edge" on a derived market is more likely a misread market than a gift.
 */
function scanSoccerModel(event, s, now, start, targetSet) {
  const anchor = anchorFrom(event, s);
  if (!anchor) return [];
  const sharpAge = anchor.age ? (now - new Date(anchor.age)) / 1000 : 0;
  if (sharpAge > s.maxLineAgeSeconds) return [];
  let M = null;
  const out = [];
  for (const bm of event.bookmakers ?? []) {
    if (targetSet.size && !targetSet.has(bm.key)) continue;
    const mkt = (bm.markets ?? []).find((m) => m.key === 'soccer_props');
    if (!mkt) continue;
    const age = ageSeconds(bm, mkt, now);
    if (age > s.maxLineAgeSeconds) continue;
    const tax = s.winningsTax?.[bm.key] ?? 0;
    M ??= scoreMatrix(anchor).M;
    for (const o of mkt.outcomes ?? []) {
      if (!o.rule || o.price < s.minDecimalOdds || o.price > s.maxDecimalOdds) continue;
      const p = ruleProb(M, o.rule);
      if (!(p > 0.01 && p < 0.99)) continue;
      const effective = om.afterTax(o.price, tax);
      const ev = om.expectedValue(p, effective);
      if (!(ev >= Math.max(s.soccerModelMinEv, s.minEv)) || ev > s.soccerModelMaxEv) continue;
      out.push({
        sport: event.sport_key ?? '', eventId: event.id,
        homeTeam: event.home_team ?? '', awayTeam: event.away_team ?? '', commenceTime: start,
        market: 'soccer_props', description: o.betikaMarket, outcome: o.betikaLabel, point: null,
        betikaMarket: o.betikaMarket, betikaLabel: o.betikaLabel, rule: o.rule, propKind: o.kind,
        book: bm.key, bookTitle: bm.title ?? bm.key,
        decimal: o.price, effectiveDecimal: effective, winningsTax: tax, fairProb: p, ev,
        stake: om.stake(p, effective, s.bankroll, s.kellyFraction, s.maxStakePct),
        sharpBooks: anchor.sharps, lineAgeSeconds: Math.max(age, sharpAge), betikaRef: event.betikaRef ?? null,
        model: { kind: 'soccer-goals' },
      });
    }
  }
  return out;
}

/**
 * Double Chance and Draw No Bet, priced from the sharp 3-way 1X2 (no extra API cost):
 *   Double Chance "H or D": P = P(H) + P(D), no push.
 *   Draw No Bet "H": wins with P(H), stake back with P(D):  EV = P(H) x odds + P(D) - 1.
 */
function scanDerived(event, s, now, start, threeWay, sharpSet, targetSet) {
  const out = [];
  for (const bm of event.bookmakers ?? []) {
    if (sharpSet.has(bm.key) || (targetSet.size && !targetSet.has(bm.key))) continue;
    const tax = s.winningsTax?.[bm.key] ?? 0;
    for (const mkt of bm.markets ?? []) {
      if (mkt.key !== 'double_chance' && mkt.key !== 'draw_no_bet') continue;
      const age = ageSeconds(bm, mkt, now);
      if (age > s.maxLineAgeSeconds) continue;
      for (const o of mkt.outcomes ?? []) {
        if (!o.code || o.price < s.minDecimalOdds || o.price > s.maxDecimalOdds) continue;
        const pWin = mkt.key === 'double_chance' ? o.code.split('').reduce((t, c) => t + threeWay[c], 0) : threeWay[o.code];
        const pPush = mkt.key === 'draw_no_bet' ? threeWay.D : 0;
        const effective = om.afterTax(o.price, tax);
        const ev = pWin * effective + pPush - 1;
        if (!(ev >= s.minEv)) continue;
        out.push({
          sport: event.sport_key ?? '', eventId: event.id,
          homeTeam: event.home_team ?? '', awayTeam: event.away_team ?? '', commenceTime: start,
          market: mkt.key, description: null, outcome: o.name, point: null, code: o.code,
          book: bm.key, bookTitle: bm.title ?? bm.key,
          decimal: o.price, effectiveDecimal: effective, winningsTax: tax,
          fairProb: pWin, pushProb: pPush, ev,
          stake: om.stakeWithPush(pWin, pPush, effective, s.bankroll, s.kellyFraction, s.maxStakePct),
          sharpBooks: threeWay.sharps, lineAgeSeconds: age, betikaRef: event.betikaRef ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * Fit a soft book's ladder of total lines to a normal curve: probit of its de-vigged P(Over)
 * against the line is a straight line with slope -1/sigma. Returns { sigma, mu, r2 } or null.
 */
export function fitTotalLadder(lines) {
  const pts = lines.filter((l) => l.over > 1 && l.under > 1).map((l) => {
    const io = 1 / l.over, iu = 1 / l.under;
    return { L: l.point, z: om.normInv(iu / (io + iu)) }; // z = probit(P(Under)) = (L - mu) / sigma
  });
  if (pts.length < 3) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p.L, 0) / n, mz = pts.reduce((a, p) => a + p.z, 0) / n;
  const sxx = pts.reduce((a, p) => a + (p.L - mx) ** 2, 0), szz = pts.reduce((a, p) => a + (p.z - mz) ** 2, 0);
  const sxz = pts.reduce((a, p) => a + (p.L - mx) * (p.z - mz), 0);
  if (!(sxx > 0 && szz > 0 && sxz > 0)) return null;
  const slope = sxz / sxx;
  return { sigma: 1 / slope, mu: mx - mz / slope, r2: (sxz * sxz) / (sxx * szz) };
}

/**
 * Basketball alternate totals: Pinnacle quotes one main line, Betika ~7. The spread (sigma)
 * comes from Betika's own ladder for this game (it fits a normal curve almost exactly),
 * the centre from Pinnacle's main line. A Betika line is +EV when Betika's centre is off
 * from Pinnacle's by more than its margin. Only lines near the main line, stricter MIN_EV.
 */
// Normal-curve spread (points) a clean Betika ladder can have, per market; full game ~17, 1st half ~11.
const SIGMA_RANGE = { totals: [8, 30], totals_h1: [6, 20], totals_q1: [3, 12] };

function scanAltTotals(event, s, now, start, main, sharpSet, targetSet, exactPoints = new Set(), marketKey = 'totals') {
  const out = [];
  for (const bm of event.bookmakers ?? []) {
    if (sharpSet.has(bm.key) || (targetSet.size && !targetSet.has(bm.key))) continue;
    const mkt = (bm.markets ?? []).find((m) => m.key === marketKey);
    if (!mkt) continue;
    const age = ageSeconds(bm, mkt, now);
    if (age > s.maxLineAgeSeconds) continue;
    const ladder = new Map();
    for (const o of mkt.outcomes ?? []) {
      if (!ladder.has(o.point)) ladder.set(o.point, { point: o.point });
      ladder.get(o.point)[o.name === 'Over' ? 'over' : 'under'] = o.price;
    }
    const fit = fitTotalLadder([...ladder.values()]);
    const [lo, hi] = SIGMA_RANGE[marketKey] ?? SIGMA_RANGE.totals;
    if (!fit || fit.r2 < 0.99 || fit.sigma < lo || fit.sigma > hi) continue; // ladder doesn't look like a clean model
    const maxDistance = s.altTotalsMaxDistance * Math.min(1, fit.sigma / 17); // same reach in "spreads" for halves
    const muSharp = main.line - fit.sigma * om.normInv(1 - main.pOver);
    const tax = s.winningsTax?.[bm.key] ?? 0;
    for (const l of ladder.values()) {
      if (exactPoints.has(l.point) || Math.abs(l.point - main.line) > maxDistance) continue;
      if (Math.abs(l.point % 1) !== 0.5) continue; // whole-number lines can push
      const pOver = 1 - om.normCdf((l.point - muSharp) / fit.sigma);
      for (const [name, price, p] of [['Over', l.over, pOver], ['Under', l.under, 1 - pOver]]) {
        if (!price || price < s.minDecimalOdds || price > s.maxDecimalOdds) continue;
        const effective = om.afterTax(price, tax);
        const ev = om.expectedValue(p, effective);
        if (!(ev >= Math.max(s.altTotalsMinEv, s.minEv))) continue;
        out.push({
          sport: event.sport_key ?? '', eventId: event.id,
          homeTeam: event.home_team ?? '', awayTeam: event.away_team ?? '', commenceTime: start,
          market: marketKey, description: null, outcome: name, point: l.point,
          book: bm.key, bookTitle: bm.title ?? bm.key,
          decimal: price, effectiveDecimal: effective, winningsTax: tax,
          fairProb: p, ev, stake: om.stake(p, effective, s.bankroll, s.kellyFraction, s.maxStakePct),
          sharpBooks: main.sharps, lineAgeSeconds: age, betikaRef: event.betikaRef ?? null,
          model: { kind: 'alt-total', mainLine: main.line, sigma: fit.sigma, muSharp, muBook: fit.mu },
        });
      }
    }
  }
  return out;
}

/**
 * Basketball team totals. Each team's expected score from Pinnacle:
 *   game centre  = main total line, adjusted by its fair P(Over) (spread from Betika's game ladder)
 *   home margin  = -(home spread) + sigmaMargin x probit(P(home covers))
 *   home = (centre + margin) / 2,  away = (centre - margin) / 2
 * Each team's spread (sigma) comes from Betika's own ladder for that team. Lines within
 * TEAM_TOTALS_MAX_DISTANCE of the team's expected score, TEAM_TOTALS_MIN_EV threshold.
 */
function scanTeamTotals(event, s, now, start, main, spread, sharpSet, targetSet, exactTeamLines = new Set()) {
  const out = [];
  const sigmaMargin = event.sport_key === 'basketball_nba' ? 13 : 11;
  for (const bm of event.bookmakers ?? []) {
    if (sharpSet.has(bm.key) || (targetSet.size && !targetSet.has(bm.key))) continue;
    const game = (bm.markets ?? []).find((m) => m.key === 'totals');
    const tt = (bm.markets ?? []).find((m) => m.key === 'team_totals');
    if (!game || !tt) continue;
    const age = ageSeconds(bm, tt, now);
    if (age > s.maxLineAgeSeconds) continue;
    const ladderOf = (outs) => {
      const map = new Map();
      for (const o of outs) {
        if (!map.has(o.point)) map.set(o.point, { point: o.point });
        map.get(o.point)[o.name === 'Over' ? 'over' : 'under'] = o.price;
      }
      return [...map.values()];
    };
    const gameFit = fitTotalLadder(ladderOf(game.outcomes ?? []));
    if (!gameFit || gameFit.r2 < 0.99 || gameFit.sigma < 8 || gameFit.sigma > 30) continue;
    const muTotal = main.line - gameFit.sigma * om.normInv(1 - main.pOver);
    const margin = -spread.homePoint + sigmaMargin * om.normInv(spread.pCover);
    const centre = { H: (muTotal + margin) / 2, A: (muTotal - margin) / 2 };
    const tax = s.winningsTax?.[bm.key] ?? 0;
    for (const side of ['H', 'A']) {
      const outs = (tt.outcomes ?? []).filter((o) => o.side === side);
      if (!outs.length) continue;
      const fit = fitTotalLadder(ladderOf(outs));
      if (!fit || fit.r2 < 0.99 || fit.sigma < 5 || fit.sigma > 20) continue;
      const mu = centre[side];
      for (const o of outs) {
        if (exactTeamLines.has(`${o.description}|${o.point}`)) continue; // Pinnacle prices it directly
        if (Math.abs(o.point % 1) !== 0.5 || Math.abs(o.point - mu) > s.teamTotalsMaxDistance) continue;
        if (o.price < s.minDecimalOdds || o.price > s.maxDecimalOdds) continue;
        const pOver = 1 - om.normCdf((o.point - mu) / fit.sigma);
        const p = o.name === 'Over' ? pOver : 1 - pOver;
        const effective = om.afterTax(o.price, tax);
        const ev = om.expectedValue(p, effective);
        if (!(ev >= Math.max(s.teamTotalsMinEv, s.minEv))) continue;
        out.push({
          sport: event.sport_key ?? '', eventId: event.id,
          homeTeam: event.home_team ?? '', awayTeam: event.away_team ?? '', commenceTime: start,
          market: 'team_totals', description: o.description, outcome: o.name, point: o.point,
          betikaTeam: o.betikaTeam, book: bm.key, bookTitle: bm.title ?? bm.key,
          decimal: o.price, effectiveDecimal: effective, winningsTax: tax,
          fairProb: p, ev, stake: om.stake(p, effective, s.bankroll, s.kellyFraction, s.maxStakePct),
          sharpBooks: main.sharps, lineAgeSeconds: age, betikaRef: event.betikaRef ?? null,
          model: { kind: 'team-total', team: o.description, centre: mu, sigma: fit.sigma, centreBook: fit.mu },
        });
      }
    }
  }
  return out;
}

export const scanEvents = (events, s, now = new Date()) =>
  events.flatMap((e) => scanEvent(e, s, now)).sort((a, b) => b.ev - a.ev);

export const matchup = (o) => `${o.awayTeam} @ ${o.homeTeam}`;

export function selection(o) {
  const parts = [];
  if (o.description) parts.push(o.description);
  parts.push(o.outcome);
  if (o.point !== null && o.point !== undefined) {
    parts.push(/spread/.test(o.market) && o.point > 0 ? `+${o.point}` : `${o.point}`);
  }
  return parts.join(' ');
}

export const dedupeKey = (o) =>
  [o.eventId, o.book, o.market, o.description, o.outcome, o.point].join('|');
