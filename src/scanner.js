// Find +EV bets by comparing soft-book prices to de-vigged sharp prices.
import * as om from './oddsMath.js';

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
    buckets.get(bk).prices.set(outcomeKey(o.name, point), { name: o.name, point, price: Number(o.price) });
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
  const start = new Date(event.commence_time);
  if (Number.isNaN(+start) || start <= now) return []; // pre-game only
  if ((start - now) / 1000 > s.maxHoursToStart * 3600) return [];

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
        });
      }
    }
  }
  return opps;
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
