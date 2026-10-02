// The home agent: the one process that runs at home (on the PC) and talks to
// the real devices. It signs in to the same cloud project as the dashboard
// and the camera app, mirrors every device into the `device_states` table,
// carries out dashboard commands, and runs scenes and automations.
//
// Nothing here listens on the network: no ports, no tokens, no URLs to type.

import os from 'node:os';
import { SseHub } from './http.js';
import { MinecraftService } from './minecraft.js';
import { GoveeService } from './govee.js';
import { ClimateService } from './climate.js';
import { DoorService } from './door.js';
import { NotifyService } from './notify.js';
import { WeatherService } from './weather.js';
import { SensorsService } from './sensors.js';
import { SwitchesService } from './switches.js';
import { ScenesService } from './scenes.js';
import { AutomationEngine } from './automations.js';
import { MODES } from './home.js';
import { homeFromRow } from '../../assets/js/rows.js';

export const AGENT_VERSION = '0.4.0';
const POLL_MS = 30000;
const WEATHER_MS = 10 * 60 * 1000;

/** What the camera app publishes (presence), seen through the eyes of scenes and automations. */
class CloudCamera {
  constructor(cloud, hub) {
    this.cloud = cloud;
    this.hub = hub;
    this.presence = { people: 0, armed: false, recording: false, alarm: false, mode: 'presence', tracks: [] };
    this.online = false;
  }

  /** Called with the camera's presence meta (or null when the camera app is gone). */
  update(meta) {
    const prev = this.presence;
    const online = !!meta && meta.running !== false;
    this.online = online;
    const next = online
      ? { people: Number(meta.people) || 0, armed: !!meta.armed, recording: !!meta.recording, alarm: !!meta.alarm, mode: meta.mode || prev.mode, tracks: meta.tracks || [] }
      : { ...prev, people: 0, recording: false, tracks: [] };
    this.presence = next;
    const at = Date.now();
    if (prev.people === 0 && next.people > 0) this.hub.broadcast({ type: 'presence', state: 'enter', people: next.people, at });
    else if (prev.people > 0 && next.people === 0) this.hub.broadcast({ type: 'presence', state: 'leave', people: 0, at });
    if (prev.armed !== next.armed) this.hub.broadcast({ type: 'armed', armed: next.armed, at });
  }

  setArmed(armed) {
    if (this.presence.armed === !!armed) return;
    this.presence = { ...this.presence, armed: !!armed };
    this.hub.broadcast({ type: 'armed', armed: !!armed, at: Date.now() });
  }

  /** Scenes and automations call this: arm/disarm go through the shared room row, the rest to the camera app. */
  command(action, payload = {}) {
    if (action === 'arm' || action === 'disarm') {
      this.cloud.setHome({ armed: action === 'arm' }).catch((e) => console.warn('camera command', e.message));
      return { action };
    }
    this.cloud.send('command', { id: `agent-${Date.now()}`, target: 'camera', action, params: payload });
    return { action };
  }
}

/** The room's mode, stored in the shared home row. */
class CloudHome {
  constructor(cloud, hub, home) {
    this.cloud = cloud;
    this.hub = hub;
    this.mode = home?.mode || 'home';
    this.modeSince = home?.modeSince || new Date().toISOString();
  }

  get() {
    return { mode: this.mode, modeSince: this.modeSince, modes: MODES };
  }

  /** From a scene or automation: write the row; the row change comes back through applyRow(). */
  setMode(mode, { source = 'agent' } = {}) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    if (mode !== this.mode) {
      this.mode = mode;
      this.modeSince = new Date().toISOString();
      this.cloud.setHome({ mode }).catch((e) => console.warn('set mode', e.message));
      this.cloud.addActivity('mode', `Mode set to ${mode}`, { source }).catch(() => {});
      this.hub.broadcast({ type: 'mode', mode, modeSince: this.modeSince, source, at: Date.now() });
    }
    return this.get();
  }

  applyRow(home) {
    if (home.mode !== this.mode) {
      this.mode = home.mode;
      this.modeSince = home.modeSince || new Date().toISOString();
      this.hub.broadcast({ type: 'mode', mode: this.mode, modeSince: this.modeSince, source: 'cloud', at: Date.now() });
    }
  }

  flush() {
    return Promise.resolve();
  }
}

/** Activity timeline in the cloud. */
class CloudActivity {
  constructor(cloud, hub, log) {
    this.cloud = cloud;
    this.hub = hub;
    this.log = log;
    this.items = [];
  }

  add(kind, text, extra = {}) {
    const entry = { at: new Date().toISOString(), kind, text, ...extra };
    this.items.unshift(entry);
    this.items.length = Math.min(this.items.length, 100);
    this.log(`${kind}: ${text}`);
    this.cloud.addActivity(kind, text, extra).catch((e) => console.warn('activity', e.message));
    this.hub.broadcast({ type: 'activity', entry });
    return entry;
  }

  list({ limit = 50 } = {}) {
    return this.items.slice(0, limit);
  }

  flush() {
    return Promise.resolve();
  }
}

export class HomeAgent {
  /**
   * @param {object} o
   * @param {import('../../assets/js/cloud.js').Cloud} o.cloud signed-in cloud link (role 'agent')
   * @param {object} o.config loadConfig() output
   * @param {Function} [o.log]
   * @param {Function} [o.now]
   */
  constructor({ cloud, config, log = (m) => console.log(`[agent] ${m}`), now = () => new Date() }) {
    this.cloud = cloud;
    this.config = config;
    this.log = log;
    this.now = now;
    this.hub = new SseHub();
    this.mirrored = {};
    this.timers = [];
    this.unsubs = [];
    this.started = false;
    this.lastAlarmAt = null;
    this.polling = null;
  }

  async start() {
    const { cloud, config, hub } = this;
    this.home = await cloud.getHome();
    this.camera = new CloudCamera(cloud, hub);
    this.homeState = new CloudHome(cloud, hub, this.home);
    this.activity = new CloudActivity(cloud, hub, this.log);
    const fx = config.fetchImpl;
    const services = {
      camera: this.camera,
      minecraft: new MinecraftService(config.minecraft, { mock: config.mock }),
      lights: new GoveeService({ apiKey: config.govee.apiKey, mock: config.mock, fetchImpl: fx }),
      ac: new ClimateService(config.ac, { mock: config.mock, fetchImpl: fx }),
      door: new DoorService(config.door, { mock: config.mock, fetchImpl: fx }),
      switches: new SwitchesService(config.switches, { mock: config.mock, fetchImpl: fx, homeassistant: config.homeassistant }),
      sensors: new SensorsService(config.sensors, { mock: config.mock, fetchImpl: fx, homeassistant: config.homeassistant }),
      weather: new WeatherService(config.location, { mock: config.mock, fetchImpl: fx }),
      notify: new NotifyService(config.notify, { mock: config.mock, fetchImpl: fx }),
      home: this.homeState,
      activity: this.activity,
      hub,
    };
    services.scenes = new ScenesService(config.scenes, services, { activity: this.activity, hub });
    services.automations = new AutomationEngine(config.automations, services, { dataDir: config.dataDir, hub, activity: this.activity, now: this.now });
    this.services = services;
    this.camera.setArmed(this.home.armed);
    this.applyAutomationOverrides(this.home.automations);

    // After a scene or automation touched devices, mirror what changed.
    this.unsubs.push(
      hub.subscribe((ev) => {
        if (ev.type === 'door') this.mirror('door', ev.state);
        else if (ev.type === 'ac') this.mirror('ac', ev.state);
        else if (ev.type === 'lights') this.queueMirror('lights');
        else if (ev.type === 'switches') this.queueMirror('switches');
        else if (ev.type === 'scene') this.queueMirror('scenes');
        else if (ev.type === 'automation' || ev.type === 'automations') this.queueMirror('automations');
        else if (ev.type === 'minecraft') setTimeout(() => this.queueMirror('minecraft'), 1500).unref?.();
      }),
      cloud.on('command', (c) => this.handleCommand(c)),
      cloud.onTable('home', (ev) => {
        if (ev.new) this.onHome(homeFromRow(ev.new));
      }),
      cloud.onPresence((p) => this.camera.update(p.camera)),
    );

    await cloud.join(this.meta());
    this.camera.update(cloud.presence.camera);
    await this.mirrorAll();
    this.timers.push(setInterval(() => this.poll().catch((e) => this.log(`poll failed: ${e.message}`)), POLL_MS));
    this.timers.push(setInterval(() => this.mirror('weather').catch(() => {}), WEATHER_MS));
    for (const t of this.timers) t.unref?.();
    this.started = true;
    this.log(`online as ${cloud.user?.email || 'agent'}${config.mock ? ' (MOCK devices: nothing is wired, everything is simulated)' : ''}`);
    return this;
  }

  meta() {
    return { version: AGENT_VERSION, mock: !!this.config.mock, host: os.hostname(), startedAt: this.startedAt || (this.startedAt = new Date().toISOString()) };
  }

  applyAutomationOverrides(overrides = {}) {
    const engine = this.services?.automations;
    if (!engine) return;
    let changed = false;
    for (const r of engine.rules) {
      const def = (engine.defaults || (engine.defaults = Object.fromEntries(engine.rules.map((x) => [x.id, !!x.enabled]))))[r.id];
      const want = overrides?.[r.id]?.enabled ?? def;
      if (r.enabled !== !!want) {
        r.enabled = !!want;
        changed = true;
      }
    }
    if (changed && this.started) this.queueMirror('automations');
  }

  /** The shared room row changed (dashboard or camera): mode, armed, alarm, automation switches. */
  onHome(home) {
    const prev = this.home || {};
    this.home = home;
    this.homeState.applyRow(home);
    this.camera.setArmed(home.armed);
    this.applyAutomationOverrides(home.automations);
    if (home.alarm && !prev.alarm && home.alarmAt !== this.lastAlarmAt) {
      this.lastAlarmAt = home.alarmAt;
      this.hub.broadcast({ type: 'alarm', source: 'camera', at: Date.now() });
    }
  }

  // ---------------------------------------------------------------- mirroring device state into the cloud
  async readDevice(name) {
    const s = this.services;
    switch (name) {
      case 'door':
        return s.door.state().catch((e) => ({ adapter: s.door.adapter, error: e.message }));
      case 'ac':
        return s.ac.state().catch((e) => ({ adapter: s.ac.adapter, error: e.message }));
      case 'lights':
        return s.lights.overview().catch((e) => ({ enabled: s.lights.enabled, devices: [], error: e.message }));
      case 'switches':
        return { list: await s.switches.list().catch(() => []) };
      case 'sensors':
        return { list: await s.sensors.read().catch(() => []) };
      case 'weather':
        return s.weather.current().catch((e) => ({ enabled: s.weather.enabled, error: e.message }));
      case 'minecraft':
        return s.minecraft.status().catch((e) => ({ enabled: true, online: false, error: e.message }));
      case 'scenes':
        return { list: s.scenes.list() };
      case 'automations':
        return { list: s.automations.list() };
      case 'notify':
        return { enabled: s.notify.enabled, adapter: s.notify.adapter };
      case 'agent':
        return { ...this.meta(), lastSeen: new Date().toISOString(), roomName: this.config.roomName };
      default:
        return null;
    }
  }

  /** Write one device's state to the cloud when it changed since the last mirror. */
  async mirror(name, state = null) {
    const next = state ?? (await this.readDevice(name));
    if (next == null) return null;
    const sig = JSON.stringify(next);
    if (this.mirrored[name] === sig) return next;
    this.mirrored[name] = sig;
    await this.cloud.setDevice(name, next);
    return next;
  }

  queueMirror(name) {
    this.polling = (this.polling || Promise.resolve()).then(() => this.mirror(name)).catch((e) => this.log(`mirror ${name} failed: ${e.message}`));
    return this.polling;
  }

  async mirrorAll() {
    for (const name of ['agent', 'notify', 'scenes', 'automations', 'door', 'ac', 'lights', 'switches', 'sensors', 'minecraft', 'weather']) {
      await this.mirror(name).catch((e) => this.log(`mirror ${name} failed: ${e.message}`));
    }
  }

  async poll() {
    for (const name of ['door', 'ac', 'lights', 'switches', 'sensors', 'minecraft']) await this.mirror(name).catch((e) => this.log(`mirror ${name} failed: ${e.message}`));
  }

  // ---------------------------------------------------------------- commands from the dashboard
  async handleCommand(c) {
    if (!c || c.target !== 'agent') return;
    const s = this.services;
    const p = c.params || {};
    const act = this.activity;
    try {
      let result = {};
      switch (c.action) {
        case 'door': {
          const state = await s.door.set(p.action || 'toggle');
          act.add('door', `🚪 Door ${state.on ? 'opened / unlocked' : 'closed / locked'}`, { source: 'dashboard' });
          await this.mirror('door', state);
          result = { state };
          break;
        }
        case 'ac': {
          const state = await s.ac.set(p.changes || {});
          act.add('device', `❄️ AC ${p.changes?.power === false ? 'off' : `${state.mode || ''} ${state.targetTemp != null ? `${state.targetTemp}°` : ''}`.trim()}`, { source: 'dashboard' });
          await this.mirror('ac', state);
          result = { state };
          break;
        }
        case 'light': {
          const state = await s.lights.control(p.device, p.changes || {});
          await this.mirror('lights');
          result = { state };
          break;
        }
        case 'lights.all': {
          await s.lights.all(p.changes || {});
          act.add('device', `💡 All lights ${p.changes?.power === false ? 'off' : 'on'}`, { source: 'dashboard' });
          await this.mirror('lights');
          break;
        }
        case 'switch': {
          const state = await s.switches.set(p.id, p.action || 'toggle');
          act.add('device', `${state.icon} ${state.name} ${state.on ? 'on' : 'off'}`, { source: 'dashboard' });
          await this.mirror('switches');
          result = { state };
          break;
        }
        case 'switches.all': {
          const out = await s.switches.all(p.action || 'off');
          act.add('device', `🔌 All switches ${Object.values(out).every((o) => o.on === false) ? 'off' : 'on'}`, { source: 'dashboard' });
          await this.mirror('switches');
          break;
        }
        case 'scene':
          result = await s.scenes.run(p.id, { source: 'dashboard' });
          await this.mirror('scenes');
          break;
        case 'automation.run':
          result = await s.automations.runNow(p.id);
          await this.mirror('automations');
          break;
        case 'minecraft': {
          const action = ['start', 'stop', 'restart'].includes(p.action) ? p.action : null;
          if (!action) throw new Error(`Unknown Minecraft action "${p.action}"`);
          result = await s.minecraft[action]();
          act.add('minecraft', `⛏️ Minecraft server ${action}`, { source: 'dashboard' });
          setTimeout(() => this.queueMirror('minecraft'), 1500).unref?.();
          break;
        }
        case 'minecraft.rcon':
          result = { command: p.command, output: await s.minecraft.rcon(p.command) };
          break;
        case 'notify': {
          const out = await s.notify.send(p.title || 'Home', p.message || 'Test notification from your dashboard');
          act.add('notify', `📱 Notification sent: ${out.message}`, { source: 'dashboard' });
          result = out;
          break;
        }
        case 'refresh':
          this.mirrored = {};
          await this.mirrorAll();
          break;
        default:
          throw new Error(`Unknown command "${c.action}"`);
      }
      await this.cloud.reply(c, { ok: true, ...result });
    } catch (e) {
      this.log(`command ${c.action} failed: ${e.message}`);
      await this.cloud.reply(c, { ok: false, error: e.message });
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const u of this.unsubs) u?.();
    this.unsubs = [];
    this.services?.automations?.close();
    this.hub.close();
    await this.cloud.leave();
    this.started = false;
  }
}
