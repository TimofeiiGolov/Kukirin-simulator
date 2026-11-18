import * as THREE from 'three';
import { mergeParts, supportsMerge, type Part } from './mergeParts';

/**
 * Склейка статичной геометрии карты в крупные меши — ради числа вызовов отрисовки.
 *
 * Меши объединяются по (материал, тени, слои, порядок отрисовки, клетка сетки XZ). Клетка
 * сохраняет отсечение по пирамиде видимости и по туману. Одноцветные MeshStandardMaterial без
 * текстур переводятся в общий материал с цветом в вершинах, поэтому меши разных цветов попадают
 * в один вызов. Материалы, которые меняются в рантайме, передаются в `keepMaterials`.
 *
 * Не трогаются: прозрачное (порядок сортировки), трафарет (слои земли), инстансы, морфы,
 * материалы с собственным шейдером, невидимые и переданные в `skip` поддеревья (то, что
 * двигается или переключается в рантайме).
 */
export interface BatchOptions {
  cell?: number;
  skip?: Iterable<THREE.Object3D>;
  /** материалы, которые меняются в рантайме (цвет, яркость): склеиваются, но остаются собой */
  keepMaterials?: Iterable<THREE.Material>;
  track: <T extends { dispose(): void }>(o: T) => T;
}

export interface BatchStats {
  before: number;
  after: number;
}

const defaultObc = THREE.Material.prototype.onBeforeCompile;
const defaultObr = THREE.Object3D.prototype.onBeforeRender;

function eligible(m: THREE.Mesh): boolean {
  if ((m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return false;
  if (Array.isArray(m.material)) return false;
  const mat = m.material;
  if (mat.transparent || mat.stencilWrite || mat.stencilFunc !== THREE.AlwaysStencilFunc) return false;
  if (mat.onBeforeCompile !== defaultObc) return false;
  if (m.onBeforeRender !== defaultObr || m.customDepthMaterial || m.customDistanceMaterial) return false;
  if (Object.keys(m.geometry.morphAttributes).length) return false;
  return !!m.geometry.attributes.position && !!m.geometry.attributes.normal && supportsMerge(m.geometry);
}

// всё состояние материала, кроме цвета: совпадение ключа = одинаковый шейдер и одинаковые параметры
function vcKey(m: THREE.MeshStandardMaterial) {
  return [
    'vc',
    m.roughness,
    m.metalness,
    m.emissive.getHexString(),
    m.emissiveIntensity,
    m.envMapIntensity,
    m.side,
    m.shadowSide,
    m.flatShading,
    m.fog,
    m.wireframe,
    m.toneMapped,
    m.depthTest,
    m.depthWrite,
    m.colorWrite,
    m.polygonOffset,
    m.polygonOffsetFactor,
    m.polygonOffsetUnits,
    m.alphaTest,
    m.dithering,
  ].join('|');
}

const MAPS = [
  'map',
  'emissiveMap',
  'normalMap',
  'bumpMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'lightMap',
  'alphaMap',
  'displacementMap',
  'envMap',
] as const;

function isVc(mat: THREE.Material, keep: Set<THREE.Material>): mat is THREE.MeshStandardMaterial {
  const m = mat as THREE.MeshStandardMaterial;
  if (m.type !== 'MeshStandardMaterial' || m.vertexColors || keep.has(m)) return false;
  return MAPS.every((k) => !m[k]);
}

export function batchStatic(root: THREE.Object3D, opts: BatchOptions): BatchStats {
  const cell = opts.cell ?? 96;
  const skip = new Set(opts.skip ?? []);
  const keep = new Set(opts.keepMaterials ?? []);
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const meshes: THREE.Mesh[] = [];
  let before = 0;
  const walk = (o: THREE.Object3D) => {
    if (!o.visible || skip.has(o)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      before++;
      if (eligible(m)) meshes.push(m);
    }
    for (const c of o.children) walk(c);
  };
  walk(root);

  const vcMats = new Map<string, THREE.MeshStandardMaterial>();
  const buckets = new Map<string, { mat: THREE.Material; proto: THREE.Mesh; items: THREE.Mesh[]; vc: boolean }>();
  const center = new THREE.Vector3();
  for (const m of meshes) {
    const vc = isVc(m.material as THREE.Material, keep);
    let mat = m.material as THREE.Material;
    let matKey = mat.uuid;
    if (vc) {
      matKey = vcKey(mat as THREE.MeshStandardMaterial);
      let shared = vcMats.get(matKey);
      if (!shared) {
        shared = opts.track((mat as THREE.MeshStandardMaterial).clone());
        shared.color.set(1, 1, 1);
        shared.vertexColors = true;
        shared.userData = {};
        vcMats.set(matKey, shared);
      }
      mat = shared;
    }
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    center.copy(g.boundingSphere!.center).applyMatrix4(m.matrixWorld);
    // для обычных материалов набор атрибутов должен совпадать, у цвета в вершинах нужны только позиция и нормаль
    const attrs = vc ? '' : Object.keys(g.attributes).sort().join(',');
    const key = [
      matKey,
      attrs,
      m.castShadow ? 1 : 0,
      m.receiveShadow ? 1 : 0,
      m.layers.mask,
      m.renderOrder,
      m.frustumCulled ? 1 : 0,
      Math.floor(center.x / cell),
      Math.floor(center.z / cell),
    ].join('|');
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, proto: m, items: [], vc }));
    b.items.push(m);
  }

  let merged = 0;
  for (const b of buckets.values()) {
    if (b.items.length < 2) continue;
    const parts: Part[] = b.items.map((m) => ({
      geo: m.geometry,
      matrix: new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld),
      // material.color уже в линейном пространстве — в шейдере цвет вершины умножается так же
      color: b.vc ? (m.material as THREE.MeshStandardMaterial).color : undefined,
    }));
    const attrs = b.vc ? ['position', 'normal'] : Object.keys(b.proto.geometry.attributes);
    const geo = mergeParts(parts, attrs);
    const out = new THREE.Mesh(opts.track(geo), b.mat);
    const p = b.proto;
    out.castShadow = p.castShadow;
    out.receiveShadow = p.receiveShadow;
    out.layers.mask = p.layers.mask;
    out.renderOrder = p.renderOrder;
    out.frustumCulled = p.frustumCulled;
    out.matrixAutoUpdate = false;
    for (const m of b.items) m.removeFromParent();
    root.add(out);
    merged += 1;
  }

  // опустевшие группы больше не нужны графу сцены
  const prune = (o: THREE.Object3D) => {
    for (const c of [...o.children]) prune(c);
    if (o !== root && o.type === 'Group' && o.children.length === 0 && !skip.has(o)) o.removeFromParent();
  };
  prune(root);

  let after = 0;
  root.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) after++;
  });
  return { before, after };
}
