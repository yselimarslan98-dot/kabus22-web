// Picks the pad the player is using and presents it in the standard mapping.
// Several pads can be listed at once (paired controllers, virtual drivers), so the first one is
// not necessarily the one in the player's hands: the pad last touched wins.
const SONY = /054c|dualsense|dualshock/i;
const btn = (pressed, value = pressed ? 1 : 0) => ({ pressed, value });

// DirectInput order of a DualSense, used when the browser reports no standard mapping.
function fromSony(p) {
  const raw = i => p.buttons[i] || btn(false);
  const hat = p.axes[9] ?? 2;
  // Eight directions from -1 (up) clockwise in steps of 2/7; anything above 1.1 is centred.
  const dir = Math.abs(hat) > 1.1 ? -1 : Math.round((hat + 1) * 3.5) % 8;
  const on = (...ds) => btn(ds.includes(dir));
  const buttons = [
    raw(1), raw(2), raw(0), raw(3),      // Cross, Circle, Square, Triangle
    raw(4), raw(5), raw(6), raw(7),      // L1, R1, L2, R2
    raw(8), raw(9), raw(10), raw(11),    // Create, Options, L3, R3
    on(7, 0, 1), on(3, 4, 5), on(5, 6, 7), on(1, 2, 3),   // D-pad up, down, left, right
    raw(12), raw(13),                    // PS, touchpad
  ];
  return { id: p.id, index: p.index, buttons, axes: [p.axes[0] || 0, p.axes[1] || 0, p.axes[2] || 0, p.axes[5] || 0], vibrationActuator: p.vibrationActuator };
}

const normal = p => (p.mapping !== 'standard' && SONY.test(p.id) ? fromSony(p) : p);
const touched = p => p.buttons.some(b => b.pressed) || [...p.axes].slice(0, 4).some(a => Math.abs(a) > 0.5);

let current = -1;

export function readPad() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(p => p && p.connected !== false).map(normal) : [];
  const cur = pads.find(p => p.index === current);
  if (cur && touched(cur)) return cur;      // a drifting stick elsewhere must not steal a pad in use
  const pick = pads.find(touched) || cur || pads.find(p => SONY.test(p.id)) || pads[0] || null;
  current = pick ? pick.index : -1;
  return pick;
}
