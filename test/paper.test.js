import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../src/paper.js';
import { Store } from '../src/store.js';
import { Coin, quoteBuy, quoteSell } from '../src/coin.js';

const cfg = {
  paper: true, paperStartSol: 2, paperSizePct: 8, paperMaxOpen: 5, paperStopPct: 25, paperTrailStartPct: 30,
  paperTrailPct: 20, paperMaxHoldMin: 90, paperFeePct: 1.25, paperTxFeeSol: 0.002, paperSlippagePct: 3,
};
const quiet = { info() {}, warn() {} };

function coinAt(vSol, mint = 'MINTpump') {
  const c = new Coin({ mint, name: 'Test', symbol: 'TST', traderPublicKey: 'DEV', signature: 's', initialBuy: 0,
    vSolInBondingCurve: vSol, vTokensInBondingCurve: (30 * 1_073_000_000) / vSol, marketCapSol: 0 });
  setPrice(c, vSol);
  return c;
}
/** Move the curve to a new SOL reserve (constant product), like buys/sells would. */
function setPrice(c, vSol) {
  c.vSol = vSol; c.vTokens = (30 * 1_073_000_000) / vSol; c.mcSol = (c.vSol / c.vTokens) * 1e9;
}

test('curve quotes: buying then selling the same tokens returns the same SOL (before fees)', () => {
  const tokens = quoteBuy(40, 800_000_000, 1);
  const back = quoteSell(41, 800_000_000 - tokens, tokens);
  assert.ok(Math.abs(back - 1) < 1e-9);
});

test('a buy costs fees and slippage: value right after buying is a few % below cost', () => {
  const t = new PaperTrader({ cfg, store: new Store(':memory:'), log: quiet });
  const coin = coinAt(40);
  const coins = new Map([[coin.mint, coin]]);
  const pos = t.open(coin, { stage: 'fresh', score: 70 }, coins);
  assert.ok(Math.abs(pos.costSol - 0.16) < 1e-9, '8% of 2 SOL');
  const loss = 1 - t.valueOf(pos, coin) / pos.costSol;
  assert.ok(loss > 0.07 && loss < 0.15, `round-trip cost ${(loss * 100).toFixed(1)}%`);
  assert.ok(Math.abs(t.equity(coins) + pos.costSol - t.valueOf(pos, coin) - 2) < 1e-9, 'no money created');
});

test('stop loss sells when the coin drops', () => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg, store, log: quiet });
  const coin = coinAt(40);
  const coins = new Map([[coin.mint, coin]]);
  t.open(coin, { stage: 'fresh', score: 70 }, coins);
  setPrice(coin, 34); t.onPrice(coin, coins);
  assert.equal(t.positions.size, 0);
  assert.match(store.paperTrades()[0].why, /stop loss/);
  assert.ok(t.cash < 2);
});

test('trailing stop locks in profit after a run-up', () => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg, store, log: quiet });
  const coin = coinAt(40);
  const coins = new Map([[coin.mint, coin]]);
  t.open(coin, { stage: 'fresh', score: 70 }, coins);
  setPrice(coin, 60); t.onPrice(coin, coins);   // big run: trailing activates
  assert.ok(t.positions.get(coin.mint).trailing);
  setPrice(coin, 58); t.onPrice(coin, coins);   // small dip: still held
  assert.equal(t.positions.size, 1);
  setPrice(coin, 50); t.onPrice(coin, coins);   // bigger drop from the top: sold
  assert.equal(t.positions.size, 0);
  const tr = store.paperTrades()[0];
  assert.match(tr.why, /trailing stop \+/);
  assert.ok(tr.proceeds_sol > tr.cost_sol, 'sold at a profit');
  assert.ok(t.cash > 2);
});

test('time stop, max open positions, and coins that disappear', () => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg: { ...cfg, paperMaxOpen: 2 }, store, log: quiet });
  const a = coinAt(40, 'A'), b = coinAt(40, 'B'), c = coinAt(40, 'C');
  const coins = new Map([['A', a], ['B', b], ['C', c]]);
  const now = Date.now();
  t.open(a, { stage: 'fresh', score: 70 }, coins, now);
  t.open(b, { stage: 'fresh', score: 70 }, coins, now);
  assert.equal(t.open(c, { stage: 'fresh', score: 70 }, coins, now), null, 'max 2 open');
  coins.delete('B');
  t.tick(coins, now + 60_000);
  assert.equal(t.positions.has('B'), false, 'closed when the coin stops trading');
  t.tick(coins, now + 91 * 60_000);
  assert.equal(t.positions.size, 0, 'time stop');
  assert.equal(store.paperTrades().length, 2);
});

test('after a restart, open positions are closed at their last value and cash is kept', () => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg, store, log: quiet });
  const coin = coinAt(40);
  const coins = new Map([[coin.mint, coin]]);
  t.open(coin, { stage: 'fresh', score: 70 }, coins);
  setPrice(coin, 45); t.onPrice(coin, coins);
  t.tick(coins, Date.now() + 61_000); // saves state
  const before = t.equity(coins);
  const t2 = new PaperTrader({ cfg, store, log: quiet });
  assert.equal(t2.positions.size, 0);
  assert.ok(Math.abs(t2.cash - before) < 1e-6, `${t2.cash} vs ${before}`);
  assert.match(store.paperTrades()[0].why, /restart/);
  // A different starting balance starts a fresh account
  assert.equal(new PaperTrader({ cfg: { ...cfg, paperStartSol: 5 }, store, log: quiet }).cash, 5);
});

test('dev past rugs are remembered and flagged', async () => {
  const { analyzeSafety } = await import('../src/safety.js');
  const store = new Store(':memory:');
  store.addLaunch({ mint: 'OLD1', creator: 'DEV', symbol: 'A', name: 'a', createdAt: Date.now() - 3600_000 });
  store.setOutcome('OLD1', 300, 40, true, false);
  const h = store.devHistory('DEV', 'NEW');
  assert.deepEqual(h, { finished: 1, rugged: 1, migrated: 0 });
  const coin = coinAt(40);
  const r = analyzeSafety(coin, { source: 'timing', slots: null, wallets: new Map(), services: new Set(), errors: [] },
    { cfg: { maxBundlePct: 15, maxDevPct: 8, maxTop10Pct: 35 }, devLaunches24h: 1, recycledSocials: [], devHistory: h });
  assert.equal(r.verdict, 'AVOID');
  assert.ok(r.flags.some((f) => f.cat === 'Dev rugged before'));
});
