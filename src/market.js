// Market data hub: the freshest known price for every coin anyone in the bot cares about, with its age.
//
// Root cause of stale prices (e.g. seeing $124K while the coin trades at $110K): after a coin graduated, the bot
// stopped subscribing to it and fell back to DexScreener / GeckoTerminal polling (10–120 s plus the providers' own
// lag), and the SOL/USD price was refreshed only every 5 minutes. This hub fixes that:
//   - Coins that matter (open positions, Setuh candidates, the coin open in Coin Check, copied tokens) are PINNED on
//     the PumpPortal stream, so their trades keep arriving after graduation (PumpSwap) too.
//   - Every trade updates the price instantly; every price carries the time it was observed.
//   - quote() refuses to hand out data older than the caller's limit: it refreshes, or reports it as stale.
// Nothing here invents a price. If no source has one, the answer is "unavailable".
import { EventEmitter } from 'node:events';
import { dexSnapshots } from './dexscreener.js';

const SUPPLY = 1e9; // every Pump.fun token

export class MarketData extends EventEmitter {
  constructor({ engine, feed, fetchFn = fetch, metrics = null, chain = null, log = console, now = () => Date.now() }) {
    super();
    this.setMaxListeners(50);
    Object.assign(this, { engine, feed, fetchFn, metrics, chain, log, now });
    this.prices = new Map();   // mint -> entry
    this.owners = new Map();   // mint -> Set(owner)
    this.inflight = new Map(); // mint -> Promise (one DexScreener refresh at a time per coin)
    this.counts = { curveTrades: 0, ammTrades: 0, refreshes: 0 };
    this.samples = { lastAt: 0 };
    feed?.on?.('trade', (m) => this.onTrade(m));
    feed?.on?.('create', (m) => this.#sampleLatency(m, 'discovery'));
  }

  get solUsd() { return this.engine?.solUsd ?? 0; }

  /** Live stream is healthy: connected and delivering messages right now. */
  feedHealthy(maxSilenceMs = 5000) {
    if (!this.feed) return false;
    const connected = this.feed.connected ?? this.engine?.feedConnected;
    return Boolean(connected) && this.feed.lastMsgAt > 0 && this.now() - this.feed.lastMsgAt <= maxSilenceMs;
  }

  /** Keep a coin's trades streaming (also after graduation) while `owner` needs it. */
  track(mint, owner) {
    let s = this.owners.get(mint);
    if (!s) { s = new Set(); this.owners.set(mint, s); }
    s.add(owner);
    this.feed?.pin?.(mint);
    if (!this.feed?.watched?.has(mint)) this.feed?.watch?.(mint);
  }
  untrack(mint, owner) {
    const s = this.owners.get(mint);
    if (!s) return;
    s.delete(owner);
    if (s.size) return;
    this.owners.delete(mint);
    this.feed?.unpin?.(mint);
    if (!this.engine?.coins.has(mint)) this.feed?.unwatch?.(mint);
  }
  isTracked(mint) { return Boolean(this.owners.get(mint)?.size) || Boolean(this.engine?.coins.has(mint)); }

  /** Every trade message: Pump.fun curve trades and PumpSwap (graduated) trades. */
  onTrade(msg) {
    const rx = msg._rx ?? this.now();
    const solUsd = this.solUsd;
    if (!(solUsd > 0) || !msg.mint) return;
    const tokens = Number(msg.tokenAmount ?? 0), sol = Number(msg.solAmount ?? 0);
    let mcSol = Number(msg.marketCapSol ?? 0);
    if (!(mcSol > 0) && tokens > 0 && sol > 0) mcSol = (sol / tokens) * SUPPLY; // fall back to this trade's own price
    if (!(mcSol > 0)) return;
    const onCurve = msg.pool ? msg.pool === 'pump' : msg.vTokensInBondingCurve != null;
    onCurve ? this.counts.curveTrades++ : this.counts.ammTrades++;
    const prev = this.prices.get(msg.mint);
    const e = {
      mint: msg.mint, priceUsd: (mcSol * solUsd) / SUPPLY, mcUsd: mcSol * solUsd, mcSol, onCurve,
      vSol: msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : onCurve ? prev?.vSol ?? null : null,
      liqUsd: onCurve ? null : prev?.liqUsd ?? null, liqAt: prev?.liqAt ?? null,
      source: onCurve ? 'Pump.fun live trade' : 'PumpSwap live trade', live: true, at: rx, lastTradeAt: rx,
      symbol: prev?.symbol ?? this.engine?.coins.get(msg.mint)?.symbol ?? '', tradeTimes: [...(prev?.tradeTimes ?? []), rx].slice(-30),
    };
    this.#set(e);
    this.metrics?.count('priceUpdates');
    if (this.prices.size > 20_000) for (const k of [...this.prices.keys()].slice(0, 5000)) if (!this.isTracked(k)) this.prices.delete(k);
    if (this.isTracked(msg.mint)) this.#sampleLatency(msg, 'trade');
  }

  #set(e) {
    this.prices.set(e.mint, e);
    if (this.isTracked(e.mint)) this.emit('price', e);
  }

  /**
   * Keep a paper book on live prices: pin the coins it holds on the stream, push every new price into it,
   * refresh coins the stream can't vouch for, then run time-based exit rules. Returns the periodic sync function.
   */
  bindBook(book, owner) {
    this.on('price', (e) => {
      if (![...book.open.values()].some((p) => p.mint === e.mint)) return;
      book.updatePrice(e.mint, { priceUsd: e.priceUsd, mcUsd: e.mcUsd, vSol: e.vSol, liqUsd: e.liqUsd, onCurve: e.onCurve, source: e.source });
    });
    return async () => {
      const held = new Set([...book.open.values()].map((p) => p.mint));
      for (const m of held) this.track(m, owner);
      for (const [m, s] of [...this.owners]) if (s.has(owner) && !held.has(m)) this.untrack(m, owner);
      const stale = [...held].filter((m) => {
        const q = this.get(m);
        // stale price, or a graduated coin whose pool liquidity (not in trade messages) is older than a minute
        return !q || q.ageMs > 15_000 || (!q.onCurve && (q.liqUsd == null || this.now() - (q.liqAt ?? 0) > 60_000));
      });
      await Promise.all(stale.slice(0, 30).map((m) => this.refresh(m).catch(() => null)));
      for (const m of held) {
        const q = this.get(m);
        if (q) book.updatePrice(m, { priceUsd: q.priceUsd, mcUsd: q.mcUsd, vSol: q.vSol, liqUsd: q.liqUsd, onCurve: q.onCurve, source: q.source });
      }
      book.tick();
    };
  }

  /**
   * How old the price is. For a coin on a healthy live stream, the price is current up to the stream's last
   * message (no trade = no price change). Otherwise its age is the time since it was observed.
   */
  freshness(mint) {
    const e = this.prices.get(mint);
    if (!e) return { known: false, ageMs: Infinity, basis: 'no data' };
    const streaming = e.live && this.isTracked(mint) && this.feedHealthy();
    if (streaming) return { known: true, ageMs: Math.max(0, this.now() - this.feed.lastMsgAt), basis: `live stream (last trade ${Math.round((this.now() - e.lastTradeAt) / 1000)}s ago)`, streaming: true };
    return { known: true, ageMs: this.now() - e.at, basis: e.live ? 'last live trade (stream not confirming now)' : `polled from ${e.source}`, streaming: false };
  }

  get(mint) {
    const e = this.prices.get(mint);
    if (!e) return null;
    const f = this.freshness(mint);
    const intervals = e.tradeTimes?.length > 1 ? (e.tradeTimes.at(-1) - e.tradeTimes[0]) / (e.tradeTimes.length - 1) : null;
    return { ...e, tradeTimes: undefined, ageMs: f.ageMs, basis: f.basis, streaming: f.streaming, avgTradeGapMs: intervals };
  }

  /**
   * A price no older than maxAgeMs, or null with the reason. Refreshes from DexScreener when the stream can't vouch
   * for the price. needLiquidity: also require a known pool liquidity for graduated coins.
   */
  async quote(mint, { maxAgeMs = 10_000, needLiquidity = false } = {}) {
    let q = this.get(mint);
    const ok = (x) => x && x.ageMs <= maxAgeMs && (!needLiquidity || x.onCurve || (x.liqUsd != null && this.now() - (x.liqAt ?? 0) < 120_000));
    if (ok(q)) return { ok: true, quote: q };
    await this.refresh(mint).catch(() => null);
    q = this.get(mint);
    if (ok(q)) return { ok: true, quote: q };
    return { ok: false, quote: q, reason: !q ? 'No price from any source' : q.ageMs > maxAgeMs ? `Price is ${(q.ageMs / 1000).toFixed(1)}s old (limit ${(maxAgeMs / 1000).toFixed(0)}s) and could not be refreshed` : 'Pool liquidity unknown' };
  }

  /** DexScreener snapshot: fills price (if the stream has nothing newer) and pool liquidity. */
  refresh(mint) {
    if (this.inflight.has(mint)) return this.inflight.get(mint);
    const p = (async () => {
      const t0 = performance.now();
      const s = (await dexSnapshots([mint], { fetchFn: this.fetchFn })).get(mint);
      this.metrics?.time('priceRefresh', performance.now() - t0, 'DexScreener refresh');
      this.counts.refreshes++;
      if (!s) return null;
      const now = this.now();
      const prev = this.prices.get(mint);
      const liveNewer = prev?.live && now - prev.lastTradeAt < 30_000;
      this.#set(liveNewer
        ? { ...prev, liqUsd: s.onCurve ? prev.liqUsd : s.liqUsd, liqAt: now, symbol: prev.symbol || s.symbol }
        : { mint, priceUsd: s.priceUsd, mcUsd: s.mcUsd, mcSol: this.solUsd ? s.mcUsd / this.solUsd : null, onCurve: s.onCurve, vSol: prev?.vSol ?? null,
            liqUsd: s.liqUsd, liqAt: now, source: 'DexScreener', live: false, at: now, lastTradeAt: prev?.lastTradeAt ?? null, symbol: s.symbol, tradeTimes: prev?.tradeTimes ?? [] });
      return s;
    })().finally(() => this.inflight.delete(mint));
    this.inflight.set(mint, p);
    return p;
  }

  /**
   * Measured stream latency: for a small sample of messages, ask the chain when the transaction landed
   * (block time, 1-second resolution) and compare with when the bot received it.
   */
  #sampleLatency(msg, kind) {
    if (!this.chain?.enabled || typeof this.chain.rpc !== 'function' || !msg.signature) return;
    const now = this.now();
    if (now - this.samples.lastAt < (kind === 'discovery' ? 10_000 : 20_000)) return;
    this.samples.lastAt = now;
    const rx = msg._rx ?? now;
    setTimeout(() => {
      this.chain.rpc('getTransaction', [msg.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
        .then((tx) => { if (tx?.blockTime) this.metrics?.time(kind === 'discovery' ? 'discoveryLatency' : 'tradeLatency', Math.max(0, rx - tx.blockTime * 1000), kind === 'discovery' ? 'Coin discovery (on-chain → bot)' : 'Trade data (on-chain → bot)'); })
        .catch(() => {});
    }, 4000).unref?.();
  }

  view() {
    return { tracked: this.owners.size, known: this.prices.size, counts: this.counts, feedHealthy: this.feedHealthy(),
      feedLastMsgAgeMs: this.feed?.lastMsgAt ? this.now() - this.feed.lastMsgAt : null };
  }
}
