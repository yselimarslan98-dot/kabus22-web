import { readFileSync, writeFileSync } from 'node:fs';
import { png } from './png.mjs';
const [file, out] = process.argv.slice(2);
const b = readFileSync(file);
const L = i => ({ off: b.readUInt32LE(4 + i * 8), len: b.readUInt32LE(8 + i * 8) });
const T = L(2), tc = b.readUInt32LE(T.off);
for (const i of [1, 3, 21]) {
  const o = T.off + b.readUInt32LE(T.off + 4 + i * 4);
  const w = b.readUInt32LE(o + 16), h = b.readUInt32LE(o + 20), m0 = b.readUInt32LE(o + 24), m1 = b.readUInt32LE(o + 28);
  const bpp = (m1 - m0) / (w * h), base = o + m0;
  for (const fmt of bpp === 2 ? ['565', '4444', '1555'] : ['888']) {
    const px = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      let r, g, bl, a = 255;
      if (bpp === 3) { bl = b[base + p * 3]; g = b[base + p * 3 + 1]; r = b[base + p * 3 + 2]; }
      else { const v = b.readUInt16LE(base + p * 2);
        if (fmt === '565') { r = (v >> 11) << 3; g = ((v >> 5) & 63) << 2; bl = (v & 31) << 3; }
        else if (fmt === '4444') { a = (v >> 12) * 17; r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; bl = (v & 15) * 17; a = 255; }
        else { r = ((v >> 10) & 31) << 3; g = ((v >> 5) & 31) << 3; bl = (v & 31) << 3; } }
      px.set([r, g, bl, a], p * 4);
    }
    writeFileSync(`${out}/tex${i}_${fmt}.png`, png(w, h, px));
  }
}
const LM = L(16), S = 256, pages = LM.len / (S * S * 3);
const atlas = new Uint8Array(S * 4 * S * 2 * 4);
for (let pg = 0; pg < 8; pg++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const s = LM.off + pg * S * S * 3 + (y * S + x) * 3, ax = (pg % 4) * S + x, ay = Math.floor(pg / 4) * S + y, d = (ay * S * 4 + ax) * 4;
  atlas.set([b[s + 2], b[s + 1], b[s], 255], d);
}
writeFileSync(`${out}/lightmaps0-7.png`, png(S * 4, S * 2, atlas));
console.log('pages', pages);
