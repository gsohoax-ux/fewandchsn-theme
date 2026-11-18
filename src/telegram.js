// Telegram bot: sends alerts and answers a few commands from YOUR chat only.

export class Telegram {
  constructor({ token, chatId, log = console }) {
    this.token = token; this.chatId = chatId; this.log = log;
    this.enabled = Boolean(token);
    this.offset = 0;
    this.handlers = new Map();
    this.queue = Promise.resolve();
  }

  on(command, fn) { this.handlers.set(command, fn); }

  async #call(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 10_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? res.status}`);
    return j.result;
  }

  /** Messages are sent one at a time to respect Telegram rate limits. */
  send(html, chatId = this.chatId) {
    if (!this.enabled || !chatId) return Promise.resolve();
    this.queue = this.queue.then(() => this.#call('sendMessage', {
      chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })).then(() => new Promise((r) => setTimeout(r, 1100)))
      .catch((e) => this.log.warn(e.message));
    return this.queue;
  }

  async poll() {
    if (!this.enabled) return;
    for (;;) {
      try {
        const updates = await this.#call('getUpdates', { offset: this.offset, timeout: 30 });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          const chat = String(msg.chat.id);
          const [cmd, ...args] = msg.text.trim().split(/\s+/);
          const name = cmd.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
          if (name === 'chatid' || name === 'start') {
            this.log.info(`Telegram chat id: ${chat}  -> put TELEGRAM_CHAT_ID=${chat} in your .env`);
            await this.send(`Your chat id is <code>${chat}</code>. Put it in TELEGRAM_CHAT_ID in your .env file and restart.`, chat);
            continue;
          }
          if (chat !== String(this.chatId)) continue; // ignore strangers
          const h = this.handlers.get(name);
          if (h) await this.send(await h(args), chat);
        }
      } catch (e) {
        this.log.warn(e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
