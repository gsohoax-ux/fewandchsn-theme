// SQLite storage: launch history (for dev/social reuse checks) and alert outcomes
// (so you can see over time whether the scores actually work).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
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
    `);
    // Older databases: add the launch-outcome columns used for "dev rugged before"
    const cols = new Set(this.db.prepare('PRAGMA table_info(launches)').all().map((c) => c.name));
    for (const [c, t] of [['ath_mc', 'REAL'], ['final_mc', 'REAL'], ['rugged', 'INTEGER'], ['graduated', 'INTEGER']]) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE launches ADD COLUMN ${c} ${t}`);
    }
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
      addSample: q(`INSERT OR IGNORE INTO samples VALUES (?,?,?,?,?,?,0,0)`),
      updSample: q(`UPDATE samples SET peak_mc_sol = MAX(peak_mc_sol, ?), migrated = MAX(migrated, ?), done = MAX(done, ?)
                    WHERE mint = ? AND stage = ?`),
      doneSamples: q(`SELECT * FROM samples WHERE done = 1 ORDER BY at DESC LIMIT ?`),
      finalize: q(`UPDATE samples SET done = 1 WHERE done = 0 AND at < ?`),
      sampleCounts: q(`SELECT SUM(done) done, COUNT(*) total FROM samples`),
      pruneSamples: q(`DELETE FROM samples WHERE at < ?`),
      setOutcome: q(`UPDATE launches SET ath_mc = ?, final_mc = ?, rugged = ?, graduated = ? WHERE mint = ?`),
      devHistory: q(`SELECT COUNT(*) finished, SUM(rugged) rugged, SUM(graduated) migrated FROM launches
                     WHERE creator = ? AND mint != ? AND rugged IS NOT NULL`),
      addPaper: q(`INSERT INTO paper_trades VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
      paperTrades: q(`SELECT * FROM paper_trades ORDER BY closed_at DESC LIMIT ?`),
      paperSince: q(`SELECT * FROM paper_trades WHERE closed_at >= ?`),
      getKv: q(`SELECT v FROM kv WHERE k = ?`),
      setKv: q(`INSERT OR REPLACE INTO kv VALUES (?, ?)`),
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
    this.s.addPaper.run(t.mint, t.symbol, t.openedAt, t.closedAt, t.costSol, t.proceedsSol, t.why, t.stage, t.score, t.entryMc, t.exitMc);
  }
  paperTrades(limit = 50) { return this.s.paperTrades.all(limit); }
  paperTradesSince(ms) { return this.s.paperSince.all(ms); }
  getKv(k) { try { return JSON.parse(this.s.getKv.get(k)?.v ?? 'null'); } catch { return null; } }
  setKv(k, v) { this.s.setKv.run(k, JSON.stringify(v)); }

  // ---- learning data ----
  addSample(mint, stage, at, features, mcSol) { this.s.addSample.run(mint, stage, at, JSON.stringify(features), mcSol, mcSol); }
  updateSample(mint, stage, peakMcSol, migrated, done) { this.s.updSample.run(peakMcSol, migrated ? 1 : 0, done ? 1 : 0, mint, stage); }
  doneSamples(limit = 20000) { return this.s.doneSamples.all(limit); }
  /** Samples whose outcome window has passed (e.g. lost in a restart) count as finished. */
  finalizeStale(beforeMs) { this.s.finalize.run(beforeMs); }
  sampleCounts() { const r = this.s.sampleCounts.get(); return { done: r.done ?? 0, total: r.total ?? 0 }; }
  getModel() { try { return JSON.parse(this.s.getKv.get('model')?.v ?? 'null'); } catch { return null; } }
  saveModel(m) { this.s.setKv.run('model', JSON.stringify(m)); }

  pruneOld(days = 14) {
    this.s.prune.run(Date.now() - days * 86400_000);
    this.s.pruneSamples.run(Date.now() - 60 * 86400_000);
  }
}
