// snd_* and media_* on WebAudio. Handles are numbers, like the engine's.
import { Ref, Str } from '../runtime.js';

const val = v => (v instanceof Ref ? v.get(0) : typeof v === 'number' ? v : +v || 0);
const text = v => (v instanceof Str ? v.s : v == null || v === 0 ? '' : typeof v === 'object' ? (v.file ?? '') : String(v));

export class EngineAudio {
  constructor(R, fs) {
    this.R = R;
    this.fs = fs;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.buffers = new Map();
    this.handles = new Map();
    this.next = 1;
    this.media = new Map();
    const G = R.G, B = R.B;
    G.sound_vol ??= 100; G.midi_vol ??= 100; G.media_handle = 0;

    B.snd_play = (c, snd, vol, bal) => this.play(snd, vol, bal, false);
    B.snd_loop = (c, snd, vol, bal) => this.play(snd, vol, bal, true);
    B.snd_stop = (c, h) => { this.stop(val(h)); return 0; };
    B.snd_playing = (c, h) => { const s = this.handles.get(val(h)); return s && !s.ended ? 1 : 0; };
    B.snd_tune = (c, h, vol, freq, bal) => { this.tune(this.handles.get(val(h)), vol, freq, bal); return 0; };
    B.snd_stopall = () => { for (const h of [...this.handles.keys()]) this.stop(h); return 0; };
    B.snd_pause = (c, h) => { this.stop(val(h)); return 0; };

    B.media_play = (c, file, target, vol) => this.mediaPlay(file, vol, false, target);
    B.media_loop = (c, file, target, vol) => this.mediaPlay(file, vol, true, target);
    B.media_stop = (c, h) => {
      h = val(h);
      for (const [k, m] of this.media) if (!h || k === h) { m.stop(); this.media.delete(k); }
      return 0;
    };
    // For videos the engine returns the current frame number; the scripts time subtitles with it.
    B.media_playing = (c, h) => {
      const m = this.media.get(val(h));
      if (!m || m.ended) return 0;
      if (m.video && m.el) return Math.floor(m.el.currentTime * 25) + 1;
      return 1;
    };
    B.media_tune = (c, h, vol) => { const m = this.media.get(val(h)); if (m && m.el) m.el.volume = clamp01(val(vol) / 100); return 0; };
    B.media_pause = (c, h) => { this.media.get(val(h))?.el?.pause(); return 0; };
    B.media_start = (c, h) => { this.media.get(val(h))?.el?.play().catch(() => {}); return 0; };
  }

  // media_layer of the video on screen: panels below it are covered by the video.
  videoLayerOf() {
    let layer = Infinity;
    for (const m of this.media.values()) if (m.video && m.el && !m.ended && !m.entity) layer = Math.min(layer, m.layer);
    return layer;
  }

  resume() { if (this.ctx.state === 'suspended') this.ctx.resume(); }

  buffer(file) {
    const key = file.toLowerCase();
    let p = this.buffers.get(key);
    if (!p) {
      p = (async () => {
        const name = this.fs.resolve(key) || this.fs.resolve(key.split(/[\\/]/).pop());
        if (!name) throw new Error('ses bulunamadı: ' + file);
        const bytes = await this.fs.read(name);
        return this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      })();
      p.catch(e => this.R.warnOnce(e.message));
      this.buffers.set(key, p);
    }
    return p;
  }

  play(snd, vol, bal, loop) {
    const file = text(snd);
    if (!file) return 0;
    const h = this.next++;
    const s = { ended: false, loop, src: null, gain: this.ctx.createGain(), pan: this.ctx.createStereoPanner(), rate: 1 };
    s.gain.connect(s.pan).connect(this.master);
    this.tune(s, vol, 0, bal);
    this.handles.set(h, s);
    this.buffer(file).then(buf => {
      if (s.ended) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.playbackRate.value = s.rate;
      src.connect(s.gain);
      src.onended = () => { s.ended = true; this.handles.delete(h); };
      src.start();
      s.src = src;
    }, () => { s.ended = true; this.handles.delete(h); });
    return h;
  }

  tune(s, vol, freq, bal) {
    if (!s) return;
    // scripts can compute NaN/Infinity (3D volume at zero distance); Web Audio throws on those
    const clamp = (x, lo, hi) => x !== x ? 0 : Math.max(lo, Math.min(hi, x));
    const sv = (this.R.G.sound_vol ?? 100) / 100;
    s.gain.gain.value = clamp(val(vol) / 100, 0, 1) * sv;
    s.pan.pan.value = clamp(val(bal) / 100, -1, 1);
    if (val(freq) > 0 && Number.isFinite(val(freq))) { s.rate = val(freq) / 100; if (s.src) s.src.playbackRate.value = s.rate; }
  }

  stop(h) {
    const s = this.handles.get(h);
    if (!s) return;
    s.ended = true;
    try { s.src?.stop(); } catch {}
    s.gain.disconnect();
    this.handles.delete(h);
  }

  // Music and videos. Audio files stream through an <audio> element; AVI videos are not playable
  // in browsers, so they end at once (the scripts then continue as after the video).
  // A video whose target is an entity's skin (bmap_for_entity) plays on that model instead of the screen.
  mediaPlay(file, vol, loop, target) {
    const name = text(file);
    const h = this.next++;
    const entity = target?.entity || null;
    const onSkin = this.onVideoSkin;
    const m = { ended: false, el: null, entity, layer: val(this.R.G.media_layer), stop() { this.ended = true; if (this.el) { this.el.pause(); this.el.remove(); URL.revokeObjectURL(this.el.src); } if (entity) onSkin?.(entity, null); } };
    this.media.set(h, m);
    this.R.G.media_handle = h;
    const resolved = this.fs.resolve(name) || this.fs.resolve(name.split(/[\\/]/).pop());
    if (!resolved) {
      this.R.warnOnce('medya bulunamadı: ' + name);
      m.ended = true;
      return h;
    }
    if (!/\.(ogg|wav|mp3)$/i.test(resolved)) {
      // Video: converted to MP4 on first use; the scripts see it "playing" while it converts.
      if (!this.video) { m.ended = true; return h; }
      m.video = resolved;
      this.video.get(resolved, true).then(blob => {
        if (m.ended) return;
        const el = document.createElement('video');
        el.src = URL.createObjectURL(blob);
        el.loop = loop;
        el.playsInline = true;
        el.volume = clamp01(val(vol) / 100);
        el.onended = () => { if (!loop) m.stop(); };
        el.onerror = () => { this.R.warn(`video hatası: ${name} (${el.error?.message || el.error?.code})`); m.stop(); };
        el.onplaying = () => this.R.host.onInfo?.(`video oynuyor: ${resolved} ${el.videoWidth}x${el.videoHeight}, ${el.duration.toFixed(1)} sn`);
        m.el = el;
        if (entity) onSkin?.(entity, el);
        else this.videoLayer?.append(el);
        el.play().catch(() => { el.muted = true; el.play().catch(() => m.stop()); });
      }, e => { this.R.warnOnce('video oynatılamadı: ' + name + ' (' + e.message + ')'); m.ended = true; });
      return h;
    }
    this.fs.read(resolved).then(bytes => {
      if (m.ended) return;
      const el = new Audio(URL.createObjectURL(new Blob([bytes])));
      el.loop = loop;
      el.volume = clamp01(val(vol) / 100);
      el.onended = () => { if (!loop) m.ended = true; };
      m.el = el;
      el.play().catch(() => { m.ended = true; });
    }, () => { m.ended = true; });
    return h;
  }

  dispose() {
    for (const h of [...this.handles.keys()]) this.stop(h);
    for (const m of this.media.values()) m.stop();
    this.ctx.close();
  }
}

const clamp01 = v => Math.max(0, Math.min(1, v));
