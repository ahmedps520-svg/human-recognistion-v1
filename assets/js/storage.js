// Persistence: the cloud project (Postgres tables + Storage bucket) when the
// user is signed in, otherwise localStorage + IndexedDB so the app is fully
// usable offline.

import { LOCAL_KEYS, localGet, localSet } from './settings.js';
import { profileFromRow, profileToRow, eventFromRow, eventToRow, eventPatchToRow as patchToRow } from './rows.js';

const BUCKET = 'clips';
const IDB_NAME = 'hr-clips';
const IDB_STORE = 'clips';
const LOCAL_EVENT_CAP = 200;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ---------- IndexedDB for local clips ----------
function openIdb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, blob) {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(key) {
  const db = await openIdb();
  const val = await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return val;
}

async function idbDelete(key) {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export class Store {
  constructor() {
    this.client = null;
    this.mode = 'local';
    this.user = null;
    this.listeners = new Set();
    this.objectUrls = new Map();
    this.lastError = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  /**
   * Use the cloud client (shared with the Cloud link) or fall back to this
   * browser's storage. Returns the active mode: supabase | local.
   */
  async configure({ client = null } = {}) {
    this.lastError = null;
    this._unsubAuth?.();
    this._unsubAuth = null;
    if (client) {
      this.client = client;
      this.mode = 'supabase';
      try {
        const { data } = await client.auth.getSession();
        this.user = data?.session?.user ?? null;
        const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
          this.user = session?.user ?? null;
          this._emit();
        });
        this._unsubAuth = () => sub?.subscription?.unsubscribe?.();
      } catch (e) {
        this.lastError = e;
        this.user = null;
      }
    } else {
      this.client = null;
      this.mode = 'local';
      this.user = null;
    }
    this._emit();
    return this.mode;
  }

  get remote() {
    return this.mode === 'supabase' && !!this.client;
  }

  /** True when writes will succeed: local mode, or signed in to Supabase. */
  get ready() {
    return !this.remote || !!this.user;
  }

  _throw(error, what) {
    const err = new Error(`${what}: ${error.message || error}`);
    err.cause = error;
    this.lastError = err;
    throw err;
  }

  // ---------- profiles ----------
  async listProfiles() {
    if (this.remote && this.user) {
      const { data, error } = await this.client.from('profiles').select('*').order('created_at', { ascending: true });
      if (error) this._throw(error, 'Loading people failed');
      const profiles = data.map(profileFromRow);
      localSet(LOCAL_KEYS.profiles, profiles); // cache for offline
      return profiles;
    }
    return localGet(LOCAL_KEYS.profiles, []);
  }

  async saveProfile(profile) {
    const p = { ...profile, id: profile.id || uuid() };
    if (this.remote && this.user) {
      const { data, error } = await this.client.from('profiles').upsert(profileToRow(p)).select().single();
      if (error) this._throw(error, 'Saving person failed');
      return profileFromRow(data);
    }
    const all = localGet(LOCAL_KEYS.profiles, []);
    const idx = all.findIndex((x) => x.id === p.id);
    p.updatedAt = new Date().toISOString();
    if (idx >= 0) all[idx] = p;
    else {
      p.createdAt = p.updatedAt;
      all.push(p);
    }
    localSet(LOCAL_KEYS.profiles, all);
    return p;
  }

  async deleteProfile(id) {
    if (this.remote && this.user) {
      const { error } = await this.client.from('profiles').delete().eq('id', id);
      if (error) this._throw(error, 'Deleting person failed');
    }
    localSet(LOCAL_KEYS.profiles, localGet(LOCAL_KEYS.profiles, []).filter((x) => x.id !== id));
  }

  // ---------- events ----------
  async listEvents({ limit = 60 } = {}) {
    if (this.remote && this.user) {
      const { data, error } = await this.client
        .from('events')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) this._throw(error, 'Loading events failed');
      return data.map(eventFromRow);
    }
    return localGet(LOCAL_KEYS.events, []).slice(0, limit);
  }

  async insertEvent(event) {
    const e = { ...event, id: event.id || uuid() };
    if (this.remote && this.user) {
      const { data, error } = await this.client.from('events').insert(eventToRow(e)).select().single();
      if (error) this._throw(error, 'Saving event failed');
      return eventFromRow(data);
    }
    const all = localGet(LOCAL_KEYS.events, []);
    all.unshift(e);
    if (all.length > LOCAL_EVENT_CAP) {
      for (const old of all.splice(LOCAL_EVENT_CAP)) {
        for (const path of new Set([old.clipPath, ...(old.clipPaths || []), old.snapshotPath])) if (path) idbDelete(path).catch(() => {});
      }
    }
    localSet(LOCAL_KEYS.events, all);
    return e;
  }

  async updateEvent(id, patch) {
    if (this.remote && this.user) {
      const { data, error } = await this.client.from('events').update(patchToRow(patch)).eq('id', id).select().single();
      if (error) this._throw(error, 'Updating event failed');
      return eventFromRow(data);
    }
    const all = localGet(LOCAL_KEYS.events, []);
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], ...patch };
    localSet(LOCAL_KEYS.events, all);
    return all[idx];
  }

  async deleteEvent(event) {
    if (this.remote && this.user) {
      const { error } = await this.client.from('events').delete().eq('id', event.id);
      if (error) this._throw(error, 'Deleting event failed');
      const paths = [...new Set([event.clipPath, ...(event.clipPaths || []), event.snapshotPath].filter(Boolean))];
      if (paths.length) await this.client.storage.from(BUCKET).remove(paths);
      return;
    }
    localSet(LOCAL_KEYS.events, localGet(LOCAL_KEYS.events, []).filter((x) => x.id !== event.id));
    for (const p of new Set([event.clipPath, ...(event.clipPaths || []), event.snapshotPath])) if (p) idbDelete(p).catch(() => {});
  }

  // ---------- media ----------
  /** Upload a clip or snapshot. Returns the storage path. */
  async uploadMedia(blob, path, contentType) {
    if (this.remote && this.user) {
      const { error } = await this.client.storage.from(BUCKET).upload(path, blob, { contentType, upsert: true });
      if (error) this._throw(error, 'Upload failed');
      return path;
    }
    await idbPut(path, blob);
    return path;
  }

  /** Resolve a storage path to a URL the <video>/<img> can load. */
  async mediaUrl(path) {
    if (!path) return null;
    if (this.remote && this.user) {
      const { data, error } = await this.client.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (error) this._throw(error, 'Could not get media link');
      return data.signedUrl;
    }
    if (this.objectUrls.has(path)) return this.objectUrls.get(path);
    const blob = await idbGet(path).catch(() => null);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.objectUrls.set(path, url);
    return url;
  }

  // ---------- cameras / calibration ----------
  async loadCalibration(cameraLabel) {
    if (this.remote && this.user && cameraLabel) {
      const { data, error } = await this.client.from('cameras').select('calibration').eq('label', cameraLabel).maybeSingle();
      if (!error && data?.calibration) {
        localSet(LOCAL_KEYS.calibration, data.calibration);
        return data.calibration;
      }
    }
    return localGet(LOCAL_KEYS.calibration);
  }

  async saveCalibration(cameraLabel, calibration) {
    localSet(LOCAL_KEYS.calibration, calibration);
    if (this.remote && this.user && cameraLabel) {
      const { error } = await this.client
        .from('cameras')
        .upsert({ label: cameraLabel, calibration, updated_at: new Date().toISOString() }, { onConflict: 'label' });
      if (error) this._throw(error, 'Saving calibration failed');
    }
    return calibration;
  }
}

export function clipPathFor(date, extension, verdict, name) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const safe = (name || verdict || 'person').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${d.getDate().toString().padStart(2, '0')}/${stamp}-${safe}.${extension}`;
}
