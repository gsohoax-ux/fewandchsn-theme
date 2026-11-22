# Memecoin Bot: architecture and feature inventory

This document records what the bot does, where each part lives, and how the platform is organized into
three sections. It was written from an audit of the code before the reorganization; nothing listed under
"existing" was removed.

## 1. Runtime and infrastructure (unchanged)

| Part | Implementation |
|---|---|
| Runtime | Node 22, ES modules, no required npm dependencies (optional `@anthropic-ai/sdk`) |
| Database | SQLite via `node:sqlite`, file `data/pump-scout.db` (Railway volume at `/app/data`) |
| Hosting | Railway, `Dockerfile`, `npm start` |
| Auth | `DASHBOARD_PASSWORD`, HMAC session cookie (1 year), login rate limiting |
| App | Installable PWA (`manifest.webmanifest`, `sw.js`, icons) |
| Config | `.env` → `src/config.js` |

## 2. Service map

```
                       ┌──────────────── market data ─────────────────┐
PumpPortal WS ─ feed.js ─► engine.js (discovery, scoring, alerts) ──► notify.js / telegram.js
                 │            │  uses: safety.js chain.js momentum.js narrative.js score.js
                 │            │        confidence.js learn.js copies.js liquidity.js dexscreener.js
                 │            │        xwatch.js trends.js
                 │            ├─► paper.js            SYSTEM A: automatic paper trading (alerts)
                 │            └─► strategy/engine.js  SYSTEM B: Setuh strategy paper trading
                 │                                       └─ paperbook.js (book "strategy")
                 ├──────────► manual.js               Coin Check & Paper Trade
                 │                                      └─ paperbook.js (book "manual")
                 └──────────► copy/engine.js          Copy Trading (account trades + Helius confirmation)
                                                        └─ paperbook.js (book "copy")
candles.js   GeckoTerminal OHLCV + candles built from recorded live trades (charts, migrated setups)
deepcheck.js full single-coin safety check (Helius + DexScreener + RugCheck)
health.js    per-provider API health, background-job status, database health
store.js     SQLite (launches, alerts, samples, paper_trades, kv, sim_positions, sim_fills,
             strategy_signals, audit_log)
server.js    HTTP API + static app (public/index.html, public/app/*.js)
```

### Service boundaries

| Concern | Module | Notes |
|---|---|---|
| Market-data ingestion | `feed.js`, `candles.js`, `dexscreener.js` | Feed reconnect + watchdog; candles rate-limited and cached |
| Coin discovery | `engine.js` (`onCreate`, `tick`, `board`, `movers`) | Stages: fresh, final, x, trend, recheck, manual |
| Token safety | `safety.js`, `deepcheck.js`, `liquidity.js` | Verdicts SAFE / CAUTION / AVOID / UNVERIFIED |
| Wallet intelligence | `chain.js`, `safety.js` (clusters), `strategy/devrep.js` | Funding links, dev history, tracked devs |
| Narrative analysis | `narrative.js` (AI + rule fallback), `xwatch.js` | AI never overrides safety (AVOID coins are never alerted) |
| Trend detection | `trends.js`, engine radar | Needs 2+ sources and spike or longevity |
| Learning engine | `learn.js`, `store.js` samples | 300 finished coins, 1.3x lift on held-out coins before use |
| Strategy engines | `strategy/*.js` | Independent from System A |
| Paper execution | `paper.js` (System A), `paperbook.js` (manual + System B) | Books never share positions |
| Position monitoring | server-side: feed trades + 10 s polling | Exits never depend on an open browser |
| Notifications | `notify.js`, `telegram.js` | ntfy + optional Telegram |
| Dashboard APIs | `server.js` | JSON APIs, JSON-only POSTs |
| Health | `health.js` | Instruments every outbound `fetch` by provider |

## 3. Feature inventory → new navigation

### Section 1: Dashboard (existing features, reorganized)

| Existing feature | Source | New location |
|---|---|---|
| Status pills (feed, Helius, AI, alerts, X, market regime) | engine.status | Top bar + System Health |
| Stats tiles | engine.status, store.stats | Overview → analytics |
| Board: New Pairs / In between / Final Stretch | engine.board | Overview → Discovery |
| Runner detection (score, reasons, 🏃) | score.runnerScore | Overview → Runners panel + coin detail |
| 5-min movers ticker (AVOID excluded) | engine.movers | Overview → Market movers |
| Live ranking table | engine.ranked | Overview → Ranking |
| Coin detail dialog (labels BUY ZONE / LOW RISK / WATCH / DO NOT BUY, spark, outcomes, liquidity, runner, confidence, X, trend) | engine.coinView | Coin detail dialog (all sections) |
| Automatic paper trading card (budget, today, all time, wins vs losses, moonbags, by stage, rules) | paper.view | Overview → Auto paper trading |
| Trends to watch (sources, thesis, ideas, coins) | engine.trendView | Trends |
| Posts on X to watch / tweet radar | engine.xPosts | Trends |
| Narratives running now | status.hotThemes | Trends |
| What the bot has learned | learner.status | Learning Center |
| Desk (Scout, Filter, Analyst, Alerts, Executor, Risk) | status.pipeline + events | System Health |
| Logger | engine.events | System Health |
| Why they died | engine.kills | Overview |
| Recent alerts with peak multiple | store.recentAlerts | Overview |
| Deep check form | deepcheck | Moved to Coin Check (top-bar search routes there) |

### Section 2: Strategy (new, System B)

| Area | Setups |
|---|---|
| New Pairs | Launch pullback (50–60%) to a support floor with buying confirmation |
| Final Stretch | A: 60% bundle pullback · B: 40–50% pullback above $15K · C: tracked developer wallet |
| Migrated Coins | 1–3 h old graduates, 60–70% off a $100K+ high, sideways floor, breakout |
| Performance | Per-setup statistics, separate from System A |

### Section 3: Coin Check & Paper Trade (existing, extended)

Search by address or link → full deep check (all existing checks) → large live chart → manual paper
positions with stop-loss, take-profit, trailing stop, partial and full sells, and trade history.

## 4. Copy trading (System D)

`copy/classify.js` turns a confirmed transaction (`getTransaction`, jsonParsed) into what the wallet did per token,
using only on-chain facts: `meta.err`, the wallet's pre/post token balances, its SOL change (fee added back), wrapped
SOL / USDC / USDT as payment, and the DEX programs that ran (top-level, inner instructions and logs). Buys, adds, sells
(with the exact % of the balance), exits and token-to-token routes are copied; transfers, funding, liquidity moves,
failed and unclear transactions are recorded and skipped.

`copy/engine.js` gets signatures from PumpPortal `subscribeAccountTrade` (instant) and from Helius
`getSignaturesForAddress` polling (complete, any DEX), confirms each with `getTransaction` (retrying ones not yet
indexed), and acts once per wallet + signature + token (`copy_events` primary key, plus fill idempotency keys).
Buys use a fixed $ amount with position, trader and portfolio caps, delay, liquidity and slippage limits; sells
mirror the trader's % on the copy. Without Helius it runs on the feed alone and says so.

## 5. Independent paper-trading systems

| | System A (automatic, existing) | System B (Setuh strategy) | Manual | System D (copy) |
|---|---|---|---|---|
| Module | `paper.js` | `strategy/engine.js` + `paperbook.js` book `strategy` | `manual.js` + `paperbook.js` book `manual` | `copy/engine.js` + book `copy` |
| Entries | Every alert | Setup signals | You | Followed wallets' buys/adds |
| Budget | `PAPER_DAILY_USD` (30) | `STRATEGY_DAILY_USD` (50) | Per position | $ per buy + exposure caps |
| Exits | −35% stop, trailing, 92% curve, graduation, stall, max hold, runner, moonbag | Per-setup stop/target/time stop | Your stop / target / trail / sells | Mirrored sells + optional own rules |
| Storage | `paper_trades`, kv `paper` | `sim_positions`/`sim_fills` where book = `strategy`, `strategy_signals` | `sim_*` where book = `manual` | `sim_*` book `copy`, `copy_traders`, `copy_events` |

A book only ever loads and manages rows with its own book name.

## 6. Data integrity rules

- Prices, liquidity and candles come only from PumpPortal trades, DexScreener or GeckoTerminal. When none
  is available the UI shows "unavailable" and marks stale data with its age.
- Every simulated sell has an idempotency key (unique in `sim_fills`), so a stop-loss, target or button
  press can never execute twice.
- Every open, sell, rule change and strategy config change is written to `audit_log`.
- Historical numbers are labelled "past results"; nothing shows a projected multiple as a likely outcome.

## 7. Known limitations

- GeckoTerminal's free API allows about 30 requests a minute, so charts cache for 15–60 s and migrated-coin
  scanning is queued. Coins too new for GeckoTerminal fall back to candles built from the trades the bot
  recorded live (only from the moment the bot started watching the coin).
- Buy/sell counts are shown when the provider reports them (GeckoTerminal pool data, or the bot's own
  feed for bonding-curve coins).
- Copy trading sees what a wallet does on-chain; it can't see orders on centralized exchanges or trades from other
  wallets the same person controls. A copy always fills after the trader, usually at a worse price.
- Wallet labels ("tracked developer") are only as good as the bot's history plus wallets you add.
