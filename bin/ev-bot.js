#!/usr/bin/env node
// CLI: ev-bot <scan|check|login|odds|balance|discover> [options]
import { parseArgs } from 'node:util';
import { BetikaAPI } from '../src/betika/api.js';
import { BetikaClient } from '../src/betika/client.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { DemoBetikaFeed, DemoBetikaPlacer, activeKeysFor, fetchEvents, loadDemoEvents, marketsFor, resolveKeys, runCycle } from '../src/bot.js';
import { SPORTS, sportGroup } from '../src/sports.js';
import { settingsFromEnv } from '../src/config.js';
import { Notifier } from '../src/notifier.js';
import { OddsAPI, OddsAPIError } from '../src/oddsApi.js';
import { Store, acquireLock } from '../src/store.js';

const HELP = `Usage: ev-bot <command> [options]

Commands:
  scan        find +EV bets and bet on Betika if BETIKA_ENABLED=true      [default]
  check       real-site self-test: fills a Betika bet slip (never places it)
  sports      which of your SPORTS have Pinnacle prices now, Betika counts, credit cost
  odds [S]    print Betika's upcoming odds for sport S (default basketball)
  login       open a visible browser and log in to Betika (session is saved)
  balance     print the Betika account balance
  discover    visible browser that records Betika API calls to ./discover/

Options:
  --once      scan once and exit
  --demo      scan sample data with a fake Betika (no key, no browser)
  --live      really place bets (same as BETIKA_LIVE=true)
  --min-ev N  override MIN_EV, e.g. 0.03
  --env FILE  path to .env (default .env)
  -h, --help`;

const ts = () => new Date().toTimeString().slice(0, 8);
const log = {
  info: (m) => console.error(`${ts()} INFO  ${m}`),
  warn: (m) => console.error(`${ts()} WARN  ${m}`),
  error: (m) => console.error(`${ts()} ERROR ${m}`),
};

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    once: { type: 'boolean' }, demo: { type: 'boolean' }, live: { type: 'boolean' },
    'min-ev': { type: 'string' }, env: { type: 'string', default: '.env' }, help: { type: 'boolean', short: 'h' },
  },
});
if (opt.help) { console.log(HELP); process.exit(0); }

const cmd = positionals[0] ?? 'scan';
const s = settingsFromEnv(opt.env);
if (opt['min-ev'] !== undefined) s.minEv = Number(opt['min-ev']);
if (opt.live) s.betikaLive = true;

const makeClient = (overrides = {}) => new BetikaClient({
  headless: s.betikaHeadless, sessionDir: s.betikaSessionDir, chromePath: s.chromePath, proxy: s.betikaBrowserProxy,
  selectorsFile: s.betikaSelectors, phone: s.betikaPhone, password: s.betikaPassword, log, ...overrides,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; log.info('stopping after this cycle...'); });

async function scan() {
  const notifier = new Notifier(s);
  if (opt.demo) {
    const demo = { ...s, betikaEnabled: true, betikaLive: false, bankroll: 20000 };
    const store = new Store(':memory:');
    const feed = new DemoBetikaFeed();
    const executor = new BetikaExecutor(demo, new DemoBetikaPlacer(feed), store, { log });
    await runCycle({ events: loadDemoEvents(), s: demo, store, notifier, betika: feed, executor, log });
    return 0;
  }

  let api;
  try { api = new OddsAPI(s.apiKey); } catch (e) {
    if (e instanceof OddsAPIError) { log.error(e.message); return 1; }
    throw e;
  }
  let release;
  try { release = acquireLock(s.storePath); } catch (e) { log.error(e.message); return 1; }
  process.on('exit', release);
  const store = new Store(s.storePath, { log });
  let feed = null, client = null, executor = null;
  if (s.betikaEnabled) {
    feed = new BetikaAPI();
    client = makeClient();
    if (s.betikaLive) await client.ensureLoggedIn();
    executor = new BetikaExecutor(s, client, store, { log, notify: (t) => notifier.sendText(t) });
    log.info(`betika: ${s.betikaLive ? 'LIVE - real bets will be placed' : 'DRY RUN - bet slips are filled, never submitted'}`
      + ` | winnings tax ${(s.winningsTax.betika * 100).toFixed(0)}%`);
  }
  log.info(`scanning ${s.sports.join(',')} | sharp=${s.sharpBooks.join(',')} | min EV ${(s.minEv * 100).toFixed(1)}% | devig=${s.devigMethod}`);
  try {
    while (!stopping) {
      try {
        const events = await fetchEvents(api, s, log);
        await runCycle({ events, s, store, notifier, betika: feed, executor, log });
      } catch (e) {
        log.error(`cycle failed: ${e.stack ?? e}`);
      }
      if (opt.once) break; // keep scanning even if betting is halted, so alerts keep coming
      for (let t = 0; t < s.pollSeconds && !stopping; t++) await sleep(1000);
    }
  } finally {
    await client?.close();
    release();
  }
  return 0;
}

async function withBrowser(fn, overrides) {
  const client = makeClient(overrides);
  try { return await fn(client); } finally { await client.close(); }
}

const fmtMatch = (m) => `${m.start.toISOString().slice(0, 16).replace('T', ' ')}Z  ${m.competition.padEnd(22)} `
  + `${`${m.home} v ${m.away}`.padEnd(44)} winner ${m.winner ? (m.draw ? [m.winner[0], m.draw, m.winner[1]] : m.winner).map((o) => o.toFixed(2)).join(' / ') : '-'}`
  + `   totals ${m.totals.length ? `${m.totals[0].point}-${m.totals.at(-1).point} (${m.totals.length} lines)` : '-'}`;

const commands = {
  scan,

  sports: async () => {
    let api;
    try { api = new OddsAPI(s.apiKey); } catch (e) { log.error(e.message); return 1; }
    const keys = await resolveKeys(api, s, log);
    const groups = [...new Set(keys.map((k) => sportGroup(k)).filter(Boolean))];
    const betika = new BetikaAPI();
    console.log(`SPORTS=${s.sports.join(',')}\n`);
    for (const g of Object.keys(SPORTS)) {
      const mine = keys.filter((k) => sportGroup(k) === g);
      const wanted = s.sports.some((e) => e.toLowerCase() === g || e.toLowerCase().startsWith(g) || sportGroup(e.toLowerCase()) === g);
      if (!wanted && !mine.length) continue;
      const n = groups.includes(g) ? (await betika.matches(g).catch(() => [])).length : '-';
      console.log(`${SPORTS[g].title.padEnd(13)} Odds API leagues: ${mine.length ? mine.join(', ') : 'none in season / not covered'}`);
      console.log(`${''.padEnd(13)} Betika matches: ${n}   credits per scan: ${mine.reduce((t, k) => t + marketsFor(k, s).length, 0)}`);
      const more = activeKeysFor(g).filter((k) => !mine.includes(k) && !SPORTS[g].skipKeys?.test(k));
      if (more.length) console.log(`${''.padEnd(13)} also in season (add to SPORTS to scan): ${more.join(', ')}`);
    }
    const cost = keys.reduce((t, k) => t + marketsFor(k, s).length, 0);
    const perDay = Math.round(cost * 86400 / s.pollSeconds);
    console.log(`\nTotal: ~${cost} credits per scan, ~${perDay}/day at POLL_SECONDS=${s.pollSeconds}`
      + ` (credits remaining: ${api.requestsRemaining ?? 'unknown'})`);
    return 0;
  },

  odds: async () => {
    const sport = (positionals[1] ?? 'basketball').toLowerCase();
    if (!SPORTS[sport]) { log.error(`unknown sport "${sport}" - use one of: ${Object.keys(SPORTS).join(', ')}`); return 1; }
    const matches = await new BetikaAPI().matches(sport);
    for (const m of matches.sort((a, b) => a.start - b.start)) console.log(fmtMatch(m));
    log.info(`${matches.length} ${sport} matches, ${matches.filter((m) => m.winner).length} with a "${SPORTS[sport].h2h.title}" price`);
    return matches.length ? 0 : 1;
  },

  // Fills the slip on the real site for the next match with a winner price: proves the
  // selectors, odds reading, slip and stake handling work. Never places the bet.
  check: async () => {
    const matches = (await new BetikaAPI().basketball()).filter((m) => m.winner && m.start > new Date())
      .sort((a, b) => a.start - b.start);
    if (!matches.length) { log.error('no upcoming basketball matches with a winner market'); return 1; }
    const m = matches.find((x) => x.competition === 'NBA') ?? matches[0];
    log.info(`check: ${m.home} v ${m.away} (${m.competition}), API says ${m.winner.join(' / ')}`);
    return withBrowser(async (c) => {
      const r = await c.placeBet({ parentMatchId: m.parentMatchId, market: 'Winner (Incl. Overtime)', label: '1',
        minOdds: 1.01, minEffectiveOdds: 0, stake: Math.max(s.betikaMinStake, 10), live: false });
      console.log(JSON.stringify(r, null, 2));
      const ok = r.status === 'dry_run' && Math.abs(r.odds - m.winner[0]) < 0.2;
      log[ok ? 'info' : 'error'](ok ? 'check passed: slip filled with the right market, odds and stake'
        : `check FAILED (${r.status}) - fix src/betika/selectors.json`);
      return ok ? 0 : 1;
    });
  },

  login: () => withBrowser(async (c) => {
    log.info('complete any OTP/captcha in the browser window (3 min)...');
    await c.ensureLoggedIn({ waitMs: 180_000 });
    log.info(`logged in, balance: ${await c.balance() ?? 'unknown'} - session saved to ${s.betikaSessionDir}`);
    return 0;
  }, { headless: false }),

  balance: () => withBrowser(async (c) => {
    await c.ensureLoggedIn();
    console.log(await c.balance());
    return 0;
  }),

  discover: () => withBrowser(async (c) => { await c.discover('discover'); return 0; }, { headless: false }),
};

if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(1); }
commands[cmd]().then((code) => process.exit(code), (e) => { log.error(e.stack ?? String(e)); process.exit(1); });
