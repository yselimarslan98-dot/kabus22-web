// Runtime for compiled WDL: task scheduler, memory model and the engine-independent builtins.
// The host (renderer, audio, input, files) plugs in through `host` and may add or override builtins in B.

const VECOFF = { x: 0, y: 1, z: 2, pan: 0, tilt: 1, roll: 2, red: 0, green: 1, blue: 2, u: 0, v: 1 };
// Field triples on objects: vec_set(my.x, ...) touches x, y, z; my.pan -> pan, tilt, roll; ...
const TRIPLE = {};
for (const t of [['x', 'y', 'z'], ['pan', 'tilt', 'roll'], ['scale_x', 'scale_y', 'scale_z'], ['red', 'green', 'blue'],
  ['lightred', 'lightgreen', 'lightblue'], ['min_x', 'min_y', 'min_z'], ['max_x', 'max_y', 'max_z'], ['pos_x', 'pos_y', 'pos_z'],
  ['size_x', 'size_y', 'size_z'], ['offset_x', 'offset_y', 'offset_z'], ['u', 'v', 'w'], ['ambient_red', 'ambient_green', 'ambient_blue'],
  ['diffuse_red', 'diffuse_green', 'diffuse_blue'], ['specular_red', 'specular_green', 'specular_blue'],
  ['emissive_red', 'emissive_green', 'emissive_blue'], ['blue', 'green', 'red']]) {
  if (!TRIPLE[t[0]]) TRIPLE[t[0]] = t;
}
const DEG = Math.PI / 180;
export const TICK = 1 / 16;   // engine time unit: 1 tick = 1/16 second

// Reference to a value inside a container: array element or object field.
export class Ref {
  constructor(c, k) { this.c = c; this.k = k; }
  key(i) {
    if (Array.isArray(this.c) || ArrayBuffer.isView(this.c)) return this.k + i;
    if (i === 0) return this.k;
    if (TRIPLE[this.k]) return TRIPLE[this.k][i];
    const m = /^(.*?)(\d+)$/.exec(this.k);          // skill5 -> skill6, skill7
    return m ? m[1] + (+m[2] + i) : this.k + i;
  }
  get(i = 0) { const v = this.c[this.key(i)]; return v ?? 0; }
  set(i, v) { this.c[this.key(i)] = v; }
}

// Mutable engine string.
export class Str {
  constructor(s = '', name = '') { this.s = String(s); this.name = name; }
  toString() { return this.s; }
}

const text = v => (v instanceof Str ? v.s : v == null || v === 0 ? '' : typeof v === 'object' && 's' in v ? v.s : String(v));

export class Runtime {
  constructor(host = {}) {
    this.host = host;
    this.G = Object.create(null);
    this.F = Object.create(null);
    this.B = Object.create(null);
    this.tasks = [];
    this.current = null;
    this.frameNo = 0;
    this.now = 0;                      // seconds
    this.L = 0;
    this.warned = new Set();
    this.stats = { calls: 0, tasks: 0 };
    installCore(this);
  }

  // ----- loading -----
  load(compiled) {
    const fn = new Function('R', compiled.source);
    fn(this);
    // Builtins the scripts call but nobody implemented: warn once, return 0.
    for (const [name, where] of compiled.builtins) {
      if (!this.B[name]) this.B[name] = (...a) => { this.warnOnce('eksik motor fonksiyonu: ' + name + ' (' + where + ')'); return 0; };
    }
    for (const n of compiled.undeclared) if (!(n in this.G)) this.G[n] = 0;
    this.initGlobals();
  }

  start(entry = 'main') {
    for (const s of this.starters) this.call(this.F[s], { me: 0, you: 0 }, []);
    if (this.F[entry]) this.call(this.F[entry], { me: 0, you: 0 }, []);
  }

  // ----- scheduler -----
  // Runs `fn` until its first wait; the rest continues as a task. Returns the function's result (or 0).
  call(fn, ctx, args) {
    if (typeof fn !== 'function') return 0;
    this.stats.calls++;
    const c = { me: ctx?.me ?? 0, you: ctx?.you ?? 0 };
    const gen = fn(c, ...args);
    return this.resume({ gen, ctx: c, wake: 0, wakeT: 0, name: fn.name, order: 0 }, undefined, true);
  }
  callPtr(f, ctx, args) {
    if (typeof f === 'function') return this.call(f, ctx, args);
    return 0;
  }
  // Calls `fn` with `me` set (entity actions, panel button events).
  callAs(fn, me, you = 0, args = []) { return this.call(fn, { me, you }, args); }

  resume(task, value, first = false) {
    const prev = this.current, prevL = this.L;
    this.current = task;
    this.L = 0;
    let r;
    try {
      r = task.gen.next(value);
    } catch (err) {
      this.current = prev; this.L = prevL;
      this.error(err, task);
      return 0;
    }
    this.current = prev; this.L = prevL;
    if (r.done) return r.value ?? 0;
    this.schedule(task, r.value);
    if (first) this.tasks.push(task);
    return 0;
  }

  schedule(task, w) {
    if (w && typeof w === 'object' && w.until) { task.until = w.until; task.wake = this.frameNo + 1; return; }
    task.until = null;
    const n = +w || 1;
    if (n < 0) { task.wake = this.frameNo + 1; task.wakeT = this.now - n; }   // wait(-s) / sleep(s): seconds
    else { task.wake = this.frameNo + Math.max(1, Math.round(n)); task.wakeT = 0; }
  }

  // One engine frame: advance time and resume due tasks in order.
  frame(dt) {
    this.frameNo++;
    this.now += dt;
    const G = this.G;
    G.time_step = G.time = Math.min(dt / TICK, 16 * (G.time_smooth_max || 1)) * (G.time_factor ?? 1);
    G.total_ticks += dt / TICK;
    G.total_frames = this.frameNo;
    const list = this.tasks;
    this.tasks = [];
    const keep = [];
    for (const t of list) {
      if (t.dead) continue;
      if (t.ctx.me && t.ctx.me.removed) continue;          // function of a removed entity ends
      if (t.wake > this.frameNo || (t.wakeT && t.wakeT > this.now) || (t.until && !t.until())) { keep.push(t); continue; }
      const prev = this.current;
      this.current = t;
      this.L = 0;
      let r;
      try { r = t.gen.next(); }
      catch (err) { this.current = prev; this.error(err, t); continue; }
      this.current = prev;
      if (!r.done) { this.schedule(t, r.value); keep.push(t); }
    }
    // Tasks started during this frame were pushed to this.tasks; keep order: old first.
    this.tasks = keep.concat(this.tasks);
    this.stats.tasks = this.tasks.length;
  }

  waitFor(fn) { return { until: () => !this.tasks.some(t => t.name === fn?.name) }; }

  runaway() {
    this.L = 0;
    throw new Error(`sonsuz döngü (wait olmadan): ${this.current?.name ?? '?'}`);
  }
  error(err, task) {
    const msg = `${task?.name ?? '?'}: ${err.message}`;
    if (this.host.onError) this.host.onError(msg, err);
    else console.error('[wdl]', msg, err);
  }
  warn(msg) { (this.host.onWarn || console.warn)('[wdl] ' + msg); }
  warnOnce(msg) { if (!this.warned.has(msg)) { this.warned.add(msg); this.warn(msg); } }

  // ----- memory -----
  ref(c, k) {
    if (c instanceof Ref) {             // ref to a field of a vector param: p.y
      const off = typeof k === 'number' ? k : VECOFF[k];
      if (off !== undefined) return new Ref(c.c, typeof c.k === 'number' ? c.k + off : c.key(off));
      return new Ref(c.c, k);
    }
    if (!c) { this.warnOnce('boş işaretçi (vektör)'); return new Ref([0, 0, 0], 0); }
    if (Array.isArray(c) && typeof k === 'string') return new Ref(c, VECOFF[k] ?? 0);
    if (typeof k === 'number' && !Array.isArray(c) && !ArrayBuffer.isView(c)) return new Ref(c, k);
    return new Ref(c, k);
  }
  get(o, k) {
    if (o instanceof Ref) {
      const off = VECOFF[k];
      return off !== undefined ? o.get(off) : (o.c[k] ?? 0);
    }
    if (Array.isArray(o)) return o[VECOFF[k] ?? 0] ?? 0;
    if (!o || typeof o !== 'object') { this.nullAccess(k); return 0; }
    const v = o[k];
    return v === undefined ? (o.getProp ? o.getProp(k) : 0) : v;
  }
  set(o, k, v) {
    if (o instanceof Ref) {
      const off = VECOFF[k];
      if (off !== undefined) o.set(off, v); else o.c[k] = v;
      return v;
    }
    if (Array.isArray(o)) { o[VECOFF[k] ?? 0] = v; return v; }
    if (!o || typeof o !== 'object') { this.nullAccess(k); return v; }
    if (o.setProp) o.setProp(k, v); else o[k] = v;
    return v;
  }
  op(o, k, op, v) { return this.set(o, k, arith(this.get(o, k), op, v)); }
  getIdx(o, i) {
    i |= 0;
    if (o instanceof Ref) return o.get(i);
    if (o && typeof o === 'object' && 'length' in o) return o[i] ?? 0;
    this.nullAccess('[' + i + ']');
    return 0;
  }
  setIdx(o, i, v) {
    i |= 0;
    if (o instanceof Ref) o.set(i, v);
    else if (o && typeof o === 'object') o[i] = v;
    else this.nullAccess('[' + i + ']');
    return v;
  }
  opIdx(o, i, op, v) { return this.setIdx(o, i, arith(this.getIdx(o, i), op, v)); }
  nullAccess(k) { this.warnOnce(`boş işaretçi erişimi: .${k} (${this.current?.name ?? '?'})`); }

  arr(size, init) {
    const n = Math.max(0, size | 0, init.length);
    const a = new Array(n).fill(0);
    for (let i = 0; i < init.length; i++) a[i] = init[i];
    return a;
  }
  str(v = '', name = '') { return new Str(text(v), name); }
  file(name) { return name; }

  // Overridden by the host.
  sound(file) { return { kind: 'sound', file: text(file) }; }
  bmap(name, file, x, y, w, h) { return { kind: 'bmap', name, file: text(file), x, y, w, h }; }
  font(name, ...args) { return { kind: 'font', name, args }; }
  object(kind, name) { return { kind, name }; }
  props(obj, list) { obj.def = list; }
}

function arith(a, op, b) {
  switch (op) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
    case '&': return a & b; case '|': return a | b; case '^': return a ^ b; case '<<': return a << b; case '>>': return a >> b;
  }
  return b;
}

// ---------- vectors ----------
function rd(v) {
  if (v instanceof Ref) return [v.get(0), v.get(1), v.get(2)];
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
  return [0, 0, 0];
}
function wr(v, x, y, z) {
  if (v instanceof Ref) { v.set(0, x); v.set(1, y); v.set(2, z); }
  else if (Array.isArray(v)) { v[0] = x; v[1] = y; v[2] = z; }
  else if (v && typeof v === 'object') { v.x = x; v.y = y; v.z = z; }
  return v;
}
// Euler rotation as the engine does it: roll about x, then tilt about y (positive = up), then pan about z.
export function rotate([x, y, z], pan, tilt, roll) {
  const cr = Math.cos(roll * DEG), sr = Math.sin(roll * DEG);
  let y1 = y * cr - z * sr, z1 = y * sr + z * cr;
  const ct = Math.cos(tilt * DEG), st = Math.sin(tilt * DEG);
  const x2 = x * ct - z1 * st, z2 = x * st + z1 * ct;
  const cp = Math.cos(pan * DEG), sp = Math.sin(pan * DEG);
  return [x2 * cp - y1 * sp, x2 * sp + y1 * cp, z2];
}
export const vec = { rd, wr };

function installCore(R) {
  const G = R.G, B = R.B;
  Object.assign(G, {
    on: 1, off: 0, null: 0, nullvector: [0, 0, 0], temp: [0, 0, 0], result: 0, normal: [0, 0, 0], target: [0, 0, 0],
    time: 1, time_step: 1, time_factor: 1, total_ticks: 0, total_frames: 0, time_smooth_max: 1,
    max_loops: 0, max_particles: 0, num_particles: 0, fps_max: 60, fps_min: 16, warn_level: 0, version: 6.6,
    delimit_str: new Str('$'), sys_day: new Date().getDate(), sys_month: new Date().getMonth() + 1, sys_year: new Date().getFullYear(),
  });
  const n = x => (typeof x === 'number' ? x : x instanceof Ref ? x.get(0) : +x || 0);

  // math (angles in degrees, like the engine)
  Object.assign(B, {
    abs: (c, x) => Math.abs(n(x)), sign: (c, x) => Math.sign(n(x)), sqrt: (c, x) => Math.sqrt(Math.max(0, n(x))),
    pow: (c, a, b) => Math.pow(n(a), n(b)), int: (c, x) => Math.trunc(n(x)), frc: (c, x) => n(x) - Math.trunc(n(x)),
    min: (c, a, b) => Math.min(n(a), n(b)), max: (c, a, b) => Math.max(n(a), n(b)), clamp: (c, x, a, b) => Math.min(n(b), Math.max(n(a), n(x))),
    sin: (c, x) => Math.sin(n(x) * DEG), cos: (c, x) => Math.cos(n(x) * DEG), tan: (c, x) => Math.tan(n(x) * DEG),
    asin: (c, x) => Math.asin(n(x)) / DEG, acos: (c, x) => Math.acos(n(x)) / DEG, atan: (c, x) => Math.atan(n(x)) / DEG,
    random: (c, x) => Math.random() * n(x), randomize: () => 0,
    ang: (c, x) => { let a = n(x) % 360; if (a > 180) a -= 360; if (a < -180) a += 360; return a; },
  });

  // vectors
  Object.assign(B, {
    vector: (c, x, y, z) => new Ref([n(x), n(y), n(z)], 0),
    vec_set: (c, a, b) => { const v = rd(b); return wr(a, ...v); },
    vec_add: (c, a, b) => { const p = rd(a), q = rd(b); return wr(a, p[0] + q[0], p[1] + q[1], p[2] + q[2]); },
    vec_sub: (c, a, b) => { const p = rd(a), q = rd(b); return wr(a, p[0] - q[0], p[1] - q[1], p[2] - q[2]); },
    vec_scale: (c, a, f) => { const p = rd(a); f = n(f); return wr(a, p[0] * f, p[1] * f, p[2] * f); },
    vec_mul: (c, a, b) => { const p = rd(a), q = rd(b); return wr(a, p[0] * q[0], p[1] * q[1], p[2] * q[2]); },
    vec_inverse: (c, a) => { const p = rd(a); return wr(a, -p[0], -p[1], -p[2]); },
    vec_length: (c, a) => Math.hypot(...rd(a)),
    vec_dist: (c, a, b) => { const p = rd(a), q = rd(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); },
    vec_dot: (c, a, b) => { const p = rd(a), q = rd(b); return p[0] * q[0] + p[1] * q[1] + p[2] * q[2]; },
    vec_diff: (c, r, a, b) => { const p = rd(a), q = rd(b); return wr(r, p[0] - q[0], p[1] - q[1], p[2] - q[2]); },
    vec_lerp: (c, r, a, b, f) => { const p = rd(a), q = rd(b); f = n(f); return wr(r, p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f); },
    vec_normalize: (c, a, len) => {
      const p = rd(a), l = Math.hypot(...p);
      if (l > 0) { const f = n(len) / l; wr(a, p[0] * f, p[1] * f, p[2] * f); }
      return l;
    },
    vec_to_angle: (c, ang, dir) => {
      const [x, y, z] = rd(dir), l = Math.hypot(x, y, z);
      const r = ang instanceof Ref ? ang : R.ref(ang, 'pan');
      r.set(0, Math.atan2(y, x) / DEG);
      r.set(1, l > 0 ? Math.asin(Math.max(-1, Math.min(1, z / l))) / DEG : 0);
      return l;
    },
    vec_for_angle: (c, dir, ang) => {
      const [p, t] = rd(ang);
      return wr(dir, Math.cos(p * DEG) * Math.cos(t * DEG), Math.sin(p * DEG) * Math.cos(t * DEG), Math.sin(t * DEG));
    },
    vec_rotate: (c, v, ang) => { const a = rd(ang); return wr(v, ...rotate(rd(v), a[0], a[1], a[2])); },
    vec_zero: (c, a) => wr(a, 0, 0, 0),
  });

  // strings
  Object.assign(B, {
    str_cpy: (c, d, s) => { if (d instanceof Str) d.s = text(s); return d; },
    str_cat: (c, d, s) => { if (d instanceof Str) d.s += text(s); return d; },
    str_cmp: (c, a, b) => (text(a) === text(b) ? 1 : 0),
    str_cmpi: (c, a, b) => (text(a).toLowerCase() === text(b).toLowerCase() ? 1 : 0),
    str_cmpni: (c, a, b) => (text(a).toLowerCase().startsWith(text(b).toLowerCase()) ? 1 : 0),
    str_len: (c, s) => text(s).length,
    str_clip: (c, s, k) => { if (s instanceof Str) s.s = s.s.slice(Math.max(0, n(k))); return s; },
    str_trunc: (c, s, k) => { if (s instanceof Str) s.s = s.s.slice(0, Math.max(0, s.s.length - n(k))); return s; },
    str_for_num: (c, s, v) => { if (s instanceof Str) s.s = (+n(v)).toFixed(3); return s; },
    str_to_num: (c, s) => parseFloat(text(s)) || 0,
    str_stri: (c, s, sub) => text(s).toLowerCase().indexOf(text(sub).toLowerCase()) + 1,
    str_create: (c, s) => new Str(text(s)),
    str_remove: () => 0,
  });

  Object.assign(B, {
    error: (c, msg) => { R.warn('error(): ' + text(msg)); return 0; },
    exit: () => { R.host.exit?.(); return 0; },
    beep: () => 0,
    proc_late: () => 0,
    // Discord, INI file and the brightness DLL of the widescreen edition.
    dll_open: () => 1, dl_pakaga: () => 0, discordrpc_tryconnect: () => 0, discordrpc_isconnected: () => 0,
    discordrpc_setstatedetails: () => 0, parse_escapechar: (c, s) => s,
    ini_isinitialized: () => 1, ini_getvariable: () => 0,
  });
}
