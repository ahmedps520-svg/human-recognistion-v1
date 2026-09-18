// Small HTTP helpers shared by the routes: JSON bodies, raw bodies, CORS,
// Server-Sent Events and error shaping. No dependencies.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function setCors(res, origin = '*') {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Meta');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

export function readBody(req, { limit = 200 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, { limit = 5 * 1024 * 1024 } = {}) {
  const raw = await readBody(req, { limit });
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/** Keeps a set of SSE clients and broadcasts JSON events to them. */
export class SseHub {
  constructor() {
    this.clients = new Set();
    this.keepalive = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 25000);
    this.keepalive.unref();
  }

  attach(req, res, { initial = null } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (initial) res.write(`event: ${initial.type}\ndata: ${JSON.stringify(initial)}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  broadcast(event) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close() {
    clearInterval(this.keepalive);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.bin': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
