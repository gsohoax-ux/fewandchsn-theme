// Section 3: Coin Check & Paper Trade — research one coin, watch its live chart, manage simulated positions.
// Simulation only: no wallet, no real orders.
import { $, $$, esc, fmt, api, poller, card, cls, toast, uid, spark } from './core.js';
import { CandleChart } from './chart.js';

export const SUBS = [['workstation', 'Workstation'], ['history', 'Trade history']];
const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const GROUPS = [
  ['Ownership concentration', ['Holders', 'Wallet links', 'Launch']],
  ['Mint / freeze authority', ['Authorities']],
  ['Liquidity', ['Liquidity']],
  ['Honeypot & taxes', ['Honeypot & tax']],
];
const LV = { ok: 'lv-ok', warn: 'lv-warn', bad: 'lv-bad', info: 'lv-info', unknown: 'lv-unknown' };
const worst = (cs) => cs.some((c) => c.level === 'bad') ? 'bad' : cs.some((c) => c.level === 'warn') ? 'warn' : cs.some((c) => c.level === 'unknown') ? 'unknown' : 'ok';

let root, sub = 'workstation';
const S = { mint: null, check: null, checking: false, checkErr: '', chart: null, chartErr: '', chartAt: 0, tf: '5m', mode: 'price', manual: null, histBook: 'manual', strat: null, editing: new Set(), lastPx: new Map() };
let chart = null;

const manualPoll = poller(async () => { S.manual = await api('/api/manual'); renderPositions(); renderTotals(); if (sub === 'history') renderHistory(); syncLevels(); }, 2000);
const chartPoll = poller(async () => { await loadChart(); }, 5000);

export function mount(el) {
  root = el;
  root.innerHTML = `
    <div id="ws">
      <div class="notice info small" style="margin-bottom:var(--gap)"><b>Simulation only.</b> No real money, no wallet connection; nothing is bought or sold. Positions are tracked against live prices with realistic fees and slippage.</div>
      <div class="card" style="margin-bottom:var(--gap)"><div class="body" style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="input mono" id="tq" placeholder="Token address, or a pump.fun / DexScreener / Padre / Axiom / GMGN link" spellcheck="false" autocomplete="off" style="flex:1 1 320px;height:38px">
        <button class="btn primary" id="tgo" style="height:38px">Run coin check</button></div></div>
      <div id="tcoin" hidden>
        <div class="grid g-trade">
          <div class="grid" style="align-content:start">
            <div class="card" id="chartcard">
              <div class="chart-head" id="chead"></div>
              <div class="chart-tools"><div class="seg" id="tfseg">${TFS.map((t) => `<button data-tf="${t}">${t}</button>`).join('')}</div>
                <div class="seg" id="modeseg"><button data-mode="price">Price</button><button data-mode="mc">Market cap</button></div>
                <span class="small muted" id="cflow" style="margin-left:auto"></span></div>
              <div class="chart-wrap" id="cwrap"><div class="chart-msg" id="cmsg">Loading chart…</div></div>
              <div class="chart-foot"><span id="csrc"></span><span id="cfresh"></span></div>
            </div>
            <div id="safety"></div>
          </div>
          <div class="grid" style="align-content:start">
            ${card('New paper position', ticket(), '<span class="tag info">SIMULATED</span>', { id: 'ticket' })}
            <div id="pretrade"></div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:var(--gap)" id="poscard"><header><h2>Open paper positions</h2><div class="meta" id="posmeta"></div></header>
        <div class="kpis" id="ptotals" style="padding:12px 14px 0;margin:0"></div><div id="positions"></div></div>
    </div>
    <div id="hist" hidden></div>`;
  wire();
}

export function show(s, params = {}) {
  sub = SUBS.some(([k]) => k === s) ? s : 'workstation';
  $('#ws', root).hidden = sub !== 'workstation';
  $('#hist', root).hidden = sub !== 'history';
  manualPoll.start();
  if (params.mint && params.mint !== S.mint) openMint(params.mint);
  else if (S.mint && sub === 'workstation') chartPoll.start();
  if (sub === 'history') renderHistory();
  if (sub !== 'workstation') chartPoll.stop();
}
export function hide() { manualPoll.stop(); chartPoll.stop(); }

/** Load a coin (address or link) into the workstation and run the full check. */
export async function openMint(q) {
  q = String(q ?? '').trim();
  if (!q) return;
  $('#tq', root).value = q;
  S.check = null; S.checkErr = ''; S.checking = true; S.chart = null; S.chartErr = '';
  $('#tcoin', root).hidden = false;
  renderSafety(); renderPretrade();
  $('#chead', root).innerHTML = '<span class="muted">Finding the coin…</span>';
  try {
    const { mint } = await api(`/api/resolve?q=${encodeURIComponent(q)}`);
    S.mint = mint;
    history.replaceState(null, '', `#/trade/workstation?mint=${mint}`);
  } catch (e) { S.checking = false; S.checkErr = e.message; renderSafety(); $('#chead', root).innerHTML = `<span class="down">${esc(e.message)}</span>`; return; }
  chartPoll.stop(); chartPoll.start();
  try { S.check = await api(`/api/check?mint=${S.mint}`); }
  catch (e) { S.checkErr = e.message; }
  S.checking = false;
  renderSafety(); renderPretrade(); renderHead();
}

// ------------------------------------------------------------------ chart
async function loadChart() {
  if (!S.mint || sub !== 'workstation') return;
  const mint = S.mint, tf = S.tf;
  // refresh cadence follows the timeframe (the server caches provider data too)
  const every = TF_SEC[tf] <= 60 ? 5000 : TF_SEC[tf] <= 900 ? 10_000 : 30_000;
  if (S.chart && S.chart.mint === mint && S.chart.tf === tf && Date.now() - S.chartAt < every - 500) return;
  try {
    const d = await api(`/api/candles?mint=${mint}&tf=${tf}`);
    if (mint !== S.mint || tf !== S.tf) return;
    S.chart = d; S.chartErr = ''; S.chartAt = Date.now();
  } catch (e) { S.chartErr = e.message; }
  drawChart(); renderHead(); renderPretrade();
}

function drawChart() {
  const d = S.chart;
  if (!chart) chart = new CandleChart($('#cwrap', root));
  const msg = $('#cmsg', root);
  const supply = d?.market?.mcUsd && d?.market?.priceUsd ? d.market.mcUsd / d.market.priceUsd : 1e9;
  if (d?.candles?.length) {
    chart.setData(d.candles, { scale: S.mode === 'mc' ? supply : 1, tfSec: TF_SEC[S.tf] });
    msg.hidden = true;
  } else {
    chart.setData([]);
    msg.hidden = false;
    msg.textContent = S.chartErr ? `Chart unavailable: ${S.chartErr}` : d ? d.note : 'Loading chart…';
  }
  syncLevels();
  $('#csrc', root).textContent = d ? `${d.note}${d.source === 'live' ? '' : ''}` : '';
  const fresh = $('#cfresh', root);
  if (d) {
    const lastCandle = d.stats?.lastCandleAgoSec;
    fresh.innerHTML = `${d.market?.stale ? `<span class="warn">STALE: ${esc(d.market.source)}</span> · ` : d.stale ? `<span class="warn">STALE: no new candle for ${fmt.age(lastCandle)}</span> · ` : ''}${d.market?.lastTradeAgoSec != null ? `last trade ${fmt.age(d.market.lastTradeAgoSec)} ago · ` : ''}updated ${new Date(S.chartAt).toLocaleTimeString()}`;
  }
  for (const b of $$('#tfseg button', root)) b.classList.toggle('on', b.dataset.tf === S.tf);
  for (const b of $$('#modeseg button', root)) b.classList.toggle('on', b.dataset.mode === S.mode);
}

function syncLevels() {
  if (!chart || !S.mint) return;
  const levels = [];
  for (const p of S.manual?.open ?? []) {
    if (p.mint !== S.mint) continue;
    levels.push({ price: p.entryPriceUsd, label: `Entry ${p.symbol ? '$' + p.symbol : ''}`, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() });
    if (p.levels.stop) levels.push({ price: p.levels.stop, label: 'Stop-loss', color: '#ef5a5a' });
    if (p.levels.target) levels.push({ price: p.levels.target, label: 'Take-profit', color: '#26c281' });
    if (p.levels.trail) levels.push({ price: p.levels.trail, label: 'Trailing stop', color: '#e2b340' });
  }
  chart.setLevels(levels);
}

function renderHead() {
  const d = S.chart, c = S.check, m = d?.market;
  const sym = c?.symbol || S.manual?.open.find((p) => p.mint === S.mint)?.symbol || '';
  const name = c?.name || '';
  const chg = d?.stats?.changePct;
  const flow = m?.flow ? `5m: ${m.flow.m5.buys} buys / ${m.flow.m5.sells} sells · 1h: ${m.flow.h1.buys} / ${m.flow.h1.sells}`
    : m?.txns?.m5 ? `5m: ${m.txns.m5.buys} buys / ${m.txns.m5.sells} sells${m.txns.h1 ? ` · 1h: ${m.txns.h1.buys} / ${m.txns.h1.sells}` : ''}` : 'Buy/sell counts unavailable';
  $('#cflow', root).textContent = flow;
  const ratio = m?.mcUsd && m?.liqUsd != null ? (m.liqUsd / m.mcUsd) * 100 : null;
  $('#chead', root).innerHTML = `
    <div><div class="tk">${sym ? '$' + esc(sym) : 'Token'} <span class="muted" style="font-weight:500;font-size:13px">${esc(name)}</span> ${c ? `<span class="verdict ${c.verdict}" style="height:22px;font-size:11px;vertical-align:middle">${c.verdict}</span>` : S.checking ? '<span class="tag">CHECKING…</span>' : ''}</div>
      <code class="faint">${esc(S.mint ?? '')}</code> <button class="btn sm ghost" data-copy="${esc(S.mint ?? '')}">Copy</button></div>
    <div><div class="px">${fmt.price(m?.priceUsd)}</div><span class="small ${cls(chg)}">${chg != null ? `${fmt.pct(chg)} over this view` : ''}</span></div>
    <div class="stat"><small>Market cap</small><b>${fmt.usd(m?.mcUsd)}</b></div>
    <div class="stat"><small>Liquidity</small><b>${fmt.usd(m?.liqUsd)}</b> ${ratio != null ? `<span class="tiny ${ratio < (m.onCurve ? 2 : 5) ? 'down' : 'muted'}">${ratio.toFixed(1)}% of MC</span>` : ''}</div>
    <div class="stat"><small>High / low (view)</small><b>${d?.stats ? `${fmt.price(d.stats.high)} / ${fmt.price(d.stats.low)}` : '—'}</b></div>
    <div class="stat"><small>Volume (view)</small><b>${fmt.usd(d?.stats?.volumeUsd)}</b></div>
    ${m?.changePct ? `<div class="stat"><small>5m / 1h / 24h</small><b><span class="${cls(m.changePct.m5)}">${fmt.pct(m.changePct.m5, 1)}</span> <span class="${cls(m.changePct.h1)}">${fmt.pct(m.changePct.h1, 1)}</span> <span class="${cls(m.changePct.h24)}">${fmt.pct(m.changePct.h24, 1)}</span></b></div>` : ''}
    ${m?.progress != null ? `<div class="stat"><small>Bonding curve</small><b>${m.progress.toFixed(0)}%</b></div>` : ''}`;
}

// ------------------------------------------------------------------ safety
function renderSafety() {
  const el = $('#safety', root);
  if (S.checking) { el.innerHTML = card('Coin safety analysis', '<div class="muted">Reading the launch block, tracing wallet funding, checking holders, authorities, liquidity and RugCheck… (10–30 s)</div>'); return; }
  if (S.checkErr) { el.innerHTML = card('Coin safety analysis', `<div class="notice bad">${esc(S.checkErr)}</div>`); return; }
  const r = S.check;
  if (!r) { el.innerHTML = ''; return; }
  const used = new Set(GROUPS.flatMap(([, g]) => g));
  const box = ([title, groups]) => {
    const cs = r.checks.filter((c) => groups.includes(c.group));
    const w = cs.length ? worst(cs) : 'unknown';
    return `<div class="box ${w}"><h4><span>${title}</span><span class="tag ${w === 'bad' ? 'down' : w === 'warn' ? 'warn' : w === 'ok' ? 'up' : ''}">${w === 'bad' ? 'RED FLAG' : w === 'warn' ? 'WARNING' : w === 'ok' ? 'OK' : 'NOT CHECKED'}</span></h4>
      <ul class="checks">${cs.length ? cs.map((c) => `<li class="${LV[c.level] ?? 'lv-info'}">${esc(c.text)}</li>`).join('') : '<li class="lv-unknown">Could not check</li>'}</ul></div>`;
  };
  const rest = r.checks.filter((c) => !used.has(c.group));
  const restGroups = [...new Set(rest.map((c) => c.group))];
  el.innerHTML = card('Coin safety analysis', `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><span class="verdict ${r.verdict}">${r.verdict}</span>
      <span><b>Safety ${r.score}/100</b> · <span class="down">${r.bad} red flag${r.bad === 1 ? '' : 's'}</span> · <span class="warn">${r.warn} warning${r.warn === 1 ? '' : 's'}</span>${r.unknown ? ` · <span class="muted">${r.unknown} not checked</span>` : ''}</span>
      ${r.live ? `<span class="small muted">Bot's live read: score ${r.live.score} · momentum ${r.live.momentum} · narrative ${r.live.narrative} · ${esc(r.live.confidence)} confidence${r.live.runner ? ' · runner signs' : ''}</span>` : ''}</div>
    <div class="notice warn" style="margin-bottom:12px"><b>Not a guarantee of safety.</b> These checks lower risk but can't rule out a rug pull: developers and large holders can still sell, and some risks only show on-chain when they happen.${r.verdict === 'UNVERIFIED' ? ' <b>UNVERIFIED:</b> key on-chain checks could not run, so this coin is not confirmed safe.' : ''}</div>
    <div class="kf">${GROUPS.map(box).join('')}</div>
    <details style="margin-top:12px"><summary>All other checks (${rest.length}) — developer, socials, market, RugCheck second opinion</summary>
      ${restGroups.map((g) => `<div class="tiny muted" style="text-transform:uppercase;letter-spacing:.6px;margin:12px 0 4px">${esc(g)}${g === 'RugCheck' ? ' · independent second opinion' : ''}</div><ul class="checks">${rest.filter((c) => c.group === g).map((c) => `<li class="${LV[c.level] ?? 'lv-info'}">${esc(c.text)}</li>`).join('')}</ul>`).join('')}
      ${r.creator ? `<p class="tiny muted">Creator wallet: <code>${esc(r.creator)}</code></p>` : ''}
      ${r.notes?.length ? `<div class="tiny muted" style="text-transform:uppercase;letter-spacing:.6px;margin:12px 0 4px">Couldn't check</div><ul class="checks">${r.notes.map((n) => `<li class="lv-unknown">${esc(n)}</li>`).join('')}</ul>` : ''}
    </details>
    <div class="links" style="margin-top:12px">${r.links?.padre ? `<a target="_blank" rel="noopener" href="${esc(r.links.padre)}">Padre</a>` : ''}<a target="_blank" rel="noopener" href="${esc(r.links?.pump)}">pump.fun</a><a target="_blank" rel="noopener" href="${esc(r.links?.dexscreener)}">DexScreener</a><a target="_blank" rel="noopener" href="${esc(r.links?.solscan)}">Solscan</a><a target="_blank" rel="noopener" href="${esc(r.links?.rugcheck)}">RugCheck</a></div>
    <p class="tiny faint" style="margin-bottom:0">Checked in ${(r.tookMs / 1000).toFixed(1)} s. Holder concentration excludes the bonding curve and pools.</p>`, `${new Date(r.at).toLocaleTimeString()}`);
}

// ------------------------------------------------------------------ order ticket
function ticket() {
  return `<div class="field"><label>Paper budget</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="presets">${[10, 30, 50, 100, 250].map((b) => `<button class="btn sm ${b === 50 ? 'primary' : ''}" data-b="${b}">$${b}</button>`).join('')}</div>
      <div style="position:relative;margin-top:6px"><span style="position:absolute;left:10px;top:7px" class="muted">$</span><input class="input mono" id="budget" type="number" min="1" max="1000000" step="1" value="50" inputmode="decimal" style="padding-left:22px"></div></div>
    <div class="field" style="margin-top:12px"><label>Stop-loss</label>
      <div style="display:flex;gap:6px"><select class="input" id="slmode" style="width:136px;flex:none"><option value="pct">% below</option><option value="price">at price</option><option value="off">Off</option></select>
      <input class="input mono" id="slval" type="number" step="any" min="0" value="20"></div><span class="tiny muted" id="slhint"></span></div>
    <div class="field" style="margin-top:10px"><label>Take-profit</label>
      <div style="display:flex;gap:6px"><select class="input" id="tpmode" style="width:136px;flex:none"><option value="pct">% above</option><option value="price">at price</option><option value="off">Off</option></select>
      <input class="input mono" id="tpval" type="number" step="any" min="0" value="50"></div>
      <div style="display:flex;gap:6px;align-items:center" class="small muted">Sell <input class="input mono" id="tpsell" type="number" min="1" max="100" value="100" style="width:70px;height:26px">% of the position at the target</div>
      <span class="tiny muted" id="tphint"></span></div>
    <div class="field" style="margin-top:10px"><label>Trailing stop</label>
      <div style="display:flex;gap:6px"><select class="input" id="trmode" style="width:136px;flex:none"><option value="off">Off</option><option value="pct">% below high</option></select>
      <input class="input mono" id="trval" type="number" step="any" min="0" value="25" disabled></div><span class="tiny muted">Follows the price up, never moves down.</span></div>
    <button class="btn buy" id="openbtn" style="width:100%;height:40px;margin-top:14px" disabled>Start paper position</button>
    <p class="tiny faint" style="margin:8px 0 0">Entry uses the live price minus trading fees (~2.25%), network fee, sandwich-bot losses and slippage for your size. Exits run on the server, even with the app closed.</p>`;
}

function riskFromTicket() {
  const v = (id) => $(id, root).value.trim();
  const risk = {};
  const sl = v('#slmode'), tp = v('#tpmode'), tr = v('#trmode');
  if (sl === 'pct' && v('#slval')) risk.stopPct = Number(v('#slval'));
  if (sl === 'price' && v('#slval')) risk.stopPrice = Number(v('#slval'));
  if (tp === 'pct' && v('#tpval')) risk.tpPct = Number(v('#tpval'));
  if (tp === 'price' && v('#tpval')) risk.tpPrice = Number(v('#tpval'));
  if (tp !== 'off') risk.tpSellPct = Number(v('#tpsell') || 100);
  if (tr === 'pct' && v('#trval')) risk.trailPct = Number(v('#trval'));
  return risk;
}

function renderPretrade() {
  const el = $('#pretrade', root);
  const r = S.check, b = Number($('#budget', root)?.value) || 0;
  const btn = $('#openbtn', root);
  const px = S.chart?.market?.priceUsd;
  // expected $ at stop / target (approximate: includes ~4.5% round-trip fees, excludes slippage)
  const risk = riskFromTicket();
  const stopPx = risk.stopPrice ?? (risk.stopPct != null && px ? px * (1 - risk.stopPct / 100) : null);
  const tpPx = risk.tpPrice ?? (risk.tpPct != null && px ? px * (1 + risk.tpPct / 100) : null);
  const at = (p) => (px && p ? b * (p / px) * 0.955 - b : null);
  $('#slhint', root).innerHTML = stopPx ? `Stop at ${fmt.price(stopPx)} → expected loss ≈ <span class="down">${fmt.signed(at(stopPx))}</span> (more if the price gaps through)` : risk.stopPct == null && risk.stopPrice == null ? '<span class="warn">No stop-loss: the position can lose 100%.</span>' : '';
  $('#tphint', root).innerHTML = tpPx ? `Target ${fmt.price(tpPx)} → expected profit ≈ <span class="up">${fmt.signed(at(tpPx) * ((risk.tpSellPct ?? 100) / 100))}</span> on the part sold. A target is a plan, not a likely outcome.` : '';
  if (!r) { el.innerHTML = ''; btn.disabled = true; btn.textContent = S.checking ? 'Waiting for the safety check…' : 'Run a coin check first'; return; }
  const L = r.liquidity, lines = [];
  const lv = (k) => worst(r.checks.filter((c) => c.group === k));
  if (L) {
    const thin = L.ratioPct != null && L.ratioPct < (L.onCurve ? 2 : 5);
    lines.push([thin ? 'bad' : L.level === 'warn' ? 'warn' : 'ok', `${thin ? '<b>HIGH RISK:</b> ' : ''}${L.onCurve ? 'Curve holds' : 'Pool liquidity'} ${fmt.usd(L.realLiqUsd)}${L.ratioPct != null ? ` = ${L.ratioPct.toFixed(1)}% of market cap${thin ? ' (thin liquidity)' : ''}` : ''}.`]);
    if (L.depthUsd > 0 && b > 0) {
      const avg = (b / L.depthUsd) * 100, move = ((1 + b / L.depthUsd) ** 2 - 1) * 100;
      lines.push([avg > 15 ? 'bad' : avg > 5 ? 'warn' : 'ok', `Slippage: a ${fmt.usd(b)} buy pays ~${avg.toFixed(1)}% and moves the price ~${move.toFixed(1)}% (your size vs pool depth ${fmt.usd(L.depthUsd)}).`]);
      const v = b * 5, got = (v * L.depthUsd) / (L.depthUsd + v);
      lines.push(['warn', `Paper gains can't be cashed out in a thin pool: if this position were worth ${fmt.usd(v)} on paper, selling it into today's pool would bring ~${fmt.usd(got)} (−${((1 - got / v) * 100).toFixed(0)}%). This tests the exit; it is not a forecast.`]);
    } else if (L.depthUsd === 0) lines.push(['bad', '<b>No liquidity pool found:</b> a real buy or sale would not fill.']);
  } else lines.push(['unknown', "Liquidity and slippage couldn't be measured, so the simulation can't price your exit accurately."]);
  const hp = lv('Honeypot & tax');
  lines.push([hp, hp === 'bad' ? '<b>Honeypot / tax red flag:</b> you may not be able to sell, or a tax takes part of every trade.' : hp === 'warn' ? 'Possible honeypot or tax issue — see Honeypot & taxes.' : hp === 'unknown' ? 'Honeypot and buy/sell tax signs could not be fully checked.' : 'No honeypot or buy/sell tax signs found.']);
  const hold = worst(r.checks.filter((c) => ['Holders', 'Wallet links', 'Launch'].includes(c.group)));
  lines.push([hold, hold === 'bad' ? '<b>Concentrated holdings:</b> a few wallets (or linked wallets) could dump on you.' : hold === 'warn' ? 'Holdings are somewhat concentrated.' : hold === 'unknown' ? 'Holder concentration could not be fully checked.' : 'Holdings look spread out (bonding curve and pools excluded).']);
  const auth = lv('Authorities');
  if (auth === 'bad') lines.push(['bad', '<b>Mint or freeze authority is active:</b> more tokens can be created or your tokens frozen.']);
  el.innerHTML = card('Before you start', `<ul class="checks">${lines.map(([l, t]) => `<li class="${LV[l]}">${t}</li>`).join('')}</ul>
    ${r.verdict === 'AVOID' ? '<div class="notice bad small" style="margin-top:10px">This coin was rated <b>AVOID</b>. You can still paper-trade it to watch what happens.</div>' : ''}`, `${r.verdict}`);
  btn.disabled = !(b >= 1) || (L && L.depthUsd === 0) || !px;
  btn.textContent = !px ? 'Waiting for a live price…' : `Start paper position · ${fmt.usd(b, 2)}`;
}

// ------------------------------------------------------------------ positions
function renderTotals() {
  const t = S.manual?.totals;
  if (!t) return;
  const pf = t.profitFactorInfinite ? '∞' : t.profitFactor != null ? t.profitFactor.toFixed(2) : '—';
  $('#ptotals', root).innerHTML = `
    <div class="kpi"><small>Open positions</small><b>${S.manual.open.length}</b></div>
    <div class="kpi"><small>Paper money in (open)</small><b>${fmt.usd(t.invested, 2)}</b></div>
    <div class="kpi"><small>Value if sold now</small><b>${fmt.usd(t.value, 2)}</b></div>
    <div class="kpi"><small>Unrealized P&L</small><b class="${cls(t.unrealizedUsd)}">${S.manual.open.length ? fmt.signed(t.unrealizedUsd) : '—'}</b><span>${S.manual.open.length ? fmt.pct(t.pnlPct, 1) : ''}</span></div>
    <div class="kpi"><small>Realized P&L</small><b class="${cls(t.realizedUsd)}">${fmt.signed(t.realizedUsd)}</b><span>${t.closedCount} closed · win ${t.winRate != null ? t.winRate + '%' : '—'} · PF ${pf}</span></div>`;
  $('#posmeta', root).innerHTML = `<span class="dot ok"></span> live · ${new Date().toLocaleTimeString()}`;
}

function posHtml(p) {
  const prev = S.lastPx.get(p.id); S.lastPx.set(p.id, p.priceUsd);
  const flash = prev == null || prev === p.priceUsd ? '' : p.priceUsd > prev ? 'flash-up' : 'flash-down';
  const r = p.risk ?? {};
  const editing = S.editing.has(p.id);
  return `<div class="pos ${flash}" data-pos="${esc(p.id)}">
    <div class="pos-top"><span class="tk" data-load="${esc(p.mint)}">${p.symbol ? '$' + esc(p.symbol) : esc(p.mint.slice(0, 6)) + '…'}</span><span class="tag">MANUAL</span>
      <span class="small muted">${esc(p.name ?? '')} · opened ${fmt.ago(p.openedAt)} · ${p.onCurve ? 'bonding curve' : 'DEX pool'} · ${esc(p.source)}</span>
      ${p.staleSec > 60 ? `<span class="tag warn">PRICE ${fmt.age(p.staleSec)} OLD</span>` : ''}
      <span style="margin-left:auto" class="num ${cls(p.pnlUsd)}"><b style="font-size:16px">${fmt.signed(p.pnlUsd)}</b> ${fmt.pct(p.pnlPct, 1)}</span></div>
    <div class="pos-grid">
      <div><small>Entry price</small><b>${fmt.price(p.entryPriceUsd)}</b></div>
      <div><small>Current price</small><b class="${cls(p.priceChangePct)}">${fmt.price(p.priceUsd)}</b></div>
      <div><small>Market cap</small><b>${fmt.usd(p.mcUsd)}</b><small class="faint" style="text-transform:none">entry ${fmt.usd(p.entryMcUsd)}</small></div>
      <div><small>Initial investment</small><b>${fmt.usd(p.budgetUsd, 2)}</b></div>
      <div><small>Value if sold now</small><b>${fmt.usd(p.ifSoldUsd, 2)}</b><small class="faint" style="text-transform:none">market ${fmt.usd(p.marketUsd, 2)}${p.exitSlipPct > 0.05 ? ` · −${p.exitSlipPct.toFixed(1)}% slippage` : ''}</small></div>
      <div><small>Tokens left</small><b>${fmt.tokens(p.tokens)}</b><small class="faint" style="text-transform:none">${p.soldPct > 0.1 ? `${p.soldPct.toFixed(0)}% sold` : 'none sold'}</small></div>
      <div><small>Unrealized P&L</small><b class="${cls(p.unrealizedUsd)}">${fmt.signed(p.unrealizedUsd)}</b></div>
      <div><small>Realized P&L</small><b class="${cls(p.realizedPnlUsd)}">${fmt.signed(p.realizedPnlUsd)}</b></div>
      <div><small>Held</small><b>${fmt.age(p.holdSec)}</b></div>
      <div><small>Fees + slippage</small><b>${fmt.usd(p.feesUsd + p.slippageUsd, 2)}</b></div>
      <div style="grid-column:span 2;min-width:0">${spark(p.history, 220, 30)}</div>
    </div>
    <div class="pos-risk">
      <div class="small"><span class="muted">Stop-loss:</span> ${p.levels.stop ? `${fmt.price(p.levels.stop)} <span class="faint">(${r.stopPct != null ? '−' + r.stopPct + '%' : 'price'})</span>` : '<span class="warn">off</span>'}${p.expectedAtStopUsd != null && (p.levels.stop || p.levels.trail) ? ` · if hit ≈ <span class="${cls(p.expectedAtStopUsd)}">${fmt.signed(p.expectedAtStopUsd)}</span>` : ''}</div>
      <div class="small"><span class="muted">Take-profit:</span> ${p.levels.target ? `${fmt.price(p.levels.target)} <span class="faint">(sell ${r.tpSellPct ?? 100}%)</span>${p.expectedAtTargetUsd != null ? ` · if hit ≈ <span class="${cls(p.expectedAtTargetUsd)}">${fmt.signed(p.expectedAtTargetUsd)}</span>` : ''}` : '<span class="faint">off</span>'}</div>
      <div class="small"><span class="muted">Trailing:</span> ${p.levels.trail ? `${fmt.price(p.levels.trail)} <span class="faint">(${r.trailPct}% below high ${fmt.price(p.trailHighUsd)})</span>` : '<span class="faint">off</span>'}</div>
    </div>
    ${editing ? riskForm(p) : ''}
    <div class="pos-actions">
      <span class="small b" style="margin-right:2px">SELL</span>
      ${[25, 50, 75].map((x) => `<button class="btn sm sell" data-sell="${x}" data-id="${esc(p.id)}">${x}%</button>`).join('')}
      <button class="btn sm sell" data-sell="100" data-id="${esc(p.id)}" style="font-weight:750">SELL 100%</button>
      <input class="input mono" data-custom="${esc(p.id)}" type="number" min="1" max="100" placeholder="%" style="width:64px;height:26px">
      <button class="btn sm sell" data-sellcustom="${esc(p.id)}">Sell %</button>
      <button class="btn sm" data-edit="${esc(p.id)}" style="margin-left:auto">${editing ? 'Cancel' : 'Edit stop / target / trail'}</button>
      <button class="btn sm ghost" data-load="${esc(p.mint)}">Chart</button>
    </div>
  </div>`;
}

function riskForm(p) {
  const r = p.risk ?? {};
  const mode = (pct, price) => (pct != null ? 'pct' : price != null ? 'price' : 'off');
  const sel = (name, m, opts) => `<select class="input" data-rf="${name}" style="width:136px;flex:none">${opts.map(([v, l]) => `<option value="${v}" ${m === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<div class="pos-risk" data-riskform="${esc(p.id)}" style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)">
    <div class="field"><label>Stop-loss</label><div style="display:flex;gap:6px">${sel('slmode', mode(r.stopPct, r.stopPrice), [['pct', '% below entry'], ['price', 'at price'], ['off', 'Off']])}<input class="input mono" data-rf="slval" type="number" step="any" value="${r.stopPct ?? r.stopPrice ?? ''}"></div></div>
    <div class="field"><label>Take-profit</label><div style="display:flex;gap:6px">${sel('tpmode', mode(r.tpPct, r.tpPrice), [['pct', '% above entry'], ['price', 'at price'], ['off', 'Off']])}<input class="input mono" data-rf="tpval" type="number" step="any" value="${r.tpPct ?? r.tpPrice ?? ''}"></div>
      <div class="tiny muted" style="display:flex;gap:6px;align-items:center">sell <input class="input mono" data-rf="tpsell" type="number" min="1" max="100" value="${r.tpSellPct ?? 100}" style="width:64px;height:24px">% at target</div></div>
    <div class="field"><label>Trailing stop</label><div style="display:flex;gap:6px">${sel('trmode', r.trailPct != null ? 'pct' : 'off', [['pct', '% below high'], ['off', 'Off']])}<input class="input mono" data-rf="trval" type="number" step="any" value="${r.trailPct ?? ''}"></div></div>
    <div style="display:flex;align-items:flex-end"><button class="btn sm primary" data-saverisk="${esc(p.id)}">Save rules</button></div>
  </div>`;
}

function renderPositions() {
  const box = $('#positions', root);
  if (!box || !S.manual) return;
  const open = S.manual.open;
  if (!open.length) { box.innerHTML = '<div class="empty">No open paper positions. Check a coin above, choose a budget and start one.</div>'; return; }
  const ids = new Set(open.map((p) => p.id));
  for (const el of $$('[data-pos]', box)) if (!ids.has(el.dataset.pos)) el.remove();
  box.querySelector('.empty')?.remove();
  open.forEach((p, i) => {
    let el = box.querySelector(`[data-pos="${CSS.escape(p.id)}"]`);
    // don't redraw a position while you're typing in it
    if (el && (el.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON')) return;
    const tmp = document.createElement('div'); tmp.innerHTML = posHtml(p);
    const fresh = tmp.firstElementChild;
    if (el) el.replaceWith(fresh); else box.insertBefore(fresh, box.children[i] ?? null);
  });
}

// ------------------------------------------------------------------ history
async function renderHistory() {
  const el = $('#hist', root);
  if (S.histBook === 'strategy' && (!S.strat || Date.now() - S.strat.at > 10_000)) {
    try { const v = await api('/api/strategy'); S.strat = { at: Date.now(), closed: v.closed }; } catch { S.strat = { at: Date.now(), closed: [] }; }
  }
  const rows = S.histBook === 'manual' ? (S.manual?.closed ?? []) : S.histBook === 'strategy' ? (S.strat?.closed ?? []) : [];
  const t = S.manual?.totals;
  el.innerHTML = `<div class="section-title"><h2>Trade history</h2><p>Completed simulated positions. Manual and Strategy are tracked separately.</p></div>
    <div class="seg" id="histseg" style="margin-bottom:12px"><button data-hb="manual" class="${S.histBook === 'manual' ? 'on' : ''}">Manual</button><button data-hb="strategy" class="${S.histBook === 'strategy' ? 'on' : ''}">Strategy (Setuh)</button></div>
    ${S.histBook === 'manual' && t ? `<div class="kpis">
      <div class="kpi"><small>Closed trades</small><b>${t.trades}</b></div><div class="kpi"><small>Win rate</small><b>${t.winRate != null ? t.winRate + '%' : '—'}</b></div>
      <div class="kpi"><small>Net result</small><b class="${cls(t.netUsd)}">${fmt.signed(t.netUsd)}</b></div><div class="kpi"><small>Avg return</small><b class="${cls(t.avgReturnPct)}">${fmt.pct(t.avgReturnPct, 1)}</b></div>
      <div class="kpi"><small>Profit factor</small><b>${t.profitFactorInfinite ? '∞' : t.profitFactor != null ? t.profitFactor.toFixed(2) : '—'}</b></div><div class="kpi"><small>Max drawdown</small><b class="down">${t.maxDrawdownUsd ? fmt.signed(-t.maxDrawdownUsd) : '—'}</b></div>
      <div class="kpi"><small>Fees + slippage paid</small><b>${fmt.usd((t.feesUsd ?? 0) + (t.slippageUsd ?? 0), 2)}</b></div></div>` : ''}
    ${card('Completed positions', rows.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Token</th><th>Origin</th><th class="r">Entry</th><th class="r">Exit (avg)</th><th class="r">Quantity</th><th class="r">Invested</th><th class="r">Returned</th><th class="r">P&L</th><th class="r">Duration</th><th class="r">Fees + slip.</th><th>Exit reason</th><th>Closed</th></tr></thead><tbody>
      ${rows.map((p) => { const sells = p.fills.filter((f) => f.kind === 'sell'); const q = sells.reduce((s, f) => s + f.tokens, 0); const avgExit = q ? sells.reduce((s, f) => s + f.tokens * f.priceUsd, 0) / q : null;
        return `<tr><td class="b"><a href="#" data-load="${esc(p.mint)}">${p.symbol ? '$' + esc(p.symbol) : esc(p.mint.slice(0, 6))}</a></td><td><span class="tag">${esc(p.origin === 'manual' ? 'MANUAL' : p.origin)}</span></td>
          <td class="r num">${fmt.price(p.entryPriceUsd)}</td><td class="r num">${fmt.price(avgExit)}</td><td class="r num">${fmt.tokens(p.tokensInit)}</td>
          <td class="r num">${fmt.usd(p.budgetUsd, 2)}</td><td class="r num">${fmt.usd(p.proceedsUsd, 2)}</td><td class="r num ${cls(p.pnlUsd)}">${fmt.signed(p.pnlUsd)}<div class="tiny">${fmt.pct(p.pnlPct, 1)}</div></td>
          <td class="r num">${fmt.age(p.holdSec)}</td><td class="r num">${fmt.usd(p.feesUsd + p.slippageUsd, 2)}</td><td class="wrap small" style="max-width:260px">${esc(p.exitReason ?? '')}</td><td class="small muted">${fmt.dateTime(p.closedAt)}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">No completed positions yet.</div>', `${rows.length} shown`, { tight: true })}`;
}

// ------------------------------------------------------------------ events
function wire() {
  $('#tgo', root).addEventListener('click', () => openMint($('#tq', root).value));
  $('#tq', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') openMint($('#tq', root).value); });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const tf = t.closest('[data-tf]');
    if (tf) { S.tf = tf.dataset.tf; S.chart = null; drawChart(); chartPoll.stop(); chartPoll.start(); return; }
    const md = t.closest('[data-mode]');
    if (md) { S.mode = md.dataset.mode; drawChart(); return; }
    const pr = t.closest('[data-b]');
    if (pr) { $('#budget', root).value = pr.dataset.b; for (const b of $$('#presets button', root)) b.classList.toggle('primary', b === pr); renderPretrade(); return; }
    const ld = t.closest('[data-load]');
    if (ld) { e.preventDefault(); if (sub !== 'workstation') location.hash = `#/trade/workstation?mint=${ld.dataset.load}`; else { openMint(ld.dataset.load); window.scrollTo({ top: 0, behavior: 'smooth' }); } return; }
    const hb = t.closest('[data-hb]');
    if (hb) { S.histBook = hb.dataset.hb; renderHistory(); return; }
    if (t.closest('#openbtn')) return openPosition();
    const sell = t.closest('[data-sell]');
    if (sell) return doSell(sell.dataset.id, Number(sell.dataset.sell), sell);
    const sc = t.closest('[data-sellcustom]');
    if (sc) { const v = Number(root.querySelector(`[data-custom="${CSS.escape(sc.dataset.sellcustom)}"]`)?.value); if (!(v > 0 && v <= 100)) return toast('Enter a sell % between 1 and 100', 'bad'); return doSell(sc.dataset.sellcustom, v, sc); }
    const ed = t.closest('[data-edit]');
    if (ed) { const id = ed.dataset.edit; S.editing.has(id) ? S.editing.delete(id) : S.editing.add(id); const p = S.manual.open.find((x) => x.id === id); if (p) root.querySelector(`[data-pos="${CSS.escape(id)}"]`).outerHTML = posHtml(p); return; }
    const sv = t.closest('[data-saverisk]');
    if (sv) return saveRisk(sv.dataset.saverisk, sv);
  });
  root.addEventListener('input', (e) => { if (e.target.closest('#ticket')) { if (e.target.id === 'budget') for (const b of $$('#presets button', root)) b.classList.toggle('primary', b.dataset.b === e.target.value); renderPretrade(); } });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'trmode') $('#trval', root).disabled = e.target.value === 'off';
    if (e.target.id === 'slmode') { $('#slval', root).disabled = e.target.value === 'off'; if (e.target.value === 'price' && S.chart?.market?.priceUsd) $('#slval', root).value = +(S.chart.market.priceUsd * 0.8).toPrecision(4); if (e.target.value === 'pct') $('#slval', root).value = 20; }
    if (e.target.id === 'tpmode') { $('#tpval', root).disabled = e.target.value === 'off'; if (e.target.value === 'price' && S.chart?.market?.priceUsd) $('#tpval', root).value = +(S.chart.market.priceUsd * 1.5).toPrecision(4); if (e.target.value === 'pct') $('#tpval', root).value = 50; }
    if (e.target.closest('#ticket')) renderPretrade();
  });
}

async function openPosition() {
  const r = S.check;
  if (!r || !S.mint) return;
  const budgetUsd = Number($('#budget', root).value);
  const risk = riskFromTicket();
  if (r.verdict === 'AVOID' && !confirm(`This coin was rated AVOID (${r.bad} red flags). Start a paper position anyway, to watch what happens?`)) return;
  if (risk.stopPct == null && risk.stopPrice == null && !confirm('No stop-loss is set, so this simulated position could lose 100%. Start anyway?')) return;
  const btn = $('#openbtn', root);
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    const p = await api('/api/manual/open', { mint: S.mint, budgetUsd, risk, requestId: uid() });
    toast(`Paper position started: ${p.symbol ? '$' + p.symbol : 'coin'} · ${fmt.usd(budgetUsd, 2)}`, 'good');
    await manualPoll.now();
    $('#poscard', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast(e.message, 'bad'); }
  finally { renderPretrade(); }
}

async function doSell(id, pct, btn) {
  const p = S.manual?.open.find((x) => x.id === id);
  if (!p) return;
  if (pct >= 100 && !confirm(`Sell 100% of ${p.symbol ? '$' + p.symbol : 'this position'}? It would bring about ${fmt.usd(p.ifSoldUsd, 2)} after fees and slippage (${fmt.signed(p.pnlUsd)} total).`)) return;
  btn.disabled = true;
  try {
    const r = await api('/api/manual/sell', { id, pct, requestId: uid() });
    const last = r.position.fills.at(-1);
    toast(`Sold ${pct}% for ${fmt.usd(last?.netUsd, 2)} after fees${r.position.status === 'closed' ? ' · position closed' : ''}`, 'good');
    await manualPoll.now();
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}

async function saveRisk(id, btn) {
  const f = root.querySelector(`[data-riskform="${CSS.escape(id)}"]`);
  const v = (k) => f.querySelector(`[data-rf="${k}"]`).value.trim();
  const risk = { stopPct: null, stopPrice: null, tpPct: null, tpPrice: null, trailPct: null };
  if (v('slmode') === 'pct' && v('slval')) risk.stopPct = Number(v('slval'));
  if (v('slmode') === 'price' && v('slval')) risk.stopPrice = Number(v('slval'));
  if (v('tpmode') === 'pct' && v('tpval')) risk.tpPct = Number(v('tpval'));
  if (v('tpmode') === 'price' && v('tpval')) risk.tpPrice = Number(v('tpval'));
  risk.tpSellPct = Number(v('tpsell') || 100);
  if (v('trmode') === 'pct' && v('trval')) risk.trailPct = Number(v('trval'));
  btn.disabled = true;
  try {
    const p = await api('/api/manual/risk', { id, risk });
    S.editing.delete(id);
    toast(p.status === 'closed' ? 'Rules saved — a level was already reached, so the position was sold' : 'Stop / target / trail saved', 'good');
    await manualPoll.now();
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
}
