// Writes manifest.json into a Kabus 22 folder so the web engine can read it from remote storage.
// Usage: node tools/manifest.mjs "H:/Kabus 22"
import { readdirSync, statSync, writeFileSync, openAsBlob } from 'node:fs';
import { listWrsBlob } from '../src/formats/wrs.js';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('kullanım: node tools/manifest.mjs <oyun klasörü>'); process.exit(1); }
const out = [];
(function walk(d, prefix) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name), prefix + e.name + '/');
    else if (e.name !== 'manifest.json') {
      const s = statSync(join(d, e.name));
      out.push({ path: prefix + e.name, size: s.size, mtime: Math.floor(s.mtimeMs) });
    }
  }
})(dir, '');
// Archive indexes go into the manifest so the first visit needs no header scan over the network.
for (const f of out) if (/.(wrs|k22)$/i.test(f.path)) f.index = await listWrsBlob(await openAsBlob(join(dir, f.path))).catch(() => undefined);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(out));
console.log(`${out.length} dosya, ${(out.reduce((a, f) => a + f.size, 0) / 1e9).toFixed(2)} GB -> manifest.json`);
