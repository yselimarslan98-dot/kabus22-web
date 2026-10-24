// The game's videos are WMV (ASF / AVI with WMV2, WMV3 and WMA), which browsers cannot play.
// They are converted once to H.264/AAC MP4 with ffmpeg.wasm in a worker and kept in IndexedDB.
import { FFmpeg } from '../../../vendor/ffmpeg/index.js';
import { idbGet, idbSet } from '../../idb.js';

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/';

async function blobURL(url, type) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
}

export class VideoConverter {
  constructor(fs) {
    this.fs = fs;
    this.queue = [];          // { key, file, resolve, reject, progress }
    this.jobs = new Map();    // key -> promise
    this.busy = false;
    this.ffmpeg = null;
    this.onStatus = () => {};
  }

  // Cache key: path + size + mtime, so a changed file is converted again.
  key(file) {
    const f = this.fs.files.get(file);
    return `video:v1:${file}:${f?.size ?? 0}:${f?.lastModified ?? 0}`;
  }

  async cached(file) {
    return idbGet(this.key(file));
  }

  // Returns a promise of an MP4 blob. `urgent` puts the file in front of the queue.
  get(file, urgent = false) {
    const key = this.key(file);
    let job = this.jobs.get(key);
    if (!job) {
      job = new Promise((resolve, reject) => {
        const item = { key, file, resolve, reject, progress: 0 };
        if (urgent) this.queue.unshift(item); else this.queue.push(item);
      });
      this.jobs.set(key, job);
      job.catch(() => this.jobs.delete(key));
      this.pump();
    } else if (urgent) {
      const i = this.queue.findIndex(q => q.key === key);
      if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    }
    return job;
  }

  progress(file) {
    const key = this.key(file);
    if (this.current?.key === key) return this.current.progress;
    return this.queue.some(q => q.key === key) ? 0 : 1;
  }

  async load() {
    if (this.ffmpeg) return this.ffmpeg;
    this.onStatus('Video çözücü indiriliyor (yaklaşık 31 MB, bir kez)');
    const ff = new FFmpeg();
    await ff.load({
      coreURL: await blobURL(CORE + 'ffmpeg-core.js', 'text/javascript'),
      wasmURL: await blobURL(CORE + 'ffmpeg-core.wasm', 'application/wasm'),
    });
    ff.on('progress', ({ progress }) => {
      if (this.current) { this.current.progress = Math.max(0, Math.min(1, progress)); this.onStatus(null); }
    });
    this.ffmpeg = ff;
    return ff;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.current = this.queue.shift();
        try {
          let blob = await idbGet(item.key);
          if (!blob) {
            const ff = await this.load();
            this.onStatus(null);
            await ff.writeFile('in', await this.fs.read(item.file));
            const code = await ff.exec(['-i', 'in', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'out.mp4']);
            const data = await ff.readFile('out.mp4');
            await ff.deleteFile('in').catch(() => {});
            await ff.deleteFile('out.mp4').catch(() => {});
            if (code !== 0 || !data?.length) throw new Error(`dönüştürülemedi (${code})`);
            blob = new Blob([data], { type: 'video/mp4' });
            await idbSet(item.key, blob);
          }
          item.resolve(blob);
        } catch (e) {
          item.reject(e);
        }
      }
    } finally {
      this.current = null;
      this.busy = false;
      this.onStatus(null);
    }
  }

  // All videos the game can play: the menu loop and the current language's cutscenes.
  allVideos(language = 'turkish') {
    return [...this.fs.files.keys()].filter(k => k === '_data/video/kn_arg.k22' || k.startsWith(`_data/language/${language}/video/`));
  }
}
