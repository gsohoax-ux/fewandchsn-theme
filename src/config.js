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
  aiModel: env('AI_MODEL', 'claude-haiku-5-5'),
  aiMaxCallsPerHour: num('AI_MAX_CALLS_PER_HOUR', 20),

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

  // Trend scanner (free): Google Trends + Wikipedia + Reddit + X radar + Pump.fun themes
  trends: env('TRENDS', '1') === '1',
  trendGeo: env('TREND_GEO', 'US'),
  trendPollMin: num('TREND_POLL_MIN', 15),
  trendSpikeTraffic: num('TREND_SPIKE_TRAFFIC', 200000),  // Google searches that count as a big spike
  trendReddit: env('TREND_REDDIT', '1') === '1',
  trendAlerts: env('TREND_ALERTS', '1') === '1',
  trendAlertMin: num('TREND_ALERT_MIN', 65),             // meme potential needed for a phone alert about a trend

  // Extra text that marks a quick-deploy tool in a coin's details (J7 and "deployed using ..." are built in)
  deployToolPatterns: list('DEPLOY_TOOL_PATTERNS'),

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
  paperStartSol: num('PAPER_START_SOL', 2),          // used only when PAPER_DAILY_USD is 0
  paperDailyUsd: num('PAPER_DAILY_USD', 30),         // fresh $ budget every day (0 = one running account in SOL)
  paperLowUsd: num('PAPER_LOW_USD', 10),             // phone alert when today's balance drops under this
  paperStopAtLow: env('PAPER_STOP_AT_LOW', '0') === '1', // also stop paper buying for the day at that point
  paperTz: env('PAPER_TZ', 'America/Chicago'),       // when a new day starts
  paperSizePct: num('PAPER_SIZE_PCT', 45),           // % of equity per trade: fewer, bigger trades so fixed fees matter less
  paperMaxOpen: num('PAPER_MAX_OPEN', 2),
  paperStopPct: num('PAPER_STOP_PCT', 35),           // sell if the PRICE falls this % below the entry
  paperTrailStartPct: num('PAPER_TRAIL_START_PCT', 30), // trailing stop starts after the price rises this %
  paperTrailPct: num('PAPER_TRAIL_PCT', 20),         // ...and sells after the price drops this % from its best
  paperTrailAfterGradPct: num('PAPER_TRAIL_AFTER_GRAD_PCT', 12), // tighter trail once the coin has graduated
  paperGradTakePct: num('PAPER_GRAD_TAKE_PCT', 92),  // sell half when the curve reaches this % (0 = off)
  paperGradExitMin: num('PAPER_GRAD_EXIT_MIN', 5),   // sell the rest this many minutes after graduation
  paperStallMin: num('PAPER_STALL_MIN', 25),         // exit if no follow-through within this many minutes...
  paperStallGainPct: num('PAPER_STALL_GAIN_PCT', 30), // ...meaning the price never got this % above the entry
  paperMaxHoldMin: num('PAPER_MAX_HOLD_MIN', 90),
  paperFeePct: num('PAPER_FEE_PCT', 1.25),           // Pump.fun trading fee per side
  paperTxFeeSol: num('PAPER_TX_FEE_SOL', 0.0015),    // network + priority fee per transaction (match your Padre setting)
  paperSlippagePct: num('PAPER_SLIPPAGE_PCT', 2),    // extra slippage from being slower than snipers
  paperTerminalFeePct: num('PAPER_TERMINAL_FEE_PCT', 1), // trading app fee per side (Padre/Axiom/GMGN charge about 1%)
  paperMevPct: num('PAPER_MEV_PCT', 2),               // sandwich-bot losses on buys
  paperMaxFixedCostPct: num('PAPER_MAX_FIXED_COST_PCT', 5), // skip trades where network fees exceed this % of the trade

  // Market regime: when few coins are graduating, be pickier
  coldGradPct: num('COLD_GRAD_PCT', 0.4),            // 24h graduation rate below this % = cold market
  coldScoreBump: num('COLD_SCORE_BUMP', 5),          // extra score needed to alert in a cold market (fixed bar only)
  // Adaptive alert bar: alert the best clean coins of the current market instead of a fixed score
  alertTargetPerDay: num('ALERT_TARGET_PER_DAY', 15), // aim for about this many alerts a day (0 = fixed ALERT_MIN_SCORE)
  alertFloor: num('ALERT_FLOOR', 58),                 // never alert below this score
  alertCeiling: num('ALERT_CEILING', 80),             // never require more than this
  topPicksEveryMin: num('TOP_PICKS_EVERY_MIN', 60),   // phone digest of the best SAFE coins (0 = off)

  // Dashboard
  port: num('PORT', 8080),
  dashboardPassword: env('DASHBOARD_PASSWORD'),
  dbPath: env('DB_PATH', 'data/pump-scout.db'),

  // When to evaluate a coin
  freshMinBuyers: num('FRESH_MIN_BUYERS', 15),
  freshMinAgeSec: num('FRESH_MIN_AGE_SEC', 20),
  freshMaxAgeSec: num('FRESH_MAX_AGE_SEC', 900),
  finalStretchPct: num('FINAL_STRETCH_PCT', 70),    // Final Stretch: coins this close to graduating get scored again
  newPairMaxMin: num('NEW_PAIR_MAX_MIN', 15),         // dashboard: coins younger than this are New Pairs
  midProgressPct: num('MID_PROGRESS_PCT', 0),         // optional mid-curve check (0 = off: the middle rarely pays)
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
