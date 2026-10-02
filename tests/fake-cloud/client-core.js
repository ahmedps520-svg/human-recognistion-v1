// supabase-js look-alike used by the tests. Works in Node and in the browser:
// the file attaches makeClient to globalThis instead of using `export`, so it
// can be served as a classic <script> in place of the vendored UMD build.
//
// makeClient({ rpc, subscribe }) -> createClient(url, key, opts)
//   rpc(request)           -> Promise<result>  (talks to FakeCloudDB.handle)
//   subscribe(fn)          -> registers fn(msg) for realtime pushes to this client
/* eslint-disable no-undef */
(function attach(root) {
  const uid = () => (root.crypto?.randomUUID ? root.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

  function makeClient({ rpc, subscribe, storage }) {
    return function createClient(url, key, opts = {}) {
      const clientId = `c-${uid().slice(0, 8)}`;
      const authStorage = opts.auth?.storage || storage || null;
      const SESSION_KEY = 'fake-sb-session';
      let session = null;
      const listeners = new Set();
      const channels = new Map();

      const loadSession = async () => {
        if (!authStorage) return;
        try {
          const raw = await authStorage.getItem(SESSION_KEY);
          session = raw ? JSON.parse(raw) : null;
        } catch {
          session = null;
        }
      };
      const saveSession = async () => {
        if (!authStorage) return;
        if (session) await authStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else await authStorage.removeItem(SESSION_KEY);
      };
      const ready = loadSession();

      const auth = {
        async getSession() {
          await ready;
          return { data: { session }, error: null };
        },
        async signInWithPassword({ email, password }) {
          const r = await rpc({ type: 'auth', email, password });
          if (r.error) return { data: { user: null, session: null }, error: r.error };
          session = r.session;
          await saveSession();
          for (const fn of listeners) fn('SIGNED_IN', session);
          return { data: { user: r.user, session }, error: null };
        },
        async signOut() {
          session = null;
          await saveSession();
          for (const fn of listeners) fn('SIGNED_OUT', null);
          return { error: null };
        },
        onAuthStateChange(fn) {
          listeners.add(fn);
          return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
        },
      };

      function from(table) {
        const op = { type: 'query', table, filters: [], get authed() { return !!session; } };
        const b = {
          select(cols = '*', { count, head } = {}) {
            if (!op.op) op.op = 'select';
            else op.returning = true;
            op.count = count;
            op.head = !!head;
            return b;
          },
          insert(values) {
            op.op = 'insert';
            op.values = Array.isArray(values) ? values : [values];
            return b;
          },
          upsert(values, { onConflict } = {}) {
            op.op = 'upsert';
            op.values = Array.isArray(values) ? values : [values];
            op.onConflict = onConflict;
            return b;
          },
          update(values) {
            op.op = 'update';
            op.values = values;
            return b;
          },
          delete() {
            op.op = 'delete';
            return b;
          },
          eq(col, val) {
            op.filters.push({ type: 'eq', col, val });
            return b;
          },
          gte(col, val) {
            op.filters.push({ type: 'gte', col, val });
            return b;
          },
          in(col, val) {
            op.filters.push({ type: 'in', col, val });
            return b;
          },
          order(col, { ascending = true } = {}) {
            op.order = { col, ascending };
            return b;
          },
          limit(n) {
            op.limit = n;
            return b;
          },
          maybeSingle() {
            op.single = 'maybe';
            return b;
          },
          single() {
            op.single = 'one';
            return b;
          },
          then(res, rej) {
            return rpc({ ...op, authed: !!session, filters: op.filters }).then(res, rej);
          },
        };
        return b;
      }

      const storageApi = {
        from(bucket) {
          return {
            async upload(path, body, { contentType } = {}) {
              const base64 = await toBase64(body);
              const r = await rpc({ type: 'storage', op: 'upload', bucket, path, base64, contentType: contentType || body?.type });
              return r;
            },
            createSignedUrl(path) {
              return rpc({ type: 'storage', op: 'signedUrl', bucket, path });
            },
            remove(paths) {
              return rpc({ type: 'storage', op: 'remove', bucket, paths });
            },
          };
        },
      };

      async function toBase64(body) {
        if (typeof body === 'string') return root.btoa ? root.btoa(body) : Buffer.from(body).toString('base64');
        if (root.Blob && body instanceof root.Blob) {
          const buf = new Uint8Array(await body.arrayBuffer());
          let s = '';
          for (const x of buf) s += String.fromCharCode(x);
          return root.btoa(s);
        }
        if (typeof Buffer !== 'undefined') return Buffer.from(body).toString('base64');
        return '';
      }

      function channel(name, config = {}) {
        const presenceKey = config.config?.presence?.key || clientId;
        const binds = [];
        let status = 'closed';
        let statusCb = null;
        const ch = {
          name,
          on(type, filter, cb) {
            binds.push({ type, filter, cb });
            return ch;
          },
          subscribe(cb) {
            statusCb = cb;
            Promise.resolve(rpc({ type: 'realtime', op: 'join', channel: name, clientId })).then(() => {
              status = 'joined';
              cb?.('SUBSCRIBED');
            });
            return ch;
          },
          presenceState() {
            return ch._state || {};
          },
          async track(meta) {
            await rpc({ type: 'realtime', op: 'track', channel: name, clientId, key: presenceKey, meta });
            return 'ok';
          },
          async untrack() {
            await rpc({ type: 'realtime', op: 'untrack', channel: name, clientId });
            return 'ok';
          },
          async send({ type, event, payload }) {
            if (type !== 'broadcast') return 'error';
            await rpc({ type: 'realtime', op: 'broadcast', channel: name, clientId, event, payload });
            return 'ok';
          },
          async unsubscribe() {
            await rpc({ type: 'realtime', op: 'leave', channel: name, clientId });
            status = 'closed';
            statusCb?.('CLOSED');
            return 'ok';
          },
          _deliver(msg) {
            if (msg.kind === 'presence') {
              ch._state = msg.state;
              for (const b of binds) if (b.type === 'presence' && (b.filter?.event === 'sync' || b.filter?.event === '*')) b.cb({});
            } else if (msg.kind === 'broadcast') {
              for (const b of binds) if (b.type === 'broadcast' && (b.filter?.event === '*' || b.filter?.event === msg.event)) b.cb({ type: 'broadcast', event: msg.event, payload: msg.payload });
            } else if (msg.kind === 'pg') {
              for (const b of binds) {
                if (b.type !== 'postgres_changes' || (b.filter?.table && b.filter.table !== msg.table)) continue;
                if (b.filter?.event && b.filter.event !== '*' && b.filter.event !== msg.eventType) continue;
                b.cb({ eventType: msg.eventType, new: msg.new || {}, old: msg.old || {}, table: msg.table, schema: 'public' });
              }
            }
          },
          get status() {
            return status;
          },
        };
        channels.set(name, ch);
        return ch;
      }

      subscribe((msg) => {
        if (msg.channel) channels.get(msg.channel)?._deliver(msg);
        else for (const ch of channels.values()) ch._deliver(msg);
      }, clientId);

      return {
        clientId,
        auth,
        from,
        storage: storageApi,
        channel,
        async removeChannel(ch) {
          await ch.unsubscribe();
          channels.delete(ch.name);
          return 'ok';
        },
        getChannels: () => [...channels.values()],
      };
    };
  }

  root.__FakeSupabaseCore = { makeClient };
})(globalThis);
