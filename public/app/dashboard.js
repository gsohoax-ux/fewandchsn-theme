// Section 1: Dashboard — market overview, trends, learning center, system health.
import { $, esc, fmt, api, poller, spark, kpi, card, scoreCls, store, cls } from './core.js';

export const SUBS = [['overview', 'Overview'], ['trends', 'Trends'], ['learning', 'Learning Center'], ['system', 'System Health'], ['diagnostics', 'Diagnostics']];
let root, sub = 'overview';
let analyticsData = null, learningData = null, healthData = null;

const statePoll = poller(async () => {
  const s = await api('/api/state');
  store.state = s; store.solUsd = s.status.solUsd || 0; window.__mbState = s;
  for (const fn of store.listeners) fn(s);
  if (!root.hidden) render();
}, 3000);
const analyticsPoll = poller(async () => { analyticsData = await api('/api/analytics'); if (!root.hidden && sub === 'overview') render(); }, 10_000);
const learningPoll = poller(async () => { learningData = await api('/api/learning'); if (!root.hidden && sub === 'learning') render(); }, 30_000);
const healthPoll = poller(async () => { healthData = await api('/api/health'); if (!root.hidden && sub === 'system') render(); }, 5000);
let latencyData = null;
const latencyPoll = poller(async () => { latencyData = await api('/api/latency'); if (!root.hidden && sub === 'system') render(); }, 2000);

export function mount(el) { root = el; statePoll.start(); }
export function show(s) {
  sub = SUBS.some(([k]) => k === s) ? s : 'overview';
  analyticsPoll[sub === 'overview' ? 'start' : 'stop']();
  learningPoll[sub === 'learning' ? 'start' : 'stop']();
  healthPoll[sub === 'system' ? 'start' : 'stop']();
  latencyPoll[sub === 'system' ? 'start' : 'stop']();
  diagPoll[sub === 'diagnostics' ? 'start' : 'stop']();
  render();
}
export function hide() { analyticsPoll.stop(); learningPoll.stop(); healthPoll.stop(); latencyPoll.stop(); diagPoll.stop(); }

function render() {
  const s = store.state;
  if (!s) { root.innerHTML = '<div class="empty">Connecting to the bot…</div>'; return; }
  const keepScroll = [...root.querySelectorAll('[data-keep]')].map((el) => [el.dataset.keep, el.scrollTop]);
  root.innerHTML = sub === 'overview' ? overview(s) : sub === 'trends' ? trends(s) : sub === 'learning' ? learning(s) : sub === 'diagnostics' ? diagnosticsView() : system(s);
  for (const [k, top] of keepScroll) { const el = root.querySelector(`[data-keep="${k}"]`); if (el) el.scrollTop = top; }
}

// ------------------------------------------------------------------ overview
function overview(s) {
  const A = analyticsData, st = s.status;
  const auto = A?.auto;
  const pf = (x) => (x?.profitFactorInfinite ? '∞' : x?.profitFactor != null ? x.profitFactor.toFixed(2) : '—');
  const kpis = `<div class="kpis">
    ${kpi('Coins monitored', fmt.num(st.launches), `${st.tracked} tracked live`)}
    ${kpi('Passing safety', A ? fmt.num(A.discovery.passingSafety) : '—', A?.discovery.safePct != null ? `${A.discovery.safePct}% of ${A.discovery.scored} scored` : 'of scored coins')}
    ${kpi('Runners now', A ? A.discovery.runnersNow : '—', 'big-move signs + a catalyst')}
    ${kpi('Active trends', A ? A.trends.active : '—', A ? `${A.trends.watching} being watched` : '')}
    ${kpi('Alerts', fmt.num(st.alerts), A ? `${A.discovery.alerts7d} in 7 days · bar ${A.discovery.alertBar}${A.discovery.alertAdaptive ? ' (auto)' : ''}` : '')}
    ${kpi('Auto paper win rate', auto?.winRate != null ? `${auto.winRate}%` : '—', auto ? `${auto.trades} finished trades` : 'automatic system')}
    ${kpi('Profit factor', pf(auto), 'won ÷ lost (auto system)', auto?.profitFactor != null ? (auto.profitFactor >= 1 ? 'up' : 'down') : '')}
    ${kpi('Avg trade return', auto?.avgReturnPct != null ? fmt.pct(auto.avgReturnPct, 1) : '—', 'per finished trade (auto)', auto?.avgReturnPct != null ? cls(auto.avgReturnPct) : '')}
  </div>`;
  const movers = s.movers ?? [];
  const tickerHtml = movers.length ? `<div class="card" style="margin-bottom:var(--gap)"><div class="ticker"><span class="muted tiny" style="align-self:center">5-MIN MOVERS</span>${movers.map((m) =>
    `<a href="#" data-open="${esc(m.mint)}"><b>$${esc(m.symbol)}</b> <span class="muted num">${fmt.mcSol(m.mcSol)}</span> <span class="up num">+${m.changePct.toFixed(0)}%</span></a>`).join('')}</div></div>` : '';
  return `${kpis}${tickerHtml}
  <div class="grid g-main">
    <div class="grid" style="align-content:start">
      ${card('Live coin discovery', board(s.board), 'tap a coin for the full read', { tight: true })}
      ${card('Live ranking', ranking(s.coins), `updated ${new Date().toLocaleTimeString()}`, { tight: true })}
    </div>
    <div class="grid" style="align-content:start">
      ${card('Runner detection', runners(s.runners ?? []), `${(s.runners ?? []).length} now`, { tight: true })}
      ${card('Market movers · 5 min', moversTable(movers), 'AVOID coins excluded', { tight: true })}
      ${card('Recent alerts', alerts(s.alerts), 'peak after alert', { tight: true })}
      ${card('Why they died', why(s.reasons), 'since start')}
    </div>
  </div>
  <p class="disclaimer">Scores are filters, not predictions. Meme coins are extremely risky — only trade what you can afford to lose.</p>`;
}

function badges(c) {
  return `${c.runner ? '<span class="tag up" title="Runner potential">RUN</span> ' : ''}${c.x ? '<span class="tag info" title="Rides a viral X post">X</span> ' : ''}${c.trend ? '<span class="tag info" title="Matches a confirmed trend">TREND</span> ' : ''}${c.deployTool ? `<span class="tag" title="Launched with ${esc(c.deployTool)}">QD</span> ` : ''}${c.copy ? '<span class="tag warn" title="Copy of an earlier coin">COPY</span> ' : ''}`;
}

// Age of a coin's price = time since its last live trade. Grey when fresh, amber > 30 s, red > 120 s.
const priceAge = (sec) => sec == null ? '<span class="faint" title="No trade received for this coin yet">no trades</span>'
  : `<span class="${sec > 120 ? 'down' : sec > 30 ? 'warn' : 'faint'}" title="Seconds since the last live trade on this coin">price ${fmt.age(sec)} old</span>`;

function board(B) {
  if (!B) return '<div class="empty">Waiting for launches…</div>';
  const row = (c) => `<li data-open="${esc(c.mint)}">
    <span class="sym">$${esc(c.symbol)} <span class="muted" style="font-weight:400">${esc(c.name).slice(0, 26)}</span></span>
    <span>${c.score != null ? `<span class="score ${scoreCls(c.score, c.verdict)}">${c.score}</span>` : '<span class="faint small">scoring…</span>'}</span>
    <span class="sub">${spark(c.spark, 44, 12)} ${fmt.mcSol(c.mcSol)} · <span class="prog"><i style="width:${c.progress.toFixed(0)}%"></i></span>${c.progress.toFixed(0)}% · ${fmt.age(c.ageSec)} · ${c.buyers} buyers · ${priceAge(c.lastTradeSec)}</span>
    <span class="sub" style="text-align:right">${badges(c)}<span class="v-${c.verdict ?? ''}">${c.alerted ? 'ALERTED · ' : ''}${c.verdict ?? ''}</span></span></li>`;
  const col = (cl, title, sub, items, empty) => `<div class="col ${cl}"><h3><span>${title}</span><span class="faint">${sub}</span></h3>
    <ul data-keep="${cl}">${items.length ? items.map(row).join('') : `<div class="empty">${empty}</div>`}</ul></div>`;
  return `<div class="board">${col('c-new', 'New pairs', `under ${B.newPairMaxMin} min`, B.newPairs, 'Waiting for launches…')}${col('c-mid', 'In between', `${B.middleCount} on the curve`, B.middle, 'Nothing mid-curve')}${col('c-final', 'Final stretch', `${B.finalStretchPct}%+ of curve`, B.final, 'No coin close to graduating yet')}</div>`;
}

function ranking(coins) {
  if (!coins?.length) return '<div class="empty">Waiting for coins to get traction…</div>';
  return `<div class="scroll-x" data-keep="rank" style="max-height:520px"><table class="t"><thead><tr><th>Score</th><th>Coin</th><th>Label</th><th>Safety</th><th class="hide-sm">Confidence</th><th class="r hide-sm">Narr.</th><th class="r hide-sm">Mom.</th><th class="r">MC</th><th class="hide-sm">Curve</th><th class="r hide-sm">Age</th><th class="r hide-sm">Price age</th><th class="r hide-sm">Holders</th></tr></thead><tbody>
  ${coins.map((c) => `<tr class="click" data-open="${esc(c.mint)}">
    <td><span class="score ${scoreCls(c.score, c.safety.verdict)}">${c.score}</span></td>
    <td><div class="b">${badges({ runner: c.runner?.is, x: c.x, deployTool: c.deployTool, copy: c.copyOf })}$${esc(c.symbol)}${c.migrated ? ' <span class="tag">GRAD</span>' : ''}${c.devSold ? ' <span class="tag warn" title="Dev sold">DEV SOLD</span>' : ''}</div><div class="tiny muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</div></td>
    <td>${c.label ? `<span class="tag ${c.label === 'BUY ZONE' ? 'solid-up' : c.label === 'LOW RISK' ? 'up' : c.label === 'WATCH' ? 'warn' : 'solid-down'}">${c.label}</span>` : ''}</td>
    <td class="v-${c.safety.verdict} b small">${c.safety.verdict}</td>
    <td class="hide-sm small">${c.confidence ? `${c.confidence.label} <span class="faint">${c.confidence.meter}</span>` : ''}</td>
    <td class="r num hide-sm">${c.narrative.score}</td><td class="r num hide-sm">${c.momentum.score}</td>
    <td class="r num">${fmt.mcSol(c.mcSol)}<div>${spark(c.spark, 56, 14)}</div></td>
    <td class="hide-sm"><span class="prog"><i style="width:${c.progress.toFixed(0)}%"></i></span><span class="num small">${c.progress.toFixed(0)}%</span></td>
    <td class="r num hide-sm">${fmt.age(c.ageSec)}</td><td class="r num hide-sm">${priceAge(c.lastTradeSec)}</td><td class="r num hide-sm">${c.holders}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function runners(list) {
  if (!list.length) return '<div class="empty">No coin shows runner signs right now. A runner needs a high runner score <b>and</b> a catalyst (trend, viral post or whale buying).</div>';
  return `<ul class="list">${list.map((c) => `<li class="click" data-open="${esc(c.mint)}" style="cursor:pointer">
    <div style="display:flex;justify-content:space-between;gap:8px"><b>$${esc(c.symbol)}</b><span class="num">${fmt.mcSol(c.mcSol)} · <span class="up">${c.runner.score}/100</span></span></div>
    <div class="tiny muted" style="margin-top:3px">${c.runner.reasons.slice(0, 4).map(esc).join(' · ')}</div></li>`).join('')}</ul>`;
}

function moversTable(mv) {
  if (!mv.length) return '<div class="empty">No coin moved 5%+ in the last 5 minutes.</div>';
  const coins = new Map((store.state?.coins ?? []).map((c) => [c.mint, c]));
  return `<div class="scroll-x"><table class="t"><thead><tr><th>Coin</th><th class="r">Move</th><th class="r">MC</th><th class="r hide-sm">Age</th><th class="r hide-sm">Trades</th></tr></thead><tbody>${mv.map((m) => {
    const c = coins.get(m.mint);
    return `<tr class="click" data-open="${esc(m.mint)}"><td class="b">$${esc(m.symbol)}</td><td class="r num up">+${m.changePct.toFixed(0)}%</td><td class="r num">${fmt.mcSol(m.mcSol)}</td><td class="r num hide-sm">${c ? fmt.age(c.ageSec) : '—'}</td><td class="r num hide-sm">${c ? c.trades : '—'}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function alerts(list) {
  if (!list?.length) return '<div class="empty">No alerts yet</div>';
  return `<div data-keep="alerts" style="max-height:300px;overflow:auto"><table class="t"><tbody>${list.map((a) => {
    const m = a.mc_sol ? a.peak_mc_sol / a.mc_sol : 1;
    return `<tr class="click" data-open="${esc(a.mint)}"><td><b>$${esc(a.symbol)}</b> <span class="tiny muted">${esc(a.stage)}</span></td><td class="num small">${a.score}</td><td class="small muted">${fmt.time(a.at)}</td>
      <td class="r num ${m >= 1.5 ? 'up' : m < 1.05 ? 'muted' : ''}">${m.toFixed(2)}x${a.migrated ? ' <span class="tag">GRAD</span>' : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function why(R) {
  if (!R?.length) return '<span class="muted small">Nothing rejected yet.</span>';
  const max = Math.max(1, ...R.map((r) => r[1]));
  return R.map(([k, n]) => `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(k)}</span><span class="num muted">${n}</span></div>
    <div class="bar" style="margin-top:3px"><i style="width:${(n / max) * 100}%;background:var(--down)"></i></div></div>`).join('');
}

export function autoPaper(s) {
  const P = s.paper;
  if (!P) return '<span class="muted">Automatic paper trading is off (PAPER=0).</span>';
  const usd = (sol) => (P.solUsd ? fmt.usd(sol * P.solUsd, 2) : `${sol.toFixed(3)} SOL`);
  const wl = (w, label) => !w || !(w.wins + w.losses) ? `<div class="small muted">${label}: no finished trades yet</div>` : `<div class="kv" style="margin-top:8px">
      <div><small>${label} W / L</small><b><span class="up">${w.wins}</span> / <span class="down">${w.losses}</span></b></div>
      <div><small>Win rate</small><b>${w.winRate}%</b></div>
      <div><small>Avg win</small><b class="up">${w.wins ? fmt.pct(w.avgWinPct, 1) : '—'}</b></div>
      <div><small>Avg loss</small><b class="down">${w.losses ? fmt.pct(w.avgLossPct, 1) : '—'}</b></div>
      <div><small>Best / worst</small><b>${fmt.pct(w.bestPct, 0)} / ${fmt.pct(w.worstPct, 0)}</b></div>
      <div><small>Profit factor</small><b class="${w.profitFactor == null || w.profitFactor >= 1 ? 'up' : 'down'}">${w.profitFactor == null ? '∞' : w.profitFactor.toFixed(2)}</b></div></div>`;
  const A = P.allTime;
  let allHtml = '';
  if (A?.days) {
    const mx = Math.max(1, ...A.series.map((d) => Math.abs(d.pnlUsd)));
    const n = A.series.length, w = 100 / Math.max(n, 14);
    const tmin = Math.min(0, ...A.series.map((d) => d.total)), tmax = Math.max(0, ...A.series.map((d) => d.total)), tspan = tmax - tmin || 1;
    const bars = A.series.map((d, i) => { const h = (Math.abs(d.pnlUsd) / mx) * 28;
      return `<rect x="${i * w + w * 0.15}" width="${w * 0.7}" y="${d.pnlUsd >= 0 ? 30 - h : 30}" height="${Math.max(0.5, h)}" fill="${d.pnlUsd >= 0 ? 'var(--up)' : 'var(--down)'}" opacity="${d.today ? 0.5 : 0.9}"><title>${d.day}: ${fmt.signed(d.pnlUsd)}${d.today ? ' (so far)' : ''}</title></rect>`; }).join('');
    const line = A.series.map((d, i) => `${i * w + w / 2},${58 - ((d.total - tmin) / tspan) * 56}`).join(' ');
    allHtml = `<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap"><span class="tiny muted" style="text-transform:uppercase;letter-spacing:.6px">All time</span>
        <b class="num ${cls(A.pnlUsd)}" style="font-size:18px">${fmt.signed(A.pnlUsd)}</b>
        <span class="small muted">${A.days} day${A.days === 1 ? '' : 's'} · ${A.greenDays} green / ${A.redDays} red · ${A.trades} trades · win ${A.winRate}%</span></div>
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" style="width:100%;height:60px;display:block;margin:6px 0"><line x1="0" x2="100" y1="30" y2="30" stroke="var(--border)" vector-effect="non-scaling-stroke"/>${bars}
        <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <div class="tiny faint">Bars = each day's result (faded = today so far) · line = running total</div>
      ${wl(P.winLoss?.allTime, 'All time')}
      ${P.moonbags?.count ? `<div class="small muted" style="margin-top:6px">Moonbags: ${P.moonbags.count} closed · ${P.moonbags.winners} in profit · <span class="${cls(P.moonbags.pnlUsd)}">${fmt.signed(P.moonbags.pnlUsd)}</span> added to all time</div>` : ''}
      <hr style="border:0;border-top:1px solid var(--border);margin:14px 0">`;
  }
  const h = P.history.length ? P.history.map((x) => x[1]) : [P.startSol, P.equitySol];
  return `${allHtml}
    <div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap"><span class="tiny muted" style="text-transform:uppercase;letter-spacing:.6px">Today</span>
      <b class="num" style="font-size:22px">${usd(P.equitySol)}</b><span class="num ${cls(P.pnlSol)}">${fmt.signed(P.pnlSol * (P.solUsd || 0))} (${fmt.pct(P.pnlPct, 1)})</span>
      <span class="small muted">${P.daily ? `budget $${P.daily.budgetUsd} · resets at midnight · alert under $${P.daily.lowUsd}` : ''}${P.daily?.lowHit ? ' · <span class="warn">under the low mark</span>' : ''}</span></div>
    <div style="margin:8px 0">${spark(h, 600, 46).replace('width="600"', 'width="100%" preserveAspectRatio="none"')}</div>
    ${wl(P.winLoss?.today, 'Today')}
    ${s.status.demo ? '<div class="notice warn small" style="margin-top:10px">Demo coins are simulated and pump far more than real ones, so these demo results mean nothing.</div>' : ''}
    <div class="grid g2" style="margin-top:12px">
      <div><div class="tiny muted" style="text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Open positions</div>${P.open.length ? `<table class="t"><tbody>${P.open.map((o) => `<tr class="click" data-open="${esc(o.mint)}"><td class="b">$${esc(o.symbol)}</td><td class="small muted">${fmt.age((Date.now() - o.openedAt) / 1000)}${o.trailing ? ' · trailing' : ''}</td><td class="r num ${cls(o.pnlPct)}">${fmt.pct(o.pnlPct, 1)}</td></tr>`).join('')}</tbody></table>` : '<div class="small muted">None — waiting for the next alert.</div>'}
        ${P.moonbags?.open.length ? `<div class="tiny muted" style="margin-top:8px">Moonbags (kept ${P.moonbags.pct}% after graduation)</div><table class="t"><tbody>${P.moonbags.open.map((m) => `<tr><td class="b">$${esc(m.symbol)}</td><td class="small muted">${fmt.age((Date.now() - m.since) / 1000)}</td><td class="r num ${m.mult >= 1 ? 'up' : 'down'}">${m.mult.toFixed(2)}x</td></tr>`).join('')}</tbody></table>` : ''}</div>
      <div><div class="tiny muted" style="text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Recent closes</div>${P.recent.length ? `<table class="t"><tbody>${P.recent.slice(0, 6).map((t) => `<tr><td class="b">$${esc(t.symbol)}</td><td class="small muted wrap">${esc(t.why)}</td><td class="r num ${cls(t.pnlPct)}">${fmt.pct(t.pnlPct, 1)}</td></tr>`).join('')}</tbody></table>` : '<div class="small muted">No closed trades yet.</div>'}</div>
    </div>
    ${P.daily?.days.length ? `<div class="tiny muted" style="margin-top:12px;text-transform:uppercase;letter-spacing:.5px">Past days</div><table class="t"><tbody>${P.daily.days.slice(0, 7).map((d) => { const pc = (d.endUsd / d.startUsd - 1) * 100;
      return `<tr><td>${esc(d.day)}</td><td class="small muted">${d.trades} trade${d.trades === 1 ? '' : 's'}</td><td class="r num ${cls(pc)}">$${d.startUsd.toFixed(0)} → $${d.endUsd.toFixed(2)} (${fmt.pct(pc, 1)})</td></tr>`; }).join('')}</tbody></table>` : ''}
    ${P.byStage?.length ? `<div class="tiny muted" style="margin-top:12px;text-transform:uppercase;letter-spacing:.5px">Results by entry stage (all time)</div><table class="t"><tbody>${P.byStage.slice(0, 8).map((g) => `<tr><td>${esc(g.key)}</td><td class="small muted">${g.trades} trades · win ${g.winRate}%</td><td class="r num ${cls(g.netPct)}">${fmt.pct(g.netPct, 1)}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="tiny faint" style="margin-top:10px">Rules: ${P.rules.sizePct}% per trade, max ${P.rules.maxOpen} open · stop when price −${P.rules.stopPct}% · trailing ${P.rules.trailPct}% after +${P.rules.trailStartPct}%
      ${P.rules.gradTakePct ? ` · sell half at ${P.rules.gradTakePct}% of the curve, rest ${P.rules.gradExitMin} min after graduation` : ''}${P.rules.stallMin ? ` · exit if not +${P.rules.stallGainPct}% within ${P.rules.stallMin} min` : ''} · max ${P.rules.maxHoldMin} min
      ${P.moonbags?.enabled ? ` · moonbag ${P.moonbags.pct}% on strong coins` : ''} · costs ${P.rules.feePct.toFixed(2)}% fees per side + slippage, sandwich bots and network fees. Paper results assume the pool could absorb each sell; in thin pools real exits get less.</div>`;
}

// ------------------------------------------------------------------ trends
function trends(s) {
  const T = s.trends;
  const st = s.status;
  const srcChips = T?.sources ? Object.entries(T.sources).map(([k, v]) => `<span class="chip" title="${esc(v.error || `${v.count} items`)}"><span class="dot ${v.ok ? 'ok' : 'bad'}"></span>${esc(k)}</span>`).join('') : '';
  const topics = T?.topics ?? [];
  const topicHtml = topics.length ? `<ul class="list">${topics.map((t) => {
    const velocity = t.spike && t.longevity ? 'Spiking and lasting' : t.spike ? 'Spiking' : t.longevity ? 'Lasting (multi-day)' : 'Building';
    return `<li style="${t.qualified ? '' : 'opacity:.6'}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
        <b style="font-size:14px">${esc(t.label)}</b>
        <span>${t.qualified ? '<span class="tag up">CONFIRMED</span>' : '<span class="tag">NEEDS 2+ SOURCES</span>'} <span class="tag ${t.spike ? 'warn' : 'info'}">${velocity}</span></span></div>
      <div class="kv" style="margin-top:8px">
        <div><small>Sources</small><b>${t.sources.length}/5</b> <span class="small muted">${t.sources.map(esc).join(', ')}</span></div>
        <div><small>Days seen</small><b>${t.days}</b></div>
        ${t.traffic ? `<div><small>Google searches</small><b>~${fmt.num(t.traffic / 1000)}K</b></div>` : ''}
        ${t.views ? `<div><small>Wikipedia views</small><b>${fmt.num(t.views / 1000)}K</b></div>` : ''}
        <div><small>Narrative strength</small><b>${t.score ?? '—'}</b></div>
        ${t.meme != null ? `<div><small>Meme potential</small><b>${t.meme}</b></div>` : ''}
      </div>
      ${t.thesis ? `<p class="small" style="margin:8px 0 0"><span class="muted">AI thesis:</span> ${esc(t.thesis)}</p>` : ''}
      ${t.ideas?.length ? `<div class="small" style="margin-top:4px"><span class="muted">Likely names / tickers:</span> ${t.ideas.map((x) => `<span class="tag">${esc(x)}</span>`).join(' ')}</div>` : ''}
      <div class="small" style="margin-top:6px"><span class="muted">Coins on it:</span> ${t.coins?.length ? t.coins.map((c) => `<a href="#" data-open="${esc(c.mint)}">$${esc(c.symbol)}</a> <span class="v-${c.verdict ?? ''} num">${c.score ?? '…'}${c.verdict ? ' ' + c.verdict : ''}</span>`).join(' · ') : (t.qualified ? '<span class="faint">none yet — watching Pump.fun</span>' : '<span class="faint">—</span>')}</div>
    </li>`;
  }).join('')}</ul>` : '<div class="empty">Collecting trends from Google, Wikipedia, Reddit and X…</div>';
  const xp = s.xPosts ?? [];
  const xHtml = xp.length ? `<ul class="list">${xp.map((p) => `<li>
      <div style="display:flex;justify-content:space-between;gap:8px" class="small"><a target="_blank" rel="noopener" href="${esc(p.url)}">@${esc(p.author)}</a><span class="muted">${fmt.ago(p.createdAt)}</span></div>
      <div style="margin:4px 0 6px">${esc(p.text)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">${p.origin === 'radar' ? `<span class="tag info">RADAR · ${p.radarCoins} coins</span>` : `<span class="tag">${p.likes.toLocaleString()} likes</span>`}<span class="tag">viral ${p.viral}</span><span class="tag">meme ${p.meme}${p.memeSource === 'ai' ? ' (AI)' : ''}</span>${p.idea ? `<span class="tag">${esc(p.idea)}</span>` : ''}</div>
      <div class="small" style="margin-top:6px">${p.coins.length ? p.coins.map((c) => `<a href="#" data-open="${esc(c.mint)}">$${esc(c.symbol)}</a> <span class="v-${c.verdict ?? ''} num">${c.score ?? '…'}${c.verdict ? ' ' + c.verdict : ''}</span>`).join(' · ') : '<span class="faint">No coin yet — watching Pump.fun</span>'}</div>
    </li>`).join('')}</ul>` : `<div class="empty">${st.x.on ? 'Waiting for posts…' : 'Tweet radar is watching: a post appears here when 3+ new coins link to it.'}</div>`;
  const themes = st.hotThemes.length ? st.hotThemes.map((t) => `<span class="tag info" style="margin:0 4px 4px 0">${esc(t.word)} · ${t.count}</span>`).join('') : '<span class="muted small">Learning from coins that pump…</span>';
  return `<div class="section-title"><h2>Trend intelligence</h2><p>A trend counts only when 2+ sources confirm it and it is spiking or lasting.</p></div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--gap)">${srcChips}<span class="chip"><span class="dot ${st.x.on ? (st.x.error ? 'bad' : 'ok') : st.x.radar ? 'ok' : ''}"></span>${st.x.on ? 'X API' : 'X radar (free)'}</span></div>
    <div class="grid g-main">
      ${card('Trending narratives', topicHtml, `${topics.filter((t) => t.qualified).length} confirmed`, { tight: true })}
      <div class="grid" style="align-content:start">
        ${card('Viral posts on X', xHtml, st.x.on ? `${st.x.posts} tracked` : 'free radar', { tight: true })}
        ${card('Pump.fun themes running now', themes)}
      </div>
    </div>`;
}

// ------------------------------------------------------------------ learning
function learning(s) {
  const L = learningData;
  if (!L) return '<div class="empty">Loading the learning report…</div>';
  const st = L.status, R = L.report;
  const reg = L.regime;
  const table = (rows, label) => rows.length ? `<table class="t"><thead><tr><th>${label}</th><th class="r">Coins</th><th class="r">Hit ${R.target}x</th><th class="r">Hit 2x</th><th class="r">Graduated</th><th class="r">Median peak</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="r num">${r.n}</td><td class="r num">${r.hitTarget}%</td><td class="r num">${r.hit2}%</td><td class="r num">${r.graduated}%</td><td class="r num ${cls(r.medianPeakPct)}">${fmt.pct(r.medianPeakPct, 0)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No finished coins yet.</div>';
  const strat = L.strategy?.bySetup ? Object.values(L.strategy.bySetup) : [];
  return `<div class="section-title"><h2>Learning Center</h2><p>Everything here is <b>past results</b> from coins the bot watched — not predictions.</p></div>
    <div class="kpis">
      ${kpi('Finished observations', fmt.num(st?.samples.done ?? 0), `${fmt.num(st?.samples.total ?? 0)} recorded · learning starts at 300`)}
      ${kpi('Learned model', st?.validated ? 'In use' : st?.n ? 'Not trusted yet' : 'Collecting', st?.validated ? `beats average by ${st.lift}x on unseen coins` : 'must beat average by 1.3x on unseen coins first')}
      ${kpi(`Average coin hit ${st?.target ?? 1.5}x`, st?.n ? `${Math.round(st.baseRate * 100)}%` : R.overall.n ? `${R.overall.hitTarget}%` : '—', 'baseline')}
      ${kpi('Top picks (held-out test)', st?.n ? `${Math.round(st.testTop * 100)}%` : '—', 'how the model did on coins it never saw')}
      ${kpi('Market condition', reg.state, reg.rate != null ? `${reg.rate.toFixed(2)}% of ${fmt.num(reg.launches)} launches graduated (24 h)` : 'needs 1,500 launches in 24 h')}
      ${kpi('Alerts that hit 2x', `${L.alerts.hit2x}%`, `${L.alerts.alerts} alerts in 7 days · ${L.alerts.migrated}% graduated`)}
    </div>
    <div class="grid g2">
      ${card('Model status', `<p style="margin-top:0">${esc(st?.info ?? 'Learning is off')}</p>
        ${!st?.n ? `<div class="bar"><i style="width:${Math.min(100, ((st?.samples.done ?? 0) / 300) * 100).toFixed(0)}%"></i></div><p class="tiny muted">${st?.samples.done ?? 0} of 300 finished coins needed before learning starts.</p>` : ''}
        <p class="tiny muted">Rule: the learned score is only mixed in when, on the newest coins it was not trained on, its top picks hit ${st?.target ?? 1.5}x at least 1.3x more often than average. Otherwise the hand-made scores are used unchanged. It never overrides safety.</p>`)}
      ${card('Learned signals', st?.top?.length ? `<ul class="checks">${st.top.map((f) => `<li class="lv-ok">More of this → more pumps: <b>${esc(f.label)}</b></li>`).join('')}${st.bottom.map((f) => `<li class="lv-bad">More of this → fewer pumps: <b>${esc(f.label)}</b></li>`).join('')}</ul>` : '<div class="muted small">Signals appear once the model has trained on 300+ finished coins.</div>')}
    </div>
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Outcomes by entry stage', table(R.byStage, 'Stage'), 'past results', { tight: true })}
      ${card('Outcomes by bot score', table(R.byScore, 'Score'), 'past results', { tight: true })}
      ${card('Outcomes by narrative strength', table(R.byNarrative, 'Narrative'), 'past results', { tight: true })}
      ${card('Outcomes by safety score', table(R.bySafety, 'Safety'), 'past results', { tight: true })}
    </div>
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Strategy observations (Setuh)', strat.length ? `<table class="t"><thead><tr><th>Setup</th><th class="r">Signals</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Net</th></tr></thead><tbody>${strat.map((x) => `<tr><td>${esc(x.family)} · ${esc(x.name)}</td><td class="r num">${x.detected}</td><td class="r num">${x.trades}</td><td class="r num">${x.winRate != null ? x.winRate + '%' : '—'}</td><td class="r num ${cls(x.netUsd)}">${x.trades ? fmt.signed(x.netUsd) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Strategy engine off.</div>', 'paper results', { tight: true })}
      ${card('Narratives that pumped recently', L.themes.length ? L.themes.map((t) => `<span class="tag info" style="margin:0 4px 4px 0">${esc(t.word)} · ${t.count}</span>`).join('') : '<span class="muted small">No pattern yet.</span>')}
    </div>`;
}

// ------------------------------------------------------------------ system
function system(s) {
  const H = healthData;
  if (!H) return '<div class="empty">Loading system health…</div>';
  const st = s.status;
  const dot = (state) => `<span class="dot ${state === 'ok' ? 'ok' : state === 'degraded' || state === 'late' || state === 'waiting' ? 'warn' : state === 'idle' ? '' : 'bad'}"></span>`;
  const svc = [
    ['Market feed socket (PumpPortal)', H.feed.connected ? 'ok' : 'down', H.feed.connected ? `connected · last message ${H.feed.lastDataSec ?? '?'}s ago · ${H.feed.reconnects} reconnects` : `offline${H.feed.problem ? ': ' + H.feed.problem : ''}`],
    ['Discovery stream (new coins)', !H.feed.connected ? 'down' : H.feed.demo || (H.feed.lastCreateSec != null && H.feed.lastCreateSec <= 60) ? 'ok' : 'degraded', H.feed.lastCreateSec != null ? `last new coin ${H.feed.lastCreateSec}s ago` : 'no new coin yet'],
    ['Trade stream (live prices)', !H.feed.connected ? 'down' : H.feed.tradesHealthy === false ? 'down' : H.feed.lastTradeSec == null && !H.feed.demo ? 'waiting' : 'ok',
      `${H.feed.lastTradeSec != null ? `last trade ${H.feed.lastTradeSec}s ago` : 'no trade received yet'} · ${H.feed.watched ?? '?'} coins subscribed · ${H.feed.counts?.trades ?? '?'} trades · ${H.feed.counts?.serverErrors ?? 0} server errors${H.feed.tradesHealthy === false ? ' — NEW PAPER ENTRIES BLOCKED' : ''}`],
    ['SOL price', !(H.solUsd > 0) ? 'down' : H.feed.solStale ? 'degraded' : 'ok', H.solUsd > 0 ? `$${H.solUsd.toFixed(2)}${H.feed.solStale ? ' — STALE, paper entries blocked' : ''}` : 'unavailable — market caps shown in SOL'],
    ['On-chain checks (Helius)', H.services.helius ? 'ok' : 'idle', H.services.helius ? 'on' : 'off — add HELIUS_API_KEY for bundle tracing'],
    ['AI narrative (Claude)', String(H.services.ai).startsWith('claude') ? 'ok' : 'idle', String(H.services.ai).startsWith('claude') ? H.services.ai : `off (${esc(H.services.ai)}) — rule-based fallback in use`],
    ['Notifications', H.services.notify.length ? 'ok' : 'idle', H.services.notify.length ? H.services.notify.join(' + ') : 'off'],
    ['X', H.services.x.on ? (H.services.x.error ? 'down' : 'ok') : H.services.x.radar ? 'ok' : 'idle', H.services.x.on ? (H.services.x.error || `${H.services.x.posts} posts`) : 'free tweet radar'],
    ['Database', H.db?.ok ? (H.db.persistent ? 'ok' : 'degraded') : 'down', H.db?.ok ? `${H.db.sizeMb} MB · ${esc(H.db.path)}${H.db.persistent ? '' : ' (in memory: not saved)'}` : `error: ${esc(H.db?.error)}`],
  ];
  const pl = H.desk.pipeline;
  const lastOf = (a) => (H.events || []).find((e) => e.agent === a);
  const lastTxt = (a, fb) => { const e = lastOf(a); return e ? `$${esc(e.symbol)} ${esc(e.text)}` : fb; };
  const desk = [
    ['Scout', `${pl.launches} launches seen`, `${pl.dead} died early`],
    ['Filter', lastTxt('FILTER', 'nothing killed yet'), `${pl.filtered} killed`],
    ['Analyst', lastTxt('ANALYST', 'scoring survivors'), `${pl.scored} scored`],
    ['Alerts', lastTxt('ALERT', `alert bar ${H.desk.alertBar}${H.desk.alertAdaptive ? ' (auto)' : ''}`), `${pl.alerts} sent`],
    ['Executor', lastTxt('EXECUTOR', 'paper mode · waiting'), `${pl.paperTrades} auto paper trades`],
    ['Risk', lastTxt('RISK', 'no open risk'), H.desk.paused ? 'alerts paused' : ''],
  ];
  return `<div class="section-title"><h2>System health</h2><p>Up ${fmt.age(H.uptimeSec)} · latency refreshes every 2 s, services every 5 s</p></div>
    ${latencyPanel()}
    ${card('Services', `<table class="t"><tbody>${svc.map(([n, state, d]) => `<tr><td style="width:30%">${dot(state)} <b>${n}</b></td><td class="wrap small">${d}</td></tr>`).join('')}</tbody></table>`, '', { tight: true })}
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Outside APIs (last 15 min)', H.providers.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Provider</th><th class="r">Calls</th><th class="r">Failed</th><th class="r">Median</th><th>Last OK</th><th>Last error</th></tr></thead><tbody>${H.providers.map((p) => `<tr><td>${dot(p.state)} ${esc(p.label)}</td><td class="r num">${p.calls}</td><td class="r num ${p.recentFails ? 'down' : ''}">${p.recentFails}/${p.recentCalls}</td><td class="r num">${p.medianMs != null ? p.medianMs + ' ms' : '—'}</td><td class="small muted">${p.lastOkAgoSec != null ? fmt.age(p.lastOkAgoSec) + ' ago' : '—'}</td><td class="small wrap ${p.lastError ? 'down' : 'muted'}">${esc(p.lastError || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No outside calls yet.</div>', '', { tight: true })}
      ${card('Background jobs', `<table class="t"><thead><tr><th>Job</th><th class="r">Runs</th><th class="r">Fails</th><th>Last run</th></tr></thead><tbody>${H.jobs.map((j) => `<tr><td>${dot(j.state)} ${esc(j.name)}${j.lastError ? `<div class="tiny down">${esc(j.lastError)}</div>` : ''}</td><td class="r num">${j.runs}</td><td class="r num ${j.fails ? 'down' : ''}">${j.fails}</td><td class="small muted">${j.lastRunAgoSec != null ? fmt.age(j.lastRunAgoSec) + ' ago' : 'waiting'}</td></tr>`).join('')}</tbody></table>`, 'exits run here, not in the browser', { tight: true })}
    </div>
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Bot desk', `<table class="t"><tbody>${desk.map(([n, t, c]) => `<tr><td class="b" style="width:90px">${n}</td><td class="wrap small">${t}</td><td class="r small muted">${c}</td></tr>`).join('')}</tbody></table>`, `${pl.launches} scanned · ${pl.alerts} alerts`, { tight: true })}
      ${card('Database', H.db?.ok ? `<div class="kv">${Object.entries(H.db.tables).map(([k, v]) => `<div><small>${esc(k)}</small><b>${fmt.num(v)}</b></div>`).join('')}</div>${H.db.persistent ? '' : '<div class="notice warn small" style="margin-top:10px">Database is in memory (demo or no volume): history is lost on restart. On Railway, attach a volume at /app/data.</div>'}` : `<div class="notice bad">${esc(H.db?.error ?? 'unavailable')}</div>`)}
    </div>
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Logger', `<ul class="log" data-keep="log">${(H.events || []).length ? H.events.map((e) => `<li><span class="faint">${fmt.time(e.at)}</span> <span class="a a-${e.agent}">${e.agent}</span>${e.symbol ? `<a href="#" data-open="${esc(e.mint)}" style="color:var(--text)">$${esc(e.symbol)}</a> ` : ''}<span class="l-${e.level}">${esc(e.text)}</span></li>`).join('') : '<li class="muted">Waiting for the first decisions…</li>'}</ul>`, 'why the bot did what it did', { tight: true })}
      ${card('Audit log', H.audit.length ? `<ul class="log">${H.audit.map((a) => `<li><span class="faint">${fmt.dateTime(a.at)}</span> <b>${esc(a.actor)}</b> ${esc(a.book)} <span class="a-EXECUTOR">${esc(a.action)}</span> <span class="muted">${esc(JSON.stringify(a.detail)).slice(0, 160)}</span></li>`).join('')}</ul>` : '<div class="empty">No simulated trades or setting changes yet.</div>', 'paper trades & settings changes', { tight: true })}
    </div>`;
}

// ------------------------------------------------------------------ live data & latency
const ms = (x) => (x == null ? '—' : x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
function freshState(ageMs, connected) {
  if (!connected) return ['bad', 'DISCONNECTED'];
  if (ageMs == null) return ['warn', 'NO DATA YET'];
  if (ageMs <= 2000) return ['ok', 'HEALTHY'];
  if (ageMs <= 10_000) return ['warn', 'DELAYED'];
  return ['bad', 'STALE'];
}
function latencyPanel() {
  const L = latencyData;
  if (!L) return card('Live data & latency', '<div class="muted small">Measuring…</div>');
  const T = L.timings ?? {}, R = L.rates ?? {};
  const feedAge = L.market?.feedLastMsgAgeMs ?? (L.feed.lastDataSec != null ? L.feed.lastDataSec * 1000 : null);
  // Health is judged on TRADE messages: new-coin messages alone must never make prices look live
  const tradeAge = L.market?.feedLastTradeAgeMs ?? (L.feed.lastTradeSec != null ? L.feed.lastTradeSec * 1000 : null);
  const [fc, word] = L.feed.tradesHealthy === false ? ['bad', 'TRADES MISSING'] : freshState(tradeAge ?? feedAge, L.feed.connected);
  const row = (label, key, note = '') => { const t = T[key]; return `<tr><td>${label}</td><td class="r num">${t?.n ? ms(t.p50) : '—'}</td><td class="r num">${t?.n ? ms(t.p95) : '—'}</td><td class="r num">${t?.n ? ms(t.last) : '—'}</td><td class="r num muted">${t?.n ?? 0}</td><td class="small muted wrap">${note}</td></tr>`; };
  const solAge = L.solUsdAgeSec;
  return card('Live data & latency', `
    <div class="kpis" style="margin-bottom:12px">
      <div class="kpi"><small>Feed status</small><b><span class="dot ${fc}"></span> ${word}</b><span>${L.feed.demo ? 'demo simulator' : 'PumpPortal websocket'} · ${L.feed.reconnects} reconnects</span></div>
      <div class="kpi"><small>Last trade message</small><b class="${L.feed.tradesHealthy === false ? 'down' : ''}">${tradeAge != null ? ms(tradeAge) : '—'}</b><span>ago · ${L.feed.counts?.trades ?? '?'} trades since connect</span></div>
      <div class="kpi"><small>Last new coin</small><b>${L.market?.feedLastCreateAgeMs != null ? ms(L.market.feedLastCreateAgeMs) : '—'}</b><span>ago · discovery stream</span></div>
      <div class="kpi"><small>Last message (any)</small><b>${feedAge != null ? ms(feedAge) : '—'}</b><span>ago · socket alive</span></div>
      <div class="kpi"><small>Price updates</small><b>${Math.round(R.priceUpdates ?? 0)}/min</b><span>${L.market ? `${L.market.counts.curveTrades} curve · ${L.market.counts.ammTrades} PumpSwap trades` : ''}</span></div>
      <div class="kpi"><small>Coins pinned on stream</small><b>${L.market?.tracked ?? 0}</b><span>positions, candidates, charts</span></div>
      <div class="kpi"><small>New coins</small><b>${Math.round(R.launches ?? 0)}/min</b><span>discovered</span></div>
      <div class="kpi"><small>SOL price age</small><b class="${solAge != null && solAge > 90 ? 'warn' : ''}">${solAge != null ? fmt.age(solAge) : '—'}</b><span>$${(L.solUsd ?? 0).toFixed(2)} · refreshed every 30 s</span></div>
    </div>
    <div class="scroll-x"><table class="t"><thead><tr><th>Stage</th><th class="r">p50</th><th class="r">p95</th><th class="r">Last</th><th class="r">Samples</th><th>What it measures</th></tr></thead><tbody>
      ${row('Coin discovery latency', 'discoveryLatency', 'On-chain block time → bot received the new coin (sampled, ±1 s block-time resolution; needs Helius)')}
      ${row('Market-data latency', 'tradeLatency', 'On-chain block time → bot received a trade (sampled, ±1 s; needs Helius)')}
      ${row('Feed message → engine', 'feedToEngine', 'From receiving a trade to the engine applying it')}
      ${row('Event-loop lag', 'eventLoopLag', 'How late the process reacts (high = overloaded)')}
      ${row('Safety + scoring', 'safetyScoring', 'Per coin, the bot\'s own checks')}
      ${row('Full safety check', 'deepCheck', 'Coin Check run by the Setuh trader on candidates')}
      ${row('Setup recognition', 'setupScan', 'One pass over all live coins for the five setups')}
      ${row('Signal → simulated entry', 'signalToEntry', 'From all rules met to the simulated fill')}
      ${row('Simulated execution', 'execution', 'Fresh quote, re-check and fill')}
      ${row('Price refresh (DexScreener)', 'priceRefresh', 'Only when the live stream can\'t vouch for a price')}
    </tbody></table></div>
    <p class="tiny muted" style="margin-bottom:0">Healthy ≤ 2 s since the last TRADE message · delayed ≤ 10 s · stale beyond that (new-coin messages don't count). New paper entries are blocked while the trade stream or SOL price is stale; open positions keep being monitored. New Setuh entries are blocked while the feed is stale or disconnected, and whenever a price is older than the trader's max data age. A paper trader can't have zero latency: every simulated fill uses the newest price the bot had at that moment.</p>`, new Date().toLocaleTimeString());
}

// ------------------------------------------------------------------ diagnostics (live audit)
let diagData = null, diagHours = 24;
const diagPoll = poller(async () => { diagData = await api(`/api/diagnostics?hours=${diagHours}`); if (!root.hidden && sub === 'diagnostics') render(); }, 15_000);
document.addEventListener('click', (e) => {
  const h = e.target.closest('[data-diaghours]');
  if (!h) return;
  diagHours = Number(h.dataset.diaghours); diagData = null; render(); diagPoll.now();
});
const SEV = { critical: 'solid-down', high: 'down', medium: 'warn', low: 'info', info: '' };
const STAT = (s) => (/^working/.test(s) ? 'ok' : /partially/.test(s) ? 'warn' : /not working/.test(s) ? 'bad' : '');
const msx = (t) => (t?.n ? `${t.p50 >= 1000 ? (t.p50 / 1000).toFixed(1) + ' s' : Math.round(t.p50) + ' ms'} / ${t.p95 >= 1000 ? (t.p95 / 1000).toFixed(1) + ' s' : Math.round(t.p95) + ' ms'}` : '—');
function diagnosticsView() {
  const D = diagData;
  const head = `<div class="section-title"><h2>Diagnostics — live audit</h2><p>Built only from what this bot measured on this server. Counts persist across restarts.</p></div>
    <div class="seg" style="margin-bottom:var(--gap)">${[1, 6, 24, 168].map((h) => `<button data-diaghours="${h}" class="${h === diagHours ? 'on' : ''}">${h < 24 ? h + ' h' : h / 24 + ' d'}</button>`).join('')}</div>`;
  if (!D) return head + '<div class="empty">Building the report…</div>';
  const rejRow = (r) => `<tr><td class="wrap small">${esc(r.reason)}${r.status ? ` <span class="tag">${esc(r.status)}</span>` : ''}</td><td class="small muted">${esc(r.where)}</td><td class="small">${esc(r.kind)}</td><td class="r num">${r.n}</td></tr>`;
  const allRej = [...D.rejections.engine, ...D.rejections.automatic, ...D.rejections.setuh, ...D.rejections.copy].sort((a, b) => b.n - a.n);
  return head + `
    ${D.demo ? '<div class="notice warn small" style="margin-bottom:var(--gap)">Demo mode: simulated coins. These numbers describe the simulator, not the real market.</div>' : ''}
    ${D.coverageHours < diagHours ? `<div class="notice info small" style="margin-bottom:var(--gap)">Counts cover ${D.coverageHours} h so far (recording started ${D.coverageFrom ? new Date(D.coverageFrom).toLocaleString() : 'just now'}).</div>` : ''}
    ${card('Findings', D.findings.length ? `<table class="t"><tbody>${D.findings.map((f) => `<tr><td style="width:90px"><span class="tag ${SEV[f.severity]}">${f.severity.toUpperCase()}</span></td>
      <td class="wrap"><b>${esc(f.title)}</b><div class="small muted">${esc(f.evidence)}</div><div class="small" style="margin-top:3px">${esc(f.fix)}${f.risk ? ` <span class="warn">Risk: ${esc(f.risk)}</span>` : ''}</div></td>
      <td class="small muted" style="width:70px">Group ${f.group}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No problems detected.</div>', 'group 1 = bug · 2 = speed · 3 = strategy/config', { tight: true })}
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('System health', `<table class="t"><tbody>${D.components.map((c) => `<tr><td style="width:36%"><span class="dot ${STAT(c.status)}"></span> <b>${esc(c.name)}</b><div class="tiny muted">${esc(c.status)}</div></td><td class="small wrap">${esc(c.evidence)}</td></tr>`).join('')}</tbody></table>`, '', { tight: true })}
      <div class="grid" style="align-content:start">
        ${card('Discovery', `<div class="kv">
          <div><small>New coins</small><b>${D.discovery.newCoins}</b></div><div><small>Per hour</small><b>${D.discovery.perHour ?? '—'}</b></div><div><small>Per minute now</small><b>${D.discovery.perMinuteNow}</b></div>
          <div><small>Duplicates ignored</small><b>${D.discovery.duplicates}</b></div><div><small>Scored</small><b>${D.discovery.scored} <span class="tiny muted">${D.discovery.scoredPct ?? '—'}%</span></b></div>
          <div><small>Died before scoring</small><b>${D.discovery.neverScored}</b></div><div><small>Disconnects</small><b>${D.discovery.disconnects}</b></div>
          <div><small>Queue now</small><b>${D.discovery.queueNow}</b></div><div><small>Queue wait p50 / p95</small><b>${msx(D.discovery.queueWait)}</b></div>
          <div><small>Evaluation p50 / p95</small><b>${msx(D.discovery.evalTime)}</b></div><div><small>Discovery latency</small><b>${msx(D.discovery.discoveryLatency)}</b></div></div>`)}
        ${card('Where rejections come from', Object.keys(D.rejectionsByKind).length ? `<table class="t"><tbody>${Object.entries(D.rejectionsByKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="r num">${n}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No rejections recorded yet.</div>', 'mandatory safety vs adjustable', { tight: true })}
      </div>
    </div>
    <div style="margin-top:var(--gap)">${card('Every rejection reason', allRej.length ? `<div class="scroll-x" style="max-height:420px"><table class="t"><thead><tr><th>Reason</th><th>Where</th><th>Kind</th><th class="r">Count</th></tr></thead><tbody>${allRej.map(rejRow).join('')}</tbody></table></div>` : '<div class="empty">None yet.</div>', `${allRej.reduce((a, r) => a + r.n, 0)} total`, { tight: true })}</div>
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Setuh setups', `<div class="scroll-x"><table class="t"><thead><tr><th>Setup</th><th class="r">Episodes</th><th class="r">Entered</th><th class="r">Rejected</th><th class="r">Missed</th><th class="r">Invalidated</th><th class="r">No data</th><th class="r">Skipped</th><th class="r">Trades</th><th class="r">Win</th></tr></thead><tbody>
        ${D.strategy.rows.map((r) => `<tr><td>${esc(r.name)}${r.enabled ? '' : ' <span class="tag">OFF</span>'}</td><td class="r num">${r.closedEpisodes}</td><td class="r num">${r.entered}</td><td class="r num">${r.rejected}</td><td class="r num">${r.missed}</td><td class="r num">${r.invalidated}</td><td class="r num">${r.insufficient}</td><td class="r num">${r.skipped}</td><td class="r num">${r.trades}</td><td class="r num">${r.winRate != null ? r.winRate + '%' : '—'}</td></tr>`).join('')}
        </tbody></table></div><div class="small muted" style="padding:8px 14px">Full safety checks on candidates: ${D.strategy.deepVerdicts.map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || 'none yet'}</div>`, '', { tight: true })}
      ${card('Paper trading activity', `<div class="scroll-x"><table class="t"><thead><tr><th>Book</th><th class="r">Opened</th><th class="r">Closed</th><th class="r">Open now</th><th class="r">Avg size</th><th class="r">Win rate</th><th class="r">Net (closed)</th><th class="r">Unrealized</th><th class="r">Avg hold</th><th class="r">Gap between entries</th></tr></thead><tbody>
        ${D.paper.map((b) => `<tr><td class="b">${esc(b.book)}</td><td class="r num">${b.opened}</td><td class="r num">${b.closed}</td><td class="r num">${b.open}</td><td class="r num">${fmt.usd(b.avgSizeUsd, 2)}</td><td class="r num">${b.winRate != null ? b.winRate + '%' : '—'}</td><td class="r num ${cls(b.netUsd)}">${b.trades ? fmt.signed(b.netUsd) : '—'}</td><td class="r num ${cls(b.unrealizedUsd)}">${b.open ? fmt.signed(b.unrealizedUsd) : '—'}</td><td class="r num">${b.avgHoldSec != null ? fmt.age(b.avgHoldSec) : '—'}</td><td class="r num">${b.avgGapMin != null ? b.avgGapMin + ' min' : '—'}</td></tr>`).join('')}
        </tbody></table></div>`, 'each book separately', { tight: true })}
    </div>
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('Latency (p50 / p95)', `<table class="t"><tbody>${Object.entries(D.latency).map(([k, t]) => `<tr><td>${esc(t.label ?? k)}</td><td class="r num">${msx(t)}</td><td class="r num muted">${t.n}</td></tr>`).join('') || '<tr><td class="muted">No samples yet.</td></tr>'}</tbody></table>`, '', { tight: true })}
      ${card('Storage & learning', `<div class="kv"><div><small>Database</small><b style="font-size:12px">${esc(D.persistence.path ?? '—')}</b></div><div><small>Persistent</small><b class="${D.persistence.persistent ? 'up' : 'down'}">${D.persistence.persistent ? 'yes' : 'NO'}</b></div>
        <div><small>Starts recorded</small><b>${D.persistence.boots}</b></div><div><small>Since</small><b style="font-size:12px">${D.persistence.firstBoot ? new Date(D.persistence.firstBoot).toLocaleString() : '—'}</b></div>
        <div><small>Learning observations</small><b>${D.learning?.samples?.done ?? '—'} / 300</b></div><div><small>Model</small><b style="font-size:12px">${D.learning?.validated ? 'in use' : 'not in use'}</b></div></div>
        <div class="small muted" style="margin-top:8px">${Object.entries(D.persistence.tables).map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}</div>`)}
    </div>`;
}
