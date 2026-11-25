// Dashboard insights: closing line value (CLV), profit by sport and market, and warnings.
import { afterTax } from './oddsMath.js';
import { dedupeKey } from './scanner.js';
import { finalOutcome, firstDryRuns } from './settle.js';
import { SPORTS, sportGroup } from './sports.js';

/** A closing price counts only if taken after the bet and at most this long before the start. */
export const CLOSE_WINDOW_MIN = 60;

/**
 * After each pre-game scan: remember the latest sharp fair price for every bet whose game hasn't
 * started, from opportunities priced at any EV (`priced`, the scan run with minEv -1). The last one
 * before kick-off is the closing line. Free: uses the prices the scan already fetched.
 * Returns how many bets were updated.
 */
export function recordClosing(bets, priced, now = new Date()) {
  const byKey = new Map(priced.map((o) => [dedupeKey(o), o]));
  if (!byKey.size) return 0;
  let n = 0;
  for (const b of bets) {
    if (b.inPlay || !b.key || !b.grade?.commenceTime || new Date(b.grade.commenceTime) <= now) continue;
    if (!((b.live && ['placed', 'unknown'].includes(b.status)) || b.status === 'dry_run')) continue;
    const o = byKey.get(b.key);
    if (!o?.fairProb) continue;
    b.close = { fairProb: o.fairProb, pushProb: o.pushProb ?? 0, betikaOdds: o.decimal, at: now.toISOString() };
    n++;
  }
  return n;
}

/**
 * Closing line value: the bet's EV re-priced with the sharp closing fair probability.
 * +3% means the odds taken were 3% better than fair at the close. Null when no usable close.
 */
export function clv(b) {
  const c = b.close;
  if (!c?.fairProb || !b.grade?.commenceTime) return null;
  const at = new Date(c.at), start = new Date(b.grade.commenceTime);
  if (at - new Date(b.at) < 60_000) return null;                  // not taken after the bet
  if ((start - at) / 60_000 > CLOSE_WINDOW_MIN || at > start) return null; // too early to be the close
  const odds = Number(b.odds ?? b.expectedOdds);
  if (!(odds > 1)) return null;
  return afterTax(odds, b.grade.winningsTax ?? 0) * c.fairProb + (c.pushProb ?? 0) - 1;
}

/** CLV summary: bets with a closing price, average CLV, share that beat the close. */
export function clvSummary(list) {
  const v = list.map(clv).filter((x) => x != null);
  return { n: v.length, avg: v.length ? v.reduce((t, x) => t + x, 0) / v.length : null,
    beat: v.length ? v.filter((x) => x > 0).length / v.length : null, of: list.length };
}

export function sportLabel(b) {
  const g = b.grade?.sport ? sportGroup(b.grade.sport) : null;
  return g ? SPORTS[g].title : 'Other';
}

export function marketLabel(b) {
  const g = b.grade ?? {};
  const soccer = String(g.sport ?? '').startsWith('soccer_');
  const name = {
    h2h: soccer ? '1X2' : 'Winner',
    totals: b.model === 'alt-total' ? 'Alt totals (model)' : 'Totals',
    team_totals: b.model === 'team-total' ? 'Team totals (model)' : 'Team totals',
    double_chance: 'Double chance', draw_no_bet: 'Draw no bet',
    totals_h1: b.model === 'alt-total' ? '1st half totals (model)' : '1st half totals', team_totals_h1: '1st half team totals',
    totals_q1: b.model === 'alt-total' ? '1st quarter totals (model)' : '1st quarter totals', team_totals_q1: '1st quarter team totals',
  }[g.market] ?? (g.market ? String(g.market).replace(/_/g, ' ') : 'Other');
  if (g.market === 'soccer_props') {
    return ({ btts: 'BTTS', team_total: 'Team goals', res_total: '1X2 & Total', total_btts: 'Total & BTTS', res_btts: '1X2 & BTTS',
      dc_total: 'DC & Total', dc_btts: 'DC & BTTS', multigoals: 'Multigoals', clean_sheet: 'Clean sheet', win_to_nil: 'Win to nil' })[b.propKind] ?? 'Goals market';
  }
  if (b.model === 'inplay-model') return (b.late ? 'In-play model 80+ (test) ' : 'In-play model ') + name;
  return (b.inPlay ? 'In-play ' : '') + name + (b.steam ? ' (steam)' : '');
}

/** Bets the dashboard reports on: real (placed) and first dry runs. */
const lists = (bets) => ({ real: bets.filter((b) => b.live && b.status === 'placed'), dryRun: firstDryRuns(bets) });

function group(list, labelOf) {
  const rows = new Map();
  for (const b of list) {
    const k = labelOf(b);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(b);
  }
  return [...rows].map(([name, bs]) => {
    const settled = bs.filter((b) => ['won', 'lost', 'push'].includes(finalOutcome(b)));
    const staked = settled.reduce((t, b) => t + (b.stake ?? 0), 0);
    const profit = settled.reduce((t, b) => t + (b.betikaProfit ?? b.profit ?? 0), 0);
    const c = clvSummary(bs);
    return {
      name, bets: bs.length, settled: settled.length,
      won: settled.filter((b) => finalOutcome(b) === 'won').length, lost: settled.filter((b) => finalOutcome(b) === 'lost').length,
      staked: round2(staked), profit: round2(profit), roi: staked ? profit / staked : null,
      avgEv: bs.length ? bs.reduce((t, b) => t + (b.ev ?? 0), 0) / bs.length : null,
      clv: c.avg, clvN: c.n,
    };
  }).sort((a, b) => b.bets - a.bets || a.name.localeCompare(b.name));
}

/** Profit, ROI, EV and CLV per sport and per market, real bets and dry runs separately. */
export function breakdown(bets) {
  const l = lists(bets);
  const one = (list) => ({ bySport: group(list, sportLabel), byMarket: group(list, marketLabel), clv: clvSummary(list) });
  return { real: one(l.real), dryRun: one(l.dryRun) };
}

/**
 * Things that need a look, most serious first: { level: 'critical' | 'warning', title, detail }.
 * critical = betting has stopped or money is at stake; warning = worth checking soon.
 */
export function warnings({ bets, state = {}, s = {}, balance = null, now = new Date() }) {
  const out = [];
  const add = (level, title, detail) => out.push({ level, title, detail });
  const hoursAgo = (t) => (now - new Date(t)) / 3600_000;
  const live = !!state.mode?.betikaLive;

  if (state.halted) add('critical', 'Betting stopped', `${state.halted} - restart the bot after checking.`);
  if (state.pausedUntil && new Date(state.pausedUntil) > now) {
    add('critical', 'Betting paused after errors', `resumes ${new Date(state.pausedUntil).toLocaleTimeString()}; scanning continues.`);
  }
  const lastTry = [...bets].reverse().find((b) => b.live);
  if (live && lastTry?.status === 'not_logged_in' && hoursAgo(lastTry.at) < 6) {
    add('critical', 'Logged out of Betika', 'run `node bin/ev-bot.js login`, then restart the bot.');
  }
  const unknown = bets.filter((b) => b.status === 'unknown' && !b.betikaStatus && hoursAgo(b.at) < 72);
  if (unknown.length) {
    add('warning', `${unknown.length} bet${unknown.length > 1 ? 's' : ''} with no confirmation`,
      `${unknown.slice(0, 3).map((b) => b.selection).join('; ')} - check My Bets on Betika.`);
  }
  const mism = bets.filter((b) => b.mismatch);
  if (mism.length) {
    add('warning', `Betika and the final score disagree on ${mism.length} bet${mism.length > 1 ? 's' : ''}`,
      `ticket${mism.length > 1 ? 's' : ''} ${mism.slice(0, 5).map((b) => b.betId).join(', ')} - Betika's result is the one counted.`);
  }
  const noScore = bets.filter((b) => b.result === 'void?' && b.live && !b.betikaStatus);
  if (noScore.length) add('warning', `${noScore.length} bet${noScore.length > 1 ? 's' : ''} never got a final score`, 'check the result on Betika.');

  const lowCredits = s.creditsWarnBelow ?? 1000;
  const credits = Number(state.credits);
  if (state.credits != null && Number.isFinite(credits) && credits < lowCredits) {
    add(credits < lowCredits / 5 ? 'critical' : 'warning', `Odds API credits low: ${credits} left`, 'scans stop when they run out.');
  }
  const stake = s.betikaFixedStake || s.betikaMinStake || 0;
  if (live && balance?.amount != null && stake && balance.amount < 3 * stake) {
    add(balance.amount < stake ? 'critical' : 'warning', `Betika balance low: KES ${balance.amount}`,
      balance.amount < stake ? 'not enough for one bet.' : `about ${Math.floor(balance.amount / stake)} bets left.`);
  }
  const tax = taxCheck(bets), setTax = s.winningsTax?.betika ?? 0;
  if (tax && tax.n >= 3 && Math.abs(tax.rate - setTax) > 0.02) {
    add('critical', `Tax setting wrong: Betika withholds ${Math.round(tax.rate * 100)}% of winnings, the bot assumes ${Math.round(setTax * 100)}%`,
      `set BETIKA_WINNINGS_TAX=${Math.round(tax.rate * 100) / 100} in .env and restart - until then many "+EV" bets are not +EV after tax.`);
  }
  for (const [k, why] of Object.entries(state.pausedStrategies ?? {})) {
    add('warning', `Strategy paused: ${k}`, `${why} - now dry runs only; it resumes by itself if its picks improve.`);
  }
  if (state.lastScan?.at && hoursAgo(state.lastScan.at) > 0.25 && state.nextScan?.at && new Date(state.nextScan.at) < now - 5 * 60_000) {
    add('warning', 'No scan for a while', `last scan ${Math.round(hoursAgo(state.lastScan.at) * 60)} min ago - check the terminal.`);
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1));
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Tax check from Betika's own bet history: the share of each bet's profit Betika withholds,
 * wht / (possible win - stake), and from paid-out wins, 1 - (payout - stake) / (stake x odds - stake).
 * Returns { n, rate, fromWins } (rate = median) or null when there is no data yet.
 */
export function taxCheck(bets) {
  const rates = [], wins = [];
  for (const b of bets) {
    if (!b.live || b.status !== 'placed') continue;
    const stake = b.betikaStake ?? b.stake;
    if (b.betikaPossibleWin > stake && b.betikaWht != null && (b.betikaWht > 0 || b.betikaStatus === 'won')) {
      rates.push(b.betikaWht / (b.betikaPossibleWin - stake));
    } else if (b.betikaStatus === 'won' && b.betikaPayout != null && Number(b.odds) > 1) {
      const gross = stake * Number(b.odds);
      if (gross > stake) wins.push(1 - (b.betikaPayout - stake) / (gross - stake));
    }
  }
  const all = [...rates, ...wins].filter((x) => x > -0.05 && x < 0.6).sort((x, y) => x - y);
  if (!all.length) return null;
  return { n: all.length, rate: all[Math.floor(all.length / 2)], fromWins: wins.length };
}


/** Which strategy found a pick (works on opportunities and on recorded bets). */
export function strategyOf(x) {
  const kind = typeof x.model === 'string' ? x.model : x.model?.kind;
  const market = x.grade?.market ?? x.market ?? '';
  if (x.late || x.model?.late) return 'in-play: model 80+ (test)';
  if (kind === 'inplay-model') return 'in-play: own model';
  if (x.inPlay) return 'in-play: Pinnacle live';
  if (market === 'soccer_props') return 'pre-match: soccer goals model';
  if (/_(h1|q1)$/.test(market)) return 'pre-match: 1st half/quarter';
  if (kind === 'alt-total' || kind === 'team-total') return 'pre-match: lines model';
  if (x.steam) return 'pre-match: steam';
  if (x.opener) return 'pre-match: opener';
  return 'pre-match: normal';
}

/**
 * Strategy guard: strategies whose recent picks show no edge stop betting real money (they keep
 * running as dry runs, so they can earn their way back). Pre-match: average CLV of the last
 * GUARD_WINDOW picks with a closing price below GUARD_MIN_CLV, over at least GUARD_MIN_BETS.
 * In play (no closing line): at least GUARD_MIN_BETS_INPLAY settled picks winning 2+ standard
 * deviations less often than their fair odds predicted. Returns Map strategy -> reason.
 */
export function strategyVerdicts(bets, s) {
  const pool = [...bets.filter((b) => b.live && b.status === 'placed'), ...firstDryRuns(bets)];
  const by = new Map();
  for (const b of pool) { const k = strategyOf(b); if (!by.has(k)) by.set(k, []); by.get(k).push(b); }
  const paused = new Map();
  for (const [k, list] of by) {
    if (k.startsWith('in-play')) {
      const settled = list.filter((b) => ['won', 'lost'].includes(finalOutcome(b)) && b.fairProb > 0).slice(-s.guardWindow * 2);
      if (settled.length < s.guardMinBetsInPlay) continue;
      const won = settled.filter((b) => finalOutcome(b) === 'won').length;
      const exp = settled.reduce((t, b) => t + b.fairProb, 0);
      const sd = Math.sqrt(settled.reduce((t, b) => t + b.fairProb * (1 - b.fairProb), 0));
      const z = sd ? (won - exp) / sd : 0;
      if (z <= -2) paused.set(k, `won ${won} of ${settled.length}, fair odds predicted ${exp.toFixed(0)} (${z.toFixed(1)} sd)`);
    } else {
      const v = list.map(clv).filter((x) => x != null).slice(-s.guardWindow);
      if (v.length < s.guardMinBets) continue;
      const avg = v.reduce((t, x) => t + x, 0) / v.length;
      if (avg < s.guardMinClv) paused.set(k, `CLV ${(avg * 100).toFixed(1)}% over the last ${v.length} picks`);
    }
  }
  return paused;
}
