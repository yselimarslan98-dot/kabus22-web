import { readFileSync } from 'node:fs';
const b = readFileSync(process.argv[2]);
const L = i => ({ off: b.readUInt32LE(4 + i * 8), len: b.readUInt32LE(8 + i * 8) });
const names = ['palettes','planes','textures','vertices','pvs','nodes','materials','faces','legacy4','hulls','leafs','bspblocks','edges','edgelist','legacy7','objects','lightmaps'];
names.forEach((n, i) => console.log(i, n, L(i)));
const T = L(2); const tc = b.readUInt32LE(T.off);
console.log('textures', tc);
for (let i = 0; i < Math.min(tc, 40); i++) {
  const o = T.off + b.readUInt32LE(T.off + 4 + i * 4);
  const nm = b.subarray(o, o + 16).toString('latin1').replace(/\0.*$/s, '');
  console.log(' ', i, nm, b.readUInt32LE(o + 16), b.readUInt32LE(o + 20), [0,1,2,3].map(k => b.readUInt32LE(o + 24 + k * 4)));
}
const F = L(7), nf = F.len / 24, M = L(6);
console.log('faces', nf);
for (let i = 0; i < 12; i++) {
  const o = F.off + i * 24;
  const tex = b.readUInt16LE(o + 10), mo = M.off + tex * 64;
  console.log(' f', i, 'plane', b.readUInt16LE(o), 'side', b.readUInt16LE(o + 2), 'e', b.readUInt32LE(o + 4), 'n', b.readUInt16LE(o + 8), 'mat', tex,
    'lt', b[o + 12], b[o + 13], b[o + 14], b[o + 15], 'lm', b.readInt32LE(o + 16), 'x', b.readUInt32LE(o + 20).toString(16),
    'mtex', b.readUInt32LE(mo + 32), 'mflags', b.readUInt16LE(mo + 36), b.subarray(mo + 44, mo + 64).toString('latin1').replace(/\0.*$/s, ''));
}
