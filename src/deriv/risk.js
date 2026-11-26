// Limits that stop the bot. Fixed stake only: stakes never grow after a loss (no martingale).

export class RiskManager {
  constructor({ stake, maxDailyLoss, dailyProfitTarget = 0, maxDailyTrades, maxConsecutiveLosses, cooldownSeconds = 300, minPayoutRatio = 1.8 }, now = () => Date.now()) {
    Object.assign(this, { stake, maxDailyLoss, dailyProfitTarget, maxDailyTrades, maxConsecutiveLosses, cooldownSeconds, minPayoutRatio });
    this.now = now;
    this.day = this.#today();
    this.pnl = 0;
    this.trades = 0;
    this.wins = 0;
    this.lossStreak = 0;
    this.cooldownUntil = 0;
    this.open = false;
  }

  #today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  #rollDay() {
    const d = this.#today();
    if (d !== this.day) {
      Object.assign(this, { day: d, pnl: 0, trades: 0, wins: 0, lossStreak: 0, cooldownUntil: 0 });
    }
  }

  /** null if a new trade is allowed, otherwise the reason it is not. */
  blocked() {
    this.#rollDay();
    if (this.open) return 'a contract is still open';
    if (this.pnl <= -this.maxDailyLoss) return `daily loss limit reached (${this.pnl.toFixed(2)})`;
    if (this.dailyProfitTarget > 0 && this.pnl >= this.dailyProfitTarget) return `daily profit target reached (+${this.pnl.toFixed(2)})`;
    if (this.trades >= this.maxDailyTrades) return `daily trade limit reached (${this.trades})`;
    if (this.now() < this.cooldownUntil) {
      return `cooling down after ${this.maxConsecutiveLosses} losses in a row (${Math.ceil((this.cooldownUntil - this.now()) / 1000)}s left)`;
    }
    // A loss now must not push the day past the limit
    if (this.pnl - this.stake < -this.maxDailyLoss) return `next stake ${this.stake} would exceed the daily loss limit`;
    return null;
  }

  /** Reject quotes that pay too little: payout/stake below minPayoutRatio. */
  checkQuote({ askPrice, payout }) {
    if (!(askPrice > 0) || !(payout > 0)) return 'quote has no price';
    if (askPrice > this.stake * 1.001) return `price ${askPrice} is above the stake ${this.stake}`;
    const ratio = payout / askPrice;
    if (ratio < this.minPayoutRatio) return `payout ${ratio.toFixed(3)}x is below DERIV_MIN_PAYOUT_RATIO ${this.minPayoutRatio}`;
    return null;
  }

  opened() {
    this.open = true;
  }

  /** Record a finished contract's profit (negative for a loss). */
  closed(profit) {
    this.#rollDay();
    this.open = false;
    this.trades++;
    this.pnl += profit;
    if (profit > 0) {
      this.wins++;
      this.lossStreak = 0;
    } else {
      this.lossStreak++;
      if (this.maxConsecutiveLosses > 0 && this.lossStreak >= this.maxConsecutiveLosses) {
        this.cooldownUntil = this.now() + this.cooldownSeconds * 1000;
        this.lossStreak = 0;
      }
    }
  }

  /**
   * Rebuild today's state from the trade journal after a restart, so a crash or reboot
   * never resets the daily loss limit, the trade count or a losing-streak pause.
   * records: journal rows ({ finished, profit }) for the mode being traded.
   */
  restore(records) {
    this.#rollDay();
    const realNow = this.now;
    const today = records
      .filter((r) => typeof r.finished === 'string' && r.finished.slice(0, 10) === this.day && Number.isFinite(r.profit))
      .sort((a, b) => a.finished.localeCompare(b.finished));
    for (const r of today) {
      const t = Date.parse(r.finished);
      this.now = () => t; // a pause started by these trades runs from when they finished
      this.closed(r.profit);
    }
    this.now = realNow;
    return today.length;
  }

  summary() {
    return { day: this.day, trades: this.trades, wins: this.wins, pnl: Math.round(this.pnl * 100) / 100 };
  }
}
