import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, trainLogistic, predict, Learner, featurize } from '../src/learn.js';
import { Store } from '../src/store.js';
import { largestSameSizeGroup } from '../src/safety.js';
import { parseOrders } from '../src/dexscreener.js';
import { analyzeMomentum } from '../src/momentum.js';
import { Coin } from '../src/coin.js';
import { combine } from '../src/score.js';

const cfg = { learnTarget: 1.5, learnMinSamples: 300, learnMinLift: 1.3, learnEveryMin: 30, learnMaxSamples: 20000 };

// Deterministic random numbers so tests are repeatable
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

function fillStore(store, n, signal) {
  const r = rng(42);
  const iMom = FEATURES.findIndex(([k]) => k === 'momentum');
  for (let i = 0; i < n; i++) {
    const x = FEATURES.map(() => r());
    // Coins with high momentum pump more often (if signal), otherwise pure noise
    const chance = signal ? 0.03 + 0.5 * x[iMom] ** 2 : 0.15;
    const hit = r() < chance;
    store.addSample(`M${i}`, 'fresh', 1_000_000 + i * 1000, x, 50);
    store.updateSample(`M${i}`, 'fresh', hit ? 90 : 55, false, true);
  }
}

test('logistic regression learns a simple pattern', () => {
  const X = [], y = [];
  const r = rng(1);
  for (let i = 0; i < 600; i++) { const a = r(); X.push([a, r()]); y.push(r() < a ? 1 : 0); }
  const m = trainLogistic(X, y);
  assert.ok(m.w[0] > 1, `weight on the real signal: ${m.w[0]}`);
  assert.ok(Math.abs(m.w[1]) < 0.6, `weight on noise: ${m.w[1]}`);
  assert.ok(predict(m, [0.9, 0.5]) > predict(m, [0.1, 0.5]));
});

test('learner waits for enough data', () => {
  const store = new Store(':memory:');
  fillStore(store, 100, true);
  const l = new Learner({ store, cfg, log: { info() {} } });
  l.train();
  assert.equal(l.model, null);
  assert.match(l.status().info, /Collecting data: 100\/300/);
});

test('learner finds a real signal, validates it, and explains it', () => {
  const store = new Store(':memory:');
  fillStore(store, 1500, true);
  const l = new Learner({ store, cfg, log: { info() {} } });
  l.train();
  assert.ok(l.model.validated, `lift ${l.model.lift}`);
  assert.equal(l.status().top[0].key, 'momentum', 'momentum is the top learned factor');
  const iMom = FEATURES.findIndex(([k]) => k === 'momentum');
  const hi = FEATURES.map(() => 0.5); hi[iMom] = 0.95;
  const lo = FEATURES.map(() => 0.5); lo[iMom] = 0.05;
  assert.ok(l.score(hi).pct > 80 && l.score(lo).pct < 30, `${l.score(hi).pct} vs ${l.score(lo).pct}`);
  // The model is saved and reloads after a restart
  assert.ok(new Learner({ store, cfg, log: { info() {} } }).model.validated);
});

test('learner refuses to take over when there is no real signal', () => {
  const store = new Store(':memory:');
  fillStore(store, 1500, false);
  const l = new Learner({ store, cfg, log: { info() {} } });
  l.train();
  assert.equal(l.model.validated, false);
  assert.match(l.status().info, /still using default scores/);
});

test('validated learning blends into the score; unvalidated does not', () => {
  const s = { verdict: 'SAFE', score: 80 }, n = { score: 50 }, m = { score: 50 };
  assert.equal(combine(s, n, m).score, 59);
  assert.equal(combine(s, n, m, 99, 0.5).score, 79);
  assert.equal(combine({ verdict: 'AVOID', score: 80 }, n, m, 99, 0.5).score, 30, 'AVOID cap still applies');
});

test('features are numbers between 0 and 1', () => {
  const coin = new Coin({ mint: 'M', name: 'A', symbol: 'A', traderPublicKey: 'D', signature: 's', initialBuy: 1e6 });
  coin.meta = { twitter: 'x', telegram: '', website: '' };
  const x = featurize(coin, {
    safety: { score: 90, launchBundle: { initialPct: 50 }, clusters: [{ heldPct: 99 }], devPct: 2, top10Pct: 20, freshPct: 10 },
    narrative: { score: 60 }, momentum: { score: 70, progressPerMin: 99, uniqueBuyers2m: 10, buySellRatio: 2, holders: 50 },
  }, 'mid');
  assert.equal(x.length, FEATURES.length);
  assert.ok(x.every((v) => v >= 0 && v <= 1));
});

test('identical-size early buys are detected; round numbers are not', () => {
  assert.equal(largestSameSizeGroup([1.2345, 1.2391, 1.2301, 1.2377, 0.3]), 4);
  assert.equal(largestSameSizeGroup([0.5, 0.5, 0.5, 1, 1]), 0, 'humans buy round amounts');
  assert.equal(largestSameSizeGroup([0.33, 0.71, 1.43]), 1);
});

test('dust buys do not count as real buyers', () => {
  const coin = new Coin({ mint: 'M', name: 'A', symbol: 'A', traderPublicKey: 'D', signature: 's', initialBuy: 1e6 }, Date.now() - 60_000);
  for (let i = 0; i < 30; i++) {
    coin.applyTrade({ signature: `d${i}`, traderPublicKey: `bot${i}`, txType: 'buy', tokenAmount: 1000, solAmount: 0.001, newTokenBalance: 1000 });
  }
  for (let i = 0; i < 5; i++) {
    coin.applyTrade({ signature: `r${i}`, traderPublicKey: `real${i}`, txType: 'buy', tokenAmount: 2e6, solAmount: 0.5, newTokenBalance: 2e6 });
  }
  const m = analyzeMomentum(coin);
  assert.equal(m.uniqueBuyers2m, 5);
  assert.ok(m.dustPct > 80);
  assert.equal(m.holders, 6, '5 real buyers + dev');
});

test('DexScreener orders parse in either response shape', () => {
  assert.equal(parseOrders([{ type: 'tokenProfile', status: 'approved' }]).paid, true);
  assert.equal(parseOrders({ orders: [{ type: 'tokenProfile', status: 'cancelled' }], boosts: [{}] }).paid, false);
  assert.equal(parseOrders({ orders: [], boosts: [{}, {}] }).boosts, 2);
  assert.equal(parseOrders(null).paid, false);
});
