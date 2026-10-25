// Runs the game's own WDL scripts in the browser: compile, wire the engine modules, drive frames.
import { preprocess } from '../lexer.js';
import { parse } from '../parser.js';
import { compile } from '../codegen.js';
import { Runtime, Str, Ref } from '../runtime.js';
import { UI, Images, FLAGS } from './ui.js';
import { EngineInput } from './input.js';
import { EngineAudio } from './audio.js';
import { EngineFiles } from './files.js';
import { World, View } from './world.js';
import { VideoConverter } from './video.js';

const val = v => (v instanceof Ref ? v.get(0) : typeof v === 'number' ? v : +v || 0);
const text = v => (v instanceof Str ? v.s : v == null || v === 0 ? '' : String(v));

export async function compileGame(fs, entry, onProgress = () => {}) {
  onProgress('Script dosyaları okunuyor');
  const warns = [];
  const { tokens } = await preprocess(entry, async name => {
    const k = fs.resolve(name) || fs.resolve(name.split(/[\\/]/).pop());
    return k ? fs.readText(k) : null;
  }, { onWarn: w => warns.push(w) });
  onProgress(`${tokens.length} simge ayrıştırılıyor`);
  const prog = parse(tokens, { onWarn: w => warns.push(w) });
  onProgress(`${prog.funcs.size} fonksiyon derleniyor`);
  return { compiled: compile(prog), warns };
}

export class Game {
  constructor({ fs, renderer, scene, uiCanvas, onLog = () => {}, onExit = () => {} }) {
    this.fs = fs;
    this.renderer = renderer;
    this.scene = scene;
    this.uiCanvas = uiCanvas;
    this.onLog = onLog;
    this.log = [];
    const R = this.R = new Runtime({
      onWarn: m => { this.log.push(m); onLog(m); },
      onInfo: m => { this.log.push(m); onLog(m); },
      onError: (m, e) => { this.log.push('HATA ' + m); onLog('HATA ' + m); console.error('[wdl]', m, e); },
      exit: onExit,
    });
    this.images = new Images(fs);
    this.underCanvas = document.getElementById('game-ui-under');
    this.ui = new UI(R, uiCanvas, this.images, this.underCanvas);
    this.files = new EngineFiles(R, fs);
    this.audio = new EngineAudio(R, fs);
    this.video = new VideoConverter(fs);
    this.audio.video = this.video;
    this.audio.videoLayer = document.getElementById('game-video');
    this.statusEl = document.getElementById('game-status');
    this.world = new World(R, fs, this.images, renderer, scene);
    this.audio.onVideoSkin = (e, el) => this.world.setVideoSkin(e, el);
    this.input = new EngineInput(R, uiCanvas, (x, y) => this.toScreen(x, y));
    this.views = [];
    this.installHost();
  }

  installHost() {
    const R = this.R, G = R.G, B = R.B, ui = this.ui;
    Object.assign(G, FLAGS);
    // Screen: the widescreen edition asks the system for the desktop size (min 1280x720, engine max 1920x1200).
    const h = Math.max(720, Math.min(1200, Math.round(innerHeight * Math.min(devicePixelRatio, 1.5))));
    const w = Math.max(1280, Math.min(1920, Math.round(h * innerWidth / innerHeight)));
    this.setScreen(w, h);
    B.sys_metrics = (c, i) => (val(i) === 0 ? this.size[0] : val(i) === 1 ? this.size[1] : 0);
    B.video_set = (c, x, y) => { if (val(x) && val(y)) this.setScreen(val(x), val(y)); return 1; };
    B.video_window = () => 0;
    B.video_switch = () => 0;
    // dl_PaKaGa(brightness -100..100, contrast -80..80, gamma -100..100): the game's DLL sets the screen's
    // gamma ramp. Approximated with a CSS filter, neutral at the game's defaults (0, 0, 30).
    B.dl_pakaga = (c, pa, ka, ga) => {
      const b = (1 + val(pa) / 200) * (1 + (val(ga) - 30) / 250), k = 1 + val(ka) / 100;
      const f = Math.abs(b - 1) < 1e-3 && Math.abs(k - 1) < 1e-3 ? '' : `brightness(${b.toFixed(3)}) contrast(${k.toFixed(3)})`;
      for (const el of [this.renderer.domElement, this.underCanvas, this.uiCanvas, this.audio.videoLayer].filter(Boolean)) el.style.filter = f;
      return 1;
    };

    const ini = this.readIni();
    B.ini_getvariable = (c, key) => new Str(ini[text(key).toLowerCase()] ?? '0');
    B.ini_isinitialized = () => 1;

    // bitmaps
    B.bmap_width = (c, b) => ui.bmapSize(b)[0];
    B.bmap_height = (c, b) => ui.bmapSize(b)[1];
    B.bmap_purge = () => 0;
    B.bmap_create = (c, f) => R.bmap('', f);

    // object constructors used by the compiled program
    R.bmap = (name, file, x, y, w2, h2) => {
      const b = { kind: 'bmap', name, file: text(file), x: val(x), y: val(y), w: val(w2), h: val(h2) };
      return b;
    };
    R.sound = file => ({ kind: 'sound', file: text(file) });
    R.font = (name, ...args) => ({ kind: 'font', name, args });
    R.object = (kind, name) => {
      if (kind === 'panel' || kind === 'text') {
        const o = { kind, name, visible: 0, layer: 0, pos_x: 0, pos_y: 0, alpha: 100, scale_x: 1, scale_y: 1, buttons: [], digits: [], windows: [], sliders: [] };
        ui.register(o);
        return o;
      }
      if (kind === 'view') { const v = new View(name); this.views.push(v); return v; }
      if (kind === 'entity') return this.world.createViewEnt(name);
      return { kind, name };
    };
    R.props = (obj, list) => {
      if (obj.kind === 'panel' || obj.kind === 'text') ui.define(obj, list);
      else if (obj._view) {
        for (const [k, thunk] of list) {
          let v;
          try { v = thunk(); } catch { continue; }
          const x = v.length === 1 ? (v[0] instanceof Ref ? val(v[0]) : v[0]) : v;
          if (k === 'type') { obj.type = new Str(text(x)); this.world.attach(obj); }
          else if (k === 'flags') { for (const f of v) if (val(f) & FLAGS.visible) obj.visible = 1; }
          else obj[k] = x;
        }
      }
      else for (const [k, thunk] of list) { try { const v = thunk(); obj[k] = v.length === 1 ? (v[0] instanceof Ref ? val(v[0]) : v[0]) : v; } catch {} }
    };

    const cam = new View('camera');
    cam.visible = 1;
    G.camera = cam;
    this.views.push(cam);
  }

  readIni() {
    const out = {};
    const f = this.fs.files.get('k22.ini');
    this.iniPromise = f ? f.arrayBuffer().then(b => {
      let section = '';
      for (const line of new TextDecoder().decode(b).split(/\r?\n/)) {
        const s = /^\s*\[(.+)\]/.exec(line);
        if (s) { section = s[1].trim().toLowerCase(); continue; }
        const kv = /^\s*([^=;]+?)\s*=\s*([^;]*?)\s*(;.*)?$/.exec(line);
        if (kv) out[section + ':' + kv[1].toLowerCase()] = kv[2];
      }
      // Browser window instead of a real fullscreen mode switch.
      out['screen:mode'] = '2';
    }) : Promise.resolve();
    return out;
  }

  setScreen(w, h) {
    this.size = [w, h];
    const G = this.R.G;
    G.screen_size = [w, h, 0];
    for (const c of [this.uiCanvas, this.underCanvas].filter(Boolean)) { c.width = w; c.height = h; }
    const cam = G.camera;
    if (cam) { cam.size_x = w; cam.size_y = h; }
    this.layout();
  }

  // Fit the game screen into the window (letterbox).
  layout() {
    const [w, h] = this.size;
    const s = Math.min(innerWidth / w, innerHeight / h);
    const cw = Math.round(w * s), ch = Math.round(h * s);
    for (const el of [this.uiCanvas, this.underCanvas, this.renderer.domElement, this.audio.videoLayer].filter(Boolean)) {
      Object.assign(el.style, { width: cw + 'px', height: ch + 'px', left: ((innerWidth - cw) / 2) + 'px', top: ((innerHeight - ch) / 2) + 'px', position: 'fixed' });
    }
    this.renderer.setSize(cw, ch, false);
    this.scale = s;
  }

  toScreen(cx, cy) {
    const r = this.uiCanvas.getBoundingClientRect();
    return [(cx - r.left) / r.width * this.size[0], (cy - r.top) / r.height * this.size[1]];
  }

  async start(compiled, onProgress = () => {}) {
    onProgress('Oyun dosyaları hazırlanıyor');
    await this.files.preload();
    await this.iniPromise;
    onProgress('Script başlatılıyor');
    this.R.load(compiled);
    this.R.start();
    this.audio.resume();
    this.onResize = () => this.layout();
    addEventListener('resize', this.onResize);
    this.last = performance.now();
    this.running = true;
    // Convert the remaining videos in the background, a while after start-up.
    setTimeout(() => {
      if (!this.running) return;
      const lang = ['turkish', 'english', 'deutsch'][val(this.R.G.dd_dil)] || 'english';
      for (const f of this.video.allVideos(lang)) this.video.get(f).catch(() => {});
    }, 20000);
    const loop = now => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      // fps_max (the game sets 72): on fast displays some steps of the scripts round to nothing otherwise.
      const fpsMax = val(this.R.G.fps_max);
      if (fpsMax > 0 && now - this.last < 1000 / fpsMax - 2) return;
      const dt = Math.min(0.1, (now - this.last) / 1000) * (this.speed || 1);
      this.last = now;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  frame(dt) {
    const R = this.R;
    this.input.poll(dt);
    for (const ev of this.input.events.splice(0)) {
      if (ev.type === 'mousedown' || ev.type === 'mouseup') this.ui.pointer(ev.x, ev.y, ev.type === 'mousedown', ev.type === 'mouseup');
      if (ev.type === 'key' && ev.name) {
        const fn = R.G['on_' + ev.name];
        if (typeof fn === 'function') R.call(fn, { me: 0, you: 0 }, []);
      }
    }
    this.showStatus();
    const [mx, my] = R.G.mouse_pos;
    this.ui.pointer(mx, my, false, false);
    if (!R.paused) R.frame(dt);
    for (const step of [() => this.world.update(dt), () => this.world.render(this.views, this.size), () => this.ui.draw(this.audio.videoLayerOf())]) {
      try { step(); } catch (e) { R.warnOnce('motor hatası: ' + e.message); console.error(e); }
    }
  }

  // While a video the game waits for is still converting, say so.
  showStatus() {
    const waiting = [...this.audio.media.values()].find(m => m.video && !m.el && !m.ended && !m.entity);
    const el = this.statusEl;
    if (!el) return;
    if (!waiting) { el.hidden = true; return; }
    const p = this.video.progress(waiting.video);
    el.hidden = false;
    el.textContent = this.video.ffmpeg ? `Video hazırlanıyor… %${Math.round(p * 100)}
(ilk seferde bir kez)` : 'Video çözücü yükleniyor…';
  }

  stop() {
    this.running = false;
    removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.audio.dispose();
  }
}
