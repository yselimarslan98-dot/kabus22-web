// 2D layer of the engine: PANEL and TEXT objects drawn on a canvas at the game's own screen resolution.
import { Ref, Str } from '../runtime.js';
import { decodeImage } from '../../formats/image.js';

// Flag constants usable in `flags = a, b, c;` definitions.
export const FLAGS = {
  visible: 1, transparent: 2, overlay: 4, refresh: 8, d3d: 16, center_x: 32, center_y: 64, narrow: 128, condensed: 256,
  shadow: 512, outline: 1024, filter: 2048, translucent: 2, light: 4096, bright: 8192, unlit: 16384, nofog: 32768,
  passable: 65536, invisible: 131072, polygon: 262144, flare: 524288, metal: 1048576, cast: 2097152, fat: 4194304, narrow_: 0,
};

const val = v => (v instanceof Ref ? v.get(0) : typeof v === 'number' ? v : +v || 0);
const text = v => (v instanceof Str ? v.s : v == null || v === 0 ? '' : String(v));

export class Images {
  constructor(fs) { this.fs = fs; this.cache = new Map(); }
  // Returns the decoded image (canvas) for a file or null while loading.
  get(file) {
    if (!file) return null;
    const key = String(file).toLowerCase().replace(/\\/g, '/');
    let e = this.cache.get(key);
    if (!e) {
      e = { img: null, failed: false };
      this.cache.set(key, e);
      this.load(key).then(img => { e.img = img; }, err => { e.failed = true; console.warn('[bmap]', file, err.message); });
    }
    return e.img;
  }
  async load(key) {
    const name = this.fs.resolve(key) || this.fs.resolve(key.split('/').pop());
    if (!name) throw new Error('bulunamadı');
    const im = decodeImage(name, await this.fs.read(name));
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(im.data.buffer, im.data.byteOffset, im.data.length), im.width, im.height), 0, 0);
    c.hasAlpha = im.alpha;
    return c;
  }
  // A sub-bitmap of a sheet as its own canvas, so scaling doesn't bleed in the neighbouring frames.
  sub(file, x, y, w, h) {
    const img = this.get(file);
    if (!img || (!x && !y && w === img.width && h === img.height)) return img;
    const key = `${x},${y},${w},${h}`;
    img.subs ??= new Map();
    let c = img.subs.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      img.subs.set(key, c);
    }
    return c;
  }
  purge(file) { if (file) this.cache.delete(String(file).toLowerCase().replace(/\\/g, '/')); }
}

export class UI {
  constructor(R, canvas, images) {
    this.R = R;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.images = images;
    this.items = [];          // panels and texts in creation order
    this.hover = null;
    this.pressed = null;
  }

  register(obj) { obj._order = this.items.length; this.items.push(obj); }

  // Applies `key = values` definitions of a PANEL / TEXT.
  define(obj, props) {
    obj.buttons = []; obj.digits = []; obj.windows = []; obj.sliders = [];
    for (const [key, thunk] of props) {
      // digits point at variables that may not exist yet (player.skill27): resolved at draw time
      if (key === 'digits') { obj.digits.push({ thunk }); continue; }
      let v;
      try { v = thunk(); } catch (e) { this.R.warn(`${obj.name}.${key}: ${e.message}`); continue; }
      switch (key) {
        case 'flags': {
          let f = 0;
          for (const x of v) f |= val(x);
          obj.flags = f;
          for (const [name, bit] of Object.entries(FLAGS)) if (f & bit && bit !== 2) obj[name] = 1;
          if (f & 2) obj.transparent = 1;
          break;
        }
        case 'button': {
          const [x, y, on, off, over, click, leave, overFn] = v;
          obj.buttons.push({ x: val(x), y: val(y), on, off, over, click, leave, overFn });
          break;
        }
        case 'window': {
          const [x, y, dx, dy, bmap, rx, ry] = v;
          obj.windows.push({ x: val(x), y: val(y), dx: val(dx), dy: val(dy), bmap, rx, ry });
          break;
        }
        case 'hslider': case 'vslider': {
          const [x, y, len, bmap, min, max, ref] = v;
          obj.sliders.push({ dir: key[0], x: val(x), y: val(y), len: val(len), bmap, min: val(min), max: val(max), ref });
          break;
        }
        case 'string': obj.string = v.map(s => (s instanceof Str ? s : new Str(text(s)))); break;
        case 'strings': obj.strings = val(v[0]); break;
        default: obj[key] = v.length === 1 ? (v[0] instanceof Ref ? val(v[0]) : v[0]) : v;
      }
    }
    if (obj.kind === 'text') {
      obj.string ??= [];
      while (obj.string.length < (obj.strings || 1)) obj.string.push(new Str(''));
    }
  }

  // Pixel size of a bmap (sub-rectangle aware); 0 while still loading.
  bmapSize(b) {
    if (!b || typeof b !== 'object') return [0, 0];
    if (b.w && b.h) return [b.w, b.h];
    const img = this.images.get(b.file);
    return img ? [img.width, img.height] : [0, 0];
  }

  drawBmap(b, x, y, sx = 1, sy = 1) {
    if (!b || typeof b !== 'object' || !b.file) return;
    const img = this.images.get(b.file);
    if (!img) return;
    const w = b.w || img.width, h = b.h || img.height;
    this.ctx.drawImage(this.images.sub(b.file, b.x || 0, b.y || 0, w, h), x, y, w * sx, h * sy);
  }

  font(f, sy = 1) {
    let size = 12, style = '', family = 'Arial';
    if (f && f.args) {
      const [name, st, sz] = f.args;
      family = text(name).replace(/#.*/, '') || 'Arial';
      size = val(sz) || 12;
      if (val(st) & 1) style += 'bold ';
      if (val(st) & 2) style += 'italic ';
    }
    return { css: `${style}${Math.max(6, size * sy)}px "${family}", Arial, sans-serif`, size: size * sy };
  }

  // Draw all visible items sorted by layer.
  draw() {
    const g = this.ctx, R = this.R;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const list = this.items.filter(o => o.visible).sort((a, b) => (val(a.layer) - val(b.layer)) || (a._order - b._order));
    for (const o of list) {
      g.globalAlpha = o.transparent ? Math.max(0, Math.min(1, val(o.alpha ?? 50) / 100)) : 1;
      if (g.globalAlpha <= 0) continue;
      if (o.kind === 'panel') this.drawPanel(o);
      else if (o.kind === 'text') this.drawText(o);
    }
    g.globalAlpha = 1;
    void R;
  }

  drawPanel(p) {
    const g = this.ctx;
    const sx = val(p.scale_x) || 1, sy = val(p.scale_y) || 1, px = val(p.pos_x), py = val(p.pos_y);
    this.drawBmap(p.bmap, px, py, sx, sy);
    for (const w of p.windows) {
      if (!w.bmap) continue;
      const img = this.images.get(w.bmap.file);
      if (!img) continue;
      const ox = val(w.rx), oy = val(w.ry);
      g.drawImage(img, (w.bmap.x || 0) + ox, (w.bmap.y || 0) + oy, w.dx, w.dy, px + w.x * sx, py + w.y * sy, w.dx * sx, w.dy * sy);
    }
    p.buttons.forEach((b, i) => {
      const state = this.pressed?.panel === p && this.pressed.i === i ? b.on : this.hover?.panel === p && this.hover.i === i ? (b.over || b.off) : b.off;
      this.drawBmap(state, px + b.x * sx, py + b.y * sy, sx, sy);
    });
    for (const dd of p.digits) {
      let d;
      try {
        const [x, y, fmt, font, factor, ref] = dd.thunk();
        d = { x: val(x), y: val(y), fmt, font, factor: val(factor) || 1, ref };
      } catch { continue; }
      const f = this.font(d.font, sy);
      g.font = f.css;
      g.fillStyle = 'white';
      g.textBaseline = 'top';
      const v = d.ref instanceof Ref ? d.ref.get(0) * d.factor : val(d.ref) * d.factor;
      let s;
      if (typeof d.fmt === 'string' || d.fmt instanceof Str) s = cformat(text(d.fmt), v);
      else s = String(Math.round(v)).padStart(val(d.fmt), ' ');
      g.fillText(s, px + d.x * sx, py + d.y * sy);
    }
  }

  drawText(t) {
    const g = this.ctx;
    const sy = val(t.scale_y) || 1, sx = val(t.scale_x) || 1;
    const f = this.font(t.font, sy);
    g.font = f.css;
    g.textBaseline = 'top';
    const r = t.red ?? 255, gr = t.green ?? 255, b = t.blue ?? 255;
    g.fillStyle = `rgb(${val(r) || 255},${val(gr) || 255},${val(b) || 255})`;
    const cx = t.center_x || (val(t.flags) & FLAGS.center_x), cy = t.center_y || (val(t.flags) & FLAGS.center_y);
    g.textAlign = cx ? 'center' : 'left';
    const lineH = f.size * 1.2;
    const lines = [];
    const maxW = val(t.size_x) ? val(t.size_x) * sx : 0;
    for (const s of t.string || []) {
      for (const raw of text(s).split(/\n|\\n/)) {
        if (!maxW) { lines.push(raw); continue; }
        let cur = '';
        for (const word of raw.split(' ')) {
          const tryS = cur ? cur + ' ' + word : word;
          if (g.measureText(tryS).width > maxW && cur) { lines.push(cur); cur = word; } else cur = tryS;
        }
        lines.push(cur);
      }
    }
    let y = val(t.pos_y) - val(t.offset_y) * sy;
    if (cy) y -= (lines.length * lineH) / 2;
    const x = val(t.pos_x);
    const shadow = t.shadow || (val(t.flags) & FLAGS.shadow) || t.outline;
    const clipH = val(t.size_y) ? val(t.size_y) * sy : 0;
    if (clipH) { g.save(); g.beginPath(); g.rect(0, val(t.pos_y), this.canvas.width, clipH); g.clip(); }
    for (const line of lines) {
      if (shadow) { const c = g.fillStyle; g.fillStyle = 'black'; g.fillText(line, x + 1, y + 1); g.fillStyle = c; }
      g.fillText(line, x, y);
      y += lineH;
    }
    if (clipH) g.restore();
    g.textAlign = 'left';
  }

  // Mouse in screen coordinates; returns true when the click hit a panel button.
  pointer(x, y, down, up) {
    const hit = this.hitTest(x, y);
    const R = this.R;
    if (hit?.panel !== this.hover?.panel || hit?.i !== this.hover?.i) {
      if (this.hover) { const b = this.hover.panel.buttons[this.hover.i]; if (b.leave) R.callPtr(b.leave, { me: 0, you: 0 }, [this.hover.i + 1, this.hover.panel]); }
      if (hit) { const b = hit.panel.buttons[hit.i]; if (b.overFn) R.callPtr(b.overFn, { me: 0, you: 0 }, [hit.i + 1, hit.panel]); }
      this.hover = hit;
    }
    if (down && hit) this.pressed = hit;
    if (up) {
      const p = this.pressed;
      this.pressed = null;
      if (p && hit && p.panel === hit.panel && p.i === hit.i) {
        const b = p.panel.buttons[p.i];
        if (b.click) R.callPtr(b.click, { me: 0, you: 0 }, [p.i + 1, p.panel]);
        return true;
      }
    }
    return !!hit;
  }
  hitTest(x, y) {
    const list = this.items.filter(o => o.visible && o.kind === 'panel' && o.buttons.length)
      .sort((a, b) => (val(b.layer) - val(a.layer)) || (b._order - a._order));
    for (const p of list) {
      const sx = val(p.scale_x) || 1, sy = val(p.scale_y) || 1;
      for (let i = p.buttons.length - 1; i >= 0; i--) {
        const b = p.buttons[i];
        const [w, h] = this.bmapSize(b.off || b.on);
        const bx = val(p.pos_x) + b.x * sx, by = val(p.pos_y) + b.y * sy;
        if (x >= bx && y >= by && x < bx + w * sx && y < by + h * sy) return { panel: p, i };
      }
    }
    return null;
  }
}

// Minimal printf for digits formats like "%.3f", "%3.0f", "%d", "%s".
function cformat(fmt, v) {
  return fmt.replace(/%(-?)(\d*)(?:\.(\d+))?([dfis%])/g, (m, left, width, prec, type) => {
    if (type === '%') return '%';
    let s = type === 'f' ? (+v).toFixed(prec == null ? 6 : +prec) : type === 's' ? String(v) : String(Math.trunc(v));
    if (width) s = left ? s.padEnd(+width) : s.padStart(+width);
    return s;
  });
}
