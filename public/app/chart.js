// Canvas candlestick chart: candles, volume, price axis, time axis, crosshair with OHLCV readout,
// last-price line, and optional level lines (entry, stop, target). No libraries; works offline.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fmtAxis(v) {
  if (!(v > 0)) return '0';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (v >= 1) return v.toFixed(v >= 100 ? 1 : 3);
  const z = Math.max(0, -Math.floor(Math.log10(v)) - 1);
  return v.toFixed(Math.min(z + 3, 12));
}
function niceStep(range, target) {
  const raw = range / target, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

export class CandleChart {
  constructor(container) {
    this.el = container;
    this.canvas = document.createElement('canvas');
    this.el.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.candles = []; this.levels = []; this.hover = null; this.unit = '$'; this.tfSec = 300;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
    const move = (x, y) => { this.hover = { x, y }; this.draw(); };
    this.canvas.addEventListener('mousemove', (e) => { const r = this.canvas.getBoundingClientRect(); move(e.clientX - r.left, e.clientY - r.top); });
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    this.canvas.addEventListener('touchstart', (e) => { const r = this.canvas.getBoundingClientRect(), t = e.touches[0]; move(t.clientX - r.left, t.clientY - r.top); }, { passive: true });
    this.canvas.addEventListener('touchmove', (e) => { const r = this.canvas.getBoundingClientRect(), t = e.touches[0]; move(t.clientX - r.left, t.clientY - r.top); }, { passive: true });
    this.canvas.addEventListener('touchend', () => { setTimeout(() => { this.hover = null; this.draw(); }, 1500); });
  }

  /** candles: [{t (sec), o, h, l, c, v}], scale: multiply prices (e.g. supply for market cap). */
  setData(candles, { scale = 1, unit = '$', tfSec = 300 } = {}) {
    this.candles = (candles ?? []).map((c) => ({ ...c, o: c.o * scale, h: c.h * scale, l: c.l * scale, c: c.c * scale }));
    this.unit = unit; this.tfSec = tfSec; this.scale = scale;
    this.draw();
  }
  /** levels: [{ price (unscaled), label, color }] */
  setLevels(levels) { this.levels = levels ?? []; this.draw(); }
  destroy() { this.ro.disconnect(); this.canvas.remove(); }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const C = { up: css('--up'), down: css('--down'), grid: css('--border'), text: css('--muted'), faint: css('--faint'), accent: css('--accent'), bg: css('--surface'), warn: css('--warn') };
    const cs = this.candles;
    if (!cs.length) return;
    const font = '11px ' + css('--mono');
    g.font = font;
    const axisW = Math.max(64, g.measureText(fmtAxis(Math.max(...cs.map((c) => c.h)))).width + 18);
    const padT = 10, timeH = 22, volH = Math.max(40, Math.round((H - padT - timeH) * 0.18));
    const plotW = W - axisW, priceH = H - padT - timeH - volH - 6;
    // visible candles: fit as many as space allows (min 5px per candle)
    const maxN = Math.max(10, Math.floor(plotW / 6));
    const vis = cs.slice(-maxN);
    const n = vis.length, slot = plotW / Math.max(n, 30), bodyW = Math.max(1, Math.min(12, slot * 0.7));
    const xOf = (i) => plotW - (n - i - 0.5) * slot;
    let lo = Math.min(...vis.map((c) => c.l)), hi = Math.max(...vis.map((c) => c.h));
    for (const L of this.levels) { const p = L.price * (this.scale ?? 1); if (p > 0 && p < hi * 3 && p > lo / 3) { lo = Math.min(lo, p); hi = Math.max(hi, p); } }
    if (hi === lo) { hi *= 1.01; lo *= 0.99; }
    const pad = (hi - lo) * 0.08; hi += pad; lo = Math.max(0, lo - pad);
    const yOf = (p) => padT + (1 - (p - lo) / (hi - lo)) * priceH;
    const vMax = Math.max(1e-9, ...vis.map((c) => c.v || 0));
    const vTop = padT + priceH + 6;

    // grid + price axis
    g.strokeStyle = C.grid; g.lineWidth = 1; g.fillStyle = C.text; g.textBaseline = 'middle';
    const step = niceStep(hi - lo, Math.max(3, Math.floor(priceH / 60)));
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const y = Math.round(yOf(p)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke();
      g.fillText(fmtAxis(p), plotW + 8, y);
    }
    // time axis
    g.textBaseline = 'top'; g.textAlign = 'center';
    const every = Math.max(1, Math.ceil(90 / slot));
    for (let i = n - 1; i >= 0; i -= every) {
      const d = new Date(vis[i].t * 1000);
      const label = this.tfSec >= 86400 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      g.fillText(label, xOf(i), H - timeH + 6);
    }
    g.textAlign = 'left';
    g.beginPath(); g.moveTo(plotW + 0.5, 0); g.lineTo(plotW + 0.5, H - timeH); g.stroke();

    // volume + candles
    for (let i = 0; i < n; i++) {
      const c = vis[i], x = xOf(i), up = c.c >= c.o;
      const col = up ? C.up : C.down;
      if (c.v > 0) { g.globalAlpha = 0.35; g.fillStyle = col; const vh = (c.v / vMax) * volH; g.fillRect(x - bodyW / 2, vTop + volH - vh, bodyW, vh); g.globalAlpha = 1; }
      g.strokeStyle = col; g.fillStyle = col;
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, yOf(c.h)); g.lineTo(Math.round(x) + 0.5, yOf(c.l)); g.stroke();
      const yo = yOf(c.o), yc = yOf(c.c);
      g.fillRect(x - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
    }

    // level lines (entry / stop / target / trail)
    const tag = (y, text, color) => {
      g.fillStyle = color; const w = g.measureText(text).width + 10;
      g.fillRect(plotW + 1, y - 9, Math.max(axisW - 2, w), 18);
      g.fillStyle = '#0b0d11'; g.textBaseline = 'middle'; g.fillText(text, plotW + 5, y);
    };
    for (const L of this.levels) {
      const p = L.price * (this.scale ?? 1);
      if (!(p > lo && p < hi)) continue;
      const y = Math.round(yOf(p)) + 0.5;
      g.strokeStyle = L.color; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = L.color; g.textBaseline = 'bottom'; g.fillText(L.label, 6, y - 2);
    }
    // last price line
    const last = vis[n - 1];
    const ly = Math.round(yOf(last.c)) + 0.5;
    g.strokeStyle = last.c >= last.o ? C.up : C.down; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(0, ly); g.lineTo(plotW, ly); g.stroke(); g.setLineDash([]);
    tag(ly, fmtAxis(last.c), last.c >= last.o ? C.up : C.down);

    // crosshair
    if (this.hover && this.hover.x < plotW) {
      const i = Math.max(0, Math.min(n - 1, Math.round(n - 0.5 - (plotW - this.hover.x) / slot)));
      const c = vis[i], x = Math.round(xOf(i)) + 0.5, y = Math.max(padT, Math.min(padT + priceH, this.hover.y));
      g.strokeStyle = C.faint; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - timeH); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(plotW, Math.round(y) + 0.5); g.stroke(); g.setLineDash([]);
      tag(y, fmtAxis(lo + (1 - (y - padT) / priceH) * (hi - lo)), C.text);
      const d = new Date(c.t * 1000);
      const chg = ((c.c / c.o - 1) * 100);
      const txt = `${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}  O ${fmtAxis(c.o)}  H ${fmtAxis(c.h)}  L ${fmtAxis(c.l)}  C ${fmtAxis(c.c)}  ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%  Vol $${fmtAxis(c.v || 0)}${c.buys != null ? `  ${c.buys}B/${c.sells}S` : ''}`;
      g.font = font; g.textBaseline = 'top';
      const tw = g.measureText(txt).width;
      g.fillStyle = C.bg; g.globalAlpha = 0.9; g.fillRect(4, 2, Math.min(tw + 10, plotW - 8), 18); g.globalAlpha = 1;
      g.fillStyle = chg >= 0 ? C.up : C.down; g.fillText(txt, 9, 5, plotW - 18);
    }
  }
}
