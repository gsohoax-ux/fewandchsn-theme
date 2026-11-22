// Dashboard analytics: one place that pulls the headline numbers together from the parts that own them.
// Each paper-trading system is reported separately; nothing is mixed.
import { tradeStats } from './paperbook.js';

export function analytics({ engine, store, paper = null, manual = null, strategy = null, trends = null, now = Date.now() }) {
  const s = engine.status();
  const coins = [...engine.coins.values()];
  const scored = coins.filter((c) => c.result);
  const passing = scored.filter((c) => c.result.safety.verdict !== 'AVOID');
  const runners = scored.filter((c) => c.result.runner?.is && !c.migrated);
  const tv = trends ? engine.trendView() : null;
  const st = store.stats();
  // System A (automatic, alerts) from its own trade table
  const a = paper?.enabled ? paper.view(engine.coins, engine.solUsd) : null;
  const autoClosed = store.paperTradesSince(0).map((t) => {
    const pnlSol = t.proceeds_sol - t.cost_sol;
    return { closedAt: t.closed_at, pnlUsd: pnlSol * (engine.solUsd || 0), pnlPct: t.cost_sol ? (pnlSol / t.cost_sol) * 100 : 0, holdSec: (t.closed_at - t.opened_at) / 1000 };
  });
  return {
    at: now,
    market: { regime: s.regime, solUsd: s.solUsd, feedConnected: s.feedConnected },
    discovery: {
      launchesSeen: s.launches, tracking: s.tracked, scored: s.pipeline.scored,
      passingSafety: s.pipeline.scored - s.pipeline.filtered, passingNow: passing.length, filtered: s.pipeline.filtered,
      safePct: s.pipeline.scored ? Math.round(((s.pipeline.scored - s.pipeline.filtered) / s.pipeline.scored) * 100) : null,
      runnersNow: runners.length, alertsSession: s.alerts, alerts7d: st.alerts, alertBar: s.alertMinScore, alertAdaptive: s.alertAdaptive,
      hit2xAfterAlert7d: st.hit2x, graduatedAfterAlert7d: st.migrated,
    },
    trends: { active: tv ? tv.topics.filter((t) => t.qualified).length : 0, watching: tv ? tv.topics.length : 0, sources: tv?.sources ?? {} },
    auto: a ? { label: 'Automatic (alerts)', today: a.winLoss?.today ?? null, allTime: a.winLoss?.allTime ?? null, pnlAllTimeUsd: a.allTime?.pnlUsd ?? null,
      open: a.open.length, ...pick(tradeStats(autoClosed), ['trades', 'winRate', 'profitFactor', 'profitFactorInfinite', 'avgReturnPct', 'maxDrawdownUsd', 'netUsd']) } : null,
    strategy: strategy ? { label: 'Strategy (Setuh)', open: strategy.book.open.size, ...pick(strategy.book.summary(), ['trades', 'winRate', 'profitFactor', 'profitFactorInfinite', 'avgReturnPct', 'maxDrawdownUsd', 'netUsd', 'pnlUsd']) } : null,
    manual: manual ? { label: 'Manual', open: manual.book.open.size, ...pick(manual.book.summary(), ['trades', 'winRate', 'profitFactor', 'profitFactorInfinite', 'avgReturnPct', 'maxDrawdownUsd', 'netUsd', 'pnlUsd']) } : null,
  };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
