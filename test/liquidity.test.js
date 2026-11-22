import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceImpact, cashOut, liquidityRead, curveVSolFromMc } from '../src/liquidity.js';
import { judge } from '../src/deepcheck.js';

test('slippage grows with order size relative to pool depth', () => {
  assert.ok(Math.abs(priceImpact(50, 5000).avgPct - 1) < 1e-9, '$50 into $5k depth = 1%');
  assert.ok(Math.abs(priceImpact(500, 5000).avgPct - 10) < 1e-9, '$500 into $5k depth = 10%');
  assert.ok(priceImpact(500, 5000).movePct > 20, 'and moves the price ~21%');
});

test('cash-out: paper gains shrink when the pool is thin', () => {
  const deep = cashOut(250, 100_000), thin = cashOut(250, 1000);
  assert.ok(deep.lossPct < 1);
  assert.ok(Math.abs(thin.getUsd - 200) < 1e-9 && Math.abs(thin.lossPct - 20) < 1e-9, '$250 into $1k depth only brings $200');
});

test('bonding-curve depth is estimated from market cap when not tracked', () => {
  assert.ok(Math.abs(curveVSolFromMc(28) - 30) < 0.1, 'launch: ~28 SOL MC -> 30 SOL virtual');
  const L = liquidityRead({ onCurve: true, mcUsd: 28 * 150 * 4, solUsd: 150, orderUsd: 50 });
  assert.ok(L.realLiqUsd > 0 && L.order.avgPct < 2, 'small orders barely move a curve coin');
});

test('thin graduated pool is HIGH RISK, healthy one is fine', () => {
  const thin = liquidityRead({ onCurve: false, liqUsd: 2_000, mcUsd: 200_000, solUsd: 150, orderUsd: 50 });
  assert.equal(thin.level, 'bad');
  assert.ok(thin.ratioPct < 5);
  const ok = liquidityRead({ onCurve: false, liqUsd: 60_000, mcUsd: 300_000, solUsd: 150, orderUsd: 50 });
  assert.equal(ok.level, 'ok');
});

const clean = { mintAuthority: null, freezeAuthority: null, top10Pct: 20, creator: 'D', devPct: 2,
  launch: { bundleWallets: 0, bundleInitialPct: 0, bundleHeldPct: 0, sniperWallets: 0, sniperHeldPct: 0 }, links: { checked: 10, clusters: [] } };

test('taxes and sell-blocking token features are flagged', () => {
  const t = (token) => judge({ ...clean, token }).checks.filter((c) => c.group === 'Honeypot & tax');
  assert.match(t({ transferFeeBps: 1000 })[0].text, /Transfer tax 10\.00% on every buy AND sell/);
  assert.equal(t({ transferFeeBps: 1000 })[0].level, 'bad');
  assert.equal(t({ transferFeeBps: 200 })[0].level, 'warn');
  assert.ok(t({ transferHook: true }).some((c) => c.level === 'bad' && /honeypot/.test(c.text)));
  assert.ok(t({ permanentDelegate: true }).some((c) => c.level === 'bad'));
  assert.equal(judge({ ...clean, token: { defaultFrozen: true } }).verdict, 'AVOID');
  assert.ok(t({}).some((c) => c.level === 'ok'));
});

test('buys with zero sells looks like a honeypot', () => {
  const j = judge({ ...clean, token: {}, market: { onCurve: false, dex: 'raydium', mcUsd: 1e5, vol24: 1e4, buys1h: 25, sells1h: 0 } });
  assert.ok(j.checks.some((c) => c.level === 'bad' && /0 sells.*possible honeypot/.test(c.text)));
  assert.equal(j.verdict, 'AVOID');
});
