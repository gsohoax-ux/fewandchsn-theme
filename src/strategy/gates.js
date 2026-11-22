// Safety gates and the setup confidence score for the autonomous Setuh trader (pure functions, tested).
//
// Order of decisions: critical safety gates FIRST. A failed gate rejects the trade no matter how high the
// confidence score is. Only coins that pass every gate are scored, and only scores at or above the minimum
// confidence can be entered. Missing data never counts as a pass.

/**
 * Critical safety gates from the full Coin Check report (deepcheck), the bot's live read, and liquidity.
 * report: DeepChecker result or null. live: engine coin result or null. slipPct: estimated entry slippage.
 * Returns { ok, pending, failed: [{key, text}], passed: [...], unknown: [...] }.
 */
export function safetyGates({ report = null, live = null, slipPct = null, settings, deepPending = false }) {
  const failed = [], passed = [], unknown = [];
  const add = (list, key, text) => list.push({ key, text });
  const group = (g) => (report?.checks ?? []).filter((c) => c.group === g);
  const bad = (g) => group(g).filter((c) => c.level === 'bad');

  if (!report) {
    if (deepPending) add(unknown, 'deep', 'Full safety check still running');
    else if (settings.requireDeepCheck) add(unknown, 'deep', 'Full safety check has not run yet');
  } else {
    if (report.verdict === 'AVOID') add(failed, 'verdict', `Coin Check verdict AVOID (${report.bad} red flag${report.bad === 1 ? '' : 's'}): ${bad('Launch')[0]?.text ?? bad('Holders')[0]?.text ?? report.checks.find((c) => c.level === 'bad')?.text ?? ''}`);
    else add(passed, 'verdict', `Coin Check verdict ${report.verdict} (${report.score}/100)`);
    const auth = bad('Authorities');
    if (auth.length) add(failed, 'authority', auth.map((c) => c.text).join('; '));
    else if (group('Authorities').some((c) => c.level === 'ok')) add(passed, 'authority', 'Mint and freeze authority revoked');
    else add(unknown, 'authority', 'Mint / freeze authority not verified');
    const hp = bad('Honeypot & tax');
    if (hp.length) add(failed, 'honeypot', hp.map((c) => c.text).join('; '));
    else if (group('Honeypot & tax').length) add(passed, 'honeypot', 'No honeypot or transfer-tax red flags');
    if (report.verdict === 'UNVERIFIED') {
      if (settings.requireVerifiedSafety) add(failed, 'verified', 'Key on-chain safety checks could not run (UNVERIFIED); verified safety is required');
      else add(unknown, 'verified', 'Key on-chain safety checks could not run (UNVERIFIED)');
    }
  }
  if (live?.safety?.verdict === 'AVOID') add(failed, 'live', `Bot's live safety read is AVOID: ${live.safety.flags?.find((f) => f.level === 'bad')?.text ?? ''}`);
  if (slipPct == null) add(unknown, 'slippage', 'Slippage could not be estimated (liquidity unknown)');
  else if (slipPct > settings.maxSlippagePct) add(failed, 'slippage', `Estimated slippage ${slipPct.toFixed(1)}% is above the ${settings.maxSlippagePct}% limit`);
  else add(passed, 'slippage', `Estimated slippage ${slipPct.toFixed(1)}% for the position size`);

  const blocking = unknown.filter((u) => u.key === 'deep' || u.key === 'slippage');
  return { ok: !failed.length && !blocking.length, pending: !failed.length && blocking.length > 0, failed, passed, unknown };
}

/**
 * Confidence 0–100 that the setup is real and tradable now (not a probability of profit).
 * Every part is shown with its points so the score can be checked.
 */
export function setupConfidence({ ev, report = null, live = null, slipPct = null, maxSlippagePct = 8, streaming = false, candles = 0, setupStats = null }) {
  const parts = [];
  const add = (label, points, max, detail) => parts.push({ label, points: Math.round(points * 10) / 10, max, detail });
  const met = ev.conditions.filter((c) => c.ok === true).length;
  add('Setup rules met', (met / Math.max(1, ev.conditions.length)) * 25, 25, `${met} of ${ev.conditions.length}`);
  if (report && report.verdict !== 'UNVERIFIED') add('Safety (full Coin Check)', (report.score / 100) * 20 - (report.verdict === 'CAUTION' ? 4 : 0), 20, `${report.verdict} ${report.score}/100`);
  else if (report) add('Safety (full Coin Check)', (report.score / 100) * 8, 20, 'UNVERIFIED: key on-chain checks missing');
  else if (live?.safety) add('Safety (live estimate only)', ((Number(live.safety.score) || 0) / 100) * 8, 20, `${live.safety.verdict} ${live.safety.score ?? '?'} (estimate)`);
  else add('Safety', 0, 20, 'no safety data');
  add('Data quality', (streaming ? 8 : 3) + (candles >= 8 ? 4 : candles >= 4 ? 2 : 0) + (report && report.verdict !== 'UNVERIFIED' ? 3 : 0), 15,
    `${streaming ? 'live trade stream' : 'polled prices'} · ${candles} candles${report && report.verdict !== 'UNVERIFIED' ? ' · on-chain verified' : ''}`);
  add('Liquidity / slippage', slipPct == null ? 0 : Math.max(0, 1 - slipPct / maxSlippagePct) * 15, 15, slipPct == null ? 'unknown' : `${slipPct.toFixed(1)}% est. slippage`);
  add('Reward vs risk', ev.rewardRisk ? Math.min(1, ev.rewardRisk / 2) * 10 : 0, 10, ev.rewardRisk ? `${ev.rewardRisk.toFixed(1)} : 1` : 'unknown');
  const n = live?.narrative?.score, m = live?.momentum?.score;
  add('Narrative & momentum', (n != null ? (n / 100) * 6 : 0) + (m != null ? (m / 100) * 4 : 0), 10, n != null ? `narrative ${n}${m != null ? ` · momentum ${m}` : ''}` : 'not scored (counts as 0)');
  if (setupStats && setupStats.trades >= 20) {
    const adj = setupStats.winRate >= 55 ? 5 : setupStats.winRate <= 35 ? -5 : 0;
    add('Setup track record', adj, 5, `${setupStats.winRate}% wins over ${setupStats.trades} paper trades`);
  } else add('Setup track record', 0, 5, `not used until 20 trades (${setupStats?.trades ?? 0} so far)`);
  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((s, p) => s + p.points, 0))));
  return { score, parts };
}

export const confidenceBand = (s) => (s == null ? 'n/a' : s >= 80 ? '80+' : s >= 70 ? '70–79' : s >= 60 ? '60–69' : s >= 50 ? '50–59' : 'under 50');
