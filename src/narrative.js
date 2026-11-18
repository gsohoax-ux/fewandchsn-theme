// Narrative: what is the coin about, does it fit what's running right now, is it original?

const STOP = new Set(('the and for you are with this that coin token sol solana pump fun official ' +
  'community just from will your our not have has its it\'s was get all new now first only real ' +
  'meme memecoin who what when how why can one out more about into they them their there did does doing done ' +
  'never ever every today been being were than then too very much many some such also just like over under after before ' +
  'but ask asked here where while because could would should might must make made take took got going gone said says year years').split(' '));

export function words(text) {
  return [...new Set((text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

/** Parse an X/Telegram URL into a stable key. */
export function socialKey(url) {
  if (!url) return null;
  const u = String(url).trim().toLowerCase();
  let m = u.match(/(?:x|twitter)\.com\/i\/communities\/(\d+)/);
  if (m) return { kind: 'community', key: `xc:${m[1]}` };
  m = u.match(/(?:x|twitter)\.com\/([a-z0-9_]+)\/status\/(\d+)/);
  if (m) return { kind: 'tweet', key: `tweet:${m[2]}`, author: m[1] };
  m = u.match(/(?:x|twitter)\.com\/([a-z0-9_]{2,})/);
  if (m && !['search', 'home', 'i', 'intent'].includes(m[1])) return { kind: 'profile', key: `x:${m[1]}` };
  m = u.match(/t\.me\/([a-z0-9_+]+)/);
  if (m) return { kind: 'telegram', key: `tg:${m[1]}` };
  return null;
}

export async function fetchMetadata(uri) {
  if (!uri) return null;
  const res = await fetch(uri, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
  const j = await res.json();
  return {
    description: String(j.description ?? '').slice(0, 600),
    image: j.image ?? '',
    twitter: j.twitter ?? j.extensions?.twitter ?? '',
    telegram: j.telegram ?? j.extensions?.telegram ?? '',
    website: j.website ?? j.extensions?.website ?? '',
  };
}

/** Learns which themes are running from the coins that actually pump. */
export class TrendTracker {
  constructor() {
    this.runners = [];      // {ts, words, symbol, name}
    this.launches = [];     // {ts, symbol, words}
  }
  #prune(now) {
    this.runners = this.runners.filter((r) => now - r.ts < 3 * 3600_000);
    this.launches = this.launches.filter((r) => now - r.ts < 3 * 3600_000);
  }
  recordLaunch(coin, now = Date.now()) {
    this.launches.push({ ts: now, symbol: coin.symbol.toLowerCase(), words: words(`${coin.name} ${coin.symbol}`) });
    if (this.launches.length > 50_000) this.launches.splice(0, 10_000);
  }
  recordRunner(coin, now = Date.now()) {
    this.#prune(now);
    if (this.runners.some((r) => r.mint === coin.mint)) return;
    this.runners.push({ ts: now, mint: coin.mint, symbol: coin.symbol, name: coin.name,
      words: words(`${coin.name} ${coin.symbol} ${coin.meta?.description ?? ''}`) });
  }
  /** Words shared by 2+ recent runners = the current meta. */
  hotThemes(now = Date.now(), limit = 15) {
    this.#prune(now);
    const counts = new Map();
    for (const r of this.runners) for (const w of r.words) counts.set(w, (counts.get(w) ?? 0) + 1);
    return [...counts].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([word, count]) => ({ word, count }));
  }
  recentRunners(limit = 12) {
    return this.runners.slice(-limit).reverse().map((r) => `${r.symbol} (${r.name})`);
  }
  copies(coin, now = Date.now()) {
    const sym = coin.symbol.toLowerCase();
    return this.launches.filter((l) => l.symbol === sym && now - l.ts < 3 * 3600_000).length - 1;
  }
}

/** Fast, free narrative score - used when there's no AI key, and as input to the AI. */
export function ruleNarrative(coin, ctx) {
  const m = coin.meta ?? {};
  const reasons = [];
  let s = 25;
  const tw = socialKey(m.twitter);
  if (tw?.kind === 'tweet') { s += 15; reasons.push('Linked to a specific tweet/news'); }
  else if (tw?.kind === 'community') { s += 10; reasons.push('Has an X community'); }
  else if (tw) { s += 10; reasons.push('Has an X account'); }
  else reasons.push('No X link');
  if (m.telegram) s += 5;
  if (m.website) s += 5;
  if ((m.description ?? '').length > 30) s += 5;

  const hot = new Set(ctx.hotThemes.map((h) => h.word));
  const hits = words(`${coin.name} ${coin.symbol} ${m.description ?? ''}`).filter((w) => hot.has(w));
  if (hits.length) { s += Math.min(25, hits.length * 12); reasons.push(`Fits current meta: ${hits.slice(0, 4).join(', ')}`); }
  if (ctx.copies >= 3) { s -= 15; reasons.push(`${ctx.copies} other coins with the same ticker in 3h`); }
  if (ctx.sameTweetCoins >= 3) { s -= 5; reasons.push(`${ctx.sameTweetCoins} coins on the same tweet`); }
  if (ctx.recycledSocials?.length) { s -= 30; reasons.push('Recycled socials'); }

  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    theme: hits[0] ?? '',
    freshness: ctx.copies >= 3 ? 'copycat' : hits.length ? 'riding_meta' : 'unknown',
    summary: reasons.join('; '),
    redFlags: ctx.recycledSocials?.length ? ['Recycled socials'] : [],
    source: 'rules',
  };
}

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'theme', 'freshness', 'summary', 'red_flags'],
  properties: {
    score: { type: 'integer', description: '0-100 narrative strength' },
    theme: { type: 'string', description: 'The narrative in 2-5 words' },
    freshness: { type: 'string', enum: ['fresh', 'riding_meta', 'copycat', 'stale', 'unclear'] },
    summary: { type: 'string', description: 'One sentence, max 25 words' },
    red_flags: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You rate the NARRATIVE of newly launched Solana meme coins on Pump.fun for an experienced trader.
Judge only the story/meme quality - safety and price action are scored elsewhere.
High scores: a clear, instantly-graspable meme tied to something people are talking about right now
(viral tweet, news, celebrity/influencer moment, a running meta), the first or best coin on that story,
a coherent name/ticker/description, real socials.
Low scores: generic or incoherent names, obvious copy of an existing coin, stale narratives,
empty socials, spammy or deceptive descriptions, impersonation of a real brand or person.
Be calibrated: most coins deserve 20-50; reserve 75+ for genuinely strong, timely narratives.`;

const TWEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'meme_score', 'idea', 'keywords'],
        properties: {
          id: { type: 'string' },
          meme_score: { type: 'integer', description: '0-100 chance this post becomes a Pump.fun meme coin narrative' },
          idea: { type: 'string', description: 'The likely coin, e.g. "Wizard Goose ($WGOOSE)". Empty if none.' },
          keywords: { type: 'array', items: { type: 'string' }, description: '2-6 names/phrases/tickers a coin about this post would use' },
        },
      },
    },
  },
};

const TWEET_SYSTEM = `You spot X posts that are likely to become Pump.fun meme coins in the next hours.
Score high: an iconic image or video, a funny or absurd moment, a named animal/character/object,
a catchy phrase, a big personality (Elon, Trump, celebrities) saying or posting something memeable,
or breaking news with a clear meme angle. Score low: plain news without a meme hook, ads,
threads, politics without a funny hook, posts that are already old news.
Most posts deserve under 40. For each post give the coin a trader would expect and the keywords
(names, phrases, tickers) such coins would use in their name or ticker.`;

export class AiNarrator {
  constructor({ apiKey, model, maxPerHour }) {
    this.apiKey = apiKey; this.model = model; this.maxPerHour = maxPerHour;
    this.calls = [];
    this.client = null;
    this.disabledReason = apiKey ? '' : 'no ANTHROPIC_API_KEY';
  }
  get enabled() { return !this.disabledReason; }

  async #getClient() {
    if (this.client) return this.client;
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 2, timeout: 60_000 });
    } catch {
      this.disabledReason = '@anthropic-ai/sdk not installed (run npm install)';
      throw new Error(this.disabledReason);
    }
    return this.client;
  }

  #budget() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    if (this.calls.length >= this.maxPerHour) throw new Error('AI hourly budget used');
    this.calls.push(now);
  }

  async #ask(system, prompt, schema) {
    const client = await this.#getClient();
    const response = await client.beta.messages.create({
      model: this.model,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') throw new Error('AI declined');
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error(`AI returned no text (stop: ${response.stop_reason})`);
    return JSON.parse(text);
  }

  /** Rate how likely each X post is to spawn a meme coin. Returns Map id -> {meme_score, idea, keywords}. */
  async scoreTweets(posts) {
    this.#budget();
    const prompt = posts.map((p) => `[${p.id}] @${p.author} (${p.followers} followers, ${p.metrics.likes} likes, ` +
      `${p.metrics.retweets} reposts${p.hasMedia ? ', has image/video' : ''}): ${p.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
    const j = await this.#ask(TWEET_SYSTEM, prompt, TWEET_SCHEMA);
    return new Map((j.items ?? []).map((i) => [String(i.id), i]));
  }

  async score(coin, ctx, rule) {
    this.#budget();
    const m = coin.meta ?? {};
    const prompt = [
      `Coin: ${coin.name} ($${coin.symbol})`,
      `Description: ${m.description || '(none)'}`,
      `X/Twitter: ${m.twitter || '(none)'}  Telegram: ${m.telegram || '(none)'}  Website: ${m.website || '(none)'}`,
      `Coins launched with the same ticker in the last 3h: ${ctx.copies}`,
      `Other coins pointing at the same tweet: ${ctx.sameTweetCoins}`,
      `Words trending among coins that pumped in the last 3h: ${ctx.hotThemes.map((h) => `${h.word}(${h.count})`).join(', ') || '(not enough data yet)'}`,
      `Recent runners: ${ctx.recentRunners.join(', ') || '(none yet)'}`,
      `Rule-based pre-check: ${rule.summary}`,
    ].join('\n');

    const j = await this.#ask(SYSTEM, prompt, AI_SCHEMA);
    return {
      score: Math.max(0, Math.min(100, Math.round(j.score))),
      theme: j.theme, freshness: j.freshness, summary: j.summary,
      redFlags: j.red_flags ?? [], source: 'ai',
    };
  }
}
