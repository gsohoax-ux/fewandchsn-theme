// Phone notifications. ntfy (https://ntfy.sh) is the default: install the ntfy app,
// subscribe to your topic, done. Telegram is still supported as an optional extra.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { formatAlert, formatWarning, alertNotification } from './score.js';

/** Topic from config, or a random one created on first run and saved next to the database. */
export function resolveNtfyTopic(cfg, log = console) {
  if (cfg.ntfyTopic) return cfg.ntfyTopic;
  if (cfg.ntfyDisabled) return '';
  const file = `${dirname(cfg.dbPath)}/ntfy-topic.txt`;
  try { return readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  // ntfy.sh topics are public to anyone who knows the name, so make it unguessable.
  const topic = `memecoin-bot-${randomBytes(9).toString('base64url')}`;
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, topic + '\n'); }
  catch (e) { log.warn(`could not save ntfy topic: ${e.message}`); }
  return topic;
}

export class Ntfy {
  constructor({ server = 'https://ntfy.sh', topic, token = '', log = console }) {
    this.server = server.replace(/\/+$/, ''); this.topic = topic; this.token = token; this.log = log;
    this.enabled = Boolean(topic);
  }

  /** Build the JSON body ntfy expects (exported for tests). */
  payload({ title, message, priority = 3, click, actions = [], tags = [] }) {
    const p = { topic: this.topic, title, message: message.slice(0, 3900), priority };
    if (click) p.click = click;
    if (tags.length) p.tags = tags;
    if (actions.length) p.actions = actions.slice(0, 3).map((a) => ({ action: 'view', label: a.label, url: a.url }));
    return p;
  }

  async send(n) {
    if (!this.enabled) return;
    try {
      const res = await fetch(this.server, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(this.payload(n)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.warn(`ntfy: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    } catch (e) { this.log.warn(`ntfy: ${e.message}`); }
  }
}

/** Sends every alert to all enabled channels. */
export class Notifier {
  constructor({ ntfy, telegram, cfg, getSolUsd = () => 0 }) {
    Object.assign(this, { ntfy, telegram, cfg, getSolUsd });
    this.prefix = cfg.demo ? '[DEMO] ' : '';
  }

  get channels() {
    return [this.ntfy?.enabled && 'ntfy', this.telegram?.enabled && this.cfg.telegramChatId && 'telegram'].filter(Boolean);
  }

  async alert(coin, result, stage) {
    const opts = { solUsd: this.getSolUsd(), padreTemplate: this.cfg.padreUrlTemplate, dashboardUrl: this.cfg.dashboardUrl };
    const n = alertNotification(coin, result, stage, opts);
    await Promise.all([
      this.ntfy?.send({ ...n, title: this.prefix + n.title }),
      this.telegram?.send(formatAlert(coin, result, stage, opts)),
    ]);
  }

  async warn(coin, text) {
    const links = coin.links(this.cfg.padreUrlTemplate);
    await Promise.all([
      this.ntfy?.send({ title: `${this.prefix}⚠️ $${coin.symbol}: ${text}`, message: `CA: ${coin.mint}`,
        priority: 4, click: links.padre || links.pump }),
      this.telegram?.send(formatWarning(coin, text)),
    ]);
  }

  /** A new X post that could become a meme coin. */
  async post(p) {
    const title = `${this.prefix}📣 Meme-able post by @${p.author} (meme ${p.meme})`;
    const message = [p.text.slice(0, 280), '',
      `❤️ ${p.metrics.likes.toLocaleString()} · 🔁 ${p.metrics.retweets.toLocaleString()}`,
      p.idea ? `Likely coin: ${p.idea}` : '',
      'Watching Pump.fun for coins about this - you get an alert if one is rising and passes safety.',
    ].filter(Boolean).join('\n');
    await Promise.all([
      this.ntfy?.send({ title, message, priority: 3, click: p.url, actions: [{ label: 'Open post', url: p.url }] }),
      this.telegram?.send(`<b>${title.replace(/[<>&]/g, '')}</b>\n${message.replace(/[<>&]/g, '')}\n${p.url}`),
    ]);
  }

  async info(text) {
    await Promise.all([
      this.ntfy?.send({ title: this.prefix + 'Memecoin bot', message: text, priority: 2 }),
      this.telegram?.send(text),
    ]);
  }
}
