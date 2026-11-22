// Turns a confirmed Solana transaction into what a followed wallet actually did with each token.
//
// Input: the result of RPC getTransaction(signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }).
// The decision uses only verified on-chain facts:
//   - meta.err                       → the transaction failed: nothing to copy
//   - pre/post token balances        → exact token amounts the wallet held before and after
//   - pre/post SOL balances (+ fee)  → SOL the wallet spent or received (wrapped SOL and USDC/USDT count as quote)
//   - programs that ran (incl. inner instructions and logs) → was a DEX involved at all?
//
// Rules:
//   token up   + quote down + DEX   → BUY   (ADD if the wallet already held the token)
//   token down + quote up   + DEX   → SELL  (EXIT if the wallet holds ~nothing after), sold % = (before − after) / before
//   token and quote moving the SAME way (+ DEX) → liquidity deposit/withdrawal → ignored
//   token moving with no DEX program → transfer in/out (airdrop, wallet move) → ignored
//   only SOL moving                  → wallet funding / unrelated → ignored
//   token A down + token B up, no quote (Jupiter route) → SELL A and BUY B

export const QUOTE_MINTS = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KConky1H3xuANx5L4Gxd: 'USDT',
};
const WSOL = 'So11111111111111111111111111111111111111112';

/** Programs that swap tokens. Trading bots and routers call these internally, which inner instructions reveal. */
export const DEX_PROGRAMS = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: 'Raydium LaunchLab',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora AMM',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'Meteora DBC',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: 'Moonshot',
};

const SOL_EPS = 0.0025;   // SOL moves smaller than this (fees, token-account rent) don't count as a trade
const STABLE_EPS = 0.5;   // USDC/USDT
const DUST = 1e-6;        // a holding below this share of the "before" balance counts as fully exited

const keyStr = (k) => (typeof k === 'string' ? k : k?.pubkey ?? '');
const amountOf = (b) => {
  const u = b?.uiTokenAmount ?? {};
  if (u.amount != null && u.decimals != null) return Number(u.amount) / 10 ** Number(u.decimals);
  return Number(u.uiAmountString ?? u.uiAmount ?? 0);
};

/** All programs that ran: top-level and inner instructions, plus "Program X invoke" log lines. */
export function programsOf(tx) {
  const set = new Set();
  const msg = tx?.transaction?.message ?? {};
  const keys = (msg.accountKeys ?? []).map(keyStr);
  const add = (ix) => { const id = ix?.programId ?? (ix?.programIdIndex != null ? keys[ix.programIdIndex] : null); if (id) set.add(String(id)); };
  for (const ix of msg.instructions ?? []) add(ix);
  for (const inner of tx?.meta?.innerInstructions ?? []) for (const ix of inner.instructions ?? []) add(ix);
  for (const line of tx?.meta?.logMessages ?? []) { const m = /^Program (\w{32,44}) invoke/.exec(line); if (m) set.add(m[1]); }
  return set;
}

/**
 * Classify one transaction for one wallet.
 * Returns { status: 'pending' | 'failed' | 'ok', signature, slot, blockTime, venue, solDelta, events: [...], ignored: [...] }
 * events: { kind: 'buy'|'add'|'sell'|'exit', mint, pre, post, delta, soldPct, quote: { sol, stable }, priceSol, priceStable }
 */
export function classifyTransaction(tx, wallet, signature = null) {
  const sig = signature ?? tx?.transaction?.signatures?.[0] ?? null;
  if (!tx || !tx.meta) return { status: 'pending', signature: sig, events: [], ignored: [] };
  const base = { signature: sig, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null, events: [], ignored: [] };
  if (tx.meta.err) return { ...base, status: 'failed', ignored: [{ kind: 'failed', reason: 'Transaction failed on-chain' }] };

  const msg = tx.transaction?.message ?? {};
  const keys = [...(msg.accountKeys ?? []).map(keyStr), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const wi = keys.indexOf(wallet);
  const fee = (tx.meta.fee ?? 0) / 1e9;
  let solDelta = wi >= 0 ? ((tx.meta.postBalances?.[wi] ?? 0) - (tx.meta.preBalances?.[wi] ?? 0)) / 1e9 : 0;
  if (wi === 0) solDelta += fee; // the fee is a cost of sending, not part of the trade

  // token balances owned by this wallet, summed per mint (a wallet can hold several accounts of one mint)
  const bal = new Map();
  const addBal = (list, which) => {
    for (const b of list ?? []) {
      if (b.owner !== wallet || !b.mint) continue;
      const e = bal.get(b.mint) ?? { pre: 0, post: 0, decimals: b.uiTokenAmount?.decimals ?? null };
      e[which] += amountOf(b);
      bal.set(b.mint, e);
    }
  };
  addBal(tx.meta.preTokenBalances, 'pre');
  addBal(tx.meta.postTokenBalances, 'post');

  let quoteSol = solDelta, quoteStable = 0;
  const tokens = [];
  for (const [mint, e] of bal) {
    const delta = e.post - e.pre;
    if (QUOTE_MINTS[mint]) { if (mint === WSOL) quoteSol += delta; else quoteStable += delta; continue; }
    if (Math.abs(delta) <= Math.max(e.pre, e.post) * 1e-12 || delta === 0) continue;
    tokens.push({ mint, pre: e.pre, post: e.post, delta, decimals: e.decimals });
  }
  const programs = programsOf(tx);
  const dexes = [...programs].map((p) => DEX_PROGRAMS[p]).filter(Boolean);
  const venue = [...new Set(dexes)].join(' + ') || null;
  const quoteDir = Math.abs(quoteSol) > SOL_EPS ? Math.sign(quoteSol) : Math.abs(quoteStable) > STABLE_EPS ? Math.sign(quoteStable) : 0;
  const out = { ...base, status: 'ok', venue, solDelta: quoteSol, stableDelta: quoteStable };

  if (!tokens.length) {
    if (quoteDir !== 0) out.ignored.push({ kind: 'funding', reason: dexes.length ? 'Only SOL/stablecoins moved (no token traded)' : 'SOL moved in or out of the wallet (funding / transfer), no trade' });
    return out;
  }
  if (!dexes.length) {
    for (const t of tokens) out.ignored.push({ kind: t.delta > 0 ? 'transfer_in' : 'transfer_out', mint: t.mint, pre: t.pre, post: t.post, delta: t.delta,
      reason: `Tokens ${t.delta > 0 ? 'received' : 'sent'} without any DEX program: a transfer, not a trade` });
    return out;
  }
  // liquidity: a token moving the same way as the quote (both into a pool, or both out of one)
  if (quoteDir !== 0 && tokens.some((t) => Math.sign(t.delta) === quoteDir)) {
    for (const t of tokens) out.ignored.push({ kind: 'liquidity', mint: t.mint, pre: t.pre, post: t.post, delta: t.delta,
      reason: quoteDir < 0 ? 'Tokens and SOL both went into a pool: liquidity deposit, not a buy' : 'Tokens and SOL both came out of a pool: liquidity withdrawal, not a sell' });
    return out;
  }
  if (quoteDir === 0) {
    const ups = tokens.filter((t) => t.delta > 0), downs = tokens.filter((t) => t.delta < 0);
    if (!(ups.length && downs.length)) {
      for (const t of tokens) out.ignored.push({ kind: 'unclear', mint: t.mint, pre: t.pre, post: t.post, delta: t.delta,
        reason: 'Token balance changed through a DEX program without any payment either way (claim, reward or LP action)' });
      return out;
    }
    // token-to-token swap: sells of the ones that went down, buys of the ones that went up
  }
  const single = tokens.length === 1;
  for (const t of tokens) {
    const quote = single ? { sol: quoteSol, stable: quoteStable } : null;
    const price = (q) => (single && Math.abs(t.delta) > 0 ? Math.abs(q) / Math.abs(t.delta) : null);
    if (t.delta > 0) {
      out.events.push({ kind: t.pre > 0 ? 'add' : 'buy', mint: t.mint, pre: t.pre, post: t.post, delta: t.delta, soldPct: null, quote,
        priceSol: quote && Math.abs(quoteSol) > SOL_EPS ? price(quoteSol) : null, priceStable: quote && Math.abs(quoteStable) > STABLE_EPS ? price(quoteStable) : null });
    } else {
      const exited = t.post <= t.pre * DUST;
      const soldPct = t.pre > 0 ? Math.min(100, ((t.pre - Math.max(0, t.post)) / t.pre) * 100) : 100;
      out.events.push({ kind: exited ? 'exit' : 'sell', mint: t.mint, pre: t.pre, post: t.post, delta: t.delta, soldPct: exited ? 100 : soldPct, quote,
        priceSol: quote && Math.abs(quoteSol) > SOL_EPS ? price(quoteSol) : null, priceStable: quote && Math.abs(quoteStable) > STABLE_EPS ? price(quoteStable) : null });
    }
  }
  return out;
}

/**
 * The same shape from a PumpPortal trade message (used for speed, and alone when there is no Helius key).
 * PumpPortal reports the wallet's balance after the trade, so before = after ± the traded amount.
 */
export function fromFeedTrade(msg) {
  const tokens = Number(msg.tokenAmount ?? 0);
  const post = Math.max(0, Number(msg.newTokenBalance ?? 0));
  const side = msg.txType === 'sell' ? 'sell' : 'buy';
  const pre = side === 'buy' ? Math.max(0, post - tokens) : post + tokens;
  const sol = Number(msg.solAmount ?? 0);
  const ev = { mint: msg.mint, pre, post, delta: side === 'buy' ? tokens : -tokens, quote: { sol: side === 'buy' ? -sol : sol, stable: 0 },
    priceSol: tokens > 0 ? sol / tokens : null, priceStable: null };
  if (side === 'buy') Object.assign(ev, { kind: pre > post * 1e-9 && pre > 0 ? 'add' : 'buy', soldPct: null });
  else { const exited = post <= pre * DUST; Object.assign(ev, { kind: exited ? 'exit' : 'sell', soldPct: exited ? 100 : pre > 0 ? (tokens / pre) * 100 : 100 }); }
  return { status: 'ok', signature: msg.signature, slot: null, blockTime: null, venue: 'Pump.fun / PumpSwap (PumpPortal feed)', events: [ev], ignored: [],
    feed: { marketCapSol: msg.marketCapSol != null ? Number(msg.marketCapSol) : null, vSol: msg.vSolInBondingCurve != null ? Number(msg.vSolInBondingCurve) : null, pool: msg.pool ?? null } };
}
