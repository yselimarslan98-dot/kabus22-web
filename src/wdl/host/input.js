// Keyboard, mouse and gamepad -> engine variables (key_*, mouse_*, joy_*), with DirectInput scancodes
// for key_pressed(), as the scripts store key bindings as scancodes in options.k22.

const SCAN = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23,
  KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33,
  KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66,
  F9: 67, F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75,
  Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83, F11: 87,
  F12: 88, NumpadEnter: 28, ControlRight: 29, AltRight: 56, Home: 71, ArrowUp: 72, PageUp: 73, ArrowLeft: 75, ArrowRight: 77,
  End: 79, ArrowDown: 80, PageDown: 81, Insert: 82, Delete: 83, IntlBackslash: 86,
};
// key_<name> variables
const NAMES = {
  Escape: 'esc', Enter: 'enter', NumpadEnter: 'enter', Space: 'space', Tab: 'tab', Backspace: 'bksp', ShiftLeft: 'shift', ShiftRight: 'shift',
  ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt', ArrowUp: 'cuu', ArrowDown: 'cud', ArrowLeft: 'cul',
  ArrowRight: 'cur', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn', Insert: 'ins', Delete: 'del',
};
for (let i = 1; i <= 12; i++) NAMES['F' + i] = 'f' + i;
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') NAMES['Key' + c] = c.toLowerCase();
for (let i = 0; i <= 9; i++) NAMES['Digit' + i] = String(i);

export const MOUSE_LEFT = 280, MOUSE_RIGHT = 281, MOUSE_MIDDLE = 282;

export class EngineInput {
  constructor(R, target, toScreen) {
    this.R = R;
    this.down = new Set();         // scancodes currently held
    this.toScreen = toScreen;      // (clientX, clientY) -> [x, y] in game screen pixels
    this.mouseDelta = [0, 0];
    this.events = [];
    const G = R.G;
    G.mouse_pos = [0, 0, 0]; G.mouse_force = [0, 0, 0]; G.mouse_left = 0; G.mouse_right = 0; G.mouse_middle = 0;
    G.mouse_mode ??= 0; G.mouse_valid = 0;
    G.joy_force = [0, 0, 0]; G.joy_raw = [0, 0, 0]; G.joy_hat = -1; G.joy_buttons = 0; G.joy2_buttons = 0; G.num_joysticks = 0;
    for (let i = 1; i <= 12; i++) G['joy_' + i] = 0;
    G.key_any = 0; G.key_lastpressed = 0;
    for (const n of new Set(Object.values(NAMES))) G['key_' + n] = 0;

    R.B.key_pressed = (c, code) => {
      code = +code || 0;
      if (code === MOUSE_LEFT) return G.mouse_left;
      if (code === MOUSE_RIGHT) return G.mouse_right;
      if (code === MOUSE_MIDDLE) return G.mouse_middle;
      if (code >= 256 && code < 256 + 12) return G['joy_' + (code - 255)] ? 1 : 0;
      return this.down.has(code) ? 1 : 0;
    };

    this.fresh = new Set();     // pressed since the last frame
    this.deferred = [];         // releases of keys no frame has seen pressed yet
    const key = (e, on) => {
      const sc = SCAN[e.code];
      if (sc === undefined) return;
      // The scripts poll keys once per frame; a tap shorter than a frame must still be seen.
      if (!on && this.fresh.has(sc)) { this.deferred.push(e); e.preventDefault(); return; }
      if (on) { this.down.add(sc); this.fresh.add(sc); G.key_lastpressed = sc; } else this.down.delete(sc);
      const n = NAMES[e.code];
      if (n) G['key_' + n] = on ? 1 : 0;
      G.key_any = this.down.size ? 1 : 0;
      if (on && !e.repeat) this.events.push({ type: 'key', code: e.code, name: n });
      // Keep the browser from scrolling / opening menus on game keys.
      if (e.code !== 'F5' && e.code !== 'F12' && !(e.ctrlKey && e.code === 'KeyR')) e.preventDefault();
    };
    this.onKeyDown = e => key(e, true);
    this.onKeyUp = e => key(e, false);
    this.onBlur = () => { this.down.clear(); for (const n of new Set(Object.values(NAMES))) G['key_' + n] = 0; G.key_any = 0; };
    this.onMouse = e => {
      const [x, y] = this.toScreen(e.clientX, e.clientY);
      G.mouse_pos[0] = x; G.mouse_pos[1] = y; G.mouse_valid = 1;
      if (e.type === 'mousemove') { this.mouseDelta[0] += e.movementX; this.mouseDelta[1] += e.movementY; }
      if (e.type === 'mousedown' || e.type === 'mouseup') {
        const v = e.type === 'mousedown' ? 1 : 0;
        if (e.button === 0) G.mouse_left = v; else if (e.button === 2) G.mouse_right = v; else if (e.button === 1) G.mouse_middle = v;
        this.events.push({ type: e.type, x, y, button: e.button });
      }
    };
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    for (const t of ['mousemove', 'mousedown', 'mouseup']) target.addEventListener(t, this.onMouse);
    target.addEventListener('contextmenu', e => e.preventDefault());
  }

  // Called once per frame before the scripts run.
  poll(dt) {
    const G = this.R.G;
    // Releases held back until one frame has seen the key down (see the key handler).
    const late = this.seen || [];
    this.seen = this.deferred.splice(0);
    this.fresh.clear();
    for (const e of late) this.onKeyUp(e);
    // mouse_force: movement per frame, roughly normalised like the engine's (-1..1 range for normal moves)
    G.mouse_force[0] = this.mouseDelta[0] / 20; G.mouse_force[1] = -this.mouseDelta[1] / 20;
    this.mouseDelta[0] = this.mouseDelta[1] = 0;

    // Standard-mapping gamepad -> joystick. Buttons 1..12 follow the DirectInput order of an Xbox pad.
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const p = pads[0];
    G.num_joysticks = pads.length;
    if (p) {
      const dz = v => (Math.abs(v) < 0.15 ? 0 : v);
      let x = dz(p.axes[0] || 0), y = dz(p.axes[1] || 0);
      const b = i => (p.buttons[i] ? p.buttons[i].pressed || p.buttons[i].value > 0.5 : false);
      // D-pad also steers, as on the original joystick hat.
      if (b(12)) y = -1; if (b(13)) y = 1; if (b(14)) x = -1; if (b(15)) x = 1;
      // The scripts only walk on Key_Ileri==1 (full deflection), so past half way the stick counts as fully pushed.
      const full = v => (Math.abs(v) > 0.5 ? Math.sign(v) : 0);
      G.joy_force[0] = full(x) * 2; G.joy_force[1] = -full(y) * 2;
      G.joy_raw[0] = x * 255; G.joy_raw[1] = y * 255;
      // Right stick acts like the mouse (first-person camera).
      const rx = dz(p.axes[2] || 0), ry = dz(p.axes[3] || 0);
      if (rx || ry) { G.mouse_force[0] = rx * 0.6; G.mouse_force[1] = -ry * 0.6; }
      // The game's default joystick bindings (options.k22) are buttons 1..6 for
      // aim, fire, run, inventory, map, magic. Lay them out like a modern pad:
      // LT aim, RT fire, LB run, Y inventory, Back map, RB magic; the rest follow.
      const order = [6, 7, 4, 3, 8, 5, 0, 1, 2, 10, 11, 9];
      let mask = 0;
      order.forEach((bi, k) => { const on = b(bi) ? 1 : 0; G['joy_' + (k + 1)] = on; if (on) mask |= 1 << k; });
      G.joy_buttons = mask;
      G.joy_hat = b(12) ? 0 : b(15) ? 9000 : b(13) ? 18000 : b(14) ? 27000 : -1;
      // Menus listen to Enter / Esc: A confirms, B and Start go back.
      this.padKey(28, 'enter', b(0));
      this.padKey(1, 'esc', b(1) || b(9));
      this.pad = p;
    } else {
      G.joy_force[0] = G.joy_force[1] = 0;
      for (let i = 1; i <= 12; i++) G['joy_' + i] = 0;
      this.pad = null;
    }
    void dt;
  }

  // A pad button standing in for a keyboard key (only toggles what the pad itself pressed).
  padKey(code, name, on) {
    this.padHeld ??= new Set();
    const G = this.R.G;
    if (on && !this.padHeld.has(code)) { this.padHeld.add(code); this.down.add(code); G['key_' + name] = 1; G.key_lastpressed = code; }
    else if (!on && this.padHeld.has(code)) { this.padHeld.delete(code); this.down.delete(code); G['key_' + name] = 0; }
    G.key_any = this.down.size ? 1 : 0;
  }

  dispose() {
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
  }
}
