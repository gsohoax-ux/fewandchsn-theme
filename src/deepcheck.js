// Deep check: paste any Solana token address and get a full bundle / rug-pull check.
//
// Works for brand-new Pump.fun coins, graduated ones, and coins the bot never saw. Uses Helius
// (on-chain data), DexScreener (market) and RugCheck (second opinion). Every check says what it
// found, and anything that couldn't be checked is listed so you know how solid the verdict is.
import { fetchMetadata, socialKey } from './narrative.js';
import { detectDeployTool } from './copies.js';
import { liquidityRead, liquidityLines } from './liquidity.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const fmtPct = (x) => `${x.toFixed(1)}%`;
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`);

/** Pure (tested): group wallets that are linked by who funded them. */
export function linkClusters(wallets, { services = new Set(), creator = null } = {}) {
  const parent = new Map([...wallets.keys()].map((w) => [w, w]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  const byFunder = new Map();
  for (const [w, info] of wallets) {
    const f = info?.funder;
    if (!f || services.has(f)) continue;
    if (parent.has(f)) union(w, f);
    if (!byFunder.has(f)) byFunder.set(f, []);
    byFunder.get(f).push(w);
  }
  for (const g of byFunder.values()) for (let i = 1; i < g.length; i++) union(g[0], g[i]);
  const groups = new Map();
  for (const w of parent.keys()) {
    if (!wallets.has(w)) continue;
    const r = find(w);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(w);
  }
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => ({ wallets: g, includesDev: Boolean(creator && g.includes(creator)) }));
}

/** Pure (tested): turn the gathered facts into checks and a verdict. */
export function judge(f, cfg = {}) {
  const maxBundle = cfg.maxBundlePct ?? 15, maxDev = cfg.maxDevPct ?? 8, maxTop10 = cfg.maxTop10Pct ?? 35;
  const checks = [];
  const add = (group, level, text) => checks.push({ group, level, text });

  // Authorities
  if (f.mintAuthority === undefined) add('Authorities', 'unknown', 'Mint / freeze authority not checked');
  else {
    add('Authorities', f.mintAuthority ? 'bad' : 'ok', f.mintAuthority ? `Mint authority is ACTIVE: more tokens can be created (${f.mintAuthority.slice(0, 6)}…)` : 'Mint authority revoked: no more tokens can be created');
    add('Authorities', f.freezeAuthority ? 'bad' : 'ok', f.freezeAuthority ? 'Freeze authority is ACTIVE: your tokens could be frozen' : 'Freeze authority revoked: tokens can\'t be frozen');
  }

  // Launch bundle / snipers
  if (!f.launch) add('Launch', 'unknown', f.launchNote || 'Launch block not analysed');
  else {
    const L = f.launch;
    if (!L.bundleWallets) add('Launch', 'ok', 'No other wallets bought in the creation block');
    else {
      const lvl = L.bundleInitialPct >= maxBundle || L.bundleHeldPct >= maxBundle * 0.66 ? 'bad' : L.bundleInitialPct >= maxBundle / 3 ? 'warn' : 'ok';
      add('Launch', lvl, `Bundled at launch: ${L.bundleWallets} wallet${L.bundleWallets > 1 ? 's' : ''} bought ${fmtPct(L.bundleInitialPct)} in the creation block, still holding ${fmtPct(L.bundleHeldPct)}`);
    }
    if (L.devInitialPct != null) add('Launch', L.devInitialPct >= 10 ? 'warn' : 'ok', `Dev bought ${fmtPct(L.devInitialPct)} at creation`);
    if (L.sniperWallets) {
      add('Launch', L.sniperHeldPct >= 20 ? 'bad' : L.sniperHeldPct >= 10 ? 'warn' : 'ok',
        `${L.sniperWallets} sniper wallet${L.sniperWallets > 1 ? 's' : ''} bought in the first 3 blocks, still holding ${fmtPct(L.sniperHeldPct)}`);
    }
  }

  // Holders
  if (f.top10Pct == null) add('Holders', 'unknown', 'Holders not checked');
  else {
    add('Holders', f.top10Pct >= maxTop10 ? 'bad' : f.top10Pct >= maxTop10 * 0.75 ? 'warn' : 'ok', `Top 10 holders own ${fmtPct(f.top10Pct)} (pools and the bonding curve excluded)`);
    if (f.topHolderPct >= 10) add('Holders', f.topHolderPct >= 20 ? 'bad' : 'warn', `Largest single holder owns ${fmtPct(f.topHolderPct)}`);
    if (f.poolPct != null) add('Holders', 'info', `Bonding curve / pools hold ${fmtPct(f.poolPct)}`);
  }

  // Wallet links
  if (!f.links) add('Wallet links', 'unknown', f.linksNote || 'Funding links not checked (needs a Helius key)');
  else if (!f.links.clusters.length) add('Wallet links', 'ok', `No linked wallets among the dev, launch buyers and top holders (${f.links.checked} wallets traced)`);
  else {
    for (const c of f.links.clusters.slice(0, 3)) {
      add('Wallet links', c.includesDev || c.heldPct >= maxBundle ? 'bad' : 'warn',
        `${c.wallets.length} wallets share a funder${c.includesDev ? ' (linked to the DEV)' : ''}, holding ${fmtPct(c.heldPct)} together`);
    }
  }
  if (f.links?.freshShare != null && f.links.freshShare >= 0.6) add('Wallet links', 'warn', `${Math.round(f.links.freshShare * 100)}% of traced wallets are brand new`);

  // Dev
  if (f.devPct != null) add('Dev', f.devPct >= maxDev ? 'bad' : f.devPct >= maxDev / 2 ? 'warn' : 'ok', `Dev holds ${fmtPct(f.devPct)} now`);
  if (f.dev?.history?.rugged) add('Dev', 'bad', `Dev rugged ${f.dev.history.rugged} of ${f.dev.history.finished} past coins the bot saw`);
  else if (f.dev?.history?.migrated) add('Dev', 'ok', `Dev's past coins: ${f.dev.history.migrated} graduated, none rugged`);
  if (f.dev?.launches24h >= 5) add('Dev', 'bad', `Serial launcher: ${f.dev.launches24h} coins in 24h`);
  else if (f.dev?.launches24h >= 2) add('Dev', 'warn', `Dev launched ${f.dev.launches24h} coins in 24h`);
  if (f.dev?.walletFresh) add('Dev', 'warn', 'Dev wallet is brand new');
  if (!f.creator) add('Dev', 'unknown', 'Creator wallet not found');

  // Socials
  if (f.socials) {
    const s = f.socials;
    add('Socials', s.count >= 2 ? 'ok' : s.count === 1 ? 'info' : 'warn', s.count ? `Socials: ${[s.twitter && 'X', s.telegram && 'Telegram', s.website && 'website'].filter(Boolean).join(', ')}` : 'No socials at all');
    if (s.recycled) add('Socials', 'bad', `Socials reused from ${s.recycled} other coin(s)`);
    if (s.deployTool) add('Socials', 'info', `Launched with ${s.deployTool} (quick deploy)`);
  }

  // Honeypot & taxes: can you actually sell, and what does each trade cost?
  if (f.mintAuthority !== undefined) {
    const t = f.token ?? {};
    if (t.transferFeeBps > 0) add('Honeypot & tax', t.transferFeeBps >= 500 ? 'bad' : 'warn', `Transfer tax ${(t.transferFeeBps / 100).toFixed(2)}% on every buy AND sell`);
    if (t.transferHook) add('Honeypot & tax', 'bad', 'Transfer hook: a program runs on every transfer and could block selling (honeypot risk)');
    if (t.permanentDelegate) add('Honeypot & tax', 'bad', 'Permanent delegate: someone can move or burn tokens from your wallet');
    if (t.defaultFrozen) add('Honeypot & tax', 'bad', 'New token accounts start FROZEN: you may not be able to sell');
    if (t.nonTransferable) add('Honeypot & tax', 'bad', 'Token is non-transferable: it cannot be sold');
    if (f.freezeAuthority) add('Honeypot & tax', 'bad', 'Freeze authority active: your tokens could be frozen so you can\'t sell (honeypot risk)');
    if (!t.transferFeeBps && !t.transferHook && !t.permanentDelegate && !t.defaultFrozen && !t.nonTransferable && !f.freezeAuthority) {
      add('Honeypot & tax', 'ok', t.is2022 ? 'Token-2022 with no tax, hook or delegate found' : 'Standard token: no transfer tax or sell-blocking features');
    }
  } else add('Honeypot & tax', 'unknown', 'Token program features not checked (taxes, transfer hooks)');
  if (f.market && f.market.buys1h >= 10 && f.market.sells1h === 0) {
    add('Honeypot & tax', 'bad', `${f.market.buys1h} buys and 0 sells in the last hour: nobody is selling, possible honeypot`);
  }
  if (f.market?.onCurve) add('Honeypot & tax', 'info', 'On the bonding curve: holders can always sell back to the curve');

  // Liquidity & slippage for your trade size
  if (f.liquidity) {
    const L = f.liquidity;
    const lines = liquidityLines(L);
    add('Liquidity', L.ratioPct != null && L.ratioPct < (L.onCurve ? 2 : 5) || L.realLiqUsd < 1000 ? 'bad' : L.ratioPct != null && L.ratioPct < (L.onCurve ? 5 : 10) ? 'warn' : 'ok', lines[0]);
    add('Liquidity', L.order.avgPct > 15 ? 'bad' : L.order.avgPct > 5 ? 'warn' : 'ok', lines[1]);
    add('Liquidity', L.cash.lossPct > 15 ? 'warn' : 'info', lines[2]);
  } else add('Liquidity', 'unknown', 'Liquidity depth not known: slippage can\'t be estimated');

  // Market
  if (f.market) {
    const m = f.market;
    add('Market', 'info', `${m.onCurve ? 'Still on the bonding curve' : `Trading on ${m.dex}`} · MC ${usd(m.mcUsd)} · 24h volume ${usd(m.vol24)}${m.ageH != null ? ` · ${m.ageH < 48 ? `${m.ageH.toFixed(1)}h` : `${(m.ageH / 24).toFixed(0)}d`} old` : ''}`);
    if (m.buys1h + m.sells1h >= 20) {
      const r = m.buys1h / Math.max(1, m.sells1h);
      add('Market', r < 0.5 ? 'warn' : 'info', `Last hour: ${m.buys1h} buys / ${m.sells1h} sells${r < 0.5 ? ' (heavy selling)' : ''}`);
    }
    if (m.change1h != null && m.change1h <= -50) add('Market', 'warn', `Price ${m.change1h.toFixed(0)}% in the last hour`);
  } else add('Market', 'unknown', 'No DexScreener data');

  // RugCheck second opinion
  if (f.rugcheck) {
    const dangers = f.rugcheck.risks.filter((r) => r.level === 'danger');
    const warns = f.rugcheck.risks.filter((r) => r.level === 'warn');
    if (dangers.length) add('RugCheck', 'bad', `RugCheck danger: ${dangers.map((r) => r.name).join(', ')}`);
    if (warns.length) add('RugCheck', 'warn', `RugCheck warnings: ${warns.map((r) => r.name).join(', ')}`);
    if (!dangers.length && !warns.length) add('RugCheck', 'ok', 'RugCheck found no warnings');
  } else add('RugCheck', 'unknown', 'RugCheck not available');

  const bad = checks.filter((c) => c.level === 'bad').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  const unknown = checks.filter((c) => c.level === 'unknown').length;
  // Never call a coin SAFE when the key checks couldn't run
  const keyUnknown = checks.filter((c) => c.level === 'unknown' && ['Authorities', 'Launch', 'Holders', 'Wallet links'].includes(c.group)).length;
  const verdict = bad ? 'AVOID' : keyUnknown >= 2 ? 'UNVERIFIED' : warn >= 2 ? 'CAUTION' : 'SAFE';
  const score = Math.max(0, Math.min(100, 100 - bad * 30 - warn * 10 - unknown * 3));
  return { verdict, score, checks, bad, warn, unknown };
}

export class DeepChecker {
  constructor({ chain, store, cfg, engine = null, fetchFn = fetch, log = console }) {
    Object.assign(this, { chain, store, cfg, engine, fetchFn, log });
    this.cache = new Map();
    this.running = new Map();
  }

  async #json(url) {
    const res = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** One check per coin at a time; results cached for 2 minutes. */
  async check(mint) {
    mint = String(mint ?? '').trim();
    if (!MINT_RE.test(mint)) throw new Error('That doesn\'t look like a Solana token address');
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < 120_000) return hit.report;
    if (this.running.has(mint)) return this.running.get(mint);
    const p = this.#run(mint).finally(() => this.running.delete(mint));
    this.running.set(mint, p);
    const report = await p;
    this.cache.set(mint, { at: Date.now(), report });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return report;
  }

  async #run(mint) {
    const t0 = Date.now();
    const f = { notes: [] };
    const chain = this.chain?.enabled ? this.chain : null;
    const step = async (name, fn) => { try { return await fn(); } catch (e) { f.notes.push(`${name}: ${e.message}`); return null; } };

    const [mintInfo, largest, asset, dex, rug] = await Promise.all([
      chain ? step('mint account', () => chain.rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }])) : null,
      chain ? step('largest holders', () => chain.rpc('getTokenLargestAccounts', [mint])) : null,
      chain ? step('token metadata', () => chain.rpc('getAsset', { id: mint })) : null,
      step('DexScreener', () => this.#json(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)),
      step('RugCheck', () => this.#json(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`)),
    ]);
    if (!chain) f.notes.push('No Helius key: on-chain checks (authorities, launch bundle, holders, wallet links) were skipped');

    // ---- authorities + supply
    const info = mintInfo?.value?.data?.parsed?.info;
    if (mintInfo && !info) throw new Error('That address is not a token mint');
    let supply = null;
    if (info) {
      f.mintAuthority = info.mintAuthority ?? null;
      f.freezeAuthority = info.freezeAuthority ?? null;
      const ext = new Map((info.extensions ?? []).map((e) => [e.extension, e.state ?? {}]));
      const fee = ext.get('transferFeeConfig');
      f.token = {
        is2022: mintInfo.value.owner === TOKEN_2022,
        transferFeeBps: Number(fee?.newerTransferFee?.transferFeeBasisPoints ?? fee?.olderTransferFee?.transferFeeBasisPoints ?? 0),
        transferHook: Boolean(ext.get('transferHook')?.programId),
        permanentDelegate: Boolean(ext.get('permanentDelegate')?.delegate),
        defaultFrozen: ext.get('defaultAccountState')?.accountState === 'frozen',
        nonTransferable: ext.has('nonTransferable'),
      };
      supply = Number(info.supply) / 10 ** (info.decimals ?? 6);
    }

    // ---- name / socials
    const meta = asset?.content?.metadata ?? {};
    f.name = meta.name ?? ''; f.symbol = meta.symbol ?? ''; f.image = asset?.content?.links?.image ?? '';
    const jsonUri = asset?.content?.json_uri;
    const offchain = jsonUri ? await step('socials', () => fetchMetadata(jsonUri)) : null;

    // ---- market (DexScreener)
    const pairs = (dex?.pairs ?? []).filter((x) => x.chainId === 'solana').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (pairs.length) {
      const p = pairs[0];
      f.name ||= p.baseToken?.name ?? ''; f.symbol ||= p.baseToken?.symbol ?? '';
      f.market = {
        dex: p.dexId, onCurve: /pump\.?fun/i.test(p.dexId ?? '') && !/swap/i.test(p.dexId ?? ''), mcUsd: p.marketCap ?? p.fdv ?? 0,
        liqUsd: p.liquidity?.usd ?? 0, vol24: p.volume?.h24 ?? 0, change1h: p.priceChange?.h1 ?? null,
        buys1h: p.txns?.h1?.buys ?? 0, sells1h: p.txns?.h1?.sells ?? 0,
        ageH: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600_000 : null, url: p.url,
      };
    }
    {
      const solUsd = this.engine?.solUsd ?? 0;
      const tracked = this.engine?.coins.get(mint);
      // too new for DexScreener, but the bot is watching it live on the bonding curve
      if (!f.market && tracked && !tracked.migrated && solUsd > 0 && tracked.mcSol > 0) {
        f.name ||= tracked.name ?? ''; f.symbol ||= tracked.symbol ?? '';
        f.market = { dex: 'pumpfun', onCurve: true, mcUsd: tracked.mcSol * solUsd, liqUsd: 0, vol24: 0, change1h: null,
          buys1h: 0, sells1h: 0, ageH: tracked.createdAt ? (Date.now() - tracked.createdAt) / 3600_000 : null, url: null, source: 'live feed' };
      }
      if (f.market) {
        f.liquidity = liquidityRead({ onCurve: f.market.onCurve, vSol: tracked && !tracked.migrated ? tracked.vSol : null,
          liqUsd: f.market.liqUsd, mcUsd: f.market.mcUsd, solUsd, orderUsd: this.cfg.checkOrderUsd ?? 50 });
      }
    }
    if (rug) f.rugcheck = { score: rug.score_normalised ?? rug.score ?? null, risks: (rug.risks ?? []).map((r) => ({ name: r.name, level: r.level, description: r.description })) };

    // ---- holders (exclude the bonding curve / pools: token accounts owned by a program, not a wallet)
    const balances = new Map(); // wallet -> tokens
    if (largest?.value?.length && supply) {
      const accts = largest.value;
      const parsed = await step('holder owners', () => chain.rpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]));
      const owners = (parsed?.value ?? []).map((a) => a?.data?.parsed?.info?.owner ?? null);
      const ownerAccts = await step('holder types', () => chain.rpc('getMultipleAccounts', [owners.filter(Boolean), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]));
      const ownerType = new Map();
      owners.filter(Boolean).forEach((o, i) => { const a = ownerAccts?.value?.[i]; ownerType.set(o, !a || a.owner === SYSTEM_PROGRAM ? 'wallet' : 'program'); });
      let poolTokens = 0;
      accts.forEach((a, i) => {
        const o = owners[i]; const amt = Number(a.uiAmount ?? a.uiAmountString ?? 0);
        if (!o) return;
        if (ownerType.get(o) === 'program') poolTokens += amt;
        else balances.set(o, (balances.get(o) ?? 0) + amt);
      });
      const top = [...balances.values()].sort((a, b) => b - a);
      f.top10Pct = (top.slice(0, 10).reduce((s, x) => s + x, 0) / supply) * 100;
      f.topHolderPct = ((top[0] ?? 0) / supply) * 100;
      f.poolPct = (poolTokens / supply) * 100;
      f.topWallets = [...balances.keys()].sort((a, b) => balances.get(b) - balances.get(a)).slice(0, 10);
    }

    // ---- creation, dev and launch block
    if (chain && supply) {
      const sigs = [];
      let before;
      for (let page = 0; page < 8; page++) {
        const got = await step('history', () => chain.rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]));
        if (!got?.length) break;
        sigs.push(...got);
        if (got.length < 1000) { before = null; break; }
        before = got.at(-1).signature;
      }
      if (before) f.launchNote = `Coin has more than ${sigs.length.toLocaleString()} transactions; its launch is too far back to analyse`;
      else if (sigs.length) {
        const create = sigs.at(-1);
        const createSlot = create.slot;
        const early = sigs.filter((s) => s.slot <= createSlot + 2 && !s.err).map((s) => s.signature);
        const txs = await step('launch transactions', () => chain.parseTransactions(early.slice(-100)));
        if (txs?.length) {
          const createTx = txs.find((t) => t.signature === create.signature) ?? txs.find((t) => t.slot === createSlot);
          f.creator = createTx?.feePayer ?? null;
          f.createdAt = (createTx?.timestamp ?? create.blockTime ?? 0) * 1000;
          const got = (t) => (t.tokenTransfers ?? []).filter((x) => x.mint === mint && x.toUserAccount).map((x) => [x.toUserAccount, Number(x.tokenAmount ?? 0)]);
          const bundle = new Map(), snipers = new Map();
          let devInitial = 0;
          for (const t of txs) {
            for (const [w, amt] of got(t)) {
              if (w === f.creator) { devInitial += amt; continue; }   // (tokens the dev paid for into OTHER wallets count as bundle)
              (t.slot === createSlot ? bundle : snipers).set(w, (bundle.get(w) ?? snipers.get(w) ?? 0) + amt);
            }
          }
          for (const w of bundle.keys()) snipers.delete(w);
          // current holdings of these wallets
          const held = new Map(balances);
          const need = [...new Set([f.creator, ...bundle.keys(), ...snipers.keys()].filter((w) => w && !held.has(w)))].slice(0, 40);
          await Promise.all(need.map((w) => step('wallet balance', async () => {
            const r = await chain.rpc('getTokenAccountsByOwner', [w, { mint }, { encoding: 'jsonParsed' }]);
            held.set(w, (r?.value ?? []).reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0));
          })));
          const pct = (x) => (x / supply) * 100;
          const sum = (m) => [...m.values()].reduce((s, x) => s + x, 0);
          const heldBy = (ws) => ws.reduce((s, w) => s + (held.get(w) ?? 0), 0);
          f.launch = {
            bundleWallets: bundle.size, bundleInitialPct: pct(sum(bundle)), bundleHeldPct: pct(heldBy([...bundle.keys()])),
            sniperWallets: snipers.size, sniperHeldPct: pct(heldBy([...snipers.keys()])), devInitialPct: pct(devInitial),
          };
          if (f.creator) f.devPct = pct(held.get(f.creator) ?? 0);
          f.held = held; f.launchWallets = [...bundle.keys(), ...snipers.keys()];
        }
      }
    }
    if (!f.held) f.held = balances;

    // ---- funding links between the dev, launch buyers and top holders
    if (chain) {
      const targets = [...new Set([f.creator, ...(f.launchWallets ?? []), ...(f.topWallets ?? [])].filter(Boolean))].slice(0, 25);
      if (targets.length) {
        const wallets = new Map();
        const ts = Math.floor((f.createdAt || Date.now()) / 1000) + 3600;
        await Promise.all(targets.map((w) => step('funding', async () => wallets.set(w, await chain.getWalletInfo(w, ts)))));
        const counts = new Map();
        for (const i of wallets.values()) if (i?.funder) counts.set(i.funder, (counts.get(i.funder) ?? 0) + 1);
        const services = new Set();
        await Promise.all([...counts].filter(([, c]) => c >= 2).map(([fnd]) => step('exchange check', async () => { if (await chain.isService(fnd)) services.add(fnd); })));
        const clusters = linkClusters(wallets, { services, creator: f.creator }).map((c) => ({
          ...c, heldPct: supply ? (c.wallets.filter((w) => w !== f.creator).reduce((s, w) => s + (f.held.get(w) ?? 0), 0) / supply) * 100 : 0,
        })).sort((a, b) => b.heldPct - a.heldPct);
        const fresh = [...wallets.values()].filter((i) => i?.fresh).length;
        f.links = { checked: wallets.size, clusters, freshShare: wallets.size >= 5 ? fresh / wallets.size : null };
        if (f.creator && wallets.get(f.creator)?.fresh) f.dev = { ...(f.dev ?? {}), walletFresh: true };
      }
    } else f.linksNote = 'Funding links need a Helius key';

    // ---- dev history (from what the bot has seen) and socials reuse
    if (f.creator) {
      f.dev = { ...(f.dev ?? {}), history: this.store.devHistory(f.creator, mint), launches24h: this.store.devLaunches(f.creator, Date.now() - 86400_000) };
    }
    const m = offchain ?? {};
    const sk = socialKey(m.twitter);
    const own = sk && sk.kind !== 'tweet' ? sk.key : socialKey(m.telegram)?.key;
    f.socials = { twitter: m.twitter || '', telegram: m.telegram || '', website: m.website || '',
      count: [m.twitter, m.telegram, m.website].filter(Boolean).length,
      recycled: own ? this.store.socialReuse(own, mint).length : 0, deployTool: detectDeployTool(m, this.cfg.deployToolPatterns) };
    if (!offchain && !jsonUri) f.socials = pairs.length ? { ...f.socials, count: (pairs[0].info?.socials?.length ?? 0) + (pairs[0].info?.websites?.length ?? 0) } : null;

    const j = judge(f, this.cfg);

    // ---- the bot's live read, if it's tracking this coin
    let live = null;
    const coin = this.engine?.coins.get(mint);
    if (coin) {
      // Reuse the bot's own evaluation when it is fresh; otherwise re-score with the on-chain data it already has
      // ('recheck' reuses chain data). Never run alongside an evaluation in progress, and never re-download
      // everything from Helius: that doubled Helius load during deep checks and caused rate-limit failures.
      const fresh = coin.result && Date.now() - coin.result.at < 120_000;
      const r = fresh || coin.evaluating ? coin.result
        : await step('live score', async () => { coin.evaluating = true; try { return await this.engine.evaluate(coin, coin.chainData ? 'recheck' : 'manual'); } finally { coin.evaluating = false; } });
      if (r) live = { score: r.score, verdict: r.safety.verdict, momentum: r.momentum.score, narrative: r.narrative.score, confidence: r.confidence.label, runner: r.runner?.is ?? false };
    }

    return {
      mint, name: f.name, symbol: f.symbol, image: f.image, ...j, at: Date.now(), tookMs: Date.now() - t0, liquidity: f.liquidity ?? null,
      creator: f.creator ?? null, market: f.market ?? null, rugcheck: f.rugcheck ?? null, live,
      links: { pump: `https://pump.fun/coin/${mint}`, dexscreener: f.market?.url || `https://dexscreener.com/solana/${mint}`,
        solscan: `https://solscan.io/token/${mint}`, rugcheck: `https://rugcheck.xyz/tokens/${mint}`,
        padre: this.cfg.padreUrlTemplate ? this.cfg.padreUrlTemplate.replace('{mint}', mint) : '' },
      notes: f.notes,
    };
  }
}
