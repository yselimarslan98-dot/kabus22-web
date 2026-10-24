// PCX and BMP decoders (plus TGA via tga.js) -> { width, height, data: RGBA top row first, alpha }.
import { parseTga } from './tga.js';

export function parsePcx(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const bpp = u8[3], xmin = dv.getUint16(4, true), ymin = dv.getUint16(6, true);
  const xmax = dv.getUint16(8, true), ymax = dv.getUint16(10, true);
  const planes = u8[65], bpl = dv.getUint16(66, true);
  const width = xmax - xmin + 1, height = ymax - ymin + 1;
  const line = planes * bpl;
  const raw = new Uint8Array(line * height);
  // RLE: 0xC0 | count, value
  for (let o = 128, p = 0; p < raw.length && o < u8.length;) {
    const b = u8[o++];
    if ((b & 0xc0) === 0xc0) { const n = b & 0x3f, v = u8[o++]; for (let k = 0; k < n && p < raw.length; k++) raw[p++] = v; }
    else raw[p++] = b;
  }
  const px = new Uint8Array(width * height * 4);
  if (bpp === 8 && planes === 1) {
    const pal = u8.length >= 769 && u8[u8.length - 769] === 12 ? u8.subarray(u8.length - 768) : null;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const c = raw[y * line + x], d = (y * width + x) * 4;
      if (pal) { px[d] = pal[c * 3]; px[d + 1] = pal[c * 3 + 1]; px[d + 2] = pal[c * 3 + 2]; }
      else px[d] = px[d + 1] = px[d + 2] = c;
      px[d + 3] = 255;
    }
  } else if (bpp === 8 && planes >= 3) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4, r = y * line;
      px[d] = raw[r + x]; px[d + 1] = raw[r + bpl + x]; px[d + 2] = raw[r + 2 * bpl + x];
      px[d + 3] = planes === 4 ? raw[r + 3 * bpl + x] : 255;
    }
  } else {
    px.fill(128);
  }
  return { width, height, data: px, alpha: planes === 4 };
}

export function parseBmp(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const off = dv.getUint32(10, true), hdr = dv.getUint32(14, true);
  const width = dv.getInt32(18, true), h0 = dv.getInt32(22, true), bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  const height = Math.abs(h0), bottomUp = h0 > 0;
  const stride = ((width * bpp + 31) >> 5) << 2;
  const px = new Uint8Array(width * height * 4);
  let pal = null;
  if (bpp <= 8) {
    const n = dv.getUint32(46, true) || (1 << bpp);
    pal = u8.subarray(14 + hdr, 14 + hdr + n * 4);
  }
  for (let y = 0; y < height; y++) {
    const row = off + (bottomUp ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      if (bpp === 24 || bpp === 32) {
        const s = row + x * (bpp >> 3);
        px[d] = u8[s + 2]; px[d + 1] = u8[s + 1]; px[d + 2] = u8[s]; px[d + 3] = bpp === 32 && compression === 3 ? u8[s + 3] : 255;
      } else if (bpp === 16) {
        const v = dv.getUint16(row + x * 2, true);
        px[d] = (v >> 10 & 31) * 255 / 31; px[d + 1] = (v >> 5 & 31) * 255 / 31; px[d + 2] = (v & 31) * 255 / 31; px[d + 3] = 255;
      } else if (pal) {
        const c = bpp === 8 ? u8[row + x] : bpp === 4 ? (u8[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15 : (u8[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        px[d] = pal[c * 4 + 2]; px[d + 1] = pal[c * 4 + 1]; px[d + 2] = pal[c * 4]; px[d + 3] = 255;
      }
    }
  }
  return { width, height, data: px, alpha: false };
}

export function decodeImage(name, bytes) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'tga') return parseTga(bytes);
  if (ext === 'pcx') return parsePcx(bytes);
  if (ext === 'bmp') return parseBmp(bytes);
  throw new Error(`desteklenmeyen resim: ${name}`);
}
