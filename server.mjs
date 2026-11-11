// Zero-dependency static dev server.
//
//   node server.mjs [port]
//
// Serves the game at http://127.0.0.1:8788/
// If the port is taken (an earlier `npm start` is still up) we walk forward to
// the next free port instead of dying with EADDRINUSE.
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};

function isPathSafe(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + '/');
}

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  let target = join(ROOT, normalize(clean).replace(/^(\.\.[/\\])+/, ''));
  if (!isPathSafe(ROOT, target)) return null;
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      if (!isPathSafe(ROOT, target)) return null;
      return { file: target, size: (await stat(target)).size };
    }
    return { file: target, size: info.size };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const start = Date.now();
  try {
    const found = await resolveFile(req.url === '/' ? '/index.html' : req.url);
    if (!found) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 not found: ' + req.url);
      return;
    }
    const body = await readFile(found.file);
    const type = MIME[extname(found.file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-cache',
      // Needed so the ES module graph can be imported from a file:// -less dev
      // origin without the CORS preflight noise in some Chrome builds.
      'access-control-allow-origin': '*',
    };
    res.writeHead(200, headers);
    res.end(body);
    const ms = Date.now() - start;
    if (!req.url.startsWith('/favicon')) {
      console.log(`${req.method} ${req.url} -> 200 ${type} ${found.size}b ${ms}ms`);
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('500 ' + err.message);
  }
});

function portFree(port) {
  return new Promise((done) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    sock.setTimeout(400);
    sock.once('connect', () => {
      sock.destroy();
      done(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      done(true);
    });
    sock.once('error', () => done(true));
  });
}

const BASE = Number(process.env.PORT || process.argv[2] || 8788);

async function main() {
  let port = BASE;
  for (let i = 0; i < 25; i++) {
    if (await portFree(port)) break;
    if (process.env.PORT_STRICT === '1') {
      console.error(`port ${port} is already in use`);
      process.exit(1);
    }
    port++;
  }
  server.listen(port, '127.0.0.1', () => {
    console.log(`dino-3d -> http://127.0.0.1:${port}/`);
  });
}

main();
