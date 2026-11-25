import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DerivClient, DerivError } from '../src/deriv/client.js';
import { makeDerivSettings, validateDerivSettings } from '../src/deriv/config.js';
import { RiskManager } from '../src/deriv/risk.js';
import { backtest, ema, emaCross, momentum, rsi } from '../src/deriv/strategy.js';
import { DerivTrader, summarizeJournal } from '../src/deriv/trader.js';

const quiet = { info() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));

/** A fake Deriv socket. handler(msg, socket) returns a reply (or nothing); socket.push() sends stream updates. */
function fakeSocketFactory(handler) {
  const sent = [];
  const sockets = [];
  const factory = () => {
    const ws = {
      readyState: 1,
      send(raw) {
        const msg = JSON.parse(raw);
        sent.push(msg);
        const reply = handler(msg, ws);
        if (reply) setImmediate(() => ws.onmessage({ data: JSON.stringify({ req_id: msg.req_id, echo_req: msg, ...reply }) }));
      },
      push(reqId, data) { ws.onmessage({ data: JSON.stringify({ req_id: reqId, ...data }) }); },
      close() { ws.readyState = 3; ws.onclose?.(); },
    };
    sockets.push(ws);
    setImmediate(() => ws.onopen());
    return ws;
  };
  return { factory, sent, sockets };
}

test('client: replies are matched by req_id, errors become DerivError, app_id goes in the URL', async () => {
  let url;
  const { factory } = fakeSocketFactory((m) => (m.ping ? { msg_type: 'ping', ping: 'pong' } : { error: { code: 'InvalidToken', message: 'bad token' } }));
  const c = new DerivClient({ appId: '1234', socketFactory: (u) => { url = u; return factory(u); }, pingMs: 0, log: quiet });
  await c.connect();
  assert.match(url, /app_id=1234/);
  assert.equal((await c.request({ ping: 1 })).ping, 'pong');
  await assert.rejects(c.request({ authorize: 'x' }), (e) => e instanceof DerivError && e.code === 'InvalidToken');
  c.close();
});

test('client: subscriptions get every update and forget on stop', async () => {
  const { factory, sent, sockets } = fakeSocketFactory((m) => {
    if (m.ticks) return { msg_type: 'tick', tick: { quote: 1 }, subscription: { id: 'sub1' } };
    if (m.forget) return { forget: 1 };
  });
  const c = new DerivClient({ appId: '1', socketFactory: factory, pingMs: 0, log: quiet });
  await c.connect();
  const got = [];
  const sub = await c.subscribe({ ticks: 'R_100' }, (m) => got.push(m.tick.quote));
  const reqId = sent[0].req_id;
  assert.equal(sent[0].subscribe, 1);
  sockets[0].push(reqId, { msg_type: 'tick', tick: { quote: 2 } });
  sockets[0].push(reqId, { msg_type: 'tick', tick: { quote: 3 } });
  assert.deepEqual(got, [1, 2, 3]);
  await sub.stop();
  assert.deepEqual(sent.at(-1).forget, 'sub1');
  c.close();
});

test('strategy: EMA, RSI, crossover and momentum signals', () => {
  assert.deepEqual(ema([1, 2, 3, 4], 2), [1.5, 2.5, 3.5]);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => i)), 100);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => -i)), 0);
  // falling then a sharp rise: fast EMA crosses above slow
  const down = Array.from({ length: 30 }, (_, i) => 100 - i * 0.1);
  const up = [...down, 98, 99.5];
  assert.equal(emaCross(up.slice(0, -1), { fast: 3, slow: 10, rsiHigh: 101 }) , null);
  const series = [...down];
  let sig = null;
  for (const p of [97.5, 98, 99, 100]) { series.push(p); sig ??= emaCross(series, { fast: 3, slow: 10, rsiHigh: 101 }); }
  assert.equal(sig, 'CALL');
  assert.equal(momentum([1, 2, 3, 4, 5], { run: 4 }), 'CALL');
  assert.equal(momentum([5, 4, 3, 2, 1], { run: 4 }), 'PUT');
  assert.equal(momentum([1, 2, 2, 3, 4], { run: 4 }), null);
});

test('backtest: equal exit price loses; break-even win rate comes from the payout', () => {
  const prices = [1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  const r = backtest(prices, { strategy: 'momentum', params: { run: 4 }, durationTicks: 2, payoutRatio: 1.95 });
  assert.equal(r.trades, 1);
  assert.equal(r.wins, 0);
  assert.equal(r.profitPerUnit, -1);
  assert.ok(Math.abs(r.breakEvenWinRate - 1 / 1.95) < 1e-9);
});

test('risk: daily loss limit, trade limit, cooldown after a losing streak, payout floor, next day resets', () => {
  let t = Date.parse('2026-11-25T10:00:00Z');
  const r = new RiskManager({ stake: 2, maxDailyLoss: 5, maxDailyTrades: 10, maxConsecutiveLosses: 2, cooldownSeconds: 60, minPayoutRatio: 1.8 }, () => t);
  assert.equal(r.blocked(), null);
  assert.match(r.checkQuote({ askPrice: 2, payout: 3.5 }), /below/);
  assert.equal(r.checkQuote({ askPrice: 2, payout: 3.9 }), null);
  assert.match(r.checkQuote({ askPrice: 3, payout: 6 }), /above the stake/);
  r.closed(-2);
  r.closed(-2);
  assert.match(r.blocked(), /cooling down/);
  t += 61_000;
  assert.match(r.blocked(), /would exceed the daily loss limit/); // -4 now, another -2 would be -6
  r.closed(1.9);
  assert.equal(r.blocked(), null);
  r.closed(-2);
  r.closed(-2);
  assert.match(r.blocked(), /daily loss limit|cooling/);
  t += 24 * 3600_000;
  assert.equal(r.blocked(), null);
  assert.equal(r.summary().trades, 0);
});

test('settings: unsafe values are refused', () => {
  assert.throws(() => validateDerivSettings(makeDerivSettings({ stake: 0 })), /STAKE/);
  assert.throws(() => validateDerivSettings(makeDerivSettings({ stake: 20, maxDailyLoss: 10 })), /larger/);
  assert.throws(() => validateDerivSettings(makeDerivSettings({ durationTicks: 11 })), /DURATION/);
  assert.throws(() => validateDerivSettings(makeDerivSettings({ live: true, token: '' })), /TOKEN/);
  assert.doesNotThrow(() => validateDerivSettings(makeDerivSettings()));
});

/** A fake Deriv server for the trader. */
function fakeDeriv({ isVirtual = 1, sold = 'won' } = {}) {
  const state = { tickReq: null, pocReq: null, bought: [] };
  const fake = fakeSocketFactory((m) => {
    if (m.authorize) return { authorize: { loginid: isVirtual ? 'VRTC1' : 'CR1', is_virtual: isVirtual, currency: 'USD', balance: 10000 } };
    if (m.ticks_history) return { history: { prices: Array.from({ length: 50 }, () => 100) } };
    if (m.ticks) { state.tickReq = m.req_id; return { tick: { quote: 100 }, subscription: { id: 't1' } }; }
    if (m.proposal) return { proposal: { id: 'p1', ask_price: m.amount, payout: m.amount * 1.95 } };
    if (m.buy) { state.bought.push(m); return { buy: { contract_id: 42, buy_price: m.price, payout: m.price * 1.95, balance_after: 9999 } }; }
    if (m.proposal_open_contract) {
      state.pocReq = m.req_id;
      return { proposal_open_contract: { contract_id: 42, is_sold: 0, status: 'open' }, subscription: { id: 'c1' } };
    }
    if (m.forget) return { forget: 1 };
  });
  state.pushTick = (q) => fake.sockets[0].push(state.tickReq, { tick: { quote: q } });
  state.sell = () => fake.sockets[0].push(state.pocReq, {
    proposal_open_contract: { contract_id: 42, is_sold: 1, status: sold, profit: sold === 'won' ? 0.95 : -1, entry_tick: 100, exit_tick: 101 },
  });
  return { ...fake, state };
}

function journal() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deriv-')), 'trades.jsonl');
}

test('paper trade: quotes but never buys; result from the ticks after entry', async () => {
  const d = fakeDeriv();
  const jp = journal();
  const s = makeDerivSettings({ strategy: 'momentum', momentumRun: 3, durationTicks: 2, journalPath: jp });
  const trader = new DerivTrader({ client: new DerivClient({ appId: '1', socketFactory: d.factory, pingMs: 0, log: quiet }), settings: s, log: quiet });
  await trader.start();
  for (const q of [101, 102, 103]) d.state.pushTick(q); // 3 rises -> CALL
  await tick(); await tick();
  assert.ok(trader.paper, 'paper contract opened');
  for (const q of [104, 104.5, 105]) d.state.pushTick(q); // entry 104, exit 105 after 2 ticks
  assert.equal(trader.paper, null);
  assert.equal(trader.results.length, 1);
  assert.equal(trader.results[0].status, 'won');
  assert.equal(trader.results[0].profit, 0.95);
  assert.equal(d.sent.some((m) => m.buy), false);
  assert.equal(summarizeJournal(jp).paper.trades, 1);
  await trader.stop();
});

test('live trade on demo: buys at the quoted price and records Deriv\'s result', async () => {
  const d = fakeDeriv({ sold: 'lost' });
  const s = makeDerivSettings({ live: true, token: 'tok', strategy: 'momentum', momentumRun: 3, journalPath: journal() });
  const trader = new DerivTrader({ client: new DerivClient({ appId: '1', socketFactory: d.factory, pingMs: 0, log: quiet }), settings: s, log: quiet });
  await trader.start();
  assert.match(trader.mode, /demo/);
  for (const q of [99, 98, 97]) d.state.pushTick(q); // PUT
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(d.state.bought.map((b) => [b.buy, b.price]), [['p1', 1]]);
  assert.equal(d.sent.find((m) => m.proposal).contract_type, 'PUT');
  d.state.sell();
  assert.equal(trader.results[0].profit, -1);
  assert.equal(trader.risk.summary().trades, 1);
  await trader.stop();
});

test('live on a real-money account is refused unless DERIV_ALLOW_REAL=true', async () => {
  const d = fakeDeriv({ isVirtual: 0 });
  const s = makeDerivSettings({ live: true, token: 'tok', journalPath: journal() });
  const trader = new DerivTrader({ client: new DerivClient({ appId: '1', socketFactory: d.factory, pingMs: 0, log: quiet }), settings: s, log: quiet });
  await assert.rejects(trader.start(), /REAL/);
});
