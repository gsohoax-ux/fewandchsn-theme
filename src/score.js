// Combine safety, narrative and momentum into one score + Telegram/dashboard text.

export function combine(safety, narrative, momentum) {
  let score = 0.35 * narrative.score + 0.35 * momentum.score + 0.30 * safety.score;
  if (safety.verdict === 'AVOID') score = Math.min(score, 30);
  else if (safety.verdict === 'CAUTION') score -= 5;
  score = Math.round(Math.max(0, Math.min(100, score)));
  const light = safety.verdict === 'AVOID' ? '🔴' : score >= 70 ? '🟢' : score >= 50 ? '🟡' : '⚪';
  return { score, light };
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ICON = { ok: '✅', warn: '⚠️', bad: '⛔', info: 'ℹ️' };

export function fmtAge(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function fmtMc(mcSol, solUsd) {
  if (!solUsd) return `${mcSol.toFixed(1)} SOL`;
  const usd = mcSol * solUsd;
  return usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : `$${(usd / 1e3).toFixed(1)}k`;
}

export function formatAlert(coin, r, stage, { solUsd, padreTemplate } = {}) {
  const { safety: s, narrative: n, momentum: m } = r;
  const links = coin.links(padreTemplate);
  const tag = stage === 'mid' ? 'MID-CURVE' : stage === 'manual' ? 'CHECK' : 'FRESH';
  const lines = [
    `${r.light} <b>$${esc(coin.symbol)}</b> · ${esc(coin.name)}   <b>${r.score}/100</b>  [${tag}]`,
    `<code>${coin.mint}</code>`,
    `MC ${fmtMc(coin.mcSol, solUsd)} · Curve ${coin.progress.toFixed(0)}% · Age ${fmtAge(coin.ageSec())} · ${m.holders} holders`,
    '',
    `🧠 <b>Narrative ${n.score}</b>${n.theme ? ` — ${esc(n.theme)}` : ''}${n.freshness && n.freshness !== 'unknown' ? ` (${esc(n.freshness.replace('_', ' '))})` : ''}`,
    n.summary ? `   ${esc(n.summary)}` : '',
    `📈 <b>Momentum ${m.score}</b> — curve ${m.progressPerMin >= 0 ? '+' : ''}${m.progressPerMin.toFixed(1)}%/min, buy/sell ${m.buySellRatio.toFixed(1)}x, ${m.uniqueBuyers2m} buyers in 2m${m.smartHolders.length ? `, 🧠 ${m.smartHolders.length} smart wallet(s)` : ''}`,
    `🛡 <b>Safety ${s.verdict}</b> (${s.score})`,
    ...s.flags.map((f) => `   ${ICON[f.level]} ${esc(f.text)}`),
    ...(n.redFlags ?? []).map((f) => `   ⚠️ ${esc(f)}`),
    '',
    [links.padre && `<a href="${links.padre}">Padre</a>`, `<a href="${links.pump}">pump.fun</a>`,
      `<a href="${links.dexscreener}">DexScreener</a>`].filter(Boolean).join(' · '),
    `<i>Not financial advice. Score is a filter, not a prediction.</i>`,
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

export function formatWarning(coin, text) {
  return `⚠️ <b>$${esc(coin.symbol)}</b> — ${esc(text)}\n<code>${coin.mint}</code>`;
}
