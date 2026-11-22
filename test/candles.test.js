import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOhlcv, pickPool, candlesFromTrades, CandleService, RateLimiter, TIMEFRAMES } from '../src/candles.js';
import { Health, providerOf, dbHealth } from '../src/health.js';
import { Store } from '../src/store.js';

const MINT = 'Fq3s2Yb2wJ8fWz6x5rJ3Rk1v9nQe4XhL7mUuTtPapump';
const POOL = 'PoolAddr11111111111111111111111111111111111';

// GeckoTerminal response shapes (v2 API, version 20230302)
const poolsJson = { data: [
  { id: `solana_${POOL}`, attributes: { address: POOL, name: 'TEST / SOL', base_token_price_usd: '0.00005', market_cap_usd: null, fdv_usd: '50000',
    reserve_in_usd: '21000', pool_created_at: '2026-11-22T10:00:00Z', volume_usd: { m5: '1200', h1: '9000', h6: '20000', h24: '40000' },
    price_change_percentage: { m5: '2.5', h1: '-10', h6: '30', h24: '120' }, transactions: { m5: { buys: 12, sells: 7, buyers: 10, sellers: 6 } } },
    relationships: { base_token: { data: { id: `solana_${MINT}` } }, dex: { data: { id: 'pumpswap' } } } },
  { id: 'solana_other', attributes: { address: 'Other', reserve_in_usd: '99999999' }, relationships: { base_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } } } },
] };
const ohlcvJson = { data: { attributes: { ohlcv_list: [[1800, 2, 3, 1.5, 2.5, 100], [1500, 1, 2.2, 0.9, 2, 50], [1200, 0, 0, 0, 0, 0]] } } };

test('parses GeckoTerminal OHLCV (ascending, bad rows dropped) and picks the coin\'s own pool', () => {
  const c = parseOhlcv(ohlcvJson);
  assert.deepEqual(c.map((x) => x.t), [1500, 1800]);
  assert.deepEqual(c[1], { t: 1800, o: 2, h: 3, l: 1.5, c: 2.5, v: 100 });
  const p = pickPool(poolsJson, MINT);
  assert.equal(p.address, POOL, 'ignores pools where the coin is not the base token');
  assert.equal(p.mcUsd, 50000, 'falls back to FDV when market cap is missing');
  assert.equal(p.liqUsd, 21000);
  assert.equal(p.txns.m5.buys, 12);
  assert.equal(pickPool({ data: [] }, MINT), null);
});

test('candles from recorded trades: OHLC, volume, buy/sell counts, gaps carried forward', () => {
  const t0 = 1_000_000_020_000; // inside a minute
  const trades = [
    { ts: t0, side: 'buy', sol: 1, mcSol: 30 }, { ts: t0 + 10_000, side: 'buy', sol: 2, mcSol: 40 },
    { ts: t0 + 20_000, side: 'sell', sol: 1, mcSol: 35 }, { ts: t0 + 130_000, side: 'buy', sol: 1, mcSol: 50 },
  ];
  const cs = candlesFromTrades(trades, 60, 100, { now: t0 + 130_000 });
  assert.equal(cs.length, 3);
  assert.deepEqual([cs[0].o, cs[0].h, cs[0].l, cs[0].c].map((x) => +(x * 1e9 / 100).toFixed(6)), [30, 40, 30, 35]);
  assert.equal(cs[0].buys, 2); assert.equal(cs[0].sells, 1);
  assert.equal(cs[0].v, 400);
  assert.equal(cs[1].v, 0, 'empty minute');
  assert.equal(cs[1].c, cs[0].c, 'gap candle carries the last close');
  assert.equal(cs[2].o, cs[0].c, 'next candle opens at the previous close');
  assert.deepEqual(candlesFromTrades([], 60, 100), []);
  assert.deepEqual(candlesFromTrades(trades, 60, 0), [], 'no SOL price, no candles (never invented)');
});

test('chart: uses GeckoTerminal, caches, and reports where the data came from', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    if (url.includes('/pools?')) return { ok: true, status: 200, json: async () => poolsJson };
    if (url.includes('/ohlcv/minute?aggregate=5')) return { ok: true, status: 200, json: async () => ohlcvJson };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const svc = new CandleService({ fetchFn, limiter: new RateLimiter(100, 60_000) });
  const r = await svc.chart(MINT, '5m');
  assert.equal(r.source, 'geckoterminal');
  assert.equal(r.candles.length, 2);
  assert.equal(r.market.liqUsd, 21000);
  assert.equal(r.stats.high, 3);
  assert.match(r.note, /GeckoTerminal/);
  const before = calls;
  await svc.chart(MINT, '5m');
  assert.equal(calls, before, 'served from cache');
  await assert.rejects(() => svc.chart(MINT, '7m'), /Unknown timeframe/);
});

test('chart: no data anywhere → empty candles with an honest note, not made-up values', async () => {
  const svc = new CandleService({ fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }), limiter: new RateLimiter(100, 60_000) });
  const r = await svc.chart(MINT, '1m');
  assert.equal(r.candles.length, 0);
  assert.equal(r.source, null);
  assert.match(r.note, /No candle data yet/);
  const down = new CandleService({ fetchFn: async () => { throw new Error('network down'); }, limiter: new RateLimiter(100, 60_000) });
  const r2 = await down.chart(MINT, '1h');
  assert.match(r2.note, /unavailable: network down/);
});

test('chart: coins the bot watched from launch use its own live trades', async () => {
  const now = Date.now();
  const coin = { mint: MINT, createdAt: now - 120_000, migrated: false, mcSol: 40, vSol: 45, progress: 12, athMcSol: 45,
    trades: [{ ts: now - 115_000, side: 'buy', sol: 1, mcSol: 30 }, { ts: now - 60_000, side: 'sell', sol: 0.5, mcSol: 40 }] };
  const engine = { solUsd: 150, coins: new Map([[MINT, coin]]) };
  const svc = new CandleService({ engine, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }), limiter: new RateLimiter(100, 60_000) });
  const r = await svc.chart(MINT, '1m');
  assert.equal(r.source, 'live');
  assert.ok(r.candles.length >= 2);
  assert.equal(r.market.source, 'live feed');
  assert.equal(r.market.mcUsd, 6000);
  assert.equal(r.market.flow.m5.sells, 1);
  assert.ok(Object.keys(TIMEFRAMES).length === 6);
});

test('rate limiter waits for a free slot, and gives up with a clear message', async () => {
  let t = 0;
  const lim = new RateLimiter(2, 1000, { now: () => t, sleep: async (ms) => { t += ms; } });
  await lim.take(); await lim.take();
  await lim.take(5000); // waits ~1s of fake time
  assert.ok(t >= 1000);
  await lim.take(); // window full again (2 calls)
  await assert.rejects(() => lim.take(10), /busy/);
});

test('health: counts calls per provider, flags failures and late jobs', async () => {
  let t = 0;
  const h = new Health({ now: () => t });
  const f = h.instrument(async (url) => {
    if (url.includes('fail')) throw new Error('boom');
    return { ok: !url.includes('429'), status: url.includes('429') ? 429 : 200 };
  });
  await f('https://api.dexscreener.com/a');
  await f('https://api.dexscreener.com/429');
  await assert.rejects(() => f('https://api.geckoterminal.com/fail'));
  const v = h.view();
  const dex = v.providers.find((p) => p.key === 'dexscreener');
  assert.equal(dex.calls, 2); assert.equal(dex.fails, 1);
  assert.equal(dex.state, 'down');
  assert.match(dex.lastError, /rate limited/);
  assert.equal(v.providers.find((p) => p.key === 'geckoterminal').lastError, 'boom');
  assert.equal(providerOf('https://mainnet.helius-rpc.com/?api-key=x').key, 'helius');
  h.beat('engine tick', 2000);
  t += 10_000;
  assert.equal(h.view().jobs.find((j) => j.name === 'engine tick').state, 'late');
});

test('health: background jobs record runs and errors without crashing', async () => {
  const h = new Health();
  let n = 0;
  const j = h.job('flaky', async () => { n++; if (n === 2) throw new Error('nope'); }, 60_000, { runNow: false });
  await j.run(); await j.run(); await j.run();
  j.stop();
  const v = h.view().jobs[0];
  assert.equal(v.runs, 3); assert.equal(v.fails, 1); assert.equal(v.lastError, 'nope');
  const db = dbHealth(new Store(':memory:'));
  assert.equal(db.ok, true);
  assert.equal(db.tables.sim_positions, 0);
});
