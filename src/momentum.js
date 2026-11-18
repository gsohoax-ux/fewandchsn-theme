// Momentum: is real money flowing in right now? (Not a prediction - a measurement.)

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const sat = (x, half) => x <= 0 ? 0 : x / (x + half); // 0..1, = 0.5 at x = half

export function analyzeMomentum(coin, now = Date.now(), smartWallets = new Set()) {
  const w2 = now - 120_000;
  const recent = coin.trades.filter((t) => t.ts >= w2);
  const buys = recent.filter((t) => t.side === 'buy');
  const sells = recent.filter((t) => t.side === 'sell');
  const buySol = buys.reduce((s, t) => s + t.sol, 0);
  const sellSol = sells.reduce((s, t) => s + t.sol, 0);
  const uniqueBuyers2m = new Set(buys.map((t) => t.trader)).size;
  const ratio = sellSol > 0 ? buySol / sellSol : buySol > 0 ? 5 : 0;

  const age = coin.ageSec(now);
  const windowMin = Math.min(2, Math.max(age / 60, 1)); // never extrapolate from < 1 min
  const progressPerMin = (coin.progress - coin.progressAt(now - windowMin * 60_000)) / windowMin;

  // Wash / bot volume: wallets that both bought and sold in the window
  const traders = new Map();
  for (const t of recent) {
    const e = traders.get(t.trader) ?? { b: 0, s: 0, vol: 0 };
    e[t.side === 'buy' ? 'b' : 's']++; e.vol += t.sol;
    traders.set(t.trader, e);
  }
  const totalVol = buySol + sellSol;
  const roundTripVol = [...traders.values()].filter((e) => e.b && e.s).reduce((s, e) => s + e.vol, 0);
  const washPct = totalVol ? (roundTripVol / totalVol) * 100 : 0;

  const smartHolders = [...smartWallets].filter((w) => (coin.balances.get(w) ?? 0) > 1);

  // Drawdown from the top - a coin 60% off its high is not "going up"
  const drawdownPct = coin.athMcSol ? (1 - coin.mcSol / coin.athMcSol) * 100 : 0;

  let score =
    35 * sat(progressPerMin, 6) +        // curve filling fast
    25 * sat(uniqueBuyers2m, 25) +       // lots of distinct buyers
    20 * clamp((ratio - 0.8) / 2.2, 0, 1) + // more buying than selling
    10 * sat(buySol - sellSol, 8) +      // net inflow in SOL
    10 * sat(coin.holders().length, 120); // holder base
  score += Math.min(15, smartHolders.length * 7);
  score -= Math.max(0, washPct - 30) * 0.5;
  score -= Math.max(0, drawdownPct - 25) * 0.6;

  return {
    score: Math.round(clamp(score)),
    progressPerMin, uniqueBuyers2m, buySellRatio: ratio, netInflowSol: buySol - sellSol,
    buys2m: buys.length, sells2m: sells.length, washPct, drawdownPct,
    holders: coin.holders().length, smartHolders,
  };
}
