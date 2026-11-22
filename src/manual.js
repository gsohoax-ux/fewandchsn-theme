// Coin Check & Paper Trade: YOUR simulated positions on coins you pick yourself.
// No real money and no wallet: positions are numbers in the bot's database (book "manual").
//
// Prices update from the bot's live Pump.fun feed (every trade) and from DexScreener every 10 seconds.
// Stop-loss, take-profit and trailing stops run here on the server, so they work with the app closed.
import { PaperBook } from './paperbook.js';
import { dexSnapshots, bestPairs } from './dexscreener.js';
import { curveVSolFromMc } from './liquidity.js';

const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Pull a Solana address out of a pasted address or link (pump.fun, DexScreener, Padre, Axiom, GMGN, ...). */
export function extractAddress(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 500) return null;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
  let path = s;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); path = `${u.pathname} ${u.search}`; } catch { /* not a URL */ }
  const found = path.match(B58) ?? [];
  // pump.fun-style addresses end in "pump"; otherwise take the longest candidate
  return found.find((a) => a.endsWith('pump')) ?? found.sort((a, b) => b.length - a.length)[0] ?? null;
}

export class ManualPaper {
  constructor({ store, cfg, engine = null, feed = null, chain = null, market = null, fetchFn = fetch, log = console, now = () => Date.now() }) {
    Object.assign(this, { store, cfg, engine, feed, chain, market, fetchFn, log });
    this.book = new PaperBook({ store, cfg, book: 'manual', getSolUsd: () => this.solUsd, log, now });
    this.#migrateOld();
    // with the market hub, prices are pushed in live (also after graduation); otherwise the old feed + polling path
    this.sync = market ? market.bindBook(this.book, 'manual') : null;
    if (!market) feed?.on?.('trade', (m) => this.onTrade(m));
  }

  get solUsd() { return this.engine?.solUsd ?? 0; }
  get open() { return this.book.open; }

  /** Positions saved by the first version (kv "manualPaper") move into the book once. */
  #migrateOld() {
    const old = this.store.getKv('manualPaper');
    if (!old?.open?.length) return;
    for (const p of old.open) {
      if (!(p.tokens > 0) || [...this.book.open.values()].some((x) => x.id === p.id)) continue;
      const pos = { id: p.id, book: 'manual', origin: 'manual', status: 'open', mint: p.mint, symbol: p.symbol, name: p.name,
        supply: p.supply || 1e9, onCurve: p.onCurve, vSol: p.vSol ?? null, liqUsd: p.liqUsd ?? null, priceUsd: p.priceUsd, mcUsd: p.mcUsd,
        source: p.source, lastAt: p.lastAt, budgetUsd: p.budgetUsd, openedAt: p.openedAt, closedAt: null, exitReason: null, meta: {},
        tokensInit: p.tokens, tokens: p.tokens, refPriceUsd: p.entryPriceUsd, entryPriceUsd: p.budgetUsd / p.tokens, entryMcUsd: p.entryMcUsd,
        entrySlipPct: p.entrySlipPct ?? 0, depthKnown: true, realizedUsd: 0, soldCostUsd: 0, feesUsd: 0, slippageUsd: 0,
        peakPriceUsd: p.peakPriceUsd ?? p.priceUsd, lowPriceUsd: p.lowPriceUsd ?? p.priceUsd, trailHighUsd: p.priceUsd,
        history: p.history ?? [], fills: [], risk: {} };
      this.book.open.set(pos.id, pos);
      this.store.saveSimPosition('manual', pos);
    }
    this.store.setKv('manualPaper', { migrated: true, open: [], closed: old.closed ?? [] });
  }

  start(health = null) {
    const loop = () => (this.sync ? this.sync() : this.poll());
    if (health) health.job('Manual positions: prices + exits', loop, 10_000);
    else { setInterval(() => loop().catch((e) => this.log.warn(`paper positions: ${e.message}`)), 10_000).unref?.(); loop().catch(() => {}); }
  }

  async #json(url) {
    const res = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Turn a pasted address or link into the coin's mint address (links to a trading pair are looked up). */
  async resolve(input) {
    const addr = extractAddress(input);
    if (!addr) throw new Error('No Solana address found in that text or link');
    if (this.engine?.coins.has(addr)) return addr;
    if (this.chain?.enabled) {
      try {
        const r = await this.chain.rpc('getAccountInfo', [addr, { encoding: 'jsonParsed' }]);
        if (r?.value?.data?.parsed?.type === 'mint') return addr;
      } catch { /* fall through */ }
    }
    try {
      const t = await this.#json(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
      if ((t.pairs ?? []).some((p) => p.baseToken?.address === addr)) return addr;
    } catch { /* fall through */ }
    try {
      const p = await this.#json(`https://api.dexscreener.com/latest/dex/pairs/solana/${addr}`);
      const base = (p.pairs ?? [p.pair]).filter(Boolean)[0]?.baseToken?.address;
      if (base) return base;
    } catch { /* fall through */ }
    return addr; // brand-new coins may not be on DexScreener yet; the check will tell
  }

  /** Current market snapshot for a coin: live bot data if it tracks it, else DexScreener. */
  async snapshot(mint) {
    if (this.market) {
      // freshest price from the live stream (refreshed if it can't vouch for it), never an old snapshot
      this.market.track(mint, 'manual');
      const r = await this.market.quote(mint, { maxAgeMs: 10_000, needLiquidity: true });
      if (r.ok) {
        const q = r.quote;
        const c = this.engine?.coins.get(mint);
        return { mint, symbol: q.symbol || c?.symbol || '', name: c?.name ?? '', priceUsd: q.priceUsd, mcUsd: q.mcUsd, supply: 1e9, onCurve: q.onCurve,
          vSol: q.vSol ?? (q.onCurve && this.solUsd > 0 ? curveVSolFromMc(q.mcUsd / this.solUsd) : null), liqUsd: q.liqUsd, source: q.source, ageMs: q.ageMs };
      }
      if (r.quote) throw new Error(`Live price not reliable right now: ${r.reason}. New paper positions are blocked until fresh data returns.`);
    }
    const c = this.engine?.coins.get(mint);
    const solUsd = this.solUsd;
    if (c && !c.migrated && solUsd > 0 && c.mcSol > 0) {
      return { mint, symbol: c.symbol, name: c.name, priceUsd: (c.mcSol * solUsd) / 1e9, mcUsd: c.mcSol * solUsd, supply: 1e9,
        onCurve: true, vSol: c.vSol, liqUsd: null, source: 'live feed' };
    }
    const t = await this.#json(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const s = bestPairs(t.pairs, [mint]).get(mint);
    if (!s) throw new Error('No price found for this coin yet (it may be too new for DexScreener)');
    return { ...s, vSol: s.onCurve && solUsd > 0 && s.mcUsd ? curveVSolFromMc(s.mcUsd / solUsd) : null };
  }

  /** Start a simulated position with `budgetUsd`; risk = optional stop/target/trail. */
  async openPosition({ mint, budgetUsd, risk = {}, requestId = null }) {
    const snap = await this.snapshot(mint);
    const pos = this.book.openPosition({ snap, budgetUsd, origin: 'manual', risk, idemKey: requestId ? `manual:${requestId}` : null });
    if (snap.onCurve && this.feed && !this.feed.watched?.has(mint)) this.feed.watch?.(mint);
    return this.book.view(pos);
  }

  sell(id, pct, requestId = null) {
    const r = this.book.sell(id, pct, { reason: `Manual sell ${pct}%`, idemKey: requestId ? `manual:${id}:${requestId}` : null });
    return { duplicate: r.duplicate, position: this.book.view(r.position) };
  }

  setRisk(id, risk) { return this.book.view(this.book.setRisk(id, risk)); }

  /** Sell everything at the current "if sold now" value. */
  closePosition(id, requestId = null) {
    const r = this.book.sell(id, 100, { reason: 'Closed manually', idemKey: requestId ? `manual:${id}:${requestId}` : null });
    const v = this.book.view(r.position);
    return { ...v, exitUsd: v.proceedsUsd };
  }

  /** Live trades from the bot's Pump.fun feed: instant price updates (and exits) for curve coins. */
  onTrade(msg) {
    const solUsd = this.solUsd;
    if (!(solUsd > 0) || msg.marketCapSol == null) return;
    if (![...this.book.open.values()].some((p) => p.mint === msg.mint && p.onCurve)) return;
    const mcUsd = Number(msg.marketCapSol) * solUsd;
    this.book.updatePrice(msg.mint, { priceUsd: mcUsd / 1e9, mcUsd, vSol: msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : null, source: 'live feed' });
  }

  /** DexScreener refresh for open positions not covered by the live feed in the last 30 s, then time rules. */
  async poll() {
    const all = [...this.book.open.values()];
    for (const p of all) if (p.onCurve && this.feed && !this.feed.watched?.has(p.mint)) this.feed.watch?.(p.mint);
    const now = Date.now();
    const mints = all.filter((p) => !(p.source === 'live feed' && now - p.lastAt < 30_000)).map((p) => p.mint);
    if (mints.length) {
      const snaps = await dexSnapshots(mints, { fetchFn: this.fetchFn });
      for (const [mint, s] of snaps) {
        this.book.updatePrice(mint, { priceUsd: s.priceUsd, mcUsd: s.mcUsd, liqUsd: s.liqUsd, onCurve: s.onCurve,
          vSol: s.onCurve && this.solUsd > 0 && s.mcUsd ? curveVSolFromMc(s.mcUsd / this.solUsd) : null, source: 'DexScreener' });
      }
    }
    this.book.tick();
  }

  view() {
    const open = this.book.openViews();
    const closed = this.book.closedViews(100);
    const s = this.book.summary(closed, open);
    return { open, closed: closed.slice(0, 50).map((c) => ({ ...c, exitUsd: c.proceedsUsd })),
      totals: s };
  }
}
