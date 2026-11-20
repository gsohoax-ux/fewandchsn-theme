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
  constructor({ cfg, store, log = console, onEvent = () => {}, onNotify = async () => {}, getSolUsd = () => 0 }) {
    Object.assign(this, { cfg, store, log, onEvent, onNotify, getSolUsd });
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
      this.days = this.days.slice(0, 60);
      const pct = (endUsd / startUsd - 1) * 100;
      this.onNotify(`📄 Paper day ${this.day}: $${startUsd.toFixed(2)} → $${endUsd.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) · ${trades} trade${trades === 1 ? '' : 's'}`);
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
    if (this.daily && !this.day) return this.#skip(coin, 'waiting for the SOL price to load today\'s budget');
    if (this.daily && this.cfg.paperStopAtLow && this.lowAlerted) return this.#skip(coin, `budget under $${this.cfg.paperLowUsd} - done for today`);
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
    this.store.setKv('paper', { account: this.account, startSol: this.startSol, cash: this.cash, equityHist: this.equityHist, positions,
      day: this.day, dayOpenedAt: this.dayOpenedAt, lowAlerted: this.lowAlerted, days: this.days });
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
      rules: { sizePct: this.cfg.paperSizePct, stopPct: this.cfg.paperStopPct, trailStartPct: this.cfg.paperTrailStartPct,
        trailPct: this.cfg.paperTrailPct, maxHoldMin: this.cfg.paperMaxHoldMin },
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
