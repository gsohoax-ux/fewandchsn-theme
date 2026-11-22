import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { ManualPaper } from '../src/manual.js';
import { StrategyEngine } from '../src/strategy/engine.js';
import { Health } from '../src/health.js';
import { CopyEngine } from '../src/copy/engine.js';

const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const cfg = { port: 0, dashboardPassword: 'secret-pass', paperTz: 'UTC', paperFeePct: 1.25, paperTerminalFeePct: 1, paperTxFeeSol: 0.0015, paperMevPct: 2, learnTarget: 1.5 };
const status = { demo: true, feedConnected: true, feedLastDataSec: 1, feedReconnects: 0, feedProblem: '', paused: false, tracked: 0, launches: 0, evaluated: 0, alerts: 0, dropped: 0,
  solUsd: 150, helius: false, ai: 'off', notify: [], x: { on: false, radar: true, posts: 0 }, hotThemes: [], alertMinScore: 65, alertAdaptive: false,
  regime: { state: 'warming up', launches: 0, grads: 0, rate: null }, learning: null, pipeline: { launches: 0, scored: 0, filtered: 0, lowScore: 0, dead: 0, alerts: 0, paperTrades: 0 } };
const engine = {
  solUsd: 150, coins: new Map(), events: [], kills: new Map(), paper: null, learner: null,
  status: () => status, ranked: () => [], xPosts: () => [], movers: () => [], board: () => ({ newPairs: [], middle: [], middleCount: 0, final: [], finalStretchPct: 70, newPairMaxMin: 15 }),
  trendView: () => ({ sources: {}, topics: [] }), coinView: () => ({}), regime: () => status.regime,
  trendsTracker: { hotThemes: () => [], recentRunners: () => [] }, logEvent() {},
};
const dex = async (url) => ({ ok: true, status: 200, json: async () => ({ pairs: url.includes(MINT) ? [{ chainId: 'solana', dexId: 'raydium', pairAddress: 'P', baseToken: { address: MINT, symbol: 'TEST', name: 'Test' }, priceUsd: '0.0001', marketCap: 100000, liquidity: { usd: 200000 } }] : [] }) });

let server, base, cookie;
before(async () => {
  const store = new Store(':memory:');
  const manual = new ManualPaper({ store, cfg, engine, fetchFn: dex, log: { warn() {} } });
  const strategy = new StrategyEngine({ cfg, engine, store, fetchFn: dex, log: { warn() {} } });
  const copy = new CopyEngine({ cfg, store, engine, fetchFn: dex, log: { warn() {} } });
  server = startServer({ engine, store, cfg, manual, strategy, copy, health: new Health(), log: { info() {}, warn() {} } });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/login`, { method: 'POST', body: 'password=secret-pass', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

const get = (path) => fetch(base + path, { headers: { cookie } });
const post = (path, body, type = 'application/json') => fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('everything except icons needs the login; security headers are set', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/app/main.js`)).status, 401);
  assert.equal((await fetch(`${base}/icon-192.png`)).status, 200);
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const bad = await fetch(`${base}/login`, { method: 'POST', body: 'password=nope', redirect: 'manual' });
  assert.equal(bad.status, 401);
});

test('the app shell and all three section modules are served', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /<script type="module" src="\/app\/main.js">/);
  for (const f of ['main', 'core', 'dashboard', 'strategy', 'trade', 'chart', 'coin', 'copy', 'setuh', 'auto']) {
    const r = await get(`/app/${f}.js`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), /javascript/);
  }
  assert.equal((await get('/app/../src/config.js')).status, 404, 'no path traversal');
  assert.equal((await get('/app/nope.js')).status, 404);
  const main = await (await get('/app/main.js')).text();
  for (const id of ['dashboard', 'strategy', 'check', 'paper']) assert.match(main, new RegExp(`id: '${id}'`));
});

test('dashboard APIs answer', async () => {
  for (const p of ['/api/state', '/api/analytics', '/api/learning', '/api/health', '/api/strategy', '/api/manual', '/api/audit']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    await r.json();
  }
  const h = await (await get('/api/health')).json();
  assert.ok(h.db.ok);
  assert.equal(h.feed.connected, true);
});

test('input validation: bad addresses, timeframes, JSON-only POSTs, unknown routes', async () => {
  assert.equal((await get('/api/candles?mint=abc&tf=5m')).status, 400);
  assert.match((await (await get(`/api/candles?mint=${MINT}&tf=7m`)).json()).error, /Timeframe/);
  const form = await post('/api/manual/open', 'mint=x', 'application/x-www-form-urlencoded');
  assert.equal(form.status, 415, 'cross-site form posts are refused');
  assert.equal((await post('/api/manual/open', '{bad json')).status, 400);
  assert.equal((await post('/api/manual/open', { mint: 'nope', budgetUsd: 10 })).status, 400);
  assert.equal((await post('/api/manual/open', { mint: MINT, budgetUsd: 0 })).status, 400);
  assert.equal((await get('/api/nothing')).status, 404);
  assert.equal((await get('/api/manual/open')).status, 405);
});

test('manual paper trade over the API: open with stops, partial sell, duplicate tap ignored, edit, close', async () => {
  const open = await (await post('/api/manual/open', { mint: MINT, budgetUsd: 50, risk: { stopPct: 20, tpPct: 60 }, requestId: 'r1' })).json();
  assert.equal(open.symbol, 'TEST');
  assert.equal(open.risk.stopPct, 20);
  const s1 = await (await post('/api/manual/sell', { id: open.id, pct: 50, requestId: 'tap-1' })).json();
  assert.equal(s1.duplicate, false);
  const s2 = await (await post('/api/manual/sell', { id: open.id, pct: 50, requestId: 'tap-1' })).json();
  assert.equal(s2.duplicate, true, 'a double tap sells once');
  assert.ok(Math.abs(s2.position.soldPct - 50) < 1e-6);
  const bad = await post('/api/manual/risk', { id: open.id, risk: { stopPct: 150 } });
  assert.equal(bad.status, 400);
  const edited = await (await post('/api/manual/risk', { id: open.id, risk: { stopPrice: 0.00005, tpPct: null, trailPct: 15 } })).json();
  assert.equal(edited.risk.stopPrice, 0.00005);
  assert.equal(edited.risk.trailPct, 15);
  const closed = await (await post('/api/manual/sell', { id: open.id, pct: 100, requestId: 'tap-2' })).json();
  assert.equal(closed.position.status, 'closed');
  const v = await (await get('/api/manual')).json();
  assert.equal(v.open.length, 0);
  assert.equal(v.closed.length, 1);
  assert.equal(v.closed[0].fills.length, 3);
  const audit = await (await get('/api/audit')).json();
  assert.ok(audit.some((a) => a.action === 'open') && audit.some((a) => a.action === 'sell') && audit.some((a) => a.action === 'risk'));
});

test('strategy settings over the API change only what was asked', async () => {
  const r = await (await post('/api/strategy/config', { setup: 'finalB', values: { targetPct: 35 } })).json();
  assert.equal(r.setups.finalB.values.targetPct, 35);
  assert.equal(r.setups.finalA.values.targetPct, 50);
  assert.equal((await post('/api/strategy/config', { setup: 'finalB', values: { targetPct: 'abc' } })).status, 400);
  assert.equal((await post('/api/strategy/devs', { wallet: 'x', mode: 'follow' })).status, 400);
  const s = await (await get('/api/strategy')).json();
  assert.equal(s.open.length, 0, 'manual trades never appear in the strategy book');
});

test('copy trading API: follow, validate, controls, separate book', async () => {
  const W = 'TraderWa11et11111111111111111111111111111111';
  assert.equal((await post('/api/copy/follow', { wallet: 'nope' })).status, 400);
  const t = await (await post('/api/copy/follow', { wallet: W, label: 'Whale', settings: { buyUsd: 25 } })).json();
  assert.equal(t.settings.buyUsd, 25);
  assert.equal(t.status.state, 'ACTIVE');
  assert.match(t.status.mirroring, /partial sells/);
  assert.equal((await post('/api/copy/follow', { wallet: W })).status, 400, 'no duplicates');
  assert.equal((await post('/api/copy/trader', { wallet: W, settings: { buyUsd: 500, maxPositionUsd: 100 } })).status, 400);
  const p = await (await post('/api/copy/trader', { wallet: W, paused: true, settings: { stopPct: 25, trailPct: 15 } })).json();
  assert.equal(p.paused, true);
  assert.equal(p.settings.stopPct, 25);
  const v = await (await get('/api/copy')).json();
  assert.equal(v.traders.length, 1);
  assert.equal(v.open.length, 0);
  assert.equal((await post('/api/copy/settings', { values: { maxTotalExposureUsd: 0 } })).status, 400);
  assert.equal((await (await post('/api/copy/unfollow', { wallet: W })).json()).ok, true);
});

test('Setuh trader API: view, journal, latency, controls and validation', async () => {
  const v = await (await get('/api/setuh')).json();
  assert.ok(v.balance && v.settings && Array.isArray(v.activity));
  assert.equal(v.settings.mode, 'autonomous');
  assert.ok((await get('/api/setuh/journal')).ok);
  assert.ok((await get('/api/latency')).ok);
  assert.equal((await post('/api/setuh/submit', { mint: 'nope' })).status, 400);
  const s = await (await post('/api/setuh/submit', { mint: MINT })).json();
  assert.match(s.note, /Migrated setup only|curve setups/);
  assert.equal((await post('/api/setuh/approve', { id: 'ghost' })).status, 400);
  const c = await (await post('/api/strategy/config', { values: { mode: 'approval', minConfidence: 70 } })).json();
  assert.equal(c.settings.mode, 'approval');
  assert.equal((await post('/api/strategy/config', { values: { maxDataAgeSec: 0 } })).status, 400);
  assert.equal((await post('/api/setuh/close-coin', { mint: MINT })).status, 400);
});
