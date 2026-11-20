# Early Pump Signals and Manipulation Tactics on Solana / Pump.fun

Method note (read first): This session could not open arxiv.org, substack, docs.mobula.io or other primary pages, because WebFetch failed DNS for those hosts. Every finding below comes from search-result snippets and the summaries the search tool produced, not from full-text reading. The numbers are as reported in those snippets. Before hard-coding any threshold into a bot, re-check it against the primary PDF or page. Evidence grades: **[EVIDENCE]** = peer-reviewed or preprint study, or an on-chain investigation with a stated method; **[VENDOR]** = tool docs or a vendor/third-party guide; **[FOLKLORE]** = a trader rule of thumb with no backtest behind it.

## 1. Early positive signals: what predicts graduation or pumps, and the thresholds people use

### Takeaway
Base rates are tiny, from about 0.2% to 1.7% graduation depending on sample and window, so any feature must be judged on precision lift over that base rate. The best-supported positive early features are net buy pressure and capital efficiency in the first minutes or first ~100 blocks, early participation by previously profitable traders (weak and inconsistent), off-chain social presence (a Telegram link), and the deployer's reputation. Raw transaction counts and holder counts are weak and easy to game. Bot-dominated early flow predicts *lower* graduation.

### Cited Findings
**Base rates (dated; they vary a lot by method)**
- Bitquery followed 11.5M new Solana tokens over 11 months (about 78% from Pump.fun). It found 1 in 58 Pump.fun coins graduate (about 1.7%), and 79% never trade after launch day. The survival table covers 8,984,141 Pump.fun tokens from 1 Nov 2025 to 7 Oct 2026 [EVIDENCE, vendor analytics] — [Bitquery](https://bitquery.io/investigations/solana-launchpad-year); [cryptonews.net summary](https://cryptonews.net/news/market/33623012/)
- Scorplabs: 11,877 graduations out of 693,331 launches in a June–July 2026 cohort (1.71%). Tokens that passed its dev-reputation filter graduated at **12.01%** (95% Wilson CI 10.0–14.4%), roughly a 7x lift. Not peer-reviewed. [VENDOR] — [Scorplabs](https://trader.scorplabs.online/blog/pump-fun-graduation-rate-dev-signal-12-percent)
- Kamat survival analysis of 832,941 launches: pooled graduation rate **0.198%**. Launches that advertise a Telegram channel graduate at **1.485% vs 0.166%** without one, about 9x. The paper is v3 with corrigenda, so expect revisions. [EVIDENCE, preprint] — [arXiv 2607.02823](https://arxiv.org/html/2607.02823v3); [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6915560)
- Pumpfundata, April 2026: 0.84% of about 763K launches graduated. **24% of graduates are bots**, and 62% graduate in under 10 minutes [VENDOR] — [pumpfundata](https://pumpfundata.com/blog/pumpfun-graduation-rate-analysis)
- Marino's academic study (655,770 tokens, Sept–Oct 2025): about 0.63% graduation [EVIDENCE, preprint] — [arXiv 2602.14860](https://arxiv.org/html/2602.14860v1)
- Pump.fun's graduation rate jumped after its July 2026 "BOOST" launch-incentive changes (regime shift: retrain models across it) — [The Block](https://www.theblock.co/news/defi/2026-07-29-pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives-409815)

**What predicts graduation**
- Marino (2602.14860): early participation by *ex-ante identified* top traders is associated with a higher graduation probability. Tokens dominated by bot-like transactions show *lower* graduation probability beyond intermediate vSol (virtual SOL / bonding-curve) levels. A secondary summary calls the predictive value of successful traders "modest and inconsistent", so it is unreliable as a standalone signal [EVIDENCE, preprint; snippets only] — [arXiv 2602.14860](https://arxiv.org/abs/2602.14860)
- A random-forest study on the first ~100 blocks found that **capital efficiency and net buy pressure** mattered more than transaction counts [practitioner] — [Medium, alleg88](https://medium.com/@alleg88/predicting-pump-fun-token-graduation-with-random-forest-on-extremely-imbalanced-data-9ef8da928390). A Kaggle competition sets the same first-100-blocks task — [Kaggle](https://www.kaggle.com/competitions/solana-skill-sprint-memcoin-graduation)
- An XGBoost capstone on first-30-minute microstructure features is precision-first on a 1.82% base rate [practitioner] — [GitHub](https://github.com/tomdelcarlo-lgtm/pumpfun-graduation-prediction)
- Caution: an audit of collector-generated graduation labels found a model that looked strong in-window but did not generalize. Its feature signs flipped with the setup, which suggests it memorized short-window conditions [EVIDENCE, preprint] — [gist.science summary of 2607.02823](https://gist.science/paper/2607.02823)
- Kamat "Coordinated Sniper Cohorts" (1.58M buyer observations, 166,098 launches, June 2026): the naive lift in first-hour buyer flow from cohort presence is mostly arithmetic contamination, because cohort wallets buy into the very outcome being measured. It shrinks substantially once cohort wallets are excluded and propensity-matched on launch quality. Implication: "lots of early buyers" is partly self-fulfilling and not causal [EVIDENCE, preprint] — [IDEAS/RePEc](https://ideas.repec.org/p/arx/papers/2607.02795.html); [arXiv](https://arxiv.org/abs/2607.02795)

**Smart-money definitions**
- Nansen: labels are based on on-chain PnL, ROI and win rate, plus off-chain data. "Smart DEX Trader (All Time)" requires at least **$1.5M cumulative realized profit**, set at the time to be the top 0.1% of wallets. There are 30D/90D/180D/All-time tiers, and short tiers need higher win rates and lower profit floors [VENDOR, primary] — [Nansen methodology](https://nansen.ai/post/what-is-smart-money-in-crypto-a-detailed-look-into-our-methodology); [Nansen Academy](https://academy.nansen.ai/articles/2132837-smart-money-101). Labels are awarded retroactively, so survivorship and look-ahead bias apply — [Altcoin Gem Finder](https://altcoingemfinder.com/blog/nansen-smart-money-explained-a-clear-guide-for-crypto-trader-1/)
- GMGN: "smart_degen" means wallets with a proven profitable record, tagged by GMGN's algorithm (cutoffs not published). Other tags include sniper, bundler, rat_trader (insider/sneak trading), and KOL. GMGN's skill exposes a `rug_ratio` from 0 to 1, with **>0.3 = high risk** [VENDOR] — [GMGN skill (clawhub)](https://clawhub.ai/gmgnai/gmgn-token); [GMGN skills docs](https://docsearch.algolia.com/mcp/docs/repo/gmgnai/gmgn-skills)
- Guide rule: require **at least 2–3 smart-money wallets**, because a single one buying is not a strong signal [FOLKLORE/VENDOR guide] — [DEXTools GMGN tutorial](https://www.dextools.io/tutorials/how-to-use-gmgn-smart-money-analytics-tutorial-2026)
- KOL wallets: Arkham added a KOL label in March 2025 that tracks wallets of influencers with more than 100K X followers — [BeInCrypto](https://beincrypto.com/arkham-tracking-crypto-influencers-meme-coins/)

**DexScreener signals**
- The trending score mixes volume, liquidity, transactions, unique makers, holders, page visits, reactions, and trust signals (verified info / Enhanced Token Info). A Boost is a paid multiplier lasting 12–24h, and 500 active boosts unlocks a gold ticker. Boosts don't add volume or traders. Enhanced Token Info ("Dex paid") costs about $299 (one source cites a $99 discount) [VENDOR, secondhand] — [OpenLiquid](https://openliquid.io/blog/dexscreener-boost-feature-explained/); [ListDesk](https://medium.com/@listdesk/how-much-do-dexscreener-ads-cost-what-each-option-really-buys-cc4325d964bc); [ListDesk – Dex paid](https://medium.com/@listdesk/what-does-dex-paid-mean-how-to-check-it-yourself-and-what-it-does-not-tell-you-c941aab511ce)

### Inferences
- Suggested positive features: net SOL inflow and buy/sell value ratio in the first N blocks or minutes; SOL raised per unique *non-cohort* buyer; curve progress velocity measured with bot and cohort wallets excluded; presence of a Telegram/X link; deployer historical graduation rate; count (≥2–3) of independently tagged profitable wallets that are *not* clustered with the dev.
- Use graduation lift over the base rate, and evaluate per regime (pre/post the BOOST change in July 2026), because base rates and feature signs drift.
- "Dex paid" and boosts show the team spent about $300+. That is a weak commitment signal, and ruggers can pay it too. Treat it as a minor feature.

### Gaps
- I found no published thresholds for unique buyers per minute, holder growth rate, volume/MC ratio, or post-migration liquidity depth that are backed by a backtest. Any such numbers circulating are folklore.
- Cielo's "smart wallet" definition and Photon/BullX/Padre/Trojan metric docs were not retrieved.
- Full Marino results (effect sizes, AUC) could not be read because arXiv was blocked.

## 2. Terminal safety/quality metrics and the "safe" thresholds people use

### Takeaway
Axiom Pulse and GMGN expose the same family of filters: Top-10 %, Dev holding %, Snipers %, Insiders %, Bundle %, holders, liquidity, Dex paid, and dev sold. No terminal publishes an official "safe" cutoff. The commonly repeated thresholds come from third-party guides: Top-10 below 30% (ideal) / above 50% (red), dev below 5–10%, snipers below 10% with a red flag above 20%, and 10+ bundler wallets as a red flag.

### Cited Findings
- Axiom Pulse has about 14 filters, including Top 10 Holders %, Dev Holding %, Snipers %, Insiders % (private sales and team), Bundle % (supply in bundle wallets), Holders, Liquidity, Volume, MC, and tx counts [VENDOR, official] — [Axiom docs – Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse)
- Third-party Axiom presets: one guide suggests a **Top-10 cap of 40%** and **dev and sniper caps of 10%**; another suggests a **dev ceiling of 5%** [FOLKLORE] — [Meme Coin Navigator](https://memecoinnavigator.com/best-axiom-trade-filters-for-new-pairs/); [Axiompedia presets](https://axiompedia.com/guides/trading/axiom-pulse-filter-presets); [CopyTradeHQ](https://copytradehq.com/axiom-filters)
- Mobula's healthy range is Top-10 **below 30%** excluding LPs, with green below 25% and yellow above 50%. Red flags are snipers holding **more than 20% combined**, and **50%+ sniper supply** means a coordinated dump is highly likely; bundler networks of **10+ wallets** are also a red flag [VENDOR guide] — [Mobula almanac](https://docs.mobula.io/almanac/detecting-snipers-bundlers)
- GMGN's scoring card flags top-10 above 50%. DEXTools says that above 50% held by the top 10 is high risk [VENDOR] — [GMGN skill](https://clawhub.ai/gmgnai/gmgn-token); [DEXTools](https://www.dextools.io/tutorials/how-to-use-gmgn-smart-money-analytics-tutorial-2026)
- MemeTrans found that tracing bundles raises high-risk tokens' *true* top-10 % by about **24% on average** over the surface figure. Coordinated (bundled) accounts held an average of **36.5% of supply** [EVIDENCE, preprint] — [MemeTrans arXiv 2602.13480](https://arxiv.org/html/2602.13480v1)

### Inferences
- Surface top-10 % understates concentration. Compute an entity-clustered top-10 (cluster by funding source and same-block buys) and apply thresholds to that figure.
- Reasonable starting hard filters (folklore-derived; tune them on your own data): clustered top-10 below 30%, dev below 5%, snipers below 10–20%, bundle below 10–15%, insiders low, rug_ratio below 0.3.

### Gaps
- No official definitions or thresholds were retrieved for GMGN "fresh wallets %", "phishing", "rat traders", or Photon/BullX/Padre/Trojan metrics. No study tests these thresholds out of sample.

## 3. Manipulation tactics, detection, and prevalence

### Takeaway
Manipulation is the norm, not the exception. Solidus flags about 98.7% of Pump.fun tokens as pump-and-dump or rug. Bitquery finds devs bundle block-0 buys on 21% of launches and another wallet buys in block 0 on 38%. About 83% of high-return meme coins show artificial growth (Mongardini et al.). Wash and bot volume can be 60–80% of volume on some tokens. Detection rests on wallet clustering (shared funders, same-block buys), wash-trade signatures, and deployer history.

### Cited Findings
**Prevalence**
- Solidus Labs 2025 Rug Pull Report (Jan 2024–Mar 2025): about **98.7%** of Pump.fun tokens and about **93%** of Raydium pools (361K) show pump-and-dump or soft-rug traits. Of about 7M Pump.fun tokens, only about **97K (<1.4%)** kept at least $1,000 liquidity. Pump.fun disputed the report [EVIDENCE, vendor] — [Solidus Labs](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance); [CoinDesk](https://hotfix.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says)
- Chainalysis (2024 data, multi-chain): about **3.59–4.52%** of tokens launched show pump-and-dump patterns (the definitions are much stricter than Solidus's). ERC20/BEP20 wash trading is up to $2.57B [EVIDENCE, vendor] — [crypto.news](https://crypto.news/chainalysis-over-4-5-of-all-tokens-launched-in-2024-have-pump-and-dump-traits/); [Benzinga](https://benzinga.com/content/43347725/chainalysis-report-market-manipulation-impacts-billions-in-crypto-trading-volume). *Conflict with Solidus is definitional; do not compare directly.*
- Mongardini et al., "A Midsummer Meme's Dream" (USENIX Security 2026; 34,988 tokens on ETH/BSC/Solana/Base): **82.8%** of high-return meme coins show artificial growth. **62.9%** of P&D/rug tokens had prior wash trading or liquidity-pool inflation (LPI). LPI means trades under $100 producing more than 500% price jumps in thin pools, usually by 1–2 wallets. Wash trading is typically done by about 3 actors per token [EVIDENCE, peer-reviewed] — [USENIX](https://www.usenix.org/conference/usenixsecurity26/presentation/mongardini); [arXiv 2507.01963](https://arxiv.org/html/2507.01963v2)
- MemeTrans (41,470 migrated Pump.fun tokens, 218.5M tx, 122 features in 5 groups): labels **84.13%** of launches high-risk. Its models cut financial loss by **56.1%** by the authors' own measure [EVIDENCE, preprint] — [arXiv 2602.13480](https://arxiv.org/html/2602.13480v1)
- "Catching the Rug" (6.4M Solana memecoins over 7 months): most show rug traits **within one hour**. XGBoost on the **first 5 minutes** (liquidity, volatility, wallet-level wash-trading features) performs best. A reviewer flags possible leakage [EVIDENCE, preprint] — [arXiv 2608.20271](https://arxiv.org/abs/2608.20271); [Pith review](https://pith.science/paper/2608.20271)

**Bundled launches / block-0 / snipers**
- Bitquery: on **21%** of new Pump.fun coins, the dev's own wallets bought in block 0 inside the launch bundle. On **38%**, a non-dev wallet bought in block 0. Bundled dev operations made **at least $579M** after fees through end of June 2026, against about $31.5M for independent snipers. This is a floor, because transfer-funded wallets are excluded. Validated against the Jito bundle record on 6 days [EVIDENCE, vendor] — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Pine Analytics (Apr 2025): deployer-funded sniper wallets that buy in the launch block and sell quickly appear on about **1.75%** of Pump.fun launches [EVIDENCE, analytics; snippet only] — [Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines)
- Kamat: **1,012 persistent wallet rings**. A top cohort of 9 wallets repeatedly appears among first buyers. **7.0% (382 of 5,419)** of cohort-touched launches had *zero* non-cohort buyers in the first 30 minutes [EVIDENCE, preprint] — [arXiv 2607.02795](https://arxiv.org/abs/2607.02795)
- Open-source and commercial bundlers advertise "create + up to 25 bundled buys in block 0", marketed as "sniper protection" — [GitHub cicere/pumpfun-bundler](https://github.com/cicere/pumpfun-bundler); [SolBundler](https://solbundler.app/)

**Case studies (high-profile bundling/sniping)**
- LIBRA (Feb 2025): Bubblemaps traced one cluster that drained about **$87M in an hour** using one-sided Meteora liquidity (adding LIBRA only, removing USDC/SOL). The same playbook was linked to MELANIA: heavy bundling at deploy, multiple wallets sniping the first block, a run to tens of millions in MC, then a rug. Hayden Davis admitted the team sniped the launch. Bubblemaps estimated about $6M in sniping profit — [Bubblemaps](https://blog.bubblemaps.io/the-libra-playbook-how-one-cluster-drained-87-million-in-a-single-hour/); [The Block](https://www.theblock.co/post/341251/libra-memecoin-facilitator-hayden-davis-admits-team-sniped-token-at-launch); [The Block – MELANIA link](https://www.theblock.co/post/341238/bubblemaps-links-single-entity-to-libra-and-melania-memecoins)
- YZY (Aug 2025): **14 wallets** tied to Davis bought one minute after launch for about $12M profit. Bubblemaps says it cannot confirm insider info — [The Block](https://www.theblock.co/post/368164/libra-token-facilitator-earns-12-million-sniping-kanye-west-memecoin-bubblemaps)

**Wash trading and volume bots**
- A Dune-based analysis estimates bots generate **60–80% of volume** on some Pump.fun tokens. Fake volume triggers real FOMO, then bots exit into it [analytics, secondary] — [BeInCrypto](https://beincrypto.com/trading-bots-pump-fun-solana-meme-coins/)
- Flip Research (2024): Raydium pools with about $3 of liquidity showed more than $5M in 24h volume — [Cointelegraph](https://cointelegraph.com/news/bots-pushing-solana-over-ethereum-research)
- Volume-bot vendors openly advertise hundreds of aged wallets plus randomized size and timing, built to beat bot detection and to push trending on Pump.fun and DexScreener [VENDOR marketing] — [openPR](https://www.openpr.com/news/4169480/this-powerful-volume-bot-is-helping-solana-memecoins-trend)

**KOL paid calls**
- ZachXBT (Sep 2025) leaked a price sheet covering 200+ influencers. Fewer than 5 of the 160+ who took deals disclosed them. The sponsor was Memenetic — [AVOID.NET summary](https://avoid.net/undisclosed-kol-paid-promotion-network-2025)
- Bubblemaps documented the pattern of a KOL buying from side wallets, then buying from the public wallet, then posting. One cluster earned about $6M on TRUMP — [Bubblemaps](https://blog.bubblemaps.io/bubblemaps-investigates-crypto-kol-moves-onchain/)

**Serial ruggers**
- Serial deployers repeat identical distribution and LP patterns. Typical flow: CEX → deployer wallets → token → LP drain → central wallet [practitioner, unverified method] — [Medium](https://medium.com/@abubakarabdulfattah120/serial-rug-deployers-on-pump-fun-a-deep-dive-into-solanas-meme-coin-laundromat-a57ddda190cc). The 12% vs 1.7% dev-reputation lift above shows deployer history is a strong feature in both directions — [Scorplabs](https://trader.scorplabs.online/blog/pump-fun-graduation-rate-dev-signal-12-percent)

### Inferences
- Red-flag features to build: dev wallet in the block-0 bundle; count of block-0/1 buyers sharing a funding source with the dev (look back several hops, because transfer-funded wallets evade simple checks); entity-clustered supply %; zero or near-zero non-cohort buyers in the first 30 minutes; known sniper-ring wallet IDs (Kamat's catalogue is CC-BY); repeated round-trip trades by about 3 wallets; tiny-trade-to-big-price-move ratio (LPI); volume/liquidity far above normal; deployer's prior tokens rugged or never graduated; a KOL side wallet buying before the public call.
- Expect adversarial adaptation. Aged wallets and randomized timing defeat naive fresh-wallet and timing checks, so prefer funding-graph features.

### Gaps
- No quantitative study was found on CTO scams, recycled or fake X accounts, dust-airdrop holder inflation, or paid "call channels" on Telegram.
- Freeze/mint authority is largely moot for standard Pump.fun tokens; I did not verify current program behavior.
- Predictive precision of individual red flags (rather than full ML models) is mostly unpublished. Most model results are self-reported preprints with leakage concerns.
