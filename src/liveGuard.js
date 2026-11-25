// In-play safety checks. Most "+EV" in-play prices are not edges: Pinnacle's price (via The Odds API)
// is a snapshot that can be older than the last goal or basket, while Betika's price already
// reflects it. Betting those is betting against what has just happened. These checks only let an
// in-play bet through when Pinnacle has priced the game *after* the current score appeared.
import { bookPlan } from './bot.js';
import { dedupeKey, scanEvent } from './scanner.js';

export class LiveGuard {
  constructor(s) {
    this.s = s;
    this.seen = new Map(); // Betika live match id -> { score, changedAt }
  }

  /** Call after each live Betika read: remembers when each game's score last changed. */
  observe(events, now = Date.now()) {
    for (const e of events) {
      const ref = e.betikaRef;
      if (!ref?.liveMatchId) continue;
      const score = String(ref.score ?? '');
      const prev = this.seen.get(ref.liveMatchId);
      // First sighting: we don't know when the score last changed, so count it as "just now".
      if (!prev || prev.score !== score) this.seen.set(ref.liveMatchId, { score, changedAt: now });
    }
  }

  /** null if the in-play pick may be bet, else the reason to skip it. */
  check(opp, now = Date.now()) {
    if (!opp.inPlay) return null;
    if (opp.ev > (this.s.liveMaxEv ?? 0.15)) return 'edge_too_big_to_trust'; // almost always a stale price
    const id = opp.betikaRef?.liveMatchId;
    const st = id ? this.seen.get(id) : null;
    if (!st) return 'score_unknown';
    if (String(opp.betikaRef.score ?? '') !== st.score) return 'score_changed';
    const pricedAt = now - (opp.lineAgeSeconds ?? Infinity) * 1000;
    if (!(pricedAt >= st.changedAt + (this.s.liveScoreSettleSeconds ?? 10) * 1000)) return 'pinnacle_older_than_score';
    return null;
  }
}

/**
 * Right before an in-play bet: fetch Pinnacle's newest price for that one game and market
 * (1 Odds API credit) and price the pick again with Betika's odds. Returns { opp } if it is still
 * +EV at the in-play minimum, else { reason }.
 */
export async function confirmLive(api, s, opp, event, scanSettings) {
  const market = opp.market === 'h2h' ? 'h2h' : 'totals';
  let fresh;
  try {
    fresh = await api.getEventOdds(event.sport_key, event.id, [market], s.regions, bookPlan(s).apiBooks);
  } catch (e) {
    return { reason: 'confirm_failed', error: e.message };
  }
  const betika = (event.bookmakers ?? []).filter((b) => b.key === 'betika');
  const merged = { ...event, bookmakers: [...(fresh?.bookmakers ?? []), ...betika] };
  const again = scanEvent(merged, scanSettings).find((o) => dedupeKey(o) === dedupeKey(opp));
  if (!again) return { reason: 'no_edge_on_fresh_price' };
  return { opp: { ...again, stake: opp.stake } };
}
