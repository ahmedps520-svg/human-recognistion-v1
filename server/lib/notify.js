// Phone notifications: ntfy (free, no account: install the ntfy app and pick a
// topic) or a Telegram bot. Mock mode just records what would be sent.
import { HttpError } from './http.js';

export class NotifyService {
  constructor(cfg = {}, { fetchImpl = globalThis.fetch, mock = false } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.adapter = mock ? 'mock' : cfg.adapter || 'none';
    this.sent = [];
  }

  get enabled() {
    if (this.adapter === 'mock') return true;
    if (this.adapter === 'ntfy') return !!this.cfg.ntfy?.topic;
    if (this.adapter === 'telegram') return !!(this.cfg.telegram?.botToken && this.cfg.telegram?.chatId);
    return false;
  }

  async send(title, message, { priority = 'default', tags = [] } = {}) {
    if (!this.enabled) throw new HttpError(400, 'No notification adapter configured (server/config.json → notify.adapter: ntfy or telegram)');
    const record = { at: new Date().toISOString(), title, message, priority };
    if (this.adapter === 'mock') {
      this.sent.push(record);
      return { ok: true, adapter: 'mock', ...record };
    }
    if (this.adapter === 'ntfy') {
      const { server = 'https://ntfy.sh', topic, token } = this.cfg.ntfy || {};
      if (!topic) throw new HttpError(400, 'ntfy topic is not configured');
      const headers = { Title: title, Priority: priority, 'Content-Type': 'text/plain; charset=utf-8' };
      if (tags.length) headers.Tags = tags.join(',');
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await this.fetch(`${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: message });
      if (!res.ok) throw new HttpError(502, `ntfy responded ${res.status}`);
      return { ok: true, adapter: 'ntfy', ...record };
    }
    if (this.adapter === 'telegram') {
      const { botToken, chatId } = this.cfg.telegram || {};
      if (!botToken || !chatId) throw new HttpError(400, 'Telegram botToken and chatId are required');
      const res = await this.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `${title}\n${message}` }),
      });
      if (!res.ok) throw new HttpError(502, `Telegram responded ${res.status}`);
      return { ok: true, adapter: 'telegram', ...record };
    }
    throw new HttpError(400, `Unknown notify adapter ${this.adapter}`);
  }
}
