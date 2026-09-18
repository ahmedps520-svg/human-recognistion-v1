// Dashboard end-to-end test: runs the home server in mock mode and drives the
// dashboard in headless Chromium.
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
const app = createServer(loadConfig({ port: 0, host: '127.0.0.1', token: TOKEN, mock: true, dataDir }));
const addr = await app.listen();
const base = `http://127.0.0.1:${addr.port}`;
step(`mock server at ${base}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  console.error: ${m.text().slice(0, 200)}`);
});

const api = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });

try {
  await page.goto(`${base}/dashboard.html?token=${TOKEN}`);
  await page.waitForFunction(() => document.getElementById('connPill').classList.contains('ok'), null, { timeout: 15000 });
  step(`connected: ${await page.textContent('#connPill')}`);

  // Minecraft
  await page.waitForFunction(() => document.getElementById('mcState').textContent === 'Online', null, { timeout: 10000 });
  const mcInfo = await page.textContent('#mcInfo');
  assert(mcInfo.includes('2 / 20') && mcInfo.includes('Steve'), 'minecraft tile shows players');
  await page.fill('#rconInput', 'list');
  await page.click('#rconForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('rconOut').textContent.includes('Steve'), null, { timeout: 10000 });
  step('rcon console works');
  await page.click('button[data-mc="stop"]');
  await page.waitForFunction(() => document.getElementById('mcState').textContent === 'Offline', null, { timeout: 10000 });
  assert(true, 'stop button takes the mock server offline');
  await page.click('button[data-mc="start"]');
  await page.waitForFunction(() => document.getElementById('mcState').textContent === 'Online', null, { timeout: 10000 });

  // AC
  await page.click('#acPower');
  await page.waitForFunction(() => document.getElementById('acState').textContent.startsWith('On'), null, { timeout: 10000 });
  const before = Number(await page.textContent('#acTarget'));
  await page.click('#acUp');
  await page.waitForFunction((b) => Number(document.getElementById('acTarget').textContent) === b + 1, before, { timeout: 10000 });
  assert(true, `AC target went from ${before} to ${before + 1}`);
  await page.click('#acModes button[data-mode="heat"]');
  await page.waitForFunction(() => document.querySelector('#acModes button.active')?.dataset.mode === 'heat', null, { timeout: 10000 });
  assert(true, 'AC mode buttons work');

  // Door
  await page.click('button[data-door="open"]');
  await page.waitForFunction(() => document.getElementById('doorState').textContent.includes('Open'), null, { timeout: 10000 });
  await page.click('button[data-door="close"]');
  await page.waitForFunction(() => document.getElementById('doorState').textContent.includes('Closed'), null, { timeout: 10000 });
  assert(true, 'door open/close reflects state');

  // Lights
  await page.waitForFunction(() => document.querySelectorAll('#lightList .light').length === 2, null, { timeout: 10000 });
  const lampOff = await page.$eval('#lightList .light:nth-child(2) .switch', (el) => el.classList.contains('on'));
  assert(lampOff === false, 'desk lamp starts off');
  await page.click('#lightList .light:nth-child(2) .switch');
  await page.waitForFunction(() => document.querySelector('#lightList .light:nth-child(2) .switch').classList.contains('on'), null, { timeout: 10000 });
  assert(true, 'light switch toggles');
  await page.click('button[data-all="off"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#lightList .switch')].every((s) => !s.classList.contains('on')), null, { timeout: 10000 });
  assert(true, 'all off works');

  // Camera: push a real JPEG through the API and a visit; the dashboard must show both.
  const jpeg = fs.readFileSync(path.join(cache, 'person.jpg'));
  const meta = encodeURIComponent(JSON.stringify({ people: 1, armed: true, recording: true }));
  const posted = await api(`/api/camera/frame?meta=${meta}`, { method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
  assert(posted.ok, 'frame accepted');
  await page.waitForFunction(() => document.getElementById('camPeople').textContent.includes('1 person') && document.getElementById('camArmed').textContent === 'Armed', null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const img = document.getElementById('camStream');
    return !img.hidden && img.naturalWidth > 0;
  }, null, { timeout: 15000 });
  assert(true, 'live MJPEG feed renders in the dashboard');
  await api('/api/camera/media/2026/09/18/snap.jpg', { method: 'PUT', body: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
  await api('/api/camera/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: new Date().toISOString(), verdict: 'person', snapshotPath: '2026/09/18/snap.jpg', clipPath: '2026/09/18/clip.webm', clipPaths: ['2026/09/18/clip.webm'] }) });
  await page.waitForFunction(() => document.querySelectorAll('#visitList li img').length >= 1, null, { timeout: 10000 });
  assert(true, 'visit with thumbnail appears live');
  await page.click('#btnArm');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(cache, 'dashboard.png'), fullPage: true });
  step('screenshot saved');
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
