// Persistence: Supabase (Postgres tables + Storage bucket) when configured,
// otherwise localStorage + IndexedDB so the app is fully usable offline.

import { LOCAL_KEYS, localGet, localSet } from './settings.js';

const BUCKET = 'clips';
const IDB_NAME = 'hr-clips';
const IDB_STORE = 'clips';
const LOCAL_EVENT_CAP = 200;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ---------- row <-> object mapping ----------
const profileFromRow = (r) => ({
  id: r.id,
  name: r.name,
  heightCm: r.height_cm == null ? null : Number(r.height_cm),
  weightKg: r.weight_kg == null ? null : Number(r.weight_kg),
  hairLength: r.hair_length || 'short',
  faceDescriptors: Array.isArray(r.face_descriptors) ? r.face_descriptors : [],
  samples: Array.isArray(r.samples) ? r.samples : [],
  color: r.color || '#4ade80',
  alertOnEnter: !!r.alert_on_enter,
  notes: r.notes || '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const profileToRow = (p) => ({
  id: p.id,
  name: p.name,
  height_cm: p.heightCm ?? null,
  weight_kg: p.weightKg ?? null,
  hair_length: p.hairLength || 'short',
  face_descriptors: p.faceDescriptors || [],
  samples: p.samples || [],
  color: p.color || '#4ade80',
  alert_on_enter: !!p.alertOnEnter,
  notes: p.notes || '',
  updated_at: new Date().toISOString(),
});

const eventFromRow = (r) => ({
  id: r.id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  verdict: r.verdict,
  personId: r.person_id,
  personName: r.person_name,
  confidence: r.confidence == null ? null : Number(r.confidence),
  features: r.features || {},
  clipPath: r.clip_path,
  snapshotPath: r.snapshot_path,
  alarmTriggered: !!r.alarm_triggered,
  lockTriggered: !!r.lock_triggered,
  confirmedPersonId: r.confirmed_person_id,
  cameraLabel: r.camera_label,
});

const eventToRow = (e) => ({
  id: e.id,
  started_at: e.startedAt,
  ended_at: e.endedAt ?? null,
  verdict: e.verdict,
  person_id: e.personId ?? null,
  person_name: e.personName ?? null,
  confidence: e.confidence ?? null,
  features: e.features || {},
  clip_path: e.clipPath ?? null,
  snapshot_path: e.snapshotPath ?? null,
  alarm_triggered: !!e.alarmTriggered,
  lock_triggered: !!e.lockTriggered,
  confirmed_person_id: e.confirmedPersonId ?? null,
  camera_label: e.cameraLabel ?? null,
});

const patchToRow = (patch) => {
  const row = eventToRow(patch);
  const out = {};
  const keys = {
    endedAt: 'ended_at', verdict: 'verdict', personId: 'person_id', personName: 'person_name', confidence: 'confidence',
    features: 'features', clipPath: 'clip_path', snapshotPath: 'snapshot_path', alarmTriggered: 'alarm_triggered',
    lockTriggered: 'lock_triggered', confirmedPersonId: 'confirmed_person_id', cameraLabel: 'camera_label',
  };
  for (const [k, col] of Object.entries(keys)) if (k in patch) out[col] = row[col];
  return out;
};

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

  /** (Re)configure from settings. Returns the active mode. */
  async configure({ supabaseUrl, supabaseAnonKey }) {
    this.lastError = null;
    if (supabaseUrl && supabaseAnonKey && window.supabase?.createClient) {
      try {
        this.client = window.supabase.createClient(supabaseUrl.trim(), supabaseAnonKey.trim(), {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        });
        this.mode = 'supabase';
        const { data } = await this.client.auth.getSession();
        this.user = data?.session?.user ?? null;
        this.client.auth.onAuthStateChange((_event, session) => {
          this.user = session?.user ?? null;
          this._emit();
        });
      } catch (e) {
        this.lastError = e;
        this.client = null;
        this.mode = 'local';
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

  async signIn(email, password) {
    if (!this.remote) throw new Error('Supabase is not configured');
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    this._emit();
    return data.user;
  }

  async signOut() {
    if (!this.remote) return;
    await this.client.auth.signOut();
    this.user = null;
    this._emit();
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
        if (old.clipPath) idbDelete(old.clipPath).catch(() => {});
        if (old.snapshotPath) idbDelete(old.snapshotPath).catch(() => {});
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
      const paths = [event.clipPath, event.snapshotPath].filter(Boolean);
      if (paths.length) await this.client.storage.from(BUCKET).remove(paths);
      return;
    }
    localSet(LOCAL_KEYS.events, localGet(LOCAL_KEYS.events, []).filter((x) => x.id !== event.id));
    for (const p of [event.clipPath, event.snapshotPath]) if (p) idbDelete(p).catch(() => {});
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
