// Minecraft Java Edition: server list ping (status), RCON commands, and
// start / stop / restart through configurable shell commands.

import net from 'node:net';
import { exec } from 'node:child_process';
import { HttpError } from './http.js';

// ---------------- protocol helpers ----------------
export function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  if (value < 0) v = value + 0x100000000; // two's complement in 32 bits
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

export function readVarint(buf, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null; // need more data
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  }
  return { value: result | 0, size: pos - offset };
}

function packet(id, ...parts) {
  const body = Buffer.concat([encodeVarint(id), ...parts]);
  return Buffer.concat([encodeVarint(body.length), body]);
}

function mcString(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([encodeVarint(b.length), b]);
}

export function flattenChat(desc) {
  if (desc == null) return '';
  if (typeof desc === 'string') return desc;
  let out = desc.text || '';
  if (Array.isArray(desc.extra)) out += desc.extra.map(flattenChat).join('');
  return out;
}

/** Server list ping. Resolves { online:false, error } instead of rejecting when the server is down. */
export function pingStatus({ host = '127.0.0.1', port = 25565, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ online: false, error: 'timeout' }));
    socket.on('error', (e) => finish({ online: false, error: e.code || e.message }));
    socket.connect(port, host, () => {
      const handshake = packet(0x00, encodeVarint(47), mcString(host), Buffer.from([(port >> 8) & 0xff, port & 0xff]), encodeVarint(1));
      socket.write(Buffer.concat([handshake, packet(0x00)]));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const len = readVarint(buf, 0);
      if (!len) return;
      if (buf.length < len.size + len.value) return;
      try {
        let pos = len.size;
        const id = readVarint(buf, pos);
        pos += id.size;
        const strLen = readVarint(buf, pos);
        pos += strLen.size;
        const json = JSON.parse(buf.subarray(pos, pos + strLen.value).toString('utf8'));
        finish({
          online: true,
          latencyMs: Date.now() - started,
          version: json.version?.name || '',
          protocol: json.version?.protocol ?? null,
          players: {
            online: json.players?.online ?? 0,
            max: json.players?.max ?? 0,
            sample: (json.players?.sample || []).map((p) => p.name),
          },
          motd: flattenChat(json.description),
          favicon: typeof json.favicon === 'string' ? json.favicon : null,
        });
      } catch (e) {
        finish({ online: false, error: `bad response: ${e.message}` });
      }
    });
  });
}

function rconPacket(id, type, payload) {
  const body = Buffer.from(String(payload), 'utf8');
  const buf = Buffer.alloc(4 + 4 + 4 + body.length + 2);
  buf.writeInt32LE(4 + 4 + body.length + 2, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  return buf;
}

function parseRconPackets(buf) {
  const out = [];
  let pos = 0;
  while (buf.length - pos >= 4) {
    const len = buf.readInt32LE(pos);
    if (buf.length - pos - 4 < len) break;
    const id = buf.readInt32LE(pos + 4);
    const type = buf.readInt32LE(pos + 8);
    const payload = buf.subarray(pos + 12, pos + 4 + len - 2).toString('utf8');
    out.push({ id, type, payload });
    pos += 4 + len;
  }
  return { packets: out, rest: buf.subarray(pos) };
}

/** Run one RCON command. Rejects on auth failure or connection problems. */
export function rconCommand({ host = '127.0.0.1', port = 25575, password = '', command = 'list', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!password) return reject(new HttpError(400, 'RCON password is not configured'));
    const socket = new net.Socket();
    let buf = Buffer.alloc(0);
    let stage = 'login';
    let output = '';
    let settle = null;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new HttpError(504, 'RCON timeout')));
    socket.on('error', (e) => finish(new HttpError(502, `RCON connection failed: ${e.code || e.message}`)));
    socket.connect(port, host, () => socket.write(rconPacket(1, 3, password)));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = parseRconPackets(buf);
      buf = rest;
      for (const p of packets) {
        if (stage === 'login') {
          if (p.type !== 2) continue; // servers may send an empty type-0 first
          if (p.id === -1) return finish(new HttpError(401, 'RCON password rejected'));
          stage = 'command';
          socket.write(rconPacket(2, 2, command));
        } else if (p.id === 2) {
          output += p.payload;
          // Long answers arrive in several packets; wait briefly for more.
          clearTimeout(settle);
          settle = setTimeout(() => finish(null, output), 150);
        }
      }
    });
  });
}

function run(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!command) return reject(new HttpError(400, 'No command configured for this action (see server/config.json)'));
    exec(command, { timeout: timeoutMs, shell: true }, (err, stdout, stderr) => {
      if (err) reject(new HttpError(500, `${command} failed: ${stderr || err.message}`));
      else resolve({ ok: true, stdout: String(stdout).slice(-2000) });
    });
  });
}

export class MinecraftService {
  constructor(cfg, { mock = false } = {}) {
    this.cfg = cfg;
    this.mock = mock;
    this.sim = { online: true, players: ['Steve', 'Alex'], max: 20, version: '1.21.4 (mock)', motd: 'Mock Minecraft server' };
    this.lastStatus = null;
  }

  async status() {
    if (!this.cfg.enabled) return { enabled: false, online: false };
    if (this.mock) {
      return this.sim.online
        ? { enabled: true, online: true, latencyMs: 3, version: this.sim.version, players: { online: this.sim.players.length, max: this.sim.max, sample: this.sim.players }, motd: this.sim.motd }
        : { enabled: true, online: false, error: 'ECONNREFUSED' };
    }
    const s = await pingStatus({ host: this.cfg.host, port: this.cfg.port });
    this.lastStatus = { ...s, enabled: true, host: this.cfg.host, port: this.cfg.port, checkedAt: Date.now() };
    return this.lastStatus;
  }

  async start() {
    if (this.mock) {
      this.sim.online = true;
      return { ok: true, stdout: 'mock server started' };
    }
    return run(this.cfg.startCommand);
  }

  async stop() {
    if (this.mock) {
      this.sim.online = false;
      return { ok: true, stdout: 'mock server stopped' };
    }
    if (this.cfg.stopCommand) return run(this.cfg.stopCommand);
    // No stop command: a graceful RCON "stop" also works on any vanilla / Paper server.
    const out = await this.rcon('stop');
    return { ok: true, stdout: out };
  }

  async restart() {
    if (this.mock) return { ok: true, stdout: 'mock server restarted' };
    if (this.cfg.restartCommand) return run(this.cfg.restartCommand);
    await this.stop();
    await new Promise((r) => setTimeout(r, 5000));
    return this.start();
  }

  async rcon(command) {
    if (!command || typeof command !== 'string') throw new HttpError(400, 'command required');
    if (this.mock) {
      if (command.trim() === 'list') return `There are ${this.sim.players.length} of a max of ${this.sim.max} players online: ${this.sim.players.join(', ')}`;
      if (command.trim() === 'stop') {
        this.sim.online = false;
        return 'Stopping the server';
      }
      return `[mock] ran: ${command}`;
    }
    return rconCommand({ ...this.cfg.rcon, command });
  }
}
