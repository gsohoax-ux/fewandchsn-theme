// Free DexScreener check: did the dev pay for a DexScreener token profile or boost?
// Paying costs real money, so it shows some commitment (it is not a safety guarantee).
// Uses DexScreener's public API - no key needed. Results are cached to stay well under its rate limit.

const cache = new Map(); // mint -> { at, value }
const TTL_MS = 5 * 60_000;

/** Pure helper (tested): read the orders response, whatever shape it comes in. */
export function parseOrders(j) {
  const orders = Array.isArray(j) ? j : Array.isArray(j?.orders) ? j.orders : [];
  const paid = orders.filter((o) => ['approved', 'processing', 'on-hold'].includes(String(o?.status ?? '').toLowerCase()));
  return {
    paid: paid.length > 0,
    types: [...new Set(paid.map((o) => String(o.type ?? '')).filter(Boolean))],
    boosts: Array.isArray(j?.boosts) ? j.boosts.length : 0,
  };
}

export async function dexPaid(mint, { fetchFn = fetch } = {}) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetchFn(`https://api.dexscreener.com/orders/v1/solana/${mint}`, { signal: AbortSignal.timeout(6000) });
  if (res.status === 404) { const v = { paid: false, types: [], boosts: 0 }; cache.set(mint, { at: Date.now(), value: v }); return v; }
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const value = parseOrders(await res.json());
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(mint, { at: Date.now(), value });
  return value;
}
