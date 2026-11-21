import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../src/paper.js';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';
import { config } from '../src/config.js';

const quiet = { info() {}, warn() {} };
const cfg = { ...config, paperDailyUsd: 0, paperStartSol: 2, paperTrailPct: 99, paperStallMin: 0 };

function coinAt(vSol, mint = 'MINTpump') {
  const c = new Coin({ mint, name: 'Test', symbol: 'TST', traderPublicKey: 'D', signature: 's', initialBuy: 0 });
  setPrice(c, vSol);
  return c;
}
function setPrice(c, vSol) {
  c.vSol = vSol; c.vTokens = (30 * 1_073_000_000) / vSol; c.mcSol = (c.vSol / c.vTokens) * 1e9;
  c.progress = Math.max(0, Math.min(100, ((1_073_000_000 - c.vTokens) / 793_100_000) * 100));
}

function runToGraduation(worthy, fetchFn) {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg, store, log: quiet, getSolUsd: () => 150, moonbagWorthy: () => worthy, fetchFn });
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  const now = Date.now();
  t.open(coin, { stage: 'final', score: 80 }, coins, now);
  setPrice(coin, 105); t.onPrice(coin, coins, now + 60_000);       // takes half near the end of the curve
  coin.migrated = true; t.onMigrate(coin, coins, now + 120_000);
  t.tick(coins, now + 120_000 + 5 * 60_000);                        // graduation exit
  return { t, store, coin, now };
}

test('strong coin: keeps a moonbag after graduation, outside the daily account', () => {
  const { t, store } = runToGraduation(true);
  assert.equal(t.positions.size, 0, 'the regular position is done');
  assert.equal(t.moonbags.size, 1, 'a moonbag is kept');
  const m = [...t.moonbags.values()][0];
  assert.ok(m.baseValue > 0);
  assert.ok(store.paperTrades().some((r) => r.why === 'kept as moonbag'));
});

test('ordinary coin: everything is sold after graduation, no moonbag', () => {
  const { t, store } = runToGraduation(false);
  assert.equal(t.moonbags.size, 0);
  assert.match(store.paperTrades()[0].why, /after graduation$/);
});

test('moonbag rides up, sells on a 50% drop from its high, and counts in all-time and wins', () => {
  const { t } = runToGraduation(true);
  const m = [...t.moonbags.values()][0];
  const base = m.baseMc;
  t.moonbagPrice(m.mint, base * 4);           // 4x after graduation
  assert.equal(t.moonbags.size, 1);
  t.moonbagPrice(m.mint, base * 2.1);         // -47.5% from the high: still held
  assert.equal(t.moonbags.size, 1);
  t.moonbagPrice(m.mint, base * 1.9);         // -52.5%: sold
  assert.equal(t.moonbags.size, 0);
  const log = t.moonbagLog[0];
  assert.match(log.why, /trailing stop/);
  assert.ok(log.mult > 1.7 && log.pnlUsd > 0, `moonbag ${log.mult.toFixed(2)}x`);
  const wl = t.winLoss(0);
  assert.equal(wl.wins + wl.losses, 1, 'partial sells and the moonbag count as ONE position');
  assert.equal(wl.wins, 1);
});

test('moonbag priced from DexScreener after the bot stops tracking the coin, with a 48h limit', async () => {
  let mcUsd = 0;
  const fetchFn = async () => ({ ok: true, json: async () => ({ pairs: [{ chainId: 'solana', marketCap: mcUsd, liquidity: { usd: 50_000 } }] }) });
  const { t } = runToGraduation(true, fetchFn);
  const m = [...t.moonbags.values()][0];
  mcUsd = m.baseMc * 150 * 3; // 3x, in USD
  await t.pollMoonbags();
  assert.ok(Math.abs(t.moonbags.get(m.mint).lastMc - m.baseMc * 3) < 1e-6);
  await t.pollMoonbags(m.since + 49 * 3600_000);
  assert.equal(t.moonbags.size, 0);
  assert.match(t.moonbagLog[0].why, /time limit/);
});

test('wins vs losses: counts, averages and profit factor', () => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg, store, log: quiet });
  const add = (mint, cost, proceeds) => store.addPaperTrade({ mint, symbol: mint, openedAt: 1, closedAt: 2, costSol: cost, proceedsSol: proceeds, why: 'x', stage: 'fresh' });
  add('A', 1, 2); add('B', 1, 0.7); add('C', 1, 0.6); add('D', 0.5, 0.75); add('D', 0.5, 0.55); // D = two partial sells
  const w = t.winLoss(0);
  assert.deepEqual([w.wins, w.losses, w.winRate], [2, 2, 50]);
  assert.ok(Math.abs(w.avgWinPct - 65) < 1e-9, `avg win ${w.avgWinPct}`);   // A +100%, D +30%
  assert.ok(Math.abs(w.avgLossPct + 35) < 1e-9);                           // B -30%, C -40%
  assert.ok(Math.abs(w.profitFactor - 1.3 / 0.7) < 1e-9);
});

test('a position only counts as a win or loss once it is completely finished', () => {
  const store = new Store(':memory:');
  const t = new PaperTrader({ cfg, store, log: quiet });
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  t.open(coin, { stage: 'final', score: 80 }, coins);
  setPrice(coin, 105); t.onPrice(coin, coins);   // half sold, rest still open
  assert.equal(t.winLoss(0).wins + t.winLoss(0).losses, 0, 'open position not counted yet');
  t.close(t.positions.get(coin.mint), coin, coins, 'test');
  assert.equal(t.winLoss(0).wins, 1);
});
