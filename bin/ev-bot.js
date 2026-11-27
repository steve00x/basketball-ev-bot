#!/usr/bin/env node
// CLI: ev-bot <scan|check|login|odds|balance|discover> [options]
import { parseArgs } from 'node:util';
import { BetikaAPI } from '../src/betika/api.js';
import { BetikaClient } from '../src/betika/client.js';
import { BetikaExecutor, MultiExecutor } from '../src/betika/executor.js';
import { DemoBetikaFeed, DemoBetikaPlacer, activeKeysFor, bookPlan, fetchEvents, fetchLiveEvents, loadDemoEvents, marketsFor, nextScanPlan, resolveKeys, runCycle } from '../src/bot.js';
import { SPORTS, sportGroup } from '../src/sports.js';
import { SettingsError, accountSettings, parseNumber, settingsFromEnv, validateSettings } from '../src/config.js';
import { Notifier } from '../src/notifier.js';
import { OddsAPI, OddsAPIError } from '../src/oddsApi.js';
import { Store, acquireLock } from '../src/store.js';
import { botState, startDashboard, summarizeOpps } from '../src/dashboard.js';
import { LiveGuard, confirmLive } from '../src/liveGuard.js';
import { review, taxLines } from '../src/review.js';
import { strategyOf, strategyVerdicts } from '../src/insights.js';
import { anchoredLiveEvents, recordAnchors, runModelCycle } from '../src/inplayModel.js';
import { SteamTracker } from '../src/steam.js';
import { recordBook } from '../src/books/record.js';
import { PeriodPrices } from '../src/periods.js';
import { BetikaWatch } from '../src/openers.js';
import { SportPesaClient, SportPesaSite, attachSportPesa, sportpesaPickFor } from '../src/books/sportpesa.js';
import { OdiBetsClient, OdiBetsSite, attachOdiBets, odibetsPickFor } from '../src/books/odibets.js';
import { attachBetikaOdds } from '../src/betika/odds.js';
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
  review      bad luck or bad prices? wins vs what the fair odds predicted
  record BOOK record another sportsbook's odds requests to add it (odibets, sportpesa, or any with --url)
  periods     check Pinnacle's 1st half / quarter prices on The Odds API (a few credits)
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

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      once: { type: 'boolean' }, demo: { type: 'boolean' }, live: { type: 'boolean' }, account: { type: 'string' }, url: { type: 'string' },
      'min-ev': { type: 'string' }, env: { type: 'string', default: '.env' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}
const { values: opt, positionals } = parsed;
if (opt.help) { console.log(HELP); process.exit(0); }

const cmd = positionals[0] ?? 'scan';
let s;
try {
  s = settingsFromEnv(opt.env);
  if (opt['min-ev'] !== undefined) s = validateSettings({ ...s, minEv: parseNumber(opt['min-ev'], '--min-ev') });
} catch (e) {
  if (!(e instanceof SettingsError)) throw e;
  console.error(`Settings problem: ${e.message}`);
  process.exit(2); // 2 = fix and start again (run-forever.ps1 does not restart on it)
}
if (opt.live) s.betikaLive = true;
// --account NAME: login / balance / history / review / dashboard for another Betika account (.env.NAME)
if (opt.account && opt.account !== 'main') {
  if (cmd === 'scan') { console.error('scan runs every account in BETIKA_ACCOUNTS at once - start it without --account'); process.exit(2); }
  try { s = accountSettings(s, opt.account); } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    console.error(`Settings problem: ${e.message}`);
    process.exit(2);
  }
}

const makeClient = (overrides = {}) => new BetikaClient({
  headless: s.betikaHeadless, sessionDir: s.betikaSessionDir, chromePath: s.chromePath, proxy: s.betikaBrowserProxy,
  selectorsFile: s.betikaSelectors, phone: s.betikaPhone, password: s.betikaPassword, log,
  pageTimeoutMs: (s.betikaPageTimeoutSeconds ?? 30) * 1000, ...overrides,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; log.info('stopping after this cycle...'); });
// A crash ends the process with code 1 (the lock is released on exit), so scripts/run-forever.ps1 can restart it.
process.on('unhandledRejection', (e) => { log.error(`crashed: ${e?.stack ?? e}`); process.exit(1); });
process.on('uncaughtException', (e) => { log.error(`crashed: ${e?.stack ?? e}`); process.exit(1); });

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
  const accounts = [{ name: 'main', s, store, log }]; // + BETIKA_ACCOUNTS
  if (s.betikaEnabled) {
    feed = new BetikaAPI();
    client = makeClient();
    accounts[0].client = client;
    if (s.betikaLive) await client.ensureLoggedIn();
    if (s.betikaLive) await refreshBalance(client, store, log);
    executor = new BetikaExecutor(s, client, store, { log, notify: (t) => notifier.sendText(t) });
    log.info(`betika: ${s.betikaLive ? 'LIVE - real bets will be placed' : 'DRY RUN - bet slips are filled, never submitted'}`
      + ` | winnings tax ${(s.winningsTax.betika * 100).toFixed(0)}%`);
    // other Betika accounts (BETIKA_ACCOUNTS=dad -> .env.dad): same scan, own login, stake, limits and bet log
    for (const name of s.betikaAccounts ?? []) {
      let as;
      try { as = accountSettings(s, name); } catch (e) {
        if (!(e instanceof SettingsError)) throw e;
        log.error(`Settings problem: ${e.message}`);
        return 2;
      }
      const tag = { info: (m) => log.info(`[${name}] ${m}`), warn: (m) => log.warn(`[${name}] ${m}`), error: (m) => log.error(`[${name}] ${m}`) };
      let rel;
      try { rel = acquireLock(as.storePath); } catch (e) { log.error(`[${name}] ${e.message}`); return 1; }
      process.on('exit', rel);
      const st = new Store(as.storePath, { log: tag });
      const cl = makeClient({ sessionDir: as.betikaSessionDir, phone: as.betikaPhone, password: as.betikaPassword, log: tag });
      // one account failing to open Betika must not stop the others: it logs in again when it next bets
      if (as.betikaLive) {
        try { await cl.ensureLoggedIn(); await refreshBalance(cl, st, tag); } catch (e) {
          tag.warn(`could not open Betika at start-up (${e.message.split('\n')[0]}) - the bot carries on; this account retries when it next bets`
            + ` (if it keeps failing: node bin/ev-bot.js login --account ${name})`);
        }
      }
      const ex = new BetikaExecutor(as, cl, st, { log: tag, notify: (t) => notifier.sendText(`[${name}] ${t}`) });
      accounts.push({ name, s: as, client: cl, store: st, executor: ex, log: tag });
      tag.info(`betika: ${as.betikaLive ? 'LIVE - real bets' : 'DRY RUN'} | stake ${as.betikaFixedStake || 'Kelly'} | max ${as.betikaMaxBetsPerDay} bets/day`);
    }
    if (accounts.length > 1) executor = new MultiExecutor(executor, accounts.slice(1).map((a) => a.executor), log);
    executor.pausedStrategy = (opp) => (s.strategyGuard ? botState.pausedStrategies?.[strategyOf(opp)] ?? null : null);
    accounts[0].executor = executor;
  }
  // SportPesa (SPORTPESA=true): its own browser session, bet log, stake and limits; bets at the same time as Betika
  const executors = {}, feeds = [];
  if (s.sportpesa) {
    const tag = { info: (m) => log.info(`[sportpesa] ${m}`), warn: (m) => log.warn(`[sportpesa] ${m}`), error: (m) => log.error(`[sportpesa] ${m}`) };
    const spS = { ...s, account: 'sportpesa', betikaLive: s.sportpesaLive, liveBetsLive: false,
      betikaFixedStake: s.sportpesaFixedStake || s.betikaFixedStake, betikaMinStake: Math.max(10, s.betikaMinStake ?? 10),
      betikaMaxBetsPerDay: s.sportpesaMaxBetsPerDay, betikaDailyStakeLimit: s.sportpesaDailyStakeLimit, storePath: s.sportpesaStorePath };
    let rel;
    try { rel = acquireLock(spS.storePath); } catch (e) { log.error(`[sportpesa] ${e.message}`); return 1; }
    process.on('exit', rel);
    const spStore = new Store(spS.storePath, { log: tag });
    const site = new SportPesaSite({ sessionDir: s.sportpesaSessionDir, chromePath: s.chromePath, headless: s.betikaHeadless, log: tag,
      timeoutMs: Math.max(60, s.betikaPageTimeoutSeconds ?? 30) * 1000 });
    const spEx = new BetikaExecutor(spS, new SportPesaClient(site, { log: tag }), spStore,
      { log: tag, notify: (t) => notifier.sendText(`[sportpesa] ${t}`), book: 'sportpesa', title: 'SportPesa', pickFor: sportpesaPickFor });
    spEx.pausedStrategy = (opp) => (s.strategyGuard ? botState.pausedStrategies?.[strategyOf(opp)] ?? null : null);
    executors.sportpesa = spEx;
    feeds.push({ name: 'sportpesa', attach: (evs, now) => attachSportPesa(evs, site, now, tag) });
    s.ownFeedBooks = [...new Set([...(s.ownFeedBooks ?? []), 'sportpesa'])];
    accounts.push({ name: 'sportpesa', s: spS, store: spStore, log: tag, executor: spEx, close: () => site.close() });
    tag.info(`${spS.betikaLive ? 'LIVE - real bets will be placed' : 'DRY RUN - prices checked, bets never sent'} | stake ${spS.betikaFixedStake || 'Kelly'}`
      + ` | max ${spS.betikaMaxBetsPerDay} bets / KES ${spS.betikaDailyStakeLimit} a day | no tax on winnings`);
  }
  // OdiBets (ODIBETS=true): priced like Betika, its own bet log and dashboard view; real bets with ODIBETS_LIVE=true
  if (s.odibets) {
    const tag = { info: (m) => log.info(`[odibets] ${m}`), warn: (m) => log.warn(`[odibets] ${m}`), error: (m) => log.error(`[odibets] ${m}`) };
    const odS = { ...s, account: 'odibets', betikaLive: s.odibetsLive, liveBetsLive: false,
      betikaFixedStake: s.odibetsFixedStake || s.betikaFixedStake, betikaMinStake: Math.max(10, s.betikaMinStake ?? 10),
      betikaMaxBetsPerDay: s.odibetsMaxBetsPerDay, betikaDailyStakeLimit: s.odibetsDailyStakeLimit, storePath: s.odibetsStorePath };
    let rel;
    try { rel = acquireLock(odS.storePath); } catch (e) { log.error(`[odibets] ${e.message}`); return 1; }
    process.on('exit', rel);
    const odStore = new Store(odS.storePath, { log: tag });
    const site = new OdiBetsSite({ sessionDir: s.odibetsSessionDir, chromePath: s.chromePath, headless: s.betikaHeadless, log: tag,
      timeoutMs: Math.max(60, s.betikaPageTimeoutSeconds ?? 30) * 1000 });
    const odEx = new BetikaExecutor(odS, new OdiBetsClient(site, { log: tag }), odStore,
      { log: tag, notify: (t) => notifier.sendText(`[odibets] ${t}`), book: 'odibets', title: 'OdiBets', pickFor: odibetsPickFor });
    odEx.pausedStrategy = (opp) => (s.strategyGuard ? botState.pausedStrategies?.[strategyOf(opp)] ?? null : null);
    executors.odibets = odEx;
    feeds.push({ name: 'odibets', attach: (evs, now) => attachOdiBets(evs, site, now, tag) });
    s.ownFeedBooks = [...new Set([...(s.ownFeedBooks ?? []), 'odibets'])];
    accounts.push({ name: 'odibets', s: odS, store: odStore, log: tag, executor: odEx, close: () => site.close() });
    tag.info(`${odS.betikaLive ? 'LIVE - real bets will be placed' : 'DRY RUN - prices checked, bets never sent'} | stake ${odS.betikaFixedStake || 'Kelly'}`
      + ` | max ${odS.betikaMaxBetsPerDay} bets / KES ${odS.betikaDailyStakeLimit} a day`);
    if (odS.betikaLive) {
      site.login().then((a) => { if (!a) tag.warn('not logged in to OdiBets - run: node bin/ev-bot.js record odibets, log in, close Chrome'); }).catch(() => {});
    }
  }
  log.info(`scanning ${s.sports.join(',')} | sharp=${s.sharpBooks.join(',')} | min EV ${(s.minEv * 100).toFixed(1)}% | devig=${s.devigMethod}`
    + ` | alt totals ${s.altTotals ? `on (min ${(s.altTotalsMinEv * 100).toFixed(1)}%)` : 'off'}`
    + ` | live betting ${s.liveBetting ? `${s.liveBetsLive && s.betikaLive ? 'REAL' : 'dry run'} (${s.liveSports.join('/')}, every ${s.livePollSeconds}s, min ${(Math.max(s.liveMinEv, s.minEv) * 100).toFixed(1)}%)` : 'off'}`
    + ` | fast scans ${s.fastScanMinutes > 0 ? `every ${Math.round(s.fastPollSeconds / 60)} min within ${s.fastScanMinutes} min of ${s.fastScanSports.join('/')} games` : 'off'}`);
  try {
    if (s.dashboard) startDashboard({ store, s, port: s.dashboardPort, log, accounts: accounts.map(({ name, store: st, s: as }) => ({ name, store: st, s: as })) });
    Object.assign(botState.mode, { betikaLive: s.betikaLive, liveBetting: s.liveBetting, liveBetsLive: s.liveBetsLive,
      minEv: s.minEv, tax: s.winningsTax.betika, sports: s.sports });
    const track = (r, k) => {
      if (!r) return;
      botState.scans++;
      botState.lastScan = { at: new Date().toISOString(), kind: k, found: r.found };
      botState.opportunities = summarizeOpps(r.all ?? []);
      botState.closest = r.closest;
      botState.credits = api.requestsRemaining;
      syncExecutor();
    };
    const syncExecutor = () => {
      botState.pausedUntil = executor?.pausedUntil ? new Date(executor.pausedUntil).toISOString() : null;
      botState.halted = executor?.halted ? (executor.haltReason ?? 'stake mismatch') : null;
      botState.accountState = Object.fromEntries(accounts.slice(1).map((a) => [a.name, {
        pausedUntil: a.executor?.pausedUntil ? new Date(a.executor.pausedUntil).toISOString() : null,
        halted: a.executor?.halted ? (a.executor.haltReason ?? 'stake mismatch') : null }]));
    };
    let papi = null, lastPapi = 0;
    if (s.oddsPapiKey) {
      papi = new OddsPapi(s.oddsPapiKey, { cachePath: s.oddsPapiCachePath, log });
      log.info(`oddspapi: on - used when The Odds API finds fewer than ${s.oddsPapiWhenFewerThan} +EV bets, at most every ${s.oddsPapiMinIntervalMinutes} min`);
    }
    const fastGroups = s.fastScanSports;
    let lastFull = 0;
    let lastLive = 0, liveActive = false;
    const liveGuard = new LiveGuard(s);
    const steam = s.steam ? new SteamTracker(s) : null;
    const periods = new PeriodPrices(api, s, log);
    const enrich = (evs) => periods.enrich(evs);
    // Betika watch: every Betika read is noted, so new listings and price changes can be checked quickly
    const watch = s.openers && feed ? new BetikaWatch(s) : null;
    const betika = watch ? {
      allMatches: async (groups, l) => { const m = await feed.allMatches(groups, l); watch.observe(m); return m; },
      allLiveMatches: (groups, l) => feed.allLiveMatches(groups, l),
    } : feed;
    const tagOpener = watch ? (o) => { if (watch.isOpener(o)) o.opener = true; } : null;
    let lastEvents = null, lastEventsAt = 0, lastBetika = 0;
    const steamMarkets = (sport) => ['h2h', 'totals', 'spreads'].filter((m) => marketsFor(sport, s).includes(m));
    let lastSettle = 0;
    // strategy guard: re-judged at start-up and after each hourly settle
    const judge = () => {
      if (!s.strategyGuard) return;
      const v = strategyVerdicts(store.data.bets, s);
      const before = new Set(Object.keys(botState.pausedStrategies ?? {}));
      botState.pausedStrategies = Object.fromEntries(v);
      for (const [k, why] of v) if (!before.has(k)) log.warn(`strategy guard: pausing real bets on "${k}" - ${why} (dry runs continue)`);
      for (const k of before) if (!v.has(k)) log.info(`strategy guard: "${k}" picks improved - real bets resume`);
    };
    judge();
    let upcoming = []; // start times of fast-sport games, for pre-start fast scans
    let kind = 'full';
    while (!stopping) {
      try {
        let events;
        if (kind === 'full') {
          events = await fetchEvents(api, s, log);
          lastFull = Date.now();
          lastEvents = events; lastEventsAt = lastFull; lastBetika = lastFull;
          upcoming = events.filter((e) => fastGroups.includes(sportGroup(e.sport_key ?? ''))).map((e) => +new Date(e.commence_time));
        } else if (kind === 'live') {
          events = await fetchLiveEvents(api, s, log);
          lastLive = Date.now();
          const modelGames = s.liveModel && s.liveSports.includes('soccer') ? anchoredLiveEvents(store).length : 0;
          liveActive = events.length > 0 || modelGames > 0;
          if (events.length) {
            track(await runCycle({ events, s, store, notifier, betika: feed, executor, log, live: true, guard: liveGuard,
              confirm: s.liveConfirm ? (o, ev, ss) => confirmLive(api, s, o, ev, ss) : null }), 'live');
          }
          else botState.credits = api.requestsRemaining;
          // our own in-play soccer prices (free: Betika's live feed + stored pre-match prices)
          if (modelGames) {
            try {
              const m = await runModelCycle({ store, s, feed, executor, notifier, log, guard: liveGuard });
              if (m?.all?.length) track(m, 'live model');
            } catch (e) { log.warn(`live model: ${e.stack ?? e}`); }
          }
          events = null;
        } else if (kind === 'betika') {
          // new or changed Betika prices since the last read, against the last full scan's Pinnacle prices
          lastBetika = Date.now();
          const groups = [...new Set(lastEvents.map((e) => sportGroup(e.sport_key ?? '')).filter(Boolean))];
          const matches = await feed.allMatches(groups, log);
          const changed = watch.observe(matches);
          attachBetikaOdds(lastEvents, matches, new Date());
          const evs = lastEvents.filter((e) => e.betikaRef && changed.has(e.betikaRef.parentMatchId) && new Date(e.commence_time) > new Date());
          if (evs.length) {
            log.info(`betika watch: ${changed.size} Betika game(s) with new or changed prices, ${evs.length} with Pinnacle prices - checking`);
            track(await runCycle({ events: evs, s, store, notifier, betika: null, executor, log, steam, decorate: tagOpener, executors }), 'betika watch');
          }
          events = null;
        } else if (kind === 'steam') {
          // games Pinnacle just moved sharply: re-price them now (a lagging Betika price is the edge)
          events = [];
          for (const { eventId, sport } of steam.due(Date.now(), 3)) {
            const markets = steamMarkets(sport);
            try {
              const ev = await api.getEventOdds(sport, eventId, markets, s.regions, bookPlan(s).apiBooks);
              steam.polled(eventId, markets.length);
              if (ev && new Date(ev.commence_time) > new Date()) events.push(ev);
            } catch (e) {
              steam.polled(eventId, 0);
              if (!(e instanceof OddsAPIError)) throw e;
              log.warn(`steam ${eventId}: ${e.message}`);
            }
          }
          log.info(`steam: re-priced ${events.length} game(s) Pinnacle moved sharply (watching ${steam.watch.size}, ${steam.spent.credits}/${s.steamDailyCredits} credits today)`);
        } else {
          log.info(`fast scan: ${fastGroups.join(', ')} games starting within ${s.fastScanMinutes} min`);
          events = await fetchEvents(api, s, log, { onlyGroups: fastGroups, horizonHours: s.fastScanMinutes / 60, quietKeys: true });
        }
        const r = events?.length ? await runCycle({ events, s, store, notifier, betika, executor, log, steam, enrich, decorate: tagOpener, executors, feeds }) : { found: Infinity };
        if (events?.length) {
          track(r, kind);
          // pre-match Pinnacle prices for the in-play model
          if (s.liveModel && recordAnchors(store, events, s)) store.save();
          const moved = steam ? [...steam.watch.values()].filter((w) => w.reason && !w.logged) : [];
          for (const w of moved) { w.logged = true; log.info(`steam: Pinnacle moved ${w.reason.what} by ${(w.reason.move * 100).toFixed(1)} pts in ${Math.round(w.reason.minutes)} min - watching that game`); }
        }
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
            track(await runCycle({ events: m.events, s, store, notifier, betika, executor, log, steam, decorate: tagOpener, executors, feeds }), 'full + oddspapi');
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
        for (const a of accounts) {
          try { await settlePending(api, a.store, a.log); } catch (e) { a.log.warn(`settle: ${e.message}`); }
        }
        // Betika's own record of placed bets (status and payout), read from My Bets
        for (const a of accounts) {
          if (!a.client || !a.s.betikaLive) continue;
          if (s.betikaHistory) {
            try { await checkBetikaHistory(a.client, a.store, a.log); } catch (e) { a.log.warn(`betika history: ${e.message.split('\n')[0]}`); }
          }
          // the real balance (winnings paid in, deposits, bets placed by hand) for the dashboard
          await refreshBalance(a.client, a.store, a.log);
        }
        judge();
      }
      if (opt.once) break; // keep scanning even if betting is halted, so alerts keep coming
      const plan = nextScanPlan({ now: Date.now(), lastFull, s, upcoming });
      if (s.liveBetting) {
        // games in progress: every LIVE_POLL_SECONDS; otherwise look again every LIVE_IDLE_CHECK_SECONDS
        const liveDue = lastLive + (liveActive ? s.livePollSeconds : s.liveIdleCheckSeconds) * 1000;
        const liveWait = Math.max(0, liveDue - Date.now());
        if (liveWait < plan.waitMs) Object.assign(plan, { kind: 'live', waitMs: liveWait });
      }
      // Betika watch between full scans, while the last scan's Pinnacle prices are still fresh enough
      if (watch && lastEvents?.length && Date.now() - lastEventsAt < (s.maxLineAgeSeconds - 60) * 1000) {
        const wait = Math.max(0, lastBetika + s.openersPollSeconds * 1000 - Date.now());
        if (wait < plan.waitMs) Object.assign(plan, { kind: 'betika', waitMs: wait });
      }
      const steamAt = steam?.nextDueAt();
      if (steamAt != null && steamAt - Date.now() < plan.waitMs) Object.assign(plan, { kind: 'steam', waitMs: Math.max(0, steamAt - Date.now()) });
      kind = plan.kind;
      botState.nextScan = { kind: plan.kind, at: new Date(Date.now() + plan.waitMs).toISOString() };
      if (plan.waitMs >= 60_000) log.info(`next ${plan.kind} scan in ${Math.round(plan.waitMs / 60_000)} min`);
      for (let t = 0; t < plan.waitMs / 1000 && !stopping; t++) await sleep(1000);
    }
  } finally {
    for (const a of accounts) { await a.client?.close(); await a.close?.(); }
    release();
  }
  return 0;
}

async function withBrowser(fn, overrides) {
  const client = makeClient(overrides);
  try { return await fn(client); } finally { await client.close(); }
}

/** Read the account balance from Betika's page and keep it for the dashboard. Never throws. */
async function refreshBalance(client, store, log) {
  try {
    const amount = await client.readBalance();
    if (amount == null) return log.warn('betika balance: not shown on the page - kept the last known figure');
    store.data.balance = { amount, at: new Date().toISOString() };
    store.save();
    log.info(`betika balance: KES ${amount}`);
  } catch (e) {
    log.warn(`betika balance: ${e.message.split('\n')[0]}`);
  }
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

  // Does The Odds API have Pinnacle's 1st half / quarter prices? Checks the next NBA (or NCAAB) game.
  periods: async () => {
    let api;
    try { api = new OddsAPI(s.apiKey); } catch (e) { log.error(e.message); return 1; }
    const markets = ['totals_h1', 'team_totals_h1', 'totals_q1', 'team_totals_q1'];
    for (const sport of ['basketball_nba', 'basketball_ncaab', 'basketball_wnba']) {
      const evs = (await api.getEvents(sport).catch(() => [])).filter((e) => new Date(e.commence_time) > new Date())
        .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
      if (!evs.length) { console.log(`${sport}: no upcoming games`); continue; }
      const e = evs[0];
      const res = await api.getEventOdds(sport, e.id, markets, s.regions, bookPlan(s).apiBooks);
      console.log(`${sport}: ${e.away_team} @ ${e.home_team} (${e.commence_time}) - cost ${api.lastCost ?? '?'} credits`);
      for (const bm of res?.bookmakers ?? []) {
        for (const m of bm.markets ?? []) {
          const pts = [...new Set(m.outcomes.map((o) => `${o.description ? `${o.description} ` : ''}${o.point}`))];
          console.log(`  ${bm.key.padEnd(10)} ${m.key.padEnd(15)} ${pts.join(', ')}`);
        }
      }
      if (!res?.bookmakers?.length) console.log('  no prices for these markets from the sharp books yet (they often appear closer to tip-off)');
    }
    return 0;
  },

  // Bad luck or bad prices? Wins you got vs wins the fair odds predicted, per group (reads the bet log only)
  review: async () => {
    const store = new Store(s.storePath, { log });
    console.log(taxLines(store.data.bets, s.winningsTax.betika ?? 0).join('\n') + '\n');
    console.log(review(store.data.bets));
    return 0;
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
    const accts = [{ name: 'main', store, s }];
    for (const name of opt.account ? [] : s.betikaAccounts ?? []) {
      try { const as = accountSettings(s, name); accts.push({ name, store: new Store(as.storePath, { log }), s: as }); } catch (e) { log.warn(e.message); }
    }
    startDashboard({ store, s, port: s.dashboardPort, log, reload: true, accounts: accts });
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
    log.info(`logged in, balance: ${await c.readBalance().catch(() => null) ?? 'unknown'} - session saved to ${s.betikaSessionDir}`);
    return 0;
  }, { headless: false }),

  // Read the balance the way the bot does and show where on Betika's page it was found
  balance: () => withBrowser(async (c) => {
    await c.ensureLoggedIn();
    const v = await c.readBalance();
    console.log(`balance: ${v ?? 'not found'}`);
    console.log('seen on the page:');
    for (const x of c.lastBalanceSources ?? []) console.log(`  ${x.source.padEnd(13)} ${String(x.value).padStart(10)}  ${x.labelled ? '(labelled Balance) ' : ''}${x.where}`);
    if (!c.lastBalanceSources?.length) console.log('  nothing - send a screenshot of the top of Betika\'s page when logged in');
    return v == null ? 1 : 0;
  }),

  discover: () => withBrowser(async (c) => { await c.discover('discover'); return 0; }, { headless: false }),

  // Record another sportsbook's data requests (to add it to the bot):  record odibets | record sportpesa | record qbet --url https://...
  record: async () => {
    const book = (positionals[1] ?? '').toLowerCase();
    if (!book) { console.error('which sportsbook? e.g.  node bin/ev-bot.js record odibets'); return 2; }
    try {
      await recordBook({ book, url: opt.url, sessionDir: `.${book.replace(/[^a-z0-9]/g, '')}-session`, chromePath: s.chromePath, log });
      return 0;
    } catch (e) { log.error(e.message); return 2; }
  },
};

if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
commands[cmd]().then((code) => process.exit(code), (e) => { log.error(e.stack ?? String(e)); process.exit(1); });
