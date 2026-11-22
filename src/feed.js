// Event feeds. Both emit: 'create', 'trade', 'migrate', 'status'.
//  - PumpPortalFeed: the real thing (free PumpPortal websocket)
//  - DemoFeed: simulated launches (organic runners, bundles, wash trading...) for trying
//    the bot without any keys. Demo coins are fake.
import { EventEmitter } from 'node:events';

export class PumpPortalFeed extends EventEmitter {
  /**
   * opts.tradeSilenceMs: trade messages must arrive at least this often while ≥ opts.minWatchedForWatchdog coins
   * are subscribed; otherwise re-subscribe, and if trades still don't come back, reconnect.
   * opts.WebSocketImpl / opts.now: injectable for tests.
   */
  constructor(url, log = console, { tradeSilenceMs = 60_000, minWatchedForWatchdog = 10, statusLogMs = 5 * 60_000, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), backoffMs = 1000,
    watchdogBackoffMs = [2, 5, 15, 30].map((m) => m * 60_000) } = {}) {
    super();
    this.url = url; this.log = log;
    Object.assign(this, { tradeSilenceMs, minWatchedForWatchdog, WebSocketImpl, now, backoffMs, watchdogBackoffMs });
    this.watchdogStrikes = 0;        // watchdog reconnects in a row without a trade in between (picks the backoff step)
    this.resubscribedThisConn = false; // the watchdog re-subscribes at most ONCE per connection
    this.subAt = new Map();          // mint -> when its subscribeTokenTrade was actually sent on THIS connection
    this.mintTradeAt = new Map();    // mint -> last trade message received for it (subscribed coins only)
    // separate health signals: discovery (new coins) vs trades (prices)
    this.lastCreateAt = 0;
    this.lastTradeAt = 0;
    this.connectedAt = 0;
    this.counts = { creates: 0, trades: 0, migrations: 0, acks: 0, serverErrors: 0, subscribeMsgs: 0, keysSubscribed: 0, resubscribes: 0, tradeWatchdogReconnects: 0 };
    this.lastAck = '';
    this.resubscribedAt = 0;
    this.watched = new Set();
    this.pendingSub = new Set();
    this.pendingUnsub = new Set();
    this.pinned = new Set();        // coins the market-data hub needs: never unsubscribed by the engine's cleanup
    this.accounts = new Set();      // wallets followed for copy trading (subscribeAccountTrade)
    this.pendingAccSub = new Set();
    this.pendingAccUnsub = new Set();
    this.connected = false;
    this.backoff = backoffMs;
    this.lastMsgAt = 0;
    this.lastProblem = '';
    this.reconnects = 0;
    setInterval(() => this.flush(), 300).unref();
    // Watchdog: a connection can stay "open" but stop delivering data. New coins launch every few
    // seconds, so 90s of silence means the feed is stuck - drop it and reconnect.
    setInterval(() => {
      if (this.connected && this.now() - this.lastMsgAt > 90_000) this.failCurrent?.('no data for 90s');
    }, 15_000).unref();
    // Trade watchdog: new-coin messages alone must not make the feed look healthy
    setInterval(() => this.checkTrades(), 15_000).unref();
    // A periodic status line, so the logs show whether trades are actually flowing
    if (statusLogMs) setInterval(() => this.log.info(`PumpPortal status: ${this.statusLine()}`), statusLogMs).unref();
  }

  statusLine() {
    const t = this.now(), ago = (x) => (x ? `${Math.round((t - x) / 1000)}s ago` : 'never');
    return `${this.connected ? 'connected' : 'DISCONNECTED'} · ${this.watched.size} coins subscribed · last new coin ${ago(this.lastCreateAt)} · last trade ${ago(this.lastTradeAt)} · ` +
      `${this.counts.creates} new coins / ${this.counts.trades} trades since start · ${this.counts.acks} subscription acks · ${this.counts.serverErrors} server errors · ${this.reconnects} reconnects`;
  }

  /**
   * Trades healthy = connected AND at least one trade arrived on THIS connection (unconfirmed after a (re)connect
   * until then) AND, when enough coins are subscribed to judge, a trade arrived within maxSilenceMs.
   */
  tradesHealthy(maxSilenceMs = this.tradeSilenceMs) {
    if (!this.connected || !this.lastTradeAt || this.lastTradeAt < this.connectedAt) return false;
    if (this.watched.size < this.minWatchedForWatchdog) return true;
    return this.now() - this.lastTradeAt <= maxSilenceMs;
  }

  /** This coin's subscription is proven: a trade for it arrived after its subscription was sent on this connection. */
  tradeProven(mint) {
    const s = this.subAt.get(mint), t = this.mintTradeAt.get(mint);
    return s != null && t != null && t >= s;
  }

  /**
   * Discovery continues but trades stopped.
   * Step 1 (once per connection): after tradeSilenceMs of silence, re-subscribe everything.
   * Step 2: reconnect only after watchdogBackoffMs[strikes] of silence on this connection (2, 5, 15, then every 30 min),
   * so a feed that never sends trades costs at most one re-subscribe burst + one reconnect per step - never a loop.
   * The step resets as soon as any trade arrives. New entries stay blocked the whole time (tradesHealthy() is false).
   */
  checkTrades() {
    if (!this.connected || this.watched.size < this.minWatchedForWatchdog) return;
    const t = this.now();
    const since = Math.max(this.lastTradeAt, this.connectedAt);
    const silent = t - since;
    if (silent <= this.tradeSilenceMs) return;
    const lastNew = this.lastCreateAt ? Math.round((t - this.lastCreateAt) / 1000) + 's ago' : 'never';
    if (!this.resubscribedThisConn) {
      this.resubscribedThisConn = true;
      this.resubscribedAt = t;
      this.counts.resubscribes++;
      for (const m of this.watched) this.pendingSub.add(m);
      for (const a of this.accounts) this.pendingAccSub.add(a);
      this.log.warn(`PumpPortal: no trade messages for ${Math.round(silent / 1000)}s while ${this.watched.size} coins are subscribed (last new coin ${lastNew}) — re-subscribing once on this connection; new paper entries blocked`);
      this.emit('status', { connected: true, trades: false, problem: 'trade messages missing' });
      return;
    }
    const steps = this.watchdogBackoffMs;
    const wait = steps[Math.min(this.watchdogStrikes, steps.length - 1)];
    if (silent < wait) return;
    this.watchdogStrikes++;
    this.counts.tradeWatchdogReconnects++;
    const next = steps[Math.min(this.watchdogStrikes, steps.length - 1)];
    this.log.warn(`PumpPortal: still no trade messages after ${Math.round(silent / 60_000)} min (re-subscribe did not help; last new coin ${lastNew}) — watchdog reconnect #${this.watchdogStrikes}; next one only after ${Math.round(next / 60_000)} min more silence`);
    this.failCurrent?.(`no trade messages for ${Math.round(silent / 1000)}s even after re-subscribing`);
  }

  start() { this.#connect(); }

  /**
   * One connection attempt. ANY way it can fail - error, close, a handshake that never completes,
   * or (via the watchdog) silence - ends this attempt exactly once and schedules a fresh one.
   * (Node's WebSocket does not fire "close" after a failed handshake, so relying on onclose alone
   * could leave the bot offline forever.)
   */
  #connect() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    let finished = false;
    const fail = (why) => {
      if (finished) return;
      finished = true;
      clearTimeout(openTimer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* already gone */ }
      this.connected = false;
      this.reconnects++;
      this.lastProblem = `${new Date().toISOString().slice(11, 19)} ${why}`;
      this.emit('status', { connected: false, problem: this.lastProblem });
      this.log.warn(`PumpPortal ${why} - reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => this.#connect(), this.backoff).unref?.(); // the HTTP server keeps the process alive
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    this.failCurrent = fail;
    const openTimer = setTimeout(() => fail('connection timed out'), 15_000);
    openTimer.unref?.();

    ws.onopen = () => {
      clearTimeout(openTimer);
      this.connected = true; this.backoff = this.backoffMs; this.lastMsgAt = this.now(); this.connectedAt = this.now(); this.resubscribedAt = 0; this.resubscribedThisConn = false;
      this.subAt.clear(); this.mintTradeAt.clear(); // every coin must prove its subscription again on the new connection
      // "connected" = the websocket opened. Subscriptions are confirmed separately (acks) and by trades arriving.
      this.log.info(`PumpPortal connected (websocket open) — subscribing to new coins, migrations and ${this.watched.size} coins' trades`);
      this.emit('status', { connected: true });
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      for (const m of this.watched) this.pendingSub.add(m);
      for (const a of this.accounts) this.pendingAccSub.add(a);
    };
    ws.onmessage = (ev) => {
      const rx = this.now();
      this.lastMsgAt = rx;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === 'object') msg._rx = rx; // when the bot received it (for freshness and latency)
      if (!msg.mint || !msg.txType) {
        // Not a market event: a subscription acknowledgement, or an error (rate limits, bans, bad keys...)
        const text = JSON.stringify(msg).slice(0, 300);
        if (/error|limit|denied|invalid|banned|forbidden|exceed|too many|unauthori|payment|balance/i.test(text)) {
          this.counts.serverErrors++;
          this.lastProblem = `${new Date().toISOString().slice(11, 19)} server says: ${text}`;
          this.log.warn(`PumpPortal ${this.lastProblem}`);
        } else {
          this.counts.acks++;
          this.lastAck = text;
          if (this.counts.acks <= 3 || this.counts.acks % 500 === 0) this.log.info(`PumpPortal ack #${this.counts.acks}: ${text}`);
        }
        return;
      }
      if (msg.txType === 'create') { this.lastCreateAt = rx; this.counts.creates++; this.emit('create', msg); }
      else if (msg.txType === 'buy' || msg.txType === 'sell') {
        if (!this.lastTradeAt) this.log.info(`PumpPortal: first trade message received (${msg.pool ?? 'pump'} ${msg.txType})`);
        this.lastTradeAt = rx; this.counts.trades++; this.watchdogStrikes = 0;
        if (this.watched.has(msg.mint)) this.mintTradeAt.set(msg.mint, rx);
        this.emit('trade', msg);
      } else if (msg.txType === 'migrate' || msg.txType === 'migration') { this.counts.migrations++; this.emit('migrate', msg); }
      else {
        this.counts.serverErrors++;
        this.log.warn(`PumpPortal: unrecognised message type "${String(msg.txType).slice(0, 40)}" — ignored`);
      }
    };
    ws.onclose = (ev) => fail(`closed (code ${ev?.code ?? '?'}${ev?.reason ? `, reason: ${ev.reason}` : ''})`);
    ws.onerror = (ev) => fail(`connection error${ev?.message ? `: ${ev.message}` : ''}`);
  }

  watch(mint) { this.watched.add(mint); this.pendingUnsub.delete(mint); this.pendingSub.add(mint); }
  unwatch(mint) { if (this.pinned.has(mint)) return; this.watched.delete(mint); this.pendingSub.delete(mint); this.pendingUnsub.add(mint); this.subAt.delete(mint); this.mintTradeAt.delete(mint); }
  pin(mint) { this.pinned.add(mint); }
  unpin(mint) { this.pinned.delete(mint); }
  /** Follow every trade a wallet makes (copy trading). */
  watchAccount(w) { this.accounts.add(w); this.pendingAccUnsub.delete(w); this.pendingAccSub.add(w); }
  unwatchAccount(w) { this.accounts.delete(w); this.pendingAccSub.delete(w); this.pendingAccUnsub.add(w); }

  /** Send queued (un)subscriptions in batches of 100 (runs every 300 ms). */
  flush() {
    if (!this.connected || this.ws?.readyState !== 1 /* OPEN */) return;
    const send = (method, set) => {
      const keys = [...set]; set.clear();
      for (let i = 0; i < keys.length; i += 100) {
        try {
          this.ws.send(JSON.stringify({ method, keys: keys.slice(i, i + 100) }));
          this.counts.subscribeMsgs++;
          if (method === 'subscribeTokenTrade') {
            this.counts.keysSubscribed += Math.min(100, keys.length - i);
            const at = this.now();
            for (const k of keys.slice(i, i + 100)) this.subAt.set(k, at);
          }
        } catch (e) {
          // put them back: they are sent again on the next flush or after reconnecting
          for (const k of keys.slice(i)) set.add(k);
          this.log.warn(`PumpPortal: ${method} send failed (${e.message}) — will retry`);
          return;
        }
      }
    };
    if (this.pendingSub.size) send('subscribeTokenTrade', this.pendingSub);
    if (this.pendingUnsub.size) send('unsubscribeTokenTrade', this.pendingUnsub);
    if (this.pendingAccSub.size) send('subscribeAccountTrade', this.pendingAccSub);
    if (this.pendingAccUnsub.size) send('unsubscribeAccountTrade', this.pendingAccUnsub);
  }
}

// ---------------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rid = (n = 44) => Array.from({ length: n }, () => B58[Math.floor(Math.random() * 58)]).join('');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.random() * (b - a);

const THEMES = [
  ['Robo Hamster', 'RHAM', 'the hamster that runs the AI datacenter', 'hamster robot'],
  ['Hamster Bank', 'HBANK', 'hamster saves for winter. you should too', 'hamster'],
  ['Moon Robot', 'MROBO', 'AI robot buys only green candles', 'robot'],
  ['Grumpy Penguin', 'GRUMP', 'he did not ask to be here', 'penguin'],
  ['Penguin Sprint', 'PSPRINT', 'the fastest penguin on solana', 'penguin'],
  ['Wizard Goose', 'WGOOSE', 'goose with a staff. honk', 'goose wizard'],
  ['Tiny Dragon', 'TDRAG', 'smol dragon big dreams', 'dragon'],
  ['Office Capybara', 'CAPY', 'capybara attends every meeting', 'capybara'],
  ['Robot Capybara', 'RCAPY', 'capybara but chrome', 'capybara robot'],
  ['Banana Cat', 'BCAT', 'it is a cat. in a banana', 'cat banana'],
];

export class DemoChain {
  constructor() { this.enabled = true; this.slots = new Map(); this.wallets = new Map(); }
  async getSignatureSlots(mint) { return this.slots.get(mint) ?? new Map(); }
  async getWalletInfo(w) { return this.wallets.get(w) ?? { funder: rid(), fundedSol: 1, txCount: '50+', fresh: false }; }
  async isService() { return false; }
}

/** Demo wallets that trade like a real trader: buy, add, sell in parts, exit, sometimes re-enter. */
export const DEMO_TRADERS = ['DemoSmartTrader1111111111111111111111111111', 'DemoQuickTrader2222222222222222222222222222'];

export class DemoFeed extends EventEmitter {
  constructor(chain, log = console, xSource = null) {
    super(); this.chain = chain; this.log = log; this.xSource = xSource; this.watched = new Set(); this.accounts = new Set(); this.pinned = new Set(); this.connected = true;
    this.demoTraders = DEMO_TRADERS;
    this.lastMsgAt = Date.now();
    this.reconnects = 0;
    setInterval(() => { this.lastMsgAt = Date.now(); }, 1000).unref?.(); // the simulator is always "connected"
  }
  emit(type, msg) {
    if (msg && typeof msg === 'object' && type !== 'status') {
      msg._rx = Date.now(); this.lastMsgAt = msg._rx;
      if (type === 'trade') this.lastTradeAt = msg._rx; else if (type === 'create') this.lastCreateAt = msg._rx;
    }
    return super.emit(type, msg);
  }
  tradesHealthy() { return true; } // the simulator always delivers trades for watched coins
  tradeProven() { return true; }
  statusLine() { return 'demo simulator'; }
  watch(m) { this.watched.add(m); }
  unwatch(m) { if (this.pinned.has(m)) return; this.watched.delete(m); }
  pin(m) { this.pinned.add(m); }
  unpin(m) { this.pinned.delete(m); }
  watchAccount(w) { this.accounts.add(w); }
  unwatchAccount(w) { this.accounts.delete(w); }

  start() {
    this.log.info('DEMO MODE - simulated coins, not real');
    this.emit('status', { connected: true, demo: true });
    const devs = [rid(), rid()];
    const launch = () => {
      const r = Math.random();
      const scenario = r < 0.12 ? 'pullback' : r < 0.3 ? 'runner' : r < 0.47 ? 'bundled' : r < 0.55 ? 'wash' : r < 0.62 ? 'serial' : 'dead';
      this.#runCoin(scenario, scenario === 'serial' ? pick(devs) : rid());
      setTimeout(launch, rnd(2500, 5000));
    };
    for (let i = 0; i < 4; i++) setTimeout(() => this.#runCoin(i % 2 ? 'runner' : 'bundled', rid()), i * 400);
    setTimeout(launch, 1500);
  }

  #runCoin(scenario, creator) {
    const [name, symbol, description, _w] = pick(THEMES);
    const mint = rid(40) + 'pump';
    let vSol = 30, vTokens = 1_073_000_000;
    const k = vSol * vTokens;
    let slot = 300_000_000 + Math.floor(Math.random() * 1e6);
    const slots = new Map();
    this.chain.slots.set(mint, slots);
    const bal = new Map();
    const createSlot = slot;

    let finished = false;
    const trade = (trader, side, amount, atSlot = ++slot) => {
      if (finished) return 'done';
      let tokens, sol;
      if (side === 'buy') { sol = amount; tokens = vTokens - k / (vSol + sol); vSol += sol; vTokens -= tokens; }
      else { tokens = Math.min(amount, bal.get(trader) ?? 0); if (tokens <= 0) return; sol = vSol - k / (vTokens + tokens); vTokens += tokens; vSol -= sol; }
      bal.set(trader, Math.max(0, (bal.get(trader) ?? 0) + (side === 'buy' ? tokens : -tokens)));
      const signature = rid(88);
      slots.set(signature, atSlot);
      if (!this.watched.has(mint) && !this.accounts.has(trader)) return;
      this.emit('trade', { signature, mint, traderPublicKey: trader, txType: side, tokenAmount: tokens,
        solAmount: sol, newTokenBalance: bal.get(trader), vTokensInBondingCurve: vTokens,
        vSolInBondingCurve: vSol, marketCapSol: (vSol / vTokens) * 1e9 });
      if (vTokens <= 279_900_000 + 1000) { finished = true; this.emit('migrate', { mint, txType: 'migrate' }); return 'done'; }
    };

    // creation (dev buys a little)
    const devBuy = scenario === 'bundled' ? rnd(1, 3) : rnd(0.1, 1);
    const devTokens = vTokens - k / (vSol + devBuy); vSol += devBuy; vTokens -= devTokens; bal.set(creator, devTokens);
    const createSig = rid(88);
    slots.set(createSig, createSlot);
    this.chain.wallets.set(creator, { funder: rid(), fundedSol: 5, txCount: '50+', fresh: false });
    const tw = scenario === 'runner' && Math.random() < 0.6
      ? `https://x.com/${symbol.toLowerCase()}_demo/status/${Math.floor(rnd(1e18, 9e18))}`
      : Math.random() < 0.5 ? `https://x.com/${symbol.toLowerCase()}${Math.floor(rnd(1, 99))}` : '';
    this.emit('create', { signature: createSig, mint, traderPublicKey: creator, txType: 'create',
      initialBuy: devTokens, solAmount: devBuy, vTokensInBondingCurve: vTokens, vSolInBondingCurve: vSol,
      marketCapSol: (vSol / vTokens) * 1e9, name, symbol, uri: '',
      _meta: { description: description + (Math.random() < 0.3 ? ' Deployed using https://j7tracker.io' : ''),
        image: Math.random() < 0.5 ? `https://ipfs.io/ipfs/Qm${symbol}DemoImage00000000000000000000000` : '', twitter: (Math.random() < 0.6 && this.xSource?.randomPostFor(symbol)?.url) || tw, telegram: Math.random() < 0.5 ? `https://t.me/${symbol.toLowerCase()}` : '', website: '' } });

    // bundle: several fresh wallets, same funder, same block as create
    const insiders = [];
    if (scenario === 'bundled' || (scenario === 'serial' && Math.random() < 0.5)) {
      const funder = Math.random() < 0.3 ? creator : rid();
      const n = Math.floor(rnd(4, 9));
      setTimeout(() => {
        for (let i = 0; i < n; i++) {
          const w = rid(); insiders.push(w);
          this.chain.wallets.set(w, { funder, fundedSol: rnd(1, 3), txCount: 2, fresh: true });
          trade(w, 'buy', rnd(0.8, 2.2), createSlot);
        }
      }, 50);
    }

    // organic flow
    const organic = [];
    const newWallet = () => {
      const w = rid();
      this.chain.wallets.set(w, { funder: rid(), fundedSol: rnd(0.5, 20), txCount: Math.random() < 0.15 ? 3 : '50+', fresh: Math.random() < 0.15 });
      organic.push(w); return w;
    };
    const washers = [rid(), rid(), rid()];
    if (scenario === 'pullback') {
      // Setuh "New Pairs" shape: launch → ~3x run → ~55% pullback → a floor that holds → buyers come back
      const mc = () => (vSol / vTokens) * 1e9;
      const startMc = mc();
      let phase = 'run', peak = 0, floorUntil = 0, buyersLeft = 12, afterSteps = 0;
      const holders = [];
      const step2 = () => {
        if (finished) return;
        let res, wait = rnd(250, 600);
        if (phase === 'run') {
          const w = newWallet(); holders.push(w);
          res = trade(w, 'buy', rnd(0.9, 1.4));
          if (mc() >= startMc * 3.1) { phase = 'pull'; peak = mc(); }
        } else if (phase === 'pull') {
          const w = holders.shift() ?? pick(organic);
          res = trade(w, 'sell', (bal.get(w) ?? 0) * rnd(0.6, 1));
          wait = rnd(400, 900);
          if (mc() <= peak * 0.46) { phase = 'floor'; floorUntil = Date.now() + 95_000; }
        } else if (phase === 'floor') {
          const w = pick(organic);
          res = Math.random() < 0.5 ? trade(newWallet(), 'buy', rnd(0.03, 0.08)) : trade(w, 'sell', Math.min(bal.get(w) ?? 0, (vTokens * 0.0006)));
          wait = rnd(1800, 3000);
          if (Date.now() > floorUntil) phase = 'return';
        } else if (phase === 'return') {
          res = trade(newWallet(), 'buy', rnd(0.15, 0.35));
          wait = rnd(2500, 4000);
          if (--buyersLeft <= 0) phase = 'after';
        } else {
          res = Math.random() < 0.6 ? trade(newWallet(), 'buy', rnd(0.1, 0.6)) : trade(pick(organic), 'sell', (bal.get(pick(organic)) ?? 0) * 0.5);
          wait = rnd(800, 2000);
          if (++afterSteps > 140) return;
        }
        if (res !== 'done') setTimeout(step2, wait);
      };
      setTimeout(step2, 300);
      return;
    }
    // a demo "smart" trader joins some coins and trades the full cycle
    const pro = scenario !== 'dead' && Math.random() < 0.55 ? pick(DEMO_TRADERS) : null;
    const plan = pro ? { 6: ['buy', rnd(1, 3)], 18: ['buy', rnd(0.5, 1.5)], 40: ['sellPct', 0.25], 65: ['sellPct', 0.5], 95: ['sellPct', 1],
      ...(Math.random() < 0.5 ? { 110: ['buy', rnd(0.5, 1)], 140: ['sellPct', 1] } : {}) } : {};
    let step = 0;
    const maxSteps = scenario === 'dead' ? 6 : scenario === 'runner' ? 400 : 160;
    const tick = () => {
      step++;
      if (step > maxSteps) return;
      let res;
      const p = plan[step];
      if (p) res = p[0] === 'buy' ? trade(pro, 'buy', p[1]) : trade(pro, 'sell', (bal.get(pro) ?? 0) * p[1]);
      if (res === 'done') return;
      if (scenario === 'dead') { if (Math.random() < 0.5) res = trade(newWallet(), 'buy', rnd(0.05, 0.3)); }
      else if (scenario === 'wash') {
        const w = pick(washers);
        const sell = (bal.get(w) ?? 0) > 0 && Math.random() < 0.5;
        res = trade(w, sell ? 'sell' : 'buy', sell ? (bal.get(w) ?? 0) * rnd(0.5, 1) : rnd(0.3, 0.8));
        if (Math.random() < 0.25) res = trade(newWallet(), 'buy', rnd(0.05, 0.4));
      } else {
        const hype = scenario === 'runner' ? 0.82 : step < 40 ? 0.7 : 0.35;
        if (Math.random() < hype) res = trade(Math.random() < 0.8 || !organic.length ? newWallet() : pick(organic), 'buy', rnd(0.05, scenario === 'runner' ? 1.5 : 1.0));
        else if (organic.length) { const w = pick(organic); res = trade(w, 'sell', (bal.get(w) ?? 0) * rnd(0.3, 1)); }
        // insiders dump once there is liquidity
        if (insiders.length && step > 35 && Math.random() < 0.25) { const w = insiders.pop(); res = trade(w, 'sell', bal.get(w) ?? 0); }
        if (scenario !== 'runner' && step === 30 && Math.random() < 0.5) trade(creator, 'sell', bal.get(creator) ?? 0);
      }
      if (res !== 'done' && !finished) setTimeout(tick, scenario === 'runner' ? rnd(300, 900) : rnd(500, 1500));
    };
    setTimeout(tick, 300);
  }
}
