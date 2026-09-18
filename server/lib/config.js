// Loads server/config.json (or the path in HOME_SERVER_CONFIG) on top of defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, '..');
export const REPO_DIR = path.resolve(here, '../..');

export const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  token: '',
  https: { cert: '', key: '' },
  dataDir: path.join(SERVER_DIR, 'data'),
  mock: false,
  serveSite: true,
  minecraft: {
    enabled: true,
    host: '127.0.0.1',
    port: 25565,
    rcon: { host: '127.0.0.1', port: 25575, password: '' },
    startCommand: '',
    stopCommand: '',
    restartCommand: '',
  },
  ac: {
    adapter: 'none', // none | mock | sensibo | homeassistant | webhook
    sensibo: { apiKey: '', podId: '' },
    homeassistant: { url: '', token: '', entityId: '' },
    webhook: { on: '', off: '', setTemp: '', setMode: '', setFan: '', status: '' },
    minTemp: 16,
    maxTemp: 30,
  },
  door: {
    adapter: 'none', // none | mock | shelly | tasmota | homeassistant | webhook
    shelly: { host: '', gen: 1, relay: 0 },
    tasmota: { host: '', index: 1 },
    homeassistant: { url: '', token: '', entityId: '' },
    webhook: { on: '', off: '', toggle: '', status: '' },
    pulseMs: 0, // > 0: "open" pulses the switch on then off (door strike / garage style)
  },
  govee: { apiKey: '' },
  homeassistant: { url: '', token: '' },
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const file = process.env.HOME_SERVER_CONFIG || path.join(SERVER_DIR, 'config.json');
  let fromFile = {};
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Could not parse ${file}: ${e.message}`);
    }
  }
  const cfg = merge(merge(DEFAULTS, fromFile), overrides);
  if (process.env.HOME_SERVER_TOKEN) cfg.token = process.env.HOME_SERVER_TOKEN;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.GOVEE_API_KEY) cfg.govee.apiKey = process.env.GOVEE_API_KEY;
  cfg.configFile = file;
  cfg.dataDir = path.resolve(SERVER_DIR, cfg.dataDir);
  // Shared Home Assistant credentials fill the per-device blanks.
  for (const dev of ['ac', 'door']) {
    const ha = cfg[dev].homeassistant;
    if (!ha.url) ha.url = cfg.homeassistant.url;
    if (!ha.token) ha.token = cfg.homeassistant.token;
  }
  return cfg;
}
