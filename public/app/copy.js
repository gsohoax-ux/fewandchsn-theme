// Section 4: Copy Trading — full trade mirroring of followed wallets with simulated money (System D).
import { $, $$, esc, fmt, api, poller, card, cls, toast, uid, kpi } from './core.js';

export const SUBS = [['traders', 'Traders'], ['activity', 'Activity'], ['positions', 'Positions'], ['performance', 'Performance'], ['settings', 'Settings']];
const FIELDS = [
  ['buyUsd', 'Copy amount per buy ($)', 'Fixed simulated $ for every buy or add the trader makes'],
  ['maxPositionUsd', 'Max position size ($)', 'Cost basis cap per token'],
  ['maxExposureUsd', 'Max exposure for this trader ($)', 'All open copies of this trader'],
  ['stopPct', 'Stop-loss % (blank = off)', 'Independent: may exit before the trader'],
  ['tpPct', 'Take-profit % (blank = off)', ''],
  ['tpSellPct', 'Sell % at take-profit', ''],
  ['trailPct', 'Trailing stop % (blank = off)', 'Follows the high, never moves down'],
  ['maxHoldMin', 'Max holding time, min (blank = off)', ''],
  ['minLiqUsd', 'Min liquidity ($)', 'Buys into thinner pools are rejected'],
  ['maxSlippagePct', 'Max estimated slippage %', ''],
  ['maxBuyDelaySec', 'Max detection delay for buys (s)', 'Older buys are not copied; sells always are'],
];
const ACTION_TAG = { copied: 'up', mirrored: 'info', exited: 'warn', rejected: 'down', skipped: 'warn', ignored: '', processing: '' };
const KIND_LABEL = { buy: 'BUY', add: 'ADD', sell: 'SELL', exit: 'EXIT', transfer_in: 'TRANSFER IN', transfer_out: 'TRANSFER OUT', liquidity: 'LIQUIDITY', failed: 'FAILED TX',
  funding: 'FUNDING', unclear: 'OTHER', unconfirmed: 'UNCONFIRMED', 'own-rule': 'YOUR RULE', manual: 'YOUR SELL' };

let root, sub = 'traders', data = null, filter = '';
const poll = poller(async () => { data = await api('/api/copy'); if (!root.hidden) render(); }, 3000);

export function mount(el) { root = el; wire(); }
export function show(s) { sub = SUBS.some(([k]) => k === s) ? s : 'traders'; poll.start(); render(); }
export function hide() { poll.stop(); }

const short = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const name = (t) => esc(t.label || short(t.wallet));
const traderName = (w) => { const t = data.traders.find((x) => x.wallet === w); return t ? name(t) : esc(short(w ?? '')); };

function render() {
  if (!data) { root.innerHTML = '<div class="empty">Loading copy trading…</div>'; return; }
  if (root.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  const P = data.portfolio;
  const pf = P.profitFactorInfinite ? '∞' : P.profitFactor != null ? P.profitFactor.toFixed(2) : '—';
  const head = `<div class="section-title"><h2>Copy trading</h2><p>Full trade mirroring with simulated money: buys, adds, partial sells, exits and re-entries. Separate from all other paper trading.</p></div>
    <div class="notice ${data.verifying ? 'info' : 'warn'} small" style="margin-bottom:var(--gap)">${data.verifying
      ? `<b>On-chain verification on.</b> Every trade is confirmed with the actual transaction (balances before/after, failed status, DEX programs) before it is copied; trades on any DEX are found by scanning each wallet every ${data.settings.pollSec}s, Pump.fun trades arrive instantly from PumpPortal.${data.pendingConfirmations ? ` ${data.pendingConfirmations} transaction(s) waiting for confirmation.` : ''}`
      : '<b>Feed-only mode:</b> without a Helius key, only Pump.fun / PumpSwap trades from the PumpPortal feed are mirrored and they are not confirmed on-chain. Add HELIUS_API_KEY for confirmed copying across all DEXes.'}
      ${data.demoWallets ? ' <b>Demo:</b> two simulated traders are followed automatically.' : ''}</div>
    <div class="kpis">
      ${kpi('Followed traders', data.traders.length, `${data.traders.filter((t) => t.enabled && !t.paused).length} active`)}
      ${kpi('Open copies', data.open.length, `${fmt.usd(P.exposureUsd, 0)} of ${fmt.usd(P.maxTotalExposureUsd, 0)} exposure`)}
      ${kpi('Value if sold now', fmt.usd(P.value, 2), data.open.length ? fmt.pct(P.pnlPct, 1) : '')}
      ${kpi('Unrealized P&L', data.open.length ? fmt.signed(P.unrealizedUsd) : '—', '', cls(P.unrealizedUsd))}
      ${kpi('Realized P&L', fmt.signed(P.realizedUsd), `${P.closedCount} closed · win ${P.winRate != null ? P.winRate + '%' : '—'} · PF ${pf}`, cls(P.realizedUsd))}
    </div>`;
  const body = sub === 'traders' ? traders() : sub === 'activity' ? activity() : sub === 'positions' ? positions() : sub === 'performance' ? performance() : settings();
  root.innerHTML = head + body;
}

// ------------------------------------------------------------------ traders
function traders() {
  const add = card('Follow a wallet', `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:3 1 320px"><label>Wallet address</label><input class="input mono" id="cw" placeholder="Solana wallet to copy" spellcheck="false" autocomplete="off"></div>
      <div class="field" style="flex:1 1 140px"><label>Label</label><input class="input" id="cl" placeholder="e.g. Fast scalper"></div>
      <div class="field" style="flex:0 1 140px"><label>Copy amount per buy ($)</label><input class="input mono" id="cb" type="number" min="1" value="25"></div>
      <button class="btn primary" data-follow>Follow</button></div>
    <p class="tiny muted" style="margin-bottom:0">Copying starts from now: the wallet's earlier trades are never copied. Its sells only mirror positions the bot copied.</p>`);
  if (!data.traders.length) return add + '<div class="empty">No wallets followed yet.</div>';
  return add + `<div class="grid" style="margin-top:var(--gap)">${data.traders.map(traderCard).join('')}</div>`;
}

function traderCard(t) {
  const s = t.stats, S = t.settings;
  const state = !t.enabled ? 'down' : t.paused ? 'warn' : 'up';
  return `<div class="card"><header style="flex-wrap:wrap"><h2 style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--text)">${name(t)}</h2>
      <code class="faint" style="word-break:break-all;min-width:0">${esc(t.wallet)}</code><button class="btn sm ghost" data-copy="${esc(t.wallet)}">Copy</button>
      <div class="meta" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="tag ${state}">${esc(t.status.state)}</span>
        <button class="btn sm ${t.enabled ? '' : 'primary'}" data-onoff="${esc(t.wallet)}">${t.enabled ? 'Copy OFF' : 'Copy ON'}</button>
        <button class="btn sm" data-pause="${esc(t.wallet)}" ${t.enabled ? '' : 'disabled'}>${t.paused ? 'Resume' : 'Pause'}</button></div></header>
    <div class="body">
      <div class="kv">
        <div><small>Mirroring</small><b style="font-family:var(--font);font-size:12.5px">${esc(t.status.mirroring)}</b></div>
        <div><small>Open copies</small><b>${s.open}</b></div><div><small>Exposure</small><b>${fmt.usd(s.exposureUsd, 2)} / ${fmt.usd(S.maxExposureUsd, 0)}</b></div>
        <div><small>Unrealized</small><b class="${cls(s.unrealizedUsd)}">${s.open ? fmt.signed(s.unrealizedUsd) : '—'}</b></div>
        <div><small>Realized (closed)</small><b class="${cls(s.netUsd)}">${s.trades ? fmt.signed(s.netUsd) : '—'}</b></div>
        <div><small>Win rate</small><b>${s.winRate != null ? s.winRate + '%' : '—'}</b></div>
        <div><small>Copied / mirrored</small><b>${s.counts.copied ?? 0} / ${s.counts.mirrored ?? 0}</b></div>
        <div><small>Rejected / skipped</small><b>${s.counts.rejected ?? 0} / ${s.counts.skipped ?? 0}</b></div>
        <div><small>Avg detection delay</small><b>${s.avgDelaySec != null ? fmt.age(s.avgDelaySec) : '—'}</b></div>
        <div><small>Avg copy price vs trader</small><b class="${s.avgVsTraderPct > 0 ? 'down' : 'up'}">${s.avgVsTraderPct != null ? fmt.pct(s.avgVsTraderPct, 1) : '—'}</b></div>
      </div>
      <p class="tiny muted">${esc(t.status.verification)}. OFF stops new copies; exits of open copies keep being mirrored until they're closed. Pause skips buys but still mirrors sells.</p>
      <details><summary>Copy settings · $${S.buyUsd} per buy · max $${S.maxPositionUsd}/position${S.stopPct != null ? ` · stop −${S.stopPct}%` : ''}${S.tpPct != null ? ` · target +${S.tpPct}%` : ''}${S.trailPct != null ? ` · trail ${S.trailPct}%` : ''}</summary>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-top:10px" data-form="${esc(t.wallet)}">
          <div class="field"><label>Label</label><input class="input" data-f="label" value="${esc(t.label)}"></div>
          ${FIELDS.map(([k, l, h]) => `<div class="field"><label title="${esc(h)}">${esc(l)}</label><input class="input mono" data-f="${k}" type="number" step="any" min="0" value="${S[k] ?? ''}"></div>`).join('')}
          <label class="check small"><input type="checkbox" data-f="copyAdds" ${S.copyAdds ? 'checked' : ''}> Copy the trader's adds</label>
          <label class="check small"><input type="checkbox" data-f="reenterAfterSafetyExit" ${S.reenterAfterSafetyExit ? 'checked' : ''}> Re-enter on the trader's adds after my own rule closed the copy</label>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm primary" data-save="${esc(t.wallet)}">Save settings</button>
          <button class="btn sm" data-unfollow="${esc(t.wallet)}" style="margin-left:auto">Unfollow</button></div>
      </details>
    </div></div>`;
}

// ------------------------------------------------------------------ activity
function activity() {
  const rows = data.events.filter((e) => !filter || e.wallet === filter);
  const opts = `<select class="input" id="cf" style="width:220px"><option value="">All traders</option>${data.traders.map((t) => `<option value="${esc(t.wallet)}" ${filter === t.wallet ? 'selected' : ''}>${name(t)}</option>`).join('')}</select>`;
  return card('What the followed wallets did, and what the bot did', `<div style="padding:10px 14px">${opts}</div>${rows.length ? `<div class="scroll-x"><table class="t"><thead><tr>
      <th>Time</th><th>Trader</th><th>Coin</th><th>Trader did</th><th class="r">Their balance</th><th class="r">Their price</th><th>Copy</th><th class="r">Copy price</th><th class="r">Delay</th><th>Details</th><th>Tx</th></tr></thead><tbody>
    ${rows.map((e) => {
      const tr = e.trader;
      const kind = KIND_LABEL[e.kind] ?? e.kind;
      const did = e.kind === 'sell' && tr?.soldPct != null ? `SELL ${tr.soldPct.toFixed(1)}%` : kind;
      return `<tr><td class="small muted">${fmt.time(e.at)}</td><td class="small">${traderName(e.wallet)}</td>
        <td class="b">${e.mint ? `<a href="#/trade/workstation?mint=${esc(e.mint)}">${e.symbol ? '$' + esc(e.symbol) : esc(e.mint.slice(0, 6) + '…')}</a>` : '—'}</td>
        <td><span class="tag ${['buy', 'add'].includes(e.kind) ? 'up' : ['sell', 'exit'].includes(e.kind) ? 'down' : ''}">${esc(did)}</span>${tr?.usd ? `<div class="tiny muted">≈ ${fmt.usd(tr.usd)}</div>` : ''}</td>
        <td class="r num small">${tr && tr.pre != null ? `${fmt.tokens(tr.pre)} → ${fmt.tokens(tr.post)}` : '—'}</td>
        <td class="r num small">${tr?.priceUsd ? fmt.price(tr.priceUsd) : '—'}</td>
        <td><span class="tag ${ACTION_TAG[e.action] ?? ''}">${esc(String(e.action).toUpperCase())}</span>${e.copy?.usd ? `<div class="tiny muted">${fmt.usd(e.copy.usd, 2)}</div>` : e.copy?.soldPct != null ? `<div class="tiny muted">sold ${e.copy.soldPct.toFixed(1)}%</div>` : ''}</td>
        <td class="r num small">${e.copy?.priceUsd ? fmt.price(e.copy.priceUsd) : '—'}${e.copy?.vsTraderPct != null ? `<div class="tiny ${e.copy.vsTraderPct > 0 ? 'down' : 'up'}">${fmt.pct(e.copy.vsTraderPct, 1)} vs trader</div>` : ''}</td>
        <td class="r num small">${e.delaySec != null ? fmt.age(e.delaySec) : '—'}</td>
        <td class="wrap small" style="min-width:280px;max-width:480px">${esc(e.reason ?? '')}<div class="tiny faint">${e.verified ? `${esc(e.venue ?? '')} · confirmed on-chain` : e.source ? esc(e.source) : esc(e.venue ?? '')}</div></td>
        <td class="small">${e.signature ? `<a target="_blank" rel="noopener" href="https://solscan.io/tx/${esc(e.signature)}">${esc(e.signature.slice(0, 6))}…</a>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">No activity yet. Everything a followed wallet does appears here: copied, mirrored, rejected (with why) or ignored (transfers, liquidity, failed, funding).</div>'}`, `${rows.length} events`, { tight: true });
}

// ------------------------------------------------------------------ positions
function positions() {
  if (!data.open.length) return card('Open copied positions', '<div class="empty">No open copies. They appear when a followed wallet buys.</div>', '', { tight: true });
  return card('Open copied positions', data.open.map((p) => {
    const t = data.traders.find((x) => x.wallet === p.meta?.trader);
    return `<div class="pos"><div class="pos-top"><a class="tk" href="#/trade/workstation?mint=${esc(p.mint)}">${p.symbol ? '$' + esc(p.symbol) : esc(p.mint.slice(0, 6))}</a><span class="tag info">COPY · ${t ? name(t) : esc(short(p.meta?.trader ?? ''))}</span>
        <span class="small muted">opened ${fmt.ago(p.openedAt)} · ${esc(p.source)}${p.staleSec > 60 ? ` · <span class="warn">price ${fmt.age(p.staleSec)} old</span>` : ''}</span>
        <span style="margin-left:auto" class="num ${cls(p.pnlUsd)}"><b>${fmt.signed(p.pnlUsd)}</b> ${fmt.pct(p.pnlPct, 1)}</span></div>
      <div class="pos-grid">
        <div><small>Invested (all buys)</small><b>${fmt.usd(p.budgetUsd, 2)}</b></div><div><small>Avg entry (market)</small><b>${fmt.price(p.entryPriceUsd)}</b></div>
        <div><small>Now</small><b class="${cls(p.priceChangePct)}">${fmt.price(p.priceUsd)}</b></div><div><small>Market cap</small><b>${fmt.usd(p.mcUsd)}</b></div>
        <div><small>Tokens left</small><b>${fmt.tokens(p.tokens)}</b><small class="faint" style="text-transform:none">${p.soldPct > 0.1 ? `${p.soldPct.toFixed(1)}% sold` : 'none sold'}</small></div>
        <div><small>Value if sold now</small><b>${fmt.usd(p.ifSoldUsd, 2)}</b></div>
        <div><small>Unrealized</small><b class="${cls(p.unrealizedUsd)}">${fmt.signed(p.unrealizedUsd)}</b></div><div><small>Realized</small><b class="${cls(p.realizedPnlUsd)}">${fmt.signed(p.realizedPnlUsd)}</b></div>
        <div><small>Stop / target / trail</small><b>${p.levels.stop ? fmt.price(p.levels.stop) : 'off'} / ${p.levels.target ? fmt.price(p.levels.target) : 'off'} / ${p.levels.trail ? fmt.price(p.levels.trail) : 'off'}</b></div>
      </div>
      <details style="margin-top:8px"><summary>Mirror history (${p.fills.length} fills)</summary><table class="t" style="margin-top:6px"><tbody>${p.fills.map((f) => `<tr><td class="small muted">${fmt.time(f.at)}</td><td><span class="tag ${f.kind === 'buy' ? 'up' : 'down'}">${f.kind.toUpperCase()}${f.kind === 'sell' && f.pct ? ' ' + f.pct.toFixed(1) + '%' : ''}</span></td><td class="r num small">${fmt.price(f.priceUsd)}</td><td class="r num small ${cls(-f.netUsd)}">${f.kind === 'buy' ? '−' + fmt.usd(f.grossUsd, 2) : '+' + fmt.usd(f.netUsd, 2)}</td><td class="wrap small">${esc(f.reason)}</td></tr>`).join('')}</tbody></table></details>
      <div class="pos-actions"><span class="small b">SELL</span>${[25, 50].map((x) => `<button class="btn sm sell" data-csell="${x}" data-id="${esc(p.id)}">${x}%</button>`).join('')}<button class="btn sm sell" data-csell="100" data-id="${esc(p.id)}">SELL 100%</button>
        <span class="tiny muted">Your override; the trader's next sells still mirror on what's left.</span></div></div>`;
  }).join(''), 'exits run automatically on the server', { tight: true });
}

// ------------------------------------------------------------------ performance
function performance() {
  const rows = data.traders;
  const pf = (x) => (x.profitFactorInfinite ? '∞' : x.profitFactor != null ? x.profitFactor.toFixed(2) : '—');
  return `${card('Performance by trader', rows.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Trader</th><th>Status</th><th class="r">Copied</th><th class="r">Mirrored</th><th class="r">Rejected</th><th class="r">Open</th><th class="r">Exposure</th><th class="r">Unrealized</th><th class="r">Closed</th><th class="r">Win rate</th><th class="r">Avg win</th><th class="r">Avg loss</th><th class="r">Profit factor</th><th class="r">Max DD</th><th class="r">Fees + slip.</th><th class="r">Net (closed)</th></tr></thead><tbody>
      ${rows.map((t) => { const s = t.stats; return `<tr><td class="b">${name(t)}</td><td><span class="tag ${!t.enabled ? 'down' : t.paused ? 'warn' : 'up'}">${!t.enabled ? 'OFF' : t.paused ? 'PAUSED' : 'ACTIVE'}</span></td>
        <td class="r num">${s.counts.copied ?? 0}</td><td class="r num">${s.counts.mirrored ?? 0}</td><td class="r num">${s.counts.rejected ?? 0}</td><td class="r num">${s.open}</td><td class="r num">${fmt.usd(s.exposureUsd, 2)}</td>
        <td class="r num ${cls(s.unrealizedUsd)}">${s.open ? fmt.signed(s.unrealizedUsd) : '—'}</td><td class="r num">${s.trades}</td><td class="r num">${s.winRate != null ? s.winRate + '%' : '—'}</td>
        <td class="r num up">${s.avgWinPct != null ? fmt.pct(s.avgWinPct, 1) : '—'}</td><td class="r num down">${s.avgLossPct != null ? fmt.pct(s.avgLossPct, 1) : '—'}</td><td class="r num">${pf(s)}</td>
        <td class="r num down">${s.maxDrawdownUsd ? fmt.signed(-s.maxDrawdownUsd) : '—'}</td><td class="r num">${fmt.usd((s.feesUsd ?? 0) + (s.slippageUsd ?? 0), 2)}</td><td class="r num ${cls(s.netUsd)}">${s.trades ? fmt.signed(s.netUsd) : '—'}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">Follow a wallet to see its results.</div>', 'copy book only', { tight: true })}
    <div style="margin-top:var(--gap)">${card('Closed copied positions', data.closed.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>Coin</th><th>Trader</th><th class="r">Invested</th><th class="r">Returned</th><th class="r">P&L</th><th class="r">Held</th><th class="r">Fills</th><th>Exit</th></tr></thead><tbody>
      ${data.closed.map((p) => `<tr><td class="b"><a href="#/trade/workstation?mint=${esc(p.mint)}">${p.symbol ? '$' + esc(p.symbol) : esc(p.mint.slice(0, 6))}</a></td><td class="small">${traderName(p.meta?.trader)}</td><td class="r num">${fmt.usd(p.budgetUsd, 2)}</td><td class="r num">${fmt.usd(p.proceedsUsd, 2)}</td>
        <td class="r num ${cls(p.pnlUsd)}">${fmt.signed(p.pnlUsd)} <span class="tiny">${fmt.pct(p.pnlPct, 1)}</span></td><td class="r num">${fmt.age(p.holdSec)}</td><td class="r num">${p.fills.length}</td><td class="wrap small">${esc(p.exitReason ?? '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No closed copies yet.</div>', `${data.closed.length} shown`, { tight: true })}</div>
    <p class="disclaimer">Simulated fills at the price available when the bot processed each trade, with fees and slippage. A copy usually gets a worse price than the trader. Paper results don't predict future returns, and paper gains can't be cashed out in a thin pool.</p>`;
}

// ------------------------------------------------------------------ settings
function settings() {
  const s = data.settings;
  return card('Copy trading portfolio', `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));align-items:end">
      <div class="field"><label>Max total exposure, all traders ($)</label><input class="input mono" data-g="maxTotalExposureUsd" type="number" min="1" value="${s.maxTotalExposureUsd}"></div>
      <div class="field"><label>Scan followed wallets every (s)</label><input class="input mono" data-g="pollSec" type="number" min="10" max="600" value="${s.pollSec}"></div>
      <label class="check"><input type="checkbox" data-g="requireVerified" ${s.requireVerified ? 'checked' : ''}> Only copy trades confirmed on-chain</label>
      <button class="btn primary" data-saveg>Save</button></div>
    <ul class="checks small" style="margin-top:14px">
      <li class="lv-info">Copied: buys and adds (fixed $ each), partial sells (same % of the copy as the trader sold of their balance), full exits, re-entries.</li>
      <li class="lv-info">Never copied: token transfers, wallet funding, liquidity deposits/withdrawals, failed transactions, unrelated token movements.</li>
      <li class="lv-info">Each wallet + transaction + token is executed once, even if it is seen several times or arrives late.</li>
      <li class="lv-info">Prices: the market price available when the bot processes the trade (not the trader's fill), plus fees and slippage for your size.</li>
      <li class="lv-info">Scanning uses Helius credits: about one call per wallet per scan, plus one per transaction. A longer interval uses fewer credits; Pump.fun trades still arrive instantly from PumpPortal.</li>
    </ul>`);
}

// ------------------------------------------------------------------ events
function wire() {
  root.addEventListener('change', (e) => { if (e.target.id === 'cf') { filter = e.target.value; e.target.blur(); render(); } });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok, 'good'); document.activeElement?.blur(); data = await api('/api/copy'); render(); } catch (err) { toast(err.message, 'bad'); } };
    if (t.closest('[data-follow]')) {
      const wallet = $('#cw', root).value.trim(), label = $('#cl', root).value.trim(), buyUsd = Number($('#cb', root).value);
      return run(() => api('/api/copy/follow', { wallet, label, settings: { buyUsd } }), 'Following — copying starts from now');
    }
    const oo = t.closest('[data-onoff]');
    if (oo) { const tr = data.traders.find((x) => x.wallet === oo.dataset.onoff); return run(() => api('/api/copy/trader', { wallet: tr.wallet, enabled: !tr.enabled }), tr.enabled ? 'Copy OFF' : 'Copy ON'); }
    const pa = t.closest('[data-pause]');
    if (pa) { const tr = data.traders.find((x) => x.wallet === pa.dataset.pause); return run(() => api('/api/copy/trader', { wallet: tr.wallet, paused: !tr.paused }), tr.paused ? 'Resumed' : 'Paused — sells still mirrored'); }
    const sv = t.closest('[data-save]');
    if (sv) {
      const f = root.querySelector(`[data-form="${CSS.escape(sv.dataset.save)}"]`);
      const settings = {}; let label;
      for (const el of $$('[data-f]', f)) {
        const k = el.dataset.f;
        if (k === 'label') label = el.value;
        else if (el.type === 'checkbox') settings[k] = el.checked;
        else settings[k] = el.value === '' ? null : Number(el.value);
      }
      return run(() => api('/api/copy/trader', { wallet: sv.dataset.save, label, settings }), 'Settings saved');
    }
    const uf = t.closest('[data-unfollow]');
    if (uf && confirm('Stop following this wallet? Its history stays in Performance.')) return run(() => api('/api/copy/unfollow', { wallet: uf.dataset.unfollow }), 'Unfollowed');
    const cs = t.closest('[data-csell]');
    if (cs) {
      const pct = Number(cs.dataset.csell);
      if (pct >= 100 && !confirm('Sell 100% of this copied position now?')) return;
      cs.disabled = true;
      return run(() => api('/api/copy/sell', { id: cs.dataset.id, pct, requestId: uid() }), `Sold ${pct}%`);
    }
    if (t.closest('[data-saveg]')) {
      const v = {}; for (const el of $$('[data-g]', root)) v[el.dataset.g] = el.type === 'checkbox' ? el.checked : Number(el.value);
      return run(() => api('/api/copy/settings', { values: v }), 'Saved');
    }
  });
}
