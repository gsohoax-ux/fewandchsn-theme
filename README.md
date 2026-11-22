# pump-scout

A **read-only** Pump.fun scout. It watches every new coin, scores the ones that get traction, and
sends the best to your **phone** (via the free **ntfy** app) and a **live dashboard**. Then you paste the contract
address into Padre and decide yourself.

It never touches your wallet and never trades.

```
🟢 $WGOOSE · Wizard Goose   73/100  [FRESH]
7Ckt3TZMuBpLMUTmMZmNW6DqLHhYGMXXPaLmQUPNpump
MC $9.8k · Curve 24% · Age 1m 40s · 61 holders

🧠 Narrative 65 — wizard goose (riding meta)
📈 Momentum 67 — curve +9.1%/min, buy/sell 2.3x, 28 buyers in 2m
🛡 Safety SAFE (88)
   ✅ No bundle at launch (same block)
   ✅ No linked wallets among early buyers
   ✅ Fresh wallets among early buyers: 1/12
   ✅ Dev holds 0.9%
   ⚠️ Top 10 holders: 29.1%
```

## What it checks

| | How |
|---|---|
| **Bundles** | Wallets that bought in the **same block** the coin was created, usually a Jito bundle from the dev's team. Shows the % bought and how much is still held. |
| **Linked wallets** | Traces **who funded** each early buyer. If several were funded by the same wallet, or by the dev, they're one person. Exchange hot wallets are ignored. |
| **Fresh wallets** | Lots of brand-new wallets among the first buyers is a typical bundle-farm pattern. |
| **Dev** | Dev's % of supply, whether they're selling, and whether they're a **serial launcher**: many coins in 24h. |
| **Holders** | Top-10 concentration. |
| **Recycled socials** | The same X or Telegram link already used by another coin. |
| **Narrative** | AI reads name, ticker, description and socials, and compares them with **what's actually pumping right now**. The bot learns the current meta from coins that reach 30%+ of the curve. It also flags copycats (same ticker) and "tweet coins". |
| **Momentum** | Curve speed (%/min), unique buyers, buy/sell volume, net SOL inflow, wash-trading, drawdown from the high, and optional "smart wallets" you list. |
| **Bot-farm filter** | Tiny "dust" buys under 0.02 SOL don't count as buyers, and only wallets holding 0.01%+ count as holders. Several identical-size buys in the first 5 seconds are flagged as a scripted bundle. |
| **Dex paid** | Free DexScreener check: did the dev pay for a DexScreener profile? |
| **Dev rugged before** | The bot remembers how each dev's earlier coins ended. A dev whose past coin pumped and then crashed gets ⛔. A dev with graduated coins gets ✅. Only coins seen while the bot was running count. |

### 📄 Paper trading (fake money, free)

The bot "buys" every alert with a fake balance and manages each position with risk rules, so you
can see in dollars whether following the alerts would make money. **Nothing touches a wallet.**

- Fills are deliberately **pessimistic**: real bonding-curve price impact, the Pump.fun fee on every
  buy and sell, a network fee per transaction, and extra slippage for being slower than snipers.
  A position starts about 8–12% down the moment it's bought, which is roughly what really happens.
- Rules (change them in Railway Variables):

| Setting | Default | Meaning |
|---|---|---|
| `PAPER_DAILY_USD` | 30 | Fresh fake budget **every day**. Yesterday's positions are closed at midnight and you get a phone summary of the day. `0` uses one running account instead. |
| `PAPER_LOW_USD` | 10 | Phone alert (once a day) when today's balance drops under this |
| `PAPER_STOP_AT_LOW` | 0 | `1` also stops paper buying for the rest of the day at that point |
| `PAPER_TZ` | America/Chicago | When a new day starts |
| `PAPER_START_SOL` | 2 | Starting balance, only used when `PAPER_DAILY_USD` is 0 |
| `PAPER_SIZE_PCT` | 45 | % of the balance per trade (about $13 of $30). Fewer, bigger trades so fixed network fees matter less. |
| `PAPER_MAX_OPEN` | 2 | Max positions at once |
| `PAPER_STOP_PCT` | 35 | Sell if the **price** falls this % below the entry. It uses price, not value after costs, because costs alone put a new position about 10–15% down. |
| `PAPER_TRAIL_START_PCT` / `PAPER_TRAIL_PCT` | 30 / 20 | After the price rises 30%, sell when it drops 20% from its best |
| `PAPER_GRAD_TAKE_PCT` | 92 | Sell half when the curve reaches this %. Graduation is often the top. `0` turns it off. |
| `PAPER_GRAD_EXIT_MIN` / `PAPER_TRAIL_AFTER_GRAD_PCT` | 5 / 12 | Sell the rest this many minutes after graduation, with a tighter trail in the meantime |
| `PAPER_STALL_MIN` / `PAPER_STALL_GAIN_PCT` | 25 / 30 | Exit if the price never got +30% within 25 minutes (no follow-through) |
| `PAPER_TERMINAL_FEE_PCT` / `PAPER_MEV_PCT` | 1 / 2 | Trading-app fee per side, and sandwich-bot losses on buys |
| `PAPER_MAX_FIXED_COST_PCT` | 5 | Skip trades where network fees would be more than this % of the trade |
| `PAPER_MAX_HOLD_MIN` | 90 | Sell after this many minutes regardless |
| `PAPER_FEE_PCT`, `PAPER_TX_FEE_SOL`, `PAPER_SLIPPAGE_PCT` | 1.25, 0.0015, 2 | Costs. Set the tx fee to match your Padre priority fee. |
| `PAPER` | 1 | 0 turns paper trading off |

A −6% stop like some bots advertise would trigger almost immediately, because fees and slippage alone
cost about that much. That's why the default stop is wider, and why it is measured on price.

The paper card also shows **results by when it bought** (stage and curve %). After a few hundred
trades, that tells you which entry timing actually makes money. Each trade logs its best and worst
move, its cost hurdle, and the market mood at entry.

**Market mood:** the bot tracks what share of new coins graduated in the last 24 hours. Below
`COLD_GRAD_PCT` (0.4%) the market is "cold", and the alert bar goes up by `COLD_SCORE_BUMP` (5).

**Real auto-trading is not built yet, on purpose.** It only makes sense after paper trading has been
profitable over a good number of trades. It also means giving the bot a wallet key, so it needs
extra safety work first.

### 🚀 Runner hunting (the big trades)

Big runners (5–10x+) are rare, so the bot looks for the signs that tend to come before them and gives
those coins room to run, while keeping losses small on everything else.

- **Runner score** (0–100) on SAFE coins: top narrative (80+), a lasting or viral trend / X post, strong
  momentum, **whale buys** (≥ `WHALE_SOL`=3 SOL from real, non-insider wallets in the last 2 min), clean dev
  history, High confidence, smart wallets.
- It's only a runner with score ≥ `RUNNER_MIN` (60) **and a real catalyst**: a trend/viral post or whale buying.
- **🚀 RUNNER alert:** top priority, sent once even if the coin was alerted before. Coins are marked 🏃 on
  the Board and in the ranking, and the coin details list the reasons.
- **Paper trading gives runners room:** sells only `PAPER_RUNNER_TAKE_PCT` (25%) near graduation, keeps a
  `PAPER_RUNNER_MOONBAG_PCT` (30%) moonbag, uses a `PAPER_RUNNER_TRAIL_PCT` (30%) trail, skips the 25-minute
  no-follow-through exit, and allows up to `PAPER_RUNNER_MAX_HOLD_MIN` (180) minutes. A coin already held is
  upgraded if it becomes a runner.
- Results: "🏃 runner trades" in Results by when it bought, and "Coins like this" adds % that reached 3x and 5x.

### 🌙 Moonbags and ✅ wins vs ❌ losses

- **Moonbag:** on coins that **graduate cleanly** (still SAFE, no insider dump or dev selling) **and** have a
  **lasting story** (a multi-day trend, or narrative ≥ `PAPER_MOONBAG_MIN_NARRATIVE`=80), the graduation
  exit keeps `PAPER_MOONBAG_PCT` (15%) of the original position. It sells after a `PAPER_MOONBAG_TRAIL_PCT` (50%)
  drop from its best price, when liquidity disappears, or after `PAPER_MOONBAG_MAX_HOURS` (48). Prices
  come from DexScreener, so it keeps working after the bot stops watching the coin and across restarts.
  Moonbags sit **outside the daily $ budget** (moved out at their value), and their results are added to the
  all-time total and shown separately, so you can see whether they help. `PAPER_MOONBAG_PCT=0` turns them off.
- **Wins vs losses** (today and all time): wins, losses, win rate, average win, average loss, best, worst and
  **profit factor** (money won ÷ money lost; above 1.0 = profitable). A position counts once it's completely
  finished, with its partial sells and moonbag added together.

### 📜 Desk, Logger and "Why they died"

The dashboard shows each part of the bot (Scout, Filter, Analyst, Alerts, Executor, Risk) with
what it last did, a live **Logger** of every decision and its reason, a **Why they died** chart of
rejection reasons, and a **ticker** of the biggest movers in the last 5 minutes. AVOID coins are
left out of the ticker.

### 🧠 Self-learning (free)

The bot records **every coin it scores** and what happened over the next **2 hours**: how high it
went, and whether it graduated. Once it has **300 finished coins**, it learns which signals actually
came before pumps, and retrains every 30 minutes as data grows.

- It's **tested before it's trusted**. The bot trains on older coins and checks itself on the newest
  ones it hasn't seen. Only if its top picks hit 1.5x at least **1.3x more often than average** does
  it start mixing its learned ranking into the score, at 50/50. Otherwise the default scores stay.
- Each coin then shows a real **"📊 chance of 1.5x"**, compared with the average coin.
- The dashboard panel **"What the bot has learned"** shows which signals help (▲) and which hurt (▼).

**The Railway volume (`/app/data`) is required for learning.** Without it, the history is wiped
every time the bot restarts or updates. Settings: `LEARN_TARGET` (1.5), `LEARN_HORIZON_MIN` (120),
`LEARN_MIN_SAMPLES` (300), `LEARN_MIN_LIFT` (1.3), `LEARN_BLEND` (0.5).

### 🎯 Confidence meter

Every score comes with a confidence rating: **Low / Medium / High** and a meter like ▰▰▰▱▱.
It answers *"how much should I trust this score?"*, not *"will it go up?"*:

- **Data quality:** on-chain bundle check or only an estimate? AI-read narrative or simple rules?
  Enough buyers to judge? Has the bot learned the current meta yet?
- **Agreement:** do safety, narrative and momentum point the same way, or are the signals mixed?
- **Track record:** once there are 10+ past alerts with a similar score, it shows how often they
  reached 1.5x and folds that in.

Tap a coin on the dashboard to see exactly why its confidence is what it is.

### 🔍 Deep check any coin

Paste any Solana token address into **Deep check a coin** at the top of the dashboard. That includes new,
graduated and older coins, even ones the bot never saw. In 10–30 seconds you get **SAFE / CAUTION / AVOID**
(or **UNVERIFIED** if the key checks couldn't run) with every check listed:

- **Authorities:** mint authority (can more tokens be made?) and freeze authority (can your tokens be frozen?)
- **Launch:** finds the creation transaction, every wallet that bought in the **same block** (including
  wallets the dev paid for), how much they bought and **still hold**, snipers in the first 3 blocks, and
  the dev's own buy
- **Holders:** the real top 10, with the bonding curve and pools excluded (program-owned accounts are detected)
- **Wallet links:** traces who funded the dev, launch buyers and top holders. Shared funders,
  dev-funded wallets and fresh wallets are flagged, and exchanges are ignored.
- **Dev:** current holdings, a brand-new wallet, past rugs and launches the bot has seen
- **Socials:** what's linked, reused socials, quick-deploy tags
- **Market** (DexScreener): bonding curve or DEX, market cap, liquidity vs market cap, volume, buys vs sells
- **RugCheck** risk report as a second opinion
- **The bot's live read**, if it's tracking the coin
- **Couldn't check:** anything that failed is listed, so you know how solid the verdict is

- **Honeypot & tax:** Token-2022 transfer tax, transfer hooks that can block selling, permanent delegates,
  frozen-by-default accounts, non-transferable tokens, freeze authority, and "buys but zero sells"
- **Liquidity & slippage:** liquidity vs market cap (a low ratio is flagged HIGH RISK), slippage and price move
  for $30 / $50 / $100 / $500 buys given the pool's depth, and a **cash-out check**: what selling would
  really bring if your trade grew 5x on paper. Paper gains can't be cashed out in a thin pool.
  `CHECK_ORDER_USD` (50) is your planned trade size.

History numbers ("coins like this", runner signs) are **past results, not forecasts**. The bot never presents a
multiple as a likely outcome.

Needs the Helius key for the on-chain parts. Results are cached for 2 minutes. A clean check lowers the risk
but can't rule out a rug, since devs can still sell.

### 🔎 Finding the best coins every day

- **Adaptive alert bar:** instead of a fixed score, the bot alerts the **top clean coins of the current
  market**, aiming for about `ALERT_TARGET_PER_DAY` (15) alerts a day, never below `ALERT_FLOOR` (58)
  and never above `ALERT_CEILING` (80). It uses the fixed `ALERT_MIN_SCORE` until about 30 coins have
  been scored. The Desk shows the current bar. Set `ALERT_TARGET_PER_DAY=0` to use the fixed bar.
- **🔎 Best coins right now:** every `TOP_PICKS_EVERY_MIN` (60) minutes your phone gets the top 3 SAFE
  live coins with score, confidence, market cap and a tap-to-open link, so quiet stretches still show
  what's worth a look. `0` turns it off.

### 🆕 New Pairs and 🏁 Final Stretch

The dashboard **Board** splits live coins like Padre/Axiom do:
- **🆕 New pairs:** under 15 minutes old (`NEW_PAIR_MAX_MIN`). Coins are scored once they have about 15 **real**
  buyers. Launch-moment bundles and linked wallets don't count.
- **↔ In between:** the middle of the curve. Coins here are past the early-price advantage but not yet
  close to graduating, and most die here. They are shown so you can watch them, but they aren't alerted by
  default (`MID_PROGRESS_PCT`=0).
- **🏁 Final stretch:** 70%+ of the curve (`FINAL_STRETCH_PCT`). Each coin is scored again here and can alert
  as **FINAL STRETCH**. These coins graduate more often, and paper trading sells half at 92% and the rest
  shortly after graduation.

A coin gets at most one alert per 10 minutes, except when it reaches the Final Stretch.

### 📈 Trend scanner (free, always on)

Finds what's trending **across the internet** that could become a coin, and checks it from several angles:

| Source | Signal |
|---|---|
| Google Trends (trending now, `TREND_GEO`=US) | Search volume: the **spike** signal |
| Wikipedia most-viewed articles | Attention over days: the **lasting** signal |
| Reddit r/popular (`TREND_REDDIT`) | Memes and viral moments |
| X (tweet radar / X watcher) | Posts coins are launching on |
| Pump.fun | Themes of coins actually pumping |

A trend only **counts** when it's on **2 or more sites** and is **either spiking** (`TREND_SPIKE_TRAFFIC`=200k
searches, a 3x Wikipedia jump, or 3+ sites within 6 hours) **or lasting** (seen on 2+ days). With an AI key,
each trend gets a **thesis**: meme potential, spike vs lasting, and likely coin names and tickers.

You get a **📈 Trend** phone alert for strong trends (meme potential ≥ `TREND_ALERT_MIN`=65), and a
**📈 TREND** coin alert when the **leading coin** on a trend is **rising and SAFE**. The dashboard shows
**Trends to watch**, with each site's status and the coins found for each trend.

### 🚀 Quick-deploy coins and 🪞 copies

Tools like **J7** let people launch a coin seconds after a tweet, often copying ("vamping") another
coin's name, image and links. The bot tags:
- **🚀 Quick-deploy coins:** the coin's details mention a deploy tool (e.g. "Deployed using
  j7tracker.io"). Add more tool names with `DEPLOY_TOOL_PATTERNS`, comma separated.
- **🪞 Copies:** the **exact same image** as a coin from the last 24h (matched on the image's IPFS
  fingerprint), or the same name and ticker.

They appear as ℹ️ notes on the coin and as badges on the Board. **They don't change the score yet.**
Paper trading reports them separately ("🚀 quick-deploy coins", "🪞 copies of other coins"), and
self-learning uses them as two extra signals, so the data decides whether they're good or bad. When
several copies pile onto one tweet or trend, the alerts already go only to the leading coin.

### 📡 Free tweet radar (always on, no key needed)

Coin creators often launch on a viral tweet and put its link in the coin's socials. When
**3 or more new coins link the same X post within an hour**, the post is probably blowing up.
The radar then:

- sends a **📡 Tweet radar** notification and puts the post in the dashboard's "Posts on X to watch",
- matches every coin about it, by link or by name,
- sends a **🐦 X NARRATIVE** alert for the **leading coin** on that post, but only if it is **rising and SAFE**.

It can't see likes or views, and it only spots a post once coins launch on it. The paid X watcher
below catches posts earlier. Tune it with `RADAR_MIN_COINS` (default 3), `RADAR_WINDOW_MIN`
(default 60) and `RADAR_ALERTS` (1 or 0).

### 🐦 X watcher (optional, needs an X API key)

- Watches X accounts you choose, plus an optional search, for **new posts that are blowing up**.
- Rates each post's **meme potential**. With an Anthropic key, AI reads the post and guesses the
  likely coin name and ticker.
- Also looks up the posts that new coins link to, to check whether that post is actually viral.
- Matches Pump.fun coins to posts by link, ticker or name.
- **🐦 X NARRATIVE alert** only when a coin about the post is **the leading coin** on it, is
  **rising** (momentum, curve going up, more buying than selling) **and is SAFE**. CAUTION or
  AVOID coins never get this alert.
- Optional **📣 meme-able post** notification as soon as a hot post appears, so you can watch
  for the coin.
- Dashboard panel **"Posts on X to watch"**: each post, how viral and meme-able it is, and the coins
  found for it with their scores.

Each coin is scored **twice** to match your style:
- **FRESH**: once it has ~15 buyers (usually in the first 1–3 minutes)
- **MID-CURVE**: when it reaches 35% of the bonding curve

After an alert, it also warns you if **the dev starts selling**, if **bundle wallets dump**, or when the coin **graduates**.

> **Be realistic:** the score is a *filter* that removes rugs and dead coins and ranks what's left.
> It cannot predict the future. The dashboard tracks how every alert performed afterwards
> ("hit 2x", "graduated"), so after a week or two you'll know if it actually helps you.

---

## Setup (about 20 minutes)

### Step 1: Get your keys

| Key | What it's for | Where | Cost |
|---|---|---|---|
| **ntfy app** | Alerts on your phone | Install **ntfy** from the App Store or Google Play. No account or key needed. | Free |
| **Helius API key** | Bundle and funding-wallet tracing | Sign up at **dashboard.helius.dev** and copy the API key | Free tier is fine to start |
| **X API Bearer token** *(optional)* | X watcher | **developer.x.com**, create a project or app, then copy the Bearer token. **Paid**: check current pricing. | Paid |
| **Anthropic API key** *(optional)* | AI narrative scoring | **console.anthropic.com**, then API Keys | Pay per use. Roughly 1–2¢ per coin it scores; capped by `AI_MAX_CALLS_PER_HOUR` |

Without Helius, bundle detection still works but is an *estimate*, based on timing.
Without Anthropic, a simpler rule-based narrative score is used.

> 🔒 Keys are passwords. Never paste them in a chat, a screenshot or a public place. They only go in your `.env` file.

### Step 2: Get a small server

The bot has to run 24/7, so it needs a computer that's always on. The easiest option is a cheap
cloud server (a "VPS"), for example **Hetzner**, **DigitalOcean** or **Vultr**, at about **$5–6/month**.
Pick **Ubuntu**, the smallest size, and a region close to the US East Coast or Europe.

Your own computer also works, but only while it's on.

### Step 3: Install and run

Connect to the server (the provider shows you how, usually "Console" in their website) and paste:

```bash
# install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# download the memecoin bot
git clone https://github.com/gsohoax-ux/memecoin-bot.git memecoin-bot
cd memecoin-bot
git checkout claude/meme-coin-trading-bot-s5ozeg
npm install

# create your settings file and put your keys in it
cp .env.example .env
nano .env        # paste keys, then Ctrl+O, Enter, Ctrl+X to save
```

**First try demo mode** (fake coins, no keys needed) to see how it works:

```bash
npm run demo
```

Then the real thing:

```bash
npm start
```

### Step 4: Get alerts on your phone (ntfy)

1. When the bot starts, it prints a line like
   `Phone alerts (ntfy): on - in the ntfy app, subscribe to topic:  memecoin-bot-Xy7...`
2. In the **ntfy** app, tap **+**, type that topic name exactly, and tap **Subscribe**.
3. You'll get "Memecoin bot is running". Tapping an alert opens the coin (in Padre if you set
   `PADRE_URL_TEMPLATE`), and the contract address is at the bottom of each alert.

The topic name works like a password: anyone who knows it can read your alerts. Don't share it.
It is saved in `data/ntfy-topic.txt`. Delete that file to get a new one.

### Step 5: Keep it running when you close the window

```bash
sudo npm install -g pm2
pm2 start npm --name pump-scout -- start
pm2 save && pm2 startup     # restarts automatically if the server reboots
pm2 logs pump-scout         # see what it's doing
```

### Dashboard

Open `http://YOUR-SERVER-IP:8080` (or your Railway link) in your browser or phone.
**Set `DASHBOARD_PASSWORD`** first, so nobody else can see it. You log in once, and it remembers
you for a year on that device.

**Install it as an app** to get its own icon, full screen, and no browser bar:
- **iPhone:** open the link in **Safari** → tap **Share** → **Add to Home Screen** → **Add**.
- **Android:** open the link in **Chrome** → tap **⋮** → **Install app** (or **Add to Home screen**).
- **Computer (Chrome/Edge):** click the install icon at the right of the address bar.

The app shows live data from your bot. The bot itself keeps running on the server, so alerts
still arrive through ntfy when the app is closed.

### Padre button in alerts (optional)

Open any coin in Padre and copy the page URL. In `.env`, set `PADRE_URL_TEMPLATE` to that URL
with the contract address replaced by `{mint}`. Alerts will then have a one-tap Padre link.

---

## Telegram (optional)

Prefer Telegram, or want both? Set `TELEGRAM_BOT_TOKEN` (from @BotFather) and send `/chatid` to your
bot to get `TELEGRAM_CHAT_ID`. Telegram also gives you commands: `/top`, `/check <CA>`, `/stats`,
`/themes`, `/pause`, `/resume`.

## Tuning (in `.env`)

| Setting | Default | Meaning |
|---|---|---|
| `ALERT_MIN_SCORE` | 65 | Only alert at or above this score. Raise it for fewer, better alerts. |
| `FRESH_MIN_BUYERS` | 15 | Buyers needed before the FRESH check |
| `MID_PROGRESS_PCT` | 35 | Curve % for the MID-CURVE check |
| `MAX_BUNDLE_PCT` | 15 | Bundles or linked wallets above this % = AVOID |
| `MAX_DEV_PCT` | 8 | Dev holding above this % = AVOID |
| `MAX_TOP10_PCT` | 35 | Top-10 holders above this % = AVOID |
| `SMART_WALLETS` | | Comma-separated wallets you follow. Their buys boost momentum. |

## Good to know

- It only knows coins **launched while it's running**. After a restart, it starts fresh.
- Data comes from PumpPortal's free websocket (`pumpportal.fun`). Use one bot per IP.
- With the Helius free tier, scoring can slow down during very busy periods. A paid plan or a
  lower `HELIUS_CONCURRENCY` helps.
- Run the tests with `npm test`.

## Files

```
src/feed.js       live PumpPortal feed + demo simulator
src/coin.js       per-coin state (holders, trades, curve progress)
src/chain.js      Helius: block slots, wallet funding, wallet age
src/safety.js     bundle / linked-wallet / dev / holder checks
src/momentum.js   flow metrics
src/narrative.js  metadata, trending meta, AI + rule narrative score
src/engine.js     when to score, alerts, follow-up warnings
src/confidence.js confidence meter
src/xwatch.js     X watcher: viral/meme-able posts, matching coins to posts
src/notify.js     phone alerts (ntfy) + optional Telegram (src/telegram.js)
src/server.js     dashboard server; public/index.html is the page
src/store.js      SQLite history (dev launches, socials, alert outcomes)
```

*Not financial advice. Meme coins are extremely risky. Only trade what you can afford to lose.*
