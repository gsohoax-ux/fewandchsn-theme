// Setuh scalping setups as pure rule functions (easy to test, no network).
//
// Each setup looks at one coin's context and returns:
//   phase: 'idle' (nothing forming) | 'watching' (pattern forming, waiting for confirmation)
//          | 'signal' (every required condition met) | 'rejected' (a hard rule failed)
//   conditions: [{ key, label, ok: true | false | null, detail }]   (null = not confirmed / no data)
//   entry / invalidation / target levels, and reward vs risk.
//
// Candles here are in MARKET CAP (USD): {t, o, h, l, c, v, buys?, sells?}. Prices are derived with
// price = mc / supply. Missing data is never treated as a pass.

export const SETUPS = {
  newPairs: {
    family: 'New Pairs', name: 'Launch pullback',
    summary: 'Skip the launch pump; buy a 50–60% pullback that holds a floor with buyers stepping back in.',
    defaults: { enabled: true, maxAgeMin: 20, minRunMult: 2.5, pullbackMinPct: 45, pullbackMaxPct: 65, candleSec: 20,
      floorCandles: 4, floorMaxRangePct: 18, flowWindowSec: 60, minBuyRatio: 1.3, minBuyers: 5, minNarrative: 45,
      maxBundleHeldPct: 12, targetPct: 55, stopPct: 20, earlyTakeMinPct: 20, earlySellRatio: 2, maxHoldMin: 30 },
  },
  finalA: {
    family: 'Final Stretch', name: 'A · 60% bundle pullback',
    summary: 'Run toward $18–20K, bundles/tracked wallets sell, ~60% retrace to a floor, sellers exhausted, demand returns.',
    defaults: { enabled: true, minPeakMcUsd: 16000, pullbackMinPct: 52, pullbackMaxPct: 68, candleSec: 30, floorCandles: 4,
      floorMaxRangePct: 15, requireInsiderSelling: true, insiderSoldPct: 50, sellExhaustRatio: 0.35, flowWindowSec: 90,
      minBuyRatio: 1.2, targetPct: 50, stopPct: 20, maxHoldMin: 45 },
  },
  finalB: {
    family: 'Final Stretch', name: 'B · 40–50% pullback',
    summary: 'Coins that reached $15K+: after a meaningful local high, wait for a 40–50% retrace that stabilizes with buying.',
    defaults: { enabled: true, minPeakMcUsd: 15000, minRiseToHighPct: 50, pullbackMinPct: 38, pullbackMaxPct: 52, candleSec: 30,
      floorCandles: 3, floorMaxRangePct: 12, flowWindowSec: 90, minBuyRatio: 1.2, targetPct: 40, stopPct: 18, maxHoldMin: 45 },
  },
  finalC: {
    family: 'Final Stretch', name: 'C · Tracked developer',
    summary: 'A developer with a good track record launches; wait for selling to exhaust, a sideways range, then a breakout.',
    defaults: { enabled: true, minDevGraduated: 1, maxDevRugs: 0, minAgeMin: 3, candleSec: 30, rangeCandles: 5,
      rangeMaxPct: 15, sellExhaustRatio: 0.35, flowWindowSec: 60, minBuyRatio: 1.3, targetPct: 50, stopPct: 20, maxHoldMin: 60 },
  },
  migrated: {
    family: 'Migrated Coins', name: 'Post-graduation floor breakout',
    summary: '1–3 h old graduates: 60–70% off a $100K+ high, sideways floor around $20–50K holding, then a breakout.',
    defaults: { enabled: true, minAgeMin: 60, maxAgeMin: 180, minPeakMcUsd: 100000, pullbackMinPct: 58, pullbackMaxPct: 72,
      supportMinMcUsd: 20000, supportMaxMcUsd: 50000, rangeCandles: 4, rangeMaxPct: 20, breakoutVolMult: 1.2,
      minLiqUsd: 10000, targetPct: 50, stopPct: 20, maxHoldMin: 120 },
  },
};

// ------------------------------------------------------------------ helpers (pure, tested)

/** Index of the highest high (first one if tied), from index `from`. */
export function peakIndex(candles, from = 0) {
  let best = -1;
  for (let i = from; i < candles.length; i++) if (best < 0 || candles[i].h > candles[best].h) best = i;
  return best;
}

/** The last n candles as a range: low, high, width %, whether the floor held (no new low in the last candle). */
export function rangeOf(candles, n) {
  if (candles.length < n || n < 2) return null;
  const w = candles.slice(-n);
  const low = Math.min(...w.map((c) => c.l)), high = Math.max(...w.map((c) => c.h));
  const prevLow = Math.min(...w.slice(0, -1).map((c) => c.l));
  return { low, high, widthPct: low > 0 ? ((high - low) / low) * 100 : Infinity, floorHeld: w.at(-1).l >= prevLow * 0.995,
    avgVol: w.slice(0, -1).reduce((s, c) => s + c.v, 0) / (n - 1), last: w.at(-1), highBeforeLast: Math.max(...w.slice(0, -1).map((c) => c.h)) };
}

/** Buy vs sell flow from trades [{ts, side, sol, trader}] in the last windowMs. */
export function flowOf(trades, now, windowMs, solUsd = 1) {
  let buyUsd = 0, sellUsd = 0;
  const buyers = new Set(), sellers = new Set();
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (now - t.ts > windowMs) break;
    if (t.side === 'sell') { sellUsd += t.sol * solUsd; sellers.add(t.trader); } else { buyUsd += t.sol * solUsd; buyers.add(t.trader); }
  }
  return { buyUsd, sellUsd, buyers: buyers.size, sellers: sellers.size, ratio: sellUsd > 0 ? buyUsd / sellUsd : buyUsd > 0 ? Infinity : 0 };
}

/** Selling now vs the heaviest selling since `sinceTs`, in windows of windowMs (lower = sellers exhausted). */
export function sellExhaustion(trades, now, sinceTs, windowMs) {
  const buckets = new Map();
  for (const t of trades) {
    if (t.ts < sinceTs || t.side !== 'sell') continue;
    const b = Math.floor(t.ts / windowMs);
    buckets.set(b, (buckets.get(b) ?? 0) + t.sol);
  }
  const maxSell = Math.max(0, ...buckets.values());
  if (!(maxSell > 0)) return null;
  let recent = 0;
  for (const t of trades) if (t.side === 'sell' && now - t.ts <= windowMs) recent += t.sol;
  return recent / maxSell;
}

const fmtK = (x) => (x == null || !Number.isFinite(x) ? '?' : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}K` : `$${x.toFixed(0)}`);
const pct = (x) => `${x.toFixed(0)}%`;
const cond = (key, label, ok, detail = '') => ({ key, label, ok, detail });

/** Levels and reward/risk for an entry at the current market cap. */
function plan(ctx, cfg, floorMc) {
  const entryMc = ctx.mcUsd;
  const stopByPct = entryMc * (1 - cfg.stopPct / 100);
  // invalidation: just under the floor if that is tighter than the % stop, never looser
  const stopMc = floorMc ? Math.max(stopByPct, floorMc * 0.96) : stopByPct;
  const targetMc = entryMc * (1 + cfg.targetPct / 100);
  const riskPct = (1 - stopMc / entryMc) * 100;
  return {
    entry: { mcUsd: entryMc, priceUsd: entryMc / ctx.supply },
    invalidation: { mcUsd: stopMc, priceUsd: stopMc / ctx.supply, pct: riskPct,
      why: floorMc && stopMc > stopByPct ? `just below the support floor (${fmtK(floorMc)})` : `${cfg.stopPct}% below entry` },
    target: { mcUsd: targetMc, priceUsd: targetMc / ctx.supply, pct: cfg.targetPct },
    rewardRisk: riskPct > 0 ? cfg.targetPct / riskPct : null,
  };
}

/** Shared hard rules: safety verdict must not be AVOID; unknown safety is not a pass. */
function safetyCond(ctx) {
  if (!ctx.safety) return cond('safety', 'Safety checked and not AVOID', null, 'The bot has not finished its safety check for this coin');
  const bad = (ctx.safety.flags ?? []).filter((f) => f.level === 'bad').map((f) => f.text);
  return cond('safety', 'Safety checked and not AVOID', ctx.safety.verdict !== 'AVOID', `${ctx.safety.verdict}${bad.length ? ` · ${bad[0]}` : ''}`);
}

function finish(setup, conds, { hard = [], forming, levels = null, notes = [] }) {
  const failedHard = conds.find((c) => hard.includes(c.key) && c.ok === false);
  const allOk = conds.every((c) => c.ok === true);
  const phase = failedHard ? 'rejected' : allOk ? 'signal' : forming ? 'watching' : 'idle';
  return { setup, phase, conditions: conds, rejectReason: failedHard ? `${failedHard.label}: ${failedHard.detail}` : null,
    unconfirmed: conds.filter((c) => c.ok !== true).map((c) => c.label), ...(levels ?? {}), notes };
}

// ------------------------------------------------------------------ setups

/**
 * ctx for curve coins: { now, supply, ageMin, launchMcUsd, mcUsd, candles (MC USD), trades, solUsd, safety, narrative,
 *   insiders: {heldAtEvalPct, heldNowPct} | null, devSold, devSoldPct, bundleHeldPct, migrated, dev: {graduated, rugged, tracked, blocked} }
 */
export function evalNewPairs(ctx, cfg) {
  const cs = ctx.candles;
  const conds = [];
  conds.push(cond('age', `Under ${cfg.maxAgeMin} min old`, ctx.ageMin <= cfg.maxAgeMin, `${ctx.ageMin.toFixed(1)} min`));
  if (ctx.migrated) conds.push(cond('curve', 'Still on the bonding curve', false, 'graduated'));
  conds.push(safetyCond(ctx));
  conds.push(cond('bundles', `Bundles hold under ${cfg.maxBundleHeldPct}%`, ctx.bundleHeldPct == null ? null : ctx.bundleHeldPct <= cfg.maxBundleHeldPct,
    ctx.bundleHeldPct == null ? 'bundle check not available yet' : `${ctx.bundleHeldPct.toFixed(1)}% still held by launch-block wallets`));
  conds.push(cond('narrative', `Narrative score ${cfg.minNarrative}+`, ctx.narrative == null ? null : ctx.narrative >= cfg.minNarrative,
    ctx.narrative == null ? 'not scored yet' : `${ctx.narrative}`));
  const pk = peakIndex(cs);
  const peak = pk >= 0 ? cs[pk].h : null;
  const run = peak && ctx.launchMcUsd ? peak / ctx.launchMcUsd : null;
  conds.push(cond('run', `Launch ran ${cfg.minRunMult}x+ first`, run == null ? null : run >= cfg.minRunMult,
    run == null ? 'no data' : `${fmtK(ctx.launchMcUsd)} → high ${fmtK(peak)} (${run.toFixed(1)}x)`));
  const pb = peak ? (1 - ctx.mcUsd / peak) * 100 : null;
  conds.push(cond('pullback', `Pulled back ${cfg.pullbackMinPct}–${cfg.pullbackMaxPct}% from the high`, pb == null ? null : pb >= cfg.pullbackMinPct && pb <= cfg.pullbackMaxPct,
    pb == null ? 'no data' : `${pct(pb)} below the high, now ${fmtK(ctx.mcUsd)}`));
  const notChasing = pk >= 0 && cs.length - 1 - pk >= cfg.floorCandles;
  conds.push(cond('nochase', 'Not chasing: the high is behind us', pk < 0 ? null : notChasing, pk < 0 ? 'no data' : `high was ${cs.length - 1 - pk} candles ago`));
  const fl = rangeOf(cs, cfg.floorCandles);
  conds.push(cond('floor', `Support floor: last ${cfg.floorCandles} candles within ${cfg.floorMaxRangePct}% and no new low`, fl == null ? null : fl.widthPct <= cfg.floorMaxRangePct && fl.floorHeld,
    fl == null ? 'not enough candles' : `range ${pct(fl.widthPct)}, floor ${fmtK(fl.low)}${fl.floorHeld ? ', holding' : ', broke lower'}`));
  const f = flowOf(ctx.trades, ctx.now, cfg.flowWindowSec * 1000, ctx.solUsd);
  conds.push(cond('buying', `Buying pressure: buys ${cfg.minBuyRatio}x sells, ${cfg.minBuyers}+ buyers in ${cfg.flowWindowSec}s`,
    f.ratio >= cfg.minBuyRatio && f.buyers >= cfg.minBuyers, `${fmtK(f.buyUsd)} bought vs ${fmtK(f.sellUsd)} sold, ${f.buyers} buyers`));
  const forming = run != null && run >= cfg.minRunMult && pb != null && pb >= cfg.pullbackMinPct * 0.7 && ctx.ageMin <= cfg.maxAgeMin;
  return finish('newPairs', conds, { hard: ['age', 'curve', 'safety', 'bundles'], forming, levels: plan(ctx, cfg, fl?.low) });
}

export function evalFinalA(ctx, cfg) {
  const cs = ctx.candles;
  const conds = [];
  if (ctx.migrated) conds.push(cond('curve', 'Still on the bonding curve', false, 'graduated'));
  conds.push(safetyCond(ctx));
  const pk = peakIndex(cs);
  const peak = pk >= 0 ? cs[pk].h : null;
  conds.push(cond('run', `Ran to ${fmtK(cfg.minPeakMcUsd)}+`, peak == null ? null : peak >= cfg.minPeakMcUsd, `high ${fmtK(peak)}`));
  const sold = ctx.insiders && ctx.insiders.heldAtEvalPct > 1 ? (1 - ctx.insiders.heldNowPct / ctx.insiders.heldAtEvalPct) * 100 : null;
  const insiderOk = sold != null ? sold >= cfg.insiderSoldPct : ctx.devSold ? true : null;
  conds.push(cond('insiders', `Bundle / tracked wallets sold ${cfg.insiderSoldPct}%+ of their bag`, cfg.requireInsiderSelling ? insiderOk : true,
    sold != null ? `launch-block and linked wallets sold ${pct(Math.max(0, sold))}` : ctx.devSold ? `dev sold ${pct(ctx.devSoldPct ?? 0)}` : 'no bundle wallets identified yet'));
  const pb = peak ? (1 - ctx.mcUsd / peak) * 100 : null;
  conds.push(cond('pullback', `Retraced ${cfg.pullbackMinPct}–${cfg.pullbackMaxPct}% from the high`, pb == null ? null : pb >= cfg.pullbackMinPct && pb <= cfg.pullbackMaxPct,
    pb == null ? 'no data' : `${pct(pb)} below ${fmtK(peak)}, now ${fmtK(ctx.mcUsd)}`));
  const fl = rangeOf(cs, cfg.floorCandles);
  conds.push(cond('floor', `Support: last ${cfg.floorCandles} candles within ${cfg.floorMaxRangePct}%, floor holding`, fl == null ? null : fl.widthPct <= cfg.floorMaxRangePct && fl.floorHeld,
    fl == null ? 'not enough candles' : `range ${pct(fl.widthPct)}, floor ${fmtK(fl.low)}`));
  const ex = pk >= 0 ? sellExhaustion(ctx.trades, ctx.now, cs[pk].t * 1000, cfg.flowWindowSec * 1000) : null;
  conds.push(cond('exhausted', 'Sellers exhausted', ex == null ? null : ex <= cfg.sellExhaustRatio,
    ex == null ? 'no selling recorded' : `selling now is ${pct(ex * 100)} of the heaviest selling since the high`));
  const f = flowOf(ctx.trades, ctx.now, cfg.flowWindowSec * 1000, ctx.solUsd);
  conds.push(cond('demand', `Renewed demand: buys ${cfg.minBuyRatio}x sells`, f.buyUsd > 0 && f.ratio >= cfg.minBuyRatio, `${fmtK(f.buyUsd)} bought vs ${fmtK(f.sellUsd)} sold`));
  const forming = peak != null && peak >= cfg.minPeakMcUsd && pb != null && pb >= cfg.pullbackMinPct * 0.7;
  return finish('finalA', conds, { hard: ['curve', 'safety'], forming, levels: plan(ctx, cfg, fl?.low) });
}

export function evalFinalB(ctx, cfg) {
  const cs = ctx.candles;
  const conds = [];
  if (ctx.migrated) conds.push(cond('curve', 'Still on the bonding curve', false, 'graduated'));
  conds.push(safetyCond(ctx));
  const pk = peakIndex(cs);
  const peak = pk >= 0 ? cs[pk].h : null;
  conds.push(cond('size', `Local high above ${fmtK(cfg.minPeakMcUsd)}`, peak == null ? null : peak >= cfg.minPeakMcUsd, `high ${fmtK(peak)}`));
  const lowBefore = pk > 0 ? Math.min(...cs.slice(0, pk).map((c) => c.l)) : null;
  const rise = lowBefore ? (peak / lowBefore - 1) * 100 : null;
  conds.push(cond('meaningful', `Meaningful high: rose ${cfg.minRiseToHighPct}%+ into it`, rise == null ? null : rise >= cfg.minRiseToHighPct,
    rise == null ? 'no data' : `${fmtK(lowBefore)} → ${fmtK(peak)} (+${pct(rise)})`));
  const pb = peak ? (1 - ctx.mcUsd / peak) * 100 : null;
  conds.push(cond('pullback', `Retraced ${cfg.pullbackMinPct}–${cfg.pullbackMaxPct}%`, pb == null ? null : pb >= cfg.pullbackMinPct && pb <= cfg.pullbackMaxPct,
    pb == null ? 'no data' : `${pct(pb)} below the high, now ${fmtK(ctx.mcUsd)}`));
  const fl = rangeOf(cs, cfg.floorCandles);
  conds.push(cond('stable', `Stabilized: last ${cfg.floorCandles} candles within ${cfg.floorMaxRangePct}%`, fl == null ? null : fl.widthPct <= cfg.floorMaxRangePct && fl.floorHeld,
    fl == null ? 'not enough candles' : `range ${pct(fl.widthPct)}, floor ${fmtK(fl.low)}`));
  const f = flowOf(ctx.trades, ctx.now, cfg.flowWindowSec * 1000, ctx.solUsd);
  conds.push(cond('buying', `Buying confirmation: buys ${cfg.minBuyRatio}x sells`, f.buyUsd > 0 && f.ratio >= cfg.minBuyRatio, `${fmtK(f.buyUsd)} bought vs ${fmtK(f.sellUsd)} sold`));
  const forming = peak != null && peak >= cfg.minPeakMcUsd && pb != null && pb >= cfg.pullbackMinPct * 0.7;
  return finish('finalB', conds, { hard: ['curve', 'safety'], forming, levels: plan(ctx, cfg, fl?.low) });
}

export function evalFinalC(ctx, cfg) {
  const cs = ctx.candles;
  const conds = [];
  const d = ctx.dev ?? null;
  if (ctx.migrated) conds.push(cond('curve', 'Still on the bonding curve', false, 'graduated'));
  conds.push(safetyCond(ctx));
  conds.push(cond('notblocked', 'Developer not flagged', d == null ? null : !d.blocked && d.rugged <= cfg.maxDevRugs,
    d == null ? 'no developer history' : d.blocked ? 'on your blocked list' : `${d.rugged} past rug${d.rugged === 1 ? '' : 's'} seen`));
  const reputable = d && (d.tracked || d.graduated >= cfg.minDevGraduated);
  conds.push(cond('reputation', 'Developer has a successful track record', d == null ? null : Boolean(reputable),
    d == null ? 'no developer history' : d.tracked ? `on your tracked list${d.label ? ` (${d.label})` : ''}` : `${d.graduated} graduated coin${d.graduated === 1 ? '' : 's'} of ${d.finished} seen`));
  conds.push(cond('launch', `Launch observed (${cfg.minAgeMin}+ min of trading)`, ctx.ageMin >= cfg.minAgeMin, `${ctx.ageMin.toFixed(1)} min old`));
  const pk = peakIndex(cs);
  const ex = pk >= 0 ? sellExhaustion(ctx.trades, ctx.now, cs[pk].t * 1000, cfg.flowWindowSec * 1000) : null;
  conds.push(cond('exhausted', 'Selling pressure exhausted', ex == null ? null : ex <= cfg.sellExhaustRatio,
    ex == null ? 'no selling recorded' : `selling now is ${pct(ex * 100)} of its peak`));
  const rg = rangeOf(cs, cfg.rangeCandles + 1);
  const sideways = rg && ((rg.highBeforeLast - Math.min(...cs.slice(-(cfg.rangeCandles + 1), -1).map((c) => c.l))) / Math.min(...cs.slice(-(cfg.rangeCandles + 1), -1).map((c) => c.l))) * 100;
  conds.push(cond('range', `Sideways: ${cfg.rangeCandles} candles within ${cfg.rangeMaxPct}%`, rg == null ? null : sideways <= cfg.rangeMaxPct,
    rg == null ? 'not enough candles' : `range ${pct(sideways)}`));
  const breakout = rg ? rg.last.c > rg.highBeforeLast : null;
  const f = flowOf(ctx.trades, ctx.now, cfg.flowWindowSec * 1000, ctx.solUsd);
  conds.push(cond('breakout', 'Upward momentum: closes above the range with buyers', breakout == null ? null : breakout && f.ratio >= cfg.minBuyRatio,
    breakout == null ? 'no data' : `${breakout ? 'closed above' : 'still inside'} the range high ${fmtK(rg.highBeforeLast)}, buys ${Number.isFinite(f.ratio) ? f.ratio.toFixed(1) : '∞'}x sells`));
  const lowOfRange = rg ? Math.min(...cs.slice(-(cfg.rangeCandles + 1), -1).map((c) => c.l)) : null;
  const forming = Boolean(reputable) && !(d?.blocked);
  return finish('finalC', conds, { hard: ['curve', 'safety', 'notblocked'], forming, levels: plan(ctx, cfg, lowOfRange) });
}

/** ctx for migrated coins: { now, supply, ageMin, ageBasis, mcUsd, liqUsd, candles (MC USD, 5m), safety? } */
export function evalMigrated(ctx, cfg) {
  const cs = ctx.candles;
  const conds = [];
  conds.push(cond('age', `${cfg.minAgeMin / 60}–${cfg.maxAgeMin / 60} h old`, ctx.ageMin == null ? null : ctx.ageMin >= cfg.minAgeMin && ctx.ageMin <= cfg.maxAgeMin,
    ctx.ageMin == null ? 'age unknown' : `${(ctx.ageMin / 60).toFixed(1)} h${ctx.ageBasis ? ` (${ctx.ageBasis})` : ''}`));
  conds.push(cond('liquidity', `Pool liquidity ${fmtK(cfg.minLiqUsd)}+`, ctx.liqUsd == null ? null : ctx.liqUsd >= cfg.minLiqUsd, ctx.liqUsd == null ? 'unknown' : fmtK(ctx.liqUsd)));
  if (ctx.safety) conds.push(safetyCond(ctx));
  const pk = peakIndex(cs);
  const peak = pk >= 0 ? cs[pk].h : null;
  conds.push(cond('high', `Prior high ${fmtK(cfg.minPeakMcUsd)}+`, peak == null ? null : peak >= cfg.minPeakMcUsd, `high ${fmtK(peak)}`));
  const pb = peak ? (1 - ctx.mcUsd / peak) * 100 : null;
  conds.push(cond('pullback', `Pulled back ${cfg.pullbackMinPct}–${cfg.pullbackMaxPct}%`, pb == null ? null : pb >= cfg.pullbackMinPct && pb <= cfg.pullbackMaxPct,
    pb == null ? 'no data' : `${pct(pb)} below the high, now ${fmtK(ctx.mcUsd)}`));
  const rg = rangeOf(cs, cfg.rangeCandles + 1);
  const box = rg ? cs.slice(-(cfg.rangeCandles + 1), -1) : null;
  const boxLow = box ? Math.min(...box.map((c) => c.l)) : null, boxHigh = box ? Math.max(...box.map((c) => c.h)) : null;
  conds.push(cond('support', `Support between ${fmtK(cfg.supportMinMcUsd)} and ${fmtK(cfg.supportMaxMcUsd)}`, boxLow == null ? null : boxLow >= cfg.supportMinMcUsd * 0.9 && boxLow <= cfg.supportMaxMcUsd * 1.1,
    boxLow == null ? 'not enough candles' : `floor ${fmtK(boxLow)}`));
  const width = boxLow ? ((boxHigh - boxLow) / boxLow) * 100 : null;
  conds.push(cond('sideways', `${cfg.rangeCandles} candles sideways (within ${cfg.rangeMaxPct}%)`, width == null ? null : width <= cfg.rangeMaxPct,
    width == null ? 'not enough candles' : `range ${pct(width)}`));
  const holding = rg ? rg.last.l >= boxLow * 0.97 : null;
  conds.push(cond('holding', 'Support floor holding', holding, holding == null ? 'no data' : holding ? 'no break below the floor' : 'broke below the floor'));
  const brk = rg ? rg.last.c > boxHigh && rg.last.v >= rg.avgVol * cfg.breakoutVolMult : null;
  conds.push(cond('breakout', `Breakout: close above the range on ${cfg.breakoutVolMult}x volume`, brk,
    brk == null ? 'no data' : `last close ${fmtK(rg.last.c)} vs range high ${fmtK(boxHigh)}, volume ${rg.avgVol > 0 ? (rg.last.v / rg.avgVol).toFixed(1) : '?'}x average`));
  const forming = peak != null && peak >= cfg.minPeakMcUsd && pb != null && pb >= cfg.pullbackMinPct * 0.8;
  return finish('migrated', conds, { hard: ['age', 'safety'], forming, levels: plan(ctx, cfg, boxLow) });
}

export const EVALUATORS = { newPairs: evalNewPairs, finalA: evalFinalA, finalB: evalFinalB, finalC: evalFinalC, migrated: evalMigrated };

/** Merge saved settings over defaults; only known keys with valid numbers/booleans are accepted. */
export function mergeConfig(saved = {}) {
  const out = {};
  for (const [id, s] of Object.entries(SETUPS)) {
    out[id] = { ...s.defaults };
    for (const [k, v] of Object.entries(saved?.[id] ?? {})) {
      if (!(k in s.defaults)) continue;
      if (typeof s.defaults[k] === 'boolean') out[id][k] = Boolean(v);
      else if (Number.isFinite(Number(v)) && Number(v) >= 0) out[id][k] = Number(v);
    }
  }
  return out;
}
