// Settle bets from final scores (The Odds API /scores) and work out profit and loss.
// Real bets (placed) and dry runs are both graded, so dry-run results show how a strategy
// would have done. Payout uses the winnings tax the bet was priced with.
import { OddsAPIError } from './oddsApi.js';

const SETTLE_AFTER_MS = 2 * 3600_000; // don't look before a game can be over

/**
 * Grade one pick from a final score: 'won' | 'lost' | 'push' | null (can't tell).
 * g = { market, outcome, point, description, code, homeTeam, awayTeam }, hs/as = home/away score.
 */
export function gradePick(g, hs, as) {
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  const cmp = (x, line, over) => (x === line ? 'push' : (x > line) === over ? 'won' : 'lost');
  const sideWins = { H: hs > as, A: as > hs, D: hs === as };
  switch (g.market) {
    case 'h2h':
      if (g.outcome === 'Draw') return hs === as ? 'won' : 'lost';
      if (hs === as) return 'push'; // a 2-way market can't end level; refund if a score says so
      if (g.outcome === g.homeTeam) return hs > as ? 'won' : 'lost';
      if (g.outcome === g.awayTeam) return as > hs ? 'won' : 'lost';
      return null;
    case 'totals':
      if (g.point == null) return null;
      return cmp(hs + as, g.point, g.outcome === 'Over');
    case 'team_totals': {
      if (g.point == null) return null;
      const team = g.description === g.homeTeam ? hs : g.description === g.awayTeam ? as : null;
      return team == null ? null : cmp(team, g.point, g.outcome === 'Over');
    }
    case 'double_chance':
      return g.code ? (g.code.split('').some((c) => sideWins[c]) ? 'won' : 'lost') : null;
    case 'draw_no_bet':
      if (!g.code) return null;
      return hs === as ? 'push' : sideWins[g.code] ? 'won' : 'lost';
    default:
      return null;
  }
}

/** Money for a graded bet: payout (tax on profit taken off) and profit. */
export function payout(bet, result) {
  const stake = bet.stake ?? 0;
  const odds = Number(bet.odds ?? bet.expectedOdds);
  const tax = bet.grade?.winningsTax ?? 0;
  if (result === 'won') {
    const gross = stake * odds;
    const paid = gross - tax * (gross - stake);
    return { payout: round2(paid), profit: round2(paid - stake) };
  }
  if (result === 'push') return { payout: stake, profit: 0 };
  return { payout: 0, profit: -stake };
}
const round2 = (x) => Math.round(x * 100) / 100;

/** Dry runs repeat every scan while an edge lasts: only the first one of each pick counts. */
export function firstDryRuns(bets) {
  const seen = new Set();
  return bets.filter((b) => {
    if (b.status !== 'dry_run') return false;
    if (seen.has(b.key)) return false;
    seen.add(b.key);
    return true;
  });
}

/** Bets worth settling: placed for real, or (first) dry runs; not settled yet; game should be over. */
export function pendingBets(bets, now = Date.now()) {
  const dry = new Set(firstDryRuns(bets));
  // 1st half / quarter picks can't be graded from final scores: Betika's bet history settles those
  return bets.filter((b) => !b.result && b.grade?.sport && b.grade?.eventId && b.grade?.commenceTime && !String(b.grade.eventId).startsWith('op-')
    && !/_(h1|q1)$/.test(b.grade.market ?? '')
    && ((b.live && b.status === 'placed') || dry.has(b))
    && now - new Date(b.grade.commenceTime) >= SETTLE_AFTER_MS);
}

/**
 * Settle what can be settled: one /scores call per sport with pending bets.
 * Bets older than 3 days that never got a final score are marked 'void?' for a manual look.
 */
export async function settlePending(api, store, log = console, now = Date.now()) {
  const pending = pendingBets(store.data.bets, now);
  if (!pending.length) return { settled: 0, pending: 0 };
  const bySport = new Map();
  for (const b of pending) (bySport.get(b.grade.sport) ?? bySport.set(b.grade.sport, []).get(b.grade.sport)).push(b);
  let settled = 0;
  for (const [sport, bets] of bySport) {
    let scores;
    try {
      scores = await api.getScores(sport, 3);
    } catch (e) {
      if (!(e instanceof OddsAPIError)) throw e;
      log.warn?.(`settle ${sport}: ${e.message}`);
      continue;
    }
    const byId = new Map(scores.map((x) => [x.id, x]));
    for (const b of bets) {
      const game = byId.get(b.grade.eventId);
      if (!game?.completed) {
        if (now - new Date(b.grade.commenceTime) > 3 * 86400_000) Object.assign(b, { result: 'void?', settledAt: new Date(now).toISOString() });
        continue;
      }
      const score = (name) => Number(game.scores?.find((x) => x.name === name)?.score);
      const result = gradePick(b.grade, score(game.home_team), score(game.away_team));
      if (!result) continue;
      Object.assign(b, { result, ...payout(b, result), finalScore: `${score(game.home_team)}-${score(game.away_team)}`, settledAt: new Date(now).toISOString() });
      settled++;
    }
  }
  if (settled) {
    store.save();
    log.info?.(`settled ${settled} bets from final scores`);
  }
  return { settled, pending: pending.length - settled };
}

/** Betika's own verdict first (from My Bets), else our score-based grade: won | lost | push | other. */
export const finalOutcome = (b) => ({ won: 'won', lost: 'lost', void: 'push' })[b.betikaStatus] ?? b.result;

/** Totals for the dashboard: real bets and dry runs separately. */
export function resultsSummary(bets) {
  const outcome = finalOutcome;
  const sum = (list) => {
    const settled = list.filter((b) => ['won', 'lost', 'push'].includes(outcome(b)));
    const staked = settled.reduce((t, b) => t + (b.stake ?? 0), 0);
    // Betika's own payout wins over our calculation when we have it
    const profit = settled.reduce((t, b) => t + (b.betikaProfit ?? b.profit ?? 0), 0);
    return {
      settled: settled.length, won: settled.filter((b) => outcome(b) === 'won').length,
      lost: settled.filter((b) => outcome(b) === 'lost').length, push: settled.filter((b) => outcome(b) === 'push').length,
      staked: round2(staked), profit: round2(profit), roi: staked ? profit / staked : null,
      expected: round2(settled.reduce((t, b) => t + (b.stake ?? 0) * (b.ev ?? 0), 0)),
      pending: list.filter((b) => !outcome(b)).length,
    };
  };
  return {
    real: sum(bets.filter((b) => b.live && b.status === 'placed')),
    dryRun: sum(firstDryRuns(bets)),
  };
}

/**
 * Running totals for the dashboard graph: settled bets in game order, cumulative actual profit
 * (Betika's payout where known, else the final-score grade) against cumulative expected profit
 * (stake x EV) over the same bets. Real bets and (first) dry runs separately.
 */
export function profitCurve(bets) {
  const outcome = finalOutcome;
  const curve = (list) => {
    const settled = list.filter((b) => ['won', 'lost', 'push'].includes(outcome(b)))
      .map((b) => ({ b, t: +new Date(b.grade?.commenceTime ?? b.at) }))
      .sort((x, y) => x.t - y.t);
    let actual = 0, expected = 0;
    return settled.map(({ b, t }, i) => {
      actual += b.betikaProfit ?? b.profit ?? 0;
      expected += (b.stake ?? 0) * (b.ev ?? 0);
      return { n: i + 1, at: new Date(t).toISOString(), pick: b.selection ?? '', game: b.matchup ?? '', result: outcome(b),
        profit: round2(b.betikaProfit ?? b.profit ?? 0), actual: round2(actual), expected: round2(expected) };
    });
  };
  return { real: curve(bets.filter((b) => b.live && b.status === 'placed')), dryRun: curve(firstDryRuns(bets)) };
}
