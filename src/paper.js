// Paper trading: the bot pretends to buy every alert with fake money and manages each position
// with risk rules (stop loss, trailing stop, max hold time). Nothing touches a wallet.
//
// Fills are deliberately pessimistic so the results are honest:
//   - price impact from the real bonding-curve math (bigger buys move the price more)
//   - Pump.fun trading fee on every buy and sell
//   - a network/priority fee per transaction
//   - extra slippage for the delay between alert and fill (bots buy before you)
import { quoteBuy, quoteSell } from './coin.js';

/** Calendar day (YYYY-MM-DD) in the given time zone. */
export function dayKey(ms, tz = 'UTC') {
  const f = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  try { return f(tz); } catch { return f('UTC'); }
}

export class PaperTrader {
  constructor({ cfg, store, log = console, onEvent = () => {}, onNotify = async () => {}, getSolUsd = () => 0, getRegime = () => null,
    moonbagWorthy = () => false, fetchFn = fetch }) {
    Object.assign(this, { cfg, store, log, onEvent, onNotify, getSolUsd, getRegime, moonbagWorthy, fetchFn });
    // Moonbags: small leftovers kept after graduation on strong coins. They live OUTSIDE the daily
    // budget (moved out at their value, like a sale), so each day stays clean, and get their own results.
    const mb = store.getKv('moonbags') ?? {};
    this.moonbags = new Map((mb.open ?? []).map((m) => [m.mint, m]));
    this.moonbagLog = mb.closed ?? [];
    this.positions = new Map(); // mint -> position
    // Daily budget mode: a fresh $ budget every day (e.g. $30), with a low-balance warning
    this.daily = cfg.paperDailyUsd > 0;
    this.account = this.daily ? `daily:${cfg.paperDailyUsd}` : `sol:${cfg.paperStartSol}`;
    const saved = store.getKv('paper');
    const same = saved && (saved.account ? saved.account === this.account : !this.daily && saved.startSol === cfg.paperStartSol);
    if (same) {
      Object.assign(this, {
        cash: saved.cash, startSol: saved.startSol, equityHist: saved.equityHist ?? [], day: saved.day ?? null,
        dayOpenedAt: saved.dayOpenedAt ?? 0, lowAlerted: Boolean(saved.lowAlerted), days: saved.days ?? [],
      });
      // Positions from before a restart can't be followed any more: close them at their last value
      for (const p of saved.positions ?? []) this.#record(p, p.lastValue ?? 0, 'closed by restart', Date.now(), p.lastMc ?? p.entryMc);
    } else {
      Object.assign(this, {
        cash: this.daily ? 0 : cfg.paperStartSol, startSol: this.daily ? 0 : cfg.paperStartSol, equityHist: [],
        day: null, dayOpenedAt: 0, lowAlerted: false, days: [],
      });
    }
    this.lastSnap = 0;
  }

  /** Start a new day: close yesterday's positions, record the result, reload today's budget. */
  #rollover(coins, key, now) {
    const solUsd = this.getSolUsd();
    if (!(solUsd > 0)) return; // need the SOL price to turn $ into SOL; try again shortly
    if (this.day) {
      for (const pos of [...this.positions.values()]) this.close(pos, coins.get(pos.mint), coins, 'end of day', now);
      const trades = this.store.paperTradesSince(this.dayOpenedAt).length;
      const endUsd = this.cash * solUsd;
      const startUsd = this.cfg.paperDailyUsd;
      this.days.unshift({ day: this.day, startUsd, endUsd, trades });
      this.days = this.days.slice(0, 365);
      const pct = (endUsd / startUsd - 1) * 100;
      const all = this.allTime(null, solUsd);
      this.onNotify(`📄 Paper day ${this.day}: $${startUsd.toFixed(2)} → $${endUsd.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) · ${trades} trade${trades === 1 ? '' : 's'}\n` +
        `All time: ${all.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(all.pnlUsd).toFixed(2)} over ${all.days} day${all.days === 1 ? '' : 's'} · ${all.greenDays} green / ${all.redDays} red · win rate ${all.winRate}%`);
    }
    this.day = key;
    this.dayOpenedAt = now;
    this.cash = this.startSol = this.cfg.paperDailyUsd / solUsd;
    this.lowAlerted = false;
    this.equityHist = [[now, +this.cash.toFixed(4)]];
    this.onEvent('EXECUTOR', null, `new day ${key}: paper budget $${this.cfg.paperDailyUsd} (${this.cash.toFixed(3)} SOL)`);
    this.#save(coins);
  }

  get enabled() { return this.cfg.paper; }

  /** Fee per side: Pump.fun fee + trading-app (terminal) fee. */
  get #feePct() { return this.cfg.paperFeePct + (this.cfg.paperTerminalFeePct ?? 0); }

  /** Fees, slippage and sandwich-bot losses applied to a buy. */
  #buyFill(coin, sol) {
    const c = this.cfg;
    const solIn = Math.max(0, sol - c.paperTxFeeSol) * (1 - this.#feePct / 100);
    const tokens = coin.migrated ? solIn / (coin.mcSol / 1e9) * 0.98 : quoteBuy(coin.vSol, coin.vTokens, solIn);
    return tokens * (1 - c.paperSlippagePct / 100) * (1 - (c.paperMevPct ?? 0) / 100);
  }

  /** SOL received for selling `tokens` now, after fees and slippage. */
  #sellValue(tokens, coin, fallbackMc) {
    const c = this.cfg;
    const raw = coin && !coin.migrated
      ? quoteSell(coin.vSol, coin.vTokens, tokens)
      : tokens * ((coin?.mcSol ?? fallbackMc) / 1e9) * 0.98;
    return Math.max(0, raw * (1 - this.#feePct / 100) * (1 - c.paperSlippagePct / 100) - c.paperTxFeeSol);
  }

  /** What selling the whole position would return right now, after fees and slippage. */
  valueOf(pos, coin) { return this.#sellValue(pos.tokens, coin, pos.lastMc ?? pos.entryMc); }

  equity(coins) {
    let eq = this.cash;
    for (const p of this.positions.values()) eq += this.valueOf(p, coins.get(p.mint));
    return eq;
  }

  /** Buy on an alert. */
  open(coin, { stage, score, deployTool = null, vamp = false, runner = false }, coins, now = Date.now()) {
    if (!this.enabled || this.positions.has(coin.mint) || coin.migrated) return null;
    if (this.daily && !this.day) return this.#skip(coin, 'waiting for the SOL price to load today\'s budget');
    if (this.daily && this.cfg.paperStopAtLow && this.lowAlerted) return this.#skip(coin, `budget under $${this.cfg.paperLowUsd} - done for today`);
    if (this.positions.size >= this.cfg.paperMaxOpen) return this.#skip(coin, `max ${this.cfg.paperMaxOpen} open positions`);
    let size = Math.min(this.cash, this.equity(coins) * (this.cfg.paperSizePct / 100));
    // Network fees are fixed per trade: if the normal size is too small, use the smallest size that
    // keeps them under the limit (when there's enough cash) instead of skipping the trade
    if (this.cfg.paperMaxFixedCostPct) {
      const minTicket = (2 * this.cfg.paperTxFeeSol) / (this.cfg.paperMaxFixedCostPct / 100);
      if (size < minTicket && this.cash >= minTicket) size = minTicket;
    }
    if (size < this.cfg.paperTxFeeSol * 5) return this.#skip(coin, 'not enough paper cash');
    // Network fees are fixed per transaction: on tiny trades they eat the edge, so skip those
    const fixedPct = ((2 * this.cfg.paperTxFeeSol) / size) * 100;
    if (this.cfg.paperMaxFixedCostPct && fixedPct > this.cfg.paperMaxFixedCostPct) {
      return this.#skip(coin, `trade too small: network fees would be ${fixedPct.toFixed(0)}% of it`);
    }
    const tokens = this.#buyFill(coin, size);
    if (!(tokens > 0)) return null;
    this.cash -= size;
    const pos = { mint: coin.mint, symbol: coin.symbol, name: coin.name, openedAt: now, costSol: size, tokens,
      entryMc: coin.mcSol, peakMc: coin.mcSol, lowMc: coin.mcSol, entryProgress: coin.progress, stage, score,
      regime: this.getRegime?.()?.rate ?? null, peakValue: 0, lastValue: 0, lastMc: coin.mcSol, trailing: false,
      halfTaken: false, migratedAt: null, deployTool, vamp, origTokens: tokens, runner };
    pos.peakValue = pos.lastValue = this.valueOf(pos, coin);
    pos.hurdle = 1 - pos.lastValue / size; // what the price must rise just to break even
    this.positions.set(coin.mint, pos);
    this.onEvent('EXECUTOR', coin, `paper-bought ${size.toFixed(3)} SOL at MC ${coin.mcSol.toFixed(0)} SOL (${stage})`);
    this.#save(coins);
    return pos;
  }

  #skip(coin, why) { this.onEvent('EXECUTOR', coin, `skipped: ${why}`, 'muted'); return null; }

  /** Check the risk rules after every trade on a coin we hold. */
  // (moonbags get prices via moonbagPrice / pollMoonbags)
  onPrice(coin, coins, now = Date.now()) {
    const pos = this.positions.get(coin.mint);
    if (!pos) return;
    const c = this.cfg;
    // Stops use the coin's PRICE (market cap), not the position value after costs: fees and slippage
    // already put a fresh position ~10-15% down, so a value-based stop would fire on normal noise.
    const mc = coin.mcSol;
    const value = this.valueOf(pos, coin);
    pos.lastValue = value; pos.lastMc = mc;
    pos.peakValue = Math.max(pos.peakValue, value);
    pos.peakMc = Math.max(pos.peakMc ?? mc, mc);
    pos.lowMc = Math.min(pos.lowMc ?? mc, mc);
    const move = mc / pos.entryMc - 1;
    const peakMove = pos.peakMc / pos.entryMc - 1;
    const net = () => { const p = this.valueOf(pos, coin) / pos.costSol - 1; return `${p >= 0 ? '+' : ''}${(p * 100).toFixed(0)}% net`; };

    if (!pos.trailing && peakMove >= c.paperTrailStartPct / 100) {
      pos.trailing = true;
      this.onEvent('RISK', coin, `trailing stop active after price +${(peakMove * 100).toFixed(0)}%`);
    }
    if (move <= -c.paperStopPct / 100) return this.close(pos, coin, coins, `stop loss: price ${(move * 100).toFixed(0)}% (${net()})`, now);
    const trail = pos.runner ? c.paperRunnerTrailPct ?? c.paperTrailPct : (coin.migrated ? c.paperTrailAfterGradPct : null) ?? c.paperTrailPct;
    if (pos.trailing && mc <= pos.peakMc * (1 - trail / 100)) {
      return this.close(pos, coin, coins, `trailing stop (${net()})`, now);
    }
    // Graduation is often the top: take half off as the curve nears completion
    if (c.paperGradTakePct && !pos.halfTaken && coin.progress >= c.paperGradTakePct) {
      const frac = pos.runner ? (c.paperRunnerTakePct ?? 25) / 100 : 0.5;
      this.#sellPart(pos, coin, coins, frac, `took ${frac === 0.5 ? 'half' : `${Math.round(frac * 100)}%`} at ${coin.progress.toFixed(0)}% of the curve${pos.runner ? ' (runner)' : ''}`, now);
    }
  }

  /** The coin graduated: take half now (if not done) and sell the rest a few minutes later. */
  onMigrate(coin, coins, now = Date.now()) {
    const pos = this.positions.get(coin.mint);
    if (!pos || pos.migratedAt) return;
    pos.migratedAt = now;
    if (this.cfg.paperGradTakePct && !pos.halfTaken) this.#sellPart(pos, coin, coins, 0.5, 'took half at graduation', now);
  }

  #sellPart(pos, coin, coins, frac, why, now) {
    const tokens = pos.tokens * frac;
    const proceeds = this.#sellValue(tokens, coin, pos.lastMc ?? pos.entryMc);
    const cost = pos.costSol * frac;
    pos.tokens -= tokens; pos.costSol -= cost; pos.halfTaken = true;
    this.cash += proceeds;
    this.#record({ ...pos, costSol: cost }, proceeds, why, now, coin?.mcSol ?? pos.lastMc);
    const p = proceeds / cost - 1;
    this.onEvent('RISK', coin ?? pos, `${why} (${p >= 0 ? '+' : ''}${(p * 100).toFixed(1)}%)`, p >= 0 ? 'good' : 'bad');
    this.#save(coins);
  }

  /** Time stop, coins the bot stopped tracking, and the equity chart. */
  tick(coins, now = Date.now()) {
    if (this.daily) {
      const key = dayKey(now, this.cfg.paperTz);
      if (key !== this.day) this.#rollover(coins, key, now);
      // Warn once a day when the balance drops under the low mark
      const solUsd = this.getSolUsd();
      if (this.day && !this.lowAlerted && solUsd > 0) {
        const eqUsd = this.equity(coins) * solUsd;
        if (eqUsd < this.cfg.paperLowUsd) {
          this.lowAlerted = true;
          const msg = `⚠️ Paper budget low: $${eqUsd.toFixed(2)} left of today's $${this.cfg.paperDailyUsd}` +
            (this.cfg.paperStopAtLow ? ' - no more paper buys today' : '');
          this.onEvent('RISK', null, msg, 'bad');
          this.onNotify(msg);
          this.#save(coins);
        }
      }
    }
    for (const pos of [...this.positions.values()]) {
      const coin = coins.get(pos.mint);
      if (!coin) { this.close(pos, null, coins, 'coin stopped trading', now); continue; }
      const c = this.cfg;
      if (pos.migratedAt && c.paperGradExitMin != null && now - pos.migratedAt >= c.paperGradExitMin * 60_000) {
        if (c.paperMoonbagPct > 0 && !this.moonbags.has(pos.mint) && (pos.runner || this.moonbagWorthy(pos.mint))) this.#toMoonbag(pos, coin, coins, now);
        else this.close(pos, coin, coins, `sold ${c.paperGradExitMin} min after graduation`, now);
        continue;
      }
      // No follow-through: most coins die fast, so don't wait the full hold time on a dud
      if (c.paperStallMin && !pos.runner && !pos.trailing && now - pos.openedAt >= c.paperStallMin * 60_000 &&
          (pos.peakMc ?? pos.entryMc) / pos.entryMc - 1 < (c.paperStallGainPct ?? 0) / 100) {
        this.close(pos, coin, coins, `no follow-through in ${c.paperStallMin} min`, now); continue;
      }
      if (now - pos.openedAt > (pos.runner ? c.paperRunnerMaxHoldMin ?? c.paperMaxHoldMin : c.paperMaxHoldMin) * 60_000) {
        const pnl = this.valueOf(pos, coin) / pos.costSol - 1;
        this.close(pos, coin, coins, `time stop ${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(0)}%`, now);
      }
    }
    if (now - this.lastSnap >= 60_000) {
      this.lastSnap = now;
      this.equityHist.push([now, +this.equity(coins).toFixed(4)]);
      if (this.equityHist.length > 2880) this.equityHist.splice(0, this.equityHist.length - 2880);
      this.#save(coins);
    }
  }

  /** Sell everything except a small slice; the slice leaves the daily account at its current value. */
  #toMoonbag(pos, coin, coins, now) {
    const keepPct = pos.runner ? this.cfg.paperRunnerMoonbagPct ?? this.cfg.paperMoonbagPct : this.cfg.paperMoonbagPct;
    const keepTokens = Math.min(pos.tokens, (pos.origTokens ?? pos.tokens) * (keepPct / 100));
    const frac = keepTokens / pos.tokens;
    if (frac < 1) this.#sellPart(pos, coin, coins, 1 - frac, `sold ${this.cfg.paperGradExitMin} min after graduation (moonbag kept)`, now);
    const value = this.valueOf(pos, coin);
    this.cash += value;                                       // moved out of today's account at its value
    this.positions.delete(pos.mint);
    this.#record(pos, value, 'kept as moonbag', now, coin?.mcSol ?? pos.lastMc);
    const mcNow = coin?.mcSol ?? pos.lastMc;
    this.moonbags.set(pos.mint, { mint: pos.mint, symbol: pos.symbol, tokens: pos.tokens, baseValue: value, baseMc: mcNow,
      peakMc: mcNow, lastMc: mcNow, since: now, lastPriceAt: now });
    this.onEvent('RISK', coin ?? pos, `🌙 kept ${this.cfg.paperMoonbagPct}% as a moonbag (worth ${value.toFixed(4)} SOL)`, 'good');
    this.#saveMoonbags();
    this.#save(coins);
  }

  /** A coin we already hold turned out to be a runner: give it runner exits from now on. */
  markRunner(mint) {
    const pos = this.positions.get(mint);
    if (pos && !pos.runner) { pos.runner = true; this.onEvent('RISK', pos, '🚀 runner: wider trail, bigger moonbag, longer hold'); }
  }

  /** Moonbag price update (from DexScreener, or the live feed while the bot still tracks the coin). */
  moonbagPrice(mint, mcSol, now = Date.now()) {
    const m = this.moonbags.get(mint);
    if (!m || !(mcSol > 0)) return;
    m.lastMc = mcSol; m.lastPriceAt = now; m.peakMc = Math.max(m.peakMc, mcSol);
    if (mcSol <= m.peakMc * (1 - this.cfg.paperMoonbagTrailPct / 100)) this.#closeMoonbag(m, `moonbag trailing stop`, now);
  }

  #moonbagValue(m) {
    const c = this.cfg;
    const raw = m.tokens * (m.lastMc / 1e9) * 0.98;
    return Math.max(0, raw * (1 - this.#feePct / 100) * (1 - c.paperSlippagePct / 100) - c.paperTxFeeSol);
  }

  #closeMoonbag(m, why, now = Date.now()) {
    const proceeds = this.#moonbagValue(m);
    this.moonbags.delete(m.mint);
    const solUsd = this.getSolUsd();
    this.moonbagLog.unshift({ mint: m.mint, symbol: m.symbol, baseValue: m.baseValue, proceeds, why, since: m.since, closedAt: now,
      pnlUsd: (proceeds - m.baseValue) * (solUsd || 0), mult: m.baseValue ? proceeds / m.baseValue : 0 });
    this.moonbagLog = this.moonbagLog.slice(0, 500);
    const pct = m.baseValue ? (proceeds / m.baseValue - 1) * 100 : 0;
    this.onEvent('RISK', m, `🌙 moonbag sold: ${why} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% since graduation)`, pct >= 0 ? 'good' : 'bad');
    this.#saveMoonbags();
  }

  /** Price moonbags from DexScreener (works after the bot stops tracking the coin, and across restarts). */
  async pollMoonbags(now = Date.now()) {
    const solUsd = this.getSolUsd();
    for (const m of [...this.moonbags.values()]) {
      if (now - m.since > this.cfg.paperMoonbagMaxHours * 3600_000) { this.#closeMoonbag(m, `moonbag time limit (${this.cfg.paperMoonbagMaxHours}h)`, now); continue; }
      if (!(solUsd > 0)) continue;
      try {
        const res = await this.fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${m.mint}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const j = await res.json();
        const pairs = (Array.isArray(j) ? j : j.pairs ?? []).filter((x) => x.chainId === 'solana' || !x.chainId);
        const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        const mcUsd = best?.marketCap ?? best?.fdv;
        if (mcUsd > 0) this.moonbagPrice(m.mint, mcUsd / solUsd, now);
        // A coin whose liquidity is gone is dead: close the moonbag at what's left
        if (best && (best.liquidity?.usd ?? 1) < 500) this.#closeMoonbag(m, 'moonbag: liquidity gone', now);
      } catch { /* try again next time */ }
    }
    this.#saveMoonbags();
  }

  #saveMoonbags() { this.store.setKv('moonbags', { open: [...this.moonbags.values()], closed: this.moonbagLog }); }

  close(pos, coin, coins, why, now = Date.now()) {
    const proceeds = this.valueOf(pos, coin);
    this.cash += proceeds;
    this.positions.delete(pos.mint);
    this.#record(pos, proceeds, why, now, coin?.mcSol ?? pos.lastMc);
    const pnl = proceeds / pos.costSol - 1;
    this.onEvent('RISK', coin ?? pos, `sold: ${why} (${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(1)}%)`, pnl >= 0 ? 'good' : 'bad');
    this.#save(coins);
  }

  #record(pos, proceeds, why, now, exitMc) {
    this.store.addPaperTrade({ mint: pos.mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: now,
      costSol: pos.costSol, proceedsSol: proceeds, why, stage: pos.stage, score: pos.score, entryMc: pos.entryMc, exitMc,
      entryProgress: pos.entryProgress ?? null, mfe: pos.peakMc ? pos.peakMc / pos.entryMc - 1 : null,
      mae: pos.lowMc ? pos.lowMc / pos.entryMc - 1 : null, hurdle: pos.hurdle ?? null, regime: pos.regime ?? null,
      deployTool: pos.deployTool ?? null, vamp: pos.vamp ? 1 : 0, runner: pos.runner ? 1 : 0 });
    if (why === 'closed by restart') this.cash += proceeds;
  }

  #save(coins) {
    const positions = [...this.positions.values()].map((p) => ({ ...p, lastValue: this.valueOf(p, coins?.get(p.mint)) }));
    this.store.setKv('paper', { account: this.account, startSol: this.startSol, cash: this.cash, equityHist: this.equityHist, positions,
      day: this.day, dayOpenedAt: this.dayOpenedAt, lowAlerted: this.lowAlerted, days: this.days });
  }

  /**
   * Progress across all days: the sum of every finished day's result plus today's so far.
   * (Each day gets a fresh budget, so the total is the sum of daily profits and losses.)
   */
  allTime(coins, solUsd = this.getSolUsd()) {
    const days = this.days.map((d) => ({ day: d.day, pnlUsd: d.endUsd - d.startUsd, trades: d.trades }));
    if (this.daily && this.day && solUsd > 0 && coins) {
      days.unshift({ day: this.day, pnlUsd: this.equity(coins) * solUsd - this.cfg.paperDailyUsd, trades: this.store.paperTradesSince(this.dayOpenedAt).length, today: true });
    }
    const closed = this.store.paperTradesSince(0).filter((t) => t.why !== 'closed by restart');
    const wins = closed.filter((t) => t.proceeds_sol > t.cost_sol).length;
    const done = days.filter((d) => !d.today);
    const series = [...days].reverse();
    let run = 0;
    return {
      days: days.length, pnlUsd: days.reduce((a, d) => a + d.pnlUsd, 0) + this.moonbagLog.reduce((a, m) => a + (m.pnlUsd ?? 0), 0),
      moonbagPnlUsd: this.moonbagLog.reduce((a, m) => a + (m.pnlUsd ?? 0), 0),
      greenDays: done.filter((d) => d.pnlUsd > 0).length, redDays: done.filter((d) => d.pnlUsd < 0).length,
      trades: closed.length, winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
      best: done.length ? Math.max(...done.map((d) => d.pnlUsd)) : 0, worst: done.length ? Math.min(...done.map((d) => d.pnlUsd)) : 0,
      avgDay: done.length ? done.reduce((a, d) => a + d.pnlUsd, 0) / done.length : 0,
      series: series.slice(-60).map((d) => ({ day: d.day, pnlUsd: d.pnlUsd, total: (run += d.pnlUsd), today: Boolean(d.today) })),
    };
  }

  /** Wins vs losses, counting each position once (its partial sells added together). */
  winLoss(sinceMs = 0) {
    const byPos = new Map();
    for (const t of this.store.paperTradesSince(sinceMs)) {
      if (t.why === 'closed by restart') continue;
      const k = `${t.mint}:${t.opened_at}`;
      const g = byPos.get(k) ?? { symbol: t.symbol, cost: 0, proceeds: 0 };
      g.cost += t.cost_sol; g.proceeds += t.proceeds_sol;
      byPos.set(k, g);
    }
    // a moonbag's later result belongs to the same position
    for (const m of this.moonbagLog) {
      if (m.closedAt < sinceMs) continue;
      for (const [k, g] of byPos) if (k.startsWith(`${m.mint}:`)) { g.proceeds += m.proceeds - m.baseValue; break; }
    }
    // only finished positions count: still open (part sold) or still holding a moonbag = not decided yet
    for (const k of [...byPos.keys()]) {
      const [mint, opened] = [k.slice(0, k.lastIndexOf(':')), Number(k.slice(k.lastIndexOf(':') + 1))];
      if (this.positions.get(mint)?.openedAt === opened || this.moonbags.has(mint)) byPos.delete(k);
    }
    const res = [...byPos.values()].map((g) => ({ symbol: g.symbol, pct: (g.proceeds / g.cost - 1) * 100, sol: g.proceeds - g.cost }));
    const wins = res.filter((r) => r.sol > 0), losses = res.filter((r) => r.sol <= 0);
    const avg = (a) => (a.length ? a.reduce((s, r) => s + r.pct, 0) / a.length : 0);
    const wonSol = wins.reduce((s, r) => s + r.sol, 0), lostSol = -losses.reduce((s, r) => s + r.sol, 0);
    return {
      wins: wins.length, losses: losses.length, winRate: res.length ? Math.round((wins.length / res.length) * 100) : 0,
      avgWinPct: avg(wins), avgLossPct: avg(losses),
      bestPct: res.length ? Math.max(...res.map((r) => r.pct)) : 0, worstPct: res.length ? Math.min(...res.map((r) => r.pct)) : 0,
      profitFactor: lostSol > 0 ? wonSol / lostSol : wins.length ? null : 0,
    };
  }

  /** All-time results grouped by when we bought (stage and curve %), so the data shows what works. */
  #byStage() {
    const groups = new Map();
    for (const t of this.store.paperTradesSince(0)) {
      if (t.why === 'closed by restart') continue;
      const bucket = t.entry_progress == null ? '' : t.entry_progress < 20 ? ' · curve <20%' : t.entry_progress < 50 ? ' · curve 20-50%' : ' · curve 50%+';
      const key = `${t.stage ?? '?'}${bucket}`;
      const g = groups.get(key) ?? { key, n: 0, wins: 0, cost: 0, proceeds: 0 };
      g.n++; g.cost += t.cost_sol; g.proceeds += t.proceeds_sol; if (t.proceeds_sol > t.cost_sol) g.wins++;
      groups.set(key, g);
    }
    // Extra rows: quick-deploy coins and copies vs the rest
    for (const t of this.store.paperTradesSince(0)) {
      if (t.why === 'closed by restart') continue;
      for (const [key, hit] of [['🚀 quick-deploy coins', Boolean(t.deploy_tool)], ['🪞 copies of other coins', Boolean(t.vamp)], ['🏃 runner trades', Boolean(t.runner)]]) {
        if (!hit) continue;
        const g = groups.get(key) ?? { key, n: 0, wins: 0, cost: 0, proceeds: 0 };
        g.n++; g.cost += t.cost_sol; g.proceeds += t.proceeds_sol; if (t.proceeds_sol > t.cost_sol) g.wins++;
        groups.set(key, g);
      }
    }
    return [...groups.values()].sort((a, b) => b.n - a.n)
      .map((g) => ({ key: g.key, trades: g.n, winRate: Math.round((g.wins / g.n) * 100), netPct: (g.proceeds / g.cost - 1) * 100 }));
  }

  view(coins, solUsd = 0) {
    const eq = this.equity(coins);
    const closed = this.store.paperTradesSince(this.daily ? this.dayOpenedAt || Date.now() : 0);
    const wins = closed.filter((t) => t.proceeds_sol > t.cost_sol);
    const pnls = closed.map((t) => t.proceeds_sol / t.cost_sol - 1);
    return {
      enabled: this.enabled, startSol: this.startSol || 1e-9, ready: !this.daily || Boolean(this.day),
      daily: this.daily ? { budgetUsd: this.cfg.paperDailyUsd, lowUsd: this.cfg.paperLowUsd, day: this.day, lowHit: this.lowAlerted,
        stopAtLow: this.cfg.paperStopAtLow, days: this.days.slice(0, 14) } : null, equitySol: eq, cashSol: this.cash, solUsd,
      pnlSol: eq - this.startSol, pnlPct: (eq / this.startSol - 1) * 100,
      trades: closed.length, winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
      best: pnls.length ? Math.max(...pnls) * 100 : 0, worst: pnls.length ? Math.min(...pnls) * 100 : 0,
      rules: { sizePct: this.cfg.paperSizePct, maxOpen: this.cfg.paperMaxOpen, stopPct: this.cfg.paperStopPct,
        trailStartPct: this.cfg.paperTrailStartPct, trailPct: this.cfg.paperTrailPct, maxHoldMin: this.cfg.paperMaxHoldMin,
        gradTakePct: this.cfg.paperGradTakePct, gradExitMin: this.cfg.paperGradExitMin, stallMin: this.cfg.paperStallMin,
        stallGainPct: this.cfg.paperStallGainPct, feePct: this.#feePct },
      byStage: this.#byStage(),
      allTime: this.daily ? this.allTime(coins, solUsd) : null,
      winLoss: { today: this.winLoss(this.daily ? this.dayOpenedAt || Date.now() : 0), allTime: this.winLoss(0) },
      moonbags: {
        enabled: this.cfg.paperMoonbagPct > 0, pct: this.cfg.paperMoonbagPct,
        open: [...this.moonbags.values()].map((m) => ({ mint: m.mint, symbol: m.symbol, valueSol: this.#moonbagValue(m),
          mult: m.baseValue ? this.#moonbagValue(m) / m.baseValue : 1, since: m.since })),
        closed: this.moonbagLog.slice(0, 5), count: this.moonbagLog.length,
        pnlUsd: this.moonbagLog.reduce((a, m) => a + (m.pnlUsd ?? 0), 0),
        winners: this.moonbagLog.filter((m) => m.proceeds > m.baseValue).length,
      },
      open: [...this.positions.values()].map((p) => {
        const v = this.valueOf(p, coins.get(p.mint));
        return { mint: p.mint, symbol: p.symbol, costSol: p.costSol, valueSol: v, pnlPct: (v / p.costSol - 1) * 100,
          openedAt: p.openedAt, trailing: p.trailing };
      }),
      recent: this.store.paperTrades(15).filter((t) => !this.daily || t.closed_at >= this.dayOpenedAt).map((t) => ({ symbol: t.symbol, mint: t.mint, why: t.why, closedAt: t.closed_at,
        pnlPct: (t.proceeds_sol / t.cost_sol - 1) * 100, pnlSol: t.proceeds_sol - t.cost_sol })),
      history: this.equityHist.slice(-720),
    };
  }
}
