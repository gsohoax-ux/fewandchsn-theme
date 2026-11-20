import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeployTool, imageKey, CopyIndex } from '../src/copies.js';
import { Coin } from '../src/coin.js';
import { Learner, FEATURES } from '../src/learn.js';
import { Store } from '../src/store.js';
import { analyzeSafety } from '../src/safety.js';

const coin = (mint, name, symbol, meta = {}) => {
  const c = new Coin({ mint, name, symbol, traderPublicKey: 'D', signature: 's', initialBuy: 0 });
  c.meta = meta;
  return c;
};

test('spots J7 and other quick-deploy tags', () => {
  assert.equal(detectDeployTool({ description: 'goose with a hat Deployed using https://j7tracker.io' }), 'J7');
  assert.equal(detectDeployTool({ description: 'launched via fastlaunch.xyz' }), 'quick deploy');
  assert.equal(detectDeployTool({ description: 'Deployed using my-tool' }, ['my-tool']), 'my-tool');
  assert.equal(detectDeployTool({ description: 'just a goose' }), null);
  assert.equal(detectDeployTool(null), null);
});

test('image fingerprints use the IPFS id whatever the gateway', () => {
  const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  assert.equal(imageKey(`https://ipfs.io/ipfs/${cid}`), cid);
  assert.equal(imageKey(`https://cf-ipfs.com/ipfs/${cid}`), cid);
  assert.equal(imageKey(`ipfs://${cid}`), cid);
});

test('copies: same image or same name+ticker as an earlier coin', () => {
  const idx = new CopyIndex();
  const t0 = Date.now();
  const img = 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const orig = coin('A', 'Wizard Goose', 'WGOOSE', { image: img });
  assert.equal(idx.originalOf(orig, t0), null);
  idx.add(orig, t0);
  const sameImage = coin('B', 'Goose Wizard', 'GWIZ', { image: img.replace('ipfs.io', 'cf-ipfs.com') });
  assert.deepEqual([idx.originalOf(sameImage, t0 + 60_000).symbol, idx.originalOf(sameImage, t0 + 60_000).how], ['WGOOSE', 'same image']);
  const sameName = coin('C', 'Wizard  Goose!', 'wgoose', {});
  assert.equal(idx.originalOf(sameName, t0 + 60_000).how, 'same name and ticker');
  assert.equal(idx.originalOf(coin('D', 'Office Capybara', 'CAPY', {}), t0), null);
  assert.equal(idx.originalOf(sameImage, t0 + 25 * 3600_000), null, 'only within 24h');
});

test('shown as info flags, never changing the safety verdict on their own', () => {
  const c = coin('B', 'Goose Wizard', 'GWIZ', {});
  const r = analyzeSafety(c, { source: 'timing', slots: null, wallets: new Map(), services: new Set(), errors: [] },
    { cfg: { maxBundlePct: 15, maxDevPct: 8, maxTop10Pct: 35 }, devLaunches24h: 0, recycledSocials: [],
      deployTool: 'J7', copyOf: { symbol: 'WGOOSE', at: Date.now() - 120_000, how: 'same image' } });
  assert.ok(r.flags.some((f) => f.level === 'info' && f.text.startsWith('Launched with J7')));
  assert.ok(r.flags.some((f) => f.level === 'info' && f.text.startsWith('Copy of $WGOOSE launched 2 min earlier')));
  assert.equal(r.verdict, 'SAFE');
});

test('learning keeps older history when new signals are added', () => {
  const store = new Store(':memory:');
  const old = FEATURES.length - 2; // samples recorded before the two new signals existed
  for (let i = 0; i < 400; i++) {
    const x = new Array(old).fill(0).map((_, j) => ((i * 7 + j * 3) % 10) / 10);
    store.addSample(`M${i}`, 'fresh', 1000 + i, x, 50);
    store.updateSample(`M${i}`, 'fresh', i % 5 === 0 ? 90 : 55, false, true);
  }
  const l = new Learner({ store, cfg: { learnTarget: 1.5, learnMinSamples: 300, learnMinLift: 1.3, learnEveryMin: 30, learnMaxSamples: 20000 }, log: { info() {} } });
  l.train();
  assert.equal(l.model.n, 400, 'all old samples used');
  assert.equal(l.model.features, FEATURES.length);
});
