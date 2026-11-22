import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepChecker, judge, linkClusters } from '../src/deepcheck.js';
import { Store } from '../src/store.js';

const MINT = 'So1MintAddressForTesting111111111111111pump';
const SYS = '11111111111111111111111111111111';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const cfg = { maxBundlePct: 15, maxDevPct: 8, maxTop10Pct: 35, deployToolPatterns: [] };

/**
 * A fake Solana world: supply 1B, the bonding curve holds the rest, `holders` own tokens.
 * `launch` lists who bought in the creation slot; `funders` says who funded each wallet.
 */
function world({ holders, launch, funders, mintAuthority = null, dex = 'pumpfun', liq = 0 }) {
  const curve = 'CurvePda111111111111111111111111111111111';
  const all = { ...holders, [curve]: 1e9 - Object.values(holders).reduce((a, b) => a + b, 0) };
  const accts = Object.entries(all).sort((a, b) => b[1] - a[1]).map(([o, amt]) => ({ address: `ta_${o}`, uiAmount: amt, owner: o }));
  const rpc = async (method, params) => {
    if (method === 'getAccountInfo') return { value: { data: { parsed: { info: { mintAuthority, freezeAuthority: null, supply: String(1e15), decimals: 6 } } } } };
    if (method === 'getTokenLargestAccounts') return { value: accts.slice(0, 20).map(({ address, uiAmount }) => ({ address, uiAmount })) };
    if (method === 'getAsset') return { content: { metadata: { name: 'Test Coin', symbol: 'TEST' } } };
    if (method === 'getMultipleAccounts') {
      return { value: params[0].map((a) => {
        if (a.startsWith('ta_')) return { data: { parsed: { info: { owner: a.slice(3) } } } };
        return { owner: a === curve ? PUMP_PROGRAM : SYS };
      }) };
    }
    if (method === 'getSignaturesForAddress') {
      return [{ signature: 'later', slot: 205 }, ...launch.map((w, i) => ({ signature: `b${i}`, slot: 100 })), { signature: 'create', slot: 100 }];
    }
    if (method === 'getTokenAccountsByOwner') return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: holders[params[0]] ?? 0 } } } } } }] };
    throw new Error(`unexpected ${method}`);
  };
  const chain = {
    enabled: true, rpc,
    parseTransactions: async (sigs) => sigs.map((sig) => {
      if (sig === 'create') return { signature: sig, slot: 100, timestamp: 1_700_000_000, feePayer: 'DEV', tokenTransfers: [{ mint: MINT, toUserAccount: 'DEV', tokenAmount: 20e6 }] };
      const i = Number(sig.slice(1));
      return { signature: sig, slot: 100, feePayer: launch[i], tokenTransfers: [{ mint: MINT, toUserAccount: launch[i], tokenAmount: 40e6 }] };
    }),
    getWalletInfo: async (w) => ({ funder: funders[w] ?? `own_${w}`, fresh: Boolean(funders[w]) }),
    isService: async () => false,
  };
  const fetchFn = async (url) => {
    if (url.includes('dexscreener')) return { ok: true, json: async () => ({ pairs: [{ chainId: 'solana', dexId: dex, marketCap: 40_000, liquidity: { usd: liq }, volume: { h24: 90_000 }, txns: { h1: { buys: 40, sells: 30 } } }] }) };
    if (url.includes('rugcheck')) return { ok: true, json: async () => ({ score_normalised: 10, risks: [] }) };
    return { ok: false, status: 404 };
  };
  return { chain, fetchFn };
}

test('catches a bundled launch with linked wallets', async () => {
  const launch = ['B1', 'B2', 'B3', 'B4', 'B5'];
  const holders = { DEV: 20e6, B1: 40e6, B2: 40e6, B3: 40e6, B4: 40e6, B5: 40e6, H1: 10e6, H2: 8e6 };
  const funders = { B1: 'BOSS', B2: 'BOSS', B3: 'BOSS', B4: 'BOSS', B5: 'BOSS' };
  const { chain, fetchFn } = world({ holders, launch, funders });
  const r = await new DeepChecker({ chain, store: new Store(':memory:'), cfg, fetchFn, log: { info() {}, warn() {} } }).check(MINT);
  assert.equal(r.verdict, 'AVOID');
  assert.equal(r.creator, 'DEV');
  const txt = r.checks.map((c) => `${c.level}:${c.text}`).join('\n');
  assert.match(txt, /bad:Bundled at launch: 5 wallets bought 20\.0% in the creation block, still holding 20\.0%/);
  assert.match(txt, /5 wallets share a funder, holding 20\.0% together/);
  assert.match(txt, /Top 10 holders own 23\.8% \(pools and the bonding curve excluded\)/);
  assert.match(txt, /Bonding curve \/ pools hold 76\.2%/);
  assert.match(txt, /ok:Mint authority revoked/);
});

test('passes a clean launch', async () => {
  const holders = { DEV: 15e6, H1: 12e6, H2: 10e6, H3: 9e6, H4: 8e6 };
  const { chain, fetchFn } = world({ holders, launch: [], funders: {} });
  const r = await new DeepChecker({ chain, store: new Store(':memory:'), cfg, fetchFn, log: { info() {}, warn() {} } }).check(MINT);
  assert.equal(r.verdict, 'SAFE', r.checks.filter((c) => c.level !== 'ok').map((c) => c.text).join(' | '));
  assert.match(r.checks.map((c) => c.text).join('\n'), /No other wallets bought in the creation block/);
});

test('flags active mint authority and missing liquidity after graduation', async () => {
  const { chain, fetchFn } = world({ holders: { DEV: 1e6 }, launch: [], funders: {}, mintAuthority: 'EvilAuthority111', dex: 'raydium', liq: 300 });
  const r = await new DeepChecker({ chain, store: new Store(':memory:'), cfg, fetchFn, log: { info() {}, warn() {} } }).check(MINT);
  assert.equal(r.verdict, 'AVOID');
  const txt = r.checks.map((c) => `${c.level}:${c.text}`).join('\n');
  assert.match(txt, /bad:Mint authority is ACTIVE/);
  assert.match(txt, /bad:Liquidity \$300/);
});

test('rejects things that are not token addresses', async () => {
  const dc = new DeepChecker({ chain: null, store: new Store(':memory:'), cfg, fetchFn: async () => ({ ok: false }) });
  await assert.rejects(() => dc.check('hello'), /doesn't look like a Solana token address/);
});

test('without Helius it still gives a partial verdict and says what was skipped', async () => {
  const { fetchFn } = world({ holders: {}, launch: [], funders: {} });
  const r = await new DeepChecker({ chain: null, store: new Store(':memory:'), cfg, fetchFn }).check(MINT);
  assert.ok(r.notes.some((n) => n.includes('No Helius key')));
  assert.ok(r.checks.some((c) => c.level === 'unknown'));
  assert.equal(r.verdict, 'UNVERIFIED');
});

test('helpers: linked clusters and verdict rules', () => {
  const w = new Map([['A', { funder: 'X' }], ['B', { funder: 'X' }], ['C', { funder: 'DEV' }], ['DEV', { funder: 'Y' }]]);
  const c = linkClusters(w, { creator: 'DEV' });
  assert.equal(c.length, 2);
  assert.ok(c.some((g) => g.includesDev));
  assert.equal(judge({ mintAuthority: null, freezeAuthority: null, top10Pct: 20, launch: { bundleWallets: 0, bundleInitialPct: 0, bundleHeldPct: 0, sniperWallets: 0, sniperHeldPct: 0 }, links: { checked: 10, clusters: [] }, creator: 'D', devPct: 2 }).verdict, 'SAFE');
});

test('never SAFE when the key on-chain checks could not run', () => {
  const j = judge({});
  assert.equal(j.verdict, 'UNVERIFIED');
  assert.equal(judge({ mintAuthority: 'X' }).verdict, 'AVOID', 'a red flag still wins');
});
