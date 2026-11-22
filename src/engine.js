// The brain: tracks every new coin, decides when to evaluate, scores, alerts.
import { Coin } from './coin.js';
import { gatherChainData, analyzeSafety, launchBlockWallets } from './safety.js';
import { analyzeMomentum } from './momentum.js';
import { fetchMetadata, ruleNarrative, socialKey, TrendTracker } from './narrative.js';
import { combine, runnerScore } from './score.js';
import { computeConfidence } from './confidence.js';
import { featurize } from './learn.js';
import { matchCoin } from './xwatch.js';
import { CopyIndex, detectDeployTool } from './copies.js';
import { liquidityRead } from './liquidity.js';
import { dexPaid } from './dexscreener.js';

const MAX_PARALLEL_EVALS = 4;

export class Engine {
  constructor({ cfg, feed, chain, store, notifier, ai, xwatch = null, learner = null, paper = null, trends = null, log = console }) {
    Object.assign(this, { cfg, feed, chain, store, notifier, ai, xwatch, learner, paper, trends, log });
    this.coins = new Map();
    this.trendsTracker = new TrendTracker();
    this.running = 0;
    this.queue = [];
    this.paused = false;
    this.solUsd = 0;
    this.counters = { launches: 0, evaluated: 0, alerts: 0, dropped: 0 };
    this.feedConnected = false;
    this.radar = new Map(); // tweet id -> { author, mints: Map(mint -> ts) }
    this.copies = new CopyIndex();
    this.events = [];        // live log: what each part of the bot decided, and why
    this.kills = new Map();  // rejection reason -> number of coins
    this.pipeline = { scored: 0, filtered: 0, lowScore: 0, dead: 0 };
    this.regimeLog = { launches: [], grads: [] }; // minute buckets for the 24h graduation rate
    this.scoreLog = [];      // [time, score] of clean coins' first scores, for the adaptive alert bar
    this.lastPicks = { at: Date.now(), key: '' };
    this.xwatch?.on('posts', () => this.#rematchAll());
    this.trends?.on('topics', () => { for (const c of this.coins.values()) c.trendMatch = this.#trendMatch(c); });
  }

  start() {
    this.feed.on('create', (m) => this.onCreate(m));
    this.feed.on('trade', (m) => this.onTrade(m));
    this.feed.on('migrate', (m) => this.onMigrate(m));
    this.feed.on('status', (s) => { this.feedConnected = s.connected; if (s.problem) this.feedProblem = s.problem; });
    this.feed.start();
    if (this.xwatch?.enabled) this.xwatch.start();
    this.trends?.start();
    setInterval(() => this.tick(), 2000).unref();
    if (this.paper) setInterval(() => this.paper.pollMoonbags().catch(() => {}), 2 * 60_000).unref();
    if (this.learner) {
      this.store.finalizeStale(Date.now() - this.cfg.learnHorizonMin * 60_000);
      try { this.learner.train(); } catch (e) { this.log.warn(`learning: ${e.message}`); }
      setInterval(() => { try { this.learner.maybeTrain(); } catch (e) { this.log.warn(`learning: ${e.message}`); } }, 5 * 60_000).unref();
    }
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
    this.#bump(this.regimeLog.launches);
    this.feed.watch(coin.mint);
    this.store.addLaunch(coin);
    this.trendsTracker.recordLaunch(coin);
    const metaP = msg._meta ? Promise.resolve(msg._meta) : fetchMetadata(coin.uri);
    metaP.then((meta) => {
      coin.meta = meta;
      // Quick-deploy tools (J7 etc.) and copies of an earlier coin ("vamps")
      coin.deployTool = detectDeployTool(meta, this.cfg.deployToolPatterns);
      coin.copyOf = this.copies.originalOf(coin);
      this.copies.add(coin);
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
      coin.trendMatch = this.#trendMatch(coin);
    }).catch(() => { coin.meta = coin.meta ?? {}; });
  }

  #bump(arr, now = Date.now()) {
    const m = Math.floor(now / 60_000);
    if (arr.length && arr.at(-1)[0] === m) arr.at(-1)[1]++; else arr.push([m, 1]);
    const cutoff = m - 24 * 60;
    while (arr.length && arr[0][0] < cutoff) arr.shift();
  }

  /** Market mood: what share of new coins graduated in the last 24h (cold markets need pickier alerts). */
  regime(now = Date.now()) {
    const cutoff = Math.floor(now / 60_000) - 24 * 60;
    const sum = (a) => a.filter(([m]) => m >= cutoff).reduce((s, [, n]) => s + n, 0);
    const launches = sum(this.regimeLog.launches), grads = sum(this.regimeLog.grads);
    if (launches < 1500) return { state: 'warming up', launches, grads, rate: null };
    const rate = (grads / launches) * 100;
    const state = rate < this.cfg.coldGradPct ? 'cold' : rate > this.cfg.coldGradPct * 3 ? 'hot' : 'normal';
    return { state, launches, grads, rate };
  }

  /**
   * The score a coin needs to alert. Adaptive mode aims for ALERT_TARGET_PER_DAY alerts by taking the
   * matching top slice of recently scored clean coins - so quiet days still surface the best coins -
   * kept between ALERT_FLOOR and ALERT_CEILING. Falls back to the fixed bar until there is enough data.
   */
  /** Moonbag only for coins that graduated cleanly AND have a lasting story (multi-day trend or top narrative). */
  moonbagWorthy(mint) {
    const c = this.coins.get(mint);
    const r = c?.result;
    if (!r || r.safety.verdict !== 'SAFE' || c.warningsSent.has('insider-dump') || c.warningsSent.has('dev-sell')) return false;
    if (r.runner?.is) return true;
    return Boolean(r.trend?.longevity) || r.narrative.score >= this.cfg.paperMoonbagMinNarrative;
  }

  alertBar(now = Date.now()) {
    const cfg = this.cfg;
    const fixed = cfg.alertMinScore + (this.regime().state === 'cold' ? cfg.coldScoreBump : 0);
    if (!cfg.alertTargetPerDay) return fixed;
    if (this.barCache && now - this.barCache.at < 60_000) return this.barCache.bar;
    const recent = this.scoreLog.filter(([t]) => now - t < 6 * 3600_000);
    let bar = fixed;
    if (recent.length >= 30) {
      const hours = Math.max(0.5, (now - recent[0][0]) / 3600_000);
      const share = Math.min(1, cfg.alertTargetPerDay / 24 / (recent.length / hours));
      const sorted = recent.map(([, s]) => s).sort((a, b) => b - a);
      bar = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
    }
    bar = Math.max(cfg.alertFloor, Math.min(cfg.alertCeiling, bar));
    this.barCache = { at: now, bar, adaptive: recent.length >= 30 };
    return bar;
  }

  /** Best SAFE live coins right now (for the hourly phone digest and the dashboard). */
  topPicks(limit = 3, now = Date.now()) {
    return [...this.coins.values()]
      .filter((c) => c.result && c.result.safety.verdict === 'SAFE' && !c.migrated && c.ageSec(now) < 2 * 3600 &&
        c.result.score >= this.cfg.alertFloor && now - c.lastEvalAt < 30 * 60_000)
      .sort((a, b) => b.result.score - a.result.score).slice(0, limit);
  }

  logEvent(agent, coin, text, level = '') {
    this.events.push({ at: Date.now(), agent, symbol: coin?.symbol ?? '', mint: coin?.mint ?? '', text, level });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
  }

  #kill(reason) { this.kills.set(reason, (this.kills.get(reason) ?? 0) + 1); }

  /** Terminal-style board: New Pairs, the middle of the curve, and the Final Stretch. */
  board(now = Date.now()) {
    const cfg = this.cfg;
    const item = (c) => ({
      mint: c.mint, symbol: c.symbol, name: c.name, ageSec: Math.round(c.ageSec(now)), mcSol: c.mcSol,
      progress: c.progress, buyers: c.organicBuyerCount(), score: c.result?.score ?? null,
      verdict: c.result?.safety.verdict ?? null, light: c.result?.light ?? '', x: Boolean(c.xMatch), trend: Boolean(c.trendMatch),
      deployTool: c.deployTool ?? null, copy: Boolean(c.copyOf), spark: c.spark(16, 30 * 60_000, now), runner: Boolean(c.result?.runner?.is),
      alerted: Boolean(c.alert),
    });
    const live = [...this.coins.values()].filter((c) => !c.migrated);
    const isNew = (c) => c.ageSec(now) < cfg.newPairMaxMin * 60 && c.progress < cfg.finalStretchPct;
    const isFinal = (c) => c.progress >= cfg.finalStretchPct;
    const middle = live.filter((c) => !isNew(c) && !isFinal(c));
    return {
      newPairs: live.filter(isNew).sort((a, b) => b.createdAt - a.createdAt).slice(0, 15).map(item),
      middle: middle.sort((a, b) => b.progress - a.progress).slice(0, 8).map(item),
      middleCount: middle.length,
      final: live.filter(isFinal).sort((a, b) => b.progress - a.progress).slice(0, 15).map(item),
      finalStretchPct: cfg.finalStretchPct, newPairMaxMin: cfg.newPairMaxMin,
    };
  }

  /** Biggest market-cap moves in the last 5 minutes among coins that are not AVOID. */
  movers(limit = 8, now = Date.now()) {
    return [...this.coins.values()]
      .filter((c) => c.result && c.result.safety.verdict !== 'AVOID' && !c.migrated)
      .map((c) => ({ c, ch: c.mcSol / Math.max(1e-9, c.mcAt(now - 5 * 60_000)) - 1 }))
      .filter((x) => x.ch > 0.05)
      .sort((a, b) => b.ch - a.ch).slice(0, limit)
      .map(({ c, ch }) => ({ mint: c.mint, symbol: c.symbol, mcSol: c.mcSol, changePct: ch * 100, score: c.result.score }));
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
    else this.logEvent('RADAR', coin, `${coins.length} coins launched on @${r.author ?? '?'}'s X post`);
  }

  #trendMatch(coin) {
    if (!this.trends || !coin.meta) return null;
    const targets = this.trends.matchTargets();
    if (!targets.length) return null;
    const m = matchCoin(coin, targets);
    return m && m.strength >= 0.5 ? m : null;
  }

  /** Details of the trend a coin is about, and where it ranks among coins on that trend. */
  #trendInfo(coin) {
    const m = coin.trendMatch;
    if (!m) return null;
    const q = this.trends.qualified().find((t) => `trend:${t.key}` === m.post.id);
    if (!q) return null;
    const rivals = [...this.coins.values()].filter((c) => c.trendMatch?.post.id === m.post.id).sort((a, b) => b.mcSol - a.mcSol);
    const names = { google: 'Google', wiki: 'Wikipedia', reddit: 'Reddit', x: 'X', pumpfun: 'Pump.fun' };
    return { key: q.key, label: q.label, sources: q.active.map((s) => names[s] ?? s), days: q.days, spike: q.spike,
      longevity: q.longevity, score: q.score, meme: q.meme ?? 50, thesis: q.thesis ?? '', ideas: q.ideas ?? [],
      how: m.how, strength: m.strength, rank: rivals.indexOf(coin) + 1, coinsOnTrend: rivals.length };
  }

  /** Items the trend scanner gets from inside the bot: viral X posts and themes pumping on Pump.fun. */
  trendItems() {
    const items = [];
    for (const p of this.xwatch?.posts.values() ?? []) {
      if ((p.viral ?? 0) >= 50) items.push({ source: 'x', phrase: (p.idea || '').replace(/\(.*?\)|\$\w+/g, '').trim() || p.keywords?.[0] || p.text.slice(0, 60), detail: `@${p.author}` });
    }
    for (const h of this.trendsTracker.hotThemes()) items.push({ source: 'pumpfun', phrase: h.word });
    return items;
  }

  trendView() {
    if (!this.trends) return null;
    const v = this.trends.view();
    const byKey = new Map();
    for (const c of this.coins.values()) {
      const id = c.trendMatch?.post.id;
      if (!id) continue;
      if (!byKey.has(id)) byKey.set(id, []);
      byKey.get(id).push({ mint: c.mint, symbol: c.symbol, mcSol: c.mcSol, score: c.result?.score ?? null, verdict: c.result?.safety.verdict ?? null });
    }
    v.topics = v.topics.map((t) => ({ ...t, coins: (byKey.get(`trend:${t.key}`) ?? []).sort((a, b) => b.mcSol - a.mcSol).slice(0, 5) }));
    return v;
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
    for (const s of coin.samples.values()) if (!s.done) { s.peak = Math.max(s.peak, coin.mcSol); s.low = Math.min(s.low ?? s.mc, coin.mcSol); }
    if (this.paper?.positions.has(coin.mint)) this.paper.onPrice(coin, this.coins);
    if (this.paper?.moonbags.has(coin.mint)) this.paper.moonbagPrice(coin.mint, coin.mcSol);
    if (coin.progress >= 30) this.trendsTracker.recordRunner(coin);
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
    this.#bump(this.regimeLog.grads);
    const coin = this.coins.get(msg.mint);
    if (!coin) return;
    coin.migrated = true;
    coin.progress = 100;
    this.paper?.onMigrate(coin, this.coins);
    this.#flushSamples(coin, Date.now());
    this.trendsTracker.recordRunner(coin);
    if (coin.alert) {
      this.store.updatePeak(coin.mint, coin.peakMcSinceAlert, true);
      this.#warn(coin, 'migrated', '🎓 Graduated - bonding curve complete, now trading on PumpSwap');
    }
  }

  #warn(coin, key, text) {
    if (coin.warningsSent.has(key)) return;
    coin.warningsSent.add(key);
    coin.result?.events?.push({ at: Date.now(), text });
    this.logEvent('WATCH', coin, text, key === 'migrated' ? 'good' : 'bad');
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

  /** Save learning outcomes: peak market cap since scoring; finished once the horizon passes. */
  #flushSamples(coin, now, final = false) {
    for (const [stage, s] of coin.samples) {
      if (s.done) continue;
      const done = final || now - s.at > this.cfg.learnHorizonMin * 60_000;
      this.store.updateSample(coin.mint, stage, s.peak, coin.migrated, done);
      if (s.low != null) this.store.setSampleLow(coin.mint, stage, s.low);
      s.done = done;
    }
  }

  #drop(coin) {
    this.#flushSamples(coin, Date.now(), true);
    // Remember how this coin ended, for "dev rugged before" on the dev's next coins
    const ath = coin.athMcSol, start = coin.startMcSol || coin.mcSol;
    const rugged = ath >= start * 1.3 && coin.mcSol <= ath * 0.35 && !coin.migrated;
    try { this.store.setOutcome(coin.mint, ath, coin.mcSol, rugged, coin.migrated); } catch { /* not critical */ }
    if (!coin.result) { this.pipeline.dead++; this.#kill('No traction (died early)'); }
    if (coin.alert) this.store.updatePeak(coin.mint, coin.peakMcSinceAlert, coin.migrated);
    this.feed.unwatch(coin.mint);
    this.coins.delete(coin.mint);
    this.counters.dropped++;
  }

  tick(now = Date.now()) {
    const cfg = this.cfg;
    this.paper?.tick(this.coins, now);
    // Hourly digest of the best SAFE coins, so quiet stretches still show what's worth a look
    if (this.cfg.topPicksEveryMin && now - this.lastPicks.at >= this.cfg.topPicksEveryMin * 60_000 && !this.paused) {
      this.lastPicks.at = now;
      const picks = this.topPicks();
      const key = picks.map((c) => c.mint).join(',');
      if (picks.length && key !== this.lastPicks.key) {
        this.lastPicks.key = key;
        this.notifier.picks?.(picks.map((c) => ({ symbol: c.symbol, name: c.name, mint: c.mint, score: c.result.score,
          confidence: c.result.confidence.label, mcSol: c.mcSol, progress: c.progress, links: c.links(this.cfg.padreUrlTemplate) })), this.solUsd);
      }
    }
    const flush = now - (this.lastFlush ?? 0) > 60_000;
    if (flush) this.lastFlush = now;
    for (const coin of this.coins.values()) {
      if (flush && coin.samples.size) this.#flushSamples(coin, now);
      const age = coin.ageSec(now);
      if (age > cfg.dropDeadAfterSec && coin.tradeCount < cfg.deadMinTrades) { this.#drop(coin); continue; }
      if (age > cfg.maxTrackMinutes * 60 || (coin.migrated && age > 600 && !coin.alert)) { this.#drop(coin); continue; }
      const idle = coin.trades.length && now - coin.trades.at(-1).ts > 20 * 60_000;
      if (idle && !coin.alert) { this.#drop(coin); continue; }
      if (coin.alert) this.store.updatePeak(coin.mint, coin.peakMcSinceAlert, coin.migrated);

      if (coin.evaluating || this.paused) continue;
      if ((coin.xMatch || coin.trendMatch) && !coin.xDone && age >= cfg.freshMinAgeSec && coin.organicBuyerCount() >= cfg.xMinBuyers && !coin.migrated) {
        coin.xDone = true; this.#enqueue(coin, coin.xMatch ? 'x' : 'trend');
      } else if (!coin.freshDone && age >= cfg.freshMinAgeSec && age <= cfg.freshMaxAgeSec &&
          (coin.organicBuyerCount() >= cfg.freshMinBuyers || coin.progress >= 10)) {
        coin.freshDone = true; this.#enqueue(coin, 'fresh');
      } else if (!coin.finalDone && coin.progress >= cfg.finalStretchPct && !coin.migrated) {
        coin.finalDone = coin.midDone = coin.freshDone = true; this.#enqueue(coin, 'final');
      } else if (cfg.midProgressPct > 0 && !coin.midDone && coin.progress >= cfg.midProgressPct && !coin.migrated) {
        coin.midDone = true; coin.freshDone = true; this.#enqueue(coin, 'mid');
      } else if (coin.result && now - coin.lastEvalAt > cfg.recheckEverySec * 1000 && (coin.progress > 15 || coin.xMatch || coin.trendMatch) && !coin.migrated) {
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
      devHistory: this.store.devHistory(coin.creator, coin.mint),
      deployTool: coin.deployTool, copyOf: coin.copyOf,
    });

    const momentum = analyzeMomentum(coin, now, cfg.smartWallets, new Set(this.#insiders(coin, chainData)), cfg.whaleSol);

    // Narrative (AI only for coins worth it - saves money)
    const nctx = {
      hotThemes: this.trendsTracker.hotThemes(now), recentRunners: this.trendsTracker.recentRunners(),
      copies: Math.max(0, this.trendsTracker.copies(coin, now)), recycledSocials,
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

    // Free DexScreener check: did the dev pay for a profile/boost?
    let paid = coin.dexPaid ?? null;
    if (cfg.dexCheck && !cfg.demo && safety.verdict !== 'AVOID' && (paid === null || stage !== 'recheck')) {
      try { paid = (await dexPaid(coin.mint)).paid; coin.dexPaid = paid; }
      catch (e) { this.log.warn(`DexScreener ${coin.symbol}: ${e.message}`); }
    }
    if (paid) {
      safety.flags.push({ level: 'ok', text: 'Dex paid: dev paid for a DexScreener profile' });
      narrative = { ...narrative, score: Math.min(100, narrative.score + 5) };
    }

    // Self-learning: what the bot has learned from past coins
    const features = featurize(coin, { safety, narrative, momentum, x, dexPaid: paid }, stage);
    const learned = this.learner?.score(features) ?? null;
    const useLearned = learned?.validated ? learned.pct : null;

    // A coin about a cross-site trend (multi-site + spike or lasting) gets a narrative boost
    coin.trendMatch = this.#trendMatch(coin) ?? coin.trendMatch;
    const trend = this.#trendInfo(coin);
    if (trend) {
      const target = Math.round((40 + 0.3 * trend.score + 0.3 * trend.meme) * (0.5 + trend.strength / 2));
      if (target > narrative.score) {
        narrative = { ...narrative, score: Math.min(100, target), theme: narrative.theme || trend.label,
          summary: `Trend "${trend.label}" on ${trend.sources.join(' + ')}${trend.days > 1 ? ` for ${trend.days} days` : ''}; ${narrative.summary}` };
      }
    }

    const { score, light } = combine(safety, narrative, momentum, useLearned, cfg.learnBlend);
    if (['fresh', 'mid', 'final', 'x', 'trend'].includes(stage) && !coin.samples.has(stage)) {
      this.store.addSample(coin.mint, stage, now, features, coin.mcSol, score);
      coin.samples.set(stage, { at: now, mc: coin.mcSol, peak: coin.mcSol, done: false });
    }
    const confidence = computeConfidence(coin, { safety, narrative, momentum, score, x, trend, learned }, {
      runnersSeen: this.trendsTracker.runners.length, history: this.store.similarAlerts(score, now),
    });
    const insiderWallets = coin.result?.insiderWallets ?? this.#insiders(coin, chainData);
    const insiderHeldAtEval = coin.result?.insiderHeldAtEval ?? insiderWallets.reduce((s, w) => s + coin.holderPct(w), 0);
    const outcomes = this.store.similarOutcomes(score, now - 14 * 86400_000);
    const liquidity = this.solUsd > 0 && !coin.migrated
      ? liquidityRead({ onCurve: true, vSol: coin.vSol, mcUsd: coin.mcSol * this.solUsd, solUsd: this.solUsd, orderUsd: cfg.checkOrderUsd }) : null;
    coin.result = { at: now, stage, score, light, safety, momentum, narrative, confidence, x, trend, learned, outcomes, liquidity, dexPaid: paid, insiderWallets,
      insiderHeldAtEval, events: coin.result?.events ?? [] };
    this.counters.evaluated++;
    if (!coin.counted) {
      coin.counted = true;
      this.pipeline.scored++;
      if (safety.verdict !== 'AVOID') {
        this.scoreLog.push([now, score]);
        if (this.scoreLog.length > 20_000) this.scoreLog.splice(0, 5_000);
        while (this.scoreLog.length && now - this.scoreLog[0][0] > 6 * 3600_000) this.scoreLog.shift();
      }
      if (safety.verdict === 'AVOID') {
        this.pipeline.filtered++;
        const bad = safety.flags.filter((f) => f.level === 'bad');
        for (const f of bad) this.#kill(f.cat || 'Other red flag');
        this.logEvent('FILTER', coin, `killed · ${bad[0]?.text ?? 'red flags'}`, 'bad');
      } else if (score < this.alertBar()) {
        this.pipeline.lowScore++;
        this.#kill(`Score below ${this.alertBar()}`);
        this.logEvent('ANALYST', coin, `passed on · score ${score} < ${this.alertBar()}`, 'muted');
      }
    }

    // Runner: big-move potential -> its own top-priority alert (once), and room to run in paper trading
    const rs = runnerScore(coin, coin.result);
    coin.result.runner = { ...rs, is: rs.score >= cfg.runnerMin && rs.catalyst };
    if (coin.result.runner.is) {
      if (this.paper?.positions.has(coin.mint)) this.paper.markRunner(coin.mint);
      if (!coin.runnerAlerted && !this.paused) {
        coin.runnerAlerted = true;
        this.logEvent('ANALYST', coin, `🚀 runner potential ${rs.score}: ${rs.reasons.slice(0, 3).join(', ')}`, 'good');
        await this.#sendAlert(coin, 'runner', score, light, now);
        return coin.result;
      }
    }

    // X narrative alert: about a meme-able post, leading coin on it, rising, and SAFE
    const rising = momentum.score >= cfg.xMinMomentum && momentum.progressPerMin > 0 && momentum.buySellRatio >= 1.2;
    if (x && !coin.xAlerted && !this.paused && safety.verdict === 'SAFE' && rising && x.rank === 1) {
      coin.xAlerted = true;
      await this.#sendAlert(coin, 'x', score, light, now);
      return coin.result;
    }
    // Trend alert: same bar - leading coin on a qualified trend, rising, and SAFE
    if (trend && !coin.trendAlerted && !this.paused && safety.verdict === 'SAFE' && rising && trend.rank === 1) {
      coin.trendAlerted = true;
      await this.#sendAlert(coin, 'trend', score, light, now);
      return coin.result;
    }

    const shouldAlert = score >= this.alertBar() && safety.verdict !== 'AVOID' &&
      (['fresh', 'mid', 'final'].includes(stage) || (stage === 'recheck' && !coin.alert));
    if (shouldAlert && !this.paused) {
      const alertStage = stage === 'recheck' ? (coin.progress >= cfg.finalStretchPct ? 'final' : 'fresh') : stage;
      if (!coin.alert || coin.alert.stage !== alertStage) await this.#sendAlert(coin, alertStage, score, light, now);
    }
    return coin.result;
  }

  async #sendAlert(coin, stage, score, light, now) {
    // One coin, one alert per 10 minutes - except reaching the Final Stretch, which is genuinely new
    if (coin.alert && now - coin.alert.at < 10 * 60_000 && stage !== 'final' && stage !== 'runner') return;
    coin.alert = { stage, at: now, mcSol: coin.mcSol, score };
    coin.peakMcSinceAlert = Math.max(coin.peakMcSinceAlert, coin.mcSol);
    this.store.addAlert(coin, stage, coin.result);
    this.counters.alerts++;
    this.log.info(`ALERT ${light} $${coin.symbol} ${score}/100 [${stage}] conf ${coin.result.confidence.label} ${coin.mint}`);
    this.logEvent('ALERT', coin, `score ${score} · ${stage === 'x' ? 'X narrative' : stage} · ${coin.result.confidence.label} confidence`, 'good');
    if (!this.paper?.positions.has(coin.mint)) {
      this.paper?.open(coin, { stage, score, deployTool: coin.deployTool, vamp: Boolean(coin.copyOf), runner: Boolean(coin.result.runner?.is) }, this.coins, now);
    }
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
      confidence: r?.confidence ?? null, x: r?.x ?? null, trend: r?.trend ?? null,
      deployTool: coin.deployTool ?? null, copyOf: coin.copyOf ?? null,
      label: !r ? null : r.safety.verdict === 'AVOID' ? 'DO NOT BUY' : coin.alert && r.safety.verdict === 'SAFE' && !coin.warningsSent.has('insider-dump') && !coin.warningsSent.has('dev-sell') ? 'BUY ZONE' : r.safety.verdict === 'SAFE' ? 'LOW RISK' : 'WATCH',
      spark: coin.spark(), outcomes: r ? this.store.similarOutcomes(r.score) : null, runner: r?.runner ?? null, liquidity: r?.liquidity ?? null, learned: r?.learned ?? null, dexPaid: r?.dexPaid ?? null,
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
      feedProblem: this.feedProblem ?? '', feedLastDataSec: this.feed.lastMsgAt ? Math.round((Date.now() - this.feed.lastMsgAt) / 1000) : null,
      feedReconnects: this.feed.reconnects ?? 0,
      tracked: this.coins.size, ...this.counters, solUsd: this.solUsd,
      helius: Boolean(this.chain?.enabled), ai: this.ai?.enabled ? this.cfg.aiModel : (this.ai?.disabledReason || 'off'),
      notify: this.notifier.channels,
      x: this.xwatch?.enabled ? { on: true, posts: this.xwatch.posts.size, error: this.xwatch.lastError }
        : { on: false, radar: Boolean(this.xwatch), posts: this.xwatch?.posts.size ?? 0 },
      hotThemes: this.trendsTracker.hotThemes(), alertMinScore: this.alertBar(), alertAdaptive: Boolean(this.barCache?.adaptive),
      regime: this.regime(),
      learning: this.learner?.status() ?? null,
      pipeline: { launches: this.counters.launches, ...this.pipeline, alerts: this.counters.alerts,
        paperTrades: this.paper ? this.store.paperTradesSince(0).length + this.paper.positions.size : 0 },
    };
  }
}
