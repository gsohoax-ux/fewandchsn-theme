import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader, dayKey } from '../src/paper.js';
import { Store } from '../src/store.js';
import { Coin } from '../src/coin.js';

const cfg = {
  paper: true, paperStartSol: 2, paperDailyUsd: 30, paperLowUsd: 10, paperStopAtLow: false, paperTz: 'America/Chicago',
  paperSizePct: 20, paperMaxOpen: 4, paperStopPct: 25, paperTrailStartPct: 30, paperTrailPct: 20, paperMaxHoldMin: 90,
  paperFeePct: 1.25, paperTxFeeSol: 0.0015, paperSlippagePct: 3,
};
const quiet = { info() {}, warn() {} };
const DAY1 = Date.parse('2026-11-20T18:00:00Z'); // noon in Chicago
const DAY2 = Date.parse('2026-11-21T07:00:00Z'); // 1am next day in Chicago

function coinAt(vSol, mint = 'MINTpump') {
  const c = new Coin({ mint, name: 'Test', symbol: 'TST', traderPublicKey: 'DEV', signature: 's', initialBuy: 0 });
  setPrice(c, vSol);
  return c;
}
function setPrice(c, vSol) { c.vSol = vSol; c.vTokens = (30 * 1_073_000_000) / vSol; c.mcSol = (c.vSol / c.vTokens) * 1e9; }

function make(store = new Store(':memory:'), over = {}, price = 150) {
  const notes = [];
  const t = new PaperTrader({ cfg: { ...cfg, ...over }, store, log: quiet, getSolUsd: () => price, onNotify: (m) => notes.push(m) });
  return { t, notes, store };
}

test('day boundaries follow the chosen time zone', () => {
  assert.equal(dayKey(DAY1, 'America/Chicago'), '2026-11-20');
  assert.equal(dayKey(Date.parse('2026-11-21T03:00:00Z'), 'America/Chicago'), '2026-11-20', '9pm Chicago is still the 20th');
  assert.equal(dayKey(DAY2, 'America/Chicago'), '2026-11-21');
  assert.equal(dayKey(DAY1, 'Not/AZone'), '2026-11-20', 'bad time zone falls back to UTC');
});

test('each day starts with $30 of SOL; trades are 20% of it', () => {
  const { t } = make();
  const coins = new Map();
  t.tick(coins, DAY1);
  assert.ok(Math.abs(t.cash - 0.2) < 1e-9, '$30 at $150/SOL = 0.2 SOL');
  const coin = coinAt(40); coins.set(coin.mint, coin);
  const pos = t.open(coin, { stage: 'fresh', score: 70 }, coins, DAY1);
  assert.ok(Math.abs(pos.costSol * 150 - 6) < 1e-6, 'about $6 per trade');
});

test('no buying until the SOL price is known', () => {
  const { t } = make(undefined, {}, 0);
  const coins = new Map();
  t.tick(coins, DAY1);
  const coin = coinAt(40); coins.set(coin.mint, coin);
  assert.equal(t.open(coin, { stage: 'fresh', score: 70 }, coins, DAY1), null);
});

test('one phone alert when the balance drops under $10; optional stop buying', () => {
  for (const stopAtLow of [false, true]) {
    const { t, notes } = make(undefined, { paperStopAtLow: stopAtLow, paperSizePct: 100, paperStopPct: 99 });
    const coins = new Map();
    t.tick(coins, DAY1);
    const coin = coinAt(40); coins.set(coin.mint, coin);
    t.open(coin, { stage: 'fresh', score: 70 }, coins, DAY1);
    setPrice(coin, 20); // big drop: whole $30 position now worth well under $10
    t.tick(coins, DAY1 + 5000);
    t.tick(coins, DAY1 + 9000);
    assert.equal(notes.filter((n) => n.includes('budget low')).length, 1, 'alert sent exactly once');
    const other = coinAt(40, 'OTHER'); coins.set('OTHER', other);
    t.close(t.positions.get(coin.mint), coin, coins, 'test');
    const res = t.open(other, { stage: 'fresh', score: 70 }, coins, DAY1 + 10_000);
    assert.equal(res === null, stopAtLow, stopAtLow ? 'buying stopped' : 'still buying');
  }
});

test('next day: positions closed, result recorded and sent, fresh $30', () => {
  const store = new Store(':memory:');
  const { t, notes } = make(store);
  const coins = new Map();
  t.tick(coins, DAY1);
  const coin = coinAt(40); coins.set(coin.mint, coin);
  t.open(coin, { stage: 'fresh', score: 70 }, coins, DAY1);
  setPrice(coin, 44); t.onPrice(coin, coins, DAY1 + 1000);
  t.tick(coins, DAY2);
  assert.equal(t.positions.size, 0);
  assert.match(store.paperTrades()[0].why, /end of day/);
  assert.equal(t.days[0].day, '2026-11-20');
  assert.ok(notes.some((n) => n.startsWith('📄 Paper day 2026-11-20: $30.00 →')));
  assert.ok(Math.abs(t.cash - 0.2) < 1e-9, 'fresh $30 budget');
  assert.equal(t.view(coins, 150).daily.day, '2026-11-21');
});

test('a restart on the same day keeps the day going', () => {
  const store = new Store(':memory:');
  const { t } = make(store);
  const coins = new Map();
  t.tick(coins, DAY1);
  t.cash = 0.15; t.tick(coins, DAY1 + 61_000); // spent some, state saved
  const { t: t2 } = make(store);
  t2.tick(coins, DAY1 + 120_000);
  assert.equal(t2.day, '2026-11-20');
  assert.ok(Math.abs(t2.cash - 0.15) < 1e-9);
});

test('all-time progress adds up every day, and the midnight summary includes it', () => {
  const store = new Store(':memory:');
  const { t, notes } = make(store);
  const coins = new Map();
  const day = (n) => Date.parse(`2026-11-${20 + n}T18:00:00Z`);
  t.tick(coins, day(0));
  t.cash = 0.2 * 1.2; t.tick(coins, day(1));   // day 1 ended $36 (+$6)
  t.cash = 0.2 * 0.9; t.tick(coins, day(2));   // day 2 ended $27 (-$3)
  t.cash = 0.2 * 1.1;                          // today so far $33 (+$3)
  const a = t.allTime(coins, 150);
  assert.equal(a.days, 3);
  assert.ok(Math.abs(a.pnlUsd - 6) < 1e-6, `total ${a.pnlUsd}`);
  assert.deepEqual([a.greenDays, a.redDays], [1, 1]);
  assert.deepEqual(a.series.map((d) => +d.total.toFixed(2)), [6, 3, 6]);
  assert.ok(a.series.at(-1).today);
  assert.match(notes.at(-1), /All time: \+\$3\.00 over 2 days · 1 green \/ 1 red/);
});
