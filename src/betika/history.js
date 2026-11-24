// Read Betika's "My Bets" data (what www.betika.com/en-ke/mybets loads when logged in) and match it
// to our bets by ticket number. Read-only; never affects betting.
//
// The exact response format hasn't been seen yet, so this reads it defensively: it looks for objects
// carrying one of our ticket numbers and picks status and amounts from field names. Anything unclear
// is left as 'unknown' rather than guessed. `historyShape` reports field names (no values) so the
// format can be confirmed and these rules tightened.

const STATUS_KEYS = /^(status|bet_status|result|outcome|state|bet_state|status_desc|status_name|bet_result)$/i;
const PAYOUT_KEYS = /^(net_win|net_winning|net_payout|payout|amount_won|won_amount|winning_amount|winnings|win_amount|possible_win_after_tax|final_payout)$/i;
const ID_KEYS = /^(short_bet_id|bet_id|betid|ticket_id|share_code|code|id)$/i;

/** Map Betika's status text/number to won | lost | void | pending | unknown. */
export function normalizeStatus(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return 'unknown';
  if (/^(won|win|winner|winning|settled_won|paid)$/.test(t) || /\bwon\b/.test(t)) return 'won';
  if (/^(lost|lose|loss|loser|settled_lost)$/.test(t) || /\blost\b/.test(t)) return 'lost';
  if (/cancel|void|refund|reject|rollback/.test(t)) return 'void';
  if (/pending|open|running|active|unsettled|placed|accepted/.test(t)) return 'pending';
  return 'unknown';
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };

/** Walk any JSON and yield every plain object. */
function* objects(v) {
  if (Array.isArray(v)) for (const x of v) yield* objects(x);
  else if (v && typeof v === 'object') { yield v; for (const x of Object.values(v)) yield* objects(x); }
}

/**
 * From captured responses, find Betika's record for each of our tickets.
 * tickets: [{ short: 'LDCH8C', long: 6691062283 }]. Returns Map short -> { status, payout, raw }.
 */
export function matchHistory(responses, tickets) {
  const want = new Map();
  for (const t of tickets) {
    if (t.short) want.set(String(t.short).toUpperCase(), t.short);
    if (t.long != null) want.set(String(t.long), t.short);
  }
  const found = new Map();
  for (const body of responses) {
    for (const o of objects(body)) {
      let short = null;
      for (const [k, v] of Object.entries(o)) {
        if (ID_KEYS.test(k) && want.has(String(v).toUpperCase())) { short = want.get(String(v).toUpperCase()); break; }
      }
      if (!short || found.has(short)) continue;
      found.set(short, readBet(o));
    }
  }
  return found;
}

/**
 * One bet from Betika's /v1/uo/bethistory (seen: short_bet_id, bet_id, bet_amount, possible_win,
 * status, betStatus { text }, wht_* / tax_amount). betStatus.text is what Betika's own app shows,
 * so it comes first; then the plain status field. A won bet pays possible_win minus withholding tax.
 */
export function readBet(o) {
  const statusKey = Object.keys(o).find((k) => STATUS_KEYS.test(k));
  const text = o.betStatus?.text ?? (statusKey ? o[statusKey] : null);
  let status = normalizeStatus(o.betStatus?.text);
  if (status === 'unknown') status = normalizeStatus(statusKey ? o[statusKey] : '');
  let payout = null;
  if (o.possible_win != null) {
    const whtKey = Object.keys(o).find((k) => /^wht/i.test(k) && num(o[k]) != null);
    const tax = whtKey ? num(o[whtKey]) : num(o.tax_amount);
    payout = num(o.possible_win) - (tax ?? 0);
  } else {
    const payoutKey = Object.keys(o).find((k) => PAYOUT_KEYS.test(k));
    payout = payoutKey ? num(o[payoutKey]) : null;
  }
  return { status, statusText: text == null ? null : String(text), payout: payout == null ? null : Math.round(payout * 100) / 100,
    fields: { status: o.betStatus?.text != null ? 'betStatus.text' : statusKey ?? null } };
}

/** Distinct status words Betika uses (e.g. "Won", "Pending") with counts: no ids, no amounts. */
export function statusWords(bodies) {
  const count = new Map();
  for (const body of bodies) {
    for (const o of objects(body)) {
      if (!('short_bet_id' in o || 'bet_id' in o)) continue;
      const k = `status=${JSON.stringify(o.status ?? null)} betStatus.text=${JSON.stringify(o.betStatus?.text ?? null)} -> ${readBet(o).status}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return [...count].map(([k, n]) => `${n} x ${k}`);
}

/** Field names and types only (no values), to confirm the format without sharing personal data. */
export function historyShape(v, depth = 0, seen = new Set()) {
  if (Array.isArray(v)) return v.length ? [historyShape(v[0], depth + 1, seen)] : [];
  if (v && typeof v === 'object') {
    if (depth > 5) return '{...}';
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, historyShape(x, depth + 1, seen)]));
  }
  return v === null ? 'null' : typeof v;
}

/**
 * Apply Betika's answers to our bet log. Betika's word is final for status and payout; our own
 * score-based result is kept as `result` and any disagreement is flagged for a manual look.
 */
export function applyHistory(bets, found, now = new Date()) {
  let updated = 0;
  for (const b of bets) {
    const h = b.betId ? found.get(b.betId) : null;
    if (!h || h.status === 'unknown' || h.status === 'pending') continue;
    const stake = b.stake ?? 0;
    const betikaProfit = h.status === 'won' && h.payout != null ? Math.round((h.payout - stake) * 100) / 100
      : h.status === 'lost' ? -stake : h.status === 'void' ? 0 : null;
    if (b.betikaStatus === h.status && b.betikaPayout === h.payout) continue;
    Object.assign(b, { betikaStatus: h.status, betikaStatusText: h.statusText, betikaPayout: h.payout, betikaProfit, betikaCheckedAt: now.toISOString() });
    const ours = b.result === 'push' ? 'void' : b.result;
    b.mismatch = !!(ours && ['won', 'lost', 'void'].includes(ours) && ours !== h.status);
    updated++;
  }
  return updated;
}
