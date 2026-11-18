// Safety + bundle analysis.
//
// "Bundled" coins: the dev (or a team) buys a big chunk of supply in the SAME block as
// the token is created - usually from several fresh wallets inside one Jito bundle -
// so the chart looks organic while insiders hold the bag they will dump on you.
//
// We detect it three ways:
//   1. Launch-block buyers: wallets whose buy landed in the creation slot (Helius slots),
//      or - without Helius - within ~1.5s of the create event.
//   2. Funding links: early buyers funded by the same wallet, by the dev, or by each other.
//   3. Fresh wallets: brand-new wallets with no history, typical of bundle farms.

import { pctOfSupply } from './coin.js';

const LAUNCH_WINDOW_MS = 1500;
const EARLY_BUYERS = 25;

/** Collect slot + wallet data. Returns null-ish fields when no chain provider is available. */
export async function gatherChainData(coin, chain) {
  const out = { source: 'timing', slots: null, wallets: new Map(), services: new Set(), errors: [] };
  if (!chain?.enabled) return out;
  try {
    out.slots = await chain.getSignatureSlots(coin.mint);
    out.source = 'chain';
  } catch (e) { out.errors.push(`slots: ${e.message}`); }

  const launch = launchBlockWallets(coin, out.slots);
  const targets = new Set([coin.creator, ...launch, ...coin.earlyBuyers(EARLY_BUYERS)]);
  await Promise.all([...targets].filter(Boolean).map(async (w) => {
    try {
      const ts = Math.floor((coin.firstBuyAt.get(w) ?? coin.createdAt) / 1000);
      out.wallets.set(w, await chain.getWalletInfo(w, ts));
    } catch (e) { out.errors.push(`wallet ${w.slice(0, 4)}: ${e.message}`); }
  }));

  // Funders shared by 2+ wallets: check they're not an exchange before calling it a bundle.
  const counts = new Map();
  for (const info of out.wallets.values()) {
    if (info.funder) counts.set(info.funder, (counts.get(info.funder) ?? 0) + 1);
  }
  await Promise.all([...counts].filter(([f, c]) => c >= 2 && f !== coin.creator).map(async ([f]) => {
    try { if (await chain.isService(f)) out.services.add(f); } catch { /* treat as not a service */ }
  }));
  return out;
}

/** Wallets (not the dev) that bought in the same block as the token creation. */
export function launchBlockWallets(coin, slots) {
  const set = new Set();
  const createSlot = slots ? (slots.get(coin.createSig) ?? Math.min(...slots.values())) : null;
  for (const t of coin.trades) {
    if (t.side !== 'buy' || t.trader === coin.creator) continue;
    if (slots && createSlot != null && Number.isFinite(createSlot)) {
      const s = slots.get(t.sig);
      if (s != null && s <= createSlot) set.add(t.trader);
    } else if (t.ts - coin.createdAt <= LAUNCH_WINDOW_MS) {
      set.add(t.trader);
    } else break;
  }
  return set;
}

/** Group wallets that are linked by funding (union-find). */
export function findClusters(coin, wallets, services = new Set()) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  for (const w of wallets.keys()) parent.set(w, w);

  const byFunder = new Map();
  for (const [w, info] of wallets) {
    const f = info.funder;
    if (!f || services.has(f)) continue;
    if (wallets.has(f)) union(w, f);                 // funded by another early wallet / the dev
    else if (f === coin.creator) union(w, coin.creator);
    if (!byFunder.has(f)) byFunder.set(f, []);
    byFunder.get(f).push(w);
  }
  for (const group of byFunder.values()) for (let i = 1; i < group.length; i++) union(group[0], group[i]);

  const groups = new Map();
  for (const w of parent.keys()) {
    const r = find(w);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(w);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({
      wallets: g,
      includesDev: g.includes(coin.creator),
      funder: wallets.get(g.find((w) => w !== coin.creator))?.funder ?? null,
      heldPct: g.filter((w) => w !== coin.creator).reduce((s, w) => s + coin.holderPct(w), 0),
    }))
    .sort((a, b) => b.heldPct - a.heldPct);
}

/**
 * Pure scoring of safety. ctx: { devLaunches24h, recycledSocials, smartWallets, cfg }
 */
export function analyzeSafety(coin, chainData, ctx) {
  const { cfg } = ctx;
  const flags = [];
  const add = (level, text) => flags.push({ level, text });
  const fmt = (n) => `${n.toFixed(1)}%`;

  // 1. Launch-block (bundle) buys
  const launch = launchBlockWallets(coin, chainData.slots);
  const launchInitial = [...launch].reduce((s, w) => s + pctOfSupply(coin.firstBuyTokens.get(w) ?? 0), 0);
  const launchHeld = [...launch].reduce((s, w) => s + coin.holderPct(w), 0);
  const how = chainData.source === 'chain' ? 'same block' : 'first 1.5s, est.';
  if (launch.size === 0) add('ok', `No bundle at launch (${how})`);
  else {
    const lvl = launchInitial >= cfg.maxBundlePct ? 'bad' : launchInitial >= cfg.maxBundlePct / 2 ? 'warn' : 'ok';
    add(lvl, `Bundled at launch: ${fmt(launchInitial)} in ${launch.size} wallet${launch.size > 1 ? 's' : ''} (${how}), still holding ${fmt(launchHeld)}`);
  }

  // 2. Funding-linked clusters
  const clusters = findClusters(coin, chainData.wallets, chainData.services);
  const clusterHeld = clusters.reduce((s, c) => s + c.heldPct, 0);
  const clusterWallets = clusters.reduce((s, c) => s + c.wallets.length, 0);
  const devLinked = clusters.some((c) => c.includesDev);
  if (chainData.wallets.size === 0) add('info', 'Funding links not checked (add a Helius key)');
  else if (!clusters.length) add('ok', 'No linked wallets among early buyers');
  else {
    const lvl = clusterHeld >= cfg.maxBundlePct || devLinked ? 'bad' : 'warn';
    add(lvl, `${clusterWallets} early wallets share funders${devLinked ? ' (linked to DEV)' : ''}, holding ${fmt(clusterHeld)}`);
  }

  // 3. Fresh wallets among early buyers
  const early = coin.earlyBuyers(EARLY_BUYERS);
  const checked = early.filter((w) => chainData.wallets.has(w));
  const fresh = checked.filter((w) => chainData.wallets.get(w).fresh);
  const freshPct = checked.length ? (fresh.length / checked.length) * 100 : 0;
  if (checked.length >= 5) {
    if (freshPct >= 60) add('warn', `${fresh.length}/${checked.length} early buyers are brand-new wallets`);
    else add('ok', `Fresh wallets among early buyers: ${fresh.length}/${checked.length}`);
  }

  // 4. Dev
  const devPct = coin.devPct();
  if (coin.devSold && coin.devSoldPct >= 90) add('info', 'Dev sold out');
  else if (coin.devSold) add('warn', `Dev is selling (${coin.devSoldPct.toFixed(0)}% of their bag)`);
  if (devPct >= cfg.maxDevPct) add('bad', `Dev holds ${fmt(devPct)}`);
  else if (!coin.devSold) add(devPct >= cfg.maxDevPct / 2 ? 'warn' : 'ok', `Dev holds ${fmt(devPct)}`);
  if (ctx.devLaunches24h >= 5) add('bad', `Serial launcher: dev made ${ctx.devLaunches24h} coins in 24h`);
  else if (ctx.devLaunches24h >= 2) add('warn', `Dev made ${ctx.devLaunches24h} coins in 24h`);

  // 5. Concentration
  const top10 = coin.topHoldersPct(10);
  add(top10 >= cfg.maxTop10Pct ? 'bad' : top10 >= cfg.maxTop10Pct * 0.75 ? 'warn' : 'ok', `Top 10 holders: ${fmt(top10)}`);

  // 6. Recycled socials (same X/Telegram link used by another coin)
  if (ctx.recycledSocials?.length) add('bad', `Socials reused from ${ctx.recycledSocials.length} other coin(s)`);

  const bad = flags.filter((f) => f.level === 'bad').length;
  const warn = flags.filter((f) => f.level === 'warn').length;
  const verdict = bad ? 'AVOID' : warn >= 2 ? 'CAUTION' : 'SAFE';
  const score = Math.max(0, Math.min(100, 100 - bad * 35 - warn * 12));

  return {
    verdict, score, flags, source: chainData.source,
    launchBundle: { wallets: launch.size, initialPct: launchInitial, heldPct: launchHeld },
    clusters: clusters.map((c) => ({ size: c.wallets.length, heldPct: c.heldPct, includesDev: c.includesDev, funder: c.funder })),
    devPct, top10Pct: top10, freshPct, errors: chainData.errors,
  };
}
