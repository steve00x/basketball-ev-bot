// Deriv WebSocket API client (no dependencies: Node 22+ has WebSocket built in).
// Protocol: https://api.deriv.com (JSON over one socket; replies matched by req_id).
export const DEFAULT_ENDPOINT = 'wss://ws.derivws.com/websockets/v3';

export class DerivError extends Error {
  constructor(code, message, request) {
    super(`${code}: ${message}`);
    this.code = code;
    this.request = request;
  }
}

/**
 * One connection to Deriv.
 *  - request(msg)            -> Promise of the reply (rejects with DerivError)
 *  - subscribe(msg, onData)  -> Promise of { id, first, stop() }; onData gets every update
 * Sends a ping every 30 s (Deriv closes idle sockets after ~2 min).
 */
export class DerivClient {
  constructor({ appId, endpoint = DEFAULT_ENDPOINT, socketFactory, log = console, timeoutMs = 30000, pingMs = 30000 } = {}) {
    if (!appId) throw new Error('DERIV_APP_ID is missing');
    this.url = `${endpoint}?app_id=${encodeURIComponent(appId)}&l=EN`;
    this.socketFactory = socketFactory ?? ((url) => new WebSocket(url));
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.pingMs = pingMs;
    this.nextId = 1;
    this.pending = new Map(); // req_id -> {resolve, reject, timer, onData}
    this.streams = new Map(); // req_id -> onData, for subscriptions
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.socketFactory(this.url);
      this.ws = ws;
      ws.onopen = () => {
        if (this.pingMs) this.pinger = setInterval(() => this.request({ ping: 1 }).catch(() => {}), this.pingMs);
        resolve(this);
      };
      ws.onerror = (e) => reject(new Error(`cannot connect to Deriv: ${e?.message ?? 'network error'}`));
      ws.onmessage = (ev) => this.#handle(ev.data);
      ws.onclose = () => {
        clearInterval(this.pinger);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Deriv connection closed')); }
        this.pending.clear();
        this.streams.clear();
        this.onClose?.();
      };
    });
  }

  close() {
    clearInterval(this.pinger);
    this.onClose = null;
    this.ws?.close();
  }

  request(msg) {
    return this.#send(msg, null);
  }

  /** Start a subscription. Resolves after the first message, which is also passed to onData. */
  async subscribe(msg, onData) {
    const first = await this.#send({ ...msg, subscribe: 1 }, onData);
    const id = first.subscription?.id;
    return {
      id,
      first,
      stop: () => (id ? this.request({ forget: id }).catch(() => {}) : Promise.resolve()),
    };
  }

  #send(msg, onData) {
    const reqId = this.nextId++;
    const payload = { ...msg, req_id: reqId };
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('not connected to Deriv'));
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Deriv did not answer ${Object.keys(msg)[0]} within ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer, onData });
      this.ws.send(JSON.stringify(payload));
    });
  }

  #handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.log.warn?.(`Deriv sent non-JSON: ${String(raw).slice(0, 80)}`); }
    const reqId = msg.req_id;
    const p = this.pending.get(reqId);
    if (p) {
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      if (msg.error) return p.reject(new DerivError(msg.error.code, msg.error.message, msg.echo_req));
      if (p.onData) {
        this.streams.set(reqId, p.onData);
        p.onData(msg);
      }
      return p.resolve(msg);
    }
    const stream = this.streams.get(reqId);
    if (!stream) return;
    if (msg.error) {
      this.streams.delete(reqId);
      return this.log.warn?.(`Deriv subscription error ${msg.error.code}: ${msg.error.message}`);
    }
    stream(msg);
  }
}
