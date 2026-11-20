# Trading Rules and Risk Management for Solana Meme Coins (pump.fun era, 2024-2026)

Method note: research was done with web search only. Full-page fetches failed because arxiv.org, bitquery.io, coingecko.com, cryptoslate.com and coinstats.app are outside this session's network allowlist, so figures below come from search-result extracts of those pages and of the secondary coverage. Treat exact numbers as "as reported" and re-check the primary page before hard-coding anything. Most "rules" in the trading literature are blog/vendor folklore; the evidence base is mostly base rates (graduation, survival, trader PnL) and execution-cost studies, not tested strategies.

## Entry timing: launch vs early curve vs mid-curve vs near graduation vs post-migration

### Takeaway
The base rate is brutal at every stage before graduation: roughly 1-2% of pump.fun tokens ever graduate (lower in weak months), and about 79% never trade after launch day. Graduation probability rises as SOL accumulates in the curve, so a later curve entry buys a much higher probability of graduation for a smaller multiple. No published source measures risk/reward by curve-percentage bucket (e.g., 30-70%); that has to be backtested.

### Cited Findings
- Fewer than 2% of all pump.fun tokens have ever graduated from the bonding curve to a DEX (lifetime figure) — [The Block](https://www.theblock.co/post/343742/pump-fun-rapid-decline-graduating-tokens-memecoin-frenzy-fizzles-out); same "<2%" in the academic study of Solana memecoins — [arXiv 2512.11850](https://arxiv.org/abs/2512.11850)
- Bitquery (about 11.5M new Solana tokens over 11 months, 78% from pump.fun): about 1 in 58 pump.fun tokens (~1.7%) had graduated by 7 Oct 2026; 79% of 8,984,141 pump.fun tokens had no trades after launch day; only 1.5% traded at all in week 5 and 0.2% had 10 or more trades in week 5 — [Bitquery](https://bitquery.io/investigations/solana-launchpad-year); [Cryptonews coverage](https://cryptonews.net/news/market/33623012/)
- Graduation rates vary a lot by period: about 0.7-0.92% in summer 2025; about 0.63% for September 2025 launches; above 1% on some days in January 2026; a reported low of 0.26% in 2026; and a jump to 6.7% in the week after the BOOST mechanism launched (July 2026), about 8x the June average — [The Block, BOOST](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives); [DEXTools](https://www.dextools.io/news/pump-fun-graduation-collapse-solana-fees-2026); [Coinpaprika](https://coinpaprika.com/education/token-graduation-mean-numbers/)
- Graduation threshold: about 85 SOL collected (about $69k valuation in older docs; others cite up to about $100k) — [Coinpaprika](https://coinpaprika.com/education/token-graduation-mean-numbers/); [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex)
- Tarantelli, Marino, Naviglio and Lillo model graduation probability conditional on the SOL currently locked in the curve plus structural and behavioral variables; conditioning improves prediction significantly — [SSRN / arXiv 2602.14860](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6543715). Secondary summaries (not verified against the full text) say: (a) historically successful traders' participation had only modest, inconsistent predictive value; (b) bot-like activity correlated with LOWER graduation probability past intermediate curve stages; (c) creators have structural incentives to sell before graduation — [search summary of arXiv 2602.14860](https://www.arxiv.org/pdf/2602.14860)
- The paper also notes that a concentrated sell wave can cause abrupt drawdowns late in the bonding curve — [arXiv 2602.14860](https://arxiv.org/html/2602.14860v1)
- A student capstone on first-30-minute microstructure (1.82% base rate) found that graduated tokens consistently have more trades, more unique buyers and larger individual buys — [GitHub capstone](https://github.com/tomdelcarlo-lgtm/pumpfun-graduation-prediction/tree/main); a Medium random-forest model found capital efficiency and average swap size dominate (anecdotal, unreviewed) — [Medium](https://medium.com/@alleg88/predicting-pump-fun-token-graduation-with-random-forest-on-extremely-imbalanced-data-9ef8da928390)
- A survival-analysis preprint of 832,941 launches studies "graduation regime windows" and a social-presence effect (tokens with social links) — [arXiv 2607.02823](https://arxiv.org/html/2607.02823v3) (details not retrieved)
- Sniping at launch: deployer-funded sniping is about 1.75% of pump.fun launch activity — [Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines); first-block outside buying was 42% (vs 32% as blocks shortened) — [CryptoSlate on Bitquery](https://cryptoslate.com/solana-study-finds-rapid-pump-fun-buying-persisted-as-blocks-sped-up/); bots pile into about 1 in 4 new tokens at launch, and almost none of those graduate — [DEXTools, June 2026](https://www.dextools.io/news/pumpfun-new-token-bot-activity-data-june-2026)
- A study of 6,000 pump.fun projects found sniper bots (buys in the first 5 blocks) are widespread but have minimal observable effect on performance, while bump and comment bots are associated with better metrics — [arXiv 2601.08641](https://arxiv.org/pdf/2601.08641); [Ding, Luo, Xu, SSRN](https://papers.ssrn.com/abstract=5953738)

### Inferences
- A launch or very-early-curve entry is a lottery ticket with a graduation chance of about 1-2%. It only makes sense with tiny size and a fast time stop, and it competes with same-block bots a paper bot cannot match.
- Since graduation probability is conditional on curve progress, a paper bot's defaults should filter on curve % plus participation (unique buyers, trade count, buy size) and require low bot or bundle concentration. Mid-to-late curve (for example 50-85%) is a reasonable default to test, but no source gives return-by-bucket numbers. Log entries by curve bucket so the bot generates this evidence itself.
- Base rates are regime-dependent (0.26% to 6.7% in 2026 alone; BOOST changed migration mechanics). The bot should recompute base rates over a rolling window rather than hard-code them.

### Gaps
- No published risk/reward (expected return, hit rate) by entry stage (launch / 30-70% / near-graduation / post-migration dip) was found.
- Full text of arXiv 2602.14860 and 2607.02823 could not be fetched (network allowlist).

## Position sizing: % per trade, max open positions, daily loss limits, Kelly

### Takeaway
Practitioner guidance converges on risking about 1-5% of trading capital per memecoin, with sizing, not stops, as the main risk control. Kelly reasoning supports small sizes because win-rate and payoff estimates are extremely noisy for fat-tailed, mostly-zero distributions. Use at most 1/4 Kelly, or a fixed small budget.

### Cited Findings
- Common blog/vendor rules: never risk more than 2-5% of capital on one meme coin; some say no more than 1% per memecoin trade; "memecoin risk management is primarily about position sizing, not stop losses" — [Thrive](https://thrive.fi/blog/trading/memecoin-trading-strategy-risk-management-guide); [Medium guide](https://medium.com/@fxmbrand/the-ultimate-guide-to-memecoin-entry-and-exit-strategies-how-to-time-the-market-for-maximum-9bad76d015ed) (folklore, untested)
- Kelly: a zero-edge strategy has Kelly fraction 0; win rates below 40% need an unusually high reward/risk for Kelly to be useful; practitioners typically use 1/4 to 1/2 Kelly because edges decay and oversizing is asymmetrically costly — [LuxAlgo](https://www.luxalgo.com/library/concept/kelly-criterion/); [philippdubach](https://philippdubach.com/posts/bet-sizing-at-the-frontier/index.md)
- Small samples make win-rate estimates useless for Kelly: 14 trades gives a 95% CI of about [29%, 82%] — [askrubyai](https://askrubyai.github.io/blog/posts/2026-02-17-kelly-criterion)
- Memecoin returns show extreme volatility, positive skew, fat tails and medians near zero — [ResearchGate risk-return study](https://www.researchgate.net/publication/397380690_The_Risk-Return_Paradox_of_Meme_Coins_An_Empirical_Feasibility_Study)

### Inferences
- Kelly for a binary bet is f* = p - (1-p)/b. Example: with p = 0.15 wins at an average +3x net (b = 3) and losses of 100%, f* = 0.15 - 0.85/3 = -0.13, so do not trade. With p = 0.30 and b = 3, f* = 0.067, and 1/4 Kelly is about 1.7%. Real losses are not always -100% (stops), so use the full PnL distribution, but the point stands: unless a measured edge exists, size near 0.5-2%.
- Suggested paper-bot defaults (inferred, not sourced): 1% of equity per position (0.5% for launch snipes); at most 5-8 concurrent positions; a daily loss limit of about 5% of equity triggering a pause; and a cooldown after 3 consecutive losses (anti-tilt). Recompute Kelly only after at least 200 closed trades per strategy.

### Gaps
- No sourced figures for max open positions or daily loss limits specific to memecoin traders; no published Kelly analysis of actual pump.fun trade distributions.

## Take-profit ladders, moonbags, stop-losses, trailing and time stops

### Takeaway
"Take initials at 2x, ladder the rest, leave a 10-15% moonbag" is the dominant folklore. Stops in thin pools gap and suffer slippage, so practitioners use either wide stops (-40 to -50%) with small size or no hard stop. No backtest evidence was found that any specific ladder is optimal.

### Cited Findings
- Take-profit folklore: sell enough at 2x to recover the initial stake ("risk-free"); alternatives are selling half at 2x, taking 30-50% off at 5x and holding a small moonbag at 10x+; an autosell template is 25% at 2x, 50% at 5x, plus a 20% trailing stop on the remainder — [AirdropAlert](https://airdropalert.com/blogs/take-profit-strategy-meme-coins/); [Odin autosell guide](https://odin.tools/blog/pump-fun-autosell-take-profit-stop-loss-2026); [Medium](https://medium.com/@fxmbrand/the-ultimate-guide-to-memecoin-entry-and-exit-strategies-how-to-time-the-market-for-maximum-9bad76d015ed)
- Moonbag sizes suggested: 10% or 15% runners — same sources
- Stops: one guide says stops are unreliable on thin meme coins because price gaps through them; another suggests -40% to -50% with smaller size; move the stop to breakeven at 2x — [Thrive](https://thrive.fi/blog/trading/memecoin-trading-strategy-risk-management-guide); [Odin](https://odin.tools/blog/pump-fun-autosell-take-profit-stop-loss-2026)
- Time-stop evidence (indirect): 79% of tokens never trade after launch day; only 1.5% trade in week 5 — [Bitquery](https://bitquery.io/investigations/solana-launchpad-year). After graduation, the share of coins with any trade in the last hour falls fast (54.7% at 0-6h post-grad in a 1,634-coin snapshot) — [Coinmonks/Medium](https://medium.com/coinmonks/what-happens-after-a-pump-fun-coin-graduates-we-tracked-1-634-of-them-61efab687f1b)

### Inferences
- A tight -20% stop on a fresh curve token will be hit by normal noise and the 1.25% + 1.25% fees plus slippage, so a "-20%" stop realizes more like -25 to -30%. Default to -35 to -50% hard stops, sized so that a stop-out costs about 0.5% of equity, and model fill at the stop price minus slippage (for example a further 3-10% on curve tokens).
- Time stops are well justified by activity decay: if not up at least 1.3-1.5x within 10-30 minutes on the curve (or no new highs in 60 minutes after migration), exit. These thresholds are inferred defaults to backtest.
- Ladder default to test: sell 50% at 2x (recover initial plus fees), 25% at 4-5x, trail the remaining 25% with a 25-35% trailing stop from the high, keeping 10% as an untrailed moonbag only for graduated tokens.

### Gaps
- No published backtest comparing ladder vs. all-out vs. trailing exits on pump.fun data.

## Graduation / migration behavior (PumpSwap)

### Takeaway
Since 20 March 2025, graduated tokens migrate instantly to PumpSwap (not Raydium). Price action around migration is described as volatile in both directions, and creators have an incentive to sell before graduation. BOOST (July 2026) adds automatic post-migration buys, but no rigorous first-hour drawdown statistics exist publicly.

### Cited Findings
- PumpSwap launched 20 March 2025 and became the default destination with no SOL migration fee — [The Block](https://www.theblock.co/post/347360/pump-fun-launches-dex-called-pumpswap-to-instantly-migrate-graduated-tokens)
- Graduation is volatile; price "often does both," surging then dumping or dumping then recovering. The pool is seeded at a fixed SOL:token ratio, which can leave a small gap between the last curve price and the first DEX price. A described strategy is to buy on the curve and sell into the post-graduation move, with the risk that the curve never fills — [MadeOnSol guide](https://madeonsol.com/blog/pump-fun-graduation-bonding-curve-explained) (vendor, anecdotal)
- BOOST routes about 20% of migration liquidity into automatic buys in the first about 5 minutes after graduation, then burns those tokens; skeptics say it may increase throughput without improving quality — [The Block](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives)
- In a snapshot of 1,634 graduated coins, 354 of 759 (46.6%) were below a low market-cap threshold (reported as "under $100", probably $100k; unclear) 24-48h after graduation — [Coinmonks/Medium](https://medium.com/coinmonks/what-happens-after-a-pump-fun-coin-graduates-we-tracked-1-634-of-them-61efab687f1b)
- An Apify dataset provides market cap at +5 min, +1h and +24h after graduation for about 3,384 tokens and could be used to compute drawdowns (unverified quality) — [Apify](https://apify.com/intenal_builds/pumpfun-graduated-tokens-dataset)

### Inferences
- Default rule: take partial profit (for example 50%) into the final 90-100% of the curve or within minutes of migration, especially in the BOOST window, rather than holding through. Treat "post-migration dip buys" as a separate strategy that requires sustained volume and holder growth after 30-60 minutes.

### Gaps
- No quantified distribution of price change from graduation to +5m/+1h/+24h was found.

## Execution realities: fees, priority fees, Jito tips, slippage, MEV

### Takeaway
On small trades, the round trip easily costs 3-6% or more before slippage: about 1.25% curve fee per side, about 1% terminal fee per side, plus fixed priority/tip costs that dominate tiny tickets. Sandwich attacks are concentrated on pump.fun curves and PumpSwap and exploit the 30-50% slippage settings memecoin traders use.

### Cited Findings
- Pump.fun curve fee: flat 1.25% on buys and sells (0.30% creator, 0.95% protocol) since 13 May 2025; PumpSwap fee tiers by market cap from 1.25% down to a 0.30% floor (launch-era flat 0.25% is superseded); 0.015 SOL graduation fee. Sources conflict (older 1% or 0.95% figures) — [Coinpaprika](https://coinpaprika.com/education/launchpad-fees/); [BloFin](https://blofin.com/academy/education/pumpfun/pump-fun-fees-explained); [Blockworks](https://blockworks.com/analytics/pumpfun/pump-bonding-curve)
- Terminal fees: GMGN and Photon about 1% per side; Axiom 1% base, about 0.75-0.95% net after cashback tiers. A $1,000 round trip costs about $19.90 in platform fees excluding priority and Jito. About 0.004 SOL of priority fee plus tip per round trip adds about 1.6% on a 0.25 SOL round trip. Axiom default priority 0.001 SOL; GMGN anti-MEV mode needs at least 0.002 SOL; Axiom has a "Secure" mode routed only via Jito-whitelisted validators — [web3wagmi](https://blog.web3wagmi.com/best-memecoin-trading-tools); [toekn compare](https://www.toekn.com/compare/axiom-vs-gmgn-vs-photon); [uwuu.ai](https://uwuu.ai/blog/axiom-trade-review) (third-party blogs; verify with platform docs)
- Solana trading apps took $422M in fees; Axiom got 48% — [Bitquery](https://bitquery.io/investigations/solana-jito-tips-trading-app-fees)
- Slippage is often set at 30-50% on hot tokens (reportedly per GMGN's recommendation) — [web3wagmi](https://blog.web3wagmi.com/best-memecoin-trading-tools)
- Sandwiching: Bitquery found 6,850,144 attacks by 2,545 bot wallets on 2,154,994 victim wallets (30 Oct 2025 to 7 Oct 2026); 96% were on the pump.fun curve or PumpSwap; about $29.7M extracted before costs — [CryptoSlate on Bitquery](https://cryptoslate.com/solana-sandwich-bots-took-29-7-million-before-costs-bitquery-estimates/). An IMC'26 paper counted 521,903 sandwiches costing users over $7.7M — [IMC'26 paper](https://cnitarot.github.io/papers/imc26_solana.pdf). Memecoin traders are especially exposed because of high slippage tolerance — [Helius MEV report](https://www.helius.dev/blog/solana-mev-report). Buys of new low-cap tokens are the most likely to be "wide-sandwiched" — [Ghost thread](https://threadreaderapp.com/scrolly/1978555200802885699)

### Inferences
- Paper-bot cost model default: per side = 1.25% venue fee + 1% terminal fee + fixed 0.001-0.003 SOL priority/tip + price impact from curve math + a slippage/MEV haircut (for example 1-3% on buys of new tokens). For a 0.1 SOL trade, fixed costs alone are about 2-4% per round trip, so total round trip is about 6-10%. A strategy has to clear this before any edge exists; a 2x target is really about 1.85x net.
- Use tight slippage (for example 5-15%) and MEV-protected routing in live trading. In paper mode, simulate fills at a worse price than quoted.

### Gaps
- No authoritative average "realized slippage" by trade size on pump.fun was found.

## Copy trading and following KOL / smart wallets

### Takeaway
The evidence is weak and mostly negative for naive copying. Most large "smart wallet" gains are not reproducible trading profit, KOL performance is non-stationary, copy latency erodes returns, and manipulative bots target copy traders.

### Cited Findings
- Bitquery (published 22 Oct 2026): 3,170 wallets with $100k+ gains (Oct 2025 to Aug 2026) totaling $752.5M; only $193.9M (26%) classed as genuine buy-then-sell trading profit. About 51% came from tokens transferred in from other addresses, 13% showed signs of coordination, and 10% were unclassified. Copy bots have no buy to mirror for transferred tokens. Bitquery did not measure copier returns — [CryptoSlate](https://cryptoslate.com/pump-funs-biggest-winners-may-be-impossible-to-copy-as-752-million-study-exposes-hidden-trading-gap/); [Cointribune](https://www.cointribune.com/en/pump-fun-why-displayed-gains-can-mislead-copy-traders)
- Academic: manipulative tactics are bot-driven and "prey on naive copy traders"; DEX execution lag diminishes copier returns; KOL performance is non-stationary (1,000 memecoins, 614,330 wallet-coin pairs) — [arXiv 2601.08641](https://arxiv.org/pdf/2601.08641); [EmergentMind summary](https://www.emergentmind.com/topics/memecoin-copy-trading)
- Historically successful traders gave only modest, inconsistent signal for graduation — [arXiv 2602.14860 (via summary)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6543715)
- Vendor data: 1.6M trades across 1,058 tracked wallets, median win rate 57.1%, and volume inversely correlated with win rate (vendor, unverified) — [MadeOnSol via CoinStats](https://coinstats.app/news/07f38ebd47e8d820af3eb96b00c42a84b9b856c602626e3e4a71afbbd79014d6_KOL-Wallet-Tracking-on-Solana-What-the-Data-Actually-Shows-After-16-Million-Trades/). Manual copying lags 30s to 5 min, "usually buying after the pump" — [uwuu.ai](https://uwuu.ai/blog/how-to-copy-kol-trades-solana). Pump.fun acquired the KOL tracker Kolscan (July 2025) — [public.com/The Block](https://public.com/crypto/pump/news/4)

### Inferences
- Treat smart-wallet buys as one weak feature, not a trigger. Exclude wallets with large inbound token transfers, funding links to deployers, or bot-like volume. Measure "copy slippage" (price at the source's buy vs. the bot's alert time) and drop wallets whose edge disappears after a realistic 2-10s delay.

### Gaps
- No independent study of actual copier PnL after latency was found.

## Psychology, common mistakes, and trader win rates

### Takeaway
Most pump.fun wallets lose or barely profit. Profitable-wallet share rarely exceeded 50% in any month and hit 30.1% in June 2025, and fewer than 0.01% made $1M+. Behavioral mistakes (FOMO, revenge trading, holding losers) are well described anecdotally but not quantified for this market.

### Cited Findings
- CoinGecko: monthly share of profitable pump.fun wallets rarely above 50% from April 2024 to late 2025, bottoming at 30.1% in June 2025 — [CoinGecko Research](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)
- Dune-based: more than 60% of addresses lost money (early 2025); 311 wallets made over $1M, under 0.01% of traders — [crypto.news](https://crypto.news/over-60-pump-fun-traders-saw-losses-less-than-0-01-made-over-1m/); [BeInCrypto](https://beincrypto.com/pump-fun-trading-data-majority-lose-money/). About 99.6% had not realized over $10k profit (realized only) — [Cointelegraph](https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data). March 2026: 50.6% lost money and 45.4% made under $500 — [crypto.news](https://crypto.news/pump-fun-data-shows-49-of-march-traders-in-the-red-as-platform-locks-fees/)
- Realistic sustained win rates: 40-60%; above 80% over 50+ trades is suspicious (guides, anecdotal) — [uwuu.ai](https://uwuu.ai/blog/how-to-copy-kol-trades-solana)
- Memecoins show short-term abnormal returns during social-media activity peaks — [ResearchGate](https://www.researchgate.net/publication/397380690_The_Risk-Return_Paradox_of_Meme_Coins_An_Empirical_Feasibility_Study); feedback trading driven by community attention — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0275531926003491)

### Inferences
- The bot's main value is enforcing discipline: pre-committed exits, cooldowns after losses, no averaging down, and daily loss caps. Alerts should show the base rate ("about 1.7% of curve tokens graduate") to counter FOMO.

### Gaps
- No quantified study of revenge trading or holding-loser behavior specific to Solana memecoins was found.

## Backtests / published strategy results

### Takeaway
No credible, published, cost-inclusive backtest of pump.fun sniping or momentum strategies was found. The only available evidence is classification and prediction work (graduation models) and base rates.

### Cited Findings
- Graduation-prediction models exist (academic and student), but they report predictive metrics, not trading PnL net of fees — [arXiv 2602.14860](https://arxiv.org/html/2602.14860v1); [GitHub capstone](https://github.com/tomdelcarlo-lgtm/pumpfun-graduation-prediction/tree/main)
- An open-source paper tracker tests "2x + moonbag on strong narrative" strategies (no results reported) — [GitHub andreolf/memecoin-paper-tracker](https://github.com/andreolf/memecoin-paper-tracker/pull/5)
- Sniper bots show minimal observable performance effect in a 6,000-project sample — [arXiv 2601.08641](https://arxiv.org/pdf/2601.08641)

### Inferences
- A paper-trading bot that logs every signal with entry stage, the full cost model, and MFE/MAE (max favorable/adverse excursion) would itself produce the missing evidence. Evaluate on net expectancy per trade and median vs. mean (because of skew), with at least 200 trades per variant.

### Gaps
- No peer-reviewed or audited backtest with transaction costs was found. Vendor "win rate" claims lack methodology.
