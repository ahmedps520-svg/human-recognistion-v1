// Cloud end-to-end test: the camera app, the dashboard and the home agent
// talk to each other through a fake cloud project (tests/fake-cloud) that
// behaves like Supabase. Headless Chromium hosts the two pages; the agent runs
// in this process with mock devices.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { FakeCloudDB, createClientFor } from '../fake-cloud/node.js';
import { Cloud } from '../../assets/js/cloud.js';
import { CLOUD } from '../../assets/js/config.js';
import { HomeAgent } from '../../server/lib/agent.js';
import { loadConfig } from '../../server/lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cache = path.join(here, '.cache');
fs.mkdirSync(cache, { recursive: true });
const EMAIL = 'me@example.com';
const PASSWORD = 'test-password';
// The project URL is baked into the site; the test only has to supply the key, like a real first run.
const PROJECT = CLOUD.supabaseUrl || 'https://e2e.supabase.co';
const PROJECT_HOST = PROJECT.replace(/^https?:\/\//, '');
const ANON = 'e2e-anon-key-xxxxxxxxxxxxxxxxxxxxxxxx';
// 1x1 JPEG
const TINY_JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exitCode = 1;
};
const assert = (c, m) => (c ? step(`ok: ${m}`) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return fn();
};

// ---------------------------------------------------------------- fake cloud + agent
const db = new FakeCloudDB({ users: { [EMAIL]: PASSWORD } });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-cloud-e2e-'));
const agentCloud = new Cloud({ url: PROJECT, anonKey: ANON, createClient: createClientFor(db), role: 'agent' });
await agentCloud.init();
await agentCloud.signIn(EMAIL, PASSWORD);
const agentLog = [];
const agent = new HomeAgent({ cloud: agentCloud, config: loadConfig({ mock: true, dataDir, roomName: 'Test room' }), log: (m) => agentLog.push(m) });
await agent.start();
step('home agent online (mock devices)');

// The browser pages load this instead of the real supabase-js build.
const core = fs.readFileSync(path.join(root, 'tests/fake-cloud/client-core.js'), 'utf8');
const glue = `${core}
(function () {
  const clients = {};
  window.__fakeDeliver = (clientId, msg) => { clients[clientId]?.(msg); };
  window.supabase = { createClient: window.__FakeSupabaseCore.makeClient({
    rpc: (req) => window.__fakeRpc(JSON.parse(JSON.stringify(req))),
    subscribe: (fn, clientId) => { clients[clientId] = fn; window.__fakeRegister(clientId); },
    storage: window.localStorage,
  }) };
})();`;

const { server, url } = await startServer(root, {});
step(`serving ${url}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const errors = [];

async function openPage(name) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  ${name} console.error: ${m.text().slice(0, 200)}`);
  });
  await page.route(/vendor\/supabase-js-[^/]+\.umd\.js$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: glue }));
  await page.exposeFunction('__fakeRpc', async (req) => db.handle(req));
  await page.exposeFunction('__fakeRegister', (clientId) => {
    db.attach(clientId, (msg) => page.evaluate(({ id, m }) => window.__fakeDeliver(id, m), { id: clientId, m: msg }).catch(() => {}));
  });
  return page;
}

const text = (page, sel) => page.textContent(sel);
const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && !el.classList.contains('hidden') && !el.hidden;
}, sel);

try {
  // ---------------------------------------------------------------- dashboard: first-time setup + sign in
  const dash = await openPage('dashboard');
  await dash.goto(`${url}/dashboard.html`);
  await dash.waitForSelector('#gate:not(.hidden)');
  const fullyBaked = !!(CLOUD.supabaseUrl && CLOUD.supabaseAnonKey);
  const setupHidden = await dash.evaluate(() => document.getElementById('gateSetup').classList.contains('hidden'));
  if (fullyBaked) assert(setupHidden, 'only email and password are asked: the project is built into the site');
  else {
    assert(await dash.evaluate(() => document.getElementById('gateSetup').open), 'first-time setup box is open when the key is missing');
    const urlHidden = await dash.evaluate(() => document.querySelector('#gateForm input[name="url"]').closest('label').classList.contains('hidden'));
    assert(urlHidden === !!CLOUD.supabaseUrl, 'the URL field is hidden when the URL is baked in');
  }
  assert((await text(dash, '#gateProject')).includes(PROJECT_HOST), 'the project is named on the sign-in screen');
  await dash.fill('#gateForm input[name="email"]', EMAIL);
  await dash.fill('#gateForm input[name="password"]', 'wrong');
  if (!fullyBaked) {
    if (!CLOUD.supabaseUrl) await dash.fill('#gateForm input[name="url"]', PROJECT);
    await dash.fill('#gateForm input[name="anonKey"]', ANON);
  }
  await dash.click('#gateForm button[type="submit"]');
  await dash.waitForSelector('#gateError:not(.hidden)');
  assert((await text(dash, '#gateError')).includes('Wrong email or password'), 'wrong password is explained');
  await dash.fill('#gateForm input[name="password"]', PASSWORD);
  await dash.click('#gateForm button[type="submit"]');
  await dash.waitForFunction(() => document.getElementById('gate').classList.contains('hidden'), null, { polling: 100 });
  await dash.waitForFunction(() => document.getElementById('liveDot').classList.contains('on'), null, { polling: 100 });
  step('dashboard signed in and live');
  assert((await text(dash, '#chipAgent')).includes('agent on'), 'dashboard shows the home agent online');
  await dash.waitForFunction(() => document.querySelectorAll('#sceneRow .scene').length >= 5, null, { polling: 100 });
  assert((await text(dash, '#doorState')) === 'Door locked', 'door state mirrored from the agent');
  assert((await dash.$$('#switchList .sw')).length === 3, 'switches mirrored from the agent');
  assert((await text(dash, '#chipWeather')).includes('°'), 'weather mirrored from the agent');
  assert((await text(dash, '#camOfflineTitle')) === 'Camera app is not open', 'no camera yet');

  // ---------------------------------------------------------------- camera app: sign in with the same account
  const cam = await openPage('camera');
  await cam.goto(`${url}/`);
  await cam.waitForFunction(() => document.getElementById('storeStatus').textContent.includes('live'), null, { polling: 100 });
  assert(await cam.evaluate(() => document.getElementById('gate').classList.contains('hidden')), 'camera app is signed in already: same site, same account as the dashboard');
  step('camera app signed in');
  assert((await text(cam, '#storeStatus')).includes('Cloud'), 'camera status pill shows the cloud');
  await dash.waitForFunction(() => document.getElementById('camOfflineTitle').textContent === 'Camera is off', null, { polling: 100 });
  assert(!(await dash.evaluate(() => document.getElementById('btnCamStart').disabled)), 'dashboard can start the camera once the app is open');
  await cam.waitForFunction(() => document.getElementById('storeStatus').textContent.includes('1 watching'), null, { polling: 100 });
  step('camera sees one dashboard watching');

  // ---------------------------------------------------------------- arm from the dashboard, siren command, disarm from the camera
  await dash.bringToFront();
  await dash.click('#btnArm');
  await cam.waitForFunction(() => window.roomGuard.state.armed === true, null, { polling: 100 });
  assert((await text(cam, '#armedBadge')) === 'Armed', 'arming from the dashboard reaches the camera app');
  await dash.waitForFunction(() => document.getElementById('secText').textContent === 'Armed', null, { polling: 100 });
  await dash.waitForFunction(() => document.getElementById('activityList').textContent.includes('armed from the dashboard'), null, { polling: 100 });
  step('activity timeline updated live');
  await dash.click('#btnSiren');
  await cam.waitForFunction(() => document.getElementById('liveLog').textContent.includes('Siren test from the dashboard'), null, { polling: 100 });
  step('siren command reached the camera app');
  await cam.bringToFront();
  await cam.click('#btnArm');
  await dash.waitForFunction(() => document.getElementById('secText').textContent === 'Secure', null, { polling: 100 });
  step('disarming on the camera reaches the dashboard');

  // ---------------------------------------------------------------- devices through the agent
  await dash.bringToFront();
  await dash.click('[data-door="open"]');
  await dash.waitForFunction(() => document.getElementById('doorState').textContent === 'Door unlocked', null, { polling: 100 });
  step('door unlocked via the agent');
  await dash.click('#acPower');
  await dash.waitForFunction(() => document.getElementById('acState').textContent.startsWith('On'), null, { polling: 100 });
  const lightWasOn = await dash.evaluate(() => document.querySelector('#lightList .light:nth-child(1) .switch').classList.contains('on'));
  await dash.click('#lightList .light:nth-child(1) .switch');
  const lightState = () => db.tables.device_states.find((d) => d.device === 'lights')?.state.devices[0].state.power;
  await until(() => lightState() === !lightWasOn);
  assert(lightState() === !lightWasOn, 'light toggled through the agent and mirrored back');
  await dash.waitForFunction((was) => document.querySelector('#lightList .light:nth-child(1) .switch').classList.contains('on') === !was, lightWasOn, { polling: 100 });
  step('AC and lights respond');
  await dash.click('#sceneRow .scene[data-scene="away"]');
  await dash.waitForFunction(() => document.querySelector('#modes button.active')?.dataset.mode === 'away', null, { polling: 100 });
  await dash.waitForFunction(() => document.getElementById('doorState').textContent === 'Door locked', null, { polling: 100 });
  await cam.waitForFunction(() => window.roomGuard.state.armed === true, null, { polling: 100 });
  step('away scene: mode, door and camera armed everywhere');
  await dash.click('#automationList .auto[data-automation="intruder"] button[data-enabled]');
  await until(() => agent.services.automations.rules.find((r) => r.id === 'intruder').enabled === false);
  assert(agent.services.automations.rules.find((r) => r.id === 'intruder').enabled === false, 'automation switch from the dashboard reaches the agent');
  await dash.click('#automationList .auto[data-automation="intruder"] button[data-enabled]');
  await until(() => agent.services.automations.rules.find((r) => r.id === 'intruder').enabled === true);

  // ---------------------------------------------------------------- presence, live picture and alarm from the camera
  await cam.evaluate(() => window.roomGuard.cloud.track({ running: true, people: 1, tracks: [{ id: 1, label: 'Person', since: Date.now() - 5000 }] }));
  await dash.waitForFunction(() => document.getElementById('camPeople').textContent.includes('1 person'), null, { polling: 100 });
  assert((await text(dash, '#roomSub')).includes('Occupied'), 'room shows occupied');
  await until(() => cam.evaluate(() => window.roomGuard.cloud.presence.dashboards.some((d) => d.wantsFrames)));
  assert(await cam.evaluate(() => window.roomGuard.cloud.presence.dashboards.some((d) => d.wantsFrames)), 'dashboard asks for snapshots (no direct video in headless)');
  await cam.evaluate((jpeg) => window.roomGuard.cloud.send('frame', { jpeg, w: 1, h: 1 }), TINY_JPEG);
  await dash.waitForFunction(() => !document.getElementById('camFrame').hidden && document.getElementById('camFrame').src.startsWith('data:image/jpeg'), null, { polling: 100 });
  assert(await visible(dash, '#camQuality'), 'live picture shown from snapshots');
  const notifiedBefore = agent.services.notify.sent.length;
  await cam.evaluate(() => window.roomGuard.cloud.setHome({ alarm: true, alarmAt: new Date().toISOString() }));
  await dash.waitForFunction(() => document.getElementById('secText').textContent === 'ALARM', null, { polling: 100 });
  await until(() => agent.services.notify.sent.length > notifiedBefore);
  assert(agent.services.notify.sent.length > notifiedBefore, 'intruder response notified the phone');
  step('alarm: dashboard ring red, agent automation fired');
  await dash.screenshot({ path: path.join(cache, 'cloud-dashboard.png'), fullPage: true });
  await cam.evaluate(() => window.roomGuard.cloud.setHome({ alarm: false }));
  await dash.waitForFunction(() => document.getElementById('secText').textContent !== 'ALARM', null, { polling: 100 });

  // ---------------------------------------------------------------- camera app stores visits in the cloud while signed in
  const ev = await cam.evaluate(async () => {
    const e = await window.roomGuard.store.insertEvent({ startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), verdict: 'person', features: {}, cameraLabel: 'e2e' });
    return { id: e.id, mode: window.roomGuard.store.mode };
  });
  assert(ev.mode === 'supabase' && db.tables.events.length === 1, 'visit written to the cloud project');
  await dash.waitForFunction(() => document.getElementById('secVisitsToday').textContent === '1', null, { polling: 100 });
  step('dashboard counted the visit live');

  // ---------------------------------------------------------------- sign out on the camera, back in through its own sign-in screen
  await cam.bringToFront();
  await cam.click('#tabs button[data-view="settings"]');
  await cam.click('#btnAccountSignOut');
  await cam.waitForSelector('#gate:not(.hidden)');
  assert((await text(cam, '#storeStatus')).includes('Browser storage'), 'camera back to browser storage after sign-out');
  await until(() => !agentCloud.presence.camera);
  assert(!agentCloud.presence.camera, 'agent sees the camera leave');
  assert((await text(cam, '#gateProject')).includes(PROJECT_HOST), 'camera sign-in screen already knows the project saved on this device');
  assert(!(await cam.evaluate(() => document.getElementById('gateSetup').open)), 'first-time setup box stays closed once the project is known');
  await cam.fill('#gateForm input[name="email"]', EMAIL);
  await cam.fill('#gateForm input[name="password"]', PASSWORD);
  await cam.click('#gateForm button[type="submit"]');
  await cam.waitForFunction(() => document.getElementById('gate').classList.contains('hidden'), null, { polling: 100 });
  await cam.waitForFunction(() => document.getElementById('storeStatus').textContent.includes('live'), null, { polling: 100 });
  step('camera signed back in through its own sign-in screen');
  await until(() => !!agentCloud.presence.camera);
  assert(!!agentCloud.presence.camera, 'agent sees the camera again');

  // ---------------------------------------------------------------- dashboard sign out
  await dash.bringToFront();
  await dash.click('#btnSettings');
  await dash.click('#btnSignOut');
  await dash.waitForSelector('#gate:not(.hidden)');
  step('dashboard signed out');
} catch (e) {
  fail(e.stack || e.message);
  console.log(`  agent log: ${agentLog.slice(-8).join(' | ')}`);
  for (const p of context.pages()) console.log(`  ${await p.title()}: toast="${await p.evaluate(() => document.getElementById('toast')?.textContent)}"`);
} finally {
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await browser.close();
  server.close();
  await agent.stop();
  await agentCloud.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(process.exitCode ? 'CLOUD E2E FAILED' : 'CLOUD E2E PASSED');
