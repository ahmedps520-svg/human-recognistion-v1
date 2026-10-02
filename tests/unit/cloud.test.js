import test from 'node:test';
import assert from 'node:assert/strict';
import { Cloud, readCloudConfig, saveCloudConfig, clearCloudConfig, friendlyAuthError } from '../../assets/js/cloud.js';
import { FakeCloudDB, createClientFor } from '../fake-cloud/node.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
};

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

async function makeCloud(db, role, { signIn = true } = {}) {
  const cloud = new Cloud({ url: 'https://test.supabase.co', anonKey: 'anon', createClient: createClientFor(db), role });
  await cloud.init();
  if (signIn) await cloud.signIn('me@example.com', 'secret');
  return cloud;
}

test('cloud config: baked values win, local setup is the fallback', () => {
  globalThis.localStorage = memoryStorage();
  assert.equal(readCloudConfig({}).configured, false);
  saveCloudConfig({ url: 'https://abc.supabase.co/', anonKey: 'x'.repeat(30) });
  const local = readCloudConfig({});
  assert.equal(local.source, 'local');
  assert.equal(local.url, 'https://abc.supabase.co');
  const baked = readCloudConfig({ supabaseUrl: 'https://baked.supabase.co', supabaseAnonKey: 'y'.repeat(30) });
  assert.equal(baked.source, 'baked');
  assert.equal(baked.url, 'https://baked.supabase.co');
  const mixed = readCloudConfig({ supabaseUrl: 'https://baked.supabase.co', supabaseAnonKey: '' });
  assert.equal(mixed.configured, true, 'baked URL + key saved on the device');
  assert.equal(mixed.url, 'https://baked.supabase.co');
  assert.equal(mixed.bakedUrl, true);
  assert.equal(mixed.source, 'local');
  assert.throws(() => saveCloudConfig({ url: 'nope', anonKey: 'short' }));
  clearCloudConfig();
  assert.equal(readCloudConfig({}).configured, false);
  delete globalThis.localStorage;
});

test('auth errors become plain advice', () => {
  assert.match(friendlyAuthError({ message: 'Invalid login credentials' }), /Wrong email or password/);
  assert.match(friendlyAuthError({ message: 'Email not confirmed' }), /confirm/);
  assert.match(friendlyAuthError(new TypeError('Failed to fetch')), /reach the cloud/);
  assert.equal(friendlyAuthError({ message: 'Something odd' }), 'Something odd');
});

test('sign in, presence, commands and row changes flow between two devices', async () => {
  const db = new FakeCloudDB({ users: { 'me@example.com': 'secret' } });
  const camera = await makeCloud(db, 'camera');
  const dash = await makeCloud(db, 'dashboard');
  await assert.rejects(camera.signIn('me@example.com', 'wrong'), /Wrong email or password/);
  assert.equal(camera.user.email, 'me@example.com');

  // Nothing answers before the camera is online.
  await dash.join({ wantsFrames: true });
  await assert.rejects(dash.command('camera', 'siren'), /offline/);

  await camera.join({ people: 0, armed: false, running: true });
  assert.ok(await until(() => dash.presence.camera?.running === true), 'dashboard sees the camera');
  assert.ok(await until(() => camera.presence.dashboards.length === 1 && camera.presence.dashboards[0].wantsFrames), 'camera sees the dashboard');

  // presence updates are change-only and throttled
  const seen = [];
  dash.onPresence((p) => seen.push(p.camera?.people));
  camera.track({ people: 1 });
  camera.track({ people: 1 });
  camera.track({ people: 2 });
  assert.ok(await until(() => seen.includes(2), 3000), 'last change arrives');
  assert.ok(!seen.includes(1) || seen.filter((x) => x === 1).length <= 1, 'intermediate changes are coalesced');

  // dashboard -> camera command with a reply
  camera.on('command', (c) => {
    if (c.target === 'camera' && c.action === 'siren') camera.reply(c, { seconds: c.params.seconds });
  });
  const r = await dash.command('camera', 'siren', { seconds: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.seconds, 3);
  await assert.rejects(dash.command('camera', 'nobody-listens', {}, { timeout: 150 }), /No answer/);

  // shared room row
  const rows = [];
  camera.onTable('home', (ev) => rows.push(ev.new.armed));
  const home = await dash.setHome({ armed: true });
  assert.equal(home.armed, true);
  assert.ok(await until(() => rows.includes(true)), 'camera gets the armed flag');
  assert.equal((await camera.getHome()).armed, true);

  // devices, activity, events
  await dash.setDevice('door', { on: false, adapter: 'mock' });
  assert.equal((await camera.listDevices()).door.on, false);
  const entry = await camera.addActivity('visit', 'Someone entered', { source: 'camera' });
  assert.equal(entry.source, 'camera');
  assert.equal((await dash.listActivity(5))[0].text, 'Someone entered');
  assert.equal(await dash.countEventsSince(new Date(0).toISOString()), 0);

  await camera.leave();
  assert.ok(await until(() => dash.presence.camera == null), 'camera leaves presence');
  await dash.close();
  await camera.close();
});
