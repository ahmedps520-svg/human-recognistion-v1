// Node side of the fake cloud: clients that talk to a FakeCloudDB directly.
import './client-core.js';
export { FakeCloudDB } from './db.js';

/** createClient(url, key, opts) bound to one FakeCloudDB. */
export function createClientFor(db) {
  const { makeClient } = globalThis.__FakeSupabaseCore;
  return makeClient({
    rpc: async (req) => db.handle(req),
    subscribe: (fn, clientId) => db.attach(clientId, (msg) => fn(msg)),
  });
}
