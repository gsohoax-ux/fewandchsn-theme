// App shell: four sections, each with its pages. Sidebar on desktop, bottom bar + page tabs on phones.
import { $, $$, esc, ICONS, onState, store } from './core.js';
import * as dashboard from './dashboard.js';
import * as strategy from './strategy.js';
import * as trade from './trade.js';
import * as copy from './copy.js';
import * as setuh from './setuh.js';
import * as auto from './auto.js';
import { setTradeOpener } from './coin.js';

const MODULES = { dashboard, strategy, trade, copy, setuh, auto };
// section -> pages; each page is shown by one module (a module can serve pages in several sections)
const NAV = [
  { id: 'dashboard', title: 'Dashboard', short: 'Dashboard', icon: ICONS.dashboard, pages: [
    ['overview', 'Overview', 'dashboard', 'overview'], ['trends', 'Trends', 'dashboard', 'trends'],
    ['learning', 'Learning Center', 'dashboard', 'learning'], ['system', 'System & latency', 'dashboard', 'system'], ['diagnostics', 'Diagnostics (audit)', 'dashboard', 'diagnostics']] },
  { id: 'strategy', title: 'Setuh Strategy', short: 'Strategy', icon: ICONS.strategy, pages: [
    ['newpairs', 'New Pairs', 'strategy', 'newpairs'], ['final', 'Final Stretch A / B / C', 'strategy', 'final'],
    ['migrated', 'Migrated', 'strategy', 'migrated'], ['rules', 'Rules & thresholds', 'strategy', 'settings']] },
  { id: 'check', title: 'Coin Check', short: 'Coin Check', icon: ICONS.trade, pages: [['coin', 'Check a coin', 'trade', 'workstation']] },
  { id: 'paper', title: 'Paper Trading', short: 'Paper', icon: ICONS.copy, pages: [
    ['setuh', 'Setuh Scalping Trader', 'setuh', 'trader'], ['journal', 'Setuh journal & analytics', 'setuh', 'journal'],
    ['auto', 'Automatic (alerts)', 'auto', 'auto'], ['manual', 'Manual', 'trade', 'manual'], ['copy', 'Copy trading', 'copy', 'traders']] },
];
// older links keep working
const ALIASES = { '#/trade/workstation': '#/check/coin', '#/trade/history': '#/paper/manual', '#/trade/manual': '#/paper/manual', '#/copy': '#/paper/copy',
  '#/strategy/performance': '#/paper/journal', '#/strategy/settings': '#/strategy/rules', '#/dashboard/system': '#/dashboard/system' };

const views = $('#content');
for (const id of Object.keys(MODULES)) {
  if (!$(`#view-${id}`)) views.insertAdjacentHTML('beforeend', `<section id="view-${id}" hidden></section>`);
  MODULES[id].mount($(`#view-${id}`));
}
let current = null;

$('#nav').innerHTML = NAV.map((s) => `<div class="grp"><button class="top" data-go="#/${s.id}">${s.icon}<span>${s.title}</span></button>
  <div class="sub">${s.pages.map(([k, l]) => `<button data-go="#/${s.id}/${k}">${l}</button>`).join('')}</div></div>`).join('');
$('#bottomnav').innerHTML = NAV.map((s) => `<button data-go="#/${s.id}">${s.icon}<span>${s.short}</span></button>`).join('');
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); location.hash = g.dataset.go; }
});

function parse() {
  let raw = location.hash || '#/dashboard';
  const [p0, q0 = ''] = raw.split('?');
  for (const [from, to] of Object.entries(ALIASES)) if (p0 === from || p0.startsWith(from + '/')) { raw = to + (q0 ? `?${q0}` : ''); break; }
  const [path, qs = ''] = raw.replace(/^#\/?/, '').split('?');
  const [sec, page] = path.split('/');
  const S = NAV.find((s) => s.id === sec) ?? NAV[0];
  const P = S.pages.find(([k]) => k === page) ?? S.pages[0];
  return { S, P, params: Object.fromEntries(new URLSearchParams(qs)) };
}

function route() {
  const { S, P, params } = parse();
  const [key, label, modId, sub] = P;
  const mod = MODULES[modId];
  if (current && current !== mod) current.hide();
  for (const id of Object.keys(MODULES)) $(`#view-${id}`).hidden = id !== modId;
  current = mod;
  mod.show(sub, params);
  $('#title').innerHTML = `${esc(S.title)} <span>/ ${esc(label)}</span>`;
  for (const b of $$('#nav .top')) b.classList.toggle('on', b.dataset.go === `#/${S.id}`);
  for (const b of $$('#nav .sub button')) b.classList.toggle('on', b.dataset.go === `#/${S.id}/${key}`);
  for (const b of $$('#bottomnav button')) b.classList.toggle('on', b.dataset.go === `#/${S.id}`);
  $('#subtabs').innerHTML = S.pages.length > 1 ? S.pages.map(([k, l]) => `<button class="${k === key ? 'on' : ''}" data-go="#/${S.id}/${k}">${l}</button>`).join('') : '';
  $('#subtabs').style.display = S.pages.length > 1 ? '' : 'none';
  try { localStorage.setItem('mb_route', location.hash); } catch { /* private mode */ }
}
window.addEventListener('hashchange', route);

// open a coin in Coin Check from anywhere
const goCheck = (q) => { location.hash = `#/check/coin?mint=${encodeURIComponent(q)}`; };
setTradeOpener(goCheck);
$('#gsearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#gsearch-q').value.trim();
  if (!q) return;
  $('#gsearch-q').value = '';
  if (current === trade && location.hash.startsWith('#/check')) trade.openMint(q); else goCheck(q);
});

// top-bar status
const aiName = (id) => { const m = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/); return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : 'off'; };
onState((s) => {
  const st = s.status;
  const chip = (ok, label, title = '') => `<span class="chip" title="${esc(title)}"><span class="dot ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}"></span>${label}</span>`;
  const age = st.feedLastDataSec;
  const feedState = !st.feedConnected ? false : age == null ? null : age <= 2 ? true : age <= 10 ? null : false;
  $('#status').innerHTML = (st.demo ? '<span class="chip demo">DEMO DATA</span>' : '') +
    chip(feedState, st.feedConnected ? (age != null && age > 10 ? `Feed stale ${age}s` : 'Feed live') : 'Feed offline', st.feedConnected ? `last data ${age ?? '?'}s ago · ${st.feedReconnects} reconnects` : st.feedProblem) +
    // discovery can keep flowing while trades stop: show that separately, loudly
    (st.feedConnected && st.feedTradesHealthy === false ? chip(false, `Trades stale ${st.feedLastTradeSec ?? '—'}s`, 'New coins arrive but no trade messages: prices frozen, new paper entries blocked, open positions still monitored') : '') +
    (!st.demo && st.solStale ? chip(false, 'SOL price stale', `SOL/USD ${st.solUsdAgeSec ?? '?'}s old: new paper entries blocked`) : '') +
    chip(st.helius ? true : null, 'Helius', st.helius ? 'On-chain checks on' : 'Add HELIUS_API_KEY for bundle tracing') +
    chip(String(st.ai).startsWith('claude') ? true : null, `AI ${aiName(st.ai)}`, String(st.ai)) +
    chip(st.notify.length ? true : null, 'Alerts', st.notify.length ? st.notify.join(' + ') : 'No alert channel') +
    (st.regime ? `<span class="chip" title="${st.regime.launches} launches, ${st.regime.grads} graduations in 24 h">Market: ${esc(st.regime.state)}</span>` : '') +
    (st.paused ? '<span class="chip"><span class="dot warn"></span>Alerts paused</span>' : '');
  store.solUsd = st.solUsd || 0;
});

let saved = null;
try { saved = localStorage.getItem('mb_route'); } catch { /* private mode */ }
if (!location.hash && saved) location.hash = saved; else route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
