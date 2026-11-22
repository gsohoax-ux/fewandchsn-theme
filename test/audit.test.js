import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Funnel, reasonKey } from '../src/funnel.js';
import { diagnose, classifyReason } from '../src/diagnostics.js';
import { Store } from '../src/store.js';
import { Health } from '../src/health.js';
import { Metrics } from '../src/metrics.js';
import { DeepChecker } from '../src/deepcheck.js';
import { StrategyEngine } from '../src/strategy/engine.js';
import { evalFinalA, SETUPS } from '../src/strategy/setups.js';
import { Coin } from '../src/coin.js';

const quiet = { warn() {}, info() {} };

test('funnel counts persist across restarts (hourly buckets in the database)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mb-'));
  const path = join(dir, 'db.sqlite');
  const f1 = new Funnel({ store: new Store(path) });
  f1.count('discovery:new', 3); f1.count('engine:reject:Bundled at launch'); f1.flush();
  const f2 = new Funnel({ store: new Store(path) }); // "after a redeploy"
  f2.count('discovery:new');
  const t = f2.totals(24);
  assert.equal(t.counts['discovery:new'], 4);
  assert.equal(t.counts['engine:reject:Bundled at launch'], 1);
  assert.equal(reasonKey('Price is 31.2s old (limit 10s)'), 'Price is N old');
  assert.equal(reasonKey('Max 2 entries per coin reached'), 'Max N entries per coin reached');
});

test('rejection reasons are classified: mandatory safety vs adjustable settings', () => {
  assert.equal(classifyReason('Bundled at launch'), 'safety (mandatory)');
  assert.equal(classifyReason('Safety gate failed: Mint authority is ACTIVE'), 'safety (mandatory)');
  assert.equal(classifyReason('Score below N'), 'quality threshold (adjustable)');
  assert.equal(classifyReason('Entry blocked: Price is N old'), 'data quality');
  assert.equal(classifyReason('max N open positions'), 'risk limit / setting');
  assert.equal(classifyReason('Entry missed: price moved +N since the signal'), 'strategy rule (adjustable)');
});

test('diagnostics report: components, discovery, rejections, findings from measured data only', () => {
  const store = new Store(':memory:');
  const funnel = new Funnel({ store });
  funnel.count('discovery:new', 500); funnel.count('engine:scored', 120); funnel.count('engine:reject:No traction (died early)', 300);
  funnel.count('engine:reject:Bundled at launch', 40); funnel.count('auto:skip:max N open positions', 9); funnel.count('auto:entry', 3); funnel.count('engine:alert:fresh', 12);
  const health = new Health();
  for (let i = 0; i < 30; i++) health.record('helius', 'Helius (on-chain)', { ok: i % 3 !== 0, status: i % 3 ? 200 : 429, error: i % 3 ? '' : 'rate limited (HTTP 429)' });
  const status = { demo: false, feedConnected: true, feedLastDataSec: 1, feedReconnects: 0, feedProblem: '', launches: 500, solUsd: 150, solUsdAgeSec: 10, helius: true, ai: 'off', notify: [], x: { on: false }, learning: null };
  const engine = { status: () => status, solUsd: 150, coins: new Map() };
  const D = diagnose({ cfg: { paperSizePct: 45, paperDailyUsd: 30, paperMaxOpen: 2 }, engine, store, health, metrics: new Metrics(), funnel, paper: { enabled: true, positions: new Map() } });
  assert.equal(D.discovery.newCoins, 500);
  assert.equal(D.discovery.neverScored, 300);
  assert.ok(D.components.find((c) => c.name.startsWith('On-chain')).status === 'partially working');
  assert.ok(D.findings.some((f) => f.severity === 'critical' && /Helius/.test(f.title)), JSON.stringify(D.findings.map((f) => f.title)));
  assert.ok(D.findings.some((f) => /alert-only by design/.test(f.title)));
  assert.ok(D.findings.some((f) => /skips more alerts/.test(f.title)));
  assert.equal(D.rejectionsByKind['safety (mandatory)'], 40);
  assert.ok(D.findings.some((f) => /Database is not on persistent storage/.test(f.title)), 'in-memory db flagged in live mode');
});

test('fix: a deep check no longer forces a full re-evaluation that re-downloads all on-chain data', async () => {
  const MINT = 'Fq3s2Yb2wJ8fWz6x5rJ3Rk1v9nQe4XhL7mUuTtPapump';
  const calls = [];
  const result = { at: Date.now(), score: 70, safety: { verdict: 'SAFE' }, momentum: { score: 50 }, narrative: { score: 60 }, confidence: { label: 'High' }, runner: { is: false } };
  const coin = { result, chainData: { source: 'chain' } };
  const engine = { coins: new Map([[MINT, coin]]), evaluate: async (c, stage) => { calls.push(stage); return { ...result, at: Date.now() }; } };
  const dc = new DeepChecker({ chain: null, store: new Store(':memory:'), cfg: { deployToolPatterns: [] }, engine, fetchFn: async () => ({ ok: false, status: 404 }), log: quiet });
  const r1 = await dc.check(MINT);
  assert.equal(calls.length, 0, 'fresh result reused');
  assert.equal(r1.live.score, 70);
  coin.result = { ...result, at: Date.now() - 10 * 60_000 };
  const dc2 = new DeepChecker({ chain: null, store: new Store(':memory:'), cfg: { deployToolPatterns: [] }, engine, fetchFn: async () => ({ ok: false, status: 404 }), log: quiet });
  await dc2.check(MINT);
  assert.deepEqual(calls, ['recheck'], 'old result: re-scored reusing the chain data it already has');
  coin.result = { ...result, at: Date.now() - 10 * 60_000 }; coin.evaluating = true;
  const dc3 = new DeepChecker({ chain: null, store: new Store(':memory:'), cfg: { deployToolPatterns: [] }, engine, fetchFn: async () => ({ ok: false, status: 404 }), log: quiet });
  await dc3.check(MINT);
  assert.equal(calls.length, 1, 'never runs alongside an evaluation in progress');
});

test('fix: Setup A says "does not apply" (not "unknown") when on-chain data shows no bundle wallets', () => {
  const cs = [{ t: 1, o: 9e3, h: 19e3, l: 9e3, c: 18e3, v: 1 }, { t: 2, o: 18e3, h: 18e3, l: 7e3, c: 7.6e3, v: 1 }];
  const base = { now: 3000, supply: 1e9, solUsd: 1, mcUsd: 7600, candles: cs, trades: [], safety: { verdict: 'SAFE', flags: [] }, insiders: null, devSold: false };
  assert.equal(evalFinalA({ ...base, chainVerified: true }, SETUPS.finalA.defaults).conditions.find((c) => c.key === 'insiders').ok, false);
  assert.equal(evalFinalA({ ...base, chainVerified: false }, SETUPS.finalA.defaults).conditions.find((c) => c.key === 'insiders').ok, null);
});

// ---- Setuh trader fixes (signal price reset; failed deep checks surfaced)
const NOW = 10_000_000;
const SAFE = { verdict: 'SAFE', score: 85, flags: [], launchBundle: { wallets: 1, initialPct: 3, heldPct: 1 } };
function pullbackCoin(clock) {
  const path = [2000, 2600, 3500, 5000, 6500, 7500, 7000, 6000, 5000, 4200, 3600, 3300, 3400, 3350, 3450, 3300, 3400];
  const start = clock.t - path.length * 15_000;
  const coin = new Coin({ mint: 'AuditCoin11111111111111111111111111111pump', symbol: 'AUD', name: 'Audit', traderPublicKey: 'DEV1', marketCapSol: path[0], vSolInBondingCurve: 31 }, start);
  coin.startMcSol = path[0];
  path.forEach((mc, i) => coin.applyTrade({ txType: i > 0 && mc < path[i - 1] ? 'sell' : 'buy', traderPublicKey: `W${i % 9}`, tokenAmount: 1e6, solAmount: 20, marketCapSol: mc, vSolInBondingCurve: 4000, signature: `s${i}` }, start + i * 15_000));
  coin.result = { safety: SAFE, narrative: { score: 62 }, momentum: { score: 60 }, insiderWallets: [] };
  return coin;
}
const buyers = (coin, clock, tag, mc = 3400) => { for (let i = 0; i < 8; i++) coin.applyTrade({ txType: 'buy', traderPublicKey: `${tag}${i}`, tokenAmount: 1e6, solAmount: 40, marketCapSol: mc, vSolInBondingCurve: 4000, signature: `${tag}${i}${clock.t}` }, clock.t - 40_000 + i * 4000); };
function trader(clock, deepcheck) {
  const coin = pullbackCoin(clock);
  buyers(coin, clock, 'A');
  const engine = { solUsd: 1, coins: new Map([[coin.mint, coin]]), regime: () => ({ state: 'normal' }), logEvent() {}, feedConnected: true };
  const se = new StrategyEngine({ cfg: { paperTz: 'UTC', paperMevPct: 2 }, engine, store: new Store(':memory:'), deepcheck, log: quiet, now: () => clock.t });
  se.updateConfig({ setup: 'newPairs', values: { candleSec: 15, floorCandles: 4, floorMaxRangePct: 15 } });
  for (const id of ['finalA', 'finalB', 'finalC', 'migrated']) se.updateConfig({ setup: id, values: { enabled: false } });
  se.updateConfig({ values: { minConfidence: 50, minEntryGapSec: 0 } });
  return { se, coin };
}

test('fix: when a signal lapses and returns, drift is measured from the NEW signal price', async () => {
  const clock = { t: NOW };
  const deepcheck = { check: () => new Promise(() => {}) }; // never finishes: entries wait, so we can watch the signal
  const { se, coin } = trader(clock, deepcheck);
  await se.scan();
  const key = `newPairs:${coin.mint}`;
  const first = se.active.get(key);
  assert.equal(first.status, 'waiting_safety');
  const p1 = first.signalPriceUsd;
  assert.ok(p1 > 0);
  clock.t += 70_000; await se.scan();                       // buyers fade → no longer a signal
  assert.equal(se.active.get(key).signalPriceUsd, undefined, 'signal price cleared when the signal lapses');
  buyers(coin, clock, 'B', 3600); await se.scan();          // confirms again at a different price
  const again = se.active.get(key);
  assert.equal(again.validAt, clock.t, 'new signal time');
  assert.ok(Math.abs(again.signalPriceUsd - 3600 / 1e9) < 1e-15, 'new signal price, not the stale first one');
});

test('fix: a failed full safety check is reported (insufficient data) instead of stalling silently', async () => {
  const clock = { t: NOW };
  const { se } = trader(clock, { check: async () => { throw new Error('Helius HTTP 429'); } });
  await se.scan();
  await new Promise((r) => setTimeout(r, 5));
  await se.scan();
  const s = se.view().signals.find((x) => x.status === 'insufficient_data');
  assert.ok(s, JSON.stringify(se.view().signals.map((x) => [x.status, x.reason])));
  assert.match(s.reason, /Full safety check failed: Helius HTTP 429/);
  assert.equal(se.view().open.length, 0);
});
