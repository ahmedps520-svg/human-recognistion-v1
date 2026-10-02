#!/usr/bin/env node
// Room Guard home server: one small Node.js process that serves the site,
// receives the camera's live feed and visit log, and controls the Minecraft
// server, the air conditioning, the door switch and the Govee lights behind
// a token-protected JSON API. No dependencies.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, REPO_DIR, SERVER_DIR } from './lib/config.js';
import { HttpError, MIME, SseHub, readBody, readJson, sendJson, setCors } from './lib/http.js';
import { checkAuth, randomToken } from './lib/auth.js';
import { CameraService } from './lib/camera.js';
import { MinecraftService } from './lib/minecraft.js';
import { GoveeService } from './lib/govee.js';
import { ClimateService } from './lib/climate.js';
import { DoorService } from './lib/door.js';
import { HomeState, ActivityLog } from './lib/home.js';
import { NotifyService } from './lib/notify.js';
import { WeatherService } from './lib/weather.js';
import { SensorsService } from './lib/sensors.js';
import { SwitchesService } from './lib/switches.js';
import { ScenesService } from './lib/scenes.js';
import { AutomationEngine } from './lib/automations.js';

export const VERSION = '0.3.0';

function parseMeta(req, url) {
  const raw = req.headers['x-meta'] || url.searchParams.get('meta');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function serveStatic(req, res, root, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel.split('/').some((seg) => seg.startsWith('.')) || rel.startsWith('/server/') || rel.startsWith('/node_modules/') || rel.startsWith('/tests/')) {
    res.writeHead(404).end('not found');
    return;
  }
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

/** Build the server. Returns { server, services, hub, config, close }. */
export function createServer(config) {
  const hub = new SseHub();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const activity = new ActivityLog({ dataDir: config.dataDir, hub });
  const services = {
    camera: new CameraService({ dataDir: config.dataDir, hub }),
    minecraft: new MinecraftService(config.minecraft, { mock: config.mock }),
    lights: new GoveeService({ apiKey: config.govee.apiKey, mock: config.mock, fetchImpl: config.fetchImpl }),
    ac: new ClimateService(config.ac, { mock: config.mock, fetchImpl: config.fetchImpl }),
    door: new DoorService(config.door, { mock: config.mock, fetchImpl: config.fetchImpl }),
    switches: new SwitchesService(config.switches, { mock: config.mock, fetchImpl: config.fetchImpl, homeassistant: config.homeassistant }),
    sensors: new SensorsService(config.sensors, { mock: config.mock, fetchImpl: config.fetchImpl, homeassistant: config.homeassistant }),
    weather: new WeatherService(config.location, { mock: config.mock, fetchImpl: config.fetchImpl }),
    notify: new NotifyService(config.notify, { mock: config.mock, fetchImpl: config.fetchImpl }),
    home: new HomeState({ dataDir: config.dataDir, hub }),
    activity,
    hub,
  };
  services.scenes = new ScenesService(config.scenes, services, { activity, hub });
  services.automations = new AutomationEngine(config.automations, services, { dataDir: config.dataDir, hub, activity });
  const { camera, minecraft, lights, ac, door, switches, sensors, weather, notify, home, scenes, automations } = services;

  // Human-readable timeline of what happens in the room.
  hub.subscribe((ev) => {
    if (ev.type === 'presence') activity.add('visit', ev.state === 'enter' ? '👤 Someone entered the room' : '🚶 Room is empty again');
    else if (ev.type === 'alarm') activity.add('alarm', '🚨 Alarm: someone is in the room', { source: ev.source });
    else if (ev.type === 'armed') activity.add('security', ev.armed ? '🔒 Camera armed' : '🔓 Camera disarmed');
    else if (ev.type === 'mode') activity.add('mode', `Mode set to ${ev.mode}`, { source: ev.source });
  });

  async function overallStatus() {
    const [mc, acState, doorState, lightState, switchList, sensorList, weatherNow] = await Promise.all([
      minecraft.status().catch((e) => ({ enabled: true, online: false, error: e.message })),
      ac.state().catch((e) => ({ adapter: ac.adapter, error: e.message })),
      door.state().catch((e) => ({ adapter: door.adapter, error: e.message })),
      lights.overview().catch((e) => ({ enabled: lights.enabled, devices: [], error: e.message })),
      switches.list().catch(() => []),
      sensors.read().catch(() => []),
      weather.current().catch((e) => ({ enabled: weather.enabled, error: e.message })),
    ]);
    return {
      type: 'status',
      at: Date.now(),
      version: VERSION,
      mock: !!config.mock,
      roomName: config.roomName,
      home: home.get(),
      camera: camera.status(),
      minecraft: mc,
      ac: acState,
      door: doorState,
      lights: lightState,
      switches: switchList,
      sensors: sensorList,
      weather: weatherNow,
      scenes: scenes.list(),
      automations: automations.list(),
      notify: { enabled: notify.enabled, adapter: notify.adapter },
      activity: activity.list({ limit: 30 }),
    };
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const seg = pathname.split('/').filter(Boolean); // ['api', 'camera', ...]

    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'room-guard-home-server', version: VERSION, mock: !!config.mock, needsToken: !config.token });

    checkAuth(req, url, config.token);

    if (pathname === '/api/status' && method === 'GET') return sendJson(res, 200, await overallStatus());
    if (pathname === '/api/events' && method === 'GET') return hub.attach(req, res, { initial: await overallStatus() });

    // ---------------- camera ----------------
    if (seg[1] === 'camera') {
      const rest = seg.slice(2);
      if (rest[0] === 'frame' && method === 'POST') {
        const buf = await readBody(req, { limit: 8 * 1024 * 1024 });
        camera.setFrame(buf, parseMeta(req, url));
        return sendJson(res, 200, { ok: true, at: camera.frame.at });
      }
      if (rest[0] === 'frame.jpg' && method === 'GET') {
        const f = camera.frame;
        if (!f) throw new HttpError(404, 'No frame yet');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': f.buffer.length, 'Cache-Control': 'no-store', 'X-Frame-At': String(f.at) });
        return res.end(f.buffer);
      }
      if (rest[0] === 'stream' && method === 'GET') return camera.streamMjpeg(req, res);
      if (rest[0] === 'status' && method === 'GET') return sendJson(res, 200, camera.status());
      if (rest[0] === 'presence' && method === 'POST') {
        camera.setPresence(await readJson(req));
        hub.broadcast({ type: 'camera', at: Date.now(), presence: camera.presence });
        return sendJson(res, 200, { ok: true });
      }
      if (rest[0] === 'command' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, camera.command(body.action, body.payload || {}));
      }
      if (rest[0] === 'events') {
        if (method === 'GET' && !rest[1]) return sendJson(res, 200, camera.listEvents({ limit: Number(url.searchParams.get('limit')) || 60 }));
        if (method === 'POST' && !rest[1]) return sendJson(res, 200, camera.insertEvent(await readJson(req)));
        if ((method === 'PUT' || method === 'PATCH') && rest[1]) return sendJson(res, 200, camera.updateEvent(rest[1], await readJson(req)));
        if (method === 'DELETE' && rest[1]) return sendJson(res, 200, camera.deleteEvent(rest[1]));
      }
      if (rest[0] === 'media' && rest.length > 1) {
        const relPath = rest.slice(1).join('/');
        if (method === 'PUT' || method === 'POST') {
          const buf = await readBody(req);
          return sendJson(res, 200, await camera.saveMedia(relPath, buf));
        }
        if (method === 'GET' || method === 'HEAD') {
          const abs = camera.mediaPath(relPath);
          return serveStatic(req, res, camera.mediaDir, '/' + path.relative(camera.mediaDir, abs).split(path.sep).join('/'));
        }
      }
      if (rest[0] === 'profiles') {
        if (method === 'GET') return sendJson(res, 200, camera.getProfiles());
        if (method === 'PUT') return sendJson(res, 200, camera.setProfiles(await readJson(req, { limit: 50 * 1024 * 1024 })));
      }
      if (rest[0] === 'calibration') {
        const label = url.searchParams.get('label') || 'default';
        if (method === 'GET') return sendJson(res, 200, { label, calibration: camera.getCalibration(label) });
        if (method === 'PUT') return sendJson(res, 200, { label, calibration: camera.setCalibration(label, (await readJson(req)).calibration ?? null) });
      }
    }

    // ---------------- room: mode, scenes, automations, switches, sensors, weather, activity, notify ----------------
    if (seg[1] === 'mode') {
      if (method === 'GET') return sendJson(res, 200, home.get());
      if (method === 'POST') return sendJson(res, 200, home.setMode((await readJson(req)).mode, { source: 'dashboard' }));
    }
    if (seg[1] === 'scenes') {
      if (method === 'GET') return sendJson(res, 200, scenes.list());
      if (method === 'POST' && seg[2] && seg[3] === 'run') return sendJson(res, 200, await scenes.run(decodeURIComponent(seg[2]), { source: 'dashboard' }));
    }
    if (seg[1] === 'automations') {
      if (method === 'GET') return sendJson(res, 200, automations.list());
      if (method === 'POST' && seg[2] && seg[3] === 'run') return sendJson(res, 200, await automations.runNow(decodeURIComponent(seg[2])));
      if (method === 'POST' && seg[2]) return sendJson(res, 200, automations.setEnabled(decodeURIComponent(seg[2]), !!(await readJson(req)).enabled));
    }
    if (seg[1] === 'switches') {
      if (method === 'GET') return sendJson(res, 200, await switches.list());
      if (method === 'POST' && seg[2] === 'all') {
        const out = await switches.all((await readJson(req)).action || 'off');
        hub.broadcast({ type: 'switches', at: Date.now() });
        activity.add('device', `🔌 All switches ${Object.values(out).every((o) => o.on === false) ? 'off' : 'on'}`);
        return sendJson(res, 200, out);
      }
      if (method === 'POST' && seg[2]) {
        const st = await switches.set(decodeURIComponent(seg[2]), (await readJson(req)).action || 'toggle');
        hub.broadcast({ type: 'switches', id: st.id, state: st, at: Date.now() });
        activity.add('device', `${st.icon} ${st.name} ${st.on ? 'on' : 'off'}`);
        return sendJson(res, 200, st);
      }
    }
    if (seg[1] === 'sensors' && method === 'GET') return sendJson(res, 200, await sensors.read());
    if (seg[1] === 'weather' && method === 'GET') return sendJson(res, 200, await weather.current());
    if (seg[1] === 'activity' && method === 'GET') return sendJson(res, 200, activity.list({ limit: Number(url.searchParams.get('limit')) || 50 }));
    if (seg[1] === 'notify' && method === 'POST') {
      const body = await readJson(req);
      const out = await notify.send(body.title || 'Home', body.message || 'Test notification from your home server');
      activity.add('notify', `📱 Notification sent: ${out.message}`);
      return sendJson(res, 200, out);
    }

    // ---------------- minecraft ----------------
    if (seg[1] === 'minecraft') {
      const action = seg[2];
      if (!action && method === 'GET') return sendJson(res, 200, await minecraft.status());
      if (method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
        const out = await minecraft[action]();
        hub.broadcast({ type: 'minecraft', action, at: Date.now() });
        activity.add('minecraft', `⛏️ Minecraft server ${action}`);
        return sendJson(res, 200, out);
      }
      if (method === 'POST' && action === 'rcon') {
        const { command } = await readJson(req);
        return sendJson(res, 200, { command, output: await minecraft.rcon(command) });
      }
    }

    // ---------------- air conditioning ----------------
    if (seg[1] === 'ac') {
      if (method === 'GET') return sendJson(res, 200, await ac.state());
      if (method === 'POST') {
        const changes = await readJson(req);
        const state = await ac.set(changes);
        hub.broadcast({ type: 'ac', state, at: Date.now() });
        activity.add('device', `❄️ AC ${changes.power === false ? 'off' : `${state.mode || ''} ${state.targetTemp != null ? `${state.targetTemp}°` : ''}`.trim()}`);
        return sendJson(res, 200, state);
      }
    }

    // ---------------- door ----------------
    if (seg[1] === 'door') {
      if (method === 'GET') return sendJson(res, 200, await door.state());
      if (method === 'POST') {
        const body = await readJson(req);
        // Room Guard's alarm webhook posts {action:'lock'} here (or 'test' from the settings button).
        const action = seg[2] === 'lock' ? (body.action === 'test' ? null : 'lock') : body.action;
        if (!action) return sendJson(res, 200, { ok: true, test: true, message: 'Door webhook reachable' });
        const state = await door.set(action);
        hub.broadcast({ type: 'door', state, at: Date.now() });
        activity.add('door', `🚪 Door ${state.on ? 'opened / unlocked' : 'closed / locked'}${seg[2] === 'lock' ? ' by the camera alarm' : ''}`);
        return sendJson(res, 200, state);
      }
    }

    // ---------------- lights ----------------
    if (seg[1] === 'lights') {
      if (method === 'GET') return sendJson(res, 200, await lights.overview());
      if (method === 'POST' && seg[2] === 'all') {
        const changes = await readJson(req);
        const result = await lights.all(changes);
        hub.broadcast({ type: 'lights', at: Date.now() });
        activity.add('device', `💡 All lights ${changes.power === false ? 'off' : 'on'}`);
        return sendJson(res, 200, result);
      }
      if (method === 'POST' && seg[2]) {
        const state = await lights.control(decodeURIComponent(seg[2]), await readJson(req));
        hub.broadcast({ type: 'lights', device: decodeURIComponent(seg[2]), state, at: Date.now() });
        return sendJson(res, 200, state);
      }
    }

    throw new HttpError(404, `No route for ${method} ${pathname}`);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) await route(req, res, url);
      else if (config.serveSite) serveStatic(req, res, REPO_DIR, url.pathname);
      else res.writeHead(404).end('not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: e.message, ...(e.extra || {}) });
      else res.end();
    }
  };

  const server = config.https?.cert && config.https?.key
    ? https.createServer({ cert: fs.readFileSync(config.https.cert), key: fs.readFileSync(config.https.key) }, handler)
    : http.createServer(handler);
  server.keepAliveTimeout = 65000;

  return {
    server,
    services,
    hub,
    config,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address()))),
    close: async () => {
      automations.close();
      hub.close();
      await Promise.all([camera.flush(), activity.flush(), home.flush()]);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function parseArgs(argv) {
  const out = { mock: false, config: '', port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock' || a === '--demo') out.mock = true;
    else if (a === '--config' && argv[i + 1]) out.config = argv[++i];
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node server/index.js [--mock] [--config path/to/config.json] [--port 8787]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.config) process.env.HOME_SERVER_CONFIG = args.config;
  const config = loadConfig(args.mock ? { mock: true, dataDir: path.join(SERVER_DIR, 'data-mock'), token: 'demo-token-change-me' } : {});
  if (args.port) config.port = args.port;
  if (args.mock) {
    const app = createServer(config);
    const addr = await app.listen();
    console.log(`Room Guard home server v${VERSION} (MOCK devices: nothing is wired, everything is simulated)`);
    console.log(`  dashboard:  http://localhost:${addr.port}/dashboard.html?token=${config.token}`);
    for (const ip of lanAddresses()) console.log(`              http://${ip}:${addr.port}/dashboard.html?token=${config.token}`);
    console.log(`  token:      ${config.token}`);
    const shutdown = () => app.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  if (!config.token) {
    config.token = randomToken();
    const file = config.configFile;
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      existing = {};
    }
    fs.writeFileSync(file, JSON.stringify({ ...existing, token: config.token }, null, 2));
    console.log(`No token was configured; generated one and saved it to ${path.relative(process.cwd(), file)}.`);
  }
  const app = createServer(config);
  const addr = await app.listen();
  const scheme = config.https?.cert ? 'https' : 'http';
  console.log(`Room Guard home server v${VERSION}${config.mock ? ' (MOCK devices)' : ''}`);
  console.log(`  dashboard:  ${scheme}://localhost:${addr.port}/dashboard.html`);
  for (const ip of lanAddresses()) console.log(`              ${scheme}://${ip}:${addr.port}/dashboard.html`);
  console.log(`  token:      ${config.token}`);
  console.log(`  data:       ${config.dataDir}`);
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { SERVER_DIR };
