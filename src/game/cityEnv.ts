import * as THREE from 'three';
import { facadeTextures, roadStripTexture, surfaceTexture } from './textures';
import { hash2 } from './cityDecor';

// Окружение города за ареной 360×360 м: земляной «фартук» с рельефом и морем, продолжения проспектов,
// дальний город, лес, горы на горизонте и пирс. Арена и физика не затрагиваются.

const HALF = 180;
const G0 = 0.032;
const R0 = 0.005;
const SEA_Y = -0.9;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function vnoise(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export interface CityEnvCtx {
  group: THREE.Group;
  macro(x: number, z: number): number;
  track<T extends { dispose(): void }>(o: T): T;
  nightMats: { mat: THREE.MeshStandardMaterial; nightI: number; sunsetI: number }[];
  maxAniso: number;
}

export interface CityEnv {
  setTime(t: 'day' | 'sunset' | 'night'): void;
  update(camPos: THREE.Vector3, timeSec: number): void;
}

/** Слой заведомо далёких объектов (город за ареной, лес, горы): ближний срез глубины их не рисует. */
export const FAR_LAYER = 1;

export function buildCityEnv(ctx: CityEnvCtx): CityEnv {
  const { group, macro, track } = ctx;

  // ---------- рельеф за ареной ----------
  const apronH = (x: number, z: number) => {
    const ex = clamp(x, -HALF, HALF);
    const ez = clamp(z, -HALF, HALF);
    const d = Math.hypot(x - ex, z - ez);
    let h = macro(ex, ez);
    // вдоль проспектов рельеф спокойный, дальше от них — холмы
    const cor = smooth(14, 170, Math.min(Math.abs(x), Math.abs(z)));
    const n = (vnoise(x / 230 + 5.3, z / 230 + 1.9) - 0.5) * 2 + (vnoise(x / 85, z / 85) - 0.5) * 0.5;
    h += n * 9 * smooth(40, 520, d) * cor;
    if (z < -HALF) h += 30 * smooth(120, 760, -z - HALF) * (0.55 + 0.45 * vnoise(x / 300 + 2, 4)) * cor;
    if (x > HALF) h = h + (-2.6 - h) * smooth(0, 75, x - HALF);
    return h;
  };

  const surf = (id: 'grass' | 'sand' | 'dirt' | 'tiles' | 'asphalt') => {
    const r = surfaceTexture(id, 1);
    r.map.anisotropy = Math.min(8, ctx.maxAniso);
    track(r.map);
    return r;
  };
  const grass = surf('grass');
  const sand = surf('sand');
  const dirt = surf('dirt');
  const tiles = surf('tiles');
  grass.map.repeat.set(1 / grass.meters, 1 / grass.meters);

  // ---------- сетка линий (плотнее у арены, реже вдаль) ----------
  const lines: number[] = [];
  for (let v = 0; v <= 2400; ) {
    lines.push(v, -v);
    v += v < 300 ? 6 : v < 700 ? 30 : v < 1500 ? 100 : 300;
  }
  for (const s of [-1, 1]) {
    for (const v of [0, 9, 11.5, 11.56, 9.0 + 0.0]) lines.push(s * v);
    lines.push(s * HALF);
  }
  const grid = [...new Set(lines.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);

  const inArena = (x0: number, x1: number, z0: number, z1: number) => x0 >= -HALF && x1 <= HALF && z0 >= -HALF && z1 <= HALF;
  const inRoad = (x: number, z: number) => (Math.abs(x) < 9 && Math.abs(z) > HALF) || (Math.abs(z) < 9 && Math.abs(x) > HALF);
  const eastEnd = (() => {
    let x = HALF;
    while (x < 330 && apronH(x, 0) > SEA_Y + 0.12) x += 1;
    return x;
  })();
  const roadOn = (x: number, z: number) => inRoad(x, z) && !(x > eastEnd);

  // ---------- земля ----------
  {
    const idx: number[] = [];
    const nx = grid.length;
    const pos = new Float32Array(nx * nx * 3);
    const nrm = new Float32Array(nx * nx * 3);
    const uv = new Float32Array(nx * nx * 2);
    const col = new Float32Array(nx * nx * 3);
    const mix = new Float32Array(nx * nx * 3);
    const e = 1.5;
    for (let j = 0; j < nx; j++)
      for (let i = 0; i < nx; i++) {
        const x = grid[i];
        const z = grid[j];
        const k = j * nx + i;
        const h = apronH(x, z);
        const inSide =
          (Math.abs(x) >= 9 && Math.abs(x) <= 11.5 && Math.abs(z) > HALF) || (Math.abs(z) >= 9 && Math.abs(z) <= 11.5 && Math.abs(x) > HALF);
        pos.set([x, h + G0, z], k * 3);
        const gx = (apronH(x + e, z) - apronH(x - e, z)) / (2 * e);
        const gz = (apronH(x, z + e) - apronH(x, z - e)) / (2 * e);
        const l = Math.hypot(gx, 1, gz);
        nrm.set([-gx / l, 1 / l, -gz / l], k * 3);
        uv.set([x, z], k * 2);
        const sandW = smooth(150, 195, x) * smooth(0.25, -0.45, h);
        const dirtW = x < -HALF ? (1 - smooth(0, 60, -x - HALF)) * (1 - smooth(70, 105, Math.abs(z))) * 0.8 : 0;
        mix.set([sandW, dirtW, inSide ? 1 : 0], k * 3);
        // крупная пятнистость против повторяемости текстуры, влажный песок у воды, склоны темнее
        const t = 0.82 + 0.34 * vnoise(x / 40 + 9, z / 40 - 3) + 0.12 * (vnoise(x / 11, z / 11) - 0.5);
        const wet = sandW > 0.3 ? 1 - 0.32 * smooth(-0.25, -0.85, h) : 1;
        const side = inSide ? 1 : t * wet;
        col.set([side, side, side], k * 3);
      }
    for (let j = 0; j < nx - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const x0 = grid[i];
        const x1 = grid[i + 1];
        const z0 = grid[j];
        const z1 = grid[j + 1];
        if (inArena(x0, x1, z0, z1)) continue;
        if (roadOn((x0 + x1) / 2, (z0 + z1) / 2)) continue;
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMix', new THREE.BufferAttribute(mix, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ map: grass.map, roughness: 1, vertexColors: true });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSand = { value: sand.map };
      sh.uniforms.uDirt = { value: dirt.map };
      sh.uniforms.uTile = { value: tiles.map };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aMix; varying vec3 vMix;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMix = aMix;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uSand; uniform sampler2D uDirt; uniform sampler2D uTile; varying vec3 vMix;')
        .replace(
          '#include <map_fragment>',
          `vec4 gC = texture2D(map, vMapUv);
           vec4 sC = texture2D(uSand, vMapUv * ${(grass.meters / sand.meters).toFixed(4)});
           vec4 dC = texture2D(uDirt, vMapUv * ${(grass.meters / dirt.meters).toFixed(4)});
           vec4 tC = texture2D(uTile, vMapUv * ${(grass.meters / tiles.meters).toFixed(4)});
           diffuseColor *= mix(mix(mix(gC, sC, vMix.x), dC, vMix.y), tC, vMix.z);`,
        );
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    track(geo);
    track(mat);
  }

  // ---------- продолжения проспектов (текстура с разметкой, без декалей — нет z-fighting) ----------
  {
    const stripTex = track(roadStripTexture(18));
    const mat = new THREE.MeshStandardMaterial({ map: stripTex, roughness: 0.93, side: THREE.DoubleSide });
    track(mat);
    const across = [-9, 0, 9];
    for (const dir of [0, 1, 2, 3]) {
      const sgn = dir % 2 === 0 ? 1 : -1;
      const alongX = dir >= 2; // 0/1: вдоль Z (север/юг), 2/3: вдоль X (запад/восток)
      const along = grid.filter((v) => v * sgn >= HALF - 0.01 && (!alongX || sgn < 0 || v <= eastEnd + 0.01));
      if (alongX && sgn > 0 && along[along.length - 1] < eastEnd) along.push(eastEnd);
      along.sort((a, b) => a - b);
      const pos: number[] = [];
      const uv: number[] = [];
      const nrm: number[] = [];
      const idx: number[] = [];
      const P = (a: number, c: number) => (alongX ? [a, c] : [c, a]); // (along, across) -> (x, z)
      const push = (x: number, z: number, y: number, u: number, v: number) => {
        pos.push(x, y, z);
        uv.push(u, v);
        nrm.push(0, 1, 0);
        return pos.length / 3 - 1;
      };
      for (const a of along)
        for (const c of across) {
          const [x, z] = P(a, c);
          push(x, z, apronH(x, z) + R0, (c + 9) / 18, Math.abs(a) / 6);
        }
      const nA = along.length;
      for (let i = 0; i < nA - 1; i++)
        for (let k = 0; k < 2; k++) {
          const a = i * 3 + k;
          const b = a + 1;
          const c = a + 3;
          const d = c + 1;
          if (alongX) idx.push(a, b, c, b, d, c);
          else idx.push(a, c, b, b, c, d);
        }
      // бордюрные грани вдоль краёв дороги (высота 3.2 см)
      for (const side of [0, 2]) {
        const s = side === 0 ? -1 : 1;
        for (let i = 0; i < nA - 1; i++) {
          const make = (ai: number) => {
            const a = along[ai];
            const [x, z] = P(a, s * 9);
            const y = apronH(x, z) + R0;
            return [
              push(x, z, y, side === 0 ? 0.01 : 0.99, Math.abs(a) / 6),
              push(x, z, y + (G0 - R0), side === 0 ? 0.01 : 0.99, Math.abs(a) / 6),
            ];
          };
          const [a0, a1] = make(i);
          const [b0, b1] = make(i + 1);
          if ((alongX ? 1 : 0) ^ (s > 0 ? 1 : 0)) idx.push(a0, b0, a1, a1, b0, b1);
          else idx.push(a0, a1, b0, b0, a1, b1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.frustumCulled = false;
      group.add(m);
      track(geo);
    }
  }

  // ---------- море ----------
  const seaUniforms = { uTime: { value: 0 } };
  const seaMat = new THREE.MeshStandardMaterial({ color: '#2f86b0', roughness: 0.22, metalness: 0.1 });
  seaMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = seaUniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp; uniform float uTime;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         vec2 wp = vWp.xz;
         normal = normalize(normal + 0.018 * vec3(cos(wp.x * 0.31 + uTime * 0.9) + 0.6 * cos(wp.y * 0.77 - uTime * 1.3), 0.0, cos(wp.y * 0.27 - uTime * 0.7) + 0.6 * cos((wp.x + wp.y) * 0.53 + uTime * 1.1)));`,
      );
  };
  {
    const geo = new THREE.PlaneGeometry(2300, 4800).rotateX(-Math.PI / 2);
    const sea = new THREE.Mesh(geo, seaMat);
    sea.position.set(HALF - 20 + 1150, SEA_Y, 0);
    sea.receiveShadow = true;
    sea.frustumCulled = false;
    group.add(sea);
    track(geo);
    track(seaMat);
  }

  // ---------- пирс на конце восточного проспекта ----------
  {
    const deckY = apronH(eastEnd, 0) + R0;
    const len = 90;
    const plank = document.createElement('canvas');
    plank.width = plank.height = 128;
    const pc = plank.getContext('2d')!;
    pc.fillStyle = '#7a5a3a';
    pc.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 8; i++) {
      const v = 100 + hash2(i, 3) * 40;
      pc.fillStyle = `rgb(${v + 20},${v},${v - 30})`;
      pc.fillRect(i * 16 + 1, 0, 14, 128);
    }
    const plankTex = track(new THREE.CanvasTexture(plank));
    plankTex.wrapS = plankTex.wrapT = THREE.RepeatWrapping;
    plankTex.colorSpace = THREE.SRGBColorSpace;
    plankTex.anisotropy = 8;
    plankTex.repeat.set(len / 8, 1);
    const deckMat = track(new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.9 }));
    const deckGeo = track(new THREE.BoxGeometry(len, 0.22, 7.2));
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.set(eastEnd + len / 2 - 1, deckY - 0.11, 0);
    deck.receiveShadow = true;
    deck.castShadow = true;
    group.add(deck);
    const woodMat = track(new THREE.MeshStandardMaterial({ color: '#4d3a28', roughness: 1 }));
    const nPost = Math.floor(len / 4);
    const postGeo = track(new THREE.CylinderGeometry(0.17, 0.2, 5, 8));
    const posts = new THREE.InstancedMesh(postGeo, woodMat, nPost * 2);
    const railPostGeo = track(new THREE.BoxGeometry(0.1, 1.05, 0.1));
    const railPosts = new THREE.InstancedMesh(railPostGeo, woodMat, nPost * 2);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < nPost; i++)
      for (let s = 0; s < 2; s++) {
        const x = eastEnd + 1 + i * 4;
        const z = (s ? 1 : -1) * 3.45;
        m4.makeTranslation(x, deckY - 2.7, z);
        posts.setMatrixAt(i * 2 + s, m4);
        m4.makeTranslation(x, deckY + 0.52, z);
        railPosts.setMatrixAt(i * 2 + s, m4);
      }
    posts.castShadow = true;
    group.add(posts, railPosts);
    const railGeo = track(new THREE.BoxGeometry(len, 0.07, 0.1));
    for (const s of [-1, 1]) {
      const r = new THREE.Mesh(railGeo, woodMat);
      r.position.set(eastEnd + len / 2 - 1, deckY + 1.0, s * 3.45);
      group.add(r);
    }
  }

  // ---------- дальний город и лес ----------
  const buildingMat = (() => {
    const f = facadeTextures();
    track(f.map);
    track(f.emissive);
    const mat = new THREE.MeshStandardMaterial({
      map: f.map,
      vertexColors: true,
      roughness: 0.75,
      metalness: 0.05,
      emissive: new THREE.Color('#ffb860'),
      emissiveMap: f.emissive,
      emissiveIntensity: 0,
    });
    ctx.nightMats.push({ mat, nightI: 1.5, sunsetI: 0.5 });
    return track(mat);
  })();

  {
    const P: number[] = [];
    const U: number[] = [];
    const N: number[] = [];
    const C: number[] = [];
    const palette: [number, number, number][] = [
      [0.95, 0.9, 0.8],
      [0.86, 0.88, 0.92],
      [0.72, 0.84, 0.97],
      [0.9, 0.68, 0.58],
      [0.98, 0.98, 0.98],
      [0.94, 0.86, 0.62],
      [0.78, 0.8, 0.84],
    ];
    const tri = (a: number[], b: number[], c: number[], na: number[], ua: number[], ub: number[], uc: number[], col: number[]) => {
      for (const [p, u] of [[a, ua], [b, ub], [c, uc]] as const) {
        P.push(p[0], p[1], p[2]);
        U.push(u[0], u[1]);
        N.push(na[0], na[1], na[2]);
        C.push(col[0], col[1], col[2]);
      }
    };
    const box = (cx: number, cz: number, w: number, d: number, y0: number, y1raw: number, col: number[]) => {
      const floors = Math.max(1, Math.round((y1raw - y0) / 3.6));
      const y1 = y0 + floors * 3.6;
      const dirs: [number, number][] = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ];
      const shade = [1, 0.86, 0.93, 0.8];
      dirs.forEach(([nx, nz], i) => {
        const L = nx ? d : w;
        const cells = Math.max(1, Math.round(L / 4));
        const rx = nz;
        const rz = -nx;
        const fx = cx + (nx * w) / 2;
        const fz = cz + (nz * d) / 2;
        const p0 = [fx - (rx * L) / 2, y0, fz - (rz * L) / 2];
        const p1 = [fx + (rx * L) / 2, y0, fz + (rz * L) / 2];
        const p2 = [p1[0], y1, p1[2]];
        const p3 = [p0[0], y1, p0[2]];
        const o = hash2(cx + i, cz) * 8;
        const u0 = o;
        const u1 = o + cells / 8;
        const v1 = floors / 8;
        const n = [nx, 0, nz];
        const c = col.map((v) => v * shade[i]);
        tri(p0, p1, p2, n, [u0, 0], [u1, 0], [u1, v1], c);
        tri(p0, p2, p3, n, [u0, 0], [u1, v1], [u0, v1], c);
      });
      const x0 = cx - w / 2;
      const x1 = cx + w / 2;
      const z0 = cz - d / 2;
      const z1 = cz + d / 2;
      const roof = [0.42, 0.43, 0.46];
      const w0 = [0.01, 0.01];
      const up = [0, 1, 0];
      tri([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], up, w0, w0, w0, roof);
      tri([x0, y1, z0], [x1, y1, z1], [x1, y1, z0], up, w0, w0, w0, roof);
      return y1;
    };

    const baseAt = (x: number, z: number, w: number, d: number) =>
      Math.min(apronH(x - w / 2, z - d / 2), apronH(x + w / 2, z - d / 2), apronH(x - w / 2, z + d / 2), apronH(x + w / 2, z + d / 2)) - 1.5;

    const treeSpots: { x: number; z: number; h: number; k: number; pine: boolean }[] = [];
    const pitch = 56;
    for (let gz = -1200; gz <= 1200; gz += pitch)
      for (let gx = -1200; gx <= 1200; gx += pitch) {
        const x = gx + (hash2(gx, gz) - 0.5) * 12;
        const z = gz + (hash2(gz, gx) - 0.5) * 12;
        const r = Math.hypot(x, z);
        if (r > 1150) continue;
        const outside = Math.max(Math.abs(x), Math.abs(z)) > 235;
        if (!outside) continue;
        if (Math.abs(x) < 26 || Math.abs(z) < 26) continue;
        const h0 = apronH(x, z);
        if (x > HALF && h0 < 0.4) continue;
        const zn = vnoise(x / 320 + 7, z / 320 + 3);
        if (zn < 0.42 || hash2(gx * 0.7, gz * 1.3) > 1 - smooth(500, 1150, r) * 0.7) continue;
        const dtn = vnoise(x / 430 + 11, z / 430 - 4);
        const w = 22 + hash2(x, z) * 22;
        const d = 22 + hash2(z, x) * 22;
        const hgt = 10 + Math.pow(dtn, 2.2) * 150 * (0.45 + hash2(x + 1, z + 2) * 0.8);
        const y0 = baseAt(x, z, w, d);
        const col = palette[Math.floor(hash2(x * 3, z * 5) * palette.length) % palette.length];
        let top = box(x, z, w, d, y0, hgt, col);
        if (hgt > 45 && hash2(x, z + 9) > 0.55) top = box(x, z, w * 0.62, d * 0.62, top, hgt * 0.35, col);
        // крышная надстройка
        box(x + (hash2(x, 7) - 0.5) * w * 0.3, z + (hash2(7, z) - 0.5) * d * 0.3, 4 + hash2(z, 2) * 4, 4 + hash2(x, 2) * 4, top, 3.6, [0.6, 0.6, 0.62]);
      }
    // лес: на свободных участках и по кромке арены
    const pt = 15;
    for (let gz = -1100; gz <= 1100; gz += pt)
      for (let gx = -1100; gx <= 1100; gx += pt) {
        const x = gx + (hash2(gx + 3, gz) - 0.5) * pt;
        const z = gz + (hash2(gz, gx + 5) - 0.5) * pt;
        if (Math.max(Math.abs(x), Math.abs(z)) < HALF + 8) continue;
        if (Math.abs(x) < 17 || Math.abs(z) < 17) continue;
        const r = Math.hypot(x, z);
        const h0 = apronH(x, z);
        if (h0 < -0.2 && x > HALF) continue;
        const dEdge = Math.max(Math.abs(x), Math.abs(z)) - HALF;
        const zn = vnoise(x / 320 + 7, z / 320 + 3);
        const forest = zn < 0.42 ? 0.5 : dEdge < 90 ? 0.3 : 0;
        const dens = forest * (1 - smooth(600, 1100, r));
        if (hash2(x * 1.7, z * 0.9) > dens) continue;
        treeSpots.push({ x, z, h: 6 + hash2(x, z) * 9, k: hash2(z, x), pine: vnoise(x / 150, z / 150) > 0.5 });
      }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const city = new THREE.Mesh(geo, buildingMat);
    city.frustumCulled = false;
    city.layers.set(FAR_LAYER);
    city.castShadow = false;
    group.add(city);
    track(geo);

    // деревья (инстансы)
    const crownGeo = track(new THREE.IcosahedronGeometry(1, 0));
    const pineGeo = track(new THREE.ConeGeometry(1, 2.6, 7));
    const trunkGeo = track(new THREE.CylinderGeometry(0.18, 0.28, 1, 6));
    const leafMat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true }));
    const trunkMat = track(new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 1 }));
    const round = treeSpots.filter((t) => !t.pine);
    const pines = treeSpots.filter((t) => t.pine);
    const crowns = new THREE.InstancedMesh(crownGeo, leafMat, Math.max(1, round.length));
    const cones = new THREE.InstancedMesh(pineGeo, leafMat, Math.max(1, pines.length));
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, treeSpots.length));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    treeSpots.forEach((t, i) => {
      const y = apronH(t.x, t.z);
      m4.compose(new THREE.Vector3(t.x, y + t.h * 0.2, t.z), q.identity(), new THREE.Vector3(1, t.h * 0.4, 1));
      trunks.setMatrixAt(i, m4);
    });
    round.forEach((t, i) => {
      const y = apronH(t.x, t.z);
      const r = t.h * 0.34;
      m4.compose(new THREE.Vector3(t.x, y + t.h * 0.62, t.z), q.identity(), new THREE.Vector3(r, r * 1.15, r));
      crowns.setMatrixAt(i, m4);
      col.setHSL(0.27 + t.k * 0.08, 0.45, 0.2 + t.k * 0.12);
      crowns.setColorAt(i, col);
    });
    pines.forEach((t, i) => {
      const y = apronH(t.x, t.z);
      const r = t.h * 0.22;
      m4.compose(new THREE.Vector3(t.x, y + t.h * 0.5 + 0.5, t.z), q.identity(), new THREE.Vector3(r, t.h * 0.38, r));
      cones.setMatrixAt(i, m4);
      col.setHSL(0.36 + t.k * 0.05, 0.4, 0.14 + t.k * 0.08);
      cones.setColorAt(i, col);
    });
    crowns.count = round.length;
    cones.count = pines.length;
    trunks.count = treeSpots.length;
    for (const m of [crowns, cones, trunks]) {
      m.frustumCulled = false;
      m.layers.set(FAR_LAYER);
      group.add(m);
    }
  }

  // ---------- горы на горизонте ----------
  const hillMat = new THREE.MeshBasicMaterial({ color: '#9bb6d0', side: THREE.DoubleSide, fog: false });
  {
    const n = 220;
    const pos: number[] = [];
    const idx: number[] = [];
    const R = 1500;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const nz = vnoise(Math.cos(a) * 3 + 20, Math.sin(a) * 3 + 20) + 0.5 * vnoise(Math.cos(a) * 9 + 5, Math.sin(a) * 9 + 5);
      const north = Math.max(0, -Math.sin(a));
      const hgt = 30 + nz * 110 + north * 90;
      pos.push(Math.cos(a) * R, -60, Math.sin(a) * R, Math.cos(a) * (R - 20), hgt, Math.sin(a) * (R - 20));
      if (i < n) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, hillMat);
    m.frustumCulled = false;
    m.layers.set(FAR_LAYER);
    group.add(m);
    track(geo);
    track(hillMat);
  }

  const seaCols = { day: '#2f86b0', sunset: '#8a5a6a', night: '#12305a' };
  const hillCols = { day: '#9ab5cf', sunset: '#a56f7e', night: '#0c1628' };
  return {
    setTime(t) {
      seaMat.color.set(seaCols[t]);
      hillMat.color.set(hillCols[t]);
    },
    update(_cam, timeSec) {
      seaUniforms.uTime.value = timeSec;
    },
  };
}
