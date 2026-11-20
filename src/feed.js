// Event feeds. Both emit: 'create', 'trade', 'migrate', 'status'.
//  - PumpPortalFeed: the real thing (free PumpPortal websocket)
//  - DemoFeed: simulated launches (organic runners, bundles, wash trading...) for trying
//    the bot without any keys. Demo coins are fake.
import { EventEmitter } from 'node:events';

export class PumpPortalFeed extends EventEmitter {
  constructor(url, log = console) {
    super();
    this.url = url; this.log = log;
    this.watched = new Set();
    this.pendingSub = new Set();
    this.pendingUnsub = new Set();
    this.connected = false;
    this.backoff = 1000;
    setInterval(() => this.#flush(), 300).unref();
  }

  start() { this.#connect(); }

  #connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true; this.backoff = 1000;
      this.log.info('PumpPortal connected');
      this.emit('status', { connected: true });
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      for (const m of this.watched) this.pendingSub.add(m);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.mint || !msg.txType) return; // subscription confirmations etc.
      if (msg.txType === 'create') this.emit('create', msg);
      else if (msg.txType === 'buy' || msg.txType === 'sell') this.emit('trade', msg);
      else if (msg.txType === 'migrate' || msg.txType === 'migration') this.emit('migrate', msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.emit('status', { connected: false });
      this.log.warn(`PumpPortal disconnected - reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => this.#connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  watch(mint) { this.watched.add(mint); this.pendingUnsub.delete(mint); this.pendingSub.add(mint); }
  unwatch(mint) { this.watched.delete(mint); this.pendingSub.delete(mint); this.pendingUnsub.add(mint); }

  #flush() {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    const send = (method, set) => {
      const keys = [...set]; set.clear();
      for (let i = 0; i < keys.length; i += 100) {
        this.ws.send(JSON.stringify({ method, keys: keys.slice(i, i + 100) }));
      }
    };
    if (this.pendingSub.size) send('subscribeTokenTrade', this.pendingSub);
    if (this.pendingUnsub.size) send('unsubscribeTokenTrade', this.pendingUnsub);
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

export class DemoFeed extends EventEmitter {
  constructor(chain, log = console, xSource = null) {
    super(); this.chain = chain; this.log = log; this.xSource = xSource; this.watched = new Set(); this.connected = true;
  }
  watch(m) { this.watched.add(m); }
  unwatch(m) { this.watched.delete(m); }

  start() {
    this.log.info('DEMO MODE - simulated coins, not real');
    this.emit('status', { connected: true, demo: true });
    const devs = [rid(), rid()];
    const launch = () => {
      const r = Math.random();
      const scenario = r < 0.22 ? 'runner' : r < 0.42 ? 'bundled' : r < 0.52 ? 'wash' : r < 0.6 ? 'serial' : 'dead';
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
      if (!this.watched.has(mint)) return;
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
    let step = 0;
    const maxSteps = scenario === 'dead' ? 6 : scenario === 'runner' ? 400 : 160;
    const tick = () => {
      step++;
      if (step > maxSteps) return;
      let res;
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
