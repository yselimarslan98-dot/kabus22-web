// Acknex WRS2 resource archive reader.
// Layout: "WRS2" magic, then repeated entries of
//   name[32] (bytes XOR 0xA5, zero padded), u32be packedSize, u32be size, LZSS data[packedSize]
// LZSS is the classic Okumura variant: N=4096, F=18, threshold 2, ring filled with spaces, r=N-F.

const NAME_LEN = 32;
const HEADER_LEN = NAME_LEN + 8;

export function listWrs(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] !== 0x57 || u8[1] !== 0x52 || u8[2] !== 0x53 || u8[3] !== 0x32) throw new Error('not a WRS2 archive');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const entries = [];
  let p = 4;
  while (p + HEADER_LEN <= u8.length) {
    let name = '';
    for (let i = 0; i < NAME_LEN; i++) {
      const b = u8[p + i];
      if (b === 0) break;
      name += String.fromCharCode(b ^ 0xa5);
    }
    const packedSize = dv.getUint32(p + NAME_LEN, false);
    const size = dv.getUint32(p + NAME_LEN + 4, false);
    const offset = p + HEADER_LEN;
    if (offset + packedSize > u8.length) throw new Error(`truncated entry ${name} at ${p}`);
    entries.push({ name, offset, packedSize, size });
    p = offset + packedSize;
  }
  return entries;
}

export function unlzss(src, size) {
  const N = 4096, F = 18, THRESHOLD = 2;
  const ring = new Uint8Array(N).fill(0x20);
  const out = new Uint8Array(size);
  let r = N - F, o = 0, i = 0, flags = 0;
  while (o < size && i < src.length) {
    if (((flags >>= 1) & 0x100) === 0) {
      flags = src[i++] | 0xff00;
    }
    if (flags & 1) {
      const c = src[i++];
      out[o++] = c;
      ring[r] = c; r = (r + 1) & (N - 1);
    } else {
      const b0 = src[i++], b1 = src[i++];
      const pos = b0 | ((b1 & 0xf0) << 4);
      const len = (b1 & 0x0f) + THRESHOLD + 1;
      for (let k = 0; k < len && o < size; k++) {
        const c = ring[(pos + k) & (N - 1)];
        out[o++] = c;
        ring[r] = c; r = (r + 1) & (N - 1);
      }
    }
  }
  return out;
}

// Lazy variants for a Blob/File: only headers are read while indexing, entry data on demand.
export async function listWrsBlob(blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (String.fromCharCode(...head) !== 'WRS2') throw new Error('not a WRS2 archive');
  const entries = [];
  // Headers are read in windows so a 1 GB archive needs a few thousand small reads at most.
  const WINDOW = 1 << 16;
  let winStart = -1, win = null;
  let p = 4;
  while (p + HEADER_LEN <= blob.size) {
    if (winStart < 0 || p < winStart || p + HEADER_LEN > winStart + win.length) {
      winStart = p;
      win = new Uint8Array(await blob.slice(p, Math.min(blob.size, p + WINDOW)).arrayBuffer());
    }
    const h = win.subarray(p - winStart, p - winStart + HEADER_LEN);
    let name = '';
    for (let i = 0; i < NAME_LEN && h[i]; i++) name += String.fromCharCode(h[i] ^ 0xa5);
    const packedSize = (h[32] << 24 | h[33] << 16 | h[34] << 8 | h[35]) >>> 0;
    const size = (h[36] << 24 | h[37] << 16 | h[38] << 8 | h[39]) >>> 0;
    const offset = p + HEADER_LEN;
    entries.push({ name, offset, packedSize, size });
    p = offset + packedSize;
  }
  return entries;
}

export async function readEntryBlob(blob, entry) {
  const packed = new Uint8Array(await blob.slice(entry.offset, entry.offset + entry.packedSize).arrayBuffer());
  if (entry.packedSize === entry.size) return packed;
  return unlzss(packed, entry.size);
}

export function readEntry(buf, entry) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const packed = u8.subarray(entry.offset, entry.offset + entry.packedSize);
  if (entry.packedSize === entry.size) return packed.slice();
  return unlzss(packed, entry.size);
}
