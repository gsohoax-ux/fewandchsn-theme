// Coin detail dialog (the bot's full read on a tracked coin). Same content as before the redesign.
import { $, esc, fmt, api, spark, scoreCls, LABEL_TAG, toast } from './core.js';

const FLAG = { ok: 'lv-ok', warn: 'lv-warn', bad: 'lv-bad', info: 'lv-info' };
let goTrade = null;
export function setTradeOpener(fn) { goTrade = fn; }

export async function openCoinByMint(mint, fallback = null) {
  const c = fallback ?? (await api(`/api/coin/${mint}`).catch(() => null));
  if (c?.safety) openCoin(c);
  else if (goTrade) goTrade(mint); // not tracked live: open it in Coin Check instead
}

export function openCoin(c) {
  const sf = c.safety, n = c.narrative, m = c.momentum;
  $('#dlg-h').innerHTML = `<span class="score ${scoreCls(c.score, sf?.verdict)}">${c.score ?? '…'}</span>
    <div style="min-width:0"><div class="b">$${esc(c.symbol)} <span class="muted">${esc(c.name)}</span> ${c.label ? `<span class="tag ${LABEL_TAG[c.label]}">${c.label}</span>` : ''}</div><code class="muted">${esc(c.mint)}</code></div>
    <button class="x" data-close aria-label="Close">×</button>`;
  $('#dlg-b').innerHTML = `
    <div class="links" style="margin-top:10px">${c.links.padre ? `<a target="_blank" rel="noopener" href="${esc(c.links.padre)}">Padre</a>` : ''}<a target="_blank" rel="noopener" href="${esc(c.links.pump)}">pump.fun</a><a target="_blank" rel="noopener" href="${esc(c.links.dexscreener)}">DexScreener</a><a target="_blank" rel="noopener" href="${esc(c.links.solscan)}">Solscan</a><a target="_blank" rel="noopener" href="${esc(c.links.rugcheck)}">RugCheck</a>
      ${c.twitter ? `<a target="_blank" rel="noopener" href="${esc(c.twitter)}">X</a>` : ''}${c.telegram ? `<a target="_blank" rel="noopener" href="${esc(c.telegram)}">Telegram</a>` : ''}
      <button class="btn sm" data-copy="${esc(c.mint)}">Copy address</button><button class="btn sm primary" data-trade="${esc(c.mint)}">Open in Coin Check</button></div>
    ${c.description ? `<p class="muted">${esc(c.description)}</p>` : ''}
    ${c.spark?.length > 1 ? `<div style="margin:10px 0">${spark(c.spark, 640, 60).replace('width="640"', 'width="100%" preserveAspectRatio="none"')}<div class="tiny muted">Market cap, last hour</div></div>` : ''}
    <div class="kv" style="margin-top:8px">
      <div><small>Market cap</small><b>${fmt.mcSol(c.mcSol)}</b></div><div><small>Curve</small><b>${c.migrated ? 'graduated' : c.progress.toFixed(0) + '%'}</b></div>
      <div><small>Age</small><b>${fmt.age(c.ageSec)}</b></div><div><small>Holders</small><b>${c.holders}</b></div><div><small>Trades</small><b>${c.trades}</b></div>
    </div>
    ${c.liquidity ? `<h3>Liquidity & slippage</h3><ul class="checks">
        <li class="${FLAG[c.liquidity.level === 'bad' ? 'bad' : c.liquidity.level === 'warn' ? 'warn' : 'ok']}">Curve holds ${fmt.usd(c.liquidity.realLiqUsd)}${c.liquidity.ratioPct != null ? ` = ${c.liquidity.ratioPct.toFixed(1)}% of market cap` : ''}${c.liquidity.level === 'bad' ? ' — HIGH RISK' : ''}</li>
        ${c.liquidity.rows.map((x) => `<li class="lv-info">$${x.usd} buy → ~${x.avgPct.toFixed(1)}% slippage, moves the price ~${x.movePct.toFixed(1)}%</li>`).join('')}
        <li class="lv-warn">If $${c.liquidity.orderUsd} grew to $${c.liquidity.orderUsd * 5} on paper, selling now would bring ~$${c.liquidity.cash.getUsd.toFixed(0)} (−${c.liquidity.cash.lossPct.toFixed(0)}%). Paper gains can't be cashed out in a thin pool.</li></ul>` : ''}
    ${c.runner?.is ? `<h3>Runner signs — ${c.runner.score}/100 (not a forecast)</h3><ul class="checks">${c.runner.reasons.map((r) => `<li class="lv-ok">${esc(r)}</li>`).join('')}</ul>
      <p class="tiny muted">Automatic paper trading gives runners room: sells only 25% near graduation, keeps a 30% moonbag, wider trail, up to 3 h hold.</p>` : ''}
    ${c.outcomes ? `<h3>Coins like this before — past results, not a prediction</h3><div class="kv">
        <div><small>Typical peak</small><b class="up">+${c.outcomes.medianPeakPct.toFixed(0)}%</b></div>
        <div><small>Reached 1.5x</small><b>${c.outcomes.hit1_5}%</b></div><div><small>Reached 2x</small><b>${c.outcomes.hit2}%</b></div>
        <div><small>Reached 3x</small><b>${c.outcomes.hit3}%</b></div><div><small>Reached 5x</small><b>${c.outcomes.hit5}%</b></div>
        ${c.outcomes.medianDropPct != null ? `<div><small>Typical drop</small><b class="down">−${c.outcomes.medianDropPct.toFixed(0)}%</b></div>` : ''}
      </div><p class="tiny muted">${c.outcomes.n} coins the bot scored ${c.outcomes.scoreFrom}–${c.outcomes.scoreTo} in the last 14 days, measured 2 hours after scoring.</p>` : ''}
    ${c.confidence ? `<h3>Confidence — ${c.confidence.label} ${c.confidence.meter} (${c.confidence.value})</h3>
      <ul class="checks">${c.confidence.reasons.map((r) => `<li class="lv-info">${esc(r)}</li>`).join('')}</ul>
      <p class="tiny muted">Confidence = how solid the data behind the score is, not the chance of profit.</p>` : ''}
    ${c.trend ? `<h3>Trend</h3><p><b>${esc(c.trend.label)}</b> — ${c.trend.sources.map(esc).join(' + ')} · ${c.trend.days} day${c.trend.days === 1 ? '' : 's'}${c.trend.spike ? ' · spiking' : ''}<br>
      ${c.trend.thesis ? `${esc(c.trend.thesis)}<br>` : ''}<span class="muted small">coin ${esc(c.trend.how)} · ${c.trend.coinsOnTrend > 1 ? `#${c.trend.rank} of ${c.trend.coinsOnTrend} coins on it` : 'only coin on it'}</span></p>` : ''}
    ${c.x ? `<h3>X post</h3><p><a target="_blank" rel="noopener" href="${esc(c.x.url)}">@${esc(c.x.author)}</a>: ${esc(c.x.text)}<br>
      <span class="muted small">${c.x.origin === 'radar' ? `${c.x.radarCoins} coins launched on it` : `${c.x.likes.toLocaleString()} likes`} · viral ${c.x.viral} · meme ${c.x.meme} · coin ${esc(c.x.how)} · ${c.x.coinsOnPost > 1 ? `#${c.x.rank} of ${c.x.coinsOnPost} coins on this post` : 'only coin on this post'}</span></p>` : ''}
    ${sf ? `<h3>Safety — <span class="v-${sf.verdict}">${sf.verdict}</span> (${sf.score})</h3>
    <ul class="checks">${sf.flags.map((f) => `<li class="${FLAG[f.level] ?? 'lv-info'}">${esc(f.text)}</li>`).join('')}</ul>` : ''}
    ${c.learned?.validated ? `<h3>Learned chance</h3><p><b>${Math.round(c.learned.p * 100)}%</b> chance of ${c.learned.target}x <span class="muted">(average coin ${Math.round(c.learned.baseRate * 100)}% · learned from ${c.learned.n} past coins)</span></p>` : ''}
    ${c.dexPaid ? '<p><span class="tag info">DEX PAID</span> The dev paid for a DexScreener profile</p>' : ''}
    ${n ? `<h3>Narrative — ${n.score} <span class="faint">(${n.source === 'ai' ? 'AI' : 'rules'})</span></h3>
    <p>${n.theme ? `<b>${esc(n.theme)}</b> · ` : ''}${n.freshness && n.freshness !== 'unknown' ? esc(n.freshness.replace('_', ' ')) + '<br>' : ''}${esc(n.summary)}</p>
    ${(n.redFlags || []).map((f) => `<div class="warn small">! ${esc(f)}</div>`).join('')}` : ''}
    ${m ? `<h3>Momentum — ${m.score}</h3>
    <div class="kv">
      <div><small>Curve speed</small><b>${m.progressPerMin.toFixed(1)}%/min</b></div><div><small>Buyers (2m)</small><b>${m.uniqueBuyers2m}</b></div>
      <div><small>Buy/sell volume</small><b>${m.buySellRatio.toFixed(2)}x</b></div><div><small>Net inflow (2m)</small><b>${m.netInflowSol.toFixed(1)} SOL</b></div>
      <div><small>Wash-like volume</small><b>${m.washPct.toFixed(0)}%</b></div><div><small>Off ATH</small><b>${m.drawdownPct.toFixed(0)}%</b></div>
      <div><small>Holders</small><b>${m.holders}</b></div><div><small>Smart wallets</small><b>${m.smartHolders.length}</b></div>
    </div>` : ''}
    ${c.events?.length ? `<h3>Events</h3>${c.events.map((e) => `<div class="small">${fmt.time(e.at)} — ${esc(e.text)}</div>`).join('')}` : ''}
    ${c.alert ? `<h3>Alert</h3><div class="small">Alerted at ${fmt.mcSol(c.alert.mcSol)} (${esc(c.alert.stage)}) · peak since ${c.alert.peakMult.toFixed(2)}x</div>` : ''}
    ${c.evaluatedAt ? `<p class="tiny faint" style="margin-top:16px">Scored ${new Date(c.evaluatedAt).toLocaleTimeString()} at ${esc(c.stage)} stage · safety data: ${sf?.source === 'chain' ? 'on-chain' : 'timing estimate'}</p>` : ''}`;
  if (!$('#dlg').open) $('#dlg').showModal();
}

// one delegated handler for the whole app: open coin, copy address, close dialog, jump to Coin Check
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { $('#dlg').close(); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    e.preventDefault(); e.stopPropagation();
    navigator.clipboard?.writeText(cp.dataset.copy).then(() => toast('Address copied'), () => toast('Copy failed', 'bad'));
    return;
  }
  const tr = e.target.closest('[data-trade]');
  if (tr) { e.preventDefault(); if ($('#dlg').open) $('#dlg').close(); goTrade?.(tr.dataset.trade); return; }
  const op = e.target.closest('[data-open]');
  if (op) {
    e.preventDefault();
    const st = (window.__mbState?.coins ?? []).find((x) => x.mint === op.dataset.open) ?? (window.__mbState?.runners ?? []).find((x) => x.mint === op.dataset.open);
    openCoinByMint(op.dataset.open, st);
  }
});
$('#dlg')?.addEventListener('click', (e) => { if (e.target === $('#dlg')) $('#dlg').close(); });
