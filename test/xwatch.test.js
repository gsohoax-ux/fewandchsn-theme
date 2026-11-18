import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coin } from '../src/coin.js';
import { viralScore, extractKeywords, matchCoin, normalizeTweets, XWatcher } from '../src/xwatch.js';
import { computeConfidence, meter } from '../src/confidence.js';

const NOW = 1_700_000_000_000;
const coin = (name, symbol, twitter = '') => {
  const c = new Coin({ mint: `M${symbol}`, name, symbol, traderPublicKey: 'DEV', signature: 's', initialBuy: 1e6 }, NOW);
  c.meta = { description: '', twitter };
  return c;
};
const post = (over = {}) => ({
  id: '111', text: 'A goose wearing a tiny Wizard hat walked into city hall', author: 'news', followers: 1e6,
  createdAt: NOW - 10 * 60_000, hasMedia: true, keywords: ['wizard goose', 'goose', 'wgoose'], meme: 80, viral: 70,
  metrics: { likes: 5000, retweets: 1000, quotes: 100, replies: 200 }, ...over,
});

test('viral score: fast engagement scores high, slow scores low', () => {
  const hot = viralScore({ createdAt: NOW - 5 * 60_000, metrics: { likes: 6000, retweets: 1500 } }, NOW);
  const cold = viralScore({ createdAt: NOW - 600 * 60_000, metrics: { likes: 300, retweets: 10 } }, NOW);
  assert.ok(hot >= 80, `hot ${hot}`);
  assert.ok(cold < 10, `cold ${cold}`);
});

test('keywords come from hashtags, quotes and names', () => {
  const k = extractKeywords('Breaking: the "Wizard Goose" is real #WGOOSE says Mayor Johnson https://t.co/x');
  assert.ok(k.includes('wizard goose'));
  assert.ok(k.includes('wgoose'));
  assert.ok(k.includes('mayor johnson'));
  assert.ok(!k.some((w) => w.includes('t.co')));
});

test('coins match posts by link, ticker or name; unrelated coins do not', () => {
  const p = post();
  assert.equal(matchCoin(coin('Anything', 'ABC', 'https://x.com/news/status/111'), [p]).strength, 1);
  assert.equal(matchCoin(coin('Gandalf Bird', 'WGOOSE'), [p]).strength, 0.85);
  assert.equal(matchCoin(coin('Wizard Goose', 'WIZ'), [p]).strength, 0.7);
  assert.equal(matchCoin(coin('Office Capybara', 'CAPY'), [p]), null);
});

test('normalizes X API v2 responses', () => {
  const [t] = normalizeTweets({
    data: [{ id: '9', text: 'hi', author_id: 'u1', created_at: '2026-11-18T10:00:00Z',
      public_metrics: { like_count: 5, retweet_count: 2, quote_count: 1, reply_count: 0 }, attachments: { media_keys: ['m'] } }],
    includes: { users: [{ id: 'u1', username: 'bob', public_metrics: { followers_count: 42 } }] },
  });
  assert.equal(t.author, 'bob');
  assert.equal(t.url, 'https://x.com/bob/status/9');
  assert.equal(t.metrics.likes, 5);
  assert.ok(t.hasMedia);
});

test('watcher polls, scores posts, looks up coin-linked posts and notifies hot ones once', async () => {
  const fresh = post({ id: '222', createdAt: Date.now() - 5 * 60_000, metrics: { likes: 20000, retweets: 5000, quotes: 500, replies: 900 } });
  const looked = [];
  const source = {
    async search() { return { posts: [fresh], newestId: '222' }; },
    async lookup(ids) { looked.push(...ids); return ids.includes('333') ? [post({ id: '333', createdAt: Date.now() })] : []; },
  };
  const sent = [];
  const cfg = { xWatchAccounts: ['news'], xSearchQuery: '', xPollSec: 999, xMaxPostAgeH: 12, xMinViralForAi: 25,
    xPostAlerts: true, xPostAlertMin: 60 };
  const w = new XWatcher({ source, cfg, notifier: { post: async (p) => sent.push(p.id) }, log: { warn() {} } });
  assert.match(w.query, /from:news/);
  w.trackLinkedPost('333');
  await w.poll();
  assert.ok(w.posts.has('222') && w.posts.has('333'));
  assert.ok(looked.includes('333'));
  assert.deepEqual(sent, ['222']);
  await w.poll();
  assert.deepEqual(sent, ['222'], 'not notified twice');
});

test('confidence is low with thin data and high with solid data', () => {
  const c = coin('Wizard Goose', 'WG');
  const thin = computeConfidence(c, {
    score: 70, safety: { source: 'timing', score: 90 }, narrative: { source: 'rules', score: 30 }, momentum: { score: 80 },
  }, { runnersSeen: 0 });
  for (let i = 0; i < 40; i++) c.buyers.add(`b${i}`);
  c.createdAt = Date.now() - 5 * 60_000;
  c.meta = { description: 'a goose', twitter: '' };
  const solid = computeConfidence(c, {
    score: 75, safety: { source: 'chain', score: 80 }, narrative: { source: 'ai', score: 75 }, momentum: { score: 72 },
    x: { viral: 80 },
  }, { runnersSeen: 10, history: { n: 20, hits: 9 } });
  assert.equal(thin.label, 'Low');
  assert.equal(solid.label, 'High');
  assert.equal(solid.track.hitPct, 45);
  assert.equal(meter(60), '▰▰▰▱▱');
});
