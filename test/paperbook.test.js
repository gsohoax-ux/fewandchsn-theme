import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperBook, normalizeRisk, tradeStats } from '../src/paperbook.js';
import { Store } from '../src/store.js';

const cfg = { paperFeePct: 1.25, paperTerminalFeePct: 1, paperTxFeeSol: 0.0015, paperMevPct: 2 };
const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
// deep pool so slippage is tiny and the math is easy to check
const snap = (price = 0.001) => ({ mint: MINT, symbol: 'TEST', name: 'Test', priceUsd: price, mcUsd: price * 1e9, supply: 1e9, onCurve: false, liqUsd: 10_000_000, source: 'test' });

function book(store = new Store(':memory:'), name = 'manual', clock = { t: 1_000_000 }) {
  return new PaperBook({ store, cfg, book: name, getSolUsd: () => 150, log: { warn() {} }, now: () => clock.t });
}

test('buy costs: fees, network fee and slippage come off up front', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 100 });
  const v = b.view(p);
  assert.equal(v.budgetUsd, 100);
  assert.ok(v.tokens > 0);
  assert.ok(v.feesUsd > 2.2 && v.feesUsd < 2.6, `fees ${v.feesUsd}`); // 2.25% + $0.225 network
  assert.ok(v.avgCostUsd > v.entryPriceUsd, 'average cost includes the costs');
  assert.ok(v.pnlPct < -6 && v.pnlPct > -8, `round trip costs: ${v.pnlPct}`);
});

test('partial sells update tokens, realized P&L and history; full sell closes', () => {
  const clock = { t: 1_000_000 };
  const store = new Store(':memory:');
  const b = book(store, 'manual', clock);
  const p = b.openPosition({ snap: snap(), budgetUsd: 100 });
  const start = p.tokens;
  b.updatePrice(MINT, { priceUsd: 0.002, mcUsd: 2e6 });
  clock.t += 1000;
  const r1 = b.sell(p.id, 25, { idemKey: 'a' });
  assert.ok(Math.abs(r1.position.tokens - start * 0.75) < 1e-6);
  const v1 = b.view(r1.position);
  assert.ok(v1.realizedPnlUsd > 20, `realized ${v1.realizedPnlUsd}`);
  assert.ok(v1.unrealizedUsd > 0);
  clock.t += 1000;
  b.sell(p.id, 50, { idemKey: 'b' });           // 50% of what's left
  assert.ok(Math.abs(b.open.get(p.id).tokens - start * 0.375) < 1e-6);
  clock.t += 1000;
  const r3 = b.sell(p.id, 100, { idemKey: 'c', reason: 'Closed manually' });
  assert.equal(r3.position.status, 'closed');
  assert.equal(b.open.size, 0);
  const closed = b.closedViews();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, 'Closed manually');
  assert.equal(closed[0].fills.length, 4); // buy + 3 sells
  assert.ok(closed[0].pnlPct > 80, `about 2x minus costs: ${closed[0].pnlPct}`);
  assert.equal(store.simFills(p.id).length, 4);
});

test('the same sell can never execute twice (idempotency key)', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 100 });
  const a = b.sell(p.id, 50, { idemKey: 'tap-1' });
  const again = b.sell(p.id, 50, { idemKey: 'tap-1' });
  assert.equal(a.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.ok(Math.abs(b.open.get(p.id).tokens - p.tokensInit * 0.5) < 1e-6);
});

test('stop-loss by % sells everything automatically, once', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 50, risk: { stopPct: 20 } });
  assert.equal(b.view(p).levels.stop.toFixed(6), (0.001 * 0.8).toFixed(6));
  assert.ok(b.view(p).expectedAtStopUsd < -10, 'shows the expected loss in $');
  b.updatePrice(MINT, { priceUsd: 0.00085 });
  assert.equal(b.open.size, 1, 'not yet');
  const fills = b.updatePrice(MINT, { priceUsd: 0.00079 });
  assert.equal(fills.length, 1);
  assert.equal(b.open.size, 0);
  assert.match(b.closedViews()[0].exitReason, /Stop-loss/);
  assert.equal(b.updatePrice(MINT, { priceUsd: 0.0007 }).length, 0, 'nothing left to sell');
});

test('stop-loss and take-profit by exact price; editing and disabling', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 50, risk: { stopPrice: 0.0009, tpPrice: 0.0015 } });
  b.setRisk(p.id, { stopPrice: 0.0005, tpPrice: null }); // move the stop down, remove the target
  b.updatePrice(MINT, { priceUsd: 0.0016 });
  assert.equal(b.open.size, 1, 'target was disabled');
  b.updatePrice(MINT, { priceUsd: 0.0012 });
  b.setRisk(p.id, { stopPrice: 0.0005, tpPct: 50 });
  assert.equal(b.open.size, 1);
  const fills = b.updatePrice(MINT, { priceUsd: 0.00151 });
  assert.equal(fills.length, 1);
  assert.match(fills[0].reason, /Take-profit/);
  assert.equal(b.open.size, 0);
});

test('a target set below the current price sells right away (rules run when edited)', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 50 });
  b.updatePrice(MINT, { priceUsd: 0.002 });
  b.setRisk(p.id, { tpPct: 50 });
  assert.equal(b.open.size, 0);
});

test('partial take-profit sells its share once and keeps the rest running', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 50, risk: { tpPct: 50, tpSellPct: 50 } });
  b.updatePrice(MINT, { priceUsd: 0.0016 });
  const pos = b.open.get(p.id);
  assert.ok(pos, 'still open');
  assert.ok(Math.abs(pos.tokens - p.tokensInit * 0.5) < 1e-6);
  b.updatePrice(MINT, { priceUsd: 0.0017 });
  assert.ok(Math.abs(b.open.get(p.id).tokens - p.tokensInit * 0.5) < 1e-6, 'did not sell again');
});

test('trailing stop follows the price up and never moves down', () => {
  const b = book();
  const p = b.openPosition({ snap: snap(), budgetUsd: 50, risk: { trailPct: 20 } });
  b.updatePrice(MINT, { priceUsd: 0.002 });
  assert.equal(b.view(b.open.get(p.id)).levels.trail.toFixed(6), '0.001600');
  b.updatePrice(MINT, { priceUsd: 0.0018 });  // dips but above the trail
  assert.equal(b.view(b.open.get(p.id)).levels.trail.toFixed(6), '0.001600', 'trail did not move down');
  b.updatePrice(MINT, { priceUsd: 0.003 });
  assert.equal(b.view(b.open.get(p.id)).levels.trail.toFixed(6), '0.002400');
  b.updatePrice(MINT, { priceUsd: 0.00239 });
  assert.equal(b.open.size, 0);
  assert.match(b.closedViews()[0].exitReason, /Trailing stop/);
  assert.ok(b.closedViews()[0].pnlPct > 100, 'locked in the gain');
});

test('time stop closes after max hold', () => {
  const clock = { t: 1_000_000 };
  const b = book(undefined, 'manual', clock);
  b.openPosition({ snap: snap(), budgetUsd: 50, risk: { maxHoldMin: 30 } });
  clock.t += 29 * 60_000; b.tick();
  assert.equal(b.open.size, 1);
  clock.t += 2 * 60_000; b.tick();
  assert.equal(b.open.size, 0);
  assert.match(b.closedViews()[0].exitReason, /Time stop/);
});

test('bad risk settings are refused with a clear message', () => {
  assert.throws(() => normalizeRisk({ stopPct: 120 }), /between/);
  assert.throws(() => normalizeRisk({ stopPct: 10, stopPrice: 0.1 }), /not both/);
  assert.throws(() => normalizeRisk({ tpPrice: -1 }), /positive/);
  assert.deepEqual(normalizeRisk({ stopPct: '', tpPct: null }).stopPct, null);
  const b = book();
  assert.throws(() => b.openPosition({ snap: snap(), budgetUsd: 0 }), /Budget/);
  assert.throws(() => b.openPosition({ snap: { ...snap(), priceUsd: 0 }, budgetUsd: 10 }), /No live price/);
  assert.throws(() => b.sell('nope', 50), /not found/);
});

test('books are independent: a book never sees or manages the other book\'s positions', () => {
  const store = new Store(':memory:');
  const manual = book(store, 'manual');
  const strat = book(store, 'strategy');
  const m = manual.openPosition({ snap: snap(), budgetUsd: 20, risk: { stopPct: 10 } });
  strat.openPosition({ snap: snap(), budgetUsd: 30, origin: 'newPairs' });
  assert.equal(manual.open.size, 1);
  assert.equal(strat.open.size, 1);
  assert.throws(() => strat.sell(m.id, 100), /not found/);
  // the price drop triggers the manual stop only
  manual.updatePrice(MINT, { priceUsd: 0.0008 });
  strat.updatePrice(MINT, { priceUsd: 0.0008 });
  assert.equal(manual.open.size, 0);
  assert.equal(strat.open.size, 1);
  // reloading from the database keeps them apart
  assert.equal(book(store, 'strategy').open.size, 1);
  assert.equal(book(store, 'manual').open.size, 0);
  assert.throws(() => new PaperBook({ store, cfg, book: 'auto' }), /unknown book/);
});

test('positions survive a restart with their stops', () => {
  const store = new Store(':memory:');
  const b1 = book(store);
  const p = b1.openPosition({ snap: snap(), budgetUsd: 50, risk: { stopPct: 25 } });
  const b2 = book(store);
  assert.equal(b2.open.get(p.id).risk.stopPct, 25);
  b2.updatePrice(MINT, { priceUsd: 0.0007 });
  assert.equal(b2.open.size, 0);
});

test('thin pools: selling into a shallow pool loses value', () => {
  const b = book();
  const p = b.openPosition({ snap: { ...snap(), liqUsd: 2000 }, budgetUsd: 500 });
  const v = b.view(p);
  assert.ok(v.entrySlipPct > 40);
  assert.ok(v.ifSoldUsd < v.marketUsd * 0.8);
  assert.throws(() => b.openPosition({ snap: { ...snap(), liqUsd: 0 }, budgetUsd: 10 }), /no liquidity pool/);
});

test('trade statistics: win rate, profit factor, drawdown', () => {
  const s = tradeStats([
    { closedAt: 1, pnlUsd: 10, pnlPct: 20, holdSec: 60 }, { closedAt: 2, pnlUsd: -5, pnlPct: -10, holdSec: 120 },
    { closedAt: 3, pnlUsd: -5, pnlPct: -10, holdSec: 60 }, { closedAt: 4, pnlUsd: 20, pnlPct: 40, holdSec: 60 },
  ]);
  assert.equal(s.trades, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.maxDrawdownUsd, 10);
  assert.equal(s.netUsd, 20);
  assert.equal(s.avgHoldSec, 75);
});
