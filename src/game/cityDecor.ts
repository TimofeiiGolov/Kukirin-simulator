import * as THREE from 'three';
import { commonAttributes, mergeParts, type Part } from './mergeParts';
import type { BoxObstacle, Obstacle } from './terrain';
import {
  FACADE_PALETTES,
  SHOP_SIGN_COLORS,
  adTexture,
  clockTexture,
  concreteTexture,
  facadeTextures,
  menuTexture,
  plateTexture,
  ribTexture,
  roadSignTexture,
  roofTexture,
  shopfrontTextures,
  woodTexture,
  type FacadeStyle,
  type FacadeTex,
} from './cityTextures';

// ============================================================================
// Декор города: здания, кузова машин, мебель улиц, новые объекты, деревья.
// Мелкие детали объекта собираются в одну геометрию на материал (collector).
// ============================================================================

export interface NightMat {
  mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  nightI: number;
  sunsetI: number;
}

export interface DecorCtx {
  group: THREE.Group;
  macro: (x: number, z: number) => number;
  /** высота видимой поверхности земли в точке */
  ground: (x: number, z: number) => number;
  track: <T extends { dispose(): void }>(o: T) => T;
  night: NightMat[];
}

export function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MatOpts {
  rough?: number;
  metal?: number;
  emissive?: string;
  emissiveI?: number;
  side?: THREE.Side;
  opacity?: number;
  flat?: boolean;
}

interface PO {
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const HALF_PI = Math.PI / 2;

export function createDecor(ctx: DecorCtx) {
  const { group, track } = ctx;
  const matCache = new Map<string, THREE.MeshStandardMaterial>();
  const M = (color: string, o: MatOpts = {}) => {
    const key = `${color}|${o.rough ?? 0.7}|${o.metal ?? 0}|${o.emissive ?? ''}|${o.emissiveI ?? 0}|${o.side ?? 0}|${o.opacity ?? 1}|${o.flat ? 1 : 0}`;
    let m = matCache.get(key);
    if (!m) {
      m = track(
        new THREE.MeshStandardMaterial({
          color,
          roughness: o.rough ?? 0.7,
          metalness: o.metal ?? 0,
          emissive: o.emissive ? new THREE.Color(o.emissive) : new THREE.Color('#000000'),
          emissiveIntensity: o.emissiveI ?? 0,
          side: o.side ?? THREE.FrontSide,
          transparent: (o.opacity ?? 1) < 1,
          opacity: o.opacity ?? 1,
          flatShading: !!o.flat,
        }),
      );
      matCache.set(key, m);
    }
    return m;
  };
  const geoCache = new Map<string, THREE.BufferGeometry>();
  const G = <T extends THREE.BufferGeometry>(key: string, make: () => T): T => {
    let g = geoCache.get(key) as T | undefined;
    if (!g) {
      g = track(make());
      geoCache.set(key, g);
    }
    return g;
  };
  const boxG = (x: number, y: number, z: number) =>
    G(`b${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`, () => new THREE.BoxGeometry(x, y, z));
  const cylG = (rt: number, rb: number, h: number, seg = 12) =>
    G(`c${rt.toFixed(3)}|${rb.toFixed(3)}|${h.toFixed(3)}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
  /** цилиндр, лежащий вдоль оси Z (колёса, диски) */
  const discG = (r: number, w: number, seg = 16) =>
    G(`d${r.toFixed(3)}|${w.toFixed(3)}|${seg}`, () => new THREE.CylinderGeometry(r, r, w, seg).rotateX(HALF_PI));
  /** цилиндр, лежащий вдоль оси X */
  const rodXG = (r: number, len: number, seg = 8) =>
    G(`rx${r.toFixed(3)}|${len.toFixed(3)}|${seg}`, () => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(HALF_PI));
  const sphG = (r: number, ws = 10, hs = 8) => G(`s${r.toFixed(3)}|${ws}|${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
  /** плоскость в плоскости XY (нормаль +Z); uv масштабируется на uk/vk */
  const planeG = (w: number, h: number, uk = 1, vk = 1) =>
    G(`p${w.toFixed(3)}|${h.toFixed(3)}|${uk.toFixed(3)}|${vk.toFixed(3)}`, () => {
      const g = new THREE.PlaneGeometry(w, h);
      if (uk !== 1 || vk !== 1) {
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uk, uv.getY(i) * vk);
      }
      return g;
    });
  /** горизонтальная плоскость (нормаль +Y) */
  const floorG = (w: number, d: number, uk = 1, vk = 1) =>
    G(`f${w.toFixed(3)}|${d.toFixed(3)}|${uk.toFixed(3)}|${vk.toFixed(3)}`, () => {
      const g = new THREE.PlaneGeometry(w, d).rotateX(-HALF_PI);
      if (uk !== 1 || vk !== 1) {
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uk, uv.getY(i) * vk);
      }
      return g;
    });

  const add = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    shadow = false,
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (shadow) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    parent.add(m);
    return m;
  };
  const box = (
    parent: THREE.Object3D,
    sx: number,
    sy: number,
    sz: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    shadow = false,
  ) => add(parent, boxG(sx, sy, sz), mat, x, y, z, shadow);

  // ---- сборщик: геометрии по материалам → один меш на материал ------------
  interface Collector {
    put: (geo: THREE.BufferGeometry, mat: THREE.Material, x?: number, y?: number, z?: number, o?: PO) => void;
    bx: (sx: number, sy: number, sz: number, mat: THREE.Material, x: number, y: number, z: number, o?: PO) => void;
    cy: (rt: number, rb: number, h: number, mat: THREE.Material, x: number, y: number, z: number, o?: PO, seg?: number) => void;
    flush: (parent: THREE.Object3D, shadow?: boolean) => void;
  }
  const collector = (): Collector => {
    const parts = new Map<THREE.Material, Part[]>();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    // геометрия из кэша не клонируется: матрица запекается при склейке (mergeParts)
    const put: Collector['put'] = (geo, mat, x = 0, y = 0, z = 0, o = {}) => {
      e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
      q.setFromEuler(e);
      p.set(x, y, z);
      s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
      let l = parts.get(mat);
      if (!l) parts.set(mat, (l = []));
      l.push({ geo, matrix: new THREE.Matrix4().compose(p, q, s) });
    };
    return {
      put,
      bx: (sx, sy, sz, mat, x, y, z, o) => put(boxG(sx, sy, sz), mat, x, y, z, o),
      cy: (rt, rb, h, mat, x, y, z, o, seg = 10) => put(cylG(rt, rb, h, seg), mat, x, y, z, o),
      flush: (parent, shadow = true) => {
        for (const [mat, list] of parts) {
          const merged = track(mergeParts(list, commonAttributes(list.map((l) => l.geo))));
          const mesh = new THREE.Mesh(merged, mat);
          mesh.castShadow = shadow && !mat.transparent;
          mesh.receiveShadow = shadow;
          parent.add(mesh);
        }
        parts.clear();
      },
    };
  };

  /** профиль (x,y) → экструзия по Z шириной w, центрирована */
  const extrudeProfile = (pts: [number, number][], w: number) => {
    const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false });
    g.translate(0, 0, -w / 2);
    return g;
  };

  // ---- общие материалы ----------------------------------------------------
  const night = (mat: THREE.MeshStandardMaterial, nightI: number, sunsetI: number) => {
    ctx.night.push({ mat, nightI, sunsetI });
    return mat;
  };
  // одинаковые огни делят материал: ночная яркость у них общая, а склейка сводит их в один вызов
  const glowCache = new Map<string, THREE.MeshStandardMaterial>();
  const glowMat = (color: string, nightI: number, sunsetI = nightI * 0.4, base = 0) => {
    const key = `${color}|${nightI}|${sunsetI}|${base}`;
    let m = glowCache.get(key);
    if (!m) glowCache.set(key, (m = makeGlow(color, nightI, sunsetI, base)));
    return m;
  };
  const makeGlow = (color: string, nightI: number, sunsetI: number, base: number) =>
    night(
      track(
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.4,
          emissive: new THREE.Color(color),
          emissiveIntensity: base,
        }),
      ),
      nightI,
      sunsetI,
    );
  const steel = M('#9aa3ad', { rough: 0.45, metal: 0.25 });
  const steelDark = M('#3a424c', { rough: 0.5, metal: 0.2 });
  const rubber = M('#17191c', { rough: 0.9 });
  const carGlass = M('#3a5b77', { rough: 0.12, metal: 0.05 });
  const tintGlass = M('#9ec9e0', { rough: 0.1, metal: 0.05, opacity: 0.38 });
  const chrome = M('#d4d8dc', { rough: 0.25, metal: 0.3 });
  const headMat = glowMat('#fff6dc', 1.6, 0.6);
  const tailMat = glowMat('#ff2a2a', 1.4, 0.7, 0.15);
  const amberMat = glowMat('#ffb030', 1.4, 0.5);
  const lampWarm = glowMat('#ffe2a0', 1.6, 0.6);
  const tankMat = M('#7c5a3e', { rough: 0.9 });
  const parapetMat = M('#cfcabf', { rough: 0.9 });
  const plinthMat = M('#8a8d90', { rough: 0.95 });

  const concTex = track(concreteTexture());
  const woodTex = track(woodTexture());
  const ribTex = track(ribTexture());
  const plateTex = track(plateTexture());
  const roofTex = { tar: track(roofTexture('tar')), tile: track(roofTexture('tile')) };
  const plateMat = track(new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5 }));

  const texMatCache = new Map<string, THREE.MeshStandardMaterial>();
  const texMat = (key: string, make: () => THREE.MeshStandardMaterial) => {
    let m = texMatCache.get(key);
    if (!m) {
      m = track(make());
      texMatCache.set(key, m);
    }
    return m;
  };
  const concMat = (color: string, rough = 0.95) =>
    texMat(`conc|${color}`, () => new THREE.MeshStandardMaterial({ color, map: concTex, roughness: rough }));
  const woodMat = (color: string) =>
    texMat(`wood|${color}`, () => new THREE.MeshStandardMaterial({ color: new THREE.Color(color).offsetHSL(0, 0.05, 0.08), map: woodTex, roughness: 0.8 }));
  const ribMat = (color: string) =>
    texMat(`rib|${color}`, () => new THREE.MeshStandardMaterial({ color, map: ribTex, roughness: 0.55, metalness: 0.15 }));
  const roofMat = (kind: 'tar' | 'tile') =>
    texMat(`roof|${kind}`, () => new THREE.MeshStandardMaterial({ map: roofTex[kind], roughness: 0.95, side: THREE.DoubleSide }));
  const worldOf = (b: { x: number; z: number }) => ctx.ground(b.x, b.z);

  // ==========================================================================
  // ЗДАНИЯ
  // ==========================================================================
  const FLOOR_H = 3.2;
  const GF_H = 3.6;
  const facadeTexCache = new Map<string, FacadeTex>();
  const facadeMatCache = new Map<string, THREE.MeshStandardMaterial>();
  const facadeMat = (fs: FacadeStyle, pi: number, cols: number, rows: number) => {
    const key = `${fs}|${pi}|${cols}|${rows}`;
    let m = facadeMatCache.get(key);
    if (m) return m;
    const tk = `${fs}|${pi}`;
    let ft = facadeTexCache.get(tk);
    if (!ft) {
      ft = facadeTextures(fs, FACADE_PALETTES[fs][pi], pi + 1);
      track(ft.map);
      track(ft.emissive);
      facadeTexCache.set(tk, ft);
    }
    const map = track(ft.map.clone());
    const em = track(ft.emissive.clone());
    for (const t of [map, em]) {
      t.repeat.set(cols / 4, rows / 4);
      t.needsUpdate = true;
    }
    m = track(
      new THREE.MeshStandardMaterial({
        map,
        emissiveMap: em,
        emissive: new THREE.Color('#ffffff'),
        emissiveIntensity: 0,
        roughness: fs === 'glass' ? 0.3 : 0.88,
        metalness: fs === 'glass' ? 0.08 : 0,
      }),
    );
    night(m, 1.0, 0.35);
    facadeMatCache.set(key, m);
    return m;
  };
  const shopTexCache = new Map<number, FacadeTex>();
  const shopMatCache = new Map<string, THREE.MeshStandardMaterial>();
  const shopMat = (variant: number, n: number) => {
    const key = `${variant}|${n}`;
    let m = shopMatCache.get(key);
    if (m) return m;
    let ft = shopTexCache.get(variant);
    if (!ft) {
      ft = shopfrontTextures(variant);
      track(ft.map);
      track(ft.emissive);
      shopTexCache.set(variant, ft);
    }
    const map = track(ft.map.clone());
    const em = track(ft.emissive.clone());
    for (const t of [map, em]) {
      t.repeat.set(n, 1);
      t.needsUpdate = true;
    }
    m = track(
      new THREE.MeshStandardMaterial({
        map,
        emissiveMap: em,
        emissive: new THREE.Color('#ffffff'),
        emissiveIntensity: 0,
        roughness: 0.35,
      }),
    );
    night(m, 1.1, 0.5);
    shopMatCache.set(key, m);
    return m;
  };

  type Side = 'pz' | 'nz' | 'px' | 'nx';
  const SIDES: Side[] = ['pz', 'nz', 'px', 'nx'];
  /** позиция/поворот точки на грани прямоугольника w×d: lateral — вдоль грани, out — наружу */
  const onSide = (side: Side, w: number, d: number, lateral: number, out: number) => {
    switch (side) {
      case 'pz':
        return { x: lateral, z: d / 2 + out, ry: 0 };
      case 'nz':
        return { x: -lateral, z: -d / 2 - out, ry: Math.PI };
      case 'px':
        return { x: w / 2 + out, z: -lateral, ry: HALF_PI };
      default:
        return { x: -w / 2 - out, z: lateral, ry: -HALF_PI };
    }
  };

  function roofSlopes(L: number, W: number, H: number) {
    const tilePerM = 1 / 3;
    const pos: number[] = [];
    const uv: number[] = [];
    const quad = (a: number[], bb: number[], cc: number[], d: number[], u: number, v: number) => {
      pos.push(...a, ...bb, ...cc, ...a, ...cc, ...d);
      uv.push(0, 0, u, 0, u, v, 0, 0, u, v, 0, v);
    };
    const slope = Math.hypot(W / 2, H);
    quad([-L / 2, 0, W / 2], [L / 2, 0, W / 2], [L / 2, H, 0], [-L / 2, H, 0], L * tilePerM, slope * tilePerM);
    quad([L / 2, 0, -W / 2], [-L / 2, 0, -W / 2], [-L / 2, H, 0], [L / 2, H, 0], L * tilePerM, slope * tilePerM);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    return geo;
  }

  /** треугольный фронтон в плоскости XY (основание на y=0, нормаль +Z) */
  function triangleG(w: number, ht: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, 0, ht, 0], 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    return geo;
  }

  function buildBuilding(b: BoxObstacle) {
    const sx = b.halfX * 2;
    const sz = b.halfZ * 2;
    const h = b.h;
    const style = b.style ?? 'slab';
    const hv = hash2(b.x * 0.37 + 1.3, b.z * 0.71 + 2.1);
    const rnd = makeRng(Math.floor((b.x * 13 + b.z * 7 + 1000) * 31));
    const c = collector();
    const gs = [
      worldOf(b),
      ctx.ground(b.x - b.halfX, b.z - b.halfZ),
      ctx.ground(b.x + b.halfX, b.z - b.halfZ),
      ctx.ground(b.x - b.halfX, b.z + b.halfZ),
      ctx.ground(b.x + b.halfX, b.z + b.halfZ),
    ];
    const hi = Math.max(...gs);
    const lo = Math.min(...gs);
    const g = new THREE.Group();
    g.position.set(b.x, hi, b.z);
    g.userData.cb = [b.x, b.z, b.halfX, b.halfZ, b.kind, b.variant ?? b.style ?? ''];
    const depth = hi - lo + 0.5;

    const fs: FacadeStyle =
      style === 'glass'
        ? 'glass'
        : style === 'tower'
          ? 'fins'
          : style === 'stepped'
            ? 'plaster'
            : style === 'gable'
              ? hv < 0.5
                ? 'brick'
                : 'plaster'
              : hv < 0.5
                ? 'brick'
                : 'concrete';
    const pal = FACADE_PALETTES[fs];
    const pi = Math.floor(hash2(b.z * 1.7 + 0.3, b.x * 2.3 + 0.9) * pal.length) % pal.length;
    const wallColor = pal[pi];
    const trimMat = M(fs === 'brick' ? '#d9d3c5' : '#e4e1da', { rough: 0.85 });
    const accent = b.accent ?? '#38bdf8';
    const accMat = glowMat(accent, 1.8, 0.8, 0);
    const acUnit = M('#aeb4ba', { rough: 0.6, metal: 0.2 });
    const redBeacon = track(new THREE.MeshBasicMaterial({ color: '#ff3030' }));
    const darkMetal = M('#2b3139', { rough: 0.5, metal: 0.2 });

    // тротуарная площадка и цоколь: здание не стоит «голым» на траве
    c.bx(sx + 1.8, depth + 0.06, sz + 1.8, M('#a9a6a0', { rough: 0.95 }), 0, 0.055 - (depth + 0.06) / 2, 0);
    c.put(floorG(sx + 1.8, sz + 1.8, (sx + 1.8) / 2, (sz + 1.8) / 2), concMat('#b7b4ad'), 0, 0.058, 0);
    c.bx(sx + 0.24, depth + 0.4, sz + 0.24, plinthMat, 0, 0.2 - (depth + 0.4) / 2, 0);

    const wallFaces = (
      w: number,
      d: number,
      y0: number,
      y1: number,
      matFn?: (len: number, ht: number) => THREE.Material,
    ) => {
      const ht = y1 - y0;
      for (const side of SIDES) {
        const len = side === 'pz' || side === 'nz' ? w : d;
        const m = matFn
          ? matFn(len, ht)
          : facadeMat(fs, pi, Math.max(1, Math.round(len / FLOOR_H)), Math.max(1, Math.round(ht / FLOOR_H)));
        const o = onSide(side, w, d, 0, 0);
        c.put(planeG(len, ht), m, o.x, (y0 + y1) / 2, o.z, { ry: o.ry });
      }
    };
    const roofTop = (w: number, d: number, y: number) => c.put(floorG(w, d, w / 4, d / 4), roofMat('tar'), 0, y, 0);
    const parapet = (w: number, d: number, y: number, ht = 0.7) => {
      const t = 0.3;
      c.bx(w, ht, t, parapetMat, 0, y + ht / 2, d / 2 - t / 2);
      c.bx(w, ht, t, parapetMat, 0, y + ht / 2, -d / 2 + t / 2);
      c.bx(t, ht, d - 2 * t, parapetMat, w / 2 - t / 2, y + ht / 2, 0);
      c.bx(t, ht, d - 2 * t, parapetMat, -w / 2 + t / 2, y + ht / 2, 0);
      c.bx(w + 0.12, 0.08, d + 0.12, trimMat, 0, y + ht + 0.04, 0);
    };
    const cornice = (w: number, d: number, y: number, ht = 0.3, ext = 0.12) =>
      c.bx(w + ext * 2, ht, d + ext * 2, trimMat, 0, y, 0);

    const acRow = (cx: number, cz: number, n: number, along: 'x' | 'z', y: number) => {
      for (let i = 0; i < n; i++) {
        const ox = along === 'x' ? i * 1.5 : 0;
        const oz = along === 'z' ? i * 1.5 : 0;
        c.bx(1.2, 0.8, 1.0, acUnit, cx + ox, y + 0.4, cz + oz);
        c.cy(0.34, 0.34, 0.04, darkMetal, cx + ox, y + 0.82, cz + oz, undefined, 12);
      }
    };
    const waterTank = (x: number, z: number, y: number) => {
      for (const [lx, lz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]])
        c.cy(0.05, 0.05, 1.6, darkMetal, x + lx, y + 0.8, z + lz, undefined, 6);
      c.bx(1.4, 0.06, 1.4, darkMetal, x, y + 1.6, z);
      c.cy(0.95, 0.95, 1.8, tankMat, x, y + 2.5, z, undefined, 14);
      c.cy(0, 1.0, 0.6, M('#5a4030', { rough: 0.9 }), x, y + 3.7, z, undefined, 14);
      for (const k of [0.6, 1.4, 2.2]) c.cy(0.97, 0.97, 0.06, darkMetal, x, y + 1.6 + k, z, undefined, 14);
    };
    const antenna = (x: number, z: number, y: number, ht: number) => {
      c.cy(0.07, 0.1, ht, steelDark, x, y + ht / 2, z, undefined, 6);
      c.bx(0.9, 0.05, 0.05, steelDark, x, y + ht * 0.7, z);
      c.bx(0.05, 0.05, 0.6, steelDark, x, y + ht * 0.55, z);
      c.put(sphG(0.17), redBeacon, x, y + ht + 0.12, z);
    };

    // ---- цокольный этаж: витрины, козырьки, входы ----
    const gfBase = (w: number, d: number) => c.bx(w, GF_H, d, M('#8b8f94', { rough: 0.9 }), 0, GF_H / 2, 0);
    const shopfronts = (w: number, d: number, awnings: boolean) => {
      const sv = Math.floor(hash2(b.x * 0.9, b.z * 1.3) * SHOP_SIGN_COLORS.length);
      SIDES.forEach((side, si) => {
        const len = side === 'pz' || side === 'nz' ? w : d;
        if (len < 5) return;
        const sw = len - 1.4;
        const o = onSide(side, w, d, 0, 0.025);
        const n = Math.max(1, Math.round(sw / 8));
        c.put(planeG(sw, 3.1), shopMat((sv + si) % SHOP_SIGN_COLORS.length, n), o.x, 1.55, o.z, { ry: o.ry });
        if (awnings && si < 2) {
          const col = SHOP_SIGN_COLORS[(sv + si) % SHOP_SIGN_COLORS.length];
          const stripes = Math.max(4, Math.round(sw / 0.7));
          const sl = sw / stripes;
          for (let k = 0; k < stripes; k++) {
            const lat = -sw / 2 + sl * (k + 0.5);
            const p2 = onSide(side, w, d, lat, 0.4);
            c.bx(sl, 0.04, 0.9, k % 2 ? M('#f1f0ea') : M(col, { rough: 0.8 }), p2.x, 3.28, p2.z, { ry: p2.ry, rx: 0.28 });
          }
        }
      });
    };

    if (style === 'stepped') {
      const t0 = h * 0.5;
      const t1 = h * 0.78;
      gfBase(sx, sz);
      shopfronts(sx, sz, true);
      wallFaces(sx, sz, GF_H, t0);
      cornice(sx, sz, GF_H, 0.3);
      cornice(sx, sz, t0, 0.35, 0.18);
      roofTop(sx, sz, t0);
      const i1 = 1.0;
      wallFaces(sx - 2 * i1, sz - 2 * i1, t0, t1);
      cornice(sx - 2 * i1, sz - 2 * i1, t1, 0.35, 0.18);
      roofTop(sx - 2 * i1, sz - 2 * i1, t1);
      const i2 = 2.2;
      const w2 = sx - 2 * i2;
      const d2 = sz - 2 * i2;
      wallFaces(w2, d2, t1, h);
      cornice(w2, d2, h, 0.4, 0.2);
      parapet(w2, d2, h + 0.1, 0.5);
      roofTop(w2, d2, h);
      acRow(-w2 * 0.2, 0, 2, 'z', h);
      c.bx(2.2, 1.6, 2.0, trimMat, w2 * 0.15, h + 0.8, -d2 * 0.15);
      antenna(w2 * 0.28, d2 * 0.25, h + 0.1, 6);
      c.bx(sx - 2 * i1 + 0.05, 0.12, sz - 2 * i1 + 0.05, accMat, 0, t1 - 0.4, 0);
      c.bx(w2 - 0.1, 0.12, d2 - 0.1, accMat, 0, h - 0.5, 0);
    } else if (style === 'glass') {
      gfBase(sx, sz);
      shopfronts(sx, sz, false);
      const sideE: Side = sx >= sz ? 'pz' : 'px';
      const lenE = sx >= sz ? sx : sz;
      const o = onSide(sideE, sx, sz, 0, 0.55);
      c.bx(Math.min(5, lenE - 2), 0.12, 1.1, M('#9ec9e0', { rough: 0.1, opacity: 0.5 }), o.x, 3.35, o.z, { ry: o.ry });
      for (const lat of [-1, 1]) {
        const p2 = onSide(sideE, sx, sz, lat * Math.min(2.3, lenE / 2 - 1), 1.05);
        c.cy(0.05, 0.05, 3.3, steelDark, p2.x, 1.65, p2.z, undefined, 6);
      }
      wallFaces(sx, sz, GF_H, h);
      cornice(sx, sz, GF_H, 0.25, 0.08);
      for (const [kx, kz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
        c.bx(0.34, h - GF_H, 0.34, steelDark, kx * (sx / 2), (h + GF_H) / 2, kz * (sz / 2));
      roofTop(sx, sz, h);
      parapet(sx, sz, h, 0.5);
      const pw = sx - 3.2;
      const pd = sz - 3.2;
      const phh = 3.4;
      wallFaces(pw, pd, h, h + phh);
      cornice(pw, pd, h + phh + 0.1, 0.25, 0.3);
      roofTop(pw, pd, h + phh);
      acRow(pw * 0.1, 0, 2, 'x', h + phh);
      antenna(-pw * 0.3, pd * 0.25, h + phh, 5);
      c.bx(sx * 0.7, 0.16, 0.1, accMat, 0, h - 0.9, sz / 2 + 0.04);
    } else if (style === 'gable') {
      const short = Math.min(sx, sz);
      const rh = Math.min(short * 0.36, 5.5);
      const wh = h - rh;
      const alongX = sx >= sz;
      gfBase(sx, sz);
      shopfronts(sx, sz, true);
      wallFaces(sx, sz, GF_H, wh);
      cornice(sx, sz, GF_H, 0.28, 0.1);
      cornice(sx, sz, wh, 0.3, 0.32);
      const L = alongX ? sx : sz;
      const Wd = alongX ? sz : sx;
      const ov = 0.35;
      const rg = G(`gable${(L + 2 * ov).toFixed(2)}|${(Wd + 0.8).toFixed(2)}|${rh.toFixed(2)}`, () =>
        roofSlopes(L + 2 * ov, Wd + 0.8, rh),
      );
      const roofM =
        hv < 0.5
          ? roofMat('tile')
          : texMat('slateroof', () => new THREE.MeshStandardMaterial({ color: '#5b6068', map: roofTex.tar, roughness: 0.85, side: THREE.DoubleSide }));
      c.put(rg, roofM, 0, wh + 0.02, 0, { ry: alongX ? 0 : HALF_PI });
      const gt = G(`gabletri${Wd.toFixed(2)}|${rh.toFixed(2)}`, () => triangleG(Wd, rh));
      const gm = M(wallColor, { rough: 0.9 });
      for (const sgn of [-1, 1]) {
        const ry = alongX ? sgn * HALF_PI : sgn > 0 ? 0 : Math.PI;
        c.put(gt, gm, alongX ? sgn * (L / 2 + 0.01) : 0, wh, alongX ? 0 : sgn * (L / 2 + 0.01), { ry });
        c.put(
          G('gvent', () => new THREE.CircleGeometry(0.5, 14)),
          M('#2a323c', { rough: 0.4 }),
          alongX ? sgn * (L / 2 + 0.04) : 0,
          wh + rh * 0.32,
          alongX ? 0 : sgn * (L / 2 + 0.04),
          { ry },
        );
      }
      c.bx(alongX ? L + 2 * ov : 0.3, 0.2, alongX ? 0.3 : L + 2 * ov, trimMat, 0, wh + rh + 0.02, 0);
      const brickM = M('#8a4b3a', { rough: 0.9 });
      const nCh = 1 + (rnd() < 0.5 ? 1 : 0);
      for (let i = 0; i < nCh; i++) {
        const off = (i === 0 ? -0.28 : 0.3) * L;
        const cx = alongX ? off : Wd * 0.14;
        const cz = alongX ? Wd * 0.14 : off;
        c.bx(0.8, 2.2, 0.8, brickM, cx, wh + rh * 0.55 + 0.6, cz);
        c.bx(1.0, 0.14, 1.0, trimMat, cx, wh + rh * 0.55 + 1.75, cz);
      }
      const dormerGlass = M('#6f93ab', { rough: 0.2 });
      for (const sgn of [-1, 1]) {
        for (const t of [-0.22, 0.2]) {
          const lat = t * L;
          const zz = sgn * Wd * 0.2;
          const yy = wh + rh * 0.4 + 0.45;
          const ry2 = alongX ? (sgn > 0 ? 0 : Math.PI) : sgn > 0 ? HALF_PI : -HALF_PI;
          const dx = (k: number) => (alongX ? lat : zz + sgn * k);
          const dz = (k: number) => (alongX ? zz + sgn * k : lat);
          c.bx(1.3, 1.3, 0.1, gm, dx(0.5), yy, dz(0.5), { ry: ry2 });
          c.bx(1.0, 0.95, 0.12, dormerGlass, dx(0.52), yy - 0.05, dz(0.52), { ry: ry2 });
          c.bx(1.5, 0.12, 0.5, M('#40454d'), dx(0.3), yy + 0.7, dz(0.3), { ry: ry2 });
        }
      }
    } else if (style === 'tower') {
      const t1 = h * 0.86;
      gfBase(sx, sz);
      shopfronts(sx, sz, true);
      wallFaces(sx, sz, GF_H, t1);
      cornice(sx, sz, GF_H, 0.3);
      cornice(sx, sz, t1, 0.5, 0.2);
      roofTop(sx, sz, t1);
      parapet(sx, sz, t1 + 0.02, 0.5);
      const iw = 1.4;
      const cw = sx - 2 * iw;
      const cd = sz - 2 * iw;
      wallFaces(cw, cd, t1, h, (len, ht) =>
        facadeMat('glass', 0, Math.max(1, Math.round(len / FLOOR_H)), Math.max(1, Math.round(ht / FLOOR_H))),
      );
      cornice(cw, cd, h, 0.3, 0.12);
      roofTop(cw, cd, h);
      c.bx(cw + 0.3, 0.18, cd + 0.3, accMat, 0, t1 + 0.4, 0);
      acRow(0, -cd * 0.2, 2, 'x', h);
      antenna(cw * 0.25, cd * 0.2, h, 9);
      c.bx(1.4, 1.2, 1.4, trimMat, -cw * 0.2, h + 0.6, cd * 0.2);
    } else {
      gfBase(sx, sz);
      shopfronts(sx, sz, true);
      wallFaces(sx, sz, GF_H, h);
      cornice(sx, sz, GF_H, 0.3);
      cornice(sx, sz, h - 0.3, 0.25, 0.1);
      roofTop(sx, sz, h);
      parapet(sx, sz, h, 0.7);
      acRow(-sx * 0.2, -sz * 0.15, 2 + Math.floor(rnd() * 2), 'x', h);
      c.bx(2.6, 2.4, 2.2, trimMat, sx * 0.16, h + 1.2, sz * 0.14);
      c.bx(2.8, 0.12, 2.4, steelDark, sx * 0.16, h + 2.45, sz * 0.14);
      if (rnd() < 0.6) waterTank(-sx * 0.18, sz * 0.2, h);
      antenna(sx * 0.3, -sz * 0.28, h, 4.5);
      c.bx(sx * 0.6, 0.16, 0.1, accMat, 0, h - 1.0, sz / 2 + 0.04);
    }
    c.flush(g);
    group.add(g);
  }

  // ==========================================================================
  // АВТОМОБИЛИ (локальная ось X — вперёд; длинная сторона коллайдера)
  // ==========================================================================
  const CAR_PAINT = ['#c0392b', '#2c5aa0', '#d9d9d6', '#2f3a45', '#7a1f2b', '#3f7d58', '#c9a227', '#6b7280'];

  function wheelSet(c: Collector, x: number, half: number, r: number, w: number, dual = false) {
    const rim = M('#c5cbd2', { rough: 0.3, metal: 0.3 });
    for (const s of [-1, 1]) {
      const z = s * (half - w / 2 + 0.01);
      c.put(discG(r, w, 18), rubber, x, r, z);
      if (dual) c.put(discG(r, w, 18), rubber, x, r, z - s * (w + 0.03));
      // слои диска разнесены на ~1 см: более тонкие зазоры издалека мерцают
      c.put(discG(r * 0.62, w + 0.02, 14), rim, x, r, z + s * 0.01);
      c.put(discG(r * 0.22, w + 0.052, 8), steelDark, x, r, z + s * 0.01);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        c.put(boxG(0.03, r * 0.34, 0.012), steelDark, x + Math.cos(a) * r * 0.38, r + Math.sin(a) * r * 0.38, z + s * (w / 2 + 0.025), { rz: a - HALF_PI });
      }
      // арка колеса
      c.put(discG(r * 1.18, 0.02, 18), M('#0c0d10', { rough: 1 }), x, r, s * (half + 0.008));
    }
  }

  function carLights(c: Collector, L: number, half: number, yHead: number, yTail: number, hw = 0.3) {
    for (const s of [-1, 1]) {
      c.bx(0.05, 0.11, hw, headMat, L / 2 + 0.005, yHead, s * half * 0.72);
      c.bx(0.05, 0.1, hw * 0.9, tailMat, -L / 2 - 0.005, yTail, s * half * 0.72);
    }
  }
  function carPlates(c: Collector, L: number, yF: number, yR: number) {
    c.put(planeG(0.5, 0.12), plateMat, L / 2 + 0.012, yF, 0, { ry: HALF_PI });
    c.put(planeG(0.5, 0.12), plateMat, -L / 2 - 0.012, yR, 0, { ry: -HALF_PI });
  }
  function mirrors(c: Collector, x: number, y: number, half: number, paint: THREE.Material) {
    for (const s of [-1, 1]) {
      c.bx(0.06, 0.1, 0.14, paint, x, y, s * (half + 0.07));
      c.bx(0.03, 0.03, 0.1, steelDark, x, y - 0.06, s * (half + 0.02));
    }
  }

  function buildCar(b: BoxObstacle) {
    const alongX = b.halfX >= b.halfZ;
    const L = 2 * Math.max(b.halfX, b.halfZ);
    const W = 2 * Math.min(b.halfX, b.halfZ);
    const v = b.variant ?? 'sedan';
    // правостороннее движение: по полосе машины смотрят «вперёд» по ходу
    const faceNeg = alongX ? b.z < 0 : b.x > 0;
    const yaw = b.rotY ?? (alongX ? (faceNeg ? Math.PI : 0) : faceNeg ? HALF_PI : -HALF_PI);
    const dirx = Math.cos(yaw);
    const dirz = -Math.sin(yaw);
    const gF = ctx.ground(b.x + dirx * L * 0.35, b.z + dirz * L * 0.35);
    const gR = ctx.ground(b.x - dirx * L * 0.35, b.z - dirz * L * 0.35);
    const g = new THREE.Group();
    g.rotation.order = 'YZX';
    g.position.set(b.x, (gF + gR) / 2, b.z);
    g.userData.cb = [b.x, b.z, b.halfX, b.halfZ, b.kind, b.variant ?? b.style ?? ''];
    g.rotation.y = yaw;
    g.rotation.z = Math.atan2(gF - gR, L * 0.7);
    const c = collector();

    const palette = b.color ?? CAR_PAINT[Math.floor(hash2(b.x, b.z) * CAR_PAINT.length)];
    const paint = M(palette, { rough: 0.32, metal: 0.12 });
    const bodyW = W * 0.92;
    const half = bodyW / 2;
    const h = b.h;
    const cc = v === 'bus' || v === 'truck' ? 0.34 : 0.22;
    const bumper = M('#2d3036', { rough: 0.7 });

    if (v === 'bus') {
      const bh = h - 0.04;
      const wr = 0.5;
      c.bx(L, bh - cc, bodyW, paint, 0, cc + (bh - cc) / 2, 0);
      c.bx(L + 0.02, 0.9, bodyW * 0.985, M('#f1f5f9', { rough: 0.5 }), 0, bh - 0.435, 0); // белая крыша-кант, чуть выше кузова, чтобы грани не совпадали
      c.bx(L + 0.02, 0.14, bodyW + 0.02, M('#f8fafc'), 0, 0.85, 0);
      // окна
      const winY0 = 1.15;
      const winY1 = bh - 0.5;
      const winH = winY1 - winY0;
      const doors = [L * 0.33, -L * 0.04];
      const n = Math.floor((L - 1.0) / 1.25);
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + 0.55 + (i + 0.5) * ((L - 1.1) / n);
        if (doors.some((d) => Math.abs(x - d) < 1.0)) continue;
        for (const s of [-1, 1]) c.bx((L - 1.1) / n - 0.16, winH, 0.03, carGlass, x, winY0 + winH / 2, s * (half + 0.005));
      }
      for (const dx of doors)
        for (const s of [-1, 1]) {
          c.bx(1.4, winH + 0.9, 0.04, M('#222831', { rough: 0.4 }), dx, 0.35 + (winH + 0.9) / 2 + 0.1, s * (half + 0.006));
          c.bx(1.28, winH + 0.75, 0.05, carGlass, dx, 0.5 + (winH + 0.75) / 2 + 0.02, s * (half + 0.01));
          c.bx(0.03, winH + 0.75, 0.06, steelDark, dx, 0.5 + (winH + 0.75) / 2 + 0.02, s * (half + 0.012));
        }
      // лобовое / заднее стекло и табло
      c.bx(0.03, 1.75, bodyW * 0.88, carGlass, L / 2 + 0.006, 1.2 + 0.875, 0);
      c.bx(0.03, 1.3, bodyW * 0.8, carGlass, -L / 2 - 0.006, 1.2 + 0.65, 0);
      c.bx(0.04, 0.3, bodyW * 0.6, amberMat, L / 2 + 0.01, bh - 0.18, 0);
      c.bx(0.03, 0.16, 1.1, amberMat, -L / 2 - 0.01, bh - 0.18, 0);
      // крышные кондиционеры
      c.bx(L * 0.28, 0.26, bodyW * 0.62, M('#d5d9de', { rough: 0.6 }), -L * 0.12, bh + 0.13, 0);
      c.bx(L * 0.12, 0.2, bodyW * 0.5, M('#d5d9de', { rough: 0.6 }), L * 0.28, bh + 0.1, 0);
      c.bx(0.2, 0.12, bodyW + 0.02, bumper, L / 2 - 0.05, 0.5, 0);
      c.bx(0.2, 0.12, bodyW + 0.02, bumper, -L / 2 + 0.05, 0.5, 0);
      c.bx(0.1, bh * 0.0 + 0.5, bodyW, bumper, L / 2 + 0.02, 0.35, 0);
      carLights(c, L, half, 0.62, 0.7, 0.36);
      carPlates(c, L, 0.5, 0.5);
      mirrors(c, L / 2 - 0.2, bh - 1.1, half + 0.05, steelDark);
      wheelSet(c, L * 0.3, half, wr, 0.3);
      wheelSet(c, -L * 0.3, half, wr, 0.3, true);
      c.bx(L * 0.94, 0.12, bodyW * 0.9, steelDark, 0, cc - 0.02, 0);
    } else if (v === 'truck') {
      const wr = 0.5;
      const cabL = L * 0.27;
      const boxL = L - cabL - 0.2;
      const cabX = L / 2 - cabL / 2;
      const cabH = Math.min(h * 0.74, 2.6);
      c.bx(L * 0.97, 0.36, bodyW * 0.8, steelDark, 0, cc + 0.2, 0); // рама
      // кабина с наклонным капотом/стеклом
      c.put(
        extrudeProfile([[-cabL / 2, 0], [cabL / 2, 0], [cabL / 2, cabH * 0.5], [cabL / 2 - 0.35, cabH], [-cabL / 2, cabH]], bodyW),
        paint,
        cabX,
        cc + 0.25,
        0,
      );
      c.put(G(`wstruck${cabH.toFixed(2)}|${bodyW.toFixed(2)}`, () => new THREE.PlaneGeometry(Math.hypot(0.35, cabH * 0.5) - 0.1, bodyW * 0.84).rotateX(-HALF_PI)), carGlass, cabX + cabL / 2 - 0.16, cc + 0.25 + cabH * 0.75 + 0.01, 0, { rz: Math.atan2(-cabH * 0.5, 0.35) });
      for (const s of [-1, 1]) c.bx(cabL * 0.5, cabH * 0.38, 0.03, carGlass, cabX - 0.05, cc + 0.25 + cabH * 0.66, s * (half + 0.006));
      // кузов-фургон
      const bxH = h - (cc + 0.35);
      c.bx(boxL, bxH, bodyW, M('#e8e6df', { rough: 0.7 }), -L / 2 + boxL / 2, cc + 0.35 + bxH / 2, 0);
      for (const s of [-1, 1]) {
        c.bx(boxL, 0.3, 0.02, paint, -L / 2 + boxL / 2, cc + 0.35 + bxH * 0.35, s * (half + 0.006));
        for (let k = 1; k < 6; k++) c.bx(0.03, bxH, 0.02, M('#b8b6ae'), -L / 2 + (boxL / 6) * k, cc + 0.35 + bxH / 2, s * (half + 0.005));
      }
      c.bx(0.03, bxH * 0.9, bodyW * 0.96, M('#cfcdc5'), -L / 2 - 0.006, cc + 0.35 + bxH / 2, 0);
      c.bx(0.04, bxH * 0.9, 0.03, steelDark, -L / 2 - 0.016, cc + 0.35 + bxH / 2, 0);
      c.bx(0.12, 0.2, bodyW, bumper, L / 2 + 0.02, cc + 0.2, 0);
      c.bx(0.1, 0.22, bodyW * 0.9, bumper, -L / 2 - 0.02, cc + 0.2, 0);
      carLights(c, L, half, cc + 0.6, cc + 0.55, 0.28);
      carPlates(c, L, cc + 0.2, cc + 0.2);
      mirrors(c, cabX + cabL / 2 - 0.35, cc + 0.25 + cabH * 0.7, half + 0.05, steelDark);
      wheelSet(c, L * 0.38, half, wr, 0.3);
      wheelSet(c, -L * 0.27, half, wr, 0.3, true);
    } else if (v === 'van') {
      const wr = 0.36;
      c.put(
        extrudeProfile(
          [[-L / 2, cc], [L / 2, cc], [L / 2, h * 0.5], [L * 0.36, h - 0.04], [-L / 2 + 0.05, h - 0.04], [-L / 2, h - 0.16]],
          bodyW,
        ),
        paint,
      );
      const wsLen = Math.hypot(L * 0.14, h * 0.5 - 0.04);
      c.put(
        G(`wsvan${wsLen.toFixed(2)}|${bodyW.toFixed(2)}`, () => new THREE.PlaneGeometry(wsLen - 0.12, bodyW * 0.86).rotateX(-HALF_PI)),
        carGlass,
        L * 0.43,
        (h * 0.5 + h - 0.04) / 2 + 0.01,
        0,
        { rz: -Math.atan2(h * 0.5 - 0.04, L * 0.14) },
      );
      for (const s of [-1, 1]) {
        c.bx(L * 0.17, h * 0.3, 0.03, carGlass, L * 0.33, h * 0.68, s * (half + 0.006));
        c.bx(0.03, h * 0.55, 0.03, steelDark, L * 0.2, h * 0.6, s * (half + 0.01));
        c.bx(L * 0.6, 0.03, 0.03, steelDark, -L * 0.15, h * 0.42, s * (half + 0.006));
      }
      c.bx(0.03, h * 0.45, bodyW * 0.9, steelDark, -L / 2 - 0.006, h * 0.55, 0);
      c.bx(0.03, 0.04, bodyW * 0.9, steelDark, -L / 2 - 0.007, h * 0.55, 0);
      c.bx(0.14, 0.2, bodyW + 0.02, bumper, L / 2 + 0.02, cc + 0.15, 0);
      c.bx(0.1, 0.2, bodyW + 0.02, bumper, -L / 2 - 0.02, cc + 0.15, 0);
      carLights(c, L, half, h * 0.38, h * 0.38, 0.28);
      carPlates(c, L, cc + 0.2, cc + 0.35);
      mirrors(c, L * 0.27, h * 0.66, half, steelDark);
      wheelSet(c, L * 0.3, half, wr, 0.24);
      wheelSet(c, -L * 0.3, half, wr, 0.24);
      c.bx(L * 0.94, 0.1, bodyW * 0.9, steelDark, 0, cc - 0.01, 0);
    } else if (v === 'pickup') {
      const wr = 0.38;
      const belt = h * 0.5;
      const bedFrom = -L / 2;
      const bedTo = -L * 0.1;
      // передняя часть + кабина
      c.put(
        extrudeProfile([[bedTo, cc], [L / 2, cc], [L / 2, belt - 0.2], [L / 2 - 0.12, belt - 0.02], [L * 0.2, belt], [bedTo, belt]], bodyW),
        paint,
      );
      c.put(extrudeProfile([[-0.1 * L, belt], [-0.02 * L, h], [L * 0.1, h], [L * 0.22, belt]], bodyW * 0.9), carGlass);
      c.bx(L * 0.12 + 0.02, 0.05, bodyW * 0.92, paint, L * 0.04, h + 0.015, 0);
      // кузов
      // дно и тент короче и уже бортов: совпадающие с бортами грани мерцали
      c.bx(bedTo - bedFrom - 0.04, 0.1, bodyW - 0.04, steelDark, (bedFrom + bedTo) / 2, cc + 0.18, 0);
      c.bx(bedTo - bedFrom - 0.04, 0.1, bodyW * 0.9, M('#3a3d42'), (bedFrom + bedTo) / 2, belt - 0.12, 0);
      for (const s of [-1, 1]) c.bx(bedTo - bedFrom, belt - cc - 0.15, 0.07, paint, (bedFrom + bedTo) / 2, (cc + 0.18 + belt) / 2 - 0.02, s * (half - 0.035));
      c.bx(0.07, belt - cc - 0.15, bodyW, paint, bedFrom + 0.035, (cc + 0.18 + belt) / 2 - 0.02, 0);
      c.bx(0.1, 0.2, bodyW + 0.02, bumper, L / 2 + 0.02, cc + 0.15, 0);
      c.bx(0.1, 0.16, bodyW, bumper, -L / 2 - 0.02, cc + 0.12, 0);
      carLights(c, L, half, belt - 0.2, belt - 0.2, 0.26);
      carPlates(c, L, cc + 0.3, cc + 0.35);
      mirrors(c, L * 0.14, belt + 0.14, half, paint);
      wheelSet(c, L * 0.3, half, wr, 0.26);
      wheelSet(c, -L * 0.28, half, wr, 0.26);
    } else {
      // sedan / hatch / taxi
      const wr = 0.33;
      const belt = h * 0.54;
      const hatch = v === 'hatch';
      const noseT = belt - 0.04;
      c.put(
        extrudeProfile(
          [
            [-L / 2, cc + 0.03],
            [L / 2, cc + 0.03],
            [L / 2 + 0.01, belt - 0.22],
            [L / 2 - 0.14, noseT],
            [L * 0.2, belt],
            [-L * 0.3, belt],
            [-L / 2 + (hatch ? 0.04 : 0.1), belt - (hatch ? 0.02 : 0.05)],
            [-L / 2, belt - 0.2],
          ],
          bodyW,
        ),
        paint,
      );
      const cab: [number, number][] = hatch
        ? [[-L * 0.4, belt], [-L * 0.36, h], [L * 0.06, h], [L * 0.22, belt]]
        : [[-L * 0.3, belt], [-L * 0.2, h], [L * 0.06, h], [L * 0.22, belt]];
      c.put(extrudeProfile(cab, bodyW * 0.88), carGlass);
      const rx0 = cab[1][0];
      c.bx(L * 0.06 - rx0 + 0.04, 0.05, bodyW * 0.9, paint, (rx0 + L * 0.06) / 2, h + 0.015, 0);
      for (const s of [-1, 1]) {
        c.bx(0.07, h - belt, 0.02, paint, -L * 0.03, (h + belt) / 2, s * (bodyW * 0.44 + 0.012));
        c.bx(0.07, h - belt, 0.02, paint, hatch ? -L * 0.37 : -L * 0.22, (h + belt) / 2 + 0.01, s * (bodyW * 0.44 + 0.012), { rz: 0.4 });
        c.bx(0.02, 0.2, 0.01, steelDark, -L * 0.1, belt - 0.14, s * (half + 0.005));
        c.bx(0.02, 0.2, 0.01, steelDark, L * 0.08, belt - 0.14, s * (half + 0.005));
      }
      c.bx(0.08, 0.16, bodyW + 0.02, bumper, L / 2 + 0.01, cc + 0.16, 0);
      c.bx(0.08, 0.16, bodyW + 0.02, bumper, -L / 2 - 0.01, cc + 0.16, 0);
      c.bx(0.03, 0.09, bodyW * 0.45, steelDark, L / 2 + 0.002, belt - 0.32, 0);
      carLights(c, L, half, belt - 0.2, belt - 0.2, 0.3);
      carPlates(c, L, cc + 0.28, cc + 0.28);
      mirrors(c, L * 0.17, belt + 0.1, half, paint);
      wheelSet(c, L * 0.31, half, wr, 0.2);
      wheelSet(c, -L * 0.31, half, wr, 0.2);
      c.bx(L * 0.92, 0.08, bodyW * 0.9, steelDark, 0, cc, 0);
      if (v === 'taxi') {
        c.bx(0.5, 0.17, 0.24, amberMat, -L * 0.07, h + 0.12, 0);
        c.bx(0.5, 0.025, 0.26, steelDark, -L * 0.07, h + 0.03, 0);
        for (let k = 0; k < 14; k++)
          for (const s of [-1, 1])
            if (k % 2 === 0) c.bx(0.16, 0.08, 0.012, M('#111111'), -L * 0.42 + k * 0.16 + 0.08, belt - 0.12, s * (half + 0.007));
      }
    }
    c.flush(g);
    group.add(g);
  }

  // ==========================================================================
  // УЛИЧНАЯ МЕБЕЛЬ И МЕЛКИЕ ОБЪЕКТЫ-БОКСЫ
  // ==========================================================================
  const sgn0 = (v: number) => (v < 0 ? -1 : 1);

  /** локальная ось X — вдоль длинной стороны коллайдера; hi/lo — перепад земли под боксом */
  function oriented(b: BoxObstacle) {
    const alongX = b.halfX >= b.halfZ;
    const lx = Math.max(b.halfX, b.halfZ);
    const lz = Math.min(b.halfX, b.halfZ);
    const sx = lx * 0.9;
    const sz = lz * 0.9;
    const pts = [
      worldOf(b),
      ctx.ground(b.x - b.halfX * 0.9, b.z - b.halfZ * 0.9),
      ctx.ground(b.x + b.halfX * 0.9, b.z - b.halfZ * 0.9),
      ctx.ground(b.x - b.halfX * 0.9, b.z + b.halfZ * 0.9),
      ctx.ground(b.x + b.halfX * 0.9, b.z + b.halfZ * 0.9),
    ];
    void sx;
    void sz;
    const hi = Math.max(...pts);
    const lo = Math.min(...pts);
    const g = new THREE.Group();
    g.position.set(b.x, hi, b.z);
    g.userData.cb = [b.x, b.z, b.halfX, b.halfZ, b.kind, b.variant ?? b.style ?? ''];
    g.rotation.y = alongX ? 0 : HALF_PI;
    // «спина» объекта — в сторону от ближайшей оси улицы
    const back = alongX ? sgn0(b.z) : sgn0(b.x);
    return { g, lx, lz, alongX, hi, lo, sink: hi - lo + 0.25, back, c: collector() };
  }
  const finishObj = (o: { g: THREE.Group; c: Collector }, shadow = true) => {
    o.c.flush(o.g, shadow);
    group.add(o.g);
  };

  function buildBench(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz, back } = o;
    const wm = woodMat(b.color ?? '#8a5a35');
    const iron = M('#262b31', { rough: 0.5, metal: 0.3 });
    const L = lx * 2 - 0.1;
    const seatY = 0.46;
    for (let i = 0; i < 3; i++) c.bx(L, 0.045, lz * 0.55, wm, 0, seatY + 0.02, -back * lz * 0.55 + back * (i * lz * 0.5 - lz * 0.35) * 0.0 + (i - 1) * lz * 0.55 * 0.5 * -back * -1);
    for (let i = 0; i < 3; i++) c.bx(L, 0.07, 0.03, wm, 0, 0.62 + i * 0.1, back * lz * 0.78, { rx: back * -0.22 });
    for (const s of [-1, 1]) {
      const x = s * (lx - 0.18);
      c.bx(0.05, 0.05, lz * 1.7, iron, x, seatY - 0.04, 0);
      c.bx(0.05, seatY - 0.04, 0.05, iron, x, (seatY - 0.04) / 2, -back * lz * 0.78);
      c.bx(0.05, seatY - 0.04, 0.05, iron, x, (seatY - 0.04) / 2, back * lz * 0.6);
      c.bx(0.05, o.sink + 0.05, 0.08, iron, x, -o.sink / 2 + 0.02, -back * lz * 0.78);
      c.bx(0.05, 0.42, 0.05, iron, x, 0.68, back * lz * 0.78, { rx: back * -0.22 });
      c.bx(0.06, 0.04, lz * 1.2, iron, x + s * 0.02, 0.66, 0);
      c.bx(0.05, 0.2, 0.05, iron, x + s * 0.02, 0.56, -back * lz * 0.5);
    }
    finishObj(o);
  }

  function buildBusstop(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz, back } = o;
    const frame = M('#cfd3d8', { rough: 0.35, metal: 0.3 });
    const L = lx * 2;
    const D = lz * 2;
    const roofY = Math.min(b.h, 2.55) - 0.08;
    const pad = concMat('#b2b0aa');
    c.bx(L, 0.14 + o.sink, D, M('#9b9a95'), 0, 0.07 - o.sink / 2, 0);
    c.put(floorG(L, D, L / 2, D / 2), pad, 0, 0.145, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.cy(0.04, 0.04, roofY - 0.14, frame, sx * (lx - 0.1), 0.14 + (roofY - 0.14) / 2, sz * (lz - 0.07), undefined, 8);
    // крыша
    c.bx(L, 0.1, D, M('#e8eaed', { rough: 0.5 }), 0, roofY + 0.05, 0);
    // кант выступает из торца крыши: совпадающие грани мерцали
    c.bx(L - 0.04, 0.07, 0.1, M(b.accent ?? '#ff6a13'), 0, roofY + 0.02, -back * (lz - 0.035));
    c.bx(L - 0.06, 0.08, 0.06, M(b.accent ?? '#ff6a13'), 0, roofY - 0.04, -back * 0 + back * (lz - 0.03) * -1);
    // стёкла: задняя и торцевые панели
    const gH = roofY - 0.3;
    c.bx(L - 0.2, gH, 0.03, tintGlass, 0, 0.18 + gH / 2, back * (lz - 0.07));
    c.bx(0.03, gH, D - 0.18, tintGlass, -(lx - 0.1), 0.18 + gH / 2, 0);
    c.bx(L - 0.2, 0.03, 0.05, frame, 0, 0.18, back * (lz - 0.07));
    c.bx(L - 0.2, 0.03, 0.05, frame, 0, 0.18 + gH, back * (lz - 0.07));
    // скамья внутри
    const wm = woodMat('#8a5a35');
    c.bx(L * 0.55, 0.05, 0.38, wm, -L * 0.08, 0.5, back * (lz - 0.45));
    c.bx(0.05, 0.36, 0.3, steelDark, -L * 0.08 - L * 0.24, 0.32, back * (lz - 0.45));
    c.bx(0.05, 0.36, 0.3, steelDark, -L * 0.08 + L * 0.24, 0.32, back * (lz - 0.45));
    // афиша-лайтбокс на торце
    const adM = texMat('busad', () => {
      const m = new THREE.MeshStandardMaterial({ map: track(adTexture(1, 256, 384)), roughness: 0.4, emissive: new THREE.Color('#ffffff') });
      m.emissiveMap = m.map;
      night(m, 0.8, 0.35);
      return m;
    });
    c.bx(0.08, 1.7, 0.95, steelDark, lx - 0.06, 0.15 + 0.9, 0);
    c.put(planeG(0.9, 1.6), adM, lx - 0.115, 0.15 + 0.9, 0, { ry: -HALF_PI });
    // табличка остановки на стойке
    c.cy(0.03, 0.03, 2.6, steel, -lx + 0.02, 1.3, back * (lz + 0.0) * 0 - back * (lz - 0.06) * 0, undefined, 6);
    c.bx(0.4, 0.4, 0.03, M('#1d4ed8'), -lx + 0.02, 2.35, 0);
    c.put(G('bsq', () => new THREE.CircleGeometry(0.12, 12)), M('#ffffff'), -lx + 0.02, 2.35, 0.018);
    c.put(G('bsq', () => new THREE.CircleGeometry(0.12, 12)), M('#ffffff'), -lx + 0.02, 2.35, -0.018, { ry: Math.PI });
    // урна
    c.cy(0.16, 0.14, 0.6, M('#2f3a45', { rough: 0.5, metal: 0.3 }), lx - 0.5, 0.45, back * (lz - 0.3));
    finishObj(o);
  }

  function buildKiosk(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const D = lz * 2;
    const body = M(b.color ?? '#f97316', { rough: 0.6 });
    const acc = M(b.accent ?? '#fed7aa', { rough: 0.6 });
    const h = b.h;
    c.bx(L, 0.18 + o.sink, D, M('#8a8d90'), 0, 0.09 - o.sink / 2, 0);
    const bz = -0.25;
    const bd = D - 0.5;
    c.bx(L - 0.2, h - 0.5, bd, body, 0, 0.18 + (h - 0.5) / 2, bz);
    c.bx(L - 0.14, 0.14, bd + 0.06, acc, 0, 0.4, bz);
    // роль: крыша с козырьком
    c.bx(L, 0.18, D, M('#2f3640', { rough: 0.7 }), 0, h - 0.18, 0);
    c.bx(L, 0.08, D, acc, 0, h - 0.05, 0);
    // окно обслуживания и прилавок
    const front = bz + bd / 2;
    const winW = L * 0.62;
    const lit = glowMat('#ffd9a0', 0.9, 0.5, 0.0);
    c.bx(winW, 1.0, 0.04, M('#1d2733', { rough: 0.2 }), 0, 1.45, front + 0.01);
    c.bx(winW - 0.2, 0.9, 0.05, lit, 0, 1.45, front + 0.012);
    c.bx(winW + 0.2, 0.08, 0.5, M('#e5e7eb', { rough: 0.5 }), 0, 0.95, front + 0.2);
    c.bx(winW + 0.2, 0.9, 0.04, steelDark, 0, 0.5, front + 0.4);
    // полосатый тент
    const n = 8;
    for (let k = 0; k < n; k++) {
      const x = -L / 2 + (L / n) * (k + 0.5);
      c.bx(L / n, 0.04, 0.62, k % 2 ? M('#f8fafc') : acc, x, 2.3, front + 0.26, { rx: 0.32 });
    }
    // вывеска и товары
    c.bx(L * 0.5, 0.35, 0.05, glowMat(b.accent ?? '#ffedd5', 1.2, 0.5, 0.15), 0, h - 0.5, front + 0.5);
    for (let k = 0; k < 4; k++) c.put(sphG(0.09), M(['#ef4444', '#facc15', '#22c55e', '#38bdf8'][k]), -winW / 2 + 0.5 + k * 0.4, 1.04, front + 0.22);
    c.bx(0.8, 1.8, 0.05, steelDark, -L / 2 + 0.55, 1.1, bz - bd / 2 - 0.01);
    c.bx(0.7, 0.35, 0.5, M('#aeb4ba'), L / 2 - 0.6, h + 0.12, bz - 0.2);
    finishObj(o);
  }

  function buildContainer(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const W = lz * 2;
    const frame = M('#2a2f36', { rough: 0.6, metal: 0.2 });
    if (b.variant === 'cabin') {
      const h = b.h;
      const body = M(b.color ?? '#e5e7eb', { rough: 0.6 });
      c.bx(L, 0.3 + o.sink, W, steelDark, 0, 0.15 - o.sink / 2, 0);
      c.bx(L - 0.04, h - 0.45, W - 0.04, body, 0, 0.3 + (h - 0.45) / 2, 0);
      c.bx(L + 0.1, 0.16, W + 0.1, M('#cbd0d6'), 0, h - 0.08, 0);
      const wm = M('#27465f', { rough: 0.15 });
      for (const s of [-1, 1]) {
        for (const x of [-L * 0.28, L * 0.1]) {
          c.bx(1.1, 0.9, 0.04, M('#f4f4f4'), x, 1.65, s * (W / 2 + 0.005));
          c.bx(0.95, 0.75, 0.05, wm, x, 1.65, s * (W / 2 + 0.01));
          c.bx(1.1, 0.06, 0.12, M('#f4f4f4'), x, 1.15, s * (W / 2 + 0.06));
        }
        c.bx(0.9, 1.9, 0.05, M('#6b4a2e'), L * 0.38, 0.3 + 0.95, s === 1 ? W / 2 + 0.012 : -W / 2 - 0.012);
      }
      c.bx(0.8, 0.12, 0.35, steelDark, L * 0.38, 0.2, W / 2 + 0.17);
      c.bx(0.9, 0.5, 0.7, acUnitMat, -L * 0.2, h + 0.25, 0);
      finishObj(o);
      return;
    }
    const levels = Math.max(1, Math.round(b.h / 2.6));
    const ch = b.h / levels;
    for (let lv = 0; lv < levels; lv++) {
      const col = lv === 0 ? (b.color ?? '#c2410c') : new THREE.Color(b.color ?? '#c2410c').offsetHSL(0.18 * lv, 0, 0.02).getStyle();
      const y0 = lv * ch;
      const rib = ribMat(col);
      const hh = ch - 0.14;
      for (const s of [-1, 1]) c.put(planeG(L, hh, L / 2, 1), rib, 0, y0 + 0.07 + hh / 2, s * (W / 2 + 0.002), { ry: s > 0 ? 0 : Math.PI });
      c.put(planeG(W, hh, W / 2, 1), rib, -L / 2 - 0.002, y0 + 0.07 + hh / 2, 0, { ry: -HALF_PI });
      // торец с дверями
      c.bx(0.04, hh, W, M(col, { rough: 0.6 }), L / 2, y0 + 0.07 + hh / 2, 0);
      for (const s of [-1, 1]) {
        c.bx(0.03, hh - 0.2, 0.02, frame, L / 2 + 0.025, y0 + 0.07 + hh / 2, s * 0.02);
        for (const k of [-0.3, 0.3]) c.cy(0.02, 0.02, hh - 0.3, steel, L / 2 + 0.05, y0 + 0.07 + hh / 2, s * (0.42 + (k > 0 ? 0.18 : 0)) * 0.85 + (k > 0 ? 0.05 : -0.05) * s);
      }
      c.bx(L, 0.12, W, M(col, { rough: 0.6 }), 0, y0 + ch - 0.06, 0);
      c.bx(L, 0.14, W, frame, 0, y0 + 0.07, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.bx(0.14, ch, 0.14, frame, sx * (L / 2 - 0.07), y0 + ch / 2, sz * (W / 2 - 0.07));
      c.bx(L - 0.1, 0.1, W - 0.1, steelDark, 0, y0 + ch - 0.01, 0);
    }
    finishObj(o);
  }
  const acUnitMat = M('#aeb4ba', { rough: 0.6, metal: 0.2 });

  function buildDumpster(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const W = lz * 2;
    const h = b.h;
    const col = M(b.color && b.color !== '#9ca3af' ? b.color : '#2f6b46', { rough: 0.55, metal: 0.1 });
    const lid = M('#1c2026', { rough: 0.7 });
    c.bx(L - 0.1, 0.12, W - 0.1, steelDark, 0, 0.18, 0);
    c.put(
      extrudeProfile([[-W / 2, 0], [W / 2, 0], [W / 2 + 0.05, h - 0.35], [-W / 2 - 0.05, h - 0.35]], L - 0.04).rotateY(HALF_PI),
      col,
      0,
      0.24,
      0,
    );
    c.bx(L, 0.07, W + 0.12, M('#d7dbe0', { rough: 0.5 }), 0, h - 0.11, 0);
    for (const s of [-1, 1]) {
      c.bx(L + 0.02, 0.06, W * 0.52, lid, 0, h - 0.05 + (s > 0 ? 0 : 0.03), s * (W * 0.26), { rx: s * 0.1 });
      c.bx(0.1, 0.4, 0.1, steelDark, s * (L / 2 - 0.2), 0.45, 0);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      c.cy(0.07, 0.07, 0.06, rubber, sx * (L / 2 - 0.15), 0.07, sz * (W / 2 - 0.1), { rx: HALF_PI }, 8);
    }
    c.bx(0.5, 0.3, 0.02, M('#f8fafc', { rough: 0.5 }), -L * 0.2, h * 0.55, W / 2 + 0.06);
    c.bx(L * 0.5, 0.08, 0.02, M('#facc15'), L * 0.1, h * 0.35, -W / 2 - 0.06);
    finishObj(o);
  }

  const lathe = (pts: [number, number][], seg = 28) =>
    new THREE.LatheGeometry(
      pts.map(([r, y]) => new THREE.Vector2(r, y)),
      seg,
    );

  function buildFountain(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx } = o;
    const R = lx * 0.88;
    const H = b.h;
    const stone = concMat('#c8c3b9', 0.85);
    const stoneD = M('#a8a399', { rough: 0.9 });
    c.bx(lx * 2, 0.14 + o.sink, lx * 2, stoneD, 0, 0.07 - o.sink / 2, 0);
    c.put(floorG(lx * 2, lx * 2, lx, lx), concMat('#cfcac0'), 0, 0.142, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      c.bx(0.55, 0.6, 0.55, stoneD, sx * (lx - 0.3), 0.14 + 0.3, sz * (lx - 0.3));
      c.bx(0.65, 0.1, 0.65, stoneD, sx * (lx - 0.3), 0.14 + 0.65, sz * (lx - 0.3));
      c.put(sphG(0.13), lampWarm, sx * (lx - 0.3), 0.14 + 0.82, sz * (lx - 0.3));
    }
    const basin = G(`fbasin${R.toFixed(2)}|${H.toFixed(2)}`, () =>
      lathe([[R, 0.14], [R, H], [R - 0.08, H + 0.08], [R - 0.38, H + 0.08], [R - 0.4, H - 0.05], [R - 0.45, 0.3]], 40),
    );
    const stoneDS = texMat(`fstoneDS|${stone.uuid}`, () => new THREE.MeshStandardMaterial({ color: '#c8c3b9', map: concTex, roughness: 0.85, side: THREE.DoubleSide }));
    c.put(basin, stoneDS);
    const water = M('#3fa2d6', { rough: 0.05, metal: 0.1, opacity: 0.72, emissive: '#0b3c5c', emissiveI: 0.2 });
    c.put(G(`fwater${R.toFixed(2)}`, () => new THREE.CircleGeometry(R - 0.42, 40).rotateX(-HALF_PI)), water, 0, H * 0.8, 0);
    c.cy(0.35, 0.5, H + 0.5, stoneDS, 0, H / 2 + 0.3, 0, undefined, 16);
    const bowl1 = G(`fbowl1|${R.toFixed(2)}`, () => lathe([[0.02, 0], [R * 0.2, 0.05], [R * 0.5, 0.3], [R * 0.5 - 0.1, 0.32], [R * 0.2, 0.12], [0.02, 0.12]]));
    c.put(bowl1, stoneDS, 0, H + 0.85, 0);
    c.cy(0.14, 0.2, 1.0, stoneDS, 0, H + 1.35, 0, undefined, 12);
    const bowl2 = G(`fbowl2|${R.toFixed(2)}`, () => lathe([[0.02, 0], [R * 0.1, 0.04], [R * 0.24, 0.2], [R * 0.24 - 0.08, 0.22], [R * 0.1, 0.1], [0.02, 0.1]]));
    c.put(bowl2, stoneDS, 0, H + 1.85, 0);
    c.put(sphG(0.2), M('#d6b04a', { rough: 0.3, metal: 0.3 }), 0, H + 2.15, 0);
    const spray = M('#dff3ff', { rough: 0.1, opacity: 0.55 });
    c.cy(0.02, 0.08, 0.8, spray, 0, H + 2.5, 0, undefined, 8);
    c.put(G(`fveil|${R.toFixed(2)}`, () => new THREE.CylinderGeometry(R * 0.5 - 0.12, R * 0.5 - 0.1, 0.5, 24, 1, true)), M('#cfeaff', { rough: 0.1, opacity: 0.4, side: THREE.DoubleSide }), 0, H + 0.62, 0);
    c.put(G(`fveil2|${R.toFixed(2)}`, () => new THREE.CylinderGeometry(R * 0.24 - 0.1, R * 0.24 - 0.08, 0.7, 20, 1, true)), M('#cfeaff', { rough: 0.1, opacity: 0.4, side: THREE.DoubleSide }), 0, H + 1.45, 0);
    finishObj(o);
  }

  function buildLedge(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const h = b.h;
    if (b.variant === 'rail') {
      const zinc = M('#b4bbc2', { rough: 0.4, metal: 0.35 });
      const n = Math.max(2, Math.round(L / 2));
      for (let i = 0; i <= n; i++) {
        const x = -L / 2 + (L / n) * i;
        c.bx(0.1, h + o.sink - 0.05, 0.1, steelDark, x, (h - 0.05 - o.sink) / 2, 0);
      }
      for (const y of [h - 0.1, h - 0.34]) c.bx(L, 0.2, 0.05, zinc, 0, y, lz * 0.0);
      c.bx(L, 0.04, 0.1, zinc, 0, h + 0.01, 0);
      for (let i = 0; i < n; i++) c.bx(0.05, 0.12, 0.012, M('#ef4444'), -L / 2 + (L / n) * (i + 0.5), h - 0.1, 0.03);
    } else if (b.variant === 'barrier') {
      const W = lz * 2;
      const conc = concMat('#b9b6b0');
      c.put(
        extrudeProfile([[-W / 2, 0], [W / 2, 0], [W * 0.28, h * 0.38], [W * 0.14, h], [-W * 0.14, h], [-W * 0.28, h * 0.38]], L - 0.04).rotateY(HALF_PI),
        conc,
        0,
        -o.sink + 0.2,
        0,
      );
      c.bx(L - 0.04, o.sink - 0.2 + 0.02, W, plinthMat, 0, -o.sink / 2 + 0.1, 0);
      const stripes = Math.max(2, Math.round(L / 0.4));
      for (let i = 0; i < stripes; i++)
        for (const s of [-1, 1]) c.bx(L / stripes, 0.14, 0.02, i % 2 ? M('#facc15') : M('#18181b'), -L / 2 + (L / stripes) * (i + 0.5), h * 0.72, s * (W * 0.2));
    } else {
      const conc = concMat(b.color && b.color !== '#9ca3af' ? b.color : '#b6b3ad');
      c.bx(L, h + o.sink - 0.08, lz * 2 - 0.06, conc, 0, (h - 0.08 - o.sink) / 2, 0);
      c.bx(L + 0.1, 0.08, lz * 2, M('#cbc8c1', { rough: 0.8 }), 0, h - 0.04, 0);
      const n = Math.max(1, Math.floor(L / 2));
      for (let i = 1; i < n; i++) c.bx(0.015, h - 0.1, lz * 2 - 0.05, M('#8d8a84'), -L / 2 + (L / n) * i, h / 2 - 0.04, 0);
    }
    finishObj(o);
  }

  function buildCrane(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const yel = M('#f2b705', { rough: 0.55, metal: 0.1 });
    const grey = M('#59606a', { rough: 0.6 });
    const H = b.h;
    const half = Math.min(lx, lz) * 0.85;
    const seg = 3;
    const nSeg = Math.floor((H - 5) / seg);
    const top = nSeg * seg;
    c.bx(lx * 2, 0.4 + o.sink, lz * 2, M('#7d7f82'), 0, 0.2 - o.sink / 2, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.bx(0.12, top, 0.12, yel, sx * half, top / 2 + 0.4, sz * half);
    const rad = 0.05;
    for (let i = 0; i < nSeg; i++) {
      const y = 0.4 + i * seg;
      for (const sd of [0, 1, 2, 3]) {
        const along = sd < 2;
        const sg = sd % 2 ? -1 : 1;
        const len = Math.hypot(half * 2, seg);
        const ang = Math.atan2(seg, half * 2);
        const flip = i % 2 ? -1 : 1;
        if (along) c.bx(len, rad * 2, rad * 2, yel, 0, y + seg / 2, sg * half, { rz: ang * flip });
        else c.bx(rad * 2, rad * 2, len, yel, sg * half, y + seg / 2, 0, { ry: 0, rx: ang * flip * 1, sz: 1 });
        c.bx(half * 2, rad * 2, rad * 2, yel, 0, y + seg, sg * half * (along ? 1 : 0) + (along ? 0 : 0));
      }
    }
    const ty = top + 0.4;
    // поворотная часть, кабина, стрела
    c.bx(half * 2 + 0.4, 0.5, half * 2 + 0.4, grey, 0, ty + 0.25, 0);
    c.bx(1.4, 1.5, 1.3, yel, half + 0.7, ty + 1.3, 0);
    c.bx(0.04, 0.8, 1.1, M('#2a4d66', { rough: 0.15 }), half + 1.42, ty + 1.45, 0);
    c.bx(0.8, 0.2, 1.5, steelDark, half + 0.7, ty + 2.1, 0);
    // A-образная стойка
    const ah = 5;
    c.bx(0.15, ah, 0.15, yel, -0.6, ty + ah / 2, 0, { rz: -0.2 });
    c.bx(0.15, ah, 0.15, yel, 0.6, ty + ah / 2, 0, { rz: 0.2 });
    const jibL = 28;
    const cjL = 10;
    const jy = ty + ah - 0.4;
    c.bx(jibL, 0.45, 0.45, yel, jibL / 2 - 1, jy, 0);
    c.bx(cjL, 0.4, 0.4, yel, -cjL / 2 - 0.5, jy, 0);
    for (let i = 0; i < 9; i++) {
      const x = 1 + i * 3;
      c.bx(0.06, 0.06, 0.5, yel, x, jy + 0.3, 0);
      c.bx(3.2, 0.06, 0.06, yel, x + 1.5, jy + 0.27, 0.0, { rz: i % 2 ? 0.25 : -0.25 });
    }
    // тросы
    const tipX = jibL - 3;
    for (const k of [0.25, 0.65]) c.bx(Math.hypot(k * tipX, 2.4) * 1, 0.025, 0.025, steelDark, k * tipX * 0.5 + 0.2, jy + 1.4 + (1 - k) * 0.2, 0, { rz: -Math.atan2(2.4, k * tipX) * 0.35 });
    c.bx(1.8, 1.6, 1.0, M('#3b3f45'), -cjL + 1.5, jy - 0.7, 0);
    c.bx(1.8, 1.6, 1.0, M('#3b3f45'), -cjL + 3.5, jy - 0.7, 0);
    // тележка, крюк
    const trolley = 14;
    c.bx(1.0, 0.3, 0.7, steelDark, trolley, jy - 0.35, 0);
    const cable = Math.max(4, top * 0.45);
    c.cy(0.02, 0.02, cable, steelDark, trolley, jy - 0.5 - cable / 2, 0, undefined, 4);
    c.bx(0.5, 0.4, 0.4, yel, trolley, jy - 0.5 - cable - 0.2, 0);
    c.bx(0.1, 0.5, 0.1, steelDark, trolley, jy - 0.5 - cable - 0.6, 0);
    c.put(sphG(0.2), redLight, 0, ty + ah + 0.35, 0);
    c.put(sphG(0.15), redLight, jibL - 0.5, jy + 0.35, 0);
    finishObj(o);
  }
  const redLight = glowMat('#ff3030', 1.6, 1.2, 0.4);

  function buildMonument(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx } = o;
    const S = lx * 2;
    const H = b.h;
    const stone = concMat('#d2cec4', 0.85);
    const stoneD = concMat('#9a968c', 0.9);
    c.bx(S, 0.3 + o.sink, S, stoneD, 0, 0.15 - o.sink / 2, 0);
    c.bx(S * 0.82, 0.3, S * 0.82, stone, 0, 0.45, 0);
    c.bx(S * 0.62, 0.9, S * 0.62, stone, 0, 1.05, 0);
    c.bx(S * 0.7, 0.12, S * 0.7, stoneD, 0, 1.55, 0);
    for (const s of [-1, 1]) {
      c.bx(S * 0.38, 0.4, 0.02, M('#2b2b2e', { rough: 0.3, metal: 0.4 }), 0, 1.0, s * (S * 0.31 + 0.012));
      c.bx(0.02, 0.4, S * 0.38, M('#2b2b2e', { rough: 0.3, metal: 0.4 }), s * (S * 0.31 + 0.012), 1.0, 0);
    }
    const ob = H - 1.6 - 0.6;
    c.put(G(`obel${S.toFixed(2)}|${ob.toFixed(2)}`, () => new THREE.CylinderGeometry(S * 0.17, S * 0.3, ob, 4).rotateY(Math.PI / 4)), stone, 0, 1.61 + ob / 2, 0);
    c.put(G(`obcap${S.toFixed(2)}`, () => new THREE.ConeGeometry(S * 0.17 * 1.414, 0.6, 4).rotateY(Math.PI / 4)), M('#d9b44a', { rough: 0.3, metal: 0.4 }), 0, H - 0.3, 0);
    finishObj(o);
  }

  function buildStall(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const D = lz * 2;
    const h = b.h;
    const col = M(b.color ?? '#ef4444', { rough: 0.8 });
    const white = M(b.accent ?? '#fff7ed', { rough: 0.8 });
    const wm = woodMat('#9a6b3f');
    c.bx(L, 0.08 + o.sink, D, M('#8d8579'), 0, 0.04 - o.sink / 2, 0);
    for (const sx of [-1, 1]) {
      c.cy(0.04, 0.04, h - 0.4, wm, sx * (lx - 0.08), (h - 0.4) / 2 + 0.08, D / 2 - 0.08, undefined, 6);
      c.cy(0.04, 0.04, h - 0.1, wm, sx * (lx - 0.08), (h - 0.1) / 2 + 0.08, -D / 2 + 0.08, undefined, 6);
    }
    // прилавок
    const front = D / 2 - 0.35;
    c.bx(L - 0.2, 0.85, 0.55, wm, 0, 0.5, front);
    c.bx(L - 0.1, 0.05, 0.65, M('#d6cfc2'), 0, 0.95, front);
    // задняя стенка и полки
    c.bx(L - 0.2, h - 0.8, 0.05, M('#8b7355', { rough: 0.9 }), 0, (h - 0.8) / 2 + 0.3, -D / 2 + 0.1);
    for (const y of [1.0, 1.6]) c.bx(L - 0.3, 0.04, 0.35, wm, 0, y, -D / 2 + 0.3);
    // навес в полоску
    const n = Math.max(6, Math.round(L / 0.4));
    const drop = 0.45;
    for (let k = 0; k < n; k++) {
      const x = -L / 2 + (L / n) * (k + 0.5);
      c.bx(L / n, 0.04, D + 0.2, k % 2 ? white : col, x, h - 0.2, 0.05, { rx: -Math.atan2(drop, D) });
      c.bx(L / n, 0.2, 0.03, k % 2 ? white : col, x, h - 0.2 - drop / 2 - 0.12, D / 2 + 0.12);
    }
    // товары
    const colors = ['#ef4444', '#facc15', '#84cc16', '#f97316', '#a855f7'];
    for (let i = 0; i < 5; i++) {
      const x = -L / 2 + 0.55 + i * ((L - 1.1) / 4);
      c.bx(0.5, 0.18, 0.4, wm, x, 1.05, front);
      for (let k = 0; k < 4; k++) c.put(sphG(0.085), M(colors[i % 5]), x - 0.15 + (k % 2) * 0.3, 1.19, front - 0.1 + Math.floor(k / 2) * 0.2);
    }
    c.bx(0.8, 0.28, 0.03, M('#2a2a2a'), 0, h - 0.8, D / 2 + 0.05);
    finishObj(o);
  }

  function buildLifeguard(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx } = o;
    const S = lx * 2;
    const H = b.h;
    const red = M('#dc2626', { rough: 0.6 });
    const white = M('#f8fafc', { rough: 0.6 });
    const wm = woodMat('#c9b79a');
    const deckY = Math.min(1.7, H * 0.48);
    const cabH = H - deckY - 0.5;
    const legs = S * 0.43;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      c.cy(0.07, 0.09, deckY + o.sink, wm, sx * legs, deckY / 2 - o.sink / 2, sz * legs, { rz: -sx * 0.04, rx: sz * 0.04 }, 6);
    }
    for (const sd of [-1, 1]) {
      c.bx(legs * 2, 0.06, 0.06, wm, 0, deckY * 0.5, sd * legs, { rz: 0.5 });
      c.bx(0.06, 0.06, legs * 2, wm, sd * legs, deckY * 0.5, 0, { rx: -0.5 });
    }
    c.bx(S, 0.14, S, wm, 0, deckY, 0);
    // кабина с полосами
    const cw = S * 0.8;
    c.bx(cw, cabH, cw, white, 0, deckY + 0.07 + cabH / 2, 0);
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) c.bx(cw + 0.02, cabH / 6, 0.02, red, 0, deckY + 0.3 + k * (cabH / 3), s * (cw / 2 + 0.003));
    c.bx(cw * 0.7, cabH * 0.42, 0.04, M('#25465f', { rough: 0.15 }), 0, deckY + cabH * 0.62, cw / 2 + 0.01);
    c.bx(0.04, cabH * 0.4, cw * 0.6, M('#25465f', { rough: 0.15 }), cw / 2 + 0.01, deckY + cabH * 0.62, 0);
    c.bx(0.04, cabH * 0.4, cw * 0.6, M('#25465f', { rough: 0.15 }), -cw / 2 - 0.01, deckY + cabH * 0.62, 0);
    // крыша и флаг
    c.put(G(`lgroof${S.toFixed(2)}`, () => new THREE.ConeGeometry(S * 0.78, 0.55, 4).rotateY(Math.PI / 4)), red, 0, H - 0.27, 0);
    c.cy(0.025, 0.025, 1.0, steel, 0, H + 0.2, 0, undefined, 6);
    c.bx(0.45, 0.28, 0.02, M('#facc15'), 0.25, H + 0.5, 0);
    // лестница сзади (внутри 2×2)
    for (const sx of [-1, 1]) c.bx(0.05, deckY + 0.3, 0.05, wm, sx * 0.3, deckY / 2, -legs - 0.05, { rx: 0.0 });
    for (let k = 1; k < 6; k++) c.bx(0.6, 0.04, 0.05, wm, 0, (deckY / 6) * k, -legs - 0.05);
    finishObj(o);
  }

  function buildBoat(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const W = lz * 2;
    const hullH = Math.min(0.75, b.h * 0.55);
    const hullShape = (s: number) => {
      const sh = new THREE.Shape();
      const hw = W * 0.46 * s;
      const hl = L / 2 - 0.02;
      sh.moveTo(-hl * s, -hw * 0.85);
      sh.lineTo(-hl * s, hw * 0.85);
      sh.quadraticCurveTo(L * 0.1, hw * 1.12, hl * s, 0);
      sh.quadraticCurveTo(L * 0.1, -hw * 1.12, -hl * s, -hw * 0.85);
      return sh;
    };
    const mkHull = (s: number, ht: number) => {
      const g = new THREE.ExtrudeGeometry(hullShape(s), { depth: ht, bevelEnabled: false });
      g.rotateX(-HALF_PI);
      return g;
    };
    const lift = 0.28;
    c.put(G(`hullL${L.toFixed(2)}|${W.toFixed(2)}`, () => mkHull(0.92, 0.2)), M('#7f1d1d', { rough: 0.6 }), 0, lift, 0);
    c.put(G(`hullM${L.toFixed(2)}|${W.toFixed(2)}|${hullH.toFixed(2)}`, () => mkHull(1, hullH - 0.2)), M('#f8fafc', { rough: 0.35 }), 0, lift + 0.2, 0);
    c.put(G(`hullS${L.toFixed(2)}|${W.toFixed(2)}`, () => mkHull(1.0, 0.06)), M('#1d4ed8', { rough: 0.4 }), 0, lift + 0.2 + (hullH - 0.2) * 0.5, 0, { sx: 1.012, sz: 1.012 });
    const deckY = lift + hullH;
    c.put(G(`hullD${L.toFixed(2)}|${W.toFixed(2)}`, () => mkHull(0.86, 0.03)), woodMat('#b98b55'), 0, deckY - 0.02, 0);
    // кабина/консоль, стекло
    c.bx(0.9, 0.55, W * 0.5, M('#f1f5f9', { rough: 0.4 }), -L * 0.04, deckY + 0.28, 0);
    c.bx(0.04, 0.3, W * 0.5, tintGlass, L * 0.04 + 0.2, deckY + 0.7, 0, { rz: 0.5 });
    c.bx(0.5, 0.06, 0.5, steelDark, -L * 0.04, deckY + 0.58, 0);
    // сиденья
    c.bx(0.5, 0.25, W * 0.6, M('#e5e7eb'), -L * 0.3, deckY + 0.15, 0);
    c.bx(0.12, 0.3, W * 0.6, M('#e5e7eb'), -L * 0.38, deckY + 0.35, 0);
    // подвесной мотор, леера, мачта
    c.bx(0.3, 0.5, 0.22, M('#1f2937', { rough: 0.5 }), -L / 2 + 0.16, deckY + 0.1, 0);
    c.bx(0.1, 0.35, 0.12, steelDark, -L / 2 + 0.06, deckY - 0.28, 0);
    c.cy(0.03, 0.03, 1.4, steel, L * 0.05, Math.min(b.h - 0.7, deckY + 1.1), 0, undefined, 6);
    c.put(sphG(0.05), redLight, L * 0.05, Math.min(b.h - 0.05, deckY + 1.8), 0);
    for (const s of [-1, 1]) c.bx(L * 0.5, 0.03, 0.03, steel, L * 0.08, deckY + 0.3, s * (W * 0.42));
    // подпорки-киль на песке
    for (const x of [-L * 0.3, L * 0.25]) c.bx(0.25, lift + o.sink, W * 0.55, woodMat('#7a5a3a'), x, (lift - o.sink) / 2, 0);
    finishObj(o);
  }

  function buildPlanter(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const W = lz * 2;
    const h = b.h;
    if (b.variant === 'hedge') {
      // подстриженная живая изгородь на низком бордюре
      const rnd2 = makeRng(Math.floor(b.x * 19 + b.z * 23 + 77));
      const leaf = ['#2f6b2a', '#3a7a31', '#2a5f27', '#43853a'];
      c.bx(L, 0.18 + o.sink, W, concMat('#9b978f'), 0, 0.09 - o.sink / 2, 0);
      c.bx(L - 0.1, h - 0.18, W - 0.1, M(leaf[0], { rough: 1, flat: true }), 0, 0.18 + (h - 0.18) / 2 - 0.08, 0);
      const n = Math.max(2, Math.round(L / 0.55));
      const rr = Math.min(W * 0.5, 0.42);
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + (L / n) * (i + 0.5);
        c.put(sphG(rr, 7, 5), M(leaf[1 + (i % 3)], { rough: 1, flat: true }), x, h - rr * 0.55, (rnd2() - 0.5) * 0.06, { sx: (L / n) * 0.62 / rr, sy: 0.85, sz: (W - 0.1) / 2 / rr });
      }
      finishObj(o);
      return;
    }
    const conc = concMat(b.color ?? '#78716c');
    const wallH = Math.min(0.62, h * 0.55);
    c.bx(L, wallH + o.sink, W, conc, 0, (wallH - o.sink) / 2, 0);
    c.bx(L + 0.06, 0.08, W + 0.06, M('#a8a29e', { rough: 0.8 }), 0, wallH + 0.01, 0);
    c.bx(L - 0.25, 0.06, W - 0.25, M('#4a3426', { rough: 1 }), 0, wallH + 0.03, 0);
    const rnd = makeRng(Math.floor(b.x * 17 + b.z * 31 + 500));
    const greens = ['#3f8f46', '#2f7d3a', '#4fa352', '#5fb35a'];
    const flowers = ['#f43f5e', '#facc15', '#f97316', '#e879f9', '#ffffff'];
    const n = Math.max(3, Math.round(L * W * 0.9));
    const fc = flowers[Math.floor(rnd() * flowers.length)];
    for (let i = 0; i < n; i++) {
      const px = (rnd() - 0.5) * (L - 0.5);
      const pz = (rnd() - 0.5) * (W - 0.5);
      const r = 0.2 + rnd() * 0.18;
      c.put(sphG(r, 7, 5), M(greens[i % 4], { rough: 0.9, flat: true }), px, wallH + 0.1 + r * 0.7, pz, { sy: 0.9 });
      if (i % 3 === 0) c.put(sphG(0.07, 6, 4), M(fc, { rough: 0.8 }), px + 0.05, wallH + 0.12 + r * 1.5, pz + 0.03);
    }
    // одно высокое растение в центре, в пределах h
    c.cy(0.03, 0.04, h - wallH - 0.3, M('#5a3e28'), 0, wallH + (h - wallH - 0.3) / 2 + 0.05, 0, undefined, 6);
    c.put(sphG(Math.min(0.42, (L - 0.5) / 2)), M('#2f7d3a', { rough: 0.9, flat: true }), 0, h - 0.3, 0);
    finishObj(o);
  }

  // ==========================================================================
  // НОВЫЕ ОБЪЕКТЫ-БОКСЫ
  // ==========================================================================
  function bikeInto(c: Collector, x: number, y: number, z: number, ry: number, s: number, col: string) {
    const frame = M(col, { rough: 0.4, metal: 0.2 });
    const wr = 0.33 * s;
    const tireG = G(`btire${wr.toFixed(3)}`, () => new THREE.TorusGeometry(wr, 0.022, 6, 18));
    const rimG = G(`brim${wr.toFixed(3)}`, () => new THREE.TorusGeometry(wr - 0.025, 0.006, 4, 18));
    const cs = Math.cos(ry);
    const sn = Math.sin(ry);
    const at = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs];
    // велосипед направлен вдоль локальной оси Z
    for (const dz of [-0.45 * s, 0.45 * s]) {
      const [px, py, pz] = at(0, wr + 0.02, dz);
      c.put(tireG, rubber, px, py, pz, { ry: ry + HALF_PI });
      c.put(rimG, steel, px, py, pz, { ry: ry + HALF_PI });
    }
    const link = (a: [number, number, number], b2: [number, number, number], r = 0.012) => {
      const dx = b2[0] - a[0];
      const dy = b2[1] - a[1];
      const dz = b2[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      const geo = G(`blink${len.toFixed(3)}|${r}`, () => new THREE.CylinderGeometry(r, r, len, 5));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      c.put(geo, frame, (a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2, (a[2] + b2[2]) / 2, { rx: e.x, ry: e.y, rz: e.z });
    };
    const rear = at(0, wr + 0.02, -0.45 * s);
    const front = at(0, wr + 0.02, 0.45 * s);
    const bb = at(0, 0.3 * s, -0.08 * s);
    const seat = at(0, 0.78 * s, -0.22 * s);
    const head = at(0, 0.82 * s, 0.34 * s);
    link(rear, bb);
    link(bb, front);
    link(rear, seat);
    link(bb, seat);
    link(seat, head);
    link(bb, head);
    c.bx(0.12, 0.04, 0.22, rubber, seat[0], seat[1] + 0.03, seat[2], { ry });
    c.bx(0.4, 0.025, 0.025, steelDark, head[0], head[1] + 0.06, head[2], { ry });
  }

  function buildBikerack(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const hh = Math.min(b.h, 0.9);
    const n = Math.max(1, Math.floor(L / 0.7));
    const pitch = L / n;
    const hoopW = Math.min(lz * 2 * 0.9, 0.8);
    const hoop = G(`hoop${hoopW.toFixed(2)}`, () => new THREE.TorusGeometry(hoopW / 2, 0.02, 6, 12, Math.PI));
    c.bx(L, 0.04 + o.sink, lz * 2, M('#9b9a95'), 0, 0.02 - o.sink / 2, 0);
    for (let i = 0; i < n; i++) {
      const x = -L / 2 + pitch * (i + 0.5);
      c.put(hoop, steel, x, hh - hoopW / 2, 0, { ry: HALF_PI });
      for (const s of [-1, 1]) c.cy(0.02, 0.02, hh - hoopW / 2, steel, x, (hh - hoopW / 2) / 2 + 0.02, s * hoopW / 2, undefined, 6);
    }
    if (lz >= 0.6) {
      const s = Math.min(1, (lz * 2 - 0.1) / 1.4);
      const cols = ['#ef4444', '#2563eb', '#16a34a', '#111827'];
      for (let i = 0; i < n; i += 2) bikeInto(c, -L / 2 + pitch * (i + 0.5), 0.04, 0, 0, s, cols[i % cols.length]);
    }
    finishObj(o);
  }

  function buildFoodtruck(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz, back } = o;
    const L = lx * 2;
    const W = lz * 2;
    const h = b.h;
    const cc = 0.34;
    const col = M(b.color ?? '#f59e0b', { rough: 0.45 });
    const cream = M('#fff7e6', { rough: 0.5 });
    const bw = W - 0.7;
    const zc = -back * 0.35;
    const cabL = L * 0.24;
    const cargoL = L - cabL;
    c.bx(L * 0.96, 0.2, bw * 0.9, steelDark, 0, cc, zc);
    c.bx(cargoL, h - cc - 0.05, bw, cream, -L / 2 + cargoL / 2, cc + (h - cc - 0.05) / 2, zc);
    c.bx(cargoL + 0.02, 0.5, bw + 0.02, col, -L / 2 + cargoL / 2, cc + 0.45, zc);
    c.bx(cargoL + 0.02, 0.25, bw + 0.02, col, -L / 2 + cargoL / 2, h - 0.2, zc);
    const cabH = h * 0.66;
    c.put(
      extrudeProfile([[-cabL / 2, 0], [cabL / 2, 0], [cabL / 2, cabH * 0.5], [cabL / 2 - 0.45, cabH], [-cabL / 2, cabH]], bw),
      col,
      L / 2 - cabL / 2,
      cc + 0.1,
      zc,
    );
    c.bx(0.03, cabH * 0.5, bw * 0.86, carGlass, L / 2 - 0.3, cc + 0.1 + cabH * 0.72, zc, { rz: -0.8 });
    for (const s of [-1, 1]) c.bx(cabL * 0.45, cabH * 0.36, 0.03, carGlass, L / 2 - cabL * 0.55, cc + 0.1 + cabH * 0.62, zc + s * (bw / 2 + 0.006));
    // окно выдачи на стороне «от улицы»
    const sz = zc - back * (bw / 2) * -1;
    const side = -back;
    void side;
    const wx = -L * 0.1;
    const ww = cargoL * 0.55;
    const zs = zc + back * (bw / 2);
    c.bx(ww, 0.95, 0.04, M('#1f2530', { rough: 0.3 }), wx, 1.65, zs + back * 0.006);
    c.bx(ww - 0.15, 0.85, 0.05, glowMat('#ffd29a', 0.9, 0.5, 0), wx, 1.65, zs + back * 0.012);
    c.bx(ww + 0.2, 0.06, 0.4, M('#d9dde2', { rough: 0.4, metal: 0.2 }), wx, 1.17, zs + back * 0.2);
    // тент в полоску (откинут, внутри габарита)
    const n = Math.round(ww / 0.35) | 0;
    for (let k = 0; k < Math.max(4, n); k++) {
      const x = wx - ww / 2 - 0.1 + ((ww + 0.2) / Math.max(4, n)) * (k + 0.5);
      c.bx((ww + 0.2) / Math.max(4, n), 0.035, 0.62, k % 2 ? M('#f8fafc') : M(b.accent ?? '#ef4444'), x, 2.35, zs + back * 0.33, { rx: back * -0.42 });
    }
    // меню на другом борту
    c.put(planeG(cargoL * 0.6, cargoL * 0.3), texMat('menu', () => new THREE.MeshStandardMaterial({ map: track(menuTexture()), roughness: 0.6 })), -L * 0.12, 1.55, zc - back * (bw / 2 + 0.012), { ry: back > 0 ? Math.PI : 0 });
    // крыша: вытяжка, кондиционер, мигающая гирлянда
    c.bx(0.9, 0.25, 0.5, steel, -L * 0.2, h + 0.12, zc);
    c.bx(0.6, 0.22, 0.5, acUnitMat, -L * 0.38, h + 0.1, zc);
    c.cy(0.07, 0.07, 0.35, steelDark, -L * 0.05, h + 0.17, zc, undefined, 8);
    c.bx(0.1, 0.18, bw * 0.8, glowMat('#fff2b0', 1.0, 0.5, 0.2), -L / 2 + cargoL + 0.0, h + 0.1, zc);
    // крышная фигура по виду еды (в пределах габарита высоты)
    const sx0 = -L * 0.3;
    const sy0 = h + 0.02;
    if (b.variant === 'burger') {
      c.put(sphG(0.3, 10, 4), M('#d99a4e'), sx0, sy0 + 0.12, zc, { sy: 0.55 });
      c.cy(0.31, 0.31, 0.06, M('#4a2a18'), sx0, sy0 + 0.0, zc, undefined, 12);
      c.cy(0.32, 0.32, 0.03, M('#65b32e'), sx0, sy0 - 0.05, zc, undefined, 12);
    } else if (b.variant === 'coffee') {
      c.cy(0.22, 0.17, 0.34, M('#f8fafc'), sx0, sy0 + 0.17, zc, undefined, 12);
      c.cy(0.2, 0.2, 0.03, M('#5a3a22'), sx0, sy0 + 0.34, zc, undefined, 12);
      c.put(G('cupH', () => new THREE.TorusGeometry(0.1, 0.025, 6, 10)), M('#f8fafc'), sx0, sy0 + 0.17, zc + 0.24, { ry: HALF_PI });
    } else if (b.variant === 'taco') {
      c.put(G('taco', () => new THREE.CylinderGeometry(0.3, 0.3, 0.5, 12, 1, true, 0, Math.PI).rotateZ(HALF_PI).rotateX(HALF_PI)), M('#e8b64d', { side: THREE.DoubleSide }), sx0, sy0 + 0.02, zc);
    } else if (b.variant === 'icecream') {
      c.put(G('icone', () => new THREE.ConeGeometry(0.17, 0.5, 8).rotateX(Math.PI)), M('#d9a55c'), sx0, sy0 + 0.25, zc);
      c.put(sphG(0.2), M('#f9a8d4'), sx0, sy0 + 0.6, zc);
      c.put(sphG(0.16), M('#fde68a'), sx0, sy0 + 0.82, zc);
    }
    // бамперы, фары, колёса
    c.bx(0.14, 0.2, bw * 0.95, M('#2d3036'), L / 2 + 0.02, cc + 0.15, zc);
    c.bx(0.1, 0.2, bw * 0.95, M('#2d3036'), -L / 2 - 0.02, cc + 0.15, zc);
    for (const s of [-1, 1]) {
      c.bx(0.05, 0.12, 0.26, headMat, L / 2 + 0.005, cc + 0.55, zc + s * bw * 0.34);
      c.bx(0.05, 0.12, 0.2, tailMat, -L / 2 - 0.005, cc + 0.7, zc + s * bw * 0.34);
    }
    c.put(planeG(0.5, 0.12), plateMat, L / 2 + 0.012, cc + 0.28, zc, { ry: HALF_PI });
    c.put(planeG(0.5, 0.12), plateMat, -L / 2 - 0.012, cc + 0.28, zc, { ry: -HALF_PI });
    const zOld = zc;
    for (const wxp of [L * 0.3, -L * 0.28]) {
      const wr = 0.38;
      for (const s of [-1, 1]) {
        const z = zOld + s * (bw / 2 - 0.1);
        c.put(discG(wr, 0.26, 16), rubber, wxp, wr, z);
        c.put(discG(wr * 0.6, 0.28, 12), chrome, wxp, wr, z + s * 0.008);
        c.put(discG(wr * 1.18, 0.02, 16), M('#0c0d10'), wxp, wr, zOld + s * (bw / 2 + 0.004));
      }
    }
    void sz;
    finishObj(o);
  }

  function buildGazebo(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz, back } = o;
    const h = b.h;
    const white = M('#f3efe6', { rough: 0.6 });
    const roof = M(b.color && b.color !== '#9ca3af' ? b.color : '#3f6b4e', { rough: 0.7 });
    const wm = woodMat('#a97c50');
    const rh = Math.max(1, h * 0.3);
    const ph = h - rh;
    c.bx(lx * 2, 0.2 + o.sink, lz * 2, concMat('#a8a49b'), 0, 0.1 - o.sink / 2, 0);
    c.put(floorG(lx * 2 - 0.3, lz * 2 - 0.3, lx, lz), wm, 0, 0.205, 0);
    const px = lx - 0.22;
    const pz = lz - 0.22;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      c.bx(0.16, ph - 0.2, 0.16, white, sx * px, 0.2 + (ph - 0.2) / 2, sz * pz);
      c.bx(0.22, 0.12, 0.22, white, sx * px, 0.26, sz * pz);
    }
    c.bx(lx * 2 - 0.1, 0.18, 0.12, white, 0, ph - 0.09, pz);
    c.bx(lx * 2 - 0.1, 0.18, 0.12, white, 0, ph - 0.09, -pz);
    c.bx(0.12, 0.18, lz * 2 - 0.1, white, px, ph - 0.09, 0);
    c.bx(0.12, 0.18, lz * 2 - 0.1, white, -px, ph - 0.09, 0);
    // перила с балясинами (вход со стороны «к улице»)
    const rail = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const ang = Math.atan2(-(z1 - z0), x1 - x0);
      c.bx(len, 0.06, 0.07, white, (x0 + x1) / 2, 1.05, (z0 + z1) / 2, { ry: ang });
      c.bx(len, 0.05, 0.05, white, (x0 + x1) / 2, 0.35, (z0 + z1) / 2, { ry: ang });
      const k = Math.max(2, Math.round(len / 0.22));
      for (let i = 0; i <= k; i++) c.bx(0.035, 0.68, 0.035, white, x0 + ((x1 - x0) * i) / k, 0.7, z0 + ((z1 - z0) * i) / k);
    };
    rail(-px, -back * pz, px, -back * pz);
    rail(-px, -back * pz, -px, back * pz);
    rail(px, -back * pz, px, back * pz);
    rail(-px, back * pz, -px * 0.35, back * pz);
    rail(px * 0.35, back * pz, px, back * pz);
    // скамья и лампа
    c.bx(lx * 1.3, 0.05, 0.35, wm, 0, 0.5, -back * (pz - 0.3));
    c.bx(0.05, 0.3, 0.3, white, -lx * 0.65, 0.34, -back * (pz - 0.3));
    c.bx(0.05, 0.3, 0.3, white, lx * 0.65, 0.34, -back * (pz - 0.3));
    // крыша-пирамида
    c.put(G('gzroof', () => new THREE.ConeGeometry(1.4142, 1, 4).rotateY(Math.PI / 4)), roof, 0, ph + rh / 2, 0, { sx: lx, sy: rh, sz: lz });
    c.put(G('gzroof2', () => new THREE.ConeGeometry(1.4142, 1, 4).rotateY(Math.PI / 4)), M('#d8d2c3', { rough: 0.7 }), 0, ph + 0.04, 0, { sx: lx * 1.0, sy: 0.08, sz: lz * 1.0 });
    c.cy(0.03, 0.05, 0.4, white, 0, h - 0.05, 0, undefined, 6);
    c.put(sphG(0.09), M('#d9b44a', { rough: 0.3, metal: 0.4 }), 0, h + 0.0, 0);
    c.put(sphG(0.1), lampWarm, 0, ph - 0.35, 0);
    c.cy(0.012, 0.012, 0.3, steelDark, 0, ph - 0.15, 0, undefined, 4);
    finishObj(o);
  }

  function buildPicnic(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2 - 0.1;
    const w = lz * 2;
    const wm = woodMat('#b0824f');
    const wmD = woodMat('#8d6238');
    const bw = w * 0.2;
    const tw = w * 0.42;
    const gap = w * 0.04;
    const tableY = Math.min(b.h, 0.8);
    const benchY = tableY * 0.58;
    const bz = tw / 2 + gap + bw / 2;
    c.bx(L, 0.05, tw, wm, 0, tableY, 0);
    for (let k = -1; k <= 1; k += 2) c.bx(L, 0.02, 0.012, wmD, 0, tableY + 0.026, k * tw * 0.17);
    for (const s of [-1, 1]) {
      c.bx(L, 0.05, bw, wm, 0, benchY, s * bz);
      for (const sx of [-1, 1]) {
        const x = sx * (L / 2 - 0.3);
        c.bx(0.06, tableY, 0.06, wmD, x, tableY / 2 - o.sink * 0, s * (tw / 2 - 0.1), { rz: sx * 0.0, rx: s * 0.0 });
        // A-образные ноги
        c.bx(0.06, Math.hypot(bz - 0.0, tableY) * 1.0, 0.06, wmD, x, tableY / 2, s * bz * 0.5 + 0.0, { rx: -s * Math.atan2(bz, tableY) });
      }
      c.bx(0.06, 0.04, bz * 2 + bw, wmD, -L / 2 + 0.3, benchY - 0.05, 0);
      c.bx(0.06, 0.04, bz * 2 + bw, wmD, L / 2 - 0.3, benchY - 0.05, 0);
    }
    c.bx(0.05, 0.05, tw, wmD, -L / 2 + 0.3, tableY - 0.05, 0);
    c.bx(0.05, 0.05, tw, wmD, L / 2 - 0.3, tableY - 0.05, 0);
    finishObj(o);
  }

  const billboardMats = new Map<string, THREE.MeshStandardMaterial>();
  function buildBillboard(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const L = lx * 2;
    const thick = Math.max(0.16, Math.min(lz * 2, 0.5));
    const top = b.h - 0.35;
    const ph = Math.min(L * 0.5, Math.max(2, b.h * 0.42));
    const vi = Math.floor(hash2(b.x * 0.3, b.z * 0.9) * 4);
    const bkey = `${vi}|${b.color ?? ""}`;
    let adM = billboardMats.get(bkey);
    if (!adM) {
      adM = track(new THREE.MeshStandardMaterial({ map: track(adTexture(vi, 512, 256, b.color)), roughness: 0.4, emissive: new THREE.Color('#ffffff') }));
      adM.emissiveMap = adM.map;
      night(adM, 0.75, 0.3);
      billboardMats.set(bkey, adM);
    }
    const frame = M('#2f353d', { rough: 0.5, metal: 0.2 });
    const py = top - ph / 2;
    c.bx(L, ph, thick, frame, 0, py, 0);
    c.put(planeG(L - 0.2, ph - 0.2), adM, 0, py, thick / 2 + 0.012);
    c.put(planeG(L - 0.2, ph - 0.2), adM, 0, py, -thick / 2 - 0.012, { ry: Math.PI });
    for (const s of [-1, 1]) {
      c.bx(0.5, 0.5, 0.5, concMat('#8a8d90'), s * L * 0.3, 0.25 - o.sink / 2, 0);
      c.cy(0.1, 0.12, py - ph / 2 + 0.3 + o.sink, steelDark, s * L * 0.3, (py - ph / 2 + 0.3 - o.sink) / 2, 0, undefined, 8);
    }
    // помост и светильники
    c.bx(L, 0.05, 0.5, steelDark, 0, py - ph / 2 - 0.02, thick / 2 + 0.25);
    c.bx(L, 0.4, 0.03, steelDark, 0, py - ph / 2 + 0.18, thick / 2 + 0.5);
    for (let i = 0; i < 4; i++) {
      const x = -L / 2 + (L / 4) * (i + 0.5);
      c.bx(0.05, 0.05, 0.6, steelDark, x, top + 0.1, thick / 2 + 0.3);
      c.bx(0.25, 0.08, 0.12, lampWarm, x, top + 0.04, thick / 2 + 0.6);
    }
    c.bx(0.05, py - 0.1, 0.05, steelDark, L * 0.3 + 0.25, (py - 0.1) / 2, thick / 2 + 0.05);
    finishObj(o);
  }

  function buildPlayground(b: BoxObstacle) {
    const o = oriented(b);
    const { c, lx, lz } = o;
    const s = Math.max(0.5, Math.min(lx / 3.2, lz / 2.4, 1.4));
    const g2 = new THREE.Group();
    g2.scale.setScalar(s);
    const floorCols = ['#c2410c', '#0f766e', '#1d4ed8'];
    const fc = floorCols[Math.floor(hash2(b.x, b.z) * 3)];
    const nx = (lx * 2) / s;
    const nz = (lz * 2) / s;
    c.bx(lx * 2, 0.06 + o.sink, lz * 2, M('#6b6f73', { rough: 1 }), 0, 0.03 - o.sink / 2, 0);
    // резиновое покрытие и бордюр — в габарите, в мировых размерах
    c.put(floorG(lx * 2 - 0.1, lz * 2 - 0.1), M(fc, { rough: 0.95 }), 0, 0.065, 0);
    const edge = woodMat('#7a5a3a');
    c.bx(lx * 2, 0.16, 0.1, edge, 0, 0.08, lz - 0.05);
    c.bx(lx * 2, 0.16, 0.1, edge, 0, 0.08, -lz + 0.05);
    c.bx(0.1, 0.16, lz * 2 - 0.2, edge, lx - 0.05, 0.08, 0);
    c.bx(0.1, 0.16, lz * 2 - 0.2, edge, -lx + 0.05, 0.08, 0);
    const k = collector();
    const red = M('#dc2626', { rough: 0.5 });
    const yellow = M('#facc15', { rough: 0.5 });
    const blue = M('#2563eb', { rough: 0.5 });
    // горка с башней (в номинальных размерах; g2 масштабирует)
    const tx = -nx / 2 + 1.6;
    const ph = 1.5;
    for (const dx of [-0.65, 0.65]) for (const dz of [-0.65, 0.65]) k.bx(0.12, ph + 0.9, 0.12, yellow, tx + dx, (ph + 0.9) / 2, dz);
    k.bx(1.5, 0.08, 1.5, M('#c4a574', { rough: 0.8 }), tx, ph, 0);
    k.put(G('pgroof', () => new THREE.ConeGeometry(1.3, 0.8, 4).rotateY(Math.PI / 4)), red, tx, ph + 1.3, 0);
    for (const sz of [-1, 1]) k.bx(1.4, 0.45, 0.04, blue, tx, ph + 0.28, sz * 0.7);
    k.bx(0.04, 0.45, 1.4, blue, tx - 0.7, ph + 0.28, 0);
    for (let i = 0; i < 5; i++) k.bx(0.05, 0.05, 0.5, steel, tx - 0.1, 0.2 + i * 0.28, -0.9 - 0.0);
    const slopeL = 2.6;
    const ang = Math.atan2(ph, slopeL);
    k.bx(Math.hypot(slopeL, ph), 0.05, 0.55, M('#9ca3af', { rough: 0.3, metal: 0.3 }), tx + 0.75 + slopeL / 2, ph / 2, 0, { rz: -ang });
    for (const sz of [-1, 1]) k.bx(Math.hypot(slopeL, ph), 0.14, 0.04, red, tx + 0.75 + slopeL / 2, ph / 2 + 0.06, sz * 0.29, { rz: -ang });
    // качели
    const sx0 = nx / 2 - 2.0;
    const beamY = 2.2;
    const half = Math.min(nz / 2 - 0.5, 1.5);
    for (const dz of [-half, half]) for (const sd of [-1, 1]) k.bx(0.08, beamY * 1.04, 0.08, blue, sx0 + sd * 0.45, beamY / 2, dz, { rz: sd * 0.2 });
    k.bx(0.1, 0.1, half * 2 + 0.2, blue, sx0, beamY, 0);
    for (const dz of [-half * 0.4, half * 0.4]) {
      for (const sd of [-1, 1]) k.cy(0.01, 0.01, beamY - 0.5, steelDark, sx0, 0.5 + (beamY - 0.5) / 2, dz + sd * 0.17, undefined, 4);
      k.bx(0.2, 0.04, 0.45, red, sx0, 0.5, dz);
    }
    // песочница и пружинная качалка
    const bz = nz / 2 - 0.9;
    k.bx(1.4, 0.2, 0.08, edge, 0, 0.1, bz - 0.7);
    k.bx(1.4, 0.2, 0.08, edge, 0, 0.1, bz + 0.7);
    k.bx(0.08, 0.2, 1.4, edge, -0.7, 0.1, bz);
    k.bx(0.08, 0.2, 1.4, edge, 0.7, 0.1, bz);
    k.bx(1.32, 0.1, 1.32, M('#e3d3a1', { rough: 1 }), 0, 0.09, bz);
    k.cy(0.05, 0.08, 0.35, steelDark, 0.0, 0.25, -nz / 2 + 0.9, undefined, 8);
    k.bx(0.2, 0.28, 0.55, yellow, 0, 0.55, -nz / 2 + 0.9);
    k.put(sphG(0.16), yellow, 0, 0.75, -nz / 2 + 1.1);
    k.flush(g2);
    o.g.add(g2);
    finishObj(o);
  }

  // ==========================================================================
  // ДИСПЕТЧЕР БОКСОВ
  // ==========================================================================
  function buildBoxes(boxes: BoxObstacle[]) {
    for (const b of boxes) {
      switch (b.kind) {
        case 'building':
          buildBuilding(b);
          break;
        case 'car':
          buildCar(b);
          break;
        case 'busstop':
          buildBusstop(b);
          break;
        case 'bench':
          buildBench(b);
          break;
        case 'kiosk':
          buildKiosk(b);
          break;
        case 'container':
          buildContainer(b);
          break;
        case 'dumpster':
          buildDumpster(b);
          break;
        case 'fountain':
          buildFountain(b);
          break;
        case 'ledge':
          buildLedge(b);
          break;
        case 'crane':
          buildCrane(b);
          break;
        case 'monument':
          buildMonument(b);
          break;
        case 'stall':
          buildStall(b);
          break;
        case 'lifeguard':
          buildLifeguard(b);
          break;
        case 'boat':
          buildBoat(b);
          break;
        case 'planter':
          buildPlanter(b);
          break;
        case 'bikerack':
          buildBikerack(b);
          break;
        case 'foodtruck':
          buildFoodtruck(b);
          break;
        case 'gazebo':
          buildGazebo(b);
          break;
        case 'picnic':
          buildPicnic(b);
          break;
        case 'billboard':
          buildBillboard(b);
          break;
        case 'playground':
          buildPlayground(b);
          break;
        default:
          box(group, b.halfX * 2, b.h, b.halfZ * 2, M(b.color ?? '#9ca3af', { rough: 0.9 }), b.x, worldOf(b) + b.h / 2, b.z, true);
      }
    }
  }

  // ==========================================================================
  // МЕЛКИЕ ОБЪЕКТЫ (цилиндрические препятствия)
  // ==========================================================================
  function buildProps(obstacles: Obstacle[]) {
    const bushes = obstacles.filter((o) => o.kind === 'bush');
    if (bushes.length) {
      const geo = G('bush', () => new THREE.IcosahedronGeometry(1, 1));
      const mat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }));
      const BLOBS = 5;
      const im = new THREE.InstancedMesh(geo, mat, bushes.length * BLOBS);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const sc = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      bushes.forEach((o, i) => {
        const gy = ctx.ground(o.x, o.z);
        const s = o.scale;
        const base = new THREE.Color(o.color ?? '#3f9a3a');
        for (let k = 0; k < BLOBS; k++) {
          const a = hash2(o.x + k * 3.1, o.z - k) * 6.28;
          const rr = k === 0 ? 0 : 0.42 * s * (0.6 + hash2(o.z + k, o.x) * 0.5);
          const bs = (k === 0 ? 0.62 : 0.38 + hash2(o.x * k, o.z) * 0.14) * s;
          q.setFromAxisAngle(up, a);
          p.set(o.x + Math.cos(a) * rr, gy + bs * 0.68 + (k === 0 ? 0.1 * s : 0), o.z + Math.sin(a) * rr);
          sc.set(bs * 1.1, bs * 0.85, bs * 1.1);
          m4.compose(p, q, sc);
          im.setMatrixAt(i * BLOBS + k, m4);
          im.setColorAt(i * BLOBS + k, base.clone().offsetHSL((hash2(a, k) - 0.5) * 0.03, 0, (k - 2) * 0.025));
        }
      });
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    }

    const poles = obstacles.filter((o) => o.kind === 'pole');
    for (const o of obstacles) {
      if (o.kind === 'bush') continue;
      const gy = ctx.ground(o.x, o.z);
      const g = new THREE.Group();
      g.position.set(o.x, gy, o.z);
      const c = collector();
      let used = true;
      if (o.kind === 'hydrant') {
        const red = M('#d4281f', { rough: 0.45, metal: 0.15 });
        const cap = M('#f2c200', { rough: 0.5 });
        c.cy(0.17, 0.19, 0.08, steelDark, 0, 0.04, 0, undefined, 10);
        c.cy(0.12, 0.14, 0.52, red, 0, 0.34, 0, undefined, 12);
        c.cy(0.15, 0.15, 0.06, red, 0, 0.62, 0, undefined, 12);
        c.put(sphG(0.125, 12, 7), red, 0, 0.66, 0, { sy: 0.8 });
        c.cy(0.04, 0.04, 0.05, cap, 0, 0.78, 0, undefined, 6);
        for (const s of [-1, 1]) {
          c.put(rodXG(0.05, 0.16, 8), red, s * 0.15, 0.45, 0);
          c.put(rodXG(0.065, 0.04, 8), cap, s * 0.24, 0.45, 0);
        }
        c.put(discG(0.07, 0.08, 8), red, 0, 0.36, 0.14);
        c.put(discG(0.075, 0.03, 8), cap, 0, 0.36, 0.19);
      } else if (o.kind === 'bin') {
        const body = M('#2f4a3a', { rough: 0.5, metal: 0.2 });
        c.cy(0.25, 0.21, 0.78, body, 0, 0.5, 0, undefined, 14);
        for (const y of [0.2, 0.55, 0.85]) c.cy(0.262, 0.262, 0.035, steelDark, 0, y, 0, undefined, 14);
        c.cy(0.27, 0.27, 0.07, M('#222831', { rough: 0.5 }), 0, 0.92, 0, undefined, 14);
        c.cy(0.12, 0.14, 0.04, M('#111418'), 0, 0.958, 0, undefined, 10);
        c.cy(0.22, 0.22, 0.1, steelDark, 0, 0.05, 0, undefined, 12);
        c.bx(0.18, 0.2, 0.02, M('#f2f2f2'), 0, 0.68, 0.248, { sz: 1 });
      } else if (o.kind === 'flag') {
        const poleM = M('#e5e7eb', { rough: 0.3, metal: 0.4 });
        c.cy(0.18, 0.22, 0.25, concMat('#9a968c'), 0, 0.12, 0, undefined, 10);
        c.cy(0.045, 0.08, o.h, poleM, 0, o.h / 2, 0, undefined, 10);
        c.put(sphG(0.11, 10, 7), M('#e0b83f', { rough: 0.3, metal: 0.5 }), 0, o.h + 0.1, 0);
        const fl = new THREE.Mesh(
          G('flag-cloth', () => {
            const geo = new THREE.PlaneGeometry(2.0, 1.2, 10, 4);
            const pos = geo.attributes.position as THREE.BufferAttribute;
            for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 2.6) * 0.16 * ((pos.getX(i) + 1) / 2));
            geo.computeVertexNormals();
            return geo;
          }),
          M(o.color ?? '#dc2626', { rough: 0.8, side: THREE.DoubleSide }),
        );
        fl.position.set(1.05, o.h - 0.75, 0);
        fl.castShadow = true;
        const wrap = new THREE.Group();
        wrap.rotation.y = hash2(o.x, o.z) * 1.2;
        wrap.add(fl);
        g.add(wrap);
        const stripe = new THREE.Mesh(G('flag-stripe', () => new THREE.PlaneGeometry(2.0, 0.35, 10, 1)), M('#f8fafc', { rough: 0.8, side: THREE.DoubleSide }));
        const sg = stripe.geometry as THREE.PlaneGeometry;
        const sp = sg.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < sp.count; i++) sp.setZ(i, Math.sin(sp.getX(i) * 2.6) * 0.16 * ((sp.getX(i) + 1) / 2) + 0.004);
        sg.computeVertexNormals();
        stripe.position.set(1.05, o.h - 0.75, 0);
        wrap.add(stripe);
      } else if (o.kind === 'umbrella') {
        const col = o.color ?? '#ef4444';
        const tilt = (hash2(o.z, o.x) - 0.5) * 0.14;
        c.cy(0.22, 0.26, 0.12, concMat('#9a968c'), 0, 0.06, 0, undefined, 10);
        c.cy(0.03, 0.04, 2.3, M('#e8e8e8', { rough: 0.4 }), 0, 1.2, 0, { rz: tilt }, 8);
        const R = 1.65;
        const wedge = (i: number) =>
          G(`umbw${i}`, () => new THREE.ConeGeometry(R, 0.5, 8, 1, true, (i * Math.PI) / 4, Math.PI / 4));
        const white = M('#f8fafc', { rough: 0.85, side: THREE.DoubleSide });
        const cm = M(col, { rough: 0.85, side: THREE.DoubleSide });
        for (let i = 0; i < 8; i++) c.put(wedge(i), i % 2 ? white : cm, -tilt * 1.2, 2.32, 0, { rz: tilt });
        c.put(sphG(0.05), steel, -tilt * 1.3, 2.6, 0);
      } else if (o.kind === 'roadsign') {
        const kind = o.color === '#dc2626' ? 'red' : o.color === '#f2c200' ? 'yellow' : 'blue';
        const sm = texMat(`rs|${kind}`, () => {
          const m = new THREE.MeshStandardMaterial({ map: track(roadSignTexture(kind)), roughness: 0.4, transparent: true, alphaTest: 0.3 });
          return m;
        });
        g.rotation.y = Math.abs(o.z) < 40 ? 0 : HALF_PI;
        c.cy(0.04, 0.045, o.h, M('#9ca3af', { rough: 0.4, metal: 0.3 }), 0, o.h / 2, 0, undefined, 8);
        const sy = o.h - 0.4;
        const geoSign = G('rsdisc', () => new THREE.PlaneGeometry(0.72, 0.72));
        c.put(geoSign, sm, 0, sy, 0.034);
        c.put(geoSign, sm, 0, sy, -0.034, { ry: Math.PI });
        c.put(G('rsback', () => new THREE.CylinderGeometry(0.33, 0.33, 0.06, 18).rotateX(HALF_PI)), M('#6b7280', { rough: 0.5, metal: 0.2 }), 0, sy, 0, { sx: kind === 'yellow' ? 0.0001 : 1 });
        if (kind === 'yellow')
          c.put(G('rsbacktri', () => new THREE.CylinderGeometry(0.4, 0.4, 0.06, 3).rotateX(HALF_PI)), M('#6b7280', { rough: 0.5, metal: 0.2 }), 0, sy - 0.05, 0, { rz: Math.PI });
      } else if (o.kind === 'pole') {
        c.cy(0.07, 0.09, o.h, M('#e5e7eb', { rough: 0.4, metal: 0.3 }), 0, o.h / 2, 0, undefined, 10);
        c.cy(0.1, 0.1, 1.2, M('#1d4ed8', { rough: 0.8 }), 0, 0.7, 0, undefined, 10);
        c.cy(0.03, 0.03, 0.12, steelDark, 0, o.h + 0.05, 0, undefined, 6);
        const mate = poles.find((p2) => p2 !== o && (Math.abs(p2.x - o.x) < 0.6 || Math.abs(p2.z - o.z) < 0.6) && Math.hypot(p2.x - o.x, p2.z - o.z) < 12 && (p2.x > o.x || p2.z > o.z));
        if (mate) {
          const dx = mate.x - o.x;
          const dz = mate.z - o.z;
          const len = Math.hypot(dx, dz);
          const netM = M('#f1f5f9', { rough: 0.9, opacity: 0.3, side: THREE.DoubleSide });
          const rot = Math.atan2(-dz, dx);
          c.put(planeG(len, 1.0), netM, dx / 2, o.h - 0.55, dz / 2, { ry: rot });
          c.bx(len, 0.07, 0.03, M('#f8fafc'), dx / 2, o.h - 0.05, dz / 2, { ry: rot });
          c.bx(len, 0.03, 0.02, M('#f8fafc'), dx / 2, o.h - 1.05, dz / 2, { ry: rot });
        }
      } else if (o.kind === 'mailbox') {
        const s = o.h / 1.3;
        const blue = M('#1e4fb0', { rough: 0.4, metal: 0.1 });
        for (const sd of [-1, 1]) c.cy(0.03, 0.03, 0.45, steelDark, sd * 0.14 * s, 0.22 * s, 0, { sx: s, sy: s, sz: s }, 6);
        c.bx(0.42 * s, 0.38 * s, 0.34 * s, blue, 0, 0.64 * s, 0);
        c.put(G('mbtop', () => new THREE.CylinderGeometry(0.17, 0.17, 0.42, 14, 1, false, 0, Math.PI).rotateZ(HALF_PI).rotateY(-HALF_PI)), blue, 0, 0.83 * s, 0, { sx: s, sy: s, sz: s });
        c.bx(0.3 * s, 0.035 * s, 0.01, M('#0b1220'), 0, 0.74 * s, 0.176 * s);
        c.bx(0.3 * s, 0.1 * s, 0.01, M('#fbbf24'), 0, 0.56 * s, 0.176 * s);
        c.bx(0.2 * s, 0.1 * s, 0.01, M('#f8fafc'), 0, 0.88 * s, 0.176 * s);
        c.bx(0.45 * s, 0.03 * s, 0.38 * s, M('#14407f'), 0, 0.44 * s, 0);
        g.rotation.y = Math.floor(hash2(o.x, o.z) * 4) * HALF_PI;
      } else if (o.kind === 'parkingmeter') {
        const s = o.h / 1.3;
        c.cy(0.035, 0.04, 1.0, steel, 0, 0.5 * s, 0, { sx: s, sy: s, sz: s }, 8);
        c.bx(0.24 * s, 0.34 * s, 0.14 * s, M('#1f6f4a', { rough: 0.45 }), 0, 1.05 * s, 0);
        c.put(G('pmtop', () => new THREE.CylinderGeometry(0.07, 0.07, 0.24, 10, 1, false, 0, Math.PI).rotateZ(HALF_PI).rotateY(-HALF_PI)), M('#1f6f4a', { rough: 0.45 }), 0, 1.22 * s, 0, { sx: s, sy: s, sz: s });
        c.bx(0.16 * s, 0.09 * s, 0.01, glowMat('#b6ffcf', 0.6, 0.3, 0.1), 0, 1.12 * s, 0.076 * s);
        c.bx(0.04 * s, 0.1 * s, 0.01, M('#0b1220'), 0, 0.97 * s, 0.076 * s);
        c.put(G('pmP', () => new THREE.CircleGeometry(0.1, 14)), texMat('rs|blue', () => new THREE.MeshStandardMaterial({ map: track(roadSignTexture('blue')), roughness: 0.4, transparent: true, alphaTest: 0.3 })), 0, 1.4 * s, 0.01, { sx: s, sy: s, sz: s });
        g.rotation.y = Math.floor(hash2(o.z, o.x) * 4) * HALF_PI;
      } else if (o.kind === 'clock') {
        const s = o.h / 3.8;
        const iron = M('#1d3a2e', { rough: 0.5, metal: 0.25 });
        const gold = M('#d6b04a', { rough: 0.35, metal: 0.4 });
        c.cy(0.2, 0.26, 0.3, iron, 0, 0.15 * s, 0, { sx: s, sy: s, sz: s }, 10);
        c.cy(0.12, 0.2, 0.3, iron, 0, 0.45 * s, 0, { sx: s, sy: s, sz: s }, 10);
        c.cy(0.07, 0.09, 2.6, iron, 0, 1.75 * s, 0, { sx: s, sy: s, sz: s }, 10);
        c.cy(0.12, 0.12, 0.06, gold, 0, 3.0 * s, 0, { sx: s, sy: s, sz: s }, 10);
        c.cy(0.44, 0.44, 0.24, iron, 0, 3.3 * s, 0, { rx: HALF_PI, sx: s, sy: s, sz: s }, 18);
        const faceM = texMat('clockface', () => {
          const m = new THREE.MeshStandardMaterial({ map: track(clockTexture()), roughness: 0.5, emissive: new THREE.Color('#ffffff') });
          m.emissiveMap = m.map;
          night(m, 0.5, 0.2);
          return m;
        });
        const fg = G('clockface', () => new THREE.CircleGeometry(0.4, 24));
        c.put(fg, faceM, 0, 3.3 * s, 0.125 * s, { sx: s, sy: s, sz: s });
        c.put(fg, faceM, 0, 3.3 * s, -0.125 * s, { ry: Math.PI, sx: s, sy: s, sz: s });
        c.put(G('clockdome', () => new THREE.SphereGeometry(0.2, 12, 6, 0, Math.PI * 2, 0, HALF_PI)), gold, 0, 3.74 * s, 0, { sx: s, sy: s, sz: s });
        c.put(sphG(0.05), gold, 0, 3.97 * s, 0, { sx: s, sy: s, sz: s });
        g.rotation.y = hash2(o.x, o.z) > 0.5 ? 0 : HALF_PI;
      } else used = false;
      if (used) {
        c.flush(g);
        group.add(g);
      }
    }
  }

  // ==========================================================================
  // ДЕРЕВЬЯ (разные породы)
  // ==========================================================================
  function buildTrees(spots: Obstacle[]) {
    if (!spots.length) return;
    const trunkGeo = G('trunk', () => new THREE.CylinderGeometry(0.15, 0.24, 2, 8));
    const trunkMat = M('#5a3e28', { rough: 1 });
    const birchMat = M('#e8e6df', { rough: 0.8 });
    const leafMat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true }));

    const groups: Record<string, Obstacle[]> = { pine: [], oak: [], birch: [], cypress: [], palm: [] };
    for (const t of spots) groups[t.variant ?? 'pine'].push(t);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const put = (
      im: THREE.InstancedMesh,
      i: number,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      col?: THREE.Color,
      rotY = 0,
    ) => {
      p.set(x, y, z);
      q.setFromAxisAngle(up, rotY);
      sc.set(sx, sy, sz);
      m4.compose(p, q, sc);
      im.setMatrixAt(i, m4);
      if (col) im.setColorAt(i, col);
    };
    const finalize = (...ims: THREE.InstancedMesh[]) => {
      for (const im of ims) {
        im.castShadow = true;
        im.receiveShadow = true;
        group.add(im);
      }
    };
    const jitter = (t: Obstacle, k: number) => hash2(t.x * (k + 1.3), t.z + k * 7.1);

    // сосны / ели: три яруса
    if (groups.pine.length) {
      const arr = groups.pine;
      const leafGeo = G('pine-leaf2', () => new THREE.ConeGeometry(1.5, 3.2, 9));
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, arr.length);
      const leaves = new THREE.InstancedMesh(leafGeo, leafMat, arr.length * 3);
      arr.forEach((t, i) => {
        const s = t.scale;
        const gy = ctx.ground(t.x, t.z);
        const col = new THREE.Color(t.color ?? '#3b7a30').offsetHSL((jitter(t, 1) - 0.5) * 0.04, 0, (jitter(t, 2) - 0.5) * 0.05);
        const rot = jitter(t, 3) * 6;
        put(trunks, i, t.x, gy + s, t.z, s, s, s);
        put(leaves, i * 3, t.x, gy + 2.5 * s, t.z, s * 1.05, s, s * 1.05, col.clone().offsetHSL(0, 0, -0.03), rot);
        put(leaves, i * 3 + 1, t.x, gy + 3.9 * s, t.z, s * 0.78, s * 0.9, s * 0.78, col, rot);
        put(leaves, i * 3 + 2, t.x, gy + 5.1 * s, t.z, s * 0.5, s * 0.8, s * 0.5, col.clone().offsetHSL(0, 0, 0.03), rot);
      });
      finalize(trunks, leaves);
    }

    // дубы: ствол, ветви, шесть кластеров листвы
    if (groups.oak.length) {
      const arr = groups.oak;
      const crown = G('oak-crown2', () => new THREE.IcosahedronGeometry(1.5, 1));
      const branchGeo = G('oak-branch', () => new THREE.CylinderGeometry(0.06, 0.1, 1.4, 6).translate(0, 0.7, 0));
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, arr.length);
      const branches = new THREE.InstancedMesh(branchGeo, trunkMat, arr.length * 2);
      const leaves = new THREE.InstancedMesh(crown, leafMat, arr.length * 6);
      const qe = new THREE.Quaternion();
      const eu = new THREE.Euler();
      arr.forEach((t, i) => {
        const s = t.scale;
        const gy = ctx.ground(t.x, t.z);
        const col = new THREE.Color(t.color ?? '#3d8b37').offsetHSL((jitter(t, 1) - 0.5) * 0.04, 0, 0);
        const rot = jitter(t, 2) * 6;
        put(trunks, i, t.x, gy + 1.1 * s, t.z, s * 1.2, s * 1.2, s * 1.2);
        for (let k = 0; k < 2; k++) {
          const a = rot + k * 2.6;
          eu.set(Math.cos(a) * 0.7, 0, Math.sin(a) * 0.7);
          qe.setFromEuler(eu);
          p.set(t.x, gy + 2.0 * s, t.z);
          sc.set(s, s, s);
          m4.compose(p, qe, sc);
          branches.setMatrixAt(i * 2 + k, m4);
        }
        const offs: [number, number, number, number][] = [
          [0, 3.5, 0, 1.0],
          [1.0, 3.1, 0.3, 0.7],
          [-0.8, 3.0, 0.6, 0.65],
          [-0.3, 3.9, -0.8, 0.7],
          [0.6, 3.8, -0.6, 0.62],
          [0.1, 4.3, 0.2, 0.6],
        ];
        offs.forEach(([ox, oy, oz, r], k) => {
          const c2 = col.clone().offsetHSL(0, 0, (k - 2.5) * 0.02);
          put(leaves, i * 6 + k, t.x + ox * s, gy + oy * s, t.z + oz * s, s * r, s * r * 0.85, s * r, c2, rot + k);
        });
      });
      finalize(trunks, branches, leaves);
    }

    // берёзы: белый ствол, лёгкая светлая крона
    if (groups.birch.length) {
      const arr = groups.birch;
      const crown = G('birch-crown2', () => new THREE.IcosahedronGeometry(1.0, 1));
      const trunks = new THREE.InstancedMesh(trunkGeo, birchMat, arr.length);
      const leaves = new THREE.InstancedMesh(crown, leafMat, arr.length * 4);
      arr.forEach((t, i) => {
        const s = t.scale;
        const gy = ctx.ground(t.x, t.z);
        const col = new THREE.Color('#9acd5a').offsetHSL((jitter(t, 1) - 0.5) * 0.05, 0, 0);
        put(trunks, i, t.x, gy + 1.7 * s, t.z, s * 0.55, s * 1.7, s * 0.55);
        const offs: [number, number, number, number, number][] = [
          [0, 4.1, 0, 0.95, 1.5],
          [0.45, 3.2, 0.2, 0.65, 0.95],
          [-0.4, 3.6, -0.3, 0.6, 1.0],
          [0.1, 5.0, 0.1, 0.5, 0.8],
        ];
        offs.forEach(([ox, oy, oz, r, hy], k) => {
          put(leaves, i * 4 + k, t.x + ox * s, gy + oy * s, t.z + oz * s, s * r, s * hy * 0.8, s * r, col.clone().offsetHSL(0, 0, (k - 1.5) * 0.025));
        });
      });
      finalize(trunks, leaves);
    }

    // кипарисы: узкий веретенообразный силуэт
    if (groups.cypress.length) {
      const arr = groups.cypress;
      const shape = G('cyp2', () => new THREE.IcosahedronGeometry(1, 1));
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, arr.length);
      const leaves = new THREE.InstancedMesh(shape, leafMat, arr.length * 2);
      arr.forEach((t, i) => {
        const s = t.scale;
        const gy = ctx.ground(t.x, t.z);
        const col = new THREE.Color('#1f5a2c').offsetHSL(0, 0, (jitter(t, 1) - 0.5) * 0.05);
        put(trunks, i, t.x, gy + 0.4 * s, t.z, s * 0.8, s * 0.4, s * 0.8);
        put(leaves, i * 2, t.x, gy + 3.1 * s, t.z, s * 0.85, s * 3.0, s * 0.85, col, jitter(t, 2) * 6);
        put(leaves, i * 2 + 1, t.x, gy + 5.5 * s, t.z, s * 0.5, s * 1.3, s * 0.5, col.clone().offsetHSL(0, 0, 0.03));
      });
      finalize(trunks, leaves);
    }

    // пальмы: изогнутые листья-ленты
    if (groups.palm.length) {
      const arr = groups.palm;
      const trunkP = G('palm-trunk', () => new THREE.CylinderGeometry(0.13, 0.24, 6.6, 8));
      const frond = G('palm-frond2', () => {
        const seg = 7;
        const len = 3.0;
        const pos: number[] = [];
        const idx: number[] = [];
        for (let i = 0; i <= seg; i++) {
          const t = i / seg;
          const x = t * len;
          const y = 0.25 * t - 0.95 * t * t;
          const w = 0.36 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)) ** 0.7;
          pos.push(x, y, -w, x, y + 0.04, w);
          if (i < seg) {
            const a = i * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
      });
      const palmTrunkMat = M('#8b6b43', { rough: 1 });
      const palmLeafMat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, side: THREE.DoubleSide, emissive: new THREE.Color('#1a5a22'), emissiveIntensity: 0.5 }));
      const cocoGeo = G('coco', () => new THREE.SphereGeometry(0.14, 6, 5));
      const trunks = new THREE.InstancedMesh(trunkP, palmTrunkMat, arr.length);
      const fronds = new THREE.InstancedMesh(frond, palmLeafMat, arr.length * 9);
      const cocos = new THREE.InstancedMesh(cocoGeo, M('#5b4026', { rough: 0.9 }), arr.length * 3);
      const e = new THREE.Euler();
      const zAxis = new THREE.Vector3(0, 0, 1);
      const qy = new THREE.Quaternion();
      const qz = new THREE.Quaternion();
      arr.forEach((t, i) => {
        const s = t.scale;
        const gy = ctx.ground(t.x, t.z);
        const lean = (hash2(t.x, t.z) - 0.5) * 0.28;
        const dir = hash2(t.z, t.x) * 6.28;
        const topX = t.x + Math.sin(lean) * Math.cos(dir) * 6.6 * s * 0.5;
        const topZ = t.z + Math.sin(lean) * Math.sin(dir) * 6.6 * s * 0.5;
        e.set(Math.sin(dir) * lean, 0, -Math.cos(dir) * lean);
        q.setFromEuler(e);
        p.set((t.x + topX) / 2, gy + 3.3 * s, (t.z + topZ) / 2);
        sc.set(s, s, s);
        m4.compose(p, q, sc);
        trunks.setMatrixAt(i, m4);
        const col = new THREE.Color('#2f9b3f').offsetHSL((jitter(t, 1) - 0.5) * 0.04, 0, 0);
        for (let k = 0; k < 9; k++) {
          const yaw = (k / 9) * Math.PI * 2 + hash2(t.x + k, t.z) * 0.4;
          const lift = 0.5 - (k % 3) * 0.3;
          qy.setFromAxisAngle(up, yaw);
          qz.setFromAxisAngle(zAxis, lift);
          q.copy(qy).multiply(qz);
          p.set(topX, gy + 6.55 * s, topZ);
          sc.set(s * (0.85 + (k % 3) * 0.1), s, s);
          m4.compose(p, q, sc);
          fronds.setMatrixAt(i * 9 + k, m4);
          fronds.setColorAt(i * 9 + k, col.clone().offsetHSL(0, 0, (k % 3) * 0.03));
        }
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * 6.28 + dir;
          q.identity();
          p.set(topX + Math.cos(a) * 0.18 * s, gy + 6.35 * s, topZ + Math.sin(a) * 0.18 * s);
          sc.set(s, s, s);
          m4.compose(p, q, sc);
          cocos.setMatrixAt(i * 3 + k, m4);
        }
      });
      finalize(trunks, fronds, cocos);
    }
  }

  return { buildBoxes, buildProps, buildTrees, M, G, add, box };
}
