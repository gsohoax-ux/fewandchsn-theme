// Liquidity, slippage and cash-out math (constant-product pools and the Pump.fun bonding curve).
//
// - Liquidity vs market cap: a coin can show a big market cap with almost nothing in the pool.
// - Slippage: how much YOUR order moves the price, given the pool's depth.
// - Cash-out: paper gains are only real if the pool can absorb the sale. Selling a position worth V
//   into a pool with R on the SOL/USD side returns about V * R / (R + V).

const VIRTUAL_K = 30 * 1_073_000_000; // Pump.fun curve: vSol * vTokens at launch

/** SOL in the curve's virtual reserve, estimated from the market cap (mcSol = vSol^2 / 32.19). */
export const curveVSolFromMc = (mcSol) => Math.sqrt((VIRTUAL_K / 1e9) * mcSol);

/** A buy of `orderUsd` into a pool whose quote-side reserve is `depthUsd`. */
export function priceImpact(orderUsd, depthUsd) {
  if (!(depthUsd > 0)) return { avgPct: 100, movePct: 100 };
  const x = orderUsd / depthUsd;
  return { avgPct: x * 100, movePct: ((1 + x) ** 2 - 1) * 100 };
}

/** What selling a position worth `valueUsd` at the current price would actually bring in. */
export function cashOut(valueUsd, depthUsd) {
  if (!(depthUsd > 0)) return { getUsd: 0, lossPct: 100 };
  const got = (valueUsd * depthUsd) / (depthUsd + valueUsd);
  return { getUsd: got, lossPct: (1 - got / valueUsd) * 100 };
}

/**
 * Full read for one coin.
 * onCurve: still on the Pump.fun bonding curve. vSol: curve virtual SOL reserve (if known).
 * liqUsd: DexScreener liquidity (total pool value, both sides) for graduated coins.
 */
export function liquidityRead({ onCurve, vSol = null, liqUsd = 0, mcUsd = 0, solUsd = 0, orderUsd = 50, sizes = [30, 50, 100, 500] }) {
  let depthUsd, realLiqUsd;
  if (onCurve) {
    const v = vSol ?? (solUsd > 0 && mcUsd > 0 ? curveVSolFromMc(mcUsd / solUsd) : null);
    if (!v || !(solUsd > 0)) return null;
    depthUsd = v * solUsd;                         // the curve prices off its virtual reserve
    realLiqUsd = Math.max(0, v - 30) * solUsd;     // real SOL actually in the curve
  } else {
    if (!(liqUsd > 0)) return { onCurve, depthUsd: 0, realLiqUsd: 0, ratioPct: 0, level: 'bad', rows: [], order: priceImpact(orderUsd, 0), cash: cashOut(orderUsd * 5, 0), orderUsd };
    depthUsd = liqUsd / 2;                          // ~half the pool is the SOL side
    realLiqUsd = liqUsd;
  }
  const ratioPct = mcUsd > 0 ? (realLiqUsd / mcUsd) * 100 : null;
  const order = priceImpact(orderUsd, depthUsd);
  const rows = sizes.map((usd) => ({ usd, ...priceImpact(usd, depthUsd) }));
  // e.g. if a $50 position ran to $250 on paper, what would selling actually bring?
  const cash = cashOut(orderUsd * 5, depthUsd);
  let level = 'ok';
  if ((ratioPct != null && ratioPct < (onCurve ? 2 : 5)) || order.avgPct > 15 || realLiqUsd < 1000) level = 'bad';
  else if ((ratioPct != null && ratioPct < (onCurve ? 5 : 10)) || order.avgPct > 5 || cash.lossPct > 15) level = 'warn';
  return { onCurve, depthUsd, realLiqUsd, ratioPct, level, rows, order, cash, orderUsd };
}

/** Plain-language lines for alerts and checks. */
export function liquidityLines(L) {
  if (!L) return [];
  const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`);
  const lines = [];
  lines.push(`${L.onCurve ? 'Curve holds' : 'Pool liquidity'} ${usd(L.realLiqUsd)}${L.ratioPct != null ? ` = ${L.ratioPct.toFixed(1)}% of market cap` : ''}${L.level === 'bad' && L.ratioPct != null && L.ratioPct < (L.onCurve ? 2 : 5) ? ' (HIGH RISK: thin liquidity)' : ''}`);
  lines.push(`A $${L.orderUsd} buy pays ~${L.order.avgPct.toFixed(1)}% slippage and moves the price ~${L.order.movePct.toFixed(1)}%`);
  lines.push(`Cash-out check: if $${L.orderUsd} grew to $${L.orderUsd * 5} on paper, selling now would bring ~${usd(L.cash.getUsd)} (−${L.cash.lossPct.toFixed(0)}% to slippage)`);
  return lines;
}
