import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiNarrator } from '../src/narrative.js';
import { Coin } from '../src/coin.js';

function fakeClient(calls) {
  const reply = (p) => {
    calls.push(p);
    const isTweets = JSON.stringify(p.output_config.format.schema).includes('meme_score');
    const body = isTweets
      ? { items: [{ id: '1', meme_score: 77, idea: 'Wizard Goose ($WGOOSE)', keywords: ['wizard goose'] }] }
      : { score: 81, theme: 'wizard goose', freshness: 'fresh', summary: 'Timely and funny.', red_flags: [] };
    return Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] });
  };
  return { messages: { create: (p) => reply({ ...p, path: 'messages' }) }, beta: { messages: { create: (p) => reply({ ...p, path: 'beta' }) } } };
}

const coin = () => {
  const c = new Coin({ mint: 'M', name: 'Wizard Goose', symbol: 'WGOOSE', traderPublicKey: 'D', signature: 's', initialBuy: 0 });
  c.meta = { description: 'goose with a staff', twitter: 'https://x.com/a/status/1' };
  return c;
};
const ctx = { hotThemes: [{ word: 'goose', count: 3 }], recentRunners: [], copies: 0, sameTweetCoins: 0 };

test('Haiku: plain request, no fallback option; answer parsed', async () => {
  const calls = [];
  const ai = new AiNarrator({ apiKey: 'test', model: 'claude-haiku-5-5', maxPerHour: 10 });
  ai.client = fakeClient(calls);
  const r = await ai.score(coin(), ctx, { summary: 'rules' });
  assert.equal(calls[0].path, 'messages');
  assert.equal(calls[0].fallbacks, undefined);
  assert.equal(calls[0].betas, undefined);
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.equal(calls[0].output_config.effort, 'low');
  assert.deepEqual({ score: r.score, source: r.source }, { score: 81, source: 'ai' });
});

test('Opus: beta request with server-side fallback', async () => {
  const calls = [];
  const ai = new AiNarrator({ apiKey: 'test', model: 'claude-opus-5-5', maxPerHour: 10 });
  ai.client = fakeClient(calls);
  await ai.score(coin(), ctx, { summary: 'rules' });
  assert.equal(calls[0].path, 'beta');
  assert.equal(calls[0].fallbacks, 'default');
  assert.deepEqual(calls[0].betas, ['server-side-fallback-2026-07-01']);
});

test('X post scoring and the hourly cap', async () => {
  const calls = [];
  const ai = new AiNarrator({ apiKey: 'test', model: 'claude-haiku-5-5', maxPerHour: 1 });
  ai.client = fakeClient(calls);
  const m = await ai.scoreTweets([{ id: '1', author: 'a', followers: 1, text: 'goose', hasMedia: true, metrics: { likes: 5, retweets: 1 } }]);
  assert.equal(m.get('1').meme_score, 77);
  await assert.rejects(() => ai.score(coin(), ctx, { summary: 'rules' }), /hourly budget/);
});

test('no key: AI stays off', () => {
  assert.equal(new AiNarrator({ apiKey: '', model: 'claude-haiku-5-5', maxPerHour: 10 }).enabled, false);
});
