// Runs the game's scripts headless with a logging host to see what they ask from the engine.
// Usage: node tools/wdl-run.mjs H:/Kabus22_extracted [frames]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { preprocess } from '../src/wdl/lexer.js';
import { parse } from '../src/wdl/parser.js';
import { compile } from '../src/wdl/codegen.js';
import { Runtime } from '../src/wdl/runtime.js';

const root = process.argv[2];
const frames = +process.argv[3] || 120;
const order = ['K22Widescreen.wrs', 'yazi_tr.k22', 'ses_tr.k22', 'Kaynak.k22'].filter(d => existsSync(join(root, d)));
const index = new Map();
for (const d of order) for (const f of readdirSync(join(root, d))) if (!index.has(f.toLowerCase())) index.set(f.toLowerCase(), join(root, d, f));
const load = async name => {
  const p = index.get(name.toLowerCase().split(/[\/]/).pop());
  return p ? new TextDecoder('windows-1254').decode(readFileSync(p)) : null;
};
const { tokens } = await preprocess('K22Widescreen.wdl', load);
const compiled = compile(parse(tokens));
const log = [];
const R = new Runtime({ onWarn: m => log.push(m), onError: (m, e) => log.push('HATA ' + m + '\n' + e.stack.split('\n').slice(1, 4).join('\n')) });
R.load(compiled);
R.start();
for (let i = 0; i < frames; i++) R.frame(1 / 60);
console.log(`görev: ${R.tasks.length}, çağrı: ${R.stats.calls}`);
console.log([...new Set(log)].slice(0, 60).join('\n'));
console.log('aktif görevler:', [...new Set(R.tasks.map(t => t.name))].slice(0, 30).join(' '));
