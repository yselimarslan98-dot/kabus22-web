// Unified input: keyboard + mouse (pointer lock) + Gamepad API (standard mapping:
// Xbox, DualSense/DualShock, Switch Pro all report the same layout in browsers).
const DEADZONE = 0.15;

export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9,
  LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

const dz = v => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { dx: 0, dy: 0 };
    this.pad = null;
    this.padPrev = [];
    this.padNow = [];
    this.lastDevice = 'keyboard';
    this.sensitivity = 0.0022;
    this.padLook = 2.6;

    addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', e => {
      if (document.pointerLockElement !== canvas) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
      this.lastDevice = 'keyboard';
    });
    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    addEventListener('gamepadconnected', e => {
      this.lastDevice = 'gamepad';
      this.onPadChange?.(e.gamepad);
    });
    addEventListener('gamepaddisconnected', () => this.onPadChange?.(null));
  }

  poll() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    this.pad = pads.find(p => p.mapping === 'standard') || pads[0] || null;
    this.padPrev = this.padNow;
    this.padNow = this.pad ? this.pad.buttons.map(b => b.pressed) : [];
    if (this.padNow.some(Boolean) || (this.pad && this.pad.axes.some(a => Math.abs(a) > 0.4))) this.lastDevice = 'gamepad';
  }

  padDown(b) { return !!this.padNow[b]; }
  padPressed(b) { return !!this.padNow[b] && !this.padPrev[b]; }
  axis(i) { return this.pad ? dz(this.pad.axes[i] || 0) : 0; }
  trigger(b) { return this.pad && this.pad.buttons[b] ? this.pad.buttons[b].value : 0; }

  // Movement intent in local space: x = strafe right, y = up, z = forward.
  move() {
    const k = c => (this.keys.has(c) ? 1 : 0);
    let x = k('KeyD') - k('KeyA') + this.axis(0);
    let z = k('KeyW') - k('KeyS') - this.axis(1);
    let y = k('Space') - k('KeyC') - k('ControlLeft') + (this.padDown(PAD.A) ? 1 : 0) - (this.padDown(PAD.B) ? 1 : 0);
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, y: Math.max(-1, Math.min(1, y)), z };
  }

  running() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.padDown(PAD.LS) || this.trigger(PAD.LT) > 0.5;
  }

  // Look delta in radians for this frame.
  look(dt) {
    const yaw = -this.mouse.dx * this.sensitivity - this.axis(2) * this.padLook * dt;
    const pitch = -this.mouse.dy * this.sensitivity - this.axis(3) * this.padLook * dt;
    this.mouse.dx = this.mouse.dy = 0;
    return { yaw, pitch };
  }

  rumble(strong = 0.6, weak = 0.3, ms = 120) {
    const act = this.pad && this.pad.vibrationActuator;
    if (act && act.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
}
