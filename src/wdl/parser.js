// WDL / C-Script parser: tokens -> program AST.
import { fileLiteral, rawBetween } from './lexer.js';

const OBJECT_KINDS = new Set(['panel', 'text', 'entity', 'view', 'material', 'overlay', 'skill']);
const POINTER_KINDS = new Set(['entity', 'panel', 'text', 'view', 'material', 'string', 'bmap', 'sound', 'function', 'font', 'var', 'action']);
const IGNORED = new Set(['resource', 'path', 'plugindir', 'bind', 'window', 'library', 'save_dir', 'savedir']);
const VAR_KW = new Set(['var', 'var_nsave', 'var_info', 'var_global']);

export class ParseError extends Error {}

// C precedence, lowest first.
const BINARY = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

export function parse(tokens, { onWarn = () => {} } = {}) {
  let i = 0;
  const peek = (o = 0) => tokens[i + o];
  const is = (v, o = 0) => { const t = tokens[i + o]; return t && t.v === v && t.t !== 'str'; };
  const where = t => t ? `${t.file}:${t.line}` : 'EOF';
  const fail = msg => { throw new ParseError(`${msg} (${where(peek())}, '${peek()?.raw ?? peek()?.v}')`); };
  const eat = v => { if (!is(v)) fail(`'${v}' bekleniyordu`); return tokens[i++]; };
  const opt = v => (is(v) ? (i++, true) : false);
  const ident = () => { const t = peek(); if (!t || t.t !== 'id') fail('ad bekleniyordu'); i++; return t.v; };

  const prog = { vars: [], strings: [], sounds: [], bmaps: [], fonts: [], objects: [], funcs: new Map(), starters: [], keys: [], dll: new Set(), errors: [] };

  // ---------- expressions ----------
  function primary() {
    const t = peek();
    if (!t) fail('ifade bekleniyordu');
    if (t.t === 'num') { i++; return { k: 'num', v: t.v }; }
    if (t.t === 'str') { i++; let v = t.v; while (peek()?.t === 'str') v += tokens[i++].v; return { k: 'str', v }; }
    if (t.v === '<') {
      const fl = fileLiteral(tokens, i);
      if (fl) { const v = rawBetween(tokens, i, fl[1]); i = fl[1]; return { k: 'file', v }; }
    }
    if (t.v === '(') { i++; const e = expr(); eat(')'); return e; }
    if (t.t === 'id') { i++; return { k: 'id', v: t.v, line: t.line, file: t.file }; }
    fail('beklenmeyen simge');
  }
  function postfix() {
    let e = primary();
    for (;;) {
      if (is('.')) { i++; e = { k: 'mem', o: e, name: ident() }; }
      else if (is('[')) { i++; const x = expr(); eat(']'); e = { k: 'idx', o: e, i: x }; }
      else if (is('(')) {
        i++;
        const args = [];
        if (!is(')')) do { args.push(assign()); } while (opt(','));
        eat(')');
        e = { k: 'call', f: e, args, line: e.line, file: e.file };
      }
      else if (is('++') || is('--')) { e = { k: 'inc', op: tokens[i++].v, target: e, prefix: false }; }
      else return e;
    }
  }
  function unary() {
    if (is('-') || is('!') || is('~') || is('+')) { const op = tokens[i++].v; return { k: 'un', op, e: unary() }; }
    if (is('++') || is('--')) { const op = tokens[i++].v; return { k: 'inc', op, target: unary(), prefix: true }; }
    // `&name` / `*name` (pointer syntax from lite-C style code) are no-ops here.
    if (is('&') || is('*')) { i++; return unary(); }
    return postfix();
  }
  function binary(level) {
    if (level === BINARY.length) return unary();
    let a = binary(level + 1);
    while (peek() && peek().t === 'p' && BINARY[level].includes(peek().v)) {
      const op = tokens[i++].v;
      a = { k: 'bin', op, a, b: binary(level + 1) };
    }
    return a;
  }
  function assign() {
    const target = binary(0);
    const t = peek();
    if (t && t.t === 'p' && ASSIGN.has(t.v)) { i++; return { k: 'asg', op: t.v, target, e: assign() }; }
    return target;
  }
  const expr = assign;

  // ---------- statements ----------
  function varDecls(kind) {
    const decls = [];
    do {
      const name = ident();
      let size = 0, init = null;
      if (opt('[')) { size = is(']') ? -1 : expr(); eat(']'); }
      // "var a[3] (1,2,3);" and a list on the next line without '=' are accepted too
      if (opt('=') || is('(') || peek()?.t === 'num' || (is('-') && peek(1)?.t === 'num')) init = initList();
      opt(')');
      decls.push({ name, size, init, kind });
    } while (opt(','));
    opt(';');
    return decls;
  }
  // `= 5`  `= (1,2,3)`  `= 1, 2, 3` (only numbers continue a bare list)
  function initList() {
    if (is('(')) {
      const save = i;
      i++;
      const list = [];
      if (!is(')')) do { if (is(';') && is(')', 1)) { i++; break; } list.push(expr()); } while (opt(',') || peek()?.t === 'num');
      opt(';');
      if (opt(')') && (is(';') || is(','))) return list;
      i = save;
    }
    const first = expr();
    const list = [first];
    // The engine also accepts numbers separated only by spaces ("1, 1 1.25").
    while ((is(',') && (peek(1)?.t === 'num' || (peek(1)?.v === '-' && peek(2)?.t === 'num'))) || peek()?.t === 'num') { opt(','); list.push(expr()); }
    return list.length > 1 ? list : first;
  }

  function block() {
    eat('{');
    const body = [];
    while (!is('}')) {
      if (!peek()) fail('kapanmamış blok');
      body.push(statement());
    }
    eat('}');
    return { k: 'block', body };
  }
  function statement() {
    const t = peek();
    if (t.t === 'p') {
      if (t.v === '{') return block();
      if (t.v === ';' || t.v === ',') { i++; return { k: 'empty' }; }
    }
    if (t.t === 'id') {
      const kw = t.v;
      if (VAR_KW.has(kw)) { i++; return { k: 'var', decls: varDecls('var') }; }
      if (POINTER_KINDS.has(kw) && is('*', 1)) { i += 2; return { k: 'var', decls: varDecls('ptr') }; }
      if (kw === 'string' && peek(1)?.t === 'id') { i++; return { k: 'var', decls: varDecls('string') }; }
      if (kw === 'if') {
        i++; eat('(');
        const c = expr(); eat(')');
        const th = statement();
        let el = null;
        if (is('else')) { i++; el = statement(); }
        return { k: 'if', c, t: th, e: el };
      }
      if (kw === 'while') { i++; eat('('); const c = expr(); eat(')'); return { k: 'while', c, body: statement() }; }
      if (kw === 'break') { i++; opt(';'); return { k: 'break' }; }
      if (kw === 'continue') { i++; opt(';'); return { k: 'continue' }; }
      if (kw === 'return') {
        i++;
        const e = is(';') || is('}') ? null : expr();
        opt(';');
        return { k: 'return', e };
      }
      if (kw === 'goto') {
        i++;
        const paren = opt('(');
        const label = ident();
        if (paren) eat(')');
        opt(';');
        return { k: 'goto', label };
      }
      // `label:`
      if (is(':', 1) && !is('::', 1)) { i += 2; return { k: 'label', name: kw }; }
      // Old command syntax: `remove me;`  `on_esc null;`
      if (peek(1)?.t === 'id' && (is(';', 2) || is(',', 2))) {
        i++;
        if (/^on_/.test(kw)) { const e = expr(); opt(';'); return { k: 'expr', e: { k: 'asg', op: '=', target: { k: 'id', v: kw }, e } }; }
        const args = [];
        do { args.push(expr()); } while (opt(','));
        opt(';');
        return { k: 'expr', e: { k: 'call', f: { k: 'id', v: kw, line: t.line, file: t.file }, args } };
      }
      // Bare engine statements: `exit;`  `beep;`  `wait;`
      if (peek(1)?.v === ';' && ['exit', 'beep', 'wait', 'exclusive_entity', 'exclusive_global', 'proc_late', 'proc_kill', 'exit_game'].includes(kw)) {
        i += 2;
        return { k: 'expr', e: { k: 'call', f: { k: 'id', v: kw }, args: kw === 'wait' ? [{ k: 'num', v: 1 }] : [] } };
      }
    }
    const e = expr();
    if (!opt(';') && !is('}')) fail("';' bekleniyordu");
    return { k: 'expr', e };
  }

  function params() {
    const ps = [];
    if (!opt('(')) return ps;
    if (!is(')')) do {
      // `var a`, `entity* e`, `&vec` (vector by reference) or bare `a`
      if (opt('&')) { ps.push(ident()); ps.refs ??= new Set(); ps.refs.add(ps.length - 1); continue; }
      if (peek()?.t === 'id' && (VAR_KW.has(peek().v) || POINTER_KINDS.has(peek().v)) && (peek(1)?.t === 'id' || is('*', 1))) {
        i += is('*', 1) ? 2 : 1;
      }
      ps.push(ident());
      if (opt('[')) { while (!is(']')) i++; i++; }
    } while (opt(','));
    eat(')');
    return ps;
  }

  // `key = a, b, c;` pairs inside panel/text/entity/view/material definitions.
  function objectBody() {
    eat('{');
    const props = [];
    while (!is('}')) {
      if (!peek()) fail('kapanmamış tanım');
      if (opt(';')) continue;
      const key = ident();
      const values = [];
      if (opt('=')) {
        if (is('{')) { objectBody(); opt(';'); continue; }   // nested block (material effects etc.)
        do {
          if (is(';') || is('}')) break;
          values.push(expr());
        } while (opt(',') || (peek() && peek().t !== 'p'));   // commas are sometimes missing at line ends
      }
      opt(';');
      props.push({ key, values });
    }
    eat('}');
    return props;
  }

  function skipToSemi() {
    let depth = 0;
    while (peek()) {
      const t = tokens[i++];
      if (t.v === '{') depth++;
      else if (t.v === '}') { if (--depth <= 0 && depth < 0) return; if (depth === 0) return; }
      else if (t.v === ';' && depth === 0) return;
    }
  }

  // ---------- top level ----------
  function toplevel() {
    const t = peek();
    if (t.t !== 'id') { if (opt(';')) return; fail('bildirim bekleniyordu'); }
    const kw = t.v;
    if (VAR_KW.has(kw)) { i++; prog.vars.push(...varDecls(kw)); return; }
    if (POINTER_KINDS.has(kw) && is('*', 1)) { i += 2; prog.vars.push(...varDecls('ptr').map(d => ({ ...d, ptrKind: kw }))); return; }
    if (kw === 'string') {
      i++;
      do {
        const name = ident();
        let size = 0, value = '';
        if (opt('[')) { size = expr(); eat(']'); }
        if (opt('=') || opt(',')) {
          const e = expr();
          value = e.k === 'str' || e.k === 'file' ? e.v : e.k === 'num' ? ' '.repeat(e.v) : '';
        }
        prog.strings.push({ name, value, size });
      } while (opt(','));
      opt(';');
      return;
    }
    if (kw === 'sound' || kw === 'bmap' || kw === 'font') {
      i++;
      const name = ident();
      if (!(opt('=') || opt(','))) { opt(';'); (kw === 'sound' ? prog.sounds : kw === 'bmap' ? prog.bmaps : prog.fonts).push({ name, args: [] }); return; }
      const args = [];
      do { args.push(expr()); } while (opt(',') || peek()?.t === 'num');   // "<file.tga>0,120,115,76"
      opt(';');
      (kw === 'sound' ? prog.sounds : kw === 'bmap' ? prog.bmaps : prog.fonts).push({ name, args });
      return;
    }
    if (kw === 'function' || kw === 'action' || kw === 'starter') {
      i++;
      const name = ident();
      const ps = kw === 'action' && !is('(') ? [] : params();
      if (opt(';')) {   // prototype
        if (!prog.funcs.has(name)) prog.funcs.set(name, { name, params: ps, body: null, kind: kw });
        return;
      }
      const body = block();
      prog.funcs.set(name, { name, params: ps, body, kind: kw, file: t.file, line: t.line });
      if (kw === 'starter') prog.starters.push(name);
      return;
    }
    if (kw === 'dllfunction') { i++; prog.dll.add(ident()); skipToSemi(); return; }
    if (OBJECT_KINDS.has(kw) && peek(1)?.t === 'id') {
      i++;
      const name = ident();
      const props = is('{') ? objectBody() : [];
      opt(';');
      prog.objects.push({ kind: kw, name, props, file: t.file });
      return;
    }
    if (/^on_/.test(kw)) {
      i++;
      opt('=');
      const f = ident();
      opt(';');
      prog.keys.push({ key: kw, func: f });
      return;
    }
    if (IGNORED.has(kw)) { skipToSemi(); return; }
    fail('bilinmeyen bildirim');
  }

  while (i < tokens.length) {
    const start = i;
    try {
      toplevel();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      prog.errors.push(e.message);
      onWarn(e.message);
      // Recover: from the start of the failed declaration skip to its ';' or its whole { } block.
      i = start;
      let depth = 0;
      while (i < tokens.length) {
        const v = tokens[i].t === 'p' ? tokens[i].v : '';
        i++;
        if (v === '{') depth++;
        else if (v === '}') { if (--depth <= 0) break; }
        else if (v === ';' && depth === 0) break;
      }
    }
  }
  return prog;
}
