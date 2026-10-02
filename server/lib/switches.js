// Extra smart plugs and switches (fan, heater, desk lamp…). Each one is a relay
// with the same adapters as the door (Shelly, Tasmota, Home Assistant, webhook).
import { DoorService } from './door.js';
import { HttpError } from './http.js';

export class SwitchesService {
  constructor(list = [], { fetchImpl = globalThis.fetch, mock = false, homeassistant = {} } = {}) {
    const defs = Array.isArray(list) && list.length ? list : mock
      ? [
          { id: 'fan', name: 'Ceiling fan', icon: '🌀', adapter: 'mock' },
          { id: 'desk', name: 'Desk plug', icon: '🖥️', adapter: 'mock' },
          { id: 'heater', name: 'Heater', icon: '🔥', adapter: 'mock' },
        ]
      : [];
    this.items = defs.map((d) => {
      const cfg = { adapter: d.adapter || 'none', shelly: d.shelly || {}, tasmota: d.tasmota || {}, homeassistant: { ...homeassistant, ...(d.homeassistant || {}) }, webhook: d.webhook || {}, pulseMs: d.pulseMs || 0 };
      return { id: d.id, name: d.name || d.id, icon: d.icon || '🔌', service: new DoorService(cfg, { fetchImpl, mock: mock || d.adapter === 'mock' }) };
    });
  }

  get enabled() {
    return this.items.length > 0;
  }

  _find(id) {
    const sw = this.items.find((x) => x.id === id);
    if (!sw) throw new HttpError(404, `Unknown switch "${id}"`);
    return sw;
  }

  async list() {
    return Promise.all(
      this.items.map(async (sw) => {
        try {
          const st = await sw.service.state();
          return { id: sw.id, name: sw.name, icon: sw.icon, on: st.on, adapter: st.adapter, lastAction: st.lastAction || null };
        } catch (e) {
          return { id: sw.id, name: sw.name, icon: sw.icon, on: null, error: e.message };
        }
      }),
    );
  }

  async set(id, action) {
    const sw = this._find(id);
    const st = await sw.service.set(action);
    return { id: sw.id, name: sw.name, icon: sw.icon, on: st.on, adapter: st.adapter, lastAction: st.lastAction || null };
  }

  async all(action) {
    const out = {};
    for (const sw of this.items) {
      try {
        out[sw.id] = await this.set(sw.id, action);
      } catch (e) {
        out[sw.id] = { id: sw.id, error: e.message };
      }
    }
    return out;
  }
}
