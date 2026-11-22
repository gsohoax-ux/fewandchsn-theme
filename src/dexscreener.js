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

/** Best Solana pair per mint (most liquidity), up to 30 mints per request. Returns Map mint -> snapshot. */
export function bestPairs(pairs, mints) {
  const want = new Set(mints);
  const out = new Map();
  for (const p of pairs ?? []) {
    const mint = p?.baseToken?.address;
    if (p?.chainId !== 'solana' || !want.has(mint) || !(Number(p.priceUsd) > 0)) continue;
    const prev = out.get(mint);
    if (prev && (prev.liqUsd ?? 0) >= (p.liquidity?.usd ?? 0)) continue;
    const priceUsd = Number(p.priceUsd), mcUsd = p.marketCap ?? p.fdv ?? 0;
    out.set(mint, {
      mint, symbol: p.baseToken?.symbol ?? '', name: p.baseToken?.name ?? '', priceUsd, mcUsd,
      supply: mcUsd && priceUsd ? mcUsd / priceUsd : 1e9, liqUsd: p.liquidity?.usd ?? 0, dexId: p.dexId ?? '',
      onCurve: /pump\.?fun/i.test(p.dexId ?? '') && !/swap/i.test(p.dexId ?? ''), pairAddress: p.pairAddress ?? null,
      pairCreatedAt: p.pairCreatedAt ?? null, volume: p.volume ?? {}, txns: p.txns ?? {}, priceChange: p.priceChange ?? {},
      source: 'DexScreener',
    });
  }
  return out;
}

export async function dexSnapshots(mints, { fetchFn = fetch } = {}) {
  const out = new Map();
  const list = [...new Set(mints)];
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    for (const [k, v] of bestPairs((await res.json()).pairs, chunk)) out.set(k, v);
  }
  return out;
}
