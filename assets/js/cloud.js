// The cloud link. One Supabase project ties everything together: the camera
// app on the iPad, the dashboard on any phone or laptop, and the home agent on
// the PC that talks to the real devices. Each of them signs in with the same
// email + password; nothing else to configure.
//
// Runs in the browser (window.supabase from the vendored UMD build) and in
// Node (pass createClient from @supabase/supabase-js).
//
// Durable state lives in tables: home (mode, armed, alarm), device_states
// (mirrored by the agent), activity (timeline), events (visits, clips).
// Live state goes over one realtime channel: presence (who is online and the
// camera's current picture of the room), broadcast "command" / "result"
// (dashboard -> camera or agent), "rtc" (WebRTC signalling for the live video)
// and "frame" (JPEG snapshots when WebRTC is not connected).

import { eventFromRow, homeFromRow, homePatchToRow, defaultHome, activityFromRow } from './rows.js';

export const CLOUD_KEY = 'hr.cloud.v1';
export const CHANNEL = 'room';
const BROADCAST_EVENTS = ['command', 'result', 'rtc', 'frame'];
const TABLES = ['home', 'device_states', 'activity', 'events'];
const TRACK_MIN_MS = 700;

const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const hasStorage = () => typeof localStorage !== 'undefined';

/** Project URL + anon key: baked into config.js, else saved on this device from the sign-in screen. */
export function readCloudConfig(baked = {}) {
  let local = null;
  try {
    local = hasStorage() ? JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null') : null;
  } catch {
    local = null;
  }
  const bakedOk = !!(baked.supabaseUrl && baked.supabaseAnonKey);
  const url = String((bakedOk ? baked.supabaseUrl : local?.url) || '').trim().replace(/\/$/, '');
  const anonKey = String((bakedOk ? baked.supabaseAnonKey : local?.anonKey) || '').trim();
  return { url, anonKey, configured: !!(url && anonKey), source: bakedOk ? 'baked' : url && anonKey ? 'local' : null };
}

export function saveCloudConfig({ url, anonKey }) {
  if (!hasStorage()) return false;
  const clean = { url: String(url || '').trim().replace(/\/$/, ''), anonKey: String(anonKey || '').trim() };
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|red)$/i.test(clean.url) && !/^https?:\/\//i.test(clean.url)) throw new Error('The project URL should look like https://xxxx.supabase.co');
  if (clean.anonKey.length < 20) throw new Error('That does not look like the anon key (it is a long string starting with "eyJ" or "sb_publishable_")');
  localStorage.setItem(CLOUD_KEY, JSON.stringify(clean));
  return true;
}

export function clearCloudConfig() {
  if (hasStorage()) localStorage.removeItem(CLOUD_KEY);
}

/** Turn Supabase's auth errors into something a person can act on. */
export function friendlyAuthError(error) {
  const msg = String(error?.message || error || 'Sign-in failed');
  if (/invalid login credentials|invalid_credentials/i.test(msg)) return 'Wrong email or password.';
  if (/email not confirmed/i.test(msg)) return 'This user is not confirmed yet. In Supabase open Authentication → Users, pick the user and confirm the email.';
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) return 'Could not reach the cloud project. Check the internet connection and the project URL.';
  if (/invalid api key|apikey/i.test(msg)) return 'The anon key is not accepted by this project. Copy it again from Supabase → Settings → API.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  return msg;
}

const wrap = (error, what) => {
  const e = new Error(`${what}: ${error?.message || error}`);
  e.cause = error;
  return e;
};

export class Cloud {
  /**
   * @param {object} o
   * @param {string} [o.url] project URL
   * @param {string} [o.anonKey] anon (public) key
   * @param {Function} [o.createClient] supabase-js createClient (defaults to window.supabase.createClient)
   * @param {object} [o.client] an already created client
   * @param {'camera'|'dashboard'|'agent'} [o.role]
   * @param {object} [o.storage] auth storage adapter (Node: file based)
   */
  constructor({ url, anonKey, createClient = globalThis.supabase?.createClient, client = null, role = 'dashboard', storage } = {}) {
    if (!client) {
      if (!createClient) throw new Error('supabase-js is not loaded');
      if (!url || !anonKey) throw new Error('Cloud project URL and anon key are required');
      client = createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, ...(storage ? { storage } : {}) },
        realtime: { params: { eventsPerSecond: 20 } },
      });
    }
    this.client = client;
    this.role = role;
    this.id = `${role}-${uuid().slice(0, 8)}`;
    this.user = null;
    this.channel = null;
    this.status = 'idle'; // idle | joining | live | error | closed
    this.handlers = new Map();
    this.tableHandlers = new Map();
    this.presence = { camera: null, agent: null, dashboards: [], all: [] };
    this.presenceListeners = new Set();
    this.authListeners = new Set();
    this.statusListeners = new Set();
    this.lastTracked = null;
    this.trackTimer = null;
    this.trackedAt = 0;
    this.pendingMeta = null;
    this.pendingCommands = new Map();
    this._authSub = null;
  }

  // ---------------------------------------------------------------- auth
  async init() {
    const { data } = await this.client.auth.getSession();
    this.user = data?.session?.user ?? null;
    if (!this._authSub) {
      const { data: sub } = this.client.auth.onAuthStateChange((event, session) => {
        const was = this.user?.id;
        this.user = session?.user ?? null;
        if (was !== this.user?.id) for (const fn of this.authListeners) fn(this.user, event);
      });
      this._authSub = sub?.subscription || null;
    }
    return this.user;
  }

  onAuth(fn) {
    this.authListeners.add(fn);
    return () => this.authListeners.delete(fn);
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email: String(email || '').trim(), password });
    if (error) throw new Error(friendlyAuthError(error));
    this.user = data.user;
    return data.user;
  }

  async signOut() {
    await this.leave();
    await this.client.auth.signOut().catch(() => {});
    this.user = null;
  }

  get signedIn() {
    return !!this.user;
  }

  // ---------------------------------------------------------------- tables
  async getHome() {
    const { data, error } = await this.client.from('home').select('*').eq('id', 'main').maybeSingle();
    if (error) throw wrap(error, 'Loading the room state failed');
    return data ? homeFromRow(data) : defaultHome();
  }

  /** Partial update of the single home row (mode, armed, alarm, roomName, automations). */
  async setHome(patch) {
    const row = { ...homePatchToRow(patch), id: 'main', updated_at: new Date().toISOString() };
    if ('mode' in patch && !('modeSince' in patch)) row.mode_since = row.updated_at;
    const { data, error } = await this.client.from('home').upsert(row, { onConflict: 'id' }).select().single();
    if (error) throw wrap(error, 'Saving the room state failed');
    return homeFromRow(data);
  }

  async listDevices() {
    const { data, error } = await this.client.from('device_states').select('*');
    if (error) throw wrap(error, 'Loading devices failed');
    const out = {};
    for (const r of data || []) out[r.device] = { ...(r.state || {}), updatedAt: r.updated_at };
    return out;
  }

  async setDevice(device, state) {
    const { error } = await this.client.from('device_states').upsert({ device, state, updated_at: new Date().toISOString() }, { onConflict: 'device' });
    if (error) throw wrap(error, `Saving ${device} failed`);
    return state;
  }

  async addActivity(kind, text, meta = {}) {
    const { data, error } = await this.client.from('activity').insert({ kind, text, meta }).select().single();
    if (error) throw wrap(error, 'Saving activity failed');
    return activityFromRow(data);
  }

  async listActivity(limit = 30) {
    const { data, error } = await this.client.from('activity').select('*').order('at', { ascending: false }).limit(limit);
    if (error) throw wrap(error, 'Loading activity failed');
    return (data || []).map(activityFromRow);
  }

  async listEvents(limit = 8) {
    const { data, error } = await this.client.from('events').select('*').order('started_at', { ascending: false }).limit(limit);
    if (error) throw wrap(error, 'Loading visits failed');
    return (data || []).map(eventFromRow);
  }

  async countEventsSince(iso) {
    const { count, error } = await this.client.from('events').select('id', { count: 'exact', head: true }).gte('started_at', iso);
    if (error) throw wrap(error, 'Counting visits failed');
    return count || 0;
  }

  async mediaUrl(path) {
    if (!path) return null;
    const { data, error } = await this.client.storage.from('clips').createSignedUrl(path, 3600);
    if (error) throw wrap(error, 'Could not get a media link');
    return data.signedUrl;
  }

  // ---------------------------------------------------------------- realtime
  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  /** Join the shared room channel and announce this device. Resolves once subscribed (or after the first error). */
  join(meta = {}) {
    if (this.channel) return Promise.resolve(this.channel);
    this.lastTracked = null;
    this.pendingMeta = { ...meta };
    this._setStatus('joining');
    const ch = this.client.channel(CHANNEL, { config: { presence: { key: this.id }, broadcast: { self: false, ack: false } } });
    this.channel = ch;
    ch.on('presence', { event: 'sync' }, () => this._syncPresence(ch.presenceState()));
    for (const event of BROADCAST_EVENTS) {
      ch.on('broadcast', { event }, ({ payload }) => this._dispatch(event, payload || {}));
    }
    for (const table of TABLES) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => this._dispatchTable(table, payload));
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(ch);
      };
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          this._setStatus('live');
          this.lastTracked = null;
          this._trackNow(this.pendingMeta || {});
          done();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this._setStatus('error');
          if (err) console.warn('cloud channel', status, err.message || err);
          done();
        } else if (status === 'CLOSED') {
          this._setStatus(this.channel ? 'error' : 'closed');
        }
      });
    });
  }

  async leave() {
    const ch = this.channel;
    this.channel = null;
    clearTimeout(this.trackTimer);
    this.trackTimer = null;
    if (ch) {
      try {
        await ch.untrack?.();
      } catch {
        /* ignore */
      }
      try {
        await this.client.removeChannel(ch);
      } catch {
        /* ignore */
      }
    }
    this.presence = { camera: null, agent: null, dashboards: [], all: [] };
    this._setStatus('closed');
  }

  _syncPresence(stateObj) {
    const all = [];
    for (const list of Object.values(stateObj || {})) for (const m of list || []) all.push(m);
    const newest = (role) => all.filter((m) => m.role === role).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
    this.presence = { camera: newest('camera'), agent: newest('agent'), dashboards: all.filter((m) => m.role === 'dashboard'), all };
    for (const fn of this.presenceListeners) {
      try {
        fn(this.presence);
      } catch (e) {
        console.error(e);
      }
    }
  }

  onPresence(fn) {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  }

  /**
   * Publish this device's state to everyone (throttled, only when it changed).
   * The camera uses it for people / armed / recording; the dashboard for "wantsFrames".
   */
  track(meta = {}) {
    this.pendingMeta = { ...(this.pendingMeta || {}), ...meta };
    if (!this.channel || this.status !== 'live') return;
    const sig = JSON.stringify(this.pendingMeta);
    if (sig === this.lastTracked) return;
    const wait = TRACK_MIN_MS - (Date.now() - this.trackedAt);
    if (wait > 0) {
      if (!this.trackTimer) this.trackTimer = setTimeout(() => {
        this.trackTimer = null;
        this.track();
      }, wait);
      return;
    }
    this._trackNow(this.pendingMeta);
  }

  _trackNow(meta) {
    if (!this.channel) return;
    this.lastTracked = JSON.stringify(meta);
    this.trackedAt = Date.now();
    const payload = { ...meta, role: this.role, id: this.id, at: Date.now() };
    Promise.resolve(this.channel.track(payload)).catch((e) => console.warn('presence track', e?.message || e));
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  _dispatch(event, payload) {
    if (event === 'result' && payload?.id && this.pendingCommands.has(payload.id)) {
      const p = this.pendingCommands.get(payload.id);
      this.pendingCommands.delete(payload.id);
      clearTimeout(p.timer);
      p.resolve(payload);
    }
    for (const fn of this.handlers.get(event) || []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  send(event, payload = {}) {
    if (!this.channel) return Promise.resolve('closed');
    return Promise.resolve(this.channel.send({ type: 'broadcast', event, payload: { ...payload, from: this.id, at: Date.now() } })).catch((e) => {
      console.warn('cloud send', e?.message || e);
      return 'error';
    });
  }

  /** Listen to row changes of one table: fn({ eventType, new, old }). */
  onTable(table, fn) {
    if (!this.tableHandlers.has(table)) this.tableHandlers.set(table, new Set());
    this.tableHandlers.get(table).add(fn);
    return () => this.tableHandlers.get(table)?.delete(fn);
  }

  _dispatchTable(table, payload) {
    const ev = { eventType: payload.eventType, new: payload.new || null, old: payload.old || null };
    for (const fn of this.tableHandlers.get(table) || []) {
      try {
        fn(ev);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Ask the camera or the home agent to do something and wait for its answer.
   * target: 'camera' | 'agent'. Rejects when nobody answers in time.
   */
  command(target, action, params = {}, { timeout = 8000 } = {}) {
    const id = uuid();
    const who = target === 'camera' ? 'the camera app' : 'the home agent';
    const online = target === 'camera' ? !!this.presence.camera : !!this.presence.agent;
    if (!online) return Promise.reject(new Error(`${who[0].toUpperCase()}${who.slice(1)} is offline`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`No answer from ${who}`));
      }, timeout);
      this.pendingCommands.set(id, { resolve, reject, timer });
      this.send('command', { id, target, action, params });
    });
  }

  /** Answer a command received through on('command'). */
  reply(cmd, result = {}) {
    return this.send('result', { ...result, id: cmd.id, target: cmd.target, action: cmd.action, ok: result.ok !== false });
  }

  async close() {
    await this.leave();
    this._authSub?.unsubscribe?.();
    this._authSub = null;
  }
}
