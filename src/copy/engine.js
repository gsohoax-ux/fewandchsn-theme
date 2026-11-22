// Copy trading (System D): mirror everything followed wallets do — buys, adds, partial sells, exits, re-entries —
// with simulated money in its own paper book ("copy"). Separate from the automatic, strategy and manual books.
//
// How trades are found:
//   1. PumpPortal account subscriptions (real time, Pump.fun / PumpSwap trades).
//   2. With a Helius key: every signature of every followed wallet is polled, so trades on any DEX are found,
//      and EVERY trade (from either source) is confirmed with getTransaction before it is copied:
//      failed transactions, transfers, funding and liquidity moves are recognized and skipped.
// Each wallet + signature + token is handled exactly once (database key), however many times it is seen.
//
// How trades are copied:
//   - buys / adds: a fixed $ amount per buy, at the price available when the bot processes it (not the trader's price),
//     with fees, slippage and liquidity limits; rejected with a reason when it can't be simulated safely.
//   - sells: the same % of the copied position as the trader sold of their own balance (from on-chain balances).
//   - optional stop-loss / take-profit / trailing stop / max hold can exit earlier; the reason is recorded.
import { PaperBook, tradeStats, normalizeRisk } from '../paperbook.js';
import { classifyTransaction, fromFeedTrade } from './classify.js';
import { dexSnapshots } from '../dexscreener.js';
import { liquidityRead, priceImpact, curveVSolFromMc } from '../liquidity.js';

export const TRADER_DEFAULTS = {
  buyUsd: 25, maxPositionUsd: 100, maxExposureUsd: 250, copyAdds: true,
  stopPct: null, tpPct: null, tpSellPct: 100, trailPct: null, maxHoldMin: null,
  minLiqUsd: 1000, maxSlippagePct: 10, maxBuyDelaySec: 90, reenterAfterSafetyExit: false,
};
export const PORTFOLIO_DEFAULTS = { maxTotalExposureUsd: 500, requireVerified: true, pollSec: 30 };
const NUM_RANGES = {
  buyUsd: [1, 100_000], maxPositionUsd: [1, 1_000_000], maxExposureUsd: [1, 10_000_000], minLiqUsd: [0, 100_000_000],
  maxSlippagePct: [0.1, 100], maxBuyDelaySec: [5, 3600],
};
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Validate trader settings; unknown keys are refused, numbers checked, risk fields via normalizeRisk. */
export function normalizeTraderSettings(input = {}, base = TRADER_DEFAULTS) {
  const out = { ...TRADER_DEFAULTS, ...base };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in TRADER_DEFAULTS)) throw new Error(`Unknown setting ${k}`);
    if (typeof TRADER_DEFAULTS[k] === 'boolean') { out[k] = Boolean(v); continue; }
    if (NUM_RANGES[k]) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < NUM_RANGES[k][0] || n > NUM_RANGES[k][1]) throw new Error(`${k} must be between ${NUM_RANGES[k][0]} and ${NUM_RANGES[k][1]}`);
      out[k] = n;
    } else out[k] = v === '' || v == null ? null : Number(v);
  }
  const r = normalizeRisk({ stopPct: out.stopPct, tpPct: out.tpPct, tpSellPct: out.tpSellPct ?? 100, trailPct: out.trailPct, maxHoldMin: out.maxHoldMin });
  Object.assign(out, { stopPct: r.stopPct, tpPct: r.tpPct, tpSellPct: r.tpSellPct, trailPct: r.trailPct, maxHoldMin: r.maxHoldMin });
  if (out.buyUsd > out.maxPositionUsd) throw new Error('The copy amount per buy cannot exceed the maximum position size');
  if (out.maxPositionUsd > out.maxExposureUsd) throw new Error('The maximum position size cannot exceed the trader\'s maximum exposure');
  return out;
}

export class CopyEngine {
  constructor({ cfg, store, engine = null, feed = null, chain = null, market = null, fetchFn = fetch, log = console, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, engine, feed, chain, market, fetchFn, log, now });
    this.book = new PaperBook({ store, cfg, book: 'copy', getSolUsd: () => this.solUsd, log, now, onEvent: (e) => this.#onFill(e) });
    this.sync = market ? market.bindBook(this.book, 'copy') : null;
    this.traders = new Map(store.copyTraders().map((t) => [t.wallet, { ...t, settings: { ...TRADER_DEFAULTS, ...t.settings } }]));
    this.settings = { ...PORTFOLIO_DEFAULTS, ...(store.getKv('copySettings') ?? {}) };
    this.pending = new Map(); // `${wallet}:${sig}` -> verification job
    this.queue = Promise.resolve(); // events are acted on one at a time, in arrival order
    for (const t of this.traders.values()) if (this.#monitoring(t)) feed?.watchAccount?.(t.wallet);
    feed?.on?.('trade', (m) => this.onFeedTrade(m));
  }

  get solUsd() { return this.engine?.solUsd ?? 0; }
  /** On-chain verification is available (a real Helius RPC, not the demo). */
  get verifying() { return Boolean(this.chain?.enabled && typeof this.chain.rpc === 'function'); }
  #monitoring(t) { return t.enabled || this.#openFor(t.wallet).length > 0; } // OFF keeps watching until its copies are closed
  #openFor(wallet, mint = null) { return [...this.book.open.values()].filter((p) => p.meta?.trader === wallet && (!mint || p.mint === mint)); }

  // ---------------------------------------------------------------- followed wallets
  addTrader(wallet, { label = '', settings = {} } = {}) {
    wallet = String(wallet ?? '').trim();
    if (!B58.test(wallet)) throw new Error('Not a Solana wallet address');
    if (this.traders.has(wallet)) throw new Error('Already following this wallet');
    if (this.traders.size >= 50) throw new Error('You can follow up to 50 wallets');
    const t = { wallet, label: String(label).slice(0, 40), enabled: true, paused: false, settings: normalizeTraderSettings(settings), addedAt: this.now(), lastSig: null };
    this.traders.set(wallet, t);
    this.store.saveCopyTrader(t);
    this.feed?.watchAccount?.(wallet);
    this.store.audit('user', 'copy', 'follow', { wallet, label: t.label, settings: t.settings });
    if (this.verifying) this.#initCursor(t).catch((e) => this.log.warn(`copy: ${e.message}`));
    return this.traderView(t);
  }

  updateTrader(wallet, { label, enabled, paused, settings } = {}) {
    const t = this.traders.get(wallet);
    if (!t) throw new Error('Not following this wallet');
    if (label != null) t.label = String(label).slice(0, 40);
    if (enabled != null) t.enabled = Boolean(enabled);
    if (paused != null) t.paused = Boolean(paused);
    if (settings) t.settings = normalizeTraderSettings(settings, t.settings);
    this.store.saveCopyTrader(t);
    if (this.#monitoring(t)) this.feed?.watchAccount?.(wallet); else this.feed?.unwatchAccount?.(wallet);
    this.store.audit('user', 'copy', 'trader-update', { wallet, label, enabled, paused, settings });
    return this.traderView(t);
  }

  removeTrader(wallet) {
    const t = this.traders.get(wallet);
    if (!t) throw new Error('Not following this wallet');
    const open = this.#openFor(wallet).length;
    if (open) throw new Error(`This trader still has ${open} open copied position${open === 1 ? '' : 's'}. Close them (or wait for the trader to exit) first.`);
    this.traders.delete(wallet);
    this.store.removeCopyTrader(wallet);
    this.feed?.unwatchAccount?.(wallet);
    this.store.audit('user', 'copy', 'unfollow', { wallet });
  }

  updateSettings(values = {}) {
    const s = { ...this.settings };
    if ('maxTotalExposureUsd' in values) { const n = Number(values.maxTotalExposureUsd); if (!(n >= 1 && n <= 100_000_000)) throw new Error('Total exposure must be at least $1'); s.maxTotalExposureUsd = n; }
    if ('requireVerified' in values) s.requireVerified = Boolean(values.requireVerified);
    if ('pollSec' in values) { const n = Number(values.pollSec); if (!(n >= 10 && n <= 600)) throw new Error('Poll interval must be 10–600 seconds'); s.pollSec = n; }
    this.settings = s;
    this.store.setKv('copySettings', s);
    this.store.audit('user', 'copy', 'settings', values);
    return s;
  }

  /** Start following from now: remember the newest signature so old history is never copied. */
  async #initCursor(t) {
    const sigs = await this.chain.rpc('getSignaturesForAddress', [t.wallet, { limit: 1, commitment: 'confirmed' }]);
    t.lastSig = sigs?.[0]?.signature ?? '';
    this.store.setCopyLastSig(t.wallet, t.lastSig);
  }

  // ---------------------------------------------------------------- detection
  onFeedTrade(msg) {
    // live price for copied positions on the bonding curve
    if (!this.market && msg.marketCapSol != null && this.solUsd > 0 && [...this.book.open.values()].some((p) => p.mint === msg.mint && p.onCurve)) {
      const mcUsd = Number(msg.marketCapSol) * this.solUsd;
      this.book.updatePrice(msg.mint, { priceUsd: mcUsd / 1e9, mcUsd, vSol: msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : null, source: 'live feed' });
    }
    const t = this.traders.get(msg.traderPublicKey);
    if (!t || !this.#monitoring(t) || !msg.signature) return;
    const detectedAt = this.now();
    if (this.verifying) this.#queueVerify(t.wallet, msg.signature, { feedMsg: msg, detectedAt });
    else this.#enqueue(() => this.handle(t, fromFeedTrade(msg), { source: 'PumpPortal feed (not confirmed on-chain: no Helius key)', verified: false, detectedAt }));
  }

  #queueVerify(wallet, sig, extra) {
    const key = `${wallet}:${sig}`;
    const job = this.pending.get(key);
    if (job) { if (extra.feedMsg && !job.feedMsg) job.feedMsg = extra.feedMsg; return; }
    if (this.store.copySignatureSeen(wallet, sig)) return;
    this.pending.set(key, { wallet, sig, attempts: 0, nextAt: this.now(), detectedAt: extra.detectedAt ?? this.now(), feedMsg: extra.feedMsg ?? null, blockTime: extra.blockTime ?? null });
  }

  #enqueue(fn) { this.queue = this.queue.then(fn).catch((e) => this.log.warn(`copy: ${e.message}`)); return this.queue; }

  /** Confirm queued signatures on-chain (retrying ones the node hasn't indexed yet). */
  async verifyTick() {
    if (!this.verifying) return;
    const due = [...this.pending.values()].filter((j) => j.nextAt <= this.now()).sort((a, b) => a.detectedAt - b.detectedAt).slice(0, 8);
    for (const job of due) {
      const key = `${job.wallet}:${job.sig}`;
      let tx = null, err = null;
      try { tx = await this.chain.rpc('getTransaction', [job.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); }
      catch (e) { err = e.message; }
      const t = this.traders.get(job.wallet);
      if (!t) { this.pending.delete(key); continue; }
      if (tx) {
        this.pending.delete(key);
        const cls = classifyTransaction(tx, job.wallet, job.sig);
        if (job.feedMsg && cls.status === 'ok') cls.feed = fromFeedTrade(job.feedMsg).feed;
        await this.#enqueue(() => this.handle(t, cls, { source: `on-chain (confirmed${job.feedMsg ? ', seen first on PumpPortal' : ''})`, verified: true, detectedAt: job.detectedAt }));
        continue;
      }
      job.attempts++;
      if (job.attempts < 8) { job.nextAt = this.now() + Math.min(2000 * 2 ** job.attempts, 30_000); continue; }
      this.pending.delete(key);
      if (job.feedMsg && !this.settings.requireVerified) {
        await this.#enqueue(() => this.handle(t, fromFeedTrade(job.feedMsg), { source: 'PumpPortal feed (on-chain confirmation timed out)', verified: false, detectedAt: job.detectedAt }));
      } else {
        const id = `${job.wallet}:${job.sig}:${job.feedMsg?.mint ?? '-'}`;
        this.#record({ id, wallet: job.wallet, signature: job.sig, mint: job.feedMsg?.mint ?? null, kind: 'unconfirmed', action: 'rejected', at: this.now(),
          reason: `Could not confirm this transaction on-chain after ${job.attempts} tries${err ? ` (${err})` : ''}; nothing copied`, detectedAt: job.detectedAt });
      }
    }
  }

  /** Find every new transaction of every followed wallet (any DEX), oldest first. */
  async pollTick() {
    if (!this.verifying) return;
    for (const t of this.traders.values()) {
      if (!this.#monitoring(t)) continue;
      if (t.lastSig == null) { await this.#initCursor(t); continue; }
      const opts = { limit: 100, commitment: 'confirmed', ...(t.lastSig ? { until: t.lastSig } : {}) };
      const sigs = await this.chain.rpc('getSignaturesForAddress', [t.wallet, opts]);
      if (!sigs?.length) continue;
      for (const s of [...sigs].reverse()) {
        if (s.err) {
          this.#record({ id: `${t.wallet}:${s.signature}:-`, wallet: t.wallet, signature: s.signature, mint: null, kind: 'failed', action: 'ignored', at: this.now(),
            blockTime: s.blockTime ?? null, reason: 'Transaction failed on-chain: nothing to copy' });
        } else this.#queueVerify(t.wallet, s.signature, { detectedAt: this.now(), blockTime: s.blockTime ?? null });
      }
      t.lastSig = sigs[0].signature;
      this.store.setCopyLastSig(t.wallet, t.lastSig);
    }
  }

  // ---------------------------------------------------------------- acting
  /** Act on one classified transaction of a followed wallet. */
  async handle(t, cls, meta) {
    if (cls.status === 'pending') return;
    const blockTime = cls.blockTime ?? null;
    const base = { wallet: t.wallet, label: t.label, signature: cls.signature, venue: cls.venue, source: meta.source, verified: meta.verified,
      detectedAt: meta.detectedAt, blockTime, at: this.now() };
    if (cls.status === 'failed') { this.#record({ ...base, id: `${t.wallet}:${cls.signature}:-`, mint: null, kind: 'failed', action: 'ignored', reason: cls.ignored[0]?.reason }); return; }
    for (const ig of cls.ignored) {
      this.#record({ ...base, id: `${t.wallet}:${cls.signature}:${ig.mint ?? ig.kind}`, mint: ig.mint ?? null, kind: ig.kind, action: 'ignored', reason: ig.reason,
        trader: ig.mint ? { pre: ig.pre, post: ig.post, delta: ig.delta } : null });
    }
    for (const ev of cls.events) await this.#act(t, ev, cls, base);
  }

  #record(row) {
    if (!this.store.claimCopyEvent(row)) return false;
    return true;
  }

  async #act(t, ev, cls, base) {
    const solUsd = this.solUsd;
    const traderPriceUsd = ev.priceStable ?? (ev.priceSol != null && solUsd > 0 ? ev.priceSol * solUsd : null);
    const traderUsd = ev.quote ? Math.abs(ev.quote.stable || 0) + Math.abs(ev.quote.sol || 0) * solUsd : null;
    const row = { ...base, id: `${t.wallet}:${cls.signature}:${ev.mint}`, mint: ev.mint, symbol: this.engine?.coins.get(ev.mint)?.symbol ?? '', kind: ev.kind, action: 'processing', reason: '',
      trader: { pre: ev.pre, post: ev.post, delta: ev.delta, soldPct: ev.soldPct, priceUsd: traderPriceUsd, usd: traderUsd }, copy: null };
    row.delaySec = Math.max(0, Math.round((this.now() - (base.blockTime ? base.blockTime * 1000 : base.detectedAt)) / 1000));
    if (!this.store.claimCopyEvent(row)) return; // already handled (seen via feed and via polling)
    try {
      if (ev.kind === 'buy' || ev.kind === 'add') await this.#copyBuy(t, ev, cls, row);
      else await this.#mirrorSell(t, ev, cls, row);
    } catch (e) { row.action = 'rejected'; row.reason = e.message; }
    this.store.updateCopyEvent(row);
    const name = row.symbol ? `$${row.symbol}` : ev.mint.slice(0, 6);
    this.engine?.logEvent?.('COPY', { symbol: row.symbol, mint: ev.mint }, `${t.label || t.wallet.slice(0, 4)} ${ev.kind}${ev.soldPct && ev.kind === 'sell' ? ` ${ev.soldPct.toFixed(0)}%` : ''} ${name} → ${row.action}${row.reason ? `: ${row.reason}` : ''}`,
      row.action === 'copied' || row.action === 'mirrored' ? 'good' : row.action === 'rejected' ? 'bad' : 'muted');
  }

  /** The price the copy can actually get now (never the trader's fill). */
  async #priceNow(mint, cls) {
    const solUsd = this.solUsd;
    const c = this.engine?.coins.get(mint);
    if (this.market) {
      this.market.track(mint, 'copy');
      const r = await this.market.quote(mint, { maxAgeMs: 10_000, needLiquidity: true });
      if (r.ok) {
        const q = r.quote;
        return { mint, symbol: q.symbol || c?.symbol || '', name: c?.name ?? '', priceUsd: q.priceUsd, mcUsd: q.mcUsd, supply: 1e9, onCurve: q.onCurve,
          vSol: q.vSol ?? (q.onCurve && solUsd > 0 ? curveVSolFromMc(q.mcUsd / solUsd) : null), liqUsd: q.liqUsd, source: `${q.source}, ${(q.ageMs / 1000).toFixed(1)}s old` };
      }
    }
    if (c && !c.migrated && solUsd > 0 && c.mcSol > 0 && c.trades.length && this.now() - c.trades.at(-1).ts < 120_000) {
      return { mint, symbol: c.symbol, name: c.name, priceUsd: (c.mcSol * solUsd) / 1e9, mcUsd: c.mcSol * solUsd, supply: 1e9, onCurve: true, vSol: c.vSol, liqUsd: null,
        source: 'live bonding-curve price (bot feed)' };
    }
    const f = cls.feed;
    if (f?.marketCapSol > 0 && solUsd > 0 && (!f.pool || f.pool === 'pump')) {
      return { mint, symbol: c?.symbol ?? '', name: c?.name ?? '', priceUsd: (f.marketCapSol * solUsd) / 1e9, mcUsd: f.marketCapSol * solUsd, supply: 1e9, onCurve: true,
        vSol: f.vSol ?? curveVSolFromMc(f.marketCapSol), liqUsd: null, source: 'bonding curve right after the trader\'s trade' };
    }
    const s = (await dexSnapshots([mint], { fetchFn: this.fetchFn }).catch(() => new Map())).get(mint);
    if (s) return { ...s, vSol: s.onCurve && solUsd > 0 && s.mcUsd ? curveVSolFromMc(s.mcUsd / solUsd) : null, source: 'DexScreener (current)' };
    return null;
  }

  async #copyBuy(t, ev, cls, row) {
    const S = t.settings;
    const open = this.#openFor(t.wallet, ev.mint)[0] ?? null;
    if (!t.enabled) { row.action = 'skipped'; row.reason = 'Copy is OFF for this trader (exits of open copies are still mirrored)'; return; }
    if (t.paused) { row.action = 'skipped'; row.reason = 'Copying is paused (sells are still mirrored)'; return; }
    if (row.delaySec > S.maxBuyDelaySec) { row.action = 'rejected'; row.reason = `Detected ${row.delaySec}s after the trade (your limit ${S.maxBuyDelaySec}s): the price has likely moved, so the buy was not copied`; return; }
    if (open && !S.copyAdds) { row.action = 'skipped'; row.reason = 'Trader added to the position; copying adds is off'; return; }
    const lastClosed = !open ? this.#lastClosed(t.wallet, ev.mint) : null;
    if (!open && lastClosed && !String(lastClosed.exitReason ?? '').startsWith('Mirrored') && ev.kind === 'add' && !S.reenterAfterSafetyExit) {
      row.action = 'skipped'; row.reason = `Your copy was closed by your own rule (${lastClosed.exitReason}); re-entering on the trader's add is off`; return;
    }
    // limits: per position, per trader, whole portfolio
    const posCost = open ? (open.costOpenUsd ?? open.budgetUsd) : 0;
    const traderExposure = this.#openFor(t.wallet).reduce((s, p) => s + (p.costOpenUsd ?? p.budgetUsd), 0);
    const totalExposure = [...this.book.open.values()].reduce((s, p) => s + (p.costOpenUsd ?? p.budgetUsd), 0);
    const rooms = [['maximum position size', S.maxPositionUsd - posCost], ['trader exposure limit', S.maxExposureUsd - traderExposure],
      ['portfolio exposure limit', this.settings.maxTotalExposureUsd - totalExposure]];
    const tight = rooms.reduce((a, b) => (b[1] < a[1] ? b : a));
    const amount = Math.min(S.buyUsd, tight[1]);
    if (amount < 1) { row.action = 'rejected'; row.reason = `Your ${tight[0]} is reached (${tight[0] === 'maximum position size' ? `$${S.maxPositionUsd}` : tight[0] === 'trader exposure limit' ? `$${S.maxExposureUsd}` : `$${this.settings.maxTotalExposureUsd}`})`; return; }
    const snap = await this.#priceNow(ev.mint, cls);
    if (!snap) { row.action = 'rejected'; row.reason = 'No live price available for this token, so the buy cannot be simulated safely'; return; }
    row.symbol = snap.symbol ?? '';
    const L = liquidityRead({ onCurve: snap.onCurve, vSol: snap.vSol, liqUsd: snap.liqUsd ?? 0, mcUsd: snap.mcUsd, solUsd: this.solUsd, orderUsd: amount });
    if (!L) { row.action = 'rejected'; row.reason = 'Liquidity could not be measured, so slippage cannot be simulated safely'; return; }
    if (L.depthUsd <= 0) { row.action = 'rejected'; row.reason = 'No liquidity pool: a buy (or later sell) would not fill'; return; }
    if (L.realLiqUsd < S.minLiqUsd) { row.action = 'rejected'; row.reason = `Liquidity $${Math.round(L.realLiqUsd).toLocaleString()} is below your minimum $${S.minLiqUsd.toLocaleString()}`; return; }
    const slip = priceImpact(amount, L.depthUsd).avgPct + (this.cfg.paperMevPct ?? 2);
    if (slip > S.maxSlippagePct) { row.action = 'rejected'; row.reason = `Estimated slippage ${slip.toFixed(1)}% is above your limit ${S.maxSlippagePct}%`; return; }
    if (snap.onCurve && this.feed && !this.feed.watched?.has(ev.mint)) this.feed.watch?.(ev.mint);
    const sigShort = `${cls.signature.slice(0, 8)}…`;
    const limited = amount < S.buyUsd ? ` (reduced from $${S.buyUsd} by your ${tight[0]})` : '';
    let pos;
    if (open) {
      const r = this.book.addToPosition(open.id, { snap, budgetUsd: amount, reason: `Mirrored add: trader added to their position (tx ${sigShort})${limited}`, idemKey: `copy:${cls.signature}:${ev.mint}` });
      pos = r.position; row.action = 'copied'; row.copyKind = 'add';
    } else {
      const reentry = Boolean(lastClosed);
      pos = this.book.openPosition({ snap, budgetUsd: amount, origin: 'copy', idemKey: `copy:${cls.signature}:${ev.mint}`,
        risk: { stopPct: S.stopPct, tpPct: S.tpPct, tpSellPct: S.tpSellPct, trailPct: S.trailPct, maxHoldMin: S.maxHoldMin },
        meta: { trader: t.wallet, label: t.label, signature: cls.signature, buyReason: `Mirrored ${reentry ? 're-entry' : ev.kind === 'add' ? 'buy (trader added to a bag held before you followed)' : 'buy'} (tx ${sigShort})${limited}` } });
      row.action = 'copied'; row.copyKind = reentry ? 'reentry' : 'open';
    }
    row.copy = { usd: amount, priceUsd: snap.priceUsd, priceSource: snap.source, slipPct: slip, positionId: pos.id,
      vsTraderPct: row.trader.priceUsd ? (snap.priceUsd / row.trader.priceUsd - 1) * 100 : null };
    row.reason = `${row.copyKind === 'add' ? 'Added' : 'Bought'} $${amount.toFixed(2)} at ${snap.source}${limited}`;
  }

  async #mirrorSell(t, ev, cls, row) {
    const pos = this.#openFor(t.wallet, ev.mint)[0] ?? null;
    if (!pos) {
      const last = this.#lastClosed(t.wallet, ev.mint);
      row.action = 'ignored';
      row.symbol = last?.symbol || row.symbol;
      row.reason = last ? `Your copy was already closed (${last.exitReason})` : 'No copied position in this token (the trader bought it before you followed, or that buy was not copied)';
      return;
    }
    row.symbol = pos.symbol;
    const snap = await this.#priceNow(ev.mint, cls);
    if (snap) this.book.updatePrice(ev.mint, snap);
    const live = this.book.open.get(pos.id);
    if (!live) { row.action = 'ignored'; row.reason = `Your copy closed on the price update itself (${this.#lastClosed(t.wallet, ev.mint)?.exitReason ?? 'own rule'})`; return; }
    if (!snap && this.now() - live.lastAt > 10 * 60_000) {
      row.action = 'rejected'; row.reason = 'No price for this token in the last 10 minutes, so the sell cannot be simulated safely. Sell it manually from Copy positions.'; return;
    }
    const pct = ev.kind === 'exit' || ev.soldPct >= 99.5 ? 100 : Math.max(0.01, Math.min(100, ev.soldPct));
    const r = this.book.sell(live.id, pct, { actor: 'system', idemKey: `copy:${cls.signature}:${ev.mint}`,
      reason: pct >= 100 ? `Mirrored full exit: trader sold all their tokens (tx ${cls.signature.slice(0, 8)}…)` : `Mirrored partial sell: trader sold ${pct.toFixed(1)}% of their tokens (tx ${cls.signature.slice(0, 8)}…)` });
    row.action = r.duplicate ? 'ignored' : 'mirrored';
    row.copy = { soldPct: pct, netUsd: r.fill?.netUsd ?? null, priceUsd: live.priceUsd, priceSource: snap?.source ?? `last known price (${Math.round((this.now() - live.lastAt) / 1000)}s old)`,
      positionId: live.id, closed: r.position.status === 'closed', vsTraderPct: row.trader.priceUsd ? (live.priceUsd / row.trader.priceUsd - 1) * 100 : null };
    row.reason = r.duplicate ? 'Already mirrored' : `Sold ${pct.toFixed(1)}% of the copy for $${(r.fill?.netUsd ?? 0).toFixed(2)} after fees${r.position.status === 'closed' ? ' · copy closed' : ''}`;
  }

  #lastClosed(wallet, mint) {
    return this.store.simPositions('copy', 'closed', 300).find((p) => p.meta?.trader === wallet && p.mint === mint) ?? null;
  }

  /** Own-rule exits (stop-loss, take-profit, trailing, time) go into the activity log with their reason. */
  #onFill({ type, position, fill }) {
    if (type !== 'sell' || String(fill.reason).startsWith('Mirrored')) return;
    const trader = position.meta?.trader;
    this.store.claimCopyEvent({ id: `${trader}:rule:${position.id}:${fill.at}`, wallet: trader, label: position.meta?.label ?? '', signature: null, mint: position.mint,
      symbol: position.symbol, kind: fill.reason.startsWith('Manual') ? 'manual' : 'own-rule', action: 'exited', at: fill.at,
      reason: `${fill.reason} — before the trader${position.status === 'closed' ? '; position closed' : ''}`, copy: { soldPct: fill.pct, netUsd: fill.netUsd, priceUsd: fill.priceUsd, positionId: position.id } });
  }

  /** Prices for copied positions the live feed doesn't cover, then time-based rules. */
  async pollPrices() {
    if (this.sync) return this.sync();
    const mints = [...this.book.open.values()].filter((p) => !(p.source === 'live feed' && this.now() - p.lastAt < 30_000)).map((p) => p.mint);
    if (mints.length) {
      const snaps = await dexSnapshots(mints, { fetchFn: this.fetchFn });
      for (const [mint, s] of snaps) this.book.updatePrice(mint, { priceUsd: s.priceUsd, mcUsd: s.mcUsd, liqUsd: s.liqUsd, onCurve: s.onCurve, source: 'DexScreener' });
    }
    this.book.tick();
  }

  sellManually(id, pct, requestId) {
    const pos = this.book.open.get(String(id));
    if (!pos) throw new Error('Position not found (it may already be closed)');
    return this.book.view(this.book.sell(id, pct, { reason: `Manual sell ${pct}% (your override)`, idemKey: requestId ? `copy:manual:${id}:${requestId}` : null }).position);
  }

  start(health) {
    health.job('Copy trading: confirm transactions', () => this.verifyTick(), 1500);
    let last = 0;
    health.job('Copy trading: scan followed wallets', async () => { if (this.now() - last >= this.settings.pollSec * 1000) { last = this.now(); await this.pollTick(); } }, 5000);
    health.job('Copy positions: prices + exits', () => this.pollPrices(), 10_000);
  }

  // ---------------------------------------------------------------- views
  traderView(t, closedAll = null, events = null) {
    const open = this.#openFor(t.wallet).map((p) => this.book.view(p));
    const closed = (closedAll ?? this.book.closedViews(1000)).filter((p) => p.meta?.trader === t.wallet);
    const evs = events ?? this.store.copyEvents(400, t.wallet);
    const counts = {};
    for (const r of this.store.copyEventCounts()) if (r.wallet === t.wallet) counts[r.action] = r.n;
    const delays = evs.filter((e) => e.action === 'copied' && e.delaySec != null).map((e) => e.delaySec);
    const diffs = evs.filter((e) => e.action === 'copied' && e.copy?.vsTraderPct != null).map((e) => e.copy.vsTraderPct);
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const exposure = open.reduce((s, p) => s + p.costOpenUsd, 0);
    return {
      wallet: t.wallet, label: t.label, enabled: t.enabled, paused: t.paused, settings: t.settings, addedAt: t.addedAt,
      status: {
        monitoring: this.#monitoring(t),
        state: !t.enabled ? (open.length ? 'OFF · mirroring exits of open copies' : 'OFF') : t.paused ? 'PAUSED · buys not copied, sells mirrored' : 'ACTIVE',
        mirroring: 'Full: buys, adds, partial sells, exits, re-entries',
        verification: this.verifying ? 'Every trade confirmed on-chain (Helius), all DEXes' : 'PumpPortal feed only (Pump.fun / PumpSwap); add HELIUS_API_KEY for on-chain confirmation and other DEXes',
      },
      stats: { open: open.length, exposureUsd: exposure, valueUsd: open.reduce((s, p) => s + p.ifSoldUsd, 0), unrealizedUsd: open.reduce((s, p) => s + p.unrealizedUsd, 0),
        realizedOpenUsd: open.reduce((s, p) => s + p.realizedPnlUsd, 0), ...tradeStats(closed), counts, avgDelaySec: avg(delays), avgVsTraderPct: avg(diffs) },
    };
  }

  view() {
    const open = this.book.openViews();
    const closed = this.book.closedViews(500);
    const traders = [...this.traders.values()].map((t) => this.traderView(t, closed));
    const sum = this.book.summary(closed, open);
    return {
      settings: this.settings, verifying: this.verifying, pendingConfirmations: this.pending.size,
      demoWallets: this.feed?.demoTraders ?? null,
      traders, open, closed: closed.slice(0, 100), events: this.store.copyEvents(200),
      portfolio: { ...sum, exposureUsd: open.reduce((s, p) => s + p.costOpenUsd, 0), maxTotalExposureUsd: this.settings.maxTotalExposureUsd },
    };
  }
}
