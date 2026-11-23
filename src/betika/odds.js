// Attach Betika prices to Odds API events as a "betika" bookmaker.
import { SPORTS, competitionFilter, sportGroup } from '../sports.js';
import { findRow, teamSimilarity } from '../teamMatch.js';

const MAX_START_DIFF_MS = 90 * 60_000;

/**
 * Mutates `events`: adds a betika bookmaker (h2h, plus totals where comparable) and
 * `event.betikaRef` { sport, parentMatchId, home, away, swapped } for the bet placer.
 * A Betika match must be the same sport, in a fitting competition (no women's/youth/
 * doubles mix-ups), start within 90 min of the sharp event, and both names must match.
 */
export function attachBetikaOdds(events, matches, now = new Date()) {
  const used = new Set();
  const unmatched = [];
  let matched = 0;
  for (const ev of events) {
    const sport = sportGroup(ev.sport_key ?? '') ?? 'basketball';
    const inComp = competitionFilter(ev.sport_key ?? '');
    const start = new Date(ev.commence_time);
    const candidates = matches.filter((m) => !used.has(m) && (m.sport ?? 'basketball') === sport
      && inComp(m.competition) && Math.abs(m.start - start) <= MAX_START_DIFF_MS);
    const hit = findRow(ev, candidates);
    if (!hit) {
      // Only blame the names if some Betika game at that time shares a team with this one.
      const score = (m) => Math.max(
        teamSimilarity(ev.home_team, m.home), teamSimilarity(ev.home_team, m.away),
        teamSimilarity(ev.away_team, m.home), teamSimilarity(ev.away_team, m.away));
      const near = candidates.map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s)[0];
      unmatched.push(`${ev.away_team} @ ${ev.home_team}`
        + (near && near.s >= 0.5 ? ` (names did not match - Betika has "${near.m.home} v ${near.m.away}")` : ' (not on Betika right now)'));
      continue;
    }
    const m = hit.row;
    used.add(m);
    matched++;
    ev.betikaRef = { sport, parentMatchId: m.parentMatchId, home: m.home, away: m.away, swapped: hit.swapped };

    const ts = now.toISOString();
    const markets = [];
    if (m.winner) {
      const [first, second] = m.winner;
      const [home, away] = hit.swapped ? [second, first] : [first, second];
      const outcomes = [{ name: ev.home_team, price: home }, { name: ev.away_team, price: away }];
      if (m.draw) outcomes.push({ name: 'Draw', price: m.draw });
      markets.push({ key: 'h2h', last_update: ts, outcomes });
    }
    if (m.totals?.length) {
      markets.push({ key: 'totals', last_update: ts, outcomes: m.totals.flatMap((l) => [
        { name: 'Over', price: l.over, point: l.point }, { name: 'Under', price: l.under, point: l.point }]) });
    }
    ev.bookmakers = (ev.bookmakers ?? []).filter((b) => b.key !== 'betika');
    if (markets.length) ev.bookmakers.push({ key: 'betika', title: 'Betika', last_update: ts, markets });
  }
  return { matched, matches: matches.length, unmatched };
}

/**
 * Where to click on Betika's match page for this opportunity, e.g.
 * { market: 'Winner (Incl. Overtime)', label: '1' }, { market: '1x2', label: 'X' },
 * { market: 'Total', label: 'Over 2.5' }. Null if Betika has no comparable market.
 */
export function betikaPick(opp) {
  const spec = SPORTS[opp.betikaRef?.sport ?? 'basketball'];
  if (!spec) return null;
  if (opp.market === 'h2h') {
    if (opp.outcome === 'Draw') return spec.h2h.draw ? { market: spec.h2h.title, label: 'X' } : null;
    const isHome = opp.outcome === opp.homeTeam;
    return { market: spec.h2h.title, label: isHome !== opp.betikaRef.swapped ? '1' : '2' };
  }
  if (opp.market === 'totals' && spec.totals) {
    return { market: spec.totals.title, label: `${opp.outcome} ${opp.point}` };
  }
  return null;
}
