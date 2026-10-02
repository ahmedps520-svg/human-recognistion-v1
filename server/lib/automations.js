// Automations: when <trigger> and <conditions> then <actions>.
// Triggers: alarm | presence (someone entered) | empty (room empty for N min) |
// schedule (HH:MM daily) | door (open/close) | armed (armed/disarmed).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.js';
import { runAction } from './scenes.js';

export const DEFAULT_AUTOMATIONS = [
  { id: 'intruder', name: 'Intruder response', icon: '🚨', enabled: true, trigger: { type: 'alarm' }, actions: [{ device: 'lights', all: { power: true, brightness: 100, color: { r: 255, g: 0, b: 0 } } }, { device: 'door', action: 'lock' }, { device: 'notify', title: 'Room Guard', message: 'Alarm: someone is in your room', priority: 'high', tags: ['rotating_light'] }], description: 'Alarm fires: lights red, door locked, phone notified.' },
  { id: 'night', name: 'Night routine', icon: '🌙', enabled: false, trigger: { type: 'schedule', at: '23:00' }, actions: [{ device: 'scene', id: 'sleep' }], description: 'Every day at 23:00 run the Sleep scene.' },
  { id: 'wake', name: 'Wake-up', icon: '🌅', enabled: false, trigger: { type: 'schedule', at: '07:00' }, actions: [{ device: 'scene', id: 'wake' }], description: 'Every day at 07:00 run the Wake up scene.' },
  { id: 'empty', name: 'Empty-room saver', icon: '🍃', enabled: false, trigger: { type: 'empty', minutes: 15 }, actions: [{ device: 'lights', all: { power: false } }, { device: 'ac', set: { power: false } }], description: 'Room empty for 15 minutes: lights and AC off.' },
  { id: 'welcome', name: 'Welcome lights', icon: '👋', enabled: false, trigger: { type: 'presence' }, conditions: { mode: 'home', armed: false }, actions: [{ device: 'lights', all: { power: true, brightness: 70 } }], description: 'Someone enters while in Home mode and disarmed: lights on.' },
  { id: 'visitor', name: 'Visitor alert', icon: '📱', enabled: false, trigger: { type: 'presence' }, conditions: { mode: 'away' }, actions: [{ device: 'notify', title: 'Room Guard', message: 'Someone entered your room while you were away' }], description: 'In Away mode, notify the phone when someone enters.' },
];

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export class AutomationEngine {
  constructor(list, services, { dataDir, hub, activity, now = () => new Date() } = {}) {
    this.rules = (Array.isArray(list) && list.length ? list : DEFAULT_AUTOMATIONS).map((r) => ({ ...r }));
    this.services = services;
    this.hub = hub;
    this.activity = activity;
    this.now = now;
    this.file = path.join(dataDir, 'automations.json');
    this.overrides = this._read();
    for (const r of this.rules) if (this.overrides[r.id]?.enabled !== undefined) r.enabled = this.overrides[r.id].enabled;
    this.lastFired = {};
    this.emptyTimers = new Map();
    this.lastMinute = null;
    this.queue = Promise.resolve();
    this.unsubscribe = hub ? hub.subscribe((ev) => this.handle(ev)) : () => {};
    this.ticker = setInterval(() => this.tick(), 20000);
    this.ticker.unref();
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  _persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.queue = this.queue.then(() => fsp.writeFile(tmp, JSON.stringify(this.overrides)).then(() => fsp.rename(tmp, this.file))).catch(() => {});
    return this.queue;
  }

  list() {
    return this.rules.map((r) => ({ id: r.id, name: r.name, icon: r.icon || '⚙️', enabled: !!r.enabled, trigger: r.trigger, conditions: r.conditions || null, description: r.description || '', actions: (r.actions || []).length, lastFired: this.lastFired[r.id] || null }));
  }

  setEnabled(id, enabled) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new HttpError(404, `Unknown automation "${id}"`);
    r.enabled = !!enabled;
    this.overrides[id] = { enabled: r.enabled };
    this._persist();
    this.activity?.add('automation', `${r.icon || ''} "${r.name}" ${r.enabled ? 'enabled' : 'disabled'}`, { automation: id });
    this.hub?.broadcast({ type: 'automations', at: Date.now() });
    return this.list().find((x) => x.id === id);
  }

  _conditionsMet(rule) {
    const c = rule.conditions || {};
    const presence = this.services.camera?.presence || {};
    if (c.mode && this.services.home?.mode !== c.mode) return false;
    if (c.armed !== undefined && !!presence.armed !== !!c.armed) return false;
    if (c.between) {
      const [from, to] = c.between;
      const t = hhmm(this.now());
      const inside = from <= to ? t >= from && t <= to : t >= from || t <= to;
      if (!inside) return false;
    }
    return true;
  }

  async fire(rule, { source = 'trigger', force = false } = {}) {
    if (!force && !rule.enabled) return null;
    if (!force && !this._conditionsMet(rule)) return null;
    const nowMs = this.now().getTime();
    const last = this.lastFiredMs?.[rule.id] || 0;
    if (!force && nowMs - last < 30000) return null; // debounce bursts
    this.lastFiredMs = { ...(this.lastFiredMs || {}), [rule.id]: nowMs };
    this.lastFired[rule.id] = new Date(nowMs).toISOString();
    const results = [];
    for (const action of rule.actions || []) results.push(await runAction(action, this.services));
    const failed = results.filter((r) => !r.ok);
    this.activity?.add('automation', `${rule.icon || ''} "${rule.name}" ran${failed.length ? ` (${failed.length} step${failed.length > 1 ? 's' : ''} skipped)` : ''}`, { automation: rule.id, source, failed: failed.map((f) => f.error) });
    this.hub?.broadcast({ type: 'automation', id: rule.id, name: rule.name, results, at: Date.now() });
    return { id: rule.id, results, failed: failed.length };
  }

  async runNow(id) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new HttpError(404, `Unknown automation "${id}"`);
    return this.fire(r, { source: 'manual', force: true });
  }

  /** React to a hub event. Resolves once every triggered rule has run. */
  handle(ev) {
    const fired = [];
    if (ev.type === 'alarm') for (const r of this.rules) if (r.trigger?.type === 'alarm') fired.push(this.fire(r, { source: 'alarm' }));
    if (ev.type === 'presence' && ev.state === 'enter') {
      for (const [id, t] of this.emptyTimers) {
        clearTimeout(t);
        this.emptyTimers.delete(id);
      }
      for (const r of this.rules) if (r.trigger?.type === 'presence') fired.push(this.fire(r, { source: 'presence' }));
    }
    if (ev.type === 'presence' && ev.state === 'leave') {
      for (const r of this.rules) {
        if (r.trigger?.type !== 'empty') continue;
        const ms = Math.max(1, Number(r.trigger.minutes) || 15) * 60000;
        clearTimeout(this.emptyTimers.get(r.id));
        const t = setTimeout(() => {
          this.emptyTimers.delete(r.id);
          if ((this.services.camera?.presence?.people || 0) === 0) this.fire(r, { source: 'empty' });
        }, ms);
        t.unref?.();
        this.emptyTimers.set(r.id, t);
      }
    }
    if (ev.type === 'door') for (const r of this.rules) if (r.trigger?.type === 'door' && (r.trigger.state === undefined || (r.trigger.state === 'open') === !!ev.state?.on)) fired.push(this.fire(r, { source: 'door' }));
    if (ev.type === 'armed') for (const r of this.rules) if (r.trigger?.type === 'armed' && (r.trigger.armed === undefined || !!r.trigger.armed === !!ev.armed)) fired.push(this.fire(r, { source: 'armed' }));
    const done = Promise.all(fired);
    done.catch((e) => console.error('automation failed', e));
    return done;
  }

  /** Schedules: fire rules whose HH:MM matches the current minute (once per minute). Resolves when they have run. */
  tick(date = this.now()) {
    const minute = hhmm(date);
    const key = `${date.toDateString()} ${minute}`;
    if (key === this.lastMinute) return Promise.resolve([]);
    this.lastMinute = key;
    const fired = [];
    for (const r of this.rules) if (r.trigger?.type === 'schedule' && r.trigger.at === minute) fired.push(this.fire(r, { source: 'schedule' }));
    const done = Promise.all(fired);
    done.catch((e) => console.error('automation failed', e));
    return done;
  }

  close() {
    clearInterval(this.ticker);
    for (const t of this.emptyTimers.values()) clearTimeout(t);
    this.unsubscribe();
  }
}
