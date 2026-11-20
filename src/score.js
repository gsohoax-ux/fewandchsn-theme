// Combine safety, narrative and momentum into one score + Telegram/dashboard text.

export function combine(safety, narrative, momentum, learnedPct = null, blend = 0.5) {
  let score = 0.35 * narrative.score + 0.35 * momentum.score + 0.30 * safety.score;
  // Once the bot has learned (and proven) what works, mix in its learned ranking
  if (learnedPct != null) score = (1 - blend) * score + blend * learnedPct;
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

const stageTag = (stage) => ({ mid: 'MID-CURVE', manual: 'CHECK', x: 'X NARRATIVE' }[stage] ?? 'FRESH');

function confLine(r) {
  const c = r.confidence;
  return c ? `🎯 Confidence ${c.label} ${c.meter} (${c.value})${c.track ? ` · similar past alerts hit 1.5x ${c.track.hitPct}% of the time` : ''}` : '';
}

function learnedLine(r) {
  const l = r.learned;
  if (!l?.validated) return '';
  return `📊 Learned: ${Math.round(l.p * 100)}% chance of ${l.target}x (average coin ${Math.round(l.baseRate * 100)}%) · from ${l.n} past coins`;
}

function xLines(r) {
  const x = r.x;
  if (!x) return [];
  return [
    `🐦 From X: @${x.author} — "${x.text.replace(/\s+/g, ' ').slice(0, 110)}${x.text.length > 110 ? '…' : ''}"`,
    (x.origin === 'radar' ? `   📡 tweet radar: ${x.radarCoins} coins launched on this post · coin ${x.how}`
      : `   ❤️ ${x.likes.toLocaleString()} · viral ${x.viral} · meme ${x.meme} · coin ${x.how}`) +
      (x.coinsOnPost > 1 ? ` · #${x.rank} of ${x.coinsOnPost} coins on this post` : ' · only coin on this post'),
  ];
}

export function formatAlert(coin, r, stage, { solUsd, padreTemplate } = {}) {
  const { safety: s, narrative: n, momentum: m } = r;
  const links = coin.links(padreTemplate);
  const tag = stageTag(stage);
  const lines = [
    `${r.light} <b>$${esc(coin.symbol)}</b> · ${esc(coin.name)}   <b>${r.score}/100</b>  [${tag}]`,
    `<code>${coin.mint}</code>`,
    `MC ${fmtMc(coin.mcSol, solUsd)} · Curve ${coin.progress.toFixed(0)}% · Age ${fmtAge(coin.ageSec())} · ${m.holders} holders`,
    esc(confLine(r)),
    esc(learnedLine(r)),
    ...xLines(r).map(esc),
    ...(r.x ? [`<a href="${r.x.url}">Open the X post</a>`] : []),
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

/** Plain-text version for ntfy push notifications. */
export function alertNotification(coin, r, stage, { solUsd, padreTemplate, dashboardUrl } = {}) {
  const { safety: s, narrative: n, momentum: m } = r;
  const links = coin.links(padreTemplate);
  const tag = stageTag(stage);
  const message = [
    `${coin.name} · MC ${fmtMc(coin.mcSol, solUsd)} · Curve ${coin.progress.toFixed(0)}% · ${fmtAge(coin.ageSec())} · ${m.holders} holders`,
    confLine(r),
    learnedLine(r),
    ...xLines(r),
    `🧠 Narrative ${n.score}${n.theme ? ` — ${n.theme}` : ''}${n.summary ? `: ${n.summary}` : ''}`,
    `📈 Momentum ${m.score} — curve ${m.progressPerMin >= 0 ? '+' : ''}${m.progressPerMin.toFixed(1)}%/min, buy/sell ${m.buySellRatio.toFixed(1)}x, ${m.uniqueBuyers2m} buyers in 2m`,
    `🛡 Safety ${s.verdict} (${s.score})`,
    ...s.flags.map((f) => `${ICON[f.level]} ${f.text}`),
    ...(n.redFlags ?? []).map((f) => `⚠️ ${f}`),
    '',
    `CA: ${coin.mint}`,
  ].filter((l) => l !== null && l !== undefined).join('\n');
  const actions = [
    links.padre && { label: 'Padre', url: links.padre },
    r.x ? { label: 'X post', url: r.x.url } : { label: 'pump.fun', url: links.pump },
    dashboardUrl && { label: 'Dashboard', url: dashboardUrl },
  ].filter(Boolean);
  return {
    title: `${stage === 'x' ? '🐦' : r.light} $${coin.symbol} ${r.score}/100 · ${tag}${r.confidence ? ` · ${r.confidence.label} confidence` : ''}`,
    message, priority: r.score >= 75 ? 5 : 4, click: links.padre || links.pump, actions,
  };
}

export function formatWarning(coin, text) {
  return `⚠️ <b>$${esc(coin.symbol)}</b> — ${esc(text)}\n<code>${coin.mint}</code>`;
}
