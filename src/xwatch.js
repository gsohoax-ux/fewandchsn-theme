// X (Twitter) watcher: finds new posts that are blowing up and could become meme coins,
// then lets the engine match Pump.fun coins to them.
//
// Data comes from the official X API v2 (needs an X developer "Bearer token", paid).
// Two inputs:
//   1. Posts from accounts you watch (X_WATCH_ACCOUNTS) + an optional search (X_SEARCH_QUERY)
//   2. Posts that new coins link to in their socials (looked up by id) - cheap and very useful
import { EventEmitter } from 'node:events';
import { words } from './narrative.js';

const clamp = (x) => Math.max(0, Math.min(100, x));
const compact = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** 0-100: how fast the post is gaining engagement right now. */
export function viralScore(post, now = Date.now()) {
  const m = post.metrics ?? {};
  const engagement = (m.likes ?? 0) + 2 * (m.retweets ?? 0) + 3 * (m.quotes ?? 0) + 0.5 * (m.replies ?? 0);
  const ageMin = Math.max(2, (now - post.createdAt) / 60_000);
  const velocity = engagement / ageMin;
  let s = (100 * velocity) / (velocity + 150);
  if (engagement > 20_000) s = Math.max(s, 80);
  return Math.round(clamp(s));
}

/** Words/phrases a coin about this post would likely use. */
export function extractKeywords(text) {
  const t = String(text ?? '').replace(/https?:\/\/\S+/g, ' ');
  const out = new Set();
  for (const m of t.matchAll(/[#$]([A-Za-z][A-Za-z0-9_]{2,20})/g)) out.add(m[1].toLowerCase());
  for (const m of t.matchAll(/["“]([^"”]{3,30})["”]/g)) out.add(m[1].toLowerCase().trim());
  // Capitalised words not at the start of a sentence (names, things)
  for (const m of t.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{3,}(?:\s[A-Z][a-z]{3,})?)\b/g)) out.add(m[1].toLowerCase());
  for (const w of words(t).filter((w) => w.length >= 5).slice(0, 4)) out.add(w);
  return [...out].slice(0, 10);
}

/** Without AI: viral + short + has a picture/video = more meme-able. */
export function ruleMemeScore(post) {
  let s = 0.6 * (post.viral ?? 0);
  if (post.hasMedia) s += 20;
  if ((post.text ?? '').length < 140) s += 10;
  return Math.round(clamp(s));
}

/** Best X post this coin is about, or null. */
export function matchCoin(coin, posts) {
  const sym = compact(coin.symbol);
  const name = compact(coin.name);
  const coinWords = new Set(words(`${coin.name} ${coin.symbol} ${coin.meta?.description ?? ''}`));
  const linked = String(coin.meta?.twitter ?? '').match(/status\/(\d+)/)?.[1];
  let best = null;
  for (const p of posts) {
    let strength = 0, how = '';
    if (linked && linked === p.id) { strength = 1; how = 'links this post'; }
    for (const kw of p.keywords ?? []) {
      const k = compact(kw);
      if (k.length < 3) continue;
      if (sym && sym === k && strength < 0.85) { strength = 0.85; how = `ticker matches "${kw}"`; }
      else if (k.length >= 4 && name.length >= 4 && (name.includes(k) || k.includes(name)) && strength < 0.7) {
        strength = 0.7; how = `name matches "${kw}"`;
      }
    }
    if (strength < 0.5) {
      const hits = (p.keywords ?? []).flatMap((k) => words(k)).filter((w) => coinWords.has(w));
      if (new Set(hits).size >= 2) { strength = 0.5; how = `shares words: ${[...new Set(hits)].slice(0, 3).join(', ')}`; }
    }
    if (!strength) continue;
    const rank = strength * (0.5 + (p.meme ?? 0) / 200);
    if (!best || rank > best.rank) best = { post: p, strength, how, rank };
  }
  return best;
}

export class XApiSource {
  constructor({ token, baseUrl = 'https://api.x.com' }) { this.token = token; this.baseUrl = baseUrl; }
  async #get(path, params) {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) throw new Error('X API rate limit - polling less often would help (X_POLL_SECONDS)');
    if (!res.ok) throw new Error(`X API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  }
  static #fields = {
    'tweet.fields': 'created_at,public_metrics,attachments,lang',
    expansions: 'author_id',
    'user.fields': 'username,public_metrics',
  };
  async search(query, sinceId) {
    const j = await this.#get('/2/tweets/search/recent', {
      query, max_results: '25', ...XApiSource.#fields, ...(sinceId ? { since_id: sinceId } : {}),
    });
    return { posts: normalizeTweets(j), newestId: j.meta?.newest_id ?? sinceId };
  }
  async lookup(ids) {
    if (!ids.length) return [];
    return normalizeTweets(await this.#get('/2/tweets', { ids: ids.slice(0, 100).join(','), ...XApiSource.#fields }));
  }
}

export function normalizeTweets(j) {
  const users = new Map((j?.includes?.users ?? []).map((u) => [u.id, u]));
  return (j?.data ?? []).map((t) => {
    const u = users.get(t.author_id) ?? {};
    const pm = t.public_metrics ?? {};
    return {
      id: t.id, text: t.text ?? '', author: u.username ?? '', followers: u.public_metrics?.followers_count ?? 0,
      createdAt: Date.parse(t.created_at) || Date.now(), hasMedia: Boolean(t.attachments?.media_keys?.length),
      url: `https://x.com/${u.username || 'i'}/status/${t.id}`,
      metrics: { likes: pm.like_count ?? 0, retweets: pm.retweet_count ?? 0, quotes: pm.quote_count ?? 0,
        replies: pm.reply_count ?? 0, views: pm.impression_count ?? 0 },
    };
  });
}

export class XWatcher extends EventEmitter {
  constructor({ source, ai, cfg, notifier, log = console }) {
    super();
    Object.assign(this, { source, ai, cfg, notifier, log });
    this.enabled = Boolean(source);
    this.posts = new Map();       // id -> post
    this.pendingLookups = new Set();
    this.sinceId = null;
    this.notified = [];           // timestamps of post notifications (rate limit)
    this.lastError = '';
    this.lastPollAt = 0;
  }

  get query() {
    const accts = this.cfg.xWatchAccounts;
    const parts = [];
    if (accts.length) parts.push(`(${accts.map((a) => `from:${a.replace(/^@/, '')}`).join(' OR ')})`);
    if (this.cfg.xSearchQuery) parts.push(`(${this.cfg.xSearchQuery})`);
    if (!parts.length) return '';
    return `(${parts.join(' OR ')}) -is:retweet -is:reply`;
  }

  start() {
    if (!this.enabled) return;
    const loop = async () => {
      await this.poll().catch((e) => { this.lastError = e.message; this.log.warn(`X: ${e.message}`); });
      setTimeout(loop, this.cfg.xPollSec * 1000).unref?.();
    };
    loop();
  }

  /** A new coin links to a post - look it up on the next poll. */
  trackLinkedPost(id) { if (this.enabled && id && !this.posts.has(id)) this.pendingLookups.add(id); }

  async poll(now = Date.now()) {
    this.lastPollAt = now;
    const fresh = [];
    if (this.query) {
      const { posts, newestId } = await this.source.search(this.query, this.sinceId);
      this.sinceId = newestId;
      for (const p of posts) if (!this.posts.has(p.id)) fresh.push({ ...p, origin: 'watched' });
    }
    // Look up posts coins link to, and refresh numbers on the promising ones
    const refresh = [...this.posts.values()]
      .filter((p) => now - p.createdAt < 6 * 3600_000 && (p.meme ?? 0) >= 50)
      .sort((a, b) => b.meme - a.meme).slice(0, 30).map((p) => p.id);
    const linked = [...this.pendingLookups].slice(0, 100 - refresh.length);
    linked.forEach((id) => this.pendingLookups.delete(id));
    if (linked.length || refresh.length) {
      for (const p of await this.source.lookup([...linked, ...refresh])) {
        const old = this.posts.get(p.id);
        if (old) Object.assign(old, { metrics: p.metrics, viral: viralScore(p, now), updatedAt: now });
        else fresh.push({ ...p, origin: 'coin-link' });
      }
    }

    for (const p of fresh) { p.viral = viralScore(p, now); p.firstSeen = now; p.keywords = [...new Set([...(p._kws ?? []), ...extractKeywords(p.text)])]; }
    await this.#scoreMemeability(fresh);
    for (const p of fresh) this.posts.set(p.id, p);

    // Forget old posts
    for (const [id, p] of this.posts) if (now - p.createdAt > this.cfg.xMaxPostAgeH * 3600_000) this.posts.delete(id);

    this.lastError = '';
    if (fresh.length) this.emit('posts', fresh);
    await this.#notifyHot(fresh, now);
  }

  async #scoreMemeability(posts) {
    for (const p of posts) { p.meme = ruleMemeScore(p); p.idea = ''; p.memeSource = 'rules'; }
    const worth = posts.filter((p) => p.viral >= this.cfg.xMinViralForAi || p.origin === 'coin-link');
    if (!this.ai?.enabled || !worth.length) return;
    for (let i = 0; i < worth.length; i += 15) {
      const batch = worth.slice(i, i + 15);
      try {
        const scored = await this.ai.scoreTweets(batch);
        for (const p of batch) {
          const s = scored.get(p.id);
          if (!s) continue;
          p.meme = clamp(Math.round(s.meme_score)); p.idea = s.idea; p.memeSource = 'ai';
          if (s.keywords?.length) p.keywords = [...new Set([...s.keywords.map((k) => k.toLowerCase()), ...p.keywords])].slice(0, 12);
        }
      } catch (e) { this.log.warn(`AI post scoring: ${e.message}`); }
    }
  }

  async #notifyHot(fresh, now) {
    if (!this.cfg.xPostAlerts || !this.notifier) return;
    this.notified = this.notified.filter((t) => now - t < 3600_000);
    const hot = fresh.filter((p) => p.origin === 'watched' && p.meme >= this.cfg.xPostAlertMin && p.viral >= 50)
      .sort((a, b) => b.meme - a.meme);
    for (const p of hot) {
      if (this.notified.length >= 6) break;
      this.notified.push(now);
      await this.notifier.post(p);
    }
  }

  match(coin) { return this.enabled || this.posts.size ? matchCoin(coin, [...this.posts.values()]) : null; }

  list(limit = 15) {
    return [...this.posts.values()]
      .sort((a, b) => (b.meme * 0.6 + b.viral * 0.4) - (a.meme * 0.6 + a.viral * 0.4))
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------------
// Demo: fake viral posts that match the demo coins' themes
// ---------------------------------------------------------------------------------
const DEMO_POSTS = [
  ['robodaily', 'A hamster just took over the AI datacenter and honestly the servers have never run better 🐹', ['robo hamster', 'hamster', 'rham']],
  ['pengufacts', 'This grumpy penguin refusing to walk with the group is all of us on a Monday', ['grumpy penguin', 'grump', 'penguin']],
  ['gooseupdate', 'A goose wearing a tiny wizard hat walked into city hall today. Nobody stopped him.', ['wizard goose', 'wgoose', 'goose']],
  ['capyzone', 'Office capybara has attended every meeting this quarter. Promoted to manager.', ['office capybara', 'capy', 'capybara']],
];

export class DemoXSource {
  constructor() { this.n = 0; this.made = []; }
  async search() {
    const posts = [];
    if (this.n < DEMO_POSTS.length) {
      const [author, text, kws] = DEMO_POSTS[this.n++];
      const id = String(1_900_000_000_000_000_000n + BigInt(this.n));
      const p = { id, text, author, followers: 2_000_000, createdAt: Date.now() - 6 * 60_000, hasMedia: true,
        url: `https://x.com/${author}/status/${id}`, _kws: kws,
        metrics: { likes: 9000 + this.n * 3000, retweets: 2500, quotes: 400, replies: 800, views: 900_000 } };
      this.made.push(p);
      posts.push(p);
    }
    return { posts, newestId: null };
  }
  async lookup(ids) {
    return this.made.filter((p) => ids.includes(p.id)).map((p) => ({ ...p,
      metrics: { ...p.metrics, likes: p.metrics.likes + 1500 } }));
  }
  /** Used by the demo feed so some fake coins link to these posts. */
  randomPostFor(symbol) { return this.made.find((p) => p._kws.includes(symbol.toLowerCase())); }
}
