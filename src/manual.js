// Coin Check & Paper Trade: YOUR simulated positions on coins you pick yourself.
// No real money and no wallet: positions are numbers in the bot's database.
//
// Prices update in real time from the bot's live Pump.fun feed (every trade), and from DexScreener
// every 10 seconds for everything else. Values are shown honestly: "if sold now" includes trading
// fees and the slippage your position size would cause in the current pool.
import { liquidityRead, cashOut, curveVSolFromMc, priceImpact } from './liquidity.js';

const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Pull a Solana address out of a pasted address or link (pump.fun, DexScreener, Padre, GMGN, ...). */
export function extractAddress(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
  let path = s;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); path = `${u.pathname} ${u.search}`; } catch { /* not a URL */ }
  const found = path.match(B58) ?? [];
  // pump.fun-style addresses end in "pump"; otherwise take the longest candidate
  return found.find((a) => a.endsWith('pump')) ?? found.sort((a, b) => b.length - a.length)[0] ?? null;
}

const nowId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class ManualPaper {
  constructor({ store, cfg, engine = null, feed = null, chain = null, fetchFn = fetch, log = console }) {
    Object.assign(this, { store, cfg, engine, feed, chain, fetchFn, log });
    const saved = store.getKv('manualPaper') ?? {};
    this.open = new Map((saved.open ?? []).map((p) => [p.id, p]));
    this.closed = saved.closed ?? [];
    feed?.on?.('trade', (m) => this.onTrade(m));
  }

  get solUsd() { return this.engine?.solUsd ?? 0; }
  #save() { this.store.setKv('manualPaper', { open: [...this.open.values()], closed: this.closed.slice(0, 200) }); }

  start() {
    const loop = async () => { try { await this.poll(); } catch (e) { this.log.warn(`paper positions: ${e.message}`); } };
    setInterval(loop, 10_000).unref?.();
    loop();
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
    // Is it a token mint? Ask the chain if we can, otherwise DexScreener
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
    const c = this.engine?.coins.get(mint);
    const solUsd = this.solUsd;
    if (c && !c.migrated && solUsd > 0 && c.mcSol > 0) {
      return { mint, symbol: c.symbol, name: c.name, priceUsd: (c.mcSol * solUsd) / 1e9, mcUsd: c.mcSol * solUsd, supply: 1e9,
        onCurve: true, vSol: c.vSol, liqUsd: null, source: 'live feed' };
    }
    const t = await this.#json(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const p = (t.pairs ?? []).filter((x) => x.chainId === 'solana' && x.baseToken?.address === mint)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!p || !(Number(p.priceUsd) > 0)) throw new Error('No price found for this coin yet (it may be too new for DexScreener)');
    const priceUsd = Number(p.priceUsd), mcUsd = p.marketCap ?? p.fdv ?? 0;
    const onCurve = /pump\.?fun/i.test(p.dexId ?? '') && !/swap/i.test(p.dexId ?? '');
    return { mint, symbol: p.baseToken?.symbol ?? '', name: p.baseToken?.name ?? '', priceUsd, mcUsd,
      supply: mcUsd && priceUsd ? mcUsd / priceUsd : 1e9, onCurve, vSol: null, liqUsd: p.liquidity?.usd ?? 0, source: 'DexScreener' };
  }

  /** Pool depth in $ (null = unknown, 0 = no pool to trade against). */
  #depth(pos) {
    const L = liquidityRead({ onCurve: pos.onCurve, vSol: pos.vSol, liqUsd: pos.liqUsd ?? 0, mcUsd: pos.mcUsd, solUsd: this.solUsd,
      orderUsd: pos.budgetUsd });
    return L ? L.depthUsd : null;
  }

  #feePct() { return (this.cfg.paperFeePct ?? 1.25) + (this.cfg.paperTerminalFeePct ?? 1); }
  #txUsd() { return (this.cfg.paperTxFeeSol ?? 0.0015) * (this.solUsd || 150); }

  /** Start a simulated position with `budgetUsd` (fees and entry slippage are taken off up front). */
  async openPosition({ mint, budgetUsd }) {
    budgetUsd = Number(budgetUsd);
    if (!(budgetUsd >= 1 && budgetUsd <= 1_000_000)) throw new Error('Budget must be between $1 and $1,000,000');
    const snap = await this.snapshot(mint);
    const pos = { id: nowId(), ...snap, budgetUsd, openedAt: Date.now(), entryPriceUsd: snap.priceUsd, entryMcUsd: snap.mcUsd, history: [] };
    const depth = this.#depth(pos);
    if (depth === 0) throw new Error('This coin has no liquidity pool to trade against, so a buy (or a later sale) would not fill');
    // average slippage for this order size against the pool, plus sandwich-bot losses on buys
    const slipPct = (depth ? priceImpact(budgetUsd, depth).avgPct : 0) + (this.cfg.paperMevPct ?? 2);
    const spendable = Math.max(0, budgetUsd - this.#txUsd()) * (1 - this.#feePct() / 100);
    pos.tokens = (spendable / snap.priceUsd) / (1 + slipPct / 100);
    pos.entrySlipPct = slipPct;
    pos.depthKnown = depth != null;
    Object.assign(pos, { priceUsd: snap.priceUsd, mcUsd: snap.mcUsd, lastAt: Date.now(), peakPriceUsd: snap.priceUsd, lowPriceUsd: snap.priceUsd });
    pos.history.push([pos.lastAt, snap.priceUsd]);
    this.open.set(pos.id, pos);
    if (snap.onCurve && this.feed && !this.feed.watched?.has(mint)) this.feed.watch?.(mint);
    this.#save();
    return this.#view(pos);
  }

  /** Lock in the simulated result at the current "if sold now" value. */
  closePosition(id) {
    const pos = this.open.get(id);
    if (!pos) throw new Error('Position not found');
    const v = this.#value(pos);
    this.open.delete(id);
    this.closed.unshift({ id, mint: pos.mint, symbol: pos.symbol, name: pos.name, budgetUsd: pos.budgetUsd, openedAt: pos.openedAt,
      closedAt: Date.now(), exitUsd: v.ifSoldUsd, pnlUsd: v.ifSoldUsd - pos.budgetUsd, pnlPct: (v.ifSoldUsd / pos.budgetUsd - 1) * 100,
      entryMcUsd: pos.entryMcUsd, exitMcUsd: pos.mcUsd });
    this.#save();
    return this.closed[0];
  }

  /** Live trades from the bot's Pump.fun feed: instant price updates for curve coins. */
  onTrade(msg) {
    const solUsd = this.solUsd;
    if (!(solUsd > 0) || msg.marketCapSol == null) return;
    for (const pos of this.open.values()) {
      if (pos.mint !== msg.mint || !pos.onCurve) continue;
      const mcUsd = Number(msg.marketCapSol) * solUsd;
      this.#update(pos, { priceUsd: mcUsd / (pos.supply || 1e9), mcUsd, vSol: msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : pos.vSol, source: 'live feed' });
    }
  }

  #update(pos, { priceUsd, mcUsd, vSol, liqUsd, onCurve, source }) {
    if (!(priceUsd > 0)) return;
    Object.assign(pos, { priceUsd, mcUsd, lastAt: Date.now(), source });
    if (vSol != null) pos.vSol = vSol;
    if (liqUsd != null) pos.liqUsd = liqUsd;
    if (onCurve != null) pos.onCurve = onCurve;
    pos.peakPriceUsd = Math.max(pos.peakPriceUsd ?? priceUsd, priceUsd);
    pos.lowPriceUsd = Math.min(pos.lowPriceUsd ?? priceUsd, priceUsd);
    const last = pos.history.at(-1);
    if (!last || pos.lastAt - last[0] >= 5_000) { pos.history.push([pos.lastAt, priceUsd]); if (pos.history.length > 360) pos.history.shift(); }
  }

  /** DexScreener refresh for every open position (one request for up to 30 coins). */
  async poll() {
    const all = [...this.open.values()];
    // keep the live feed subscribed for curve coins (the bot may have stopped tracking them)
    for (const p of all) if (p.onCurve && this.feed && !this.feed.watched?.has(p.mint)) this.feed.watch?.(p.mint);
    const mints = [...new Set(all.filter((p) => !(p.source === 'live feed' && Date.now() - p.lastAt < 30_000)).map((p) => p.mint))];
    for (let i = 0; i < mints.length; i += 30) {
      const t = await this.#json(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(i, i + 30).join(',')}`).catch(() => null);
      for (const p of t?.pairs ?? []) {
        if (p.chainId !== 'solana') continue;
        for (const pos of this.open.values()) {
          if (pos.mint !== p.baseToken?.address) continue;
          const better = !pos._pair || pos._pair === p.pairAddress || (p.liquidity?.usd ?? 0) > (pos.liqUsd ?? 0);
          if (!better) continue;
          pos._pair = p.pairAddress;
          const onCurve = /pump\.?fun/i.test(p.dexId ?? '') && !/swap/i.test(p.dexId ?? '');
          this.#update(pos, { priceUsd: Number(p.priceUsd), mcUsd: p.marketCap ?? p.fdv ?? pos.mcUsd, liqUsd: p.liquidity?.usd ?? 0,
            onCurve, vSol: onCurve && this.solUsd > 0 && p.marketCap ? curveVSolFromMc(p.marketCap / this.solUsd) : null, source: 'DexScreener' });
        }
      }
    }
    if (all.length) this.#save();
  }

  /** Market value, and what selling everything now would really bring after fees and slippage. */
  #value(pos) {
    const marketUsd = pos.tokens * pos.priceUsd;
    const depth = this.#depth(pos);
    // unknown depth: no slippage estimate; no pool at all: nothing can be sold
    const slip = depth == null ? 0 : cashOut(marketUsd, depth).lossPct;
    const ifSoldUsd = Math.max(0, marketUsd * (1 - slip / 100) * (1 - this.#feePct() / 100) - this.#txUsd());
    return { marketUsd, ifSoldUsd, exitSlipPct: slip };
  }

  #view(pos) {
    const v = this.#value(pos);
    return {
      id: pos.id, mint: pos.mint, symbol: pos.symbol, name: pos.name, budgetUsd: pos.budgetUsd, openedAt: pos.openedAt,
      entryPriceUsd: pos.entryPriceUsd, entryMcUsd: pos.entryMcUsd, priceUsd: pos.priceUsd, mcUsd: pos.mcUsd,
      priceChangePct: (pos.priceUsd / pos.entryPriceUsd - 1) * 100, marketUsd: v.marketUsd, ifSoldUsd: v.ifSoldUsd,
      pnlUsd: v.ifSoldUsd - pos.budgetUsd, pnlPct: (v.ifSoldUsd / pos.budgetUsd - 1) * 100, exitSlipPct: v.exitSlipPct,
      entrySlipPct: pos.entrySlipPct, depthUsd: this.#depth(pos), onCurve: pos.onCurve, liqUsd: pos.liqUsd, source: pos.source, lastAt: pos.lastAt,
      history: pos.history.slice(-120).map(([, p]) => p),
    };
  }

  view() {
    const open = [...this.open.values()].map((p) => this.#view(p)).sort((a, b) => b.openedAt - a.openedAt);
    const invested = open.reduce((s, p) => s + p.budgetUsd, 0), now = open.reduce((s, p) => s + p.ifSoldUsd, 0);
    const realized = this.closed.reduce((s, c) => s + c.pnlUsd, 0);
    return { open, closed: this.closed.slice(0, 20),
      totals: { invested, value: now, pnlUsd: now - invested, pnlPct: invested ? (now / invested - 1) * 100 : 0, realizedUsd: realized, closedCount: this.closed.length } };
  }
}
