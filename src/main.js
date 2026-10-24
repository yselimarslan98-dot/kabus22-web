import * as THREE from 'three';
import { GameFS } from './vfs.js';
import { idbGet, idbSet } from './idb.js';
import { parseWmb6 } from './formats/wmb6.js';
import { buildLevel, findSpawn } from './engine/level.js';
import { buildCollider, Player } from './engine/player.js';
import { Input, PAD } from './engine/input.js';
import { MenuNav } from './ui/menunav.js';

const $ = s => document.querySelector(s);
const state = { fs: null, levels: [], current: null, paused: false, settings: { lang: 'tr', char: 'oyuncu_demir', mode: 'walk' } };

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  nav.refresh();
}
function progress(title, msg, frac) {
  $('#load-title').textContent = title;
  $('#load-msg').textContent = msg || '';
  $('#load-bar').style.width = `${Math.round((frac || 0) * 100)}%`;
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

// ---------- renderer / game loop ----------
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050506);
scene.fog = new THREE.Fog(0x050506, 1500, 9000);
const camera = new THREE.PerspectiveCamera(70, 1, 2, 30000);
scene.add(camera);
const flashlight = new THREE.SpotLight(0xfff1d6, 0, 1400, 0.42, 0.45, 1);
flashlight.position.set(6, -6, 0);
flashlight.target.position.set(0, 0, -1);
camera.add(flashlight, flashlight.target);
const FLASH_ON = 900;

const input = new Input(canvas);
const nav = new MenuNav(input);
let player = null;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now(), fpsT = 0, fpsN = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  input.poll();
  nav.update();
  if (!state.current) return;

  if (input.padPressed(PAD.START) || input.keys.has('Escape') && !state._escHeld) setPaused(!state.paused);
  state._escHeld = input.keys.has('Escape');

  if (!state.paused) {
    if (input.padPressed(PAD.Y) || input.keys.has('KeyF') && !state._fHeld) {
      flashlight.intensity = flashlight.intensity ? 0 : FLASH_ON;
      input.rumble(0.15, 0.1, 60);
    }
    state._fHeld = input.keys.has('KeyF');
    player.update(dt, input);
  }
  renderer.render(scene, camera);

  fpsN++; fpsT += dt;
  if (fpsT > 0.5) { $('#hud-fps').textContent = `${Math.round(fpsN / fpsT)} fps`; fpsN = 0; fpsT = 0; }
}
requestAnimationFrame(frame);

// Pointer lock needs a user gesture; failures (e.g. auto-load in dev) are harmless.
function lockPointer() {
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {}
}

function setPaused(p) {
  state.paused = p;
  $('#pause').hidden = !p;
  if (p) document.exitPointerLock?.();
  nav.refresh();
}

// ---------- level loading ----------
async function playLevel(lv) {
  show('screen-loading');
  progress(lv.id, 'Bölüm dosyası okunuyor', 0.1);
  await nextFrame();
  const t0 = performance.now();
  const bytes = await state.fs.read(lv.file);
  progress(lv.id, 'Geometri ve ışık haritaları çözülüyor', 0.45);
  await nextFrame();
  const level = parseWmb6(bytes);
  progress(lv.id, 'Sahne kuruluyor', 0.7);
  await nextFrame();

  unloadLevel();
  const built = buildLevel(level);
  scene.add(built.root);
  const collider = buildCollider(level);
  player = new Player(camera, collider);
  player.mode = state.settings.mode;
  player.killY = built.bounds.min.y - 500;
  const spawn = findSpawn(level, state.settings.char) || { origin: built.bounds.getCenter(new THREE.Vector3()), yaw: 0 };
  player.respawn = () => player.spawn(spawn.origin, spawn.yaw);
  player.respawn();
  state.current = { lv, level, built, collider };

  $('#hud-level').textContent = `${lv.id} · ${(performance.now() - t0) / 1000 | 0 || '<1'} sn'de yüklendi`;
  $('#hud-hint').textContent = input.lastDevice === 'gamepad'
    ? 'Sol çubuk: hareket · Sağ çubuk: bakış · Y: fener · Start: menü'
    : 'Tıkla: fareyi kilitle · WASD: hareket · F: fener · Esc: menü';
  setTimeout(() => { $('#hud-hint').textContent = ''; }, 8000);
  show('screen-game');
  setPaused(false);
  lockPointer();
}

function unloadLevel() {
  if (!state.current) return;
  scene.remove(state.current.built.root);
  state.current.built.dispose();
  state.current.collider.dispose();
  state.current = null;
}

// ---------- folder selection ----------
async function useFS(fs, label) {
  if (!fs.isKabus22()) {
    show('screen-start');
    $('#start-msg').textContent = 'Bu klasörde Kabus 22 bulunamadı (Kaynak.k22 ve K22.wrs gerekli).';
    return;
  }
  state.fs = fs;
  show('screen-loading');
  await fs.mount(state.settings.lang, (msg, f) => progress('Oyun dosyaları', msg, f));
  state.levels = await fs.levelList();
  await setBackdrop(fs);
  renderMenu();
  show('screen-menu');
  if (label) $('#hud-level').textContent = label;
}

async function setBackdrop(fs) {
  const shots = [...fs.files.keys()].filter(k => k.startsWith('gallery/') && /\.jpe?g$/.test(k));
  if (!shots.length) return;
  const f = fs.files.get(shots[Math.floor(Math.random() * shots.length)]);
  $('#bg').style.backgroundImage = `url(${f.url || URL.createObjectURL(f)})`;
}

function renderMenu() {
  const ol = $('#level-list');
  ol.innerHTML = '';
  state.levels.forEach((lv, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.nav = '';
    b.innerHTML = `${String(i + 1).padStart(2, '0')} · ${lv.id}<small>${lv.file}</small>`;
    b.onclick = () => playLevel(lv).catch(fail);
    li.append(b);
    ol.append(li);
  });
  nav.refresh();
}

function fail(err) {
  console.error(err);
  show('screen-start');
  $('#start-msg').textContent = `Hata: ${err.message || err}`;
}

$('#btn-pick').onclick = async () => {
  if (window.showDirectoryPicker) {
    try {
      const handle = await showDirectoryPicker({ id: 'kabus22', mode: 'read' });
      await idbSet('dir', handle);
      await useFS(await GameFS.fromDirectoryHandle(handle), handle.name);
    } catch (e) {
      if (e.name !== 'AbortError') fail(e);
    }
  } else {
    $('#dir-input').click();
  }
};
$('#dir-input').onchange = e => useFS(GameFS.fromFileList(e.target.files)).catch(fail);

(async () => {
  const params = new URLSearchParams(location.search);
  if (params.has('dev')) {
    await useFS(await GameFS.fromDevServer(), 'dev');
    const want = params.get('level');
    const lv = want && state.levels.find(l => l.id.toLowerCase() === want.toLowerCase());
    if (lv) await playLevel(lv);
    return;
  }
  const saved = await idbGet('settings');
  if (saved) Object.assign(state.settings, saved);
  $('#sel-lang').value = state.settings.lang;
  $('#sel-char').value = state.settings.char;
  $('#sel-mode').value = state.settings.mode;

  const handle = await idbGet('dir');
  if (handle && handle.queryPermission) {
    const btn = $('#btn-resume');
    btn.hidden = false;
    btn.dataset.nav = '';
    btn.textContent = `Devam et (${handle.name})`;
    btn.onclick = async () => {
      try {
        if (await handle.requestPermission({ mode: 'read' }) !== 'granted') return;
        await useFS(await GameFS.fromDirectoryHandle(handle), handle.name);
      } catch (e) { fail(e); }
    };
    nav.refresh();
  }
})();

for (const [sel, key] of [['#sel-lang', 'lang'], ['#sel-char', 'char'], ['#sel-mode', 'mode']]) {
  $(sel).onchange = async e => {
    state.settings[key] = e.target.value;
    await idbSet('settings', state.settings);
    if (key === 'lang' && state.fs) {
      // Re-mount so localized text/voice archives take priority.
      const fs = state.fs;
      fs.entries.clear(); fs.archives = [];
      await useFS(fs);
    }
  };
}

$('#btn-continue').onclick = () => { setPaused(false); lockPointer(); };
$('#btn-mode').onclick = () => {
  player.mode = player.mode === 'walk' ? 'fly' : 'walk';
  player.velocity.set(0, 0, 0);
  $('#btn-mode').textContent = player.mode === 'walk' ? 'Serbest kameraya geç' : 'Yürümeye geç';
};
$('#btn-quit').onclick = () => { setPaused(false); unloadLevel(); show('screen-menu'); };

input.onPadChange = pad => {
  $('#pad-status').textContent = pad ? `Kumanda: ${pad.id.replace(/\(.*?\)/g, '').trim()}` : 'Kumanda bağlı değil. Bağlayıp bir tuşa bas.';
};

window.k22 = { state, scene, camera, renderer, get player() { return player; } };
