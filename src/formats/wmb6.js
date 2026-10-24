// Acknex A6 level (WMB6) reader.
// List layout and object structs follow ikskuh/libgamestudio (MIT). The face lightmap
// placement (bytes 12..15 of a face) was worked out from Kabus 22 data:
//   [12] log2 of luxel size in texels, [13] lightmap page, [14] x, [15] y inside the page.
// Block size is derived Quake-style from the texture-space extents of the face.

const LIST = {
  palettes: 0, planes: 1, textures: 2, vertices: 3, pvs: 4, nodes: 5, materials: 6, faces: 7,
  legacy4: 8, hulls: 9, leafs: 10, bspBlocks: 11, edges: 12, edgeList: 13, models: 14, objects: 15, lightmaps: 16,
};

export const SURFACE = { shaded: 0, flat: 3, sky: 5, turbulence: 9, none: 11 };

const cstr = (u8, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) { const c = u8[off + i]; if (!c) break; s += String.fromCharCode(c); }
  return s;
};

export function parseWmb6(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (cstr(u8, 0, 4) !== 'WMB6') throw new Error('not a WMB6 level');
  const list = i => ({ off: dv.getUint32(4 + i * 8, true), len: dv.getUint32(8 + i * 8, true) });
  const f32 = o => dv.getFloat32(o, true), u32 = o => dv.getUint32(o, true), i32 = o => dv.getInt32(o, true), u16 = o => dv.getUint16(o, true);

  const textures = readTextures(u8, dv, list(LIST.textures));

  const M = list(LIST.materials);
  const materials = [];
  for (let o = M.off; o < M.off + M.len; o += 64) {
    const flags = u16(o + 36);
    materials.push({
      s: [f32(o), f32(o + 4), f32(o + 8), f32(o + 12)],
      t: [f32(o + 16), f32(o + 20), f32(o + 24), f32(o + 28)],
      texture: u32(o + 32), type: flags & 15, flags, userFlags: u32(o + 38),
      passable: !!(flags & 64), name: cstr(u8, o + 44, 20),
    });
  }

  const LM = list(LIST.lightmaps);
  const objects = readObjects(u8, dv, list(LIST.objects));
  const info = objects.find(ob => ob.type === 'info');
  // Pages are 256 << lmapSize square; some map entities carry garbage there, which would make the
  // page size 0 (endless loop) or huge. Fall back to 256 and only accept sizes the data can hold.
  let lmSize = 256 << Math.min(4, Math.max(0, info ? info.lmapSize : 0));
  if (LM.len % (lmSize * lmSize * 3) !== 0 && LM.len % (256 * 256 * 3) === 0) lmSize = 256;
  const lightmaps = [];
  for (let o = LM.off; o + lmSize * lmSize * 3 <= LM.off + LM.len; o += lmSize * lmSize * 3) {
    const px = new Uint8Array(lmSize * lmSize * 4);
    for (let p = 0, s = o; p < lmSize * lmSize; p++, s += 3) {
      px[p * 4] = u8[s + 2]; px[p * 4 + 1] = u8[s + 1]; px[p * 4 + 2] = u8[s]; px[p * 4 + 3] = 255;
    }
    lightmaps.push({ width: lmSize, height: lmSize, data: px });
  }

  // Faces -> triangle fans, grouped by texture + lightmap page.
  const V = list(LIST.vertices), E = list(LIST.edges), EL = list(LIST.edgeList), F = list(LIST.faces);
  const groups = new Map();
  const corner = [];
  for (let o = F.off; o < F.off + F.len; o += 24) {
    const firstEdge = u32(o + 4), numEdges = u16(o + 8), mat = materials[u16(o + 10)];
    if (!mat || mat.type === SURFACE.none || numEdges < 3) continue;
    const luxel = 1 << u8[o + 12], page = u8[o + 13], lx = u8[o + 14], ly = u8[o + 15];
    const tex = textures[mat.texture];

    corner.length = 0;
    let smin = Infinity, tmin = Infinity;
    for (let k = 0; k < numEdges; k++) {
      const se = i32(EL.off + (firstEdge + k) * 4);
      const vi = u32(E.off + Math.abs(se) * 8 + (se < 0 ? 4 : 0));
      const x = f32(V.off + vi * 12), y = f32(V.off + vi * 12 + 4), z = f32(V.off + vi * 12 + 8);
      const s = x * mat.s[0] + y * mat.s[1] + z * mat.s[2] + mat.s[3];
      const t = x * mat.t[0] + y * mat.t[1] + z * mat.t[2] + mat.t[3];
      if (s < smin) smin = s;
      if (t < tmin) tmin = t;
      corner.push(x, y, z, s, t);
    }
    const bs = Math.floor(smin / luxel), bt = Math.floor(tmin / luxel);

    const passable = mat.passable || mat.type === SURFACE.turbulence;
    const key = `${mat.texture}:${mat.type === SURFACE.shaded ? page : -1}:${mat.type}:${passable}`;
    let g = groups.get(key);
    if (!g) {
      g = { texture: mat.texture, lightmap: mat.type === SURFACE.shaded && page < lightmaps.length ? page : -1, surface: mat.type, passable, pos: [], uv: [], uv1: [], idx: [] };
      groups.set(key, g);
    }
    const base = g.pos.length / 3;
    for (let k = 0; k < corner.length; k += 5) {
      // Acknex is x forward, y left, z up; scene space is y up.
      g.pos.push(corner[k], corner[k + 2], -corner[k + 1]);
      g.uv.push(corner[k + 3] / (tex ? tex.width : 64), corner[k + 4] / (tex ? tex.height : 64));
      g.uv1.push((lx + corner[k + 3] / luxel - bs + 0.5) / lmSize, (ly + corner[k + 4] / luxel - bt + 0.5) / lmSize);
    }
    for (let k = 2; k < numEdges; k++) g.idx.push(base, base + k, base + k - 1);
  }

  return { textures, materials, lightmaps, objects, info, groups: [...groups.values()] };
}

function readTextures(u8, dv, L) {
  const count = dv.getUint32(L.off, true), out = [];
  for (let i = 0; i < count; i++) {
    const o = L.off + dv.getUint32(L.off + 4 + i * 4, true);
    const name = cstr(u8, o, 16), width = dv.getUint32(o + 16, true), height = dv.getUint32(o + 20, true);
    const m0 = dv.getUint32(o + 24, true), m1 = dv.getUint32(o + 28, true);
    const bpp = Math.round((m1 - m0) / (width * height));
    const src = o + m0, n = width * height, px = new Uint8Array(n * 4);
    if (bpp === 2) {
      for (let p = 0; p < n; p++) {
        const v = dv.getUint16(src + p * 2, true);
        px[p * 4] = (v >> 11) * 255 / 31; px[p * 4 + 1] = ((v >> 5) & 63) * 255 / 63; px[p * 4 + 2] = (v & 31) * 255 / 31; px[p * 4 + 3] = 255;
      }
    } else if (bpp === 3 || bpp === 4) {
      for (let p = 0; p < n; p++) {
        const s = src + p * bpp;
        px[p * 4] = u8[s + 2]; px[p * 4 + 1] = u8[s + 1]; px[p * 4 + 2] = u8[s]; px[p * 4 + 3] = bpp === 4 ? u8[s + 3] : 255;
      }
    } else {
      px.fill(128);
    }
    out.push({ name, width, height, data: px });
  }
  return out;
}

// The records are C structs: after the char arrays the floats start on the next 4-byte boundary.
function readObjects(u8, dv, L) {
  if (!L.len) return [];
  const f32 = o => dv.getFloat32(o, true), u32 = o => dv.getUint32(o, true);
  const vec = o => [f32(o), f32(o + 4), f32(o + 8)];
  const count = u32(L.off), out = [];
  for (let i = 0; i < count; i++) {
    const o = L.off + u32(L.off + 4 + i * 4), type = u32(o), p = o + 4;
    switch (type) {
      case 1: out.push({ type: 'position', origin: vec(p), angle: vec(p + 12), name: cstr(u8, p + 32, 20) }); break;
      case 2: out.push({ type: 'light', origin: vec(p), color: vec(p + 12), range: f32(p + 24), flags: u32(p + 28) }); break;
      case 3: out.push({
        type: 'entity', origin: vec(p), angle: vec(p + 12), scale: vec(p + 24),
        name: cstr(u8, p + 36, 20), file: cstr(u8, p + 56, 13), action: cstr(u8, p + 69, 20),
        skills: Array.from({ length: 8 }, (_, k) => f32(p + 92 + k * 4)), flags: u32(p + 124), ambient: f32(p + 128),
      }); break;
      case 4: out.push({ type: 'sound', origin: vec(p), volume: f32(p + 12), range: u32(p + 24), file: cstr(u8, p + 32, 33) }); break;
      case 5: out.push({ type: 'info', azimuth: f32(p + 12), elevation: f32(p + 16), lmapSize: u8[p + 25], sunColor: u32(p + 28), ambientColor: u32(p + 32) }); break;
      case 6: {
        const n = f32(p + 20) | 0, ne = u32(p + 36), pts = [];
        for (let k = 0; k < n; k++) pts.push(vec(p + 40 + k * 12));
        out.push({ type: 'path', name: cstr(u8, p, 20), points: pts, edges: ne });
        break;
      }
      case 7: out.push({
        type: 'entity', origin: vec(p), angle: vec(p + 12), scale: vec(p + 24),
        name: cstr(u8, p + 36, 33), file: cstr(u8, p + 69, 33), action: cstr(u8, p + 102, 33),
        skills: Array.from({ length: 20 }, (_, k) => f32(p + 136 + k * 4)), flags: u32(p + 216),
        ambient: f32(p + 220), albedo: f32(p + 224), string1: cstr(u8, p + 268, 33), string2: cstr(u8, p + 301, 33),
      }); break;
      case 8: out.push({ type: 'region', min: vec(p), max: vec(p + 12), name: cstr(u8, p + 32, 32) }); break;
      default: out.push({ type: 'unknown', id: type });
    }
  }
  return out;
}
