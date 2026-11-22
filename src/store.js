// SQLite storage: launch history (for dev/social reuse checks) and alert outcomes
// (so you can see over time whether the scores actually work).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS launches (
        mint TEXT PRIMARY KEY, creator TEXT, symbol TEXT, name TEXT,
        social_key TEXT, tweet_key TEXT, created_at INTEGER);
      CREATE INDEX IF NOT EXISTS launches_creator ON launches(creator, created_at);
      CREATE INDEX IF NOT EXISTS launches_social ON launches(social_key);
      CREATE INDEX IF NOT EXISTS launches_tweet ON launches(tweet_key, created_at);
      CREATE TABLE IF NOT EXISTS alerts (
        mint TEXT, stage TEXT, symbol TEXT, name TEXT, at INTEGER, score INTEGER,
        safety TEXT, narrative INTEGER, momentum INTEGER, mc_sol REAL,
        peak_mc_sol REAL, migrated INTEGER DEFAULT 0, PRIMARY KEY (mint, stage));
      CREATE TABLE IF NOT EXISTS samples (
        mint TEXT, stage TEXT, at INTEGER, features TEXT, mc_sol REAL, peak_mc_sol REAL,
        migrated INTEGER DEFAULT 0, done INTEGER DEFAULT 0, PRIMARY KEY (mint, stage));
      CREATE INDEX IF NOT EXISTS samples_done ON samples(done, at);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS paper_trades (
        mint TEXT, symbol TEXT, opened_at INTEGER, closed_at INTEGER, cost_sol REAL, proceeds_sol REAL,
        why TEXT, stage TEXT, score INTEGER, entry_mc REAL, exit_mc REAL);
      -- Simulated positions for the manual book and the strategy book (never the automatic System A)
      CREATE TABLE IF NOT EXISTS sim_positions (
        id TEXT PRIMARY KEY, book TEXT NOT NULL, mint TEXT NOT NULL, status TEXT NOT NULL,
        opened_at INTEGER, closed_at INTEGER, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sim_positions_book ON sim_positions(book, status);
      CREATE TABLE IF NOT EXISTS sim_fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, book TEXT NOT NULL, position_id TEXT NOT NULL, idem_key TEXT UNIQUE,
        at INTEGER, kind TEXT, reason TEXT, pct REAL, tokens REAL, price_usd REAL, gross_usd REAL,
        fees_usd REAL, slippage_usd REAL, net_usd REAL, mc_usd REAL);
      CREATE INDEX IF NOT EXISTS sim_fills_pos ON sim_fills(position_id);
      CREATE TABLE IF NOT EXISTS strategy_signals (
        id TEXT PRIMARY KEY, setup TEXT, mint TEXT, symbol TEXT, at INTEGER, status TEXT, regime TEXT, data TEXT);
      CREATE INDEX IF NOT EXISTS strategy_signals_at ON strategy_signals(at);
      CREATE INDEX IF NOT EXISTS strategy_signals_setup ON strategy_signals(setup, mint, at);
      -- Copy trading: followed wallets and every transaction seen for them (one row per wallet + signature + token)
      CREATE TABLE IF NOT EXISTS copy_traders (
        wallet TEXT PRIMARY KEY, label TEXT, enabled INTEGER, paused INTEGER, settings TEXT, added_at INTEGER, last_sig TEXT);
      CREATE TABLE IF NOT EXISTS copy_events (
        id TEXT PRIMARY KEY, wallet TEXT, signature TEXT, mint TEXT, kind TEXT, action TEXT, at INTEGER, data TEXT);
      CREATE INDEX IF NOT EXISTS copy_events_at ON copy_events(at);
      CREATE INDEX IF NOT EXISTS copy_events_wallet ON copy_events(wallet, at);
      -- Setuh trader activity feed (what the autonomous trader did, step by step)
      CREATE TABLE IF NOT EXISTS setuh_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, mint TEXT, data TEXT);
      CREATE INDEX IF NOT EXISTS setuh_activity_at ON setuh_activity(at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor TEXT, book TEXT, action TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
    `);
    // Older databases: add the launch-outcome columns used for "dev rugged before"
    const cols = new Set(this.db.prepare('PRAGMA table_info(launches)').all().map((c) => c.name));
    for (const [c, t] of [['ath_mc', 'REAL'], ['final_mc', 'REAL'], ['rugged', 'INTEGER'], ['graduated', 'INTEGER']]) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE launches ADD COLUMN ${c} ${t}`);
    }
    // ...and the per-trade evaluation columns for paper trades
    const pcols = new Set(this.db.prepare('PRAGMA table_info(paper_trades)').all().map((c) => c.name));
    for (const c of ['entry_progress', 'mfe', 'mae', 'hurdle', 'regime']) {
      if (!pcols.has(c)) this.db.exec(`ALTER TABLE paper_trades ADD COLUMN ${c} REAL`);
    }
    if (!pcols.has('deploy_tool')) this.db.exec('ALTER TABLE paper_trades ADD COLUMN deploy_tool TEXT');
    const scols = new Set(this.db.prepare('PRAGMA table_info(samples)').all().map((c) => c.name));
    if (!scols.has('score')) this.db.exec('ALTER TABLE samples ADD COLUMN score INTEGER');
    if (!scols.has('low_mc_sol')) this.db.exec('ALTER TABLE samples ADD COLUMN low_mc_sol REAL');
    if (!pcols.has('vamp')) this.db.exec('ALTER TABLE paper_trades ADD COLUMN vamp INTEGER');
    if (!pcols.has('runner')) this.db.exec('ALTER TABLE paper_trades ADD COLUMN runner INTEGER');
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      addLaunch: q(`INSERT OR IGNORE INTO launches (mint, creator, symbol, name, social_key, tweet_key, created_at) VALUES (?,?,?,?,?,?,?)`),
      setSocial: q(`UPDATE launches SET social_key = ?, tweet_key = ? WHERE mint = ?`),
      devCount: q(`SELECT COUNT(*) n FROM launches WHERE creator = ? AND created_at >= ?`),
      socialReuse: q(`SELECT mint FROM launches WHERE social_key = ? AND mint != ? LIMIT 20`),
      tweetCount: q(`SELECT COUNT(*) n FROM launches WHERE tweet_key = ? AND mint != ? AND created_at >= ?`),
      addAlert: q(`INSERT OR REPLACE INTO alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      updPeak: q(`UPDATE alerts SET peak_mc_sol = MAX(peak_mc_sol, ?), migrated = MAX(migrated, ?) WHERE mint = ?`),
      recentAlerts: q(`SELECT * FROM alerts ORDER BY at DESC LIMIT ?`),
      since: q(`SELECT * FROM alerts WHERE at >= ?`),
      prune: q(`DELETE FROM launches WHERE created_at < ?`),
      addSample: q(`INSERT OR IGNORE INTO samples (mint, stage, at, features, mc_sol, peak_mc_sol, migrated, done, score, low_mc_sol)
                    VALUES (?,?,?,?,?,?,0,0,?,?)`),
      setLow: q(`UPDATE samples SET low_mc_sol = MIN(COALESCE(low_mc_sol, ?), ?) WHERE mint = ? AND stage = ?`),
      similarOutcomes: q(`SELECT mc_sol, peak_mc_sol, low_mc_sol FROM samples
                          WHERE done = 1 AND score BETWEEN ? AND ? AND at >= ? AND mc_sol > 0 ORDER BY at DESC LIMIT 3000`),
      updSample: q(`UPDATE samples SET peak_mc_sol = MAX(peak_mc_sol, ?), migrated = MAX(migrated, ?), done = MAX(done, ?)
                    WHERE mint = ? AND stage = ?`),
      doneSamples: q(`SELECT * FROM samples WHERE done = 1 ORDER BY at DESC LIMIT ?`),
      finalize: q(`UPDATE samples SET done = 1 WHERE done = 0 AND at < ?`),
      sampleCounts: q(`SELECT SUM(done) done, COUNT(*) total FROM samples`),
      pruneSamples: q(`DELETE FROM samples WHERE at < ?`),
      setOutcome: q(`UPDATE launches SET ath_mc = ?, final_mc = ?, rugged = ?, graduated = ? WHERE mint = ?`),
      devHistory: q(`SELECT COUNT(*) finished, SUM(rugged) rugged, SUM(graduated) migrated FROM launches
                     WHERE creator = ? AND mint != ? AND rugged IS NOT NULL`),
      addPaper: q(`INSERT INTO paper_trades (mint, symbol, opened_at, closed_at, cost_sol, proceeds_sol, why, stage, score,
                   entry_mc, exit_mc, entry_progress, mfe, mae, hurdle, regime, deploy_tool, vamp, runner)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      paperTrades: q(`SELECT * FROM paper_trades ORDER BY closed_at DESC LIMIT ?`),
      paperSince: q(`SELECT * FROM paper_trades WHERE closed_at >= ?`),
      getKv: q(`SELECT v FROM kv WHERE k = ?`),
      setKv: q(`INSERT OR REPLACE INTO kv VALUES (?, ?)`),
      simUpsert: q(`INSERT INTO sim_positions (id, book, mint, status, opened_at, closed_at, data) VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET status = excluded.status, closed_at = excluded.closed_at, data = excluded.data`),
      simByBook: q(`SELECT data FROM sim_positions WHERE book = ? AND status = ? ORDER BY opened_at DESC LIMIT ?`),
      simFill: q(`INSERT OR IGNORE INTO sim_fills (book, position_id, idem_key, at, kind, reason, pct, tokens, price_usd, gross_usd,
                  fees_usd, slippage_usd, net_usd, mc_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      simFillsFor: q(`SELECT * FROM sim_fills WHERE position_id = ? ORDER BY at`),
      sigUpsert: q(`INSERT INTO strategy_signals (id, setup, mint, symbol, at, status, regime, data) VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`),
      sigRecent: q(`SELECT * FROM strategy_signals ORDER BY at DESC LIMIT ?`),
      sigCounts: q(`SELECT setup, status, COUNT(*) n FROM strategy_signals WHERE at >= ? GROUP BY setup, status`),
      ctUpsert: q(`INSERT INTO copy_traders (wallet, label, enabled, paused, settings, added_at, last_sig) VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(wallet) DO UPDATE SET label = excluded.label, enabled = excluded.enabled, paused = excluded.paused, settings = excluded.settings`),
      ctAll: q(`SELECT * FROM copy_traders ORDER BY added_at`),
      ctDel: q(`DELETE FROM copy_traders WHERE wallet = ?`),
      ctLastSig: q(`UPDATE copy_traders SET last_sig = ? WHERE wallet = ?`),
      ceClaim: q(`INSERT OR IGNORE INTO copy_events (id, wallet, signature, mint, kind, action, at, data) VALUES (?,?,?,?,?,?,?,?)`),
      ceUpdate: q(`UPDATE copy_events SET kind = ?, action = ?, data = ? WHERE id = ?`),
      ceRecent: q(`SELECT data FROM copy_events ORDER BY at DESC LIMIT ?`),
      ceRecentFor: q(`SELECT data FROM copy_events WHERE wallet = ? ORDER BY at DESC LIMIT ?`),
      ceCounts: q(`SELECT wallet, action, COUNT(*) n FROM copy_events GROUP BY wallet, action`),
      ceSeen: q(`SELECT 1 FROM copy_events WHERE wallet = ? AND signature = ? LIMIT 1`),
      cePrune: q(`DELETE FROM copy_events WHERE at < ? AND action = 'ignored'`),
      actAdd: q(`INSERT INTO setuh_activity (at, type, mint, data) VALUES (?,?,?,?)`),
      actRecent: q(`SELECT id, data FROM setuh_activity ORDER BY id DESC LIMIT ?`),
      actPrune: q(`DELETE FROM setuh_activity WHERE at < ?`),
      sigAll: q(`SELECT data FROM strategy_signals WHERE at >= ? ORDER BY at DESC LIMIT ?`),
      audit: q(`INSERT INTO audit_log (at, actor, book, action, detail) VALUES (?,?,?,?,?)`),
      auditRecent: q(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`),
      pruneAudit: q(`DELETE FROM audit_log WHERE at < ?`),
      pruneSignals: q(`DELETE FROM strategy_signals WHERE at < ? AND status IN ('watch', 'rejected')`),
      similar: q(`SELECT COUNT(*) n, SUM(CASE WHEN peak_mc_sol >= 1.5 * mc_sol THEN 1 ELSE 0 END) hits
                  FROM alerts WHERE score BETWEEN ? AND ? AND at BETWEEN ? AND ?`),
    };
  }

  addLaunch(c) {
    this.s.addLaunch.run(c.mint, c.creator ?? '', c.symbol, c.name, null, null, c.createdAt);
  }
  setSocials(mint, socialKey, tweetKey) { this.s.setSocial.run(socialKey, tweetKey, mint); }
  devLaunches(creator, sinceMs) { return this.s.devCount.get(creator, sinceMs).n; }
  socialReuse(key, mint) { return key ? this.s.socialReuse.all(key, mint).map((r) => r.mint) : []; }
  sameTweetCoins(key, mint, sinceMs) { return key ? this.s.tweetCount.get(key, mint, sinceMs).n : 0; }

  addAlert(coin, stage, r) {
    this.s.addAlert.run(coin.mint, stage, coin.symbol, coin.name, Date.now(), r.score,
      r.safety.verdict, r.narrative.score, r.momentum.score, coin.mcSol, coin.mcSol, coin.migrated ? 1 : 0);
  }
  updatePeak(mint, peakMcSol, migrated) { this.s.updPeak.run(peakMcSol, migrated ? 1 : 0, mint); }
  recentAlerts(limit = 30) { return this.s.recentAlerts.all(limit); }

  /** How did alerts do? Peak multiple after the alert, migration rate. */
  stats(sinceMs = Date.now() - 7 * 86400_000) {
    const rows = this.s.since.all(sinceMs);
    const mult = (r) => (r.mc_sol ? r.peak_mc_sol / r.mc_sol : 1);
    const n = rows.length;
    const pct = (f) => (n ? Math.round((rows.filter(f).length / n) * 100) : 0);
    return {
      alerts: n,
      hit2x: pct((r) => mult(r) >= 2),
      hit1_5x: pct((r) => mult(r) >= 1.5),
      migrated: pct((r) => r.migrated),
      medianPeak: n ? +rows.map(mult).sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(2) : 0,
    };
  }

  /** Past alerts with a similar score, at least 1h old so their outcome is known. */
  similarAlerts(score, now = Date.now()) {
    const r = this.s.similar.get(score - 5, score + 5, now - 14 * 86400_000, now - 3600_000);
    return { n: r.n ?? 0, hits: r.hits ?? 0 };
  }

  // ---- launch outcomes (for "dev rugged before") ----
  setOutcome(mint, athMc, finalMc, rugged, graduated) { this.s.setOutcome.run(athMc, finalMc, rugged ? 1 : 0, graduated ? 1 : 0, mint); }
  devHistory(creator, mint) {
    const r = this.s.devHistory.get(creator ?? '', mint);
    return { finished: r.finished ?? 0, rugged: r.rugged ?? 0, migrated: r.migrated ?? 0 };
  }

  // ---- paper trading ----
  addPaperTrade(t) {
    this.s.addPaper.run(t.mint, t.symbol, t.openedAt, t.closedAt, t.costSol, t.proceedsSol, t.why, t.stage ?? null, t.score ?? null, t.entryMc ?? null, t.exitMc ?? null,
      t.entryProgress ?? null, t.mfe ?? null, t.mae ?? null, t.hurdle ?? null, t.regime ?? null, t.deployTool ?? null, t.vamp ?? 0, t.runner ?? 0);
  }
  paperTrades(limit = 50) { return this.s.paperTrades.all(limit); }
  paperTradesSince(ms) { return this.s.paperSince.all(ms); }
  getKv(k) { try { return JSON.parse(this.s.getKv.get(k)?.v ?? 'null'); } catch { return null; } }
  setKv(k, v) { this.s.setKv.run(k, JSON.stringify(v)); }

  // ---- learning data ----
  addSample(mint, stage, at, features, mcSol, score = null) {
    this.s.addSample.run(mint, stage, at, JSON.stringify(features), mcSol, mcSol, score, mcSol);
  }
  setSampleLow(mint, stage, lowMcSol) { this.s.setLow.run(lowMcSol, lowMcSol, mint, stage); }

  /** What happened to past coins with a similar score (needs enough finished coins to mean anything). */
  similarOutcomes(score, sinceMs = Date.now() - 14 * 86400_000, minN = 30) {
    // cached for a minute per score: the dashboard asks for many coins every few seconds
    this.outcomeCache ??= new Map();
    const key = `${score}|${minN}`;
    const hit = this.outcomeCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.val;
    const val = this.#similarOutcomes(score, sinceMs, minN);
    this.outcomeCache.set(key, { at: Date.now(), val });
    return val;
  }

  #similarOutcomes(score, sinceMs, minN) {
    const rows = this.s.similarOutcomes.all(score - 5, score + 5, sinceMs);
    if (rows.length < minN) return null;
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const peaks = rows.map((r) => r.peak_mc_sol / r.mc_sol);
    const drops = rows.filter((r) => r.low_mc_sol != null).map((r) => 1 - r.low_mc_sol / r.mc_sol);
    return {
      n: rows.length, scoreFrom: score - 5, scoreTo: score + 5,
      medianPeakPct: (med(peaks) - 1) * 100,
      hit1_5: Math.round((peaks.filter((p) => p >= 1.5).length / rows.length) * 100),
      hit2: Math.round((peaks.filter((p) => p >= 2).length / rows.length) * 100),
      hit3: Math.round((peaks.filter((p) => p >= 3).length / rows.length) * 100),
      hit5: Math.round((peaks.filter((p) => p >= 5).length / rows.length) * 100),
      medianDropPct: drops.length >= minN ? med(drops) * 100 : null,
    };
  }
  updateSample(mint, stage, peakMcSol, migrated, done) { this.s.updSample.run(peakMcSol, migrated ? 1 : 0, done ? 1 : 0, mint, stage); }
  doneSamples(limit = 20000) { return this.s.doneSamples.all(limit); }
  /** Samples whose outcome window has passed (e.g. lost in a restart) count as finished. */
  finalizeStale(beforeMs) { this.s.finalize.run(beforeMs); }
  sampleCounts() { const r = this.s.sampleCounts.get(); return { done: r.done ?? 0, total: r.total ?? 0 }; }
  getModel() { try { return JSON.parse(this.s.getKv.get('model')?.v ?? 'null'); } catch { return null; } }
  saveModel(m) { this.s.setKv.run('model', JSON.stringify(m)); }

  // ---- simulated positions (manual + strategy books) ----
  saveSimPosition(book, pos) {
    this.s.simUpsert.run(pos.id, book, pos.mint, pos.status, pos.openedAt ?? null, pos.closedAt ?? null, JSON.stringify(pos));
  }
  simPositions(book, status, limit = 500) {
    return this.s.simByBook.all(book, status, limit).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  }
  /** Records a fill once. Returns false if a fill with the same idempotency key already exists. */
  addSimFill(book, f) {
    const r = this.s.simFill.run(book, f.positionId, f.idemKey ?? null, f.at, f.kind, f.reason ?? '', f.pct ?? null, f.tokens ?? null,
      f.priceUsd ?? null, f.grossUsd ?? null, f.feesUsd ?? null, f.slippageUsd ?? null, f.netUsd ?? null, f.mcUsd ?? null);
    return r.changes > 0;
  }
  simFills(positionId) { return this.s.simFillsFor.all(positionId); }

  // ---- strategy signals ----
  saveSignal(sig) {
    this.s.sigUpsert.run(sig.id, sig.setup, sig.mint, sig.symbol ?? '', sig.at, sig.status, sig.regime ?? null, JSON.stringify(sig));
  }
  recentSignals(limit = 100) {
    return this.s.sigRecent.all(limit).map((r) => { try { return { ...JSON.parse(r.data), status: r.status }; } catch { return null; } }).filter(Boolean);
  }
  signalCounts(sinceMs = 0) { return this.s.sigCounts.all(sinceMs); }

  // ---- copy trading ----
  saveCopyTrader(t) {
    this.s.ctUpsert.run(t.wallet, t.label ?? '', t.enabled ? 1 : 0, t.paused ? 1 : 0, JSON.stringify(t.settings ?? {}), t.addedAt ?? Date.now(), t.lastSig ?? null);
  }
  copyTraders() {
    return this.s.ctAll.all().map((r) => ({ wallet: r.wallet, label: r.label, enabled: Boolean(r.enabled), paused: Boolean(r.paused),
      settings: (() => { try { return JSON.parse(r.settings); } catch { return {}; } })(), addedAt: r.added_at, lastSig: r.last_sig }));
  }
  removeCopyTrader(wallet) { this.s.ctDel.run(wallet); }
  setCopyLastSig(wallet, sig) { this.s.ctLastSig.run(sig, wallet); }
  /** Reserve an event id. Returns false if this wallet + signature + token was already handled (no double copies). */
  claimCopyEvent(ev) { return this.s.ceClaim.run(ev.id, ev.wallet, ev.signature, ev.mint ?? '', ev.kind, ev.action, ev.at, JSON.stringify(ev)).changes > 0; }
  updateCopyEvent(ev) { this.s.ceUpdate.run(ev.kind, ev.action, JSON.stringify(ev), ev.id); }
  copySignatureSeen(wallet, sig) { return Boolean(this.s.ceSeen.get(wallet, sig)); }
  copyEvents(limit = 200, wallet = null) {
    const rows = wallet ? this.s.ceRecentFor.all(wallet, limit) : this.s.ceRecent.all(limit);
    return rows.map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  }
  copyEventCounts() { return this.s.ceCounts.all(); }

  // ---- Setuh trader activity ----
  addActivity(ev) { this.s.actAdd.run(ev.at ?? Date.now(), ev.type, ev.mint ?? '', JSON.stringify(ev)); }
  recentActivity(limit = 200) {
    return this.s.actRecent.all(limit).map((r) => { try { return { id: r.id, ...JSON.parse(r.data) }; } catch { return null; } }).filter(Boolean);
  }
  signalsSince(ms, limit = 5000) { return this.s.sigAll.all(ms, limit).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean); }

  // ---- audit log ----
  audit(actor, book, action, detail = {}) {
    try { this.s.audit.run(Date.now(), actor, book ?? '', action, JSON.stringify(detail)); } catch { /* never block on the audit log */ }
  }
  recentAudit(limit = 100) {
    return this.s.auditRecent.all(limit).map((r) => ({ ...r, detail: (() => { try { return JSON.parse(r.detail); } catch { return r.detail; } })() }));
  }

  /**
   * Learning Center: what actually happened to scored coins (finished 2-hour windows only).
   * Grouped by stage, by score band, and by narrative band. Past results, not predictions.
   */
  learningReport(target = 1.5) {
    if (this.lrCache && Date.now() - this.lrCache.at < 5 * 60_000) return this.lrCache.val;
    const rows = this.s.doneSamples.all(20000).filter((r) => r.mc_sol > 0);
    const summarize = (list) => {
      if (!list.length) return { n: 0 };
      const peaks = list.map((r) => r.peak_mc_sol / r.mc_sol).sort((a, b) => a - b);
      return { n: list.length, hitTarget: Math.round((peaks.filter((p) => p >= target).length / list.length) * 100),
        hit2: Math.round((peaks.filter((p) => p >= 2).length / list.length) * 100),
        graduated: Math.round((list.filter((r) => r.migrated).length / list.length) * 100),
        medianPeakPct: Math.round((peaks[Math.floor(peaks.length / 2)] - 1) * 100) };
    };
    const group = (keyFn) => {
      const m = new Map();
      for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return [...m.entries()].map(([key, list]) => ({ key, ...summarize(list) }));
    };
    const feat = (r, i) => { try { return JSON.parse(r.features)[i]; } catch { return null; } };
    const band = (x) => (x == null ? null : x >= 80 ? '80+' : x >= 65 ? '65–79' : x >= 50 ? '50–64' : 'under 50');
    const order = ['80+', '65–79', '50–64', 'under 50'];
    const byOrder = (a, b) => order.indexOf(a.key) - order.indexOf(b.key);
    const val = {
      target, overall: summarize(rows),
      byStage: group((r) => r.stage).sort((a, b) => b.n - a.n),
      byScore: group((r) => band(r.score)).sort(byOrder),
      byNarrative: group((r) => { const f = feat(r, 1); return f == null ? null : band(f * 100); }).sort(byOrder),
      bySafety: group((r) => { const f = feat(r, 0); return f == null ? null : band(f * 100); }).sort(byOrder),
      firstAt: rows.length ? Math.min(...rows.map((r) => r.at)) : null,
    };
    this.lrCache = { at: Date.now(), val };
    return val;
  }

  pruneOld(days = 14) {
    this.s.pruneAudit.run(Date.now() - 90 * 86400_000);
    this.s.cePrune.run(Date.now() - 14 * 86400_000);
    this.s.actPrune.run(Date.now() - 30 * 86400_000);
    this.s.pruneSignals.run(Date.now() - 14 * 86400_000);
    this.s.prune.run(Date.now() - days * 86400_000);
    this.s.pruneSamples.run(Date.now() - 60 * 86400_000);
  }
}
