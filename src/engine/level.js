// Turns a parsed WMB6 level into three.js meshes (diffuse texture + baked lightmap).
import * as THREE from 'three';
import { SURFACE } from '../formats/wmb6.js';

function dataTexture(img, { repeat = false, srgb = true, mips = true } = {}) {
  const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export function buildLevel(level, { lightmapIntensity = 2 } = {}) {
  const root = new THREE.Group();
  const textures = level.textures.map(img => dataTexture(img, { repeat: true }));
  const lightmaps = level.lightmaps.map(img => {
    const t = dataTexture(img, { srgb: false, mips: false });
    t.channel = 1;
    return t;
  });

  const box = new THREE.Box3();
  for (const g of level.groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('uv1', new THREE.Float32BufferAttribute(g.uv1, 2));
    geo.setIndex(g.idx.length > 65535 ? new THREE.Uint32BufferAttribute(g.idx, 1) : new THREE.Uint16BufferAttribute(g.idx, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    box.union(geo.boundingBox);

    const params = { map: textures[g.texture] || null, side: THREE.FrontSide };
    if (g.surface === SURFACE.sky) params.fog = false;
    if (g.surface === SURFACE.turbulence) Object.assign(params, { transparent: true, opacity: 0.75 });
    let mat;
    if (g.lightmap >= 0) {
      // Lambert so the flashlight adds on top of the baked light; lightmap enters as
      // irradiance and gets divided by PI in the BRDF, hence the PI factor.
      mat = new THREE.MeshLambertMaterial({ ...params, lightMap: lightmaps[g.lightmap], lightMapIntensity: lightmapIntensity * Math.PI });
    } else {
      // Without a lightmap the basic material would be fully bright; keep unlit faces dim instead.
      mat = new THREE.MeshBasicMaterial(params);
      if (g.surface !== SURFACE.sky) mat.color.setScalar(0.6);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.userData.surface = g.surface;
    root.add(mesh);
  }

  return { root, bounds: box, dispose() {
    root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    textures.forEach(t => t.dispose());
    lightmaps.forEach(t => t.dispose());
  } };
}

// Acknex (x fwd, y left, z up) -> scene (x, z, -y)
export const toScene = ([x, y, z]) => new THREE.Vector3(x, z, -y);

export function findSpawn(level, prefer = 'oyuncu_demir') {
  const ents = level.objects.filter(o => o.type === 'entity');
  const pick = ents.find(e => e.action.toLowerCase() === prefer)
    || ents.find(e => /^oyuncu_/i.test(e.action))
    || ents.find(e => /player/i.test(e.action));
  if (pick) return { origin: toScene(pick.origin), yaw: pick.angle[0] * Math.PI / 180, who: pick.action };
  return null;
}
