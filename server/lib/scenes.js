// Scenes: named bundles of device actions, run from the dashboard or by
// automations. Also hosts the shared action runner.
import { HttpError } from './http.js';

export const DEFAULT_SCENES = [
  { id: 'home', name: "I'm home", icon: '🏠', mode: 'home', actions: [{ device: 'camera', command: 'disarm' }, { device: 'door', action: 'unlock' }, { device: 'lights', all: { power: true, brightness: 70, colorTempK: 3500 } }] },
  { id: 'wake', name: 'Wake up', icon: '🌅', mode: 'home', actions: [{ device: 'lights', all: { power: true, brightness: 60, colorTempK: 3000 } }, { device: 'ac', set: { power: false } }, { device: 'camera', command: 'disarm' }] },
  { id: 'focus', name: 'Focus', icon: '💡', actions: [{ device: 'lights', all: { power: true, brightness: 100, colorTempK: 5000 } }] },
  { id: 'movie', name: 'Movie', icon: '🎬', actions: [{ device: 'lights', all: { power: true, brightness: 15, color: { r: 40, g: 60, b: 255 } } }, { device: 'ac', set: { power: true, mode: 'cool', targetTemp: 23 } }] },
  { id: 'sleep', name: 'Sleep', icon: '🌙', mode: 'sleep', actions: [{ device: 'lights', all: { power: false } }, { device: 'ac', set: { power: true, mode: 'cool', targetTemp: 24 } }, { device: 'door', action: 'lock' }, { device: 'camera', command: 'arm' }] },
  { id: 'away', name: 'Away', icon: '🧳', mode: 'away', actions: [{ device: 'lights', all: { power: false } }, { device: 'switches', all: 'off' }, { device: 'ac', set: { power: false } }, { device: 'door', action: 'lock' }, { device: 'camera', command: 'arm' }] },
];

/** Execute one action against the services. Never throws; returns { ok, error? }. */
export async function runAction(action, services, { depth = 0 } = {}) {
  const { lights, ac, door, switches, camera, notify, home, scenes, minecraft, hub } = services;
  const tell = (event) => hub?.broadcast({ ...event, at: Date.now(), source: 'scene' });
  try {
    switch (action.device) {
      case 'lights':
        if (action.all) await lights.all(action.all);
        else if (action.id) await lights.control(action.id, action.set || {});
        else throw new Error('lights action needs "all" or "id"');
        tell({ type: 'lights' });
        break;
      case 'ac': {
        const state = await ac.set(action.set || {});
        tell({ type: 'ac', state });
        break;
      }
      case 'door': {
        const state = await door.set(action.action || 'toggle');
        tell({ type: 'door', state });
        break;
      }
      case 'switch': {
        const state = await switches.set(action.id, action.action || 'toggle');
        tell({ type: 'switches', id: state.id, state });
        break;
      }
      case 'switches':
        await switches.all(action.all || 'off');
        tell({ type: 'switches' });
        break;
      case 'camera':
        camera.command(action.command || 'arm', action.payload || {});
        break;
      case 'notify':
        await notify.send(action.title || 'Home', action.message || '', { priority: action.priority || 'default', tags: action.tags || [] });
        break;
      case 'mode':
        home.setMode(action.mode, { source: 'scene' });
        break;
      case 'scene':
        if (depth > 2) throw new Error('scene nesting too deep');
        await scenes.run(action.id, { source: 'scene', depth: depth + 1 });
        break;
      case 'minecraft':
        await minecraft[action.action === 'stop' ? 'stop' : action.action === 'restart' ? 'restart' : 'start']();
        tell({ type: 'minecraft', action: action.action || 'start' });
        break;
      default:
        throw new Error(`Unknown device "${action.device}"`);
    }
    return { ok: true, action };
  } catch (e) {
    return { ok: false, action, error: e.message };
  }
}

export class ScenesService {
  constructor(list, services, { activity, hub } = {}) {
    this.scenes = Array.isArray(list) && list.length ? list : DEFAULT_SCENES;
    this.services = services;
    this.activity = activity;
    this.hub = hub;
    this.lastRun = {};
  }

  list() {
    return this.scenes.map((s) => ({ id: s.id, name: s.name, icon: s.icon || '✨', mode: s.mode || null, actions: s.actions.length, lastRun: this.lastRun[s.id] || null }));
  }

  async run(id, { source = 'dashboard', depth = 0 } = {}) {
    const scene = this.scenes.find((s) => s.id === id);
    if (!scene) throw new HttpError(404, `Unknown scene "${id}"`);
    const results = [];
    for (const action of scene.actions || []) results.push(await runAction(action, { ...this.services, scenes: this }, { depth }));
    if (scene.mode) this.services.home.setMode(scene.mode, { source: `scene:${scene.id}` });
    const failed = results.filter((r) => !r.ok);
    this.lastRun[id] = new Date().toISOString();
    this.activity?.add('scene', `${scene.icon || ''} Scene "${scene.name}" ran${failed.length ? ` (${failed.length} step${failed.length > 1 ? 's' : ''} skipped)` : ''}`, { scene: id, source, failed: failed.map((f) => f.error) });
    this.hub?.broadcast({ type: 'scene', id, name: scene.name, results, at: Date.now() });
    return { id, name: scene.name, results, failed: failed.length };
  }
}
