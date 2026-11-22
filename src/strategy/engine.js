// System B: the Setuh strategy engine. Detects setups, explains every signal, and paper-trades them
// in its OWN book ("strategy") with its own daily budget, positions, history and statistics.
// It never reads or changes the automatic paper trader (paper.js, System A) or the manual book.
import { PaperBook, tradeStats } from '../paperbook.js';
import { SETUPS, EVALUATORS, mergeConfig, flowOf } from './setups.js';
import { candlesFromTrades } from '../candles.js';
import { dayKey } from '../paper.js';
import { dexSnapshots } from '../dexscreener.js';
import { curveVSolFromMc } from '../liquidity.js';

const CURVE_SETUPS = ['newPairs', 'finalA', 'finalB', 'finalC'];
const COOLDOWN_MS = 30 * 60_000;

export const STRATEGY_DEFAULTS = { enabled: true, dailyUsd: 50, perTradeUsd: 10, maxOpen: 5, maxOpenPerSetup: 2 };

export class StrategyEngine {
  constructor({ cfg, engine, store, feed = null, candles = null, fetchFn = fetch, log = console, now = () => Date.now() }) {
    Object.assign(this, { cfg, engine, store, feed, candles, fetchFn, log, now });
    this.book = new PaperBook({ store, cfg, book: 'strategy', getSolUsd: () => engine?.solUsd ?? 0, log, now,
      onEvent: (e) => this.#onFill(e) });
    this.active = new Map();     // `${setup}:${mint}` -> signal (current episode)
    this.cooldown = new Map();   // `${setup}:${mint}` -> until ts
    this.migratedWatch = new Map(); // mint -> { mint, symbol, migratedAt, createdAt, lastScanAt, snap }
    this.lastEval = new Map();   // `${setup}:${mint}` -> latest evaluation (for the UI)
    this.loadConfig();
    feed?.on?.('trade', (m) => this.onTrade(m));
    feed?.on?.('migrate', (m) => this.onMigrate(m));
  }

  // ---------------------------------------------------------------- settings
  loadConfig() {
    const saved = this.store.getKv('strategyConfig') ?? {};
    this.setups = mergeConfig(saved.setups);
    const s = saved.settings ?? {};
    this.settings = {
      enabled: s.enabled ?? this.cfg.strategyEnabled ?? STRATEGY_DEFAULTS.enabled,
      dailyUsd: Number(s.dailyUsd ?? this.cfg.strategyDailyUsd ?? STRATEGY_DEFAULTS.dailyUsd),
      perTradeUsd: Number(s.perTradeUsd ?? this.cfg.strategyPerTradeUsd ?? STRATEGY_DEFAULTS.perTradeUsd),
      maxOpen: Number(s.maxOpen ?? STRATEGY_DEFAULTS.maxOpen),
      maxOpenPerSetup: Number(s.maxOpenPerSetup ?? STRATEGY_DEFAULTS.maxOpenPerSetup),
    };
    this.trackedDevs = this.store.getKv('trackedDevs') ?? {};
  }

  /** Update settings for one setup or the engine. Unknown keys are ignored; bad values are refused. */
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
      if ('enabled' in values) s.enabled = Boolean(values.enabled);
      for (const k of ['dailyUsd', 'perTradeUsd', 'maxOpen', 'maxOpenPerSetup']) {
        if (!(k in values)) continue;
        const n = Number(values[k]);
        if (!Number.isFinite(n) || n < (k.startsWith('max') ? 0 : 1) || n > 1_000_000) throw new Error(`${k} is out of range`);
        s[k] = n;
      }
      if (s.perTradeUsd != null && s.dailyUsd != null && s.perTradeUsd > s.dailyUsd) throw new Error('Per-trade size cannot exceed the daily budget');
      saved.settings = s;
    }
    this.store.setKv('strategyConfig', saved);
    this.store.audit('user', 'strategy', 'config', { setup, values });
    this.loadConfig();
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

  /** Developer reputation: your tracked list plus outcomes of the dev's earlier coins the bot saw. */
  devReputation(creator) {
    if (!creator) return null;
    const h = this.store.devHistory(creator, '');
    const t = this.trackedDevs[creator];
    return { wallet: creator, finished: h.finished, graduated: h.migrated, rugged: h.rugged,
      tracked: t?.mode === 'follow', blocked: t?.mode === 'block', label: t?.label ?? '' };
  }

  configView() {
    return { settings: this.settings, setups: Object.fromEntries(Object.entries(SETUPS).map(([id, s]) =>
      [id, { family: s.family, name: s.name, summary: s.summary, values: this.setups[id], defaults: s.defaults }])),
      trackedDevs: this.trackedDevs };
  }

  // ---------------------------------------------------------------- budget
  #today() { return dayKey(this.now(), this.cfg.paperTz ?? 'UTC'); }
  budget() {
    const today = this.#today();
    const all = [...this.book.openViews(), ...this.book.closedViews(500)];
    const spent = all.filter((p) => dayKey(p.openedAt, this.cfg.paperTz ?? 'UTC') === today).reduce((s, p) => s + p.budgetUsd, 0);
    return { day: today, dailyUsd: this.settings.dailyUsd, spentUsd: spent, leftUsd: Math.max(0, this.settings.dailyUsd - spent), perTradeUsd: this.settings.perTradeUsd };
  }

  // ---------------------------------------------------------------- market events
  onTrade(msg) {
    const solUsd = this.engine?.solUsd ?? 0;
    if (!(solUsd > 0) || msg.marketCapSol == null) return;
    if (![...this.book.open.values()].some((p) => p.mint === msg.mint)) return;
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
    this.migratedWatch.set(msg.mint, { mint: msg.mint, symbol: c?.symbol ?? msg.symbol ?? '', name: c?.name ?? msg.name ?? '',
      migratedAt: this.now(), createdAt: c?.createdAt ?? null, creator: c?.creator ?? null, lastScanAt: 0, snap: null });
    // positions held from the curve now trade on the AMM pool: polling takes over
    for (const p of this.book.open.values()) if (p.mint === msg.mint) p.onCurve = false;
  }

  #onFill({ position, fill }) {
    this.engine?.logEvent?.('EXECUTOR', { symbol: position.symbol, mint: position.mint },
      `strategy ${SETUPS[position.origin]?.name ?? position.origin}: ${fill.reason} · ${fill.netUsd >= 0 ? '+' : ''}$${fill.netUsd.toFixed(2)}`, fill.reason.startsWith('Take') ? 'good' : '');
  }

  // ---------------------------------------------------------------- scanning
  /** Build the context the curve setups need from the engine's live coin. */
  curveContext(coin, setupCfg) {
    const solUsd = this.engine.solUsd;
    const r = coin.result;
    const insiders = r?.insiderWallets?.length ? { heldAtEvalPct: r.insiderHeldAtEval ?? 0,
      heldNowPct: r.insiderWallets.reduce((s, w) => s + coin.holderPct(w), 0) } : null;
    return {
      now: this.now(), supply: 1e9, solUsd, ageMin: coin.ageSec(this.now()) / 60,
      launchMcUsd: (coin.startMcSol || coin.trades[0]?.mcSol || coin.mcSol) * solUsd, mcUsd: coin.mcSol * solUsd,
      candles: candlesFromTrades(coin.trades, setupCfg.candleSec ?? 30, solUsd, { now: this.now(), supply: 1, maxCandles: 400 }),
      trades: coin.trades, safety: r?.safety ?? null, narrative: r?.narrative?.score ?? null, insiders,
      bundleHeldPct: r?.safety?.launchBundle?.heldPct ?? null,
      devSold: coin.devSold, devSoldPct: coin.devSoldPct, migrated: coin.migrated, dev: this.devReputation(coin.creator),
      symbol: coin.symbol, name: coin.name, mint: coin.mint, creator: coin.creator, vSol: coin.vSol,
    };
  }

  /** Evaluate the curve setups on every live coin; act on new signals. Runs every few seconds. */
  async scan() {
    if (!this.engine) return;
    const solUsd = this.engine.solUsd;
    if (!(solUsd > 0)) return;
    const now = this.now();
    for (const coin of this.engine.coins.values()) {
      if (coin.migrated || coin.trades.length < 8) continue;
      for (const id of CURVE_SETUPS) {
        const sc = this.setups[id];
        if (!sc.enabled) continue;
        if (id === 'newPairs' && coin.ageSec(now) / 60 > sc.maxAgeMin + 5) continue;
        if (id === 'finalC' && !this.#devIsCandidate(coin.creator, sc)) continue;
        if ((id === 'finalA' || id === 'finalB') && coin.athMcSol * solUsd < sc.minPeakMcUsd * 0.9) continue;
        const ctx = this.curveContext(coin, sc);
        const ev = EVALUATORS[id](ctx, sc);
        await this.#handle(id, ctx, ev, { onCurve: true, vSol: coin.vSol });
      }
    }
    this.#earlyExits();
    this.#expire(now);
  }

  #devIsCandidate(creator, sc) {
    if (!creator) return false;
    const t = this.trackedDevs[creator];
    if (t) return true;
    const d = this.devReputation(creator);
    return d.graduated >= sc.minDevGraduated;
  }

  /** New Pairs: take profit early when buying flips to heavy selling. */
  #earlyExits() {
    const sc = this.setups.newPairs;
    for (const pos of [...this.book.open.values()]) {
      if (pos.origin !== 'newPairs') continue;
      const coin = this.engine.coins.get(pos.mint);
      if (!coin) continue;
      const gainPct = (pos.priceUsd / pos.refPriceUsd - 1) * 100;
      const f = flowOf(coin.trades, this.now(), (sc.flowWindowSec ?? 60) * 1000, this.engine.solUsd);
      if (gainPct >= sc.earlyTakeMinPct && f.sellUsd > 0 && f.sellUsd >= f.buyUsd * sc.earlySellRatio) {
        try { this.book.sell(pos.id, 100, { reason: `Early profit: +${gainPct.toFixed(0)}% and sellers took over`, idemKey: `${pos.id}:early`, actor: 'system' }); }
        catch (e) { this.log.warn(`strategy early exit: ${e.message}`); }
      }
    }
  }

  /** Migrated coins: cheap DexScreener prefilter, then GeckoTerminal candles for the candidates. */
  async scanMigrated() {
    const sc = this.setups.migrated;
    if (!sc.enabled || !this.candles) return;
    const now = this.now();
    for (const [mint, w] of this.migratedWatch) if (now - w.migratedAt > (sc.maxAgeMin + 60) * 60_000) this.migratedWatch.delete(mint);
    const list = [...this.migratedWatch.values()];
    if (!list.length) return;
    const snaps = await dexSnapshots(list.map((w) => w.mint), { fetchFn: this.fetchFn }).catch(() => new Map());
    const due = [];
    for (const w of list) {
      const s = snaps.get(w.mint);
      if (s) { w.snap = s; w.symbol ||= s.symbol; w.name ||= s.name; }
      const ageMin = w.createdAt ? (now - w.createdAt) / 60_000 : s?.pairCreatedAt ? (now - s.pairCreatedAt) / 60_000 : (now - w.migratedAt) / 60_000;
      if (ageMin < sc.minAgeMin - 10 || ageMin > sc.maxAgeMin) continue;
      if (!s || s.mcUsd < sc.supportMinMcUsd * 0.6 || s.mcUsd > sc.supportMaxMcUsd * 1.6 || s.liqUsd < sc.minLiqUsd * 0.5) continue;
      if (now - w.lastScanAt < 3 * 60_000) continue;
      due.push([w, ageMin]);
    }
    // stay well inside the free chart API limit: at most 6 coins per pass
    for (const [w, ageMin] of due.sort((a, b) => a[0].lastScanAt - b[0].lastScanAt).slice(0, 6)) {
      w.lastScanAt = now;
      let g;
      try { g = await this.candles.geckoCandles(w.mint, '5m'); } catch (e) { this.log.warn(`strategy migrated ${w.symbol}: ${e.message}`); continue; }
      if (!g.candles.length || !g.pool?.priceUsd) continue;
      const supply = g.pool.mcUsd && g.pool.priceUsd ? g.pool.mcUsd / g.pool.priceUsd : 1e9;
      const ctx = { now, supply, ageMin, ageBasis: w.createdAt ? 'since launch' : 'since the pool opened',
        mcUsd: g.pool.mcUsd ?? w.snap?.mcUsd, liqUsd: g.pool.liqUsd ?? w.snap?.liqUsd ?? null,
        candles: g.candles.map((c) => ({ ...c, o: c.o * supply, h: c.h * supply, l: c.l * supply, c: c.c * supply })),
        safety: null, mint: w.mint, symbol: w.symbol, name: w.name };
      const ev = EVALUATORS.migrated(ctx, sc);
      await this.#handle('migrated', ctx, ev, { onCurve: false, liqUsd: ctx.liqUsd });
    }
  }

  /** Track one evaluation: open/advance/close the signal episode and enter when valid. */
  async #handle(setup, ctx, ev, market) {
    const key = `${setup}:${ctx.mint}`;
    const now = this.now();
    if ((this.cooldown.get(key) ?? 0) > now) return;
    let sig = this.active.get(key);
    if (ev.phase === 'idle' && !sig) return;
    this.lastEval.set(key, { at: now, setup, mint: ctx.mint, symbol: ctx.symbol, phase: ev.phase, conditions: ev.conditions });
    if (!sig) {
      if (ev.phase === 'rejected' && !this.#formingDespiteReject(ev)) return;
      sig = { id: `${key}:${now}`, setup, mint: ctx.mint, symbol: ctx.symbol, name: ctx.name ?? '', at: now, status: 'watch',
        regime: this.engine?.regime?.().state ?? null, history: [] };
      this.active.set(key, sig);
    }
    Object.assign(sig, { updatedAt: now, phase: ev.phase, conditions: ev.conditions, unconfirmed: ev.unconfirmed,
      entry: ev.entry, invalidation: ev.invalidation, target: ev.target, rewardRisk: ev.rewardRisk, mcUsd: ctx.mcUsd });
    if (ev.phase === 'rejected') {
      sig.status = 'rejected'; sig.reason = ev.rejectReason;
      this.#close(key, sig);
      return;
    }
    if (ev.phase === 'idle') {
      // the pattern fell apart before confirming
      sig.status = 'rejected'; sig.reason = 'Pattern broke down before confirmation: ' + (ev.unconfirmed.slice(0, 2).join('; ') || 'conditions changed');
      this.#close(key, sig);
      return;
    }
    if (ev.phase === 'watching') {
      if (!sig.saved || now - sig.saved > 60_000) { sig.saved = now; this.store.saveSignal(sig); }
      return;
    }
    // signal: every condition met
    sig.status = 'valid';
    sig.why = this.#explain(setup, ev);
    const skip = this.#entryBlock(setup, ctx.mint);
    if (skip) {
      sig.status = 'skipped'; sig.reason = skip;
      this.#close(key, sig);
      return;
    }
    try {
      const snap = { mint: ctx.mint, symbol: ctx.symbol, name: ctx.name ?? '', priceUsd: ctx.mcUsd / ctx.supply, mcUsd: ctx.mcUsd, supply: ctx.supply,
        onCurve: market.onCurve, vSol: market.vSol ?? (market.onCurve && this.engine.solUsd > 0 ? curveVSolFromMc(ctx.mcUsd / this.engine.solUsd) : null),
        liqUsd: market.liqUsd ?? null, source: market.onCurve ? 'live feed' : 'GeckoTerminal' };
      const sc = this.setups[setup];
      const pos = this.book.openPosition({ snap, budgetUsd: this.settings.perTradeUsd, origin: setup, idemKey: sig.id,
        risk: { stopPrice: ev.invalidation.priceUsd, tpPct: sc.targetPct, maxHoldMin: sc.maxHoldMin },
        meta: { signalId: sig.id, setup, regime: sig.regime, why: sig.why, conditions: ev.conditions, invalidation: ev.invalidation, target: ev.target, rewardRisk: ev.rewardRisk } });
      if (market.onCurve && this.feed && !this.feed.watched?.has(ctx.mint)) this.feed.watch?.(ctx.mint);
      sig.status = 'entered'; sig.positionId = pos.id;
      this.engine?.logEvent?.('EXECUTOR', { symbol: ctx.symbol, mint: ctx.mint }, `strategy ${SETUPS[setup].name}: paper entry at $${(ctx.mcUsd / 1000).toFixed(1)}K`, 'good');
    } catch (e) {
      sig.status = 'skipped'; sig.reason = `Entry failed: ${e.message}`;
    }
    this.#close(key, sig);
  }

  #formingDespiteReject(ev) {
    // count a rejection only when the price pattern itself was there (so "rejected" means something)
    const patternKeys = ['pullback', 'run', 'high', 'reputation'];
    return ev.conditions.some((c) => patternKeys.includes(c.key) && c.ok === true);
  }

  #entryBlock(setup, mint) {
    if (!this.settings.enabled) return 'Strategy paper trading is switched off';
    const open = [...this.book.open.values()];
    if (open.some((p) => p.mint === mint)) return 'Already holding this coin in the strategy book';
    if (open.length >= this.settings.maxOpen) return `Max ${this.settings.maxOpen} open strategy positions`;
    if (open.filter((p) => p.origin === setup).length >= this.settings.maxOpenPerSetup) return `Max ${this.settings.maxOpenPerSetup} open positions for this setup`;
    const b = this.budget();
    if (b.leftUsd < this.settings.perTradeUsd) return `Daily strategy budget used ($${b.spentUsd.toFixed(0)} of $${b.dailyUsd})`;
    return null;
  }

  #explain(setup, ev) {
    const s = SETUPS[setup];
    return `${s.family} · ${s.name}: ${ev.conditions.filter((c) => c.ok).map((c) => c.detail || c.label).slice(0, 4).join('; ')}. ` +
      `Invalid below $${(ev.invalidation.mcUsd / 1000).toFixed(1)}K (${ev.invalidation.why}); target +${ev.target.pct}%` +
      `${ev.rewardRisk ? ` (${ev.rewardRisk.toFixed(1)}:1 reward to risk on paper)` : ''}.`;
  }

  #close(key, sig) {
    this.store.saveSignal(sig);
    this.active.delete(key);
    this.cooldown.set(key, this.now() + COOLDOWN_MS);
    if (this.cooldown.size > 5000) for (const [k, t] of this.cooldown) if (t < this.now()) this.cooldown.delete(k);
  }

  #expire(now) {
    for (const [key, sig] of this.active) {
      if (now - (sig.updatedAt ?? sig.at) > 10 * 60_000) { sig.status = 'rejected'; sig.reason = 'Stopped forming (no update for 10 min)'; this.#close(key, sig); }
    }
  }

  /** Prices for positions in coins the live feed no longer covers (graduated coins). */
  async pollPrices() {
    const mints = [...this.book.open.values()].filter((p) => !(p.source === 'live feed' && this.now() - p.lastAt < 30_000)).map((p) => p.mint);
    if (mints.length) {
      const snaps = await dexSnapshots(mints, { fetchFn: this.fetchFn });
      for (const [mint, s] of snaps) this.book.updatePrice(mint, { priceUsd: s.priceUsd, mcUsd: s.mcUsd, liqUsd: s.liqUsd, onCurve: s.onCurve, source: 'DexScreener' });
    }
    this.book.tick();
  }

  start(health) {
    health.job('Strategy: curve setups scan', () => this.scan(), 5_000);
    health.job('Strategy: migrated coins scan', () => this.scanMigrated(), 60_000);
    health.job('Strategy positions: prices + exits', () => this.pollPrices(), 10_000);
  }

  sellManually(id, pct, requestId) {
    const pos = this.book.open.get(String(id));
    if (!pos) throw new Error('Position not found (it may already be closed)');
    const r = this.book.sell(id, pct, { reason: `Manual override: sold ${pct}%`, idemKey: requestId ? `strategy:${id}:${requestId}` : null });
    return this.book.view(r.position);
  }

  // ---------------------------------------------------------------- views
  /** Per-setup performance from this book only (never mixed with System A or manual trades). */
  performance() {
    const closed = this.book.closedViews(2000);
    const counts = this.store.signalCounts(0);
    const bySetup = {};
    for (const id of Object.keys(SETUPS)) {
      const c = (st) => counts.filter((r) => r.setup === id && (!st || st.includes(r.status))).reduce((s, r) => s + r.n, 0);
      const trades = closed.filter((t) => t.origin === id);
      const byRegime = {};
      for (const t of trades) { const k = t.meta?.regime ?? 'unknown'; (byRegime[k] ??= []).push(t); }
      bySetup[id] = {
        id, family: SETUPS[id].family, name: SETUPS[id].name, enabled: this.setups[id].enabled,
        detected: c(null), valid: c(['valid', 'entered', 'skipped']), rejected: c(['rejected']), skipped: c(['skipped']), entered: c(['entered']),
        open: [...this.book.open.values()].filter((p) => p.origin === id).length,
        ...tradeStats(trades),
        byRegime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, tradeStats(v)])),
      };
    }
    return { bySetup, all: tradeStats(closed) };
  }

  view() {
    const open = this.book.openViews();
    const closed = this.book.closedViews(100);
    const watching = [...this.active.values()].map((s) => ({ ...s, history: undefined }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      settings: this.settings, budget: this.budget(), config: this.configView(),
      open, closed: closed.slice(0, 60), watching, signals: this.store.recentSignals(80),
      performance: this.performance(), migratedWatching: this.migratedWatch.size,
      summary: this.book.summary(closed, open),
    };
  }
}
