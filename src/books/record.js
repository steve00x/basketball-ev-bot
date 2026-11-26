// Record what another sportsbook's own pages load (odds lists, match pages, bet slip), so support for
// it can be built from real data. Runs Chrome on your PC as a normal visitor or logged in as you:
//   node bin/ev-bot.js record odibets      (or sportpesa, or: record qbet --url https://...)
// Browse football and basketball, open a match, add one pick to the bet slip (don't place it), then
// close the browser. Writes record-<book>/summary.txt: which data requests the site made and what
// their replies look like. Logins, tokens, phone numbers, names and account data are removed first;
// account pages (profile, balance, deposits, ...) are listed by path only, never their contents.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

export const BOOKS = {
  sportpesa: { title: 'SportPesa', home: 'https://www.ke.sportpesa.com/', domain: 'sportpesa.com' },
  odibets: { title: 'OdiBets', home: 'https://odibets.com/', domain: 'odibets.com' },
};

const SECRET_KEY = /token|password|passwd|pass$|secret|auth|session|cookie|pin$|otp|profile|msisdn|phone|mobile|user_?id|customer|e_?mail|account|first_?name|last_?name|surname|full_?name|nick|national|id_?number|dob|birth|address|ip_?addr|device/i;
const PRIVATE_PATH = /account|profile|user|wallet|balance|kyc|login|logout|auth|register|deposit|withdraw|transaction|statement|bonus|referr|notification|message|inbox|otp|verify|password/i;
const PHONE = /(?:\+?254|\b0)[17]\d{8}\b/g;
const TOKENISH = /^(eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9+/_-]{40,}={0,2})$/;

/** Remove anything personal: secret-looking keys, phone numbers, tokens. */
export function scrub(v, depth = 0) {
  if (depth > 12) return '[...]';
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : scrub(x, depth + 1)]));
  if (typeof v === 'string') return TOKENISH.test(v) ? '[redacted]' : v.replace(PHONE, '[phone]');
  return v;
}

/** A small sample of a reply: arrays cut to their first 2 items, long strings cut, about `max` characters. */
export function sample(v, max = 1800) {
  const cut = (x, d) => {
    if (d > 7) return '...';
    if (Array.isArray(x)) return x.length > 2 ? [...x.slice(0, 2).map((y) => cut(y, d + 1)), `... ${x.length} items`] : x.map((y) => cut(y, d + 1));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).slice(0, 30).map(([k, y]) => [k, cut(y, d + 1)]));
    return typeof x === 'string' && x.length > 80 ? `${x.slice(0, 80)}...` : x;
  };
  const s = JSON.stringify(cut(v, 0));
  return s.length > max ? `${s.slice(0, max)} ...[cut]` : s;
}

const sameSite = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Group recorded calls by method + host + path, newest sample kept; private paths without contents. */
export function summarize(calls, book) {
  const groups = new Map();
  for (const c of calls) {
    const u = new URL(c.url);
    const k = `${c.method} ${u.host}${u.pathname.replace(/\/\d{3,}(?=\/|$)/g, '/{id}')}`;
    if (!groups.has(k)) groups.set(k, { k, n: 0, params: new Set(), status: new Set(), calls: [] });
    const g = groups.get(k);
    g.n++; g.status.add(c.status);
    for (const [p, val] of u.searchParams) g.params.add(`${p}=${SECRET_KEY.test(p) ? '[redacted]' : val.slice(0, 40)}`);
    g.calls.push(c);
  }
  const lines = [`${book} - ${calls.length} data requests recorded, ${groups.size} different endpoints`, ''];
  for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) {
    const priv = PRIVATE_PATH.test(g.k);
    lines.push(`## ${g.k}  (x${g.n}, HTTP ${[...g.status].join('/')})`);
    if (g.params.size) lines.push(`params: ${[...g.params].slice(0, 25).join('&')}`);
    if (priv) { lines.push('(account endpoint: contents not recorded)', ''); continue; }
    const last = g.calls.at(-1);
    if (last.request != null) lines.push(`sent: ${sample(scrub(last.request), 800)}`);
    lines.push(`reply: ${sample(scrub(last.response))}`, '');
  }
  return lines.join('\n');
}

export async function recordBook({ book, url, sessionDir, chromePath, log = console }) {
  const spec = BOOKS[book] ?? (url ? { title: book, home: url, domain: new URL(url).hostname.replace(/^www\./, '') } : null);
  if (!spec) throw new Error(`unknown sportsbook "${book}" - use ${Object.keys(BOOKS).join(', ')}, or --url https://... for another one`);
  const home = url || spec.home;
  const outDir = `record-${book}`;
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ headless: false, userDataDir: sessionDir, executablePath: chromePath || undefined,
    defaultViewport: null, args: ['--no-sandbox'] });
  const [page] = await browser.pages();
  const calls = [];
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      const u = new URL(res.url());
      if (!sameSite(u.hostname, spec.domain)) return;
      if (calls.length >= 1500) return;
      const text = await res.text().catch(() => '');
      let body = text;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      let sent = req.postData() ?? null;
      try { sent = sent && JSON.parse(sent); } catch { /* keep text */ }
      for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, 'redacted');
      const priv = PRIVATE_PATH.test(u.pathname);
      calls.push({ url: u.href, method: req.method(), status: res.status(), request: priv ? null : sent, response: priv ? null : body });
    } catch { /* body gone after navigation */ }
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log.warn?.(`${spec.title}: ${e.message}`));
  log.info?.(`recording ${spec.title}: browse football and basketball, open a match, add one pick to the bet slip (do NOT place it), then close the browser window`);
  await new Promise((r) => browser.on('disconnected', r));
  const summary = summarize(calls, spec.title);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);
  log.info?.(`${calls.length} data requests recorded - send me ${outDir}${path.sep}summary.txt (personal data already removed)`);
  return { calls: calls.length, file: path.join(outDir, 'summary.txt') };
}
