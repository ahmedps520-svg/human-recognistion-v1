// Dashboard end-to-end test: runs the home server in mock mode and drives the
// smart-room dashboard in headless Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../../server/index.js';
import { loadConfig } from '../../server/lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(here, '.cache');
const TOKEN = 'e2e-token';
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exitCode = 1;
};
const assert = (c, m) => (c ? step(`ok: ${m}`) : fail(m));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-dash-'));
const app = createServer(loadConfig({ port: 0, host: '127.0.0.1', token: TOKEN, mock: true, dataDir, roomName: 'Test room' }));
const addr = await app.listen();
const base = `http://127.0.0.1:${addr.port}`;
step(`mock server at ${base}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  console.error: ${m.text().slice(0, 200)}`);
});
const api = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });
const apiJson = (p, init) => api(p, init).then((r) => r.json());
const wait = (fn, label, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).catch(() => { throw new Error(`timeout: ${label}`); });
const text = (sel) => page.textContent(sel);

try {
  await page.goto(`${base}/dashboard.html?token=${TOKEN}`);
  await wait(() => document.getElementById('liveDot').classList.contains('on'), 'live connection');
  assert((await text('#roomName')) === 'Test room', 'room name comes from the server');
  assert((await text('#chipWeather')).includes('31°'), 'outdoor weather in the header');
  assert((await text('#chipInside')).includes('°'), 'inside temperature in the header');

  // Modes
  await page.click('#modes button[data-mode="sleep"]');
  await wait(() => document.querySelector('#modes button.active')?.dataset.mode === 'sleep', 'sleep mode active');
  assert((await apiJson('/api/mode')).mode === 'sleep', 'mode saved on the server');

  // Scenes
  await wait(() => document.querySelectorAll('#sceneRow .scene').length >= 5, 'scenes rendered');
  await page.click('#sceneRow .scene[data-scene="away"]');
  await wait(() => document.getElementById('doorState').textContent === 'Door locked' && document.getElementById('acState').textContent === 'Off', 'away scene locked the door and turned the AC off');
  await wait(() => document.querySelector('#modes button.active')?.dataset.mode === 'away', 'scene switched the mode to away');
  await wait(() => [...document.querySelectorAll('#lightList .switch')].every((s) => !s.classList.contains('on')), 'all lights off after the away scene');

  // Security / door
  await page.click('[data-door="open"]');
  await wait(() => document.getElementById('doorState').textContent === 'Door unlocked', 'door unlocked');
  await page.click('#btnDoor');
  await wait(() => document.getElementById('doorState').textContent === 'Door locked', 'big door button toggles back');

  // Climate
  await page.click('#acPower');
  await wait(() => document.getElementById('acState').textContent.startsWith('On'), 'AC on');
  const before = Number(await text('#acTarget'));
  await page.click('#acUp');
  await wait((b) => Number(document.getElementById('acTarget').textContent) === b + 1, 'AC target +1', before);
  await page.click('#acModes button[data-mode="heat"]');
  await wait(() => document.querySelector('#acModes button.active')?.dataset.mode === 'heat', 'AC mode heat');
  assert((await page.$$('#sensorRow .sensor')).length === 4, 'room sensors shown');

  // Lights
  await page.click('#lightList .light:nth-child(2) .switch');
  await wait(() => document.querySelector('#lightList .light:nth-child(2) .switch').classList.contains('on'), 'light switched on');

  // Switches
  await wait(() => document.querySelectorAll('#switchList .sw').length === 3, 'three switches');
  await page.click('#switchList .sw:nth-child(1) .switch');
  await wait(() => document.querySelector('#switchList .sw:nth-child(1) .switch').classList.contains('on'), 'switch on');
  await page.click('[data-sw-all="off"]');
  await wait(() => [...document.querySelectorAll('#switchList .switch')].every((s) => !s.classList.contains('on')), 'all switches off');

  // Automations
  await wait(() => document.querySelectorAll('#automationList .auto').length >= 6, 'automations listed');
  assert(await page.$eval('#automationList .auto[data-automation="intruder"] .switch', (el) => el.classList.contains('on')), 'intruder response enabled by default');
  await page.click('#automationList .auto[data-automation="night"] .switch');
  await wait(() => document.querySelector('#automationList .auto[data-automation="night"] .switch').classList.contains('on'), 'night routine toggled on');
  assert((await apiJson('/api/automations')).find((a) => a.id === 'night').enabled === true, 'toggle persisted on the server');

  // Camera: frame + presence, then an alarm that triggers the intruder automation.
  const jpeg = fs.readFileSync(path.join(cache, 'person.jpg'));
  await api(`/api/camera/frame?meta=${encodeURIComponent(JSON.stringify({ people: 1, armed: true, recording: true }))}`, { method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
  await wait(() => document.getElementById('camPeople').textContent.includes('1 person') && document.getElementById('camArmed').textContent === 'Armed', 'presence chips live');
  await wait(() => document.getElementById('roomSub').textContent.startsWith('Occupied'), 'header shows the room as occupied');
  await wait(() => { const img = document.getElementById('camStream'); return !img.hidden && img.naturalWidth > 0; }, 'live feed renders', null, 15000);
  assert((await text('#secText')) === 'Armed', 'security ring shows armed');
  await api('/api/camera/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ people: 1, armed: true, alarm: true }) });
  await wait(() => document.getElementById('secText').textContent === 'ALARM', 'security ring shows the alarm');
  await wait(() => document.getElementById('doorState').textContent === 'Door locked', 'intruder automation locked the door');
  await wait(() => document.getElementById('activityList').textContent.includes('Intruder response'), 'activity timeline shows the automation live');
  const lights = await apiJson('/api/lights');
  assert(lights.devices.every((d) => d.state.color.r === 255 && d.state.color.g === 0), 'intruder automation turned the lights red');
  assert(app.services.notify.sent.length >= 1, 'phone notification sent by the automation');

  // Visit
  await api('/api/camera/media/2026/10/02/snap.jpg', { method: 'PUT', body: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
  await api('/api/camera/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: new Date().toISOString(), verdict: 'person', snapshotPath: '2026/10/02/snap.jpg', clipPath: '2026/10/02/clip.webm', clipPaths: ['2026/10/02/clip.webm'], alarmTriggered: true }) });
  await wait(() => document.querySelectorAll('#visitList li img').length >= 1, 'visit with thumbnail appears live');
  await wait(() => document.getElementById('secVisitsToday').textContent === '1', 'visits-today counter updates');

  // Minecraft
  await wait(() => document.getElementById('mcState').textContent === 'Online', 'minecraft online');
  await page.click('#btnConsole');
  await page.fill('#rconInput', 'list');
  await page.click('#rconForm button[type=submit]');
  await wait(() => document.getElementById('rconOut').textContent.includes('Steve'), 'rcon console');
  await page.click('button[data-mc="stop"]');
  await wait(() => document.getElementById('mcState').textContent === 'Offline', 'minecraft stopped');
  await page.click('button[data-mc="start"]');
  await wait(() => document.getElementById('mcState').textContent === 'Online', 'minecraft started');

  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(cache, 'dashboard.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 930 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(cache, 'dashboard-phone.png'), fullPage: true });
  step('screenshots saved');
} catch (e) {
  fail(e.stack || String(e));
  await page.screenshot({ path: path.join(cache, 'dashboard-failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await browser.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(process.exitCode ? 'DASHBOARD E2E FAILED' : 'DASHBOARD E2E PASSED');
