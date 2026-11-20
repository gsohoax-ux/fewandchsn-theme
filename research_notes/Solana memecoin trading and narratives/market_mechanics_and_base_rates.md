# Solana Meme Coin Market Mechanics (Pump.fun and after graduation) and Base Rates

Method note (2026-11-20): WebFetch could not reach any of the source hosts in this session (DNS blocked for arxiv.org, soliduslabs.com, bitquery.io, coingecko.com, solanacompass.com, koal.fun). Every finding below therefore comes from search-engine summaries of the linked pages, not full-text reads. Numbers have been cross-checked across several outlets where possible, but anyone setting production thresholds should re-verify the key figures against the primary pages. Reliability flags: [P] = primary or near-primary (official post, academic paper, on-chain analytics firm); [S] = reputable secondary press; [V] = vendor or marketing blog, low reliability.

## 1. How the Pump.fun bonding curve and fee system work today, and what changed in 2025-2026

### Takeaway
A Pump.fun token starts on a constant-product curve with virtual reserves of about 30 SOL and 1.073B tokens (1B total supply). It graduates once the curve's real tokens are sold, which takes roughly 85 SOL and corresponds to about $69k market cap; the dollar figure moves with the SOL price. Since 20 March 2025, graduated tokens go to Pump.fun's own DEX, PumpSwap, with no migration fee, instead of to Raydium. Bonding-curve trades now cost 1.25% (0.95% protocol, 0.30% creator). After graduation, creator fees are tiered by market cap.

### Cited Findings
**Curve mechanics**
- Official pump-public-docs, as summarized by DeepWiki, give the initial virtual token reserve as 1,073,000,000,000,000 base units (6 decimals, so 1.073B tokens) and a typical total supply of 1,000,000,000,000,000 base units (1B tokens). Market cap = virtual SOL reserves × total supply ÷ virtual token reserves. The curve is "complete" when real token reserves reach zero, so the trigger is on-chain state, not a fixed USD amount. [P] — [DeepWiki: pump bonding curve mechanism](https://deepwiki.com/pump-fun/pump-public-docs/3.1-pump-bonding-curve-mechanism)
- Initial virtual reserves are about 30 SOL and 1.073B tokens, giving a starting price of about 0.000000028 SOL per token. [V/S] — [madeonsol](https://madeonsol.com/blog/solana-bonding-curves-explained); [Bybit wiki](https://www.bybit.com/wiki/article/bonding-curves-on-solana-trading-guide)
- Graduation happens at about 85 SOL deposited into the curve, roughly $69k market cap. Bybit notes this is the "historically cited" figure and that its USD value depends on the SOL price. Some sources say $69,420, and one cites about $12k of liquidity at migration. [V/S] — [Bybit wiki](https://www.bybit.com/wiki/article/pump-fun-solana-meme-coin-launchpad-guide); [Decrypt](https://decrypt.co/249107/fewer-than-100-pump-fun-tokens-above-1m-market-cap-amid-meme-coin-lull)
- Token creation costs about 0.0072 SOL (as of Oct 2026), and Pump.fun sees more than 1M launches a month. [V] — [jumpbit, Oct 2026](https://jumpbit.io/en/resources/best/launchpads)

**PumpSwap (launched 20 March 2025)**
- PumpSwap went live on 20 March 2025. Graduated tokens migrate to it instantly instead of to Raydium, and the migration fee fell from 6 SOL to 0. PumpSwap charged 0.25% per trade at launch: 0.20% to LPs and 0.05% to the protocol. Pump.fun said creator revenue sharing would follow. [S] — [The Block, 2025-03-20](https://www.theblock.co/news/business/2025-03-20-pump-fun-launches-dex-called-pumpswap-to-instantly-migrate-graduated-tokens-347360); [Crypto Briefing](https://cryptobriefing.com/launch-pumpswap-dex-pump-fun)
- Context: Pump.fun's volume had fallen about 94% since the start of 2025. Raydium launched its own launchpad, LaunchLab, about a day after PumpSwap. [S] — [CryptoSlate](https://cryptoslate.com/pumpfun-launches-its-own-dex-called-pumpswap-amid-falling-revenue/); [The Block](https://www.theblock.co/post/347360)

**Creator fees and how they evolved**
- May 2025: PumpSwap began paying creators 0.05% of every transaction, half of PumpSwap's protocol revenue. [S] — [blocmates](https://www.blocmates.com/news-posts/pump-fun-s-dex-pumpswap-launches-0-05-creator-fee-on-transactions)
- September 2025, "Project Ascend" / Dynamic Fees V1: PumpSwap creator fees became tiered by market cap. They start at 0.95% for small caps and step down to 0.05% once market cap reaches about 98,240 SOL. Protocol and LP fees were unchanged. The tiers apply only to graduated tokens on PumpSwap. Creators were reportedly paid $2.4M in the first 24 hours. [S] — [FinanceFeeds](https://financefeeds.com/pump-fun-introduces-dynamic-creator-fees-to-strengthen-memecoin-ecosystem/); [SolanaFloor](https://solanafloor.com/news/pump-funs-new-creator-fee-model-pays-2m-24-hours); [CCN](https://www.ccn.com/news/crypto/pump-fun-token-project-ascend/)
- 2026 schedule, per third-party guides citing Pump.fun's fee page; I did not verify it directly. Bonding-curve trades cost 1.25%: 0.95% protocol, 0.30% creator, 0% LP. A 0.015 SOL fee is charged at graduation. The PumpSwap canonical-pool creator fee ranges from 0.95% down to 0.05% by market cap, and one guide gives the total PumpSwap fee as 1.25% falling to 0.30% at $20M+ market cap. Non-canonical pools pay creators nothing. Custom pairs (not SOL or USDC) pay a flat 0.05% after graduation. Since February 2026, creators can choose a "cashback" mode that sends their 0.3% to traders and holders. Pump.fun's own apps add a 0.45% platform fee (0.40% with a referral code). The guides disagree on when the schedule was last updated: 20 May 2026 or October 2026. [V] — [Blofin](https://blofin.com/en/academy/education/pumpfun/pump-fun-fees-explained); [froglabs](https://froglabs.io/blog/pump-fun-fees-explained); [smithii](https://smithii.io/en/pump-fun-creator-fees/); [soltokencreator](https://www.soltokencreator.io/blog/pump-fun-fees-explained)
- Late 2025 or 2026: Pump.fun added "Mayhem Mode", a graduation-related feature that Bitquery studied separately ("1 in 50 graduations fills the pool"). [P] — [Bitquery: Mayhem Mode](https://bitquery.io/investigations/pump-fun-mayhem-mode)
- Pump.fun also lets creators launch coins priced in tokenized stocks. [S] — [The Defiant](https://thedefiant.io/news/defi/pump-fun-lets-creators-launch-coins-priced-in-tokenized-stocks)

**Competing launchpads and market share**
- July 2025: LetsBONK.fun, built on Raydium LaunchLab, passed Pump.fun for the first time. Dune data showed 17,585 vs 9,783 launches in 24 hours, and 24h revenue of $1.04M vs $533k on 8 July 2025. Reported market share ranged from 54% to 58.5% for LetsBonk vs about 35% for Pump.fun. Pump.fun regained the daily-launch lead shortly afterwards (13,690 vs 13,392). [S] — [Unchained](https://unchainedcrypto.com/letsbonk-flips-pump-fun-in-daily-token-launches/); [Coinedition](https://coinedition.com/solana-launchpad-battle-pumpfun-letsbonk/); [stepdata](https://stepdata.substack.com/p/letsbonk-claims-82-of-bonding-curve)
- LetsBonk charges 1.25% on curve trades and graduates tokens to Raydium. [V] — [jumpbit](https://jumpbit.io/en/resources/best/launchpads)
- Bitquery, 1 Nov 2025 to 7 Oct 2026, covering about 11.5M Solana tokens with at least one confirmed trade: Pump.fun 78%, Meteora DBC 10%, Raydium LaunchLab (LetsBonk and others) 4%. Pump.fun's share peaked at 90% in August 2026. [P] — [Bitquery](https://bitquery.io/investigations/solana-launchpad-year)
- In the 30 days to 9 Nov 2026, Pump.fun accounted for 92% of meme launchpad launches across all chains and 84% of launchpad trading volume. [S] — [TokenPost](https://www.tokenpost.com/news/investing/54556)
- Smaller players include Believe (share estimates range from about 4.5% in 2025 to about 8.85%), Bags, Jupiter Studio and Moonshot. Their shares are poorly documented. [V] — [Bitget academy](https://web3.bitget.com/en/academy/letsbonk-fun-vs-pump-fun-which-solana-memecoin-launchpad-wins-in-2026); [graphdex](https://graphdex.io/en/blog/best-solana-launchpads-2026)
- Conflict: one Bitget article claims LetsBonk held 49.8% vs Pump.fun's 40.9% in "July 2026". Its numbers match the July 2025 data, so the date is probably a typo. [V] — [Bitget academy](https://web3.bitget.com/en/academy/letsbonk-fun-vs-pump-fun-which-solana-memecoin-launchpad-wins-in-2026)

### Inferences
- Because the graduation threshold is set in SOL, the graduation market cap in USD moves with SOL. A bot should track graduation progress as SOL in the curve or as the fraction of real tokens sold, not as a USD market cap.
- Round-trip friction on the curve is at least 2.5% before priority fees and Jito tips, and about 3.4% inside Pump.fun's own UI. After graduation, round-trip fees on a small-cap token can still be about 2%+ because creator fees are highest at low market cap. Small-edge strategies need to clear this.
- LetsBonk's challenge in mid-2025 faded. By late 2026 Pump.fun had near-monopoly share of launches again, so for a bot "Pump.fun + PumpSwap" covers most of the flow.

### Gaps
- I could not read Pump.fun's official fee page or docs directly. The exact current tier breakpoints and the precise SOL graduation threshold in 2026 should be checked in the docs or on-chain.
- I found no reliable 2026 share data for Believe, Moonshot or Bags.

## 2. Base rates: graduation, market-cap milestones, lifespan, launches per day

### Takeaway
Only about 0.2% to 1.7% of Pump.fun tokens ever graduate, depending on the period and the definition. Recent figures are at the low end: about 1 in 58 over Nov 2025 to Oct 2026, 0.26% in June 2026, and 0.198% graduating within 24 hours in one 2026 paper. Most tokens are dead within a day: 79% never trade after launch day. Reaching $1M is a roughly 1-in-10,000+ event. Launches run at about 10k to 70k per day depending on market regime.

### Cited Findings
**Graduation rate**
- Bitquery, Nov 2025 to Oct 2026: about 1 in 58 Pump.fun tokens (≈1.7%) had graduated by early October 2026. [P] — [Bitquery](https://bitquery.io/investigations/solana-launchpad-year)
- June 2026: only 0.26% of Pump.fun tokens graduated. [V] — [coinlaw / coincentral roundup](https://coinlaw.io/memecoin-statistics/)
- arXiv 2602.14860, "Predicting the success of new crypto-tokens: the Pump.fun case": 0.63% graduation rate across 655,770 tokens launched Sep to Oct 2025. [P] — [arXiv 2602.14860](https://arxiv.org/html/2602.14860v1)
- arXiv 2607.02823, survival analysis of 832,941 launches: pooled 24-hour graduation rate of 0.198%, about 3.18× lower than the Sep to Oct 2025 rate. Launches listing all three social links graduate at about 17× the rate of launches with none. [P, via summary] — [deeppaper summary](https://arxiv.deeppaper.ai/papers/2607.02823v1); [Brave New Coin](https://bravenewcoin.com/insights/what-auditing-832941-pump-fun-launches-taught-me-about-memecoin-success)
- arXiv 2609.10246, "Meme Coin Factories": graduation share of about 1.02% in its sample. It finds evidence that wash trading helps coins graduate. [P] — [arXiv 2609.10246](https://arxiv.org/html/2609.10246v1)
- arXiv 2512.11850 on Solana memecoins: graduation rates in Q4 2024 peaked below 2%. [P] — [arXiv 2512.11850](https://arxiv.org/pdf/2512.11850)
- Mid-2025: graduation rate around 0.7% to 0.8% in July and August 2025. A later "six-month high" reached about 0.92% to 1.15%. [S] — [Cryptopolitan](https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/); [Cryptopolitan](https://www.cryptopolitan.com/pump-fun-token-graduations-six-month-high/)
- Lifetime rate on Dune dashboards: about 1.4%. Another Dune-based estimate puts it under 2%. [S] — [TechFlow](https://www.techflowpost.com/en-US/article/19808); [The Block](https://www.theblock.co/post/375352/pump-fun-dominates-token-launches-1-million-daily-despite-market-slowdown)
- Full-year 2025: 0.89% across 11.6M tokens. [V, low reliability] — [Pegasus guide](https://pegasus.botdoctor.dev/guides/pump-fun-graduation-rate)
- One review notes that published estimates of a related fraction range from 0.198% to 5% across four studies, mostly because of differences in window and definition. [V] — [coinpaprika](https://coinpaprika.com/education/token-graduation-mean-numbers/)

**$100k / $1M milestones**
- Decrypt, Sept 2024: of millions of Pump.fun tokens, fewer than 100 (89) were above $1M market cap, about 0.3% of graduated coins. This is old data. [S] — [Decrypt](https://decrypt.co/249107/fewer-than-100-pump-fun-tokens-above-1m-market-cap-amid-meme-coin-lull)
- A Dune-based report counted 96 tokens that had ever reached $1M. A Chinese-language analysis estimated the chance of passing $1M at about 1 in 20,000. [S] — [ChainCatcher](https://www.chaincatcher.com/en/article/2139008)
- Solidus Labs (May 2025): only about 97,000 of about 7M Pump.fun tokens (≈1.4%) still held at least $1,000 of liquidity. [P] — [Solidus Labs](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance); [CoinDesk](https://hotfix.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says)

**Lifespan and survival**
- Bitquery, Nov 2025 to Oct 2026, 8,984,141 Pump.fun tokens: 79% recorded no trade after launch day. Only 1.5% recorded any trade in week 5, and 0.2% recorded at least 10 trades in week 5. [P] — [Bitquery](https://bitquery.io/investigations/solana-launchpad-year); [crypto.news](https://crypto.news/pump-fun-memecoin-trader-fatigue-token-survival/)
- Jumpbit: only 17.2% of September 2026 launches recorded a trade at least 24 hours later. This is consistent with Bitquery under a different definition. [V] — [crypto.news](https://crypto.news/pump-fun-memecoin-trader-fatigue-token-survival/)

**Launches per day**
- Record of 71,735 launches on 23 Jan 2025, per a Dune dashboard. The January 2025 average was above 50k/day, falling to about 30k/day in February and about 25k/day in March 2025. Launches fell about 80% from the peak. [S] — [The Block](https://www.theblock.co/news/web3/2025-02-27-pump-fun-rapid-decline-graduating-tokens-memecoin-frenzy-fizzles-out-343742); [CoinMarketCap](https://coinmarketcap.com/academy/article/pumpfun-sees-80percent-decline-in-token-launches-as-meme-coin-market-loses-momentum)
- July 2025: about 10k to 14k Pump.fun launches/day during the LetsBonk contest. [S] — [Coinedition](https://coinedition.com/solana-launchpad-battle-pumpfun-letsbonk/)
- 7 Jan 2026: nearly 30,000 launches in one day. Elsewhere: 42,000 launches in 24 hours (date unclear). Late 2026: more than 1M launches a month, about 33k/day. [S/V] — [coinlaw](https://coinlaw.io/memecoin-statistics/); [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex); [jumpbit](https://jumpbit.io/en/resources/best/launchpads)

### Inferences
- For planning, assume about 0.3% to 1.5% of new launches graduate, about 0.01% to 0.1% reach $1M, and about 80% are dead within 24 hours. A bot that buys new launches indiscriminately is betting against roughly 99:1 odds of graduation.
- Social links (X, Telegram, website) are a cheap, well-supported filter, with about 17× higher graduation odds. Correlation does not imply cause, though, and scammers can add these links too.

### Gaps
- I found no rigorous, dated statistic for the share of launches reaching $100k market cap.
- I found no clean monthly launch series for 2026. The Dune dashboards (for example dune.com/meme_trading/pumpfun-graduation) need to be queried directly.

## 3. Share of tokens that are rugs or pump-and-dumps

### Takeaway
Solidus Labs (May 2025) classified about 98.6% to 98.7% of roughly 7M Pump.fun tokens as rug pulls or pump-and-dumps, and about 93% of 388k Raydium pools as "soft rugs". These are heuristic, liquidity-based labels, not confirmed fraud. Academic work finds large-scale manipulation, such as wash trading and "coin factories".

### Cited Findings
- Solidus Labs, "2025 Rug Pull Report: Rug Pulls and Pump-and-Dumps on Solana" (May 2025): about 98.6% (98.7% on Solidus's own page) of Pump.fun tokens were flagged as rugs or pump-and-dumps. Only about 97k of about 7M kept at least $1,000 of liquidity. About 93% of 388,000 Raydium pools (≈361k) showed soft-rug characteristics. The median rug was about $2,832. The largest was $1.9M (MToken). One outlet's "$28,000 median" is probably a typo. [P] — [Solidus Labs](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance); [CoinDesk 2025-05-07](https://hotfix.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says); [The Defiant](https://thedefiant.io/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report)
- arXiv 2609.10246, "Meme Coin Factories: Uncovering Large-Scale Manipulations on pump.fun": documents manipulation at scale and finds wash trading may help coins graduate. [P] — [arXiv](https://arxiv.org/html/2609.10246v1)
- The bulk of dev-bundle profit goes to launch teams (see Section 5). [P] — [Bitquery snipers/bundles](https://bitquery.io/investigations/pump-fun-snipers-bundles)

### Inferences
- Since about 98% of tokens look like rugs or pump-and-dumps by liquidity outcome, the useful question for a bot is not "is this a scam?" but whether it can enter and exit profitably before the dump. Holding duration and exit discipline matter more than due diligence on fundamentals.

### Gaps
- I could not read Solidus's exact classification rules. Its liquidity thresholds and time windows should be checked in the primary PDF.

## 4. What fraction of traders profit

### Takeaway
In the January 2025 Dune snapshot, only about 0.4% of 13.55M Pump.fun wallets had realized more than $10k profit, and about 293 had realized more than $1M. More than 60% of traders were losing money in mid-2025. Newer data suggests that around the median, more wallets are slightly profitable, but large wins are still very rare.

### Cited Findings
- January 2025, Dune (analyst Adam Tehc): 55,296 of 13.55M wallets (≈0.41%) had realized more than $10k. About 0.048% had realized more than $100k, and 0.00217% (≈293 wallets) more than $1M. About 30% of wallets made a single transaction, likely bots. Pump.fun co-founder Alon disputed the methodology. [S] — [Decrypt](https://decrypt.co/300403/pump-fun-traders-millionaires); [Cointelegraph](https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data)
- Only about 3% of Pump.fun traders had made more than $1,000 (2024 Dune analysis). [S] — [The Defiant](https://thedefiant.io/just-3-of-pump-fun-traders-have-made-over-usd1000)
- July 2025, before the PUMP token launch: more than 60% of traders had losses, and fewer than 0.01% had made more than $1M. [S] — [crypto.news](https://crypto.news/over-60-pump-fun-traders-saw-losses-less-than-0-01-made-over-1m/); [BeInCrypto](https://beincrypto.com/pump-fun-trading-data-majority-lose-money/)
- September 2025, Bubblemaps via Dune: about 130k of more than 270k wallets in the sample were in profit, and about 2,000 had passed $10k. This sample is not comparable with the 13.55M figure. [S] — [BeInCrypto](https://beincrypto.com/nearly-half-pumpfun-traders-book-profits)
- CoinGecko Research, "Pump.fun traders are making a comeback" (data Apr 2024 to Apr 2026): in a recent month, 2.05M wallets (65.1%) made between $1 and $500, which suggests a shift towards small winners. [P, summary only] — [CoinGecko](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback); [Crowdfund Insider, May 2026](https://www.crowdfundinsider.com/2026/05/277755-solana-based-meme-coins-trading-platform-pump-fun-makes-recovery-research/)
- TRUMP memecoin: traders lost about $2B across about 800k wallets after its January 2025 launch. [S] — [cited in search results on the decline](https://coinedition.com/pumpfun-token-sale-vanishes-revenue-crash/)

### Inferences
- The PnL distribution is extremely right-skewed. A realistic target for a retail-scale bot is small, frequent profits net of fees, not outsized wins. Fewer than 1 in 200 wallets clearing $10k realized is the honest prior.

### Gaps
- I found no study that separates PnL for bots and humans, or that adjusts for fees, priority fees and Jito tips.

## 5. Who participates and what their edge is

### Takeaway
Launch flow is dominated by automation. Non-dev wallets buy in block 0 on about 38% of new coins and within three blocks on about 50%. Developer bundles extracted far more ($579M+) than independent snipers did ($31.5M). Most retail trading goes through terminals, with Axiom taking about 42% to 57% of Solana trading-bot volume in 2025.

### Cited Findings
- Bitquery, 11-month sample: a non-dev wallet bought in block 0 on 38% of new Pump.fun coins, and within the first three blocks on about half. Snipers spent about $440M in total. Developer bundles made $579M+, while independent snipers made only $31.5M. [P] — [Bitquery: snipers & bundles](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Pine Analytics, via BeInCrypto: same-block sniping is "the dominant launch pattern". About 50% of launches involve sniping, mostly spray-and-pray bots. The strictest measure, deployer-funded snipers, covers about 1.75% of launches (15k+ in one month). [S] — [BeInCrypto](https://beincrypto.com/pump-fun-meme-coin-snipers-systematic-problem/)
- Vendor claims that more than 60% of launches are sniped in block 0 or 1 have no disclosed methodology. [V] — [SolBundler](https://solbundler.app/blog/anti-sniper-strategies-2026)
- Terminal and bot market share, 2025. April 2025 (Dune): Axiom rose from 3.5% to 42.2% in two months, while Photon fell from 31.8% to 20.4% and BullX from 27.5% to 11.3%. June 2025 (Adam Tehc on X): Axiom 57.0%, Photon 13.4%, BullX 6.6%, GMGN 6.5%, Trojan 4.4%, Bloom 3.3%, BonkBot 2.8%, Maestro 1.5%. [S/influencer] — [X: Adam_Tehc](https://x.com/Adam_Tehc/status/1930906164809826351); [Gate research](https://www.gate.com/learn/articles/a-data-driven-look-at-trading-bots-solana-remains-the-main-battleground-as-newcomers-surpass-veterans-in-multi-scenario-competition/8411)
- Axiom, a Y Combinator company, made about $10M in one week, peaked at about $2M daily revenue in April 2025, and reached $100M cumulative revenue by late May 2025 and later $200M+. It was the fastest app to that milestone. [S] — [Blockworks](https://blockworks.com/news/axiom-ycombinator-startup-solana-memecoin-revenue-10m); [SolanaFloor](https://solanafloor.com/news/solana-trading-bot-axiom-becomes-the-fastest-application-to-reach-200-m-in-revenue)
- About 30% of Pump.fun wallets have made only one transaction, which suggests many bot or burner wallets. [S] — [Cointelegraph](https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data)

### Inferences
- The biggest structural edge belongs to the developer or bundler, who controls supply at block 0. Independent sniping is crowded and earned about 18× less in total. A bot competing for block-0 entries is mostly competing on Jito tips against many others, with thin returns.
- Since most retail flow goes through Axiom-style terminals, signals visible in those terminals (dev holdings, bundles, top-10 concentration) are already priced in by many participants.

### Gaps
- I found no dated, rigorous share of total Pump.fun or PumpSwap volume attributable to bots overall.
- I found no quantitative data on KOL-call returns or copy-trader performance.

## 6. Lifecycle and timing around graduation

### Takeaway
Price usually falls after graduation. In one study, the median graduate was worth 3.8% of its graduation market cap 24 hours later. Only 26.4% were at or above graduation market cap after 1 hour, and 8.6% after 24 hours. Liquidity changes structurally at migration.

### Cited Findings
- MemeFees, 2026, not peer-reviewed, n = 49,118 graduates: the median graduate's market cap 24 hours after graduation was 3.8% of its graduation market cap. 26.4% were still at or above graduation market cap at 1 hour, and 8.6% at 24 hours. [V] — [MemeFees](https://memefees.com/research/memecoin-survival-2026)
- arXiv 2602.14860: graduation moves the pool from virtual to real reserves, which changes depth. How concentrated selling is across wallets affects the size of the post-graduation drop. [P] — [arXiv 2602.14860](https://arxiv.org/pdf/2602.14860)
- Bitquery: "1 in 50 graduations fills the pool" under Mayhem Mode. [P] — [Bitquery](https://bitquery.io/investigations/pump-fun-mayhem-mode)

### Inferences
- The default expectation for a graduation is "sell the news". Long entries at migration need strong specific evidence, such as rising unique buyers and low insider concentration. Exits or tight trailing stops in the first hour are justified by the 26% → 9% survival decay.

### Gaps
- I found no study measuring the median time from migration to peak, in minutes.
- I found no data on time-of-day or day-of-week effects for launches or graduations. This needs a custom Dune query.

## 7. Market regime, 2024-2026

### Takeaway
Activity peaked in January 2025 around the TRUMP launch (71,735 launches, about $15M daily Pump.fun revenue). It then fell about 80% to 90% by February and March 2025. There was a mid-2025 launchpad war, a brief rally in January 2026, and a weak second half of 2026, with memecoin market cap around $30B and Pump.fun activity about 80% below its peak. Graduation rates track the regime: about 1% to 2% in hot periods, about 0.2% to 0.3% in cold ones.

### Cited Findings
- Peak, January 2025: 71,735 launches on 23 Jan 2025. Daily volume peaked at $544M on 23 Jan and fell about 50% to $270M by 13 Feb. Daily revenue peaked at about $15.4M (24 or 25 Jan) and was about $1.1M by late February. [S] — [The Block](https://www.theblock.co/news/web3/2025-02-27-pump-fun-rapid-decline-graduating-tokens-memecoin-frenzy-fizzles-out-343742); [AiCoin](https://www.aicoin.com/en/article/442773); [CoinCentral](https://coincentral.com/end-of-the-ride-pump-funs-memecoin-platform-launches-are-down-80/)
- Late 2024: memecoin market cap peaked at about $140B. By September 2026 it was about $31.2B. [V/S] — [cryptowire](https://www.cryptowire.in/blog/memecoin-market-cap-stalls-near-30-billion-as-pumpfun-activity-sits-80-below-peak/); [coinlaw](https://coinlaw.io/memecoin-statistics/)
- July 2025: the PUMP token sale reportedly raised about $600M at about a $4B valuation. Messari says the public sale ended in 12 minutes on 13 July 2025. PUMP later fell about 70%. Sources conflict on details. [P/S] — [Messari](https://messari.io/project/pump-fun); [bitcoinethereumnews](https://bitcoinethereumnews.com/tech/pump-token-drops-70-in-2025-despite-record-600m-sale/)
- July 2025: LetsBonk briefly overtook Pump.fun (see Section 1).
- January 2026 rebound: the meme sector added about $8B of market cap in days, on about $9.2B of daily meme volume. Pump.fun had nearly 30k launches on 7 Jan 2026. [V] — [coinlaw](https://coinlaw.io/memecoin-statistics/)
- 2026: Pump.fun revenue was $124.7M in Q1 2026. Daily revenue fell about 83% to about $800k by June 2026. Trailing-30-day fees were $27.31M and revenue $20.91M as of 7 Aug 2026. H1 2026 PUMP buybacks were $72.2M, down 67%. [V/S] — [financefeeds](https://financefeeds.com/crypto-picks-and-shovels/); [KuCoin](https://www.kucoin.com/news/flash/pump-faces-1-25m-unlock-pressure-amid-shrinking-buybacks); [CCN](https://www.ccn.com/news/crypto/pump-fun-revenue-record-low-diversify/)
- Pump.fun's 2026 revenue to date of $322M ranked it second among all crypto projects. [V] — [The Currency Analytics](https://thecurrencyanalytics.com/defi/pump-fun-hits-322-million-in-2026-ranking-second-among-all-crypto-projects-297765)
- Graduation rate by regime: below 2% at peak in Q4 2024; about 0.7% to 0.8% in July and August 2025; 0.63% in Sep to Oct 2025; 0.26% in June 2026; 0.198% within 24 hours in the 2026 sample (sources in Section 2).

### Inferences
- Graduation and survival rates appear to move with overall flow by a factor of about 3× to 5×. A bot should switch thresholds by regime, for example by gating on trailing-24h launch counts, graduation counts or PumpSwap volume, rather than using static parameters.
- Q4 2026 conditions look cold-to-neutral: launches are still high, but graduations are low and revenue is declining. Expectations should be set at the low end of the base rates.

### Gaps
- I found no rigorous study that directly measures how the regime affects per-token success odds. The inference above comes from comparing graduation rates across periods.
- Revenue figures for 2026 conflict across sources.
