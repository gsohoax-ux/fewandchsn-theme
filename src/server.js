// Tiny HTTP server for the dashboard (no dependencies).
// The dashboard can be installed as an app ("Add to Home Screen"). Login uses a form and a
// long-lived cookie, because the browser's password pop-up does not work inside installed apps.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { analytics } from './analytics.js';
import { diagnose } from './diagnostics.js';
import { TIMEFRAMES } from './candles.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const file = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url));

// Files anyone may fetch (icons and the app manifest reveal nothing)
const PUBLIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/favicon.ico': ['icon-192.png', 'image/png'],
};

const LOGIN_PAGE = (error = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Memecoin Bot</title><link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#12151d">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6e8ee;
    font:15px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;box-sizing:border-box}
  form{width:100%;max-width:340px;background:#12151d;border:1px solid #232838;border-radius:16px;padding:28px 22px;text-align:center}
  img{width:64px;height:64px;border-radius:14px} h1{font-size:20px;margin:12px 0 18px}
  input,button{width:100%;box-sizing:border-box;font:inherit;border-radius:10px;padding:12px 14px}
  input{background:#171b25;border:1px solid #232838;color:inherit;margin-bottom:12px}
  button{background:#2ecc71;border:0;color:#04120a;font-weight:700;cursor:pointer}
  p{color:#ff5c5c;margin:0 0 12px;font-size:13px}
</style></head><body>
<form method="post" action="/login"><img src="/apple-touch-icon.png" alt=""><h1>Memecoin Bot</h1>
${error ? `<p>${error}</p>` : ''}
<input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password" autofocus required>
<button type="submit">Open dashboard</button></form></body></html>`;

// Security headers on every response. Scripts are only loaded from this server.
const SECURITY = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const APP_FILE_RE = /^\/app\/([a-z0-9-]+\.js)$/;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

export function startServer({ engine, store, cfg, deepcheck = null, manual = null, strategy = null, candles = null, health = null, paper = null, trends = null, copy = null, market = null, metrics = null, funnel = null, learner = null, log = console }) {
  const token = cfg.dashboardPassword
    ? createHmac('sha256', cfg.dashboardPassword).update('memecoin-bot-session-v1').digest('hex') : '';
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

  const authorized = (req) => {
    if (!cfg.dashboardPassword) return true;
    const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith('mb_session='))?.slice(11) ?? '';
    if (cookie && same(cookie, token)) return true;
    const h = req.headers.authorization ?? '';
    if (h.startsWith('Basic ')) {
      const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
      return same(pass, cfg.dashboardPassword);
    }
    return false;
  };
  const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY, ...headers });
    res.end(body);
  };
  const json = (res, data, status = 200) => send(res, status, 'application/json', JSON.stringify(data));
  const html = (res, body, status = 200, headers = {}) => send(res, status, 'text/html; charset=utf-8', body, headers);
  const fail = (res, e) => {
    const status = e instanceof HttpError ? e.status : 400;
    if (!(e instanceof HttpError) && !/not found|must|between|Unknown|No |no |already|cannot|Budget|price|positive|Nothing|switched|wallet|Sell %|address/i.test(e?.message ?? '')) log.warn(`API: ${e?.stack ?? e}`);
    json(res, { error: e?.message ?? String(e) }, status);
  };
  /** JSON bodies only (blocks cross-site form posts), max 16 KB. */
  const readJson = (req) => new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return reject(new HttpError(415, 'Send JSON (content-type: application/json)'));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16_384) { reject(new HttpError(413, 'Request too large')); req.destroy(); } });
    req.on('end', () => { try { const v = body ? JSON.parse(body) : {}; if (typeof v !== 'object' || Array.isArray(v) || v === null) throw 0; resolve(v); } catch { reject(bad('Bad JSON')); } });
    req.on('error', reject);
  });
  const mintParam = (v) => { const m = String(v ?? '').trim(); if (!MINT_RE.test(m)) throw bad('Not a valid Solana token address'); return m; };
  const reqId = (v) => (v == null ? null : String(v).replace(/[^\w-]/g, '').slice(0, 64) || null);
  const need = (svc, name) => { if (!svc) throw new HttpError(503, `${name} is not running`); return svc; };

  // ---- API routes: [method, path, handler(url, body) -> data | Promise<data>]
  const routes = {
    'GET /api/state': () => ({
      status: engine.status(), coins: engine.ranked(80), xPosts: engine.xPosts(12),
      events: engine.events.slice(-60).reverse(), movers: engine.movers(), board: engine.board(),
      trends: engine.trendView?.() ?? [],
      reasons: [...engine.kills].sort((a, b) => b[1] - a[1]).slice(0, 10),
      paper: engine.paper?.enabled ? engine.paper.view(engine.coins, engine.solUsd) : null,
      alerts: store.recentAlerts(40), stats: store.stats(),
      runners: [...engine.coins.values()].filter((c) => c.result?.runner?.is && !c.migrated).sort((a, b) => b.result.runner.score - a.result.runner.score).slice(0, 8).map((c) => engine.coinView(c)),
    }),
    'GET /api/analytics': () => analytics({ engine, store, paper, manual, strategy, trends, copy }),
    'GET /api/learning': () => ({ status: engine.learner?.status() ?? null, report: store.learningReport(cfg.learnTarget), regime: engine.regime(),
      themes: engine.trendsTracker.hotThemes(), recentRunners: engine.trendsTracker.recentRunners?.().slice?.(0, 12) ?? [],
      alerts: store.stats(), strategy: strategy ? strategy.performance() : null }),
    'GET /api/health': () => {
      const s = engine.status();
      return {
        ...(health ? health.view({ store }) : { providers: [], jobs: [], db: null }),
        feed: { connected: s.feedConnected, lastDataSec: s.feedLastDataSec, reconnects: s.feedReconnects, problem: s.feedProblem, demo: s.demo, lastCreateSec: s.feedLastCreateSec, lastTradeSec: s.feedLastTradeSec, tradesHealthy: s.feedTradesHealthy, watched: s.feedWatched, counts: s.feedCounts, lastAck: s.feedLastAck, solStale: s.solStale },
        services: { helius: s.helius, ai: s.ai, notify: s.notify, x: s.x, trends: Boolean(trends), paper: Boolean(paper?.enabled), strategy: Boolean(strategy), learning: Boolean(engine.learner) },
        solUsd: s.solUsd, desk: { pipeline: s.pipeline, alertBar: s.alertMinScore, alertAdaptive: s.alertAdaptive, paused: s.paused },
        events: engine.events.slice(-120).reverse(), audit: store.recentAudit(40),
      };
    },
    'GET /api/check': async (url) => {
      need(deepcheck, 'Deep check');
      const q = url.searchParams.get('q');
      const mint = q != null && manual ? await manual.resolve(q) : mintParam(url.searchParams.get('mint') ?? q);
      const t0 = performance.now();
      const report = await deepcheck.check(mint);
      metrics?.time('coinCheck', performance.now() - t0, 'Coin Check (manual)');
      // Setuh strategy compatibility + whether the coin passes the trader's safety gates
      if (strategy) report.setuh = await strategy.compatibility(mint, report).catch((e) => ({ error: e.message, setups: [] }));
      // report confidence: how much of the check could actually run (not a safety score)
      const total = report.checks.length, unknown = report.unknown + report.notes.length;
      report.reportConfidence = { score: Math.max(0, Math.round(100 * (1 - unknown / Math.max(1, total + report.notes.length)) - (report.verdict === 'UNVERIFIED' ? 25 : 0))),
        detail: `${total - report.unknown} of ${total} checks ran${report.notes.length ? `; ${report.notes.length} could not run` : ''}${report.verdict === 'UNVERIFIED' ? '; key on-chain checks missing' : ''}` };
      return report;
    },
    'GET /api/diagnostics': (url) => diagnose({ cfg, engine, store, paper, manual, strategy, copy, health, metrics, market, funnel, learner,
      hours: Math.max(1, Math.min(720, Number(url.searchParams.get('hours')) || 24)) }),
    'GET /api/latency': () => {
      const s = engine.status();
      const m = metrics?.view() ?? { timings: {}, rates: {}, gauges: {} };
      return { ...m, market: market?.view() ?? null, feed: { connected: s.feedConnected, lastDataSec: s.feedLastDataSec, reconnects: s.feedReconnects, problem: s.feedProblem, demo: s.demo, lastCreateSec: s.feedLastCreateSec, lastTradeSec: s.feedLastTradeSec, tradesHealthy: s.feedTradesHealthy, watched: s.feedWatched, counts: s.feedCounts, lastAck: s.feedLastAck, solStale: s.solStale },
        solUsd: s.solUsd, solUsdAgeSec: s.solUsdAgeSec };
    },
    'GET /api/setuh': () => need(strategy, 'Setuh trader').view(),
    'GET /api/setuh/journal': () => need(strategy, 'Setuh trader').journal(400),
    'POST /api/setuh/submit': (url, b) => need(strategy, 'Setuh trader').submit(mintParam(b.mint)),
    'POST /api/setuh/unsubmit': (url, b) => { need(strategy, 'Setuh trader').unsubmit(mintParam(b.mint)); return { ok: true }; },
    'POST /api/setuh/approve': (url, b) => need(strategy, 'Setuh trader').approve(String(b.id ?? '')),
    'POST /api/setuh/cancel': (url, b) => need(strategy, 'Setuh trader').cancel(String(b.id ?? '')),
    'POST /api/setuh/close-coin': (url, b) => need(strategy, 'Setuh trader').closeCoin(mintParam(b.mint), reqId(b.requestId)),
    'GET /api/resolve': async (url) => ({ mint: await need(manual, 'Coin check').resolve(String(url.searchParams.get('q') ?? '').slice(0, 500)) }),
    'GET /api/candles': async (url) => {
      const mint = mintParam(url.searchParams.get('mint'));
      const tf = url.searchParams.get('tf') ?? '5m';
      if (!TIMEFRAMES[tf]) throw bad('Timeframe must be one of ' + Object.keys(TIMEFRAMES).join(', '));
      return need(candles, 'Chart data').chart(mint, tf);
    },
    'GET /api/manual': () => need(manual, 'Manual paper trading').view(),
    'POST /api/manual/open': async (url, b) => need(manual, 'Manual paper trading').openPosition({ mint: mintParam(b.mint), budgetUsd: b.budgetUsd, risk: b.risk ?? {}, requestId: reqId(b.requestId) }),
    'POST /api/manual/sell': (url, b) => need(manual, 'Manual paper trading').sell(String(b.id ?? ''), b.pct, reqId(b.requestId)),
    'POST /api/manual/risk': (url, b) => need(manual, 'Manual paper trading').setRisk(String(b.id ?? ''), b.risk ?? {}),
    'POST /api/manual/close': (url, b) => need(manual, 'Manual paper trading').closePosition(String(b.id ?? ''), reqId(b.requestId)),
    'GET /api/strategy': () => need(strategy, 'Strategy').view(),
    'POST /api/strategy/config': (url, b) => need(strategy, 'Strategy').updateConfig({ setup: b.setup ?? null, values: b.values ?? {} }),
    'POST /api/strategy/reset': (url, b) => need(strategy, 'Strategy').resetSetup(String(b.setup ?? '')),
    'POST /api/strategy/devs': (url, b) => need(strategy, 'Strategy').setTrackedDev(String(b.wallet ?? '').trim(), { mode: b.mode, label: b.label ?? '' }),
    'POST /api/strategy/sell': (url, b) => need(strategy, 'Strategy').sellManually(String(b.id ?? ''), b.pct, reqId(b.requestId)),
    'GET /api/copy': () => need(copy, 'Copy trading').view(),
    'POST /api/copy/follow': (url, b) => need(copy, 'Copy trading').addTrader(String(b.wallet ?? '').trim(), { label: b.label ?? '', settings: b.settings ?? {} }),
    'POST /api/copy/trader': (url, b) => need(copy, 'Copy trading').updateTrader(String(b.wallet ?? ''), { label: b.label, enabled: b.enabled, paused: b.paused, settings: b.settings }),
    'POST /api/copy/unfollow': (url, b) => { need(copy, 'Copy trading').removeTrader(String(b.wallet ?? '')); return { ok: true }; },
    'POST /api/copy/settings': (url, b) => need(copy, 'Copy trading').updateSettings(b.values ?? {}),
    'POST /api/copy/sell': (url, b) => need(copy, 'Copy trading').sellManually(String(b.id ?? ''), b.pct, reqId(b.requestId)),
    'GET /api/audit': () => store.recentAudit(200),
  };

  const failed = new Map(); // ip -> [timestamps] - slows down password guessing

  const server = createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'text/plain', 'bad request'); }

    const pub = PUBLIC[url.pathname];
    if (pub) return send(res, 200, pub[1], file(pub[0]), { 'cache-control': url.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });

    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const now = Date.now();
        const recent = (failed.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
        if (recent.length >= 10) return html(res, LOGIN_PAGE('Too many tries. Wait 15 minutes.'), 429);
        const pass = new URLSearchParams(body).get('password') ?? '';
        if (!cfg.dashboardPassword || !same(pass, cfg.dashboardPassword)) {
          failed.set(ip, [...recent, now]);
          if (failed.size > 10_000) failed.clear();
          return html(res, LOGIN_PAGE('Wrong password'), 401);
        }
        failed.delete(ip);
        const secure = String(req.headers['x-forwarded-proto'] ?? '').includes('https') ? '; Secure' : '';
        res.writeHead(303, { location: '/', 'set-cookie': `mb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`, ...SECURITY });
        res.end();
      });
      return;
    }

    if (!authorized(req)) {
      if (url.pathname.startsWith('/api/')) return json(res, { error: 'login required' }, 401);
      return html(res, LOGIN_PAGE(), 401);
    }

    if (url.pathname === '/logout') {
      res.writeHead(303, { location: '/', 'set-cookie': 'mb_session=; Path=/; Max-Age=0', ...SECURITY });
      return res.end();
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return html(res, file('index.html'));
    const app = url.pathname.match(APP_FILE_RE);
    if (app) {
      const name = `app/${app[1]}`;
      if (!existsSync(new URL(`../public/${name}`, import.meta.url))) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/javascript; charset=utf-8', file(name), { 'cache-control': 'no-cache' });
    }
    const m = url.pathname.match(/^\/api\/coin\/([1-9A-HJ-NP-Za-km-z]{32,48})$/);
    if (m) {
      const coin = engine.coins.get(m[1]);
      return coin ? json(res, engine.coinView(coin)) : json(res, { error: 'not tracked' }, 404);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      const other = routes[`${req.method === 'GET' ? 'POST' : 'GET'} ${url.pathname}`];
      return other ? json(res, { error: 'method not allowed' }, 405) : json(res, { error: 'not found' }, 404);
    }
    const run = req.method === 'POST' ? readJson(req).then((b) => handler(url, b)) : Promise.resolve().then(() => handler(url));
    run.then((data) => json(res, data)).catch((e) => fail(res, e));
  });
  server.listen(cfg.port, () => log.info(`Dashboard: http://localhost:${cfg.port}`));
  return server;
}
