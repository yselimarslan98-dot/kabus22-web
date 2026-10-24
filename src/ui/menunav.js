// Gamepad navigation for HTML menus: D-pad / left stick moves focus spatially,
// A (Cross) activates, left/right on a <select> cycles its options, B (Circle) goes back.
import { PAD } from '../engine/input.js';

export class MenuNav {
  constructor(input) {
    this.input = input;
    this.items = [];
    this.repeatAt = 0;
  }

  scope() {
    const pause = document.querySelector('#pause:not([hidden])');
    if (pause) return pause;
    const s = document.querySelector('.screen.active');
    return s && s.id !== 'screen-game' ? s : null;
  }

  refresh() {
    const sc = this.scope();
    this.items = sc ? [...sc.querySelectorAll('[data-nav]')].filter(el => !el.hidden && el.offsetParent !== null) : [];
  }

  update() {
    const inp = this.input;
    if (!inp.pad || !this.items.length) return;
    const now = performance.now();
    const dx = (inp.padDown(PAD.RIGHT) ? 1 : 0) - (inp.padDown(PAD.LEFT) ? 1 : 0) + Math.round(inp.axis(0));
    const dy = (inp.padDown(PAD.DOWN) ? 1 : 0) - (inp.padDown(PAD.UP) ? 1 : 0) + Math.round(inp.axis(1));
    const cur = document.activeElement;
    const focused = this.items.includes(cur) ? cur : null;

    if ((dx || dy) && now >= this.repeatAt) {
      this.repeatAt = now + (this.held ? 120 : 320);
      this.held = true;
      if (!focused) return this.focus(this.items[0]);
      if (focused.tagName === 'SELECT' && dx && !dy) {
        focused.selectedIndex = (focused.selectedIndex + dx + focused.options.length) % focused.options.length;
        focused.dispatchEvent(new Event('change'));
        return;
      }
      this.focus(this.nearest(focused, Math.sign(dx), Math.sign(dy)) || focused);
    } else if (!dx && !dy) {
      this.held = false;
      this.repeatAt = 0;
    }

    if (inp.padPressed(PAD.A)) {
      if (!focused) this.focus(this.items[0]);
      else if (focused.tagName !== 'SELECT') focused.click();
    }
    if (inp.padPressed(PAD.B)) document.querySelector('#pause:not([hidden]) #btn-continue, .screen.active #btn-back')?.click();
  }

  focus(el) {
    el.focus({ preventScroll: false });
    el.scrollIntoView({ block: 'nearest' });
    this.items.forEach(i => i.classList.toggle('pad-focus', i === el));
  }

  nearest(from, dx, dy) {
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of this.items) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const vx = b.left + b.width / 2 - ax, vy = b.top + b.height / 2 - ay;
      const along = vx * dx + vy * dy;
      if (along <= 4) continue;
      const across = Math.abs(dx ? vy : vx);
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
}
