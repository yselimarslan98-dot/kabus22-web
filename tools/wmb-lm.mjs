import { readFileSync } from 'node:fs';
const b = readFileSync(process.argv[2]);
const L = i => ({ off: b.readUInt32LE(4 + i * 8), len: b.readUInt32LE(8 + i * 8) });
const F = L(7), M = L(6), V = L(3), E = L(12), EL = L(13);
const nf = F.len / 24;
const h12 = {}, h13 = {}; let maxx = 0, maxy = 0;
for (let i = 0; i < nf; i++) { const o = F.off + i * 24; h12[b[o+12]] = (h12[b[o+12]]||0)+1; h13[b[o+13]] = (h13[b[o+13]]||0)+1; }
console.log('b12', h12); console.log('b13', h13);
const lmH = {}; for (let i = 0; i < nf; i++) { const o = F.off + i * 24; const v = b.readInt32LE(o + 16); lmH[v] = (lmH[v]||0)+1; }
console.log('lm field', Object.entries(lmH).slice(0, 40));
// texture-space extents per face
const vert = k => [0,1,2].map(j => b.readFloatLE(V.off + k * 12 + j * 4));
for (let i = 0; i < 16; i++) {
  const o = F.off + i * 24, fe = b.readUInt32LE(o + 4), ne = b.readUInt16LE(o + 8), mi = b.readUInt16LE(o + 10);
  const mo = M.off + mi * 64; const s = [0,1,2,3].map(k => b.readFloatLE(mo + k*4)), t = [0,1,2,3].map(k => b.readFloatLE(mo + 16 + k*4));
  let smin = 1e9, smax = -1e9, tmin = 1e9, tmax = -1e9;
  for (let k = 0; k < ne; k++) {
    const se = b.readInt32LE(EL.off + (fe + k) * 4); const ei = Math.abs(se);
    const vi = b.readUInt32LE(E.off + ei * 8 + (se < 0 ? 4 : 0)); const p = vert(vi);
    const ss = p[0]*s[0]+p[1]*s[1]+p[2]*s[2]+s[3], tt = p[0]*t[0]+p[1]*t[1]+p[2]*t[2]+t[3];
    smin = Math.min(smin, ss); smax = Math.max(smax, ss); tmin = Math.min(tmin, tt); tmax = Math.max(tmax, tt);
  }
  console.log(i, 'lm@', b[o+14], b[o+15], 'page', b[o+13], 'sExt', (smax - smin).toFixed(1), 'tExt', (tmax - tmin).toFixed(1), 's', s.map(x=>x.toFixed(3)).join(','), 'smin', smin.toFixed(1), tmin.toFixed(1));
}
