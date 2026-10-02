// Outdoor weather from Open-Meteo (free, no key) for the configured location.
const CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm',
};

export class WeatherService {
  constructor(cfg = {}, { fetchImpl = globalThis.fetch, mock = false } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.mock = mock;
    this.cache = { at: 0, value: null };
  }

  get enabled() {
    return this.mock || (Number.isFinite(this.cfg.lat) && Number.isFinite(this.cfg.lon));
  }

  async current() {
    if (!this.enabled) return { enabled: false };
    if (this.mock) return { enabled: true, name: this.cfg.name || 'Mock city', temperature: 31.4, humidity: 40, wind: 12, code: 1, description: 'Mostly clear', isDay: true, at: new Date().toISOString() };
    if (this.cache.value && Date.now() - this.cache.at < 10 * 60 * 1000) return this.cache.value;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.cfg.lat}&longitude=${this.cfg.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day&timezone=auto`;
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
    const j = await res.json();
    const c = j.current || {};
    const value = {
      enabled: true,
      name: this.cfg.name || `${this.cfg.lat}, ${this.cfg.lon}`,
      temperature: c.temperature_2m ?? null,
      humidity: c.relative_humidity_2m ?? null,
      wind: c.wind_speed_10m ?? null,
      code: c.weather_code ?? null,
      description: CODES[c.weather_code] || '',
      isDay: c.is_day === 1,
      at: c.time || new Date().toISOString(),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }
}
