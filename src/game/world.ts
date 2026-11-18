import * as THREE from 'three';
import { SURFACES, type SurfaceId, type TimeOfDay } from './data';
import type { DynamicCone } from './physics';
import { CELL, HALF, LAYOUT, POTHOLES, WASH, hillTrailDist, isCityRoad, type Terrain } from './terrain';
import { createDecor, hash2 } from './cityDecor';
import { glowTexture, labelTexture, roadArrowTexture, stripesTexture, surfaceTexture, windowsTexture } from './textures';
import { buildCityEnv, type CityEnv } from './cityEnv';
import { batchStatic } from './staticBatch';
import { tr } from '../i18n';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TodDef {
  top: string;
  hor: string;
  bottom: string;
  sunDir: [number, number, number];
  sunColor: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  fog: string;
  exposure: number;
  stars: number;
  headlight: number;
  cloud: string;
  cloudAmt: number;
  disc: string;
  paint: number;
}

const TOD: Record<TimeOfDay, TodDef> = {
  day: {
    top: '#3d7fd0',
    hor: '#c4e0f6',
    bottom: '#7d8a78',
    sunDir: [0.4, 0.8, 0.3],
    sunColor: '#fff2dc',
    sunI: 2.9,
    hemiSky: '#cfe4ff',
    hemiGround: '#6f6a55',
    hemiI: 1.15,
    fog: '#c4e0f6',
    exposure: 1.0,
    stars: 0,
    headlight: 0,
    cloud: '#ffffff',
    cloudAmt: 0.75,
    disc: '#fff6d8',
    paint: 1,
  },
  sunset: {
    top: '#26357a',
    hor: '#ff9d5c',
    bottom: '#4a3030',
    sunDir: [0.85, 0.2, 0.35],
    sunColor: '#ff9a4a',
    sunI: 2.3,
    hemiSky: '#9a86b8',
    hemiGround: '#40302e',
    hemiI: 0.95,
    fog: '#e59a72',
    exposure: 1.0,
    stars: 0.2,
    headlight: 0.4,
    cloud: '#ffb7a0',
    cloudAmt: 0.7,
    disc: '#ffd8a0',
    paint: 0.85,
  },
  night: {
    top: '#02040c',
    hor: '#12203a',
    bottom: '#05070c',
    sunDir: [-0.3, 0.6, 0.2],
    sunColor: '#7d96cc',
    sunI: 0.45,
    hemiSky: '#3b5088',
    hemiGround: '#171d2a',
    hemiI: 0.8,
    fog: '#0b1426',
    exposure: 1.2,
    stars: 1,
    headlight: 1,
    cloud: '#1c2a48',
    cloudAmt: 0.55,
    disc: '#cfdcff',
    paint: 0.4,
  },
};

export interface World {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  setTime(t: TimeOfDay): void;
  headlightLevel(): number;
  update(camPos: THREE.Vector3, target: THREE.Vector3, cones?: DynamicCone[]): void;
  setShadowSize(n: number): void;
  /** Перерисовать текстовые вывески после смены языка. */
  relabel(): void;
  dispose(): void;
}

export function createWorld(scene: THREE.Scene, terrain: Terrain, renderer: THREE.WebGLRenderer): World {
  const group = new THREE.Group();
  scene.add(group);
  const macro = (x: number, z: number) => terrain.macro(x, z);
  const labels: { mat: THREE.SpriteMaterial; sprite: THREE.Sprite; text: string; icon: string }[] = [];
  const signMode = terrain.mapId === 'city';

  // ---------- освещение ----------
  const hemi = new THREE.HemisphereLight('#cfe4ff', '#6f6a55', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff2dc', 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -16;
  sc.right = 16;
  sc.top = 16;
  sc.bottom = -16;
  sc.near = 1;
  sc.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  // ---------- небо ----------
  const skyUniforms = {
    top: { value: new THREE.Color() },
    hor: { value: new THREE.Color() },
    bottom: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color() },
    sunAmt: { value: 1 },
    time: { value: 0 },
    cloudCol: { value: new THREE.Color() },
    cloudAmt: { value: 0.7 },
    discCol: { value: new THREE.Color() },
    discCos: { value: 0.99985 },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vDir; uniform vec3 top; uniform vec3 hor; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunAmt;
      uniform float time; uniform vec3 cloudCol; uniform float cloudAmt; uniform vec3 discCol; uniform float discCos;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p){ float a = 0.5; float s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(hor, top, pow(h, 0.5));
        col = mix(col, hor, (1.0 - smoothstep(0.0, 0.2, h)) * 0.55);
        if (d.y < 0.0) col = mix(hor, bottom, clamp(-d.y * 4.0, 0.0, 1.0));
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * (pow(s, 14.0) * 0.28 + pow(s, 4.0) * 0.06) * sunAmt;
        col = mix(col, discCol, smoothstep(discCos, discCos + 0.00007, s));
        if (d.y > 0.01) {
          vec2 p = d.xz / (d.y + 0.2) * 1.2 + vec2(time * 0.01, time * 0.004);
          float c = fbm(p);
          float m = smoothstep(0.48, 0.78, c) * smoothstep(0.01, 0.2, d.y) * cloudAmt;
          vec3 cc = cloudCol * (0.82 + 0.18 * smoothstep(0.5, 0.8, c)) + sunColor * pow(s, 6.0) * 0.35 * sunAmt;
          col = mix(col, cc, m);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

  // звёзды
  const starPos: number[] = [];
  const r0 = rng(99);
  for (let i = 0; i < 500; i++) {
    const u = r0() * 2 - 1;
    const a = r0() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const y = Math.abs(u);
    starPos.push(Math.cos(a) * s * 850, y * 850, Math.sin(a) * s * 850);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: '#ffffff',
    size: 2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const disposables: { dispose(): void }[] = [sky.geometry, skyMat, starGeo, starMat];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const pv = new THREE.Vector3();

  // Материалы, меняющие свечение ночью/на закате
  const nightEmissiveMats: { mat: THREE.MeshStandardMaterial; nightI: number; sunsetI: number }[] = [];

  // ---------- покрытия земли ----------
  // Земля рисуется слоями (painter's algorithm), а не борьбой за глубину:
  //  - слой 0 (базовый) пишет глубину обычным образом;
  //  - слои 1..N (зоны, дороги) рисуются строго по порядку renderOrder с depthFunc = Always,
  //    поэтому дорога ВСЕГДА лежит поверх травы/плитки/песка, независимо от дистанции и z-fighting.
  const texCache = new Map<SurfaceId, { map: THREE.CanvasTexture; roughness: number; meters: number }>();
  const getSurfTex = (sid: SurfaceId) => {
    let t = texCache.get(sid);
    if (!t) {
      const r = surfaceTexture(sid, 1);
      r.map.repeat.set(1, 1); // UV считаем в метрах мира -> одинаковый масштаб на любых патчах
      r.map.anisotropy = Math.min(8, maxAniso);
      disposables.push(r.map);
      t = r;
      texCache.set(sid, t);
    }
    return t;
  };
  const surfMatCache = new Map<string, THREE.MeshStandardMaterial>();
  const getSurfMat = (sid: SurfaceId, layer: number) => {
    const overlay = layer > 0;
    const key = `${sid}|${layer}`;
    let m = surfMatCache.get(key);
    if (!m) {
      const { map, roughness } = getSurfTex(sid);
      m = new THREE.MeshStandardMaterial({
        map,
        roughness,
        metalness: sid === 'wet' ? 0.18 : sid === 'snow' ? 0.08 : 0,
        // базовый слой чуть «отодвинут» назад, чтобы разметка и декали всегда были над ним
        polygonOffset: !overlay,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      if (overlay) m.depthFunc = THREE.AlwaysDepth;
      // Трафарет хранит номер верхнего слоя в пикселе. Кадр рисуется двумя срезами глубины, и на их
      // стыке дорога (ниже бордюра) уже отсечена, а газон над ней ещё нет: без трафарета ближний срез
      // закрашивал дорогу дальнего среза полосой газона.
      m.stencilWrite = true;
      m.stencilRef = layer;
      m.stencilFunc = THREE.GreaterEqualStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
      surfMatCache.set(key, m);
      disposables.push(m);
    }
    return m;
  };

  const GROUND_RO = -9; // renderOrder базового слоя земли (после неба, до всех объектов)

  const finishGround = (mesh: THREE.Mesh, layer: number) => {
    mesh.renderOrder = GROUND_RO + layer * 0.01;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  // Участок рельефа с высотой macro(x, z) + yOff. layer 0 = базовый, >0 = поверх предыдущих.
  const addTerrainPatch = (
    cx: number,
    cz: number,
    w: number,
    d: number,
    sid: SurfaceId,
    layer = 0,
    yOff = 0,
    step = 2.5,
  ) => {
    const segX = Math.max(1, Math.ceil(w / step));
    const segZ = Math.max(1, Math.ceil(d / step));
    const geo = new THREE.PlaneGeometry(w, d, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const meters = getSurfTex(sid).meters;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx;
      const wz = pos.getZ(i) + cz;
      pos.setY(i, macro(wx, wz) + yOff);
      uv.setXY(i, wx / meters, wz / meters);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, getSurfMat(sid, layer));
    mesh.position.set(cx, 0, cz);
    finishGround(mesh, layer);
    disposables.push(geo);
  };

  // Полоса под углом, обрезанная по прямоугольнику (диагональные аллеи парка)
  const addClippedStrip = (
    cx: number,
    cz: number,
    len: number,
    wid: number,
    angle: number,
    clip: { x0: number; x1: number; z0: number; z1: number },
    sid: SurfaceId,
    layer: number,
    yOff: number,
  ) => {
    const geo = new THREE.PlaneGeometry(len, wid, Math.ceil(len / 2), Math.max(2, Math.ceil(wid / 2.5)));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const meters = getSurfTex(sid).meters;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const wx = Math.min(clip.x1, Math.max(clip.x0, cx + lx * c + lz * sn));
      const wz = Math.min(clip.z1, Math.max(clip.z0, cz - lx * sn + lz * c));
      pos.setXYZ(i, wx, macro(wx, wz) + yOff, wz);
      uv.setXY(i, wx / meters, wz / meters);
    }
    geo.computeVertexNormals();
    finishGround(new THREE.Mesh(geo, getSurfMat(sid, layer)), layer);
    disposables.push(geo);
  };

  const white = new THREE.MeshBasicMaterial({
    color: '#f2f2f2',
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const yellow = new THREE.MeshBasicMaterial({
    color: '#f2c200',
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const bikeLaneMat = new THREE.MeshBasicMaterial({
    color: '#10b981',
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const orangeLineMat = new THREE.MeshBasicMaterial({
    color: '#ff6a13',
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const lineGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  disposables.push(white, yellow, bikeLaneMat, orangeLineMat, lineGeo);

  // Разметка/декали копятся по материалам и выводятся одним InstancedMesh (flushLines в конце)
  const lineBatches = new Map<THREE.Material, THREE.Matrix4[]>();
  const upV = new THREE.Vector3(0, 1, 0);
  const nV = new THREE.Vector3();
  const qTilt = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const paintMats: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[] = [];
  const lampLights: THREE.Object3D[] = [];
  for (const m of [white, yellow, bikeLaneMat, orangeLineMat]) paintMats.push({ mat: m, base: m.color.clone() });

  const addLine = (x: number, z: number, lx: number, lz: number, mat: THREE.Material, yExtra = 0.014, yaw = 0) => {
    // декаль ложится вдоль наклона рельефа
    const gx = (macro(x + 0.5, z) - macro(x - 0.5, z)) / 1.0;
    const gz = (macro(x, z + 0.5) - macro(x, z - 0.5)) / 1.0;
    nV.set(-gx, 1, -gz).normalize();
    qTilt.setFromUnitVectors(upV, nV);
    qYaw.setFromAxisAngle(upV, yaw);
    qTilt.multiply(qYaw);
    const mx = new THREE.Matrix4().compose(pv.set(x, macro(x, z) + yExtra, z), qTilt, sv.set(lx, 1, lz));
    let list = lineBatches.get(mat);
    if (!list) lineBatches.set(mat, (list = []));
    list.push(mx);
  };
  const flushLines = () => {
    for (const [mat, list] of lineBatches) {
      const im = new THREE.InstancedMesh(lineGeo, mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.receiveShadow = !(mat instanceof THREE.MeshBasicMaterial);
      group.add(im);
    }
    lineBatches.clear();
  };

  // Видимая высота земли в точке (на городской карте проезжая часть ниже тротуаров на 2.7 см)
  const groundY = (x: number, z: number) =>
    terrain.mapId === 'city' ? macro(x, z) + (isCityRoad(x, z) ? 0.005 : 0.032) : macro(x, z);
  const decor = createDecor({
    group,
    macro,
    ground: groundY,
    track: (o) => {
      disposables.push(o);
      return o;
    },
    night: nightEmissiveMats,
  });

  // Наземные декали города: разметка катка и плазы, люки, лужи, полотенца, волейбольная сетка, цветы
  const buildGroundDecor = () => {
    const mk = (color: string, off = -6) =>
      new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: off, polygonOffsetUnits: off });
    const red = mk('#dc2626');
    const blue = mk('#2563eb');
    const cyan = mk('#22d3ee');
    const orange = mk('#ff6a13');
    const whiteD = mk('#f8fafc');
    const dark = mk('#26292e');
    const ironRing = mk('#4b5563', -7);
    disposables.push(red, blue, cyan, orange, whiteD, dark, ironRing);
    const flat = (mat: THREE.Material, geo: THREE.BufferGeometry, x: number, z: number, y: number, ry = 0, sx = 1, sz = 1) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, macro(x, z) + y, z);
      m.rotation.y = ry;
      m.scale.set(sx, 1, sz);
      m.renderOrder = 2;
      group.add(m);
      return m;
    };
    const rect = (mat: THREE.Material, x: number, z: number, lx: number, lz: number, y: number, ry = 0) =>
      flat(mat, lineGeo, x, z, y, ry, lx, lz);
    const ringG = (ri: number, ro: number) => {
      const g = new THREE.RingGeometry(ri, ro, 40).rotateX(-Math.PI / 2);
      disposables.push(g);
      return g;
    };
    const discG = (r: number) => {
      const g = new THREE.CircleGeometry(r, 24).rotateX(-Math.PI / 2);
      disposables.push(g);
      return g;
    };

    // --- Ледовый каток: хоккейная разметка ---
    {
      const y = 0.052;
      rect(red, -47, -47, 33, 0.2, y); // центральная красная линия (вдоль X)
      rect(blue, -47, -53.5, 33, 0.18, y);
      rect(blue, -47, -40.5, 33, 0.18, y);
      flat(blue, ringG(3.6, 3.8), -47, -47, y);
      flat(blue, discG(0.45), -47, -47, y);
      for (const [fx, fz] of [
        [-57, -57],
        [-37, -57],
        [-57, -37],
        [-37, -37],
      ]) {
        flat(red, ringG(2.3, 2.45), fx, fz, y);
        flat(red, discG(0.3), fx, fz, y);
      }
    }

    // --- Стрит-плаза: граффити-разметка и «старт-сетка» ---
    {
      const y = 0.058;
      for (const [cx, cz, c] of [
        [26, -26, orange],
        [68, -26, cyan],
        [26, -48, cyan],
        [68, -48, orange],
      ] as [number, number, THREE.Material][])
        rect(c, cx, cz, 3.2, 3.2, y, Math.PI / 8);
      flat(whiteD, ringG(5.6, 5.78), 47, -37, y);
      flat(orange, ringG(2.0, 2.15), 47, -37, y);
      for (let x = 24; x <= 70; x += 6) {
        rect(whiteD, x, -22.4, 2.6, 0.16, y);
        rect(whiteD, x, -51.6, 2.6, 0.16, y);
      }
    }

    // --- Люки на дорогах ---
    const manholes: [number, number][] = [
      [-55, -2],
      [-20, 3],
      [15, -3],
      [50, 2.4],
      [-30, -90],
      [30, 90],
      [90, 30],
      [-90, -30],
      [60, -92],
      [-4, 55],
      [3, -65],
      [-120, 3],
      [95, -3.4],
    ];
    const manG = discG(0.46);
    const manRingG = ringG(0.46, 0.56);
    for (const [mx, mz] of manholes) {
      flat(dark, manG, mx, mz, 0.011);
      flat(ironRing, manRingG, mx, mz, 0.012);
      for (let k = -1; k <= 1; k++) rect(ironRing, mx, mz + k * 0.17, 0.7, 0.04, 0.013);
    }

    // --- Лужи на мокрой дороге ---
    {
      const puddleMat = new THREE.MeshStandardMaterial({
        color: '#2b3f55',
        roughness: 0.04,
        metalness: 0.55,
        transparent: true,
        opacity: 0.88,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
      });
      disposables.push(puddleMat);
      const pg = discG(1);
      const puddles: [number, number, number, number][] = [
        [88, -70, 2.0, 1.2],
        [93, -58, 1.5, 1.0],
        [86, -44, 2.4, 1.3],
        [95, -33, 1.6, 1.1],
        [90, -22, 2.2, 1.2],
        [110, -3, 2.6, 1.4],
        [125, 3, 2.2, 1.2],
        [140, -2.5, 3.0, 1.5],
        [155, 2.2, 2.0, 1.1],
      ];
      for (const [px, pz, rx, rz] of puddles) {
        const m = flat(puddleMat, pg, px, pz, 0.012, hash2(px, pz) * 3, rx, rz);
        m.renderOrder = 3;
      }
    }

    // --- Пляж: полотенца, волейбольная площадка ---
    {
      const towelCols = ['#f43f5e', '#06b6d4', '#facc15', '#a855f7', '#22c55e', '#fb923c'];
      const towelGeo = new THREE.BoxGeometry(0.85, 0.02, 1.9);
      disposables.push(towelGeo);
      let k = 0;
      for (const o of terrain.obstacles) {
        if (o.kind !== 'umbrella' || o.x < 110) continue;
        for (const s of [-1, 1]) {
          const tm = new THREE.MeshStandardMaterial({ color: towelCols[(k++) % towelCols.length], roughness: 1 });
          disposables.push(tm);
          const m = new THREE.Mesh(towelGeo, tm);
          const tx = o.x + s * 1.15;
          const tz = o.z + (hash2(tx, o.z) - 0.5) * 0.8;
          const slopeZ = Math.atan2(macro(tx + 0.5, tz) - macro(tx - 0.5, tz), 1.0);
          m.position.set(tx, groundY(tx, tz) + 0.015, tz);
          m.rotation.set(0, (hash2(o.z, tx) - 0.5) * 0.7, slopeZ);
          m.receiveShadow = true;
          group.add(m);
        }
      }
      // волейбол: линии площадки и сетка
      const cx = 132;
      const cz = -47;
      rect(whiteD, cx, cz, 9.2, 0.1, 0.06, Math.PI / 2);
      rect(whiteD, cx - 4.6, cz, 0.1, 18, 0.06);
      rect(whiteD, cx + 4.6, cz, 0.1, 18, 0.06);
      rect(whiteD, cx, cz - 9, 9.2, 0.1, 0.06);
      rect(whiteD, cx, cz + 9, 9.2, 0.1, 0.06);
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const cx2 = c.getContext('2d')!;
      cx2.strokeStyle = 'rgba(255,255,255,0.95)';
      cx2.lineWidth = 3;
      for (let i = 0; i <= 64; i += 16) {
        cx2.beginPath();
        cx2.moveTo(i, 0);
        cx2.lineTo(i, 64);
        cx2.moveTo(0, i);
        cx2.lineTo(64, i);
        cx2.stroke();
      }
      const netTex = new THREE.CanvasTexture(c);
      netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
      netTex.repeat.set(20, 2);
      const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
      const netGeo = new THREE.PlaneGeometry(10, 1, 1, 1);
      const net = new THREE.Mesh(netGeo, netMat);
      net.position.set(132, macro(132, -47) + 1.95, -47);
      net.rotation.y = Math.PI / 2;
      group.add(net);
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 10), whiteD);
      band.position.set(132, macro(132, -47) + 2.46, -47);
      group.add(band);
      disposables.push(netTex, netMat, netGeo, band.geometry);
    }

    // --- Цветочные клумбы в парке ---
    {
      const flowerGeo = new THREE.SphereGeometry(0.1, 6, 5);
      const flowerMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 });
      disposables.push(flowerGeo, flowerMat);
      const cols = ['#f43f5e', '#facc15', '#ffffff', '#a855f7', '#fb923c', '#38bdf8'];
      const fr = rng(404);
      const pts: { x: number; z: number; c: number }[] = [];
      for (let b = 0; b < 14; b++) {
        const bx = -76 + fr() * 58;
        const bz = 18 + fr() * 58;
        if (Math.abs((bx + 47) + (bz - 47)) < 8 || Math.abs((bx + 47) - (bz - 47)) < 8) continue;
        const dRing = Math.hypot(bx + 47, bz - 47);
        if (dRing > 15 && dRing < 27) continue;
        const col = Math.floor(fr() * cols.length);
        for (let i = 0; i < 16; i++) pts.push({ x: bx + (fr() - 0.5) * 2.6, z: bz + (fr() - 0.5) * 2.6, c: col });
      }
      const im = new THREE.InstancedMesh(flowerGeo, flowerMat, pts.length);
      pts.forEach((pt, i) => {
        m4.compose(pv.set(pt.x, groundY(pt.x, pt.z) + 0.1, pt.z), q.identity(), sv.set(1, 1, 1));
        im.setMatrixAt(i, m4);
        im.setColorAt(i, new THREE.Color(cols[pt.c]));
      });
      group.add(im);
    }
  };

  // ==========================================================================
  // РЕНДЕР КАРТЫ 1: ПОЛИГОН
  // ==========================================================================
  // Вывески участков карты (terrain.signs)
  const sizeLabel = (label: THREE.Sprite, tex: THREE.Texture) => {
    if (signMode) label.scale.set(2.5 * (tex.userData.aspect as number), 2.5, 1);
    else label.scale.set(18, 4.5, 1);
  };
  const addLabel = (title: string, icon: string, x: number, y: number, z: number) => {
    const lTex = labelTexture(tr(title), icon, signMode ? 'sign' : 'hud');
    const lMat = new THREE.SpriteMaterial({ map: lTex, transparent: true, depthWrite: false });
    const label = new THREE.Sprite(lMat);
    label.position.set(x, y, z);
    labels.push({ mat: lMat, sprite: label, text: title, icon });
    sizeLabel(label, lTex);
    group.add(label);
    disposables.push(lTex, lMat);
  };
  const addSigns = () => {
    for (const sg of terrain.signs) {
      // в городе табличка поднимается над ближайшим высоким зданием, чтобы не прорезать фасады
      let y = macro(sg.x, sg.z) + (signMode ? 9 : 8.5);
      if (signMode)
        for (const b of terrain.boxes) {
          const r = Math.max(b.halfX, b.halfZ) * 1.42 + 2;
          if (Math.abs(b.x - sg.x) < r && Math.abs(b.z - sg.z) < r) y = Math.max(y, macro(b.x, b.z) + b.h + 2.5);
        }
      addLabel(sg.title, sg.icon, sg.x, y, sg.z);
    }
  };

  if (terrain.mapId === 'polygon') {
    for (let iz = -1; iz <= 1; iz++) {
      for (let ix = -1; ix <= 1; ix++) {
        const sid = LAYOUT[iz + 1][ix + 1];
        const cx = ix * CELL;
        const cz = iz * CELL;
        addTerrainPatch(cx, cz, CELL, CELL, sid, 0, 0, CELL / 64);

        const def = SURFACES[sid];
        addLabel(def.name, def.icon, cx, macro(cx, cz) + 8, cz);
      }
    }

    // Разметка полигона
    for (let x = -56; x < 56; x += 4) {
      addLine(x + 2, -7, 4, 0.16, white);
      addLine(x + 2, 7, 4, 0.16, white);
      if (Math.floor((x + 56) / 4) % 2 === 0) addLine(x + 1.5, 0, 3, 0.14, yellow);
    }
    addLine(0, 0, 0.5, 14, white);
    for (let z = -5; z <= 5; z += 1) addLine(-26, z, 3, 0.5, white);

    // Стиральная доска (гребёнка)
    {
      const g = new THREE.BoxGeometry(0.16, 0.012, WASH.halfW * 2);
      const mt = new THREE.MeshStandardMaterial({ color: '#1f2023', roughness: 0.9 });
      const n = Math.floor((WASH.x1 - WASH.x0) / WASH.wl);
      const im = new THREE.InstancedMesh(g, mt, n);
      for (let i = 0; i < n; i++) {
        const wx = WASH.x0 + (i + 0.25) * WASH.wl;
        pv.set(wx, macro(wx, 0) + 0.005, 0);
        q.identity();
        sv.set(1, 1, 1);
        m4.compose(pv, q, sv);
        im.setMatrixAt(i, m4);
      }
      group.add(im);
      disposables.push(g, mt);
    }

    // Ямы
    {
      const mt = new THREE.MeshBasicMaterial({
        color: '#0d0d0e',
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      for (const p of POTHOLES) {
        const g = new THREE.CircleGeometry(p.r, 24).rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, mt);
        m.position.set(p.x, macro(p.x, p.z) + 0.011, p.z);
        group.add(m);
        disposables.push(g);
      }
      disposables.push(mt);
    }
  } else if (terrain.mapId === 'city') {
    // ==========================================================================
    // РЕНДЕР КАРТЫ 2: ГОРОД (CITY)
    // ==========================================================================
    // Уровни видимой поверхности: тротуары/кварталы выше проезжей части на высоту бордюра 3.2 см
    const G0 = 0.032;
    const R0 = 0.005;

    // Слой 0. Базовая плиточная поверхность кварталов и тротуаров
    for (let iz = -1; iz <= 1; iz++) {
      for (let ix = -1; ix <= 1; ix++) {
        addTerrainPatch(ix * CELL, iz * CELL, CELL, CELL, 'tiles', 0, G0);
      }
    }

    // Слой 1. Специализированные зоны покрытий в кварталах города
    // СЗ: Ледовый каток (snow) с светящимися бортиками
    addTerrainPatch(-47, -47, 34, 34, 'snow', 1, G0);
    {
      const rinkWallMat = new THREE.MeshStandardMaterial({
        color: '#e0f2fe',
        roughness: 0.3,
        emissive: new THREE.Color('#38bdf8'),
        emissiveIntensity: 0.35,
      });
      nightEmissiveMats.push({ mat: rinkWallMat, nightI: 1.1, sunsetI: 0.55 });
      const addRinkBorder = (bx: number, bz: number, lx: number, lz: number) => {
        const g = new THREE.BoxGeometry(lx, 0.22, lz);
        const m = new THREE.Mesh(g, rinkWallMat);
        m.position.set(bx, macro(bx, bz) + 0.14, bz);
        group.add(m);
        disposables.push(g);
      };
      // Бортики с проездами посередине для въезда на каток
      addRinkBorder(-47, -64, 34, 0.25);
      addRinkBorder(-64, -47, 0.25, 34);
      addRinkBorder(-56.5, -30, 15, 0.25);
      addRinkBorder(-37.5, -30, 15, 0.25);
      addRinkBorder(-30, -56.5, 0.25, 15);
      addRinkBorder(-30, -37.5, 0.25, 15);
      disposables.push(rinkWallMat);
    }

    // СВ: Асфальтовая стрит-плаза / скейт-парк
    addTerrainPatch(47, -37, 50, 30, 'asphalt', 1, G0);

    // ЮЗ: Городской парк (трава)
    addTerrainPatch(-47, 47, 66, 66, 'grass', 1, G0);
    // Слой 2. Грунтовое кольцо памп-трека в парке
    {
      const ringGeo = new THREE.RingGeometry(18, 24.5, 64, 10);
      ringGeo.rotateX(-Math.PI / 2);
      const pos = ringGeo.attributes.position as THREE.BufferAttribute;
      const uv = ringGeo.attributes.uv as THREE.BufferAttribute;
      const meters = getSurfTex('dirt').meters;
      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i) - 47;
        const wz = pos.getZ(i) + 47;
        pos.setY(i, macro(wx, wz) + G0);
        uv.setXY(i, wx / meters, wz / meters);
      }
      ringGeo.computeVertexNormals();
      const ringMesh = new THREE.Mesh(ringGeo, getSurfMat('dirt', 2));
      ringMesh.position.set(-47, 0, 47);
      finishGround(ringMesh, 2);
      disposables.push(ringGeo);
    }
    // Слой 3. Диагональные гравийные аллеи парка (как в surfaceAtCity)
    {
      const clip = { x0: -80, x1: -14, z0: 14, z1: 80 };
      addClippedStrip(-47, 47, 104, 7.8, Math.PI / 4, clip, 'gravel', 3, G0);
      addClippedStrip(-47, 47, 104, 7.1, -Math.PI / 4, clip, 'gravel', 3, G0);
    }

    // ЮВ: Старый город (историческая брусчатка)
    addTerrainPatch(47, 47, 66, 66, 'cobble', 1, G0);

    // Восток: Городской песчаный пляж (x ∈ [116, 176])
    addTerrainPatch(146, 0, 60, 160, 'sand', 1, G0);

    // Запад: Гравийный строй-полигон (СЗ) и Грунтовый лесопарк (ЮЗ)
    addTerrainPatch(-138, -47, 72, 66, 'gravel', 1, G0);
    addTerrainPatch(-138, 47, 72, 66, 'dirt', 1, G0);

    // Северный панорамный холм (трава) и Южный бульвар
    addTerrainPatch(0, -140, 340, 76, 'grass', 1, G0);
    addTerrainPatch(0, 140, 340, 76, 'grass', 1, G0);

    // Слой 4. АСФАЛЬТОВАЯ ДОРОЖНАЯ СЕТЬ ГОРОДА (проезжая часть ниже бордюра, всегда поверх всех зон)
    // Главный проспект (вдоль X, ширина 18 м)
    addTerrainPatch(0, 0, 360, 18, 'asphalt', 4, R0);
    // Центральный бульвар (вдоль Z, ширина 18 м)
    addTerrainPatch(0, 0, 18, 360, 'asphalt', 4, R0);
    // Внешнее кольцо у границы арены (x, z = ±168)
    for (const s of [-1, 1]) {
      addTerrainPatch(0, s * 168, 349, 13, 'asphalt', 4, R0);
      addTerrainPatch(s * 168, 0, 13, 349, 'asphalt', 4, R0);
    }
    // Кольцевые улицы (x = ±90, z = ±90, ширина 13 м)
    addTerrainPatch(0, -90, 336, 13, 'asphalt', 4, R0);
    addTerrainPatch(0, 90, 336, 13, 'asphalt', 4, R0);
    addTerrainPatch(-90, 0, 13, 336, 'asphalt', 4, R0);
    addTerrainPatch(90, 0, 13, 336, 'asphalt', 4, R0);

    // Слой 5. Особые покрытия проезжей части
    // Мокрый асфальт (участок теста ABS на Восточной улице и проспекте)
    addTerrainPatch(90, -46, 13, 64, 'wet', 5, R0);
    addTerrainPatch(132, 0, 60, 18, 'wet', 5, R0);
    // Брусчатый переезд Южной улицы в Старом городе
    addTerrainPatch(48, 90, 48, 13, 'cobble', 5, R0);

    // 4. РАЗМЕТКА, БОРДЮРЫ, ПЕШЕХОДНЫЕ ПЕРЕХОДЫ, СТОП-ЛИНИИ, СТРЕЛКИ (генерируются по схеме дорог)
    type Road = { c: number; hw: number; ext: number; main: boolean };
    const roads: Road[] = [
      { c: 0, hw: 9, ext: 180, main: true },
      { c: -90, hw: 6.5, ext: 168, main: false },
      { c: 90, hw: 6.5, ext: 168, main: false },
      { c: -168, hw: 6.5, ext: 174.5, main: false },
      { c: 168, hw: 6.5, ext: 174.5, main: false },
    ];
    type Axis = 'x' | 'z'; // 'x': дорога идёт вдоль X (z = c), 'z': вдоль Z (x = c)
    const crossing = (r: Road) => roads.filter((o) => Math.abs(r.c) <= o.ext && Math.abs(o.c) <= r.ext).map((o) => o.c);
    const putLine = (axis: Axis, r: Road, along: number, off: number, len: number, wid: number, mat: THREE.Material, y = 0.014, yaw = 0) => {
      if (axis === 'x') addLine(along, r.c + off, len, wid, mat, y, yaw);
      else addLine(r.c + off, along, wid, len, mat, y, yaw);
    };
    const LIM = HALF - 3;

    // материалы бордюра, ливнёвок и заплат (освещаются, в отличие от краски)
    const curbMat = new THREE.MeshStandardMaterial({
      color: '#c9cacc',
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const gutterMat = new THREE.MeshStandardMaterial({
      color: '#2d2e32',
      roughness: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const patchMat = new THREE.MeshStandardMaterial({
      color: '#2f3034',
      roughness: 0.97,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const grateTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#17181a';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#6b7078';
      for (let i = 0; i < 7; i++) g.fillRect(6 + i * 8, 5, 4, 54);
      g.strokeStyle = '#8a8f96';
      g.lineWidth = 4;
      g.strokeRect(2, 2, 60, 60);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    })();
    const grateMat = new THREE.MeshStandardMaterial({
      map: grateTex,
      roughness: 0.6,
      metalness: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const arrowTex = { straight: roadArrowTexture('straight'), left: roadArrowTexture('left') };
    const arrowMat = (k: 'straight' | 'left') => {
      const m = new THREE.MeshBasicMaterial({
        map: arrowTex[k],
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
      });
      paintMats.push({ mat: m, base: m.color.clone() });
      return m;
    };
    const arrowStraight = arrowMat('straight');
    const arrowLeft = arrowMat('left');
    disposables.push(curbMat, gutterMat, patchMat, grateTex, grateMat, arrowTex.straight, arrowTex.left, arrowStraight, arrowLeft);

    for (const axis of ['x', 'z'] as Axis[]) {
      for (const r of roads) {
        const js = crossing(r);
        const free = (p: number, rad = 13) => js.every((j) => Math.abs(p - j) > rad);
        const dMax = Math.floor((Math.min(r.ext, LIM) - 3) / 6) * 6;
        for (let d = -dMax; d <= dMax; d += 6) {
          if (!free(d)) continue;
          if (r.main) {
            putLine(axis, r, d, -0.18, 5.8, 0.1, yellow, 0.015);
            putLine(axis, r, d, 0.18, 5.8, 0.1, yellow, 0.015);
            for (const s of [-1, 1]) {
              putLine(axis, r, d, s * 3.6, 2.8, 0.12, white, 0.015);
              putLine(axis, r, d, s * 7.8, 6.0, 1.4, bikeLaneMat, 0.012);
              putLine(axis, r, d, s * 7.0, 6.0, 0.12, white, 0.015);
            }
          } else {
            putLine(axis, r, d, 0, 2.8, 0.12, yellow, 0.015);
            for (const s of [-1, 1]) putLine(axis, r, d, s * 5.6, 5.8, 0.12, white, 0.015);
          }
        }

        // бордюры: светлая кромка тротуара и тёмный лоток на проезжей части, прерываются на перекрёстках
        for (const s of [-1, 1]) {
          let start: number | null = null;
          const flush = (end: number) => {
            if (start === null) return;
            const len = end - start;
            if (len > 0.8) {
              const mid = (start + end) / 2;
              putLine(axis, r, mid, s * (r.hw + 0.15), len, 0.3, curbMat, 0.038);
              putLine(axis, r, mid, s * (r.hw - 0.2), len, 0.4, gutterMat, 0.009);
            }
            start = null;
          };
          const lim = Math.min(r.ext, HALF - 0.2);
          for (let p = -lim; p <= lim + 0.01; p += 0.5) {
            const out = axis === 'x' ? isCityRoad(p, r.c + s * (r.hw + 0.4)) : isCityRoad(r.c + s * (r.hw + 0.4), p);
            const inn = axis === 'x' ? isCityRoad(p, r.c + s * (r.hw - 0.4)) : isCityRoad(r.c + s * (r.hw - 0.4), p);
            if (!out && inn) start ??= p;
            else flush(p);
          }
          flush(lim);
        }

        // ливнёвки у кромки главных проспектов
        if (r.main)
          for (let p = -144; p <= 144; p += 36) {
            if (!free(p + 18, 14)) continue;
            for (const s of [-1, 1]) putLine(axis, r, p + 18, s * 8.55, 0.95, 0.5, grateMat, 0.016);
          }
      }
    }

    // заплаты асфальта и трещины на главных проспектах
    for (let i = 0; i < 22; i++) {
      const axis: Axis = i % 2 ? 'x' : 'z';
      const p = (hash2(i, 3.1) - 0.5) * 300;
      if (Math.abs(p) < 20) continue;
      if (Math.abs(Math.abs(p) - 90) < 14) continue;
      const off = (hash2(i, 8.7) > 0.5 ? 1 : -1) * (1.2 + hash2(i, 2.2) * 4.6);
      const sw = 1.1 + hash2(i, 5.5) * 1.4;
      const sl = 1.8 + hash2(i, 6.6) * 2.6;
      putLine(axis, roads[0], p, off, sl, sw, patchMat, 0.008);
      if (i % 3 === 0) putLine(axis, roads[0], p + sl * 0.7, off + sw * 0.6, 3.5 + hash2(i, 1.1) * 3, 0.05, gutterMat, 0.009, (hash2(i, 4.4) - 0.5) * 0.6);
    }

    // стартовая линия у центра
    addLine(4.5, 0, 0.45, 16, orangeLineMat, 0.016);

    // переходы «зебра», стоп-линии и стрелки на въездах в перекрёстки
    for (const rx of roads)
      for (const rz of roads) {
        if (Math.abs(rx.c) > rz.ext || Math.abs(rz.c) > rx.ext) continue;
        const jx = rz.c;
        const jz = rx.c;
        for (const axis of ['x', 'z'] as Axis[]) {
          const r = axis === 'x' ? rx : rz;
          const along0 = axis === 'x' ? jx : jz;
          const js = crossing(r);
          for (const s of [-1, 1]) {
            const probe = along0 + s * 17;
            if (Math.abs(probe) > LIM) continue;
            if (!(axis === 'x' ? isCityRoad(probe, jz) : isCityRoad(jx, probe))) continue;
            const span = r.hw - 1.6;
            for (let k = -span; k <= span + 0.01; k += 1.2) putLine(axis, r, along0 + s * 11.5, k, 3.0, 0.6, white, 0.016);
            const hi = r.main ? 7.0 : 5.3;
            const side = axis === 'x' ? -s : s;
            putLine(axis, r, along0 + s * 14.6, side * (0.4 + hi) * 0.5, 0.45, hi - 0.4, white, 0.016);
            // стрелки: во внутренней полосе поворот налево, во внешней — прямо
            const farJ = js.some((j) => Math.abs(j - (along0 + s * 28)) < 14 && j !== along0);
            if (farJ || Math.abs(along0 + s * 28) > LIM - 3) continue;
            const yaw = axis === 'x' ? s * (Math.PI / 2) : s > 0 ? 0 : Math.PI;
            const lanes: [number, THREE.Material][] = r.main ? [[2.0, arrowLeft], [5.3, arrowStraight]] : [[3.0, arrowStraight]];
            for (const [lane, mat] of lanes) putLine(axis, r, along0 + s * 28, side * lane, 1.5, 3.0, mat, 0.017, yaw);
          }
        }
      }

    // 5. 3D-ЗДАНИЯ (разных стилей), АВТОМОБИЛИ (разные кузова), ОСТАНОВКИ, ЛАВКИ, КИОСКИ,
    //    КОНТЕЙНЕРЫ, КРАН, ФОНТАН И ПР. (из terrain.boxes)
    const metalDarkMat = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.4, metalness: 0.6 });
    disposables.push(metalDarkMat);
    decor.buildBoxes(terrain.boxes);
    decor.buildProps(terrain.obstacles);
    buildGroundDecor();

    // 6. УЛИЧНЫЕ ФОНАРИ, СВЕТОФОРЫ И БОЛЛАРДЫ (из terrain.obstacles; размер совпадает с коллайдером)
    const lampSpots = terrain.obstacles.filter((o) => o.kind === 'lamp');
    const signSpots = terrain.obstacles.filter((o) => o.kind === 'sign');
    const bollardSpots = terrain.obstacles.filter((o) => o.kind === 'bollard');

    const Y = new THREE.Vector3(0, 1, 0);
    const xf = (x: number, y: number, z: number, yaw = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(Y, yaw), new THREE.Vector3(1, 1, 1));
    const rel = (base: THREE.Matrix4, local: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(base, local);
    const makeInst = (geo: THREE.BufferGeometry, mat: THREE.Material, cast = false) => {
      const list: THREE.Matrix4[] = [];
      disposables.push(geo);
      return {
        push: (m: THREE.Matrix4) => list.push(m),
        build: () => {
          if (!list.length) return;
          const im = new THREE.InstancedMesh(geo, mat, list.length);
          list.forEach((m, i) => im.setMatrixAt(i, m));
          im.castShadow = cast;
          im.receiveShadow = true;
          group.add(im);
        },
      };
    };
    const poleMat = new THREE.MeshStandardMaterial({ color: '#59606a', roughness: 0.5, metalness: 0.55 });
    const housingMat = new THREE.MeshStandardMaterial({ color: '#25282d', roughness: 0.55, metalness: 0.3 });
    disposables.push(poleMat, housingMat);

    // --- фонари: цоколь, конусная опора, кронштейн с подкосом, светильник с линзой ---
    if (lampSpots.length > 0) {
      const lensMat = new THREE.MeshStandardMaterial({ color: '#fff6e0', emissive: new THREE.Color('#ffcf70'), emissiveIntensity: 0.25 });
      nightEmissiveMats.push({ mat: lensMat, nightI: 3.2, sunsetI: 1.6 });
      disposables.push(lensMat);
      const base = makeInst(new THREE.CylinderGeometry(0.15, 0.18, 0.5, 12).translate(0, 0.25, 0), poleMat, true);
      const collar = makeInst(new THREE.CylinderGeometry(0.115, 0.14, 0.14, 12).translate(0, 0.57, 0), poleMat);
      const pole = makeInst(new THREE.CylinderGeometry(0.055, 0.1, 5.5, 10).translate(0, 0.5 + 2.75, 0), poleMat, true);
      const arm = makeInst(new THREE.BoxGeometry(1.9, 0.07, 0.07).translate(0.95, 6.0, 0), poleMat, true);
      const brace = makeInst(new THREE.BoxGeometry(1.0, 0.045, 0.045), poleMat);
      const head = makeInst(new THREE.BoxGeometry(0.95, 0.1, 0.34).translate(1.75, 6.1, 0), housingMat, true);
      const lens = makeInst(new THREE.BoxGeometry(0.8, 0.02, 0.26).translate(1.75, 6.04, 0), lensMat);
      const glowPos: number[] = [];
      const poolList: THREE.Matrix4[] = [];
      for (const l of lampSpots) {
        const gy = groundY(l.x, l.z);
        let dir: [number, number] | null = null;
        for (const d of [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ] as [number, number][])
          if (isCityRoad(l.x + d[0] * 3, l.z + d[1] * 3)) {
            dir = d;
            break;
          }
        if (!dir) dir = Math.abs(l.x) > Math.abs(l.z) ? [-Math.sign(l.x) || 1, 0] : [0, -Math.sign(l.z) || 1];
        const yaw = Math.atan2(-dir[1], dir[0]);
        const b = xf(l.x, gy, l.z, yaw);
        base.push(b);
        collar.push(b);
        pole.push(b);
        arm.push(b);
        brace.push(rel(b, new THREE.Matrix4().makeRotationZ(0.62).setPosition(0.46, 5.62, 0)));
        head.push(b);
        lens.push(b);
        const hx = l.x + dir[0] * 1.75;
        const hz = l.z + dir[1] * 1.75;
        glowPos.push(hx, gy + 5.95, hz);
        poolList.push(xf(hx, gy + 0.05, hz));
      }
      for (const i of [base, collar, pole, arm, brace, head, lens]) i.build();

      // свечение: без PointLight (их число было бы взрывным), только аддитивные спрайты
      const gTex = glowTexture();
      const glowGeo = new THREE.BufferGeometry();
      glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
      const glowMat = new THREE.PointsMaterial({
        map: gTex,
        color: '#ffc468',
        size: 3.2,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.Points(glowGeo, glowMat);
      glow.frustumCulled = false;
      glow.visible = false;
      group.add(glow);
      const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      const poolMat = new THREE.MeshBasicMaterial({
        map: gTex,
        color: '#ffb35a',
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      });
      const pools = new THREE.InstancedMesh(poolGeo, poolMat, poolList.length);
      poolList.forEach((m, i) => {
        m.scale(new THREE.Vector3(10, 1, 10));
        pools.setMatrixAt(i, m);
      });
      pools.frustumCulled = false;
      pools.visible = false;
      pools.renderOrder = 4;
      group.add(pools);
      disposables.push(gTex, glowGeo, glowMat, poolGeo, poolMat);
      lampLights.push(glow, pools);
    }

    // --- светофоры: консольные кронштейны над проезжей частью, головки с козырьками, пешеходные секции ---
    if (signSpots.length > 0) {
      const junctions: [number, number][] = [];
      for (const rx of roads) for (const rz of roads) if (Math.abs(rx.c) <= rz.ext && Math.abs(rz.c) <= rx.ext) junctions.push([rz.c, rx.c]);
      const mk = (c: string) => new THREE.MeshBasicMaterial({ color: c });
      const dim = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 });
      const redOn = mk('#ff3030');
      const ambOn = mk('#ffb020');
      const grnOn = mk('#27e06a');
      const redOff = dim('#3a1010');
      const ambOff = dim('#3a2a0a');
      const grnOff = dim('#0e3018');
      const manMat = mk('#ff4a3a');
      const btnMat = new THREE.MeshStandardMaterial({ color: '#e8c020', roughness: 0.5 });
      disposables.push(redOn, ambOn, grnOn, redOff, ambOff, grnOff, manMat, btnMat);
      const poleI = makeInst(new THREE.CylinderGeometry(0.075, 0.115, 5.6, 10).translate(0, 2.8, 0), poleMat, true);
      const collarI = makeInst(new THREE.CylinderGeometry(0.15, 0.185, 0.3, 12).translate(0, 0.15, 0), poleMat, true);
      const armI = makeInst(new THREE.BoxGeometry(5.6, 0.1, 0.1).translate(2.8, 5.35, 0), poleMat, true);
      const housI = makeInst(new THREE.BoxGeometry(0.36, 1.05, 0.28), housingMat, true);
      const backI = makeInst(new THREE.BoxGeometry(0.62, 1.32, 0.03).translate(0, 0, -0.16), housingMat);
      const visorI = makeInst(new THREE.BoxGeometry(0.28, 0.03, 0.2).translate(0, 0, 0.2), housingMat);
      const lensGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.03, 14).rotateX(Math.PI / 2);
      const lensI = {
        r: [makeInst(lensGeo, redOn), makeInst(lensGeo, redOff)],
        a: [makeInst(lensGeo, ambOn), makeInst(lensGeo, ambOff)],
        g: [makeInst(lensGeo, grnOn), makeInst(lensGeo, grnOff)],
      };
      const pedI = makeInst(new THREE.BoxGeometry(0.34, 0.42, 0.2), housingMat, true);
      const manI = makeInst(new THREE.BoxGeometry(0.16, 0.2, 0.02).translate(0, 0.06, 0.11), manMat);
      const btnI = makeInst(new THREE.BoxGeometry(0.1, 0.14, 0.06).translate(0, 0, 0.1), btnMat);
      for (const s of signSpots) {
        const gy = macro(s.x, s.z);
        let jc = junctions[0] ?? [0, 0];
        let best = Infinity;
        for (const j of junctions) {
          const d = Math.hypot(j[0] - s.x, j[1] - s.z);
          if (d < best) {
            best = d;
            jc = j;
          }
        }
        const dxj = Math.sign(jc[0] - s.x) || 1;
        const dzj = Math.sign(jc[1] - s.z) || 1;
        const goZ = hash2(jc[0], jc[1]) > 0.5;
        const b0 = xf(s.x, gy, s.z);
        poleI.push(b0);
        collarI.push(b0);
        // кронштейн 1 идёт вдоль X к оси перекрёстка (головки смотрят вдоль Z), кронштейн 2 — вдоль Z (головки смотрят вдоль X)
        for (const [dirx, dirz, fx, fz, green] of [
          [dxj, 0, 0, -dzj, goZ],
          [0, dzj, -dxj, 0, !goZ],
        ] as [number, number, number, number, boolean][]) {
          const armB = xf(s.x, gy + (dirx ? 0 : -0.35), s.z, Math.atan2(-dirz, dirx));
          armI.push(armB);
          const fyaw = Math.atan2(fx, fz);
          for (const ad of [2.4, 4.9]) {
            const hb = xf(s.x + dirx * ad, gy + (dirx ? 4.75 : 4.4), s.z + dirz * ad, fyaw);
            housI.push(hb);
            backI.push(hb);
            for (const ly of [0.31, 0, -0.31]) visorI.push(rel(hb, new THREE.Matrix4().makeTranslation(0, ly + 0.1, 0)));
            lensI.r[green ? 1 : 0].push(rel(hb, new THREE.Matrix4().makeTranslation(0, 0.31, 0.15)));
            lensI.a[1].push(rel(hb, new THREE.Matrix4().makeTranslation(0, 0, 0.15)));
            lensI.g[green ? 0 : 1].push(rel(hb, new THREE.Matrix4().makeTranslation(0, -0.31, 0.15)));
          }
          // пешеходная секция и кнопка на опоре
          const pb = xf(s.x + fx * 0.14, gy + 2.55, s.z + fz * 0.14, fyaw);
          pedI.push(pb);
          manI.push(pb);
          btnI.push(xf(s.x + fx * 0.1, gy + 1.15, s.z + fz * 0.1, fyaw));
        }
      }
      for (const i of [poleI, collarI, armI, housI, backI, visorI, pedI, manI, btnI, ...Object.values(lensI).flat()]) i.build();
    }

    // --- болларды: стальной корпус, купол, светоотражающие кольца ---
    if (bollardSpots.length > 0) {
      const bodyMat = new THREE.MeshStandardMaterial({ color: '#3a4049', roughness: 0.4, metalness: 0.55 });
      const bandMat = new THREE.MeshStandardMaterial({ color: '#f1f5f9', roughness: 0.35, emissive: new THREE.Color('#f1f5f9'), emissiveIntensity: 0.05 });
      const orMat = new THREE.MeshStandardMaterial({ color: '#ff6a13', roughness: 0.45 });
      disposables.push(bodyMat, bandMat, orMat);
      const body = makeInst(new THREE.CylinderGeometry(0.115, 0.125, 0.72, 14).translate(0, 0.36, 0), bodyMat, true);
      const cap = makeInst(new THREE.SphereGeometry(0.115, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.72, 0), bodyMat, true);
      const band = makeInst(new THREE.CylinderGeometry(0.119, 0.119, 0.07, 14).translate(0, 0.6, 0), bandMat);
      const stripe = makeInst(new THREE.CylinderGeometry(0.121, 0.123, 0.1, 14).translate(0, 0.14, 0), orMat);
      for (const bl of bollardSpots) {
        const m = xf(bl.x, groundY(bl.x, bl.z), bl.z);
        body.push(m);
        cap.push(m);
        band.push(m);
        stripe.push(m);
      }
      for (const i of [body, cap, band, stripe]) i.build();
    }

    // 7. Навигационные вывески кварталов города
    addSigns();
  }

  // ==========================================================================
  // РЕНДЕР КАРТЫ 3: ГОРНЫЙ СПУСК (HILL)
  // ==========================================================================
  if (terrain.mapId === 'hill') {
    // Земля — мозаика квадратов по terrain.surface, без слоёв поверх: на крутом рельефе
    // слои с depthFunc = Always просвечивали бы сквозь перегибы склона.
    type Bucket = { pos: number[]; nrm: number[]; uv: number[]; meters: number };
    const buckets = new Map<SurfaceId, Bucket>();
    // соседние квады делят вершины: высота и нормаль считаются один раз на узел сетки (шаг ≥ 0.75 м)
    const vcache = new Map<number, number>();
    const vdata: number[] = [];
    const pushVert = (b: Bucket, x: number, z: number, yOff: number) => {
      const key = (Math.round(x * 4) + 8192) * 16384 + (Math.round(z * 4) + 8192);
      let i = vcache.get(key);
      if (i === undefined) {
        const e = 0.6;
        const gx = (macro(x + e, z) - macro(x - e, z)) / (2 * e);
        const gz = (macro(x, z + e) - macro(x, z - e)) / (2 * e);
        const l = Math.hypot(gx, 1, gz);
        i = vdata.length;
        vdata.push(macro(x, z), -gx / l, 1 / l, -gz / l);
        vcache.set(key, i);
      }
      b.pos.push(x, vdata[i] + yOff, z);
      b.nrm.push(vdata[i + 1], vdata[i + 2], vdata[i + 3]);
      b.uv.push(x / b.meters, z / b.meters);
    };
    const quad = (x0: number, z0: number, s: number, sid: SurfaceId, yOff = 0) => {
      let b = buckets.get(sid);
      if (!b) {
        b = { pos: [], nrm: [], uv: [], meters: getSurfTex(sid).meters };
        buckets.set(sid, b);
      }
      pushVert(b, x0, z0, yOff);
      pushVert(b, x0, z0 + s, yOff);
      pushVert(b, x0 + s, z0, yOff);
      pushVert(b, x0 + s, z0, yOff);
      pushVert(b, x0, z0 + s, yOff);
      pushVert(b, x0 + s, z0 + s, yOff);
    };
    const flush = (shadow: boolean) => {
      for (const [sid, b] of buckets) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
        const mesh = new THREE.Mesh(geo, getSurfMat(sid, 0));
        mesh.renderOrder = GROUND_RO;
        mesh.receiveShadow = shadow;
        group.add(mesh);
        disposables.push(geo);
      }
      buckets.clear();
    };

    // Арена: крупная сетка 3 м, у тропы и площадок — мелкая 0.75 м
    const COARSE = 3;
    const SUB = 4;
    for (let x0 = -HALF; x0 < HALF; x0 += COARSE) {
      for (let z0 = -HALF; z0 < HALF; z0 += COARSE) {
        const cx = x0 + COARSE / 2;
        const cz = z0 + COARSE / 2;
        const fine = hillTrailDist(cx, cz) < 19 || (cx < -146 && Math.abs(cz) < 16);
        if (!fine) {
          quad(x0, z0, COARSE, terrain.surface(cx, cz));
          continue;
        }
        const s = COARSE / SUB;
        for (let i = 0; i < SUB; i++) {
          for (let j = 0; j < SUB; j++) {
            const fx = x0 + i * s;
            const fz = z0 + j * s;
            quad(fx, fz, s, terrain.surface(fx + s / 2, fz + s / 2));
          }
        }
      }
    }
    flush(true);

    // Гора за ограждением: редкая сетка, чтобы склон не обрывался у забора
    const FAR = 30;
    for (let x0 = -900; x0 < 900; x0 += FAR) {
      for (let z0 = -900; z0 < 900; z0 += FAR) {
        const cx = x0 + FAR / 2;
        const cz = z0 + FAR / 2;
        if (Math.abs(cx) < HALF && Math.abs(cz) < HALF) continue;
        quad(x0, z0, FAR, terrain.surface(cx, cz) === 'snow' ? 'snow' : 'grass', -0.05);
      }
    }
    flush(false);

    // Ручей
    {
      const g = new THREE.PlaneGeometry(6, HALF * 2, 4, 120);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, macro(pos.getX(i) + 105, pos.getZ(i)) + 0.03);
      g.computeVertexNormals();
      const mt = new THREE.MeshStandardMaterial({ color: '#3f86b8', roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.5, depthWrite: false });
      const water = new THREE.Mesh(g, mt);
      water.position.x = 105;
      group.add(water);
      disposables.push(g, mt);
    }

    // Препятствия трассы (terrain.boxes)
    const { M, add, box } = decor;
    const bark = M('#6b4a2f', { rough: 0.95 });
    const cut = M('#c9a26b', { rough: 0.9 });
    const concrete = M('#b8bcc2', { rough: 0.9 });
    const warn = M('#ff6a13', { rough: 0.6 });
    const hay = M('#d9b24c', { rough: 1 });
    const cabinWall = M('#7a5230', { rough: 0.9 });
    const cabinRoof = M('#3d2b23', { rough: 0.85 });
    const SINK = 1.2; // объекты уходят в землю, чтобы на уклоне под ними не было щели
    for (const b of terrain.boxes) {
      const gy = macro(b.x, b.z);
      const w = b.halfX * 2;
      const d = b.halfZ * 2;
      if (b.kind === 'log') {
        const r = b.h * 0.56;
        const geo = decor.G(`log${d}`, () => new THREE.CylinderGeometry(r, r * 1.08, d, 12).rotateX(Math.PI / 2));
        add(group, geo, bark, b.x, gy + r * 0.86, b.z, true);
        const cap = decor.G('logcap', () => new THREE.CircleGeometry(r * 0.94, 12));
        add(group, cap, cut, b.x, gy + r * 0.86, b.z + b.halfZ + 0.005);
        add(group, cap, cut, b.x, gy + r * 0.86, b.z - b.halfZ - 0.005).rotation.y = Math.PI;
      } else if (b.kind === 'barrier') {
        box(group, w, b.h + SINK, d, concrete, b.x, gy + (b.h - SINK) / 2, b.z, true);
        box(group, w + 0.02, 0.16, d + 0.02, warn, b.x, gy + b.h - 0.14, b.z);
      } else if (b.kind === 'haybale') {
        box(group, w, b.h + SINK, d, hay, b.x, gy + (b.h - SINK) / 2, b.z, true);
      } else if (b.kind === 'arch') {
        box(group, w, b.h + SINK, d, M(b.color ?? '#ff6a13', { rough: 0.6 }), b.x, gy + (b.h - SINK) / 2, b.z, true);
      } else if (b.kind === 'cabin') {
        box(group, w, b.h + SINK, d, cabinWall, b.x, gy + (b.h - SINK) / 2, b.z, true);
        const roof = decor.G('cabinroof', () => new THREE.ConeGeometry(Math.hypot(b.halfX, b.halfZ) * 1.15, 1.8, 4).rotateY(Math.PI / 4));
        add(group, roof, cabinRoof, b.x, gy + b.h + 0.9, b.z, true);
      }
    }
    // Перекладины арок старта и финиша
    const pillars = terrain.boxes.filter((b) => b.kind === 'arch');
    for (let i = 0; i + 1 < pillars.length; i += 2) {
      const a = pillars[i];
      const c = pillars[i + 1];
      const top = Math.max(macro(a.x, a.z), macro(c.x, c.z)) + a.h;
      box(group, 0.5, 0.9, Math.abs(c.z - a.z) + 0.6, M(a.color ?? '#ff6a13', { rough: 0.6 }), a.x, top - 0.45, (a.z + c.z) / 2, true);
    }

    addSigns();
  }

  // ---------- внешняя земля ----------
  const isCity = terrain.mapId === 'city';
  let cityEnv: CityEnv | null = null;
  if (isCity) {
    cityEnv = buildCityEnv({
      group,
      macro,
      track: (o) => {
        disposables.push(o);
        return o;
      },
      nightMats: nightEmissiveMats,
      maxAniso,
    });
  } else {
    const outerGeo = new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2);
    const outerMat = new THREE.MeshStandardMaterial({ color: '#3b4a38', roughness: 1 });
    const outer = new THREE.Mesh(outerGeo, outerMat);
    outer.position.y = -4.2;
    outer.receiveShadow = true;
    group.add(outer);
    disposables.push(outerGeo, outerMat);
  }

  // ---------- ограждение арены ----------
  const segLen = 6;
  const nSeg = (HALF * 2) / segLen;
  const fenceGeo = new THREE.BoxGeometry(segLen, 1, 0.3);
  const fenceMat = new THREE.MeshStandardMaterial({ color: isCity ? '#b4b7bb' : '#9ea2a7', roughness: 0.9 });
  const hazardTex = stripesTexture('#d92d20', '#f5f5f5', 3);
  const hazardMat = new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.7 });
  const capGeo = new THREE.BoxGeometry(segLen, 0.14, 0.36);
  const capMat = new THREE.MeshStandardMaterial({ color: '#ff6a13', roughness: 0.6 });
  const fence = new THREE.InstancedMesh(fenceGeo, fenceMat, nSeg * 4);
  const caps = new THREE.InstancedMesh(capGeo, capMat, nSeg * 4);
  // там, где проспекты упираются в границу арены, — красно-белый барьер
  const hazard = new THREE.InstancedMesh(fenceGeo, hazardMat, 16);
  const sink = isCity ? 1.2 : 4.2;
  let fi = 0;
  let hi = 0;
  let ci = 0;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < nSeg; i++) {
      const t = -HALF + segLen * (i + 0.5);
      let x = 0;
      let z = 0;
      let rot = 0;
      if (side === 0) {
        x = t;
        z = -HALF;
      } else if (side === 1) {
        x = t;
        z = HALF;
      } else if (side === 2) {
        x = -HALF;
        z = t;
        rot = Math.PI / 2;
      } else {
        x = HALF;
        z = t;
        rot = Math.PI / 2;
      }
      const top = macro(x, z) + 1.0;
      const sy = top + sink;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      pv.set(x, -sink + sy / 2, z);
      sv.set(1, sy, 1);
      m4.compose(pv, q, sv);
      if (isCity && Math.abs(t) < 12) hazard.setMatrixAt(hi++, m4);
      else fence.setMatrixAt(fi++, m4);
      pv.set(x, top + 0.07, z);
      sv.set(1, 1, 1);
      m4.compose(pv, q, sv);
      caps.setMatrixAt(ci++, m4);
    }
  }
  fence.count = fi;
  hazard.count = hi;
  fence.castShadow = true;
  fence.receiveShadow = true;
  hazard.castShadow = true;
  group.add(fence, caps, hazard);
  disposables.push(fenceGeo, fenceMat, capGeo, capMat, hazardTex, hazardMat);

  // ---------- горизонт: панорама небоскрёбов ----------
  const bgWinTex = windowsTexture();
  const bMat = new THREE.MeshStandardMaterial({
    map: bgWinTex,
    roughness: 0.8,
    emissive: new THREE.Color('#ffb860'),
    emissiveMap: bgWinTex,
    emissiveIntensity: 0.0,
  });
  nightEmissiveMats.push({ mat: bMat, nightI: 1.2, sunsetI: 0.4 });
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  const nB = 70;
  const buildings = new THREE.InstancedMesh(bGeo, bMat, nB);
  const rb = rng(5);
  for (let i = 0; i < nB; i++) {
    const a = (i / nB) * Math.PI * 2 + rb() * 0.05;
    const rad = 330 + rb() * 120;
    const w = 20 + rb() * 30;
    const h = 25 + rb() * 90;
    pv.set(Math.cos(a) * rad, -4.2 + h / 2, Math.sin(a) * rad);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    sv.set(w, h, w * 1.2);
    m4.compose(pv, q, sv);
    buildings.setMatrixAt(i, m4);
  }
  buildings.visible = terrain.mapId === 'polygon'; // в горах небоскрёбов нет; у города своё окружение (cityEnv)
  group.add(buildings);
  disposables.push(bgWinTex, bMat, bGeo);

  // ---------- деревья и камни (синхронизированы с terrain.obstacles) ----------
  // булыжник: додекаэдр с детерминированным «разбросом» вершин, чтобы камни не были одинаковыми правильными многогранниками
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  {
    const p = rockGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const k = 0.82 + 0.3 * hash2(Math.round(p.getX(i) * 40) + 3, Math.round(p.getY(i) * 40) + Math.round(p.getZ(i) * 40));
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
    }
    rockGeo.computeVertexNormals();
  }
  const rockMat = new THREE.MeshStandardMaterial({ color: '#8a8782', roughness: 1, flatShading: true });

  const treeSpots = terrain.obstacles.filter((o) => o.kind === 'tree');
  const rockSpots = terrain.obstacles.filter((o) => o.kind === 'rock');

  decor.buildTrees(treeSpots);

  if (rockSpots.length > 0) {
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockSpots.length);
    rockSpots.forEach((r, i) => {
      const s = r.scale;
      pv.set(r.x, groundY(r.x, r.z) + s * 0.26, r.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (r.x * 7.3) % 6.28);
      sv.set(s * 0.86, s * 0.68, s * 0.8);
      m4.compose(pv, q, sv);
      rocks.setMatrixAt(i, m4);
    });
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    group.add(rocks);
  }
  disposables.push(rockGeo, rockMat);

  // ---------- динамические сбиваемые конусы ----------
  const coneGeo = new THREE.ConeGeometry(0.17, 0.55, 14);
  const coneBaseGeo = new THREE.BoxGeometry(0.38, 0.035, 0.38);
  const coneMat = new THREE.MeshStandardMaterial({ color: '#ff5a10', roughness: 0.55 });
  const coneBandMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 });
  const bandGeo = new THREE.CylinderGeometry(0.06, 0.094, 0.11, 14);
  const bandGeo2 = new THREE.CylinderGeometry(0.109, 0.143, 0.11, 14);
  const coneGroups: THREE.Group[] = [];

  for (const spot of terrain.cones) {
    const cg = new THREE.Group();
    const gy = terrain.height(spot.x, spot.z);
    cg.position.set(spot.x, gy, spot.z);
    const base = new THREE.Mesh(coneBaseGeo, coneMat);
    base.position.y = 0.018;
    const c = new THREE.Mesh(coneGeo, coneMat);
    c.position.y = 0.275;
    c.castShadow = true;
    const b = new THREE.Mesh(bandGeo, coneBandMat);
    b.position.y = 0.31;
    const b2 = new THREE.Mesh(bandGeo2, coneBandMat);
    b2.position.y = 0.15;
    cg.add(base, c, b, b2);
    group.add(cg);
    coneGroups.push(cg);
  }
  disposables.push(coneGeo, coneBaseGeo, coneMat, coneBandMat, bandGeo, bandGeo2);

  // ---------- лежачие полицейские (terrain.speedBumps) ----------
  const bumpTex = stripesTexture('#f2c200', '#1b1b1b', 14);
  const bumpMat = new THREE.MeshStandardMaterial({ map: bumpTex, roughness: 0.8 });
  disposables.push(bumpTex, bumpMat);
  for (const b of terrain.speedBumps) {
    const R = (b.halfL * b.halfL + b.h * b.h) / (2 * b.h);
    // только верхняя дуга цилиндра: гладкий профиль без огромного скрытого тела
    const alpha = Math.asin(Math.min(1, b.halfL / R));
    const g = new THREE.CylinderGeometry(R, R, b.halfW * 2, 20, 1, false, -alpha, alpha * 2);
    g.rotateX(-Math.PI / 2);
    if ((b.axis ?? 'x') !== 'x') g.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(g, bumpMat);
    m.position.set(b.x, macro(b.x, b.z) + b.h - R, b.z);
    m.receiveShadow = true;
    m.castShadow = true;
    group.add(m);
    disposables.push(g);
  }

  // ---------- трамплины (terrain.ramps) ----------
  for (const r of terrain.ramps) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(r.len, 0);
    shape.lineTo(r.len, r.h);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: r.halfW * 2, bevelEnabled: false });
    g.translate(0, 0, -r.halfW);
    if (r.dir === -1) {
      g.rotateY(Math.PI);
    }
    const rMat = new THREE.MeshStandardMaterial({ color: r.color ?? '#d8a300', roughness: 0.65 });
    const m = new THREE.Mesh(g, rMat);
    const baseOff = terrain.mapId === 'city' && Math.abs(r.z0) > 10 ? 0.032 : 0;
    m.position.set(r.x0, macro(r.x0, r.z0) + baseOff, r.z0);
    // на склоне трамплин лежит вдоль уклона
    if (terrain.mapId === 'hill') m.rotation.z = Math.atan2(macro(r.x0 + r.dir * r.len, r.z0) - macro(r.x0, r.z0), r.len) * r.dir;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    disposables.push(g, rMat);
  }

  // ---------- время суток ----------
  let curTod: TimeOfDay = 'day';
  const fog: THREE.Fog | THREE.FogExp2 = isCity ? new THREE.FogExp2('#c4e0f6', 0.0011) : new THREE.Fog('#c4e0f6', 60, 420);
  scene.fog = fog;
  scene.background = new THREE.Color('#c4e0f6');
  const sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  const setTime = (t: TimeOfDay) => {
    curTod = t;
    const d = TOD[t];
    skyUniforms.top.value.set(d.top);
    skyUniforms.hor.value.set(d.hor);
    skyUniforms.bottom.value.set(d.bottom);
    skyUniforms.sunColor.value.set(d.sunColor);
    skyUniforms.sunAmt.value = t === 'night' ? 0.15 : 1;
    skyUniforms.cloudCol.value.set(d.cloud);
    skyUniforms.cloudAmt.value = d.cloudAmt;
    skyUniforms.discCol.value.set(d.disc).multiplyScalar(t === 'night' ? 1.1 : 4);
    skyUniforms.discCos.value = t === 'night' ? 0.99972 : 0.99984;
    sunDir.set(...d.sunDir).normalize();
    skyUniforms.sunDir.value.copy(sunDir);
    sun.color.set(d.sunColor);
    sun.intensity = d.sunI;
    hemi.color.set(d.hemiSky);
    hemi.groundColor.set(d.hemiGround);
    hemi.intensity = d.hemiI;
    fog.color.set(d.fog);
    if (fog instanceof THREE.FogExp2) {
      fog.density = t === 'night' ? 0.0024 : t === 'sunset' ? 0.0015 : 0.0011;
    } else {
      fog.near = t === 'night' ? 25 : 60;
      fog.far = t === 'night' ? 300 : 420;
    }
    (scene.background as THREE.Color).set(d.fog);
    starMat.opacity = d.stars;
    for (const em of nightEmissiveMats) {
      em.mat.emissiveIntensity = t === 'night' ? em.nightI : t === 'sunset' ? em.sunsetI : 0;
    }
    // краска без освещения ночью не должна «светиться»
    for (const p of paintMats) p.mat.color.copy(p.base).multiplyScalar(d.paint);
    for (const o of lampLights) {
      o.visible = t !== 'day';
      const m = (o as THREE.Points | THREE.Mesh).material as THREE.Material;
      m.opacity = (t === 'night' ? 1 : 0.55) * (o instanceof THREE.Points ? 0.8 : 0.5);
    }
    cityEnv?.setTime(t);
    renderer.toneMappingExposure = d.exposure;
  };
  flushLines();
  setTime('day');
  // всё статичное уже построено: склеиваем, оставляя двигающееся и переключаемое как есть
  batchStatic(group, {
    cell: 96,
    skip: [...coneGroups, ...lampLights],
    keepMaterials: [...nightEmissiveMats.map((e) => e.mat), ...paintMats.map((p) => p.mat)],
    track: (o) => {
      disposables.push(o);
      return o;
    },
  });

  return {
    group,
    sun,
    hemi,
    setTime,
    headlightLevel: () => TOD[curTod].headlight,
    relabel() {
      for (const l of labels) {
        l.mat.map?.dispose();
        l.mat.map = labelTexture(tr(l.text), l.icon, signMode ? 'sign' : 'hud');
        l.mat.needsUpdate = true;
        sizeLabel(l.sprite, l.mat.map);
        disposables.push(l.mat.map);
      }
    },
    update(camPos, target, cones) {
      sky.position.copy(camPos);
      stars.position.copy(camPos);
      const tsec = performance.now() / 1000;
      skyUniforms.time.value = tsec;
      cityEnv?.update(camPos, tsec);
      if (signMode)
        for (const l of labels) {
          const dist = l.sprite.position.distanceTo(camPos);
          l.mat.opacity = Math.min(1, Math.max(0, (dist - 7) / 10));
        }
      sun.position.copy(target).addScaledVector(sunDir, 70);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();

      if (cones) {
        for (let i = 0; i < cones.length && i < coneGroups.length; i++) {
          const dc = cones[i];
          const cg = coneGroups[i];
          cg.position.set(dc.x, dc.y, dc.z);
          cg.rotation.set(dc.rotX, 0, dc.rotZ);
        }
      }
    },
    setShadowSize(n) {
      sun.shadow.mapSize.set(n, n);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
    },
    dispose() {
      scene.remove(group, hemi, sun, sun.target, sky, stars);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
      }
      disposables.forEach((d) => d.dispose());
      // Страховка от утечек: всё, что не попало в disposables
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          if (!mat) continue;
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
    },
  };
}
