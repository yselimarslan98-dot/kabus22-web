// Acknex HMP4/HMP5 terrain: a regular height grid with one skin covering the whole terrain.
// Header (after "HMP5"): u32, scale[3], offset[3], f32, trisize_x, trisize_y, numverts_x (float),
// numskins, u32, u32, numverts, u32, numframes, u32, flags, u32; then skins (type, w, h, pixels),
// then the frame: type, bbox (2 packed vertices), name[16], vertices (u16 height, u8 normal, u8).
// Output has the same shape as parseMdl (scene-space positions) so it renders like a model.

const BPP = { 2: 2, 3: 2, 4: 3, 5: 4 };

export function parseHmp(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(...u8.subarray(0, 4));
  if (magic !== 'HMP4' && magic !== 'HMP5') throw new Error(`desteklenmeyen arazi: ${magic}`);
  const f32 = o => dv.getFloat32(o, true), u32 = o => dv.getUint32(o, true);
  const scale = [f32(8), f32(12), f32(16)], offset = [f32(20), f32(24), f32(28)];
  const triX = f32(36), triY = f32(40), nx = Math.round(f32(44));
  const numSkins = u32(48), numVerts = u32(60);
  const ny = Math.round(numVerts / nx);

  let o = 84;
  const skins = [];
  for (let i = 0; i < numSkins; i++) {
    const type = u32(o), w = u32(o + 4), h = u32(o + 8);
    o += 12;
    const fmt = type & 7, b = BPP[fmt] || 3;
    const px = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const s = o + p * b;
      if (b === 2) {
        const v = dv.getUint16(s, true);
        px[p * 4] = (v >> 11) * 255 / 31; px[p * 4 + 1] = ((v >> 5) & 63) * 255 / 63; px[p * 4 + 2] = (v & 31) * 255 / 31;
      } else { px[p * 4] = u8[s + 2]; px[p * 4 + 1] = u8[s + 1]; px[p * 4 + 2] = u8[s]; }
      px[p * 4 + 3] = 255;
    }
    skins.push({ width: w, height: h, data: px, alpha: false });
    o += b * w * h;
    if (type & 8) o += b * ((w >> 1) * (h >> 1) + (w >> 2) * (h >> 2) + (w >> 3) * (h >> 3));
  }

  const packing = u32(o);
  const vs = packing === 2 ? 4 : 2;            // 16-bit height + normal + pad, or 8-bit height + normal
  o += 4 + 2 * (packing === 2 ? 8 : 4) + 16;   // type, bbox min/max, name

  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, s = o + k * vs;
      const raw = packing === 2 ? dv.getUint16(s, true) : u8[s];
      const x = offset[0] + i * triX, y = offset[1] + j * triY, z = raw * scale[2] + offset[2];
      // Acknex (x fwd, y left, z up) -> scene (x, z, -y)
      pos[k * 3] = x; pos[k * 3 + 1] = z; pos[k * 3 + 2] = -y;
      uv[k * 2] = i / (nx - 1); uv[k * 2 + 1] = 1 - j / (ny - 1);
    }
  }
  const index = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  return { version: magic, terrain: true, skins, uv, index, frames: [{ name: 'terrain', pos }], nx, ny };
}
