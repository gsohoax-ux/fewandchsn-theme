// A book of simulated positions: open, partial and full sells, stop-loss, take-profit, trailing stop,
// realistic fees and slippage, P&L, and a fill history.
//
// Two separate books use this: "manual" (Coin Check & Paper Trade) and "strategy" (the Setuh strategy
// engine). Each book only loads and manages its own rows, so they can never touch each other's
// positions. The automatic alert paper trader (paper.js, System A) is a different engine and is not used here.
//
// Exits run on the server whenever a price arrives (live feed or polling), never in the browser.
// Every sell has an idempotency key that is unique in the database, so a trigger can never fire twice.
import { liquidityRead, cashOut, priceImpact } from './liquidity.js';

const DUST = 1e-9;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const num = (x) => (x === '' || x == null ? null : Number(x));

/** Check and normalize stop-loss / take-profit / trailing settings. Throws on bad input. */
export function normalizeRisk(input = {}, entryPriceUsd = null) {
  const r = {};
  const pct = (v, name, lo, hi) => {
    const n = num(v);
    if (n == null) return null;
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
    return n;
  };
  const price = (v, name) => {
    const n = num(v);
    if (n == null) return null;
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive price`);
    return n;
  };
  r.stopPct = pct(input.stopPct, 'Stop-loss %', 0.1, 99.9);
  r.stopPrice = price(input.stopPrice, 'Stop-loss price');
  r.tpPct = pct(input.tpPct, 'Take-profit %', 0.1, 100_000);
  r.tpPrice = price(input.tpPrice, 'Take-profit price');
  r.tpSellPct = pct(input.tpSellPct ?? 100, 'Take-profit sell %', 1, 100);
  r.trailPct = pct(input.trailPct, 'Trailing stop %', 0.1, 99.9);
  r.maxHoldMin = pct(input.maxHoldMin, 'Max hold (minutes)', 1, 60 * 24 * 30);
  if (r.stopPct != null && r.stopPrice != null) throw new Error('Set the stop-loss as a % or a price, not both');
  if (r.tpPct != null && r.tpPrice != null) throw new Error('Set the take-profit as a % or a price, not both');
  if (entryPriceUsd > 0) {
    if (r.stopPrice != null && r.stopPrice >= entryPriceUsd * 10) throw new Error('Stop-loss price is far above the entry price');
  }
  return r;
}

export class PaperBook {
  /**
   * book: 'manual' | 'strategy'. getSolUsd: () => SOL price. onEvent(evt): optional, called on fills.
   */
  constructor({ store, cfg, book, getSolUsd = () => 0, onEvent = null, log = console, now = () => Date.now() }) {
    if (!['manual', 'strategy', 'copy'].includes(book)) throw new Error(`unknown book ${book}`);
    Object.assign(this, { store, cfg, book, getSolUsd, onEvent, log, now });
    this.open = new Map(this.store.simPositions(book, 'open').map((p) => [p.id, p]));
    this.busy = new Set(); // positions with a sell in progress (no overlapping executions)
  }

  #feePct() { return (this.cfg.paperFeePct ?? 1.25) + (this.cfg.paperTerminalFeePct ?? 1); }
  #txUsd() { return (this.cfg.paperTxFeeSol ?? 0.0015) * (this.getSolUsd() || 150); }
  #save(pos) { this.store.saveSimPosition(this.book, pos); }

  /** Pool depth in $ (null = unknown, 0 = no pool to trade against). */
  depth(pos, orderUsd = 50) {
    const L = liquidityRead({ onCurve: pos.onCurve, vSol: pos.vSol, liqUsd: pos.liqUsd ?? 0, mcUsd: pos.mcUsd, solUsd: this.getSolUsd(), orderUsd });
    return L ? L.depthUsd : null;
  }

  /**
   * Open a position. snap = { mint, symbol, name, priceUsd, mcUsd, supply, onCurve, vSol, liqUsd, source }.
   * origin = 'manual' or a strategy setup id. risk = stop/target/trail settings. meta = anything to keep.
   */
  openPosition({ snap, budgetUsd, origin = 'manual', risk = {}, meta = {}, idemKey = null }) {
    budgetUsd = Number(budgetUsd);
    if (!(budgetUsd >= 1 && budgetUsd <= 1_000_000)) throw new Error('Budget must be between $1 and $1,000,000');
    if (!(snap?.priceUsd > 0)) throw new Error('No live price for this coin, so a simulated buy is not possible');
    if (idemKey && [...this.open.values()].some((p) => p.idemKey === idemKey)) throw new Error('This position was already opened');
    const now = this.now();
    const pos = {
      id: newId(), book: this.book, origin, idemKey, status: 'open', mint: snap.mint, symbol: snap.symbol ?? '', name: snap.name ?? '',
      supply: snap.supply || 1e9, onCurve: Boolean(snap.onCurve), vSol: snap.vSol ?? null, liqUsd: snap.liqUsd ?? null,
      priceUsd: snap.priceUsd, mcUsd: snap.mcUsd, source: snap.source ?? '', lastAt: now,
      budgetUsd, openedAt: now, closedAt: null, exitReason: null, meta,
    };
    const b = this.#buyFill(pos, budgetUsd, snap.priceUsd);
    Object.assign(pos, {
      tokensInit: b.tokens, tokens: b.tokens, costOpenUsd: budgetUsd, refPriceUsd: snap.priceUsd, entryPriceUsd: budgetUsd / b.tokens, entryMcUsd: snap.mcUsd,
      entrySlipPct: b.slipPct, depthKnown: b.depthKnown,
      realizedUsd: 0, soldCostUsd: 0, feesUsd: b.feesUsd, slippageUsd: b.slippageUsd,
      peakPriceUsd: snap.priceUsd, lowPriceUsd: snap.priceUsd, trailHighUsd: snap.priceUsd,
      history: [[now, snap.priceUsd]], fills: [],
    });
    pos.risk = normalizeRisk(risk, snap.priceUsd);
    pos.fills.push({ at: now, kind: 'buy', reason: meta.buyReason ?? (origin === 'manual' ? 'Manual buy' : `Strategy entry (${origin})`), pct: 100, tokens: b.tokens,
      priceUsd: snap.priceUsd, grossUsd: budgetUsd, feesUsd: b.feesUsd, slippageUsd: b.slippageUsd, netUsd: -budgetUsd, mcUsd: snap.mcUsd });
    this.store.addSimFill(this.book, { positionId: pos.id, idemKey: `${pos.id}:open`, ...pos.fills[0] });
    this.open.set(pos.id, pos);
    this.#save(pos);
    this.store.audit(origin === 'manual' ? 'user' : 'system', this.book, 'open', { id: pos.id, mint: pos.mint, budgetUsd, priceUsd: snap.priceUsd, risk: pos.risk });
    return pos;
  }

  /** Tokens a buy of budgetUsd gets at priceUsd after fees, network fee, price impact and sandwich losses. */
  #buyFill(pos, budgetUsd, priceUsd) {
    const depth = this.depth({ ...pos, priceUsd }, budgetUsd);
    if (depth === 0) throw new Error('This coin has no liquidity pool to trade against, so a buy (or a later sale) would not fill');
    const impactPct = depth ? priceImpact(budgetUsd, depth).avgPct : 0;
    const slipPct = impactPct + (this.cfg.paperMevPct ?? 2);
    const txUsd = this.#txUsd();
    const feeUsd = Math.max(0, budgetUsd - txUsd) * (this.#feePct() / 100);
    const spendable = Math.max(0, budgetUsd - txUsd - feeUsd);
    const tokens = spendable / priceUsd / (1 + slipPct / 100);
    return { tokens, slipPct, feesUsd: feeUsd + txUsd, slippageUsd: spendable - tokens * priceUsd, depthKnown: depth != null };
  }

  /**
   * Buy more into an open position (average-cost accounting). The current market state in `snap`
   * is applied first, so the add fills at today's price, not the original entry.
   */
  addToPosition(id, { snap, budgetUsd, reason = 'Added to position', idemKey = null, actor = 'system' }) {
    const pos = this.#get(id);
    budgetUsd = Number(budgetUsd);
    if (!(budgetUsd >= 1 && budgetUsd <= 1_000_000)) throw new Error('Add amount must be between $1 and $1,000,000');
    if (!(snap?.priceUsd > 0)) throw new Error('No live price for this coin, so a simulated buy is not possible');
    this.updatePrice(pos.mint, snap);
    if (pos.status !== 'open') throw new Error('Position closed while updating the price');
    const b = this.#buyFill(pos, budgetUsd, snap.priceUsd);
    const now = this.now();
    const fill = { at: now, kind: 'buy', reason, pct: null, tokens: b.tokens, priceUsd: snap.priceUsd, grossUsd: budgetUsd,
      feesUsd: b.feesUsd, slippageUsd: b.slippageUsd, netUsd: -budgetUsd, mcUsd: snap.mcUsd };
    if (!this.store.addSimFill(this.book, { positionId: pos.id, idemKey: idemKey ?? `${pos.id}:add:${now}`, ...fill })) return { duplicate: true, position: pos };
    // market reference price for % stops/targets: token-weighted average of the market prices paid
    pos.refPriceUsd = (pos.refPriceUsd * pos.tokens + snap.priceUsd * b.tokens) / (pos.tokens + b.tokens);
    pos.tokens += b.tokens;
    pos.tokensInit += b.tokens;
    pos.budgetUsd += budgetUsd;
    pos.costOpenUsd = (pos.costOpenUsd ?? pos.budgetUsd - budgetUsd - pos.soldCostUsd) + budgetUsd;
    pos.entryPriceUsd = pos.costOpenUsd / pos.tokens;
    pos.feesUsd += b.feesUsd;
    pos.slippageUsd += b.slippageUsd;
    pos.fills.push(fill);
    this.#save(pos);
    this.store.audit(actor, this.book, 'add', { id: pos.id, mint: pos.mint, budgetUsd, priceUsd: snap.priceUsd, reason });
    this.onEvent?.({ type: 'buy', book: this.book, position: pos, fill });
    return { duplicate: false, position: pos, fill };
  }

  /** Change stop / target / trail on an open position (null or '' clears a setting). */
  setRisk(id, risk) {
    const pos = this.#get(id);
    pos.risk = normalizeRisk({ ...risk }, pos.refPriceUsd);
    // a fresh trailing stop starts from the current price, not an old high
    if (pos.risk.trailPct != null && risk.resetTrail !== false) pos.trailHighUsd = pos.priceUsd;
    this.#save(pos);
    this.store.audit('user', this.book, 'risk', { id, risk: pos.risk });
    this.#checkTriggers(pos);
    return pos;
  }

  #get(id) {
    const pos = this.open.get(String(id));
    if (!pos) throw new Error('Position not found (it may already be closed)');
    return pos;
  }

  /** Price levels that trigger exits, from the settings. */
  levels(pos) {
    const r = pos.risk ?? {};
    const ref = pos.refPriceUsd;
    return {
      stop: r.stopPrice ?? (r.stopPct != null ? ref * (1 - r.stopPct / 100) : null),
      target: r.tpPrice ?? (r.tpPct != null ? ref * (1 + r.tpPct / 100) : null),
      trail: r.trailPct != null ? pos.trailHighUsd * (1 - r.trailPct / 100) : null,
    };
  }

  /**
   * Sell `pct` % of the CURRENT remaining tokens at the current price.
   * idemKey makes the sell happen at most once (button double-taps, repeated triggers).
   */
  sell(id, pct, { reason = 'Manual sell', idemKey = null, actor = 'user' } = {}) {
    const pos = this.#get(id);
    pct = Number(pct);
    if (!(pct > 0 && pct <= 100)) throw new Error('Sell % must be between 0 and 100');
    if (this.busy.has(pos.id)) throw new Error('A sell for this position is already being processed');
    this.busy.add(pos.id);
    try {
      const key = idemKey ?? `${pos.id}:${this.now()}:${pct}:${reason}`;
      const tokens = pct >= 100 ? pos.tokens : pos.tokens * (pct / 100);
      if (!(tokens > DUST)) throw new Error('Nothing left to sell');
      const q = this.quoteSell(pos, tokens);
      const fill = { at: this.now(), kind: 'sell', reason, pct, tokens, priceUsd: pos.priceUsd, grossUsd: q.grossUsd,
        feesUsd: q.feesUsd, slippageUsd: q.slippageUsd, netUsd: q.netUsd, mcUsd: pos.mcUsd };
      if (!this.store.addSimFill(this.book, { positionId: pos.id, idemKey: key, ...fill })) {
        return { duplicate: true, position: pos };
      }
      // average cost: the share of the open cost basis that these tokens carry
      const costOpen = pos.costOpenUsd ?? pos.budgetUsd - pos.soldCostUsd;
      const costShare = costOpen * Math.min(1, tokens / pos.tokens);
      pos.costOpenUsd = Math.max(0, costOpen - costShare);
      pos.tokens = Math.max(0, pos.tokens - tokens);
      pos.realizedUsd += q.netUsd;
      pos.soldCostUsd += costShare;
      pos.feesUsd += q.feesUsd;
      pos.slippageUsd += q.slippageUsd;
      pos.fills.push(fill);
      if (pos.tokens <= pos.tokensInit * 1e-6) {
        pos.tokens = 0;
        pos.status = 'closed';
        pos.closedAt = fill.at;
        pos.exitReason = reason;
        this.open.delete(pos.id);
      }
      this.#save(pos);
      this.store.audit(actor, this.book, 'sell', { id: pos.id, mint: pos.mint, pct, reason, netUsd: q.netUsd, priceUsd: pos.priceUsd });
      this.onEvent?.({ type: 'sell', book: this.book, position: pos, fill });
      return { duplicate: false, position: pos, fill };
    } finally { this.busy.delete(pos.id); }
  }

  /** What selling `tokens` now would really bring: price × tokens, minus slippage, fees and network fee. */
  quoteSell(pos, tokens) {
    const grossUsd = tokens * pos.priceUsd;
    const depth = this.depth(pos, grossUsd);
    const slipPct = depth == null ? 0 : cashOut(grossUsd, depth).lossPct;
    const afterSlip = grossUsd * (1 - slipPct / 100);
    const fee = afterSlip * (this.#feePct() / 100);
    const tx = this.#txUsd();
    const netUsd = Math.max(0, afterSlip - fee - tx);
    return { grossUsd, slipPct, slippageUsd: grossUsd - afterSlip, feesUsd: fee + tx, netUsd, depthKnown: depth != null };
  }

  /** New price for a coin: update every open position on it and run its exit rules. */
  updatePrice(mint, { priceUsd, mcUsd, vSol, liqUsd, onCurve, source }) {
    if (!(priceUsd > 0)) return [];
    const done = [];
    for (const pos of [...this.open.values()]) {
      if (pos.mint !== mint) continue;
      const now = this.now();
      Object.assign(pos, { priceUsd, mcUsd: mcUsd ?? pos.mcUsd, lastAt: now, source: source ?? pos.source });
      if (vSol != null) pos.vSol = vSol;
      if (liqUsd != null) pos.liqUsd = liqUsd;
      if (onCurve != null) pos.onCurve = onCurve;
      pos.peakPriceUsd = Math.max(pos.peakPriceUsd, priceUsd);
      pos.lowPriceUsd = Math.min(pos.lowPriceUsd, priceUsd);
      pos.trailHighUsd = Math.max(pos.trailHighUsd ?? priceUsd, priceUsd); // only ever moves up
      const last = pos.history.at(-1);
      if (!last || now - last[0] >= 5_000) { pos.history.push([now, priceUsd]); if (pos.history.length > 720) pos.history.shift(); }
      done.push(...this.#checkTriggers(pos));
      if (pos.status === 'open') this.dirty = true;
    }
    return done;
  }

  /** Run stop-loss, take-profit, trailing stop and max-hold rules. Returns the fills made. */
  #checkTriggers(pos) {
    if (pos.status !== 'open') return [];
    const out = [];
    const L = this.levels(pos);
    const p = pos.priceUsd, r = pos.risk ?? {};
    const sellAll = (reason, key) => { try { const x = this.sell(pos.id, 100, { reason, idemKey: `${pos.id}:${key}`, actor: 'system' }); if (!x.duplicate) out.push(x.fill); } catch (e) { this.log.warn?.(`${this.book} ${reason}: ${e.message}`); } };
    if (L.stop != null && p <= L.stop) sellAll(`Stop-loss hit at ${fmt(p)}`, 'stop');
    else if (L.trail != null && p <= L.trail) sellAll(`Trailing stop hit at ${fmt(p)} (${r.trailPct}% below the high of ${fmt(pos.trailHighUsd)})`, `trail:${pos.trailHighUsd}`);
    else if (L.target != null && p >= L.target) {
      const pct = r.tpSellPct ?? 100;
      try {
        const x = this.sell(pos.id, pct, { reason: `Take-profit hit at ${fmt(p)}${pct < 100 ? ` (sold ${pct}%)` : ''}`, idemKey: `${pos.id}:tp:${L.target}`, actor: 'system' });
        if (!x.duplicate) {
          out.push(x.fill);
          // a partial take-profit is done once: clear the target so it doesn't sell again
          if (pos.status === 'open') { pos.risk = { ...pos.risk, tpPct: null, tpPrice: null }; this.#save(pos); }
        }
      } catch (e) { this.log.warn?.(`${this.book} take-profit: ${e.message}`); }
    } else if (r.maxHoldMin != null && this.now() - pos.openedAt >= r.maxHoldMin * 60_000) sellAll(`Time stop: held ${r.maxHoldMin} min`, 'time');
    return out;
  }

  /** Re-run time-based rules (max hold) even without new prices. */
  tick() {
    for (const pos of [...this.open.values()]) this.#checkTriggers(pos);
    if (this.dirty) { for (const pos of this.open.values()) this.#save(pos); this.dirty = false; }
  }

  /** Value now: market value, what selling all would bring, realized and unrealized P&L. */
  value(pos) {
    const q = pos.tokens > 0 ? this.quoteSell(pos, pos.tokens) : { grossUsd: 0, netUsd: 0, slipPct: 0 };
    const costOpen = pos.costOpenUsd ?? pos.budgetUsd - pos.soldCostUsd;
    const unrealizedUsd = q.netUsd - costOpen;
    const realizedPnlUsd = pos.realizedUsd - pos.soldCostUsd;
    const totalPnlUsd = pos.realizedUsd + q.netUsd - pos.budgetUsd;
    return { marketUsd: q.grossUsd, ifSoldUsd: q.netUsd, exitSlipPct: q.slipPct, costOpenUsd: costOpen,
      unrealizedUsd, unrealizedPct: costOpen > 0 ? (unrealizedUsd / costOpen) * 100 : 0,
      realizedPnlUsd, totalPnlUsd, totalPnlPct: (totalPnlUsd / pos.budgetUsd) * 100 };
  }

  view(pos) {
    const v = this.value(pos);
    const L = this.levels(pos);
    const expected = (price) => (price == null || !(pos.tokens > 0) ? null
      : (() => { const saved = pos.priceUsd; pos.priceUsd = price; const q = this.quoteSell(pos, pos.tokens); pos.priceUsd = saved; return pos.realizedUsd + q.netUsd - pos.budgetUsd; })());
    const now = this.now();
    return {
      id: pos.id, book: pos.book, origin: pos.origin, status: pos.status, mint: pos.mint, symbol: pos.symbol, name: pos.name,
      budgetUsd: pos.budgetUsd, openedAt: pos.openedAt, closedAt: pos.closedAt, holdSec: Math.round(((pos.closedAt ?? now) - pos.openedAt) / 1000),
      entryPriceUsd: pos.refPriceUsd, avgCostUsd: pos.entryPriceUsd, entryMcUsd: pos.entryMcUsd, priceUsd: pos.priceUsd, mcUsd: pos.mcUsd,
      priceChangePct: (pos.priceUsd / pos.refPriceUsd - 1) * 100,
      tokensInit: pos.tokensInit, tokens: pos.tokens, soldPct: (1 - pos.tokens / pos.tokensInit) * 100,
      ...v, pnlUsd: v.totalPnlUsd, pnlPct: v.totalPnlPct, proceedsUsd: pos.realizedUsd,
      feesUsd: pos.feesUsd, slippageUsd: pos.slippageUsd, entrySlipPct: pos.entrySlipPct, depthKnown: pos.depthKnown,
      risk: pos.risk, levels: L, trailHighUsd: pos.trailHighUsd,
      expectedAtStopUsd: expected(L.stop != null && L.trail != null ? Math.max(L.stop, L.trail) : L.stop ?? L.trail),
      expectedAtTargetUsd: expected(L.target),
      onCurve: pos.onCurve, liqUsd: pos.liqUsd, source: pos.source, lastAt: pos.lastAt, staleSec: Math.round((now - pos.lastAt) / 1000),
      exitReason: pos.exitReason, meta: pos.meta, fills: pos.fills,
      history: pos.history.slice(-180).map(([, p]) => p),
    };
  }

  openViews() { return [...this.open.values()].map((p) => this.view(p)).sort((a, b) => b.openedAt - a.openedAt); }
  closedViews(limit = 100) { return this.store.simPositions(this.book, 'closed', limit).map((p) => this.view(p)); }

  /** Totals for open and closed positions, plus win/loss statistics on closed ones. */
  summary(closed = this.closedViews(500), open = this.openViews()) {
    const invested = open.reduce((s, p) => s + p.costOpenUsd, 0);
    const value = open.reduce((s, p) => s + p.ifSoldUsd, 0);
    const unrealized = open.reduce((s, p) => s + p.unrealizedUsd, 0);
    const realizedOpen = open.reduce((s, p) => s + p.realizedPnlUsd, 0);
    return { invested, value, pnlUsd: value - invested, pnlPct: invested ? (value / invested - 1) * 100 : 0,
      unrealizedUsd: unrealized, realizedUsd: closed.reduce((s, c) => s + c.pnlUsd, 0) + realizedOpen,
      closedCount: closed.length, ...tradeStats(closed) };
  }
}

/** Win rate, averages, profit factor, max drawdown and hold time over closed positions. */
export function tradeStats(closed) {
  const done = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const wins = done.filter((t) => t.pnlUsd > 0), losses = done.filter((t) => t.pnlUsd <= 0);
  const won = wins.reduce((s, t) => s + t.pnlUsd, 0), lost = -losses.reduce((s, t) => s + t.pnlUsd, 0);
  let eq = 0, peak = 0, maxDd = 0;
  for (const t of done) { eq += t.pnlUsd; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
  const avg = (a, f) => (a.length ? a.reduce((s, t) => s + f(t), 0) / a.length : null);
  return {
    trades: done.length, wins: wins.length, losses: losses.length,
    winRate: done.length ? Math.round((wins.length / done.length) * 100) : null,
    avgWinUsd: avg(wins, (t) => t.pnlUsd), avgLossUsd: avg(losses, (t) => t.pnlUsd),
    avgWinPct: avg(wins, (t) => t.pnlPct), avgLossPct: avg(losses, (t) => t.pnlPct),
    avgReturnPct: avg(done, (t) => t.pnlPct),
    profitFactor: lost > 0 ? won / lost : null, profitFactorInfinite: lost === 0 && won > 0,
    netUsd: won - lost, maxDrawdownUsd: maxDd, avgHoldSec: avg(done, (t) => t.holdSec),
    feesUsd: done.reduce((s, t) => s + (t.feesUsd ?? 0), 0), slippageUsd: done.reduce((s, t) => s + (t.slippageUsd ?? 0), 0),
  };
}

function fmt(p) {
  if (!(p > 0)) return '$0';
  if (p >= 1) return `$${p.toFixed(4)}`;
  const z = Math.max(0, -Math.floor(Math.log10(p)) - 1);
  return `$${p.toFixed(Math.min(z + 4, 14))}`;
}
