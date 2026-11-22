import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyEngine } from '../src/strategy/engine.js';
import { safetyGates, setupConfidence } from '../src/strategy/gates.js';
import { decisionStage } from '../src/strategy/setups.js';
import { MarketData } from '../src/market.js';
import { Metrics } from '../src/metrics.js';
import { Coin } from '../src/coin.js';
import { Store } from '../src/store.js';
import { EventEmitter } from 'node:events';

const NOW = 10_000_000;
const SAFE = { verdict: 'SAFE', score: 85, flags: [], launchBundle: { wallets: 1, initialPct: 3, heldPct: 1 } };
const cfg = { paperTz: 'UTC', paperFeePct: 1.25, paperTerminalFeePct: 1, paperTxFeeSol: 0.0015, paperMevPct: 2 };
const quiet = { warn() {}, info() {} };

/** A Pump.fun coin that launched at $2K, ran to $7.5K and pulled back to a ~$3.3K floor (solUsd = 1, so MC in SOL = $). */
function pullbackCoin(clock) {
  const path = [2000, 2600, 3500, 5000, 6500, 7500, 7000, 6000, 5000, 4200, 3600, 3300, 3400, 3350, 3450, 3300, 3400];
  const start = clock.t - path.length * 15_000;
  const coin = new Coin({ mint: 'SetuhCoin11111111111111111111111111111pump', symbol: 'SETUH', name: 'Setuh Coin', traderPublicKey: 'DEV1', marketCapSol: path[0], vSolInBondingCurve: 31 }, start);
  coin.startMcSol = path[0];
  path.forEach((mc, i) => coin.applyTrade({ txType: i > 0 && mc < path[i - 1] ? 'sell' : 'buy', traderPublicKey: `W${i % 9}`, tokenAmount: 1e6, solAmount: 20, marketCapSol: mc, vSolInBondingCurve: 4000, signature: `s${i}` }, start + i * 15_000));
  buyers(coin, clock, 'A');
  coin.result = { safety: SAFE, narrative: { score: 62 }, momentum: { score: 60 }, insiderWallets: [] };
  return coin;
}
/** Fresh buying in the last minute: the entry confirmation. */
function buyers(coin, clock, tag, mc = 3400) {
  for (let i = 0; i < 8; i++) coin.applyTrade({ txType: 'buy', traderPublicKey: `${tag}${i}`, tokenAmount: 1e6, solAmount: 40, marketCapSol: mc, vSolInBondingCurve: 4000, signature: `${tag}${i}${clock.t}` }, clock.t - 40_000 + i * 4000);
}
function trader({ clock, store = new Store(':memory:'), settings = {}, market = null, deepcheck = null, engine = null, coin = null }) {
  coin ??= pullbackCoin(clock);
  engine ??= { solUsd: 1, coins: new Map([[coin.mint, coin]]), regime: () => ({ state: 'normal' }), logEvent() {}, feedConnected: true };
  const se = new StrategyEngine({ cfg, engine, store, market, deepcheck, log: quiet, now: () => clock.t });
  se.updateConfig({ setup: 'newPairs', values: { candleSec: 15, floorCandles: 4, floorMaxRangePct: 15 } });
  for (const id of ['finalA', 'finalB', 'finalC', 'migrated']) se.updateConfig({ setup: id, values: { enabled: false } });
  se.updateConfig({ values: { minConfidence: 50, positionUsd: 25, minEntryGapSec: 0, ...settings } });
  return { se, store, coin, engine };
}
const acts = (se) => se.view().activity.map((a) => a.type);

test('autonomous: discovers, checks, scores, enters with signal / decision / fill prices recorded; exits on its own stop', async () => {
  const clock = { t: NOW };
  const { se, store, coin } = trader({ clock });
  await se.scan();
  const v = se.view();
  assert.equal(v.open.length, 1, JSON.stringify(v.signals.map((s) => [s.status, s.reason])));
  const p = v.open[0];
  assert.equal(p.book, 'strategy');
  assert.equal(p.meta.entryNo, 1);
  assert.equal(p.budgetUsd, 25);
  assert.ok(p.meta.confidence.score >= 50);
  assert.ok(p.meta.signal.priceUsd > 0 && p.meta.decision.priceUsd > 0 && p.meta.fill.priceUsd > 0, 'signal, decision and fill prices are all recorded');
  assert.ok(p.meta.fill.avgCostUsd > p.meta.fill.priceUsd, 'fill cost includes fees and slippage');
  assert.equal(p.levels.stop.toFixed(8), p.meta.invalidation.priceUsd.toFixed(8), 'stop at the setup invalidation level');
  assert.equal(p.risk.tpSellPct, 50, 'partial profit-taking at the target');
  assert.ok(acts(se).includes('entry') && acts(se).includes('passed_safety') && acts(se).includes('confidence'));
  assert.match(v.activity.find((a) => a.type === 'entry').text, /^Entry 1 executed/);
  const bal = se.balance();
  assert.equal(bal.investedUsd, 25);
  assert.equal(bal.cashUsd, 975);
  // the same standing signal never creates a duplicate entry
  await se.scan(); await se.scan();
  assert.equal(se.view().open.length, 1);
  // price collapses through the invalidation level → its own stop sells it
  coin.applyTrade({ txType: 'sell', traderPublicKey: 'X', tokenAmount: 1e6, solAmount: 30, marketCapSol: 2000, vSolInBondingCurve: 4000, signature: 'dump' }, clock.t);
  se.book.updatePrice(coin.mint, { priceUsd: 2000 / 1e9, mcUsd: 2000 });
  const after = se.view();
  assert.equal(after.open.length, 0);
  assert.match(after.closed[0].exitReason, /Stop-loss/);
  assert.ok(acts(se).includes('closed'));
  assert.equal(store.simPositions('manual', 'open').length + store.simPositions('copy', 'open').length, 0, 'other books untouched');
  assert.equal(store.paperTradesSince(0).length, 0, 'automatic system untouched');
});

test('multiple entries: each one re-qualifies, is numbered, and limits apply', async () => {
  const clock = { t: NOW };
  const { se, coin } = trader({ clock, settings: { maxEntriesPerCoin: 2, maxExposurePerCoinUsd: 75 } });
  await se.scan();
  assert.equal(se.view().open.length, 1);
  // buyers fade (setup no longer confirmed) → re-armed; then buyers return → a NEW qualifying signal → Entry 2
  clock.t += 70_000; await se.scan();
  buyers(coin, clock, 'B'); await se.scan();
  let v = se.view();
  assert.equal(v.open.length, 2, JSON.stringify(v.signals.slice(0, 3).map((s) => [s.status, s.reason])));
  assert.deepEqual(v.open.map((p) => p.meta.entryNo).sort(), [1, 2]);
  assert.ok(v.activity.some((a) => /^Entry 2 executed/.test(a.text)));
  // third time: the per-coin entry limit stops it, with the reason
  clock.t += 70_000; await se.scan();
  buyers(coin, clock, 'C'); await se.scan();
  v = se.view();
  assert.equal(v.open.length, 2);
  assert.match(v.signals.find((s) => s.status === 'skipped').reason, /Max 2 entries per coin/);
  const j = se.journal();
  assert.equal(j.coins.length, 1);
  assert.equal(j.coins[0].entries, 2, 'combined position tracked separately');
  assert.equal(j.coins[0].investedUsd, 50);
  assert.deepEqual(j.entries.map((e) => e.entryNo).sort(), [1, 2]);
});

test('approval mode: waits for you; approve re-checks fresh data then enters; cancel records it', async () => {
  const clock = { t: NOW };
  const { se } = trader({ clock, settings: { mode: 'approval' } });
  await se.scan();
  let v = se.view();
  assert.equal(v.open.length, 0);
  assert.equal(v.pending.length, 1);
  assert.equal(v.pending[0].status, 'pending_approval');
  await se.approve(v.pending[0].id);
  v = se.view();
  assert.equal(v.open.length, 1);
  assert.match(v.open[0].meta.how, /approved by you/);
  await assert.rejects(() => se.approve(v.pending[0]?.id ?? 'x'), /no longer waiting/);

  const c2 = { t: NOW };
  const t2 = trader({ clock: c2, settings: { mode: 'approval' } });
  await t2.se.scan();
  const id = t2.se.view().pending[0].id;
  t2.se.cancel(id);
  assert.equal(t2.se.view().pending.length, 0);
  assert.equal(t2.se.view().signals.find((s) => s.id === id).status, 'cancelled');
});

test('critical safety gates: a failed check rejects even with minimum confidence 0', async () => {
  const clock = { t: NOW };
  const report = { verdict: 'AVOID', score: 20, bad: 1, warn: 0, unknown: 0, at: NOW, checks: [{ group: 'Authorities', level: 'bad', text: 'Mint authority is ACTIVE' }] };
  let calls = 0;
  const deepcheck = { check: async () => { calls++; return report; } };
  const { se } = trader({ clock, deepcheck, settings: { minConfidence: 0 } });
  await se.scan();                                    // setup forms → full check queued
  await new Promise((r) => setTimeout(r, 5));
  await se.scan();
  const v = se.view();
  assert.equal(v.open.length, 0);
  const rej = v.signals.find((s) => s.status === 'rejected');
  assert.match(rej.reason, /Safety gate failed: .*AVOID.*Mint authority is ACTIVE/);
  assert.ok(calls >= 1);
});

test('stale or disconnected data blocks entries; price drift = entry missed', async () => {
  const stub = (over) => ({ feedHealthy: () => true, track() {}, untrack() {}, freshness: () => ({ streaming: true }), get: () => null, bindBook: () => async () => {}, view: () => ({}), ...over });
  const c1 = { t: NOW };
  const stale = trader({ clock: c1, market: stub({ quote: async () => ({ ok: false, reason: 'Price is 31.0s old (limit 10s) and could not be refreshed' }) }) });
  await stale.se.scan();
  assert.equal(stale.se.view().open.length, 0);
  assert.match(stale.se.view().signals[0].reason, /Entry blocked: Price is 31.0s old/);

  const c2 = { t: NOW };
  const down = trader({ clock: c2, market: stub({ feedHealthy: () => false, quote: async () => ({ ok: true }) }) });
  await down.se.scan();
  assert.match(down.se.view().signals[0].reason, /feed is disconnected or stale/);

  const c3 = { t: NOW };
  const jump = trader({ clock: c3, market: stub({ quote: async () => ({ ok: true, quote: { priceUsd: 3400 * 1.12 / 1e9, mcUsd: 3400 * 1.12, onCurve: true, vSol: 4000, ageMs: 300, source: 'Pump.fun live trade' } }) }) });
  await jump.se.scan();
  assert.equal(jump.se.view().open.length, 0);
  assert.match(jump.se.view().signals[0].reason, /Entry missed: price moved \+12\.0% since the signal/);
});

test('daily loss limit, cash and settings validation', async () => {
  const clock = { t: NOW };
  const { se } = trader({ clock });
  assert.throws(() => se.updateConfig({ values: { positionUsd: 500, maxExposurePerCoinUsd: 100 } }), /cannot exceed/);
  assert.throws(() => se.updateConfig({ values: { mode: 'yolo' } }), /mode must be/);
  assert.throws(() => se.updateConfig({ values: { minConfidence: 150 } }), /between/);
  assert.throws(() => se.updateConfig({ values: { nope: 1 } }), /Unknown setting/);
  se.updateConfig({ values: { perTradeUsd: 20, maxOpen: 4 } });                    // older keys still work
  assert.equal(se.settings.positionUsd, 20);
  assert.equal(se.settings.maxOpenPositions, 4);
  se.updateConfig({ values: { maxDailyLossUsd: 1, startingBalanceUsd: 500 } });
  await se.scan();
  const pos = se.view().open[0];
  se.book.updatePrice(pos.mint, { priceUsd: pos.priceUsd * 0.97, mcUsd: pos.mcUsd * 0.97 });
  assert.ok(se.balance().dailyLossHit);
  assert.equal(se.balance().startingUsd, 500);
});

test('partial take-profit, then a trailing stop protects the rest', async () => {
  const clock = { t: NOW };
  const { se } = trader({ clock, settings: { partialTakePct: 50, trailAfterTpPct: 15 } });
  await se.scan();
  const p = se.view().open[0];
  se.book.updatePrice(p.mint, { priceUsd: p.entryPriceUsd * 1.6, mcUsd: p.mcUsd * 1.6 });
  let pos = se.book.open.get(p.id);
  assert.ok(pos, 'still open after the partial');
  assert.ok(Math.abs(pos.tokens - pos.tokensInit * 0.5) < 1e-6);
  assert.equal(pos.risk.trailPct, 15);
  se.book.updatePrice(p.mint, { priceUsd: p.entryPriceUsd * 1.6 * 0.8, mcUsd: p.mcUsd });
  assert.equal(se.book.open.size, 0);
  assert.match(se.view().closed[0].exitReason, /Trailing stop/);
  const perf = se.performance();
  assert.equal(perf.bySetup.newPairs.trades, 1);
  assert.equal(perf.bySetup.newPairs.wins, 1);
  assert.ok(Object.keys(perf.byConfidence).length === 1);
  assert.match(perf.review.find((n) => n.setup === 'newPairs').text, /too few to judge/);
});

test('your controls: pause entries, pause discovery, send a coin in, close a whole coin', async () => {
  const clock = { t: NOW };
  const { se, coin } = trader({ clock, settings: { entriesPaused: true } });
  await se.scan();
  assert.equal(se.view().open.length, 0);
  assert.match(se.view().signals[0].reason, /New entries are paused/);
  const c2 = { t: NOW };
  const d = trader({ clock: c2, settings: { discoveryPaused: true } });
  await d.se.scan();
  assert.equal(d.se.view().signals.length, 0, 'discovery paused: nothing scanned');
  d.se.submit(d.coin.mint);                       // your coin is still checked
  await d.se.scan();
  assert.equal(d.se.view().open.length, 1);
  assert.equal(d.se.closeCoin(d.coin.mint).closed, 1);
  assert.throws(() => d.se.submit('bad'), /valid Solana/);
  assert.ok(coin);
});

test('gates and confidence (pure): missing data never passes; parts add up', () => {
  const settings = { maxSlippagePct: 8, requireVerifiedSafety: true, requireDeepCheck: true };
  assert.equal(safetyGates({ report: null, slipPct: 2, settings }).pending, true);
  const unv = safetyGates({ report: { verdict: 'UNVERIFIED', score: 70, bad: 0, checks: [] }, slipPct: 2, settings });
  assert.equal(unv.ok, false);
  assert.match(unv.failed[0].text, /UNVERIFIED/);
  const ok = safetyGates({ report: { verdict: 'SAFE', score: 90, bad: 0, checks: [{ group: 'Authorities', level: 'ok', text: 'revoked' }, { group: 'Honeypot & tax', level: 'ok', text: 'fine' }] }, slipPct: 2, settings });
  assert.equal(ok.ok, true);
  assert.equal(safetyGates({ report: { verdict: 'SAFE', score: 90, bad: 0, checks: [] }, slipPct: 12, settings }).failed[0].key, 'slippage');
  const ev = { conditions: [{ ok: true }, { ok: true }, { ok: null }], rewardRisk: 2 };
  const c = setupConfidence({ ev, report: null, live: null, slipPct: null });
  assert.equal(c.parts.find((p) => p.label === 'Safety').points, 0);
  assert.equal(c.parts.find((p) => p.label === 'Liquidity / slippage').points, 0, 'unknown liquidity scores 0, not neutral');
  assert.equal(c.score, Math.round(c.parts.reduce((s, p) => s + p.points, 0)));
  assert.equal(decisionStage({ phase: 'watching', conditions: [{ key: 'pullback', ok: true }, { key: 'floor', ok: false }] }), 'waiting_confirmation');
  assert.equal(decisionStage({ phase: 'watching', conditions: [{ key: 'pullback', ok: false }, { key: 'floor', ok: false }] }), 'waiting_setup');
  assert.equal(decisionStage({ phase: 'watching', conditions: [{ key: 'safety', ok: null }] }), 'insufficient_data');
});

test('market hub: live stream prices with ages, pinning across cleanup, stale quotes refreshed or refused', async () => {
  const clock = { t: 1_000_000 };
  const feed = new EventEmitter();
  Object.assign(feed, { watched: new Set(), pinned: new Set(), connected: true, lastMsgAt: clock.t,
    watch(m) { this.watched.add(m); }, unwatch(m) { if (!this.pinned.has(m)) this.watched.delete(m); }, pin(m) { this.pinned.add(m); }, unpin(m) { this.pinned.delete(m); } });
  let dexCalls = 0, dexPrice = 0.00011;
  const fetchFn = async () => { dexCalls++; return { ok: true, json: async () => ({ pairs: [{ chainId: 'solana', dexId: 'pumpswap', baseToken: { address: 'M', symbol: 'M' }, priceUsd: String(dexPrice), marketCap: dexPrice * 1e9, liquidity: { usd: 50000 } }] }) }; };
  const market = new MarketData({ engine: { solUsd: 150, coins: new Map() }, feed, fetchFn, metrics: new Metrics({ now: () => clock.t }), now: () => clock.t });
  market.track('M', 'test');
  feed.unwatch('M');
  assert.ok(feed.watched.has('M'), 'engine cleanup cannot unsubscribe a pinned coin');
  // a PumpSwap trade (graduated coin): price comes from the trade itself
  feed.emit('trade', { mint: 'M', txType: 'buy', pool: 'pump-amm', tokenAmount: 1e6, solAmount: 0.733, _rx: clock.t });
  let q = market.get('M');
  assert.equal(q.onCurve, false);
  assert.ok(Math.abs(q.mcUsd - 0.733 / 1e6 * 1e9 * 150) < 1e-6);
  assert.equal(q.source, 'PumpSwap live trade');
  clock.t += 3000; feed.lastMsgAt = clock.t - 500;
  assert.ok(market.get('M').ageMs <= 500, 'on a healthy stream the price is current up to the last message');
  const r = await market.quote('M', { maxAgeMs: 10_000, needLiquidity: true });
  assert.ok(r.ok);
  assert.equal(dexCalls, 1, 'liquidity fetched once (not in trade messages)');
  assert.equal(r.quote.liqUsd, 50000);
  assert.ok(Math.abs(r.quote.mcUsd - 109950) < 1, 'the newer live price is not overwritten by the polled one');
  // stream goes quiet: the price ages; a quote refreshes it
  feed.lastMsgAt = clock.t - 60_000; clock.t += 60_000;
  dexPrice = 0.00010;
  const r2 = await market.quote('M', { maxAgeMs: 10_000 });
  assert.ok(r2.ok);
  assert.equal(r2.quote.source, 'DexScreener');
  assert.equal(r2.quote.mcUsd, 100000);
  // no source at all → refused, never invented
  const none = await new MarketData({ engine: { solUsd: 150, coins: new Map() }, feed, fetchFn: async () => ({ ok: false, status: 500 }), now: () => clock.t }).quote('Z');
  assert.equal(none.ok, false);
  assert.match(none.reason, /No price/);
  market.untrack('M', 'test');
  feed.unwatch('M');
  assert.equal(feed.watched.has('M'), false);
});

test('metrics: timings and rates', () => {
  let t = 0;
  const m = new Metrics({ now: () => t });
  for (const ms of [10, 20, 30, 40, 1000]) m.time('x', ms);
  const s = m.stat('x');
  assert.equal(s.n, 5); assert.equal(s.p50, 30); assert.equal(s.max, 1000);
  m.count('y'); m.count('y'); t += 30_000;
  assert.equal(m.rate('y', 60_000), 2);
});
