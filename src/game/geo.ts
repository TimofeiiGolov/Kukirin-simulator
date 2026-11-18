import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Общие процедурные примитивы для моделей самоката и райдера.
export type Pt = [number, number];

// Общая студийная карта отражений: без неё металл и лак выглядят плоскими и чёрными.
let envTex: THREE.CanvasTexture | null = null;
export function studioEnv(): THREE.Texture {
  if (envTex) return envTex;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#b9d2ee');
  sky.addColorStop(0.4, '#e6eef6');
  sky.addColorStop(0.495, '#f6f1e6');
  sky.addColorStop(0.53, '#77726a');
  sky.addColorStop(1, '#2b2a28');
  g.fillStyle = sky;
  g.fillRect(0, 0, 512, 256);
  const sun = g.createRadialGradient(150, 62, 2, 150, 62, 70);
  sun.addColorStop(0, 'rgba(255,255,255,1)');
  sun.addColorStop(0.25, 'rgba(255,250,235,0.85)');
  sun.addColorStop(1, 'rgba(255,250,235,0)');
  g.fillStyle = sun;
  g.fillRect(60, 0, 190, 140);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(330, 34, 110, 30);
  g.fillRect(470, 60, 42, 40);
  g.fillRect(0, 60, 20, 40);
  envTex = new THREE.CanvasTexture(c);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;
  return envTex;
}

/** Контур из ломаной со скруглёнными углами. */
export function outline(pts: Pt[], r = 0): THREE.Shape {
  const sh = new THREE.Shape();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1;
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const ra = Math.min(r, la * 0.45);
    const rb = Math.min(r, lb * 0.45);
    const x1 = p[0] + ((a[0] - p[0]) / la) * ra;
    const y1 = p[1] + ((a[1] - p[1]) / la) * ra;
    if (i === 0) sh.moveTo(x1, y1);
    else sh.lineTo(x1, y1);
    if (r > 0) sh.quadraticCurveTo(p[0], p[1], p[0] + ((b[0] - p[0]) / lb) * rb, p[1] + ((b[1] - p[1]) / lb) * rb);
  }
  sh.closePath();
  return sh;
}

/** Выдавливание контура вдоль Z (по центру) с фаской, не увеличивающей габарит. */
export function extrudeZ(shape: THREE.Shape, depth: number, bevel = 0.002, curveSegments = 8): THREE.BufferGeometry {
  const b = Math.max(0, Math.min(bevel, depth * 0.45));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - 2 * b,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 1,
    curveSegments,
  });
  g.translate(0, 0, -(depth - 2 * b) / 2);
  return g;
}

export const plate = (pts: Pt[], depth: number, r = 0.006, bevel = 0.002) => extrudeZ(outline(pts, r), depth, bevel);

/** Параллелепипед sx×sy×sz со скруглением рёбер вокруг оси axis. */
export function rbox(sx: number, sy: number, sz: number, r: number, axis: 'x' | 'y' | 'z' = 'z', bevel = 0.0015) {
  const [w, h, d] = axis === 'z' ? [sx, sy, sz] : axis === 'x' ? [sz, sy, sx] : [sx, sz, sy];
  const g = extrudeZ(
    outline(
      [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ],
      Math.min(r, w * 0.49, h * 0.49),
    ),
    d,
    bevel,
    3,
  );
  if (axis === 'x') g.rotateY(Math.PI / 2);
  else if (axis === 'y') g.rotateX(Math.PI / 2);
  return g;
}

/** Тело вращения вокруг оси Z; профиль — пары (радиус, координата вдоль оси), обход против часовой. */
export function lathe(pts: Pt[], seg = 32, phiStart = 0, phiLen = Math.PI * 2, smooth = 0) {
  let v = pts.map(([r, h]) => new THREE.Vector2(r, h));
  if (smooth) v = new THREE.SplineCurve(v).getPoints(smooth);
  const g = new THREE.LatheGeometry(v, seg, phiStart, phiLen);
  g.rotateX(Math.PI / 2);
  return g;
}

export const cylZ = (r: number, len: number, seg = 16) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);

/** Склеивает статичные меши контейнера по материалам: сотни деталей → несколько draw call. */
export function bake(container: THREE.Object3D, stop: Set<THREE.Object3D>) {
  container.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(container.matrixWorld).invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const done: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    for (const ch of o.children) {
      if (stop.has(ch)) continue;
      const m = ch as THREE.Mesh;
      if (m.isMesh && !(m as unknown as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(m.material)) {
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        const list = buckets.get(m.material);
        if (list) list.push(g);
        else buckets.set(m.material, [g]);
        done.push(m);
      }
      visit(ch);
    }
  };
  visit(container);
  for (const m of done) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (merged) container.add(new THREE.Mesh(merged, mat));
  }
}

