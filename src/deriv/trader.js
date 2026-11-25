// The trading loop: ticks in -> strategy signal -> risk check -> quote -> buy (or paper trade) -> result.
import fs from 'node:fs';
import { RiskManager } from './risk.js';
import { getStrategy } from './strategy.js';
import { strategyParams } from './config.js';

const HISTORY_TICKS = 300;
const MAX_PRICES = 1000;

export class DerivTrader {
  /**
   * @param client   a DerivClient (or a fake with the same request/subscribe/connect/close)
   * @param settings from derivSettingsFromEnv()
   */
  constructor({ client, settings, log = console, risk, now = () => Date.now() }) {
    this.client = client;
    this.s = settings;
    this.log = log;
    this.now = now;
    this.risk = risk ?? new RiskManager(settings, now);
    this.signalFn = getStrategy(settings.strategy);
    this.params = strategyParams(settings);
    this.prices = [];
    this.tickCount = 0;
    this.paper = null; // open paper contract
    this.contract = null; // open live contract
    this.lastBlock = null;
    this.account = null;
    this.results = [];
  }

  get mode() {
    return this.s.live ? (this.account?.is_virtual ? 'LIVE (demo account)' : 'LIVE (REAL MONEY)') : 'PAPER';
  }

  async start() {
    await this.client.connect();
    if (this.s.token) {
      const { authorize } = await this.client.request({ authorize: this.s.token });
      this.account = authorize;
      this.s.currency = authorize.currency || this.s.currency;
      this.log.info(`Deriv account ${authorize.loginid} (${authorize.is_virtual ? 'demo' : 'REAL'}), balance ${authorize.balance} ${authorize.currency}`);
      if (this.s.live && !authorize.is_virtual && !this.s.allowReal) {
        throw new Error('DERIV_LIVE=true on a REAL-money account: set DERIV_ALLOW_REAL=true too if you really mean it (use a demo token first)');
      }
    }
    const { history } = await this.client.request({ ticks_history: this.s.symbol, end: 'latest', count: HISTORY_TICKS, style: 'ticks' });
    this.prices = (history?.prices ?? []).map(Number);
    this.tickStream = await this.client.subscribe({ ticks: this.s.symbol }, (m) => m.tick && this.onTick(Number(m.tick.quote)));
    this.log.info(`${this.mode}: ${this.s.symbol}, ${this.s.strategy}, stake ${this.s.stake} ${this.s.currency}, Rise/Fall over ${this.s.durationTicks} ticks`);
  }

  async stop() {
    await this.tickStream?.stop();
    this.client.close();
  }

  onTick(price) {
    this.tickCount++;
    this.prices.push(price);
    if (this.prices.length > MAX_PRICES) this.prices.splice(0, this.prices.length - MAX_PRICES);
    if (this.paper) return this.#advancePaper(price);
    if (this.busy || this.contract) return;
    const signal = this.signalFn(this.prices, this.params);
    if (!signal) return;
    const blocked = this.risk.blocked();
    if (blocked) {
      if (blocked !== this.lastBlock) this.log.info(`skip ${signal}: ${blocked}`);
      this.lastBlock = blocked;
      return;
    }
    this.lastBlock = null;
    this.trade(signal).catch((e) => {
      this.log.error(`trade failed: ${e.message}`);
      this.busy = false;
      if (!this.contract && !this.paper) this.risk.open = false;
    });
  }

  async trade(signal) {
    this.busy = true;
    this.risk.opened();
    const { proposal } = await this.client.request({
      proposal: 1,
      amount: this.s.stake,
      basis: 'stake',
      contract_type: signal,
      currency: this.s.currency,
      duration: this.s.durationTicks,
      duration_unit: 't',
      symbol: this.s.symbol,
    });
    const quote = { askPrice: Number(proposal.ask_price), payout: Number(proposal.payout) };
    const bad = this.risk.checkQuote(quote);
    if (bad) {
      this.log.info(`skip ${signal}: ${bad}`);
      this.risk.open = false;
      this.busy = false;
      return;
    }
    const base = { time: new Date(this.now()).toISOString(), mode: this.s.live ? 'live' : 'paper', symbol: this.s.symbol, signal, stake: quote.askPrice, payout: quote.payout };

    if (!this.s.live) {
      this.paper = { ...base, startTick: this.tickCount, entry: null };
      this.log.info(`PAPER ${signal} ${quote.askPrice} to win ${quote.payout} (${(quote.payout / quote.askPrice).toFixed(3)}x)`);
      this.busy = false;
      return;
    }

    // Buy at no more than the quoted price
    const { buy } = await this.client.request({ buy: proposal.id, price: quote.askPrice });
    this.contract = { ...base, contractId: buy.contract_id, stake: Number(buy.buy_price) };
    this.busy = false;
    this.log.info(`BUY ${signal} #${buy.contract_id} ${buy.buy_price} to win ${buy.payout}, balance ${buy.balance_after}`);
    await this.watchContract(buy.contract_id);
  }

  /** Follow a live contract until Deriv says it is sold (works again after a reconnect). */
  async watchContract(contractId) {
    const sub = await this.client.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (m) => {
      const poc = m.proposal_open_contract;
      if (!poc?.is_sold || !this.contract) return;
      sub?.stop();
      this.#finish({ ...this.contract, entry: Number(poc.entry_tick ?? poc.entry_spot), exit: Number(poc.exit_tick ?? poc.sell_spot), profit: Number(poc.profit), status: poc.status });
    });
    // The first message may already have been the sold one
    if (!this.contract) sub.stop();
  }

  #advancePaper(price) {
    const p = this.paper;
    if (p.entry === null) {
      p.entry = price; // the first tick after the buy is the entry spot
      p.entryTick = this.tickCount;
      return;
    }
    if (this.tickCount - p.entryTick < this.s.durationTicks) return;
    const won = p.signal === 'CALL' ? price > p.entry : price < p.entry; // equal = loss
    this.paper = null;
    this.#finish({ ...p, exit: price, profit: won ? p.payout - p.stake : -p.stake, status: won ? 'won' : 'lost' });
  }

  #finish(result) {
    const profit = Math.round(result.profit * 100) / 100;
    const record = { ...result, profit, finished: new Date(this.now()).toISOString() };
    delete record.startTick;
    delete record.entryTick;
    this.contract = null;
    this.risk.closed(profit);
    this.results.push(record);
    if (this.s.journalPath) {
      try { fs.appendFileSync(this.s.journalPath, JSON.stringify(record) + '\n'); } catch (e) { this.log.warn(`journal: ${e.message}`); }
    }
    const day = this.risk.summary();
    this.log.info(`${record.status.toUpperCase()} ${record.signal} ${record.entry} -> ${record.exit}: ${profit >= 0 ? '+' : ''}${profit} | today ${day.wins}/${day.trades} won, P&L ${day.pnl}`);
  }
}

/** Read the trade journal and summarise it (win rate vs the rate needed to break even). */
export function summarizeJournal(path) {
  if (!fs.existsSync(path)) return null;
  const rows = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const by = {};
  for (const r of rows) {
    const k = r.mode;
    const g = (by[k] ??= { trades: 0, wins: 0, staked: 0, profit: 0, payoutRatioSum: 0 });
    g.trades++;
    if (r.profit > 0) g.wins++;
    g.staked += r.stake;
    g.profit += r.profit;
    g.payoutRatioSum += r.payout / r.stake;
  }
  return Object.fromEntries(Object.entries(by).map(([k, g]) => [k, {
    trades: g.trades,
    winRate: g.wins / g.trades,
    breakEvenWinRate: g.trades / g.payoutRatioSum,
    profit: Math.round(g.profit * 100) / 100,
    roi: g.profit / g.staked,
  }]));
}
