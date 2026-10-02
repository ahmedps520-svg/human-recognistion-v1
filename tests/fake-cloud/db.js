// A stand-in for the Supabase project, used by the unit tests and the
// end-to-end test. One FakeCloudDB holds the tables, the storage bucket, the
// users and the realtime channel; any number of clients (Node or browser
// pages) attach to it and see each other's changes, presence and broadcasts.

import crypto from 'node:crypto';

const PRIMARY = { profiles: 'id', events: 'id', cameras: 'label', home: 'id', device_states: 'device', activity: 'id' };
const now = () => new Date().toISOString();

function defaults(table, row) {
  const r = { ...row };
  if (table === 'activity') {
    r.at ??= now();
    r.meta ??= {};
  } else if (table === 'home') {
    r.id ??= 'main';
    r.room_name ??= 'My room';
    r.mode ??= 'home';
    r.mode_since ??= now();
    r.armed ??= false;
    r.alarm ??= false;
    r.alarm_at ??= null;
    r.automations ??= {};
    r.updated_at ??= now();
  } else if (table === 'device_states') {
    r.state ??= {};
    r.updated_at ??= now();
  } else if (table === 'events') {
    r.id ??= crypto.randomUUID();
    r.started_at ??= now();
    r.verdict ??= 'person';
    r.features ??= {};
    r.clip_paths ??= [];
    r.alarm_triggered ??= false;
    r.lock_triggered ??= false;
  } else if (table === 'profiles') {
    r.id ??= crypto.randomUUID();
    r.created_at ??= now();
    r.updated_at ??= now();
  } else if (table === 'cameras') {
    r.id ??= crypto.randomUUID();
    r.updated_at ??= now();
  }
  return r;
}

export class FakeCloudDB {
  constructor({ users = {} } = {}) {
    this.users = users; // email -> password
    this.tables = { profiles: [], events: [], cameras: [], home: [defaults('home', {})], device_states: [], activity: [] };
    this.seq = { activity: 0 };
    this.files = new Map(); // bucket/path -> { base64, contentType }
    this.clients = new Map(); // clientId -> { deliver }
    this.channels = new Map(); // name -> { members: Set<clientId>, presence: Map<key, { clientId, meta }> }
    this.log = [];
  }

  // ---------------------------------------------------------------- clients
  attach(clientId, deliver) {
    this.clients.set(clientId, { deliver });
  }

  detach(clientId) {
    for (const [name, ch] of this.channels) {
      if (!ch.members.has(clientId)) continue;
      ch.members.delete(clientId);
      for (const [key, p] of ch.presence) if (p.clientId === clientId) ch.presence.delete(key);
      this._presenceSync(name);
    }
    this.clients.delete(clientId);
  }

  _deliver(clientId, msg) {
    const c = this.clients.get(clientId);
    if (!c) return;
    try {
      const r = c.deliver(msg);
      if (r && typeof r.catch === 'function') r.catch((e) => console.warn('deliver', e.message));
    } catch (e) {
      console.warn('deliver', e.message);
    }
  }

  // ---------------------------------------------------------------- auth
  signIn(email, password) {
    if (!email || this.users[email] !== password) return { error: { message: 'Invalid login credentials' } };
    const user = { id: crypto.createHash('md5').update(email).digest('hex'), email, role: 'authenticated' };
    return { session: { access_token: `tok-${user.id}`, refresh_token: `ref-${user.id}`, user }, user };
  }

  // ---------------------------------------------------------------- tables
  query(op) {
    this.log.push(op);
    const { table } = op;
    if (!(table in this.tables)) return { data: null, error: { message: `relation "${table}" does not exist` }, count: null };
    if (!op.authed) return { data: null, error: { message: 'JWT missing: sign in first' }, count: null };
    const rows = this.tables[table];
    const pk = PRIMARY[table];
    const match = (r) => (op.filters || []).every((f) => {
      if (f.type === 'eq') return r[f.col] === f.val;
      if (f.type === 'gte') return r[f.col] >= f.val;
      if (f.type === 'in') return f.val.includes(r[f.col]);
      return true;
    });
    const finish = (list) => {
      let out = list;
      if (op.order) out = [...out].sort((a, b) => (a[op.order.col] < b[op.order.col] ? -1 : a[op.order.col] > b[op.order.col] ? 1 : 0) * (op.order.ascending === false ? -1 : 1));
      if (op.limit != null) out = out.slice(0, op.limit);
      const count = op.count ? out.length : null;
      if (op.head) return { data: null, error: null, count };
      if (op.single === 'one') return out.length === 1 ? { data: out[0], error: null, count } : { data: null, error: { message: out.length ? 'Results contain more than one row' : 'JSON object requested, multiple (or no) rows returned' }, count };
      if (op.single === 'maybe') return out.length <= 1 ? { data: out[0] ?? null, error: null, count } : { data: null, error: { message: 'Results contain more than one row' }, count };
      return { data: out.map((r) => ({ ...r })), error: null, count };
    };
    const emit = (eventType, newRow, oldRow) => {
      const msg = { kind: 'pg', table, eventType, new: newRow ? { ...newRow } : null, old: oldRow ? { [pk]: oldRow[pk] } : null };
      for (const ch of this.channels.values()) for (const id of ch.members) this._deliver(id, msg);
    };
    switch (op.op) {
      case 'select':
        return finish(rows.filter(match));
      case 'insert': {
        const inserted = [];
        for (const v of op.values) {
          const r = defaults(table, v);
          if (table === 'activity') r.id = ++this.seq.activity;
          if (pk && rows.some((x) => x[pk] === r[pk])) return { data: null, error: { message: `duplicate key value violates unique constraint "${table}_pkey"` } };
          rows.push(r);
          inserted.push(r);
          emit('INSERT', r, null);
        }
        return op.returning ? finish(inserted) : { data: null, error: null };
      }
      case 'upsert': {
        const out = [];
        const key = op.onConflict || pk;
        for (const v of op.values) {
          const idx = rows.findIndex((x) => x[key] === v[key]);
          if (idx >= 0) {
            const before = rows[idx];
            rows[idx] = { ...before, ...v };
            out.push(rows[idx]);
            emit('UPDATE', rows[idx], before);
          } else {
            const r = defaults(table, v);
            rows.push(r);
            out.push(r);
            emit('INSERT', r, null);
          }
        }
        return op.returning ? finish(out) : { data: null, error: null };
      }
      case 'update': {
        const out = [];
        for (let i = 0; i < rows.length; i++) {
          if (!match(rows[i])) continue;
          const before = rows[i];
          rows[i] = { ...before, ...op.values };
          out.push(rows[i]);
          emit('UPDATE', rows[i], before);
        }
        return op.returning ? finish(out) : { data: null, error: null };
      }
      case 'delete': {
        const gone = rows.filter(match);
        this.tables[table] = rows.filter((r) => !match(r));
        for (const r of gone) emit('DELETE', null, r);
        return op.returning ? finish(gone) : { data: null, error: null };
      }
      default:
        return { data: null, error: { message: `unknown op ${op.op}` } };
    }
  }

  // ---------------------------------------------------------------- storage
  storage(op) {
    const key = `${op.bucket}/${op.path}`;
    if (op.op === 'upload') {
      this.files.set(key, { base64: op.base64, contentType: op.contentType || 'application/octet-stream' });
      return { data: { path: op.path }, error: null };
    }
    if (op.op === 'signedUrl') {
      const f = this.files.get(key);
      return f ? { data: { signedUrl: `data:${f.contentType};base64,${f.base64}` }, error: null } : { data: null, error: { message: 'Object not found' } };
    }
    if (op.op === 'remove') {
      for (const p of op.paths) this.files.delete(`${op.bucket}/${p}`);
      return { data: [], error: null };
    }
    return { data: null, error: { message: `unknown storage op ${op.op}` } };
  }

  // ---------------------------------------------------------------- realtime
  _channel(name) {
    if (!this.channels.has(name)) this.channels.set(name, { members: new Set(), presence: new Map() });
    return this.channels.get(name);
  }

  presenceState(name) {
    const out = {};
    for (const [key, p] of this._channel(name).presence) out[key] = [{ ...p.meta, presence_ref: `${key}:${p.clientId}` }];
    return out;
  }

  _presenceSync(name) {
    const ch = this._channel(name);
    const state = this.presenceState(name);
    for (const id of ch.members) this._deliver(id, { kind: 'presence', channel: name, state });
  }

  realtime(op) {
    const ch = this._channel(op.channel);
    switch (op.op) {
      case 'join':
        ch.members.add(op.clientId);
        this._deliver(op.clientId, { kind: 'presence', channel: op.channel, state: this.presenceState(op.channel) });
        return { ok: true };
      case 'leave':
        ch.members.delete(op.clientId);
        for (const [key, p] of ch.presence) if (p.clientId === op.clientId) ch.presence.delete(key);
        this._presenceSync(op.channel);
        return { ok: true };
      case 'track':
        ch.presence.set(op.key, { clientId: op.clientId, meta: op.meta });
        this._presenceSync(op.channel);
        return { ok: true };
      case 'untrack':
        for (const [key, p] of ch.presence) if (p.clientId === op.clientId) ch.presence.delete(key);
        this._presenceSync(op.channel);
        return { ok: true };
      case 'broadcast':
        for (const id of ch.members) if (id !== op.clientId) this._deliver(id, { kind: 'broadcast', channel: op.channel, event: op.event, payload: op.payload });
        return { ok: true };
      default:
        return { ok: false };
    }
  }

  /** Single entry point for remote (browser) clients. */
  handle(req) {
    if (req.type === 'auth') return this.signIn(req.email, req.password);
    if (req.type === 'query') return this.query(req);
    if (req.type === 'storage') return this.storage(req);
    if (req.type === 'realtime') return this.realtime(req);
    return { error: { message: 'bad request' } };
  }
}
