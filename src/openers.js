// Betika watch: catches Betika's opening prices and price changes between full scans.
// A bookmaker's first prices on a game or market are its softest. Betika's listings are free to
// read, so between full scans the bot re-reads them every OPENERS_POLL_SECONDS, finds games whose
// Betika prices are new or changed, and compares only those against the Pinnacle prices of the last
// full scan (no extra Odds API credits). Picks on markets Betika listed within OPENERS_WINDOW_MINUTES
// are tagged "opener" so `review` can show whether they pay.

/** Markets of one Betika listing record, as the bot names them (soccer goals markets by title). */
export function marketKeys(m) {
  const keys = [];
  if (m.winner) keys.push('h2h');
  if (m.totals?.length) keys.push('totals');
  if (m.teamTotals && (m.teamTotals.home?.length || m.teamTotals.away?.length)) keys.push('team_totals');
  if (m.doubleChance) keys.push('double_chance');
  if (m.drawNoBet) keys.push('draw_no_bet');
  for (const t of new Set((m.props ?? []).map((p) => p.title))) keys.push(`soccer_props:${t}`);
  for (const [pk, per] of Object.entries(m.periods ?? {})) {
    if (per.totals?.length) keys.push(`totals_${pk}`);
    if (per.teamTotals?.home?.length || per.teamTotals?.away?.length) keys.push(`team_totals_${pk}`);
  }
  return keys;
}

const signature = (m) => JSON.stringify([m.winner, m.draw, m.totals, m.teamTotals, m.doubleChance, m.drawNoBet,
  (m.props ?? []).map((p) => [p.title, p.label, p.price]), m.periods]);

/** The market key an opportunity was priced on (matching marketKeys). */
export const oppMarketKey = (o) => (o.market === 'soccer_props' ? `soccer_props:${o.betikaMarket}` : o.market);

export class BetikaWatch {
  constructor(s) {
    this.s = s;
    this.sig = new Map();       // parentMatchId -> price signature
    this.firstSeen = new Map(); // `${parentMatchId}|${market}` -> ms (null = already there when the bot started)
    this.seenAt = new Map();    // parentMatchId -> last read (ms)
    this.started = false;
  }

  /** Feed every Betika read. Returns the parent match ids whose prices are new or changed since the last read. */
  observe(matches, now = Date.now()) {
    const changed = new Set();
    for (const m of matches) {
      if (m.live) continue;
      this.seenAt.set(m.parentMatchId, now);
      const sig = signature(m);
      if (this.sig.get(m.parentMatchId) !== sig) {
        if (this.sig.has(m.parentMatchId) || this.started) changed.add(m.parentMatchId);
        this.sig.set(m.parentMatchId, sig);
      }
      for (const k of marketKeys(m)) {
        const id = `${m.parentMatchId}|${k}`;
        if (!this.firstSeen.has(id)) this.firstSeen.set(id, this.started ? now : null);
      }
    }
    this.started = true;
    // forget games not listed for 2 days (keeps memory flat over days of running)
    for (const [id, t] of this.seenAt) {
      if (now - t < 2 * 86400_000) continue;
      this.seenAt.delete(id); this.sig.delete(id);
      for (const k of this.firstSeen.keys()) if (k.startsWith(`${id}|`)) this.firstSeen.delete(k);
    }
    return changed;
  }

  /** Was this pick's Betika market first listed within the opener window? */
  isOpener(o, now = Date.now()) {
    const t = o.betikaRef ? this.firstSeen.get(`${o.betikaRef.parentMatchId}|${oppMarketKey(o)}`) : null;
    return t != null && now - t <= this.s.openersWindowMinutes * 60_000;
  }
}
