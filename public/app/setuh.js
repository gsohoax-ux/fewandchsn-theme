// Paper Trading › Autonomous Setuh Scalping Paper Trader (+ journal & analytics). Simulation only.
import { $, $$, esc, fmt, api, poller, card, cls, toast, uid, kpi, condList } from './core.js';

export const SUBS = [['trader', 'Setuh trader'], ['journal', 'Journal']];
const STAGE = {
  waiting_setup: ['', 'WAITING FOR SETUP'], waiting_confirmation: ['info', 'WAITING FOR CONFIRMATION'], waiting_safety: ['info', 'SAFETY CHECK RUNNING'],
  insufficient_data: ['warn', 'INSUFFICIENT DATA'], pending_approval: ['warn', 'NEEDS YOUR APPROVAL'], entered: ['up', 'APPROVED & ENTERED'],
  rejected: ['down', 'REJECTED'], missed: ['warn', 'ENTRY MISSED'], invalidated: ['', 'SETUP INVALIDATED'], skipped: ['warn', 'SKIPPED'], cancelled: ['', 'CANCELLED'],
};
const ACT = { entry: 'up', closed: '', partial_sell: 'info', rejected: 'down', missed: 'warn', invalidated: '', insufficient_data: 'warn', pending_approval: 'warn',
  approved: 'up', cancelled: '', passed_safety: 'up', confidence: 'info', setup: 'info', waiting_confirmation: 'info', screening: 'info', skipped: 'warn', submitted: 'info', settings: '' };
const SETTING_FIELDS = [
  ['startingBalanceUsd', 'Starting simulated balance ($)'], ['positionUsd', 'Position size per entry ($)'], ['maxOpenPositions', 'Max simultaneous positions'],
  ['maxOpenPerSetup', 'Max open per setup'], ['maxDailyLossUsd', 'Max daily simulated loss ($)'], ['maxExposurePerCoinUsd', 'Max exposure per coin ($)'],
  ['maxEntriesPerCoin', 'Max entries per coin'], ['minEntryGapSec', 'Min seconds between entries on a coin'], ['minConfidence', 'Minimum confidence (0–100)'],
  ['maxSlippagePct', 'Max acceptable slippage %'], ['maxDataAgeSec', 'Max data age (s)'], ['maxHoldMin', 'Max holding time (min)'],
  ['maxEntryDriftPct', 'Max price drift signal → fill %'], ['minRewardRisk', 'Min reward : risk at fill'], ['partialTakePct', 'Sell % at target (partial profit)'],
  ['trailAfterTpPct', 'Trailing stop on the rest after target %'], ['approvalTtlSec', 'Approval window (s)'],
];

let root, sub = 'trader', data = null, journal = null;
const poll = poller(async () => { data = await api('/api/setuh'); if (sub === 'journal') journal = await api('/api/setuh/journal'); if (!root.hidden) render(); }, 2000);

export function mount(el) { root = el; wire(); }
export function show(s) { sub = SUBS.some(([k]) => k === s) ? s : 'trader'; poll.start(); poll.now(); render(); }
export function hide() { poll.stop(); }

const sym = (x) => (x.symbol ? `$${esc(x.symbol)}` : esc((x.mint ?? '').slice(0, 6) + '…'));
const coinLink = (x) => `<a href="#/check/coin?mint=${esc(x.mint)}">${sym(x)}</a>`;

function render() {
  if (!data) { root.innerHTML = '<div class="empty">Loading the Setuh trader…</div>'; return; }
  if (root.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  const keep = window.scrollY;
  root.innerHTML = sub === 'journal' ? journalView() : trader();
  window.scrollTo(0, keep);
}

// ------------------------------------------------------------------ trader
function trader() {
  const S = data.settings, B = data.balance;
  const feedOk = data.feed.ok;
  const head = `<div class="section-title"><h2>Autonomous Setuh Scalping Paper Trader</h2><p>Finds, checks and paper-trades the five Setuh setups on its own. Own balance, positions and history. Simulated money only — no wallet, no real orders.</p></div>
    <div class="kpis">
      ${kpi('Equity', fmt.usd(B.equityUsd, 2), `started with ${fmt.usd(B.startingUsd, 0)}`)}
      ${kpi('Cash', fmt.usd(B.cashUsd, 2), `${fmt.usd(B.investedUsd, 2)} in open entries`)}
      ${kpi('Total return', fmt.pct(B.returnPct, 1), `realized ${fmt.signed(B.realizedUsd)}`, cls(B.returnPct))}
      ${kpi('Today', fmt.signed(B.todayPnlUsd), B.dailyLossHit ? 'DAILY LOSS LIMIT HIT — no new entries' : `limit −${fmt.usd(S.maxDailyLossUsd, 0)}`, B.dailyLossHit ? 'down' : cls(B.todayPnlUsd))}
      ${kpi('Open entries', data.open.length, `${new Set(data.open.map((p) => p.mint)).size} coins · max ${S.maxOpenPositions}`)}
      ${kpi('Live data', feedOk ? 'HEALTHY' : 'BLOCKED', feedOk ? 'entries allowed' : 'feed stale or disconnected: no new entries', feedOk ? 'up' : 'down')}
    </div>`;
  const controls = card('Controls', `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
      <div class="seg"><button data-mode="autonomous" class="${S.mode === 'autonomous' ? 'on' : ''}">Fully autonomous</button><button data-mode="approval" class="${S.mode === 'approval' ? 'on' : ''}">Ask me first (approval)</button></div>
      <button class="btn ${S.discoveryPaused ? 'primary' : ''}" data-toggle="discoveryPaused">${S.discoveryPaused ? 'Resume discovery' : 'Pause discovery'}</button>
      <button class="btn ${S.entriesPaused ? 'primary' : ''}" data-toggle="entriesPaused">${S.entriesPaused ? 'Resume new entries' : 'Pause new entries'}</button>
      <span class="small muted">${S.discoveryPaused ? 'Discovery paused: only coins you send in are checked.' : 'Scanning every live coin for the five setups.'} ${S.entriesPaused ? 'New entries paused; open positions are still managed.' : ''}</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><input class="input mono" id="sq" placeholder="Send a coin to the Setuh trader: paste its address" style="flex:1 1 320px"><button class="btn primary" data-submit>Send to Setuh trader</button></div>
    ${data.focus.length ? `<div class="small" style="margin-top:8px"><span class="muted">Coins you sent in:</span> ${data.focus.map((f) => `<span class="tag info">${f.symbol ? '$' + esc(f.symbol) : esc(f.mint.slice(0, 6))} <a href="#" data-unsubmit="${esc(f.mint)}" style="color:inherit;margin-left:4px">×</a></span>`).join(' ')}</div>` : ''}
    <p class="tiny muted" style="margin-bottom:0">Every entry needs ALL of: the setup's rules met, the critical safety gates passed (a high confidence score never overrides a failed gate), confidence ≥ ${S.minConfidence}, a price no older than ${S.maxDataAgeSec}s at the moment of the fill, and the risk limits. ${S.mode === 'approval' ? 'Approval mode: entries wait for you, and are re-checked with fresh data when you approve.' : ''}</p>`);
  const pend = data.pending.length ? card('Waiting for your approval', data.pending.map((p) => `<div class="pos"><div class="pos-top">${coinLink(p)}<span class="tag info">${esc(p.setup)}</span>
      <span class="small muted">confidence <b>${p.confidence?.score ?? '—'}</b> · signal at ${fmt.usd(p.signalMcUsd)} · expires in ${fmt.age((p.expiresAt - Date.now()) / 1000)}</span>
      <span style="margin-left:auto;display:flex;gap:6px"><button class="btn sm buy" data-approve="${esc(p.id)}">Approve entry</button><button class="btn sm" data-cancel="${esc(p.id)}">Cancel</button></span></div>
      <div class="small">${esc(p.why ?? '')}</div></div>`).join(''), 'fresh data is re-checked when you approve', { tight: true }) : '';
  const groups = new Map();
  for (const p of data.open) { if (!groups.has(p.mint)) groups.set(p.mint, []); groups.get(p.mint).push(p); }
  const positions = card('Open positions by coin', groups.size ? [...groups.values()].map(coinGroup).join('') : '<div class="empty">No open positions. Entries appear here as Entry 1, Entry 2… per coin.</div>', 'each entry managed separately', { tight: true });
  const cands = card('Candidates being watched', data.watching.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Coin</th><th>Setup</th><th>Decision</th><th class="r">Rules met</th><th class="r">MC now</th><th class="r">Confidence</th><th>Waiting for</th></tr></thead><tbody>
    ${data.watching.map((w) => { const [c, l] = STAGE[w.status] ?? ['', w.status]; const met = (w.conditions ?? []).filter((x) => x.ok === true).length;
      return `<tr><td class="b">${coinLink(w)}${w.focus ? ' <span class="tag">YOURS</span>' : ''}</td><td class="small">${esc(w.setup)}</td><td><span class="tag ${c}">${l}</span></td><td class="r num">${met}/${(w.conditions ?? []).length}</td>
        <td class="r num">${fmt.usd(w.mcUsd)}</td><td class="r num">${w.confidence?.score ?? '—'}</td><td class="small wrap" style="max-width:360px">${esc((w.unconfirmed ?? []).slice(0, 2).join(' · ') || w.reason || '')}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">No setup forming right now.</div>', `${data.watching.length} candidates · ${data.deepChecks.running} safety checks running`, { tight: true });
  const feed = card('Live activity', `<ul class="list" style="max-height:520px;overflow:auto">${data.activity.length ? data.activity.map((a) => `<li class="click" data-act="${esc(a.positionId ?? '')}" data-mint="${esc(a.mint ?? '')}" style="cursor:pointer;padding:8px 14px">
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><span class="tiny muted num">${new Date(a.at).toLocaleTimeString()}</span><span class="tag ${ACT[a.type] ?? ''}">${esc(a.type.replace(/_/g, ' ').toUpperCase())}</span>
        ${a.mint ? `<b>${a.symbol ? '$' + esc(a.symbol) : esc(a.mint.slice(0, 6))}</b>` : ''}${a.setup ? `<span class="tiny muted">${esc(a.setup)}</span>` : ''}</div>
      <div class="small" style="margin-top:2px">${esc(a.text)}</div></li>`).join('') : '<li class="empty">Nothing yet. Every step the trader takes appears here.</li>'}</ul>`, 'tap an event for the coin or trade', { tight: true });
  const settings = card('Risk controls', `<details><summary>Show settings · $${S.positionUsd}/entry · max ${S.maxEntriesPerCoin} entries/coin · min confidence ${S.minConfidence} · max data age ${S.maxDataAgeSec}s</summary>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:10px">${SETTING_FIELDS.map(([k, l]) => `<div class="field"><label>${esc(l)}</label><input class="input mono" data-s="${k}" type="number" step="any" value="${S[k]}"></div>`).join('')}
        <label class="check small"><input type="checkbox" data-s="requireVerifiedSafety" ${S.requireVerifiedSafety ? 'checked' : ''}> Require verified on-chain safety (block UNVERIFIED coins)</label>
        <label class="check small"><input type="checkbox" data-s="requireDeepCheck" ${S.requireDeepCheck ? 'checked' : ''}> Require the full Coin Check before any entry</label></div>
      <div style="margin-top:10px"><button class="btn primary sm" data-savesettings>Save risk controls</button> <span class="tiny muted">Setup rules are in Setuh Strategy › Rules & thresholds. Nothing is changed automatically.</span></div></details>`);
  return `${head}<div class="grid" style="gap:var(--gap)">${controls}${pend}${positions}<div class="grid g2">${cands}${feed}</div>${settings}</div>
    <p class="disclaimer">Simulated fills at the newest available price with fees and slippage. Targets are plans, not likely outcomes. Paper gains can't be cashed out in a thin pool.</p>`;
}

function coinGroup(list) {
  const f = list[0];
  const inv = list.reduce((s, p) => s + p.budgetUsd, 0), val = list.reduce((s, p) => s + p.ifSoldUsd + 0, 0), pnl = list.reduce((s, p) => s + p.pnlUsd, 0);
  return `<div class="pos"><div class="pos-top">${coinLink(f)}<span class="tag info">${list.length} ENTR${list.length === 1 ? 'Y' : 'IES'}</span>
      <span class="small muted">combined: ${fmt.usd(inv, 2)} in · value if sold ${fmt.usd(val, 2)} · now ${fmt.price(f.priceUsd)} (MC ${fmt.usd(f.mcUsd)}) · ${esc(f.source)}${f.staleSec > 15 ? ` · <span class="warn">price ${fmt.age(f.staleSec)} old</span>` : ''}</span>
      <span style="margin-left:auto" class="num ${cls(pnl)}"><b>${fmt.signed(pnl)}</b></span><button class="btn sm sell" data-closecoin="${esc(f.mint)}">Close all</button></div>
    <div class="scroll-x"><table class="t"><thead><tr><th>Entry</th><th>Setup</th><th class="r">Conf.</th><th class="r">Signal</th><th class="r">Decision</th><th class="r">Fill (avg cost)</th><th class="r">Now</th><th class="r">Size</th><th class="r">P&L</th><th>Stop / target / trail</th><th class="r">Held</th><th></th></tr></thead><tbody>
    ${list.sort((a, b) => (a.meta?.entryNo ?? 0) - (b.meta?.entryNo ?? 0)).map((p) => { const m = p.meta ?? {};
      return `<tr class="click" data-entry="${esc(p.id)}"><td class="b">Entry ${m.entryNo ?? '?'}</td><td class="small">${esc(p.origin)}</td><td class="r num">${m.confidence?.score ?? '—'}</td>
        <td class="r num small">${fmt.price(m.signal?.priceUsd)}</td><td class="r num small">${fmt.price(m.decision?.priceUsd)}<div class="tiny muted">${m.decision ? `${(m.decision.ageMs / 1000).toFixed(1)}s old` : ''}</div></td>
        <td class="r num small">${fmt.price(m.fill?.priceUsd ?? p.entryPriceUsd)}<div class="tiny muted">${fmt.price(p.avgCostUsd)}</div></td><td class="r num small ${cls(p.priceChangePct)}">${fmt.price(p.priceUsd)}</td>
        <td class="r num">${fmt.usd(p.budgetUsd, 2)}${p.soldPct > 0.5 ? `<div class="tiny muted">${p.soldPct.toFixed(0)}% sold</div>` : ''}</td><td class="r num ${cls(p.pnlUsd)}">${fmt.signed(p.pnlUsd)}<div class="tiny">${fmt.pct(p.pnlPct, 1)}</div></td>
        <td class="small num">${fmt.price(p.levels.stop)} / ${p.levels.target ? fmt.price(p.levels.target) : '—'} / ${p.levels.trail ? fmt.price(p.levels.trail) : '—'}</td><td class="r num small">${fmt.age(p.holdSec)}</td>
        <td class="r"><button class="btn sm sell" data-sell="50" data-id="${esc(p.id)}">50%</button> <button class="btn sm sell" data-sell="100" data-id="${esc(p.id)}">Close</button></td></tr>`; }).join('')}
    </tbody></table></div></div>`;
}

// ------------------------------------------------------------------ journal
function journalView() {
  if (!journal) return '<div class="empty">Loading the journal…</div>';
  const P = data.performance;
  const pf = (x) => (x.profitFactorInfinite ? '∞' : x.profitFactor != null ? x.profitFactor.toFixed(2) : '—');
  const rows = Object.values(P.bySetup);
  const line = (x, name) => `<tr><td class="b">${name}</td><td class="r num">${x.trades}</td><td class="r num">${x.winRate != null ? x.winRate + '%' : '—'}</td>
    <td class="r num ${cls(x.netUsd)}">${x.trades ? fmt.signed(x.netUsd / x.trades) : '—'}</td><td class="r num">${pf(x)}</td><td class="r num down">${x.maxDrawdownUsd ? fmt.signed(-x.maxDrawdownUsd) : '—'}</td>
    <td class="r num">${x.avgHoldSec != null ? fmt.age(x.avgHoldSec) : '—'}</td><td class="r num ${cls(x.returnPct)}">${x.trades ? fmt.pct(x.returnPct, 2) : '—'}</td>
    <td class="r num">${x.missed ?? '—'}</td><td class="r num">${x.rejected ?? '—'}</td><td class="r num">${x.insufficient ?? '—'}</td><td class="r num">${x.invalidated ?? '—'}</td></tr>`;
  const bands = Object.entries(P.byConfidence).sort();
  return `<div class="section-title"><h2>Setuh journal & analytics</h2><p>Every entry and exit of the autonomous trader. Past paper results — not predictions.</p></div>
    ${card('Performance by setup', `<div class="scroll-x"><table class="t"><thead><tr><th>Setup</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Avg P&L</th><th class="r">Profit factor</th><th class="r">Max drawdown</th><th class="r">Avg hold</th><th class="r">Return</th><th class="r">Missed</th><th class="r">Rejected</th><th class="r">No data</th><th class="r">Invalidated</th></tr></thead>
      <tbody>${rows.map((x) => line(x, `${esc(x.family)} · ${esc(x.name)}`)).join('')}${line(P.all, 'All setups')}</tbody></table></div>`, 'Setuh book only', { tight: true })}
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('By confidence range', bands.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Confidence</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Net</th><th class="r">Profit factor</th></tr></thead><tbody>${bands.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${v.trades}</td><td class="r num">${v.winRate}%</td><td class="r num ${cls(v.netUsd)}">${fmt.signed(v.netUsd)}</td><td class="r num">${pf(v)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No completed trades yet.</div>', '', { tight: true })}
      ${card('Review notes (never applied automatically)', `<ul class="checks">${P.review.map((n) => `<li class="${n.level === 'warn' ? 'lv-warn' : 'lv-info'}">${esc(n.text)}</li>`).join('') || '<li class="lv-info">Nothing to review yet.</li>'}</ul>
        <p class="tiny muted" style="margin-bottom:0">The trader never changes its rules by itself. These notes need enough trades to mean anything; you decide in Rules & thresholds.</p>`)}
    </div>
    <div style="margin-top:var(--gap)">${card('Combined open positions per coin', journal.coins.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Coin</th><th class="r">Entries</th><th>Setups</th><th class="r">Invested</th><th class="r">Value if sold</th><th class="r">P&L</th></tr></thead><tbody>${journal.coins.map((c) => `<tr><td class="b">${coinLink(c)}</td><td class="r num">${c.entries}</td><td class="small">${c.setups.map(esc).join(', ')}</td><td class="r num">${fmt.usd(c.investedUsd, 2)}</td><td class="r num">${fmt.usd(c.valueUsd, 2)}</td><td class="r num ${cls(c.pnlUsd)}">${fmt.signed(c.pnlUsd)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No open positions.</div>', '', { tight: true })}</div>
    <div style="margin-top:var(--gap)">${card('Trade journal (one row per entry)', journal.entries.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Coin</th><th>Setup</th><th class="r">Entry</th><th class="r">Conf.</th><th>Safety</th><th>Entered</th><th class="r">Signal</th><th class="r">Fill</th><th class="r">Size</th><th>Exited</th><th class="r">Exit (avg)</th><th class="r">Fees + slip.</th><th class="r">P&L</th><th>Exit reason</th></tr></thead><tbody>
      ${journal.entries.map((e) => `<tr class="click" data-entry="${esc(e.id)}"><td class="b">${coinLink(e)}<div class="tiny faint mono">${esc(e.mint.slice(0, 4))}…${esc(e.mint.slice(-4))}</div></td><td class="small">${esc(e.family)}<div class="tiny muted">${esc(e.setupName)}</div></td>
        <td class="r num">${e.entryNo ?? '—'}</td><td class="r num">${e.confidence ?? '—'}</td><td class="small v-${e.safety?.report?.verdict ?? ''}">${e.safety?.report ? `${esc(e.safety.report.verdict)} ${e.safety.report.score}` : 'live est.'}</td>
        <td class="small muted">${fmt.dateTime(e.openedAt)}</td><td class="r num small">${fmt.price(e.signal?.priceUsd)}</td><td class="r num small">${fmt.price(e.fill?.priceUsd)}</td><td class="r num">${fmt.usd(e.sizeUsd, 2)}</td>
        <td class="small muted">${e.closedAt ? fmt.dateTime(e.closedAt) : '<span class="tag info">OPEN</span>'}</td><td class="r num small">${fmt.price(e.exitPriceUsd)}</td><td class="r num">${fmt.usd(e.feesUsd + e.slippageUsd, 2)}</td>
        <td class="r num ${cls(e.pnlUsd)}">${fmt.signed(e.pnlUsd)}<div class="tiny">${fmt.pct(e.pnlPct, 1)}</div></td><td class="small wrap" style="max-width:240px">${esc(e.exitReason ?? '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No trades yet.</div>', `${journal.entries.length} entries`, { tight: true })}</div>`;
}

// entry details dialog
function openEntry(id) {
  const e = journal?.entries.find((x) => x.id === id);
  const p = e ?? data.open.find((x) => x.id === id) ?? data.closed.find((x) => x.id === id);
  if (!p) { api('/api/setuh/journal').then((j) => { journal = j; if (j.entries.find((x) => x.id === id)) openEntry(id); }).catch(() => {}); return; }
  const m = e ? { entryNo: e.entryNo, confidence: { score: e.confidence, parts: e.confidenceParts }, safety: e.safety, signal: e.signal, decision: e.decision, fill: e.fill, why: e.why } : p.meta ?? {};
  $('#dlg-h').innerHTML = `<div><div class="b">${sym(p)} · Entry ${m.entryNo ?? '?'} · ${esc(e?.setupName ?? p.origin)}</div><code class="muted">${esc(p.mint)}</code></div><button class="x" data-close aria-label="Close">×</button>`;
  $('#dlg-b').innerHTML = `
    <div class="kv" style="margin-top:10px">
      <div><small>Signal price</small><b>${fmt.price(m.signal?.priceUsd)}</b></div><div><small>Decision price</small><b>${fmt.price(m.decision?.priceUsd)}</b></div>
      <div><small>Simulated fill</small><b>${fmt.price(m.fill?.priceUsd)}</b></div><div><small>Avg cost (fees+slip)</small><b>${fmt.price(m.fill?.avgCostUsd)}</b></div>
      <div><small>Data age at decision</small><b>${m.decision ? (m.decision.ageMs / 1000).toFixed(1) + 's' : '—'}</b></div><div><small>Signal → fill</small><b>${m.fill?.signalToEntryMs != null ? fmt.age(m.fill.signalToEntryMs / 1000) : '—'}</b></div>
      <div><small>Execution</small><b>${m.fill?.execMs != null ? Math.round(m.fill.execMs) + ' ms' : '—'}</b></div><div><small>P&L</small><b class="${cls(p.pnlUsd)}">${fmt.signed(p.pnlUsd)} (${fmt.pct(p.pnlPct, 1)})</b></div>
    </div>
    <h3>Why it entered</h3><p class="small">${esc(m.why ?? '')}</p>
    ${m.confidence?.parts?.length ? `<h3>Confidence ${m.confidence.score}/100</h3><table class="t"><tbody>${m.confidence.parts.map((x) => `<tr><td>${esc(x.label)}</td><td class="r num">${x.points} / ${x.max}</td><td class="small muted">${esc(x.detail)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${m.safety?.gates ? `<h3>Safety gates</h3><ul class="checks">${m.safety.gates.passed.map((g) => `<li class="lv-ok">${esc(g.text)}</li>`).join('')}${m.safety.gates.unknown.map((g) => `<li class="lv-unknown">${esc(g.text)}</li>`).join('')}</ul>` : ''}
    ${(p.meta?.conditions ?? []).length ? `<h3>Setup rules at entry</h3>${condList(p.meta.conditions)}` : ''}
    <h3>Fills</h3><table class="t"><tbody>${(p.fills ?? []).map((f) => `<tr><td class="small muted">${new Date(f.at).toLocaleTimeString()}</td><td><span class="tag ${f.kind === 'buy' ? 'up' : 'down'}">${f.kind.toUpperCase()}${f.kind === 'sell' && f.pct ? ' ' + Math.round(f.pct) + '%' : ''}</span></td><td class="r num small">${fmt.price(f.priceUsd)}</td><td class="r num small">${f.kind === 'buy' ? '−' + fmt.usd(f.grossUsd, 2) : '+' + fmt.usd(f.netUsd, 2)}</td><td class="small wrap">${esc(f.reason)}</td></tr>`).join('')}</tbody></table>
    ${p.exitReason ? `<h3>Exit</h3><p class="small">${esc(p.exitReason)}</p>` : ''}
    <p class="tiny faint">Simulated trade. Signal = price when every rule was first met; decision = newest price fetched right before the fill; fill = that price plus impact and sandwich costs; average cost adds fees.</p>`;
  if (!$('#dlg').open) $('#dlg').showModal();
}

// ------------------------------------------------------------------ events
function wire() {
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'good'); document.activeElement?.blur(); data = await api('/api/setuh'); render(); } catch (err) { toast(err.message, 'bad'); } };
    const md = t.closest('[data-mode]');
    if (md) return run(() => api('/api/strategy/config', { values: { mode: md.dataset.mode } }), md.dataset.mode === 'approval' ? 'Approval mode: entries wait for you' : 'Fully autonomous');
    const tg = t.closest('[data-toggle]');
    if (tg) { const k = tg.dataset.toggle; return run(() => api('/api/strategy/config', { values: { [k]: !data.settings[k] } }), 'Saved'); }
    if (t.closest('[data-submit]')) { const q = $('#sq', root).value.trim(); return run(() => api('/api/setuh/submit', { mint: q }), (r) => `Sent in. ${r.note}`); }
    const us = t.closest('[data-unsubmit]');
    if (us) { e.preventDefault(); return run(() => api('/api/setuh/unsubmit', { mint: us.dataset.unsubmit }), 'Removed'); }
    const ap = t.closest('[data-approve]');
    if (ap) { ap.disabled = true; return run(() => api('/api/setuh/approve', { id: ap.dataset.approve }), (r) => r.status === 'entered' ? `Entry ${r.entryNo} executed` : `Not entered: ${r.reason}`); }
    const cn = t.closest('[data-cancel]');
    if (cn) return run(() => api('/api/setuh/cancel', { id: cn.dataset.cancel }), 'Cancelled');
    const sl = t.closest('[data-sell]');
    if (sl) { e.stopPropagation(); const pct = Number(sl.dataset.sell); if (pct >= 100 && !confirm('Close this entry now?')) return; sl.disabled = true; return run(() => api('/api/strategy/sell', { id: sl.dataset.id, pct, requestId: uid() }), `Sold ${pct}%`); }
    const cc = t.closest('[data-closecoin]');
    if (cc) { if (!confirm('Close every entry on this coin?')) return; return run(() => api('/api/setuh/close-coin', { mint: cc.dataset.closecoin, requestId: uid() }), (r) => `Closed ${r.closed} entr${r.closed === 1 ? 'y' : 'ies'}`); }
    if (t.closest('[data-savesettings]')) {
      const v = {}; for (const el of $$('[data-s]', root)) v[el.dataset.s] = el.type === 'checkbox' ? el.checked : Number(el.value);
      return run(() => api('/api/strategy/config', { values: v }), 'Risk controls saved');
    }
    if (t.closest('a')) return;
    const en = t.closest('[data-entry]');
    if (en) { if (!journal) journal = await api('/api/setuh/journal').catch(() => null); return openEntry(en.dataset.entry); }
    const act = t.closest('[data-act]');
    if (act) {
      if (act.dataset.act) { if (!journal) journal = await api('/api/setuh/journal').catch(() => null); return openEntry(act.dataset.act); }
      if (act.dataset.mint) location.hash = `#/check/coin?mint=${act.dataset.mint}`;
    }
  });
}
