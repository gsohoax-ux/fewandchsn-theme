import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ManualPaper, extractAddress } from '../src/manual.js';
import { Store } from '../src/store.js';

const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const PUMP = 'Fq3s2Yb2wJ8fWz6x5rJ3Rk1v9nQe4XhL7mUuTtPapump';
const PAIR = 'Ac1dPa1rAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const cfg = { paperFeePct: 1.25, paperTerminalFeePct: 1, paperTxFeeSol: 0.0015, paperMevPct: 2 };

test('finds the address in pasted links and raw addresses', () => {
  assert.equal(extractAddress(MINT), MINT);
  assert.equal(extractAddress(`  ${PUMP}  `), PUMP);
  assert.equal(extractAddress(`https://pump.fun/coin/${PUMP}`), PUMP);
  assert.equal(extractAddress(`pump.fun/coin/${PUMP}?include-nsfw=true`), PUMP);
  assert.equal(extractAddress(`https://dexscreener.com/solana/${PAIR}?maker=1`), PAIR);
  assert.equal(extractAddress(`https://trade.padre.gg/trade/solana/${PUMP}`), PUMP);
  assert.equal(extractAddress(`https://gmgn.ai/sol/token/abc_${PUMP}`), PUMP);
  assert.equal(extractAddress('hello there'), null);
  assert.equal(extractAddress(''), null);
});

/** DexScreener stand-in: one graduated coin with a $100k pool, price set by the test. */
function dex(state) {
  return async (url) => {
    if (url.includes('/latest/dex/tokens/')) {
      const asked = url.split('/tokens/')[1].split(',');
      const pairs = asked.includes(MINT) ? [{ chainId: 'solana', dexId: 'raydium', pairAddress: PAIR, baseToken: { address: MINT, symbol: 'TEST', name: 'Test' },
        priceUsd: String(state.price), marketCap: state.price * 1e9, liquidity: { usd: state.liq } }] : [];
      return { ok: true, json: async () => ({ pairs }) };
    }
    if (url.includes('/latest/dex/pairs/solana/')) {
      return { ok: true, json: async () => ({ pairs: url.endsWith(PAIR) ? [{ baseToken: { address: MINT } }] : [] }) };
    }
    return { ok: false, status: 404 };
  };
}

test('opens a position with fees + slippage, tracks it live, and closes it', async () => {
  const state = { price: 0.0001, liq: 100_000 };
  const store = new Store(':memory:');
  const engine = { solUsd: 150, coins: new Map() };
  const m = new ManualPaper({ store, cfg, engine, fetchFn: dex(state), log: { warn() {} } });

  const p = await m.openPosition({ mint: MINT, budgetUsd: 50 });
  assert.equal(p.symbol, 'TEST');
  assert.equal(p.entryMcUsd, 100_000);
  // $50 in a pool with $50k on the SOL side: ~0.1% impact + 2% MEV; fees 2.25% and $0.225 network
  assert.ok(p.entrySlipPct > 2 && p.entrySlipPct < 2.2, `entry slip ${p.entrySlipPct}`);
  // value "if sold now" includes the round trip: entry AND exit fees, slippage and network fees
  assert.ok(p.pnlPct < -6 && p.pnlPct > -9, `starts red after round-trip costs: ${p.pnlPct}`);

  state.price = 0.0002; // price doubles
  await m.poll();
  const v = m.view();
  assert.equal(v.open.length, 1);
  assert.equal(v.open[0].mcUsd, 200_000);
  assert.ok(Math.abs(v.open[0].priceChangePct - 100) < 1e-9);
  assert.ok(v.open[0].pnlPct > 80 && v.open[0].pnlPct < 95, `doubles minus costs: ${v.open[0].pnlPct}`);
  assert.ok(v.totals.pnlUsd > 40);

  const closed = m.closePosition(p.id);
  assert.ok(closed.pnlUsd > 40);
  assert.equal(m.view().open.length, 0);
  assert.equal(m.view().totals.closedCount, 1);
  assert.throws(() => m.closePosition(p.id), /not found/);

  // survives a restart
  const again = new ManualPaper({ store, cfg, engine, fetchFn: dex(state), log: { warn() {} } });
  assert.equal(again.view().closed.length, 1);
});

test('a thin pool means the paper value cannot all be cashed out', async () => {
  const state = { price: 0.0001, liq: 2_000 }; // $1k SOL side
  const m = new ManualPaper({ store: new Store(':memory:'), cfg, engine: { solUsd: 150, coins: new Map() }, fetchFn: dex(state), log: { warn() {} } });
  const p = await m.openPosition({ mint: MINT, budgetUsd: 500 });
  assert.ok(p.entrySlipPct > 50, 'a $500 buy into a $1k pool pays huge slippage');
  assert.ok(p.ifSoldUsd < p.marketUsd * 0.8, 'selling into the thin pool loses a lot');
});

test('refuses bad budgets and coins with no pool', async () => {
  const state = { price: 0.0001, liq: 0 };
  const m = new ManualPaper({ store: new Store(':memory:'), cfg, engine: { solUsd: 150, coins: new Map() }, fetchFn: dex(state), log: { warn() {} } });
  await assert.rejects(() => m.openPosition({ mint: MINT, budgetUsd: 0 }), /Budget/);
  await assert.rejects(() => m.openPosition({ mint: MINT, budgetUsd: 50 }), /no liquidity pool/);
});

test('resolves a DexScreener pair link to the coin', async () => {
  const m = new ManualPaper({ store: new Store(':memory:'), cfg, engine: null, fetchFn: dex({ price: 1, liq: 1 }), log: { warn() {} } });
  assert.equal(await m.resolve(`https://dexscreener.com/solana/${PAIR}`), MINT);
  assert.equal(await m.resolve(`https://pump.fun/coin/${MINT}`), MINT);
  await assert.rejects(() => m.resolve('not an address'), /No Solana address/);
});

test('curve coins update instantly from the live trade feed', async () => {
  const feed = new EventEmitter(); feed.watched = new Set(); feed.watch = (x) => feed.watched.add(x);
  const coin = { symbol: 'CRV', name: 'Curve Coin', migrated: false, mcSol: 30, vSol: 31 };
  const engine = { solUsd: 150, coins: new Map([[PUMP, coin]]) };
  const m = new ManualPaper({ store: new Store(':memory:'), cfg, engine, feed, fetchFn: async () => ({ ok: false }), log: { warn() {} } });
  const p = await m.openPosition({ mint: PUMP, budgetUsd: 30 });
  assert.equal(p.onCurve, true);
  assert.equal(p.mcUsd, 4500);
  assert.ok(feed.watched.has(PUMP), 'subscribed to live trades');
  feed.emit('trade', { mint: PUMP, marketCapSol: 60, vSolInBondingCurve: 44 });
  const v = m.view().open[0];
  assert.equal(v.mcUsd, 9000);
  assert.equal(v.source, 'live feed');
  assert.ok(v.pnlUsd > 0);
  feed.emit('trade', { mint: 'other', marketCapSol: 1 });
  assert.equal(m.view().open[0].mcUsd, 9000, 'other coins are ignored');
});
