// Self-learning: the bot records every coin it scores and what happened next, then learns
// which signals actually predicted a pump. Free - it only uses the bot's own history.
//
// Model: logistic regression (simple, robust, explainable). It is only trusted ("validated")
// when, on the most recent coins it was NOT trained on, its top picks hit the target clearly
// more often than average. Until then the hand-made scores are used unchanged.

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export const FEATURES = [
  ['safety', 'Safety score'],
  ['narrative', 'Narrative score'],
  ['momentum', 'Momentum score'],
  ['bundle', 'Bundled at launch %'],
  ['linked', 'Linked-wallet holdings %'],
  ['dev', 'Dev holdings %'],
  ['top10', 'Top 10 holders %'],
  ['fresh', 'Fresh early wallets'],
  ['progress', 'Curve %'],
  ['speed', 'Curve speed'],
  ['buyers', 'Buyers in last 2 min'],
  ['buysell', 'Buy/sell ratio'],
  ['wash', 'Wash-trading volume'],
  ['dust', 'Dust (fake) buyers'],
  ['holders', 'Real holders'],
  ['drawdown', 'Drop from high'],
  ['age', 'Coin age'],
  ['twitter', 'Has X link'],
  ['telegram', 'Has Telegram'],
  ['website', 'Has website'],
  ['xpost', 'Rides an X post'],
  ['dexpaid', 'Dex paid'],
  ['devsold', 'Dev sold'],
  ['mid', 'Scored later on the curve'],
  ['deploytool', 'Launched with a quick-deploy tool (J7 etc.)'],
  ['vamp', 'Copy of an earlier coin'],
];

/** Turn a scored coin into numbers between 0 and 1. */
export function featurize(coin, r, stage) {
  const s = r.safety, m = r.momentum, meta = coin.meta ?? {};
  const linked = (s.clusters ?? []).reduce((a, c) => a + c.heldPct, 0);
  const f = {
    safety: s.score / 100, narrative: r.narrative.score / 100, momentum: m.score / 100,
    bundle: (s.launchBundle?.initialPct ?? 0) / 30, linked: linked / 30, dev: (s.devPct ?? 0) / 20,
    top10: (s.top10Pct ?? 0) / 60, fresh: (s.freshPct ?? 0) / 100,
    progress: coin.progress / 100, speed: (m.progressPerMin ?? 0) / 20, buyers: (m.uniqueBuyers2m ?? 0) / 50,
    buysell: (m.buySellRatio ?? 0) / 5, wash: (m.washPct ?? 0) / 100, dust: (m.dustPct ?? 0) / 100,
    holders: (m.holders ?? 0) / 200, drawdown: (m.drawdownPct ?? 0) / 100, age: coin.ageSec() / 1800,
    twitter: meta.twitter ? 1 : 0, telegram: meta.telegram ? 1 : 0, website: meta.website ? 1 : 0,
    xpost: r.x ? 1 : 0, dexpaid: r.dexPaid ? 1 : 0, devsold: coin.devSold ? 1 : 0, mid: stage === 'mid' || stage === 'final' ? 1 : 0,
    deploytool: coin.deployTool ? 1 : 0, vamp: coin.copyOf ? 1 : 0,
  };
  return FEATURES.map(([k]) => clamp01(f[k]));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function trainLogistic(X, y, { epochs = 300, lr = 0.5, l2 = 0.002 } = {}) {
  const d = X[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  let b = Math.log(Math.max(1e-6, base) / Math.max(1e-6, 1 - base));
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b };
}

export const predict = (model, x) => sigmoid(x.reduce((z, v, j) => z + model.w[j] * v, model.b));

/** Of the top `share` of coins by predicted chance, how many actually hit? */
function topHitRate(ps, ys, share = 0.2) {
  const idx = ps.map((p, i) => i).sort((a, b) => ps[b] - ps[a]).slice(0, Math.max(1, Math.round(ps.length * share)));
  return idx.reduce((a, i) => a + ys[i], 0) / idx.length;
}

export class Learner {
  constructor({ store, cfg, log = console }) {
    this.store = store; this.cfg = cfg; this.log = log;
    this.model = store.getModel();
    this.lastTrainAt = 0;
    this.info = this.model ? 'Loaded saved model' : 'Collecting data';
  }

  /** Retrain on finished samples (time split: train on older coins, test on the newest). */
  train(now = Date.now()) {
    this.lastTrainAt = now;
    const rows = this.store.doneSamples(this.cfg.learnMaxSamples);
    const target = this.cfg.learnTarget;
    const data = rows.map((r) => ({ x: JSON.parse(r.features), y: r.mc_sol > 0 && r.peak_mc_sol / r.mc_sol >= target ? 1 : 0, at: r.at }))
      .filter((d) => d.x.length <= FEATURES.length)
      .map((d) => (d.x.length < FEATURES.length ? { ...d, x: [...d.x, ...new Array(FEATURES.length - d.x.length).fill(0)] } : d))
      .sort((a, b) => a.at - b.at);
    const pos = data.reduce((a, d) => a + d.y, 0);
    if (data.length < this.cfg.learnMinSamples || pos < 15) {
      this.info = `Collecting data: ${data.length}/${this.cfg.learnMinSamples} coins finished, ${pos} hit ${target}x`;
      return this.model;
    }
    const cut = Math.floor(data.length * 0.8);
    const train = data.slice(0, cut), test = data.slice(cut);
    const m = trainLogistic(train.map((d) => d.x), train.map((d) => d.y));
    const tp = test.map((d) => predict(m, d.x)), ty = test.map((d) => d.y);
    const testBase = ty.reduce((a, b) => a + b, 0) / ty.length;
    const testTop = topHitRate(tp, ty);
    const lift = testBase > 0 ? testTop / testBase : 0;
    const validated = lift >= this.cfg.learnMinLift && ty.reduce((a, b) => a + b, 0) >= 5;

    // Final model on all data; ranks let us turn a probability into a 0-100 percentile
    const full = trainLogistic(data.map((d) => d.x), data.map((d) => d.y));
    const ranks = data.map((d) => predict(full, d.x)).sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(ranks.length / 200));
    const means = FEATURES.map((_, j) => data.reduce((a, d) => a + d.x[j], 0) / data.length);
    const sds = FEATURES.map((_, j) => Math.sqrt(data.reduce((a, d) => a + (d.x[j] - means[j]) ** 2, 0) / data.length) || 0);
    const importance = FEATURES.map(([key, label], j) => ({ key, label, effect: +(full.w[j] * sds[j]).toFixed(3) }))
      .filter((f) => Math.abs(f.effect) >= 0.02).sort((a, b) => b.effect - a.effect);

    this.model = {
      w: full.w, b: full.b, n: data.length, pos, target, baseRate: pos / data.length,
      testN: test.length, testBase, testTop, lift: +lift.toFixed(2), validated,
      ranks: ranks.filter((_, i) => i % step === 0), importance, trainedAt: now, features: FEATURES.length,
    };
    this.store.saveModel(this.model);
    this.info = validated
      ? `Learned from ${data.length} coins: top picks hit ${target}x ${lift.toFixed(1)}x more often than average`
      : `Learned from ${data.length} coins but not yet better than the default scores (lift ${lift.toFixed(2)}x) - still using default scores`;
    this.log.info(`Learning: ${this.info}`);
    return this.model;
  }

  maybeTrain(now = Date.now()) {
    if (now - this.lastTrainAt >= this.cfg.learnEveryMin * 60_000) this.train(now);
  }

  /** Chance of hitting the target, and its percentile among past coins. */
  score(x) {
    const m = this.model;
    if (!m || m.features !== FEATURES.length) return null;
    const p = predict(m, x);
    let lo = 0, hi = m.ranks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (m.ranks[mid] <= p) lo = mid + 1; else hi = mid; }
    return { p, pct: Math.round((lo / m.ranks.length) * 100), validated: m.validated, baseRate: m.baseRate, target: m.target, n: m.n };
  }

  status() {
    const m = this.model;
    return {
      info: this.info, validated: Boolean(m?.validated), n: m?.n ?? 0, target: m?.target ?? this.cfg.learnTarget,
      baseRate: m?.baseRate ?? 0, lift: m?.lift ?? 0, testTop: m?.testTop ?? 0,
      top: (m?.importance ?? []).slice(0, 4), bottom: (m?.importance ?? []).slice(-4).reverse().filter((f) => f.effect < 0),
      samples: this.store.sampleCounts(),
    };
  }
}
