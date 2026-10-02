import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { HomeAgent } from '../lib/agent.js';
import { Cloud } from '../../assets/js/cloud.js';
import { FakeCloudDB, createClientFor } from '../../tests/fake-cloud/node.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(15);
  }
  return fn();
};

async function setup() {
  const db = new FakeCloudDB({ users: { 'me@example.com': 'secret' } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-agent-'));
  const config = loadConfig({ mock: true, dataDir, roomName: 'Test room' });
  const mk = async (role) => {
    const c = new Cloud({ url: 'https://test.supabase.co', anonKey: 'anon', createClient: createClientFor(db), role });
    await c.init();
    await c.signIn('me@example.com', 'secret');
    return c;
  };
  const agentCloud = await mk('agent');
  const dash = await mk('dashboard');
  await dash.join({ wantsFrames: false });
  const agent = new HomeAgent({ cloud: agentCloud, config, log: () => {} });
  await agent.start();
  return {
    db, agent, dash, mk, config,
    devices: () => dash.listDevices(),
    close: async () => {
      await agent.stop();
      await dash.close();
      await agentCloud.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('the agent announces itself and mirrors every device into the cloud', async () => {
  const t = await setup();
  try {
    assert.ok(await until(() => !!t.dash.presence.agent), 'dashboard sees the agent');
    assert.equal(t.dash.presence.agent.mock, true);
    const d = await t.devices();
    for (const name of ['agent', 'notify', 'scenes', 'automations', 'door', 'ac', 'lights', 'switches', 'sensors', 'minecraft', 'weather']) assert.ok(d[name], `${name} mirrored`);
    assert.equal(d.notify.adapter, 'mock');
    assert.ok(d.scenes.list.length >= 5);
    assert.equal(d.automations.list.find((a) => a.id === 'intruder').enabled, true);
    assert.equal(d.switches.list.length, 3);
    assert.equal(d.lights.devices.length >= 1, true);
  } finally {
    await t.close();
  }
});

test('dashboard commands reach the devices and the mirror follows', async () => {
  const t = await setup();
  try {
    const r = await t.dash.command('agent', 'door', { action: 'open' });
    assert.equal(r.ok, true);
    assert.equal(r.state.on, true);
    assert.ok(await until(async () => (await t.devices()).door?.on === true), 'door state mirrored');
    assert.equal((await t.devices()).door.on, true);

    const ac = await t.dash.command('agent', 'ac', { changes: { power: true, targetTemp: 21, mode: 'cool' } });
    assert.equal(ac.state.targetTemp, 21);
    const sw = await t.dash.command('agent', 'switch', { id: 'desk', action: 'on' });
    assert.equal(sw.state.on, true);
    const mc = await t.dash.command('agent', 'minecraft.rcon', { command: 'list' });
    assert.match(mc.output, /players/i);
    const bad = await t.dash.command('agent', 'nonsense').catch((e) => e);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Unknown command/);
    const act = await t.dash.listActivity(10);
    assert.ok(act.some((e) => e.kind === 'door'));
  } finally {
    await t.close();
  }
});

test('scenes set the mode and arm the camera through the shared room row', async () => {
  const t = await setup();
  try {
    const r = await t.dash.command('agent', 'scene', { id: 'away' });
    assert.equal(r.name, 'Away');
    assert.ok(await until(async () => (await t.dash.getHome()).mode === 'away'), 'mode away');
    const home = await t.dash.getHome();
    assert.equal(home.armed, true, 'scene armed the camera via the home row');
    assert.equal((await t.devices()).door.on, false, 'door locked');
    assert.ok(await until(async () => (await t.devices()).scenes.list.find((s) => s.id === 'away').lastRun), 'scene lastRun mirrored');
    const act = await t.dash.listActivity(10);
    assert.ok(act.some((e) => e.kind === 'scene'));
    assert.ok(act.some((e) => e.kind === 'mode' && e.text.includes('away')));
  } finally {
    await t.close();
  }
});

test('automation switches live in the room row; the intruder response fires on the camera alarm', async () => {
  const t = await setup();
  try {
    const camera = await t.mk('camera');
    await camera.join({ people: 1, armed: true, running: true, alarm: false });
    assert.ok(await until(() => t.agent.camera.presence.people === 1), 'agent follows camera presence');

    // dashboard disables the rule -> agent obeys
    await t.dash.setHome({ automations: { intruder: { enabled: false } } });
    assert.ok(await until(() => t.agent.services.automations.rules.find((r) => r.id === 'intruder').enabled === false), 'rule disabled');
    assert.ok(await until(async () => (await t.devices()).automations.list.find((a) => a.id === 'intruder').enabled === false), 'mirror shows it disabled');

    // the dashboard unlocked the door; the alarm must lock it again and notify
    await t.dash.command('agent', 'door', { action: 'open' });
    await t.dash.setHome({ automations: { intruder: { enabled: true } } });
    assert.ok(await until(() => t.agent.services.automations.rules.find((r) => r.id === 'intruder').enabled === true), 'rule enabled again');
    await camera.setHome({ alarm: true, alarmAt: new Date().toISOString() });
    assert.ok(await until(() => t.agent.services.notify.sent.length === 1, 4000), 'phone notified');
    assert.match(t.agent.services.notify.sent[0].message, /Alarm/);
    assert.ok(await until(async () => (await t.devices()).door.on === false), 'door locked by the intruder response');
    const lights = (await t.devices()).lights;
    assert.equal(lights.devices[0].state.color.r, 255);
    const act = await t.dash.listActivity(10);
    assert.ok(act.some((e) => e.kind === 'automation' && e.text.includes('Intruder')));

    // same alarm again does not re-fire
    await camera.setHome({ roomName: 'Still alarmed' });
    await sleep(100);
    assert.equal(t.agent.services.notify.sent.length, 1);
    await camera.close();
  } finally {
    await t.close();
  }
});
