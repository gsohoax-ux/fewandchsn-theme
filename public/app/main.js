// App shell: navigation (sidebar on desktop, bottom bar + sub-tabs on mobile), routing, top-bar status and search.
import { $, $$, esc, ICONS, onState, store } from './core.js';
import * as dashboard from './dashboard.js';
import * as strategy from './strategy.js';
import * as trade from './trade.js';
import * as copy from './copy.js';
import { setTradeOpener } from './coin.js';

const SECTIONS = [
  { id: 'dashboard', title: 'Dashboard', short: 'Dashboard', mod: dashboard, icon: ICONS.dashboard },
  { id: 'strategy', title: 'Strategy', short: 'Strategy', mod: strategy, icon: ICONS.strategy },
  { id: 'trade', title: 'Coin Check & Paper Trade', short: 'Coin Check', mod: trade, icon: ICONS.trade },
  { id: 'copy', title: 'Copy Trading', short: 'Copy', mod: copy, icon: ICONS.copy },
];
let current = null;

for (const s of SECTIONS) s.mod.mount($(`#view-${s.id}`));

// sidebar + bottom bar
$('#nav').innerHTML = SECTIONS.map((s) => `<div class="grp"><button class="top" data-go="#/${s.id}">${s.icon}<span>${s.title}</span></button>
  <div class="sub">${s.mod.SUBS.map(([k, l]) => `<button data-go="#/${s.id}/${k}">${l}</button>`).join('')}</div></div>`).join('');
$('#bottomnav').innerHTML = SECTIONS.map((s) => `<button data-go="#/${s.id}">${s.icon}<span>${s.short}</span></button>`).join('');
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); location.hash = g.dataset.go; }
});

function parse() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const [sec, sub] = path.split('/');
  return { sec: SECTIONS.some((s) => s.id === sec) ? sec : 'dashboard', sub: sub || '', params: Object.fromEntries(new URLSearchParams(qs)) };
}

function route() {
  const { sec, sub, params } = parse();
  const S = SECTIONS.find((s) => s.id === sec);
  const subKey = S.mod.SUBS.some(([k]) => k === sub) ? sub : S.mod.SUBS[0][0];
  if (current && current !== S) current.mod.hide();
  for (const s of SECTIONS) $(`#view-${s.id}`).hidden = s !== S;
  current = S;
  S.mod.show(subKey, params);
  $('#title').innerHTML = `${esc(S.title)} <span>/ ${esc(S.mod.SUBS.find(([k]) => k === subKey)[1])}</span>`;
  for (const b of $$('#nav .top')) b.classList.toggle('on', b.dataset.go === `#/${S.id}`);
  for (const b of $$('#nav .sub button')) b.classList.toggle('on', b.dataset.go === `#/${S.id}/${subKey}`);
  for (const b of $$('#bottomnav button')) b.classList.toggle('on', b.dataset.go === `#/${S.id}`);
  $('#subtabs').innerHTML = S.mod.SUBS.map(([k, l]) => `<button class="${k === subKey ? 'on' : ''}" data-go="#/${S.id}/${k}">${l}</button>`).join('');
  try { localStorage.setItem('mb_route', location.hash); } catch { /* private mode */ }
}
window.addEventListener('hashchange', route);

// open a coin in Coin Check from anywhere
const goTrade = (q) => { location.hash = `#/trade/workstation?mint=${encodeURIComponent(q)}`; };
setTradeOpener(goTrade);
$('#gsearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#gsearch-q').value.trim();
  if (!q) return;
  $('#gsearch-q').value = '';
  if (current?.id === 'trade') trade.openMint(q); else goTrade(q);
});

// top-bar status
const aiName = (id) => { const m = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/); return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : 'off'; };
onState((s) => {
  const st = s.status;
  const chip = (ok, label, title = '') => `<span class="chip" title="${esc(title)}"><span class="dot ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}"></span>${label}</span>`;
  $('#status').innerHTML = (st.demo ? '<span class="chip demo">DEMO DATA</span>' : '') +
    chip(st.feedConnected, st.feedConnected ? 'Feed live' : 'Feed offline', st.feedConnected ? `last data ${st.feedLastDataSec ?? '?'}s ago · ${st.feedReconnects} reconnects` : st.feedProblem) +
    chip(st.helius ? true : null, 'Helius', st.helius ? 'On-chain checks on' : 'Add HELIUS_API_KEY for bundle tracing') +
    chip(String(st.ai).startsWith('claude') ? true : null, `AI ${aiName(st.ai)}`, String(st.ai)) +
    chip(st.notify.length ? true : null, 'Alerts', st.notify.length ? st.notify.join(' + ') : 'No alert channel') +
    (st.regime ? `<span class="chip" title="${st.regime.launches} launches, ${st.regime.grads} graduations in 24 h">Market: ${esc(st.regime.state)}</span>` : '') +
    (st.paused ? '<span class="chip"><span class="dot warn"></span>Alerts paused</span>' : '');
  store.solUsd = st.solUsd || 0;
});

// start where you left off
let saved = null;
try { saved = localStorage.getItem('mb_route'); } catch { /* private mode */ }
if (!location.hash && saved) location.hash = saved; else route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
