import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalNewPairs, evalFinalA, evalFinalB, evalFinalC, evalMigrated, SETUPS, mergeConfig, rangeOf, peakIndex, flowOf, sellExhaustion } from '../src/strategy/setups.js';

const NOW = 10_000_000;
const D = (id) => ({ ...SETUPS[id].defaults });
/** candles from [o,h,l,c,v] rows, `sec` apart, ending at NOW */
const candles = (rows, sec) => rows.map(([o, h, l, c, v = 100], i) => ({ t: (NOW - (rows.length - 1 - i) * sec * 1000) / 1000, o, h, l, c, v }));
/** trades in the last `windowSec`: buys and sells in USD (solUsd = 1) */
const flow = (buys, sells, buyers = 8, windowSec = 50) => [
  ...Array.from({ length: buyers }, (_, i) => ({ ts: NOW - (windowSec - i) * 1000, side: 'buy', sol: buys / buyers, trader: `B${i}` })),
  ...(sells ? [{ ts: NOW - 5000, side: 'sell', sol: sells, trader: 'S1' }] : []),
].sort((a, b) => a.ts - b.ts);
const SAFE = { verdict: 'SAFE', flags: [] };

// ---------------------------------------------------------------- New Pairs
const npCandles = candles([
  [2000, 3000, 2000, 3000], [3000, 5000, 3000, 5000], [5000, 7500, 5000, 7000], [7000, 7100, 5000, 5000],
  [5000, 5100, 3800, 3800], [3800, 3800, 3300, 3300], [3300, 3500, 3250, 3300], [3300, 3650, 3300, 3500], [3500, 3550, 3280, 3400], [3400, 3600, 3350, 3400],
], 20);
const npCtx = (over = {}) => ({ now: NOW, supply: 1e9, solUsd: 1, ageMin: 4, launchMcUsd: 2000, mcUsd: 3400, candles: npCandles,
  trades: flow(300, 100), safety: SAFE, narrative: 60, bundleHeldPct: 2, ...over });

test('New Pairs: signals a 50–60% pullback holding a floor with buyers', () => {
  const ev = evalNewPairs(npCtx(), D('newPairs'));
  assert.equal(ev.phase, 'signal', ev.conditions.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.detail}`).join(' | '));
  assert.ok(Math.abs(ev.invalidation.mcUsd - 3250 * 0.96) < 1e-6, 'invalidation just under the floor (tighter than −20%)');
  assert.equal(ev.target.pct, 55);
  assert.ok(ev.rewardRisk > 2);
  assert.equal(ev.unconfirmed.length, 0);
});

test('New Pairs: waits (watching) while buyers have not stepped in', () => {
  const ev = evalNewPairs(npCtx({ trades: flow(100, 200, 3) }), D('newPairs'));
  assert.equal(ev.phase, 'watching');
  assert.ok(ev.unconfirmed.some((u) => u.startsWith('Buying pressure')));
});

test('New Pairs: never chases the launch pump', () => {
  const pumping = candles([[2000, 3000, 2000, 3000], [3000, 5000, 3000, 5000], [5000, 7500, 5000, 7400]], 20);
  const ev = evalNewPairs(npCtx({ candles: pumping, mcUsd: 7400 }), D('newPairs'));
  assert.notEqual(ev.phase, 'signal');
  assert.equal(ev.conditions.find((c) => c.key === 'pullback').ok, false);
});

test('New Pairs: AVOID safety, bundles or missing safety data block the trade', () => {
  assert.equal(evalNewPairs(npCtx({ safety: { verdict: 'AVOID', flags: [{ level: 'bad', text: 'Bundled 30%' }] } }), D('newPairs')).phase, 'rejected');
  assert.equal(evalNewPairs(npCtx({ bundleHeldPct: 25 }), D('newPairs')).phase, 'rejected');
  const noData = evalNewPairs(npCtx({ safety: null, narrative: null, bundleHeldPct: null }), D('newPairs'));
  assert.notEqual(noData.phase, 'signal', 'unknown data is never a pass');
  assert.equal(noData.conditions.find((c) => c.key === 'safety').ok, null);
});

// ---------------------------------------------------------------- Final Stretch A
const faCandles = candles([
  [9000, 12000, 9000, 12000], [12000, 19000, 12000, 18500], [18500, 18600, 13000, 13000], [13000, 13100, 9000, 9000],
  [9000, 9100, 8200, 8200], [8200, 8300, 7500, 7800], [7800, 8300, 7600, 8000], [8000, 8200, 7700, 7900], [7900, 8100, 7650, 7700],
], 30);
const faTrades = [
  // heavy selling just after the high, then calm
  { ts: NOW - 170_000, side: 'sell', sol: 900, trader: 'BUNDLE1' }, { ts: NOW - 160_000, side: 'sell', sol: 800, trader: 'BUNDLE2' },
  ...flow(250, 60, 6, 60),
];
const faCtx = (over = {}) => ({ now: NOW, supply: 1e9, solUsd: 1, ageMin: 12, mcUsd: 7700, candles: faCandles, trades: faTrades, safety: SAFE,
  insiders: { heldAtEvalPct: 12, heldNowPct: 3 }, devSold: false, ...over });

test('Final Stretch A: 60% bundle pullback after insiders sold, sellers exhausted, demand back', () => {
  const ev = evalFinalA(faCtx(), D('finalA'));
  assert.equal(ev.phase, 'signal', ev.conditions.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.detail}`).join(' | '));
  assert.match(ev.conditions.find((c) => c.key === 'insiders').detail, /sold 75%/);
});

test('Final Stretch A: needs the bundle/tracked wallets to have sold', () => {
  const ev = evalFinalA(faCtx({ insiders: { heldAtEvalPct: 12, heldNowPct: 11 } }), D('finalA'));
  assert.equal(ev.conditions.find((c) => c.key === 'insiders').ok, false);
  assert.notEqual(ev.phase, 'signal');
});

test('Final Stretch B: 40–50% pullback above $15K that stabilizes with buying', () => {
  const cs = candles([[10000, 12000, 10000, 12000], [12000, 20000, 12000, 19500], [19500, 19600, 14000, 14000],
    [14000, 14100, 11000, 11000], [11000, 11600, 10800, 11200], [11200, 11500, 11000, 11300], [11300, 11500, 11000, 11100]], 30);
  const ev = evalFinalB({ now: NOW, supply: 1e9, solUsd: 1, mcUsd: 11100, candles: cs, trades: flow(200, 80), safety: SAFE }, D('finalB'));
  assert.equal(ev.phase, 'signal', ev.conditions.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.detail}`).join(' | '));
  const small = evalFinalB({ now: NOW, supply: 1e9, solUsd: 1, mcUsd: 6000, candles: cs.map((c) => ({ ...c, h: c.h / 2, l: c.l / 2, o: c.o / 2, c: c.c / 2 })), trades: flow(200, 80), safety: SAFE }, D('finalB'));
  assert.equal(small.conditions.find((c) => c.key === 'size').ok, false, 'below $15K is not this setup');
});

test('Final Stretch C: reputable dev, selling exhausted, sideways range, breakout', () => {
  const cs = candles([[5000, 9000, 5000, 8800], [8800, 9000, 6500, 6600], [6600, 6900, 6400, 6700], [6700, 6950, 6500, 6800],
    [6800, 6900, 6450, 6600], [6600, 6950, 6500, 6900], [6900, 6950, 6600, 6700], [6700, 7600, 6700, 7500]], 30);
  const trades = [{ ts: NOW - 200_000, side: 'sell', sol: 900, trader: 'X' }, ...flow(300, 50, 8, 55)];
  const base = { now: NOW, supply: 1e9, solUsd: 1, ageMin: 6, mcUsd: 7500, candles: cs, trades, safety: SAFE };
  const good = evalFinalC({ ...base, dev: { graduated: 2, rugged: 0, finished: 3, tracked: false, blocked: false } }, D('finalC'));
  assert.equal(good.phase, 'signal', good.conditions.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.detail}`).join(' | '));
  assert.equal(evalFinalC({ ...base, dev: { graduated: 2, rugged: 1, finished: 3 } }, D('finalC')).phase, 'rejected', 'a dev who rugged is excluded');
  assert.equal(evalFinalC({ ...base, dev: { graduated: 0, rugged: 0, finished: 0, blocked: true } }, D('finalC')).phase, 'rejected');
  assert.notEqual(evalFinalC({ ...base, dev: { graduated: 0, rugged: 0, finished: 4 } }, D('finalC')).phase, 'signal', 'no track record, no trade');
});

// ---------------------------------------------------------------- Migrated
const migCandles = candles([
  [60000, 90000, 60000, 90000], [90000, 150000, 90000, 140000], [140000, 141000, 90000, 95000], [95000, 96000, 60000, 62000],
  [62000, 63000, 44000, 45000], [45000, 46000, 40000, 42000, 100], [42000, 45500, 41000, 44000, 100], [44000, 46000, 40500, 41500, 100],
  [41500, 45000, 41000, 43000, 100], [43000, 49000, 42500, 48000, 260],
], 300);
const migCtx = (over = {}) => ({ now: NOW, supply: 1e9, ageMin: 100, mcUsd: 48000, liqUsd: 25000, candles: migCandles, ...over });

test('Migrated: 60–70% off a $100K+ high, sideways floor holding, breakout on volume', () => {
  const ev = evalMigrated(migCtx(), D('migrated'));
  assert.equal(ev.phase, 'signal', ev.conditions.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.detail}`).join(' | '));
});

test('Migrated: a big drop alone is not an entry (no breakout yet)', () => {
  const noBreak = migCandles.slice(0, -1).concat([{ ...migCandles.at(-1), c: 44000, h: 45000, v: 100 }]);
  const ev = evalMigrated(migCtx({ candles: noBreak, mcUsd: 44000 }), D('migrated'));
  assert.equal(ev.phase, 'watching');
  assert.equal(ev.conditions.find((c) => c.key === 'breakout').ok, false);
});

test('Migrated: outside the 1–3 hour window is rejected', () => {
  assert.equal(evalMigrated(migCtx({ ageMin: 300 }), D('migrated')).phase, 'rejected');
});

// ---------------------------------------------------------------- helpers + config
test('helpers: peak, range, flow, exhaustion', () => {
  assert.equal(peakIndex(npCandles), 2);
  const r = rangeOf(npCandles, 4);
  assert.equal(r.low, 3250);
  assert.ok(r.floorHeld);
  const f = flowOf(flow(300, 100), NOW, 60_000);
  assert.equal(f.buyers, 8);
  assert.equal(f.ratio, 3);
  assert.ok(sellExhaustion(faTrades, NOW, NOW - 200_000, 90_000) < 0.1);
  assert.equal(sellExhaustion([], NOW, 0, 60_000), null);
});

test('config: unknown keys and bad values are ignored; other setups untouched', () => {
  const c = mergeConfig({ newPairs: { stopPct: 15, bogus: 1, targetPct: 'x' }, finalA: { enabled: false } });
  assert.equal(c.newPairs.stopPct, 15);
  assert.equal(c.newPairs.targetPct, SETUPS.newPairs.defaults.targetPct);
  assert.equal(c.newPairs.bogus, undefined);
  assert.equal(c.finalA.enabled, false);
  assert.deepEqual(c.finalB, SETUPS.finalB.defaults);
});

// Engine (autonomous Setuh trader) tests live in test/setuh.test.js
