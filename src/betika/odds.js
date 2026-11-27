// Attach Betika prices to Odds API events as a "betika" bookmaker.
import { SPORTS, competitionFilter, sportGroup } from '../sports.js';
import { findRow, teamSimilarity } from '../teamMatch.js';

const MAX_START_DIFF_MS = 90 * 60_000;

/**
 * Do Betika's winner prices look like the sharp book's for this game? Implied chances may differ
 * by bookmaker margin and a real edge, not by 15+ points (a different game, or the teams swapped).
 */
function samePriceShape(ev, hit) {
  const m = hit.row;
  if (!m.winner) return false;
  const sharp = (ev.bookmakers ?? []).find((b) => b.key !== 'betika' && b.markets?.some((x) => x.key === 'h2h'))?.markets.find((x) => x.key === 'h2h');
  if (!sharp) return false;
  const p = (name) => { const o = sharp.outcomes.find((x) => x.name === name); return o ? 1 / o.price : null; };
  const [b1, b2] = hit.swapped ? [m.winner[1], m.winner[0]] : m.winner;
  const pairs = [[p(ev.home_team), 1 / b1], [p(ev.away_team), 1 / b2]];
  if (m.draw && p('Draw') != null) pairs.push([p('Draw'), 1 / m.draw]);
  return pairs.every(([x, y]) => x != null && Math.abs(x - y) < 0.15);
}

/**
 * Mutates `events`: adds a betika bookmaker (h2h, plus totals where comparable) and
 * `event.betikaRef` { sport, parentMatchId, home, away, swapped } for the bet placer.
 * A Betika match must be the same sport, in a fitting competition (no women's/youth/
 * doubles mix-ups), start within 90 min of the sharp event, and both names must match.
 */
export function attachBetikaOdds(events, matches, now = new Date(), { live = false } = {}) {
  const used = new Set();
  const unmatched = [];
  let matched = 0;
  for (const ev of events) {
    // Pre-game scans skip started games (they're on Betika's live page); live scans take only started ones.
    if ((new Date(ev.commence_time) <= now) !== live) continue;
    const sport = sportGroup(ev.sport_key ?? '') ?? 'basketball';
    const inComp = competitionFilter(ev.sport_key ?? '');
    const start = new Date(ev.commence_time);
    const candidates = matches.filter((m) => !used.has(m) && (m.sport ?? 'basketball') === sport
      && inComp(m.competition) && Math.abs(m.start - start) <= MAX_START_DIFF_MS);
    let hit = findRow(ev, candidates);
    // matched on one team + kick-off only: accept only if Betika's prices look like the same game
    if (hit?.loose && !samePriceShape(ev, hit)) hit = null;
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
    ev.betikaRef = { sport, parentMatchId: m.parentMatchId, home: m.home, away: m.away, swapped: hit.swapped,
      ...(m.live ? { liveMatchId: m.liveMatchId, clock: m.clock, period: m.period, score: m.score, redCards: m.redCards ?? null } : {}) };

    const ts = now.toISOString();
    const markets = [];
    if (m.winner) {
      const [first, second] = m.winner;
      const [home, away] = hit.swapped ? [second, first] : [first, second];
      const outcomes = [{ name: ev.home_team, price: home }, { name: ev.away_team, price: away }];
      if (m.draw) outcomes.push({ name: 'Draw', price: m.draw });
      markets.push({ key: 'h2h', last_update: ts, outcomes });
    }
    // Double Chance / Draw No Bet. Outcomes carry a code from OUR home/away view
    // (H = home, D = draw, A = away), translated if Betika lists the teams the other way round.
    const side = (b) => (b === '1') !== hit.swapped ? 'H' : 'A';
    const label = { H: ev.home_team, A: ev.away_team, D: 'Draw' };
    if (m.doubleChance) {
      const dc = [['1X', [side('1'), 'D']], ['X2', ['D', side('2')]], ['12', ['H', 'A']]].map(([k, codes]) => {
        const code = ['H', 'D', 'A'].filter((c) => codes.includes(c)).join('');
        return { name: code.split('').map((c) => label[c]).join(' or '), code, price: m.doubleChance[k] };
      });
      markets.push({ key: 'double_chance', last_update: ts, outcomes: dc });
    }
    if (m.drawNoBet) {
      const [b1, b2] = m.drawNoBet;
      markets.push({ key: 'draw_no_bet', last_update: ts, outcomes: [
        { name: ev.home_team, code: 'H', price: hit.swapped ? b2 : b1 },
        { name: ev.away_team, code: 'A', price: hit.swapped ? b1 : b2 }] });
    }
    // Team totals: Betika's first-listed team is our home team unless swapped
    if (m.teamTotals) {
      const teams = [
        { ladder: m.teamTotals.home, ours: hit.swapped ? 'A' : 'H', betikaTeam: m.home },
        { ladder: m.teamTotals.away, ours: hit.swapped ? 'H' : 'A', betikaTeam: m.away }];
      const outcomes = teams.flatMap(({ ladder, ours, betikaTeam }) => ladder.flatMap((l) => ['over', 'under'].map((k) => ({
        name: k === 'over' ? 'Over' : 'Under', price: l[k], point: l.point,
        description: ours === 'H' ? ev.home_team : ev.away_team, side: ours, betikaTeam }))));
      if (outcomes.length) markets.push({ key: 'team_totals', last_update: ts, outcomes });
    }
    // Soccer goals markets (priced by the goals model): the rule turned to our home/away view
    if (m.props?.length) {
      const map = (x) => (x === 'X' ? 'D' : (x === '1') !== hit.swapped ? 'H' : 'A');
      const orient = (r) => ({ ...r, ...(r.res ? { res: ['H', 'D', 'A'].filter((c) => r.res.map(map).includes(c)).join('') } : {}),
        ...(r.team ? { team: { ...r.team, side: map(r.team.side) } } : {}), ...(r.zero ? { zero: map(r.zero) } : {}) });
      markets.push({ key: 'soccer_props', last_update: ts, outcomes: m.props.map((p) => ({
        name: p.label, price: p.price, description: p.title, betikaMarket: p.title, betikaLabel: p.label, kind: p.kind, rule: orient(p.rule) })) });
    }
    // 1st half / 1st quarter: market keys as The Odds API names them (totals_h1, team_totals_q1, ...)
    for (const [pk, per] of Object.entries(m.periods ?? {})) {
      if (per.totals.length) {
        markets.push({ key: `totals_${pk}`, last_update: ts, outcomes: per.totals.flatMap((l) => [
          { name: 'Over', price: l.over, point: l.point }, { name: 'Under', price: l.under, point: l.point }]) });
      }
      const teams = [
        { ladder: per.teamTotals.home, ours: hit.swapped ? 'A' : 'H', betikaTeam: m.home },
        { ladder: per.teamTotals.away, ours: hit.swapped ? 'H' : 'A', betikaTeam: m.away }];
      const outcomes = teams.flatMap(({ ladder, ours, betikaTeam }) => ladder.flatMap((l) => ['over', 'under'].map((k) => ({
        name: k === 'over' ? 'Over' : 'Under', price: l[k], point: l.point,
        description: ours === 'H' ? ev.home_team : ev.away_team, side: ours, betikaTeam }))));
      if (outcomes.length) markets.push({ key: `team_totals_${pk}`, last_update: ts, outcomes });
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
  // H/D/A codes are from our home/away view; Betika's 1/2 may be swapped.
  const sym = (c) => (c === 'D' ? 'X' : ((c === 'H') !== opp.betikaRef.swapped ? '1' : '2'));
  if (opp.market === 'double_chance' && spec.doubleChance && opp.code) {
    const syms = opp.code.split('').map(sym);
    const lbl = syms.includes('X') ? (syms.includes('1') ? '1/X' : 'X/2') : '1/2';
    return { market: spec.doubleChance.title, label: lbl };
  }
  if (opp.market === 'draw_no_bet' && spec.drawNoBet && opp.code) {
    return { market: spec.drawNoBet.title, label: sym(opp.code) };
  }
  if (opp.market === 'team_totals' && spec.teamTotals && opp.betikaTeam) {
    return { market: `${opp.betikaTeam} ${spec.teamTotals.titleSuffix}`, label: `${opp.outcome} ${opp.point}` };
  }
  if (opp.market === 'totals' && spec.totals) {
    return { market: spec.totals.title, label: `${opp.outcome} ${opp.point}` };
  }
  // soccer goals markets carry Betika's own market title and button label
  if (opp.market === 'soccer_props') return opp.betikaMarket && opp.betikaLabel ? { market: opp.betikaMarket, label: opp.betikaLabel } : null;
  // 1st half / 1st quarter, e.g. "1st Half - Total" / "1st Half - Philadelphia Total"
  const per = /^(team_)?totals_(h1|q1)$/.exec(opp.market ?? '');
  const p = per && spec.periods?.find((x) => x.key === per[2]);
  if (p) {
    if (per[1] && !opp.betikaTeam) return null;
    return { market: per[1] ? `${p.title} - ${opp.betikaTeam} Total` : `${p.title} - Total`, label: `${opp.outcome} ${opp.point}` };
  }
  return null;
}
