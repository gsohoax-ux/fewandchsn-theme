// Paper Trading › Automatic: the original paper trader that follows every alert (System A). Unchanged rules.
import { onState, store, card, api } from './core.js';
import { autoPaper } from './dashboard.js';

export const SUBS = [['auto', 'Automatic']];
let root;
export function mount(el) { root = el; onState(() => { if (!root.hidden) render(); }); }
export function show() { render(); }
export function hide() {}
function render() {
  const s = store.state;
  if (!s) { root.innerHTML = '<div class="empty">Loading…</div>'; api('/api/state').catch(() => {}); return; }
  root.innerHTML = `<div class="section-title"><h2>Automatic paper trading</h2><p>Follows every alert with its own daily budget and rules. Separate from the Setuh trader, manual and copy trading.</p></div>
    ${card('Automatic paper trading <span class="faint" style="text-transform:none;letter-spacing:0">· System A</span>', autoPaper(s), 'follows every alert')}`;
}
