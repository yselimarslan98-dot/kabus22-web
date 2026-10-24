// Reads the game's own WDL scripts and records which entity flags each action switches on
// right at startup (before its first loop or wait), e.g. `my.invisible = on; my.passable = on;`.
// This is enough to show the level the way the engine does before the game logic runs.

const FLAGS = ['invisible', 'passable', 'transparent', 'bright', 'unlit', 'overlay', 'facing', 'oriented', 'flare'];

export async function actionHints(fs) {
  const hints = new Map();
  for (const file of fs.list('.wdl')) {
    const src = (await fs.readText(file)).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/\baction\s+(\w+)\s*\{/gi)) {
      const flags = {};
      const start = m.index + m[0].length;
      let depth = 1, end = start;
      for (; end < src.length && depth > 0; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') depth--;
      }
      // Statements up to the first loop / wait / branch.
      const body = src.slice(start, end);
      const stop = /\b(while|wait|if|ent_remove)\s*\(/i.exec(body);
      const head = stop ? body.slice(0, stop.index) : body;
      for (const f of FLAGS) {
        const r = new RegExp(`\\bmy\\.${f}\\s*=\\s*(on|off|1|0)\\b`, 'gi');
        for (const x of head.matchAll(r)) flags[f] = /on|1/i.test(x[1]);
      }
      const alpha = /\bmy\.alpha\s*=\s*(\d+(?:\.\d+)?)/i.exec(head);
      if (alpha) flags.alpha = +alpha[1];
      hints.set(m[1].toLowerCase(), flags);
    }
  }
  return hints;
}
