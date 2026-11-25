// Trade signals from a list of tick prices. Pure functions: easy to test and to replay on history.
// A signal is 'CALL' (Rise), 'PUT' (Fall) or null (no trade).

export function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI of the last `period` changes (0-100). null when there is not enough data. */
export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * EMA crossover: fast EMA crosses above slow -> CALL, below -> PUT.
 * RSI filter skips CALLs when overbought and PUTs when oversold.
 */
export function emaCross(prices, { fast = 5, slow = 20, rsiPeriod = 14, rsiHigh = 70, rsiLow = 30 } = {}) {
  if (prices.length < Math.max(slow, rsiPeriod) + 2) return null;
  const f = ema(prices, fast);
  const s = ema(prices, slow);
  // align the two series on their last two points
  const fNow = f.at(-1), fPrev = f.at(-2), sNow = s.at(-1), sPrev = s.at(-2);
  const r = rsi(prices.slice(-(rsiPeriod * 3)), rsiPeriod);
  if (fPrev <= sPrev && fNow > sNow && (r === null || r < rsiHigh)) return 'CALL';
  if (fPrev >= sPrev && fNow < sNow && (r === null || r > rsiLow)) return 'PUT';
  return null;
}

/** Momentum: the last `run` ticks all moved the same way -> follow it. */
export function momentum(prices, { run = 4 } = {}) {
  if (prices.length < run + 1) return null;
  const last = prices.slice(-(run + 1));
  let up = true, down = true;
  for (let i = 1; i < last.length; i++) {
    if (!(last[i] > last[i - 1])) up = false;
    if (!(last[i] < last[i - 1])) down = false;
  }
  return up ? 'CALL' : down ? 'PUT' : null;
}

export const STRATEGIES = { 'ema-cross': emaCross, momentum };

export function getStrategy(name) {
  const fn = STRATEGIES[name];
  if (!fn) throw new Error(`unknown DERIV_STRATEGY=${name} (choose ${Object.keys(STRATEGIES).join(', ')})`);
  return fn;
}

/**
 * Replay a strategy on historical ticks with Rise/Fall over `durationTicks`.
 * Entry = the tick after the signal, exit = `durationTicks` ticks later; equal prices lose (as on Deriv).
 * payoutRatio = payout / stake (e.g. 1.95). Returns win rate and profit per 1 unit staked.
 */
export function backtest(prices, { strategy = 'ema-cross', params = {}, durationTicks = 5, payoutRatio = 1.95, window = 200 } = {}) {
  const fn = getStrategy(strategy);
  let trades = 0, wins = 0, i = 0;
  while (i < prices.length) {
    const signal = fn(prices.slice(Math.max(0, i - window), i + 1), params);
    const entry = i + 1, exit = i + 1 + durationTicks;
    if (signal && exit < prices.length) {
      trades++;
      const won = signal === 'CALL' ? prices[exit] > prices[entry] : prices[exit] < prices[entry];
      if (won) wins++;
      i = exit; // one contract at a time
    } else i++;
  }
  const profit = wins * (payoutRatio - 1) - (trades - wins);
  return {
    trades,
    wins,
    winRate: trades ? wins / trades : 0,
    breakEvenWinRate: 1 / payoutRatio,
    profitPerUnit: profit,
    roi: trades ? profit / trades : 0,
  };
}
