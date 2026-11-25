// Settings from environment variables / a .env file (no dependency).
import fs from 'node:fs';

export function loadDotenv(path = '.env') {
  if (!path || !fs.existsSync(path)) return;
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).split(/\s+#/)[0].trim().replace(/^['"]|['"]$/g, ''); // "0.02<tab># note" too
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const env = (k) => (process.env[k] ?? '').trim();
const list = (k, d) => { const v = env(k).split(',').map((s) => s.trim()).filter(Boolean); return v.length ? v : d; };
export class SettingsError extends Error {}

/** Read a number from .env. Accepts "0.02", "2%", "0,02". Anything else stops the bot with a clear message. */
export function parseNumber(raw, name = 'value') {
  let t = String(raw).trim().replace(/\s+/g, '');
  const pct = t.endsWith('%');
  if (pct) t = t.slice(0, -1);
  if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.'); // "0,02" (comma decimal)
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) {
    throw new SettingsError(`${name}=${raw} in .env is not a number (write it like ${name}=0.02)`);
  }
  return pct ? n / 100 : n;
}
const num = (k, d) => (env(k) === '' ? d : parseNumber(env(k), k));
const bool = (k, d) => (env(k) === '' ? d : /^(1|true|yes|on)$/i.test(env(k)));
const str = (k, d) => env(k) || d;

export const DEFAULTS = Object.freeze({
  apiKey: '',
  sports: ['basketball_nba'],
  markets: ['h2h', 'spreads', 'totals'],
  regions: ['us', 'eu'],
  sharpBooks: ['pinnacle'],
  targetBooks: [],
  propMarkets: [],
  devigMethod: 'power',
  minEv: 0.02,
  minDecimalOdds: 1.3,
  maxDecimalOdds: 5.0,
  maxHoursToStart: 36,
  maxLineAgeSeconds: 300,
  realertEvDelta: 0.01,
  bankroll: 1000,
  kellyFraction: 0.25,
  maxStakePct: 0.02,
  pollSeconds: 300,
  storePath: 'ev-bot-store.json',
  discordWebhookUrl: '',
  telegramBotToken: '',
  telegramChatId: '',
  // Betika
  // Tax on net winnings per book (Kenya: 20% withholding from 1 July 2026)
  winningsTax: { betika: 0.2 },
  betikaEnabled: false,
  betikaLive: false, // false = dry run: fills the bet slip but never clicks "Place Bet"
  betikaPhone: '',
  betikaPassword: '',
  betikaHeadless: true,
  betikaMinStake: 10,
  betikaMaxStake: 500,
  betikaFixedStake: 0, // >0: bet exactly this much every time
  betikaErrorPauseMinutes: 15,
  // Basketball alternate totals priced by a model (see scanner.js scanAltTotals)
  altTotals: true,
  altTotalsMinEv: 0.04,
  altTotalsMaxDistance: 6,
  teamTotals: true,
  settle: true,                 // grade bets from final scores (The Odds API /scores)
  settleIntervalMinutes: 60,
  betikaHistory: true,          // also read Betika's My Bets for placed bets (status and payout)
  dashboard: true,
  dashboardPort: 3000,
  creditsWarnBelow: 1000,
  dashboardHost: '127.0.0.1', // 0.0.0.0 = also reachable from phones on the same Wi-Fi (needs DASHBOARD_KEY)
  dashboardKey: '',
  // In-play betting (Pinnacle live prices from The Odds API vs Betika's live feed)
  liveBetting: false,          // scan games in progress
  liveBetsLive: false,         // place real in-play bets (dry run otherwise, even if BETIKA_LIVE=true)
  liveSports: ['basketball', 'soccer'],
  livePollSeconds: 45,
  liveIdleCheckSeconds: 600,   // how often to look for games in progress when none are on
  liveMinEv: 0.05,
  liveMaxOddsAgeSeconds: 30,   // Pinnacle's live price must be this fresh
  liveMaxEv: 0.15,             // in play, a bigger "edge" is almost always a stale price: skip it
  liveScoreSettleSeconds: 10,  // Pinnacle must have priced the game this long after the score last changed
  liveConfirm: true,           // re-check with a fresh Pinnacle price right before an in-play bet (1 credit)
  liveModel: true,             // in-play soccer priced by our own model (pre-match Pinnacle + live score/minute)
  liveModelMinEv: 0.06,
  liveModelMaxMinute: 80,
  liveModelLateTest: true,     // after LIVE_MODEL_MAX_MINUTE, keep pricing as DRY RUNS only (late-goal test)
  liveModelQuietMinutes: 3,    // no model bets this soon after a goal
  liveModelMaxAnchorHours: 3,  // the pre-match Pinnacle price must be from the last 3 h before kick-off
  periodMarkets: true,         // basketball 1st half / 1st quarter totals and team totals (NBA, NCAAB, WNBA)
  periodHoursBefore: 3,        // only for games starting within this many hours
  periodRefreshMinutes: 20,    // each game's Pinnacle period prices at most this often
  periodGamesPerScan: 3,
  periodQuarters: false,       // 1st quarter prices too (rarely pair with Betika's single line)
  periodDailyCredits: 400,
  steam: true,                 // follow sharp Pinnacle moves (pre-match)
  steamMinMove: 0.03,          // a move of 3 percentage points of fair probability...
  steamWindowMinutes: 15,      // ...within this many minutes
  steamWatchMinutes: 10,       // then re-price that game every STEAM_POLL_SECONDS for this long
  steamPollSeconds: 60,
  steamMaxEvents: 3,
  steamDailyCredits: 300,
  liveMaxHoursSinceStart: 4,
  // OddsPapi: second Pinnacle source, used only when The Odds API finds fewer than N +EV bets
  oddsPapiKey: '',
  oddsPapiWhenFewerThan: 3,
  oddsPapiMinIntervalMinutes: 180,
  oddsPapiRequestsPerScan: 1, // each request = up to 5 leagues
  oddsPapiTournaments: [],
  oddsPapiSports: ['basketball', 'soccer'],
  oddsPapiCachePath: 'oddspapi-cache.json',
  teamTotalsMinEv: 0.04,
  teamTotalsMaxDistance: 4,
  // Faster scans shortly before games start (0 = off). Only leagues with games in the window are fetched.
  fastScanMinutes: 0,
  fastPollSeconds: 300,
  fastScanSports: ['basketball'],
  betikaDailyStakeLimit: 2000,
  betikaMaxBetsPerDay: 10,
  betikaSelectors: '',
  betikaSessionDir: '.betika-session',
  chromePath: '',
  betikaBrowserProxy: '', // only needed behind an HTTP proxy
});

export function settingsFromEnv(dotenv = '.env', overrides = {}) {
  loadDotenv(dotenv);
  const d = DEFAULTS;
  return validateSettings({
    ...d,
    apiKey: str('ODDS_API_KEY', d.apiKey),
    sports: list('SPORTS', d.sports),
    markets: list('MARKETS', d.markets),
    regions: list('REGIONS', d.regions),
    sharpBooks: list('SHARP_BOOKS', d.sharpBooks),
    targetBooks: list('TARGET_BOOKS', d.targetBooks),
    propMarkets: list('PROP_MARKETS', d.propMarkets),
    devigMethod: str('DEVIG_METHOD', d.devigMethod),
    minEv: num('MIN_EV', d.minEv),
    minDecimalOdds: num('MIN_DECIMAL_ODDS', d.minDecimalOdds),
    maxDecimalOdds: num('MAX_DECIMAL_ODDS', d.maxDecimalOdds),
    maxHoursToStart: num('MAX_HOURS_TO_START', d.maxHoursToStart),
    maxLineAgeSeconds: num('MAX_LINE_AGE_SECONDS', d.maxLineAgeSeconds),
    realertEvDelta: num('REALERT_EV_DELTA', d.realertEvDelta),
    bankroll: num('BANKROLL', d.bankroll),
    kellyFraction: num('KELLY_FRACTION', d.kellyFraction),
    maxStakePct: num('MAX_STAKE_PCT', d.maxStakePct),
    pollSeconds: num('POLL_SECONDS', d.pollSeconds),
    storePath: str('STORE_PATH', d.storePath),
    discordWebhookUrl: str('DISCORD_WEBHOOK_URL', ''),
    telegramBotToken: str('TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: str('TELEGRAM_CHAT_ID', ''),
    winningsTax: { ...d.winningsTax, betika: num('BETIKA_WINNINGS_TAX', d.winningsTax.betika) },
    // MARKETS_SOCCER=h2h (etc.) overrides MARKETS for one sport, e.g. to halve soccer's credit cost.
    marketsBySport: Object.fromEntries(Object.keys(process.env)
      .filter((k) => /^MARKETS_[A-Z]+$/.test(k) && env(k))
      .map((k) => [k.slice(8).toLowerCase(), list(k, [])])),
    betikaEnabled: bool('BETIKA_ENABLED', d.betikaEnabled),
    betikaLive: bool('BETIKA_LIVE', d.betikaLive),
    betikaPhone: str('BETIKA_PHONE', ''),
    betikaPassword: str('BETIKA_PASSWORD', ''),
    betikaHeadless: bool('BETIKA_HEADLESS', d.betikaHeadless),
    betikaMinStake: num('BETIKA_MIN_STAKE', d.betikaMinStake),
    betikaMaxStake: num('BETIKA_MAX_STAKE', d.betikaMaxStake),
    betikaFixedStake: num('BETIKA_FIXED_STAKE', d.betikaFixedStake),
    betikaErrorPauseMinutes: num('BETIKA_ERROR_PAUSE_MINUTES', d.betikaErrorPauseMinutes),
    altTotals: bool('ALT_TOTALS', d.altTotals),
    altTotalsMinEv: num('ALT_TOTALS_MIN_EV', d.altTotalsMinEv),
    altTotalsMaxDistance: num('ALT_TOTALS_MAX_DISTANCE', d.altTotalsMaxDistance),
    teamTotals: bool('TEAM_TOTALS', d.teamTotals),
    settle: bool('SETTLE', d.settle),
    settleIntervalMinutes: num('SETTLE_INTERVAL_MINUTES', d.settleIntervalMinutes),
    betikaHistory: bool('BETIKA_HISTORY', d.betikaHistory),
    dashboard: bool('DASHBOARD', d.dashboard),
    dashboardPort: num('DASHBOARD_PORT', d.dashboardPort),
    creditsWarnBelow: num('CREDITS_WARN_BELOW', d.creditsWarnBelow),
    dashboardHost: str('DASHBOARD_HOST', d.dashboardHost),
    dashboardKey: str('DASHBOARD_KEY', d.dashboardKey),
    liveBetting: bool('LIVE_BETTING', d.liveBetting),
    liveBetsLive: bool('LIVE_BETS_LIVE', d.liveBetsLive),
    liveSports: list('LIVE_SPORTS', d.liveSports).map((x) => x.toLowerCase()),
    livePollSeconds: num('LIVE_POLL_SECONDS', d.livePollSeconds),
    liveIdleCheckSeconds: num('LIVE_IDLE_CHECK_SECONDS', d.liveIdleCheckSeconds),
    liveMinEv: num('LIVE_MIN_EV', d.liveMinEv),
    liveMaxOddsAgeSeconds: num('LIVE_MAX_ODDS_AGE_SECONDS', d.liveMaxOddsAgeSeconds),
    liveMaxEv: num('LIVE_MAX_EV', d.liveMaxEv),
    liveScoreSettleSeconds: num('LIVE_SCORE_SETTLE_SECONDS', d.liveScoreSettleSeconds),
    liveConfirm: bool('LIVE_CONFIRM', d.liveConfirm),
    liveModel: bool('LIVE_MODEL', d.liveModel),
    liveModelMinEv: num('LIVE_MODEL_MIN_EV', d.liveModelMinEv),
    liveModelMaxMinute: num('LIVE_MODEL_MAX_MINUTE', d.liveModelMaxMinute),
    liveModelLateTest: bool('LIVE_MODEL_LATE_TEST', d.liveModelLateTest),
    liveModelQuietMinutes: num('LIVE_MODEL_QUIET_MINUTES', d.liveModelQuietMinutes),
    liveModelMaxAnchorHours: num('LIVE_MODEL_MAX_ANCHOR_HOURS', d.liveModelMaxAnchorHours),
    periodMarkets: bool('PERIOD_MARKETS', d.periodMarkets),
    periodHoursBefore: num('PERIOD_HOURS_BEFORE', d.periodHoursBefore),
    periodRefreshMinutes: num('PERIOD_REFRESH_MINUTES', d.periodRefreshMinutes),
    periodGamesPerScan: num('PERIOD_GAMES_PER_SCAN', d.periodGamesPerScan),
    periodQuarters: bool('PERIOD_QUARTERS', d.periodQuarters),
    periodDailyCredits: num('PERIOD_DAILY_CREDITS', d.periodDailyCredits),
    steam: bool('STEAM', d.steam),
    steamMinMove: num('STEAM_MIN_MOVE', d.steamMinMove),
    steamWindowMinutes: num('STEAM_WINDOW_MINUTES', d.steamWindowMinutes),
    steamWatchMinutes: num('STEAM_WATCH_MINUTES', d.steamWatchMinutes),
    steamPollSeconds: num('STEAM_POLL_SECONDS', d.steamPollSeconds),
    steamMaxEvents: num('STEAM_MAX_EVENTS', d.steamMaxEvents),
    steamDailyCredits: num('STEAM_DAILY_CREDITS', d.steamDailyCredits),
    liveMaxHoursSinceStart: num('LIVE_MAX_HOURS_SINCE_START', d.liveMaxHoursSinceStart),
    oddsPapiKey: str('ODDSPAPI_KEY', ''),
    oddsPapiWhenFewerThan: num('ODDSPAPI_WHEN_FEWER_THAN', d.oddsPapiWhenFewerThan),
    oddsPapiMinIntervalMinutes: num('ODDSPAPI_MIN_INTERVAL_MINUTES', d.oddsPapiMinIntervalMinutes),
    oddsPapiRequestsPerScan: num('ODDSPAPI_REQUESTS_PER_SCAN', d.oddsPapiRequestsPerScan),
    oddsPapiTournaments: list('ODDSPAPI_TOURNAMENTS', d.oddsPapiTournaments),
    oddsPapiSports: list('ODDSPAPI_SPORTS', d.oddsPapiSports).map((x) => x.toLowerCase()),
    oddsPapiCachePath: str('ODDSPAPI_CACHE_PATH', d.oddsPapiCachePath),
    teamTotalsMinEv: num('TEAM_TOTALS_MIN_EV', d.teamTotalsMinEv),
    teamTotalsMaxDistance: num('TEAM_TOTALS_MAX_DISTANCE', d.teamTotalsMaxDistance),
    fastScanMinutes: num('FAST_SCAN_MINUTES', d.fastScanMinutes),
    fastPollSeconds: num('FAST_POLL_SECONDS', d.fastPollSeconds),
    fastScanSports: list('FAST_SCAN_SPORTS', d.fastScanSports).map((x) => x.toLowerCase()),
    betikaDailyStakeLimit: num('BETIKA_DAILY_STAKE_LIMIT', d.betikaDailyStakeLimit),
    betikaMaxBetsPerDay: num('BETIKA_MAX_BETS_PER_DAY', d.betikaMaxBetsPerDay),
    betikaSelectors: str('BETIKA_SELECTORS', ''),
    betikaSessionDir: str('BETIKA_SESSION_DIR', d.betikaSessionDir),
    chromePath: str('CHROME_PATH', ''),
    betikaBrowserProxy: str('BETIKA_BROWSER_PROXY', ''),
    ...overrides,
  });
}

/** Refuse settings that would make the bot bet on everything (e.g. MIN_EV=NaN or negative). */
export function validateSettings(s) {
  const fail = (m) => { throw new SettingsError(m); };
  const finite = ['periodHoursBefore', 'periodRefreshMinutes', 'periodGamesPerScan', 'periodDailyCredits', 'liveModelMinEv', 'liveModelMaxMinute', 'liveModelQuietMinutes', 'liveModelMaxAnchorHours', 'steamMinMove', 'steamWindowMinutes', 'steamWatchMinutes', 'steamPollSeconds', 'steamMaxEvents', 'steamDailyCredits', 'liveMaxEv', 'liveScoreSettleSeconds', 'settleIntervalMinutes', 'livePollSeconds', 'liveIdleCheckSeconds', 'liveMinEv', 'liveMaxOddsAgeSeconds', 'liveMaxHoursSinceStart', 'oddsPapiWhenFewerThan', 'oddsPapiMinIntervalMinutes', 'oddsPapiRequestsPerScan', 'teamTotalsMinEv', 'teamTotalsMaxDistance', 'altTotalsMinEv', 'altTotalsMaxDistance', 'fastScanMinutes', 'fastPollSeconds', 'minEv', 'minDecimalOdds', 'maxDecimalOdds', 'maxHoursToStart', 'maxLineAgeSeconds', 'bankroll',
    'kellyFraction', 'maxStakePct', 'pollSeconds', 'betikaMinStake', 'betikaMaxStake', 'betikaFixedStake',
    'betikaDailyStakeLimit', 'betikaMaxBetsPerDay'];
  for (const k of finite) if (!Number.isFinite(s[k])) fail(`setting ${k} is not a number: ${s[k]}`);
  if (s.altTotalsMinEv < 0 || s.altTotalsMinEv > 0.5) fail(`ALT_TOTALS_MIN_EV=${s.altTotalsMinEv} must be between 0 and 0.5`);
  if (s.liveBetting && s.livePollSeconds < 20) fail('LIVE_POLL_SECONDS must be at least 20');
  if (s.liveMinEv < 0 || s.liveMinEv > 0.5) fail(`LIVE_MIN_EV=${s.liveMinEv} must be between 0 and 0.5`);
  if (s.oddsPapiRequestsPerScan < 1 || s.oddsPapiRequestsPerScan > 10) fail('ODDSPAPI_REQUESTS_PER_SCAN must be 1..10');
  if (s.teamTotalsMinEv < 0 || s.teamTotalsMinEv > 0.5) fail(`TEAM_TOTALS_MIN_EV=${s.teamTotalsMinEv} must be between 0 and 0.5`);
  if (s.fastScanMinutes > 0 && s.fastPollSeconds < 60) fail('FAST_POLL_SECONDS must be at least 60');
  if (s.minEv < 0) fail(`MIN_EV=${s.minEv} is negative: that would bet on losing prices`);
  if (s.minEv > 0.5) fail(`MIN_EV=${s.minEv} looks wrong (it is a fraction: 0.02 means 2%)`);
  const tax = s.winningsTax?.betika ?? 0;
  if (!Number.isFinite(tax) || tax < 0 || tax >= 1) fail(`BETIKA_WINNINGS_TAX=${tax} must be between 0 and 0.99`);
  if (s.minDecimalOdds <= 1 || s.maxDecimalOdds <= s.minDecimalOdds) fail('MIN_DECIMAL_ODDS / MAX_DECIMAL_ODDS are invalid');
  return s;
}

export const makeSettings = (overrides = {}) => ({ ...DEFAULTS, ...overrides });
