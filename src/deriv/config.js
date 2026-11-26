// Deriv bot settings from environment variables / .env (reuses the number parser of the main bot).
import { SettingsError, parseNumber } from '../config.js';

const env = (k) => (process.env[k] ?? '').trim();
const num = (k, d) => (env(k) === '' ? d : parseNumber(env(k), k));
const bool = (k, d) => (env(k) === '' ? d : /^(1|true|yes|on)$/i.test(env(k)));
const str = (k, d) => env(k) || d;

export const DERIV_DEFAULTS = Object.freeze({
  appId: '1089', // Deriv's public test app id; register your own at api.deriv.com
  endpoint: 'wss://ws.derivws.com/websockets/v3',
  token: '',
  live: false, // false = paper trading: real quotes and ticks, no buy
  allowReal: false, // must be true as well to buy on a real-money account
  symbol: 'R_100',
  currency: 'USD',
  stake: 1,
  durationTicks: 5,
  strategy: 'ema-cross',
  emaFast: 5,
  emaSlow: 20,
  rsiPeriod: 14,
  momentumRun: 4,
  minPayoutRatio: 1.8,
  maxDailyLoss: 10,
  dailyProfitTarget: 0,
  maxDailyTrades: 50,
  maxConsecutiveLosses: 3,
  cooldownSeconds: 300,
  journalPath: 'deriv-trades.jsonl',
  statusPath: 'deriv-status.json',
  stallSeconds: 120, // no tick for this long -> reconnect
});

export function derivSettingsFromEnv() {
  const d = DERIV_DEFAULTS;
  return validateDerivSettings({
    appId: str('DERIV_APP_ID', d.appId),
    endpoint: str('DERIV_ENDPOINT', d.endpoint),
    token: str('DERIV_API_TOKEN', d.token),
    live: bool('DERIV_LIVE', d.live),
    allowReal: bool('DERIV_ALLOW_REAL', d.allowReal),
    symbol: str('DERIV_SYMBOL', d.symbol),
    currency: str('DERIV_CURRENCY', d.currency),
    stake: num('DERIV_STAKE', d.stake),
    durationTicks: num('DERIV_DURATION_TICKS', d.durationTicks),
    strategy: str('DERIV_STRATEGY', d.strategy),
    emaFast: num('DERIV_EMA_FAST', d.emaFast),
    emaSlow: num('DERIV_EMA_SLOW', d.emaSlow),
    rsiPeriod: num('DERIV_RSI_PERIOD', d.rsiPeriod),
    momentumRun: num('DERIV_MOMENTUM_RUN', d.momentumRun),
    minPayoutRatio: num('DERIV_MIN_PAYOUT_RATIO', d.minPayoutRatio),
    maxDailyLoss: num('DERIV_MAX_DAILY_LOSS', d.maxDailyLoss),
    dailyProfitTarget: num('DERIV_DAILY_PROFIT_TARGET', d.dailyProfitTarget),
    maxDailyTrades: num('DERIV_MAX_DAILY_TRADES', d.maxDailyTrades),
    maxConsecutiveLosses: num('DERIV_MAX_CONSECUTIVE_LOSSES', d.maxConsecutiveLosses),
    cooldownSeconds: num('DERIV_COOLDOWN_SECONDS', d.cooldownSeconds),
    journalPath: str('DERIV_JOURNAL', d.journalPath),
    statusPath: str('DERIV_STATUS_FILE', d.statusPath),
    stallSeconds: num('DERIV_STALL_SECONDS', d.stallSeconds),
  });
}

export function makeDerivSettings(overrides = {}) {
  return { ...DERIV_DEFAULTS, ...overrides };
}

export function validateDerivSettings(s) {
  const fail = (m) => { throw new SettingsError(m); };
  if (!(s.stake > 0)) fail('DERIV_STAKE must be above 0');
  if (!(s.maxDailyLoss > 0)) fail('DERIV_MAX_DAILY_LOSS must be above 0');
  if (s.stake > s.maxDailyLoss) fail('DERIV_STAKE is larger than DERIV_MAX_DAILY_LOSS');
  if (!Number.isInteger(s.durationTicks) || s.durationTicks < 1 || s.durationTicks > 10) fail('DERIV_DURATION_TICKS must be a whole number from 1 to 10');
  if (!(s.maxDailyTrades >= 1)) fail('DERIV_MAX_DAILY_TRADES must be at least 1');
  if (!(s.minPayoutRatio > 1)) fail('DERIV_MIN_PAYOUT_RATIO must be above 1 (payout / stake, e.g. 1.8)');
  if (s.emaFast >= s.emaSlow) fail('DERIV_EMA_FAST must be smaller than DERIV_EMA_SLOW');
  if (!(s.stallSeconds >= 30)) fail('DERIV_STALL_SECONDS must be at least 30');
  if (s.live && !s.token) fail('DERIV_LIVE=true needs DERIV_API_TOKEN (create one with Read + Trade scopes)');
  return s;
}

export function strategyParams(s) {
  return s.strategy === 'momentum'
    ? { run: s.momentumRun }
    : { fast: s.emaFast, slow: s.emaSlow, rsiPeriod: s.rsiPeriod };
}
