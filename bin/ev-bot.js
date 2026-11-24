#!/usr/bin/env node
// CLI: ev-bot <scan|check|login|odds|balance|discover> [options]
import { parseArgs } from 'node:util';
import { BetikaAPI } from '../src/betika/api.js';
import { BetikaClient } from '../src/betika/client.js';
import { BetikaExecutor } from '../src/betika/executor.js';
import { DemoBetikaFeed, DemoBetikaPlacer, activeKeysFor, fetchEvents, fetchLiveEvents, loadDemoEvents, marketsFor, nextScanPlan, resolveKeys, runCycle } from '../src/bot.js';
import { SPORTS, sportGroup } from '../src/sports.js';
import { SettingsError, parseNumber, settingsFromEnv, validateSettings } from '../src/config.js';
import { Notifier } from '../src/notifier.js';
import { OddsAPI, OddsAPIError } from '../src/oddsApi.js';
import { Store, acquireLock } from '../src/store.js';
import { botState, startDashboard, summarizeOpps } from '../src/dashboard.js';
import { settlePending } from '../src/settle.js';
import { applyHistory, historyShape, matchHistory, statusWords } from '../src/betika/history.js';
import { OddsPapi, OddsPapiError, mergeEvents, summarizeAccount } from '../src/oddsPapi.js';
import { teamSimilarity } from '../src/teamMatch.js';

const HELP = `Usage: ev-bot <command> [options]

Commands:
  scan        find +EV bets and bet on Betika if BETIKA_ENABLED=true      [default]
  check       real-site self-test: fills a Betika bet slip (never places it)
  sports      which of your SPORTS have Pinnacle prices now, Betika counts, credit cost
  oddspapi    check your OddsPapi key: quota, leagues and the Pinnacle markets it returns
  dashboard   open the dashboard on your bet log without scanning (scan also serves it)
  settle      grade finished bets from final scores now and print profit and loss
  history     read Betika's My Bets: record Betika's status and payout on your placed bets
  leagues S [text]  list OddsPapi league ids for sport S, e.g. leagues basketball euroleague
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
let s;
try {
  s = settingsFromEnv(opt.env);
  if (opt['min-ev'] !== undefined) s = validateSettings({ ...s, minEv: parseNumber(opt['min-ev'], '--min-ev') });
} catch (e) {
  if (!(e instanceof SettingsError)) throw e;
  console.error(`Settings problem: ${e.message}`);
  process.exit(1);
}
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
  log.info(`scanning ${s.sports.join(',')} | sharp=${s.sharpBooks.join(',')} | min EV ${(s.minEv * 100).toFixed(1)}% | devig=${s.devigMethod}`
    + ` | alt totals ${s.altTotals ? `on (min ${(s.altTotalsMinEv * 100).toFixed(1)}%)` : 'off'}`
    + ` | live betting ${s.liveBetting ? `${s.liveBetsLive && s.betikaLive ? 'REAL' : 'dry run'} (${s.liveSports.join('/')}, every ${s.livePollSeconds}s, min ${(Math.max(s.liveMinEv, s.minEv) * 100).toFixed(1)}%)` : 'off'}`
    + ` | fast scans ${s.fastScanMinutes > 0 ? `every ${Math.round(s.fastPollSeconds / 60)} min within ${s.fastScanMinutes} min of ${s.fastScanSports.join('/')} games` : 'off'}`);
  try {
    if (s.dashboard) startDashboard({ store, s, port: s.dashboardPort, log });
    Object.assign(botState.mode, { betikaLive: s.betikaLive, liveBetting: s.liveBetting, liveBetsLive: s.liveBetsLive,
      minEv: s.minEv, tax: s.winningsTax.betika, sports: s.sports });
    const track = (r, k) => {
      if (!r) return;
      botState.scans++;
      botState.lastScan = { at: new Date().toISOString(), kind: k, found: r.found };
      botState.opportunities = summarizeOpps(r.all ?? []);
      botState.closest = r.closest;
      botState.credits = api.requestsRemaining;
    };
    let papi = null, lastPapi = 0;
    if (s.oddsPapiKey) {
      papi = new OddsPapi(s.oddsPapiKey, { cachePath: s.oddsPapiCachePath, log });
      log.info(`oddspapi: on - used when The Odds API finds fewer than ${s.oddsPapiWhenFewerThan} +EV bets, at most every ${s.oddsPapiMinIntervalMinutes} min`);
    }
    const fastGroups = s.fastScanSports;
    let lastFull = 0;
    let lastLive = 0, liveActive = false;
    let lastSettle = 0;
    let upcoming = []; // start times of fast-sport games, for pre-start fast scans
    let kind = 'full';
    while (!stopping) {
      try {
        let events;
        if (kind === 'full') {
          events = await fetchEvents(api, s, log);
          lastFull = Date.now();
          upcoming = events.filter((e) => fastGroups.includes(sportGroup(e.sport_key ?? ''))).map((e) => +new Date(e.commence_time));
        } else if (kind === 'live') {
          events = await fetchLiveEvents(api, s, log);
          lastLive = Date.now();
          liveActive = events.length > 0;
          if (liveActive) track(await runCycle({ events, s, store, notifier, betika: feed, executor, log, live: true }), 'live');
          else botState.credits = api.requestsRemaining;
          events = null;
        } else {
          log.info(`fast scan: ${fastGroups.join(', ')} games starting within ${s.fastScanMinutes} min`);
          events = await fetchEvents(api, s, log, { onlyGroups: fastGroups, horizonHours: s.fastScanMinutes / 60, quietKeys: true });
        }
        const r = events ? await runCycle({ events, s, store, notifier, betika: feed, executor, log }) : { found: Infinity };
        if (events) track(r, kind);
        // Second source: only when The Odds API found too few bets, and not more often than
        // ODDSPAPI_MIN_INTERVAL_MINUTES (OddsPapi's free plan is 250 requests a month).
        if (papi && kind === 'full' && r.found < s.oddsPapiWhenFewerThan && !papi.quotaGone
            && Date.now() - lastPapi >= s.oddsPapiMinIntervalMinutes * 60_000) {
          lastPapi = Date.now();
          try {
            log.info(`oddspapi: The Odds API found ${r.found} +EV (< ${s.oddsPapiWhenFewerThan}), adding Pinnacle's extra lines from OddsPapi`);
            const extra = await papi.fetchEvents(s, sportGroupsOf(s.sports));
            const m = mergeEvents(events, extra, { similarity: teamSimilarity, groupOf: (k) => sportGroup(k) });
            log.info(`oddspapi: ${m.joined} games got extra Pinnacle lines, ${m.added} new games`);
            track(await runCycle({ events: m.events, s, store, notifier, betika: feed, executor, log }), 'full + oddspapi');
            botState.oddsPapi = { requestsUsedThisRun: papi.requestsUsed };
          } catch (e) {
            log.warn(`oddspapi: ${e instanceof OddsPapiError ? e.message : (e.stack ?? e)}`);
          }
        }
      } catch (e) {
        log.error(`cycle failed: ${e.stack ?? e}`);
      }
      // Grade finished bets from final scores (about 2 credits per sport with unsettled bets)
      if (s.settle && Date.now() - lastSettle >= s.settleIntervalMinutes * 60_000) {
        lastSettle = Date.now();
        try { await settlePending(api, store, log); } catch (e) { log.warn(`settle: ${e.message}`); }
        // Betika's own record of placed bets (status and payout), read from My Bets
        if (client && s.betikaLive && s.betikaHistory) {
          try { await checkBetikaHistory(client, store, log); } catch (e) { log.warn(`betika history: ${e.message.split('\n')[0]}`); }
        }
      }
      if (opt.once) break; // keep scanning even if betting is halted, so alerts keep coming
      const plan = nextScanPlan({ now: Date.now(), lastFull, s, upcoming });
      if (s.liveBetting) {
        // games in progress: every LIVE_POLL_SECONDS; otherwise look again every LIVE_IDLE_CHECK_SECONDS
        const liveDue = lastLive + (liveActive ? s.livePollSeconds : s.liveIdleCheckSeconds) * 1000;
        const liveWait = Math.max(0, liveDue - Date.now());
        if (liveWait < plan.waitMs) Object.assign(plan, { kind: 'live', waitMs: liveWait });
      }
      kind = plan.kind;
      botState.nextScan = { kind: plan.kind, at: new Date(Date.now() + plan.waitMs).toISOString() };
      if (plan.waitMs >= 60_000) log.info(`next ${plan.kind} scan in ${Math.round(plan.waitMs / 60_000)} min`);
      for (let t = 0; t < plan.waitMs / 1000 && !stopping; t++) await sleep(1000);
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

/** Read Betika's My Bets and record its status/payout on our placed bets. Returns the raw bodies. */
async function checkBetikaHistory(client, store, log) {
  const open = store.data.bets.filter((b) => b.live && b.status === 'placed' && b.betId && !['won', 'lost', 'void'].includes(b.betikaStatus));
  if (!open.length) return [];
  const bodies = await client.betHistory({ want: open.map((b) => b.betId) });
  const found = matchHistory(bodies, open.map((b) => ({ short: b.betId, long: b.betIdLong })));
  const n = applyHistory(store.data.bets, found);
  if (n) store.save();
  const bad = store.data.bets.filter((b) => b.mismatch);
  log.info(`betika history: ${found.size} of ${open.length} open tickets found, ${n} updated`
    + (bad.length ? ` | CHECK: Betika and final score disagree on ${bad.map((b) => b.betId).join(', ')}` : ''));
  return bodies;
}

/** Sport groups ("soccer", "basketball", ...) named or implied by SPORTS. */
const sportGroupsOf = (entries) => [...new Set(entries.map((e) => e.toLowerCase())
  .map((e) => (SPORTS[e] ? e : e.startsWith('soccer') ? 'soccer' : sportGroup(e))).filter(Boolean))];

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

  // Checks OddsPapi with your key: quota, sports, chosen leagues, and one odds request.
  oddspapi: async () => {
    if (!s.oddsPapiKey) { log.error('set ODDSPAPI_KEY in .env first'); return 1; }
    const papi = new OddsPapi(s.oddsPapiKey, { cachePath: s.oddsPapiCachePath, log });
    let acc;
    try { acc = await papi.account(); } catch (e) {
      if (!(e instanceof OddsPapiError)) throw e;
      log.error(`oddspapi: ${e.message}${e.code === 'INVALID_API_KEY' ? ' - check ODDSPAPI_KEY in .env' : ''}`);
      return 1;
    }
    console.log(`account: ${summarizeAccount(acc)}`); // never the raw response: it holds your key and email
    const groups = sportGroupsOf(s.sports);
    const bySport = await papi.sportGroups(groups);
    console.log(`sports: ${Object.entries(bySport).map(([id, g]) => `${g}=${id}`).join(', ') || 'none of your SPORTS found'}`);
    const events = await papi.fetchEvents(s, groups);
    console.log('leagues (put ids in ODDSPAPI_TOURNAMENTS to choose them yourself):');
    for (const l of papi.lastLeagues ?? []) console.log(`  ${String(l.id).padStart(6)}  ${l.group.padEnd(11)} ${l.country}: ${l.name}`);
    const count = (e, key) => e.bookmakers[0].markets.find((m) => m.key === key)?.outcomes.length ?? 0;
    for (const e of events.slice(0, 15)) {
      console.log(`${e.commence_time.slice(0, 16)}  ${e.sport_key.padEnd(24)} ${`${e.home_team} v ${e.away_team}`.padEnd(46)}`
        + ` h2h ${count(e, 'h2h')}  totals ${count(e, 'totals')}  team totals ${count(e, 'team_totals')}`);
    }
    console.log(`${events.length} events | OddsPapi requests used by this check: ${papi.requestsUsed}`);
    return events.length ? 0 : 1;
  },

  // Read Betika's My Bets once: update our bets, and print the data's shape (field names only)
  history: async () => {
    const store = new Store(s.storePath, { log });
    return withBrowser(async (c) => {
      try {
        await c.ensureLoggedIn();
        const bodies = await checkBetikaHistory(c, store, log);
        const all = bodies?.length ? bodies : await c.betHistory();
        console.log(`Betika API calls made by My Bets (paths only):\n  ${[...new Set(c.lastHistoryCalls ?? [])].join('\n  ') || 'none'}`);
        console.log(`Periods Betika offers (all requested): ${(c.lastHistoryPeriods ?? []).join(' | ') || 'none listed'}`);
        console.log(`Period requests: ${(c.lastHistoryReplays ?? []).join(' | ') || 'none'}`);
        console.log(`Filters My Bets sent (secrets removed):\n  ${(c.lastHistoryFilters ?? []).map((f) => JSON.stringify(f)).join('\n  ') || 'none'}`);
        console.log(`Status words Betika used (and how the bot reads them):\n  ${statusWords(all).join('\n  ') || 'none'}`);
        const settledHere = store.data.bets.filter((b) => ['won', 'lost', 'void'].includes(b.betikaStatus)).length;
        console.log(`Bets with Betika's result recorded: ${settledHere}`);
        return 0;
      } catch (e) {
        log.error(`betika history: ${e.message.split('\n')[0]}`);
        return 1;
      }
    });
  },

  // Grade finished bets now from final scores and print the totals.
  settle: async () => {
    let api;
    try { api = new OddsAPI(s.apiKey); } catch (e) { log.error(e.message); return 1; }
    const store = new Store(s.storePath, { log });
    const r = await settlePending(api, store, log);
    const { resultsSummary } = await import('../src/settle.js');
    const t = resultsSummary(store.data.bets);
    for (const [name, x] of [['Real bets', t.real], ['Dry runs', t.dryRun]]) {
      console.log(`${name}: ${x.won} won, ${x.lost} lost, ${x.push} push | staked KES ${x.staked} | profit KES ${x.profit}`
        + `${x.roi != null ? ` (ROI ${(x.roi * 100).toFixed(1)}%)` : ''} | expected KES ${x.expected} | unsettled ${x.pending}`);
    }
    log.info(`settled now: ${r.settled} | credits remaining: ${api.requestsRemaining}`);
    return 0;
  },

  // The dashboard on its own (bet history), without scanning: http://localhost:DASHBOARD_PORT
  dashboard: async () => {
    const store = new Store(s.storePath, { log });
    Object.assign(botState.mode, { betikaLive: s.betikaLive, liveBetting: s.liveBetting, liveBetsLive: s.liveBetsLive,
      minEv: s.minEv, tax: s.winningsTax.betika });
    startDashboard({ store, s, port: s.dashboardPort, log, reload: true });
    log.info('showing the saved bet log (no scanning here); it updates as a scan in another window saves bets - press Ctrl+C to stop');
    await new Promise(() => {});
  },

  // Every OddsPapi league of a sport with its id, optionally filtered by name, e.g.
  //   node bin/ev-bot.js leagues basketball euroleague
  leagues: async () => {
    if (!s.oddsPapiKey) { log.error('set ODDSPAPI_KEY in .env first'); return 1; }
    const sport = (positionals[1] ?? 'basketball').toLowerCase();
    const search = positionals.slice(2).join(' ').toLowerCase();
    const papi = new OddsPapi(s.oddsPapiKey, { cachePath: s.oddsPapiCachePath, log });
    try {
      const bySport = await papi.sportGroups([sport]);
      const sportId = Object.keys(bySport)[0];
      if (!sportId) { log.error(`OddsPapi has no sport "${sport}" - use one of: ${Object.keys(SPORTS).join(', ')}`); return 1; }
      const list = (await papi.tournaments(sportId))
        .filter((t) => !search || `${t.tournamentName} ${t.categoryName}`.toLowerCase().includes(search))
        .sort((a, b) => (b.upcomingFixtures ?? 0) - (a.upcomingFixtures ?? 0) || (b.futureFixtures ?? 0) - (a.futureFixtures ?? 0));
      for (const t of list) {
        console.log(`${String(t.tournamentId).padStart(7)}  ${`${t.categoryName}: ${t.tournamentName}`.padEnd(50)}`
          + ` upcoming ${t.upcomingFixtures ?? 0}, later ${t.futureFixtures ?? 0}`);
      }
      log.info(`${list.length} ${sport} leagues${search ? ` matching "${search}"` : ''} | OddsPapi requests used: ${papi.requestsUsed}`);
      return 0;
    } catch (e) {
      if (!(e instanceof OddsPapiError)) throw e;
      log.error(`oddspapi: ${e.message}`);
      return 1;
    }
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
