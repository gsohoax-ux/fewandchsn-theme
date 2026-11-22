// Shared helpers: DOM, formatting, API calls, icons, toasts. No framework.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '');

/** Shared state other modules read (latest /api/state, SOL price). */
export const store = { state: null, solUsd: 0, listeners: new Set() };
export function onState(fn) { store.listeners.add(fn); return () => store.listeners.delete(fn); }

// ------------------------------------------------------------------ formatting
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const fmt = {
  usd(x, d) {
    if (!isNum(x)) return '—';
    const a = Math.abs(x), s = x < 0 ? '−' : '';
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}K`;
    return `${s}$${a.toFixed(d ?? (a < 100 ? 2 : 0))}`;
  },
  signed(x, d = 2) { return !isNum(x) ? '—' : `${x >= 0 ? '+' : '−'}${fmt.usd(Math.abs(x), d)}`; },
  pct(x, d) { return !isNum(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d ?? (Math.abs(x) < 10 ? 2 : 1))}%`; },
  pctPlain(x, d = 0) { return !isNum(x) ? '—' : `${x.toFixed(d)}%`; },
  price(p) {
    if (!isNum(p) || p <= 0) return '—';
    if (p >= 1) return `$${p.toFixed(4)}`;
    const z = Math.max(0, -Math.floor(Math.log10(p)) - 1);
    return `$${p.toFixed(Math.min(z + 4, 14))}`;
  },
  num(x, d = 0) { return !isNum(x) ? '—' : x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }); },
  tokens(x) { return !isNum(x) ? '—' : x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : x.toFixed(2); },
  age(sec) {
    if (!isNum(sec)) return '—';
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  },
  ago(ts) { return ts ? `${fmt.age((Date.now() - ts) / 1000)} ago` : '—'; },
  time(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; },
  dateTime(ts) { return ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; },
  /** Market cap in SOL → $ when the SOL price is known. */
  mcSol(sol) { return !isNum(sol) ? '—' : store.solUsd ? fmt.usd(sol * store.solUsd) : `${sol.toFixed(1)} SOL`; },
};
export const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'muted');
export const scoreCls = (score, verdict) => (verdict === 'AVOID' ? 's-r' : score >= 70 ? 's-g' : score >= 50 ? 's-y' : 's-n');
export const LABEL_TAG = { 'BUY ZONE': 'solid-up', 'LOW RISK': 'up', WATCH: 'warn', 'DO NOT BUY': 'solid-down' };

// ------------------------------------------------------------------ api
export async function api(path, body) {
  const opts = body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  if (r.status === 401) { location.reload(); throw new Error('Login required'); }
  let j = null;
  try { j = await r.json(); } catch { throw new Error(`Server returned HTTP ${r.status}`); }
  if (!r.ok || j?.error) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

/** Repeating loader that pauses while the page is hidden and never overlaps itself. */
export function poller(fn, everyMs) {
  let timer = null, running = false, active = false;
  const run = async () => {
    if (running || document.hidden) return;
    running = true;
    try { await fn(); } catch (e) { console.warn(e); } finally { running = false; }
  };
  document.addEventListener('visibilitychange', () => { if (active && !document.hidden) run(); });
  return {
    start() { if (active) return; active = true; run(); timer = setInterval(run, everyMs); },
    stop() { active = false; clearInterval(timer); },
    now: run,
    get active() { return active; },
  };
}

// ------------------------------------------------------------------ ui bits
export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 4000);
}

export function spark(vals, w = 64, h = 18) {
  if (!vals || vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`).join(' ');
  const up = vals.at(-1) >= vals[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? 'var(--up)' : 'var(--down)'}" stroke-width="1.4"/></svg>`;
}

export const kpi = (label, value, sub = '', valueCls = '') => `<div class="kpi"><small>${esc(label)}</small><b class="${valueCls}">${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
export const card = (title, body, meta = '', { id = '', tight = false, cls: c = '' } = {}) =>
  `<div class="card ${c}" ${id ? `id="${id}"` : ''}><header><h2>${title}</h2>${meta ? `<div class="meta">${meta}</div>` : ''}</header><div class="body ${tight ? 'tight' : ''}">${body}</div></div>`;
export const condList = (conds) => `<ul class="cond">${conds.map((c) => `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'no' : 'na'}"><span class="ic">${c.ok === true ? '✓' : c.ok === false ? '✕' : '?'}</span><span>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>`;

export const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  strategy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/></svg>',
  trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 4v16M17 4v16"/><rect x="4.5" y="7" width="5" height="8" rx="1"/><rect x="14.5" y="9" width="5" height="6" rx="1"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="3"/><path d="M3 19c0-3 2.2-5 5-5s5 2 5 5"/><path d="M15 7h6M18 4v6"/><path d="M15 15l3 3 3-3M18 18v-6" opacity=".9"/></svg>',
};
