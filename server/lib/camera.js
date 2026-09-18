// Camera side of the home server: the latest frame pushed by the Room Guard
// tab (served back as JPEG or an MJPEG stream), presence, the visit log,
// clips/snapshots on disk, profiles and calibration, and commands sent back
// to the camera tab (arm / disarm) over SSE.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const EVENT_CAP = 2000;
const uuid = () => crypto.randomUUID();

function readJsonFile(file, fallback) {
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

export class CameraService {
  constructor({ dataDir, hub }) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'media');
    this.hub = hub;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.files = {
      events: path.join(dataDir, 'events.json'),
      profiles: path.join(dataDir, 'profiles.json'),
      cameras: path.join(dataDir, 'cameras.json'),
    };
    this.events = readJsonFile(this.files.events, []);
    this.profiles = readJsonFile(this.files.profiles, []);
    this.cameras = readJsonFile(this.files.cameras, {});
    this.frame = null; // { buffer, at, meta }
    this.presence = { people: 0, armed: false, recording: false, tracks: [] };
    this.presenceAt = 0;
    this.streams = new Set();
    this.writeQueue = Promise.resolve();
  }

  _persist(name) {
    const value = name === 'events' ? this.events : name === 'profiles' ? this.profiles : this.cameras;
    this.writeQueue = this.writeQueue.then(() => writeJsonAtomic(this.files[name], value)).catch((e) => console.error('persist failed', e));
    return this.writeQueue;
  }

  // ---------------- live frame ----------------
  setFrame(buffer, meta = {}) {
    if (!buffer?.length) throw new HttpError(400, 'Empty frame');
    this.frame = { buffer, at: Date.now(), meta };
    if (meta && typeof meta === 'object' && ('people' in meta || 'armed' in meta)) this.setPresence(meta);
    for (const res of this.streams) this._writeMjpegFrame(res, buffer);
    this.hub.broadcast({ type: 'camera', at: this.frame.at, presence: this.presence });
  }

  setPresence(p) {
    this.presence = {
      people: Number(p.people) || 0,
      armed: !!p.armed,
      recording: !!p.recording,
      mode: p.mode || this.presence.mode || 'presence',
      tracks: Array.isArray(p.tracks) ? p.tracks.slice(0, 10) : [],
    };
    this.presenceAt = Date.now();
  }

  status() {
    const now = Date.now();
    return {
      online: !!this.frame && now - this.frame.at < 15000,
      lastFrameAt: this.frame?.at || null,
      presence: this.presence,
      presenceAt: this.presenceAt || null,
      visitsToday: this.events.filter((e) => new Date(e.startedAt).toDateString() === new Date().toDateString()).length,
      lastVisit: this.events[0] || null,
    };
  }

  // Browsers display a multipart part only when the following part begins, so
  // every frame is written twice: the duplicate makes the first copy show at
  // once (the displayed picture is always the newest frame either way).
  _writeMjpegFrame(res, buffer) {
    try {
      const head = `Content-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`;
      res.write(head);
      res.write(buffer);
      res.write('\r\n--frame\r\n');
      res.write(head);
      res.write(buffer);
      res.write('\r\n--frame\r\n');
    } catch {
      this.streams.delete(res);
    }
  }

  streamMjpeg(req, res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      Pragma: 'no-cache',
    });
    res.write('--frame\r\n');
    this.streams.add(res);
    if (this.frame) this._writeMjpegFrame(res, this.frame.buffer);
    req.on('close', () => this.streams.delete(res));
  }

  command(action, payload = {}) {
    const allowed = ['arm', 'disarm', 'snapshot', 'stop', 'start'];
    if (!allowed.includes(action)) throw new HttpError(400, `Unknown command "${action}"`);
    const cmd = { type: 'command', action, payload, at: Date.now(), id: uuid() };
    this.hub.broadcast(cmd);
    return cmd;
  }

  // ---------------- visits ----------------
  listEvents({ limit = 60 } = {}) {
    return this.events.slice(0, Math.max(1, Math.min(500, limit)));
  }

  insertEvent(event) {
    if (!event || typeof event !== 'object') throw new HttpError(400, 'Event body required');
    const e = { ...event, id: event.id || uuid(), startedAt: event.startedAt || new Date().toISOString() };
    const idx = this.events.findIndex((x) => x.id === e.id);
    if (idx >= 0) this.events[idx] = e;
    else this.events.unshift(e);
    if (this.events.length > EVENT_CAP) {
      for (const old of this.events.splice(EVENT_CAP)) this._deleteMediaOf(old);
    }
    this._persist('events');
    this.hub.broadcast({ type: 'visit', action: 'insert', event: e });
    return e;
  }

  updateEvent(id, patch) {
    const idx = this.events.findIndex((x) => x.id === id);
    if (idx < 0) throw new HttpError(404, 'Event not found');
    this.events[idx] = { ...this.events[idx], ...patch, id };
    this._persist('events');
    this.hub.broadcast({ type: 'visit', action: 'update', event: this.events[idx] });
    return this.events[idx];
  }

  deleteEvent(id) {
    const idx = this.events.findIndex((x) => x.id === id);
    if (idx < 0) throw new HttpError(404, 'Event not found');
    const [event] = this.events.splice(idx, 1);
    this._deleteMediaOf(event);
    this._persist('events');
    this.hub.broadcast({ type: 'visit', action: 'delete', id });
    return event;
  }

  _deleteMediaOf(event) {
    for (const p of new Set([event.clipPath, ...(event.clipPaths || []), event.snapshotPath])) {
      if (!p) continue;
      fsp.unlink(this.mediaPath(p)).catch(() => {});
    }
  }

  // ---------------- media ----------------
  mediaPath(relPath) {
    const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.includes('..') || !/^[A-Za-z0-9_\-./]+$/.test(clean)) throw new HttpError(400, 'Bad media path');
    const abs = path.resolve(this.mediaDir, clean);
    if (!abs.startsWith(this.mediaDir + path.sep) && abs !== this.mediaDir) throw new HttpError(400, 'Bad media path');
    return abs;
  }

  async saveMedia(relPath, buffer) {
    const abs = this.mediaPath(relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buffer);
    return { path: relPath, bytes: buffer.length };
  }

  // ---------------- profiles / calibration ----------------
  getProfiles() {
    return this.profiles;
  }

  setProfiles(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Profiles must be an array');
    this.profiles = list;
    this._persist('profiles');
    return this.profiles;
  }

  getCalibration(label) {
    return this.cameras[label || 'default']?.calibration ?? null;
  }

  setCalibration(label, calibration) {
    const key = label || 'default';
    this.cameras[key] = { label: key, calibration: calibration ?? null, updatedAt: new Date().toISOString() };
    this._persist('cameras');
    return this.cameras[key].calibration;
  }

  async flush() {
    await this.writeQueue;
  }
}
