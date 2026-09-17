// Tiny static file server used by the end-to-end test (and `npm run serve`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  '.bin': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/**
 * @param {string} root directory to serve
 * @param {Record<string,string>} mounts extra url-prefix -> directory mappings
 */
export function startServer(root, mounts = {}, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    let base = root;
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (pathname.startsWith(prefix)) {
        base = dir;
        pathname = pathname.slice(prefix.length);
        break;
      }
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(base, pathname));
    if (!file.startsWith(path.normalize(base))) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const { url } = await startServer(root, {}, Number(process.env.PORT) || 8080);
  console.log(`Serving ${root} at ${url}`);
}
