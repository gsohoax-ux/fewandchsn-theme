import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../src/paper.js';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';
import { analyzeSafety } from '../src/safety.js';
import { analyzeMomentum } from '../src/momentum.js';
import { config } from '../src/config.js';

// The real defaults from config.js (fixed 2 SOL account, no daily reset, for simple numbers)
const cfg = { ...config, paperDailyUsd: 0, paperStartSol: 2 };
const quiet = { info() {}, warn() {} };

function coinAt(vSol, mint = 'MINTpump') {
  const c = new Coin({ mint, name: 'Test', symbol: 'TST', traderPublicKey: 'DEV', signature: 's', initialBuy: 0 });
  setPrice(c, vSol);
  return c;
}
function setPrice(c, vSol) {
  c.vSol = vSol; c.vTokens = (30 * 1_073_000_000) / vSol; c.mcSol = (c.vSol / c.vTokens) * 1e9;
  c.progress = Math.max(0, Math.min(100, ((1_073_000_000 - c.vTokens) / 793_100_000) * 100));
}
const setup = (over = {}) => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg: { ...cfg, ...over }, store, log: quiet });
  return { t, store };
};

test('defaults: fewer, bigger trades with realistic costs', () => {
  const { t } = setup();
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  const pos = t.open(coin, { stage: 'fresh', score: 70 }, coins);
  assert.ok(Math.abs(pos.costSol - 0.9) < 1e-9, '45% of 2 SOL');
  assert.ok(pos.hurdle > 0.08 && pos.hurdle < 0.2, `cost hurdle ${(pos.hurdle * 100).toFixed(1)}%`);
});

test('stops follow the price: the cost hurdle alone does not trigger a stop', () => {
  const { t, store } = setup();
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  t.open(coin, { stage: 'fresh', score: 70 }, coins);
  setPrice(coin, 37.5); t.onPrice(coin, coins); // price about -12%
  assert.equal(t.positions.size, 1, 'still held: a −12% price dip is noise');
  setPrice(coin, 31.5); t.onPrice(coin, coins); // price about -38%
  assert.equal(t.positions.size, 0);
  assert.match(store.paperTrades()[0].why, /stop loss: price -3\d%/);
});

test('graduation: half sold near the end of the curve, the rest a few minutes after graduating', () => {
  const { t, store } = setup({ paperTrailPct: 99 });
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  const now = Date.now();
  t.open(coin, { stage: 'mid', score: 70 }, coins, now);
  const tokens0 = t.positions.get(coin.mint).tokens;
  setPrice(coin, 105); t.onPrice(coin, coins, now + 60_000); // ~94% of the curve
  const pos = t.positions.get(coin.mint);
  assert.ok(pos.halfTaken && Math.abs(pos.tokens - tokens0 / 2) < 1);
  assert.match(store.paperTrades()[0].why, /took half at 9\d% of the curve/);
  coin.migrated = true; t.onMigrate(coin, coins, now + 120_000);
  t.tick(coins, now + 120_000 + 4 * 60_000);
  assert.equal(t.positions.size, 1, 'still holding during the first minutes');
  t.tick(coins, now + 120_000 + 5 * 60_000);
  assert.equal(t.positions.size, 0);
  assert.match(store.paperTrades()[0].why, /after graduation/);
  assert.ok(t.cash > 2, 'a run to graduation was profitable after costs');
});

test('no follow-through: a coin that never gets going is sold after 25 minutes', () => {
  const { t, store } = setup();
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  const now = Date.now();
  t.open(coin, { stage: 'fresh', score: 70 }, coins, now);
  setPrice(coin, 42); t.onPrice(coin, coins, now + 60_000); // +10% only
  t.tick(coins, now + 24 * 60_000);
  assert.equal(t.positions.size, 1);
  t.tick(coins, now + 26 * 60_000);
  assert.equal(t.positions.size, 0);
  assert.match(store.paperTrades()[0].why, /no follow-through/);
  const tr = store.paperTrades()[0];
  assert.ok(tr.mfe > 0.09 && tr.hurdle > 0, 'best move and cost hurdle are logged');
});

test('trades too small for the network fees are skipped', () => {
  const { t } = setup({ paperStartSol: 0.05 });
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  assert.equal(t.open(coin, { stage: 'fresh', score: 70 }, coins), null);
});

test('results are grouped by entry stage', () => {
  const { t } = setup();
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  t.open(coin, { stage: 'fresh', score: 70 }, coins);
  setPrice(coin, 30.5); t.onPrice(coin, coins);
  const v = t.view(coins);
  assert.equal(v.byStage[0].key, 'fresh · curve 20-50%');
  assert.equal(v.byStage[0].trades, 1);
  assert.ok(v.byStage[0].netPct < 0);
});

test('top 10 counts a linked-wallet group as one holder', () => {
  const coin = coinAt(40);
  coin.trades = []; coin.balances = new Map(); coin.firstBuyAt = new Map(); coin.firstBuyTokens = new Map();
  const T0 = coin.createdAt;
  const buy = (w, tokens, ts) => coin.applyTrade({ signature: `s${w}`, traderPublicKey: w, txType: 'buy', tokenAmount: tokens, solAmount: 1, newTokenBalance: tokens }, ts);
  for (let i = 0; i < 12; i++) buy(`L${i}`, 3_000_000, T0 + 5000 + i);           // 12 linked wallets x 0.3%
  for (let i = 0; i < 40; i++) buy(`O${i}`, 2_500_000, T0 + 9000 + i);           // 40 others x 0.25%
  const wallets = new Map([...Array(12)].map((_, i) => [`L${i}`, { funder: 'F', fresh: true }]));
  const cfg2 = { maxBundlePct: 15, maxDevPct: 8, maxTop10Pct: 35 };
  const r = analyzeSafety(coin, { source: 'chain', slots: new Map(), wallets, services: new Set(), errors: [] }, { cfg: cfg2, devLaunches24h: 0, recycledSocials: [] });
  // Raw top 10 would be 10 x 0.3% = 3%; grouped, the 12 linked wallets are one 3.6% holder + 9 others x 0.25%
  assert.ok(Math.abs(r.top10Pct - (3.6 + 9 * 0.25)) < 0.01, `top10 ${r.top10Pct}`);
});

test('insiders and launch-moment buyers do not count as real buyers', () => {
  const coin = coinAt(40);
  const T0 = Date.now() - 60_000;
  coin.createdAt = T0; coin.trades = []; coin.firstBuyAt = new Map();
  const buy = (w, ts) => coin.applyTrade({ signature: `s${w}`, traderPublicKey: w, txType: 'buy', tokenAmount: 1e6, solAmount: 0.5, newTokenBalance: 1e6 }, ts);
  for (let i = 0; i < 5; i++) buy(`B${i}`, T0 + 200);     // launch-moment bundle
  for (let i = 0; i < 4; i++) buy(`U${i}`, T0 + 20_000);  // real buyers
  assert.equal(coin.organicBuyerCount(), 4);
  const m = analyzeMomentum(coin, Date.now(), new Set(), new Set(['B0', 'B1', 'B2', 'B3', 'B4']));
  assert.equal(m.uniqueBuyers2m, 4);
});
