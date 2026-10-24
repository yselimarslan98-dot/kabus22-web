// Virtual file system over the player's own Kabus 22 install.
// Nothing is uploaded or copied: files are read lazily from the folder the player picked,
// archive headers are indexed once and the index is cached in IndexedDB.
import { listWrsBlob, readEntryBlob } from './formats/wrs.js';
import { idbGet, idbSet } from './idb.js';

const INDEX_VERSION = 1;

// Blob-like view of a remote file (dev server or the player's own bucket), read with HTTP Range
// requests. Remote reads are kept in Cache Storage so a level is downloaded only once.
const CACHE = 'kabus22-remote-v1';
class RangeBlob {
  constructor(url, lastModified, start, end) {
    Object.assign(this, { url, size: end - start, lastModified, start, end });
  }
  slice(a = 0, b = this.size) {
    const s = new RangeBlob(this.url, this.lastModified, this.start + a, this.start + Math.min(b, this.size));
    s.cached = this.cached;
    return s;
  }
  async arrayBuffer() {
    if (this.size <= 0) return new ArrayBuffer(0);
    const key = `${this.url}?k22range=${this.start}-${this.end}&m=${this.lastModified}`;
    const cache = this.cached && self.caches ? await caches.open(CACHE).catch(() => null) : null;
    const hit = cache && await cache.match(key);
    if (hit) return hit.arrayBuffer();
    const r = await fetch(this.url, { headers: { Range: `bytes=${this.start}-${this.end - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${this.url}`);
    let buf = await r.arrayBuffer();
    // Server ignored the Range header: cut the slice out of the full body.
    if (r.status === 200 && buf.byteLength !== this.size) buf = buf.slice(this.start, this.end);
    if (cache && this.size > 4096) cache.put(key, new Response(buf)).catch(() => {});
    return buf;
  }
}

export class GameFS {
  constructor(files) {
    this.files = files;          // Map lower-case relative path -> File
    this.entries = new Map();    // lower-case resource name -> { blob, entry }
    this.archives = [];
  }

  static async fromDirectoryHandle(handle) {
    const files = new Map();
    async function walk(dir, prefix) {
      for await (const [name, h] of dir.entries()) {
        const path = prefix + name;
        if (h.kind === 'directory') {
          // Saves and extracted videos are not needed; skipping keeps the walk quick.
          if (!/^(saves|video)$/i.test(name)) await walk(h, path + '/');
        } else {
          files.set(path.toLowerCase(), await h.getFile());
        }
      }
    }
    await walk(handle, '');
    return new GameFS(files);
  }

  static fromFileList(list) {
    const files = new Map();
    for (const f of list) {
      // webkitRelativePath starts with the picked folder's own name.
      const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
      files.set(rel.toLowerCase(), f);
    }
    return new GameFS(files);
  }

  // Development only: game folder served by tools/devserver.mjs on localhost.
  static async fromDevServer() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) throw new Error('dev mode is localhost only');
    const list = await (await fetch('/__game/manifest.json')).json();
    const files = new Map();
    for (const f of list) files.set(f.path.toLowerCase(), new RangeBlob(`/__game/${encodeURI(f.path)}`, f.mtime, 0, f.size));
    return new GameFS(files);
  }

  // A folder the player uploaded to their own storage (e.g. Cloudflare R2 with CORS), described by
  // manifest.json from tools/manifest.mjs. Nothing is fetched until a file is actually read.
  static async fromRemote(base) {
    if (!base.endsWith('/')) base += '/';
    const r = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`manifest.json okunamadı (${r.status})`);
    const files = new Map();
    for (const f of await r.json()) {
      const b = new RangeBlob(new URL(f.path.split('/').map(encodeURIComponent).join('/'), base).href, f.mtime, 0, f.size);
      b.cached = true;
      b.index = f.index;
      files.set(f.path.toLowerCase(), b);
    }
    return new GameFS(files);
  }

  isKabus22() {
    return this.files.has('kaynak.k22') && (this.files.has('k22.wrs') || this.files.has('k22widescreen.wrs'));
  }

  // Mount order = lookup priority (first match wins), like the engine's resource chain.
  async mount(lang = 'tr', onProgress = () => {}) {
    const names = [
      this.files.has('k22widescreen.wrs') ? 'k22widescreen.wrs' : 'k22.wrs',
      `yazi_${lang}.k22`, `ses_${lang}.k22`, 'kaynak.k22',
    ].filter(n => this.files.has(n));
    for (const [i, name] of names.entries()) {
      onProgress(`${name} dizinleniyor`, i / names.length);
      const blob = this.files.get(name);
      const key = `wrs:${INDEX_VERSION}:${name}:${blob.size}:${blob.lastModified}`;
      let entries = blob.index || await idbGet(key);
      if (!entries) {
        entries = await listWrsBlob(blob);
        await idbSet(key, entries);
      }
      this.archives.push({ name, blob, entries });
      for (const entry of entries) {
        const k = entry.name.toLowerCase();
        if (!this.entries.has(k)) this.entries.set(k, { blob, entry });
      }
    }
    onProgress('hazır', 1);
  }

  // Old entity records store file names in 13 bytes ("shasi100t2.md"); resolve those by prefix.
  resolve(name) {
    const k = name.toLowerCase().replace(/\\/g, '/');
    if (this.entries.has(k) || this.files.has(k)) return k;
    if (k.length < 12) return null;
    for (const e of this.entries.keys()) if (e.startsWith(k)) return e;
    return null;
  }

  has(name) {
    const k = name.toLowerCase();
    return this.entries.has(k) || this.files.has(k);
  }

  async read(name) {
    const k = name.toLowerCase().replace(/\\/g, '/');
    const hit = this.entries.get(k);
    if (hit) return readEntryBlob(hit.blob, hit.entry);
    const f = this.files.get(k);
    if (f) return new Uint8Array(await f.arrayBuffer());
    throw new Error(`dosya bulunamadı: ${name}`);
  }

  async readText(name) {
    return new TextDecoder('windows-1254').decode(await this.read(name));
  }

  list(ext) {
    const out = new Set();
    for (const k of this.entries.keys()) if (k.endsWith(ext)) out.add(k);
    return [...out];
  }

  // Level order comes from the game's own LevelYonetim.wdl.
  async levelList() {
    const src = await this.readText('LevelYonetim.wdl');
    const files = new Map();
    for (const m of src.matchAll(/STRING\s+(LVS_\w+)\s*=\s*<([^>]+)>/gi)) files.set(m[1].toLowerCase(), m[2]);
    const order = [];
    for (const m of src.matchAll(/LVSL_Leveller\[(\d+)\]\s*=\s*(LVS_\w+)/gi)) {
      const file = files.get(m[2].toLowerCase());
      if (file && this.has(file) && !order.some(l => l.file.toLowerCase() === file.toLowerCase())) {
        order.push({ index: +m[1], id: m[2].slice(4), file });
      }
    }
    return order.sort((a, b) => a.index - b.index);
  }
}
