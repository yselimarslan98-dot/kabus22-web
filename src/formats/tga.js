// Minimal Truevision TGA decoder (types 2/3/10/11, 8/16/24/32 bpp) -> RGBA, top row first.
export function parseTga(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const idLen = u8[0], cmapType = u8[1], type = u8[2];
  const cmapLen = u8[5] | u8[6] << 8, cmapBits = u8[7];
  const width = u8[12] | u8[13] << 8, height = u8[14] | u8[15] << 8, bpp = u8[16], desc = u8[17];
  if (![2, 3, 10, 11].includes(type)) throw new Error(`desteklenmeyen TGA türü: ${type}`);
  let o = 18 + idLen + (cmapType ? cmapLen * ((cmapBits + 7) >> 3) : 0);
  const bytes = bpp >> 3, n = width * height, px = new Uint8Array(n * 4);
  const put = (p, s) => {
    if (bytes === 1) { px[p] = px[p + 1] = px[p + 2] = u8[s]; px[p + 3] = 255; }
    else if (bytes === 2) {
      const v = u8[s] | u8[s + 1] << 8;
      px[p] = (v >> 10 & 31) * 255 / 31; px[p + 1] = (v >> 5 & 31) * 255 / 31; px[p + 2] = (v & 31) * 255 / 31; px[p + 3] = 255;
    } else { px[p] = u8[s + 2]; px[p + 1] = u8[s + 1]; px[p + 2] = u8[s]; px[p + 3] = bytes === 4 ? u8[s + 3] : 255; }
  };
  if (type < 9) {
    for (let i = 0; i < n; i++, o += bytes) put(i * 4, o);
  } else {
    for (let i = 0; i < n;) {
      const h = u8[o++], count = (h & 127) + 1;
      if (h & 128) { for (let k = 0; k < count && i < n; k++) put(i++ * 4, o); o += bytes; }
      else for (let k = 0; k < count && i < n; k++, o += bytes) put(i++ * 4, o);
    }
  }
  // Bottom-up unless descriptor bit 5 is set; flip to top-down.
  if (!(desc & 32)) {
    const row = width * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < height >> 1; y++) {
      const a = y * row, b = (height - 1 - y) * row;
      tmp.set(px.subarray(a, a + row)); px.copyWithin(a, b, b + row); px.set(tmp, b);
    }
  }
  return { width, height, data: px, alpha: bytes === 4 };
}
