// Central configuration. Values come from environment variables / the .env file.
try { process.loadEnvFile(); } catch { /* no .env file - fine */ }

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => {
  const v = env(k);
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? n : d;
};
const list = (k) => env(k).split(/[\s,]+/).filter(Boolean);

const heliusKey = env('HELIUS_API_KEY');
const pumpportalKey = env('PUMPPORTAL_API_KEY');

export const config = {
  demo: process.argv.includes('--demo') || env('DEMO') === '1',

  // Data sources
  pumpportalUrl: env('PUMPPORTAL_URL', 'wss://pumpportal.fun/api/data') +
    (pumpportalKey ? `?api-key=${pumpportalKey}` : ''),
  heliusKey,
  heliusRpcUrl: env('HELIUS_RPC_URL', heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : ''),
  heliusApiUrl: env('HELIUS_API_URL', 'https://api.helius.xyz'),
  heliusConcurrency: num('HELIUS_CONCURRENCY', 4),

  // Alerts
  ntfyServer: env('NTFY_SERVER', 'https://ntfy.sh'),
  ntfyTopic: env('NTFY_TOPIC'),
  ntfyToken: env('NTFY_TOKEN'),
  ntfyDisabled: env('NTFY_DISABLED') === '1',
  dashboardUrl: env('DASHBOARD_URL'),
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChatId: env('TELEGRAM_CHAT_ID'),
  padreUrlTemplate: env('PADRE_URL_TEMPLATE'),

  // AI narrative
  anthropicKey: env('ANTHROPIC_API_KEY'),
  aiModel: env('AI_MODEL', 'claude-opus-5-5'),
  aiMaxCallsPerHour: num('AI_MAX_CALLS_PER_HOUR', 120),

  // X (Twitter) watcher
  xBearerToken: env('X_BEARER_TOKEN'),
  xWatchAccounts: list('X_WATCH_ACCOUNTS').length ? list('X_WATCH_ACCOUNTS')
    : ['elonmusk', 'realDonaldTrump', 'cz_binance', 'MrBeast'],
  xSearchQuery: env('X_SEARCH_QUERY'),
  xPollSec: num('X_POLL_SECONDS', 180),
  xMaxPostAgeH: num('X_MAX_POST_AGE_HOURS', 12),
  xMinViralForAi: num('X_MIN_VIRAL_FOR_AI', 25),
  xPostAlerts: env('X_POST_ALERTS', '1') === '1',
  xPostAlertMin: num('X_POST_ALERT_MIN', 80),
  xMinMomentum: num('X_MIN_MOMENTUM', 50),
  xMinBuyers: num('X_MIN_BUYERS', 8),

  // Dashboard
  port: num('PORT', 8080),
  dashboardPassword: env('DASHBOARD_PASSWORD'),
  dbPath: env('DB_PATH', 'data/pump-scout.db'),

  // When to evaluate a coin
  freshMinBuyers: num('FRESH_MIN_BUYERS', 15),
  freshMinAgeSec: num('FRESH_MIN_AGE_SEC', 20),
  freshMaxAgeSec: num('FRESH_MAX_AGE_SEC', 900),
  midProgressPct: num('MID_PROGRESS_PCT', 35),
  recheckEverySec: num('RECHECK_EVERY_SEC', 45),

  // Alerting threshold
  alertMinScore: num('ALERT_MIN_SCORE', 65),

  // Safety limits (percent of total supply)
  maxBundlePct: num('MAX_BUNDLE_PCT', 15),
  maxDevPct: num('MAX_DEV_PCT', 8),
  maxTop10Pct: num('MAX_TOP10_PCT', 35),

  // Housekeeping
  dropDeadAfterSec: num('DROP_DEAD_AFTER_SEC', 180),
  deadMinTrades: num('DEAD_MIN_TRADES', 8),
  maxTrackMinutes: num('MAX_TRACK_MINUTES', 240),
  maxTrackedCoins: num('MAX_TRACKED_COINS', 1500),

  smartWallets: new Set(list('SMART_WALLETS')),
};
