// Govee lights through the Govee Developer (cloud) API v1, which works for
// WiFi devices from anywhere. Get a key in the Govee Home app:
// Settings → Apply for API key.

import crypto from 'node:crypto';
import { HttpError } from './http.js';

const BASE = 'https://openapi.api.govee.com/router/api/v1';
const CAP = {
  power: { type: 'devices.capabilities.on_off', instance: 'powerSwitch' },
  brightness: { type: 'devices.capabilities.range', instance: 'brightness' },
  color: { type: 'devices.capabilities.color_setting', instance: 'colorRgb' },
  colorTempK: { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK' },
};

export const rgbToInt = ({ r, g, b }) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
export const intToRgb = (v) => ({ r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff });

export class GoveeService {
  constructor({ apiKey = '', fetchImpl = globalThis.fetch, mock = false } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.mock = mock;
    this.cache = { devices: null, at: 0 };
    this.sim = mock
      ? [
          { device: 'AA:BB:CC:DD:EE:01', sku: 'H6159', deviceName: 'Bed strip', type: 'devices.types.light', state: { online: true, power: true, brightness: 80, color: { r: 255, g: 180, b: 80 }, colorTempK: 0 } },
          { device: 'AA:BB:CC:DD:EE:02', sku: 'H6008', deviceName: 'Desk lamp', type: 'devices.types.light', state: { online: true, power: false, brightness: 40, color: { r: 0, g: 120, b: 255 }, colorTempK: 0 } },
        ]
      : null;
  }

  get enabled() {
    return this.mock || !!this.apiKey;
  }

  async _call(pathname, { method = 'GET', body } = {}) {
    if (!this.apiKey) throw new HttpError(400, 'Govee API key is not configured');
    const res = await this.fetch(`${BASE}${pathname}`, {
      method,
      headers: { 'Govee-API-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) throw new HttpError(502, `Govee API ${res.status}: ${json?.message || text.slice(0, 200)}`);
    if (json && json.code && json.code !== 200) throw new HttpError(502, `Govee API error ${json.code}: ${json.message || ''}`);
    return json;
  }

  async listDevices({ fresh = false } = {}) {
    if (this.mock) return this.sim.map(({ state, ...d }) => d);
    if (!fresh && this.cache.devices && Date.now() - this.cache.at < 60000) return this.cache.devices;
    const json = await this._call('/user/devices');
    const devices = (json?.data || []).map((d) => ({
      device: d.device,
      sku: d.sku,
      deviceName: d.deviceName,
      type: d.type,
      capabilities: (d.capabilities || []).map((c) => c.instance),
    }));
    this.cache = { devices, at: Date.now() };
    return devices;
  }

  async state(device) {
    if (this.mock) {
      const d = this.sim.find((x) => x.device === device);
      if (!d) throw new HttpError(404, 'Unknown device');
      return { ...d.state };
    }
    const devices = await this.listDevices();
    const d = devices.find((x) => x.device === device);
    if (!d) throw new HttpError(404, 'Unknown device');
    const json = await this._call('/device/state', { method: 'POST', body: { requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device } } });
    const caps = json?.payload?.capabilities || [];
    const get = (instance) => caps.find((c) => c.instance === instance)?.state?.value;
    const rgb = get('colorRgb');
    return {
      online: get('online') !== false,
      power: get('powerSwitch') === 1 || get('powerSwitch') === true,
      brightness: get('brightness') ?? null,
      color: Number.isFinite(rgb) ? intToRgb(rgb) : null,
      colorTempK: get('colorTemperatureK') ?? null,
    };
  }

  /** Apply any of { power, brightness, color:{r,g,b}, colorTempK } to one device. */
  async control(device, changes = {}) {
    const ops = [];
    if (changes.power !== undefined) ops.push({ ...CAP.power, value: changes.power ? 1 : 0 });
    if (Number.isFinite(changes.brightness)) ops.push({ ...CAP.brightness, value: Math.max(1, Math.min(100, Math.round(changes.brightness))) });
    if (changes.color && Number.isFinite(changes.color.r)) ops.push({ ...CAP.color, value: rgbToInt(changes.color) });
    if (Number.isFinite(changes.colorTempK) && changes.colorTempK > 0) ops.push({ ...CAP.colorTempK, value: Math.round(changes.colorTempK) });
    if (!ops.length) throw new HttpError(400, 'Nothing to change (power, brightness, color, colorTempK)');
    if (this.mock) {
      const d = this.sim.find((x) => x.device === device);
      if (!d) throw new HttpError(404, 'Unknown device');
      if (changes.power !== undefined) d.state.power = !!changes.power;
      if (Number.isFinite(changes.brightness)) d.state.brightness = Math.round(changes.brightness);
      if (changes.color) d.state.color = { ...changes.color };
      if (Number.isFinite(changes.colorTempK)) d.state.colorTempK = changes.colorTempK;
      return { ...d.state };
    }
    const devices = await this.listDevices();
    const d = devices.find((x) => x.device === device);
    if (!d) throw new HttpError(404, 'Unknown device');
    for (const capability of ops) {
      await this._call('/device/control', { method: 'POST', body: { requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device, capability } } });
    }
    return this.state(device);
  }

  async all(changes) {
    const devices = await this.listDevices();
    const results = {};
    for (const d of devices) {
      try {
        results[d.device] = await this.control(d.device, changes);
      } catch (e) {
        results[d.device] = { error: e.message };
      }
    }
    return results;
  }

  async overview() {
    if (!this.enabled) return { enabled: false, devices: [] };
    const devices = await this.listDevices();
    const out = [];
    for (const d of devices) {
      let state = null;
      try {
        state = await this.state(d.device);
      } catch (e) {
        state = { error: e.message };
      }
      out.push({ ...d, state });
    }
    return { enabled: true, devices: out };
  }
}
