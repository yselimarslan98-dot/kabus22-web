// Usage: node tools/wrs-cli.mjs list <file.wrs>
//        node tools/wrs-cli.mjs extract <file.wrs> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { listWrs, readEntry } from '../src/formats/wrs.js';

const [cmd, file, outDir] = process.argv.slice(2);
const buf = readFileSync(file);
const entries = listWrs(buf);
if (cmd === 'list') {
  for (const e of entries) console.log(`${String(e.size).padStart(10)} ${String(e.packedSize).padStart(10)}  ${e.name}`);
  console.log(`${entries.length} entries`);
} else if (cmd === 'extract') {
  for (const e of entries) {
    const dst = join(outDir, e.name.replace(/\\/g, '/'));
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readEntry(buf, e));
  }
  console.log(`extracted ${entries.length} entries to ${outDir}`);
}
