// Source fixes applied to the game's own scripts before compiling. Keep these rare: each one
// changes the shipped game's logic, so it must only remove a dead end.
const PATCHES = [
  {
    // boss_alev_basla is cleared only when the flame lands and finishes. The projectile lives for
    // about 800 units, so from further away it vanished in mid-air, the flag stayed set, the boss
    // never cast again and its Ebru phase (which needs the flag clear) could not start.
    file: 'efect2.wdl',
    after: 'function boss_alevadu_buyu',
    find: 'remove(me);',
    insert: 'if(boss_alev_start==0){boss_alev_basla=0;}\n\t',
  },
];

export function patchSource(name, src, onWarn = () => {}) {
  const base = name.split(/[\\/]/).pop().toLowerCase();
  for (const p of PATCHES) {
    if (p.file !== base) continue;
    const from = src.indexOf(p.after);
    const at = from < 0 ? -1 : src.indexOf(p.find, from);
    if (at < 0) { onWarn(`betik yaması uygulanamadı: ${p.file} ${p.after}`); continue; }
    src = src.slice(0, at) + p.insert + src.slice(at);
  }
  return src;
}
