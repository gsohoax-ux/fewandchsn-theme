// Paper trading: the bot pretends to buy every alert with fake money and manages each position
// with risk rules (stop loss, trailing stop, max hold time). Nothing touches a wallet.
//
// Fills are deliberately pessimistic so the results are honest:
//   - price impact from the real bonding-curve math (bigger buys move the price more)
//   - Pump.fun trading fee on every buy and sell
//   - a network/priority fee per transaction
//   - extra slippage for the delay between alert and fill (bots buy before you)
import { quoteBuy, quoteSell } from './coin.js';

export class PaperTrader {
  constructor({ cfg, store, log = console, onEvent = () => {} }) {
    Object.assign(this, { cfg, store, log, onEvent });
    this.positions = new Map(); // mint -> position
    const saved = store.getKv('paper');
    if (saved && saved.startSol === cfg.paperStartSol) {
      this.cash = saved.cash;
      this.equityHist = saved.equityHist ?? [];
      // Positions from before a restart can't be followed any more: close them at their last value
      for (const p of saved.positions ?? []) this.#record(p, p.lastValue ?? 0, 'closed by restart', Date.now(), p.lastMc ?? p.entryMc);
    } else {
      this.cash = cfg.paperStartSol;
      this.equityHist = [];
    }
    this.startSol = cfg.paperStartSol;
    this.lastSnap = 0;
  }

  get enabled() { return this.cfg.paper; }

  /** Fees and slippage applied to a quote. */
  #buyFill(coin, sol) {
    const c = this.cfg;
    const solIn = Math.max(0, sol - c.paperTxFeeSol) * (1 - c.paperFeePct / 100);
    const tokens = coin.migrated ? solIn / (coin.mcSol / 1e9) * 0.98 : quoteBuy(coin.vSol, coin.vTokens, solIn);
    return tokens * (1 - c.paperSlippagePct / 100);
  }

  /** What selling the whole position would return right now, after fees and slippage. */
  valueOf(pos, coin) {
    const c = this.cfg;
    const raw = coin && !coin.migrated
      ? quoteSell(coin.vSol, coin.vTokens, pos.tokens)
      : pos.tokens * ((coin?.mcSol ?? pos.lastMc ?? pos.entryMc) / 1e9) * 0.98;
    return Math.max(0, raw * (1 - c.paperFeePct / 100) * (1 - c.paperSlippagePct / 100) - c.paperTxFeeSol);
  }

  equity(coins) {
    let eq = this.cash;
    for (const p of this.positions.values()) eq += this.valueOf(p, coins.get(p.mint));
    return eq;
  }

  /** Buy on an alert. */
  open(coin, { stage, score }, coins, now = Date.now()) {
    if (!this.enabled || this.positions.has(coin.mint) || coin.migrated) return null;
    if (this.positions.size >= this.cfg.paperMaxOpen) return this.#skip(coin, `max ${this.cfg.paperMaxOpen} open positions`);
    const size = Math.min(this.cash, this.equity(coins) * (this.cfg.paperSizePct / 100));
    if (size < this.cfg.paperTxFeeSol * 5) return this.#skip(coin, 'not enough paper cash');
    const tokens = this.#buyFill(coin, size);
    if (!(tokens > 0)) return null;
    this.cash -= size;
    const pos = { mint: coin.mint, symbol: coin.symbol, name: coin.name, openedAt: now, costSol: size, tokens,
      entryMc: coin.mcSol, stage, score, peakValue: 0, lastValue: 0, lastMc: coin.mcSol, trailing: false };
    pos.peakValue = pos.lastValue = this.valueOf(pos, coin);
    this.positions.set(coin.mint, pos);
    this.onEvent('EXECUTOR', coin, `paper-bought ${size.toFixed(3)} SOL at MC ${coin.mcSol.toFixed(0)} SOL (${stage})`);
    this.#save(coins);
    return pos;
  }

  #skip(coin, why) { this.onEvent('EXECUTOR', coin, `skipped: ${why}`, 'muted'); return null; }

  /** Check the risk rules after every trade on a coin we hold. */
  onPrice(coin, coins, now = Date.now()) {
    const pos = this.positions.get(coin.mint);
    if (!pos) return;
    const c = this.cfg;
    const value = this.valueOf(pos, coin);
    pos.lastValue = value; pos.lastMc = coin.mcSol;
    pos.peakValue = Math.max(pos.peakValue, value);
    const pnl = value / pos.costSol - 1;
    const peakPnl = pos.peakValue / pos.costSol - 1;
    if (!pos.trailing && peakPnl >= c.paperTrailStartPct / 100) {
      pos.trailing = true;
      this.onEvent('RISK', coin, `trailing stop active after +${(peakPnl * 100).toFixed(0)}%`);
    }
    if (pnl <= -c.paperStopPct / 100) return this.close(pos, coin, coins, `stop loss ${(pnl * 100).toFixed(0)}%`, now);
    if (pos.trailing && value <= pos.peakValue * (1 - c.paperTrailPct / 100)) {
      return this.close(pos, coin, coins, `trailing stop ${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(0)}%`, now);
    }
  }

  /** Time stop, coins the bot stopped tracking, and the equity chart. */
  tick(coins, now = Date.now()) {
    for (const pos of [...this.positions.values()]) {
      const coin = coins.get(pos.mint);
      if (!coin) { this.close(pos, null, coins, 'coin stopped trading', now); continue; }
      if (now - pos.openedAt > this.cfg.paperMaxHoldMin * 60_000) {
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
      costSol: pos.costSol, proceedsSol: proceeds, why, stage: pos.stage, score: pos.score, entryMc: pos.entryMc, exitMc });
    if (why === 'closed by restart') this.cash += proceeds;
  }

  #save(coins) {
    const positions = [...this.positions.values()].map((p) => ({ ...p, lastValue: this.valueOf(p, coins?.get(p.mint)) }));
    this.store.setKv('paper', { startSol: this.startSol, cash: this.cash, equityHist: this.equityHist, positions });
  }

  view(coins, solUsd = 0) {
    const eq = this.equity(coins);
    const closed = this.store.paperTradesSince(0);
    const wins = closed.filter((t) => t.proceeds_sol > t.cost_sol);
    const pnls = closed.map((t) => t.proceeds_sol / t.cost_sol - 1);
    return {
      enabled: this.enabled, startSol: this.startSol, equitySol: eq, cashSol: this.cash, solUsd,
      pnlSol: eq - this.startSol, pnlPct: (eq / this.startSol - 1) * 100,
      trades: closed.length, winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
      best: pnls.length ? Math.max(...pnls) * 100 : 0, worst: pnls.length ? Math.min(...pnls) * 100 : 0,
      rules: { sizePct: this.cfg.paperSizePct, stopPct: this.cfg.paperStopPct, trailStartPct: this.cfg.paperTrailStartPct,
        trailPct: this.cfg.paperTrailPct, maxHoldMin: this.cfg.paperMaxHoldMin },
      open: [...this.positions.values()].map((p) => {
        const v = this.valueOf(p, coins.get(p.mint));
        return { mint: p.mint, symbol: p.symbol, costSol: p.costSol, valueSol: v, pnlPct: (v / p.costSol - 1) * 100,
          openedAt: p.openedAt, trailing: p.trailing };
      }),
      recent: this.store.paperTrades(15).map((t) => ({ symbol: t.symbol, mint: t.mint, why: t.why, closedAt: t.closed_at,
        pnlPct: (t.proceeds_sol / t.cost_sol - 1) * 100, pnlSol: t.proceeds_sol - t.cost_sol })),
      history: this.equityHist.slice(-720),
    };
  }
}
