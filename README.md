# pump-scout

A **read-only** Pump.fun scout. It watches every new coin, scores the ones that get traction, and
sends the best to your **Telegram** and a **live dashboard**. Then you paste the contract
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
| **Telegram bot token** | Sending you alerts | In Telegram, message **@BotFather**, send `/newbot`, pick a name, and it gives you a token | Free |
| **Helius API key** | Bundle and funding-wallet tracing | Sign up at **dashboard.helius.dev** and copy the API key | Free tier is fine to start |
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

### Step 4: Connect Telegram

1. Open your new bot in Telegram and send `/chatid`.
2. It replies with a number. Put it in `.env` as `TELEGRAM_CHAT_ID=...`.
3. Restart (`Ctrl+C`, then `npm start`). You'll get "pump-scout is running".

### Step 5: Keep it running when you close the window

```bash
sudo npm install -g pm2
pm2 start npm --name pump-scout -- start
pm2 save && pm2 startup     # restarts automatically if the server reboots
pm2 logs pump-scout         # see what it's doing
```

### Dashboard

Open `http://YOUR-SERVER-IP:8080` in your browser or phone.
**Set `DASHBOARD_PASSWORD` in `.env`** first, so nobody else can see it.

### Padre button in alerts (optional)

Open any coin in Padre and copy the page URL. In `.env`, set `PADRE_URL_TEMPLATE` to that URL
with the contract address replaced by `{mint}`. Alerts will then have a one-tap Padre link.

---

## Telegram commands

| Command | |
|---|---|
| `/top` | Best coins right now |
| `/check <CA>` | Full scorecard for a coin the bot is tracking |
| `/stats` | How past alerts performed (hit 1.5x / 2x, graduated) |
| `/themes` | Narratives running right now |
| `/pause` / `/resume` | Stop or start alerts |

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
src/telegram.js   alerts + commands
src/server.js     dashboard server; public/index.html is the page
src/store.js      SQLite history (dev launches, socials, alert outcomes)
```

*Not financial advice. Meme coins are extremely risky. Only trade what you can afford to lose.*
