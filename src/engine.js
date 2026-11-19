// The brain: tracks every new coin, decides when to evaluate, scores, alerts.
import { Coin } from './coin.js';
import { gatherChainData, analyzeSafety, launchBlockWallets } from './safety.js';
import { analyzeMomentum } from './momentum.js';
import { fetchMetadata, ruleNarrative, socialKey, TrendTracker } from './narrative.js';
import { combine } from './score.js';
import { computeConfidence } from './confidence.js';

const MAX_PARALLEL_EVALS = 4;

export class Engine {
  constructor({ cfg, feed, chain, store, notifier, ai, xwatch = null, log = console }) {
    Object.assign(this, { cfg, feed, chain, store, notifier, ai, xwatch, log });
    this.coins = new Map();
    this.trends = new TrendTracker();
    this.running = 0;
    this.queue = [];
    this.paused = false;
    this.solUsd = 0;
    this.counters = { launches: 0, evaluated: 0, alerts: 0, dropped: 0 };
    this.feedConnected = false;
    this.radar = new Map(); // tweet id -> { author, mints: Map(mint -> ts) }
    this.xwatch?.on('posts', () => this.#rematchAll());
  }

  start() {
    this.feed.on('create', (m) => this.onCreate(m));
    this.feed.on('trade', (m) => this.onTrade(m));
    this.feed.on('migrate', (m) => this.onMigrate(m));
    this.feed.on('status', (s) => { this.feedConnected = s.connected; });
    this.feed.start();
    if (this.xwatch?.enabled) this.xwatch.start();
    setInterval(() => this.tick(), 2000).unref();
    setInterval(() => this.store.pruneOld(), 6 * 3600_000).unref();
    if (!this.cfg.demo) { this.#updateSolPrice(); setInterval(() => this.#updateSolPrice(), 5 * 60_000).unref(); }
    else this.solUsd = 150;
  }

  /** SOL/USD from the first source that answers (cloud servers are often blocked by one or another). */
  async #updateSolPrice() {
    const sources = [
      ['https://api.coinbase.com/v2/prices/SOL-USD/spot', (j) => j.data.amount],
      ['https://api.kraken.com/0/public/Ticker?pair=SOLUSD', (j) => Object.values(j.result)[0].c[0]],
      ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', (j) => j.solana.usd],
    ];
    for (const [url, pick] of sources) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const price = Number(pick(await r.json()));
        if (price > 0) { this.solUsd = price; return; }
      } catch { /* try the next source */ }
    }
    if (!this.solUsd) this.log.warn('SOL price unavailable - market caps shown in SOL');
  }

  onCreate(msg) {
    if (this.coins.has(msg.mint)) return;
    if (this.coins.size >= this.cfg.maxTrackedCoins) this.#evictOne();
    const coin = new Coin(msg);
    this.coins.set(coin.mint, coin);
    this.counters.launches++;
    this.feed.watch(coin.mint);
    this.store.addLaunch(coin);
    this.trends.recordLaunch(coin);
    const metaP = msg._meta ? Promise.resolve(msg._meta) : fetchMetadata(coin.uri);
    metaP.then((meta) => {
      coin.meta = meta;
      const sk = socialKey(meta?.twitter);
      const tg = socialKey(meta?.telegram);
      const ownSocial = sk && sk.kind !== 'tweet' ? sk.key : tg?.key ?? null;
      this.store.setSocials(coin.mint, ownSocial, sk?.kind === 'tweet' ? sk.key : null);
      if (sk?.kind === 'tweet') {
        const tweetId = sk.key.slice('tweet:'.length);
        this.xwatch?.trackLinkedPost(tweetId);
        this.#radar(coin, tweetId, sk.author);
      }
      coin.xMatch = this.#xMatch(coin);
    }).catch(() => { coin.meta = coin.meta ?? {}; });
  }

  #xMatch(coin) {
    if (!this.xwatch?.posts.size || !coin.meta) return null;
    const m = this.xwatch.match(coin);
    return m && m.strength >= 0.5 ? m : null;
  }

  /** Free tweet radar: count new coins per linked X post. */
  #radar(coin, id, author) {
    if (!this.xwatch) return;
    const now = Date.now();
    const windowMs = this.cfg.radarWindowMin * 60_000;
    let r = this.radar.get(id);
    if (!r) { r = { author, mints: new Map() }; this.radar.set(id, r); }
    r.mints.set(coin.mint, now);
    for (const [m, t] of r.mints) if (now - t > windowMs) r.mints.delete(m);
    if (this.radar.size > 5000) {
      for (const [k, v] of this.radar) if ([...v.mints.values()].every((t) => now - t > windowMs)) this.radar.delete(k);
    }
    if (r.mints.size < this.cfg.radarMinCoins) return;
    const coins = [...r.mints.keys()].map((m) => this.coins.get(m)).filter(Boolean);
    if (coins.length < this.cfg.radarMinCoins) return;
    if (!this.xwatch.addRadarPost({ id, author: r.author, coins, now })) this.#rematchAll();
  }

  #rematchAll() { for (const c of this.coins.values()) c.xMatch = this.#xMatch(c); }

  /** Details of the X post a coin is about, and where it ranks among coins on that post. */
  #xInfo(coin) {
    const m = coin.xMatch;
    if (!m) return null;
    const p = m.post;
    const rivals = [...this.coins.values()].filter((c) => c.xMatch?.post.id === p.id).sort((a, b) => b.mcSol - a.mcSol);
    return {
      id: p.id, url: p.url, author: p.author, text: p.text.slice(0, 160), likes: p.metrics.likes,
      reposts: p.metrics.retweets, viral: p.viral, meme: p.meme, idea: p.idea ?? '', how: m.how,
      origin: p.origin, radarCoins: p.radarCoins ?? 0,
      strength: m.strength, rank: rivals.indexOf(coin) + 1, coinsOnPost: rivals.length,
    };
  }

  onTrade(msg) {
    const coin = this.coins.get(msg.mint);
    if (!coin) return;
    const wasDevSold = coin.devSold;
    coin.applyTrade(msg);
    if (coin.progress >= 30) this.trends.recordRunner(coin);
    if (!coin.alert) return;
    if (!wasDevSold && coin.devSold) this.#warn(coin, 'dev-sell', 'Dev started selling');
    const insiders = coin.result?.insiderWallets ?? [];
    if (insiders.length) {
      const held = insiders.reduce((s, w) => s + coin.holderPct(w), 0);
      const start = coin.result.insiderHeldAtEval;
      if (start > 3 && held < start * 0.5) this.#warn(coin, 'insider-dump', `Bundle/insider wallets dumped ${Math.round((1 - held / start) * 100)}% of their bag`);
    }
  }

  onMigrate(msg) {
    const coin = this.coins.get(msg.mint);
    if (!coin) return;
    coin.migrated = true;
    coin.progress = 100;
    this.trends.recordRunner(coin);
    if (coin.alert) {
      this.store.updatePeak(coin.mint, coin.peakMcSinceAlert, true);
      this.#warn(coin, 'migrated', '🎓 Graduated - bonding curve complete, now trading on PumpSwap');
    }
  }

  #warn(coin, key, text) {
    if (coin.warningsSent.has(key)) return;
    coin.warningsSent.add(key);
    coin.result?.events?.push({ at: Date.now(), text });
    this.notifier.warn(coin, text);
  }

  #evictOne() {
    let worst = null;
    for (const c of this.coins.values()) {
      if (c.alert) continue;
      if (!worst || c.tradeCount < worst.tradeCount) worst = c;
    }
    if (worst) this.#drop(worst);
  }

  #drop(coin) {
    if (coin.alert) this.store.updatePeak(coin.mint, coin.peakMcSinceAlert, coin.migrated);
    this.feed.unwatch(coin.mint);
    this.coins.delete(coin.mint);
    this.counters.dropped++;
  }

  tick(now = Date.now()) {
    const cfg = this.cfg;
    for (const coin of this.coins.values()) {
      const age = coin.ageSec(now);
      if (age > cfg.dropDeadAfterSec && coin.tradeCount < cfg.deadMinTrades) { this.#drop(coin); continue; }
      if (age > cfg.maxTrackMinutes * 60 || (coin.migrated && age > 600 && !coin.alert)) { this.#drop(coin); continue; }
      const idle = coin.trades.length && now - coin.trades.at(-1).ts > 20 * 60_000;
      if (idle && !coin.alert) { this.#drop(coin); continue; }
      if (coin.alert) this.store.updatePeak(coin.mint, coin.peakMcSinceAlert, coin.migrated);

      if (coin.evaluating || this.paused) continue;
      if (coin.xMatch && !coin.xDone && age >= cfg.freshMinAgeSec && coin.buyers.size >= cfg.xMinBuyers && !coin.migrated) {
        coin.xDone = true; this.#enqueue(coin, 'x');
      } else if (!coin.freshDone && age >= cfg.freshMinAgeSec && age <= cfg.freshMaxAgeSec &&
          (coin.buyers.size >= cfg.freshMinBuyers || coin.progress >= 10)) {
        coin.freshDone = true; this.#enqueue(coin, 'fresh');
      } else if (!coin.midDone && coin.progress >= cfg.midProgressPct && !coin.migrated) {
        coin.midDone = true; coin.freshDone = true; this.#enqueue(coin, 'mid');
      } else if (coin.result && now - coin.lastEvalAt > cfg.recheckEverySec * 1000 && (coin.progress > 15 || coin.xMatch) && !coin.migrated) {
        this.#enqueue(coin, 'recheck');
      }
    }
  }

  #enqueue(coin, stage) {
    coin.evaluating = true;
    this.queue.push([coin, stage]);
    this.#pump();
  }

  #pump() {
    while (this.running < MAX_PARALLEL_EVALS && this.queue.length) {
      const [coin, stage] = this.queue.shift();
      this.running++;
      this.evaluate(coin, stage)
        .catch((e) => this.log.warn(`eval ${coin.symbol}: ${e.message}`))
        .finally(() => { coin.evaluating = false; this.running--; this.#pump(); });
    }
  }

  async evaluate(coin, stage) {
    const now = Date.now();
    coin.lastEvalAt = now;
    const cfg = this.cfg;

    // Safety. On re-checks, reuse the (slow) on-chain data from the first evaluation.
    const chainData = stage === 'recheck' && coin.chainData ? coin.chainData : await gatherChainData(coin, this.chain);
    coin.chainData = chainData;
    const sk = socialKey(coin.meta?.twitter);
    const ownSocial = sk && sk.kind !== 'tweet' ? sk.key : socialKey(coin.meta?.telegram)?.key;
    const recycledSocials = this.store.socialReuse(ownSocial, coin.mint);
    const safety = analyzeSafety(coin, chainData, {
      cfg, recycledSocials,
      devLaunches24h: this.store.devLaunches(coin.creator, now - 86400_000),
    });

    const momentum = analyzeMomentum(coin, now, cfg.smartWallets);

    // Narrative (AI only for coins worth it - saves money)
    const nctx = {
      hotThemes: this.trends.hotThemes(now), recentRunners: this.trends.recentRunners(),
      copies: Math.max(0, this.trends.copies(coin, now)), recycledSocials,
      sameTweetCoins: sk?.kind === 'tweet' ? this.store.sameTweetCoins(sk.key, coin.mint, now - 6 * 3600_000) : 0,
    };
    let narrative = ruleNarrative(coin, nctx);
    if (coin.baseNarrative?.source === 'ai') narrative = coin.baseNarrative;
    else if (this.ai?.enabled && safety.verdict !== 'AVOID' && momentum.score >= 35) {
      try { narrative = await this.ai.score(coin, nctx, narrative); }
      catch (e) { this.log.warn(`AI narrative ${coin.symbol}: ${e.message}`); }
    }
    coin.baseNarrative = narrative;

    // A coin riding a viral, meme-able X post gets a narrative boost
    coin.xMatch = this.#xMatch(coin) ?? coin.xMatch;
    const x = this.#xInfo(coin);
    if (x && x.viral >= 40) {
      const target = Math.round((40 + 0.3 * x.viral + 0.3 * x.meme) * (0.5 + x.strength / 2));
      if (target > narrative.score) {
        narrative = { ...narrative, score: Math.min(100, target),
          summary: `${x.origin === 'radar' ? `X post by @${x.author} that ${x.radarCoins} coins launched on` : `Viral X post by @${x.author} (${x.likes.toLocaleString()} likes)`}; ${narrative.summary}` };
      }
    }

    const { score, light } = combine(safety, narrative, momentum);
    const confidence = computeConfidence(coin, { safety, narrative, momentum, score, x }, {
      runnersSeen: this.trends.runners.length, history: this.store.similarAlerts(score, now),
    });
    const insiderWallets = coin.result?.insiderWallets ?? this.#insiders(coin, chainData);
    const insiderHeldAtEval = coin.result?.insiderHeldAtEval ?? insiderWallets.reduce((s, w) => s + coin.holderPct(w), 0);
    coin.result = { at: now, stage, score, light, safety, momentum, narrative, confidence, x, insiderWallets,
      insiderHeldAtEval, events: coin.result?.events ?? [] };
    this.counters.evaluated++;

    // X narrative alert: about a meme-able post, leading coin on it, rising, and SAFE
    const rising = momentum.score >= cfg.xMinMomentum && momentum.progressPerMin > 0 && momentum.buySellRatio >= 1.2;
    if (x && !coin.xAlerted && !this.paused && safety.verdict === 'SAFE' && rising && x.rank === 1) {
      coin.xAlerted = true;
      await this.#sendAlert(coin, 'x', score, light, now);
      return coin.result;
    }

    const shouldAlert = score >= cfg.alertMinScore && safety.verdict !== 'AVOID' &&
      (stage === 'fresh' || stage === 'mid' || (stage === 'recheck' && !coin.alert));
    if (shouldAlert && !this.paused) {
      const alertStage = stage === 'recheck' ? (coin.progress >= cfg.midProgressPct ? 'mid' : 'fresh') : stage;
      if (!coin.alert || coin.alert.stage !== alertStage) await this.#sendAlert(coin, alertStage, score, light, now);
    }
    return coin.result;
  }

  async #sendAlert(coin, stage, score, light, now) {
    coin.alert = { stage, at: now, mcSol: coin.mcSol, score };
    coin.peakMcSinceAlert = Math.max(coin.peakMcSinceAlert, coin.mcSol);
    this.store.addAlert(coin, stage, coin.result);
    this.counters.alerts++;
    this.log.info(`ALERT ${light} $${coin.symbol} ${score}/100 [${stage}] conf ${coin.result.confidence.label} ${coin.mint}`);
    await this.notifier.alert(coin, coin.result, stage);
  }

  #insiders(coin, chainData) {
    const set = launchBlockWallets(coin, chainData.slots);
    const funders = new Map();
    for (const [w, i] of chainData.wallets) if (i.funder && !chainData.services.has(i.funder)) {
      funders.set(i.funder, [...(funders.get(i.funder) ?? []), w]);
    }
    for (const ws of funders.values()) if (ws.length >= 2) ws.forEach((w) => w !== coin.creator && set.add(w));
    return [...set];
  }

  // ---- views for dashboard / telegram -------------------------------------------------
  coinView(coin) {
    const r = coin.result;
    return {
      mint: coin.mint, symbol: coin.symbol, name: coin.name, image: coin.meta?.image ?? '',
      ageSec: Math.round(coin.ageSec()), mcSol: coin.mcSol, progress: coin.progress, migrated: coin.migrated,
      holders: coin.holders().length, trades: coin.tradeCount, devSold: coin.devSold,
      twitter: coin.meta?.twitter ?? '', telegram: coin.meta?.telegram ?? '', description: coin.meta?.description ?? '',
      links: coin.links(this.cfg.padreUrlTemplate),
      score: r?.score ?? null, light: r?.light ?? '', stage: r?.stage ?? null, evaluatedAt: r?.at ?? null,
      safety: r?.safety ?? null, narrative: r?.narrative ?? null, momentum: r?.momentum ?? null,
      confidence: r?.confidence ?? null, x: r?.x ?? null,
      events: r?.events ?? [],
      alert: coin.alert ? { ...coin.alert, peakMult: coin.alert.mcSol ? coin.peakMcSinceAlert / coin.alert.mcSol : 1 } : null,
    };
  }

  ranked(limit = 60) {
    return [...this.coins.values()].filter((c) => c.result)
      .sort((a, b) => (b.result.score - a.result.score) || (b.progress - a.progress))
      .slice(0, limit).map((c) => this.coinView(c));
  }

  /** Meme-able X posts and the coins found for each. */
  xPosts(limit = 12) {
    if (!this.xwatch) return [];
    const byPost = new Map();
    for (const c of this.coins.values()) {
      const id = c.xMatch?.post.id;
      if (!id) continue;
      if (!byPost.has(id)) byPost.set(id, []);
      byPost.get(id).push({ mint: c.mint, symbol: c.symbol, mcSol: c.mcSol, score: c.result?.score ?? null,
        verdict: c.result?.safety.verdict ?? null });
    }
    return this.xwatch.list(limit).map((p) => ({
      id: p.id, url: p.url, author: p.author, text: p.text.slice(0, 220), createdAt: p.createdAt,
      likes: p.metrics.likes, reposts: p.metrics.retweets, viral: p.viral, meme: p.meme, idea: p.idea ?? '',
      memeSource: p.memeSource, origin: p.origin, radarCoins: p.radarCoins ?? 0,
      coins: (byPost.get(p.id) ?? []).sort((a, b) => b.mcSol - a.mcSol).slice(0, 5),
    }));
  }

  status() {
    return {
      demo: this.cfg.demo, feedConnected: this.feedConnected, paused: this.paused,
      tracked: this.coins.size, ...this.counters, solUsd: this.solUsd,
      helius: Boolean(this.chain?.enabled), ai: this.ai?.enabled ? this.cfg.aiModel : (this.ai?.disabledReason || 'off'),
      notify: this.notifier.channels,
      x: this.xwatch?.enabled ? { on: true, posts: this.xwatch.posts.size, error: this.xwatch.lastError }
        : { on: false, radar: Boolean(this.xwatch), posts: this.xwatch?.posts.size ?? 0 },
      hotThemes: this.trends.hotThemes(), alertMinScore: this.cfg.alertMinScore,
    };
  }
}
