// On-chain lookups through Helius: transaction slots (to find same-block bundles)
// and wallet funding / age (to link bundle wallets that share a funder).

const LAMPORTS = 1e9;
const MIN_FUNDING_SOL = 0.05;
const WALLET_PAGE = 50;

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

class TtlCache {
  constructor(max = 5000, ttlMs = 30 * 60_000) { this.max = max; this.ttl = ttlMs; this.map = new Map(); }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() - e.t > this.ttl) { this.map.delete(k); return undefined; }
    return e.v;
  }
  set(k, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { v, t: Date.now() });
  }
}

export class HeliusChain {
  constructor({ rpcUrl, apiUrl, apiKey, concurrency = 4 }) {
    this.rpcUrl = rpcUrl;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.limit = limiter(concurrency);
    this.walletCache = new TtlCache(8000);
    this.serviceCache = new TtlCache(4000, 6 * 3600_000);
    this.enabled = Boolean(rpcUrl && apiKey);
  }

  async #fetchJson(url, init, attempt = 0) {
    return this.limit(async () => {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        return { retry: true };
      }
      if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
      return { data: await res.json() };
    }).then((r) => (r.retry ? this.#fetchJson(url, init, attempt + 1) : r.data));
  }

  async rpc(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const data = await this.#fetchJson(this.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
    return data.result;
  }

  /** Helius parsed ("enhanced") transactions for up to 100 signatures. */
  async parseTransactions(signatures) {
    if (!signatures.length) return [];
    const url = `${this.apiUrl}/v0/transactions?api-key=${this.apiKey}`;
    const out = await this.#fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: signatures.slice(0, 100) }) });
    return Array.isArray(out) ? out : [];
  }

  /** Map of signature -> slot for the token's recent transactions. */
  async getSignatureSlots(mint) {
    const sigs = await this.rpc('getSignaturesForAddress', [mint, { limit: 1000 }]);
    return new Map(sigs.map((s) => [s.signature, s.slot]));
  }

  /**
   * Who funded this wallet, and how old is it?
   * @param {number} buyTsSec unix seconds of the wallet's buy
   */
  async getWalletInfo(wallet, buyTsSec) {
    const cached = this.walletCache.get(wallet);
    if (cached) return cached;
    const url = `${this.apiUrl}/v0/addresses/${wallet}/transactions?api-key=${this.apiKey}&limit=${WALLET_PAGE}`;
    const txs = await this.#fetchJson(url, {});
    const info = summarizeWallet(wallet, Array.isArray(txs) ? txs : [], buyTsSec);
    this.walletCache.set(wallet, info);
    return info;
  }

  /** Busy addresses (exchanges, bridges, bots) fund thousands of wallets - not a bundle signal. */
  async isService(address) {
    const cached = this.serviceCache.get(address);
    if (cached !== undefined) return cached;
    const sigs = await this.rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    let busy = false;
    if (sigs.length >= 1000) {
      const span = (sigs[0].blockTime ?? 0) - (sigs[sigs.length - 1].blockTime ?? 0);
      busy = span < 6 * 3600;
    }
    this.serviceCache.set(address, busy);
    return busy;
  }
}

/** Pure helper (unit tested): derive funder / freshness from Helius enhanced transactions. */
export function summarizeWallet(wallet, txs, buyTsSec) {
  const full = txs.length >= WALLET_PAGE;
  const times = txs.map((t) => t.timestamp).filter(Boolean);
  const oldest = times.length ? Math.min(...times) : null;
  const inflows = [];
  for (const t of txs) {
    for (const n of t.nativeTransfers ?? []) {
      if (n.toUserAccount === wallet && n.fromUserAccount && n.fromUserAccount !== wallet &&
          n.amount >= MIN_FUNDING_SOL * LAMPORTS) {
        inflows.push({ from: n.fromUserAccount, sol: n.amount / LAMPORTS, ts: t.timestamp ?? 0 });
      }
    }
  }
  inflows.sort((a, b) => b.ts - a.ts);
  const beforeBuy = inflows.filter((f) => !buyTsSec || f.ts <= buyTsSec + 5);
  const funding = beforeBuy[0] ?? inflows[0] ?? null;
  const ageHours = oldest && buyTsSec ? (buyTsSec - oldest) / 3600 : null;
  return {
    funder: funding?.from ?? null,
    fundedSol: funding?.sol ?? 0,
    fundedAt: funding?.ts ?? null,
    txCount: full ? `${WALLET_PAGE}+` : txs.length,
    fresh: !full && ageHours !== null && ageHours < 24,
  };
}
