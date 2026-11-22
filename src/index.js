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
import { Learner } from './learn.js';
import { PaperTrader } from './paper.js';
import { TrendScanner } from './trends.js';
import { DeepChecker } from './deepcheck.js';
import { ManualPaper } from './manual.js';
import { Health } from './health.js';
import { CandleService } from './candles.js';
import { StrategyEngine } from './strategy/engine.js';
import { CopyEngine } from './copy/engine.js';
import { DEMO_TRADERS } from './feed.js';

// Health monitor first: every outbound request from here on is counted by provider
const health = new Health();
globalThis.fetch = health.instrument(globalThis.fetch.bind(globalThis));

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
const learner = new Learner({ store, cfg, log });
const paper = new PaperTrader({ cfg, store, log, getSolUsd: () => engine.solUsd, getRegime: () => engine.regime(),
  moonbagWorthy: (mint) => engine.moonbagWorthy(mint),
  onEvent: (agent, coin, text, level) => engine.logEvent(agent, coin, text, level),
  onNotify: (text) => notifier.info(text) });
const trends = cfg.trends ? new TrendScanner({ cfg, store, ai, notifier, log, demo: cfg.demo, extraItems: () => engine.trendItems() }) : null;
const engine = new Engine({ cfg, feed, chain, store, notifier, ai, xwatch, learner, paper, trends, log });

// Telegram commands (only used if you set up Telegram too)
telegram.on('help', async () => [
  '<b>Memecoin Bot commands</b>',
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
  const t = engine.trendsTracker.hotThemes();
  return t.length ? '<b>Running now</b>\n' + t.map((h) => `${h.word} (${h.count})`).join(', ') : 'Not enough data yet.';
});
telegram.on('pause', async () => { engine.paused = true; return '⏸ Alerts paused'; });
telegram.on('resume', async () => { engine.paused = false; return '▶️ Alerts resumed'; });

log.info(`Memecoin bot starting${cfg.demo ? ' in DEMO mode' : ''}`);
log.info(`  Helius (bundle tracing): ${chain.enabled ? 'on' : 'OFF - add HELIUS_API_KEY for accurate bundle detection'}`);
log.info(`  AI narrative: ${ai.enabled ? cfg.aiModel : 'OFF - using rule-based narrative score'}`);
log.info(`  X watcher: ${xwatch.enabled ? `on - watching ${cfg.xWatchAccounts.map((a) => '@' + a).join(', ')}${cfg.xSearchQuery ? ' + search' : ''}` : 'free tweet radar only (add X_BEARER_TOKEN for the full X watcher)'}`);
log.info(`  Trend scanner: ${trends ? `on - Google Trends (${cfg.trendGeo}), Wikipedia${cfg.trendReddit ? ', Reddit' : ''}, X radar, Pump.fun themes` : 'OFF'}`);
log.info(`  Phone alerts (ntfy): ${ntfy.enabled ? `on - in the ntfy app, subscribe to topic:  ${ntfy.topic}` : 'OFF'}`);
if (telegram.enabled) log.info(`  Telegram: ${cfg.telegramChatId ? 'on' : 'token set - send /chatid to your bot to get your chat id'}`);

engine.start();
// background-loop heartbeat for System Health (the engine schedules its own loop)
const engineTick = engine.tick.bind(engine);
engine.tick = (now) => { try { engineTick(now); health.beat('Engine: discovery & scoring loop', 2000); } catch (e) { health.beat('Engine: discovery & scoring loop', 2000, false, e.message); throw e; } };
const deepcheck = new DeepChecker({ chain: cfg.demo ? null : chain, store, cfg, engine, log });
// Coin Check & Paper Trade: your own simulated positions (no real money, no wallet)
const manual = new ManualPaper({ store, cfg, engine, feed, chain: cfg.demo ? null : chain, log });
manual.start(health);
// Charts: GeckoTerminal OHLCV + candles from the bot's own live trades
const candles = new CandleService({ engine, log });
// Strategy section (System B): Setuh setups with their own paper book and budget
const strategy = cfg.strategyEnabled ? new StrategyEngine({ cfg, engine, store, feed, candles, log }) : null;
strategy?.start(health);
// Copy trading (System D): mirror followed wallets' buys, adds, partial sells and exits in its own paper book
const copy = new CopyEngine({ cfg, store, engine, feed, chain: cfg.demo ? null : chain, log });
if (cfg.demo && !copy.traders.size) {
  for (const [i, w] of DEMO_TRADERS.entries()) {
    try { copy.addTrader(w, { label: i ? 'Demo quick trader' : 'Demo smart trader' }); } catch (e) { log.warn(`demo copy trader: ${e.message}`); }
  }
}
copy.start(health);
startServer({ engine, store, cfg, deepcheck, manual, strategy, candles, health, paper, trends, copy, log });
telegram.poll();
notifier.info(`🤖 Memecoin bot is running${cfg.demo ? ' (DEMO - fake coins)' : ''}. You'll get alerts here.`);
