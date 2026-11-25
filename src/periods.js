// Pinnacle's 1st-half and 1st-quarter prices (The Odds API "period" markets: totals_h1,
// team_totals_h1, totals_q1, team_totals_q1) for basketball games Betika lists them on.
//
// They come from the per-game endpoint, 1 credit per market that has prices, so the bot is
// careful with them: only games starting within PERIOD_HOURS_BEFORE, each game at most every
// PERIOD_REFRESH_MINUTES, a few games per scan, and a daily credit cap. Prices are used in the
// scan they were fetched for only (the bot never trusts a Pinnacle price older than 5 minutes).
import { bookPlan } from './bot.js';

export const PERIOD_SPORTS = ['basketball_nba', 'basketball_ncaab', 'basketball_wnba'];
const PERIOD_KEY = /^(team_)?totals_(h1|q1)$/;

export class PeriodPrices {
  constructor(api, s, log = console) {
    Object.assign(this, { api, s, log });
    this.last = new Map(); // eventId -> last fetch (ms)
    this.spent = { day: null, credits: 0 };
  }

  /** Add Pinnacle's period markets to games due for a refresh. Call after Betika's odds are attached. */
  async enrich(events, now = Date.now()) {
    const s = this.s;
    if (!s.periodMarkets) return { games: 0 };
    const day = new Date(now).toDateString();
    if (this.spent.day !== day) this.spent = { day, credits: 0 };
    // 1st quarter: Pinnacle's line is usually a whole number and Betika has one line, so they almost
    // never pair - not worth a credit unless PERIOD_QUARTERS=true
    const wanted = (e) => (e.bookmakers.find((b) => b.key === 'betika')?.markets ?? []).map((m) => m.key)
      .filter((k) => PERIOD_KEY.test(k) && (s.periodQuarters || !k.endsWith('_q1')));
    const due = events
      .filter((e) => PERIOD_SPORTS.includes(e.sport_key) && e.betikaRef && wanted(e).length)
      .filter((e) => { const t = new Date(e.commence_time) - now; return t > 0 && t <= s.periodHoursBefore * 3600_000; })
      .filter((e) => now - (this.last.get(e.id) ?? 0) >= s.periodRefreshMinutes * 60_000)
      .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
      .slice(0, s.periodGamesPerScan);
    let asked = 0, got = 0, games = 0;
    for (const e of due) {
      const markets = wanted(e);
      if (this.spent.credits + markets.length > s.periodDailyCredits) break;
      this.last.set(e.id, now);
      let res;
      try {
        res = await this.api.getEventOdds(e.sport_key, e.id, markets, s.regions, bookPlan(s).apiBooks);
      } catch (err) {
        this.log.warn?.(`periods ${e.away_team} @ ${e.home_team}: ${err.message}`);
        continue;
      }
      this.spent.credits += this.api.lastCost ?? markets.length;
      games++;
      asked += markets.length;
      for (const bm of res?.bookmakers ?? []) {
        const mine = e.bookmakers.find((b) => b.key === bm.key);
        const fresh = (bm.markets ?? []).filter((m) => PERIOD_KEY.test(m.key));
        if (s.sharpBooks.includes(bm.key)) got += fresh.length;
        if (mine) mine.markets = [...mine.markets.filter((m) => !fresh.some((f) => f.key === m.key)), ...fresh];
        else e.bookmakers.push({ ...bm, markets: fresh });
      }
    }
    if (games) {
      this.log.info?.(`periods: 1st half/quarter prices for ${games} game(s) - Pinnacle had ${got} of ${asked} markets`
        + ` (${this.spent.credits}/${s.periodDailyCredits} credits today)`);
    }
    return { games, asked, got };
  }
}
