// Room-wide state (mode) and the activity timeline, both persisted on disk.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.js';

export const MODES = ['home', 'away', 'sleep', 'guest'];
const ACTIVITY_CAP = 500;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

export class HomeState {
  constructor({ dataDir, hub }) {
    this.file = path.join(dataDir, 'state.json');
    this.hub = hub;
    const saved = readJson(this.file, {});
    this.mode = MODES.includes(saved.mode) ? saved.mode : 'home';
    this.modeSince = saved.modeSince || new Date().toISOString();
    this.queue = Promise.resolve();
  }

  get() {
    return { mode: this.mode, modeSince: this.modeSince, modes: MODES };
  }

  setMode(mode, { source = 'dashboard' } = {}) {
    if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
    const changed = mode !== this.mode;
    this.mode = mode;
    if (changed) this.modeSince = new Date().toISOString();
    this.queue = this.queue.then(() => writeJsonAtomic(this.file, { mode: this.mode, modeSince: this.modeSince })).catch(() => {});
    this.hub.broadcast({ type: 'mode', mode: this.mode, modeSince: this.modeSince, source, at: Date.now() });
    return this.get();
  }

  flush() {
    return this.queue;
  }
}

export class ActivityLog {
  constructor({ dataDir, hub }) {
    this.file = path.join(dataDir, 'activity.json');
    this.hub = hub;
    this.items = readJson(this.file, []);
    this.queue = Promise.resolve();
  }

  /** kinds: visit | alarm | door | scene | automation | mode | device | notify | minecraft | system */
  add(kind, text, extra = {}) {
    const entry = { at: new Date().toISOString(), kind, text, ...extra };
    this.items.unshift(entry);
    if (this.items.length > ACTIVITY_CAP) this.items.length = ACTIVITY_CAP;
    this.queue = this.queue.then(() => writeJsonAtomic(this.file, this.items)).catch(() => {});
    this.hub.broadcast({ type: 'activity', entry });
    return entry;
  }

  list({ limit = 50 } = {}) {
    return this.items.slice(0, Math.max(1, Math.min(500, limit)));
  }

  flush() {
    return this.queue;
  }
}
