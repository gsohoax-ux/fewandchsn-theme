// System health: which outside services answer, how fast, when they last failed; background-job status;
// database health. Every outbound fetch is counted by provider, so nothing else has to report in.

const PROVIDERS = [
  ['helius', /helius/i, 'Helius (on-chain)'],
  ['dexscreener', /dexscreener\.com/i, 'DexScreener'],
  ['geckoterminal', /geckoterminal\.com/i, 'GeckoTerminal (charts)'],
  ['rugcheck', /rugcheck\.xyz/i, 'RugCheck'],
  ['solprice', /coinbase\.com|kraken\.com|coingecko\.com/i, 'SOL price'],
  ['google', /trends\.google/i, 'Google Trends'],
  ['wiki', /wikimedia\.org|wikipedia\.org/i, 'Wikipedia'],
  ['reddit', /reddit\.com/i, 'Reddit'],
  ['x', /api\.x\.com|api\.twitter\.com/i, 'X API'],
  ['ntfy', /ntfy/i, 'ntfy'],
  ['telegram', /api\.telegram\.org/i, 'Telegram'],
  ['ipfs', /ipfs|pinata|arweave|irys/i, 'Coin metadata (IPFS)'],
  ['anthropic', /anthropic\.com/i, 'Claude AI'],
];

export function providerOf(url) {
  const s = String(url);
  for (const [key, re, label] of PROVIDERS) if (re.test(s)) return { key, label };
  try { const h = new URL(s).hostname; return { key: h, label: h }; } catch { return { key: 'other', label: 'Other' }; }
}

export class Health {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.providers = new Map(); // key -> stats
    this.jobs = new Map();      // name -> stats
    this.started = now();
  }

  record(key, label, { ok, ms = 0, status = null, error = '' }) {
    const t = this.now();
    let p = this.providers.get(key);
    if (!p) { p = { key, label, calls: 0, fails: 0, lastOkAt: null, lastFailAt: null, lastError: '', lastStatus: null, ms: [], window: [] }; this.providers.set(key, p); }
    p.calls++;
    p.lastStatus = status;
    if (ok) p.lastOkAt = t; else { p.fails++; p.lastFailAt = t; p.lastError = error || (status ? `HTTP ${status}` : 'failed'); }
    p.ms.push(ms); if (p.ms.length > 50) p.ms.shift();
    p.window.push([t, ok]); while (p.window.length && t - p.window[0][0] > 15 * 60_000) p.window.shift();
  }

  /** Wrap a fetch so every call is recorded by provider. Returns the wrapped fetch. */
  instrument(fetchFn) {
    const self = this;
    const wrapped = async function healthFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const { key, label } = providerOf(url);
      const t0 = self.now();
      try {
        const res = await fetchFn(input, init);
        // 429 = rate limited: the provider works but is pushing back
        self.record(key, label, { ok: res.ok || res.status === 404, ms: self.now() - t0, status: res.status,
          error: res.status === 429 ? 'rate limited (HTTP 429)' : '' });
        return res;
      } catch (e) {
        self.record(key, label, { ok: false, ms: self.now() - t0, error: e?.name === 'TimeoutError' ? 'timed out' : e?.message ?? 'failed' });
        throw e;
      }
    };
    return wrapped;
  }

  /** Run `fn` every `everyMs`, recording each run. Errors are caught and recorded, never thrown. */
  job(name, fn, everyMs, { runNow = true } = {}) {
    const j = { name, everyMs, runs: 0, fails: 0, lastRunAt: null, lastOkAt: null, lastError: '', lastMs: 0, running: false };
    this.jobs.set(name, j);
    const run = async () => {
      if (j.running) return; // never overlap the same job
      j.running = true;
      const t0 = this.now();
      try { await fn(); j.lastOkAt = this.now(); }
      catch (e) { j.fails++; j.lastError = e?.message ?? String(e); }
      finally { j.runs++; j.lastRunAt = this.now(); j.lastMs = this.now() - t0; j.running = false; }
    };
    const timer = setInterval(run, everyMs); timer.unref?.();
    if (runNow) run();
    return { run, stop: () => clearInterval(timer) };
  }

  /** Mark a job run that is scheduled elsewhere (e.g. the engine's own timers). */
  beat(name, everyMs, ok = true, error = '') {
    let j = this.jobs.get(name);
    if (!j) { j = { name, everyMs, runs: 0, fails: 0, lastRunAt: null, lastOkAt: null, lastError: '', lastMs: 0, running: false }; this.jobs.set(name, j); }
    j.runs++; j.lastRunAt = this.now();
    if (ok) j.lastOkAt = j.lastRunAt; else { j.fails++; j.lastError = error; }
  }

  view({ store = null, extra = {} } = {}) {
    const t = this.now();
    const providers = [...this.providers.values()].map((p) => {
      const recent = p.window.length, recentFails = p.window.filter(([, ok]) => !ok).length;
      const state = !recent ? 'idle' : recentFails === 0 ? 'ok' : recentFails / recent < 0.3 ? 'degraded' : 'down';
      const ms = [...p.ms].sort((a, b) => a - b);
      return { key: p.key, label: p.label, state, calls: p.calls, fails: p.fails, recentCalls: recent, recentFails,
        lastOkAgoSec: p.lastOkAt ? Math.round((t - p.lastOkAt) / 1000) : null,
        lastFailAgoSec: p.lastFailAt ? Math.round((t - p.lastFailAt) / 1000) : null,
        lastError: p.lastError, medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null };
    }).sort((a, b) => b.calls - a.calls);
    const jobs = [...this.jobs.values()].map((j) => {
      const late = j.lastRunAt == null ? t - this.started > j.everyMs * 3 : t - j.lastRunAt > j.everyMs * 3;
      return { name: j.name, everyMs: j.everyMs, runs: j.runs, fails: j.fails, lastError: j.lastError, lastMs: j.lastMs,
        lastRunAgoSec: j.lastRunAt ? Math.round((t - j.lastRunAt) / 1000) : null,
        state: late ? 'late' : j.lastRunAt && j.lastOkAt !== j.lastRunAt ? 'failing' : j.lastRunAt ? 'ok' : 'waiting' };
    });
    return { uptimeSec: Math.round((t - this.started) / 1000), providers, jobs, db: store ? dbHealth(store) : null, ...extra };
  }
}

/** Database health: can we read and write, how big, how much history. */
export function dbHealth(store) {
  const out = { ok: false, error: '', tables: {} };
  try {
    const t0 = Date.now();
    store.db.prepare('SELECT 1').get();
    store.setKv('healthcheck', Date.now());
    for (const t of ['launches', 'alerts', 'samples', 'paper_trades', 'sim_positions', 'sim_fills', 'strategy_signals', 'audit_log']) {
      try { out.tables[t] = store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { /* table not present */ }
    }
    const pc = store.db.prepare('PRAGMA page_count').get()?.page_count ?? 0;
    const ps = store.db.prepare('PRAGMA page_size').get()?.page_size ?? 0;
    out.sizeMb = +((pc * ps) / 1e6).toFixed(2);
    out.path = store.path ?? '';
    out.persistent = store.path && store.path !== ':memory:';
    out.ms = Date.now() - t0;
    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}
