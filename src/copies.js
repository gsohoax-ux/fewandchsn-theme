// Quick-deploy tools and copycat ("vamp") detection.
//
// Tools like J7 let people launch a Pump.fun coin seconds after a tweet, often copying ("vamping")
// another coin's name, image and links. Many such coins say "Deployed using j7tracker.io".
// We tag them so paper trading and self-learning can show whether they do better or worse.

const DEFAULT_TOOL_PATTERNS = [
  ['J7', /j7tracker/i],
  ['quick deploy', /\b(deployed|launched|created)\s+(using|via|with|on)\s+(https?:\/\/)?[a-z0-9-]+\.[a-z]{2,}/i],
];

/** Which deploy tool (if any) a coin's metadata mentions. */
export function detectDeployTool(meta, extraPatterns = []) {
  if (!meta) return null;
  const text = [meta.description, meta.website, meta.twitter, meta.telegram].filter(Boolean).join(' ');
  for (const p of extraPatterns) if (p && text.toLowerCase().includes(p.toLowerCase())) return p;
  for (const [name, re] of DEFAULT_TOOL_PATTERNS) if (re.test(text)) return name;
  return null;
}

/** A stable fingerprint of a coin's image: the IPFS content id when there is one. */
export function imageKey(url) {
  if (!url) return null;
  const cid = String(url).match(/\/ipfs\/([A-Za-z0-9]{20,})/)?.[1] ?? String(url).match(/^(?:ipfs:\/\/)([A-Za-z0-9]{20,})/)?.[1];
  return cid ?? String(url).trim().toLowerCase();
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Remembers recent coins so a later coin with the same image, or the same name and ticker, is spotted as a copy. */
export class CopyIndex {
  constructor({ windowMs = 24 * 3600_000 } = {}) { this.windowMs = windowMs; this.byImage = new Map(); this.byName = new Map(); }

  #fresh(e, now) { return e && now - e.at < this.windowMs; }

  /** The earlier coin this one copies, or null. Call before add(). */
  originalOf(coin, now = Date.now()) {
    const img = imageKey(coin.meta?.image);
    const a = img && this.byImage.get(img);
    if (this.#fresh(a, now) && a.mint !== coin.mint) return { ...a, how: 'same image' };
    const nk = `${norm(coin.name)}|${norm(coin.symbol)}`;
    const b = this.byName.get(nk);
    if (norm(coin.name).length >= 3 && this.#fresh(b, now) && b.mint !== coin.mint) return { ...b, how: 'same name and ticker' };
    return null;
  }

  add(coin, now = Date.now()) {
    const e = { mint: coin.mint, symbol: coin.symbol, at: now };
    const img = imageKey(coin.meta?.image);
    if (img && !this.#fresh(this.byImage.get(img), now)) this.byImage.set(img, e);
    const nk = `${norm(coin.name)}|${norm(coin.symbol)}`;
    if (!this.#fresh(this.byName.get(nk), now)) this.byName.set(nk, e);
    if (this.byImage.size + this.byName.size > 100_000) this.prune(now);
  }

  prune(now = Date.now()) {
    for (const m of [this.byImage, this.byName]) for (const [k, e] of m) if (!this.#fresh(e, now)) m.delete(k);
  }
}
