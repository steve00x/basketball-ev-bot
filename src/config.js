// Settings from environment variables / a .env file (no dependency).
import fs from 'node:fs';

export function loadDotenv(path = '.env') {
  if (!path || !fs.existsSync(path)) return;
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).split(' #')[0].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const env = (k) => (process.env[k] ?? '').trim();
const list = (k, d) => { const v = env(k).split(',').map((s) => s.trim()).filter(Boolean); return v.length ? v : d; };
const num = (k, d) => (env(k) === '' ? d : Number(env(k)));
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
  return {
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
    betikaDailyStakeLimit: num('BETIKA_DAILY_STAKE_LIMIT', d.betikaDailyStakeLimit),
    betikaMaxBetsPerDay: num('BETIKA_MAX_BETS_PER_DAY', d.betikaMaxBetsPerDay),
    betikaSelectors: str('BETIKA_SELECTORS', ''),
    betikaSessionDir: str('BETIKA_SESSION_DIR', d.betikaSessionDir),
    chromePath: str('CHROME_PATH', ''),
    betikaBrowserProxy: str('BETIKA_BROWSER_PROXY', ''),
    ...overrides,
  };
}

export const makeSettings = (overrides = {}) => ({ ...DEFAULTS, ...overrides });
