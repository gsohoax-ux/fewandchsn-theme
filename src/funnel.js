// Funnel counters: how many coins / signals / trades reach each step, and why the rest stop.
// Counted in memory and written to the database every 30 s in hourly buckets, so the numbers survive
// restarts and deploys (the old in-memory "Why they died" counts reset on every restart).

export class Funnel {
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
    this.pending = new Map(); // `${hour}|${key}` -> n
    store.db.exec(`CREATE TABLE IF NOT EXISTS funnel (hour INTEGER, key TEXT, n INTEGER, PRIMARY KEY (hour, key))`);
    this.upsert = store.db.prepare(`INSERT INTO funnel (hour, key, n) VALUES (?,?,?) ON CONFLICT(hour, key) DO UPDATE SET n = n + excluded.n`);
    this.read = store.db.prepare(`SELECT key, SUM(n) n FROM funnel WHERE hour >= ? GROUP BY key`);
    this.hours = store.db.prepare(`SELECT MIN(hour) first, MAX(hour) last, COUNT(DISTINCT hour) n FROM funnel WHERE hour >= ?`);
    this.byHour = store.db.prepare(`SELECT hour, n FROM funnel WHERE key = ? AND hour >= ? ORDER BY hour`);
    this.prune = store.db.prepare(`DELETE FROM funnel WHERE hour < ?`);
    this.timer = setInterval(() => this.flush(), 30_000);
    this.timer.unref?.();
  }

  #hour(t = this.now()) { return Math.floor(t / 3600_000); }

  count(key, n = 1) {
    if (!key) return;
    const k = `${this.#hour()}|${String(key).slice(0, 160)}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + n);
    if (this.pending.size > 5000) this.flush();
  }

  flush() {
    if (!this.pending.size) return;
    const rows = [...this.pending]; this.pending.clear();
    try { for (const [k, n] of rows) { const i = k.indexOf('|'); this.upsert.run(Number(k.slice(0, i)), k.slice(i + 1), n); } }
    catch { /* database busy: drop this batch rather than block the bot */ }
    if (Math.random() < 0.02) this.prune.run(this.#hour() - 24 * 30);
  }

  /** Totals per key over the last `hours` (including what hasn't been written yet). */
  totals(hours = 24) {
    this.flush();
    const since = this.#hour() - hours + 1;
    const out = {};
    for (const r of this.read.all(since)) out[r.key] = r.n;
    const span = this.hours.get(since);
    return { counts: out, hoursCovered: span?.n ?? 0, firstHour: span?.first ? span.first * 3600_000 : null };
  }

  series(key, hours = 24) {
    this.flush();
    return this.byHour.all(key, this.#hour() - hours + 1).map((r) => [r.hour * 3600_000, r.n]);
  }
}

/** Turn a free-text reason into a stable bucket (numbers removed) so counts group together. */
export function reasonKey(text) {
  return String(text ?? 'unknown').replace(/\$?[\d][\d,.]*[%sKkMm]?/g, 'N').replace(/\s+/g, ' ').replace(/\(.*?\)/g, '').trim().slice(0, 110);
}
