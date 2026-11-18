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
    `);
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      addLaunch: q(`INSERT OR IGNORE INTO launches VALUES (?,?,?,?,?,?,?)`),
      setSocial: q(`UPDATE launches SET social_key = ?, tweet_key = ? WHERE mint = ?`),
      devCount: q(`SELECT COUNT(*) n FROM launches WHERE creator = ? AND created_at >= ?`),
      socialReuse: q(`SELECT mint FROM launches WHERE social_key = ? AND mint != ? LIMIT 20`),
      tweetCount: q(`SELECT COUNT(*) n FROM launches WHERE tweet_key = ? AND mint != ? AND created_at >= ?`),
      addAlert: q(`INSERT OR REPLACE INTO alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      updPeak: q(`UPDATE alerts SET peak_mc_sol = MAX(peak_mc_sol, ?), migrated = MAX(migrated, ?) WHERE mint = ?`),
      recentAlerts: q(`SELECT * FROM alerts ORDER BY at DESC LIMIT ?`),
      since: q(`SELECT * FROM alerts WHERE at >= ?`),
      prune: q(`DELETE FROM launches WHERE created_at < ?`),
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

  pruneOld(days = 14) { this.s.prune.run(Date.now() - days * 86400_000); }
}
