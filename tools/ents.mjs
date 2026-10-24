// Lists entity files referenced by a level: node tools/ents.mjs level.wmb
import { readFileSync } from 'node:fs';
import { parseWmb6 } from '../src/formats/wmb6.js';
const lv = parseWmb6(new Uint8Array(readFileSync(process.argv[2])));
const by = {};
for (const o of lv.objects) if (o.type === 'entity') { const k = o.file.toLowerCase(); (by[k] ||= []).push(o.action); }
for (const [f, a] of Object.entries(by)) console.log(f.padEnd(24), a.length, [...new Set(a)].join(' '));
console.log(lv.objects.reduce((m, o) => (m[o.type] = (m[o.type] || 0) + 1, m), {}));
