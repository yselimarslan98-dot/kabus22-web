// WDL / C-Script (Acknex A6) lexer and preprocessor.
// The language is case-insensitive: identifiers carry a lower-case `v` and their original `raw`.

const PUNCT = ['<<=', '>>=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '=', '+', '-', '*', '/', '%', '<', '>', '!', '&', '|', '^', '~', ':', '?', '#'];

export function tokenize(src, file = '?') {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    const start = i;
    if (/[A-Za-z_À-￿]/.test(c)) {
      while (i < n && /[A-Za-z0-9_À-￿]/.test(src[i])) i++;
      const raw = src.slice(start, i);
      out.push({ t: 'id', v: raw.toLowerCase(), raw, line, file, pos: start });
      continue;
    }
    const prevT = out[out.length - 1];
    const afterName = prevT && (prevT.t === 'id' || prevT.v === ')' || prevT.v === ']');
    // ".5" is a number, but in "my.3rdMesafe" the dot is member access.
    if (/[0-9]/.test(c) || (c === '.' && !afterName && /[0-9]/.test(src[i + 1]))) {
      if (c === '0' && /[xX]/.test(src[i + 1])) {
        i += 2;
        while (i < n && /[0-9A-Fa-f]/.test(src[i])) i++;
        out.push({ t: 'num', v: parseInt(src.slice(start + 2, i), 16), line, file, pos: start });
        continue;
      }
      while (i < n && /[0-9.]/.test(src[i])) i++;
      // Names may start with digits ("3rd_camera", "my.1point_x").
      if (/[A-Za-z_]/.test(src[i]) && !src.slice(start, i).includes('.') && !/[eE][-+0-9]/.test(src.slice(i, i + 2))) {
        while (i < n && /[A-Za-z0-9_À-￿]/.test(src[i])) i++;
        const raw = src.slice(start, i);
        out.push({ t: 'id', v: raw.toLowerCase(), raw, line, file, pos: start });
        continue;
      }
      if (/[eE]/.test(src[i]) && /[-+0-9]/.test(src[i + 1])) { i += 2; while (i < n && /[0-9]/.test(src[i])) i++; }
      out.push({ t: 'num', v: parseFloat(src.slice(start, i)), line, file, pos: start });
      continue;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' ? '"' : e === '\\' ? '\\' : '\\' + e;
          i += 2;
          continue;
        }
        if (src[i] === '\n') line++;
        s += src[i++];
      }
      i++;
      out.push({ t: 'str', v: s, line, file, pos: start });
      continue;
    }
    let p = null;
    for (const q of PUNCT) if (src.startsWith(q, i)) { p = q; break; }
    if (!p) { i++; continue; }  // stray byte (e.g. encoding garbage outside comments)
    i += p.length;
    // "x* =time" is accepted by the engine as "x *= time".
    if ((p === '*' || p === '/' || p === '+' || p === '-') && /[ 	]/.test(src[i])) {
      let j = i;
      while (src[j] === ' ' || src[j] === '	') j++;
      if (src[j] === '=' && src[j + 1] !== '=' && out.length && /^(id|num)$/.test(out[out.length - 1].t) || src[j] === '=' && src[j + 1] !== '=' && out[out.length - 1]?.v === ']') { p += '='; i = j + 1; }
    }
    out.push({ t: 'p', v: p, line, file, pos: start, src });
  }
  return out;
}

// Reads `<file.ext>` starting at token index i (a '<' token). Returns [name, nextIndex] or null.
export function fileLiteral(toks, i) {
  const lt = toks[i];
  if (!lt || lt.v !== '<' || lt.t !== 'p') return null;
  let j = i + 1, name = '';
  while (j < toks.length && j < i + 40) {
    const t = toks[j];
    if (t.t === 'p' && t.v === '>') {
      if (!name) return null;
      return [name, j + 1];
    }
    if (t.line !== lt.line) return null;
    if (t.t === 'id' || t.t === 'num') name += 'x';
    else if (t.t === 'p' && /^[.\-\\/:+#!~]$/.test(t.v)) name += t.v;
    else return null;
    // The real text (numbers keep their formatting, e.g. "s1_0.5.wmb") is taken from the source by rawBetween.
    j++;
  }
  return null;
}

// Expands include / define / ifdef. `load(name)` returns source text or null.
export async function preprocess(entry, load, { onWarn = () => {} } = {}) {
  const defines = new Map();
  const seen = new Set();
  const out = [];

  async function run(name) {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const src = await load(name);
    if (src == null) { onWarn(`include bulunamadı: ${name}`); return; }
    const toks = tokenize(src, name);
    const skip = [];        // stack of booleans: true = currently skipping
    const skipping = () => skip.some(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const startOfStmt = i === 0 || (toks[i - 1].t === 'p' && (toks[i - 1].v === ';' || toks[i - 1].v === '}' || toks[i - 1].v === '{'));
      const hash = t.t === 'p' && t.v === '#' && toks[i + 1]?.t === 'id';
      const d = hash ? toks[i + 1] : t;
      const dir = d.t === 'id' && (startOfStmt || hash) ? d.v : null;
      if (dir === 'ifdef' || dir === 'ifndef') {
        const sym = toks[i + 1 + hash]?.v;
        const on = defines.has(sym);
        skip.push(skipping() || (dir === 'ifdef' ? !on : on));
        i += 1 + hash; if (toks[i + 1]?.v === ';') i++;
        continue;
      }
      if (dir === 'ifelse' || dir === 'else' && hash) {
        const top = skip.pop();
        const outer = skipping();
        skip.push(outer || !top);
        i += hash; if (toks[i + 1]?.v === ';') i++;
        continue;
      }
      if (dir === 'endif') { skip.pop(); i += hash; if (toks[i + 1]?.v === ';') i++; continue; }
      if (skipping()) continue;
      if (dir === 'include') {
        let j = i + 1 + hash, file;
        const fl = fileLiteral(toks, j);
        if (fl) { file = rawBetween(toks, j, fl[1]); j = fl[1]; }
        else if (toks[j]?.t === 'str') { file = toks[j].v; j++; }
        if (toks[j]?.v === ';') j++;
        i = j - 1;
        if (file) await run(file);
        continue;
      }
      if (dir === 'define') {
        // `define NAME, value;`  `define NAME;`  `#define NAME value` (to end of line)
        let j = i + 1 + hash;
        const nameTok = toks[j++];
        const body = [];
        if (hash) {
          while (j < toks.length && toks[j].line === nameTok.line) body.push(toks[j++]);
        } else {
          if (toks[j]?.v === ',' || toks[j]?.v === '=') j++;   // "define A, B;" and "DEFINE A = B;"
          while (j < toks.length && toks[j].v !== ';') body.push(toks[j++]);
          if (toks[j]?.v === ';') j++;
        }
        defines.set(nameTok.v, body);
        i = j - 1;
        continue;
      }
      if (dir === 'undef') { defines.delete(toks[i + 1 + hash]?.v); i += 1 + hash; if (toks[i + 1]?.v === ';') i++; continue; }
      out.push(t);
    }
  }
  await run(entry);

  // Macro substitution (repeated so defines can refer to defines).
  const expand = (toks, depth = 0) => {
    const res = [];
    for (const t of toks) {
      const body = t.t === 'id' && defines.get(t.v);
      if (body && depth < 8) for (const b of expand(body, depth + 1)) res.push({ ...b, line: t.line, file: t.file, pos: t.pos, src: t.src });
      else res.push(t);
    }
    return res;
  };
  return { tokens: expand(out), defines };
}

// Original text of a `<file>` literal between token indexes (keeps "s1_0.5.wmb" intact).
export function rawBetween(toks, i, end) {
  const a = toks[i], b = toks[end - 1];
  if (a.src && a.src === b.src) return a.src.slice(a.pos + 1, b.pos).trim();
  let s = '';
  for (let k = i + 1; k < end - 1; k++) s += toks[k].raw ?? toks[k].v;
  return s;
}
