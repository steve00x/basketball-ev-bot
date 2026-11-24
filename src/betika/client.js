// Puppeteer driver for Betika: login and bet placement on the match page.
// Odds are read from Betika's JSON API instead (see api.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SELECTORS = path.join(HERE, 'selectors.json');
export const loadSelectors = (file) => JSON.parse(fs.readFileSync(file || DEFAULT_SELECTORS, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (t) => { const n = parseFloat(String(t ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const SECRET_KEYS = /token|password|pass|auth|session|pin/i;
// stricter, for anything printed to the screen: no account ids or contact details either
const PRINT_SECRET_KEYS = /token|password|pass|auth|session|pin|profile|msisdn|phone|mobile|user_?id|customer|email|account/i;
const redactForPrint = (v) => (Array.isArray(v) ? v.map(redactForPrint) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, PRINT_SECRET_KEYS.test(k) ? '[redacted]' : redactForPrint(x)])) : v);

export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : redact(x)]));
  }
  return v;
}

const money = (re, s) => { const m = re.exec(s); return m ? Number(m[1].replace(/,/g, '')) : null; };

/**
 * Decide what Betika's POST /v2/bet reply means. Anything unclear is 'unknown' (the bot halts).
 * A real accepted reply (2026-11-23) looks like:
 *   { status_code: "201 Created", message: "LDCH8C confirmed.\nPossible win Ksh22.20 from Ksh10.00 stake.\n
 *     New Betika balance Ksh1243.79 ...", params: { bet_id: 6691062283, short_bet_id: "LDCH8C" } }
 */
export function classifyBetResponse(httpStatus, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const obj = body && typeof body === 'object' ? body : {};
  const msg = String(obj.message ?? obj.error?.message ?? obj.error ?? '');
  const code = parseInt(String(obj.status_code ?? ''), 10); // "201 Created" -> 201
  const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);

  if (httpStatus >= 400 || code >= 400 || obj.success === false || obj.error
      || /insufficient|invalid|failed|not allowed|rejected|suspended|expired|error/i.test(msg)) {
    return { status: 'rejected', message: short(msg || text) };
  }
  const betId = obj.params?.short_bet_id ?? obj.params?.bet_id ?? null;
  const confirmed = /\bconfirmed\b/i.test(msg) || betId !== null || obj.success === true;
  if (confirmed && (Number.isNaN(code) || (code >= 200 && code < 300))) {
    return {
      status: 'placed',
      message: short(msg || 'placed'),
      betId: obj.params?.short_bet_id ?? null,
      betIdLong: obj.params?.bet_id ?? null,
      possibleWin: money(/possible win\s*ksh\s*([\d,]+(?:\.\d+)?)/i, msg),
      confirmedStake: money(/from\s*ksh\s*([\d,]+(?:\.\d+)?)\s*stake/i, msg),
      balanceAfter: money(/balance\s*ksh\s*([\d,]+(?:\.\d+)?)/i, msg),
    };
  }
  return { status: 'unknown', message: short(text) };
}

export class BetikaClient {
  constructor({ headless = true, sessionDir = '.betika-session', chromePath = '', selectorsFile = '',
    phone = '', password = '', proxy = '', betResponseTimeoutMs = 20000, log = console } = {}) {
    Object.assign(this, { headless, sessionDir, chromePath, phone, password, proxy, betResponseTimeoutMs, log });
    this.sel = loadSelectors(selectorsFile);
    this.browser = null;
    this.page = null;
  }

  async start() {
    if (this.page) return this.page;
    this.browser = await puppeteer.launch({
      headless: this.headless,
      userDataDir: this.sessionDir, // keeps you logged in between runs
      executablePath: this.chromePath || undefined,
      defaultViewport: { width: 1366, height: 1000 },
      args: ['--no-sandbox', ...(this.proxy ? [`--proxy-server=${this.proxy}`] : [])],
    });
    const [page] = await this.browser.pages();
    this.page = page ?? (await this.browser.newPage());
    this.page.setDefaultTimeout(20000);
    // A native dialog freezes the page (and every evaluate) until it's answered.
    // Betika's "Remove All" asks "Are you sure you want to clear the betslip?": accept only that one.
    // "beforeunload" is the browser's "Leave site?" prompt (Betika shows it while the slip has
    // a selection). It only asks to continue navigating, so accept it - dismissing cancels the
    // navigation and page.goto fails with net::ERR_ABORTED.
    this.page.on('dialog', async (d) => {
      const ok = d.type() === 'beforeunload'
        || (d.type() === 'confirm' && new RegExp(this.sel.clearSlipConfirm ?? 'clear the betslip', 'i').test(d.message()));
      this.log[ok ? 'info' : 'warn']?.(`betika: ${ok ? 'accepted' : 'dismissed'} ${d.type()} "${d.message()}"`);
      await (ok ? d.accept() : d.dismiss()).catch(() => {});
    });
    return this.page;
  }

  async close() {
    // If you already closed the window, closing again makes Windows print
    // "process could not be terminated" errors, so skip it.
    if (this.browser?.connected) await this.browser.close().catch(() => {});
    this.browser = this.page = null;
  }

  /**
   * Load a page and wait until Betika's app has rendered (`readySelector`).
   * Betika keeps live connections open, so "network idle" is not a usable signal.
   * Fails fast with a clear error after one retry instead of hanging.
   */
  async goto(url, readySelector = this.sel.appReady, { timeoutMs = 30000, attempts = 2 } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e) => {
          // Betika's app sometimes swaps the URL itself mid-load, which Chrome reports as an
          // aborted navigation. The page is still fine, so keep waiting for it to render.
          if (!/ERR_ABORTED|frame was detached/i.test(e.message)) throw e;
          this.log.warn?.(`betika: navigation to ${url} was interrupted, waiting for the page anyway`);
        });
        await this.page.waitForSelector(readySelector, { timeout: timeoutMs });
        await sleep(1500); // let the header settle into logged-in / logged-out state
        return;
      } catch (e) {
        lastErr = e;
        this.log.warn?.(`betika: ${url} not ready (attempt ${i}/${attempts}): ${e.message.split('\n')[0]}`);
      }
    }
    throw new Error(`Betika page did not load: ${url} (${lastErr.message.split('\n')[0]})`);
  }

  async isLoggedIn() {
    return !(await this.page.$(this.sel.login.loggedOutMarker));
  }

  /** Log in if needed. `waitMs` leaves time to solve an OTP/captcha in a visible browser. */
  async ensureLoggedIn({ waitMs = 30000 } = {}) {
    await this.start();
    await this.goto(this.sel.urls.home);
    if (await this.isLoggedIn()) return true;
    if (!this.phone || !this.password) throw new Error('not logged in and BETIKA_PHONE / BETIKA_PASSWORD not set');
    const L = this.sel.login;
    await this.goto(this.sel.urls.login, L.phone);
    await this.page.type(L.phone, this.phone, { delay: 40 });
    await this.page.type(L.password, this.password, { delay: 40 });
    const remember = await this.page.$(`${L.remember} input[type=checkbox]`);
    if (remember && !(await remember.evaluate((n) => n.checked))) await (await this.page.$(L.remember)).click();
    await this.page.click(L.submit);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (!this.page.url().includes('/login') && (await this.isLoggedIn())) {
        this.log.info?.('betika: logged in');
        return true;
      }
    }
    throw new Error('betika login did not complete (wrong password, OTP or captcha?)');
  }

  async balance() {
    const el = await this.page.$(this.sel.unverified_balance);
    return el ? toNum(await el.evaluate((n) => n.textContent)) : null;
  }

  async slipCount() {
    return (await this.page.$$(this.sel.betslip.selection)).length;
  }

  async clearBetslip() {
    for (let i = 0; i < 3 && (await this.slipCount()); i++) {
      const btn = await this.page.$(this.sel.betslip.removeAll);
      if (!btn) break;
      await btn.evaluate((b) => b.click());
      await sleep(800);
    }
    return (await this.slipCount()) === 0;
  }

  /** Read one outcome on the match page: { odds } or null. Clicks it if click=true. */
  async outcome(market, label, { click = false } = {}) {
    return this.page.evaluate((M, market, label, click) => {
      const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const mk = [...document.querySelectorAll(M.market)]
        .find((m) => norm(m.querySelector(M.marketTitle)?.textContent) === norm(market));
      if (!mk) return { error: 'market_not_found' };
      const btn = [...mk.querySelectorAll(M.outcome)]
        .find((b) => norm(b.querySelector(M.outcomeLabel)?.textContent) === norm(label));
      if (!btn) return { error: 'outcome_not_found' };
      if (btn.disabled || /disabled|locked|suspended/.test(btn.className)) return { error: 'outcome_suspended' };
      const odds = parseFloat(btn.querySelector(M.outcomeOdds)?.textContent);
      if (click) btn.click();
      return { odds };
    }, this.sel.match, market, label, click);
  }

  /**
   * Place one bet from the match page.
   * bet = { parentMatchId, market, label, minOdds, minEffectiveOdds, stake, live }
   *   market/label: e.g. 'Winner (Incl. Overtime)' / '1', or 'Total (Incl. Overtime)' / 'Over 228.5'
   *   minOdds: lowest posted price accepted
   *   minEffectiveOdds: lowest (Final Payout / stake) accepted, i.e. after Betika's tax deductions
   * With live=false it fills the slip and checks everything, but never clicks Place Bet.
   */
  async placeBet({ parentMatchId, liveMatchId, market, label, minOdds, minEffectiveOdds = 0, stake, live = false }) {
    const page = await this.start();
    const B = this.sel.betslip;
    // In-play bets go through Betika's live match page (/live/m/{live match id})
    const matchUrl = liveMatchId ? this.sel.urls.liveMatch.replace('{liveMatchId}', liveMatchId)
      : this.sel.urls.match.replace('{parentMatchId}', parentMatchId);
    try {
      await this.goto(matchUrl, `${this.sel.appReady} , ${this.sel.match.market}`);
      await page.waitForSelector(this.sel.match.market, { timeout: 10000 });
    } catch (e) {
      return { status: 'match_unavailable', message: e.message.split('\n')[0] };
    }
    if (live && !(await this.isLoggedIn())) {
      // e.g. after a browser restart: log back in once, then reopen the match page
      if (!this.phone || !this.password) return { status: 'not_logged_in' };
      try {
        await this.ensureLoggedIn();
        await this.goto(matchUrl, this.sel.match.market);
      } catch (e) {
        return { status: 'not_logged_in', message: e.message.split('\n')[0] };
      }
      if (!(await this.isLoggedIn())) return { status: 'not_logged_in' };
    }

    const seen = await this.outcome(market, label);
    if (seen.error) return { status: seen.error };
    if (!(seen.odds >= minOdds)) return { status: 'price_moved', odds: seen.odds, minOdds };

    const bal = await this.balance();
    if (live && bal !== null && bal < stake) return { status: 'insufficient_balance', balance: bal, odds: seen.odds };

    if (!(await this.clearBetslip())) return { status: 'betslip_not_empty', odds: seen.odds };
    await this.outcome(market, label, { click: true });
    await page.waitForSelector(B.selection, { timeout: 10000 }).catch(() => {});
    if ((await this.slipCount()) !== 1) return { status: 'betslip_not_single', odds: seen.odds };
    const slip = await page.$eval(B.selection, (n, B) => ({
      market: n.querySelector(B.selectionMarket)?.textContent.replace(/\s+/g, ' ').trim() ?? '',
      odds: parseFloat(n.querySelector(B.selectionOdds)?.textContent),
    }), B);
    if (!slip.market.toLowerCase().includes(market.toLowerCase())) return { status: 'wrong_selection', slip };
    if (!(slip.odds >= minOdds)) return { status: 'price_moved', odds: slip.odds, minOdds };

    // Stake: clear with the native setter so Vue sees it, type, then read it back.
    const input = await page.waitForSelector(B.stake);
    await input.evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      el.focus(); set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await input.type(String(stake), { delay: 30 });
    await sleep(600);
    const typed = toNum(await input.evaluate((el) => el.value));
    const btn = await page.$(B.place);
    if (!btn) return { status: 'no_place_button', odds: slip.odds };
    const attrs = await btn.evaluate((b) => ({ amount: b.getAttribute('amount'), totalodds: b.getAttribute('totalodds') }));
    if (typed !== stake || (attrs.amount !== null && toNum(attrs.amount) !== stake)) {
      return { status: 'stake_mismatch', stake, typed, buttonAmount: attrs.amount };
    }
    const odds = attrs.totalodds !== null ? toNum(attrs.totalodds) : slip.odds;
    if (!(odds >= minOdds)) return { status: 'price_moved', odds, minOdds };

    // Final Payout already has Betika's tax deductions in it, so it's the real return.
    const payout = toNum(await page.$eval(B.finalPayout, (n) => n.textContent).catch(() => null));
    const effectiveOdds = payout ? payout / stake : null;
    if (effectiveOdds !== null && effectiveOdds < minEffectiveOdds) {
      return { status: 'payout_too_low', odds, payout, effectiveOdds, minEffectiveOdds };
    }

    if (!live) return { status: 'dry_run', odds, stake, payout, effectiveOdds };

    const betApi = new RegExp(this.sel.betApi, 'i');
    const responseP = page.waitForResponse(
      // live bets are held by Betika for a few seconds before acceptance
      (r) => r.request().method() === 'POST' && betApi.test(r.url()), { timeout: this.betResponseTimeoutMs * (liveMatchId ? 2 : 1) }).catch(() => null);
    await btn.evaluate((b) => b.click());
    const res = await responseP;
    if (!res) return { status: 'unknown', odds, stake, payout, message: 'no bet API response seen' };
    let body;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ''); }
    const verdict = classifyBetResponse(res.status(), body);
    if (verdict.status === 'placed' && verdict.confirmedStake !== null && verdict.confirmedStake !== stake) {
      verdict.stakeMismatch = true; // Betika confirmed a different stake than we typed
    }
    return { ...verdict, odds, stake, payout, effectiveOdds, apiUrl: res.url(), response: redact(body) };
  }

  /**
   * Open a visible browser and save Betika API traffic (with secrets redacted) while you
   * click around. Run it once while placing a small bet by hand, then share discover/ to
   * pin down the bet API's response format.
   */
  async discover(outDir = 'discover') {
    fs.mkdirSync(outDir, { recursive: true });
    const page = await this.start();
    let n = 0;
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!/api\.betika\.com/i.test(url)) return;
        const req = res.request();
        let body = await res.text();
        try { body = JSON.parse(body); } catch { /* keep text */ }
        let sent = req.postData() ?? null;
        try { sent = sent && JSON.parse(sent); } catch { /* keep text */ }
        const u = new URL(url);
        for (const k of [...u.searchParams.keys()]) if (SECRET_KEYS.test(k)) u.searchParams.set(k, 'redacted');
        const name = `${String(++n).padStart(3, '0')}-${req.method()}-${u.pathname.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.json`;
        fs.writeFileSync(path.join(outDir, name), JSON.stringify(
          { url: u.href, method: req.method(), status: res.status(), request: redact(sent), response: redact(body) }, null, 2));
        if (req.method() !== 'GET') this.log.info?.(`saved ${name}`);
      } catch { /* bodies can vanish on navigation */ }
    });
    await this.goto(this.sel.urls.home);
    this.log.info?.(`recording Betika API calls to ${outDir}/ - log in, place a small bet by hand, then close the browser`);
    await new Promise((r) => this.browser.on('disconnected', r));
  }

  /**
   * Open "My Bets" in the logged-in browser and return the JSON Betika loads there (read-only).
   * Also clicks a "Settled"/"All" tab if the page has one, to include finished bets.
   */
  async betHistory({ waitMs = 6000, maxPages = 5 } = {}) {
    const page = await this.start();
    if (!(await this.isLoggedIn().catch(() => false))) await this.ensureLoggedIn();
    const bodies = [];
    this.lastHistoryCalls = []; // API paths My Bets called (no query values), to see where bets come from
    this.lastHistoryFilters = [];
    const onResponse = async (res) => {
      try {
        const host = new URL(res.url()).hostname;
        if (!host.endsWith('betika.com') || ['www.betika.com', 'cdn.betika.com', 'media.betika.com'].includes(host)) return;
        if (/\/uo\/(matches|sport|totalMatches)|\/v1\/sports/.test(res.url())) return; // odds lists, not bets
        const u = new URL(res.url());
        this.lastHistoryCalls.push(`${res.request().method()} ${res.status()} ${u.host}${u.pathname}`);
        // account/feature/IP services are not bet data (and may hold personal details): never read
        if (/^(userinfo|ip|ke-experiment-service)\./.test(host)) return;
        if (replaying && /\/uo\/bethistory/.test(res.url())) return;
        const ct = res.headers()['content-type'] ?? '';
        if (ct.includes('json')) bodies.push(await res.json());
        // remember the page's own history request so later pages can be asked for the same way
        if (/\/uo\/bethistory/.test(res.url()) && res.request().method() === 'POST') {
          historyRequest = { url: res.url(), body: res.request().postData(), headers: res.request().headers() };
          // the filters the page asked for (secrets removed), to learn how settled bets are requested
          let sent = null;
          try { sent = JSON.parse(res.request().postData() ?? 'null'); } catch { /* not JSON */ }
          if (sent && typeof sent === 'object') this.lastHistoryFilters.push(redactForPrint(sent));
        }
      } catch { /* body gone after navigation */ }
    };
    let historyRequest = null;
    let replaying = false;
    page.on('response', onResponse);
    try {
      // My Bets has no bet slip panel, so don't wait for the usual page-ready marker: load it and
      // give Betika time to fetch the bets (we read its data, not the page).
      await page.goto(this.sel.urls.myBets ?? 'https://www.betika.com/en-ke/mybets', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch((e) => { if (!/ERR_ABORTED|detached/i.test(e.message)) throw e; });
      await sleep(waitMs * 1.5);
      if (/\/login/.test(page.url())) throw new Error('Betika sent My Bets to the login page - run `node bin/ev-bot.js login` again');
      // The page asks for period "ACTIVE" (open bets). Betika's reply lists its other periods
      // (meta.periods: { title, filter }); ask for each the same way to get settled bets too.
      let body;
      try { body = JSON.parse(historyRequest?.body ?? 'null'); } catch { body = null; }
      const periods = bodies.find((b) => Array.isArray(b?.bets))?.meta?.periods ?? [];
      this.lastHistoryPeriods = periods.map((p) => `${p.title} = ${p.filter}`);
      if (historyRequest && body) {
        replaying = true; // these replies are added here, not by the listener
        try {
          for (const p of periods) {
            if (!p?.filter || String(p.filter) === String(body.period)) continue;
            for (let pg = 1; pg <= maxPages; pg++) {
              const next = await page.evaluate(async (r, b) => {
                const h = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !/^(content-length|host|origin|referer|cookie)$/i.test(k)));
                const res = await fetch(r.url, { method: 'POST', headers: h, body: JSON.stringify(b), credentials: 'include' });
                return res.ok ? res.json() : null;
              }, historyRequest, { ...body, period: p.filter, page: String(pg) }).catch(() => null);
              if (!next?.bets?.length) break;
              bodies.push(next);
              if (next.bets.length < Number(next.limit ?? Infinity)) break;
            }
          }
        } finally { replaying = false; }
      }
    } finally {
      page.off('response', onResponse);
    }
    return bodies;
  }
}
