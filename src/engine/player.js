// First-person controller: capsule vs. level triangles (BVH), gravity, slide, or free-fly.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const RADIUS = 15;          // quants
const HEIGHT = 70;          // capsule segment length + 2*radius ~= 100 quants tall
const EYE = 50;             // eye height above capsule centre-ish
const GRAVITY = 1400;
const JUMP = 380;
const WALK = 190, RUN = 340, FLY = 420;

// extra: [{ geo, matrix }] for solid entities (models, map entities).
export function buildCollider(level, extra = []) {
  const pos = [], idx = [];
  const v = new THREE.Vector3();
  for (const g of level.groups) {
    if (g.passable) continue;
    const base = pos.length / 3;
    for (const v of g.pos) pos.push(v);
    for (const i of g.idx) idx.push(base + i);
  }
  for (const { geo: eg, matrix } of extra) {
    const base = pos.length / 3, p = eg.attributes.position;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(matrix); pos.push(v.x, v.y, v.z); }
    const ix = eg.index.array;
    for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundsTree = new MeshBVH(geo);
  return geo;
}

export class Player {
  constructor(camera, collider) {
    this.camera = camera;
    this.collider = collider;
    this.position = new THREE.Vector3();   // capsule bottom sphere centre
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.mode = 'walk';
    this.onGround = false;
    this.segment = new THREE.Line3();
    this._box = new THREE.Box3();
    this._v = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this.bob = 0;
  }

  spawn(origin, yaw) {
    // Entity origin is roughly the model centre; drop the capsule a little above it.
    this.position.copy(origin).add(new THREE.Vector3(0, 10, 0));
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.sync(0);
  }

  update(dt, input) {
    const look = input.look(dt);
    this.yaw += look.yaw;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + look.pitch));
    const m = input.move();
    const fwd = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const right = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    if (this.mode === 'fly') {
      const dir = fwd.clone().multiplyScalar(Math.cos(this.pitch)).setY(Math.sin(this.pitch));
      const speed = FLY * (input.running() ? 2.5 : 1);
      this.position.addScaledVector(dir, m.z * speed * dt).addScaledVector(right, m.x * speed * dt);
      this.position.y += m.y * speed * dt;
      this.sync(dt);
      return;
    }

    const speed = input.running() ? RUN : WALK;
    const wish = fwd.multiplyScalar(m.z).addScaledVector(right, m.x).multiplyScalar(speed);
    // Snappy on the ground, a little air control otherwise.
    const accel = this.onGround ? 12 : 2.5;
    this.velocity.x += (wish.x - this.velocity.x) * Math.min(1, accel * dt);
    this.velocity.z += (wish.z - this.velocity.z) * Math.min(1, accel * dt);
    if (this.onGround && m.y > 0.5) this.velocity.y = JUMP;
    this.velocity.y -= GRAVITY * dt;

    // Substeps keep fast movement from tunnelling through thin brushes.
    const steps = Math.max(1, Math.ceil(this.velocity.length() * dt / (RADIUS * 0.5)));
    const h = dt / steps;
    this.onGround = false;
    for (let s = 0; s < steps; s++) this.step(h);

    if (this.position.y < this.killY) this.respawn?.();
    const moving = this.onGround && Math.hypot(this.velocity.x, this.velocity.z) > 20;
    this.bob = moving ? this.bob + dt * (input.running() ? 13 : 9) : this.bob * 0.9;
    this.sync(dt);
  }

  step(dt) {
    const start = this._a.copy(this.position);
    this.position.addScaledVector(this.velocity, dt);
    const seg = this.segment;
    seg.start.copy(this.position);
    seg.end.copy(this.position).y += HEIGHT;
    this._box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end);
    this._box.min.addScalar(-RADIUS);
    this._box.max.addScalar(RADIUS);

    const triPoint = new THREE.Vector3(), capPoint = new THREE.Vector3();
    this.collider.boundsTree.shapecast({
      intersectsBounds: box => box.intersectsBox(this._box),
      intersectsTriangle: tri => {
        const d = tri.closestPointToSegment(seg, triPoint, capPoint);
        if (d < RADIUS) {
          const depth = RADIUS - d;
          const dir = capPoint.sub(triPoint).normalize();
          seg.start.addScaledVector(dir, depth);
          seg.end.addScaledVector(dir, depth);
        }
      },
    });

    const delta = this._b.copy(seg.start).sub(this.position);
    const grounded = delta.y > Math.abs(dt * this.velocity.y * 0.25);
    if (delta.lengthSq() > 1e-8) {
      this.position.add(delta);
      const n = delta.normalize();
      if (grounded) {
        this.onGround = true;
        if (this.velocity.y < 0) this.velocity.y = 0;
      } else {
        this.velocity.addScaledVector(n, -n.dot(this.velocity));
      }
    }
    return start;
  }

  sync() {
    const bob = Math.sin(this.bob) * 2.2;
    this.camera.position.copy(this.position);
    if (this.mode === 'walk') this.camera.position.y += EYE + bob;
    this.camera.rotation.set(this.pitch, this.yaw - Math.PI / 2, 0, 'YXZ');
  }
}
