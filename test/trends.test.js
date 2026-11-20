import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleTrendsRss, parseWikiTop, parseReddit, TrendScanner, topicWords } from '../src/trends.js';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';
import { matchCoin } from '../src/xwatch.js';

const cfg = { trendGeo: 'US', trendPollMin: 15, trendSpikeTraffic: 200000, trendReddit: true, trendAlerts: true,
  trendAlertMin: 50, paperTz: 'UTC' };
const quiet = { info() {}, warn() {} };
const DAY = 86400_000;
const T0 = Date.parse('2026-11-20T12:00:00Z');

const RSS = `<?xml version="1.0"?><rss><channel><title>Daily Search Trends</title>
<item><title>wizard goose</title><ht:approx_traffic>500,000+</ht:approx_traffic>
<ht:news_item><ht:news_item_title><![CDATA[Goose in a wizard hat walks into city hall &amp; nobody stops it]]></ht:news_item_title></ht:news_item></item>
<item><title>knicks vs celtics</title><ht:approx_traffic>100,000+</ht:approx_traffic></item>
</channel></rss>`;

test('parses Google Trends RSS', () => {
  const items = parseGoogleTrendsRss(RSS);
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].phrase, items[0].traffic], ['wizard goose', 500000]);
  assert.match(items[0].detail, /city hall & nobody/);
});

test('parses Wikipedia top articles and skips non-articles', () => {
  const items = parseWikiTop({ items: [{ articles: [{ article: 'Main_Page', views: 9e6 }, { article: 'Special:Search', views: 1e6 },
    { article: 'Wizard_goose', views: 300000 }, { article: 'Deaths_in_2026', views: 200000 }] }] });
  assert.deepEqual(items.map((i) => i.phrase), ['Wizard goose']);
});

test('parses Reddit and keeps only names from long titles', () => {
  const items = parseReddit({ data: { children: [{ data: { title: 'This Wizard Goose at City Hall is my new hero', subreddit: 'aww', ups: 50000 } },
    { data: { title: 'nsfw thing', over_18: true } }] } });
  assert.equal(items.length, 1);
  const ws = topicWords(items[0]);
  assert.ok(ws.has('wizard') && ws.has('goose'));
  assert.ok(!ws.has('hero'), 'ordinary words are left out');
});

function scanner(fetchMap, over = {}) {
  const sent = [];
  const fetchFn = async (url) => {
    const key = Object.keys(fetchMap).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404 };
    const body = fetchMap[key];
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  };
  const s = new TrendScanner({ cfg: { ...cfg, ...over }, store: new Store(':memory:'), log: quiet, fetchFn,
    notifier: { trend: async (t) => sent.push(t) } });
  return { s, sent };
}

test('a trend counts only when it is on 2+ sites AND spiking or lasting', async () => {
  const wiki = { items: [{ articles: [{ article: 'Wizard_goose', views: 300000 }] }] };
  const reddit = { data: { children: [{ data: { title: 'Knicks fans celebrate after Celtics game', subreddit: 'nba', ups: 1000 } }] } };
  const { s, sent } = scanner({ 'trends.google.com': RSS, 'wikimedia.org': wiki, 'reddit.com': reddit });
  await s.poll(T0);
  const q = s.qualified(T0);
  const goose = q.find((t) => t.words.has('goose'));
  assert.ok(goose, 'wizard goose: Google + Wikipedia + big spike');
  assert.ok(goose.spike);
  assert.deepEqual(goose.active.sort(), ['google', 'wiki']);
  const knicks = [...s.topics.values()].find((t) => t.words.has('knicks'));
  assert.ok(knicks, 'knicks topic exists');
  assert.equal(s.assess(knicks, T0).qualified, false, 'knicks: 2 sites but 100k searches (no spike) and only 1 day');
  assert.equal(sent.length, 1, 'phone alert for the qualified trend');
  assert.equal(s.sourceStatus.google.ok, true);
});

test('lasting: seen on 2 sites over 2 days qualifies even without a spike', () => {
  const { s } = scanner({});
  s.ingest([{ source: 'google', phrase: 'office capybara', traffic: 50000 }], T0);
  s.ingest([{ source: 'reddit', phrase: 'Office Capybara promoted again', proper: true }], T0 + DAY);
  const t = [...s.topics.values()][0];
  const a = s.assess(t, T0 + DAY);
  assert.equal(a.days, 2);
  assert.ok(a.longevity && !a.spike && a.qualified);
});

test('one site alone never qualifies, however big', () => {
  const { s } = scanner({});
  s.ingest([{ source: 'google', phrase: 'huge thing', traffic: 5_000_000 }], T0);
  assert.equal(s.qualified(T0).length, 0);
});

test('topics persist across restarts and old ones are pruned', () => {
  const store = new Store(':memory:');
  const a = new TrendScanner({ cfg, store, log: quiet, fetchFn: async () => ({ ok: false }) });
  a.ingest([{ source: 'google', phrase: 'wizard goose', traffic: 500000 }, { source: 'x', phrase: 'wizard goose' }], T0);
  a.save();
  const b = new TrendScanner({ cfg, store, log: quiet, fetchFn: async () => ({ ok: false }) });
  assert.equal(b.qualified(T0).length, 1);
  b.prune(T0 + 8 * DAY);
  assert.equal(b.topics.size, 0);
});

test('coins match qualified trends by ticker or name', () => {
  const { s } = scanner({});
  s.ingest([{ source: 'google', phrase: 'wizard goose', traffic: 500000 }, { source: 'wiki', phrase: 'Wizard goose', views: 300000 }], T0);
  const targets = s.matchTargets(T0);
  const coin = (name, symbol) => { const c = new Coin({ mint: `M${symbol}`, name, symbol, traderPublicKey: 'D', signature: 's', initialBuy: 0 }); c.meta = { description: '' }; return c; };
  assert.ok(matchCoin(coin('Wizard Goose', 'WGOOSE'), targets).strength >= 0.7);
  assert.equal(matchCoin(coin('Office Capybara', 'CAPY'), targets), null);
});
