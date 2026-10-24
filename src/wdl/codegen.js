// WDL AST -> JavaScript.
//
// Every script function becomes a generator `function* (ctx, ...params)`. `wait(n)` / `sleep(s)` become
// `yield`, and the runtime resumes the generator on a later frame. Like the original engine, a call
// runs the callee until its first wait and then returns to the caller, while the callee keeps running
// as its own task (see runtime.call).
//
// Functions that use labels and goto are lowered to a `switch` state machine.
//
// Memory model: script globals live in G (lower-case keys), locals are JS `let` bindings ($name).
// `var a[3]` is a JS array. Vectors are passed as references R.ref(container, key) where a builtin or a
// script function expects one (vec_set(temp, my.x) -> R.ref(G.temp, 0), R.ref(ctx.me, 'x')).

// Vector argument positions of engine functions.
export const VEC_SLOTS = {
  vec_set: [0, 1], vec_add: [0, 1], vec_sub: [0, 1], vec_scale: [0], vec_mul: [0, 1], vec_length: [0], vec_dist: [0, 1],
  vec_normalize: [0], vec_to_angle: [0, 1], vec_for_angle: [0, 1], vec_rotate: [0, 1], vec_inverse: [0], vec_diff: [0, 1, 2],
  vec_dot: [0, 1], vec_cross: [0, 1, 2], vec_lerp: [0, 1, 2], vec_accelerate: [0, 1, 2], vec_for_vertex: [0], vec_for_screen: [0],
  vec_to_screen: [0], vec_zero: [0], vec_fill: [0], vec_randomize: [0], vec_for_bone: [0], vec_for_normal: [0], vec_for_uv: [0],
  ang_rotate: [0, 1], ang_add: [0, 1], ang_diff: [0, 1, 2], ang_lerp: [0, 1, 2], vec_set_euler: [0], rel_for_screen: [0],
  vec_for_ent: [0], vec_to_ent: [0], vec_to_mesh: [0], vec_for_mesh: [0], ent_vertex: [0],
  ent_create: [1], ent_createlocal: [1], ent_createlayer: [], c_trace: [0, 1], trace: [0, 1], c_move: [1, 2], ent_move: [0, 1],
  move: [1, 2], effect: [2, 3], effect_local: [2, 3], c_scan: [0, 1, 2], scan_entity: [0, 1], scan: [0, 1, 2], scan_texture: [0, 1],
 ent_playsound: [], ent_bonerotate: [2], ent_bonemove: [2], ent_bonerotate_parent: [2],
  content: [0], c_content: [0], vec_bounce: [0, 1], vec_clamp: [0], draw_line3d: [0, 1], draw_point3d: [0, 1],
  pos_for_screen: [0],
};

// Engine calls that suspend the current function.
const WAITS = new Set(['wait', 'sleep', 'wait_for', 'waitt']);

const VECOFF = { x: 0, y: 1, z: 2, pan: 0, tilt: 1, roll: 2, red: 0, green: 1, blue: 2, u: 0, v: 1 };
const CONST = { on: '1', off: '0', true: '1', false: '0', null: '0' };

const jsStr = s => JSON.stringify(s);
const loc = n => '$' + n.replace(/[^\w$]/g, c => '_' + c.charCodeAt(0).toString(16));

export function compile(prog) {
  const globals = new Map();     // name -> { array, kind }
  for (const v of prog.vars) {
    if (!globals.has(v.name)) globals.set(v.name, { array: !!v.size, kind: v.kind, ptr: v.ptrKind });
  }
  for (const s of prog.strings) globals.set(s.name, { kind: 'string' });
  for (const s of prog.sounds) globals.set(s.name, { kind: 'sound' });
  for (const s of prog.bmaps) globals.set(s.name, { kind: 'bmap' });
  for (const s of prog.fonts) globals.set(s.name, { kind: 'font' });
  for (const o of prog.objects) globals.set(o.name, { kind: o.kind });
  const funcs = prog.funcs;
  const isFunc = n => funcs.has(n) && funcs.get(n).body;
  const usedGlobals = new Set(), calledBuiltins = new Map();

  // ----- which params are used as vectors (fixpoint over calls) -----
  const vecParams = new Map();
  for (const [name, f] of funcs) vecParams.set(name, new Set(f.params.refs || []));
  function scanVec(f, node, ps) {
    if (!node || typeof node !== 'object') return false;
    let changed = false;
    const mark = e => {
      if (e && e.k === 'id') {
        const i = f.params.indexOf(e.v);
        if (i >= 0 && !ps.has(i)) { ps.add(i); changed = true; }
      }
    };
    if (node.k === 'mem' || node.k === 'idx') mark(node.o);
    if (node.k === 'call' && node.f.k === 'id') {
      const slots = VEC_SLOTS[node.f.v] || (vecParams.get(node.f.v) && [...vecParams.get(node.f.v)]) || [];
      for (const s of slots) mark(node.args[s]);
    }
    for (const key in node) {
      const v = node[key];
      if (Array.isArray(v)) { for (const x of v) changed = scanVec(f, x, ps) || changed; }
      else if (v && typeof v === 'object' && key !== 'refs') changed = scanVec(f, v, ps) || changed;
    }
    return changed;
  }
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (const [name, f] of funcs) if (f.body) changed = scanVec(f, f.body, vecParams.get(name)) || changed;
  }

  // ----- function compiler -----
  function compileFunction(f) {
    const locals = new Map();    // name -> { array }
    const params = new Map(f.params.map((p, i) => [p, i]));
    const vecP = vecParams.get(f.name) || new Set();
    let temps = 0;
    const writeback = [];
    let hasLabels = false;
    (function find(n) {
      if (!n || typeof n !== 'object') return;
      if (n.k === 'label') hasLabels = true;
      if (n.k === 'var') for (const d of n.decls) if (!locals.has(d.name) && !params.has(d.name)) locals.set(d.name, { array: !!d.size, kind: d.kind });
      for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(find); else if (v && typeof v === 'object') find(v); }
    })(f.body);
    const isArrayName = n => locals.get(n)?.array || (!locals.has(n) && !params.has(n) && globals.get(n)?.array);
    // `var h; h.z = 1;` uses a scalar like a vector (the engine just uses the memory after it), while
    // `var e; e = you; e.x` uses it as a pointer. A scalar local gets a companion array ($h$v) that
    // holds .y/.z while it holds a number; when it holds an object, member access goes to the object.
    const companions = new Set();
    const scalarLocal = n => (locals.has(n) && !locals.get(n).array && locals.get(n).kind !== 'string') || (params.has(n) && !vecP.has(params.get(n)));
    const companion = n => { companions.add(n); return loc(n) + '$v'; };

    function idRef(name) {
      if (name === 'my' || name === 'me') return 'ctx.me';
      if (name === 'you') return 'ctx.you';
      if (locals.has(name) || params.has(name)) return loc(name);
      if (name in CONST) return CONST[name];
      if (isFunc(name) && !globals.has(name)) return `F[${jsStr(name)}]`;
      usedGlobals.add(name);
      return `G[${jsStr(name)}]`;
    }

    // Expression -> JS (value)
    function ex(e) {
      switch (e.k) {
        case 'num': return String(e.v);
        case 'str': return jsStr(e.v);
        case 'file': return `R.file(${jsStr(e.v)})`;
        case 'id': return idRef(e.v);
        case 'mem': {
          const off = VECOFF[e.name];
          if (off !== undefined && e.o.k === 'id' && isArrayName(e.o.v)) return `(${idRef(e.o.v)}[${off}] ?? 0)`;
          if (off !== undefined && e.o.k === 'id' && scalarLocal(e.o.v)) {
            const v = loc(e.o.v), c = companion(e.o.v);
            return `((typeof ${v} === 'object' && ${v}) ? R.get(${v}, ${jsStr(e.name)}) : ${off === 0 ? v : `${c}[${off}]`})`;
          }
          return `R.get(${ex(e.o)}, ${jsStr(e.name)})`;
        }
        case 'idx':
          if (e.o.k === 'id' && isArrayName(e.o.v)) return `(${idRef(e.o.v)}[${ex(e.i)} | 0] ?? 0)`;
          return `R.getIdx(${ex(e.o)}, ${ex(e.i)})`;
        case 'call': return call(e);
        case 'un':
          if (e.op === '!') return `(${ex(e.e)} ? 0 : 1)`;
          if (e.op === '+') return ex(e.e);
          return `(${e.op}${ex(e.e)})`;
        case 'bin': {
          const a = ex(e.a), b = ex(e.b);
          switch (e.op) {
            case '&&': return `(${a} && ${b} ? 1 : 0)`;
            case '||': return `(${a} || ${b} ? 1 : 0)`;
            case '==': case '!=': case '<': case '<=': case '>': case '>=':
              return `(${a} ${e.op} ${b} ? 1 : 0)`;
            default: return `(${a} ${e.op} ${b})`;
          }
        }
        case 'asg': return assign(e.target, e.op, ex(e.e));
        case 'inc': {
          const op = e.op === '++' ? '+' : '-';
          if (e.prefix) return assign(e.target, op + '=', '1');
          return `(${assign(e.target, op + '=', '1')} ${op === '+' ? '-' : '+'} 1)`;
        }
      }
      throw new Error(`bilinmeyen ifade ${e.k}`);
    }

    // Assignment (also compound ops) -> JS expression evaluating to the new value.
    function assign(t, op, rhs) {
      const bin = op === '=' ? null : op.slice(0, -1);
      const combine = cur => (bin ? `(${cur} ${bin} ${rhs})` : rhs);
      if (t.k === 'id') {
        const r = idRef(t.v);
        if (isArrayName(t.v)) return `(${r}[0] = ${combine(`(${r}[0] ?? 0)`)})`;
        if (r === 'ctx.me' || r === 'ctx.you' || r.startsWith('$') || r.startsWith('G[')) return `(${r} = ${combine(r)})`;
        return rhs;   // assigning to a constant: ignored
      }
      if (t.k === 'mem') {
        const off = VECOFF[t.name];
        if (off !== undefined && t.o.k === 'id' && isArrayName(t.o.v)) {
          const r = `${idRef(t.o.v)}[${off}]`;
          return `(${r} = ${combine(`(${r} ?? 0)`)})`;
        }
        if (off !== undefined && t.o.k === 'id' && scalarLocal(t.o.v)) {
          const v = loc(t.o.v), c = companion(t.o.v), slot = off === 0 ? v : `${c}[${off}]`;
          const value = bin ? `(${ex(t)} ${bin} ${rhs})` : rhs;
          return `((typeof ${v} === 'object' && ${v}) ? R.set(${v}, ${jsStr(t.name)}, ${value}) : (${slot} = ${value}))`;
        }
        const o = ex(t.o);
        return bin ? `R.op(${o}, ${jsStr(t.name)}, ${jsStr(bin)}, ${rhs})` : `R.set(${o}, ${jsStr(t.name)}, ${rhs})`;
      }
      if (t.k === 'idx') {
        if (t.o.k === 'id' && isArrayName(t.o.v)) {
          const r = idRef(t.o.v);
          if (!bin) return `(${r}[${ex(t.i)} | 0] = ${rhs})`;
          return `R.opIdx(${r}, ${ex(t.i)}, ${jsStr(bin)}, ${rhs})`;
        }
        return bin ? `R.opIdx(${ex(t.o)}, ${ex(t.i)}, ${jsStr(bin)}, ${rhs})` : `R.setIdx(${ex(t.o)}, ${ex(t.i)}, ${rhs})`;
      }
      return rhs;
    }

    // Vector / reference argument.
    function ref(e) {
      if (!e) return '0';
      if (e.k === 'mem') {
        if (e.o.k === 'id' && isArrayName(e.o.v) && VECOFF[e.name] !== undefined) return `R.ref(${idRef(e.o.v)}, ${VECOFF[e.name]})`;
        return `R.ref(${ex(e.o)}, ${jsStr(e.name)})`;
      }
      if (e.k === 'idx') return `R.ref(${ex(e.o)}, ${ex(e.i)})`;
      if (e.k === 'id' && isArrayName(e.v)) return `R.ref(${idRef(e.v)}, 0)`;
      if (e.k === 'id') {
        const pi = f.params.indexOf(e.v);
        // A scalar passed where a vector is expected: the engine writes its first component into it
        // (vec_to_angle(angle_var, dir)). Locals go through a temporary box written back after the call.
        if ((locals.has(e.v) || (pi >= 0 && !vecP.has(pi)))) {
          const v = loc(e.v), c = companion(e.v);
          writeback.push(`(typeof ${v} !== 'object' ? (${v} = ${c}[0]) : 0)`);
          return `((typeof ${v} === 'object' && ${v}) ? R.ref(${v}, 'x') : (${c}[0] = ${v}, R.ref(${c}, 0)))`;
        }
        if (!params.has(e.v) && globals.get(e.v)?.kind?.startsWith('var')) return `R.ref(G, ${jsStr(e.v)})`;
      }
      return ex(e);
    }
    // Wraps a call so boxed scalar arguments are written back: (r = call, a = box[0], r)
    function withWriteback(code, before) {
      const wb = writeback.splice(before);
      if (!wb.length) return code;
      const r = `$$b${temps++}`;
      return `(${r} = ${code}, ${wb.join(', ')}, ${r})`;
    }

    function call(e) {
      const args = e.args;
      if (e.f.k !== 'id') return `R.callPtr(${ex(e.f)}, ctx, [${args.map(ex).join(', ')}])`;
      const name = e.f.v;
      if (WAITS.has(name) && !isFunc(name)) {
        const a = args[0] ? ex(args[0]) : '1';
        if (name === 'sleep') return `(yield -(${a}))`;
        if (name === 'wait_for') return `(yield R.waitFor(${a}))`;
        return `(yield ${a})`;
      }
      if (isFunc(name)) {
        const vp = vecParams.get(name), mark = writeback.length;
        return withWriteback(`R.call(F[${jsStr(name)}], ctx, [${args.map((a, i) => (vp.has(i) ? ref(a) : ex(a))).join(', ')}])`, mark);
      }
      if (locals.has(name) || params.has(name) || (globals.has(name) && !prog.dll.has(name))) {
        return `R.callPtr(${idRef(name)}, ctx, [${args.map(ex).join(', ')}])`;
      }
      const slots = VEC_SLOTS[name] || [];
      if (!calledBuiltins.has(name)) calledBuiltins.set(name, `${e.f.file ?? f.file}:${e.f.line ?? f.line}`);
      const mark = writeback.length;
      return withWriteback(`B[${jsStr(name)}](ctx${args.map((a, i) => ', ' + (slots.includes(i) ? ref(a) : ex(a))).join('')})`, mark);
    }

    const GUARD = 'if ((++R.L & 4095) === 0) R.guard();';

    // ----- structured statements -----
    function st(s, ind) {
      const p = '  '.repeat(ind);
      switch (s.k) {
        case 'block': return s.body.map(x => st(x, ind)).join('');
        case 'empty': case 'label': return '';
        case 'var': return s.decls.map(d => p + declInit(d) + ';\n').join('');
        case 'expr': return `${p}${ex(s.e)};\n`;
        case 'if': return `${p}if (${ex(s.c)}) {\n${st(s.t, ind + 1)}${p}}` + (s.e ? ` else {\n${st(s.e, ind + 1)}${p}}\n` : '\n');
        case 'while': return `${p}while (${ex(s.c)}) {\n${p}  ${GUARD}\n${st(s.body, ind + 1)}${p}}\n`;
        case 'break': return `${p}break;\n`;
        case 'continue': return `${p}continue;\n`;
        case 'return': return `${p}return ${s.e ? ex(s.e) : '0'};\n`;
        case 'goto': return `${p}/* goto ${s.label} */\n`;
      }
      throw new Error(`bilinmeyen deyim ${s.k}`);
    }
    function declInit(d) {
      const r = loc(d.name);
      if (d.size) {
        const size = d.size === -1 ? (Array.isArray(d.init) ? d.init.length : 1) : ex(d.size);
        const init = d.init == null ? '' : Array.isArray(d.init) ? d.init.map(ex).join(', ') : ex(d.init);
        return `${r} = R.arr(${size}, [${init}])`;
      }
      if (d.kind === 'string') return `${r} = R.str(${d.init && !Array.isArray(d.init) ? ex(d.init) : '""'})`;
      const init = d.init == null ? '0' : Array.isArray(d.init) ? ex(d.init[0]) : ex(d.init);
      return `${r} = ${init}`;
    }

    // ----- lowered (goto) form -----
    function lowered(body) {
      let next = 1, out = '';
      const labels = new Map();
      const L = name => { if (!labels.has(name)) labels.set(name, next++); return labels.get(name); };
      const fresh = () => next++;
      const jump = id => `$pc = ${id}; continue;`;
      const loops = [];
      function emit(s) {
        switch (s.k) {
          case 'block': s.body.forEach(emit); return;
          case 'empty': return;
          case 'label': out += `case ${L(s.name)}:\n`; return;
          case 'goto': out += jump(L(s.label)) + '\n'; return;
          case 'var': for (const d of s.decls) out += declInit(d) + ';\n'; return;
          case 'expr': out += ex(s.e) + ';\n'; return;
          case 'return': out += `return ${s.e ? ex(s.e) : '0'};\n`; return;
          case 'if': {
            const els = fresh(), end = fresh();
            out += `if (!(${ex(s.c)})) { ${jump(s.e ? els : end)} }\n`;
            emit(s.t);
            if (s.e) { out += jump(end) + `\ncase ${els}:\n`; emit(s.e); }
            out += `case ${end}:\n`;
            return;
          }
          case 'while': {
            const top = fresh(), end = fresh();
            out += `case ${top}:\nif (!(${ex(s.c)})) { ${jump(end)} }\n`;
            loops.push({ top, end });
            emit(s.body);
            loops.pop();
            out += jump(top) + `\ncase ${end}:\n`;
            return;
          }
          case 'break': out += (loops.length ? jump(loops[loops.length - 1].end) : '') + '\n'; return;
          case 'continue': out += (loops.length ? jump(loops[loops.length - 1].top) : '') + '\n'; return;
        }
        throw new Error(`bilinmeyen deyim ${s.k}`);
      }
      emit(body);
      const missing = [];
      (function find(n) {
        if (!n || typeof n !== 'object') return;
        if (n.k === 'goto' && !labels.has(n.label)) missing.push(n.label);
        for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(find); else if (v && typeof v === 'object') find(v); }
      })(body);
      // A goto to an unknown label just ends the function, as the engine would fail anyway.
      for (const m of missing) out += `case ${L(m)}:\nreturn 0;\n`;
      return `let $pc = 0;\nfor (;;) {\n${GUARD}\nswitch ($pc) {\ncase 0:\n${out}}\nreturn 0;\n}\n`;
    }

    const ps = f.params.map(loc);
    const body = hasLabels ? lowered(f.body) : st(f.body, 1) + '  return 0;\n';
    const decl = [...locals.keys()].filter(n => !params.has(n)).map(n => `${loc(n)} = 0`);
    for (let t = 0; t < temps; t++) decl.push(`$b${t}`);
    for (const n of companions) decl.push(`${loc(n)}$v = [0, 0, 0]`);
    return `F[${jsStr(f.name)}] = function* w_${loc(f.name).slice(1)}(ctx${ps.map(p => ', ' + p).join('')}) {\n` +
      (decl.length ? `  let ${decl.join(', ')};\n` : '') + body + '};\n';
  }

  // ----- program -----
  let out = '';
  const failed = [];
  for (const [, f] of funcs) {
    if (!f.body) continue;
    try { out += compileFunction(f); }
    catch (err) { failed.push(`${f.name}: ${err.message}`); out += `F[${jsStr(f.name)}] = function* () { R.warn(${jsStr('derlenemedi: ' + f.name)}); return 0; };\n`; }
  }

  // Global initialisation; object properties are thunks so they can refer to anything defined later.
  const gx = makeGlobalExpr();
  let init = '';
  for (const v of prog.vars) {
    const key = jsStr(v.name);
    if (v.size) {
      const size = v.size === -1 ? (Array.isArray(v.init) ? v.init.length : 1) : gx(v.size);
      const list = v.init == null ? '' : Array.isArray(v.init) ? v.init.map(gx).join(', ') : gx(v.init);
      init += `G[${key}] = R.arr(${size}, [${list}]);\n`;
    } else {
      init += `G[${key}] = ${v.init == null ? '0' : gx(Array.isArray(v.init) ? v.init[0] : v.init)};\n`;
    }
  }
  for (const s of prog.strings) init += `G[${jsStr(s.name)}] = R.str(${jsStr(s.value)}, ${jsStr(s.name)});\n`;
  for (const s of prog.sounds) init += `G[${jsStr(s.name)}] = R.sound(${s.args.map(gx).join(', ')});\n`;
  for (const s of prog.bmaps) init += `G[${jsStr(s.name)}] = R.bmap(${jsStr(s.name)}${s.args.map(a => ', ' + gx(a)).join('')});\n`;
  for (const s of prog.fonts) init += `G[${jsStr(s.name)}] = R.font(${jsStr(s.name)}${s.args.map(a => ', ' + gx(a)).join('')});\n`;
  for (const o of prog.objects) init += `G[${jsStr(o.name)}] = R.object(${jsStr(o.kind)}, ${jsStr(o.name)});\n`;
  for (const o of prog.objects) {
    const props = o.props.map(p => `[${jsStr(p.key)}, () => [${p.values.map(v => gx(v, true)).join(', ')}]]`).join(',\n  ');
    init += `R.props(G[${jsStr(o.name)}], [\n  ${props}]);\n`;
  }
  for (const k of prog.keys) init += `G[${jsStr(k.key)}] = ${k.func in CONST ? '0' : isFunc(k.func) ? `F[${jsStr(k.func)}]` : '0'};\n`;

  function makeGlobalExpr() {
    // Expressions outside functions: same rules, no locals; `asRef` turns script variables into references.
    const fake = { name: '', params: [], body: { k: 'block', body: [] }, file: '', line: 0 };
    vecParams.set('', new Set());
    return (e, asRef = false) => {
      if (asRef && e.k === 'id' && globals.has(e.v) && (globals.get(e.v).kind?.startsWith('var'))) {
        usedGlobals.add(e.v);
        return globals.get(e.v).array ? `R.ref(G[${jsStr(e.v)}], 0)` : `R.ref(G, ${jsStr(e.v)})`;
      }
      if (asRef && e.k === 'mem') return `R.ref(${exprOf(e.o)}, ${jsStr(e.name)})`;
      return exprOf(e);
    };
    function exprOf(e) {
      // Reuse the function compiler on a synthetic return statement.
      const src = compileFunction({ ...fake, body: { k: 'block', body: [{ k: 'return', e }] } });
      return src.slice(src.indexOf('return ') + 7, src.lastIndexOf(';\n  return 0;'));
    }
  }

  const declared = new Set([...globals.keys()]);
  const undeclared = [...usedGlobals].filter(n => !declared.has(n));
  const source = `"use strict";\nconst { G, F, B } = R;\n${out}\nR.initGlobals = () => {\n${init}};\nR.starters = ${JSON.stringify(prog.starters.filter(isFunc))};\n`;
  return { source, failed, undeclared, builtins: calledBuiltins, vecParams };
}
