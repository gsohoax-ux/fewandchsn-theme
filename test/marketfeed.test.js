// Market-data health: discovery vs trade stream, per-coin staleness, SOL freshness, watchdog, reconnection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PumpPortalFeed } from '../src/feed.js';
import { MarketData } from '../src/market.js';
import { Engine } from '../src/engine.js';
import { PaperTrader } from '../src/paper.js';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';
import { PaperBook } from '../src/paperbook.js';
import { StrategyEngine } from '../src/strategy/engine.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Fake clock shared by feed + market. */
function clock(start = 1_700_000_000_000) { const c = { t: start, now: () => c.t, adv(ms) { c.t += ms; } }; return c; }

/** Fake WebSocket that records what the bot sends and lets the test play the server. */
function fakeWs() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    send(s) { if (this.failSend) throw new Error('socket busy'); this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
    subs(method = 'subscribeTokenTrade') { return this.sent.filter((m) => m.method === method).flatMap((m) => m.keys ?? [true]); }
  }
  return { FakeWS, sockets };
}

function logger() { const l = { lines: [], info: (m) => l.lines.push(['info', m]), warn: (m) => l.lines.push(['warn', m]) }; return l; }

function setup({ watched = 12, tradeSilenceMs = 60_000, fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) }) } = {}) {
  const ck = clock(); const { FakeWS, sockets } = fakeWs(); const log = logger();
  const feed = new PumpPortalFeed('wss://test', log, { WebSocketImpl: FakeWS, now: ck.now, tradeSilenceMs, statusLogMs: 0, backoffMs: 5 });
  feed.start();
  sockets[0].open();
  const mints = Array.from({ length: watched }, (_, i) => `M${i}pump`);
  for (const m of mints) feed.watch(m);
  feed.flush();
  const engine = { solUsd: 150, solUsdAt: ck.now(), coins: new Map() };
  const market = new MarketData({ engine, feed, fetchFn, log: logger(), now: ck.now });
  for (const m of mints) market.track(m, 'test');
  return { ck, feed, sockets, log, market, engine, mints };
}
const trade = (mint, mc = 40) => ({ mint, txType: 'buy', traderPublicKey: 'W', tokenAmount: 1e6, solAmount: 0.04, marketCapSol: mc, vSolInBondingCurve: 35, vTokensInBondingCurve: 9e8, pool: 'pump' });
const create = (n) => ({ mint: `NEW${n}pump`, txType: 'create', traderPublicKey: 'DEV', symbol: 'N', name: 'n', marketCapSol: 28, vSolInBondingCurve: 30, vTokensInBondingCurve: 1.07e9 });

test('normal trade delivery: subscriptions sent, trades priced, stream healthy, quote accepted', async () => {
  const { ck, feed, sockets, market, mints } = setup();
  const ws = sockets[0];
  assert.deepEqual(ws.sent.slice(0, 2).map((m) => m.method), ['subscribeNewToken', 'subscribeMigration']);
  assert.deepEqual(new Set(ws.subs()), new Set(mints), 'every watched coin subscribed');
  assert.equal(feed.counts.keysSubscribed, mints.length);
  ws.msg({ message: 'Successfully subscribed to keys.' });
  assert.equal(feed.counts.acks, 1);
  ck.adv(1000); ws.msg(trade(mints[0], 42));
  assert.equal(feed.counts.trades, 1);
  assert.equal(feed.tradesHealthy(), true);
  assert.equal(market.tradeStreamHealthy(), true);
  const q = market.get(mints[0]);
  assert.equal(q.streaming, true);
  assert.ok(q.ageMs < 1000);
  assert.equal((await market.quote(mints[0])).ok, true);
});

test('discovery without trades: discovery healthy, trade stream NOT healthy, prices not live', async () => {
  const { ck, feed, sockets, market, mints } = setup();
  const ws = sockets[0];
  ws.msg(trade(mints[0]));                         // one trade at the start...
  for (let i = 0; i < 40; i++) { ck.adv(3000); ws.msg(create(i)); } // ...then 120 s of new coins only
  assert.equal(market.feedHealthy(), true, 'socket + discovery still look alive');
  assert.equal(feed.tradesHealthy(), false, 'trade stream detected as broken');
  assert.equal(market.tradeStreamHealthy(), false);
  const q = market.get(mints[0]);
  assert.equal(q.streaming, false, 'the OLD code reported streaming:true here');
  assert.ok(q.ageMs >= 119_000, `age is the coin's real age (${q.ageMs})`);
  const r = await market.quote(mints[0], { maxAgeMs: 10_000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /old/);
});

test('per-coin staleness: a quiet coin WITHOUT proof on this connection is stale even while other coins trade', async () => {
  const { ck, sockets, market, feed, mints } = setup();
  sockets[0].msg(trade(mints[0]));
  sockets[0].drop(); await tick(20); sockets[1].open(); feed.flush();   // reconnect: M0 must prove itself again
  for (let i = 0; i < 9; i++) { ck.adv(10_000); sockets[1].msg(trade(mints[1])); } // 90 s: only M1 trades
  assert.equal(market.tradeStreamHealthy(), true);
  assert.equal(market.get(mints[1]).streaming, true);
  const a = market.get(mints[0]);
  assert.equal(a.streaming, false);
  assert.ok(a.ageMs >= 90_000);
  assert.match(a.basis, /quiet coin/);
});

test('a coin that traded recently on a healthy stream stays current between trades', () => {
  const { ck, sockets, market, mints } = setup();
  const ws = sockets[0];
  ws.msg(trade(mints[0]));
  ck.adv(20_000); ws.msg(trade(mints[1]));          // stream proven live 0 s ago, M0 quiet for 20 s (< 60 s)
  const a = market.get(mints[0]);
  assert.equal(a.streaming, true);
  assert.ok(a.ageMs < 1000);
});

test('stale SOL/USD price: quotes refused; missing SOL price refused', async () => {
  const { ck, sockets, market, engine, mints } = setup();
  sockets[0].msg(trade(mints[0]));
  engine.solUsdAt = ck.now() - 200_000;
  let r = await market.quote(mints[0]);
  assert.equal(r.ok, false); assert.match(r.reason, /SOL\/USD price is 200s old/);
  engine.solUsdAt = ck.now(); engine.solUsd = 0;
  r = await market.quote(mints[0]);
  assert.equal(r.ok, false); assert.match(r.reason, /SOL\/USD price unavailable/);
  engine.solUsd = 150;
  assert.equal((await market.quote(mints[0])).ok, true);
});

test('trade watchdog: re-subscribes first, then reconnects if trades stay missing', async () => {
  const { ck, feed, sockets, log, mints } = setup();
  const ws = sockets[0];
  const statuses = []; feed.on('status', (s) => statuses.push(s));
  const before = ws.subs().length;
  ck.adv(61_000); ws.msg(create(1));
  feed.checkTrades();
  assert.equal(feed.counts.resubscribes, 1);
  assert.ok(statuses.some((s) => s.problem === 'trade messages missing'));
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && /no trade messages .* re-subscribing/.test(m)));
  feed.flush();
  assert.equal(ws.subs().length - before, mints.length, 'all watched coins re-subscribed');
  ck.adv(30_000); feed.checkTrades();
  assert.equal(sockets.length, 1, 'no reconnect before a second silence window');
  ck.adv(31_000); feed.checkTrades();
  assert.equal(feed.counts.tradeWatchdogReconnects, 1);
  assert.equal(feed.connected, false);
  await tick(20);
  assert.equal(sockets.length, 2, 'new connection opened');
});

test('watchdog stays quiet with few subscribed coins; the stream still counts as unconfirmed until a trade arrives', () => {
  const { ck, feed, sockets, mints } = setup({ watched: 3 });
  ck.adv(10 * 60_000); feed.checkTrades();
  assert.equal(feed.counts.resubscribes, 0);
  assert.equal(feed.tradesHealthy(), false, 'no trade on this connection yet = unconfirmed');
  sockets[0].msg(trade(mints[0]));
  ck.adv(10 * 60_000);
  assert.equal(feed.tradesHealthy(), true, 'confirmed; too few coins to judge silence (per-coin proof still applies)');
});

test('disconnect → reconnect restores ALL subscriptions (coins and copy-trade wallets)', async () => {
  const { feed, sockets, log, mints } = setup();
  feed.watchAccount('WALLET1'); feed.flush();
  sockets[0].drop(1006);
  assert.equal(feed.connected, false);
  assert.equal(feed.reconnects, 1);
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && /closed \(code 1006\)/.test(m)));
  await tick(20);
  const ws2 = sockets[1];
  ws2.open();
  feed.flush();
  assert.deepEqual(ws2.sent.slice(0, 2).map((m) => m.method), ['subscribeNewToken', 'subscribeMigration']);
  assert.deepEqual(new Set(ws2.subs()), new Set(mints));
  assert.deepEqual(ws2.subs('subscribeAccountTrade'), ['WALLET1']);
});

test('reconnect without trade recovery: watchdog fires again on the new connection', async () => {
  const { ck, feed, sockets } = setup();
  sockets[0].drop(); await tick(20); sockets[1].open(); feed.flush();
  ck.adv(61_000); sockets[1].msg(create(1)); feed.checkTrades();
  assert.equal(feed.counts.resubscribes, 1);
  ck.adv(61_000); feed.checkTrades();
  assert.equal(feed.counts.tradeWatchdogReconnects, 1);
  await tick(20);
  assert.equal(sockets.length, 3);
});

test('reconnect WITH trade recovery: healthy again, no watchdog action', async () => {
  const { ck, feed, sockets, market, mints } = setup();
  sockets[0].drop(); await tick(20); sockets[1].open(); feed.flush();
  ck.adv(5000); sockets[1].msg(trade(mints[2]));
  assert.equal(market.tradeStreamHealthy(), true, 'prices live again right after the first trade');
  assert.equal(market.get(mints[2]).streaming, true);
  ck.adv(50_000); feed.checkTrades();
  assert.equal(feed.counts.resubscribes, 0, 'within the 60 s window: no watchdog action');
  assert.equal(feed.tradesHealthy(), true);
});

test('server errors and acks are classified and logged; failed sends are retried', () => {
  const { feed, sockets, log } = setup();
  const ws = sockets[0];
  ws.msg({ errors: 'Rate limit exceeded: too many subscriptions' });
  assert.equal(feed.counts.serverErrors, 1);
  assert.match(feed.lastProblem, /server says/);
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && /Rate limit exceeded/.test(m)));
  ws.msg({ message: 'Successfully subscribed to keys.' });
  assert.equal(feed.counts.acks, 1);
  assert.match(feed.lastAck, /Successfully/);
  ws.failSend = true; feed.watch('LATEpump'); feed.flush();
  assert.ok(feed.pendingSub.has('LATEpump'), 'kept for retry');
  ws.failSend = false; feed.flush();
  assert.ok(ws.subs().includes('LATEpump'));
});

test('status line reports discovery and trades separately', () => {
  const { ck, feed, sockets, mints } = setup();
  sockets[0].msg(create(1)); ck.adv(2000); sockets[0].msg(trade(mints[0]));
  const s = feed.statusLine();
  assert.match(s, /last new coin 2s ago/);
  assert.match(s, /last trade 0s ago/);
  assert.match(s, /12 coins subscribed/);
});

// ================================================================ correction 1: watchdog backoff, no loops
test('watchdog never loops: one re-subscribe per connection, reconnects after 2, 5, 15, 30, 30 min of silence', async () => {
  const { ck, feed, sockets } = setup();
  const connStart = [ck.now()];
  let healthyEver = false;
  for (let i = 0; i < (2 + 5 + 15 + 30 + 30) * 4 + 40; i++) {      // 15 s steps, ~92 min, trades NEVER arrive
    ck.adv(15_000); sockets.at(-1).msg(create(i)); feed.checkTrades();
    if (feed.tradesHealthy()) healthyEver = true;
    if (!feed.connected) { await tick(15); sockets.at(-1).open(); feed.flush(); connStart.push(ck.now()); if (feed.tradesHealthy()) healthyEver = true; }
  }
  const minutes = connStart.slice(1).map((t, i) => Math.round((t - connStart[i]) / 60_000));
  assert.deepEqual(minutes, [2, 5, 15, 30, 30], `reconnect spacing ${minutes}`);
  assert.equal(feed.counts.tradeWatchdogReconnects, 5);
  assert.equal(feed.counts.resubscribes, connStart.length, 'exactly one re-subscribe per connection');
  for (const ws of sockets) assert.ok(ws.sent.filter((m) => m.method === 'subscribeTokenTrade').length <= 2, 'at most: initial subscribe + one re-subscribe per connection');
  assert.equal(healthyEver, false, 'new entries stayed blocked the whole time, including right after each reconnect');
});

test('watchdog backoff resets once trades come back', async () => {
  const { ck, feed, sockets, mints } = setup();
  const runToReconnect = async () => { const n = sockets.length; while (sockets.length === n) { ck.adv(15_000); feed.checkTrades(); await tick(0); if (!feed.connected) await tick(15); } sockets.at(-1).open(); feed.flush(); };
  await runToReconnect(); await runToReconnect();
  assert.equal(feed.watchdogStrikes, 2);
  sockets.at(-1).msg(trade(mints[0]));
  assert.equal(feed.watchdogStrikes, 0);
  const start = ck.now(); await runToReconnect();
  assert.equal(Math.round((ck.now() - start) / 60_000), 2, 'back to the first step');
});

// ================================================================ correction 2: per-coin proof, entry-time measurement
const engineCtx = (feed, over = {}) => ({ cfg: { demo: false, solMaxAgeSec: 120 }, solUsd: 150, solUsdAt: Date.now(), feed, ...over });
const entryCheck = (ctx, mint) => Engine.prototype.entryDataProblem.call(ctx, { mint });
const keepTrading = (ck, ws, mint, sec) => { for (let s = 0; s < sec; s += 10) { ck.adv(10_000); ws.msg(trade(mint)); } };

test('quiet but valid subscribed curve coin: still live, quotable without DexScreener, and allowed to enter', async () => {
  const { ck, sockets, market, feed, engine, mints } = setup();
  const ws = sockets[0];
  ws.msg(trade(mints[0], 40));                       // M0 proves its subscription...
  keepTrading(ck, ws, mints[1], 300);                // ...then stays quiet 5 min while the market trades
  const q = market.get(mints[0]);
  assert.equal(q.streaming, true);
  assert.match(q.basis, /subscription verified/);
  engine.solUsdAt = ck.now();                       // SOL/USD refreshed on schedule meanwhile
  const r = await market.quote(mints[0]);           // fetchFn fails: no DexScreener needed
  assert.equal(r.ok, true);
  assert.equal(r.quote.mcUsd, 40 * 150);
  assert.equal(entryCheck(engineCtx(feed), mints[0]), null, 'no blanket per-coin age limit');
});

test('subscribed coin with NO trade since subscription is refused; proof is reset by a reconnect', async () => {
  const { ck, sockets, feed, mints } = setup();
  sockets[0].msg(trade(mints[0])); sockets[0].msg(trade(mints[1]));
  assert.match(entryCheck(engineCtx(feed), mints[2]), /no trade received for this coin since it was subscribed/);
  assert.equal(entryCheck(engineCtx(feed), mints[0]), null);
  sockets[0].drop(); await tick(20); sockets[1].open(); feed.flush();
  ck.adv(1000); sockets[1].msg(trade(mints[1]));
  assert.match(entryCheck(engineCtx(feed), mints[0]), /since it was subscribed/, 'old proof does not survive a reconnect');
  ck.adv(1000); sockets[1].msg(trade(mints[0]));
  assert.equal(entryCheck(engineCtx(feed), mints[0]), null);
});

test('quiet PumpSwap (graduated) coin keeps the 60 s quiet limit (coverage unverified)', () => {
  const { ck, sockets, market, mints } = setup();
  sockets[0].msg({ ...trade(mints[3]), pool: 'pump-amm' });
  keepTrading(ck, sockets[0], mints[1], 120);
  const q = market.get(mints[3]);
  assert.equal(q.onCurve, false);
  assert.equal(q.streaming, false);
  assert.ok(q.ageMs >= 120_000);
});

test('entry guard: SOL stale/missing and broken trade stream refused; demo unaffected', () => {
  const { ck, sockets, feed, mints } = setup();
  sockets[0].msg(trade(mints[0]));
  assert.equal(entryCheck(engineCtx(feed), mints[0]), null);
  assert.match(entryCheck(engineCtx(feed, { solUsdAt: Date.now() - 300_000 }), mints[0]), /SOL\/USD price 300s old/);
  assert.match(entryCheck(engineCtx(feed, { solUsd: 0 }), mints[0]), /SOL\/USD price unavailable/);
  for (let i = 0; i < 5; i++) { ck.adv(15_000); sockets[0].msg(create(i)); }
  assert.match(entryCheck(engineCtx(feed), mints[0]), /trade stream not confirmed/);
  assert.equal(entryCheck(engineCtx(feed, { cfg: { demo: true, solMaxAgeSec: 120 } }), mints[0]), null);
});

const pcfg = { paper: true, paperStartSol: 2, paperSizePct: 8, paperMaxOpen: 5, paperStopPct: 25, paperTrailStartPct: 30,
  paperTrailPct: 20, paperMaxHoldMin: 90, paperFeePct: 1.25, paperTxFeeSol: 0.002, paperSlippagePct: 3 };
function coinAt(vSol, mint = 'MINTpump') {
  const c = new Coin({ mint, name: 'Test', symbol: 'TST', traderPublicKey: 'DEV', signature: 's', initialBuy: 0,
    vSolInBondingCurve: vSol, vTokensInBondingCurve: (30 * 1_073_000_000) / vSol, marketCapSol: 0 });
  c.vSol = vSol; c.vTokens = (30 * 1_073_000_000) / vSol; c.mcSol = (c.vSol / c.vTokens) * 1e9;
  return c;
}

test('freshness is measured at the ENTRY moment, not when scoring began', () => {
  const ctx = { cfg: { demo: false, solMaxAgeSec: 120 }, solUsd: 150, solUsdAt: Date.now() - 150_000, feed: { tradesHealthy: () => true, tradeProven: () => true } };
  const calls = [];
  const t = new PaperTrader({ cfg: pcfg, store: new Store(':memory:'), log: { info() {}, warn() {} },
    getDataProblem: (...a) => { calls.push(a.length); return Engine.prototype.entryDataProblem.call(ctx, ...a); } });
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  const scoringStartedAt = Date.now() - 100_000; // SOL looked 50 s old back then, it is 150 s old now
  assert.equal(t.open(coin, { stage: 'x', score: 80 }, coins, scoringStartedAt), null, 'blocked: SOL is stale NOW');
  assert.deepEqual(calls, [1], 'the guard is not handed the scoring-time clock');
  ctx.solUsdAt = Date.now();
  assert.ok(t.open(coin, { stage: 'x', score: 80 }, coins, scoringStartedAt), 'X-narrative entry on a quiet, verified coin goes through');
});

test('paper entry blocked on stale data, but an OPEN position keeps being monitored and exits', () => {
  const store = new Store(':memory:');
  let problem = null;
  const events = [];
  const t = new PaperTrader({ cfg: pcfg, store, log: { info() {}, warn() {} }, getDataProblem: () => problem, onEvent: (k, c, msg) => events.push(msg) });
  const held = coinAt(40, 'HELDpump');
  const coins = new Map([[held.mint, held]]);
  assert.ok(t.open(held, { stage: 'fresh', score: 70 }, coins), 'opened while data was fresh');
  problem = 'stale data: live trade stream not confirmed';
  const other = coinAt(40, 'OTHERpump'); coins.set(other.mint, other);
  assert.equal(t.open(other, { stage: 'fresh', score: 80 }, coins), null);
  assert.ok(events.some((m) => /skipped: stale data/.test(m)));
  held.vSol = 34; held.vTokens = (30 * 1_073_000_000) / 34; held.mcSol = (held.vSol / held.vTokens) * 1e9;
  t.onPrice(held, coins);
  assert.equal(t.positions.size, 0);
  assert.match(store.paperTrades()[0].why, /stop loss/);
});

// ================================================================ correction 3: Setuh feed health
test('Setuh feedOk follows TRADE health, not general message activity', () => {
  const { ck, sockets, market, mints } = setup();
  const ok = (m, engine = {}) => StrategyEngine.prototype.feedOk.call({ market: m, engine });
  assert.equal(ok(market), false, 'connected, no trade yet');
  for (let i = 0; i < 10; i++) { ck.adv(3000); sockets[0].msg(create(i)); }
  assert.equal(market.feedHealthy(15_000), true, 'old check would have said OK');
  assert.equal(ok(market), false, 'discovery alone does not unblock entries');
  sockets[0].msg(trade(mints[0]));
  assert.equal(ok(market), true);
  for (let i = 0; i < 5; i++) { ck.adv(15_000); sockets[0].msg(create(i)); }
  assert.equal(ok(market), false, 'trades stopped again');
  assert.equal(ok({ feedHealthy: () => true }), true, 'older market hubs keep the old check');
  assert.equal(ok(null, { feedConnected: false }), false);
});

// ================================================================ correction 4: price-source protection
function dex(state) {
  return async () => ({ ok: true, json: async () => ({ pairs: [{ chainId: 'solana', dexId: state.dexId, baseToken: { address: state.mint, symbol: 'X' },
    priceUsd: String(state.price), marketCap: state.price * 1e9, liquidity: { usd: state.liq } }] }) });
}

test('DexScreener never overwrites a verified live bonding-curve price (liquidity still taken)', async () => {
  const st = { dexId: 'pumpfun', price: 0.000012, liq: 7777, mint: 'M0pump' };
  const { ck, sockets, market, mints } = setup({ fetchFn: dex(st) });
  sockets[0].msg(trade(mints[0], 40));
  keepTrading(ck, sockets[0], mints[1], 90);
  await market.refresh(mints[0]);
  const q = market.get(mints[0]);
  assert.equal(q.mcUsd, 40 * 150, 'live curve price kept');
  assert.equal(q.source, 'Pump.fun live trade');
  assert.ok(q.liqAt === ck.now(), 'liquidity timestamp refreshed');
});

test('DexScreener still replaces: unproven subscription, unhealthy trade stream, coin left the curve, graduated coins', async () => {
  // a) subscription not proven on this connection
  {
    const st = { dexId: 'pumpfun', price: 0.000012, liq: 0, mint: 'M0pump' };
    const { ck, sockets, market, feed, mints } = setup({ fetchFn: dex(st) });
    sockets[0].msg(trade(mints[0], 40));
    sockets[0].drop(); await tick(20); sockets[1].open(); feed.flush();
    keepTrading(ck, sockets[1], mints[1], 60);
    await market.refresh(mints[0]);
    assert.equal(market.get(mints[0]).source, 'DexScreener');
  }
  // b) trade stream silent
  {
    const st = { dexId: 'pumpfun', price: 0.000012, liq: 0, mint: 'M0pump' };
    const { ck, sockets, market, mints } = setup({ fetchFn: dex(st) });
    sockets[0].msg(trade(mints[0], 40));
    for (let i = 0; i < 6; i++) { ck.adv(15_000); sockets[0].msg(create(i)); }
    await market.refresh(mints[0]);
    assert.equal(market.get(mints[0]).source, 'DexScreener');
  }
  // c) DexScreener says it graduated (PumpSwap pool)
  {
    const st = { dexId: 'pumpswap', price: 0.000012, liq: 50_000, mint: 'M0pump' };
    const { ck, sockets, market, mints } = setup({ fetchFn: dex(st) });
    sockets[0].msg(trade(mints[0], 40));
    keepTrading(ck, sockets[0], mints[1], 60);
    await market.refresh(mints[0]);
    const q = market.get(mints[0]);
    assert.equal(q.source, 'DexScreener'); assert.equal(q.onCurve, false);
  }
  // d) graduated coin priced from PumpSwap trades: unchanged fallback after 30 s quiet
  {
    const st = { dexId: 'pumpswap', price: 0.000012, liq: 50_000, mint: 'M3pump' };
    const { ck, sockets, market, mints } = setup({ fetchFn: dex(st) });
    sockets[0].msg({ ...trade(mints[3], 40), pool: 'pump-amm' });
    keepTrading(ck, sockets[0], mints[1], 40);
    await market.refresh(mints[3]);
    assert.equal(market.get(mints[3]).source, 'DexScreener');
    assert.equal(market.get(mints[3]).liqUsd, 50_000);
  }
});

test('Setuh/manual/copy books: positions keep getting prices and exits fire during a trade-stream outage', async () => {
  const { ck, sockets, market, mints } = setup();
  const b = new PaperBook({ store: new Store(':memory:'), cfg: { paperFeePct: 1.25, paperTerminalFeePct: 1, paperTxFeeSol: 0.0015, paperMevPct: 2 },
    book: 'manual', getSolUsd: () => 150, log: { warn() {} }, now: ck.now });
  sockets[0].msg(trade(mints[0], 40));
  const snap = { ...market.get(mints[0]), supply: 1e9, liqUsd: null };
  const pos = b.openPosition({ snap, budgetUsd: 20, risk: { stopPct: 20 } });
  const refresher = market.bindBook(b, 'manual');
  for (let i = 0; i < 8; i++) { ck.adv(15_000); sockets[0].msg(create(i)); }  // 2 min: trades missing, DexScreener down
  await refresher();
  assert.equal(b.open.size, 1, 'still open and monitored on the last known price');
  sockets[0].msg(trade(mints[0], 28));          // the next price we DO get is -30%
  await refresher();
  assert.equal(b.open.has(pos.id), false, 'stop-loss executed');
});
