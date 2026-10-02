import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../index.js';
import { loadConfig } from '../lib/config.js';
import { AutomationEngine } from '../lib/automations.js';

const TOKEN = 'test-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-smart-'));
  const app = createServer(loadConfig({ port: 0, host: '127.0.0.1', token: TOKEN, mock: true, dataDir, ...extra }));
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (p, { method = 'GET', body, raw, headers = {} } = {}) => {
    const res = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  return { app, base, api, dataDir, close: async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('status carries the whole smart room', async () => {
  const t = await startApp();
  try {
    const { json } = await t.api('/api/status');
    assert.equal(json.home.mode, 'home');
    assert.equal(json.roomName, 'My room');
    assert.ok(json.scenes.length >= 5);
    assert.ok(json.automations.find((a) => a.id === 'intruder').enabled);
    assert.equal(json.automations.find((a) => a.id === 'night').enabled, false);
    assert.equal(json.switches.length, 3);
    assert.equal(json.sensors.length, 4);
    assert.equal(json.weather.enabled, true);
    assert.equal(json.notify.adapter, 'mock');
    assert.ok(Array.isArray(json.activity));
  } finally {
    await t.close();
  }
});

test('modes persist and show up in the activity timeline', async () => {
  const t = await startApp();
  try {
    const set = await t.api('/api/mode', { method: 'POST', body: { mode: 'sleep' } });
    assert.equal(set.json.mode, 'sleep');
    assert.equal((await t.api('/api/mode', { method: 'POST', body: { mode: 'party' } })).status, 400);
    const act = (await t.api('/api/activity?limit=5')).json;
    assert.ok(act.some((e) => e.kind === 'mode' && e.text.includes('sleep')));
    await t.app.services.home.flush();
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'state.json'), 'utf8')).mode, 'sleep');
  } finally {
    await t.close();
  }
});

test('a scene drives every device and sets the mode', async () => {
  const t = await startApp();
  try {
    const commands = [];
    t.app.hub.subscribe((ev) => ev.type === 'command' && commands.push(ev.action));
    const run = (await t.api('/api/scenes/sleep/run', { method: 'POST' })).json;
    assert.equal(run.failed, 0, JSON.stringify(run.results));
    const s = (await t.api('/api/status')).json;
    assert.equal(s.home.mode, 'sleep');
    assert.ok(s.lights.devices.every((d) => d.state.power === false), 'lights off');
    assert.equal(s.door.on, false, 'door locked');
    assert.equal(s.ac.power, true);
    assert.equal(s.ac.targetTemp, 24);
    assert.deepEqual(commands, ['arm'], 'camera told to arm');
    assert.ok(s.activity.some((e) => e.kind === 'scene' && e.text.includes('Sleep')));
    assert.equal((await t.api('/api/scenes/nope/run', { method: 'POST' })).status, 404);
  } finally {
    await t.close();
  }
});

test('intruder automation fires on an alarm reported by the camera', async () => {
  const t = await startApp();
  try {
    const notify = t.app.services.notify;
    await t.api('/api/camera/presence', { method: 'POST', body: { people: 1, armed: true, alarm: false } });
    await t.api('/api/camera/presence', { method: 'POST', body: { people: 1, armed: true, alarm: true } });
    await sleep(100);
    assert.equal(notify.sent.length, 1, 'phone notified once');
    assert.match(notify.sent[0].message, /Alarm/);
    const s = (await t.api('/api/status')).json;
    assert.equal(s.door.on, false, 'door locked by the automation');
    assert.deepEqual(s.lights.devices[0].state.color, { r: 255, g: 0, b: 0 }, 'lights turned red');
    // a second alarm within the debounce window does not re-fire
    await t.api('/api/camera/presence', { method: 'POST', body: { people: 1, armed: true, alarm: false } });
    await t.api('/api/camera/presence', { method: 'POST', body: { people: 1, armed: true, alarm: true } });
    await sleep(50);
    assert.equal(notify.sent.length, 1);
    // disabled rules stay quiet; enabling is persisted
    const off = (await t.api('/api/automations/intruder', { method: 'POST', body: { enabled: false } })).json;
    assert.equal(off.enabled, false);
    await t.app.services.automations.queue;
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'automations.json'), 'utf8')).intruder.enabled, false);
    const forced = (await t.api('/api/automations/intruder/run', { method: 'POST' })).json;
    assert.equal(forced.failed, 0);
    assert.equal(notify.sent.length, 2, 'run now ignores the disabled flag');
  } finally {
    await t.close();
  }
});

test('presence enter/leave events reach the engine and the timeline', async () => {
  const t = await startApp();
  try {
    await t.api('/api/automations/welcome', { method: 'POST', body: { enabled: true } });
    await t.api('/api/lights/all', { method: 'POST', body: { power: false } });
    await t.api('/api/camera/presence', { method: 'POST', body: { people: 2, armed: false } });
    await sleep(80);
    const s = (await t.api('/api/status')).json;
    assert.ok(s.lights.devices.every((d) => d.state.power === true), 'welcome lights came on');
    assert.ok(s.activity.some((e) => e.text.includes('entered')));
    await t.api('/api/camera/presence', { method: 'POST', body: { people: 0, armed: false } });
    const act = (await t.api('/api/activity')).json;
    assert.ok(act.some((e) => e.text.includes('empty')));
    assert.ok((await t.api('/api/camera/status')).json.emptySince);
  } finally {
    await t.close();
  }
});

test('schedules fire once per matching minute', async () => {
  const t = await startApp();
  try {
    let fakeNow = new Date('2026-10-02T23:00:10');
    const engine = new AutomationEngine([{ id: 'night', name: 'Night', enabled: true, trigger: { type: 'schedule', at: '23:00' }, actions: [{ device: 'scene', id: 'sleep' }] }], t.app.services, { dataDir: t.dataDir, hub: null, activity: t.app.services.activity, now: () => fakeNow });
    const first = await engine.tick();
    assert.equal(first.length, 1, JSON.stringify(first));
    assert.equal(first[0]?.failed, 0, JSON.stringify(first));
    assert.equal(t.app.services.home.mode, 'sleep');
    t.app.services.home.setMode('home');
    assert.equal((await engine.tick()).length, 0, 'same minute: no second run');
    assert.equal(t.app.services.home.mode, 'home');
    fakeNow = new Date('2026-10-03T23:00:05');
    await engine.tick();
    assert.equal(t.app.services.home.mode, 'sleep');
    engine.close();
  } finally {
    await t.close();
  }
});

test('switches, sensors, weather and notifications', async () => {
  const t = await startApp();
  try {
    const list = (await t.api('/api/switches')).json;
    assert.equal(list.length, 3);
    const fan = (await t.api('/api/switches/fan', { method: 'POST', body: { action: 'on' } })).json;
    assert.equal(fan.on, true);
    const all = (await t.api('/api/switches/all', { method: 'POST', body: { action: 'off' } })).json;
    assert.ok(Object.values(all).every((s) => s.on === false));
    assert.equal((await t.api('/api/switches/nope', { method: 'POST', body: { action: 'on' } })).status, 404);
    const sensors = (await t.api('/api/sensors')).json;
    assert.ok(sensors.find((s) => s.kind === 'temperature').value > 20);
    const w = (await t.api('/api/weather')).json;
    assert.equal(w.description, 'Mostly clear');
    const n = (await t.api('/api/notify', { method: 'POST', body: { message: 'hello' } })).json;
    assert.equal(n.ok, true);
    assert.equal(t.app.services.notify.sent[0].message, 'hello');
    const act = (await t.api('/api/activity')).json;
    assert.ok(act.some((e) => e.kind === 'device' && e.text.includes('Ceiling fan on')));
  } finally {
    await t.close();
  }
});
