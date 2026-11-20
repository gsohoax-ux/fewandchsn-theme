// Tiny HTTP server for the dashboard (no dependencies).
// The dashboard can be installed as an app ("Add to Home Screen"). Login uses a form and a
// long-lived cookie, because the browser's password pop-up does not work inside installed apps.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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

export function startServer({ engine, store, cfg, log = console }) {
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
  const json = (res, data) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const html = (res, body, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  };

  const failed = new Map(); // ip -> [timestamps] - slows down password guessing

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    const pub = PUBLIC[url.pathname];
    if (pub) {
      res.writeHead(200, { 'content-type': pub[1], 'cache-control': url.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });
      return res.end(file(pub[0]));
    }

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
          return html(res, LOGIN_PAGE('Wrong password'), 401);
        }
        failed.delete(ip);
        const secure = String(req.headers['x-forwarded-proto'] ?? '').includes('https') ? '; Secure' : '';
        res.writeHead(303, {
          location: '/',
          'set-cookie': `mb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
        });
        res.end();
      });
      return;
    }

    if (!authorized(req)) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401); return res.end('login required'); }
      return html(res, LOGIN_PAGE(), 401);
    }

    if (url.pathname === '/logout') {
      res.writeHead(303, { location: '/', 'set-cookie': 'mb_session=; Path=/; Max-Age=0' });
      return res.end();
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return html(res, file('index.html'));
    if (url.pathname === '/api/state') {
      return json(res, {
        status: engine.status(), coins: engine.ranked(80), xPosts: engine.xPosts(12),
        alerts: store.recentAlerts(40), stats: store.stats(),
      });
    }
    const m = url.pathname.match(/^\/api\/coin\/([1-9A-HJ-NP-Za-km-z]{32,48})$/);
    if (m) {
      const coin = engine.coins.get(m[1]);
      return coin ? json(res, engine.coinView(coin)) : (res.writeHead(404), res.end('not tracked'));
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(cfg.port, () => log.info(`Dashboard: http://localhost:${cfg.port}`));
  return server;
}
