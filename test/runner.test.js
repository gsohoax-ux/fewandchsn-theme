import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runnerScore } from '../src/score.js';
import { analyzeMomentum } from '../src/momentum.js';
import { PaperTrader } from '../src/paper.js';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';
import { config } from '../src/config.js';

const base = (over = {}) => ({
  safety: { verdict: 'SAFE', devClean: true }, narrative: { score: 85 }, momentum: { score: 75, whaleBuys: 2, whaleSol: 9, smartHolders: [] },
  confidence: { label: 'High' }, trend: { longevity: true, label: 'wizard goose', sources: ['Google', 'Wikipedia'] }, ...over,
});

test('runner score: strong story + momentum + whales on a SAFE coin', () => {
  const r = runnerScore(null, base());
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.ok(r.reasons.some((x) => x.includes('whale')));
  assert.equal(runnerScore(null, base({ safety: { verdict: 'CAUTION' } })).score, 0, 'never for coins that are not SAFE');
  const weak = runnerScore(null, base({ narrative: { score: 40 }, trend: null, momentum: { score: 40, whaleBuys: 0 }, confidence: { label: 'Low' } }));
  assert.ok(weak.score < config.runnerMin, `weak coin ${weak.score}`);
});

test('whale buys: big buys from real wallets, not insiders', () => {
  const c = new Coin({ mint: 'M', name: 'A', symbol: 'A', traderPublicKey: 'D', signature: 's', initialBuy: 0 }, Date.now() - 60_000);
  const buy = (w, sol) => c.applyTrade({ signature: `s${w}`, traderPublicKey: w, txType: 'buy', tokenAmount: 1e6, solAmount: sol, newTokenBalance: 1e6 });
  buy('WHALE', 5); buy('INSIDER', 8); buy('SMALL', 0.5);
  const m = analyzeMomentum(c, Date.now(), new Set(), new Set(['INSIDER']), 3);
  assert.equal(m.whaleBuys, 1);
  assert.equal(m.whaleSol, 5);
});

function coinAt(vSol) {
  const c = new Coin({ mint: 'MINTpump', name: 'T', symbol: 'T', traderPublicKey: 'D', signature: 's', initialBuy: 0 });
  setPrice(c, vSol); return c;
}
function setPrice(c, vSol) {
  c.vSol = vSol; c.vTokens = (30 * 1_073_000_000) / vSol; c.mcSol = (c.vSol / c.vTokens) * 1e9;
  c.progress = Math.max(0, Math.min(100, ((1_073_000_000 - c.vTokens) / 793_100_000) * 100));
}

test('runner trades get room: 25% taken near graduation, 30% moonbag, no 25-min exit', () => {
  const store = new Store(':memory:');
  const cfg = { ...config, paperDailyUsd: 0, paperStartSol: 2, paperTrailPct: 99, paperRunnerTrailPct: 99 };
  const t = new PaperTrader({ cfg, store, log: { info() {}, warn() {} }, getSolUsd: () => 150, moonbagWorthy: () => false });
  const coin = coinAt(40); const coins = new Map([[coin.mint, coin]]);
  const now = Date.now();
  t.open(coin, { stage: 'fresh', score: 80 }, coins, now);
  t.markRunner(coin.mint);                                   // turns out to be a runner after buying
  const tokens0 = t.positions.get(coin.mint).origTokens;
  t.tick(coins, now + 30 * 60_000);
  assert.equal(t.positions.size, 1, 'runners skip the no-follow-through exit');
  setPrice(coin, 105); t.onPrice(coin, coins, now + 31 * 60_000);
  assert.ok(Math.abs(t.positions.get(coin.mint).tokens - tokens0 * 0.75) < 1, 'only 25% sold near graduation');
  coin.migrated = true; t.onMigrate(coin, coins, now + 32 * 60_000);
  t.tick(coins, now + 38 * 60_000);
  const m = t.moonbags.get(coin.mint);
  assert.ok(m, 'runner keeps a moonbag even if the coin would not normally qualify');
  assert.ok(Math.abs(m.tokens - tokens0 * 0.30) < 1, '30% moonbag');
  assert.ok(store.paperTrades().some((r) => r.runner === 1));
});

test('a runner needs a catalyst: trend/viral post or whale buys', () => {
  const noCatalyst = runnerScore(null, base({ trend: null, momentum: { score: 75, whaleBuys: 0, smartHolders: [] } }));
  assert.ok(noCatalyst.score >= 60 && !noCatalyst.catalyst, 'good score but no catalyst');
  assert.ok(runnerScore(null, base()).catalyst);
  assert.ok(runnerScore(null, base({ trend: null })).catalyst, 'whales alone count');
});
