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

  // Free tweet radar: N coins linking the same X post within a window = viral post
  radarMinCoins: num('RADAR_MIN_COINS', 3),
  radarWindowMin: num('RADAR_WINDOW_MIN', 60),
  radarAlerts: env('RADAR_ALERTS', '1') === '1',

  // Self-learning
  learnTarget: num('LEARN_TARGET', 1.5),             // "a hit" = coin reached this multiple after scoring
  learnHorizonMin: num('LEARN_HORIZON_MIN', 120),    // how long after scoring we watch the outcome
  learnMinSamples: num('LEARN_MIN_SAMPLES', 300),    // finished coins needed before learning
  learnMinLift: num('LEARN_MIN_LIFT', 1.3),          // learned model must beat average by this much
  learnEveryMin: num('LEARN_EVERY_MIN', 30),
  learnMaxSamples: num('LEARN_MAX_SAMPLES', 20000),
  learnBlend: num('LEARN_BLEND', 0.5),               // weight of the learned score once validated

  // Free DexScreener check (did the dev pay for a DexScreener profile/boost?)
  dexCheck: env('DEX_CHECK', '1') === '1',

  // Paper trading (fake money) - tests whether following the alerts would make money
  paper: env('PAPER', '1') === '1',
  paperStartSol: num('PAPER_START_SOL', 2),          // changing this starts a fresh paper account
  paperSizePct: num('PAPER_SIZE_PCT', 8),            // % of equity per trade
  paperMaxOpen: num('PAPER_MAX_OPEN', 5),
  paperStopPct: num('PAPER_STOP_PCT', 25),           // sell if down this %
  paperTrailStartPct: num('PAPER_TRAIL_START_PCT', 30), // trailing stop starts after this gain
  paperTrailPct: num('PAPER_TRAIL_PCT', 20),         // ...and sells after this drop from the best value
  paperMaxHoldMin: num('PAPER_MAX_HOLD_MIN', 90),
  paperFeePct: num('PAPER_FEE_PCT', 1.25),           // Pump.fun trading fee per side
  paperTxFeeSol: num('PAPER_TX_FEE_SOL', 0.002),     // network + priority fee per transaction
  paperSlippagePct: num('PAPER_SLIPPAGE_PCT', 3),    // extra slippage from being slower than snipers

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
