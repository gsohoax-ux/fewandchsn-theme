import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { PaperTrader } from '../src/paper.js';
import { Coin } from '../src/coin.js';
import { config } from '../src/config.js';

function engine(over = {}) {
  const cfg = { ...config, demo: false, ...over };
  const feed = Object.assign(new EventEmitter(), { watch() {}, unwatch() {}, start() {} });
  const notifier = { alert: async () => {}, warn: async () => {}, info: async () => {}, channels: [] };
  return new Engine({ cfg, feed, chain: null, store: new Store(':memory:'), notifier, log: { info() {}, warn() {} } });
}

test('adaptive bar: uses the fixed bar until there is enough data', () => {
  const e = engine();
  assert.equal(e.alertBar(), config.alertMinScore);
});

test('adaptive bar: aims for the target number of alerts a day, within floor and ceiling', () => {
  const now = Date.now();
  // 240 clean coins scored over the last 4h = 60/hour. Target 15/day = 0.625/hour -> top ~1% of scores.
  const scores = (lo, hi) => Array.from({ length: 240 }, (_, i) => [now - (240 - i) * 60_000, lo + ((i * 37) % (hi - lo + 1))]);
  const quiet = engine(); quiet.scoreLog = scores(30, 62);
  assert.equal(quiet.alertBar(now), 62, 'quiet market: the best coins (62) still alert, instead of nothing at 65');
  const weak = engine(); weak.scoreLog = scores(20, 50);
  assert.equal(weak.alertBar(now), 58, 'never below the floor');
  const hot = engine(); hot.scoreLog = scores(60, 95);
  assert.equal(hot.alertBar(now), 80, 'never above the ceiling');
  const off = engine({ alertTargetPerDay: 0 }); off.scoreLog = scores(30, 62);
  assert.equal(off.alertBar(now), config.alertMinScore, 'adaptive mode can be turned off');
});

test('top picks: only SAFE, live, recently scored coins above the floor, best first', () => {
  const e = engine();
  const now = Date.now();
  const add = (mint, score, verdict, extra = {}) => {
    const c = new Coin({ mint, name: mint, symbol: mint, traderPublicKey: 'D', signature: 's', initialBuy: 0 }, now - 60_000);
    c.result = { score, safety: { verdict }, confidence: { label: 'Medium' } };
    c.lastEvalAt = now - 60_000;
    Object.assign(c, extra);
    e.coins.set(mint, c);
  };
  add('A', 70, 'SAFE'); add('B', 85, 'SAFE'); add('C', 90, 'AVOID'); add('D', 75, 'CAUTION');
  add('E', 80, 'SAFE', { migrated: true }); add('F', 40, 'SAFE'); add('G', 72, 'SAFE');
  assert.deepEqual(e.topPicks(3, now).map((c) => c.mint), ['B', 'G', 'A']);
});

test('paper: uses the smallest size that keeps fees under the limit instead of skipping', () => {
  const cfg = { ...config, paperDailyUsd: 0, paperStartSol: 0.1 };
  const t = new PaperTrader({ cfg, store: new Store(':memory:'), log: { info() {}, warn() {} } });
  const coin = new Coin({ mint: 'M', name: 'T', symbol: 'T', traderPublicKey: 'D', signature: 's', initialBuy: 0 });
  coin.vSol = 40; coin.vTokens = (30 * 1_073_000_000) / 40; coin.mcSol = (coin.vSol / coin.vTokens) * 1e9;
  const pos = t.open(coin, { stage: 'fresh', score: 70 }, new Map([[coin.mint, coin]]));
  const minTicket = (2 * cfg.paperTxFeeSol) / (cfg.paperMaxFixedCostPct / 100);
  assert.ok(pos, 'traded instead of skipped');
  assert.ok(Math.abs(pos.costSol - minTicket) < 1e-9, `size ${pos.costSol} = minimum ${minTicket}`);
});
