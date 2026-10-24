// Acknex MDL4 / MDL5 / MDL7 model reader.
// Layout follows ikskuh/libgamestudio (MIT), see ref/mdl.zig; skin flags checked against the game's files.
//
// Output is renderer-ready: corners with distinct (vertex, uv) pairs are split, so every frame is a flat
// Float32Array of positions in scene space (x, z, -y) indexed by the same `index` buffer.

const FMT = { 0: 1, 2: 2, 3: 2, 4: 3, 5: 4 };   // skin format -> bytes per pixel
const MIPS = 0x08, MATERIAL = 0x10, MATDEF = 0x20;

export function parseMdl(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(...u8.subarray(0, 4));
  if (magic === 'MDL7') return parseMdl7(u8, dv);
  if (magic === 'MDL4' || magic === 'MDL5') return parseMdl45(u8, dv, magic);
  throw new Error(`desteklenmeyen model: ${magic}`);
}

function readSkinPixels(u8, dv, o, fmt, w, h) {
  const n = w * h, px = new Uint8Array(n * 4);
  if (fmt === 2) {
    for (let p = 0; p < n; p++) {
      const v = dv.getUint16(o + p * 2, true);
      px[p * 4] = (v >> 11) * 255 / 31; px[p * 4 + 1] = ((v >> 5) & 63) * 255 / 63; px[p * 4 + 2] = (v & 31) * 255 / 31; px[p * 4 + 3] = 255;
    }
  } else if (fmt === 3) {
    for (let p = 0; p < n; p++) {
      const v = dv.getUint16(o + p * 2, true);
      px[p * 4] = ((v >> 8) & 15) * 17; px[p * 4 + 1] = ((v >> 4) & 15) * 17; px[p * 4 + 2] = (v & 15) * 17; px[p * 4 + 3] = (v >> 12) * 17;
    }
  } else if (fmt === 4 || fmt === 5) {
    const b = FMT[fmt];
    for (let p = 0, s = o; p < n; p++, s += b) {
      px[p * 4] = u8[s + 2]; px[p * 4 + 1] = u8[s + 1]; px[p * 4 + 2] = u8[s]; px[p * 4 + 3] = b === 4 ? u8[s + 3] : 255;
    }
  } else {
    px.fill(160);
  }
  return { width: w, height: h, data: px, alpha: fmt === 3 || fmt === 5 };
}

// Byte size of a skin's pixel data including the optional 3 mip levels.
function skinBytes(fmt, w, h, mips) {
  const b = FMT[fmt] || 0;
  return b * w * h + (mips ? b * ((w >> 1) * (h >> 1) + (w >> 2) * (h >> 2) + (w >> 3) * (h >> 3)) : 0);
}

// Splits corners so each output vertex has one 3D vertex and one uv.
function weld(tris, uvOf) {
  const key = new Map(), vmap = [], uv = [], index = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = t[k], s = t[3 + k], id = v * 65536 + s;
      let i = key.get(id);
      if (i === undefined) {
        i = vmap.length;
        key.set(id, i);
        vmap.push(v);
        uv.push(...uvOf(s));
      }
      index.push(i);
    }
  }
  return { vmap: Uint32Array.from(vmap), uv: Float32Array.from(uv), index };
}

function expand(vmap, verts) {
  const pos = new Float32Array(vmap.length * 3);
  for (let i = 0; i < vmap.length; i++) {
    const v = vmap[i] * 3;
    // Acknex (x fwd, y left, z up) -> scene (x, z, -y)
    pos[i * 3] = verts[v]; pos[i * 3 + 1] = verts[v + 2]; pos[i * 3 + 2] = -verts[v + 1];
  }
  return pos;
}

function name16(u8, o, n = 16) {
  let s = '';
  for (let i = 0; i < n && u8[o + i]; i++) s += String.fromCharCode(u8[o + i]);
  return s;
}

function parseMdl45(u8, dv, magic) {
  const f32 = o => dv.getFloat32(o, true), u32 = o => dv.getUint32(o, true);
  const scale = [f32(8), f32(12), f32(16)], offset = [f32(20), f32(24), f32(28)];
  const numSkins = u32(48), sw = u32(52), sh = u32(56);
  const numVerts = u32(60), numTris = u32(64), numFrames = u32(68), numSkinVerts = u32(72);

  let o = 0x54;
  const skins = [];
  for (let i = 0; i < numSkins; i++) {
    const type = u32(o); o += 4;
    let w = sw, h = sh;
    if (magic === 'MDL5') { w = u32(o); h = u32(o + 4); o += 8; }
    const fmt = type & 7;
    skins.push(readSkinPixels(u8, dv, o, fmt, w, h));
    o += skinBytes(fmt, w, h, type & MIPS);
  }
  const tw = skins[0]?.width || sw || 1, th = skins[0]?.height || sh || 1;
  const st = new Int16Array(numSkinVerts * 2);
  for (let i = 0; i < numSkinVerts * 2; i++, o += 2) st[i] = dv.getInt16(o, true);
  const tris = [];
  for (let i = 0; i < numTris; i++, o += 12) {
    tris.push([0, 1, 2, 3, 4, 5].map(k => dv.getUint16(o + k * 2, true)));
  }
  const w = weld(tris, s => [(st[s * 2] + 0.5) / tw, (st[s * 2 + 1] + 0.5) / th]);

  const frames = [];
  for (let f = 0; f < numFrames; f++) {
    const packing = u32(o); o += 4;
    const vs = packing === 2 ? 8 : 4;
    o += vs * 2;                                    // bbox min / max
    const name = name16(u8, o); o += 16;
    const verts = new Float32Array(numVerts * 3);
    for (let v = 0; v < numVerts; v++, o += vs) {
      for (let k = 0; k < 3; k++) {
        const raw = packing === 2 ? dv.getUint16(o + k * 2, true) : u8[o + k];
        verts[v * 3 + k] = raw * scale[k] + offset[k];
      }
    }
    frames.push({ name, pos: expand(w.vmap, verts) });
  }
  return { version: magic, skins, uv: w.uv, index: w.index, frames };
}

function parseMdl7(u8, dv) {
  const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true), f32 = o => dv.getFloat32(o, true);
  const numBones = u32(8), numGroups = u32(12), dataSize = u32(16);
  const S = { bone: u16(28), skin: u16(30), stpt: u16(36), tri: u16(38), mainv: u16(40), framev: u16(42), bonet: u16(44) };

  let o = 48;
  const bones = [];
  for (let i = 0; i < numBones; i++, o += S.bone) {
    const parent = u16(o);
    bones.push({ parent: parent === 0xffff ? -1 : parent, pos: [f32(o + 4), f32(o + 8), f32(o + 12)], name: name16(u8, o + 16, 20) });
  }

  // Only the first group is used by Acknex A6 models.
  if (!numGroups) return { version: 'MDL7', skins: [], uv: new Float32Array(), index: [], frames: [] };
  const numSkins = u32(o + 24), numUvs = u32(o + 28), numTris = u32(o + 32), numVerts = u32(o + 36), numFrames = u32(o + 40);
  o += 44;

  const skins = [];
  for (let i = 0; i < numSkins; i++) {
    const type = u32(o), w = u32(o + 4), h = u32(o + 8), name = name16(u8, o + 12);
    o += S.skin;
    const fmt = type & 7;
    if (fmt === 7) { skins.push({ extern: name16(u8, o, w), name }); o += w; }
    else if (fmt === 6) { skins.push({ dds: true, name }); o += w; }   // w holds the DDS byte size
    else if (w && h) { skins.push({ ...readSkinPixels(u8, dv, o, fmt, w, h), name }); o += skinBytes(fmt, w, h, type & MIPS); }
    else skins.push({ name });
    if (type & MATERIAL) o += 68;
    if (type & MATDEF) o += 4 + u32(o);
  }

  const uvs = new Float32Array(numUvs * 2);
  for (let i = 0; i < numUvs; i++) { uvs[i * 2] = f32(o + i * S.stpt); uvs[i * 2 + 1] = f32(o + i * S.stpt + 4); }
  o += numUvs * S.stpt;

  const tris = [];
  for (let i = 0; i < numTris; i++, o += S.tri) tris.push([0, 1, 2, 3, 4, 5].map(k => u16(o + k * 2)));
  const w = weld(tris, s => [uvs[s * 2], uvs[s * 2 + 1]]);

  const base = new Float32Array(numVerts * 3), boneOf = new Int32Array(numVerts);
  for (let i = 0; i < numVerts; i++, o += S.mainv) {
    base[i * 3] = f32(o); base[i * 3 + 1] = f32(o + 4); base[i * 3 + 2] = f32(o + 8);
    const b = u16(o + 12);
    boneOf[i] = b === 0xffff ? -1 : b;
  }

  const frames = [];
  let verts = base;
  for (let f = 0; f < numFrames; f++) {
    const name = name16(u8, o), nv = u32(o + 16), nm = u32(o + 20);
    o += 24;
    // Frame vertices replace main vertices by index (vertex animation).
    if (nv) {
      verts = base.slice();
      for (let k = 0; k < nv; k++, o += S.framev) {
        const vi = u16(o + 12);
        if (vi < numVerts) { verts[vi * 3] = f32(o); verts[vi * 3 + 1] = f32(o + 4); verts[vi * 3 + 2] = f32(o + 8); }
      }
    }
    const matrices = [];
    for (let k = 0; k < nm; k++, o += S.bonet) {
      matrices.push({ bone: u16(o + 64), m: Array.from({ length: 16 }, (_, j) => f32(o + j * 4)) });
    }
    frames.push({ name, pos: expand(w.vmap, verts), matrices });
  }
  if (!frames.length) frames.push({ name: 'base', pos: expand(w.vmap, base), matrices: [] });

  return { version: 'MDL7', skins, uv: w.uv, index: w.index, frames, bones, boneOf, vmap: w.vmap, base, complete: o === dataSize };
}

// Groups frame names into animation scenes the way Acknex does ("walk1", "walk2" -> "walk").
export function animations(model) {
  const out = new Map();
  model.frames.forEach((f, i) => {
    const scene = f.name.replace(/\d+$/, '').toLowerCase();
    if (!out.has(scene)) out.set(scene, []);
    out.get(scene).push(i);
  });
  return out;
}
