#!/usr/bin/env node
// CLI: deriv-bot <run|backtest|balance|symbols|report|status>
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { SettingsError, loadDotenv } from '../src/config.js';
import { DerivClient } from '../src/deriv/client.js';
import { derivSettingsFromEnv, strategyParams } from '../src/deriv/config.js';
import { backtest } from '../src/deriv/strategy.js';
import { RiskManager } from '../src/deriv/risk.js';
import { DerivTrader, readJournal, summarizeJournal } from '../src/deriv/trader.js';

const HELP = `Usage: deriv-bot <command> [options]

Commands:
  run        trade Rise/Fall on DERIV_SYMBOL (paper unless DERIV_LIVE=true)   [default]
  backtest   replay the strategy on recent ticks (--count 5000)
  balance    print the account balance (needs DERIV_API_TOKEN)
  symbols    list markets that are open now
  report     win rate and profit from the trade journal
  status     is the running bot healthy? (exit code 1 if not; for health checks)

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

  if (cmd === 'status') {
    let st;
    try { st = JSON.parse(fs.readFileSync(s.statusPath, 'utf8')); } catch { console.log(`no ${s.statusPath}: the bot is not running here`); return 1; }
    const age = Math.round((Date.now() - Date.parse(st.updated)) / 1000);
    const tickAge = st.lastTick ? Math.round((Date.now() - Date.parse(st.lastTick)) / 1000) : null;
    console.log(`${st.mode} ${st.symbol}: status written ${age}s ago, last tick ${tickAge ?? '-'}s ago, today ${st.today.wins}/${st.today.trades} won, P&L ${st.today.pnl}${st.blocked ? ` (paused: ${st.blocked})` : ''}`);
    return age <= 120 && tickAge !== null && tickAge <= s.stallSeconds * 2 ? 0 : 1;
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

  // Today's limits survive restarts: rebuild them from the journal
  const risk = new RiskManager(s);
  const restored = risk.restore(readJournal(s.journalPath).filter((r) => r.mode === (s.live ? 'live' : 'paper')));
  if (restored) {
    const d = risk.summary();
    log.info(`restored today from ${s.journalPath}: ${d.wins}/${d.trades} won, P&L ${d.pnl}${risk.blocked() ? ` - ${risk.blocked()}` : ''}`);
  }

  let trader = null;
  let stopping = false;
  const retry = () => start().catch((e) => {
    log.error(`${e.message}; retrying in 30s`);
    if (!stopping) setTimeout(retry, 30000);
  });
  const start = async () => {
    const prev = trader;
    if (prev?.paper) risk.open = false; // a paper trade cut off by the disconnect is dropped
    trader = new DerivTrader({ client: client(), settings: s, log, risk });
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

  // Watchdog: a socket can hang without closing. No tick for DERIV_STALL_SECONDS -> reconnect.
  // It also writes DERIV_STATUS_FILE, which `deriv-bot status` reads.
  const watchdog = setInterval(() => {
    if (!trader || stopping) return;
    const quiet = (Date.now() - (trader.lastTickAt ?? Date.now())) / 1000;
    if (trader.lastTickAt && quiet > s.stallSeconds && trader.client.ws?.readyState === 1) {
      log.warn(`no tick for ${Math.round(quiet)}s, reconnecting`);
      trader.client.ws.close(); // fires onClose -> reconnect
    }
    try {
      fs.writeFileSync(s.statusPath, JSON.stringify({
        updated: new Date().toISOString(), pid: process.pid, mode: trader.mode, symbol: s.symbol,
        lastTick: trader.lastTickAt ? new Date(trader.lastTickAt).toISOString() : null,
        today: risk.summary(), blocked: risk.blocked() === 'a contract is still open' ? null : risk.blocked(),
      }));
    } catch (e) { log.warn(`status file: ${e.message}`); }
  }, 15000);

  // Ctrl+C, and SIGTERM from PM2 / Docker / systemd: let an open live contract finish first
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    clearInterval(watchdog);
    for (let i = 0; i < 30 && trader?.contract; i++) {
      if (i === 0) log.info(`${sig}: waiting for contract #${trader.contract.contractId} to finish`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const d = risk.summary();
    log.info(`stopping. today: ${d.wins}/${d.trades} won, P&L ${d.pnl}`);
    await trader?.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A bug must not leave a half-working bot: exit, and the supervisor starts a fresh one
  process.on('unhandledRejection', (e) => { log.error(`unexpected: ${e?.stack ?? e}`); process.exit(1); });
  process.on('uncaughtException', (e) => { log.error(`unexpected: ${e?.stack ?? e}`); process.exit(1); });
  await start();
}

main().then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch((e) => {
  log.error(e instanceof SettingsError || !process.env.DEBUG ? e.message : e.stack);
  process.exit(1);
});
