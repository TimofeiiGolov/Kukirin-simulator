import * as THREE from 'three';

/** Кусок для склейки: исходная геометрия, её матрица и (необязательно) цвет в вершины. */
export interface Part {
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  color?: THREE.Color;
}

/** Атрибуты, которые умеет переносить склейка. Нормаль поворачивается, остальное копируется. */
const SUPPORTED: Record<string, number> = { position: 3, normal: 3, uv: 2, color: 3 };

/** Общие для всех кусков поддерживаемые атрибуты с одинаковым числом компонент. */
export function commonAttributes(geos: THREE.BufferGeometry[]): string[] {
  return Object.keys(SUPPORTED).filter((name) =>
    geos.every((g) => {
      const a = g.attributes[name];
      return !!a && a.itemSize === SUPPORTED[name];
    }),
  );
}

export function supportsMerge(g: THREE.BufferGeometry): boolean {
  return Object.keys(g.attributes).every((n) => n in SUPPORTED) && !Object.keys(g.morphAttributes).length;
}

/**
 * Запекает матрицы и сливает куски в одну индексированную геометрию, записывая вершины сразу
 * в итоговые массивы — без промежуточных клонов. Результат совпадает с
 * clone() + applyMatrix4() + mergeGeometries(), включая разворот обхода у зеркальных матриц.
 * `color` в кусках переопределяет атрибут цвета (материал с цветом в вершинах).
 */
export function mergeParts(parts: Part[], attrs: string[]): THREE.BufferGeometry {
  const withColor = attrs.includes('color') || parts.some((p) => p.color);
  const names = attrs.filter((a) => a !== 'color');
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    const n = p.geo.attributes.position.count;
    nv += n;
    ni += p.geo.index ? p.geo.index.count : n;
  }
  const out: Record<string, Float32Array> = {};
  for (const n of names) out[n] = new Float32Array(nv * SUPPORTED[n]);
  const col = withColor ? new Float32Array(nv * 3) : null;
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);

  const nm = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const g = p.geo;
    const n = g.attributes.position.count;
    const e = p.matrix.elements;
    for (const name of names) {
      const src = g.attributes[name];
      const dst = out[name];
      if (name === 'position') {
        for (let i = 0; i < n; i++) {
          const x = src.getX(i), y = src.getY(i), z = src.getZ(i);
          const k = (vo + i) * 3;
          dst[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
          dst[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          dst[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
      } else if (name === 'normal') {
        const m = nm.getNormalMatrix(p.matrix).elements;
        for (let i = 0; i < n; i++) {
          const x = src.getX(i), y = src.getY(i), z = src.getZ(i);
          const nx = m[0] * x + m[3] * y + m[6] * z;
          const ny = m[1] * x + m[4] * y + m[7] * z;
          const nz = m[2] * x + m[5] * y + m[8] * z;
          const l = Math.hypot(nx, ny, nz) || 1;
          const k = (vo + i) * 3;
          dst[k] = nx / l;
          dst[k + 1] = ny / l;
          dst[k + 2] = nz / l;
        }
      } else {
        const s = SUPPORTED[name];
        for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) dst[(vo + i) * s + c] = src.getComponent(i, c);
      }
    }
    if (col) {
      const src = g.attributes.color;
      for (let i = 0; i < n; i++) {
        const k = (vo + i) * 3;
        if (p.color) {
          col[k] = p.color.r;
          col[k + 1] = p.color.g;
          col[k + 2] = p.color.b;
        } else if (src) {
          col[k] = src.getX(i);
          col[k + 1] = src.getY(i);
          col[k + 2] = src.getZ(i);
        } else col[k] = col[k + 1] = col[k + 2] = 1;
      }
    }
    // зеркальная матрица выворачивает треугольники: three.js исправляет это при отрисовке объекта, после запекания — мы
    const flip = p.matrix.determinant() < 0;
    const idx = g.index;
    const cnt = idx ? idx.count : n;
    for (let t = 0; t + 2 < cnt; t += 3) {
      const a = idx ? idx.getX(t) : t;
      const b = idx ? idx.getX(t + 1) : t + 1;
      const c = idx ? idx.getX(t + 2) : t + 2;
      index[io + t] = vo + a;
      index[io + t + 1] = vo + (flip ? c : b);
      index[io + t + 2] = vo + (flip ? b : c);
    }
    vo += n;
    io += cnt;
  }

  const geo = new THREE.BufferGeometry();
  for (const n of names) geo.setAttribute(n, new THREE.BufferAttribute(out[n], SUPPORTED[n]));
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
