import type { MapId, SurfaceId } from './data';

export const CELL = 120;
export const HALF = 180; // арена 360 x 360 м

export interface Obstacle {
  x: number;
  z: number;
  r: number; // радиус коллизии
  h: number; // высота объекта
  scale: number;
  kind: ObstacleKind;
  variant?: TreeVariant;
  color?: string;
  rotY?: number;
}

export type ObstacleKind =
  | 'tree'
  | 'rock'
  | 'lamp'
  | 'bollard'
  | 'sign'
  | 'hydrant'
  | 'bin'
  | 'flag'
  | 'umbrella'
  | 'roadsign'
  | 'bush'
  | 'pole'
  | 'mailbox'
  | 'parkingmeter'
  | 'clock';

export type TreeVariant = 'pine' | 'oak' | 'birch' | 'cypress' | 'palm';

export type BuildingStyle = 'slab' | 'stepped' | 'glass' | 'gable' | 'tower';

export type CarVariant = 'sedan' | 'hatch' | 'van' | 'pickup' | 'taxi' | 'bus' | 'truck';

export const OBSTACLE_REASON: Record<ObstacleKind, string> = {
  tree: 'Столкновение с деревом',
  rock: 'Наезд на камень',
  lamp: 'Столкновение с фонарным столбом',
  sign: 'Столкновение со светофором',
  bollard: 'Наезд на парковочный столбик',
  hydrant: 'Наезд на пожарный гидрант',
  bin: 'Наезд на урну',
  flag: 'Столкновение с флагштоком',
  umbrella: 'Столкновение с пляжным зонтом',
  roadsign: 'Столкновение с дорожным знаком',
  bush: 'Наезд на куст',
  pole: 'Столкновение со стойкой',
  mailbox: 'Наезд на почтовый ящик',
  parkingmeter: 'Наезд на паркомат',
  clock: 'Столкновение с уличными часами',
};

export interface BoxObstacle {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  h: number;
  kind: BoxKind;
  label: string;
  color?: string;
  accent?: string;
  rotY?: number;
  variant?: string;
  style?: BuildingStyle;
}

export type BoxKind =
  | 'building'
  | 'car'
  | 'bench'
  | 'busstop'
  | 'wall'
  | 'kiosk'
  | 'container'
  | 'dumpster'
  | 'fountain'
  | 'ledge'
  | 'crane'
  | 'monument'
  | 'stall'
  | 'lifeguard'
  | 'boat'
  | 'planter'
  | 'log'
  | 'barrier'
  | 'haybale'
  | 'arch'
  | 'cabin'
  | 'bikerack'
  | 'foodtruck'
  | 'gazebo'
  | 'picnic'
  | 'billboard'
  | 'playground';

export interface ConeSpot {
  x: number;
  z: number;
  r: number;
}

export interface SpeedBump {
  x: number;
  z: number;
  halfW: number;
  halfL: number;
  h: number;
  axis?: 'x' | 'z'; // 'x' = поперёк дороги вдоль X (лежит вдоль Z), 'z' = поперёк дороги вдоль Z
}

export interface RampDef {
  x0: number;
  z0: number;
  len: number;
  h: number;
  halfW: number;
  dir: 1 | -1; // 1 = подъём вдоль +X, -1 = подъём вдоль -X
  color?: string;
}

export interface DistrictSign {
  x: number;
  z: number;
  title: string;
  icon: string;
}

export interface Terrain {
  mapId: MapId;
  /** Точка появления и курс (0 = вдоль +X). */
  spawn?: { x: number; z: number; psi: number };
  height(x: number, z: number): number;
  macro(x: number, z: number): number;
  surface(x: number, z: number): SurfaceId;
  gradient(x: number, z: number, out: { x: number; z: number }): void;
  obstacles: Obstacle[];
  boxes: BoxObstacle[];
  cones: ConeSpot[];
  ramps: RampDef[];
  speedBumps: SpeedBump[];
  signs: DistrictSign[];
}

// layout[iz+1][ix+1] для полигона
export const LAYOUT: SurfaceId[][] = [
  ['snow', 'gravel', 'sand'],
  ['tiles', 'asphalt', 'wet'],
  ['grass', 'cobble', 'dirt'],
];

export function cellIndex(v: number): number {
  return Math.max(-1, Math.min(1, Math.floor((v + CELL / 2) / CELL)));
}

export function surfaceAtPolygon(x: number, z: number): SurfaceId {
  return LAYOUT[cellIndex(z) + 1][cellIndex(x) + 1];
}

function smoothstep(a: number, b: number, v: number) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 50000 - 1;
}

function vn(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roughness(s: SurfaceId, x: number, z: number): number {
  switch (s) {
    case 'asphalt':
    case 'wet':
      return 0.0014 * vn(x * 1.3, z * 1.3) + 0.0006 * vn(x * 4, z * 4);
    case 'tiles': {
      const gx = ((x % 0.8) + 0.8) % 0.8;
      const gz = ((z % 0.8) + 0.8) % 0.8;
      const g = (gx < 0.03 ? 1 : 0) + (gz < 0.03 ? 1 : 0);
      return 0.0012 * vn(x * 2, z * 2) - 0.0032 * Math.min(1, g) + 0.0015 * hash(Math.floor(x / 0.8), Math.floor(z / 0.8));
    }
    case 'cobble':
      return 0.0095 * vn(x * 5.2, z * 5.2) + 0.0036 * vn(x * 11, z * 11) + 0.0032 * vn(x * 0.9, z * 0.9);
    case 'gravel':
      return 0.01 * vn(x * 2.6, z * 2.6) + 0.0055 * vn(x * 7, z * 7) + 0.0035 * vn(x * 0.7, z * 0.7);
    case 'dirt':
      return 0.028 * vn(x * 0.85, z * 0.85) + 0.011 * vn(x * 3.1, z * 3.1) + 0.0045 * vn(x * 8, z * 8);
    case 'grass':
      return 0.016 * vn(x * 1.3, z * 1.3) + 0.006 * vn(x * 4.2, z * 4.2);
    case 'sand':
      return 0.018 * vn(x * 0.6, z * 0.6) + 0.006 * Math.sin(x * 2.2 + vn(x * 0.3, z * 0.3) * 3);
    case 'snow':
      return 0.008 * vn(x * 0.8, z * 0.8) + 0.003 * vn(x * 3, z * 3);
  }
}

// ============================================================================
// КАРТА 1: ПОЛИГОН (POLYGON)
// ============================================================================
export function macroHeightPolygon(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - 52);
  const dz = Math.max(0, Math.abs(z) - 24);
  const dTrack = Math.hypot(dx, dz);
  const dCenter = Math.hypot(x, z);
  const w = Math.min(smoothstep(32, 115, dCenter), smoothstep(0, 38, dTrack));
  if (w <= 0) return 0;
  const h =
    1.5 * Math.sin(x * 0.034 + 0.6) * Math.cos(z * 0.029 - 0.4) +
    0.8 * Math.sin(x * 0.066 + z * 0.052) +
    0.4 * Math.cos(z * 0.09 - x * 0.04);
  return w * h * 0.9;
}

export const SPEED_BUMPS: SpeedBump[] = [
  { x: 16, z: 0, halfW: 6, halfL: 0.55, h: 0.055, axis: 'x' },
  { x: 24, z: 0, halfW: 6, halfL: 0.55, h: 0.075, axis: 'x' },
];
export const RAMP: RampDef = { x0: 36, z0: 0, len: 3.6, h: 0.46, halfW: 1.45, dir: 1, color: '#d8a300' };
export const WASH = { x0: -48, x1: -30, halfW: 3.5, amp: 0.013, wl: 0.4 };
export const POTHOLES = [
  { x: -14, z: -3.2, r: 0.5, d: 0.055 },
  { x: -11, z: 2.6, r: 0.42, d: 0.048 },
  { x: -8, z: -1.0, r: 0.35, d: 0.042 },
];

export const CONES: ConeSpot[] = Array.from({ length: 10 }, (_, i) => ({
  x: 4 + i * 5,
  z: 20 + (i % 2 ? 1.2 : -1.2),
  r: 0.22,
}));

function generatePolygonObstacles(): Obstacle[] {
  const list: Obstacle[] = [];
  const rt = rng(21);
  const place = (ix: number, iz: number, n: number, kind: 'tree' | 'rock', col?: string[]) => {
    let placed = 0;
    let guard = 0;
    while (placed < n && guard++ < 1200) {
      const lx = (rt() - 0.5) * (CELL - 12);
      const lz = (rt() - 0.5) * (CELL - 12);
      if (Math.hypot(lx, lz) < 22) continue;
      const x = ix * CELL + lx;
      const z = iz * CELL + lz;
      if (list.some((o) => Math.hypot(o.x - x, o.z - z) < 2.6)) continue;
      if (kind === 'tree') {
        const s = 0.8 + rt() * 0.9;
        const c = col![Math.floor(rt() * col!.length)];
        list.push({ x, z, r: 0.24 * s, h: 5.2 * s, scale: s, kind: 'tree', color: c });
      } else {
        const s = 0.45 + rt() * 1.25;
        list.push({ x, z, r: 0.82 * s, h: 0.9 * s, scale: s, kind: 'rock' });
      }
      placed++;
    }
  };
  place(-1, 1, 70, 'tree', ['#2f6b2a', '#3b7a30', '#27582a', '#4a8a36']);
  place(1, 1, 18, 'tree', ['#4a7a2a', '#3a6a2a']);
  place(-1, -1, 30, 'tree', ['#d8e6ee', '#c4d6e0', '#e8f0f4']);
  place(0, 1, 6, 'tree', ['#3b7a30']);
  place(1, 1, 24, 'rock');
  place(0, -1, 26, 'rock');
  place(1, -1, 14, 'rock');
  place(-1, -1, 12, 'rock');
  return list;
}

export const OBSTACLES: Obstacle[] = generatePolygonObstacles();

function evalRampsAndBumps(x: number, z: number, ramps: RampDef[], bumps: SpeedBump[]): number {
  let h = 0;
  for (let i = 0; i < bumps.length; i++) {
    const b = bumps[i];
    const along = (b.axis ?? 'x') === 'x' ? x - b.x : z - b.z;
    const across = (b.axis ?? 'x') === 'x' ? z - b.z : x - b.x;
    if (Math.abs(along) < b.halfL && Math.abs(across) < b.halfW) {
      const R = (b.halfL * b.halfL + b.h * b.h) / (2 * b.h);
      h += Math.sqrt(Math.max(0, R * R - along * along)) - (R - b.h);
    }
  }
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i];
    const rx = r.dir === 1 ? x - r.x0 : r.x0 - x;
    const rz = z - r.z0;
    if (rx >= 0 && rx <= r.len && Math.abs(rz) <= r.halfW) {
      h += (rx / r.len) * r.h;
    }
  }
  return h;
}

export function bumpHeightPolygon(x: number, z: number): number {
  let h = evalRampsAndBumps(x, z, [RAMP], SPEED_BUMPS);
  if (x > -54 && x < 46 && Math.abs(z) < 9) {
    if (x > WASH.x0 && x < WASH.x1 && Math.abs(z) < WASH.halfW) {
      const e = smoothstep(WASH.x0, WASH.x0 + 1.5, x) * (1 - smoothstep(WASH.x1 - 1.5, WASH.x1, x));
      h += WASH.amp * e * Math.sin(((x - WASH.x0) * Math.PI * 2) / WASH.wl);
    }
    for (const p of POTHOLES) {
      const dd = Math.hypot(x - p.x, z - p.z);
      if (dd < p.r) {
        const q = dd / p.r;
        h -= p.d * (1 - q * q) * (1 - q * q);
      }
    }
  }
  return h;
}

// ============================================================================
// КАРТА 2: ГОРОД (CITY)
// ============================================================================
// Дорожная сетка города:
// - Главный проспект (вдоль X): z ∈ [-9, 9], тротуары z ∈ [-13.5, -9] и [9, 13.5]
// - Центральный бульвар (вдоль Z): x ∈ [-9, 9], тротуары x ∈ [-13.5, -9] и [9, 13.5]
// - Северная / Южная улицы: z ∈ [-96, -84] и z ∈ [84, 96]
// - Западная / Восточная улицы: x ∈ [-96, -84] и x ∈ [84, 96]

// Внешняя кольцевая дорога замыкает улицы на |x| = |z| = 168 — тупиков до края арены нет
export const CITY_EDGE_RING = 168;

export function isCityRoad(x: number, z: number): boolean {
  const mainX = Math.abs(z) <= 9.0;
  const mainZ = Math.abs(x) <= 9.0;
  const ringZ = Math.abs(Math.abs(z) - 90) <= 6.5 && Math.abs(x) <= CITY_EDGE_RING;
  const ringX = Math.abs(Math.abs(x) - 90) <= 6.5 && Math.abs(z) <= CITY_EDGE_RING;
  const edgeZ = Math.abs(Math.abs(z) - CITY_EDGE_RING) <= 6.5 && Math.abs(x) <= CITY_EDGE_RING + 6.5;
  const edgeX = Math.abs(Math.abs(x) - CITY_EDGE_RING) <= 6.5 && Math.abs(z) <= CITY_EDGE_RING + 6.5;
  return mainX || mainZ || ringZ || ringX || edgeZ || edgeX;
}

export function isCitySidewalk(x: number, z: number): boolean {
  if (isCityRoad(x, z)) return false;
  const mainX = Math.abs(z) <= 13.5;
  const mainZ = Math.abs(x) <= 13.5;
  const ringZ = Math.abs(Math.abs(z) - 90) <= 10.0 && Math.abs(x) <= CITY_EDGE_RING + 4;
  const ringX = Math.abs(Math.abs(x) - 90) <= 10.0 && Math.abs(z) <= CITY_EDGE_RING + 4;
  const edgeZ = Math.abs(Math.abs(z) - CITY_EDGE_RING) <= 10.0 && Math.abs(x) <= CITY_EDGE_RING + 10;
  const edgeX = Math.abs(Math.abs(x) - CITY_EDGE_RING) <= 10.0 && Math.abs(z) <= CITY_EDGE_RING + 10;
  return mainX || mainZ || ringZ || ringX || edgeZ || edgeX;
}

export function surfaceAtCity(x: number, z: number): SurfaceId {
  // 1. Проезжая часть улиц
  if (isCityRoad(x, z)) {
    // Мокрый участок дороги на Восточной улице и восточном выезде проспекта (после поливальной машины)
    if ((x > 82 && x < 98 && z > -78 && z < -14) || (x > 102 && x < 162 && Math.abs(z) <= 9)) {
      return 'wet';
    }
    // Брусчатый переезд в Старом городе
    if (x > 24 && x < 72 && z > 83 && z < 97) {
      return 'cobble';
    }
    return 'asphalt';
  }

  // 2. Тротуары вдоль всех улиц
  if (isCitySidewalk(x, z)) {
    return 'tiles';
  }

  // 3. Внутренние кварталы:
  // СЗ квартал (x ∈ [-80, -13.5], z ∈ [-80, -13.5]) — Деловой квартал + открытый Ледовый каток
  if (x >= -80 && x <= -13.5 && z >= -80 && z <= -13.5) {
    if (x >= -64 && x <= -30 && z >= -64 && z <= -30) {
      return 'snow'; // Городской каток
    }
    return 'tiles';
  }

  // СВ квартал (x ∈ [13.5, 80], z ∈ [-80, -13.5]) — Торговая плаза и скейт/самокат-спот
  if (x >= 13.5 && x <= 80 && z >= -80 && z <= -13.5) {
    if (x >= 22 && x <= 72 && z >= -52 && z <= -22) {
      return 'asphalt'; // Асфальтовый скейт-парк / стрит-спот
    }
    return 'tiles';
  }

  // ЮЗ квартал (x ∈ [-80, -13.5], z ∈ [13.5, 80]) — Городской парк (трава, гравийные аллеи, грунтовый памп-трек)
  if (x >= -80 && x <= -13.5 && z >= 13.5 && z <= 80) {
    // Диагональная гравийная аллея через парк
    if (Math.abs((x + 47) + (z - 47)) < 5.5 || Math.abs((x + 47) - (z - 47)) < 5.0) {
      return 'gravel';
    }
    // Грунтовая вело-трасса (памп-трек) в южной части парка
    const dRing = Math.hypot(x + 47, z - 47);
    if (dRing > 18 && dRing < 24.5) {
      return 'dirt';
    }
    return 'grass';
  }

  // ЮВ квартал (x ∈ [13.5, 80], z ∈ [13.5, 80]) — Старый город (историческая брусчатка)
  if (x >= 13.5 && x <= 80 && z >= 13.5 && z <= 80) {
    return 'cobble';
  }

  // 4. Внешние районы города:
  // Восточная набережная и Городской пляж (x > 100)
  if (x > 100 && Math.abs(z) < 82) {
    if (x > 116) return 'sand';
    return 'tiles';
  }

  // Северо-западная стройплощадка / гравийный полигон (x < -100, z < -13.5)
  if (x < -100 && z < -13.5 && z > -82) {
    return 'gravel';
  }

  // Юго-западная грунтовая лесопарковая зона (x < -100, z > 13.5)
  if (x < -100 && z > 13.5 && z < 82) {
    return 'dirt';
  }

  // Северный смотровой парк на холмах (z < -100)
  if (z < -100) {
    if (Math.abs(x) < 28 && z > -145) return 'tiles';
    return 'grass';
  }

  // Южный зелёный бульвар (z > 100)
  if (z > 100) {
    if (Math.abs(x) < 45 && z < 135) return 'tiles';
    return 'grass';
  }

  return 'tiles';
}

export function macroHeightCity(x: number, z: number): number {
  let h = 0;

  // 1. Северный панорамный холм за Северной улицей (z < -102)
  if (z < -132) {
    const t = smoothstep(-132, -176, z);
    h += t * (4.2 + 1.4 * Math.cos(x * 0.035) + 0.6 * Math.sin(z * 0.05));
  }

  // 2. Плавный рельеф и кочки грунтового памп-трека в ЮЗ парке и лесопарке
  if (x < -15 && z > 15 && z < 80) {
    const dRing = Math.hypot(x + 47, z - 47);
    if (dRing > 17 && dRing < 25.5) {
      const w = Math.sin(((dRing - 17) / 8.5) * Math.PI);
      const a = Math.atan2(z - 47, x + 47);
      h += 0.24 * w * (1 + Math.sin(a * 8));
    }
  }

  if (x < -104 && z > 18 && z < 78) {
    const wx = smoothstep(-104, -118, x) * (1 - smoothstep(-158, -172, x));
    const wz = smoothstep(18, 28, z) * (1 - smoothstep(68, 78, z));
    h += wx * wz * (0.65 * Math.sin(x * 0.14) * Math.cos(z * 0.12) + 0.25 * Math.sin(x * 0.32));
  }

  // 3. Пологий спуск к песчаному пляжу на востоке (x > 112)
  if (x > 112 && Math.abs(z) < 78) {
    const t = smoothstep(112, 165, x) * (1 - smoothstep(68, 78, Math.abs(z)));
    h -= t * 0.65;
  }

  return h;
}

export const CITY_SPEED_BUMPS: SpeedBump[] = [
  // На Главном проспекте перед перекрёстками и пешеходными переходами
  { x: 24, z: 0, halfW: 8.8, halfL: 0.52, h: 0.052, axis: 'x' },
  { x: 68, z: 0, halfW: 8.8, halfL: 0.52, h: 0.058, axis: 'x' },
  { x: -28, z: 0, halfW: 8.8, halfL: 0.52, h: 0.052, axis: 'x' },
  { x: -68, z: 0, halfW: 8.8, halfL: 0.52, h: 0.058, axis: 'x' },
  // На Центральном бульваре (вдоль Z)
  { x: 0, z: 26, halfW: 8.8, halfL: 0.52, h: 0.052, axis: 'z' },
  { x: 0, z: -26, halfW: 8.8, halfL: 0.52, h: 0.052, axis: 'z' },
];

export const CITY_RAMPS: RampDef[] = [
  // 1. Трамплин на Центральном проспекте (восток)
  { x0: 44, z0: -3.2, len: 3.8, h: 0.48, halfW: 1.5, dir: 1, color: '#ff6a13' },
  // 2. Встречный кикер в Стрит-парке (СВ квартал)
  { x0: 36, z0: -36, len: 3.6, h: 0.52, halfW: 1.8, dir: 1, color: '#2bd4ff' },
  { x0: 58, z0: -36, len: 3.6, h: 0.52, halfW: 1.8, dir: -1, color: '#ff6a13' },
  // 3. Трамплин на пляжной набережной
  { x0: 106, z0: 22, len: 3.4, h: 0.44, halfW: 1.5, dir: 1, color: '#f2c200' },
];

export const CITY_CONES: ConeSpot[] = [
  // Слалом на велополосе Главного проспекта
  ...Array.from({ length: 8 }, (_, i) => ({
    x: -62 + i * 4.5,
    z: 5.5 + (i % 2 ? 0.9 : -0.9),
    r: 0.22,
  })),
  // Площадка самокатной школы в СВ квартале
  ...Array.from({ length: 6 }, (_, i) => ({
    x: 28 + i * 4.2,
    z: -26 + (i % 2 ? 1.1 : -1.1),
    r: 0.22,
  })),
];

export const CITY_SIGNS: DistrictSign[] = [
  { x: 0, z: 0, title: 'Центральный проспект', icon: '🏙️' },
  { x: 47, z: -36, title: 'Стрит-плаза и Трамплины', icon: '🛹' },
  { x: -47, z: -47, title: 'Ледовый каток · Сити', icon: '⛸️' },
  { x: -47, z: 47, title: 'Городской парк · Памп-трек', icon: '🌳' },
  { x: 47, z: 47, title: 'Старый город · Брусчатка', icon: '🏛️' },
  { x: 90, z: -45, title: 'Мокрая улица · Тест ABS', icon: '🌧️' },
  { x: 136, z: 0, title: 'Городской пляж', icon: '🏖️' },
  { x: -132, z: -47, title: 'Гравийный участок', icon: '🏗️' },
];

function buildCityBoxesAndObstacles(): { boxes: BoxObstacle[]; obstacles: Obstacle[]; removed: string[] } {
  const boxes: BoxObstacle[] = [];
  const obstacles: Obstacle[] = [];

  let bIdx = 0;
  const addBuilding = (x: number, z: number, halfX: number, halfZ: number, h: number, color: string, accent = '#38bdf8') => {
    const styles: BuildingStyle[] = ['slab', 'stepped', 'glass', 'tower', 'slab', 'stepped'];
    const oldTown = x > 14 && z > 14 && x < 82 && z < 82 && h < 25;
    const style: BuildingStyle = oldTown ? 'gable' : h >= 44 ? 'tower' : styles[bIdx % styles.length];
    bIdx++;
    boxes.push({
      style,
      x,
      z,
      halfX,
      halfZ,
      h,
      kind: 'building',
      label: 'Столкновение со зданием',
      color,
      accent,
    });
  };

  // --- 1. НЕБОСКРЁБЫ И БИЗНЕС-ЦЕНТРЫ В СЗ КВАРТАЛЕ (вокруг катка x ∈ [-80, -14], z ∈ [-80, -14]) ---
  addBuilding(-22, -23, 6.5, 6.5, 42, '#1e293b', '#38bdf8');
  addBuilding(-22, -47, 6.0, 9.5, 54, '#0f172a', '#2bd4ff');
  addBuilding(-22, -71, 6.5, 6.0, 36, '#1e2433', '#f59e0b');
  addBuilding(-47, -21, 11.0, 5.5, 32, '#27303f', '#38bdf8');
  addBuilding(-72, -24, 5.5, 7.5, 46, '#172030', '#a855f7');
  addBuilding(-72, -52, 5.5, 11.0, 38, '#1e293b', '#38bdf8');
  addBuilding(-48, -73, 12.0, 5.0, 28, '#222b38', '#4ade80');

  // --- 2. ТОРГОВЫЙ КВАРТАЛ И СТРИТ-ПЛАЗА В СВ КВАРТАЛЕ (x ∈ [14, 80], z ∈ [-80, -14]) ---
  addBuilding(26, -68, 9.5, 6.5, 26, '#27272a', '#ff6a13');
  addBuilding(52, -68, 11.0, 6.5, 34, '#18181b', '#2bd4ff');
  addBuilding(73, -64, 5.5, 9.5, 40, '#1f2937', '#f43f5e');
  addBuilding(73, -34, 5.5, 11.0, 30, '#262b36', '#eab308');

  // --- 3. СТАРЫЙ ГОРОД (ЮВ КВАРТАЛ, x ∈ [14, 80], z ∈ [14, 80]) — уютные кварталы с улочками ---
  addBuilding(25, 25, 8.0, 7.0, 18, '#574136', '#fbbf24');
  addBuilding(50, 25, 9.5, 7.0, 21, '#6b4c3b', '#f59e0b');
  addBuilding(72, 26, 5.5, 8.0, 19, '#4a3b32', '#fb923c');
  addBuilding(25, 50, 7.5, 8.5, 22, '#5c4033', '#fcd34d');
  addBuilding(72, 52, 5.5, 9.5, 20, '#4f3d34', '#f59e0b');
  addBuilding(26, 72, 8.5, 5.5, 17, '#63483a', '#fbbf24');
  addBuilding(52, 72, 10.5, 5.5, 23, '#523a2e', '#fb923c');

  // --- 4. ВНЕШНИЕ ГОРОДСКИЕ КВАРТАЛЫ (ПЕРИМЕТР МЕГАПОЛИСА) ---
  // Вдоль Северного бульвара (z ≈ -116)
  for (const bx of [-70, -42, 42, 70]) {
    addBuilding(bx, -116, 10, 8, 32 + (Math.abs(bx) % 20), '#1e2636', '#38bdf8');
  }
  // Вдоль Южной улицы (z ≈ +116)
  for (const bx of [-72, -44, 44, 72]) {
    addBuilding(bx, 116, 10.5, 8, 28 + (Math.abs(bx) % 18), '#262936', '#ff6a13');
  }

  // --- 5. ПРИПАРКОВАННЫЕ АВТОМОБИЛИ В ПАРКОВОЧНЫХ КАРМАНАХ ---
  const carColors = ['#ef4444', '#3b82f6', '#eab308', '#10b981', '#f97316', '#e2e8f0', '#6366f1', '#14b8a6'];
  type CarSpot = { x: number; z: number; alongX: boolean; col: string; v: CarVariant; rotY: number };
  const CAR_DIMS: Record<CarVariant, [number, number, number]> = {
    sedan: [2.15, 0.98, 1.48],
    hatch: [1.95, 0.95, 1.5],
    van: [2.5, 1.0, 2.1],
    pickup: [2.6, 1.0, 1.75],
    taxi: [2.15, 0.98, 1.65],
    bus: [5.6, 1.3, 3.3],
    truck: [3.8, 1.25, 3.4],
  };
  // Ряды машин у бордюров кольцевых улиц; движение правостороннее, машины смотрят по ходу своей полосы.
  // На проспектах парковки нет: там полоса СИМ.
  const rc = rng(5150);
  const carVariants: CarVariant[] = ['sedan', 'hatch', 'sedan', 'taxi', 'van', 'hatch', 'pickup', 'sedan'];
  const carSpots: CarSpot[] = [
    { x: -62, z: 95, alongX: true, col: '#f59e0b', v: 'bus', rotY: 0 },
    { x: 62, z: -95, alongX: true, col: '#0ea5e9', v: 'bus', rotY: Math.PI },
    { x: -95, z: -62, alongX: false, col: '#16a34a', v: 'truck', rotY: -Math.PI / 2 },
    { x: 95, z: 116, alongX: false, col: '#dc2626', v: 'truck', rotY: Math.PI / 2 },
  ];
  const carRect = (c: CarSpot) => ({
    hx: c.alongX ? CAR_DIMS[c.v][0] : CAR_DIMS[c.v][1],
    hz: c.alongX ? CAR_DIMS[c.v][1] : CAR_DIMS[c.v][0],
  });
  const meterSpots: { x: number; z: number }[] = [];
  for (const c of [-90, 90]) {
    for (const alongX of [true, false]) {
      for (const side of [-1, 1]) {
        for (let s = -150; s <= 150; s += 7.5) {
          const along = s + (rc() - 0.5) * 1.2;
          if ([0, -90, 90].some((j) => Math.abs(along - j) < 18) || Math.abs(along) > 152) continue;
          if (rc() > 0.3) continue;
          const v = carVariants[Math.floor(rc() * carVariants.length)];
          const off = c + side * 5.15;
          const spot: CarSpot = {
            x: alongX ? along : off,
            z: alongX ? off : along,
            alongX,
            col: v === 'taxi' ? '#facc15' : carColors[Math.floor(rc() * carColors.length)],
            v,
            // Правая полоса: вдоль X лицом к +X у стороны +Z, вдоль Z лицом к +Z у стороны −X
            rotY: alongX ? (side > 0 ? 0 : Math.PI) : side < 0 ? -Math.PI / 2 : Math.PI / 2,
          };
          const r = carRect(spot);
          if (carSpots.some((o) => {
            const q = carRect(o);
            return Math.abs(o.x - spot.x) < q.hx + r.hx + 0.8 && Math.abs(o.z - spot.z) < q.hz + r.hz + 0.8;
          })) continue;
          carSpots.push(spot);
          if (rc() < 0.55) meterSpots.push({ x: alongX ? along : c + side * 7.15, z: alongX ? c + side * 7.15 : along });
        }
      }
    }
  }
  for (const cs of carSpots) {
    const d = CAR_DIMS[cs.v];
    boxes.push({
      x: cs.x,
      z: cs.z,
      halfX: cs.alongX ? d[0] : d[1],
      halfZ: cs.alongX ? d[1] : d[0],
      h: d[2],
      kind: 'car',
      variant: cs.v,
      label: cs.v === 'bus' ? 'Столкновение с автобусом' : cs.v === 'truck' ? 'Столкновение с грузовиком' : 'Столкновение с автомобилем',
      color: cs.col,
      rotY: cs.rotY,
    });
  }

  // --- 6. АВТОБУСНЫЕ ОСТАНОВКИ И ПАРКОВЫЕ СКАМЕЙКИ ---
  const busStops: { x: number; z: number; alongX: boolean }[] = [
    { x: -18, z: 11.6, alongX: true },
    { x: 29, z: -11.6, alongX: true },
    { x: -11.6, z: 29, alongX: false },
    { x: 11.6, z: -22, alongX: false },
  ];
  for (const bs of busStops) {
    boxes.push({
      x: bs.x,
      z: bs.z,
      halfX: bs.alongX ? 2.2 : 0.85,
      halfZ: bs.alongX ? 0.85 : 2.2,
      h: 2.5,
      kind: 'busstop',
      label: 'Столкновение с остановкой',
      color: '#1e293b',
      accent: '#ff6a13',
    });
  }

  // Скамейки в парке и на бульварах (вне проезжей части!)
  const benches: { x: number; z: number; alongX: boolean }[] = [
    { x: -34, z: 20, alongX: true },
    { x: -60, z: 20, alongX: true },
    { x: -20, z: 36, alongX: false },
    { x: -20, z: 58, alongX: false },
    { x: 38, z: -16, alongX: true },
    { x: 60, z: -16, alongX: true },
    { x: 47, z: 37, alongX: true },
    { x: 17.5, z: -132, alongX: false },
    { x: 28.5, z: -132, alongX: false },
    { x: 23, z: -126.5, alongX: true },
    { x: 23, z: -137.5, alongX: true },
    { x: -30, z: 22, alongX: true },
    { x: -30, z: 70, alongX: true },
    { x: 110, z: -36, alongX: false },
    { x: 110, z: 40, alongX: false },
  ];
  for (const bn of benches) {
    boxes.push({
      x: bn.x,
      z: bn.z,
      halfX: bn.alongX ? 0.95 : 0.38,
      halfZ: bn.alongX ? 0.38 : 0.95,
      h: 0.82,
      kind: 'bench',
      label: 'Наезд на скамейку',
      color: '#7c4d2b',
    });
  }

  // --- 7. УЛИЧНЫЕ ФОНАРИ, СВЕТОФОРЫ, БОЛЛАРДЫ И ДЕРЕВЬЯ ---

  // Светофоры на углах главных перекрёстков
  const intersections = [
    [0, 0],
    [-90, 0],
    [90, 0],
    [0, -90],
    [0, 90],
  ];
  for (const [ix, iz] of intersections) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        obstacles.push({
          x: ix + sx * 10.4,
          z: iz + sz * 10.4,
          r: 0.2,
          h: 4.8,
          scale: 1,
          kind: 'sign',
        });
      }
    }
  }

  // Защитные парковочные столбики (болларды) у входа в парк и Старый город
  for (let i = 0; i < 5; i++) {
    obstacles.push({ x: 16 + i * 2.4, z: 13.8, r: 0.14, h: 0.85, scale: 1, kind: 'bollard' });
    obstacles.push({ x: -16 - i * 2.4, z: 13.8, r: 0.14, h: 0.85, scale: 1, kind: 'bollard' });
  }

  // Деревья в Городском парке (ЮЗ квартал), на бульварах, на пляже и северном холме
  const rt = rng(77);
  const parkColors = ['#2f7a32', '#3d8b37', '#266329', '#529940'];
  // Деревья в ЮЗ парке (оставляем свободными аллеи и памп-трек)
  for (let i = 0; i < 42; i++) {
    const tx = -76 + rt() * 58;
    const tz = 18 + rt() * 58;
    if (Math.abs((tx + 47) + (tz - 47)) < 7.2 || Math.abs((tx + 47) - (tz - 47)) < 6.8) continue;
    const dRing = Math.hypot(tx + 47, tz - 47);
    if (dRing > 15.5 && dRing < 26.5) continue;
    const s = 0.85 + rt() * 0.65;
    obstacles.push({
      x: tx,
      z: tz,
      r: 0.24 * s,
      h: 5.2 * s,
      scale: s,
      kind: 'tree',
      variant: (['oak', 'pine', 'birch', 'cypress'] as TreeVariant[])[i % 4],
      color: parkColors[i % parkColors.length],
    });
  }

  // Аллея деревьев вдоль тротуаров (z = ±14.2, за внешним краем тротуара 13.5 м)
  for (let x = -76; x <= 76; x += 19) {
    if (Math.abs(x) < 22) continue;
    obstacles.push({ x, z: -14.2, r: 0.22, h: 4.6, scale: 0.85, kind: 'tree', variant: 'oak', color: '#3b8236' });
    obstacles.push({ x, z: 14.2, r: 0.22, h: 4.6, scale: 0.85, kind: 'tree', variant: 'oak', color: '#4a9440' });
  }

  // Деревья и камни в северном панорамном парке (z < -108) и западном лесопарке (x < -108)
  for (let i = 0; i < 36; i++) {
    const tx = -160 + rt() * 320;
    const tz = -168 + rt() * 56;
    if (Math.abs(tx) < 32 || Math.abs(Math.abs(tx) - 90) < 14) continue;
    const s = 0.9 + rt() * 0.7;
    obstacles.push({
      x: tx,
      z: tz,
      r: 0.25 * s,
      h: 5.4 * s,
      scale: s,
      kind: 'tree',
      variant: (['pine', 'pine', 'oak', 'cypress', 'birch'] as TreeVariant[])[i % 5],
      color: ['#2f6b2a', '#357a30', '#3d8b37'][i % 3],
    });
  }

  // Декоративные валуны на гравийном участке и пляже
  for (let i = 0; i < 16; i++) {
    const rx = -164 + rt() * 54;
    const rz = -76 + rt() * 54;
    const s = 0.55 + rt() * 0.85;
    obstacles.push({ x: rx, z: rz, r: 0.82 * s, h: 0.9 * s, scale: s, kind: 'rock' });
  }


  // ==========================================================================
  // РАЗНООБРАЗИЕ: новые объекты города
  // ==========================================================================
  const rv = rng(2024);
  const addObs = (
    x: number,
    z: number,
    kind: ObstacleKind,
    r: number,
    h: number,
    extra: Partial<Obstacle> = {},
  ) => obstacles.push({ x, z, r, h, scale: 1, kind, ...extra });
  const addBox = (
    x: number,
    z: number,
    halfX: number,
    halfZ: number,
    h: number,
    kind: BoxKind,
    label: string,
    extra: Partial<BoxObstacle> = {},
  ) => boxes.push({ x, z, halfX, halfZ, h, kind, label, ...extra });
  const addTree = (x: number, z: number, variant: TreeVariant, s = 1, color?: string) => {
    const h = variant === 'palm' ? 7.2 * s : variant === 'cypress' ? 6.4 * s : 5.2 * s;
    addObs(x, z, 'tree', (variant === 'palm' ? 0.2 : 0.24) * s, h, { scale: s, variant, color });
  };

  // --- Пожарные гидранты и урны вдоль проспекта и у остановок ---
  for (const [hx, hz] of [
    [-48, -11.2],
    [48, 11.2],
    [-66, 11.2],
    [66, -11.2],
    [110, 11.2],
    [-110, -11.2],
    [11.2, 62],
    [-11.2, -62],
    [11.2, -110],
    [-11.2, 110],
  ])
    addObs(hx, hz, 'hydrant', 0.15, 0.85);

  for (const [bx, bz] of [
    [-22.4, 11.6],
    [32.4, -11.6],
    [-11.6, 32.4],
    [11.6, -18.6],
    [-31.5, 20.2],
    [-62.4, 20.2],
    [35.6, -16.2],
    [62.6, -16.2],
    [50.4, 37],
    [44, 37],
    [19.5, -126.5],
    [26.5, -137.5],
    [113, -36],
    [113, 40],
  ])
    addObs(bx, bz, 'bin', 0.26, 0.95);

  // --- Дорожные знаки (синие парковочные, красные запрещающие, жёлтые предупреждающие) ---
  const signColors = ['#2563eb', '#dc2626', '#f2c200', '#2563eb'];
  [-106, -72, -40, 40, 72, 106, 128, -128].forEach((sx, i) => {
    addObs(sx, i % 2 ? 10.9 : -10.9, 'roadsign', 0.1, 2.6, { color: signColors[i % signColors.length] });
  });
  [-132, -64, 64, 132].forEach((sz, i) => {
    addObs(i % 2 ? 10.9 : -10.9, sz, 'roadsign', 0.1, 2.6, { color: signColors[(i + 1) % signColors.length] });
  });

  // --- Старый город: фонтан, флаги, рынок ---
  addBox(47, 47, 3.3, 3.3, 0.75, 'fountain', 'Столкновение с фонтаном');
  for (const [fx, fz] of [
    [38, 38],
    [56, 38],
    [38, 56],
    [56, 56],
  ])
    addObs(fx, fz, 'flag', 0.1, 8.5, { color: fx < 47 ? '#dc2626' : '#2563eb' });
  addBox(63, 37, 1.7, 1.0, 2.7, 'stall', 'Столкновение с торговой палаткой', { color: '#ef4444', accent: '#fff7ed' });
  addBox(31, 37, 1.7, 1.0, 2.7, 'stall', 'Столкновение с торговой палаткой', { color: '#2563eb', accent: '#fff7ed' });
  addBox(47, 61, 1.7, 1.0, 2.7, 'stall', 'Столкновение с торговой палаткой', { color: '#f59e0b', accent: '#fff7ed' });
  addBox(34, 62, 1.0, 1.7, 2.7, 'stall', 'Столкновение с торговой палаткой', { color: '#16a34a', accent: '#fff7ed' });
  // Кафе вокруг фонтана: зонты по углам площади
  [
    [40.5, 41.5, '#f43f5e'],
    [53.5, 41.5, '#f59e0b'],
    [40.5, 52.5, '#38bdf8'],
    [53.5, 52.5, '#f43f5e'],
  ].forEach(([ux, uz, col]) => addObs(ux as number, uz as number, 'umbrella', 0.1, 2.5, { color: col as string }));

  // --- Стрит-плаза: ледж-боксы, рейлы, киоск, кадки ---
  addBox(30, -47, 2.6, 0.38, 0.5, 'ledge', 'Наезд на ледж', { color: '#9ca3af' });
  addBox(46, -47, 2.6, 0.38, 0.62, 'ledge', 'Наезд на ледж', { color: '#a1a1aa' });
  addBox(64, -47, 2.6, 0.38, 0.5, 'ledge', 'Наезд на ледж', { color: '#9ca3af' });
  addBox(52, -27.5, 3.2, 0.12, 0.45, 'ledge', 'Наезд на рейл', { color: '#f97316', variant: 'rail' });
  addBox(46, -58, 2.0, 1.4, 3.0, 'kiosk', 'Столкновение с киоском', { color: '#f97316', accent: '#fed7aa' });
  addBox(15.6, -56, 1.2, 1.2, 1.1, 'planter', 'Наезд на кадку с растениями', { color: '#78716c' });
  addBox(16.4, -30, 1.2, 1.2, 1.0, 'planter', 'Наезд на кадку с растениями', { color: '#78716c' });
  addBox(16.4, -44, 1.2, 1.2, 1.0, 'planter', 'Наезд на кадку с растениями', { color: '#78716c' });
  addBox(78, -16.8, 1.6, 1.0, 1.0, 'planter', 'Наезд на кадку с растениями', { color: '#78716c' });

  // --- Ледовый каток: флаги и урны по углам ---
  for (const [fx, fz] of [
    [-65, -65],
    [-30, -64.5],
  ])
    addObs(fx, fz, 'flag', 0.1, 7.5, { color: '#38bdf8' });

  // --- Парк: кусты, клумбы-кадки, фонари вдоль аллей ---
  for (let i = 0; i < 26; i++) {
    const bx = -77 + rv() * 62;
    const bz = 17 + rv() * 62;
    if (Math.abs((bx + 47) + (bz - 47)) < 7.8 || Math.abs((bx + 47) - (bz - 47)) < 7.4) continue;
    const dRing = Math.hypot(bx + 47, bz - 47);
    if (dRing > 15.5 && dRing < 26.5) continue;
    const s = 0.7 + rv() * 0.6;
    addObs(bx, bz, 'bush', 0.55 * s, 0.95 * s, { scale: s, color: ['#2f7a32', '#3f9a3a', '#6aa84f'][i % 3] });
  }
  for (const [lx, lz] of [
    [-47, 19.5],
    [-47, 77.5],
    [-19.5, 47],
    [-74.5, 47],
  ])
    addObs(lx, lz, 'lamp', 0.18, 6.2);

  // --- Северный парк: монумент, кусты, фонари вокруг площади (справа от Центрального бульвара) ---
  addBox(23, -132, 1.2, 1.2, 8.5, 'monument', 'Столкновение с монументом');
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    addObs(
      23 + Math.cos(a) * 7.8,
      -132 + Math.sin(a) * 7.8,
      i % 2 ? 'bush' : 'lamp',
      i % 2 ? 0.5 : 0.18,
      i % 2 ? 0.9 : 6.2,
      { color: '#3f9a3a' },
    );
  }
  for (let i = 0; i < 24; i++) {
    const bx = -160 + rv() * 320;
    const bz = -168 + rv() * 60;
    if (Math.abs(bx) < 34 || Math.abs(Math.abs(bx) - 90) < 15) continue;
    const s = 0.7 + rv() * 0.7;
    addObs(bx, bz, 'bush', 0.55 * s, 0.95 * s, { scale: s, color: ['#2f6b2a', '#4d9b3a', '#6aa84f'][i % 3] });
  }

  // --- Южный бульвар: рынок и кадки (вне проезжей части Центрального бульвара!) ---
  [-30, -18, 18, 30].forEach((sx, i) => {
    addBox(sx, 126, 1.7, 1.0, 2.7, 'stall', 'Столкновение с торговой палаткой', {
      color: ['#ef4444', '#2563eb', '#f59e0b', '#16a34a'][i],
      accent: '#fff7ed',
    });
  });
  for (const px of [-28, -16, 16, 28])
    addBox(px, 108, 1.1, 1.1, 1.0, 'planter', 'Наезд на кадку с растениями', { color: '#78716c' });
  [-44, -34, -24, -16, 16, 24, 34, 44].forEach((tx, i) => {
    addTree(tx, 134, (['oak', 'birch'] as TreeVariant[])[i % 2], 0.95, '#4a9440');
  });

  // --- Пляж: пальмы, зонтики, спасательные вышки, лодка, волейбол ---
  for (let i = 0; i < 24; i++) {
    const px = 122 + rv() * 46;
    const pz = (rv() < 0.5 ? -1 : 1) * (16 + rv() * 58);
    // Не ставим пальмы на волейбольную площадку (x ∈ [125, 140], z ∈ [-59, -35])
    if (px > 124 && px < 141 && pz > -60 && pz < -34) continue;
    addTree(px, pz, 'palm', 0.9 + rv() * 0.35);
  }
  const umbrellaCols = ['#ef4444', '#f59e0b', '#06b6d4', '#a855f7', '#22c55e', '#f43f5e'];
  for (let i = 0; i < 14; i++) {
    const ux = 124 + (i % 5) * 9 + rv() * 3;
    const uz = (i % 2 ? -1 : 1) * (18 + Math.floor(i / 2) * 7.5 + rv() * 2);
    if (ux > 124 && ux < 141 && uz > -60 && uz < -34) continue;
    addObs(ux, uz, 'umbrella', 0.1, 2.4, { color: umbrellaCols[i % umbrellaCols.length] });
  }
  addBox(150, -32, 1.0, 1.0, 3.6, 'lifeguard', 'Столкновение со спасательной вышкой', { color: '#ef4444' });
  addBox(150, 34, 1.0, 1.0, 3.6, 'lifeguard', 'Столкновение со спасательной вышкой', { color: '#f59e0b' });
  addBox(124, -24, 2.4, 1.6, 3.0, 'kiosk', 'Столкновение с пляжным баром', { color: '#06b6d4', accent: '#cffafe' });
  addBox(148, 52, 2.8, 1.0, 1.3, 'boat', 'Наезд на лодку', { color: '#2563eb' });
  addObs(132, -52, 'pole', 0.09, 2.5);
  addObs(132, -42, 'pole', 0.09, 2.5);
  for (let z = -76; z <= 76; z += 22) {
    if (Math.abs(z) < 14) continue;
    addObs(110, z, 'lamp', 0.18, 6.2);
  }

  // --- Строй-площадка (гравий, запад): контейнеры, кран, барьеры, мусорные баки ---
  [-74, -70.7, -67.4].forEach((cz, i) =>
    addBox(-157.5, cz, 3.0, 1.2, 2.6, 'container', 'Столкновение с контейнером', {
      color: ['#dc2626', '#2563eb', '#16a34a'][i],
    }),
  );
  addBox(-150, -74, 3.0, 1.2, 5.2, 'container', 'Столкновение со штабелем контейнеров', { color: '#f59e0b', variant: 'stack' });
  addBox(-140, -70, 3.0, 1.2, 2.6, 'container', 'Столкновение с контейнером', { color: '#64748b' });
  addBox(-128, -48, 1.0, 1.0, 34, 'crane', 'Столкновение с башенным краном');
  for (let i = 0; i < 6; i++)
    addBox(-146 + i * 3.4, -32, 1.5, 0.3, 0.8, 'ledge', 'Наезд на дорожный барьер', {
      color: i % 2 ? '#f8fafc' : '#f97316',
      variant: 'barrier',
    });
  addBox(-108, -20, 1.3, 0.8, 1.3, 'dumpster', 'Столкновение с мусорным контейнером', { color: '#166534' });
  addBox(-113, -20, 1.3, 0.8, 1.3, 'dumpster', 'Столкновение с мусорным контейнером', { color: '#1d4ed8' });
  addBox(-110, -44, 2.4, 1.6, 2.8, 'container', 'Столкновение с бытовкой', { color: '#eab308', variant: 'cabin' });

  // --- Лесопарк (грунт, запад-юг): деревья разных пород, кусты, валуны ---
  for (let i = 0; i < 46; i++) {
    const tx = -170 + rv() * 66;
    const tz = 18 + rv() * 60;
    const s = 0.85 + rv() * 0.7;
    addTree(tx, tz, (['pine', 'oak', 'birch', 'cypress', 'pine'] as TreeVariant[])[i % 5], s, ['#2f6b2a', '#357a30', '#4d9b3a'][i % 3]);
  }
  for (let i = 0; i < 18; i++) {
    const rx = -170 + rv() * 66;
    const rz = 18 + rv() * 60;
    const s = 0.5 + rv() * 0.7;
    if (i % 3 === 0) addObs(rx, rz, 'rock', 0.82 * s, 0.9 * s, { scale: s });
    else addObs(rx, rz, 'bush', 0.55 * s, 0.95 * s, { scale: s, color: '#3a7a2e' });
  }

  // --- Деревья вдоль западного и восточного проспекта, вдоль колец (за пределами проезжей части и тротуаров) ---
  for (let x = -166; x <= -104; x += 17) addTree(x, Math.round(x) % 2 ? 14.4 : -14.4, 'oak', 0.9, '#3b8236');
  for (let x = 104; x <= 116; x += 12) addTree(x, 14.4, 'oak', 0.9, '#3b8236');
  for (let i = 0; i < 9; i++) {
    const a = -150 + i * 36;
    if (Math.abs(a) < 20 || Math.abs(Math.abs(a) - 90) < 16) continue;
    addTree(a, 101.2, i % 2 ? 'birch' : 'oak', 0.9, '#4a9440');
    addTree(a, -101.2, i % 2 ? 'oak' : 'birch', 0.9, '#4a9440');
  }

  // --- Дополнительные здания по краям города ---
  addBuilding(-113, 120, 9, 8, 30, '#243044', '#38bdf8');
  addBuilding(-140, 118, 9, 9, 40, '#1b2536', '#a855f7');
  addBuilding(113, 120, 9, 8, 36, '#2a2f3b', '#f59e0b');
  addBuilding(140, 118, 9, 9, 26, '#1f2937', '#4ade80');
  addBuilding(-113, -120, 9, 8, 38, '#1e293b', '#2bd4ff');
  addBuilding(-140, -120, 9, 9, 48, '#162033', '#f43f5e');
  addBuilding(113, -120, 9, 8, 34, '#27303f', '#ff6a13');
  addBuilding(140, -120, 9, 9, 28, '#202938', '#eab308');

  // ==========================================================================
  // РЕМАСТЕР: композиция районов (отдельный генератор, чтобы не сдвигать случайные расстановки выше)
  // ==========================================================================
  const addHedge = (x: number, z: number, halfX: number, halfZ: number) =>
    addBox(x, z, halfX, halfZ, 0.9, 'planter', 'Наезд на живую изгородь', { color: '#2f6b2a', variant: 'hedge' });
  const addRack = (x: number, z: number, alongX = true) =>
    addBox(x, z, alongX ? 1.2 : 0.3, alongX ? 0.3 : 1.2, 0.9, 'bikerack', 'Наезд на велопарковку', { color: '#475569' });
  const addTruck = (x: number, z: number, alongX: boolean, variant: string, color: string, accent: string) =>
    addBox(x, z, alongX ? 2.75 : 1.1, alongX ? 1.1 : 2.75, 2.8, 'foodtruck', 'Столкновение с фудтраком', { color, accent, variant });

  // Паркоматы у бордюра рядом с машинами, почтовые ящики на тротуарах, часы на перекрёстках
  for (const m of meterSpots)
    if (!boxes.some((b) => Math.abs(m.x - b.x) < b.halfX + 0.7 && Math.abs(m.z - b.z) < b.halfZ + 0.7)) addObs(m.x, m.z, "parkingmeter", 0.15, 1.3);
  for (const [mx, mz] of [
    [-52, -9.9],
    [52, 9.9],
    [9.9, -52],
    [-9.9, 52],
    [97.4, -50],
    [-97.4, 50],
    [50, 97.4],
    [-50, -97.4],
  ])
    addObs(mx, mz, 'mailbox', 0.3, 1.2);
  addObs(12.6, 12.6, 'clock', 0.25, 4);
  addObs(112, -16.5, 'clock', 0.25, 4);

  // Остановки на кольцевых улицах — рядом с припаркованными автобусами
  for (const [sx, sz] of [
    [-62, 98.4],
    [62, -98.4],
  ])
    addBox(sx, sz, 2.2, 0.85, 2.5, 'busstop', 'Столкновение с остановкой', { color: '#1e293b', accent: '#ff6a13' });

  // Велопарковки: у остановок проспекта, у плазы, в Старом городе, в парке и на набережной
  addRack(-24.5, 12.7);
  addRack(24.5, -12.7);
  addRack(-12.7, 24.5, false);
  addRack(12.7, -26.5, false);
  addRack(21, -17.5);
  addRack(27, -17.5);
  addRack(31, 16.5);
  addRack(37, 16.5);
  addRack(-22, 18);
  addRack(103.5, -30, false);
  addRack(103.5, 30, false);

  // Фудтраки: плаза и набережная
  addTruck(68, -18.2, true, 'burger', '#f97316', '#fff7ed');
  addTruck(24, -57, true, 'coffee', '#0ea5e9', '#e0f2fe');
  addTruck(113.5, -54, false, 'taco', '#16a34a', '#fef9c3');
  addTruck(113.5, 56, false, 'icecream', '#f43f5e', '#fdf2f8');

  // Парк: беседка, пикниковая зона, детская площадка — по «долям» между аллеями и памп-треком
  addBox(-47, 36, 2.5, 2.5, 3.4, 'gazebo', 'Столкновение с беседкой', { color: '#f1f5f9', accent: '#0f766e' });
  addBox(-36.5, 43.8, 0.9, 0.8, 0.8, 'picnic', 'Наезд на пикниковый стол', { color: '#a16207' });
  addBox(-36.5, 50.2, 0.9, 0.8, 0.8, 'picnic', 'Наезд на пикниковый стол', { color: '#a16207' });
  addBox(-58.5, 47, 3, 2.5, 2.6, 'playground', 'Столкновение с детской площадкой', { color: '#f59e0b', accent: '#38bdf8' });
  addHedge(-30, 16.2, 2.5, 0.55);
  addHedge(-44, 16.2, 2.5, 0.55);
  addHedge(-58, 16.2, 2.5, 0.55);

  // Рекламные щиты у колец
  for (const [bx, bz, bh, bc] of [
    [-58, 103.5, true, '#0ea5e9'],
    [58, 103.5, true, '#f97316'],
    [-58, -103.5, true, '#a855f7'],
    [58, -103.5, true, '#22c55e'],
    [103.5, -62, false, '#f43f5e'],
    [103.5, 62, false, '#eab308'],
  ] as [number, number, boolean, string][])
    addBox(bx, bz, bh ? 3 : 0.25, bh ? 0.25 : 3, 6, 'billboard', 'Столкновение с рекламным щитом', { color: bc });

  // Фонари: единый шаг 24 м, симметрично; на проспектах с двух сторон, на кольцах — вразбежку
  const lampStations = Array.from({ length: 14 }, (_, k) => 24 * (k - 7) + 12);
  const nearJunction = (s: number) => Math.abs(s) < 15 || Math.abs(Math.abs(s) - 90) < 12 || Math.abs(Math.abs(s) - CITY_EDGE_RING) < 14;
  const addLamp = (x: number, z: number) => {
    if (!boxes.some((b) => Math.abs(x - b.x) < b.halfX + 0.8 && Math.abs(z - b.z) < b.halfZ + 0.8)) obstacles.push({ x, z, r: 0.18, h: 6.2, scale: 1, kind: 'lamp' });
  };
  lampStations.forEach((s, k) => {
    if (nearJunction(s)) return;
    for (const side of [-1, 1]) {
      addLamp(s, side * 10.2);
      addLamp(side * 10.2, s);
    }
    for (const c of [-90, 90, -CITY_EDGE_RING, CITY_EDGE_RING]) {
      const off = c + (k % 2 ? 1 : -1) * 8.6;
      addLamp(s, off);
      addLamp(off, s);
    }
  });
  // Рядные уличные деревья вдоль внутренних сторон колец
  for (const c of [-79.1, 79.1]) {
    for (let t = -76, i = 0; t <= 76; t += 9.5, i++) {
      if (Math.abs(t) < 18) continue;
      addTree(t, c, i % 2 ? 'birch' : 'oak', 0.9, '#4a9440');
      addTree(c, t, i % 2 ? 'oak' : 'birch', 0.9, '#4a9440');
    }
  }
  // Деревья вдоль Центрального бульвара
  for (const z of [30, 49, 68, -30, -49, -68])
    for (const sx of [-1, 1]) addTree(sx * 14.2, z, 'oak', 0.85, '#3b8236');

  // Комплексная пространственная очистка: убираем любые деревья/кусты/камни/мелкие объекты,
  // попавшие на проезжую часть, внутрь зданий/машин/лавок/остановок или друг в друга
  const isNearRoad = (x: number, z: number, margin: number) =>
    isCityRoad(x, z) ||
    isCityRoad(x + margin, z) ||
    isCityRoad(x - margin, z) ||
    isCityRoad(x, z + margin) ||
    isCityRoad(x, z - margin);

  const removed: string[] = [];
  const drop = (i: number, why: string, by = "") => {
    const o = obstacles[i];
    removed.push(`${o.kind}@(${o.x.toFixed(1)},${o.z.toFixed(1)}):${why}${by}`);
    obstacles.splice(i, 1);
  };
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    const isNatural = o.kind === 'tree' || o.kind === 'bush' || o.kind === 'rock' || o.kind === 'umbrella';

    // 1. Никакой объект не должен стоять на проезжей части (а деревья/кусты/камни — ближе 1.6 м к дороге или на тротуарах)
    if (isNearRoad(o.x, o.z, isNatural ? 1.6 : o.r + 0.15) || (isNatural && isCitySidewalk(o.x, o.z))) {
      drop(i, 'road');
      continue;
    }

    // 2. Убираем объекты, попавшие внутрь любых габаритных объектов (зданий, остановок, лавок, киосков и т.д.)
    let insideBox = false;
    let by = "";
    const pad = isNatural ? 1.1 : 0.35;
    for (const b of boxes) {
      if (Math.abs(o.x - b.x) < b.halfX + o.r + pad && Math.abs(o.z - b.z) < b.halfZ + o.r + pad) {
        insideBox = true;
        by = `${b.kind}@(${b.x},${b.z})`;
        break;
      }
    }
    if (insideBox) {
      drop(i, "box", ">" + by);
      continue;
    }

    // 3. Убираем пересечения между самими препятствиями
    let overlapsOther = false;
    by = "";
    for (let j = 0; j < i; j++) {
      const other = obstacles[j];
      const minD = o.r + other.r + (isNatural && (other.kind === 'tree' || other.kind === 'rock' || other.kind === 'bush') ? 0.75 : 0.35);
      if (Math.hypot(o.x - other.x, o.z - other.z) < minD) {
        overlapsOther = true;
        by = `${other.kind}@(${other.x.toFixed(1)},${other.z.toFixed(1)})`;
        break;
      }
    }
    if (overlapsOther) {
      drop(i, "overlap", ">" + by);
    }
  }


  return { boxes, obstacles, removed };
}

const CITY_DATA = buildCityBoxesAndObstacles();
// Что генератор молча выбросил при очистке (для scripts/check-city.mjs)
export const CITY_BUILD_REPORT = { removed: CITY_DATA.removed };

export function bumpHeightCity(x: number, z: number): number {
  let h = evalRampsAndBumps(x, z, CITY_RAMPS, CITY_SPEED_BUMPS);
  // Мягкий реалистичный бордюр (3.2 см) при заезде с проезжей части на тротуар/кварталы
  if (!isCityRoad(x, z)) {
    h += 0.032;
  }
  return h;
}

// ============================================================================
// КАРТА 3: ГОРНЫЙ СПУСК (HILL)
// ============================================================================
// Склон падает вдоль +X: старт на вершине (x ≈ -164), финиш в долине (x ≈ 160).
// Тропа шириной ~9 м врезана в склон полкой, чтобы поперёк неё не было уклона.

export const HILL_SPAWN = { x: -164, z: 0, psi: 0 };
export const HILL_TRAIL_HALF = 4.6;

// Уклон вниз по X в узловых точках [x, уклон]; между узлами меняется линейно.
const HILL_GRAD: [number, number][] = [
  [-152, 0],
  [-140, 0.3],
  [-96, 0.32],
  [-86, 0.1],
  [-62, 0.1],
  [-52, 0.36],
  [-8, 0.38],
  [2, 0.06],
  [30, 0.06],
  [40, 0.27],
  [86, 0.27],
  [96, 0.07],
  [112, 0.07],
  [122, 0.22],
  [150, 0.22],
  [162, 0],
];
// Накопленный перепад высот к каждому узлу
const HILL_DROP: number[] = [0];
for (let i = 1; i < HILL_GRAD.length; i++) {
  const [x0, g0] = HILL_GRAD[i - 1];
  const [x1, g1] = HILL_GRAD[i];
  HILL_DROP.push(HILL_DROP[i - 1] + ((g0 + g1) / 2) * (x1 - x0));
}
export const HILL_TOP = HILL_DROP[HILL_DROP.length - 1];
const HILL_FLOOR = -3; // уровень земли далеко за пределами арены

function hillProfile(x: number): number {
  const first = HILL_GRAD[0][0];
  if (x <= first) {
    // плато вершины, за ареной — обратный склон горы
    return x > -190 ? HILL_TOP : Math.max(HILL_FLOOR, HILL_TOP - 0.35 * (-190 - x));
  }
  const n = HILL_GRAD.length;
  if (x >= HILL_GRAD[n - 1][0]) return 0;
  let i = 1;
  while (x > HILL_GRAD[i][0]) i++;
  const [x0, g0] = HILL_GRAD[i - 1];
  const [x1, g1] = HILL_GRAD[i];
  const t = x - x0;
  return HILL_TOP - (HILL_DROP[i - 1] + g0 * t + ((g1 - g0) * t * t) / (2 * (x1 - x0)));
}

/** Осевая линия тропы: z как функция x. Прямые участки соединены плавными перекладками. */
export function hillTrailZ(x: number): number {
  return 26 * smoothstep(-138, -104, x) - 50 * smoothstep(-60, -4, x) + 30 * smoothstep(88, 126, x);
}

/** Боковое расстояние от точки до оси тропы (вдоль Z). */
export function hillTrailDist(x: number, z: number): number {
  return Math.abs(z - hillTrailZ(x));
}

export function macroHeightHill(x: number, z: number): number {
  const zc = hillTrailZ(x);
  const off = z - zc;
  const d = Math.abs(off);
  // Полка тропы: высота берётся в ближайшей точке оси, поэтому поперёк тропы ровно
  const m = (hillTrailZ(x + 0.5) - hillTrailZ(x - 0.5)) / 1.0;
  const carve = 1 - smoothstep(6, 16, d);
  let h = hillProfile(x + (carve * off * m) / (1 + m * m));
  // Борта лощины и неровности склона вне тропы
  const dd = Math.max(0, d - 7);
  const q = (dd / 26) * (dd / 26);
  h += 4 * (q / (1 + q));
  h += (0.9 * vn(x * 0.035, z * 0.035) + 0.35 * vn(x * 0.11 + 7, z * 0.11)) * smoothstep(7, 20, d);
  // Русло ручья
  const sx = (x - 105) / 4.5;
  h -= 0.22 * Math.exp(-sx * sx);
  // Далеко за ареной гора сходит к равнине
  const az = Math.abs(z);
  if (az > 230) h = HILL_FLOOR + (h - HILL_FLOOR) * (1 - smoothstep(230, 560, az));
  return h;
}

export function surfaceAtHill(x: number, z: number): SurfaceId {
  if (x >= 102 && x < 108) return 'wet'; // брод через ручей
  const zc = hillTrailZ(x);
  const d = Math.abs(z - zc);
  if (x < -150 && Math.abs(z) < 12) return 'asphalt'; // стартовая площадка
  if (x >= 156 && Math.abs(z - zc) < 15) return 'asphalt'; // финишная площадка
  if (d < HILL_TRAIL_HALF) {
    if (x < -88) return 'asphalt';
    if (x < -60) return 'gravel';
    if (x < -4) return 'dirt';
    if (x < 32) return 'cobble';
    if (x < 92) return 'dirt';
    if (x < 118) return 'asphalt';
    return 'gravel';
  }
  if (x + 8 * vn(z * 0.06, 1.7) < -116) return 'snow'; // снежник у вершины
  if (x > 118 && x < 154 && d < 15) return 'gravel'; // осыпь шире тропы
  return 'grass';
}

const hillRamp = (x0: number): RampDef => ({ x0, z0: hillTrailZ(x0), len: 3, h: 0.5, halfW: 1.7, dir: 1, color: '#8a5a2b' });
export const HILL_RAMPS: RampDef[] = [hillRamp(52), hillRamp(70)];

export const HILL_SPEED_BUMPS: SpeedBump[] = [
  { x: -74, z: hillTrailZ(-74), halfW: 4.4, halfL: 0.32, h: 0.07 },
  { x: 0.5, z: hillTrailZ(0.5), halfW: 4.4, halfL: 0.32, h: 0.07 },
  { x: 30, z: hillTrailZ(30), halfW: 4.4, halfL: 0.32, h: 0.07 },
];

/** Гребёнка на гравийной осыпи. */
export const HILL_WASH = { x0: 126, x1: 146, amp: 0.014, wl: 0.45 };

export const HILL_CONES: ConeSpot[] = [
  // разметка шиканы
  ...[5, 15, 25].flatMap((x, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    return [0.6, 1.7].map((k) => ({ x: x - 2.2, z: hillTrailZ(x) + side * k, r: 0.14 }));
  }),
  // слалом на осыпи
  ...[130, 136, 142, 148].map((x, i) => ({ x, z: hillTrailZ(x) + (i % 2 === 0 ? 1.5 : -1.5), r: 0.14 })),
];

export const HILL_SIGNS: DistrictSign[] = [
  { x: -158, title: 'Старт · Вершина', icon: '🏔️' },
  { x: -90, title: 'Камнепад', icon: '🪨' },
  { x: -56, title: 'Брёвна', icon: '🪵' },
  { x: 0, title: 'Шикана', icon: '🚧' },
  { x: 42, title: 'Трамплины', icon: '🛹' },
  { x: 97, title: 'Брод', icon: '💧' },
  { x: 121, title: 'Осыпь', icon: '⚠️' },
  { x: 163, title: 'Финиш · Долина', icon: '🏁' },
].map((s) => ({ ...s, z: hillTrailZ(s.x) + 11 }));

function buildHillBoxesAndObstacles(): { boxes: BoxObstacle[]; obstacles: Obstacle[] } {
  const boxes: BoxObstacle[] = [];
  const obstacles: Obstacle[] = [];
  const rock = (x: number, off: number, s: number) =>
    obstacles.push({ x, z: hillTrailZ(x) + off, r: 0.82 * s, h: 0.9 * s, scale: s, kind: 'rock' });

  // Стартовая и финишная арки
  for (const x of [-150, 158]) {
    for (const side of [-1, 1]) {
      boxes.push({ x, z: hillTrailZ(x) + side * 6.2, halfX: 0.3, halfZ: 0.3, h: 4.6, kind: 'arch', label: 'Столкновение с аркой', color: x < 0 ? '#ff6a13' : '#e8e9e2' });
    }
  }

  // Камнепад: валуны прямо на тропе, между ними всегда остаётся проезд
  const fall: [number, number, number][] = [
    [-84, -2.6, 0.62], [-81, 1.6, 0.8], [-78.5, 3.3, 0.55], [-76, -0.9, 0.7], [-72, -3.2, 0.85],
    [-70, 2.4, 0.6], [-67.5, 0.3, 0.75], [-65, -2.5, 0.58], [-63, 3.0, 0.66],
  ];
  for (const [x, off, s] of fall) rock(x, off, s);

  // Поваленные брёвна: перекрывают больше половины тропы поочерёдно слева и справа
  [-48, -36, -24, -12].forEach((x, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    boxes.push({ x, z: hillTrailZ(x) + side * 2.0, halfX: 0.24, halfZ: 2.6, h: 0.42, kind: 'log', label: 'Наезд на бревно' });
  });

  // Шикана из бетонных барьеров
  [5, 15, 25].forEach((x, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    boxes.push({ x, z: hillTrailZ(x) + side * 2.4, halfX: 0.3, halfZ: 2.2, h: 0.85, kind: 'barrier', label: 'Столкновение с барьером' });
  });

  // Тюки сена с одной стороны трамплина: с другой остаётся объезд
  HILL_RAMPS.forEach((r, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    for (const dx of [0.5, 2.3]) {
      boxes.push({ x: r.x0 + dx, z: r.z0 + side * (r.halfW + 1.0), halfX: 0.6, halfZ: 0.5, h: 0.7, kind: 'haybale', label: 'Наезд на тюк сена' });
    }
  });

  // Валуны у брода и на осыпи
  rock(100.5, 3.4, 0.9);
  rock(109.5, -3.0, 0.8);
  rock(110, 2.2, 0.55);
  rock(125, -2.8, 0.6);
  rock(133, 3.4, 0.7);
  rock(139, -3.5, 0.65);
  rock(145, 3.2, 0.6);

  // Хижина у финиша
  boxes.push({ x: 170, z: hillTrailZ(170) + 24, halfX: 3, halfZ: 2.5, h: 3, kind: 'cabin', label: 'Столкновение с хижиной' });

  // Лес и камни на склоне вне тропы
  const rt = rng(77);
  const lim = HALF - 6;
  const free = (x: number, z: number, gap: number) =>
    !obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < gap) &&
    !boxes.some((b) => Math.abs(b.x - x) < b.halfX + gap && Math.abs(b.z - z) < b.halfZ + gap);
  const greens = ['#2f6b2a', '#27582a', '#3b7a30', '#2c5f33'];
  const snowy = ['#d8e6ee', '#c4d6e0', '#e8f0f4'];
  let guard = 0;
  let trees = 0;
  while (trees < 230 && guard++ < 6000) {
    const x = (rt() * 2 - 1) * lim;
    const z = (rt() * 2 - 1) * lim;
    if (hillTrailDist(x, z) < 13) continue;
    const surf = surfaceAtHill(x, z);
    if (surf !== 'grass' && surf !== 'snow') continue;
    if (surf === 'snow' && rt() > 0.35) continue; // у вершины лес редеет
    if (!free(x, z, 3.4)) continue;
    const s = 0.8 + rt() * 0.9;
    const pine = x < 40 || rt() < 0.5;
    const col = surf === 'snow' ? snowy : greens;
    obstacles.push({ x, z, r: 0.24 * s, h: 5.2 * s, scale: s, kind: 'tree', variant: pine ? 'pine' : rt() < 0.5 ? 'oak' : 'birch', color: col[Math.floor(rt() * col.length)] });
    trees++;
  }
  let rocks = 0;
  guard = 0;
  while (rocks < 46 && guard++ < 3000) {
    const x = (rt() * 2 - 1) * lim;
    const z = (rt() * 2 - 1) * lim;
    if (hillTrailDist(x, z) < 9 || surfaceAtHill(x, z) === 'asphalt' || !free(x, z, 3)) continue;
    const s = 0.5 + rt() * 1.3;
    obstacles.push({ x, z, r: 0.82 * s, h: 0.9 * s, scale: s, kind: 'rock' });
    rocks++;
  }
  return { boxes, obstacles };
}

const HILL_DATA = buildHillBoxesAndObstacles();

export function bumpHeightHill(x: number, z: number): number {
  let h = evalRampsAndBumps(x, z, HILL_RAMPS, HILL_SPEED_BUMPS);
  if (x > HILL_WASH.x0 && x < HILL_WASH.x1 && hillTrailDist(x, z) < HILL_TRAIL_HALF) {
    h += HILL_WASH.amp * (0.5 + 0.5 * Math.sin((x / HILL_WASH.wl) * Math.PI * 2));
  }
  return h;
}

function createHillTerrain(): Terrain {
  return {
    mapId: 'hill',
    spawn: HILL_SPAWN,
    macro: macroHeightHill,
    surface: surfaceAtHill,
    obstacles: HILL_DATA.obstacles,
    boxes: HILL_DATA.boxes,
    cones: HILL_CONES,
    ramps: HILL_RAMPS,
    speedBumps: HILL_SPEED_BUMPS,
    signs: HILL_SIGNS,
    height: (x, z) => macroHeightHill(x, z) + roughness(surfaceAtHill(x, z), x, z) + bumpHeightHill(x, z),
    gradient(x, z, out) {
      const e = 0.35;
      const hxp = macroHeightHill(x + e, z) + bumpHeightHill(x + e, z);
      const hxm = macroHeightHill(x - e, z) + bumpHeightHill(x - e, z);
      const hzp = macroHeightHill(x, z + e) + bumpHeightHill(x, z + e);
      const hzm = macroHeightHill(x, z - e) + bumpHeightHill(x, z - e);
      out.x = Math.max(-0.55, Math.min(0.55, (hxp - hxm) / (2 * e)));
      out.z = Math.max(-0.55, Math.min(0.55, (hzp - hzm) / (2 * e)));
    },
  };
}

// ============================================================================
// ФАБРИКА КАРТ
// ============================================================================
const ORIGIN_SPAWN = { x: 0, z: 0, psi: 0 };

export function createTerrain(mapId: MapId = 'polygon'): Terrain {
  if (mapId === 'hill') return createHillTerrain();
  if (mapId === 'city') {
    const heightFn = (x: number, z: number) => {
      const s = surfaceAtCity(x, z);
      return macroHeightCity(x, z) + roughness(s, x, z) + bumpHeightCity(x, z);
    };
    return {
      mapId: 'city',
      spawn: ORIGIN_SPAWN,
      macro: macroHeightCity,
      surface: surfaceAtCity,
      obstacles: CITY_DATA.obstacles,
      boxes: CITY_DATA.boxes,
      cones: CITY_CONES,
      ramps: CITY_RAMPS,
      speedBumps: CITY_SPEED_BUMPS,
      signs: CITY_SIGNS,
      height: heightFn,
      gradient(x, z, out) {
        const e = 0.35;
        const hxp = macroHeightCity(x + e, z) + bumpHeightCity(x + e, z);
        const hxm = macroHeightCity(x - e, z) + bumpHeightCity(x - e, z);
        const hzp = macroHeightCity(x, z + e) + bumpHeightCity(x, z + e);
        const hzm = macroHeightCity(x, z - e) + bumpHeightCity(x, z - e);
        out.x = Math.max(-0.55, Math.min(0.55, (hxp - hxm) / (2 * e)));
        out.z = Math.max(-0.55, Math.min(0.55, (hzp - hzm) / (2 * e)));
      },
    };
  }

  // Полигон (по умолчанию)
  const heightFn = (x: number, z: number) => {
    const s = surfaceAtPolygon(x, z);
    const cx = ((((x + CELL / 2) % CELL) + CELL) % CELL) - CELL / 2;
    const cz = ((((z + CELL / 2) % CELL) + CELL) % CELL) - CELL / 2;
    const edge = Math.min(CELL / 2 - Math.abs(cx), CELL / 2 - Math.abs(cz));
    const f = smoothstep(0, 1.5, edge);
    return macroHeightPolygon(x, z) + roughness(s, x, z) * f + bumpHeightPolygon(x, z);
  };

  return {
    mapId: 'polygon',
    spawn: ORIGIN_SPAWN,
    macro: macroHeightPolygon,
    surface: surfaceAtPolygon,
    obstacles: OBSTACLES,
    boxes: [],
    cones: CONES,
    ramps: [RAMP],
    speedBumps: SPEED_BUMPS,
    signs: [],
    height: heightFn,
    gradient(x, z, out) {
      const e = 0.35;
      const hxp = macroHeightPolygon(x + e, z) + bumpHeightPolygon(x + e, z);
      const hxm = macroHeightPolygon(x - e, z) + bumpHeightPolygon(x - e, z);
      const hzp = macroHeightPolygon(x, z + e) + bumpHeightPolygon(x, z + e);
      const hzm = macroHeightPolygon(x, z - e) + bumpHeightPolygon(x, z - e);
      out.x = Math.max(-0.55, Math.min(0.55, (hxp - hxm) / (2 * e)));
      out.z = Math.max(-0.55, Math.min(0.55, (hzp - hzm) / (2 * e)));
    },
  };
}

// Экспортируем для обратной совместимости
export const macroHeight = macroHeightPolygon;
export const surfaceAt = surfaceAtPolygon;
export const bumpHeight = bumpHeightPolygon;

export function createFlatTerrain(s: SurfaceId = 'asphalt'): Terrain {
  return {
    mapId: 'polygon',
    spawn: ORIGIN_SPAWN,
    macro: () => 0,
    height: () => 0,
    surface: () => s,
    obstacles: [],
    boxes: [],
    cones: [],
    ramps: [],
    speedBumps: [],
    signs: [],
    gradient(_x, _z, out) {
      out.x = 0;
      out.z = 0;
    },
  };
}
