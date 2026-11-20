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
| `PAPER_SIZE_PCT` | 20 | % of the balance per trade (about $6 of a $30 budget) |
| `PAPER_MAX_OPEN` | 4 | Max positions at once |
| `PAPER_STOP_PCT` | 25 | Sell if down this much |
| `PAPER_TRAIL_START_PCT` / `PAPER_TRAIL_PCT` | 30 / 20 | After +30%, sell when it drops 20% from its best |
| `PAPER_MAX_HOLD_MIN` | 90 | Sell after this many minutes regardless |
| `PAPER_FEE_PCT`, `PAPER_TX_FEE_SOL`, `PAPER_SLIPPAGE_PCT` | 1.25, 0.0015, 3 | Costs. Set the tx fee to match your Padre priority fee. |
| `PAPER` | 1 | 0 turns paper trading off |

A −6% stop like some bots advertise would trigger almost immediately, because fees and slippage alone
cost about that much. That's why the default stop is wider.

**Real auto-trading is not built yet, on purpose.** It only makes sense after paper trading has been
profitable over a good number of trades. It also means giving the bot a wallet key, so it needs
extra safety work first.

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
