// Tiny HTTP server for the dashboard (no dependencies).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const page = () => readFileSync(new URL('../public/index.html', import.meta.url));

export function startServer({ engine, store, cfg, log = console }) {
  const authorized = (req) => {
    if (!cfg.dashboardPassword) return true;
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return false;
    const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(cfg.dashboardPassword);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const json = (res, data) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const server = createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="pump-scout"' });
      return res.end('Password required');
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
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
