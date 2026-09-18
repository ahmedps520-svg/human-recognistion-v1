// Air conditioning through one of several adapters. State is normalised to
// { power, mode, targetTemp, fanLevel, currentTemp, humidity }.

import { HttpError } from './http.js';

const MODES = ['cool', 'heat', 'fan', 'dry', 'auto'];
const clampTemp = (t, cfg) => Math.max(cfg.minTemp, Math.min(cfg.maxTemp, Math.round(Number(t))));

async function fetchJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new HttpError(502, `${new URL(url).host} responded ${res.status}: ${(json && (json.message || json.error)) || text.slice(0, 200)}`);
  return json;
}

export class ClimateService {
  constructor(cfg, { fetchImpl = globalThis.fetch, mock = false } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.adapter = mock ? 'mock' : cfg.adapter || 'none';
    this.sim = { power: false, mode: 'cool', targetTemp: 23, fanLevel: 'auto', currentTemp: 26.5, humidity: 48 };
  }

  get enabled() {
    return this.adapter !== 'none';
  }

  async state() {
    switch (this.adapter) {
      case 'mock':
        return { adapter: 'mock', ...this.sim };
      case 'sensibo':
        return this._sensiboState();
      case 'homeassistant':
        return this._haState();
      case 'webhook':
        return this._webhookState();
      default:
        return { adapter: 'none', enabled: false };
    }
  }

  /** changes: { power, mode, targetTemp, fanLevel } */
  async set(changes = {}) {
    const c = {};
    if (changes.power !== undefined) c.power = !!changes.power;
    if (changes.mode !== undefined) {
      if (!MODES.includes(changes.mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
      c.mode = changes.mode;
    }
    if (changes.targetTemp !== undefined) {
      if (!Number.isFinite(Number(changes.targetTemp))) throw new HttpError(400, 'targetTemp must be a number');
      c.targetTemp = clampTemp(changes.targetTemp, this.cfg);
    }
    if (changes.fanLevel !== undefined) c.fanLevel = String(changes.fanLevel);
    if (!Object.keys(c).length) throw new HttpError(400, 'Nothing to change (power, mode, targetTemp, fanLevel)');
    switch (this.adapter) {
      case 'mock':
        Object.assign(this.sim, c);
        return { adapter: 'mock', ...this.sim };
      case 'sensibo':
        return this._sensiboSet(c);
      case 'homeassistant':
        return this._haSet(c);
      case 'webhook':
        return this._webhookSet(c);
      default:
        throw new HttpError(400, 'No AC adapter configured (server/config.json → ac.adapter)');
    }
  }

  // ---------------- Sensibo ----------------
  async _sensiboPod() {
    const { apiKey, podId } = this.cfg.sensibo;
    if (!apiKey) throw new HttpError(400, 'Sensibo API key is not configured');
    const json = await fetchJson(this.fetch, `https://home.sensibo.com/api/v2/users/me/pods?apiKey=${encodeURIComponent(apiKey)}&fields=id,room,acState,measurements`);
    const pods = json?.result || [];
    const pod = podId ? pods.find((p) => p.id === podId) : pods[0];
    if (!pod) throw new HttpError(404, 'No Sensibo device found');
    return pod;
  }

  _sensiboNormalise(pod) {
    const s = pod.acState || {};
    return {
      adapter: 'sensibo',
      podId: pod.id,
      room: pod.room?.name || '',
      power: !!s.on,
      mode: s.mode || 'cool',
      targetTemp: s.targetTemperature ?? null,
      fanLevel: s.fanLevel || 'auto',
      unit: s.temperatureUnit || 'C',
      currentTemp: pod.measurements?.temperature ?? null,
      humidity: pod.measurements?.humidity ?? null,
    };
  }

  async _sensiboState() {
    return this._sensiboNormalise(await this._sensiboPod());
  }

  async _sensiboSet(c) {
    const pod = await this._sensiboPod();
    const acState = { ...(pod.acState || {}) };
    if (c.power !== undefined) acState.on = c.power;
    if (c.mode) acState.mode = c.mode;
    if (c.targetTemp !== undefined) acState.targetTemperature = c.targetTemp;
    if (c.fanLevel) acState.fanLevel = c.fanLevel;
    if (c.power === undefined && (c.mode || c.targetTemp !== undefined)) acState.on = true;
    const json = await fetchJson(this.fetch, `https://home.sensibo.com/api/v2/pods/${pod.id}/acStates?apiKey=${encodeURIComponent(this.cfg.sensibo.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acState }),
    });
    return this._sensiboNormalise({ ...pod, acState: json?.result?.acState || acState });
  }

  // ---------------- Home Assistant ----------------
  _ha() {
    const { url, token, entityId } = this.cfg.homeassistant;
    if (!url || !token || !entityId) throw new HttpError(400, 'Home Assistant url, token and climate entityId are required');
    return { base: url.replace(/\/$/, ''), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, entityId };
  }

  async _haState() {
    const ha = this._ha();
    const s = await fetchJson(this.fetch, `${ha.base}/api/states/${ha.entityId}`, { headers: ha.headers });
    const a = s?.attributes || {};
    return {
      adapter: 'homeassistant',
      entityId: ha.entityId,
      power: s?.state !== 'off' && s?.state !== 'unavailable',
      mode: s?.state === 'fan_only' ? 'fan' : s?.state === 'heat_cool' ? 'auto' : s?.state || 'off',
      targetTemp: a.temperature ?? null,
      fanLevel: a.fan_mode || 'auto',
      currentTemp: a.current_temperature ?? null,
      humidity: a.current_humidity ?? null,
      modes: a.hvac_modes || [],
      fanModes: a.fan_modes || [],
    };
  }

  async _haSet(c) {
    const ha = this._ha();
    const call = (service, data) =>
      fetchJson(this.fetch, `${ha.base}/api/services/climate/${service}`, { method: 'POST', headers: ha.headers, body: JSON.stringify({ entity_id: ha.entityId, ...data }) });
    if (c.power === false) await call('turn_off', {});
    else if (c.power === true && !c.mode) await call('turn_on', {});
    if (c.mode) await call('set_hvac_mode', { hvac_mode: c.mode === 'fan' ? 'fan_only' : c.mode === 'auto' ? 'heat_cool' : c.mode });
    if (c.targetTemp !== undefined) await call('set_temperature', { temperature: c.targetTemp });
    if (c.fanLevel) await call('set_fan_mode', { fan_mode: c.fanLevel });
    return this._haState();
  }

  // ---------------- generic webhooks ----------------
  _tpl(url, vars) {
    return url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
  }

  async _webhookState() {
    const w = this.cfg.webhook;
    if (!w.status) return { adapter: 'webhook', power: null, mode: null, targetTemp: null, fanLevel: null, note: 'no status URL configured' };
    const json = await fetchJson(this.fetch, w.status);
    return { adapter: 'webhook', power: json?.power ?? null, mode: json?.mode ?? null, targetTemp: json?.targetTemp ?? null, fanLevel: json?.fanLevel ?? null, currentTemp: json?.currentTemp ?? null };
  }

  async _webhookSet(c) {
    const w = this.cfg.webhook;
    const hit = async (url, vars) => {
      if (!url) throw new HttpError(400, 'That action has no webhook URL configured');
      await fetchJson(this.fetch, this._tpl(url, vars), { method: 'POST' });
    };
    if (c.power === true) await hit(w.on, {});
    if (c.power === false) await hit(w.off, {});
    if (c.mode) await hit(w.setMode, { mode: c.mode });
    if (c.targetTemp !== undefined) await hit(w.setTemp, { temp: c.targetTemp });
    if (c.fanLevel) await hit(w.setFan, { fan: c.fanLevel });
    return this._webhookState();
  }
}
