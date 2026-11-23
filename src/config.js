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
  const finite = ['altTotalsMinEv', 'altTotalsMaxDistance', 'fastScanMinutes', 'fastPollSeconds', 'minEv', 'minDecimalOdds', 'maxDecimalOdds', 'maxHoursToStart', 'maxLineAgeSeconds', 'bankroll',
    'kellyFraction', 'maxStakePct', 'pollSeconds', 'betikaMinStake', 'betikaMaxStake', 'betikaFixedStake',
    'betikaDailyStakeLimit', 'betikaMaxBetsPerDay'];
  for (const k of finite) if (!Number.isFinite(s[k])) fail(`setting ${k} is not a number: ${s[k]}`);
  if (s.altTotalsMinEv < 0 || s.altTotalsMinEv > 0.5) fail(`ALT_TOTALS_MIN_EV=${s.altTotalsMinEv} must be between 0 and 0.5`);
  if (s.fastScanMinutes > 0 && s.fastPollSeconds < 60) fail('FAST_POLL_SECONDS must be at least 60');
  if (s.minEv < 0) fail(`MIN_EV=${s.minEv} is negative: that would bet on losing prices`);
  if (s.minEv > 0.5) fail(`MIN_EV=${s.minEv} looks wrong (it is a fraction: 0.02 means 2%)`);
  const tax = s.winningsTax?.betika ?? 0;
  if (!Number.isFinite(tax) || tax < 0 || tax >= 1) fail(`BETIKA_WINNINGS_TAX=${tax} must be between 0 and 0.99`);
  if (s.minDecimalOdds <= 1 || s.maxDecimalOdds <= s.minDecimalOdds) fail('MIN_DECIMAL_ODDS / MAX_DECIMAL_ODDS are invalid');
  return s;
}

export const makeSettings = (overrides = {}) => ({ ...DEFAULTS, ...overrides });
