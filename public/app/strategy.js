// Section 2: Strategy — the Setuh scalping setups (System B). Own budget, positions, history and stats,
// completely separate from the automatic paper trader and from manual positions.
import { $, $$, esc, fmt, api, poller, card, cls, toast, uid, condList, kpi } from './core.js';

export const SUBS = [['newpairs', 'New Pairs'], ['final', 'Final Stretch'], ['migrated', 'Migrated Coins'], ['performance', 'Performance'], ['settings', 'Rules & settings']];
const FAMILY = { newpairs: ['newPairs'], final: ['finalA', 'finalB', 'finalC'], migrated: ['migrated'] };
const LABELS = {
  enabled: 'Enabled', maxAgeMin: 'Max coin age (min)', minRunMult: 'Launch run needed (x)', pullbackMinPct: 'Pullback from high: min %', pullbackMaxPct: 'Pullback from high: max %',
  candleSec: 'Candle size (sec)', floorCandles: 'Floor: candles', floorMaxRangePct: 'Floor: max range %', flowWindowSec: 'Flow window (sec)', minBuyRatio: 'Buys ÷ sells needed',
  minBuyers: 'Min buyers in window', minNarrative: 'Min narrative score', maxBundleHeldPct: 'Max % held by bundles', targetPct: 'Take-profit %', stopPct: 'Stop-loss %',
  earlyTakeMinPct: 'Early take: min gain %', earlySellRatio: 'Early take: sells ÷ buys', maxHoldMin: 'Time stop (min)', minPeakMcUsd: 'Min high (market cap $)',
  requireInsiderSelling: 'Require bundle / tracked selling', insiderSoldPct: 'Bundle wallets sold ≥ %', sellExhaustRatio: 'Sellers exhausted: ≤ ratio of peak selling',
  minRiseToHighPct: 'Rise into the high ≥ %', minDevGraduated: 'Dev graduated coins ≥', maxDevRugs: 'Dev rugs allowed ≤', minAgeMin: 'Min age (min)',
  rangeCandles: 'Range: candles', rangeMaxPct: 'Range: max width %', supportMinMcUsd: 'Support zone from ($ MC)', supportMaxMcUsd: 'Support zone to ($ MC)',
  breakoutVolMult: 'Breakout volume ≥ x average', minLiqUsd: 'Min pool liquidity ($)',
};
const STATUS_TAG = { watch: '', valid: 'info', entered: 'up', skipped: 'warn', rejected: 'down' };

let root, sub = 'newpairs', data = null;
const poll = poller(async () => { data = await api('/api/strategy'); if (!root.hidden) render(); }, 3000);

export function mount(el) { root = el; wire(); }
export function show(s) { sub = SUBS.some(([k]) => k === s) ? s : 'newpairs'; poll.start(); render(); }
export function hide() { poll.stop(); }

function render() {
  if (!data) { root.innerHTML = '<div class="empty">Loading the strategy engine…</div>'; return; }
  if (root.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return; // don't wipe a form you're editing
  const b = data.budget, st = data.settings, sum = data.summary;
  const head = `<div class="section-title"><h2>Setuh strategy workspace</h2><p>Independent paper trading: its own budget, positions and results — never mixed with the automatic system or your manual trades.</p></div>
    <div class="kpis">
      ${kpi('Engine', st.enabled ? 'ON' : 'OFF', st.enabled ? 'scanning and paper-entering' : 'still scanning; no entries', st.enabled ? 'up' : 'down')}
      ${kpi("Today's budget", `${fmt.usd(b.leftUsd, 0)} left`, `${fmt.usd(b.spentUsd, 0)} of ${fmt.usd(b.dailyUsd, 0)} used · ${fmt.usd(b.perTradeUsd, 0)} per trade`)}
      ${kpi('Open positions', data.open.length, `max ${st.maxOpen} · ${st.maxOpenPerSetup} per setup`)}
      ${kpi('Forming now', data.watching.length, `${data.migratedWatching} graduates being watched`)}
      ${kpi('Closed trades', sum.trades, sum.trades ? `win ${sum.winRate}% · net ${fmt.signed(sum.netUsd)}` : 'no results yet', sum.trades ? cls(sum.netUsd) : '')}
    </div>`;
  let body = '';
  if (FAMILY[sub]) body = family(FAMILY[sub]);
  else if (sub === 'performance') body = performance();
  else body = settings();
  root.innerHTML = head + body;
}

// ------------------------------------------------------------------ family view
function family(ids) {
  const cfg = data.config.setups;
  const perf = data.performance.bySetup;
  const setupCards = ids.map((id) => {
    const c = cfg[id], v = c.values, p = perf[id];
    const rules = ruleSummary(id, v);
    return `<div class="card"><header><h2>${esc(c.name)}</h2><div class="meta"><button class="btn sm ${v.enabled ? '' : 'primary'}" data-toggle="${id}">${v.enabled ? 'Disable' : 'Enable'}</button></div></header>
      <div class="body"><p class="small" style="margin-top:0">${esc(c.summary)}</p>
        <ul class="checks small">${rules.map((r) => `<li class="lv-info">${r}</li>`).join('')}</ul>
        <div class="kv" style="margin-top:10px"><div><small>Detected</small><b>${p.detected}</b></div><div><small>Valid</small><b>${p.valid}</b></div><div><small>Rejected</small><b>${p.rejected}</b></div>
          <div><small>Entered</small><b>${p.entered}</b></div><div><small>Win rate</small><b>${p.winRate != null ? p.winRate + '%' : '—'}</b></div><div><small>Net</small><b class="${cls(p.netUsd)}">${p.trades ? fmt.signed(p.netUsd) : '—'}</b></div></div>
        ${v.enabled ? '' : '<div class="notice warn small" style="margin-top:10px">Disabled: not scanning.</div>'}</div></div>`;
  }).join('');
  const watching = data.watching.filter((w) => ids.includes(w.setup));
  const candHtml = watching.length ? watching.map((w) => signalBlock(w, cfg)).join('') : `<div class="empty">Nothing forming right now. Candidates appear here as soon as the price pattern starts to form, with every rule shown as met (✓), failed (✕) or not yet confirmed (?).</div>`;
  const sigs = data.signals.filter((s) => ids.includes(s.setup) && s.status !== 'watch').slice(0, 30);
  const sigHtml = sigs.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Time</th><th>Coin</th><th>Setup</th><th>Result</th><th>Why</th></tr></thead><tbody>${sigs.map((s) => `<tr>
      <td class="small muted">${fmt.time(s.updatedAt ?? s.at)}</td><td class="b"><a href="#/trade/workstation?mint=${esc(s.mint)}">$${esc(s.symbol || s.mint.slice(0, 6))}</a></td><td class="small">${esc(cfg[s.setup]?.name ?? s.setup)}</td>
      <td><span class="tag ${STATUS_TAG[s.status]}">${s.status.toUpperCase()}</span></td><td class="wrap small" style="max-width:520px">${esc(s.status === 'entered' ? s.why : s.reason ?? s.why ?? '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No completed signals yet.</div>';
  const open = data.open.filter((p) => ids.includes(p.origin));
  return `<div class="grid ${ids.length > 1 ? 'g3' : ''}" style="${ids.length > 1 ? '' : 'max-width:720px'}">${setupCards}</div>
    <div style="margin-top:var(--gap)">${card('Live candidates', candHtml, `${watching.length} forming`, { tight: true })}</div>
    <div style="margin-top:var(--gap)">${card('Strategy positions', open.length ? open.map(posBlock).join('') : '<div class="empty">No open positions from these setups.</div>', 'exits run automatically on the server', { tight: true })}</div>
    <div style="margin-top:var(--gap)">${card('Signal log', sigHtml, 'valid · entered · skipped · rejected', { tight: true })}</div>`;
}

function ruleSummary(id, v) {
  const k = (x) => fmt.usd(x, 0);
  const r = {
    newPairs: [`Coin under ${v.maxAgeMin} min; launch ran ${v.minRunMult}x+ first (never chase the launch pump)`, `Pullback ${v.pullbackMinPct}–${v.pullbackMaxPct}% to a floor (${v.floorCandles} × ${v.candleSec}s candles within ${v.floorMaxRangePct}%)`,
      `Buyers back: buys ≥ ${v.minBuyRatio}x sells, ${v.minBuyers}+ buyers in ${v.flowWindowSec}s; narrative ≥ ${v.minNarrative}; bundles ≤ ${v.maxBundleHeldPct}%`, `Target +${v.targetPct}% (early take on heavy selling after +${v.earlyTakeMinPct}%) · stop −${v.stopPct}% or under the floor · ${v.maxHoldMin} min time stop`],
    finalA: [`High of ${k(v.minPeakMcUsd)}+ market cap, then bundle / tracked wallets sell ${v.insiderSoldPct}%+`, `Retrace ${v.pullbackMinPct}–${v.pullbackMaxPct}% to a floor that holds (${v.floorCandles} candles within ${v.floorMaxRangePct}%)`,
      `Sellers exhausted (selling ≤ ${Math.round(v.sellExhaustRatio * 100)}% of peak) and buys ≥ ${v.minBuyRatio}x sells`, `Target +${v.targetPct}% · stop −${v.stopPct}% or under the floor · ${v.maxHoldMin} min time stop`],
    finalB: [`Local high above ${k(v.minPeakMcUsd)}, after rising ${v.minRiseToHighPct}%+ into it`, `Retrace ${v.pullbackMinPct}–${v.pullbackMaxPct}%, then ${v.floorCandles} stable candles within ${v.floorMaxRangePct}%`,
      `Buys ≥ ${v.minBuyRatio}x sells`, `Target +${v.targetPct}% · stop −${v.stopPct}% or under the floor · ${v.maxHoldMin} min time stop`],
    finalC: [`Developer with ${v.minDevGraduated}+ graduated coin(s) and ≤ ${v.maxDevRugs} rugs, or on your tracked list (blocked devs excluded)`, `Selling exhausted (≤ ${Math.round(v.sellExhaustRatio * 100)}% of peak), then ${v.rangeCandles} sideways candles within ${v.rangeMaxPct}%`,
      `Entry only on a close above the range with buys ≥ ${v.minBuyRatio}x sells`, `Target +${v.targetPct}% · stop −${v.stopPct}% or under the range · ${v.maxHoldMin} min time stop`],
    migrated: [`Graduated coins ${v.minAgeMin / 60}–${v.maxAgeMin / 60} h old with ${k(v.minLiqUsd)}+ pool liquidity`, `Prior high ${k(v.minPeakMcUsd)}+, pullback ${v.pullbackMinPct}–${v.pullbackMaxPct}% into ${k(v.supportMinMcUsd)}–${k(v.supportMaxMcUsd)}`,
      `${v.rangeCandles} × 5-min candles sideways within ${v.rangeMaxPct}%, floor holding — a drop alone is never an entry`, `Breakout close above the range on ${v.breakoutVolMult}x volume · target +${v.targetPct}% · stop −${v.stopPct}% or under support`],
  };
  return r[id] ?? [];
}

function signalBlock(w, cfg) {
  const met = w.conditions.filter((c) => c.ok === true).length;
  return `<div class="pos"><div class="pos-top"><a class="tk" href="#/trade/workstation?mint=${esc(w.mint)}">$${esc(w.symbol || w.mint.slice(0, 6))}</a><span class="tag info">${esc(cfg[w.setup]?.name ?? w.setup)}</span>
      <span class="small muted">forming since ${fmt.time(w.at)} · ${met}/${w.conditions.length} rules met · now ${fmt.usd(w.mcUsd)}</span></div>
    <div class="grid g2"><div>${condList(w.conditions)}</div>
      <div class="small">${w.entry ? `<div class="kv"><div><small>Entry (if confirmed)</small><b>${fmt.usd(w.entry.mcUsd)}</b></div><div><small>Invalidation</small><b class="down">${fmt.usd(w.invalidation.mcUsd)}</b></div>
        <div><small>Target</small><b class="up">${fmt.usd(w.target.mcUsd)}</b></div><div><small>Reward : risk</small><b>${w.rewardRisk ? w.rewardRisk.toFixed(1) + ' : 1' : '—'}</b></div></div>
        <p class="tiny muted">Invalidation: ${esc(w.invalidation.why)} (−${w.invalidation.pct.toFixed(1)}%). Planned levels on paper, not expected outcomes.</p>` : ''}
        ${w.unconfirmed?.length ? `<p class="small"><span class="muted">Still unconfirmed:</span> ${w.unconfirmed.map(esc).join('; ')}</p>` : ''}</div></div></div>`;
}

function posBlock(p) {
  const m = p.meta ?? {};
  return `<div class="pos" data-pos="${esc(p.id)}"><div class="pos-top"><a class="tk" href="#/trade/workstation?mint=${esc(p.mint)}">$${esc(p.symbol || p.mint.slice(0, 6))}</a><span class="tag info">${esc(data.config.setups[p.origin]?.name ?? p.origin)}</span>
      <span class="small muted">opened ${fmt.ago(p.openedAt)} · ${esc(p.source)}${p.staleSec > 60 ? ` · <span class="warn">price ${fmt.age(p.staleSec)} old</span>` : ''}</span>
      <span style="margin-left:auto" class="num ${cls(p.pnlUsd)}"><b>${fmt.signed(p.pnlUsd)}</b> ${fmt.pct(p.pnlPct, 1)}</span></div>
    <div class="pos-grid">
      <div><small>Entry</small><b>${fmt.price(p.entryPriceUsd)}</b></div><div><small>Now</small><b class="${cls(p.priceChangePct)}">${fmt.price(p.priceUsd)}</b></div>
      <div><small>Market cap</small><b>${fmt.usd(p.mcUsd)}</b></div><div><small>Invested</small><b>${fmt.usd(p.budgetUsd, 2)}</b></div>
      <div><small>If sold now</small><b>${fmt.usd(p.ifSoldUsd, 2)}</b></div><div><small>Stop</small><b class="down">${fmt.price(p.levels.stop)}</b></div>
      <div><small>Target</small><b class="up">${fmt.price(p.levels.target)}</b></div><div><small>Held</small><b>${fmt.age(p.holdSec)}</b></div>
    </div>
    ${m.why ? `<p class="small" style="margin:10px 0 0"><span class="muted">Why:</span> ${esc(m.why)}</p>` : ''}
    <div class="pos-actions"><span class="small b">SELL</span>${[25, 50].map((x) => `<button class="btn sm sell" data-ssell="${x}" data-id="${esc(p.id)}">${x}%</button>`).join('')}<button class="btn sm sell" data-ssell="100" data-id="${esc(p.id)}">SELL 100%</button>
      <span class="tiny muted">Manual override of the strategy's own exits.</span></div></div>`;
}

// ------------------------------------------------------------------ performance
function performance() {
  const P = data.performance, cfg = data.config.setups;
  const rows = Object.values(P.bySetup);
  const pf = (x) => (x.profitFactorInfinite ? '∞' : x.profitFactor != null ? x.profitFactor.toFixed(2) : '—');
  const line = (x, name) => `<tr><td class="b">${name}</td><td class="r num">${x.detected ?? '—'}</td><td class="r num">${x.valid ?? '—'}</td><td class="r num">${x.rejected ?? '—'}</td><td class="r num">${x.entered ?? '—'}</td>
    <td class="r num">${x.trades}</td><td class="r num">${x.winRate != null ? x.winRate + '%' : '—'}</td><td class="r num up">${x.avgWinPct != null ? fmt.pct(x.avgWinPct, 1) : '—'}</td><td class="r num down">${x.avgLossPct != null ? fmt.pct(x.avgLossPct, 1) : '—'}</td>
    <td class="r num">${pf(x)}</td><td class="r num down">${x.maxDrawdownUsd ? fmt.signed(-x.maxDrawdownUsd) : '—'}</td><td class="r num">${x.avgHoldSec != null ? fmt.age(x.avgHoldSec) : '—'}</td>
    <td class="r num">${fmt.usd((x.feesUsd ?? 0) + (x.slippageUsd ?? 0), 2)}</td><td class="r num ${cls(x.netUsd)}">${x.trades ? fmt.signed(x.netUsd) : '—'}</td></tr>`;
  const regimes = rows.flatMap((x) => Object.entries(x.byRegime).map(([k, v]) => [x, k, v]));
  return `${card('Performance by setup', `<div class="scroll-x"><table class="t"><thead><tr><th>Setup</th><th class="r">Detected</th><th class="r">Valid</th><th class="r">Rejected</th><th class="r">Entries</th><th class="r">Completed</th><th class="r">Win rate</th><th class="r">Avg win</th><th class="r">Avg loss</th><th class="r">Profit factor</th><th class="r">Max drawdown</th><th class="r">Avg hold</th><th class="r">Fees + slippage</th><th class="r">Net</th></tr></thead>
      <tbody>${rows.map((x) => line(x, `${esc(x.family)} · ${esc(x.name)}`)).join('')}${line({ ...P.all }, 'All setups')}</tbody></table></div>`, 'Setuh paper results only', { tight: true })}
    <div class="grid g2" style="margin-top:var(--gap)">
      ${card('By market condition', regimes.length ? `<table class="t"><thead><tr><th>Setup</th><th>Market</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Net</th></tr></thead><tbody>${regimes.map(([x, k, v]) => `<tr><td>${esc(x.name)}</td><td>${esc(k)}</td><td class="r num">${v.trades}</td><td class="r num">${v.winRate}%</td><td class="r num ${cls(v.netUsd)}">${fmt.signed(v.netUsd)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Results by market condition appear after the first completed trades.</div>', 'cold / normal / hot', { tight: true })}
      ${card('Completed strategy trades', data.closed.length ? `<div class="scroll-x" style="max-height:420px"><table class="t"><thead><tr><th>Coin</th><th>Setup</th><th class="r">P&L</th><th class="r">Held</th><th>Exit</th></tr></thead><tbody>${data.closed.map((p) => `<tr><td class="b"><a href="#/trade/workstation?mint=${esc(p.mint)}">$${esc(p.symbol || p.mint.slice(0, 6))}</a></td><td class="small">${esc(cfg[p.origin]?.name ?? p.origin)}</td><td class="r num ${cls(p.pnlUsd)}">${fmt.signed(p.pnlUsd)} <span class="tiny">${fmt.pct(p.pnlPct, 1)}</span></td><td class="r num">${fmt.age(p.holdSec)}</td><td class="wrap small">${esc(p.exitReason ?? '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No completed trades yet.</div>', `${data.closed.length} shown`, { tight: true })}
    </div>
    <p class="disclaimer">Paper results on simulated fills with fees, slippage and network costs. Past paper results do not predict future returns.</p>`;
}

// ------------------------------------------------------------------ settings
function settings() {
  const st = data.settings, cfg = data.config.setups;
  const devs = Object.entries(data.config.trackedDevs ?? {});
  const field = (setup, k, v, d) => typeof d === 'boolean'
    ? `<label class="check small"><input type="checkbox" data-cfg="${setup}" data-k="${k}" ${v ? 'checked' : ''}> ${esc(LABELS[k] ?? k)}</label>`
    : `<div class="field"><label title="default ${d}">${esc(LABELS[k] ?? k)}</label><input class="input mono" data-cfg="${setup}" data-k="${k}" type="number" step="any" min="0" value="${v}"></div>`;
  return `${card('Strategy engine', `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));align-items:end">
      <label class="check"><input type="checkbox" data-g="enabled" ${st.enabled ? 'checked' : ''}> Paper-enter valid signals</label>
      <div class="field"><label>Daily budget ($)</label><input class="input mono" data-g="dailyUsd" type="number" min="1" value="${st.dailyUsd}"></div>
      <div class="field"><label>Per trade ($)</label><input class="input mono" data-g="perTradeUsd" type="number" min="1" value="${st.perTradeUsd}"></div>
      <div class="field"><label>Max open positions</label><input class="input mono" data-g="maxOpen" type="number" min="0" value="${st.maxOpen}"></div>
      <div class="field"><label>Max open per setup</label><input class="input mono" data-g="maxOpenPerSetup" type="number" min="0" value="${st.maxOpenPerSetup}"></div>
      <button class="btn primary" data-saveg>Save engine settings</button></div>
      <p class="tiny muted" style="margin-bottom:0">Separate from the automatic paper trader's daily budget. Resets at midnight (same time zone as the automatic system). Changes are saved in the database and logged in the audit log.</p>`)}
    <div class="grid g2" style="margin-top:var(--gap)">
      ${Object.entries(cfg).map(([id, c]) => card(`${esc(c.family)} · ${esc(c.name)}`, `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${Object.entries(c.values).map(([k, v]) => field(id, k, v, c.defaults[k])).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary sm" data-savecfg="${id}">Save ${esc(c.name)}</button><button class="btn sm" data-resetcfg="${id}">Reset to defaults</button></div>`)).join('')}
    </div>
    <div style="margin-top:var(--gap)">${card('Tracked developer wallets (Final Stretch C)', `
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input mono" id="devw" placeholder="Developer wallet address" style="flex:2 1 300px"><input class="input" id="devl" placeholder="Label (optional)" style="flex:1 1 140px">
        <select class="input" id="devm" style="width:130px"><option value="follow">Follow</option><option value="block">Block</option></select><button class="btn primary" data-adddev>Add</button></div>
      ${devs.length ? `<table class="t" style="margin-top:10px"><tbody>${devs.map(([w, d]) => `<tr><td><code>${esc(w)}</code></td><td>${esc(d.label)}</td><td><span class="tag ${d.mode === 'follow' ? 'up' : 'down'}">${d.mode.toUpperCase()}</span></td><td class="r"><button class="btn sm" data-rmdev="${esc(w)}">Remove</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="small muted">No wallets added. Setup C also uses the bot\'s own history: devs whose earlier coins graduated, with no rugs seen.</p>'}`)}</div>`;
}

// ------------------------------------------------------------------ events
function wire() {
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok, 'good'); data = await api('/api/strategy'); render(); } catch (err) { toast(err.message, 'bad'); } };
    const tg = t.closest('[data-toggle]');
    if (tg) { const id = tg.dataset.toggle; const on = !data.config.setups[id].values.enabled; return run(() => api('/api/strategy/config', { setup: id, values: { enabled: on } }), `${data.config.setups[id].name} ${on ? 'enabled' : 'disabled'}`); }
    const ss = t.closest('[data-ssell]');
    if (ss) {
      const pct = Number(ss.dataset.ssell);
      if (pct >= 100 && !confirm('Sell 100% of this strategy position now (manual override)?')) return;
      ss.disabled = true;
      return run(() => api('/api/strategy/sell', { id: ss.dataset.id, pct, requestId: uid() }), `Sold ${pct}%`);
    }
    if (t.closest('[data-saveg]')) {
      const v = {}; for (const el of $$('[data-g]', root)) v[el.dataset.g] = el.type === 'checkbox' ? el.checked : Number(el.value);
      document.activeElement?.blur();
      return run(() => api('/api/strategy/config', { values: v }), 'Engine settings saved');
    }
    const sc = t.closest('[data-savecfg]');
    if (sc) {
      const id = sc.dataset.savecfg, v = {};
      for (const el of $$(`[data-cfg="${id}"]`, root)) v[el.dataset.k] = el.type === 'checkbox' ? el.checked : Number(el.value);
      document.activeElement?.blur();
      return run(() => api('/api/strategy/config', { setup: id, values: v }), 'Saved — only this setup changed');
    }
    const rc = t.closest('[data-resetcfg]');
    if (rc && confirm('Reset this setup to its default rules?')) return run(() => api('/api/strategy/reset', { setup: rc.dataset.resetcfg }), 'Defaults restored');
    if (t.closest('[data-adddev]')) {
      const wallet = $('#devw', root).value.trim(), label = $('#devl', root).value.trim(), mode = $('#devm', root).value;
      document.activeElement?.blur();
      return run(() => api('/api/strategy/devs', { wallet, label, mode }), 'Developer wallet saved');
    }
    const rm = t.closest('[data-rmdev]');
    if (rm) return run(() => api('/api/strategy/devs', { wallet: rm.dataset.rmdev, mode: 'remove' }), 'Removed');
  });
}
