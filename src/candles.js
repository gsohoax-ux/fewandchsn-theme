// Real candlestick data for charts and for the strategy engine.
//
// Sources, best first:
//   1. The bot's own live trade feed (PumpPortal): exact, real-time candles for bonding-curve coins the bot
//      has watched since launch.
//   2. GeckoTerminal's free public API (OHLCV per pool, ~30 requests/minute): any coin with an indexed pool.
// Nothing is ever made up: if neither source has data, the chart says so.

export const TIMEFRAMES = {
  '1m': { unit: 'minute', agg: 1, sec: 60 },
  '5m': { unit: 'minute', agg: 5, sec: 300 },
  '15m': { unit: 'minute', agg: 15, sec: 900 },
  '1h': { unit: 'hour', agg: 1, sec: 3600 },
  '4h': { unit: 'hour', agg: 4, sec: 14400 },
  '1d': { unit: 'day', agg: 1, sec: 86400 },
};
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const GT_HEADERS = { accept: 'application/json;version=20230302' };

/** GeckoTerminal OHLCV response → ascending candles {t (sec), o, h, l, c, v (USD)}. */
export function parseOhlcv(j) {
  const list = j?.data?.attributes?.ohlcv_list ?? [];
  return list.filter((r) => Array.isArray(r) && r.length >= 6 && r.slice(1, 5).every((x) => Number(x) > 0))
    .map(([t, o, h, l, c, v]) => ({ t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 }))
    .sort((a, b) => a.t - b.t);
}

/** GeckoTerminal pools response → the most liquid pool where the coin is the base token. */
export function pickPool(j, mint) {
  const pools = (j?.data ?? []).filter((p) => p?.attributes)
    .filter((p) => (p.relationships?.base_token?.data?.id ?? '').endsWith(mint))
    .sort((a, b) => Number(b.attributes.reserve_in_usd ?? 0) - Number(a.attributes.reserve_in_usd ?? 0));
  const p = pools[0];
  if (!p) return null;
  const a = p.attributes, num = (x) => (x == null || x === '' ? null : Number(x));
  const tx = (k) => a.transactions?.[k] ? { buys: a.transactions[k].buys ?? 0, sells: a.transactions[k].sells ?? 0, buyers: a.transactions[k].buyers ?? null, sellers: a.transactions[k].sellers ?? null } : null;
  return {
    address: a.address, name: a.name ?? '', dex: p.relationships?.dex?.data?.id ?? '',
    priceUsd: num(a.base_token_price_usd), mcUsd: num(a.market_cap_usd) ?? num(a.fdv_usd), fdvUsd: num(a.fdv_usd),
    liqUsd: num(a.reserve_in_usd), createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    volumeUsd: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h6: num(a.volume_usd?.h6), h24: num(a.volume_usd?.h24) },
    changePct: { m5: num(a.price_change_percentage?.m5), h1: num(a.price_change_percentage?.h1), h6: num(a.price_change_percentage?.h6), h24: num(a.price_change_percentage?.h24) },
    txns: { m5: tx('m5'), h1: tx('h1'), h24: tx('h24') },
  };
}

/**
 * Candles from the bot's recorded trades. trades = [{ts, side, sol, mcSol}]. Price per token in USD
 * (1B supply). Each candle also counts buys and sells. Empty periods carry the last close forward.
 */
export function candlesFromTrades(trades, tfSec, solUsd, { now = Date.now(), supply = 1e9, maxCandles = 500 } = {}) {
  if (!trades?.length || !(solUsd > 0)) return [];
  const step = tfSec * 1000;
  const px = (t) => (t.mcSol * solUsd) / supply;
  const out = [];
  let cur = null;
  for (const t of trades) {
    if (!(t.mcSol > 0)) continue;
    const b = Math.floor(t.ts / step) * step;
    if (!cur || b !== cur.b) {
      if (cur) {
        out.push(cur);
        for (let g = cur.b + step; g < b && out.length < 100_000; g += step) out.push({ b: g, o: cur.c, h: cur.c, l: cur.c, c: cur.c, v: 0, buys: 0, sells: 0 });
      }
      const open = cur ? cur.c : px(t);
      cur = { b, o: open, h: Math.max(open, px(t)), l: Math.min(open, px(t)), c: px(t), v: 0, buys: 0, sells: 0 };
    }
    const p = px(t);
    cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p); cur.c = p;
    cur.v += (t.sol ?? 0) * solUsd;
    if (t.side === 'sell') cur.sells++; else cur.buys++;
  }
  if (cur) {
    out.push(cur);
    const last = Math.floor(now / step) * step;
    for (let g = cur.b + step; g <= last && out.length < 100_000; g += step) out.push({ b: g, o: cur.c, h: cur.c, l: cur.c, c: cur.c, v: 0, buys: 0, sells: 0 });
  }
  return out.slice(-maxCandles).map(({ b, ...c }) => ({ t: b / 1000, ...c }));
}

/** Simple sliding-window limiter: at most `max` calls per `windowMs`. Waits (up to maxWaitMs) for a slot. */
export class RateLimiter {
  constructor(max = 25, windowMs = 60_000, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { max, windowMs, now, sleep });
    this.calls = [];
  }
  async take(maxWaitMs = 4000) {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const t = this.now();
      while (this.calls.length && t - this.calls[0] >= this.windowMs) this.calls.shift();
      if (this.calls.length < this.max) { this.calls.push(t); return; }
      const wait = this.calls[0] + this.windowMs - t + 5;
      if (t + wait > deadline) throw new Error('Chart data provider is busy (free rate limit) — retrying shortly');
      await this.sleep(wait);
    }
  }
}

export class CandleService {
  constructor({ engine = null, fetchFn = fetch, log = console, limiter = new RateLimiter(25, 60_000), now = () => Date.now() }) {
    Object.assign(this, { engine, fetchFn, log, limiter, now });
    this.cache = new Map(); // key -> { at, ttl, val | err }
  }

  async #cached(key, ttlMs, fn, errTtlMs = 30_000) {
    const hit = this.cache.get(key);
    const t = this.now();
    if (hit && t - hit.at < (hit.err ? errTtlMs : ttlMs)) { if (hit.err) throw hit.err; return hit.val; }
    if (hit?.pending) return hit.pending;
    const pending = (async () => {
      try { const val = await fn(); this.cache.set(key, { at: this.now(), val }); return val; }
      catch (err) { this.cache.set(key, { at: this.now(), err }); throw err; }
    })();
    this.cache.set(key, { ...(hit ?? {}), at: hit?.at ?? 0, pending });
    if (this.cache.size > 3000) for (const k of [...this.cache.keys()].slice(0, 500)) this.cache.delete(k);
    return pending;
  }

  async #gt(path) {
    await this.limiter.take();
    const res = await this.fetchFn(`${GT}${path}`, { headers: GT_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('GeckoTerminal rate limit reached — retrying shortly');
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
    return res.json();
  }

  /** Most liquid pool for a coin, with live market stats (GeckoTerminal). null if not indexed yet. */
  pool(mint) {
    return this.#cached(`pool:${mint}`, 20_000, async () => pickPool(await this.#gt(`/tokens/${mint}/pools?page=1`), mint));
  }

  /** Candles for one timeframe from GeckoTerminal. */
  async geckoCandles(mint, tf) {
    const T = TIMEFRAMES[tf];
    const pool = await this.pool(mint);
    if (!pool) return { candles: [], pool: null };
    const ttl = T.sec <= 60 ? 15_000 : T.sec <= 900 ? 30_000 : 120_000;
    const candles = await this.#cached(`ohlcv:${pool.address}:${tf}`, ttl,
      async () => parseOhlcv(await this.#gt(`/pools/${pool.address}/ohlcv/${T.unit}?aggregate=${T.agg}&limit=300&currency=usd&token=base`)));
    return { candles, pool };
  }

  /** Candles built from the trades the bot recorded (bonding-curve coins it is watching). */
  liveCandles(mint, tf) {
    const c = this.engine?.coins.get(mint);
    const solUsd = this.engine?.solUsd ?? 0;
    if (!c || !c.trades.length || !(solUsd > 0)) return null;
    const fromLaunch = c.trades[0].ts - c.createdAt < 90_000;
    return { candles: candlesFromTrades(c.trades, TIMEFRAMES[tf].sec, solUsd, { now: this.now() }), fromLaunch,
      since: c.trades[0].ts, coin: c };
  }

  /**
   * Chart data for a coin: candles + market stats + where they came from + how fresh they are.
   * Never throws for missing data; reports it instead.
   */
  async chart(mint, tf = '5m') {
    if (!TIMEFRAMES[tf]) throw new Error('Unknown timeframe');
    const live = this.liveCandles(mint, tf);
    const out = { mint, tf, candles: [], source: null, note: '', market: null, updatedAt: this.now() };
    let gecko = null, geckoErr = null;
    // Prefer the bot's own feed for coins it has watched since launch (exact and real-time) on short timeframes
    const liveGood = live && live.fromLaunch && !live.coin.migrated && TIMEFRAMES[tf].sec <= 3600;
    if (!liveGood) {
      try { gecko = await this.geckoCandles(mint, tf); } catch (e) { geckoErr = e.message; }
    } else {
      // still fetch pool stats (cached) for liquidity/volume when available, without blocking the chart on errors
      try { gecko = { candles: [], pool: await this.pool(mint) }; } catch { /* stats optional */ }
    }
    if (liveGood || (!gecko?.candles?.length && live?.candles.length)) {
      out.candles = live.candles;
      out.source = 'live';
      out.note = live.fromLaunch ? 'Built from every trade the bot recorded from the live Pump.fun feed'
        : `Built from trades the bot recorded since ${new Date(live.since).toISOString().slice(11, 16)} UTC (it started watching late)`;
    } else if (gecko?.candles?.length) {
      out.candles = gecko.candles;
      out.source = 'geckoterminal';
      out.note = `GeckoTerminal OHLCV · pool ${gecko.pool.name || gecko.pool.address.slice(0, 6)}${gecko.pool.dex ? ` on ${gecko.pool.dex}` : ''}`;
    } else {
      out.note = geckoErr ? `Chart data unavailable: ${geckoErr}` : 'No candle data yet: the coin is not indexed by GeckoTerminal and the bot has no recorded trades for it';
    }
    const c = live?.coin, solUsd = this.engine?.solUsd ?? 0;
    const pool = gecko?.pool ?? null;
    if (c && !c.migrated && solUsd > 0) {
      const sinceMs = (m) => this.now() - m * 60_000;
      const flow = (m) => { let buys = 0, sells = 0, bv = 0, sv = 0; for (const t of c.trades) if (t.ts >= sinceMs(m)) { if (t.side === 'sell') { sells++; sv += t.sol * solUsd; } else { buys++; bv += t.sol * solUsd; } } return { buys, sells, buyUsd: bv, sellUsd: sv }; };
      out.market = { priceUsd: (c.mcSol * solUsd) / 1e9, mcUsd: c.mcSol * solUsd, liqUsd: Math.max(0, c.vSol - 30) * solUsd, liqKind: 'SOL in the bonding curve',
        progress: c.progress, onCurve: true, source: 'live feed', lastTradeAgoSec: Math.round((this.now() - c.trades.at(-1).ts) / 1000),
        flow: { m5: flow(5), h1: flow(60) }, athMcUsd: c.athMcSol * solUsd };
    } else if (!pool && c && solUsd > 0) {
      // graduated and not indexed yet: show the last price the bot saw, clearly marked as old
      out.market = { priceUsd: (c.mcSol * solUsd) / 1e9, mcUsd: c.mcSol * solUsd, liqUsd: null, onCurve: false, source: 'last live-feed price before graduation',
        lastTradeAgoSec: c.trades.length ? Math.round((this.now() - c.trades.at(-1).ts) / 1000) : null, stale: true };
      out.stale = true;
    } else if (pool) {
      out.market = { priceUsd: pool.priceUsd, mcUsd: pool.mcUsd, liqUsd: pool.liqUsd, liqKind: 'pool reserves', onCurve: /pump-fun|pumpfun/i.test(pool.dex) && !/swap/i.test(pool.dex),
        source: 'GeckoTerminal', volumeUsd: pool.volumeUsd, changePct: pool.changePct, txns: pool.txns, dex: pool.dex, poolCreatedAt: pool.createdAt };
    }
    if (out.candles.length) {
      const cs = out.candles;
      out.stats = { high: Math.max(...cs.map((x) => x.h)), low: Math.min(...cs.map((x) => x.l)), first: cs[0].o, last: cs.at(-1).c,
        changePct: (cs.at(-1).c / cs[0].o - 1) * 100, volumeUsd: cs.reduce((s, x) => s + x.v, 0), lastCandleAgoSec: Math.round(this.now() / 1000 - cs.at(-1).t) };
      out.stale = Boolean(out.stale) || (out.source === 'geckoterminal' && out.stats.lastCandleAgoSec > TIMEFRAMES[tf].sec * 3 + 120);
    }
    return out;
  }
}
