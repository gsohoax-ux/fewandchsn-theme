import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/engine.js';
import { XWatcher } from '../src/xwatch.js';
import { Store } from '../src/store.js';
import { config } from '../src/config.js';

const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const cfg = { ...config, demo: false, radarMinCoins: 3, radarWindowMin: 60, radarAlerts: true };
  const sent = [];
  const notifier = { post: async (p) => sent.push(p), alert: async () => {}, warn: async () => {}, channels: [] };
  const feed = Object.assign(new EventEmitter(), { watch() {}, unwatch() {}, start() {} });
  const xwatch = new XWatcher({ source: null, cfg, notifier, log: { warn() {} } });
  const engine = new Engine({ cfg, feed, chain: null, store: new Store(':memory:'), notifier, xwatch, log: { info() {}, warn() {} } });
  return { engine, xwatch, sent };
}

const launch = (engine, i, twitter, name = 'Grumpy Penguin', symbol = 'GRUMP') => engine.onCreate({
  mint: `MINT${i}pump`, name, symbol, traderPublicKey: `DEV${i}`, signature: `sig${i}`, initialBuy: 1e6,
  _meta: { description: '', twitter },
});

test('tweet radar: 3 coins linking one post creates a radar post and matches the coins (no X key)', async () => {
  const { engine, xwatch, sent } = setup();
  const url = 'https://x.com/pengufacts/status/555';
  launch(engine, 1, url); launch(engine, 2, url);
  await tick();
  assert.equal(xwatch.posts.size, 0, 'two coins are not enough');
  launch(engine, 3, url, 'Penguin Sad', 'PSAD');
  await tick();
  const p = xwatch.posts.get('555');
  assert.ok(p, 'radar post created');
  assert.equal(p.origin, 'radar');
  assert.equal(p.author, 'pengufacts');
  assert.equal(p.radarCoins, 3);
  assert.ok(p.keywords.includes('penguin'));
  assert.equal(sent.length, 1, 'one radar notification');
  for (const i of [1, 2, 3]) assert.equal(engine.coins.get(`MINT${i}pump`).xMatch?.post.id, '555');

  // a 4th coin updates the count without a second notification
  launch(engine, 4, url);
  await tick();
  assert.equal(xwatch.posts.get('555').radarCoins, 4);
  assert.equal(sent.length, 1);

  // a coin that doesn't link the post but uses the same name still matches by keywords
  launch(engine, 5, '', 'Grumpy Penguin Classic', 'GPC');
  await tick();
  engine.coins.get('MINT5pump').xMatch = null;
  const view = engine.xPosts();
  assert.equal(view[0].origin, 'radar');
  assert.equal(view[0].coins.length, 4);
});

test('tweet radar ignores coins that link different posts', async () => {
  const { engine, xwatch } = setup();
  launch(engine, 1, 'https://x.com/a/status/1');
  launch(engine, 2, 'https://x.com/a/status/2');
  launch(engine, 3, 'https://x.com/a/status/3');
  await tick();
  assert.equal(xwatch.posts.size, 0);
});
