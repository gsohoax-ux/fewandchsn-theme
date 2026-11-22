# Memecoin Bot — performance, activity and trading-system audit

Date: 2026-11-22. Scope: the full codebase on branch `claude/meme-coin-trading-bot-s5ozeg`.

## How this audit was done (and its limits)

| Evidence | Available? |
|---|---|
| Source code of every component | Yes — read end to end for the coin → score → trade path |
| Automated tests | Yes — 187 run, 187 pass |
| Measured runs on the real engine with the demo coin stream | Yes — numbers below are labelled *demo* or *simulation* |
| **Your Railway logs, database, live feed and trade history** | **No.** This audit environment has no outbound network access, so it cannot reach Railway, PumpPortal or Helius |

Because the live data couldn't be read, this audit adds a **live Diagnostics report** to the bot
(Dashboard › Diagnostics, `GET /api/diagnostics?hours=24`). It computes every section below from *your* server's
measured data: coins discovered, every rejection reason, setup outcomes, paper-trading activity, latency, Helius
failure rate, storage persistence. Counts are now kept in the database, so they survive restarts. **Open it after the
next deploy has run for a few hours; it replaces the "unable to verify" items below with real numbers.**

---

## A. Executive summary

The bot is not broken in the places that would make it silent (feed, positions, P&L math, exits all verified by
code and tests). It is quiet for four measurable reasons, in order of likely impact:

1. **Helius rate limits throttle coin scoring (most likely the main cause — needs live confirmation).** Each coin
   evaluation traces ~26 wallets through Helius' enhanced API. Measured on the real engine with a simulated Helius
   at free-tier-like limits (10 req/s RPC, 2 req/s enhanced — *assumed*), the bot scored **13 coins in 3 minutes
   instead of 84** (−85 %), with **25 coins queued** and a **90-second p95 wait**. Every system downstream —
   alerts, the automatic trader, the Setuh trader (which needs a scored coin) — is starved by this.
2. **The automatic trader is small and alert-only by design.** It buys only on alerts (adaptive bar, ~15/day
   target), max **2** open positions, **~$13** per trade (45 % of a $30 day). In the demo, **15 of 21 alerts were
   skipped with "max 2 open positions"**. Its P&L therefore moves in cents to a few dollars. This is configuration,
   not a fault.
3. **The Setuh trader is strict by design and was hurt by bugs (fixed).** It needs a specific chart pattern, a
   *verified* full Coin Check (Helius again) and confidence ≥ 60. Four defects made it reject or miss more than
   intended (Bugs 1–4 below, all fixed).
4. **Copy trading does nothing until you follow wallets** (not configured).

What is *not* the cause, on the evidence: P&L calculation, position updates, stop/target/trailing execution, the
discovery feed itself, or database writes. Things that could still be causes but can only be confirmed live: the
real Helius failure rate, whether PumpPortal streams PumpSwap trades for graduated coins, and whether the Railway
volume persists data across deploys.

## B. System health

Status from code + tests + demo run. "Unable to verify" = depends on your live environment; the Diagnostics page
reports it live.

| Component | Status | Evidence |
|---|---|---|
| PumpPortal connection | Working (code/demo); live: unable to verify | Reconnect with backoff + 90 s silence watchdog; disconnects and reconnect time now measured |
| New coin discovery | Working (demo: 55 coins/h, 0 lost) | `discovery:new` / `discovery:duplicate` counters |
| WebSocket stability | Unable to verify live | `feed:disconnect`, `feedReconnect` p50 now recorded |
| Market data / prices | Working | Market hub prices every trade; demo 1,261 updates/min |
| Market-cap calculation | Working | Curve price × 1B supply × SOL/USD (SOL refreshed every 30 s); tested |
| Liquidity updates | Working (DexScreener refresh for graduated coins) | `priceRefresh` timing, provider health |
| Wallet monitoring (copy) | Not configured (no wallets followed) | — |
| Coin safety checks | Working; **throughput limited by Helius** | Simulation above |
| AI narrative | Not configured unless ANTHROPIC_API_KEY set | Rule fallback in use |
| Momentum / confidence scoring | Working | Tests |
| Setuh strategy recognition | Working; 4 bugs fixed | Tests `setuh.test.js`, `audit.test.js` |
| Automatic paper trading | Working, low frequency by design | Demo: 6 entries / 21 alerts |
| Manual paper trading | Working | Tests |
| Copy trading | Working when configured | Tests `copy-*.test.js`; demo: 19 opened / 13 closed |
| Position monitoring | Working | Stale positions (>2 min without price) are now flagged live |
| Stop-loss / take-profit / trailing | Working | `paperbook.test.js` (14 tests) |
| Database persistence | Working in code; **Railway volume unable to verify** | New boot log: Diagnostics shows "N starts recorded" — must be ≥ 2 after a deploy |
| Background workers | Working (all jobs on schedule in demo) | System Health job table |
| Notifications | Depends on NTFY_TOPIC / Telegram | — |

## C. Discovery performance

Code path: PumpPortal `subscribeNewToken` → `engine.onCreate` (duplicates ignored and now counted) → coin tracked →
scored once it has ~15 real buyers (20 s–15 min old) or 10 % curve progress → dropped if dead (< 8 trades in 3 min).

Demo (1 h window): 55 coins discovered, 0 duplicates, 30 scored, 3 died before scoring, 0 s queue wait.
Simulation with free-tier-like Helius: **only 13 of ~84 scorable coins were scored in 3 minutes.**
Discovery itself is not the bottleneck; **processing after discovery is**, when Helius is rate-limited.

## D. Rejection analysis

Every rejection is now counted with its reason and classified as *safety (mandatory)*, *quality threshold
(adjustable)*, *strategy rule (adjustable)*, *risk limit / setting* or *data quality*. Demo, 1 h:

| Reason | Where | Kind | Count |
|---|---|---|---|
| max 2 open positions | automatic trader | risk limit / setting | 15 |
| Bundled at launch | scoring | safety | 6 |
| Linked wallets | scoring | safety | 6 |
| Top N holders too high | scoring | safety | 6 |
| Recycled socials | scoring | safety | 5 |
| No traction (died early) | scoring | quality | 3 |
| Score below bar | scoring | quality | 2 |

Overlap: once a coin is AVOID it is not re-checked by later filters (the Setuh scan skips AVOID coins early), so
the same coin isn't counted repeatedly. Safety restrictions were not loosened.

## E. Strategy performance (five Setuh setups)

Demo, 1 h: New Pairs — 4 completed episodes, 2 entered, 1 rejected (AVOID: reused socials). Final Stretch A/B/C and
Migrated — no qualifying pattern in the demo stream. No setup has the 20+ completed trades needed to judge win rate
or calibrate thresholds; the journal's review notes say so instead of inventing numbers.

Implementation vs rules: the rules implemented are the ones described earlier in this project (the video itself
was never available to the bot). Defects found and fixed:

- **Bug 2 — stale signal price:** if a confirmed signal lapsed and came back, entry drift was measured from the
  *first* signal's price → false "Entry missed: price moved X %". Fixed + tested.
- **Bug 3 — silent stall:** a failed full safety check (e.g. Helius 429) left the candidate waiting ~5 min with no
  reason shown. Now reported as "insufficient data: full safety check failed …" and retried after ~1 min.
- **Bug 4 — Setup A mislabel:** clean coins with no bundle wallets showed "insufficient data" forever. With
  verified on-chain data it now says the setup doesn't apply. (No effect on entries.)

## F. Paper-trading performance

Verified by tests: purchase and sale simulation, token quantities, average cost across adds, fees, slippage, price
impact, realized and unrealized P&L, stop-loss, take-profit (incl. partial), trailing stop, multiple entries,
closure, idempotent fills, restart persistence, book separation. No case found where a trade is believed open but
not recorded (open → `sim_positions` + `sim_fills` in the same call).

Demo, 1 h — each book separately: Automatic 6 opened / 4 closed, avg size $10.16; Setuh 2 opened ($25 each);
Copy 19 opened / 13 closed; Manual 0. *Demo coins are simulated; these numbers say nothing about real profitability.*

Low P&L is explained by **low activity + small sizes**, not a broken calculation.

## G. Data accuracy and latency

The $124K-vs-$110K discrepancy was diagnosed and fixed in the previous round (graduated coins were dropped from the
live stream and priced from 10–120 s old snapshots; SOL/USD was 5 min old). Now: one market-data hub; every price is
timestamped; entries are blocked above the max data age (10 s) or when the feed is stale; dashboard and trader read
the same hub. Measured in demo: feed → engine 0 ms, setup scan ~1 ms, signal → simulated entry ~1 ms.

New in this audit: evaluation-queue wait (p50/p95) — the measurement that exposes the Helius bottleneck live.

## H. Missing features

- The Setuh video itself: rules come from the project's written descriptions; thresholds are configurable.
- Confidence calibration: impossible until each setup has ≥ 20 completed trades (by design, nothing is invented).
- Per-setup minimum confidence: not implemented (single threshold today) — proposed below.
- Self-learning: active only after 300 finished observations on a persistent database.

## I. Bugs and configuration problems

| # | Problem | Status |
|---|---|---|
| 1 | **Coin Check forced a full re-evaluation that re-downloaded all on-chain data** during every Setuh deep check (and could run concurrently with the coin's own evaluation), doubling Helius load exactly when a clean verdict was needed → rate-limit failures → UNVERIFIED → rejections | **Fixed** + test |
| 2 | Stale signal price after a lapse | **Fixed** + test |
| 3 | Silent 5-min stall after a failed deep check | **Fixed** + test |
| 4 | Setup A "insufficient data" for coins without bundles | **Fixed** + test |
| 5 | Rejection counts ("Why they died") reset on every restart | **Fixed** (persisted funnel) + test |
| 6 | Evaluation queue was strict FIFO: Final Stretch coins waited behind routine rechecks | **Fixed** (priority order: final/narrative → fresh → recheck) |
| 7 | No way to verify the Railway volume | **Fixed** (boot log in Diagnostics) |
| 8 | Helius throughput vs ~26 wallet lookups per coin | **Measured; not changed** — needs your decision (Group 2/3) |
| 9 | Automatic trader `PAPER_MAX_OPEN=2` blocks most alerts | **Configuration** — proposal below |

## J. Recommended fixes, ranked

### Group 1 — bugs and broken functionality (applied)
Items 1–7 above. Risk: low; existing behaviour preserved, 187/187 tests pass.

### Group 2 — performance and speed (proposed, not applied — they change how coins are checked)

| Priority | Change | Expected benefit | Risk |
|---|---|---|---|
| **Critical** | Confirm with Diagnostics → "On-chain checks (Helius)" failure rate and "Evaluation queue wait". If p95 wait > 30 s or failures > 10 %: **upgrade the Helius plan** (simulation at 50/10 req/s restored 75 of 84 evaluations with 0 s wait) | Coins scored on time → more alerts, more Setuh candidates, fewer UNVERIFIED | Cost (Helius paid plan) |
| High | **Two-phase scoring:** run the instant checks (timing-based bundle signs, momentum, holders) for every coin, and spend Helius wallet tracing only on coins that pass them | 3–5× fewer Helius calls; final safety verdict still on-chain before any alert or trade | A coin rejected by cheap checks never gets the full trace (it would not have qualified anyway) |
| High | Reduce wallets traced per coin from ~26 to the dev + launch-block wallets + first 12 buyers | ~45 % fewer enhanced calls | Slightly less coverage of late bundle wallets — a safety trade-off; needs your OK |
| Medium | A Helius request budget (token bucket at your plan's limits) instead of bursts + retries | No 429 storms, steadier latency | None material |

### Group 3 — strategy and configuration (proposed, not applied)

| Priority | Change | Expected effect | Risk |
|---|---|---|---|
| High | Automatic trader `PAPER_MAX_OPEN` 2 → 3 or 4 | Takes the alerts it now skips (demo: 15 of 21 skipped) | More simultaneous risk; same per-trade rules |
| Medium | If you want P&L in dollars rather than cents: raise `PAPER_DAILY_USD` / Setuh position size | Larger simulated results (same % outcomes) | Larger simulated drawdowns; no effect on quality |
| Medium | Per-setup minimum confidence (keep 60 globally until each setup has 20+ trades, then set from the journal's confidence-range table) | Evidence-based thresholds | None until applied |
| Low | Revisit max entry drift (6 %) only if the live report shows "missed: price moved" dominating | Fewer missed entries | Entries at worse prices |
| Keep | Require verified safety + full Coin Check for Setuh entries | — | Turning these off would let unverified coins trade: **not recommended** |

The objective is a better trading system, not more trades. Applying Group 2's Helius fix first lets the bot actually
see the market; only then do the Group 3 numbers become meaningful.

## Tests

`npm test`: **187 tests, 187 pass, 0 fail** (106 original + 81 added over the project, 7 in this audit:
funnel persistence, reason classification, diagnostics findings, Bug 1 re-evaluation, Bug 4 Setup A,
Bug 2 signal reset, Bug 3 deep-check failure).
