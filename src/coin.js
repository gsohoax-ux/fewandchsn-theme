// Live state of one Pump.fun coin, built from the PumpPortal event stream.

export const TOTAL_SUPPLY = 1_000_000_000;      // every pump.fun token has 1B supply
const INITIAL_VIRTUAL_TOKENS = 1_073_000_000;    // virtual token reserves at launch
const CURVE_SELLABLE_TOKENS = 793_100_000;       // tokens sold before the curve completes
const MAX_TRADES_KEPT = 6000;

/** Bonding-curve progress in percent (0 = just launched, 100 = graduated). */
export function curveProgress(vTokensInBondingCurve) {
  if (!vTokensInBondingCurve) return 0;
  const p = ((INITIAL_VIRTUAL_TOKENS - vTokensInBondingCurve) / CURVE_SELLABLE_TOKENS) * 100;
  return Math.max(0, Math.min(100, p));
}

export const pctOfSupply = (tokens) => (tokens / TOTAL_SUPPLY) * 100;

/** Tokens received for `sol` SOL on the bonding curve (constant product on virtual reserves). */
export function quoteBuy(vSol, vTokens, sol) { return vTokens - (vSol * vTokens) / (vSol + sol); }
/** SOL received for selling `tokens` on the bonding curve. */
export function quoteSell(vSol, vTokens, tokens) { return vSol - (vSol * vTokens) / (vTokens + tokens); }

export class Coin {
  constructor(msg, now = Date.now()) {
    this.mint = msg.mint;
    this.name = msg.name ?? '';
    this.symbol = msg.symbol ?? '';
    this.uri = msg.uri ?? '';
    this.creator = msg.traderPublicKey;
    this.createSig = msg.signature;
    this.createdAt = now;
    this.initialBuyTokens = Number(msg.initialBuy ?? 0);
    this.initialBuySol = Number(msg.solAmount ?? 0);

    this.trades = [];              // {ts, sig, trader, side, sol, tokens, progress, mcSol}
    this.balances = new Map();     // wallet -> token balance (from trade events)
    this.firstBuyAt = new Map();   // wallet -> ts of first buy
    this.firstBuyTokens = new Map();
    this.buyers = new Set();
    this.tradeCount = 0;

    this.vTokens = Number(msg.vTokensInBondingCurve ?? INITIAL_VIRTUAL_TOKENS);
    this.vSol = Number(msg.vSolInBondingCurve ?? 30);
    this.mcSol = Number(msg.marketCapSol ?? 0);
    this.progress = curveProgress(this.vTokens);
    this.athMcSol = this.mcSol;
    this.startMcSol = this.mcSol;

    if (this.creator && this.initialBuyTokens > 0) {
      this.balances.set(this.creator, this.initialBuyTokens);
      this.firstBuyAt.set(this.creator, now);
      this.firstBuyTokens.set(this.creator, this.initialBuyTokens);
    }

    this.meta = null;              // {description, image, twitter, telegram, website}
    this.devSold = false;
    this.devSoldPct = 0;
    this.migrated = false;

    // evaluation state
    this.evaluating = false;
    this.lastEvalAt = 0;
    this.freshDone = false;
    this.midDone = false;
    this.finalDone = false;
    this.result = null;            // latest full evaluation
    this.alert = null;             // {stage, at, mcSol, score}
    this.peakMcSinceAlert = 0;
    this.warningsSent = new Set();
    this.samples = new Map();      // stage -> { at, mc, peak, done } for self-learning
  }

  applyTrade(msg, now = Date.now()) {
    const side = msg.txType === 'sell' ? 'sell' : 'buy';
    const trader = msg.traderPublicKey;
    const tokens = Number(msg.tokenAmount ?? 0);
    const sol = Number(msg.solAmount ?? 0);

    if (msg.vTokensInBondingCurve != null) {
      this.vTokens = Number(msg.vTokensInBondingCurve);
      this.progress = curveProgress(this.vTokens);
    }
    if (msg.vSolInBondingCurve != null) this.vSol = Number(msg.vSolInBondingCurve);
    if (msg.marketCapSol != null) this.mcSol = Number(msg.marketCapSol);
    this.athMcSol = Math.max(this.athMcSol, this.mcSol);
    if (this.alert) this.peakMcSinceAlert = Math.max(this.peakMcSinceAlert, this.mcSol);

    const prev = this.balances.get(trader) ?? 0;
    const next = msg.newTokenBalance != null
      ? Number(msg.newTokenBalance)
      : Math.max(0, prev + (side === 'buy' ? tokens : -tokens));
    this.balances.set(trader, next);

    if (side === 'buy') {
      this.buyers.add(trader);
      if (!this.firstBuyAt.has(trader)) {
        this.firstBuyAt.set(trader, now);
        this.firstBuyTokens.set(trader, tokens);
      }
    } else if (trader === this.creator) {
      this.devSold = true;
      const start = this.initialBuyTokens || 1;
      this.devSoldPct = Math.min(100, Math.max(0, (1 - next / start) * 100));
    }

    this.tradeCount++;
    this.trades.push({ ts: now, sig: msg.signature, trader, side, sol, tokens,
      progress: this.progress, mcSol: this.mcSol });
    if (this.trades.length > MAX_TRADES_KEPT) this.trades.splice(0, this.trades.length - MAX_TRADES_KEPT);
  }

  ageSec(now = Date.now()) { return (now - this.createdAt) / 1000; }

  holders() {
    return [...this.balances.entries()].filter(([, b]) => b > 1);
  }

  holderPct(wallet) { return pctOfSupply(this.balances.get(wallet) ?? 0); }

  devPct() { return this.holderPct(this.creator); }

  /** Percent of supply held by the top N wallets (bonding curve excluded). */
  topHoldersPct(n = 10) {
    const top = this.holders().map(([, b]) => b).sort((a, b) => b - a).slice(0, n);
    return pctOfSupply(top.reduce((a, b) => a + b, 0));
  }

  /** Buyers that are not the dev and did not buy in the launch moment (where bundles and snipers sit). */
  organicBuyerCount(launchWindowMs = 1500) {
    let n = 0;
    for (const [w, ts] of this.firstBuyAt) if (w !== this.creator && ts - this.createdAt > launchWindowMs) n++;
    return n;
  }

  /** The first N distinct buyers, in order (dev excluded). */
  earlyBuyers(n = 25) {
    return [...this.firstBuyAt.entries()]
      .filter(([w]) => w !== this.creator)
      .sort((a, b) => a[1] - b[1])
      .slice(0, n)
      .map(([w]) => w);
  }

  /** Market cap (SOL) at (or just before) a past timestamp. */
  mcAt(ts) {
    let mc = this.trades[0]?.mcSol ?? this.mcSol;
    for (const t of this.trades) { if (t.ts > ts) break; mc = t.mcSol; }
    return mc;
  }

  /** Progress value at (or just before) a past timestamp. */
  progressAt(ts) {
    let p = 0;
    for (const t of this.trades) { if (t.ts > ts) break; p = t.progress; }
    return p;
  }

  links(padreTemplate = '') {
    return {
      pump: `https://pump.fun/coin/${this.mint}`,
      dexscreener: `https://dexscreener.com/solana/${this.mint}`,
      padre: padreTemplate ? padreTemplate.replace('{mint}', this.mint) : '',
    };
  }
}
