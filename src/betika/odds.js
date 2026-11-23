// Attach Betika prices to Odds API events as a "betika" bookmaker.
import { COMPETITIONS } from './api.js';
import { findRow } from '../teamMatch.js';

const MAX_START_DIFF_MS = 90 * 60_000;

/**
 * Mutates `events`: adds a betika bookmaker (h2h + totals) and `event.betikaRef`
 * { parentMatchId, home, away, swapped } for the bet placer.
 * A match must be in the right competition, start within 90 min of the sharp
 * event, and both team names must match.
 */
export function attachBetikaOdds(events, matches, now = new Date()) {
  const used = new Set();
  const unmatched = [];
  let matched = 0;
  for (const ev of events) {
    const inComp = COMPETITIONS[ev.sport_key] ?? (() => true);
    const start = new Date(ev.commence_time);
    const candidates = matches.filter((m) => !used.has(m) && inComp(m.competition)
      && Math.abs(m.start - start) <= MAX_START_DIFF_MS);
    const hit = findRow(ev, candidates);
    if (!hit) {
      const notListed = !matches.some((m) => inComp(m.competition) && Math.abs(m.start - start) <= MAX_START_DIFF_MS);
      unmatched.push(`${ev.away_team} @ ${ev.home_team}${notListed ? ' (not on Betika yet)' : ' (names did not match)'}`);
      continue;
    }
    const m = hit.row;
    used.add(m);
    matched++;
    ev.betikaRef = { parentMatchId: m.parentMatchId, home: m.home, away: m.away, swapped: hit.swapped };

    const ts = now.toISOString();
    const markets = [];
    if (m.winner) {
      const [first, second] = m.winner;
      const [home, away] = hit.swapped ? [second, first] : [first, second];
      markets.push({ key: 'h2h', last_update: ts, outcomes: [
        { name: ev.home_team, price: home }, { name: ev.away_team, price: away }] });
    }
    if (m.totals.length) {
      markets.push({ key: 'totals', last_update: ts, outcomes: m.totals.flatMap((l) => [
        { name: 'Over', price: l.over, point: l.point }, { name: 'Under', price: l.under, point: l.point }]) });
    }
    ev.bookmakers = (ev.bookmakers ?? []).filter((b) => b.key !== 'betika');
    if (markets.length) ev.bookmakers.push({ key: 'betika', title: 'Betika', last_update: ts, markets });
  }
  return { matched, matches: matches.length, unmatched };
}

/**
 * Where to click on Betika's match page for this opportunity:
 * { market: 'Winner (Incl. Overtime)', label: '1' } or { market: 'Total (Incl. Overtime)', label: 'Over 228.5' }
 */
export function betikaPick(opp) {
  if (opp.market === 'h2h') {
    const isHome = opp.outcome === opp.homeTeam;
    return { market: 'Winner (Incl. Overtime)', label: isHome !== opp.betikaRef.swapped ? '1' : '2' };
  }
  if (opp.market === 'totals') {
    return { market: 'Total (Incl. Overtime)', label: `${opp.outcome} ${opp.point}` };
  }
  return null;
}
