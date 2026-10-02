// Extra room sensors (temperature, humidity, CO2, light, …) read from Home
// Assistant entities. Mock mode simulates a few.
export class SensorsService {
  constructor(cfg = {}, { fetchImpl = globalThis.fetch, mock = false, homeassistant = {} } = {}) {
    this.list = Array.isArray(cfg) ? cfg : [];
    this.fetch = fetchImpl;
    this.mock = mock;
    this.ha = homeassistant;
    if (mock && !this.list.length) {
      this.list = [
        { id: 'temp', name: 'Room temperature', kind: 'temperature', unit: '°C', mockValue: 25.8 },
        { id: 'hum', name: 'Humidity', kind: 'humidity', unit: '%', mockValue: 47 },
        { id: 'co2', name: 'CO₂', kind: 'co2', unit: 'ppm', mockValue: 612 },
        { id: 'lux', name: 'Light level', kind: 'illuminance', unit: 'lx', mockValue: 85 },
      ];
    }
  }

  get enabled() {
    return this.list.length > 0;
  }

  async read() {
    const out = [];
    for (const s of this.list) {
      if (this.mock || s.mockValue !== undefined) {
        const jitter = this.mock ? (Math.sin(Date.now() / 60000) * 0.3) : 0;
        out.push({ id: s.id, name: s.name, kind: s.kind, unit: s.unit, value: Number((s.mockValue + jitter).toFixed(1)), at: new Date().toISOString() });
        continue;
      }
      try {
        const base = (this.ha.url || '').replace(/\/$/, '');
        if (!base || !this.ha.token || !s.entityId) throw new Error('Home Assistant url/token/entityId missing');
        const res = await this.fetch(`${base}/api/states/${s.entityId}`, { headers: { Authorization: `Bearer ${this.ha.token}` } });
        if (!res.ok) throw new Error(`HA ${res.status}`);
        const j = await res.json();
        out.push({ id: s.id, name: s.name, kind: s.kind, unit: s.unit || j.attributes?.unit_of_measurement || '', value: Number(j.state), at: j.last_updated });
      } catch (e) {
        out.push({ id: s.id, name: s.name, kind: s.kind, unit: s.unit, value: null, error: e.message });
      }
    }
    return out;
  }
}
