// Local development server: serves the site and (localhost only) exposes a local game
// folder under /__game/ with HTTP Range support, so the app can be tested headlessly via
// http://localhost:8022/?dev=1 without the folder picker.
// Usage: node tools/devserver.mjs "H:/Kabus 22"
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync, openAsBlob } from 'node:fs';
import { listWrsBlob } from '../src/formats/wrs.js';
import { join, extname, resolve, relative } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const game = process.argv[2] && resolve(process.argv[2]);
const PORT = +process.env.PORT || 8022;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function manifest(dir, prefix = '', out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) manifest(p, prefix + d.name + '/', out);
    else { const s = statSync(p); out.push({ path: prefix + d.name, size: s.size, mtime: Math.floor(s.mtimeMs) }); }
  }
  return out;
}

function sendFile(req, res, file, type) {
  const size = statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = +range[1], end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  }
}

let indexed = null;
createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (url === '/__game/manifest.json') {
      if (!game) { res.writeHead(404).end(); return; }
      // Same shape as tools/manifest.mjs, archive indexes included.
      indexed ||= Promise.all(manifest(game).map(async f => /.(wrs|k22)$/i.test(f.path)
        ? { ...f, index: await listWrsBlob(await openAsBlob(join(game, f.path))).catch(() => undefined) } : f));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await indexed));
      return;
    }
    if (url.startsWith('/__game/')) {
      const file = resolve(game, '.' + url.slice(7));
      if (!game || relative(game, file).startsWith('..')) { res.writeHead(403).end(); return; }
      sendFile(req, res, file, 'application/octet-stream');
      return;
    }
    let file = resolve(root, '.' + (url === '/' ? '/index.html' : url));
    if (relative(root, file).startsWith('..')) { res.writeHead(403).end(); return; }
    sendFile(req, res, file, TYPES[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(url, e);
    if (!res.headersSent) res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/  game: ${game || '(none)'}`));
