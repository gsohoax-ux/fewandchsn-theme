// Latency and throughput metrics: small ring buffers with p50 / p95, rates and gauges.
// Used by the live-feed health panel to find bottlenecks. Nothing here is estimated: every number is measured.

export class Metrics {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.series = new Map(); // name -> { vals: [[ts, ms]], label, unit }
    this.counters = new Map(); // name -> [ts...] (last 10 min)
    this.gauges = new Map();
  }

  /** Record one timing (ms). */
  time(name, ms, label = name) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let s = this.series.get(name);
    if (!s) { s = { label, vals: [] }; this.series.set(name, s); }
    s.vals.push([this.now(), ms]);
    if (s.vals.length > 500) s.vals.splice(0, s.vals.length - 500);
  }

  /** Time an async function. */
  async measure(name, fn, label = name) {
    const t0 = performance.now();
    try { return await fn(); } finally { this.time(name, performance.now() - t0, label); }
  }

  count(name) {
    let c = this.counters.get(name);
    if (!c) { c = []; this.counters.set(name, c); }
    const t = this.now();
    c.push(t);
    while (c.length && t - c[0] > 600_000) c.shift();
  }

  gauge(name, value) { this.gauges.set(name, { value, at: this.now() }); }

  stat(name, windowMs = 300_000) {
    const s = this.series.get(name);
    if (!s) return null;
    const t = this.now();
    const v = s.vals.filter(([ts]) => t - ts <= windowMs).map(([, ms]) => ms).sort((a, b) => a - b);
    if (!v.length) return { label: s.label, n: 0 };
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return { label: s.label, n: v.length, p50: q(0.5), p95: q(0.95), max: v.at(-1), last: s.vals.at(-1)[1] };
  }

  /** Events per minute over the last `windowMs`. */
  rate(name, windowMs = 60_000) {
    const c = this.counters.get(name) ?? [];
    const t = this.now();
    return (c.filter((ts) => t - ts <= windowMs).length * 60_000) / windowMs;
  }

  view() {
    return {
      timings: Object.fromEntries([...this.series.keys()].map((k) => [k, this.stat(k)])),
      rates: Object.fromEntries([...this.counters.keys()].map((k) => [k, this.rate(k)])),
      gauges: Object.fromEntries([...this.gauges.entries()].map(([k, g]) => [k, { ...g, ageSec: Math.round((this.now() - g.at) / 1000) }])),
    };
  }
}

/** Event-loop lag: how late a 100 ms timer fires. High lag = the process is too busy to react quickly. */
export function watchEventLoop(metrics, everyMs = 100) {
  let last = performance.now();
  const t = setInterval(() => {
    const n = performance.now();
    metrics.time('eventLoopLag', Math.max(0, n - last - everyMs), 'Event-loop lag');
    last = n;
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
