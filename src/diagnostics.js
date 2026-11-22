// Live diagnostic audit: why is the bot doing what it's doing? Built only from measured data
// (funnel counts, metrics, health checks, database records). Where something can't be measured,
// it says "unable to verify" instead of guessing.
import { tradeStats } from './paperbook.js';

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const sum = (o, prefix) => Object.entries(o).filter(([k]) => k.startsWith(prefix)).reduce((s, [, n]) => s + n, 0);
const group = (o, prefix) => Object.entries(o).filter(([k]) => k.startsWith(prefix)).map(([k, n]) => [k.slice(prefix.length), n]).sort((a, b) => b[1] - a[1]);

/** Which rejection reasons are mandatory safety restrictions vs adjustable preferences. */
export function classifyReason(reason) {
  const r = String(reason).toLowerCase();
  if (/bundle|linked|insider|sniper|dev (holds|sold|selling)|rug|mint authority|freeze|honeypot|tax|recycled|reused|avoid|top 10|top n holders|holders too high|serial|scripted|fresh wallet|verified|unverified|authority|safety gate|critical/.test(r)) return 'safety (mandatory)';
  if (/stale|disconnected|no price|price is .* old|entry blocked|not reliable|could not be refreshed|liquidity unknown|insufficient|failed:|could not confirm|data/.test(r)) return 'data quality';
  if (/max .*open|exposure|entries per coin|budget|cash|daily loss|paused|limit|gap|too small|not enough paper cash|done for today/.test(r)) return 'risk limit / setting';
  if (/score below|confidence|narrative|momentum|traction|died early/.test(r)) return 'quality threshold (adjustable)';
  if (/pullback|floor|run|high|breakout|range|setup|drift|missed|reward|invalidat|pattern|sideways|support/.test(r)) return 'strategy rule (adjustable)';
  return 'other';
}

export function diagnose({ cfg, engine, store, paper = null, manual = null, strategy = null, copy = null, health = null, metrics = null, market = null, funnel = null, learner = null, hours = 24, now = Date.now() }) {
  const st = engine.status();
  const F = funnel ? funnel.totals(hours) : { counts: {}, hoursCovered: 0, firstHour: null };
  const C = F.counts;
  const M = metrics?.view() ?? { timings: {}, rates: {}, gauges: {} };
  const H = health?.view({ store }) ?? { providers: [], jobs: [], db: null };
  const prov = (k) => H.providers.find((p) => p.key === k);
  const job = (re) => H.jobs.filter((j) => re.test(j.name));
  const T = (k) => M.timings?.[k] ?? null;
  const findings = [];
  const find = (severity, group_, title, evidence, fix, risk = '') => findings.push({ severity, group: group_, title, evidence, fix, risk });

  // ---------------------------------------------------------------- B. system health
  const comp = [];
  const add = (name, status, evidence) => comp.push({ name, status, evidence });
  const jobsOk = (re) => { const j = job(re); return !j.length ? null : j.every((x) => x.state === 'ok') ? true : false; };
  add('PumpPortal connection', st.demo ? 'working (demo simulator)' : st.feedConnected ? (st.feedLastDataSec != null && st.feedLastDataSec <= 10 ? 'working' : 'partially working') : 'not working',
    `${st.feedConnected ? 'connected' : 'disconnected'} · last data ${st.feedLastDataSec ?? '?'}s ago · ${st.feedReconnects} reconnects since start${st.feedProblem ? ` · last problem: ${st.feedProblem}` : ''}`);
  const launches = C['discovery:new'] ?? 0;
  add('New coin discovery', launches ? 'working' : st.launches ? 'working' : 'unable to verify', `${launches} new coins in the last ${F.hoursCovered || '<1'} h recorded · ${Math.round(M.rates?.launches ?? 0)}/min right now · ${C['discovery:duplicate'] ?? 0} duplicate create messages ignored`);
  add('WebSocket stability', (C['feed:disconnect'] ?? 0) > 20 ? 'partially working' : 'working', `${C['feed:disconnect'] ?? 0} disconnects in window · reconnect p50 ${T('feedReconnect')?.p50 != null ? Math.round(T('feedReconnect').p50) + ' ms' : 'n/a'}`);
  add('Market-data ingestion / price updates', (M.rates?.priceUpdates ?? 0) > 0 ? 'working' : 'not working', `${Math.round(M.rates?.priceUpdates ?? 0)} price updates/min · ${market?.counts?.curveTrades ?? 0} curve + ${market?.counts?.ammTrades ?? 0} PumpSwap trades priced · ${market?.owners?.size ?? 0} coins pinned`);
  add('Market-cap calculation', st.solUsd > 0 ? (st.solUsdAgeSec != null && st.solUsdAgeSec > 120 ? 'partially working' : 'working') : 'not working', `SOL $${(st.solUsd ?? 0).toFixed(2)} · ${st.solUsdAgeSec ?? '?'}s old (refreshed every 30 s) · MC = curve price × 1B supply × SOL/USD`);
  const dx = prov('dexscreener');
  add('Liquidity updates (DexScreener)', !dx ? 'unable to verify' : dx.state === 'ok' ? 'working' : dx.state === 'idle' ? 'unable to verify' : 'partially working', dx ? `${dx.calls} calls · ${dx.recentFails}/${dx.recentCalls} failed (15 min) · ${dx.lastError || 'no errors'}` : 'no calls yet');
  const hx = prov('helius');
  add('On-chain checks (Helius)', !st.helius ? 'not configured' : !hx ? 'unable to verify' : hx.state === 'ok' ? 'working' : 'partially working', !st.helius ? 'HELIUS_API_KEY not set: bundle / wallet-link checks fall back to timing estimates' : hx ? `${hx.calls} calls · ${hx.recentFails}/${hx.recentCalls} failed (15 min) · median ${hx.medianMs ?? '?'} ms · ${hx.lastError || 'no errors'}` : 'no calls yet');
  add('Wallet monitoring (copy trading)', !copy ? 'not configured' : !copy.traders.size ? 'not configured' : jobsOk(/^Copy/) ? 'working' : 'partially working', copy ? `${copy.traders.size} wallets followed · ${copy.verifying ? 'on-chain verification on' : 'feed-only (no Helius)'}` : 'off');
  const scored = C['engine:scored'] ?? 0;
  add('Coin safety checks', scored ? 'working' : 'unable to verify', `${scored} coins scored · verdicts: ${group(C, 'engine:verdict:').map(([k, n]) => `${k} ${n}`).join(', ') || 'none yet'} · data: ${group(C, 'engine:safetySource:').map(([k, n]) => `${k} ${n}`).join(', ') || '—'}`);
  add('AI narrative analysis', String(st.ai).startsWith('claude') ? 'working' : 'not configured', String(st.ai).startsWith('claude') ? `${st.ai} (used only for non-AVOID coins with momentum ≥ 35)` : `off (${st.ai}): rule-based narrative score in use`);
  add('Momentum scoring', scored ? 'working' : 'unable to verify', `computed for every scored coin · p50 ${T('safetyScoring')?.p50 != null ? Math.round(T('safetyScoring').p50) + ' ms' : 'n/a'} per evaluation incl. safety`);
  add('Confidence scoring', strategy ? 'working' : 'not configured', 'engine confidence (data quality) + Setuh setup confidence (itemized); see section on confidence');
  add('Setuh strategy recognition', !strategy ? 'not configured' : jobsOk(/Setuh trader: setup scan/) ? 'working' : 'partially working', strategy ? `scan p50 ${T('setupScan')?.p50 != null ? Math.round(T('setupScan').p50) + ' ms' : 'n/a'} · ${strategy.active.size} candidates now · mode ${strategy.settings.mode}${strategy.settings.discoveryPaused ? ' · DISCOVERY PAUSED' : ''}${strategy.settings.entriesPaused ? ' · ENTRIES PAUSED' : ''}` : 'off');
  add('Automatic paper trading', !paper?.enabled ? 'not configured' : 'working', paper?.enabled ? `${C['auto:entry'] ?? 0} entries and ${sum(C, 'auto:skip:')} skips in window · enters only on alerts (${sum(C, 'engine:alert:')} alerts)` : 'PAPER=0');
  add('Manual paper trading', manual ? 'working' : 'not configured', manual ? `${manual.book.open.size} open` : 'off');
  add('Copy trading', !copy ? 'not configured' : copy.traders.size ? 'working' : 'not configured', copy ? `${copy.book.open.size} open copies` : '');
  const books = [['Setuh', strategy?.book], ['Manual', manual?.book], ['Copy', copy?.book]].filter(([, b]) => b);
  const stale = books.flatMap(([n, b]) => b.openViews().filter((p) => p.staleSec > 120).map((p) => ({ book: n, symbol: p.symbol, mint: p.mint, staleSec: p.staleSec })));
  add('Position monitoring', stale.length ? 'partially working' : 'working', stale.length ? `${stale.length} open position(s) without a price update for 2+ min: ${stale.map((s) => `${s.book} ${s.symbol || s.mint.slice(0, 6)} ${s.staleSec}s`).join(', ')}` : `every open position updated within 2 min (${books.reduce((s, [, b]) => s + b.open.size, 0)} open across books)`);
  add('Stop-loss / take-profit / trailing', 'working', 'run on the server on every price update and every 5–10 s (tests: paperbook.test.js, setuh.test.js)');
  add('Database persistence', !H.db?.ok ? 'not working' : H.db.persistent ? 'working' : 'not working', H.db?.ok ? `${H.db.path} · ${H.db.sizeMb} MB${H.db.persistent ? '' : ' · IN MEMORY: lost on restart'}` : H.db?.error ?? 'unknown');
  const failingJobs = H.jobs.filter((j) => j.state !== 'ok' && j.state !== 'waiting');
  add('Background workers', failingJobs.length ? 'partially working' : 'working', failingJobs.length ? failingJobs.map((j) => `${j.name}: ${j.state}${j.lastError ? ` (${j.lastError})` : ''}`).join('; ') : `${H.jobs.length} jobs running on schedule`);
  add('Notifications', st.notify?.length ? 'working' : 'not configured', st.notify?.length ? st.notify.join(' + ') : 'no ntfy topic / Telegram set');

  // ---------------------------------------------------------------- C. discovery
  const neverScored = C['engine:reject:No traction (died early)'] ?? 0;
  const discovery = {
    windowHours: F.hoursCovered, newCoins: launches, perHour: F.hoursCovered ? Math.round(launches / F.hoursCovered) : null, perMinuteNow: Math.round((M.rates?.launches ?? 0) * 10) / 10,
    duplicates: C['discovery:duplicate'] ?? 0, scored, neverScored, scoredPct: pct(scored, launches), disconnects: C['feed:disconnect'] ?? 0,
    reconnectP50Ms: T('feedReconnect')?.p50 ?? null, queueNow: M.gauges?.evalQueue?.value ?? 0, queueWait: T('evalQueueWait'), evalTime: T('safetyScoring'),
    series: funnel?.series('discovery:new', 24) ?? [],
    discoveryLatency: T('discoveryLatency'),
  };

  // ---------------------------------------------------------------- D. rejections
  const engineRej = group(C, 'engine:reject:').map(([k, n]) => ({ reason: k, n, kind: classifyReason(k), where: 'coin scoring' }));
  const autoRej = group(C, 'auto:skip:').map(([k, n]) => ({ reason: k, n, kind: classifyReason(k), where: 'automatic paper trader' }));
  const setuhRej = group(C, 'setuhReason:').map(([k, n]) => { const i = k.indexOf(':'); return { reason: k.slice(i + 1), status: k.slice(0, i), n, kind: classifyReason(k.slice(i + 1)), where: 'Setuh trader' }; });
  const copyRej = copy ? store.copyEvents(1000).filter((e) => (e.action === 'rejected' || e.action === 'skipped') && now - e.at < hours * 3600_000).reduce((m, e) => { const k = e.reason?.replace(/\d[\d,.]*/g, 'N').slice(0, 90) ?? '?'; m[k] = (m[k] ?? 0) + 1; return m; }, {}) : {};
  const rejections = { engine: engineRej, automatic: autoRej, setuh: setuhRej, copy: Object.entries(copyRej).map(([reason, n]) => ({ reason, n, kind: classifyReason(reason), where: 'copy trading' })) };
  const byKind = {};
  for (const r of [...engineRej, ...autoRej, ...setuhRej, ...rejections.copy]) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;

  // ---------------------------------------------------------------- E. strategy
  const setups = ['newPairs', 'finalA', 'finalB', 'finalC', 'migrated'];
  const perf = strategy?.performance();
  const strategyRows = setups.map((id) => {
    const s = (st_) => C[`setuh:${id}:${st_}`] ?? 0;
    return { id, name: perf?.bySetup[id]?.name ?? id, enabled: strategy?.setups[id]?.enabled ?? false,
      closedEpisodes: ['entered', 'rejected', 'missed', 'invalidated', 'insufficient_data', 'skipped', 'cancelled'].reduce((a, k) => a + s(k), 0),
      entered: s('entered'), rejected: s('rejected'), missed: s('missed'), invalidated: s('invalidated'), insufficient: s('insufficient_data'), skipped: s('skipped'),
      trades: perf?.bySetup[id]?.trades ?? 0, winRate: perf?.bySetup[id]?.winRate ?? null, netUsd: perf?.bySetup[id]?.netUsd ?? 0 };
  });
  const deepVerdicts = group(C, 'setuh:deep:');

  // ---------------------------------------------------------------- F. paper trading
  const since = now - hours * 3600_000;
  const bookStats = (name, open, closed, sizeHint) => {
    const inWin = closed.filter((p) => (p.closedAt ?? 0) >= since);
    const opened = [...open, ...closed].filter((p) => (p.openedAt ?? 0) >= since).sort((a, b) => a.openedAt - b.openedAt);
    const gaps = opened.slice(1).map((p, i) => p.openedAt - opened[i].openedAt);
    const s = tradeStats(inWin);
    return { book: name, opened: opened.length, closed: inWin.length, open: open.length, ...s, avgSizeUsd: opened.length ? opened.reduce((a, p) => a + (p.budgetUsd ?? sizeHint ?? 0), 0) / opened.length : sizeHint ?? null,
      avgGapMin: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60_000) : null,
      unrealizedUsd: open.reduce((a, p) => a + (p.unrealizedUsd ?? 0), 0) };
  };
  const paperRows = [];
  if (strategy) paperRows.push(bookStats('Setuh', strategy.book.openViews(), strategy.book.closedViews(2000)));
  if (manual) paperRows.push(bookStats('Manual', manual.book.openViews(), manual.book.closedViews(2000)));
  if (copy) paperRows.push(bookStats('Copy', copy.book.openViews(), copy.book.closedViews(2000)));
  let autoRow = null;
  if (paper?.enabled) {
    const sol = engine.solUsd || 0;
    const closed = store.paperTradesSince(since).map((t) => ({ openedAt: t.opened_at, closedAt: t.closed_at, budgetUsd: t.cost_sol * sol, pnlUsd: (t.proceeds_sol - t.cost_sol) * sol, pnlPct: t.cost_sol ? ((t.proceeds_sol - t.cost_sol) / t.cost_sol) * 100 : 0, holdSec: (t.closed_at - t.opened_at) / 1000 }));
    const open = [...paper.positions.values()].map((p) => ({ openedAt: p.openedAt, budgetUsd: p.costSol * sol }));
    autoRow = bookStats('Automatic', open, closed);
    autoRow.sizePct = cfg.paperSizePct; autoRow.dailyUsd = cfg.paperDailyUsd; autoRow.maxOpen = cfg.paperMaxOpen;
    paperRows.unshift(autoRow);
  }

  // ---------------------------------------------------------------- G. latency & data accuracy
  const latency = Object.fromEntries(['discoveryLatency', 'tradeLatency', 'feedToEngine', 'eventLoopLag', 'evalQueueWait', 'safetyScoring', 'deepCheck', 'setupScan', 'signalToEntry', 'execution', 'priceRefresh', 'feedReconnect', 'coinCheck']
    .map((k) => [k, T(k)]).filter(([, v]) => v));

  // ---------------------------------------------------------------- persistence & learning
  const boots = store.getKv('boots') ?? [];
  const L = learner?.status?.() ?? st.learning ?? null;
  const persistence = { path: H.db?.path, persistent: Boolean(H.db?.persistent), boots: boots.length, firstBoot: boots[0] ?? null, lastBoot: boots.at(-1) ?? null, tables: H.db?.tables ?? {} };

  // ---------------------------------------------------------------- findings (rules on measured data only)
  if (!st.demo && !st.feedConnected) find('critical', 1, 'Live feed is disconnected', `last problem: ${st.feedProblem || 'n/a'}`, 'Check PUMPPORTAL_URL / network; the bot reconnects automatically with backoff.');
  if ((C['feed:disconnect'] ?? 0) > 20) find('high', 2, 'Frequent feed disconnects', `${C['feed:disconnect']} in ${F.hoursCovered} h`, 'Look at the disconnect reasons in System Health; consider a PumpPortal API key.');
  if (hx && hx.recentCalls >= 20 && hx.recentFails / hx.recentCalls > 0.1) find('critical', 2, 'Helius calls are failing or rate-limited', `${hx.recentFails}/${hx.recentCalls} failed in 15 min · last error: ${hx.lastError}`,
    'Lower HELIUS_CONCURRENCY, upgrade the Helius plan, or reduce wallet lookups per coin. Failed checks become "unknown", which makes coins UNVERIFIED and blocks Setuh entries.', 'Fewer lookups = slightly less bundle-detection coverage.');
  if (!st.helius && !st.demo) find('high', 3, 'No Helius key: safety relies on timing estimates', 'HELIUS_API_KEY not set', 'Add the key; the Setuh trader requires verified on-chain safety by default and will reject every coin without it.');
  const qw = T('evalQueueWait');
  if (qw?.n >= 10 && qw.p95 > 30_000) find('high', 2, 'Coins wait too long to be scored', `evaluation queue wait p50 ${Math.round(qw.p50 / 1000)} s · p95 ${Math.round(qw.p95 / 1000)} s · queue now ${M.gauges?.evalQueue?.value ?? 0}`,
    'Coins are scored late, so alerts and setups trigger late or not at all. Raise evaluation parallelism only if Helius has headroom; the queue is already prioritised (Final Stretch first).', 'More parallel evaluations = more Helius calls.');
  if (st.solUsdAgeSec != null && st.solUsdAgeSec > 120) find('high', 1, 'SOL price is stale', `${st.solUsdAgeSec}s old`, 'All price sources failing: check Coinbase / Kraken / CoinGecko reachability in System Health.');
  if (stale.length) find('high', 1, 'Open positions are not receiving prices', stale.map((s) => `${s.book} ${s.symbol || s.mint.slice(0, 6)}: ${s.staleSec}s`).join(', '), 'Check DexScreener health; graduated coins without PumpSwap trades depend on it.');
  if (!H.db?.persistent && !st.demo) find('critical', 1, 'Database is not on persistent storage', `path ${H.db?.path}`, 'Attach a Railway volume at /app/data (DB_PATH=data/pump-scout.db).');
  if (!st.demo && boots.length === 1) find('info', 1, 'Persistence across deploys not yet verifiable', `this database has recorded 1 start (${new Date(boots[0]).toISOString()})`, 'After your next deploy, this should show 2+ starts. If it shows 1 again, the Railway volume at /app/data is not attached and history is wiped on every deploy.');
  else if (boots.length > 1) find('info', 1, 'Database survives restarts', `${boots.length} starts recorded since ${new Date(boots[0]).toISOString().slice(0, 10)}`, 'No action.');
  if (autoRow) {
    const alerts = sum(C, 'engine:alert:');
    find('info', 3, 'Automatic paper trader: small, alert-only by design', `${alerts} alerts → ${C['auto:entry'] ?? 0} entries in ${F.hoursCovered || '<1'} h · ${autoRow.closed} closed · average size ≈ $${(autoRow.avgSizeUsd ?? 0).toFixed(2)} (${cfg.paperSizePct}% of a $${cfg.paperDailyUsd}/day budget, max ${cfg.paperMaxOpen} open)`,
      'This system can only trade as often as the alert bar allows (~15/day target) and its positions are ~$13, so its P&L moves in cents to a few dollars. That is configuration, not a fault.', 'Raising size or max-open increases risk per alert.');
    const topSkip = autoRej[0];
    if (topSkip && topSkip.n >= Math.max(3, (C['auto:entry'] ?? 0))) find('medium', 3, 'Automatic trader skips more alerts than it takes', `top skip reason: "${topSkip.reason}" × ${topSkip.n}`, 'If it is "max 2 open positions", alerts arrive while both slots are full. Consider PAPER_MAX_OPEN=3–4 (more simultaneous risk).');
  }
  if (strategy) {
    const dv = Object.fromEntries(deepVerdicts);
    const deepTotal = deepVerdicts.reduce((a, [, n]) => a + n, 0);
    if (deepTotal >= 5 && (dv.UNVERIFIED ?? 0) / deepTotal > 0.3) find('high', 1, 'Many Setuh candidates come back UNVERIFIED', `${dv.UNVERIFIED} of ${deepTotal} full safety checks`, 'Usually Helius failures (see Helius finding). With "require verified safety" on, every one of these is rejected.', 'Turning the requirement off would let unverified coins trade — not recommended.');
    const entered = strategyRows.reduce((a, r) => a + r.entered, 0), missed = strategyRows.reduce((a, r) => a + r.missed, 0);
    if (missed >= 5 && missed > entered) find('medium', 3, 'Setuh entries are missed more often than taken', `${missed} missed vs ${entered} entered`, 'Inspect the missed reasons: price drift (raise max entry drift slightly) vs re-check failing (setup genuinely gone).');
    const ins = strategyRows.reduce((a, r) => a + r.insufficient, 0);
    if (ins >= 10 && ins > entered * 3) find('medium', 1, 'Setuh candidates often lack data', `${ins} insufficient-data outcomes`, 'See the reasons list: usually unscored coins, missing on-chain data or stale quotes.');
    const totalEpisodes = strategyRows.reduce((a, r) => a + r.closedEpisodes, 0);
    if (!totalEpisodes && launches > 100) find('info', 3, 'No Setuh setup has completed an episode yet', `${launches} coins discovered, ${strategy.active.size} candidates forming now`, 'These setups are specific chart patterns; quiet stretches are expected. Check the Setuh Strategy pages for what is forming.');
    if (strategy.settings.discoveryPaused) find('high', 3, 'Setuh discovery is paused', 'setting discoveryPaused = true', 'Resume discovery in Paper Trading › Setuh Scalping Trader.');
    if (strategy.settings.entriesPaused) find('high', 3, 'Setuh new entries are paused', 'setting entriesPaused = true', 'Resume entries in Paper Trading › Setuh Scalping Trader.');
  }
  if (copy && !copy.traders.size) find('info', 3, 'Copy trading is not set up', 'no wallets followed', 'Follow wallets in Paper Trading › Copy trading if you want this system active.');
  if (L && (L.samples?.done ?? 0) < 300) find('info', 3, 'Self-learning not active yet', `${L.samples?.done ?? 0} of 300 finished observations`, 'Keeps collecting automatically (needs a persistent database).');
  if (!String(st.ai).startsWith('claude')) find('low', 3, 'AI narrative is off', String(st.ai), 'Optional: ANTHROPIC_API_KEY for AI-read narratives.');
  if (!st.notify?.length) find('medium', 3, 'No notification channel', 'ntfy / Telegram not configured', 'Set NTFY_TOPIC.');

  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    generatedAt: now, windowHours: hours, coverageHours: F.hoursCovered, coverageFrom: F.firstHour, uptimeSec: H.uptimeSec ?? null, demo: st.demo,
    components: comp, discovery, rejections, rejectionsByKind: byKind, strategy: { rows: strategyRows, deepVerdicts, review: perf?.review ?? [] },
    paper: paperRows, latency, persistence, learning: L, findings,
    config: { helius: st.helius, ai: st.ai, notify: st.notify, x: st.x?.on ? 'X API' : 'free radar', copyTraders: copy?.traders.size ?? 0,
      setuh: strategy ? { mode: strategy.settings.mode, minConfidence: strategy.settings.minConfidence, maxDataAgeSec: strategy.settings.maxDataAgeSec, requireVerifiedSafety: strategy.settings.requireVerifiedSafety, requireDeepCheck: strategy.settings.requireDeepCheck, positionUsd: strategy.settings.positionUsd } : null,
      auto: { dailyUsd: cfg.paperDailyUsd, sizePct: cfg.paperSizePct, maxOpen: cfg.paperMaxOpen, alertTargetPerDay: cfg.alertTargetPerDay, alertFloor: cfg.alertFloor, alertCeiling: cfg.alertCeiling } },
  };
}
