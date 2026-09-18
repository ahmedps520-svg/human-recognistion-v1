import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer } from '../index.js';
import { loadConfig } from '../lib/config.js';
import { encodeVarint, readVarint, pingStatus, rconCommand, flattenChat } from '../lib/minecraft.js';

const TOKEN = 'test-token';

async function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-server-'));
  const config = loadConfig({ port: 0, host: '127.0.0.1', token: TOKEN, mock: true, dataDir, serveSite: true, ...extra });
  const app = createServer(config);
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (p, { method = 'GET', body, raw, headers = {} } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, base, api, dataDir, close: async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('auth: health is open, everything else needs the token', async () => {
  const t = await startApp();
  try {
    const health = await fetch(`${t.base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    const noAuth = await fetch(`${t.base}/api/status`);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`${t.base}/api/status`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    const viaQuery = await fetch(`${t.base}/api/status?token=${TOKEN}`);
    assert.equal(viaQuery.status, 200);
    const cors = await fetch(`${t.base}/api/status`, { method: 'OPTIONS' });
    assert.equal(cors.status, 204);
    assert.equal(cors.headers.get('access-control-allow-origin'), '*');
  } finally {
    await t.close();
  }
});

test('status aggregates every device in mock mode', async () => {
  const t = await startApp();
  try {
    const { json } = await t.api('/api/status');
    assert.equal(json.mock, true);
    assert.equal(json.camera.online, false);
    assert.equal(json.minecraft.online, true);
    assert.equal(json.minecraft.players.online, 2);
    assert.equal(json.ac.adapter, 'mock');
    assert.equal(json.door.adapter, 'mock');
    assert.equal(json.lights.devices.length, 2);
  } finally {
    await t.close();
  }
});

test('camera: frames, presence, MJPEG stream and commands', async () => {
  const t = await startApp();
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);
    const posted = await t.api('/api/camera/frame?meta=' + encodeURIComponent(JSON.stringify({ people: 1, armed: true, recording: true, tracks: [{ id: 1 }] })), { method: 'POST', raw: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(posted.status, 200);
    const frame = await fetch(`${t.base}/api/camera/frame.jpg?token=${TOKEN}`);
    assert.equal(frame.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await frame.arrayBuffer()).length, jpeg.length);
    const status = (await t.api('/api/camera/status')).json;
    assert.equal(status.online, true);
    assert.equal(status.presence.people, 1);
    assert.equal(status.presence.armed, true);

    // MJPEG: the first multipart chunk is the current frame
    const ctrl = new AbortController();
    const stream = await fetch(`${t.base}/api/camera/stream?token=${TOKEN}`, { signal: ctrl.signal });
    assert.match(stream.headers.get('content-type'), /multipart\/x-mixed-replace/);
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString('latin1'), /--frame\r\nContent-Type: image\/jpeg/);
    ctrl.abort();

    // commands go out over SSE
    const sseCtrl = new AbortController();
    const sse = await fetch(`${t.base}/api/events?token=${TOKEN}`, { signal: sseCtrl.signal });
    const sseReader = sse.body.getReader();
    let text = Buffer.from((await sseReader.read()).value).toString();
    assert.match(text, /event: status/);
    const cmd = await t.api('/api/camera/command', { method: 'POST', body: { action: 'arm' } });
    assert.equal(cmd.json.action, 'arm');
    text = Buffer.from((await sseReader.read()).value).toString();
    assert.match(text, /event: command/);
    assert.match(text, /"action":"arm"/);
    sseCtrl.abort();
    const bad = await t.api('/api/camera/command', { method: 'POST', body: { action: 'explode' } });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
  }
});

test('camera: visits, media, profiles and calibration persist on disk', async () => {
  const t = await startApp();
  try {
    const ins = await t.api('/api/camera/events', { method: 'POST', body: { startedAt: '2026-09-18T10:00:00.000Z', verdict: 'person' } });
    assert.equal(ins.status, 200);
    const id = ins.json.id;
    const upd = await t.api(`/api/camera/events/${id}`, { method: 'PUT', body: { endedAt: '2026-09-18T10:01:00.000Z', clipPath: '2026/09/18/x.webm' } });
    assert.equal(upd.json.endedAt, '2026-09-18T10:01:00.000Z');
    const list = (await t.api('/api/camera/events?limit=5')).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].clipPath, '2026/09/18/x.webm');

    const media = await t.api('/api/camera/media/2026/09/18/x.webm', { method: 'PUT', raw: Buffer.from('webm-bytes'), headers: { 'Content-Type': 'video/webm' } });
    assert.equal(media.json.bytes, 10);
    const got = await fetch(`${t.base}/api/camera/media/2026/09/18/x.webm?token=${TOKEN}`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'webm-bytes');
    const traversal = await t.api('/api/camera/media/../../etc/passwd');
    assert.ok([400, 404].includes(traversal.status), 'plain traversal is neutralised');
    const encoded = await t.api('/api/camera/media/%2e%2e/%2e%2e/etc/passwd');
    assert.ok([400, 404].includes(encoded.status), 'encoded traversal is neutralised');
    assert.throws(() => t.app.services.camera.mediaPath('../../etc/passwd'), /Bad media path/);
    assert.throws(() => t.app.services.camera.mediaPath('a/%2e%2e/b'), /Bad media path/);
    assert.throws(() => t.app.services.camera.mediaPath('/etc/passwd/../x'), /Bad media path/);

    await t.api('/api/camera/profiles', { method: 'PUT', body: [{ id: 'p1', name: 'Mom' }] });
    assert.equal((await t.api('/api/camera/profiles')).json[0].name, 'Mom');
    await t.api('/api/camera/calibration?label=cam1', { method: 'PUT', body: { calibration: { a: 0, b: 0.005 } } });
    assert.equal((await t.api('/api/camera/calibration?label=cam1')).json.calibration.b, 0.005);

    const del = await t.api(`/api/camera/events/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await t.api('/api/camera/events')).json.length, 0);
    await t.app.services.camera.flush();
    assert.ok(fs.existsSync(path.join(t.dataDir, 'events.json')));
    assert.equal(fs.existsSync(path.join(t.dataDir, 'media/2026/09/18/x.webm')), false, 'deleting the visit removes its clip');
  } finally {
    await t.close();
  }
});

test('devices: minecraft, ac, door and lights in mock mode', async () => {
  const t = await startApp();
  try {
    let mc = (await t.api('/api/minecraft')).json;
    assert.equal(mc.online, true);
    const rcon = await t.api('/api/minecraft/rcon', { method: 'POST', body: { command: 'list' } });
    assert.match(rcon.json.output, /2 of a max of 20/);
    await t.api('/api/minecraft/stop', { method: 'POST' });
    mc = (await t.api('/api/minecraft')).json;
    assert.equal(mc.online, false);
    await t.api('/api/minecraft/start', { method: 'POST' });
    assert.equal((await t.api('/api/minecraft')).json.online, true);

    let ac = (await t.api('/api/ac', { method: 'POST', body: { power: true, targetTemp: 21.4, mode: 'cool' } })).json;
    assert.equal(ac.power, true);
    assert.equal(ac.targetTemp, 21);
    const badMode = await t.api('/api/ac', { method: 'POST', body: { mode: 'turbo' } });
    assert.equal(badMode.status, 400);
    ac = (await t.api('/api/ac', { method: 'POST', body: { targetTemp: 99 } })).json;
    assert.equal(ac.targetTemp, 30, 'clamped to maxTemp');

    let door = (await t.api('/api/door')).json;
    assert.equal(door.on, false);
    door = (await t.api('/api/door', { method: 'POST', body: { action: 'open' } })).json;
    assert.equal(door.on, true);
    door = (await t.api('/api/door/lock', { method: 'POST', body: { action: 'lock', reason: 'unknown person detected' } })).json;
    assert.equal(door.on, false, 'Room Guard alarm webhook locks the door');
    const probe = (await t.api('/api/door/lock', { method: 'POST', body: { action: 'test' } })).json;
    assert.equal(probe.test, true);
    door = (await t.api('/api/door', { method: 'POST', body: { action: 'toggle' } })).json;
    assert.equal(door.on, true);

    const lights = (await t.api('/api/lights')).json;
    assert.equal(lights.devices.length, 2);
    const dev = lights.devices[1].device;
    const on = (await t.api(`/api/lights/${encodeURIComponent(dev)}`, { method: 'POST', body: { power: true, brightness: 55, color: { r: 10, g: 20, b: 30 } } })).json;
    assert.equal(on.power, true);
    assert.equal(on.brightness, 55);
    assert.deepEqual(on.color, { r: 10, g: 20, b: 30 });
    const all = (await t.api('/api/lights/all', { method: 'POST', body: { power: false } })).json;
    assert.ok(Object.values(all).every((s) => s.power === false));
    const nothing = await t.api(`/api/lights/${encodeURIComponent(dev)}`, { method: 'POST', body: {} });
    assert.equal(nothing.status, 400);
  } finally {
    await t.close();
  }
});

test('static site is served, private folders are not', async () => {
  const t = await startApp();
  try {
    const index = await fetch(`${t.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Room Guard/);
    const dash = await fetch(`${t.base}/dashboard.html`);
    assert.equal(dash.status, 200);
    assert.equal((await fetch(`${t.base}/server/config.json`)).status, 404);
    assert.equal((await fetch(`${t.base}/.git/config`)).status, 404);
  } finally {
    await t.close();
  }
});

// ---------------- Minecraft protocol against fake servers ----------------
test('varint round trip', () => {
  for (const v of [0, 1, 127, 128, 255, 300, 25565, 2147483647, -1]) {
    const buf = encodeVarint(v);
    const back = readVarint(buf, 0);
    assert.equal(back.value, v, `value ${v}`);
    assert.equal(back.size, buf.length);
  }
  assert.equal(readVarint(Buffer.from([0x80]), 0), null, 'incomplete varint');
  assert.equal(flattenChat({ text: 'A ', extra: [{ text: 'B' }, 'C'] }), 'A BC');
});

function fakeMinecraft() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        // Wait for handshake + status request (two packets); then answer.
        if (buf.length < 3) return;
        const json = JSON.stringify({ version: { name: '1.21.4', protocol: 769 }, players: { online: 1, max: 20, sample: [{ name: 'Steve', id: 'x' }] }, description: { text: 'Hello ', extra: [{ text: 'world' }] } });
        const str = Buffer.from(json, 'utf8');
        const body = Buffer.concat([encodeVarint(0), encodeVarint(str.length), str]);
        socket.write(Buffer.concat([encodeVarint(body.length), body]));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function fakeRcon(password) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      let authed = false;
      const send = (id, type, payload) => {
        const body = Buffer.from(payload, 'utf8');
        const out = Buffer.alloc(14 + body.length);
        out.writeInt32LE(10 + body.length, 0);
        out.writeInt32LE(id, 4);
        out.writeInt32LE(type, 8);
        body.copy(out, 12);
        socket.write(out);
      };
      socket.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 4) {
          const len = buf.readInt32LE(0);
          if (buf.length < 4 + len) break;
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const payload = buf.subarray(12, 4 + len - 2).toString('utf8');
          buf = buf.subarray(4 + len);
          if (type === 3) {
            authed = payload === password;
            send(authed ? id : -1, 2, '');
          } else if (type === 2 && authed) {
            send(id, 0, payload === 'list' ? 'There are 1 of a max of 20 players online: Steve' : `ran ${payload}`);
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('server list ping parses a real-shaped status response', async () => {
  const mc = await fakeMinecraft();
  try {
    const s = await pingStatus({ host: '127.0.0.1', port: mc.port, timeoutMs: 2000 });
    assert.equal(s.online, true);
    assert.equal(s.version, '1.21.4');
    assert.equal(s.players.online, 1);
    assert.deepEqual(s.players.sample, ['Steve']);
    assert.equal(s.motd, 'Hello world');
  } finally {
    mc.server.close();
  }
  const down = await pingStatus({ host: '127.0.0.1', port: 1, timeoutMs: 1000 });
  assert.equal(down.online, false);
});

test('rcon logs in and runs commands, rejects a bad password', async () => {
  const r = await fakeRcon('hunter2');
  try {
    const out = await rconCommand({ host: '127.0.0.1', port: r.port, password: 'hunter2', command: 'list' });
    assert.match(out, /Steve/);
    await assert.rejects(rconCommand({ host: '127.0.0.1', port: r.port, password: 'wrong', command: 'list' }), /rejected/);
  } finally {
    r.server.close();
  }
});
