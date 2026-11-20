// Trend scanner: finds what's trending across several sites, keeps only trends that are on
// MULTIPLE sites AND either spiking hard or lasting several days, writes a short thesis for each,
// and lets the engine match Pump.fun coins to them. All sources are free and need no keys:
//   - Google Trends "trending now" (search volume: the spike signal)
//   - Wikipedia most-viewed articles (multi-day attention: the longevity signal)
//   - Reddit r/popular (memes and viral moments)
//   - X posts the tweet radar / X watcher found, and themes of coins pumping on Pump.fun
import { EventEmitter } from 'node:events';
import { words } from './narrative.js';
import { extractKeywords } from './xwatch.js';
import { dayKey } from './paper.js';

const UA = 'memecoin-bot/1.0 (personal trend research)';
const SOURCE_NAMES = { google: 'Google', wiki: 'Wikipedia', reddit: 'Reddit', x: 'X', pumpfun: 'Pump.fun' };
const decode = (s) => String(s ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// ---------------------------------------------------------------- parsers (pure, tested)
export function parseGoogleTrendsRss(xml) {
  return String(xml ?? '').split('<item>').slice(1).map((it) => {
    const title = decode(it.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const traffic = Number((it.match(/<ht:approx_traffic>([\d,.]+)/)?.[1] ?? '0').replace(/[,.]/g, ''));
    const news = [...it.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((m) => decode(m[1])).slice(0, 3);
    return { source: 'google', phrase: title, traffic, detail: news[0] ?? '' };
  }).filter((x) => x.phrase);
}

const WIKI_SKIP = /^(Main_Page|Special:|Wikipedia:|File:|Portal:|Help:|Template:|Category:|Talk:|User:|Deaths_in_|List_of_|Cleopatra$|XXX)/;
export function parseWikiTop(json, limit = 60) {
  const arts = json?.items?.[0]?.articles ?? [];
  return arts.filter((a) => !WIKI_SKIP.test(a.article)).slice(0, limit)
    .map((a) => ({ source: 'wiki', phrase: decode(a.article.replace(/_/g, ' ')), views: a.views ?? 0, key: a.article }));
}

export function parseReddit(json, limit = 50) {
  return (json?.data?.children ?? []).slice(0, limit).map((c) => c.data ?? {})
    .filter((d) => d.title && !d.over_18 && !d.stickied)
    .map((d) => ({ source: 'reddit', phrase: d.title, score: d.ups ?? 0, detail: `r/${d.subreddit}`, proper: true }));
}

/** Meaningful words of a trend phrase. Reddit titles are long, so keep only names / capitalised words there. */
export function topicWords(item) {
  if (item.proper) {
    const kws = extractKeywords(item.phrase).flatMap((k) => words(k));
    return new Set(kws.filter((w) => w.length >= 4).slice(0, 6));
  }
  return new Set(words(item.phrase).filter((w) => w.length >= 3).slice(0, 6));
}

// ---------------------------------------------------------------- scanner
export class TrendScanner extends EventEmitter {
  constructor({ cfg, store, ai = null, notifier = null, log = console, fetchFn = fetch, extraItems = () => [], demo = false }) {
    super();
    Object.assign(this, { cfg, store, ai, notifier, log, fetchFn, extraItems, demo });
    this.topics = new Map();
    this.sourceStatus = {};
    this.notified = [];
    this.wikiPrev = new Map(); // article -> views the day before (for spikes)
    this.lastWikiDay = null;
    this.load();
  }

  load() {
    for (const t of this.store.getKv('trends') ?? []) {
      this.topics.set(t.key, { ...t, words: new Set(t.words), days: new Set(t.days), sources: new Map(t.sources) });
    }
  }

  save() {
    this.store.setKv('trends', [...this.topics.values()].map((t) => ({ ...t, words: [...t.words], days: [...t.days], sources: [...t.sources] })));
  }

  start() {
    const loop = async () => {
      try { await this.poll(); } catch (e) { this.log.warn(`trends: ${e.message}`); }
      setTimeout(loop, (this.demo ? 0.25 : this.cfg.trendPollMin) * 60_000).unref?.();
    };
    setTimeout(loop, 5000).unref?.();
  }

  async #get(url, as = 'json') {
    const res = await this.fetchFn(url, { headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return as === 'json' ? res.json() : res.text();
  }

  async #source(name, fn) {
    try {
      const items = await fn();
      this.sourceStatus[name] = { ok: true, at: Date.now(), count: items.length };
      return items;
    } catch (e) {
      this.sourceStatus[name] = { ok: false, at: Date.now(), error: e.message };
      return [];
    }
  }

  async fetchAll(now = Date.now()) {
    if (this.demo) return demoItems(now);
    const geo = this.cfg.trendGeo;
    const jobs = [this.#source('google', async () => parseGoogleTrendsRss(await this.#get(`https://trends.google.com/trending/rss?geo=${geo}`, 'text')))];
    // Wikipedia publishes yesterday's top articles once a day
    const yday = new Date(now - 86400_000).toISOString().slice(0, 10);
    if (this.lastWikiDay !== yday) {
      jobs.push(this.#source('wiki', async () => {
        const path = (iso) => `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${iso.replace(/-/g, '/')}`;
        const prevIso = new Date(now - 2 * 86400_000).toISOString().slice(0, 10);
        const [cur, prev] = await Promise.all([this.#get(path(yday)), this.#get(path(prevIso)).catch(() => null)]);
        this.wikiPrev = new Map((prev?.items?.[0]?.articles ?? []).map((a) => [a.article, a.views]));
        this.lastWikiDay = yday;
        return parseWikiTop(cur);
      }));
    }
    if (this.cfg.trendReddit) jobs.push(this.#source('reddit', async () => parseReddit(await this.#get('https://www.reddit.com/r/popular/hot.json?limit=50'))));
    return (await Promise.all(jobs)).flat();
  }

  async poll(now = Date.now()) {
    const items = [...await this.fetchAll(now), ...this.extraItems()];
    const before = new Set(this.qualified(now).map((t) => t.key));
    this.ingest(items, now);
    this.prune(now);
    await this.#theses(now);
    this.save();
    const fresh = this.qualified(now).filter((t) => !before.has(t.key));
    if (fresh.length) this.log.info(`Trends: ${fresh.length} new qualified trend(s): ${fresh.map((t) => t.label).join(', ')}`);
    this.emit('topics');
    await this.#notify(fresh, now);
  }

  /** Merge sightings into topics. Items about the same thing (shared words) join one topic. */
  ingest(items, now = Date.now()) {
    const day = dayKey(now, this.cfg.paperTz);
    for (const item of items) {
      const ws = topicWords(item);
      if (!ws.size) continue;
      let topic = null, best = 0;
      for (const t of this.topics.values()) {
        const overlap = [...ws].filter((w) => t.words.has(w)).length;
        const need = Math.min(2, ws.size, t.words.size);
        if (overlap >= need && overlap > best) { topic = t; best = overlap; }
      }
      if (!topic) {
        topic = { key: [...ws].sort().join('-'), label: item.phrase.slice(0, 60), words: new Set(ws), days: new Set(),
          sources: new Map(), firstSeen: now, lastSeen: now, peakTraffic: 0, peakViews: 0, wikiJump: 0, details: [],
          meme: null, thesis: '', kind: '', ideas: [], keywords: [], thesisAt: 0, notified: false };
        this.topics.set(topic.key, topic);
      }
      if (item.source === 'google' || (item.source === 'wiki' && !topic.sources.has('google'))) topic.label = item.phrase.slice(0, 60);
      topic.sources.set(item.source, now);
      topic.days.add(day);
      topic.lastSeen = now;
      if (item.traffic) topic.peakTraffic = Math.max(topic.peakTraffic, item.traffic);
      if (item.views) {
        topic.peakViews = Math.max(topic.peakViews, item.views);
        const prev = this.wikiPrev.get(item.key);
        topic.wikiJump = Math.max(topic.wikiJump, prev ? item.views / prev : item.views >= 200_000 ? 10 : 1);
      }
      if (item.detail && !topic.details.includes(item.detail)) topic.details = [item.detail, ...topic.details].slice(0, 4);
    }
  }

  prune(now = Date.now()) {
    for (const [k, t] of this.topics) if (now - t.lastSeen > 7 * 86400_000) this.topics.delete(k);
    if (this.topics.size > 3000) {
      const old = [...this.topics.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, this.topics.size - 3000);
      for (const t of old) this.topics.delete(t.key);
    }
  }

  /** Multi-site + (spike or longevity) = a trend worth watching. */
  assess(t, now = Date.now()) {
    const active = [...t.sources].filter(([, at]) => now - at < 48 * 3600_000).map(([s]) => s); // sites seen in the last 2 days
    const days = t.days.size;
    const spike = t.peakTraffic >= this.cfg.trendSpikeTraffic || t.wikiJump >= 3 || (active.length >= 3 && now - t.firstSeen < 6 * 3600_000);
    const longevity = days >= 2;
    const qualified = active.length >= 2 && (spike || longevity);
    let score = 15 * Math.min(active.length, 4) + (spike ? 20 : 0) + Math.min(20, (days - 1) * 7);
    if (t.peakTraffic) score += Math.min(15, Math.max(0, Math.log10(t.peakTraffic) - 3) * 5);
    return { active, days, spike, longevity, qualified, score: Math.min(100, Math.round(score)) };
  }

  qualified(now = Date.now()) {
    return [...this.topics.values()].map((t) => ({ ...t, ...this.assess(t, now) })).filter((t) => t.qualified)
      .sort((a, b) => (b.score + (b.meme ?? 50)) - (a.score + (a.meme ?? 50)));
  }

  async #theses(now) {
    const need = this.qualified(now).filter((t) => now - t.thesisAt > 6 * 3600_000).slice(0, 10);
    for (const t of need) {
      const topic = this.topics.get(t.key);
      topic.thesisAt = now;
      topic.kind = t.spike && t.longevity ? 'spike + lasting' : t.spike ? 'spike' : 'lasting';
      if (topic.meme == null) {
        topic.meme = 45 + (t.spike ? 10 : 0) + (t.active.includes('x') || t.active.includes('pumpfun') ? 15 : 0);
        topic.thesis = `On ${t.active.map((s) => SOURCE_NAMES[s]).join(', ')}${t.days > 1 ? ` for ${t.days} days` : ''}${t.spike ? ', spiking' : ''}.`;
      }
    }
    if (!this.ai?.enabled || !need.length) return;
    try {
      const out = await this.ai.trendTheses(need.map((t) => ({ id: t.key, label: t.label, sources: t.active.map((s) => SOURCE_NAMES[s]),
        days: t.days, spike: t.spike, traffic: t.peakTraffic, views: t.peakViews, details: t.details })));
      for (const t of need) {
        const r = out.get(t.key);
        if (!r) continue;
        Object.assign(this.topics.get(t.key), {
          meme: Math.max(0, Math.min(100, Math.round(r.meme_score))), thesis: r.thesis, ideas: (r.coin_ideas ?? []).slice(0, 4),
          keywords: (r.keywords ?? []).map((k) => String(k).toLowerCase()).slice(0, 8), aiKind: r.kind,
        });
      }
    } catch (e) { this.log.warn(`AI trend thesis: ${e.message}`); }
  }

  async #notify(fresh, now) {
    if (!this.cfg.trendAlerts || !this.notifier) return;
    this.notified = this.notified.filter((t) => now - t < 3600_000);
    for (const t of fresh.sort((a, b) => (b.meme ?? 0) - (a.meme ?? 0))) {
      const topic = this.topics.get(t.key);
      if (topic.notified || (topic.meme ?? 0) < this.cfg.trendAlertMin || this.notified.length >= 6) continue;
      topic.notified = true; this.notified.push(now);
      await this.notifier.trend({ ...t, ...topic, sources: t.active.map((s) => SOURCE_NAMES[s]) });
    }
    this.save();
  }

  /** Qualified trends as match targets for coins (same shape the X matcher uses). */
  matchTargets(now = Date.now()) {
    return this.qualified(now).map((t) => ({
      id: `trend:${t.key}`, key: t.key, meme: t.meme ?? 50,
      keywords: [...new Set([t.label.toLowerCase(), ...(t.keywords ?? []), ...(t.ideas ?? []).map((i) => i.toLowerCase().replace(/\(.*?\)|\$/g, '').trim()), ...t.words])],
    }));
  }

  view(now = Date.now(), limit = 12) {
    const all = [...this.topics.values()].map((t) => ({ ...t, ...this.assess(t, now) }))
      .sort((a, b) => (Number(b.qualified) - Number(a.qualified)) || (b.score - a.score)).slice(0, limit);
    return {
      sources: Object.fromEntries(Object.entries(this.sourceStatus).map(([k, v]) => [SOURCE_NAMES[k] ?? k, v])),
      topics: all.map((t) => ({ key: t.key, label: t.label, sources: t.active.map((s) => SOURCE_NAMES[s]), days: t.days, spike: t.spike,
        longevity: t.longevity, qualified: t.qualified, score: t.score, meme: t.meme, thesis: t.thesis, ideas: t.ideas ?? [],
        kind: t.aiKind || t.kind, traffic: t.peakTraffic, views: t.peakViews, firstSeen: t.firstSeen })),
    };
  }
}

// ---------------------------------------------------------------- demo
function demoItems(now) {
  const m = Math.floor(now / 60_000) % 4;
  return [
    { source: 'google', phrase: 'wizard goose', traffic: 500_000, detail: 'Goose in a wizard hat walks into city hall' },
    { source: 'wiki', phrase: 'Wizard goose', views: 250_000, key: 'Wizard_goose' },
    { source: 'reddit', phrase: 'This Wizard Goose at City Hall is my new hero', score: 40_000, detail: 'r/aww', proper: true },
    { source: 'google', phrase: 'office capybara', traffic: 100_000, detail: 'Capybara attends every meeting' },
    ...(m % 2 ? [{ source: 'reddit', phrase: 'Office Capybara promoted to manager', score: 9000, detail: 'r/funny', proper: true }] : []),
    { source: 'google', phrase: 'stock market today', traffic: 200_000 },
  ];
}
