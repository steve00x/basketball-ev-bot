// Thin client for The Odds API v4 (https://the-odds-api.com/liveapi/guides/v4/).
export const BASE_URL = 'https://api.the-odds-api.com/v4';

export class OddsAPIError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OddsAPI {
  constructor(apiKey, { fetchImpl = globalThis.fetch, timeoutMs = 15000, retries = 3, backoffMs = 1000 } = {}) {
    if (!apiKey) throw new OddsAPIError('ODDS_API_KEY is not set (use --demo to run on sample data)');
    Object.assign(this, { apiKey, fetchImpl, timeoutMs, retries, backoffMs });
    this.requestsRemaining = null;
    this.requestsUsed = null;
  }

  async get(path, params = {}) {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries({ ...params, apiKey: this.apiKey })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        if (attempt === this.retries) throw new OddsAPIError(`network error calling ${path}: ${e.message}`);
        await sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      this.requestsRemaining = res.headers.get('x-requests-remaining') ?? this.requestsRemaining;
      this.requestsUsed = res.headers.get('x-requests-used') ?? this.requestsUsed;
      if (res.status === 429 || res.status >= 500) {
        if (attempt === this.retries) throw new OddsAPIError(`${path}: HTTP ${res.status}`);
        await sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      if (res.status !== 200) {
        throw new OddsAPIError(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    }
    throw new OddsAPIError(`${path}: retries exhausted`);
  }

  // With `bookmakers` the API ignores regions and bills per 10 books - usually cheaper.
  static bookParams(regions, bookmakers) {
    return bookmakers?.length ? { bookmakers: bookmakers.join(',') } : { regions: regions.join(',') };
  }

  /** Every sport The Odds API lists (in-season ones have active: true). Costs no credits. */
  getSports() {
    return this.get('/sports');
  }

  /** Upcoming events of one league, without odds. Costs no credits. */
  /** Scores of recent games (completed: true once final). daysFrom up to 3; costs 2 credits with daysFrom. */
  getScores(sport, daysFrom = 3) {
    return this.get(`/sports/${sport}/scores`, { daysFrom, dateFormat: 'iso' });
  }

  getEvents(sport) {
    return this.get(`/sports/${sport}/events`, { dateFormat: 'iso' });
  }

  getOdds(sport, markets, regions, bookmakers) {
    return this.get(`/sports/${sport}/odds`, {
      markets: markets.join(','), oddsFormat: 'decimal', dateFormat: 'iso',
      ...OddsAPI.bookParams(regions, bookmakers),
    });
  }

  getEventOdds(sport, eventId, markets, regions, bookmakers) {
    return this.get(`/sports/${sport}/events/${eventId}/odds`, {
      markets: markets.join(','), oddsFormat: 'decimal', dateFormat: 'iso',
      ...OddsAPI.bookParams(regions, bookmakers),
    });
  }
}
