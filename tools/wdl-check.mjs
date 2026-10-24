// Parses the game's scripts from an extracted archive folder and reports problems.
// Usage: node tools/wdl-check.mjs H:/Kabus22_extracted
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { preprocess } from '../src/wdl/lexer.js';
import { parse } from '../src/wdl/parser.js';

const root = process.argv[2];
const order = ['K22Widescreen.wrs', 'yazi_tr.k22', 'ses_tr.k22', 'Kaynak.k22'].filter(d => existsSync(join(root, d)));
const index = new Map();
for (const d of order) for (const f of readdirSync(join(root, d))) if (!index.has(f.toLowerCase())) index.set(f.toLowerCase(), join(root, d, f));
const load = async name => {
  const p = index.get(name.toLowerCase().split(/[\/]/).pop());
  return p ? new TextDecoder('windows-1254').decode(readFileSync(p)) : null;
};
const t0 = performance.now();
const warns = [];
const { tokens, defines } = await preprocess(process.argv[3]?.endsWith('.wdl') ? process.argv[3] : 'K22Widescreen.wdl', load, { onWarn: w => warns.push(w) });
const t1 = performance.now();
const prog = parse(tokens, { onWarn: w => warns.push(w) });
const t2 = performance.now();
console.log(`${tokens.length} simge, ${defines.size} define, önişlem ${(t1 - t0) | 0} ms, ayrıştırma ${(t2 - t1) | 0} ms`);
console.log(`fonksiyon ${prog.funcs.size}, değişken ${prog.vars.length}, string ${prog.strings.length}, ses ${prog.sounds.length}, bmap ${prog.bmaps.length}, nesne ${prog.objects.length}, starter ${prog.starters.length}, tuş ${prog.keys.length}, dll ${prog.dll.size}`);
console.log(`uyarı ${warns.length}`);
for (const w of warns.slice(0, 30)) console.log('  ' + w);
export { prog };

// Compile to JS and make sure V8 accepts the result.
const { compile } = await import('../src/wdl/codegen.js');
const t3 = performance.now();
const out = compile(prog);
const t4 = performance.now();
console.log(`derleme ${(t4 - t3) | 0} ms, ${(out.source.length / 1e6).toFixed(1)} MB JS, başarısız ${out.failed.length}`);
for (const f of out.failed.slice(0, 10)) console.log('  ' + f);
try { new Function('R', out.source); console.log('JS sözdizimi: tamam'); }
catch (e) {
  console.log('JS sözdizimi hatası:', e.message);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TEMP + '/k22-out.js', out.source);
  console.log('kaynak: ' + process.env.TEMP + '/k22-out.js');
}
if (process.argv.includes('--api')) {
  console.log(`\nmotor fonksiyonları (${out.builtins.size}):`);
  console.log([...out.builtins.keys()].sort().join(' '));
  console.log(`\ntanımsız global adlar (${out.undeclared.length}):`);
  console.log(out.undeclared.sort().join(' '));
}
