// The smart door switch: a relay (Shelly, Tasmota), a Home Assistant switch or
// lock, or plain webhooks. Normalised state: { on } where "on" means the
// switch is energised (door open / unlocked, depending on your wiring).

import { HttpError } from './http.js';

async function getJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `${new URL(url).host} responded ${res.status}: ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DoorService {
  constructor(cfg, { fetchImpl = globalThis.fetch, mock = false } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.adapter = mock ? 'mock' : cfg.adapter || 'none';
    this.sim = { on: false };
    this.lastAction = null;
  }

  get enabled() {
    return this.adapter !== 'none';
  }

  async state() {
    let s;
    switch (this.adapter) {
      case 'mock':
        s = { ...this.sim };
        break;
      case 'shelly':
        s = await this._shellyState();
        break;
      case 'tasmota':
        s = await this._tasmotaState();
        break;
      case 'homeassistant':
        s = await this._haState();
        break;
      case 'webhook':
        s = await this._webhookState();
        break;
      default:
        return { adapter: 'none', enabled: false, on: null };
    }
    return { adapter: this.adapter, enabled: true, pulseMs: this.cfg.pulseMs || 0, lastAction: this.lastAction, ...s };
  }

  /** action: on | off | toggle | open | close | lock | unlock | pulse */
  async set(action) {
    const a = String(action || '').toLowerCase();
    const pulse = this.cfg.pulseMs > 0;
    let want;
    if (a === 'on' || a === 'unlock') want = true;
    else if (a === 'off' || a === 'lock') want = false;
    else if (a === 'open') want = pulse ? 'pulse' : true;
    else if (a === 'close') want = false;
    else if (a === 'pulse') want = 'pulse';
    else if (a === 'toggle') want = 'toggle';
    else throw new HttpError(400, 'action must be one of on, off, toggle, open, close, lock, unlock, pulse');
    if (!this.enabled) throw new HttpError(400, 'No door adapter configured (server/config.json → door.adapter)');
    if (want === 'pulse') {
      await this._apply(true);
      await sleep(this.cfg.pulseMs || 800);
      await this._apply(false);
    } else if (want === 'toggle') {
      const cur = await this.state();
      await this._apply(!cur.on);
    } else {
      await this._apply(want);
    }
    this.lastAction = { action: a, at: new Date().toISOString() };
    return this.state();
  }

  async _apply(on) {
    switch (this.adapter) {
      case 'mock':
        this.sim.on = on;
        return;
      case 'shelly':
        return this._shellySet(on);
      case 'tasmota':
        return this._tasmotaSet(on);
      case 'homeassistant':
        return this._haSet(on);
      case 'webhook':
        return this._webhookSet(on);
      default:
        throw new HttpError(400, 'No door adapter configured');
    }
  }

  // ---------------- Shelly ----------------
  _shelly() {
    const { host, gen = 1, relay = 0 } = this.cfg.shelly;
    if (!host) throw new HttpError(400, 'Shelly host is not configured');
    return { base: `http://${host}`, gen: Number(gen), relay: Number(relay) };
  }

  async _shellyState() {
    const s = this._shelly();
    if (s.gen >= 2) {
      const j = await getJson(this.fetch, `${s.base}/rpc/Switch.GetStatus?id=${s.relay}`);
      return { on: !!j?.output };
    }
    const j = await getJson(this.fetch, `${s.base}/status`);
    return { on: !!j?.relays?.[s.relay]?.ison };
  }

  async _shellySet(on) {
    const s = this._shelly();
    if (s.gen >= 2) await getJson(this.fetch, `${s.base}/rpc/Switch.Set?id=${s.relay}&on=${on ? 'true' : 'false'}`);
    else await getJson(this.fetch, `${s.base}/relay/${s.relay}?turn=${on ? 'on' : 'off'}`);
  }

  // ---------------- Tasmota ----------------
  _tasmota() {
    const { host, index = 1 } = this.cfg.tasmota;
    if (!host) throw new HttpError(400, 'Tasmota host is not configured');
    return { base: `http://${host}`, index: Number(index) };
  }

  async _tasmotaState() {
    const t = this._tasmota();
    const j = await getJson(this.fetch, `${t.base}/cm?cmnd=Power${t.index}`);
    const v = j?.[`POWER${t.index}`] ?? j?.POWER;
    return { on: String(v).toUpperCase() === 'ON' };
  }

  async _tasmotaSet(on) {
    const t = this._tasmota();
    await getJson(this.fetch, `${t.base}/cm?cmnd=Power${t.index}%20${on ? 'ON' : 'OFF'}`);
  }

  // ---------------- Home Assistant ----------------
  _ha() {
    const { url, token, entityId } = this.cfg.homeassistant;
    if (!url || !token || !entityId) throw new HttpError(400, 'Home Assistant url, token and entityId are required');
    return { base: url.replace(/\/$/, ''), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, entityId, domain: entityId.split('.')[0] };
  }

  async _haState() {
    const ha = this._ha();
    const s = await getJson(this.fetch, `${ha.base}/api/states/${ha.entityId}`, { headers: ha.headers });
    if (ha.domain === 'lock') return { on: s?.state === 'unlocked', locked: s?.state === 'locked' };
    if (ha.domain === 'cover') return { on: s?.state === 'open' };
    return { on: s?.state === 'on' };
  }

  async _haSet(on) {
    const ha = this._ha();
    const service = ha.domain === 'lock' ? (on ? 'unlock' : 'lock') : ha.domain === 'cover' ? (on ? 'open_cover' : 'close_cover') : on ? 'turn_on' : 'turn_off';
    await getJson(this.fetch, `${ha.base}/api/services/${ha.domain}/${service}`, { method: 'POST', headers: ha.headers, body: JSON.stringify({ entity_id: ha.entityId }) });
  }

  // ---------------- webhooks ----------------
  async _webhookState() {
    const w = this.cfg.webhook;
    if (!w.status) return { on: this.sim.on, note: 'no status URL configured; showing last commanded state' };
    const j = await getJson(this.fetch, w.status);
    return { on: !!(j?.on ?? j?.state === 'on') };
  }

  async _webhookSet(on) {
    const w = this.cfg.webhook;
    const url = on ? w.on : w.off;
    if (!url) throw new HttpError(400, 'That action has no webhook URL configured');
    await getJson(this.fetch, url, { method: 'POST' });
    this.sim.on = on;
  }
}
