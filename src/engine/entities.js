// Places a level's entities: MDL models, TGA/PCX sprites and WMB map entities.
// Visibility and blending follow the entity flags plus what each action sets at startup.
import * as THREE from 'three';
import { parseMdl, animations } from '../formats/mdl.js';
import { parseTga } from '../formats/tga.js';
import { parseWmb6 } from '../formats/wmb6.js';
import { buildLevel, toScene } from './level.js';

// A6 entity flag bits as stored in this game's WMB6 files (libgamestudio's "old" layout;
// checked against Kk: cars and barrels carry SHADOW, lamps BRIGHT, YapayKutu boxes INVISIBLE).
const F = { invisible: 1, passable: 2, transparent: 4, overlay: 16, unlit: 512, bright: 8192 };
const IDLE = /^(frame|bekle|tbekle|stand|idle|dur|wait|fly|uc)$/;
const DEG = Math.PI / 180;

function texture(img, { flipY = false } = {}) {
  const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.flipY = flipY;
  t.needsUpdate = true;
  return t;
}

function flagsOf(ent, hints) {
  const h = hints.get(ent.action.toLowerCase()) || {};
  const f = {};
  for (const [k, bit] of Object.entries(F)) f[k] = h[k] ?? !!(ent.flags & bit);
  f.facing = h.facing; f.oriented = h.oriented;
  f.alpha = h.alpha ?? 50;
  return f;
}

// Brightness under an entity, read from the level's own lightmap so models match the baked light.
function sampleLight(levelRoot, origin, ray) {
  ray.set(origin.clone().add(new THREE.Vector3(0, 8, 0)), new THREE.Vector3(0, -1, 0));
  for (const hit of ray.intersectObject(levelRoot, true)) {
    const lm = hit.object.material.lightMap;
    if (!lm || !hit.uv1) continue;
    const { width, height, data } = lm.image;
    const x = Math.min(width - 1, Math.max(0, Math.floor(hit.uv1.x * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(hit.uv1.y * height)));
    const p = (y * width + x) * 4;
    return new THREE.Color(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255).multiplyScalar(2);
  }
  return new THREE.Color(0.5, 0.5, 0.5);
}

function material(map, flags, light, alphaTest) {
  const common = { map, transparent: flags.transparent || flags.bright, side: THREE.DoubleSide, alphaTest };
  if (flags.transparent || flags.bright) common.opacity = Math.min(1, flags.alpha / 100);
  if (flags.bright) Object.assign(common, { blending: THREE.AdditiveBlending, depthWrite: false });
  if (flags.unlit || flags.bright) return new THREE.MeshBasicMaterial(common);
  // Baked light as emissive (matches the room), Lambert diffuse so the flashlight still lights it.
  return new THREE.MeshLambertMaterial({ ...common, emissive: light, emissiveMap: map });
}

function placeTransform(obj, ent) {
  obj.position.copy(toScene(ent.origin));
  obj.rotation.set(ent.angle[2] * DEG, ent.angle[0] * DEG, ent.angle[1] * DEG, 'YZX');
  obj.scale.set(ent.scale[0] || 1, ent.scale[2] || 1, ent.scale[1] || 1);
}

export async function buildEntities(level, fs, hints, levelRoot, onProgress = () => {}) {
  const root = new THREE.Group();
  const colliders = [];
  const animated = [];
  const disposables = [];
  const cache = new Map();
  const ray = new THREE.Raycaster();
  const stats = { models: 0, sprites: 0, maps: 0, hidden: 0, missing: [] };

  async function load(file) {
    const key = file.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let res = null;
    try {
      file = fs.resolve(file);
      if (!file) throw new Error('yok');
      const bytes = await fs.read(file);
      if (/\.mdl$/i.test(file)) {
        const m = parseMdl(bytes);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(m.frames[0].pos.slice(), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
        geo.setIndex(m.index);
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        const skin = m.skins.find(s => s.data);
        const map = skin ? texture(skin) : null;
        disposables.push(geo, map);
        res = { kind: 'model', m, geo, map, alpha: skin?.alpha, anims: animations(m) };
      } else if (/\.tga$/i.test(file)) {
        const img = parseTga(bytes);
        const map = texture(img, { flipY: true });
        disposables.push(map);
        res = { kind: 'sprite', img, map };
      } else if (/\.wmb$/i.test(file)) {
        const sub = parseWmb6(bytes);
        res = { kind: 'map', sub };
      }
    } catch (e) {
      stats.missing.push(key);
    }
    cache.set(key, res);
    return res;
  }

  const ents = level.objects.filter(o => o.type === 'entity');
  for (const [i, ent] of ents.entries()) {
    if (i % 20 === 0) onProgress(i / ents.length);
    const flags = flagsOf(ent, hints);
    if (flags.invisible || /^oyuncu_/i.test(ent.action)) { stats.hidden++; continue; }
    const res = await load(ent.file);
    if (!res) continue;

    const origin = toScene(ent.origin);
    let obj;
    if (res.kind === 'model') {
      const light = flags.unlit ? null : sampleLight(levelRoot, origin, ray);
      const mat = material(res.map, flags, light, res.alpha ? 0.5 : 0);
      disposables.push(mat);
      const scene = [...res.anims].find(([k, v]) => IDLE.test(k) && v.length > 1);
      const geo = scene ? res.geo.clone() : res.geo;
      if (scene) { disposables.push(geo); animated.push({ geo, m: res.m, frames: scene[1], t: Math.random() * scene[1].length }); }
      obj = new THREE.Mesh(geo, mat);
      placeTransform(obj, ent);
      stats.models++;
      if (!flags.passable) colliders.push({ geo: res.geo, matrix: (obj.updateMatrix(), obj.matrix.clone()) });
    } else if (res.kind === 'sprite') {
      const w = res.img.width * (ent.scale[0] || 1), h = res.img.height * (ent.scale[2] || 1);
      const billboard = flags.facing || (!flags.oriented && !ent.angle[0] && !ent.angle[1] && !ent.angle[2]);
      const light = flags.unlit || flags.bright ? null : sampleLight(levelRoot, origin, ray);
      if (billboard) {
        const mat = new THREE.SpriteMaterial({
          map: res.map, color: light || 0xffffff, transparent: true, alphaTest: res.img.alpha ? 0.1 : 0,
          opacity: flags.transparent || flags.bright ? Math.min(1, flags.alpha / 100) : 1,
          blending: flags.bright ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: !flags.bright,
        });
        obj = new THREE.Sprite(mat);
        obj.position.copy(origin);
        obj.scale.set(w, h, 1);
        disposables.push(mat);
      } else {
        // An oriented sprite lies in the entity's local y/z plane, i.e. it faces along x.
        const mat = new THREE.MeshBasicMaterial({
          map: res.map, side: THREE.DoubleSide, transparent: flags.transparent || flags.bright || res.img.alpha,
          alphaTest: res.img.alpha ? 0.1 : 0, color: light || 0xffffff,
          opacity: flags.transparent || flags.bright ? Math.min(1, flags.alpha / 100) : 1,
          blending: flags.bright ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: !flags.bright,
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(res.img.width, res.img.height), mat);
        plane.rotation.y = -Math.PI / 2;
        obj = new THREE.Group();
        obj.add(plane);
        placeTransform(obj, ent);
        disposables.push(mat, plane.geometry);
      }
      stats.sprites++;
    } else if (res.kind === 'map') {
      const built = buildLevel(res.sub);
      obj = built.root;
      placeTransform(obj, ent);
      disposables.push(built);
      stats.maps++;
      if (!flags.passable) {
        obj.updateMatrix();
        for (const g of res.sub.groups) {
          if (g.passable) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
          geo.setIndex(g.idx);
          colliders.push({ geo, matrix: obj.matrix.clone() });
          disposables.push(geo);
        }
      }
    }
    if (!obj) continue;
    obj.name = ent.name || ent.file;
    obj.userData.entity = ent;
    root.add(obj);
  }

  root.traverse(o => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  root.updateMatrixWorld(true);

  return {
    root, colliders, stats,
    // Vertex animation: linear blend between the frames of the idle scene.
    update(dt) {
      for (const a of animated) {
        a.t = (a.t + dt * 10) % a.frames.length;
        const i = Math.floor(a.t), k = a.t - i;
        const p0 = a.m.frames[a.frames[i]].pos, p1 = a.m.frames[a.frames[(i + 1) % a.frames.length]].pos;
        const attr = a.geo.attributes.position, out = attr.array;
        for (let j = 0; j < out.length; j++) out[j] = p0[j] + (p1[j] - p0[j]) * k;
        attr.needsUpdate = true;
      }
    },
    dispose() { for (const d of disposables) d?.dispose?.(); },
  };
}
