// Measures the real Engine's evaluation queue when Helius is rate-limited.
// ASSUMED limits (state them in the report): rpcRps for regular RPC, enhancedRps for the enhanced API (wallet lookups),
// 150 ms latency per call. Real engine + real demo coin stream; only the Helius client is simulated.
import { Engine } from '../src/engine.js';
import { DemoFeed, DemoChain } from '../src/feed.js';
import { Store } from '../src/store.js';
import { Metrics } from '../src/metrics.js';
import { config } from '../src/config.js';

const [rpcRps, enhancedRps, seconds] = process.argv.slice(2).map(Number);
const quiet = { info() {}, warn() {} };
const bucket = (rps) => { let next = 0; return async () => { if (!rps) return; const now = Date.now(); const at = Math.max(now, next); next = at + 1000 / rps; await new Promise((r) => setTimeout(r, at - now)); }; };
const rpc = bucket(rpcRps), enh = bucket(enhancedRps);
const lat = () => new Promise((r) => setTimeout(r, 150));
const demoChain = new DemoChain();
let calls = 0;
const chain = { enabled: true,
  async getSignatureSlots(m) { calls++; await rpc(); await lat(); return demoChain.getSignatureSlots(m); },
  async getWalletInfo(w) { calls++; await enh(); await lat(); return demoChain.getWalletInfo(w); },
  async isService() { calls++; await rpc(); await lat(); return false; } };
const feed = new DemoFeed(demoChain, quiet, null);
const store = new Store(':memory:');
const notifier = { alert: async () => {}, warn() {}, info() {}, picks() {}, channels: [] };
const cfg = { ...config, demo: true, dexCheck: false, alertTargetPerDay: 15 };
const engine = new Engine({ cfg, feed, chain, store, notifier, ai: { enabled: false }, log: quiet });
engine.metrics = new Metrics();
engine.start();
setTimeout(() => {
  const w = engine.metrics.stat('evalQueueWait', 10 * 60_000), e = engine.metrics.stat('safetyScoring', 10 * 60_000);
  const st = engine.status();
  console.log(JSON.stringify({ rpcRps, enhancedRps, seconds, launches: st.launches, evaluated: st.evaluated, queueNow: engine.queue.length,
    waitP50s: +(w?.p50 / 1000 || 0).toFixed(1), waitP95s: +(w?.p95 / 1000 || 0).toFixed(1), evalP50s: +(e?.p50 / 1000 || 0).toFixed(1), evalP95s: +(e?.p95 / 1000 || 0).toFixed(1), heliusCalls: calls }));
  process.exit(0);
}, seconds * 1000);
