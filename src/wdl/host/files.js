// file_* and txt_load. The scripts read files synchronously, so small files of the game folder are
// preloaded; anything the game writes (options, saves) lives in IndexedDB and shadows the original.
import { Ref, Str } from '../runtime.js';
import { idbGet, idbSet } from '../../idb.js';

const val = v => (v instanceof Ref ? v.get(0) : typeof v === 'number' ? v : +v || 0);
const text = v => (v instanceof Str ? v.s : v == null || v === 0 ? '' : String(v));
const norm = n => text(n).trim().toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.?\//, '');
const enc = new TextEncoder(), dec = new TextDecoder('windows-1254');

export class EngineFiles {
  constructor(R, fs) {
    this.R = R;
    this.fs = fs;
    this.data = new Map();     // normalized name -> Uint8Array (preloaded originals)
    this.written = new Map();  // normalized name -> Uint8Array (game writes)
    this.open = new Map();
    this.next = 1;
    const B = R.B;
    B.file_open_read = (c, name) => this.openRead(name);
    B.file_open_game = B.file_open_read;
    B.file_open_write = (c, name) => this.openWrite(name, false);
    B.file_open_append = (c, name) => this.openWrite(name, true);
    B.file_close = (c, h) => { this.close(val(h)); return 0; };
    B.file_asc_read = (c, h) => { const f = this.open.get(val(h)); return f && f.pos < f.bytes.length ? f.bytes[f.pos++] : -1; };
    B.file_asc_write = (c, h, b) => { this.open.get(val(h))?.out.push(val(b) & 255); return 0; };
    B.file_var_read = (c, h) => this.readToken(this.open.get(val(h)), /[\s,;]/).num;
    B.file_var_write = (c, h, v) => { this.write(val(h), fmtNum(val(v)) + ' '); return 0; };
    B.file_str_read = (c, h, s) => {
      const t = this.readToken(this.open.get(val(h)), /[\r\n,]/, true);
      if (s instanceof Str) s.s = t.str;
      return t.eof ? -1 : t.str.length;
    };
    B.file_str_write = (c, h, s) => { this.write(val(h), text(s)); return 0; };
    B.file_seek = (c, h, pos, mode) => { const f = this.open.get(val(h)); if (f) f.pos = val(mode) === 0 ? val(pos) : val(mode) === 1 ? f.pos + val(pos) : f.bytes.length + val(pos); return f ? f.pos : 0; };
    B.file_length = (c, h) => this.open.get(val(h))?.bytes.length ?? 0;
    B.file_cpy = () => 0;
    B.file_delete = (c, name) => { this.written.set(norm(name), null); idbSet('file:' + norm(name), null); return 0; };
    // txt_load(text, file): one line per string
    B.txt_load = (c, t, name) => {
      const bytes = this.bytes(name);
      if (!bytes || !t || typeof t !== 'object') return 0;
      const lines = dec.decode(bytes).split(/\r?\n/);
      t.string ??= [];
      lines.forEach((l, i) => { if (t.string[i] instanceof Str) t.string[i].s = l; else t.string[i] = new Str(l); });
      return lines.length;
    };
  }

  // Must run before the scripts start.
  async preload() {
    const keep = [...this.fs.files.entries()].filter(([k, f]) => f.size < 512 * 1024 && /\.(k22|txt|ini|cfg|sav|dat|wdl)$/i.test(k) || /^saves\//.test(k) && f.size < 16 * 1024 * 1024);
    await Promise.all(keep.map(async ([k, f]) => {
      try { this.data.set(k, new Uint8Array(await f.arrayBuffer())); } catch {}
    }));
    // .txt files inside archives (subtitles and such)
    for (const k of this.fs.list('.txt')) {
      try { this.data.set(k, await this.fs.read(k)); } catch {}
    }
    const index = (await idbGet('files:index')) || [];
    for (const k of index) { const b = await idbGet('file:' + k); if (b) this.written.set(k, b); }
  }

  bytes(name) {
    const k = norm(name);
    if (this.written.has(k)) return this.written.get(k);
    if (this.data.has(k)) return this.data.get(k);
    const base = k.split('/').pop();
    for (const [key, b] of this.data) if (key === base || key.endsWith('/' + base)) return b;
    return null;
  }

  openRead(name) {
    const bytes = this.bytes(name);
    if (!bytes) return 0;
    const h = this.next++;
    this.open.set(h, { name: norm(name), bytes, pos: 0 });
    return h;
  }
  openWrite(name, append) {
    const h = this.next++;
    const prev = append ? this.bytes(name) : null;
    this.open.set(h, { name: norm(name), bytes: new Uint8Array(), pos: 0, out: prev ? [...prev] : [], write: true });
    return h;
  }
  write(h, s) { const f = this.open.get(h); if (f?.out) for (const b of enc.encode(s)) f.out.push(b); }
  close(h) {
    const f = this.open.get(h);
    this.open.delete(h);
    if (!f?.write) return;
    const bytes = Uint8Array.from(f.out);
    this.written.set(f.name, bytes);
    idbSet('file:' + f.name, bytes);
    idbSet('files:index', [...this.written.keys()]);
  }
  readToken(f, delim, keepSpaces = false) {
    if (!f || f.pos >= f.bytes.length) return { str: '', num: 0, eof: true };
    // skip leading delimiters / whitespace
    while (f.pos < f.bytes.length && (delim.test(String.fromCharCode(f.bytes[f.pos])) || (!keepSpaces && f.bytes[f.pos] <= 32))) f.pos++;
    const start = f.pos;
    while (f.pos < f.bytes.length && !delim.test(String.fromCharCode(f.bytes[f.pos]))) f.pos++;
    const str = dec.decode(f.bytes.subarray(start, f.pos));
    if (f.pos < f.bytes.length) f.pos++;
    return { str, num: parseFloat(str) || 0, eof: false };
  }
}

const fmtNum = v => (Number.isInteger(v) ? String(v) : v.toFixed(3));
