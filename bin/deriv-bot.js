#!/usr/bin/env node
// CLI: deriv-bot <run|backtest|balance|symbols|report>
import { parseArgs } from 'node:util';
import { SettingsError, loadDotenv } from '../src/config.js';
import { DerivClient } from '../src/deriv/client.js';
import { derivSettingsFromEnv, strategyParams } from '../src/deriv/config.js';
import { backtest } from '../src/deriv/strategy.js';
import { DerivTrader, summarizeJournal } from '../src/deriv/trader.js';

const HELP = `Usage: deriv-bot <command> [options]

Commands:
  run        trade Rise/Fall on DERIV_SYMBOL (paper unless DERIV_LIVE=true)   [default]
  backtest   replay the strategy on recent ticks (--count 5000)
  balance    print the account balance (needs DERIV_API_TOKEN)
  symbols    list markets that are open now
  report     win rate and profit from the trade journal

Options:
  --count N  ticks for backtest (max 5000)
  -h, --help
`;

const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (m) => console.log(`${stamp()} INFO  ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN  ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { count: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return console.log(HELP);
  loadDotenv();
  const s = derivSettingsFromEnv();
  const cmd = positionals[0] ?? 'run';
  const client = () => new DerivClient({ appId: s.appId, endpoint: s.endpoint, log });

  if (cmd === 'report') {
    const sum = summarizeJournal(s.journalPath);
    if (!sum) return console.log(`no trades in ${s.journalPath} yet`);
    for (const [mode, g] of Object.entries(sum)) {
      console.log(`${mode}: ${g.trades} trades, won ${(g.winRate * 100).toFixed(1)}% (break-even ${(g.breakEvenWinRate * 100).toFixed(1)}%), profit ${g.profit}, ROI ${(g.roi * 100).toFixed(2)}%`);
    }
    return;
  }

  if (cmd === 'symbols') {
    const c = await client().connect();
    const { active_symbols } = await c.request({ active_symbols: 'brief', product_type: 'basic' });
    for (const a of active_symbols.filter((x) => x.exchange_is_open)) console.log(`${a.symbol.padEnd(12)} ${a.market_display_name.padEnd(18)} ${a.display_name}`);
    return c.close();
  }

  if (cmd === 'balance') {
    if (!s.token) throw new SettingsError('set DERIV_API_TOKEN in .env first');
    const c = await client().connect();
    const { authorize } = await c.request({ authorize: s.token });
    console.log(`${authorize.loginid} (${authorize.is_virtual ? 'demo' : 'real'}): ${authorize.balance} ${authorize.currency}`);
    return c.close();
  }

  if (cmd === 'backtest') {
    const count = Math.min(Number(values.count ?? 5000), 5000);
    const c = await client().connect();
    const { history } = await c.request({ ticks_history: s.symbol, end: 'latest', count, style: 'ticks' });
    // Use a real quote for the payout ratio
    const { proposal } = await c.request({ proposal: 1, amount: s.stake, basis: 'stake', contract_type: 'CALL', currency: s.currency, duration: s.durationTicks, duration_unit: 't', symbol: s.symbol });
    c.close();
    const payoutRatio = Number(proposal.payout) / Number(proposal.ask_price);
    const r = backtest(history.prices.map(Number), { strategy: s.strategy, params: strategyParams(s), durationTicks: s.durationTicks, payoutRatio });
    console.log(`${s.symbol} ${s.strategy}, ${history.prices.length} ticks, payout ${payoutRatio.toFixed(3)}x`);
    console.log(`${r.trades} trades, won ${(r.winRate * 100).toFixed(1)}% (break-even ${(r.breakEvenWinRate * 100).toFixed(1)}%), ROI ${(r.roi * 100).toFixed(2)}% per trade`);
    return;
  }

  if (cmd !== 'run') throw new SettingsError(`unknown command ${cmd}\n\n${HELP}`);

  let trader = null;
  let stopping = false;
  const retry = () => start().catch((e) => {
    log.error(`${e.message}; retrying in 30s`);
    if (!stopping) setTimeout(retry, 30000);
  });
  const start = async () => {
    const prev = trader;
    if (prev?.paper) prev.risk.open = false; // a paper trade cut off by the disconnect is dropped
    trader = new DerivTrader({ client: client(), settings: s, log, risk: prev?.risk });
    trader.client.onClose = () => {
      if (stopping) return;
      log.warn('connection lost, reconnecting in 5s');
      setTimeout(retry, 5000);
    };
    try {
      await trader.start();
    } catch (e) {
      trader.client.onClose = null;
      trader.client.close();
      throw e;
    }
    // A live contract that was open when the connection dropped: follow it to the end
    if (prev?.contract) {
      trader.contract = prev.contract;
      await trader.watchContract(prev.contract.contractId);
    }
  };
  process.on('SIGINT', async () => {
    stopping = true;
    const d = trader?.risk.summary();
    log.info(`stopping. today: ${d?.wins ?? 0}/${d?.trades ?? 0} won, P&L ${d?.pnl ?? 0}`);
    await trader?.stop().catch(() => {});
    process.exit(0);
  });
  await start();
}

main().catch((e) => {
  log.error(e instanceof SettingsError || !process.env.DEBUG ? e.message : e.stack);
  process.exit(1);
});
