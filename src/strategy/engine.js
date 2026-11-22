// Autonomous Setuh Scalping Paper Trader (System B).
//
// Finds candidates on its own, checks them, recognizes the Setuh setup, scores confidence, waits for the entry
// confirmation, re-checks the newest price, and simulates the entry — or rejects / skips it and says why.
// It has its own simulated balance, positions (one per entry, so Entry 1 / 2 / 3 on a coin are separate),
// trade journal, analytics and activity feed. It never touches the automatic, manual or copy paper books,
// and it never sends a real transaction.
//
// Decision stages: waiting_setup → waiting_confirmation → (gates + confidence) → entered | pending_approval |
// rejected | missed | insufficient_data | invalidated | skipped | cancelled.
import { PaperBook, tradeStats } from '../paperbook.js';
import { SETUPS, EVALUATORS, mergeConfig, flowOf, decisionStage } from './setups.js';
import { safetyGates, setupConfidence, confidenceBand } from './gates.js';
import { candlesFromTrades } from '../candles.js';
import { dayKey } from '../paper.js';
import { dexSnapshots } from '../dexscreener.js';
import { liquidityRead, priceImpact, curveVSolFromMc } from '../liquidity.js';
import { reasonKey } from '../funnel.js';

const CURVE_SETUPS = ['newPairs', 'finalA', 'finalB', 'finalC'];
const RETRY_MS = 2 * 60_000;      // a rejected / invalidated coin+setup is not re-reported for 2 minutes
const DEEP_TTL_MS = 5 * 60_000;   // full Coin Check results are reused for 5 minutes

export const SETUH_DEFAULTS = {
  mode: 'autonomous',          // 'autonomous' | 'approval'
  discoveryPaused: false,      // stop finding new candidates (your submitted coins are still checked)
  entriesPaused: false,        // keep scanning and managing open positions, but take no new entries
  startingBalanceUsd: 1000, positionUsd: 25, maxOpenPositions: 6, maxOpenPerSetup: 3, maxDailyLossUsd: 100,
  maxExposurePerCoinUsd: 75, maxEntriesPerCoin: 3, minEntryGapSec: 60, minConfidence: 60, maxSlippagePct: 8,
  maxDataAgeSec: 10, maxHoldMin: 120, maxEntryDriftPct: 6, minRewardRisk: 1.2, partialTakePct: 50, trailAfterTpPct: 15,
  approvalTtlSec: 180, requireVerifiedSafety: true, requireDeepCheck: true,
};
const RANGES = {
  startingBalanceUsd: [10, 10_000_000], positionUsd: [1, 1_000_000], maxOpenPositions: [0, 500], maxOpenPerSetup: [0, 500],
  maxDailyLossUsd: [1, 10_000_000], maxExposurePerCoinUsd: [1, 10_000_000], maxEntriesPerCoin: [1, 50], minEntryGapSec: [0, 86_400],
  minConfidence: [0, 100], maxSlippagePct: [0.1, 100], maxDataAgeSec: [1, 600], maxHoldMin: [1, 10_080], maxEntryDriftPct: [0.1, 100],
  minRewardRisk: [0, 20], partialTakePct: [1, 100], trailAfterTpPct: [0, 99], approvalTtlSec: [10, 86_400],
};
export const STRATEGY_DEFAULTS = SETUH_DEFAULTS; // older name

export class StrategyEngine {
  constructor({ cfg, engine, store, feed = null, candles = null, market = null, deepcheck = null, metrics = null, funnel = null, fetchFn = fetch, log = console, now = () => Date.now() }) {
    Object.assign(this, { cfg, engine, store, feed, candles, market, deepcheck, metrics, funnel, fetchFn, log, now });
    this.book = new PaperBook({ store, cfg, book: 'strategy', getSolUsd: () => engine?.solUsd ?? 0, log, now, onEvent: (e) => this.#onFill(e) });
    this.sync = market ? market.bindBook(this.book, 'setuh') : null;
    this.active = new Map();     // `${setup}:${mint}` -> current signal episode
    this.armed = new Map();      // `${setup}:${mint}` -> false right after an entry, until the setup resets
    this.retryAt = new Map();    // `${setup}:${mint}` -> don't report again before
    this.pending = new Map();    // signal id -> { sig, ctx, ev, market, expiresAt } (approval mode)
    this.deep = new Map();       // mint -> { at, running, report, error }
    this.deepQueue = [];
    this.deepRunning = 0;
    this.migratedWatch = new Map();
    this.focus = new Map(Object.entries(store.getKv('setuhFocus') ?? {})); // mint -> { at } coins you sent in
    this.loadConfig();
    for (const m of this.focus.keys()) market?.track(m, 'setuh-focus');
    if (!market) feed?.on?.('trade', (m) => this.onTrade(m));
    feed?.on?.('migrate', (m) => this.onMigrate(m));
  }

  // ---------------------------------------------------------------- settings
  loadConfig() {
    const saved = this.store.getKv('strategyConfig') ?? {};
    this.setups = mergeConfig(saved.setups);
    const s = saved.settings ?? {};
    const legacy = {};
    if (s.perTradeUsd != null && s.positionUsd == null) legacy.positionUsd = s.perTradeUsd;
    if (s.maxOpen != null && s.maxOpenPositions == null) legacy.maxOpenPositions = s.maxOpen;
    if (s.enabled === false && s.entriesPaused == null) legacy.entriesPaused = true;
    this.settings = { ...SETUH_DEFAULTS, requireVerifiedSafety: !this.cfg.demo, ...legacy, ...pick(s, Object.keys(SETUH_DEFAULTS)) };
    this.trackedDevs = this.store.getKv('trackedDevs') ?? {};
  }

  updateConfig({ setup = null, values = {} }) {
    const saved = this.store.getKv('strategyConfig') ?? {};
    if (setup) {
      if (!SETUPS[setup]) throw new Error('Unknown setup');
      const d = SETUPS[setup].defaults;
      const clean = {};
      for (const [k, v] of Object.entries(values)) {
        if (!(k in d)) throw new Error(`Unknown setting ${k}`);
        if (typeof d[k] === 'boolean') clean[k] = Boolean(v);
        else { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new Error(`${k} must be a positive number`); clean[k] = n; }
      }
      saved.setups = { ...(saved.setups ?? {}), [setup]: { ...(saved.setups?.[setup] ?? {}), ...clean } };
    } else {
      const s = { ...(saved.settings ?? {}) };
      for (const [k, v] of Object.entries(values)) {
        if (k === 'enabled') { s.entriesPaused = !v; continue; }               // older switch
        if (k === 'perTradeUsd') { s.positionUsd = Number(v); continue; }
        if (k === 'maxOpen') { s.maxOpenPositions = Number(v); continue; }
        if (k === 'dailyUsd') continue;                                         // replaced by the simulated balance
        if (!(k in SETUH_DEFAULTS)) throw new Error(`Unknown setting ${k}`);
        if (k === 'mode') { if (!['autonomous', 'approval'].includes(v)) throw new Error('mode must be autonomous or approval'); s.mode = v; continue; }
        if (typeof SETUH_DEFAULTS[k] === 'boolean') { s[k] = Boolean(v); continue; }
        const n = Number(v), [lo, hi] = RANGES[k];
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
        s[k] = n;
      }
      const merged = { ...this.settings, ...s };
      if (merged.positionUsd > merged.maxExposurePerCoinUsd) throw new Error('Position size cannot exceed the maximum exposure per coin');
      saved.settings = s;
    }
    this.store.setKv('strategyConfig', saved);
    this.store.audit('user', 'strategy', 'config', { setup, values });
    this.loadConfig();
    if (!setup) this.#activity('settings', null, `Settings changed: ${Object.keys(values).join(', ')}`);
    return this.configView();
  }

  resetSetup(setup) {
    if (!SETUPS[setup]) throw new Error('Unknown setup');
    const saved = this.store.getKv('strategyConfig') ?? {};
    if (saved.setups) delete saved.setups[setup];
    this.store.setKv('strategyConfig', saved);
    this.store.audit('user', 'strategy', 'config-reset', { setup });
    this.loadConfig();
    return this.configView();
  }

  setTrackedDev(wallet, { mode = 'follow', label = '' } = {}) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(wallet))) throw new Error('Not a Solana wallet address');
    if (!['follow', 'block', 'remove'].includes(mode)) throw new Error('mode must be follow, block or remove');
    const all = { ...(this.store.getKv('trackedDevs') ?? {}) };
    if (mode === 'remove') delete all[wallet];
    else all[wallet] = { mode, label: String(label).slice(0, 40), addedAt: this.now() };
    this.store.setKv('trackedDevs', all);
    this.store.audit('user', 'strategy', 'tracked-dev', { wallet, mode, label });
    this.trackedDevs = all;
    return all;
  }

  devReputation(creator) {
    if (!creator) return null;
    const h = this.store.devHistory(creator, '');
    const t = this.trackedDevs[creator];
    return { wallet: creator, finished: h.finished, graduated: h.migrated, rugged: h.rugged, tracked: t?.mode === 'follow', blocked: t?.mode === 'block', label: t?.label ?? '' };
  }

  configView() {
    return { settings: this.settings, setups: Object.fromEntries(Object.entries(SETUPS).map(([id, s]) =>
      [id, { family: s.family, name: s.name, summary: s.summary, values: this.setups[id], defaults: s.defaults }])), trackedDevs: this.trackedDevs };
  }

  // ---------------------------------------------------------------- balance & limits
  #today() { return dayKey(this.now(), this.cfg.paperTz ?? 'UTC'); }

  /** Simulated balance: starting cash + realized results − money in open positions. */
  balance() {
    const open = this.book.openViews(), closed = this.book.closedViews(5000);
    const realized = closed.reduce((s, p) => s + p.pnlUsd, 0) + open.reduce((s, p) => s + p.realizedPnlUsd, 0);
    const invested = open.reduce((s, p) => s + p.costOpenUsd, 0);
    const openValue = open.reduce((s, p) => s + p.ifSoldUsd, 0);
    const cash = this.settings.startingBalanceUsd + realized - invested;
    const today = this.#today(), tz = this.cfg.paperTz ?? 'UTC';
    const todayPnl = closed.filter((p) => dayKey(p.closedAt, tz) === today).reduce((s, p) => s + p.pnlUsd, 0) + open.reduce((s, p) => s + p.unrealizedUsd + p.realizedPnlUsd, 0);
    return { startingUsd: this.settings.startingBalanceUsd, cashUsd: cash, investedUsd: invested, openValueUsd: openValue, equityUsd: cash + openValue,
      realizedUsd: realized, returnPct: ((cash + openValue) / this.settings.startingBalanceUsd - 1) * 100, todayPnlUsd: todayPnl, day: today,
      dailyLossHit: todayPnl <= -this.settings.maxDailyLossUsd };
  }
  /** Older callers. */
  budget() { const b = this.balance(); return { day: b.day, dailyUsd: b.startingUsd, spentUsd: b.investedUsd, leftUsd: b.cashUsd, perTradeUsd: this.settings.positionUsd }; }

  /** Why a new entry can't be taken right now, or null. */
  #entryBlock(setup, mint, sizeUsd) {
    const S = this.settings;
    if (S.entriesPaused) return 'New entries are paused';
    if (this.engine && !this.feedOk()) return 'Live market feed is disconnected or stale: new entries blocked until reliable data returns';
    const open = [...this.book.open.values()];
    if (open.length >= S.maxOpenPositions) return `Max ${S.maxOpenPositions} open positions`;
    if (open.filter((p) => p.origin === setup).length >= S.maxOpenPerSetup) return `Max ${S.maxOpenPerSetup} open positions for this setup`;
    const onCoin = open.filter((p) => p.mint === mint);
    if (onCoin.length >= S.maxEntriesPerCoin) return `Max ${S.maxEntriesPerCoin} entries per coin reached`;
    const coinExposure = onCoin.reduce((s, p) => s + (p.costOpenUsd ?? p.budgetUsd), 0);
    if (coinExposure + sizeUsd > S.maxExposurePerCoinUsd + 1e-9) return `Exposure on this coin would exceed $${S.maxExposurePerCoinUsd}`;
    const last = onCoin.reduce((m, p) => Math.max(m, p.openedAt), 0);
    if (last && this.now() - last < S.minEntryGapSec * 1000) return `Last entry on this coin was ${Math.round((this.now() - last) / 1000)}s ago (minimum gap ${S.minEntryGapSec}s)`;
    const b = this.balance();
    if (b.dailyLossHit) return `Daily loss limit reached (${b.todayPnlUsd.toFixed(2)} today, limit −$${S.maxDailyLossUsd})`;
    if (b.cashUsd < sizeUsd) return `Not enough simulated cash ($${b.cashUsd.toFixed(2)} left)`;
    return null;
  }

  /** New entries need TRADES flowing (new-coin messages alone don't count). Older market hubs: message health. */
  feedOk() {
    if (!this.market) return Boolean(this.engine?.feedConnected ?? true);
    return typeof this.market.tradeFeedOk === 'function' ? this.market.tradeFeedOk() : this.market.feedHealthy(15_000);
  }

  // ---------------------------------------------------------------- market events
  onTrade(msg) { // only without the market hub
    const solUsd = this.engine?.solUsd ?? 0;
    if (!(solUsd > 0) || msg.marketCapSol == null || ![...this.book.open.values()].some((p) => p.mint === msg.mint)) return;
    const mcUsd = Number(msg.marketCapSol) * solUsd;
    this.book.updatePrice(msg.mint, { priceUsd: mcUsd / 1e9, mcUsd, vSol: msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : null, source: 'live feed' });
  }

  onMigrate(msg) {
    if (!msg?.mint) return;
    const c = this.engine?.coins.get(msg.mint);
    if (this.migratedWatch.size > 400) {
      const oldest = [...this.migratedWatch.values()].sort((a, b) => a.migratedAt - b.migratedAt)[0];
      this.migratedWatch.delete(oldest.mint);
    }
    this.migratedWatch.set(msg.mint, { mint: msg.mint, symbol: c?.symbol ?? '', name: c?.name ?? '', migratedAt: this.now(), createdAt: c?.createdAt ?? null, lastScanAt: 0, snap: null });
    for (const p of this.book.open.values()) if (p.mint === msg.mint) p.onCurve = false;
  }

  #onFill({ type, position, fill }) {
    if (type !== 'sell') return;
    const m = position.meta ?? {};
    const kind = /Stop-loss/.test(fill.reason) ? 'stop' : /Take-profit/.test(fill.reason) ? 'take_profit' : /Trailing/.test(fill.reason) ? 'trailing' : /Time stop/.test(fill.reason) ? 'time' : /Emergency/.test(fill.reason) ? 'emergency' : 'sell';
    this.#activity(position.status === 'closed' ? 'closed' : 'partial_sell', position,
      `Entry ${m.entryNo ?? '?'} · ${fill.reason} · ${fill.pct >= 100 ? 'sold all' : `sold ${fill.pct?.toFixed(0)}%`} for $${fill.netUsd.toFixed(2)}${position.status === 'closed' ? ` · closed ${position.realizedUsd - position.budgetUsd >= 0 ? '+' : '−'}$${Math.abs(position.realizedUsd - position.budgetUsd).toFixed(2)}` : ''}`, { kind, fillPriceUsd: fill.priceUsd });
    this.engine?.logEvent?.('EXECUTOR', { symbol: position.symbol, mint: position.mint }, `Setuh ${SETUPS[position.origin]?.name ?? position.origin} entry ${m.entryNo ?? ''}: ${fill.reason}`, kind === 'take_profit' ? 'good' : '');
    // after a partial take-profit, protect the rest with a trailing stop
    if (kind === 'take_profit' && position.status === 'open' && this.settings.trailAfterTpPct > 0 && position.risk?.trailPct == null) {
      try { this.book.setRisk(position.id, { ...position.risk, tpPct: null, tpPrice: null, trailPct: this.settings.trailAfterTpPct }); } catch { /* closed meanwhile */ }
    }
  }

  #activity(type, ref, text, extra = {}) {
    const ev = { at: this.now(), type, mint: ref?.mint ?? null, symbol: ref?.symbol ?? '', setup: ref?.setup ?? ref?.origin ?? null,
      positionId: ref?.positionId ?? (ref?.tokens != null ? ref.id : null) ?? null, signalId: ref?.signalId ?? ref?.meta?.signalId ?? (ref?.conditions ? ref.id : null) ?? null, text, ...extra };
    try { this.store.addActivity(ev); } catch (e) { this.log.warn(`setuh activity: ${e.message}`); }
  }

  // ---------------------------------------------------------------- your controls
  /** Send a coin in yourself: it is watched and checked like a discovered candidate (same rules and gates). */
  submit(mint) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint))) throw new Error('Not a valid Solana token address');
    this.focus.set(mint, { at: this.now() });
    this.store.setKv('setuhFocus', Object.fromEntries(this.focus));
    this.market?.track(mint, 'setuh-focus');
    const c = this.engine?.coins.get(mint);
    if (!c || c.migrated) this.migratedWatch.set(mint, { mint, symbol: c?.symbol ?? '', name: c?.name ?? '', migratedAt: this.now(), createdAt: c?.createdAt ?? null, lastScanAt: 0, snap: null, focus: true });
    this.#queueDeep(mint, true);
    this.#activity('submitted', { mint, symbol: c?.symbol ?? '' }, `You sent this coin to the Setuh trader: it is checked against all five setups${c && !c.migrated ? '' : ' (graduated / not in live history: Migrated setup only)'}`);
    this.store.audit('user', 'strategy', 'submit', { mint });
    return { mint, tracked: Boolean(c), note: c && !c.migrated ? 'Watching all curve setups with full trade history' : 'Not in the bot\'s live trade history: curve setups need that history, so only the Migrated setup can be checked (from GeckoTerminal candles)' };
  }
  unsubmit(mint) { this.focus.delete(mint); this.store.setKv('setuhFocus', Object.fromEntries(this.focus)); this.market?.untrack(mint, 'setuh-focus'); }

  async approve(signalId) {
    const p = this.pending.get(signalId);
    if (!p) throw new Error('This signal is no longer waiting for approval');
    this.pending.delete(signalId);
    p.sig.approvedAt = this.now();
    this.#activity('approved', p.sig, `You approved the entry — re-checking the newest price before simulating it`);
    await this.#execute(p.sig, p.ctx, p.ev, p.market, 'approved by you');
    return this.#sigView(p.sig);
  }
  cancel(signalId) {
    const p = this.pending.get(signalId);
    if (!p) throw new Error('This signal is no longer waiting for approval');
    this.pending.delete(signalId);
    p.sig.status = 'cancelled'; p.sig.reason = 'Cancelled by you';
    this.#close(`${p.sig.setup}:${p.sig.mint}`, p.sig);
    this.#activity('cancelled', p.sig, 'Pending entry cancelled by you');
    return this.#sigView(p.sig);
  }

  sellManually(id, pct, requestId) {
    const pos = this.book.open.get(String(id));
    if (!pos) throw new Error('Position not found (it may already be closed)');
    const r = this.book.sell(id, pct, { reason: `Manual override: sold ${pct}%`, idemKey: requestId ? `strategy:${id}:${requestId}` : null });
    return this.book.view(r.position);
  }
  /** Close every entry on a coin (combined position). */
  closeCoin(mint, requestId) {
    const ids = [...this.book.open.values()].filter((p) => p.mint === mint).map((p) => p.id);
    if (!ids.length) throw new Error('No open entries on this coin');
    for (const id of ids) this.book.sell(id, 100, { reason: 'Closed manually (whole coin)', idemKey: requestId ? `strategy:coin:${id}:${requestId}` : null });
    return { closed: ids.length };
  }

  // ---------------------------------------------------------------- full safety checks
  #queueDeep(mint, priority = false) {
    if (!this.deepcheck) return;
    const d = this.deep.get(mint);
    // a failed check is retried after a minute (not left to stall for the full cache time)
    if (d && (d.running || this.now() - d.at < (d.error ? 60_000 : DEEP_TTL_MS))) return;
    if (this.deepQueue.includes(mint)) return;
    priority ? this.deepQueue.unshift(mint) : this.deepQueue.push(mint);
    this.#pumpDeep();
  }
  #pumpDeep() {
    while (this.deepRunning < 2 && this.deepQueue.length) {
      const mint = this.deepQueue.shift();
      this.deepRunning++;
      this.deep.set(mint, { ...(this.deep.get(mint) ?? {}), running: true, at: this.now() });
      const t0 = performance.now();
      this.deepcheck.check(mint)
        .then((report) => { this.deep.set(mint, { at: this.now(), running: false, report }); this.funnel?.count(`setuh:deep:${report.verdict}`); this.metrics?.time('deepCheck', performance.now() - t0, 'Full safety check (Coin Check)'); })
        .catch((e) => this.deep.set(mint, { at: this.now(), running: false, error: e.message }))
        .finally(() => { this.deepRunning--; this.#pumpDeep(); });
    }
  }

  // ---------------------------------------------------------------- scanning
  curveContext(coin, setupCfg) {
    const solUsd = this.engine.solUsd;
    const r = coin.result;
    const insiders = r?.insiderWallets?.length ? { heldAtEvalPct: r.insiderHeldAtEval ?? 0, heldNowPct: r.insiderWallets.reduce((s, w) => s + coin.holderPct(w), 0) } : null;
    return {
      now: this.now(), supply: 1e9, solUsd, ageMin: coin.ageSec(this.now()) / 60,
      launchMcUsd: (coin.startMcSol || coin.trades[0]?.mcSol || coin.mcSol) * solUsd, mcUsd: coin.mcSol * solUsd,
      candles: candlesFromTrades(coin.trades, setupCfg.candleSec ?? 30, solUsd, { now: this.now(), supply: 1, maxCandles: 400 }),
      trades: coin.trades, safety: r?.safety ?? null, narrative: r?.narrative?.score ?? null, insiders,
      bundleHeldPct: r?.safety?.launchBundle?.heldPct ?? null,
      devSold: coin.devSold, devSoldPct: coin.devSoldPct, migrated: coin.migrated, dev: this.devReputation(coin.creator), chainVerified: coin.chainData?.source === 'chain',
      symbol: coin.symbol, name: coin.name, mint: coin.mint, creator: coin.creator, vSol: coin.vSol, live: r ?? null,
    };
  }

  async scan() {
    if (!this.engine) return;
    const t0 = performance.now();
    const solUsd = this.engine.solUsd;
    if (!(solUsd > 0)) return;
    const now = this.now();
    for (const coin of this.engine.coins.values()) {
      if (coin.migrated || coin.trades.length < 8) continue;
      const focused = this.focus.has(coin.mint);
      if (this.settings.discoveryPaused && !focused) continue;
      for (const id of CURVE_SETUPS) {
        const sc = this.setups[id];
        if (!sc.enabled) continue;
        if (!focused) {
          // early rejection of obviously unsuitable coins (cheap checks before any work)
          if (id === 'newPairs' && coin.ageSec(now) / 60 > sc.maxAgeMin + 5) continue;
          if (id === 'finalC' && !this.#devIsCandidate(coin.creator, sc)) continue;
          if ((id === 'finalA' || id === 'finalB') && coin.athMcSol * solUsd < sc.minPeakMcUsd * 0.9) continue;
          if (coin.result?.safety?.verdict === 'AVOID' && !this.active.has(`${id}:${coin.mint}`)) continue;
        }
        const ctx = this.curveContext(coin, sc);
        const ev = EVALUATORS[id](ctx, sc);
        await this.#handle(id, ctx, ev, { onCurve: true, vSol: coin.vSol });
      }
    }
    this.metrics?.time('setupScan', performance.now() - t0, 'Setup recognition (all live coins)');
    this.#expirePending(now);
    this.#manage();
    this.#expire(now);
  }

  #devIsCandidate(creator, sc) {
    if (!creator) return false;
    if (this.trackedDevs[creator]) return true;
    return this.devReputation(creator).graduated >= sc.minDevGraduated;
  }

  /** Track one evaluation through the decision stages; act when everything is confirmed. */
  async #handle(setup, ctx, ev, market) {
    const key = `${setup}:${ctx.mint}`;
    const now = this.now();
    const stage = decisionStage(ev);
    // re-arm multiple entries: after an entry, the setup must stop being a signal before it can qualify again
    if (stage !== 'signal' && this.armed.get(key) === false) this.armed.set(key, true);
    if ((this.retryAt.get(key) ?? 0) > now) return;
    let sig = this.active.get(key);
    if (stage === 'idle' && !sig) return;
    if (!sig) {
      if (stage === 'rejected' && !ev.conditions.some((c) => ['pullback', 'run', 'high', 'reputation'].includes(c.key) && c.ok === true)) return;
      if (stage === 'signal' && this.armed.get(key) === false) return; // same signal still standing after an entry: not a new one
      sig = { id: `${key}:${now}`, setup, mint: ctx.mint, symbol: ctx.symbol, name: ctx.name ?? '', at: now, status: stage, regime: this.engine?.regime?.().state ?? null, focus: this.focus.has(ctx.mint) };
      this.active.set(key, sig);
      this.#activity('setup', sig, `${SETUPS[setup].family} · ${SETUPS[setup].name} forming at $${(ctx.mcUsd / 1000).toFixed(1)}K — ${label(stage)}`);
      if (stage !== 'rejected') this.#queueDeep(ctx.mint); // deeper analysis as soon as a setup starts forming
    }
    const prevStatus = sig.status;
    Object.assign(sig, { updatedAt: now, conditions: ev.conditions, unconfirmed: ev.unconfirmed, entry: ev.entry, invalidation: ev.invalidation,
      target: ev.target, rewardRisk: ev.rewardRisk, mcUsd: ctx.mcUsd, priceUsd: ctx.mcUsd / ctx.supply });
    if (stage === 'rejected') { sig.status = 'rejected'; sig.reason = ev.rejectReason; this.#activity('rejected', sig, `Rejected: ${ev.rejectReason}`); this.#close(key, sig, true); return; }
    if (stage === 'idle') { sig.status = 'invalidated'; sig.reason = `Setup invalidated before entry: ${ev.unconfirmed.slice(0, 2).join('; ') || 'pattern broke down'}`; this.#activity('invalidated', sig, sig.reason); this.#close(key, sig, true); return; }
    if (stage !== 'signal') {
      // the signal lapsed (if it had fired): the next one starts a fresh signal price and time
      if (sig.validAt) { delete sig.validAt; delete sig.signalPriceUsd; delete sig.signalMcUsd; }
      sig.status = stage;
      if (prevStatus !== stage) this.#activity(stage, sig, `${label(stage)}${stage === 'waiting_confirmation' ? `: setup confirmed, waiting for ${ev.unconfirmed.slice(0, 2).join(' / ')}` : stage === 'insufficient_data' ? `: ${ev.conditions.filter((c) => c.ok === null).map((c) => c.label).slice(0, 2).join(' / ')}` : ''}`);
      if (!sig.saved || now - sig.saved > 60_000 || prevStatus !== stage) { sig.saved = now; this.store.saveSignal(sig); }
      return;
    }
    if (this.armed.get(key) === false) return;
    if (this.pending.has(sig.id)) return;
    // every rule met: gates, confidence, then entry (or approval)
    sig.validAt ??= now; // reset whenever the signal lapses (see above), so drift is measured from THIS signal
    sig.signalPriceUsd ??= ctx.mcUsd / ctx.supply;
    sig.signalMcUsd ??= ctx.mcUsd;
    const g = this.#gates(ctx, ev, market);
    const dErr = this.deep.get(ctx.mint);
    if (!g.report && dErr?.error && !dErr.running && this.settings.requireDeepCheck && this.deepcheck) {
      sig.status = 'insufficient_data'; sig.reason = `Full safety check failed: ${dErr.error} (retrying in about a minute)`;
      this.#activity('insufficient_data', sig, sig.reason); this.#close(key, sig, true); return;
    }
    sig.safety = { report: g.report ? { verdict: g.report.verdict, score: g.report.score, bad: g.report.bad, warn: g.report.warn, unknown: g.report.unknown, at: g.report.at } : null, gates: g.gates };
    sig.confidence = g.confidence;
    if (g.gates.pending) {
      if (prevStatus !== 'waiting_safety') this.#activity('screening', sig, `Setup confirmed — waiting for the full safety check (${g.gates.unknown.map((u) => u.text).join('; ')})`);
      sig.status = 'waiting_safety';
      return;
    }
    if (!g.gates.ok) {
      sig.status = 'rejected'; sig.reason = `Safety gate failed: ${g.gates.failed.map((f) => f.text).join('; ')}`;
      this.#activity('rejected', sig, sig.reason); this.#close(key, sig, true); return;
    }
    this.#activity('passed_safety', sig, `Passed safety gates: ${g.gates.passed.map((p) => p.text).join(' · ')}`);
    if (g.confidence.score < this.settings.minConfidence) {
      sig.status = 'rejected'; sig.reason = `Confidence ${g.confidence.score} is below the minimum ${this.settings.minConfidence}`;
      this.#activity('rejected', sig, sig.reason); this.#close(key, sig, true); return;
    }
    this.#activity('confidence', sig, `Confidence ${g.confidence.score}/100 (minimum ${this.settings.minConfidence})`);
    sig.why = this.#explain(setup, ev, g.confidence.score);
    if (this.settings.mode === 'approval') {
      sig.status = 'pending_approval';
      this.pending.set(sig.id, { sig, ctx, ev, market, expiresAt: now + this.settings.approvalTtlSec * 1000 });
      this.store.saveSignal(sig);
      this.#activity('pending_approval', sig, `Ready to enter — waiting for your approval (expires in ${this.settings.approvalTtlSec}s)`);
      return;
    }
    await this.#execute(sig, ctx, ev, market, 'autonomous');
  }

  #gates(ctx, ev, market) {
    const d = this.deep.get(ctx.mint);
    if (this.deepcheck && (!d || (!d.running && this.now() - d.at > DEEP_TTL_MS))) this.#queueDeep(ctx.mint, true);
    const report = d?.report ?? null;
    const slipPct = this.#slip(ctx, market, this.settings.positionUsd);
    const gates = safetyGates({ report, live: ctx.live, slipPct, settings: { ...this.settings, requireDeepCheck: this.settings.requireDeepCheck && Boolean(this.deepcheck) }, deepPending: Boolean(d?.running) });
    const stats = tradeStats(this.book.closedViews(2000).filter((p) => p.origin === ev.setup));
    const confidence = setupConfidence({ ev, report, live: ctx.live, slipPct, maxSlippagePct: this.settings.maxSlippagePct,
      streaming: this.market ? this.market.freshness(ctx.mint).streaming : true, candles: ctx.candles?.length ?? 0, setupStats: stats });
    return { report, gates, confidence };
  }

  #slip(ctx, market, sizeUsd) {
    const solUsd = this.engine?.solUsd ?? 0;
    const L = liquidityRead({ onCurve: market.onCurve, vSol: market.vSol ?? (market.onCurve && solUsd > 0 ? curveVSolFromMc(ctx.mcUsd / solUsd) : null),
      liqUsd: market.liqUsd ?? 0, mcUsd: ctx.mcUsd, solUsd, orderUsd: sizeUsd });
    if (!L || !(L.depthUsd > 0)) return null;
    return priceImpact(sizeUsd, L.depthUsd).avgPct + (this.cfg.paperMevPct ?? 2);
  }

  /**
   * Simulate the entry with the NEWEST data: fresh quote (age-checked), rules re-checked at that price,
   * drift and reward/risk checked, then the fill is simulated with fees and slippage.
   */
  async #execute(sig, ctx, ev, market, how) {
    const key = `${sig.setup}:${sig.mint}`;
    const t0 = performance.now();
    const S = this.settings, sc = this.setups[sig.setup];
    const size = S.positionUsd;
    const block = this.#entryBlock(sig.setup, sig.mint, size);
    if (block) { sig.status = 'skipped'; sig.reason = block; this.#activity('skipped', sig, `Entry skipped: ${block}`); this.#close(key, sig, false); this.armed.set(key, false); return; }
    // 1) newest market data, age-checked
    let quote = null;
    if (this.market) {
      this.market.track(sig.mint, 'setuh-entry');
      const r = await this.market.quote(sig.mint, { maxAgeMs: S.maxDataAgeSec * 1000, needLiquidity: !market.onCurve });
      if (!r.ok) {
        sig.status = 'insufficient_data'; sig.reason = `Entry blocked: ${r.reason}`;
        this.#activity('insufficient_data', sig, sig.reason); this.#close(key, sig, true); return;
      }
      quote = r.quote;
    } else {
      quote = { priceUsd: ctx.mcUsd / ctx.supply, mcUsd: ctx.mcUsd, onCurve: market.onCurve, vSol: market.vSol, liqUsd: market.liqUsd ?? null, source: 'evaluation data', ageMs: 0 };
    }
    const decision = { at: this.now(), priceUsd: quote.priceUsd, mcUsd: quote.mcUsd, ageMs: quote.ageMs, source: quote.source };
    sig.decision = decision;
    // 2) rules again at the fresh price
    const fresh = { ...ctx, mcUsd: quote.mcUsd, now: this.now() };
    const ev2 = EVALUATORS[sig.setup](fresh, sc);
    const drift = (quote.priceUsd / sig.signalPriceUsd - 1) * 100;
    const fail = (status, reason) => { sig.status = status; sig.reason = reason; this.#activity(status, sig, reason); this.#close(key, sig, true); };
    if (quote.priceUsd <= ev.invalidation.priceUsd) return fail('invalidated', `Setup invalidated: price ${fmtP(quote.priceUsd)} is at or below the invalidation level ${fmtP(ev.invalidation.priceUsd)}`);
    if (drift > S.maxEntryDriftPct) return fail('missed', `Entry missed: price moved +${drift.toFixed(1)}% since the signal (limit ${S.maxEntryDriftPct}%)`);
    if (ev2.phase !== 'signal') return fail('missed', `Entry missed: at the newest price the setup no longer qualifies (${ev2.unconfirmed.slice(0, 2).join('; ') || ev2.rejectReason || 'conditions changed'})`);
    const stop = ev.invalidation.priceUsd;
    const riskPct = (1 - stop / quote.priceUsd) * 100;
    const rr = riskPct > 0 ? sc.targetPct / riskPct : null;
    if (!(rr >= S.minRewardRisk)) return fail('missed', `Entry missed: reward/risk at the newest price is ${rr ? rr.toFixed(2) : 'n/a'} (minimum ${S.minRewardRisk})`);
    const freshMarket = { onCurve: quote.onCurve, vSol: quote.vSol ?? market.vSol, liqUsd: quote.liqUsd ?? market.liqUsd };
    const slip = this.#slip(fresh, freshMarket, size);
    if (slip == null) return fail('insufficient_data', 'Entry blocked: liquidity unknown, slippage cannot be simulated');
    if (slip > S.maxSlippagePct) return fail('rejected', `Estimated slippage ${slip.toFixed(1)}% at the newest price is above the ${S.maxSlippagePct}% limit`);
    // 3) simulate the fill
    const entryNo = this.#nextEntryNo(sig.mint);
    const snap = { mint: sig.mint, symbol: sig.symbol, name: sig.name, priceUsd: quote.priceUsd, mcUsd: quote.mcUsd, supply: 1e9, onCurve: quote.onCurve,
      vSol: freshMarket.vSol ?? (quote.onCurve && this.engine?.solUsd ? curveVSolFromMc(quote.mcUsd / this.engine.solUsd) : null), liqUsd: freshMarket.liqUsd, source: quote.source };
    let pos;
    try {
      pos = this.book.openPosition({ snap, budgetUsd: size, origin: sig.setup, idemKey: sig.id,
        risk: { stopPrice: stop, tpPct: sc.targetPct, tpSellPct: S.partialTakePct, maxHoldMin: Math.min(sc.maxHoldMin ?? S.maxHoldMin, S.maxHoldMin) },
        meta: { signalId: sig.id, setup: sig.setup, entryNo, how, regime: sig.regime, why: sig.why, confidence: sig.confidence, safety: sig.safety,
          conditions: ev.conditions, invalidation: ev.invalidation, target: { ...ev.target, priceUsd: quote.priceUsd * (1 + sc.targetPct / 100) }, rewardRisk: rr,
          signal: { at: sig.validAt, priceUsd: sig.signalPriceUsd, mcUsd: sig.signalMcUsd }, decision,
          buyReason: `Entry ${entryNo}: ${SETUPS[sig.setup].family} · ${SETUPS[sig.setup].name} (${how})` } });
    } catch (e) { return fail('rejected', `Entry failed: ${e.message}`); }
    const execMs = performance.now() - t0;
    pos.meta.fill = { at: pos.openedAt, priceUsd: pos.refPriceUsd, avgCostUsd: pos.entryPriceUsd, slipPct: pos.entrySlipPct, execMs, signalToEntryMs: pos.openedAt - sig.validAt };
    this.store.saveSimPosition('strategy', pos);
    this.metrics?.time('signalToEntry', pos.openedAt - sig.validAt, 'Signal → simulated entry');
    this.metrics?.time('execution', execMs, 'Simulated execution (fresh quote → fill)');
    this.market?.track(sig.mint, 'setuh');
    Object.assign(sig, { status: 'entered', positionId: pos.id, entryNo, fill: pos.meta.fill });
    this.#activity('entry', { ...sig, positionId: pos.id }, `Entry ${entryNo} executed: $${size.toFixed(2)} at ${fmtP(pos.refPriceUsd)} (MC $${(quote.mcUsd / 1000).toFixed(1)}K, data ${(quote.ageMs / 1000).toFixed(1)}s old) · signal ${fmtP(sig.signalPriceUsd)} · drift ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}% · ${(execMs).toFixed(0)} ms`, { entryNo });
    this.engine?.logEvent?.('EXECUTOR', { symbol: sig.symbol, mint: sig.mint }, `Setuh entry ${entryNo}: ${SETUPS[sig.setup].name} at $${(quote.mcUsd / 1000).toFixed(1)}K`, 'good');
    this.armed.set(key, false);
    this.#close(key, sig, false);
  }

  #nextEntryNo(mint) {
    const since = this.now() - 24 * 3600_000;
    const all = [...this.book.open.values(), ...this.store.simPositions('strategy', 'closed', 2000)].filter((p) => p.mint === mint && p.openedAt >= since);
    return all.length + 1;
  }

  #explain(setup, ev, score) {
    const s = SETUPS[setup];
    return `${s.family} · ${s.name}: ${ev.conditions.filter((c) => c.ok).map((c) => c.detail || c.label).slice(0, 4).join('; ')}. ` +
      `Invalid below $${(ev.invalidation.mcUsd / 1000).toFixed(1)}K (${ev.invalidation.why}); target +${ev.target.pct}%` +
      `${ev.rewardRisk ? ` (${ev.rewardRisk.toFixed(1)}:1 reward to risk on paper)` : ''}; confidence ${score}/100.`;
  }

  #close(key, sig, retryLater) {
    this.store.saveSignal(sig);
    this.funnel?.count(`setuh:${sig.setup}:${sig.status}`);
    if (sig.reason) this.funnel?.count(`setuhReason:${sig.status}:${reasonKey(sig.reason)}`);
    this.active.delete(key);
    if (retryLater) this.retryAt.set(key, this.now() + RETRY_MS);
    if (this.retryAt.size > 5000) for (const [k, t] of this.retryAt) if (t < this.now()) this.retryAt.delete(k);
  }

  #expire(now) {
    for (const [key, sig] of this.active) {
      if (sig.status === 'pending_approval') continue;
      if (now - (sig.updatedAt ?? sig.at) > 10 * 60_000) { sig.status = 'invalidated'; sig.reason = 'Stopped forming (no update for 10 min)'; this.#close(key, sig, false); }
    }
  }

  #expirePending(now) {
    for (const [id, p] of this.pending) {
      if (now < p.expiresAt) continue;
      this.pending.delete(id);
      p.sig.status = 'missed'; p.sig.reason = 'Entry missed: approval window expired';
      this.#activity('missed', p.sig, p.sig.reason);
      this.#close(`${p.sig.setup}:${p.sig.mint}`, p.sig, true);
    }
  }

  /** Position management beyond stop / target / trail / time: emergency exits and the New Pairs early take. */
  #manage() {
    const solUsd = this.engine?.solUsd ?? 0;
    for (const pos of [...this.book.open.values()]) {
      const coin = this.engine?.coins.get(pos.mint);
      const sell = (reason, key) => { try { this.book.sell(pos.id, 100, { reason, idemKey: `${pos.id}:${key}`, actor: 'system' }); } catch (e) { this.log.warn(`setuh exit: ${e.message}`); } };
      if (coin) {
        const after = (coin.result?.events ?? []).filter((e) => e.at > pos.openedAt && /dumped|Dev started selling/i.test(e.text));
        if (after.length) { sell(`Emergency exit: ${after[0].text}`, 'emergency-insider'); continue; }
        if (coin.result?.safety?.verdict === 'AVOID' && coin.result.at > pos.openedAt) { sell('Emergency exit: the live safety read turned AVOID', 'emergency-avoid'); continue; }
      }
      const q = this.market?.get(pos.mint);
      if (q && !q.onCurve && q.liqUsd != null && pos.meta?.entryLiqUsd && q.liqUsd < pos.meta.entryLiqUsd * 0.4) { sell(`Emergency exit: pool liquidity fell ${Math.round((1 - q.liqUsd / pos.meta.entryLiqUsd) * 100)}% since entry`, 'emergency-liq'); continue; }
      if (pos.meta && pos.meta.entryLiqUsd == null && q?.liqUsd != null) pos.meta.entryLiqUsd = q.liqUsd;
      if (pos.origin === 'newPairs' && coin && solUsd > 0) {
        const sc = this.setups.newPairs;
        const gainPct = (pos.priceUsd / pos.refPriceUsd - 1) * 100;
        const f = flowOf(coin.trades, this.now(), (sc.flowWindowSec ?? 60) * 1000, solUsd);
        if (gainPct >= sc.earlyTakeMinPct && f.sellUsd > 0 && f.sellUsd >= f.buyUsd * sc.earlySellRatio) sell(`Early profit: +${gainPct.toFixed(0)}% and sellers took over`, 'early');
      }
    }
  }

  async scanMigrated() {
    const sc = this.setups.migrated;
    if (!sc.enabled || !this.candles) return;
    const now = this.now();
    for (const [mint, w] of this.migratedWatch) if (!w.focus && now - w.migratedAt > (sc.maxAgeMin + 60) * 60_000) this.migratedWatch.delete(mint);
    const list = [...this.migratedWatch.values()].filter((w) => w.focus || !this.settings.discoveryPaused);
    if (!list.length) return;
    const snaps = await dexSnapshots(list.map((w) => w.mint), { fetchFn: this.fetchFn }).catch(() => new Map());
    const due = [];
    for (const w of list) {
      const s = snaps.get(w.mint);
      if (s) { w.snap = s; w.symbol ||= s.symbol; w.name ||= s.name; }
      const ageMin = w.createdAt ? (now - w.createdAt) / 60_000 : s?.pairCreatedAt ? (now - s.pairCreatedAt) / 60_000 : (now - w.migratedAt) / 60_000;
      if (!w.focus) {
        if (ageMin < sc.minAgeMin - 10 || ageMin > sc.maxAgeMin) continue;
        if (!s || s.mcUsd < sc.supportMinMcUsd * 0.6 || s.mcUsd > sc.supportMaxMcUsd * 1.6 || s.liqUsd < sc.minLiqUsd * 0.5) continue;
      }
      if (now - w.lastScanAt < (w.focus ? 60_000 : 3 * 60_000)) continue;
      due.push([w, ageMin]);
    }
    for (const [w, ageMin] of due.sort((a, b) => Number(b[0].focus ?? 0) - Number(a[0].focus ?? 0) || a[0].lastScanAt - b[0].lastScanAt).slice(0, 6)) {
      w.lastScanAt = now;
      let g;
      try { g = await this.candles.geckoCandles(w.mint, '5m'); } catch (e) { this.log.warn(`setuh migrated ${w.symbol}: ${e.message}`); continue; }
      if (!g.candles.length || !g.pool?.priceUsd) continue;
      const supply = g.pool.mcUsd && g.pool.priceUsd ? g.pool.mcUsd / g.pool.priceUsd : 1e9;
      const live = this.market?.get(w.mint);
      const ctx = { now, supply, ageMin, ageBasis: w.createdAt ? 'since launch' : 'since the pool opened',
        mcUsd: live && live.ageMs < 30_000 ? live.mcUsd : g.pool.mcUsd ?? w.snap?.mcUsd, liqUsd: g.pool.liqUsd ?? w.snap?.liqUsd ?? null,
        candles: g.candles.map((c) => ({ ...c, o: c.o * supply, h: c.h * supply, l: c.l * supply, c: c.c * supply })),
        safety: null, mint: w.mint, symbol: w.symbol, name: w.name, live: null };
      this.market?.track(w.mint, 'setuh-migrated');
      const ev = EVALUATORS.migrated(ctx, sc);
      await this.#handle('migrated', ctx, ev, { onCurve: false, liqUsd: ctx.liqUsd });
    }
  }

  async pollPrices() {
    if (this.sync) return this.sync();
    const mints = [...this.book.open.values()].filter((p) => !(p.source === 'live feed' && this.now() - p.lastAt < 30_000)).map((p) => p.mint);
    if (mints.length) {
      const snaps = await dexSnapshots(mints, { fetchFn: this.fetchFn });
      for (const [mint, s] of snaps) this.book.updatePrice(mint, { priceUsd: s.priceUsd, mcUsd: s.mcUsd, liqUsd: s.liqUsd, onCurve: s.onCurve, source: 'DexScreener' });
    }
    this.book.tick();
  }

  start(health) {
    health.job('Setuh trader: setup scan + management', () => this.scan(), 2_000);
    health.job('Setuh trader: migrated coins scan', () => this.scanMigrated(), 30_000);
    health.job('Setuh positions: prices + exits', () => this.pollPrices(), 5_000);
  }

  // ---------------------------------------------------------------- Coin Check: strategy compatibility
  /** How a coin fits each Setuh setup right now, and whether it qualifies for paper trading (same gates as entries). */
  async compatibility(mint, report = null) {
    const coin = this.engine?.coins.get(mint);
    const out = { setups: [], qualifies: null, note: '' };
    const q = this.market?.get(mint) ?? null;
    let market = { onCurve: true, vSol: coin?.vSol, liqUsd: null };
    if (coin && !coin.migrated) {
      for (const id of CURVE_SETUPS) {
        const sc = this.setups[id];
        const ctx = this.curveContext(coin, sc);
        const ev = EVALUATORS[id](ctx, sc);
        out.setups.push(this.#compatRow(id, ev, ctx, market, report));
      }
    } else out.note = coin ? 'Graduated: curve setups no longer apply.' : 'Not in the bot\'s live trade history, so curve setups (which need every trade since launch) can\'t be evaluated.';
    if ((!coin || coin.migrated) && this.candles) {
      try {
        const g = await this.candles.geckoCandles(mint, '5m');
        if (g.candles.length && g.pool?.priceUsd) {
          const supply = g.pool.mcUsd / g.pool.priceUsd || 1e9;
          const ageMin = coin ? (this.now() - coin.createdAt) / 60_000 : g.pool.createdAt ? (this.now() - g.pool.createdAt) / 60_000 : null;
          const ctx = { now: this.now(), supply, ageMin, ageBasis: coin ? 'since launch' : 'since the pool opened', mcUsd: q && q.ageMs < 30_000 ? q.mcUsd : g.pool.mcUsd, liqUsd: g.pool.liqUsd,
            candles: g.candles.map((c) => ({ ...c, o: c.o * supply, h: c.h * supply, l: c.l * supply, c: c.c * supply })), safety: null, mint, live: null };
          market = { onCurve: false, liqUsd: g.pool.liqUsd };
          out.setups.push(this.#compatRow('migrated', EVALUATORS.migrated(ctx, this.setups.migrated), ctx, market, report));
        } else out.setups.push({ id: 'migrated', family: SETUPS.migrated.family, name: SETUPS.migrated.name, stage: 'insufficient_data', note: 'No candle data from GeckoTerminal yet' });
      } catch (e) { out.setups.push({ id: 'migrated', family: SETUPS.migrated.family, name: SETUPS.migrated.name, stage: 'insufficient_data', note: e.message }); }
    }
    const mcUsd = q?.mcUsd ?? (coin ? coin.mcSol * (this.engine.solUsd || 0) : null);
    const slipPct = mcUsd ? this.#slip({ mcUsd, supply: 1e9 }, market, this.settings.positionUsd) : null;
    const gates = safetyGates({ report, live: coin?.result ?? null, slipPct, settings: { ...this.settings, requireDeepCheck: true } });
    out.qualifies = { ok: gates.ok, failed: gates.failed, passed: gates.passed, unknown: gates.unknown,
      summary: gates.ok ? 'Passes the Setuh trader\'s safety gates (still not a guarantee of safety)' : gates.failed.length ? 'Fails a critical safety gate: the Setuh trader will not enter it' : 'Missing data: the Setuh trader will not enter until the checks complete' };
    out.inFocus = this.focus.has(mint);
    return out;
  }

  #compatRow(id, ev, ctx, market, report) {
    const stage = decisionStage(ev);
    const slipPct = this.#slip(ctx, market, this.settings.positionUsd);
    const conf = setupConfidence({ ev, report, live: ctx.live, slipPct, maxSlippagePct: this.settings.maxSlippagePct, streaming: this.market ? this.market.freshness(ctx.mint).streaming : false, candles: ctx.candles?.length ?? 0 });
    return { id, family: SETUPS[id].family, name: SETUPS[id].name, stage, label: label(stage === 'signal' ? 'signal' : stage), met: ev.conditions.filter((c) => c.ok === true).length,
      total: ev.conditions.length, conditions: ev.conditions, unconfirmed: ev.unconfirmed, confidence: conf.score, invalidation: ev.invalidation, target: ev.target, rejectReason: ev.rejectReason };
  }

  // ---------------------------------------------------------------- views
  #sigView(s) { return { ...s, history: undefined }; }

  /** Trade journal: one row per entry (entries on a coin are separate), plus the combined position per coin. */
  journal(limit = 300) {
    const rows = [...this.book.openViews(), ...this.book.closedViews(limit)].map((p) => {
      const m = p.meta ?? {};
      const sells = p.fills.filter((f) => f.kind === 'sell');
      const q = sells.reduce((s, f) => s + f.tokens, 0);
      return {
        id: p.id, status: p.status, mint: p.mint, symbol: p.symbol, name: p.name, setup: p.origin, family: SETUPS[p.origin]?.family ?? '', setupName: SETUPS[p.origin]?.name ?? p.origin,
        entryNo: m.entryNo ?? null, confidence: m.confidence?.score ?? null, confidenceParts: m.confidence?.parts ?? [], safety: m.safety ?? null, how: m.how ?? '',
        signal: m.signal ?? null, decision: m.decision ?? null, fill: m.fill ?? { at: p.openedAt, priceUsd: p.entryPriceUsd, avgCostUsd: p.avgCostUsd },
        sizeUsd: p.budgetUsd, openedAt: p.openedAt, closedAt: p.closedAt, exitPriceUsd: q ? sells.reduce((s, f) => s + f.tokens * f.priceUsd, 0) / q : null,
        currentPriceUsd: p.priceUsd, currentMcUsd: p.mcUsd, staleSec: p.staleSec, source: p.source, levels: p.levels, risk: p.risk,
        feesUsd: p.feesUsd, slippageUsd: p.slippageUsd, pnlUsd: p.pnlUsd, pnlPct: p.pnlPct, unrealizedUsd: p.unrealizedUsd, realizedPnlUsd: p.realizedPnlUsd,
        ifSoldUsd: p.ifSoldUsd, tokens: p.tokens, soldPct: p.soldPct, holdSec: p.holdSec, why: m.why ?? '', exitReason: p.exitReason, fills: p.fills,
      };
    }).sort((a, b) => b.openedAt - a.openedAt);
    const coins = new Map();
    for (const r of rows.filter((x) => x.status === 'open')) {
      const c = coins.get(r.mint) ?? { mint: r.mint, symbol: r.symbol, entries: 0, investedUsd: 0, valueUsd: 0, unrealizedUsd: 0, realizedUsd: 0, setups: new Set() };
      c.entries++; c.investedUsd += r.sizeUsd; c.valueUsd += r.ifSoldUsd; c.unrealizedUsd += r.unrealizedUsd; c.realizedUsd += r.realizedPnlUsd; c.setups.add(r.setupName);
      c.priceUsd = r.currentPriceUsd; c.mcUsd = r.currentMcUsd; c.staleSec = r.staleSec;
      coins.set(r.mint, c);
    }
    return { entries: rows, coins: [...coins.values()].map((c) => ({ ...c, setups: [...c.setups], pnlUsd: c.valueUsd - c.investedUsd + c.realizedUsd })) };
  }

  /** Analytics per setup (this book only), incl. confidence ranges, missed and rejected opportunities. */
  performance() {
    const closed = this.book.closedViews(5000);
    const sigs = this.store.signalsSince(this.now() - 30 * 86400_000);
    const bySetup = {};
    for (const id of Object.keys(SETUPS)) {
      const s = sigs.filter((x) => x.setup === id);
      const count = (...st) => s.filter((x) => st.includes(x.status)).length;
      const trades = closed.filter((t) => t.origin === id);
      const bands = {};
      for (const t of trades) (bands[confidenceBand(t.meta?.confidence?.score)] ??= []).push(t);
      const byRegime = {};
      for (const t of trades) (byRegime[t.meta?.regime ?? 'unknown'] ??= []).push(t);
      const st = tradeStats(trades);
      bySetup[id] = {
        id, family: SETUPS[id].family, name: SETUPS[id].name, enabled: this.setups[id].enabled,
        detected: s.length, valid: count('entered', 'missed', 'skipped', 'pending_approval', 'cancelled'), entered: count('entered'),
        rejected: count('rejected'), missed: count('missed'), skipped: count('skipped'), invalidated: count('invalidated'), insufficient: count('insufficient_data'),
        open: [...this.book.open.values()].filter((p) => p.origin === id).length, ...st,
        returnPct: (st.netUsd / this.settings.startingBalanceUsd) * 100,
        byConfidence: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, tradeStats(v)])),
        byRegime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, tradeStats(v)])),
      };
    }
    const all = tradeStats(closed);
    const bands = {};
    for (const t of closed) (bands[confidenceBand(t.meta?.confidence?.score)] ??= []).push(t);
    return { bySetup, all: { ...all, returnPct: (all.netUsd / this.settings.startingBalanceUsd) * 100 },
      byConfidence: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, tradeStats(v)])), review: this.reviewNotes(bySetup, bands) };
  }

  /**
   * Documented, reviewable observations. Nothing here changes a rule: you decide in Rules & settings.
   * Needs enough trades to say anything (20+ per setup, 15+ per confidence range).
   */
  reviewNotes(bySetup, bands) {
    const notes = [];
    for (const s of Object.values(bySetup)) {
      if (s.trades < 20) { notes.push({ level: 'info', setup: s.id, text: `${s.name}: ${s.trades} completed trades — too few to judge (20 needed). No changes suggested.` }); continue; }
      if (s.profitFactor != null && s.profitFactor < 1) notes.push({ level: 'warn', setup: s.id, text: `${s.name}: losing on paper (profit factor ${s.profitFactor.toFixed(2)} over ${s.trades} trades). Consider a higher minimum confidence for it, stricter confirmation, or disabling it. Not applied automatically.` });
      if (s.missed > s.entered && s.missed >= 10) notes.push({ level: 'info', setup: s.id, text: `${s.name}: ${s.missed} entries missed vs ${s.entered} taken — mostly price drift before the fill. A slightly higher max entry drift would take more of them (at worse prices). Not applied automatically.` });
    }
    const lo = bands['50–59'] ?? bands['under 50'], hi = bands['80+'] ?? bands['70–79'];
    if (lo && hi && lo.length >= 15 && hi.length >= 15) {
      const a = tradeStats(lo), b = tradeStats(hi);
      if (a.winRate < b.winRate - 15) notes.push({ level: 'info', setup: null, text: `Low-confidence entries won ${a.winRate}% vs ${b.winRate}% for high-confidence ones. Raising the minimum confidence would filter more of them. Not applied automatically.` });
    }
    return notes;
  }

  view() {
    const open = this.book.openViews();
    const closed = this.book.closedViews(100);
    return {
      settings: this.settings, balance: this.balance(), budget: this.budget(), config: this.configView(),
      feed: { ok: this.feedOk(), market: this.market?.view() ?? null },
      open, closed: closed.slice(0, 60),
      watching: [...this.active.values()].map((s) => this.#sigView(s)).sort((a, b) => b.updatedAt - a.updatedAt),
      pending: [...this.pending.values()].map((p) => ({ ...this.#sigView(p.sig), expiresAt: p.expiresAt })),
      signals: this.store.recentSignals(100), activity: this.store.recentActivity(150),
      focus: [...this.focus.entries()].map(([mint, f]) => ({ mint, at: f.at, symbol: this.engine?.coins.get(mint)?.symbol ?? this.market?.get(mint)?.symbol ?? '' })),
      performance: this.performance(), migratedWatching: this.migratedWatch.size, summary: this.book.summary(closed, open),
      deepChecks: { running: this.deepRunning, queued: this.deepQueue.length },
    };
  }
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const LABELS = { waiting_setup: 'Waiting for setup', waiting_confirmation: 'Waiting for confirmation', insufficient_data: 'Insufficient data', signal: 'Entry conditions met',
  rejected: 'Rejected', invalidated: 'Setup invalidated', missed: 'Entry missed', entered: 'Approved & entered', pending_approval: 'Waiting for your approval',
  skipped: 'Skipped', cancelled: 'Cancelled', waiting_safety: 'Waiting for safety check', idle: 'No setup' };
export const label = (s) => LABELS[s] ?? s;
function fmtP(p) { if (!(p > 0)) return '$0'; if (p >= 1) return `$${p.toFixed(4)}`; const z = Math.max(0, -Math.floor(Math.log10(p)) - 1); return `$${p.toFixed(Math.min(z + 4, 14))}`; }
