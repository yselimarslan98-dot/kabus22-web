// 3D side of the engine for the scripts: levels, entities, animation, movement and collision,
// tracing, scanning, particles, paths and views. Coordinates in the scripts are Acknex
// (x forward, y left, z up); three.js scene space is (x, z, -y).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { parseWmb6, SURFACE } from '../../formats/wmb6.js';
import { parseMdl, animations } from '../../formats/mdl.js';
import { parseHmp } from '../../formats/hmp.js';
import { decodeImage } from '../../formats/image.js';
import { buildLevel } from '../../engine/level.js';
import { Ref, Str, rotate, vec } from '../runtime.js';

const DEG = Math.PI / 180;
const val = v => (v instanceof Ref ? v.get(0) : typeof v === 'number' ? v : +v || 0);
const text = v => (v instanceof Str ? v.s : v == null || v === 0 ? '' : String(v));
const S = (x, y, z, out = new THREE.Vector3()) => out.set(x, z, -y);          // Acknex -> scene
const A = v => [v.x, -v.z, v.y];                                              // scene -> Acknex

export const MODE = {
  ignore_me: 1, ignore_you: 2, ignore_passable: 4, ignore_passents: 8, ignore_models: 16, ignore_sprites: 32, ignore_maps: 64,
  ignore_push: 128, glide: 256, use_box: 512, activate_trigger: 1024, scan_texture: 2048, use_aabb: 4096, activate_sonar: 8192,
  activate_shoot: 16384, ignore_content: 32768, use_polygon: 65536, ignore_world: 64,
};
export const EVENT = {
  event_block: 1, event_entity: 2, event_stuck: 3, event_push: 4, event_impact: 5, event_detect: 6, event_scan: 7,
  event_shoot: 8, event_trigger: 9, event_touch: 10, event_release: 11, event_click: 12, event_sonar: 13,
  event_frame: 14, event_disconnect: 15, event_rightclick: 16,
};
const ENTITY_FLAGS = { invisible: 1, passable: 2, transparent: 4, overlay: 16, flare: 128, unlit: 512, shadow: 1024, nofog: 4096, bright: 8192, metal: 16384 };

// Models much bigger than a character (rock walls and cave pieces placed as models) collide with their
// polygons; their bounding box would fill whole rooms the player walks inside.
// Static decoration (no action, or only the brightness helper action) does the same: railings, scaffolds,
// stair frames, often rotated, whose axis-aligned boxes close passages the player walks through.
const bigModel = o => o._res?.kind === 'model' && !o._res.m?.terrain && !!o._obj && !o._view &&
  (Math.max(-o.min_x, o.max_x, -o.min_y, o.max_y) > 256 || !o._actionName || /parlaklik_(ayari|degeri)$/i.test(o._actionName));

// ---------- script-visible objects ----------
let entId = 0;
export class Ent {
  constructor(file) {
    this.kind = 'entity';
    this.id = ++entId;
    this.type = new Str(file || '');
    this.x = 0; this.y = 0; this.z = 0; this.pan = 0; this.tilt = 0; this.roll = 0;
    this.scale_x = 1; this.scale_y = 1; this.scale_z = 1;
    this.alpha = 50; this.ambient = 0; this.albedo = 50; this.frame = 1; this.next_frame = 0; this.skin = 1;
    this.lightrange = 0; this.lightred = 0; this.lightgreen = 0; this.lightblue = 0; this.red = 0; this.green = 0; this.blue = 0;
    this.min_x = -16; this.min_y = -16; this.min_z = -16; this.max_x = 16; this.max_y = 16; this.max_z = 16;
    this.invisible = 0; this.passable = 0; this.transparent = 0; this.bright = 0; this.unlit = 0; this.flare = 0; this.overlay = 0;
    this.event = 0; this.string1 = new Str(); this.string2 = new Str();
    this.removed = false;
  }
  getProp(k) { return k.startsWith('skill') || k.startsWith('flag') || k.startsWith('enable_') ? 0 : 0; }
}

export class View {
  constructor(name) {
    this.kind = 'view'; this.name = name;
    this.x = 0; this.y = 0; this.z = 0; this.pan = 0; this.tilt = 0; this.roll = 0;
    this.arc = 60; this.aspect = 1; this.visible = 0; this.layer = 0; this.genius = 0; this.ambient = 0;
    this.pos_x = 0; this.pos_y = 0; this.size_x = 0; this.size_y = 0; this.fog_start = 0; this.fog_end = 0;
  }
}

// Particle for effect(): `my` inside its functions.
class Particle {
  constructor(x, y, z, vx, vy, vz) {
    this.kind = 'particle';
    this.x = x; this.y = y; this.z = z; this.vel_x = vx; this.vel_y = vy; this.vel_z = vz;
    this.size = 4; this.alpha = 50; this.lifespan = 100; this.bmap = 0; this.function = 0; this.move = 0;
    this.red = 255; this.green = 255; this.blue = 255; this.gravity = 0;
  }
  getProp() { return 0; }
}

export class World {
  constructor(R, fs, images, renderer, scene) {
    this.R = R; this.fs = fs; this.images = images; this.renderer = renderer; this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.ents = new Set();
    this.models = new Map();     // file -> Promise<resource>
    this.res = new Map();        // file -> resource (once loaded)
    this.level = null;
    this.loading = null;
    this.particles = [];
    this.emits = [];
    this.spriteMats = new Map();
    this.ray = new THREE.Raycaster();
    this.tmp = new THREE.Vector3();
    this.lights = Array.from({ length: 8 }, () => { const l = new THREE.PointLight(0xffffff, 0, 1, 1); l.visible = false; scene.add(l); return l; });
    this.camera3 = new THREE.PerspectiveCamera(60, 16 / 9, 2, 60000);
    scene.add(this.camera3);
    // View entities (ENTITY name { view = camera; ... }): drawn on top, placed relative to their view.
    this.viewScene = new THREE.Scene();
    this.viewScene.add(new THREE.AmbientLight(0xffffff, 1.5));
    this.viewEnts = new Set();
    this.terrains = [];          // HMP terrain colliders (world space)
    this.install();
  }

  // ---------- resources ----------
  resolve(file) {
    const f = text(file).replace(/\\/g, '/');
    return this.fs.resolve(f) || this.fs.resolve(f.split('/').pop());
  }

  load(file) {
    const key = text(file).toLowerCase();
    if (!key) return Promise.resolve(null);
    let p = this.models.get(key);
    if (!p) {
      p = this.loadResource(key).then(r => { this.res.set(key, r); return r; }, e => { this.R.warnOnce(`varlık yüklenemedi: ${key} (${e.message})`); this.res.set(key, null); return null; });
      this.models.set(key, p);
    }
    return p;
  }

  async loadResource(key) {
    const name = this.resolve(key);
    if (!name) throw new Error('bulunamadı');
    const bytes = await this.fs.read(name);
    if (/\.(mdl|hmp)$/i.test(name)) {
      const m = /\.hmp$/i.test(name) ? parseHmp(bytes) : parseMdl(bytes);
      const skins = m.skins.map(s => (s.data ? dataTexture(s) : null));
      const anims = animations(m);
      // first welded vertex for every original vertex (vertex queries use original numbering)
      const n = m.vmap ? m.vmap.length : m.frames[0].pos.length / 3;
      const vmap = m.vmap || weldMap(m);
      const first = new Map();
      for (let i = 0; i < n; i++) if (!first.has(vmap[i])) first.set(vmap[i], i);
      const box = new THREE.Box3();
      const p0 = m.frames[0].pos;
      for (let i = 0; i < p0.length; i += 3) box.expandByPoint(this.tmp.set(p0[i], p0[i + 1], p0[i + 2]));
      return { kind: 'model', m, skins, anims, first, box, alpha: m.skins.some(s => s.alpha) };
    }
    if (/\.wmb$/i.test(name)) {
      const sub = parseWmb6(bytes);
      return { kind: 'map', sub };
    }
    if (/\.(tga|pcx|bmp)$/i.test(name)) {
      const img = decodeImage(name, bytes);
      const tex = dataTexture(img);
      tex.flipY = true;
      // name+N.tga: an animated sprite, N frames side by side; e.frame picks one
      const frames = +(/\+(\d+)\.\w+$/.exec(name)?.[1] || 1);
      if (frames > 1) tex.repeat.x = 1 / frames;
      return { kind: 'sprite', img, tex, frames };
    }
    throw new Error('desteklenmeyen tür');
  }

  // ---------- entities ----------
  createEnt(file, pos, action, you = 0, fromLevel = null) {
    const e = new Ent(text(file));
    if (fromLevel) {
      [e.x, e.y, e.z] = fromLevel.origin;
      [e.pan, e.tilt, e.roll] = fromLevel.angle;
      [e.scale_x, e.scale_y, e.scale_z] = fromLevel.scale.map(s => s || 1);
      fromLevel.skills.forEach((s, i) => { if (s) e['skill' + (i + 1)] = s; });
      for (const [k, bit] of Object.entries(ENTITY_FLAGS)) if (fromLevel.flags & bit) e[k] = 1;
      e.ambient = fromLevel.ambient || 0;
      if (fromLevel.albedo !== undefined) e.albedo = fromLevel.albedo;
      if (fromLevel.string1) e.string1.s = fromLevel.string1;
      if (fromLevel.string2) e.string2.s = fromLevel.string2;
      e.name = fromLevel.name;
    } else if (pos) {
      [e.x, e.y, e.z] = vec.rd(pos);
    }
    this.ents.add(e);
    this.attach(e);
    if (typeof action === 'function') this.R.call(action, { me: e, you }, []);
    return e;
  }

  attach(e) {
    const key = text(e.type).toLowerCase();
    // The old model stays until the new one (ent_morph) has loaded.
    const done = r => {
      if (e.removed || text(e.type).toLowerCase() !== key) return;
      e._res = r;
      this.buildObject(e);
    };
    const cached = this.res.get(key);
    if (cached !== undefined) done(cached);
    else this.load(key).then(done);
  }

  buildObject(e) {
    if (e._obj) { e._obj.parent?.remove(e._obj); e._obj = null; }
    const r = e._res;
    if (!r) return;
    let obj;
    if (r.kind === 'model') {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(r.m.frames[0].pos.slice(), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(r.m.uv, 2));
      geo.setIndex(r.m.index);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.boundingSphere.radius *= 1.5;     // animation may grow the model
      const mat = new THREE.MeshLambertMaterial({ map: r.skins[0], side: THREE.DoubleSide, alphaTest: r.alpha ? 0.5 : 0, emissive: 0xffffff, emissiveMap: r.skins[0] });
      obj = new THREE.Mesh(geo, mat);
      e._frames = [-1, -1, -1];
      // default bounding box from the model, as the engine does for models
      if (!e._boxSet) {
        const b = r.box;
        const sx = e.scale_x || 1, sy = e.scale_y || 1, sz = e.scale_z || 1;
        e.min_x = b.min.x * sx; e.max_x = b.max.x * sx; e.min_y = -b.max.z * sy; e.max_y = -b.min.z * sy; e.min_z = b.min.y * sz; e.max_z = b.max.y * sz;
      }
    } else if (r.kind === 'sprite') {
      const mat = new THREE.MeshBasicMaterial({ map: r.frames > 1 ? Object.assign(r.tex.clone(), { needsUpdate: true }) : r.tex, side: THREE.DoubleSide, transparent: true, alphaTest: r.img.alpha ? 0.05 : 0, depthWrite: true });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(r.img.width / r.frames, r.img.height), mat);
      plane.rotation.y = -Math.PI / 2;
      obj = new THREE.Group();
      obj.add(plane);
      obj.userData.plane = plane;
      // box scaled like the plane (width along y by scale_y, height by scale_z): fences placed at 0.17 scale
      if (!e._boxSet) {
        const w = r.img.width / r.frames / 2 * (e.scale_y || 1), h = r.img.height / 2 * (e.scale_z || 1);
        e.min_x = -2; e.max_x = 2; e.min_y = -w; e.max_y = w; e.min_z = -h; e.max_z = h;
      }
    } else if (r.kind === 'map') {
      const built = buildLevel(r.sub);
      obj = built.root;
      obj.userData.dispose = built.dispose;
      const b = built.bounds;
      if (!e._boxSet) { e.min_x = b.min.x; e.max_x = b.max.x; e.min_y = -b.max.z; e.max_y = -b.min.z; e.min_z = b.min.y; e.max_z = b.max.y; }
    }
    if (r.kind === 'model' && r.m.terrain && !e._view) {
      S(e.x, e.y, e.z, obj.position);
      obj.rotation.set(e.roll * DEG, e.pan * DEG, e.tilt * DEG, 'YZX');
      obj.scale.set(e.scale_x || 1, e.scale_z || 1, e.scale_y || 1);
      obj.updateMatrixWorld(true);
      const geo = obj.geometry.clone().applyMatrix4(obj.matrixWorld);
      geo.boundsTree = new MeshBVH(geo);
      geo.userData = { ent: e };
      this.terrains.push(geo);
    }
    obj.userData.ent = e;
    obj.matrixAutoUpdate = true;
    e._obj = obj;
    e._lightAt = null;
    (e._view ? this.viewScene : this.root).add(obj);
  }

  remove(e) {
    if (!e || typeof e !== 'object' || e.removed) return;
    e.removed = true;
    this.ents.delete(e);
    if (e._obj) {
      this.root.remove(e._obj);
      if (e._res?.kind === 'model') { e._obj.geometry.dispose(); e._obj.material.dispose(); }
      e._obj = null;
    }
    if (e._shadow) { this.root.remove(e._shadow); e._shadow = null; }
  }

  // ---------- level ----------
  levelLoad(file) {
    const R = this.R;
    const name = this.resolve(file);
    R.host.onInfo?.(`level_load: ${text(file)}`);
    R.paused = true;               // the engine loads levels synchronously: nothing runs meanwhile
    this.loading = (async () => {
      for (const e of [...this.ents]) this.remove(e);
      for (const p of this.particles) p.sprite && this.root.remove(p.sprite);
      this.particles = []; this.emits = [];
      this.terrains = [];
      if (this.level) { this.root.remove(this.level.root); this.level.dispose(); this.level.collider?.dispose(); this.level = null; }
      if (!name) { R.warn('bölüm bulunamadı: ' + text(file)); return; }
      const lv = parseWmb6(await this.fs.read(name));
      const built = buildLevel(lv);
      this.root.add(built.root);
      built.root.updateMatrixWorld(true);
      const collider = solidGeometry(lv.groups);
      this.level = { name, lv, root: built.root, dispose: built.dispose, collider, bounds: built.bounds, paths: lv.objects.filter(o => o.type === 'path') };
      const info = lv.info;
      if (info) { R.G.sun_angle[0] = info.azimuth; R.G.sun_angle[1] = info.elevation; }
      // Preload the level's entity resources so actions see their models from the first frame.
      const objs = lv.objects.filter(o => o.type === 'entity');
      await Promise.all([...new Set(objs.map(o => o.file.toLowerCase()))].map(f => this.load(f)));
      const fn = R.F;
      for (const o of objs) {
        const action = o.action ? fn[o.action.toLowerCase()] : 0;
        this.createEnt(o.file, null, 0, 0, o)._action = action;
      }
      R.paused = false;
      for (const e of [...this.ents]) if (e._action) { const a = e._action; e._action = null; e._actionName = a.name; R.call(a, { me: e, you: 0 }, []); }
    })().catch(err => { R.paused = false; R.error(err, { name: 'level_load' }); }).finally(() => { this.loading = null; R.paused = false; });
    return 0;
  }

  // ---------- per frame ----------
  update(dt) {
    const R = this.R, G = R.G;
    for (const e of this.ents) this.syncEnt(e);
    if (!(+G.freeze_mode > 0)) this.updateParticles(dt);
    this.updateLights();
    void G;
  }

  syncEnt(e) {
    const o = e._obj;
    if (!o || !e._res) return;
    o.visible = !e.invisible;
    if (!o.visible) return;
    S(e.x, e.y, e.z, o.position);
    o.rotation.set(e.roll * DEG, e.pan * DEG, e.tilt * DEG, 'YZX');
    o.scale.set(e.scale_x || 1, e.scale_z || 1, e.scale_y || 1);
    const r = e._res;
    if (r.kind === 'model') this.syncModel(e, o, r);
    else if (r.kind === 'sprite') this.syncSprite(e, o, r);
  }

  // media_play into bmap_for_entity: the video becomes the model's skin.
  setVideoSkin(e, el) {
    e._videoSkin?.dispose();
    e._videoSkin = null;
    if (!el) return;
    const t = new THREE.VideoTexture(el);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    e._videoSkin = t;
  }

  syncModel(e, o, r) {
    // frame interpolation
    const n = r.m.frames.length;
    if (n > 1) {
      const f = Math.max(1, val(e.frame));
      const f0 = Math.min(n - 1, Math.floor(f) - 1);
      const f1 = e.next_frame ? Math.min(n - 1, Math.floor(val(e.next_frame)) - 1) : Math.min(n - 1, f0 + 1);
      const t = f - Math.floor(f);
      if (e._frames[0] !== f0 || e._frames[1] !== f1 || e._frames[2] !== t) {
        e._frames = [f0, f1, t];
        const a = r.m.frames[f0].pos, b = r.m.frames[f1].pos, out = o.geometry.attributes.position.array;
        if (t === 0 || f0 === f1) out.set(a);
        else for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
        o.geometry.attributes.position.needsUpdate = true;
        o.geometry.computeVertexNormals();
      }
    }
    const skin = e._videoSkin || r.skins[Math.max(0, Math.min(r.skins.length - 1, (val(e.skin) | 0) - 1))] || r.skins[0];
    const m = o.material;
    if (m.map !== skin) { m.map = skin; m.emissiveMap = skin; m.needsUpdate = true; }
    const blend = e.transparent || e.bright;
    m.transparent = !!blend;
    m.opacity = blend ? Math.max(0, Math.min(1, val(e.alpha) / 100)) : 1;
    m.blending = e.bright ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.depthWrite = !e.bright;
    // brightness: baked light at the entity's spot (re-sampled when it moves) + its ambient
    if (!e._lightAt || Math.abs(e._lightAt[0] - e.x) + Math.abs(e._lightAt[1] - e.y) + Math.abs(e._lightAt[2] - e.z) > 32) {
      e._lightAt = [e.x, e.y, e.z];
      e._light = this.sampleLight(e.x, e.y, e.z + (e.max_z > 0 ? 8 : 0));
    }
    this.syncShadow(e);
    const amb = val(e.ambient) / 100;
    if (e.unlit || e.bright) m.emissive.setRGB(1, 1, 1);
    else m.emissive.copy(e._light).addScalar(amb * 0.5);
    if (e.light) m.emissive.multiply(new THREE.Color(val(e.red) / 255 || 1, val(e.green) / 255 || 1, val(e.blue) / 255 || 1));
  }

  syncSprite(e, o, r) {
    const plane = o.userData.plane;
    const m = plane.material;
    const facing = e.facing || (!e.oriented && !e.pan && !e.tilt && !e.roll);
    if (facing) o.quaternion.copy(this.camera3.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
    const blend = e.transparent || e.bright || e.flare;
    m.opacity = blend ? Math.max(0, Math.min(1, val(e.alpha) / 100)) : 1;
    m.blending = e.bright || e.flare ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.depthWrite = !(e.bright || e.flare);
    if (r.frames > 1) m.map.offset.x = (((Math.floor(val(e.frame)) % r.frames) + r.frames) % r.frames) / r.frames;
  }

  // Soft blob shadow on the floor under models with the SHADOW flag.
  syncShadow(e) {
    if (!e.shadow || e.invisible || !this.level) { if (e._shadow) e._shadow.visible = false; return; }
    if (!e._shadow) {
      if (!this.shadowMat) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(0,0,0,0.6)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
        this.shadowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
        this.shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      }
      e._shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
      e._shadow.renderOrder = 1;
      this.root.add(e._shadow);
    }
    const s = e._shadow;
    if (!e._shadowAt || Math.abs(e._shadowAt[0] - e.x) + Math.abs(e._shadowAt[1] - e.y) + Math.abs(e._shadowAt[2] - e.z) > 2) {
      e._shadowAt = [e.x, e.y, e.z];
      const ray = new THREE.Ray(S(e.x, e.y, e.z + 4), new THREE.Vector3(0, -1, 0));
      const hit = this.level.collider.boundsTree.raycastFirst(ray, THREE.DoubleSide);
      const drop = hit ? hit.distance : Infinity;
      s.visible = drop < 400;
      if (s.visible) { s.position.copy(hit.point); s.position.y += 0.5; }
      const size = Math.max(16, (e.max_x - e.min_x + e.max_y - e.min_y) * 0.6);
      s.scale.set(size, 1, size);
    }
  }

  sampleLight(x, y, z) {
    const lv = this.level;
    if (!lv) return new THREE.Color(0.5, 0.5, 0.5);
    this.ray.set(S(x, y, z + 4), new THREE.Vector3(0, -1, 0));
    this.ray.far = 2000;
    for (const hit of this.ray.intersectObject(lv.root, true)) {
      const lm = hit.object.material.lightMap;
      if (!lm || !hit.uv1) continue;
      const { width, height, data } = lm.image;
      const px = Math.min(width - 1, Math.max(0, Math.floor(hit.uv1.x * width)));
      const py = Math.min(height - 1, Math.max(0, Math.floor(hit.uv1.y * height)));
      const p = (py * width + px) * 4;
      return new THREE.Color(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255).multiplyScalar(2);
    }
    return new THREE.Color(0.35, 0.35, 0.35);
  }

  // Dynamic lights: the closest light-emitting entities get one of the pooled point lights.
  updateLights() {
    const cam = this.camera3.position;
    const list = [];
    for (const e of this.ents) {
      if (val(e.lightrange) > 0) {
        const p = S(e.x, e.y, e.z);
        list.push([p.distanceToSquared(cam), e, p]);
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    this.lights.forEach((l, i) => {
      const it = list[i];
      if (!it) { l.visible = false; return; }
      const [, e, p] = it;
      l.visible = true;
      l.position.copy(p);
      l.distance = val(e.lightrange) * 1.2;
      l.decay = 1;
      const r = val(e.lightred) || val(e.red), g = val(e.lightgreen) || val(e.green), b = val(e.lightblue) || val(e.blue);
      l.color.setRGB(r / 255 || 0.5, g / 255 || 0.5, b / 255 || 0.5);
      l.intensity = 4;
    });
  }

  // ---------- particles ----------
  spriteMaterial(bmap, add) {
    const file = bmap && typeof bmap === 'object' ? bmap.file : '';
    const key = file + (add ? '+' : '');
    let m = this.spriteMats.get(key);
    if (!m) {
      m = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending });
      this.spriteMats.set(key, m);
      if (file) this.load(file).then(r => { if (r?.kind === 'sprite') { const t = r.tex.clone(); t.flipY = false; t.needsUpdate = true; m.map = t; m.needsUpdate = true; } });
    }
    return m;
  }

  effect(fn, n, pos, vel) {
    const [x, y, z] = vec.rd(pos), [vx, vy, vz] = vec.rd(vel);
    n = Math.min(500, Math.max(0, Math.round(val(n))));
    for (let i = 0; i < n; i++) {
      const p = new Particle(x, y, z, vx, vy, vz);
      this.particles.push(p);
      if (typeof fn === 'function') this.R.call(fn, { me: p, you: 0 }, []);
    }
    return 0;
  }

  emit(n, pos, fn) {
    const [x, y, z] = vec.rd(pos);
    n = Math.min(200, Math.max(0, Math.round(val(n))));
    for (let i = 0; i < n; i++) this.emits.push({ pos: [x, y, z], speed: [0, 0, 0], size: 4, age: 0, alpha: 50, map: 0, flare: 0, action: fn, color: [255, 255, 255] });
    return 0;
  }

  updateParticles(dt) {
    const R = this.R, G = R.G, t = G.time_step || 1;
    // effect(): `my` is the particle
    const live = [];
    for (const p of this.particles) {
      if (typeof p.function === 'function') R.call(p.function, { me: p, you: 0 }, []);
      if (p.move) { p.x += p.vel_x * t; p.y += p.vel_y * t; p.z += (p.vel_z - (p.gravity || 0) * 0) * t; }
      p.lifespan -= t;
      if (p.lifespan <= 0) { if (p.sprite) this.root.remove(p.sprite); continue; }
      this.drawParticle(p, p.x, p.y, p.z, p.size, p.bmap, p.alpha, p.bright || p.flare);
      live.push(p);
    }
    this.particles = live;
    // emit(): the function sees my_pos, my_speed, my_age, ... globals
    const keep = [];
    for (const q of this.emits) {
      G.my_pos = q.pos; G.my_speed = q.speed; G.my_size = q.size; G.my_age = q.age; G.my_alpha = q.alpha; G.my_map = q.map;
      G.my_flare = q.flare; G.my_action = q.action; G.my_color = q.color;
      if (typeof q.action === 'function') R.call(q.action, { me: 0, you: 0 }, []);
      q.size = val(G.my_size); q.alpha = val(G.my_alpha); q.map = G.my_map; q.flare = val(G.my_flare); q.action = G.my_action;
      q.pos[0] += q.speed[0] * t; q.pos[1] += q.speed[1] * t; q.pos[2] += q.speed[2] * t;
      q.age += t;
      if (!q.action || q.alpha <= 0 || q.age > 2000) { if (q.sprite) this.root.remove(q.sprite); continue; }
      this.drawParticle(q, q.pos[0], q.pos[1], q.pos[2], q.size, q.map, q.alpha, q.flare);
      keep.push(q);
    }
    this.emits = keep;
    void dt;
  }

  drawParticle(p, x, y, z, size, bmap, alpha, add) {
    if (!p.sprite) {
      p.sprite = new THREE.Sprite(this.spriteMaterial(bmap, add));
      this.root.add(p.sprite);
    }
    const s = p.sprite;
    if (s.material !== this.spriteMaterial(bmap, add)) s.material = this.spriteMaterial(bmap, add);
    S(x, y, z, s.position);
    const sz = Math.max(0.5, val(size));
    s.scale.set(sz, sz, 1);
    s.material.opacity = Math.max(0, Math.min(1, val(alpha) / 100));
  }

  // ---------- collision ----------
  // Ray against the level and entities. Returns { dist, point (Acknex), normal, ent } or null.
  traceRay(from, to, mode, me, you) {
    const a = S(...from), b = S(...to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-6) return null;
    dir.divideScalar(len);
    let best = null;
    if (this.level && !(mode & MODE.ignore_maps)) {
      const ray = new THREE.Ray(a, dir);
      const hit = this.level.collider.boundsTree.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance <= len) best = { dist: hit.distance, point: hit.point, normal: hit.face.normal.clone(), ent: 0 };
    }
    const ray = new THREE.Ray(a, dir);
    const box = new THREE.Box3(), hitP = new THREE.Vector3();
    for (const e of this.ents) {
      if (e === me && (mode & MODE.ignore_me)) continue;
      if (e === you && (mode & MODE.ignore_you)) continue;
      if (e.passable && (mode & MODE.ignore_passable || mode & MODE.ignore_passents)) continue;
      if (e.invisible && !e._res) continue;
      const kind = e._res?.kind;
      if (kind === 'model' && (mode & MODE.ignore_models)) continue;
      if (kind === 'sprite' && (mode & MODE.ignore_sprites)) continue;
      if (!kind) continue;
      if (e.passable && !(mode & MODE.scan_texture)) continue;
      entBox(e, box);
      // A trace starting inside a model's box is still checked against its mesh below.
      const inside = !!e._obj && (kind === 'model' || kind === 'map') && box.containsPoint(a);
      if (!inside && !ray.intersectBox(box, hitP)) continue;
      if (inside) hitP.copy(a);
      const d = hitP.distanceTo(a);
      if (d > len || (best && d >= best.dist)) continue;
      // polygonal check for models / maps when close: refine with the mesh
      if (e._obj && (kind === 'model' || kind === 'map')) {
        this.ray.set(a, dir); this.ray.far = len;
        e._obj.updateMatrixWorld(true);
        // Both sides count: a trace that starts inside the model (a sword in a body) leaves through a back face.
        const sides = [];
        e._obj.traverse(o => { if (o.material && !Array.isArray(o.material)) { sides.push([o.material, o.material.side]); o.material.side = THREE.DoubleSide; } });
        const hits = this.ray.intersectObject(e._obj, true);
        for (const [m, s] of sides) m.side = s;
        if (!hits.length) continue;
        if (best && hits[0].distance >= best.dist) continue;
        best = { dist: hits[0].distance, point: hits[0].point, normal: hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : dir.clone().negate(), ent: e };
      } else best = { dist: d, point: hitP.clone(), normal: dir.clone().negate(), ent: e };
    }
    if (!best) return null;
    return { dist: best.dist, point: A(best.point), normal: A(best.normal), ent: best.ent };
  }

  // Moves `e` by `d` (Acknex) with capsule-vs-world collision. Returns distance actually moved.
  moveEnt(e, d, mode, ctx) {
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) return 0;
    // Collision radius from the bounding box; the narrow / fat hull flags of A6 clamp it.
    let r = Math.max(4, Math.min(64, Math.max(-e.min_x, e.max_x, -e.min_y, e.max_y) * 0.8));
    if (e.narrow) r = Math.min(r, 14);
    else if (e.fat) r = Math.max(r, 24);
    const zlo = e.min_z, zhi = e.max_z;
    const steps = Math.max(1, Math.ceil(len / (r * 0.5)));
    const sx = d[0] / steps, sy = d[1] / steps, sz = d[2] / steps;
    const start = [e.x, e.y, e.z];
    const polys = mode & MODE.ignore_models ? [] : [...this.ents]
      .filter(o => o !== e && !o.passable && !o.invisible && !(o === ctx.you && (mode & MODE.ignore_you)) && bigModel(o))
      .map(o => this.polyCollider(o));
    const seg = new THREE.Line3(), box = new THREE.Box3(), tri = new THREE.Vector3(), cap = new THREE.Vector3();
    let blocked = null;
    for (let s = 0; s < steps; s++) {
      const px = e.x + sx, py = e.y + sy, pz = e.z + sz;
      let pos = S(px, py, pz);
      if (this.level && !(e.passable && (mode & MODE.ignore_passable))) {
        // capsule from feet+r to head-r
        const lo = Math.min(zlo + r, (zlo + zhi) / 2), hi = Math.max(zhi - r, lo);
        seg.start.copy(pos).y += lo; seg.end.copy(pos).y += hi;
        box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end);
        box.min.addScalar(-r); box.max.addScalar(r);
        let pushed = false;
        for (const col of [this.level.collider, ...this.terrains, ...polys]) if (!col.boundingBox || col.boundingBox.intersectsBox(box)) col.boundsTree.shapecast({
          intersectsBounds: b => b.intersectsBox(box),
          intersectsTriangle: t => {
            const dist = t.closestPointToSegment(seg, tri, cap);
            if (dist < r) {
              const n = cap.sub(tri);
              if (n.lengthSq() < 1e-8) return;
              n.normalize();
              seg.start.addScaledVector(n, r - dist);
              seg.end.addScaledVector(n, r - dist);
              pushed = true;
              blocked ??= { normal: n.clone(), ent: 0 };
            }
          },
        });
        if (pushed) {
          pos.copy(seg.start).y -= lo;
          if (!(mode & MODE.glide)) { const a = A(pos); e.x = a[0]; e.y = a[1]; e.z = a[2]; break; }
        }
      }
      let [nx, ny, nz] = A(pos);
      // entity boxes
      if (!(mode & MODE.ignore_models && mode & MODE.ignore_sprites)) {
        for (const o of this.ents) {
          if (o === e || o.passable || o.invisible || !o._res || o._res.m?.terrain || bigModel(o)) continue;
          if (o === ctx.you && (mode & MODE.ignore_you)) continue;
          if (o._res.kind === 'model' && (mode & MODE.ignore_models)) continue;
          if (o._res.kind === 'sprite' && (mode & MODE.ignore_sprites)) continue;
          const ox = Math.max(o.x + o.min_x, Math.min(nx, o.x + o.max_x)) - nx;
          const oy = Math.max(o.y + o.min_y, Math.min(ny, o.y + o.max_y)) - ny;
          const inZ = nz + zhi > o.z + o.min_z && nz + zlo < o.z + o.max_z;
          if (!inZ) continue;
          const dist = Math.hypot(ox, oy);
          // Already overlapping before this step (spawned in a door, an entity moved onto us): only moving
          // deeper is blocked, so the mover can always walk out.
          const sx0 = Math.max(o.x + o.min_x, Math.min(e.x, o.x + o.max_x)) - e.x;
          const sy0 = Math.max(o.y + o.min_y, Math.min(e.y, o.y + o.max_y)) - e.y;
          const d0 = Math.hypot(sx0, sy0);
          const cx = o.x + (o.min_x + o.max_x) / 2, cy = o.y + (o.min_y + o.max_y) / 2;
          const deeper = d0 < 1e-6 ? Math.hypot(cx - nx, cy - ny) < Math.hypot(cx - e.x, cy - e.y) : dist < d0;
          if (d0 < r && !deeper) continue;
          if (dist < r) {
            if (dist < 1e-6) { nx = e.x; ny = e.y; }
            else { nx -= ox / dist * (r - dist); ny -= oy / dist * (r - dist); }
            blocked = { normal: [-ox, -oy, 0], ent: o };
            if (!(mode & MODE.glide)) break;
          }
        }
      }
      e.x = nx; e.y = ny; e.z = nz;
      if (blocked && !(mode & MODE.glide)) break;
    }
    // events
    const G = this.R.G;
    if (blocked) {
      if (blocked.ent) {
        ctx.you = blocked.ent;
        if (e.enable_entity && typeof e.event === 'function') { G.event_type = EVENT.event_entity; this.R.call(e.event, { me: e, you: blocked.ent }, []); }
        const o = blocked.ent;
        if (o.enable_impact && typeof o.event === 'function') { G.event_type = EVENT.event_impact; this.R.call(o.event, { me: o, you: e }, []); }
        if (o.enable_push && typeof o.event === 'function') { G.event_type = EVENT.event_push; this.R.call(o.event, { me: o, you: e }, []); }
      } else if (e.enable_block && typeof e.event === 'function') { G.event_type = EVENT.event_block; this.R.call(e.event, { me: e, you: 0 }, []); }
      if (Array.isArray(blocked.normal)) vec.wr(G.normal, ...blocked.normal);
      else vec.wr(G.normal, ...A(blocked.normal));
    }
    if (mode & MODE.activate_trigger) this.triggers(e);
    return Math.hypot(e.x - start[0], e.y - start[1], e.z - start[2]);
  }

  // World-space BVH of a big model's mesh, rebuilt when the entity moves.
  polyCollider(o) {
    const key = [o.x, o.y, o.z, o.pan, o.tilt, o.roll, o.scale_x, o.scale_y, o.scale_z].join();
    if (o._poly?.key === key) return o._poly.geo;
    o._poly?.geo.dispose();
    const m = new THREE.Object3D();
    S(o.x, o.y, o.z, m.position);
    m.rotation.set(o.roll * DEG, o.pan * DEG, o.tilt * DEG, 'YZX');
    m.scale.set(o.scale_x || 1, o.scale_z || 1, o.scale_y || 1);
    m.updateMatrixWorld(true);
    const geo = o._obj.geometry.clone().applyMatrix4(m.matrixWorld);
    geo.boundsTree = new MeshBVH(geo);
    geo.computeBoundingBox();
    o._poly = { key, geo };
    return geo;
  }

  triggers(e) {
    const G = this.R.G;
    for (const o of this.ents) {
      if (o === e || !o.enable_trigger || typeof o.event !== 'function') continue;
      const range = val(o.trigger_range) || 0;
      const inside = Math.hypot(o.x - e.x, o.y - e.y, o.z - e.z) < range;
      o._triggered ??= new Set();
      if (inside && !o._triggered.has(e)) { o._triggered.add(e); G.event_type = EVENT.event_trigger; this.R.call(o.event, { me: o, you: e }, []); }
      else if (!inside) o._triggered.delete(e);
    }
  }

  // scan_entity(pos, angle(pan, tilt, range)): EVENT_SCAN to every entity in the cone.
  scan(me, pos, ang) {
    const [px, py, pz] = vec.rd(pos);
    const [pan, tilt, range] = vec.rd(ang);
    const G = this.R.G;
    let count = 0;
    // Without an entity (a starter, e.g. using an inventory item from player.x) the scan looks the way the
    // entity standing at the scan origin faces; the rooms' fixed cameras often look elsewhere.
    const at = me ? null : [...this.ents].find(o => o.x === px && o.y === py && o.z === pz);
    const dir = me ? val(me.pan) : at ? val(at.pan) : val(G.camera?.pan);
    for (const o of [...this.ents]) {
      if (o === me || !o.enable_scan || typeof o.event !== 'function') continue;
      const dx = o.x - px, dy = o.y - py, dz = o.z - pz, dist = Math.hypot(dx, dy, dz);
      if (dist > range) continue;
      if (pan < 360) {
        const da = Math.abs(((Math.atan2(dy, dx) / DEG - dir) % 360 + 540) % 360 - 180);
        if (da > pan / 2) continue;
      }
      void tilt;
      G.event_type = EVENT.event_scan;
      G.result = dist;
      this.R.call(o.event, { me: o, you: me }, []);
      count++;
    }
    return count;
  }

  // ---------- views ----------
  render(views, size) {
    const r = this.renderer;
    r.autoClear = false;
    r.setScissorTest(false);
    r.clear();
    const list = views.filter(v => v.visible).sort((a, b) => val(a.layer) - val(b.layer));
    for (const v of list) {
      const w = val(v.size_x) || size[0], h = val(v.size_y) || size[1];
      const x = val(v.pos_x), y = val(v.pos_y);
      const cam = this.camera3;
      S(v.x, v.y, v.z, cam.position);
      cam.rotation.set(v.tilt * DEG, (v.pan - 90) * DEG, -v.roll * DEG, 'YXZ');
      const aspect = w / h;
      const arc = Math.max(5, Math.min(170, val(v.arc) || 60));
      cam.fov = 2 * Math.atan(Math.tan(arc * DEG / 2) / aspect * (val(v.aspect) || 1)) / DEG;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const px = r.getPixelRatio();
      const sx = r.domElement.width / px / size[0], sy = r.domElement.height / px / size[1];
      r.setViewport(x * sx, (size[1] - y - h) * sy, w * sx, h * sy);
      r.setScissor(x * sx, (size[1] - y - h) * sy, w * sx, h * sy);
      r.setScissorTest(true);
      r.clearDepth();
      // view.genius: that entity is not drawn in this view (first-person cameras)
      const hide = v.genius && v.genius._obj && v.genius._obj.visible ? v.genius._obj : null;
      if (hide) hide.visible = false;
      r.render(this.scene, cam);
      if (hide) hide.visible = true;
      if (this.placeViewEnts(v, cam)) { r.clearDepth(); r.render(this.viewScene, cam); }
    }
    r.setScissorTest(false);
  }

  createViewEnt(name) {
    const e = new Ent('');
    e.name = name;
    e._view = true;
    e.visible = 0;
    e.layer = 0;
    e.unlit = 1;
    this.viewEnts.add(e);
    return e;
  }

  // Positions the view entities of view v in front of its camera; returns whether any is visible.
  placeViewEnts(v, cam) {
    let any = false;
    for (const e of this.viewEnts) {
      const o = e._obj;
      if (!o) continue;
      const show = e.view === v && !!val(e.visible) && !e.invisible;
      o.visible = show;
      if (!show) continue;
      any = true;
      // view space: x forward, y left, z up -> camera space: (-y, z, -x)
      o.position.set(-val(e.y), val(e.z), -val(e.x)).applyMatrix4(cam.matrixWorld);
      o.quaternion.copy(cam.quaternion)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2))
        .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(e.roll * DEG, e.pan * DEG, e.tilt * DEG, 'YZX')));
      o.scale.set(e.scale_x || 1, e.scale_z || 1, e.scale_y || 1);
      if (e._res?.kind === 'model') { e._light = new THREE.Color(1, 1, 1); e._lightAt = [e.x, e.y, e.z]; this.syncModel(e, o, e._res); }
    }
    return any;
  }

  // ---------- builtins ----------
  install() {
    const R = this.R, G = R.G, B = R.B, W = this;
    Object.assign(G, MODE, EVENT, { anm_cycle: 1, anm_add: 2, move_mode: 0, trace_mode: 0, event_type: 0 });
    G.sun_angle = [0, 60, 0]; G.sun_color = [255, 255, 255]; G.fog_color = 0; G.camera_dist = 0;
    G.my_pos = [0, 0, 0]; G.my_speed = [0, 0, 0]; G.my_color = [255, 255, 255];
    for (const k of ['my_size', 'my_age', 'my_alpha', 'my_map', 'my_flare', 'my_action']) G[k] = 0;

    B.level_load = (c, f) => W.levelLoad(f);
    B.ent_create = (c, f, pos, action) => W.createEnt(f, pos, action, c.me);
    B.create = B.ent_create;
    B.ent_createlocal = B.ent_create;
    B.ent_remove = (c, e) => { W.remove(e); return 0; };
    B.remove = (c, e) => { W.remove(e ?? c.me); return 0; };
    B.ent_purge = () => 0;
    B.ent_morph = (c, e, f) => { if (e && typeof e === 'object') { e.type = new Str(text(f)); W.attach(e); } return 0; };

    // animation
    const scene = (e, name) => {
      const r = e?._res;
      if (!r || r.kind !== 'model') return null;
      return r.anims.get(text(name).toLowerCase()) || null;
    };
    const setFrame = (e, name, pct, cycle) => {
      const fr = scene(e, name);
      if (!fr) return 0;
      const n = fr.length;
      let p = val(pct);
      if (cycle) p = ((p % 100) + 100) % 100;
      else p = Math.max(0, Math.min(100, p));
      const pos = cycle ? p / 100 * n : p / 100 * (n - 1);
      const i = Math.min(n - 1, Math.floor(pos)), t = pos - Math.floor(pos);
      e.frame = fr[i] + 1 + t;
      e.next_frame = (cycle ? fr[(i + 1) % n] : fr[Math.min(n - 1, i + 1)]) + 1;
      return 0;
    };
    B.ent_frame = (c, name, pct) => setFrame(c.me, name, pct, false);
    B.ent_cycle = (c, name, pct) => setFrame(c.me, name, pct, true);
    B.ent_animate = (c, e, name, pct, mode) => setFrame(e, name, pct, val(mode) & 1);
    B.ent_frames = (c, e) => e?._res?.m?.frames.length ?? 0;

    // vertices (original numbering, 1-based like the engine)
    const vertexPos = (e, n) => {
      const r = e?._res;
      if (!r || r.kind !== 'model') return e ? [e.x, e.y, e.z] : [0, 0, 0];
      const i = r.first.get(Math.max(0, (val(n) | 0) - 1)) ?? 0;
      const arr = e._obj ? e._obj.geometry.attributes.position.array : r.m.frames[0].pos;
      // model space (scene axes) -> Acknex local -> world
      const lx = arr[i * 3] * e.scale_x, ly = -arr[i * 3 + 2] * e.scale_y, lz = arr[i * 3 + 1] * e.scale_z;
      const [wx, wy, wz] = rotate([lx, ly, lz], e.pan, e.tilt, e.roll);
      return [e.x + wx, e.y + wy, e.z + wz];
    };
    B.ent_vertex = (c, v, n) => vec.wr(v, ...vertexPos(c.me, n));
    B.vec_for_vertex = (c, v, e, n) => vec.wr(v, ...vertexPos(e, n));
    B.ent_vertices = (c, e) => e?._res?.m ? (e._res.m.vmap ? Math.max(...e._res.first.keys()) + 1 : 0) : 0;
    B.vec_for_mesh = (c, v, e, n) => {
      const r = e?._res;
      if (!r || r.kind !== 'model' || !e._obj) return vec.wr(v, 0, 0, 0);
      const i = r.first.get(Math.max(0, (val(n) | 0) - 1)) ?? 0, a = e._obj.geometry.attributes.position.array;
      return vec.wr(v, a[i * 3], -a[i * 3 + 2], a[i * 3 + 1]);
    };
    B.vec_to_mesh = (c, v, e, n) => {
      const r = e?._res;
      if (!r || r.kind !== 'model' || !e._obj) return 0;
      const [x, y, z] = vec.rd(v), key = Math.max(0, (val(n) | 0) - 1);
      const a = e._obj.geometry.attributes.position.array;
      const vm = r.m.vmap || [];
      for (let i = 0; i < vm.length; i++) if (vm[i] === key) { a[i * 3] = x; a[i * 3 + 1] = z; a[i * 3 + 2] = -y; }
      e._obj.geometry.attributes.position.needsUpdate = true;
      e._frames = [-2, -2, -2];
      return 0;
    };

    // movement and collision
    B.ent_move = (c, rel, abs) => {
      const e = c.me;
      if (!e || typeof e !== 'object') return 0;
      const [rx, ry, rz] = vec.rd(rel), [ax, ay, az] = vec.rd(abs);
      const [wx, wy, wz] = rotate([rx, ry, rz], e.pan, 0, 0);
      return W.moveEnt(e, [wx + ax, wy + ay, wz + az], val(G.move_mode), c);
    };
    B.c_move = (c, e, rel, abs, mode) => {
      if (!e || typeof e !== 'object') return 0;
      const [rx, ry, rz] = vec.rd(rel), [ax, ay, az] = vec.rd(abs);
      const [wx, wy, wz] = rotate([rx, ry, rz], e.pan, e.tilt, e.roll);
      return W.moveEnt(e, [wx + ax, wy + ay, wz + az], val(mode), c);
    };
    B.move = (c, e, rel, abs) => B.c_move(c, e, rel, abs, G.move_mode);
    const trace = (c, from, to, mode) => {
      const f = vec.rd(from), t = vec.rd(to);
      // A box swept down finds a floor its centre is already below (spawned sunk into the floor, a
      // negative gap the gravity scripts lift out of): start from the top of the box.
      // The box's footprint is swept too: rays from the centre and the four corners, nearest hit wins, so
      // an entity walking off a step stays on it until the whole box has left the edge.
      let lift = 0, h;
      if ((mode & MODE.use_box) && c.me && t[2] < f[2] && Math.hypot(t[0] - f[0], t[1] - f[1]) < 1e-3) {
        const e = c.me;
        lift = Math.max(0, val(e.max_z));
        f[2] += lift;
        const fx = 0.9 * Math.min(-e.min_x, e.max_x), fy = 0.9 * Math.min(-e.min_y, e.max_y);
        for (const [ox, oy] of [[0, 0], [fx, fy], [fx, -fy], [-fx, fy], [-fx, -fy]]) {
          const r = W.traceRay([f[0] + ox, f[1] + oy, f[2]], [t[0] + ox, t[1] + oy, t[2]], mode, c.me, c.you);
          if (r && (!h || r.dist < h.dist - 0.01)) h = r;
        }
      } else h = W.traceRay(f, t, mode, c.me, c.you);
      if (!h) { c.you = 0; G.result = 0; return 0; }
      let dist = h.dist - lift;
      // use_box sweeps the bounding box of me: the distance is measured from the box surface,
      // so a downward trace gives the gap under the feet (negative when sunk into the floor).
      if ((mode & MODE.use_box) && c.me) {
        const e = c.me, d = [t[0] - f[0], t[1] - f[1], t[2] - f[2]], L = Math.hypot(...d) || 1;
        const [dx, dy, dz] = d.map(v => v / L);
        dist -= (dx > 0 ? dx * e.max_x : dx * e.min_x) + (dy > 0 ? dy * e.max_y : dy * e.min_y) + (dz > 0 ? dz * e.max_z : dz * e.min_z);
      }
      vec.wr(G.target, ...h.point);
      // vars are fixed point in A6, so a flat floor gives normal.z == 1 exactly; scripts test that
      vec.wr(G.normal, ...h.normal.map(n => Math.round(n * 1000) / 1000));
      c.you = h.ent || 0;   // you is the hit entity, or NULL when the ray hit the level
      return (G.result = dist);
    };
    B.trace = (c, from, to) => trace(c, from, to, val(G.trace_mode));
    B.c_trace = (c, from, to, mode) => trace(c, from, to, val(mode));
    B.scan_entity = (c, pos, ang) => W.scan(c.me, pos, ang);
    B.c_scan = (c, pos, ang, size) => W.scan(c.me, pos, [vec.rd(size)[0] || 360, 0, vec.rd(size)[2] || vec.rd(ang)[2]]);

    // particles
    B.effect = (c, fn, n, pos, vel) => W.effect(fn, n, pos, vel);
    B.effect_local = B.effect;
    B.emit = (c, n, pos, fn) => W.emit(n, pos, fn);

    // paths
    const pathOf = e => (e && e._path) || null;
    B.ent_path = (c, name) => {
      const e = c.me, p = W.level?.paths.find(x => x.name.toLowerCase() === text(name).toLowerCase());
      if (!e || !p) return 0;
      e._path = p; e._pathIdx = 0;
      return p.points.length;
    };
    const point = (v, p, i) => { const q = p.points[i]; vec.wr(v, q[0], q[1], q[2]); return i + 1; };
    B.ent_waypoint = (c, v, n) => {
      const p = pathOf(c.me);
      if (!p) return 0;
      if (val(n) > 0) c.me._pathIdx = Math.min(p.points.length - 1, (val(n) | 0) - 1);
      return point(v, p, c.me._pathIdx);
    };
    B.ent_nextpoint = (c, v) => {
      const p = pathOf(c.me);
      if (!p) return 0;
      c.me._pathIdx = (c.me._pathIdx + 1) % p.points.length;
      return point(v, p, c.me._pathIdx);
    };
    B.ent_prevpoint = (c, v) => {
      const p = pathOf(c.me);
      if (!p) return 0;
      c.me._pathIdx = (c.me._pathIdx - 1 + p.points.length) % p.points.length;
      return point(v, p, c.me._pathIdx);
    };

    // screen projection
    B.vec_to_screen = (c, v, view) => {
      const cam = W.camera3;
      const [x, y, z] = vec.rd(v);
      const p = S(x, y, z).project(cam);
      if (p.z > 1 || p.z < -1) return 0;
      const size = G.screen_size;
      vec.wr(v, (p.x + 1) / 2 * size[0], (1 - p.y) / 2 * size[1], p.z);
      void view;
      return 1;
    };
    B.bmap_for_entity = (c, e) => {
      const f = text(e?.type);
      if (f && /\.(tga|pcx|bmp)$/i.test(f)) return R.bmap('', f);
      return e && typeof e === 'object' ? { kind: 'bmap', file: '', entity: e } : 0;
    };
  }
}

function dataTexture(img) {
  const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function weldMap(m) { return new Uint32Array(m.frames[0].pos.length / 3).map((_, i) => i); }

function solidGeometry(groups) {
  const pos = [], idx = [];
  for (const g of groups) {
    if (g.passable || g.surface === SURFACE.sky) continue;
    const base = pos.length / 3;
    for (const v of g.pos) pos.push(v);
    for (const i of g.idx) idx.push(base + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundsTree = new MeshBVH(geo);
  return geo;
}

// World-space AABB of an entity's bounding box, in scene coordinates.
function entBox(e, box) {
  const a = S(e.x + e.min_x, e.y + e.min_y, e.z + e.min_z), b = S(e.x + e.max_x, e.y + e.max_y, e.z + e.max_z);
  box.makeEmpty().expandByPoint(a).expandByPoint(b);
  return box;
}
