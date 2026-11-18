// Confidence meter: how much should you trust this score?
//
// It is NOT the chance of profit. It measures:
//   - data quality: was the bundle check on-chain or estimated? AI narrative or rules?
//     enough buyers/trades to judge? has the bot learned the current meta yet?
//   - agreement: do safety, narrative and momentum point the same way?
//   - track record: once enough alerts exist, how did past alerts with a similar score do?

const clamp = (x) => Math.max(0, Math.min(100, x));

export function computeConfidence(coin, r, { runnersSeen = 0, history = null } = {}) {
  const reasons = [];
  let data = 0;
  const add = (pts, ok, good, bad) => { if (ok) { data += pts; if (good) reasons.push(`+ ${good}`); } else if (bad) reasons.push(`- ${bad}`); };

  add(25, r.safety.source === 'chain', 'on-chain bundle check', 'bundle check is an estimate (no Helius)');
  add(15, r.narrative.source === 'ai', 'AI read the narrative', 'narrative scored by simple rules');
  const buyers = coin.buyers.size;
  add(buyers >= 30 ? 20 : buyers >= 15 ? 10 : 0, buyers >= 15, `${buyers} buyers so far`, `only ${buyers} buyers so far`);
  add(10, coin.ageSec() >= 120, null, 'coin is under 2 minutes old');
  add(10, runnersSeen >= 5, null, 'bot is still learning the current meta');
  add(10, Boolean(coin.meta && (coin.meta.description || coin.meta.twitter)), null, 'no coin description/socials loaded');
  add(10, Boolean(r.x?.viral >= 50), 'linked to a verified viral X post', null);

  // Agreement between the three parts (big spread = mixed signals)
  const parts = [r.safety.score, r.narrative.score, r.momentum.score];
  const mean = parts.reduce((a, b) => a + b, 0) / 3;
  const spread = Math.sqrt(parts.reduce((s, p) => s + (p - mean) ** 2, 0) / 3);
  const agreement = clamp(100 - spread * 2.2);
  if (agreement < 50) reasons.push('- mixed signals between safety, narrative and momentum');

  let value = clamp(Math.round(0.65 * clamp(data) + 0.35 * agreement));

  // Track record overrides guesswork once there is enough of it
  let track = null;
  if (history && history.n >= 10) {
    track = { n: history.n, hitPct: Math.round((history.hits / history.n) * 100) };
    reasons.push(`past alerts scored ${r.score - 5}-${r.score + 5}: ${history.hits}/${history.n} reached 1.5x`);
    value = clamp(Math.round(0.6 * value + 0.4 * Math.min(100, track.hitPct * 2)));
  }

  const label = value >= 70 ? 'High' : value >= 45 ? 'Medium' : 'Low';
  return { value, label, meter: meter(value), reasons, track };
}

export function meter(value, slots = 5) {
  const full = Math.round((value / 100) * slots);
  return '▰'.repeat(full) + '▱'.repeat(slots - full);
}
