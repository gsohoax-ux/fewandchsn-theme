// Memecoin bot (pump-scout) entry point.  `npm start` (live)  |  `npm run demo` (simulated coins)
import { config as cfg } from './config.js';
import { PumpPortalFeed, DemoFeed, DemoChain } from './feed.js';
import { HeliusChain } from './chain.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { Ntfy, Notifier, resolveNtfyTopic } from './notify.js';
import { AiNarrator } from './narrative.js';
import { Engine } from './engine.js';
import { startServer } from './server.js';
import { fmtMc } from './score.js';
import { XWatcher, XApiSource, DemoXSource } from './xwatch.js';

const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (...a) => console.log(ts(), ...a),
  warn: (...a) => console.warn(ts(), 'WARN', ...a),
};

const chain = cfg.demo ? new DemoChain() : new HeliusChain({
  rpcUrl: cfg.heliusRpcUrl, apiUrl: cfg.heliusApiUrl, apiKey: cfg.heliusKey, concurrency: cfg.heliusConcurrency,
});
const xSource = cfg.demo ? new DemoXSource() : cfg.xBearerToken ? new XApiSource({ token: cfg.xBearerToken }) : null;
const feed = cfg.demo ? new DemoFeed(chain, log, xSource) : new PumpPortalFeed(cfg.pumpportalUrl, log);
const store = new Store(cfg.demo ? ':memory:' : cfg.dbPath);
const telegram = new Telegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId, log });
const ai = new AiNarrator({ apiKey: cfg.anthropicKey, model: cfg.aiModel, maxPerHour: cfg.aiMaxCallsPerHour });
const ntfy = new Ntfy({ server: cfg.ntfyServer, topic: resolveNtfyTopic(cfg, log), token: cfg.ntfyToken, log });
const notifier = new Notifier({ ntfy, telegram, cfg, getSolUsd: () => engine.solUsd });
if (cfg.demo) cfg.xPollSec = 15;
const xwatch = new XWatcher({ source: xSource, ai, cfg, notifier, log });
const engine = new Engine({ cfg, feed, chain, store, notifier, ai, xwatch, log });

// Telegram commands (only used if you set up Telegram too)
telegram.on('help', async () => [
  '<b>pump-scout commands</b>',
  '/top - best coins right now',
  '/check &lt;contract address&gt; - full scorecard of a tracked coin',
  '/stats - how past alerts performed',
  '/themes - narratives running right now',
  '/pause, /resume - stop/start alerts',
].join('\n'));
telegram.on('top', async () => {
  const top = engine.ranked(8);
  if (!top.length) return 'Nothing scored yet - give it a minute.';
  return '<b>Top coins now</b>\n' + top.map((c, i) =>
    `${i + 1}. ${c.light} <b>$${c.symbol}</b> ${c.score} · ${c.safety.verdict} · MC ${fmtMc(c.mcSol, engine.solUsd)} · ${c.progress.toFixed(0)}%\n<code>${c.mint}</code>`).join('\n');
});
telegram.on('check', async ([mint]) => {
  const coin = engine.coins.get(mint ?? '');
  if (!coin) return 'Not tracked. The bot only tracks coins launched while it is running (and drops dead ones).';
  const { formatAlert } = await import('./score.js');
  const r = await engine.evaluate(coin, 'manual');
  return formatAlert(coin, r, 'manual', { solUsd: engine.solUsd, padreTemplate: cfg.padreUrlTemplate });
});
telegram.on('stats', async () => {
  const s = store.stats();
  return `<b>Last 7 days</b>\nAlerts: ${s.alerts}\nReached 1.5x after alert: ${s.hit1_5x}%\nReached 2x after alert: ${s.hit2x}%\nGraduated: ${s.migrated}%\nMedian peak: ${s.medianPeak}x`;
});
telegram.on('themes', async () => {
  const t = engine.trends.hotThemes();
  return t.length ? '<b>Running now</b>\n' + t.map((h) => `${h.word} (${h.count})`).join(', ') : 'Not enough data yet.';
});
telegram.on('pause', async () => { engine.paused = true; return '⏸ Alerts paused'; });
telegram.on('resume', async () => { engine.paused = false; return '▶️ Alerts resumed'; });

log.info(`Memecoin bot starting${cfg.demo ? ' in DEMO mode' : ''}`);
log.info(`  Helius (bundle tracing): ${chain.enabled ? 'on' : 'OFF - add HELIUS_API_KEY for accurate bundle detection'}`);
log.info(`  AI narrative: ${ai.enabled ? cfg.aiModel : 'OFF - using rule-based narrative score'}`);
log.info(`  X watcher: ${xwatch.enabled ? `on - watching ${cfg.xWatchAccounts.map((a) => '@' + a).join(', ')}${cfg.xSearchQuery ? ' + search' : ''}` : 'OFF - add X_BEARER_TOKEN to watch X for meme-able posts'}`);
log.info(`  Phone alerts (ntfy): ${ntfy.enabled ? `on - in the ntfy app, subscribe to topic:  ${ntfy.topic}` : 'OFF'}`);
if (telegram.enabled) log.info(`  Telegram: ${cfg.telegramChatId ? 'on' : 'token set - send /chatid to your bot to get your chat id'}`);

engine.start();
startServer({ engine, store, cfg, log });
telegram.poll();
notifier.info(`🤖 Memecoin bot is running${cfg.demo ? ' (DEMO - fake coins)' : ''}. You'll get alerts here.`);
