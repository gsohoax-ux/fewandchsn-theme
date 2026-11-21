import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';

test('"coins like this": real outcomes of similar scores, only with enough data', () => {
  const store = new Store(':memory:');
  const now = Date.now();
  const add = (i, score, peakMult, lowMult) => {
    store.addSample(`M${i}`, 'fresh', now - 3600_000, [0.5], 100, score);
    store.setSampleLow(`M${i}`, 'fresh', 100 * lowMult);
    store.updateSample(`M${i}`, 'fresh', 100 * peakMult, false, true);
  };
  for (let i = 0; i < 20; i++) add(i, 72, i < 5 ? 2.5 : 1.2, 0.6);
  assert.equal(store.similarOutcomes(70), null, '20 coins is not enough');
  for (let i = 20; i < 40; i++) add(i, 74, i < 25 ? 3 : 1.1, 0.5);
  add(99, 40, 10, 0.9); // a very different score is ignored
  store.outcomeCache = null;
  const o = store.similarOutcomes(70);
  assert.equal(o.n, 40);
  assert.equal(o.hit2, 25, '10 of 40 reached 2x');
  assert.ok(Math.abs(o.medianPeakPct - 20) < 1e-6, `median peak ${o.medianPeakPct}`);
  assert.ok(Math.abs(o.medianDropPct - 50) < 1e-6, `median drop ${o.medianDropPct}`);
});

test('mini chart follows the market cap over time', () => {
  const t0 = Date.now() - 10 * 60_000;
  const c = new Coin({ mint: 'M', name: 'A', symbol: 'A', traderPublicKey: 'D', signature: 's', initialBuy: 0, marketCapSol: 30 }, t0);
  for (let i = 1; i <= 10; i++) c.applyTrade({ signature: `s${i}`, traderPublicKey: `W${i}`, txType: 'buy', tokenAmount: 1, solAmount: 0.1, marketCapSol: 30 + i * 5 }, t0 + i * 60_000);
  const s = c.spark(10, 60 * 60_000, t0 + 10 * 60_000);
  assert.equal(s.length, 10);
  assert.ok(s[0] <= s.at(-1) && s.at(-1) === 80);
  assert.match(c.links().solscan, /solscan\.io\/token\/M$/);
  assert.match(c.links().rugcheck, /rugcheck\.xyz\/tokens\/M$/);
});
