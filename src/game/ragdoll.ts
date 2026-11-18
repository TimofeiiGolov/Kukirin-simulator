import * as THREE from 'three';
import type { ContactCause, DamageSystem } from './damage';
import { SURFACES, type ReplayCamMode } from './data';
import type { DynamicCone } from './physics';
import type { VisualState } from './scooterModel';
import { HALF, type Terrain } from './terrain';

// Индексы 17 анатомических узлов рэгдолла (51 float в массиве координат)
export const P_PELVIS = 0;
export const P_CHEST = 1;
export const P_HEAD = 2;
export const P_HIP_L = 3;
export const P_HIP_R = 4;
export const P_SH_L = 5;
export const P_SH_R = 6;
export const P_KNEE_L = 7;
export const P_KNEE_R = 8;
export const P_ANK_L = 9;
export const P_ANK_R = 10;
export const P_TOE_L = 11;
export const P_TOE_R = 12;
export const P_ELB_L = 13;
export const P_ELB_R = 14;
export const P_HAND_L = 15;
export const P_HAND_R = 16;

export const PARTICLE_COUNT = 17;
export const POSE_FLOATS = PARTICLE_COUNT * 3;

const G = 9.81;
const SUB_DT = 1 / 240;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrapPi = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const lerpAngle = (a: number, b: number, t: number) => a + wrapPi(b - a) * t;

export type CrashKind = 'obstacle' | 'endo' | 'loopout' | 'landing' | 'slip';

export interface CrashEventInfo {
  reason: string;
  preVxW: number;
  preVyW: number;
  preVzW: number;
  preSpeed: number; // м/с до удара
  impactVn: number; // нормальная скорость удара, м/с
  impactNx: number; // нормаль препятствия X (от препятствия к самокату)
  impactNz: number; // нормаль препятствия Z
  impactX: number;
  impactY: number;
  impactZ: number;
  peakG: number;
  kind: CrashKind;
}

export interface ScooterColliderState {
  x: number;
  y: number;
  z: number;
  psi: number;
  lay?: number; // 0 — самокат стоит, 1 — лежит на боку
  side?: number; // сторона падения самоката (+1 вправо)
}

interface DistanceConstraint {
  a: number;
  b: number;
  rest: number;
  stiff: number;
}

interface LimitConstraint {
  a: number;
  b: number;
  minD: number;
  maxD: number;
  stiff: number;
}

// Радиусы коллизии сфер каждого узла рэгдолла (м)
const RADII: number[] = [
  0.122, // 0: pelvis
  0.142, // 1: chest
  0.128, // 2: head (в шлеме)
  0.082, // 3: hipL
  0.082, // 4: hipR
  0.072, // 5: shL
  0.072, // 6: shR
  0.058, // 7: kneeL
  0.058, // 8: kneeR
  0.052, // 9: ankL
  0.052, // 10: ankR
  0.046, // 11: toeL
  0.046, // 12: toeR
  0.050, // 13: elbL
  0.050, // 14: elbR
  0.045, // 15: handL
  0.045, // 16: handR
];

// Реалистичное антропометрическое распределение массы сегментов тела человека (кг, суммарно ~72 кг с экипировкой)
const MASS_KG: number[] = [
  11.5, // 0: pelvis (таз и низ живота)
  13.2, // 1: chest (грудная клетка и спина)
  6.0,  // 2: head (голова + шлем)
  5.0,  // 3: hipL (тазобедренный сустав и верх бедра Л)
  5.0,  // 4: hipR (тазобедренный сустав и верх бедра П)
  3.7,  // 5: shL (плечевой пояс Л)
  3.7,  // 6: shR (плечевой пояс П)
  4.6,  // 7: kneeL (бедро/колено Л)
  4.6,  // 8: kneeR (бедро/колено П)
  2.3,  // 9: ankL (голень/лодыжка Л)
  2.3,  // 10: ankR (голень/лодыжка П)
  1.05, // 11: toeL (стопа/кроссовка Л)
  1.05, // 12: toeR (стопа/кроссовка П)
  1.85, // 13: elbL (плечо/локоть Л)
  1.85, // 14: elbR (плечо/локоть П)
  1.1,  // 15: handL (предплечье/кисть Л)
  1.1,  // 16: handR (предплечье/кисть П)
];

const TOTAL_MASS = MASS_KG.reduce((s, m) => s + m, 0);

// Обратные массы узлов: таз и грудь в ~11 раз тяжелее кистей и стоп, поэтому конечности не «дёргают» корпус
const INV_MASS: number[] = MASS_KG.map((m) => 1 / m);

// Относительный уровень высоты узла в теле (0 = стопы, 1 = голова)
const HEIGHT_WEIGHT: number[] = [
  0.52, // pelvis
  0.84, // chest
  1.0,  // head
  0.48, // hipL
  0.48, // hipR
  0.82, // shL
  0.82, // shR
  0.26, // kneeL
  0.26, // kneeR
  0.06, // ankL
  0.06, // ankR
  0.04, // toeL
  0.04, // toeR
  0.66, // elbL
  0.66, // elbR
  0.55, // handL
  0.55, // handR
];

// Самопересечения: пары узлов, узел против сегмента и сегмент против сегмента (чтобы конечности
// не проходили сквозь корпус, голову и друг друга)
const SELF_COLLISION_PAIRS: [number, number, number][] = [
  [P_HAND_L, P_HEAD, 0.18],
  [P_HAND_R, P_HEAD, 0.18],
  [P_KNEE_L, P_HEAD, 0.19],
  [P_KNEE_R, P_HEAD, 0.19],
  [P_HAND_L, P_HAND_R, 0.1],
  [P_TOE_L, P_TOE_R, 0.1],
];
const POINT_SEGMENT_PAIRS: [number, number, number, number][] = [
  [P_HAND_L, P_PELVIS, P_CHEST, 0.18],
  [P_HAND_R, P_PELVIS, P_CHEST, 0.18],
  [P_ELB_L, P_PELVIS, P_CHEST, 0.175],
  [P_ELB_R, P_PELVIS, P_CHEST, 0.175],
  [P_KNEE_L, P_PELVIS, P_CHEST, 0.19],
  [P_KNEE_R, P_PELVIS, P_CHEST, 0.19],
  [P_ANK_L, P_PELVIS, P_CHEST, 0.17],
  [P_ANK_R, P_PELVIS, P_CHEST, 0.17],
  [P_HAND_L, P_HIP_L, P_KNEE_L, 0.11],
  [P_HAND_R, P_HIP_R, P_KNEE_R, 0.11],
  [P_HAND_L, P_HIP_R, P_KNEE_R, 0.11],
  [P_HAND_R, P_HIP_L, P_KNEE_L, 0.11],
];
const SEGMENT_PAIRS: [number, number, number, number, number][] = [
  [P_HIP_L, P_KNEE_L, P_HIP_R, P_KNEE_R, 0.135],
  [P_KNEE_L, P_ANK_L, P_KNEE_R, P_ANK_R, 0.105],
  [P_KNEE_L, P_ANK_L, P_HIP_R, P_KNEE_R, 0.12],
  [P_KNEE_R, P_ANK_R, P_HIP_L, P_KNEE_L, 0.12],
  [P_ELB_L, P_HAND_L, P_ELB_R, P_HAND_R, 0.085],
  [P_ANK_L, P_TOE_L, P_ANK_R, P_TOE_R, 0.09],
];

// Середины костей как дополнительные сферы столкновений: тонкий столб или бордюр не проходит между суставами
const MID_BONES: [number, number, number][] = [
  [P_HIP_L, P_KNEE_L, 0.07],
  [P_HIP_R, P_KNEE_R, 0.07],
  [P_KNEE_L, P_ANK_L, 0.052],
  [P_KNEE_R, P_ANK_R, 0.052],
  [P_SH_L, P_ELB_L, 0.048],
  [P_SH_R, P_ELB_R, 0.048],
  [P_ELB_L, P_HAND_L, 0.042],
  [P_ELB_R, P_HAND_R, 0.042],
  [P_PELVIS, P_CHEST, 0.13],
];

// Анатомические пределы суставов (синусы/косинусы углов)
const SIN = (deg: number) => Math.sin((deg * Math.PI) / 180);
const KNEE_HYPER = SIN(3); // переразгибание колена
const KNEE_SIDE = SIN(30); // увод голени вбок (ротация бедра)
const HIP_BACK = SIN(24); // разгибание бедра назад
const HIP_UP = SIN(40); // бедро выше горизонтали
const HIP_ADD = SIN(20); // приведение через среднюю линию
const HIP_ABD = SIN(46); // отведение в сторону
const FOOT_FWD = SIN(22); // стопа не смотрит назад
const FOOT_SIDE = SIN(32);
const ARM_BACK = SIN(40); // заведение плеча за спину
const ARM_CROSS = SIN(32); // заведение плеча через грудь
const ELBOW_BACK = SIN(10); // переразгибание локтя
const NECK_COS = Math.cos((36 * Math.PI) / 180);
const TWIST_MAX = (30 * Math.PI) / 180; // скручивание плеч относительно таза
const JOINT_STIFF = 0.8;

export class RagdollSim {
  active = false;
  age = 0;
  private acc = 0;

  // Текущие и предыдущие мировые координаты 17 частиц (Verlet)
  pos = new Float32Array(POSE_FLOATS);
  prev = new Float32Array(POSE_FLOATS);

  // Метрики полёта и удара
  comPos = new THREE.Vector3();
  comVel = new THREE.Vector3();
  originPos = new THREE.Vector3();
  impactPos = new THREE.Vector3();
  flightDist = 0;
  maxHeight = 0;
  baseGroundY = 0;
  peakG = 0;
  impactKmh = 0;
  lastHitImpact = 0;
  private hitCooldown = 0;
  /** Модель травм: получает удары, скольжение и перегрузки суставов. */
  damage: DamageSystem | null = null;
  private restT = 0;

  /** Тело улеглось: центр масс почти неподвижен дольше трети секунды. */
  get settled() {
    return this.age > 0.6 && this.restT > 0.35;
  }

  private bones: DistanceConstraint[] = [];
  private limits: LimitConstraint[] = [];

  constructor() {
    this.buildDefaultConstraints();
  }

  private buildDefaultConstraints() {
    // 1. Основные кости и жёсткий 3D-каркас торса/таза (тетраэдральная ферма)
    this.bones = [
      // Позвоночник и шея
      { a: P_PELVIS, b: P_CHEST, rest: 0.5, stiff: 1.0 },
      { a: P_CHEST, b: P_HEAD, rest: 0.21, stiff: 1.0 },

      // Тазовый пояс
      { a: P_PELVIS, b: P_HIP_L, rest: 0.088, stiff: 1.0 },
      { a: P_PELVIS, b: P_HIP_R, rest: 0.088, stiff: 1.0 },
      { a: P_HIP_L, b: P_HIP_R, rest: 0.17, stiff: 1.0 },

      // Плечевой пояс
      { a: P_CHEST, b: P_SH_L, rest: 0.188, stiff: 1.0 },
      { a: P_CHEST, b: P_SH_R, rest: 0.188, stiff: 1.0 },
      { a: P_SH_L, b: P_SH_R, rest: 0.37, stiff: 1.0 },

      // Диагональные распорки торса (удерживают 3D-объём грудной клетки и таза при тяжёлых кувырках)
      { a: P_PELVIS, b: P_SH_L, rest: 0.525, stiff: 0.95 },
      { a: P_PELVIS, b: P_SH_R, rest: 0.525, stiff: 0.95 },
      { a: P_CHEST, b: P_HIP_L, rest: 0.515, stiff: 0.95 },
      { a: P_CHEST, b: P_HIP_R, rest: 0.515, stiff: 0.95 },
      { a: P_HIP_L, b: P_SH_L, rest: 0.495, stiff: 0.9 },
      { a: P_HIP_R, b: P_SH_R, rest: 0.495, stiff: 0.9 },
      { a: P_HIP_L, b: P_SH_R, rest: 0.535, stiff: 0.86 },
      { a: P_HIP_R, b: P_SH_L, rest: 0.535, stiff: 0.86 },

      // Ноги и стопы
      { a: P_HIP_L, b: P_KNEE_L, rest: 0.42, stiff: 1.0 },
      { a: P_KNEE_L, b: P_ANK_L, rest: 0.41, stiff: 1.0 },
      { a: P_ANK_L, b: P_TOE_L, rest: 0.16, stiff: 1.0 },
      { a: P_HIP_R, b: P_KNEE_R, rest: 0.42, stiff: 1.0 },
      { a: P_KNEE_R, b: P_ANK_R, rest: 0.41, stiff: 1.0 },
      { a: P_ANK_R, b: P_TOE_R, rest: 0.16, stiff: 1.0 },

      // Руки
      { a: P_SH_L, b: P_ELB_L, rest: 0.35, stiff: 1.0 },
      { a: P_ELB_L, b: P_HAND_L, rest: 0.34, stiff: 1.0 },
      { a: P_SH_R, b: P_ELB_R, rest: 0.35, stiff: 1.0 },
      { a: P_ELB_R, b: P_HAND_R, rest: 0.34, stiff: 1.0 },
    ];

    // 2. Анатомические ограничители углов суставов
    this.limits = [
      // Шея и голова держат анатомическую осанку и не проваливаются в грудь или спину
      { a: P_PELVIS, b: P_HEAD, minD: 0.64, maxD: 0.72, stiff: 0.82 },
      { a: P_SH_L, b: P_HEAD, minD: 0.22, maxD: 0.30, stiff: 0.74 },
      { a: P_SH_R, b: P_HEAD, minD: 0.22, maxD: 0.30, stiff: 0.74 },
      { a: P_HIP_L, b: P_HEAD, minD: 0.62, maxD: 0.74, stiff: 0.55 },
      { a: P_HIP_R, b: P_HEAD, minD: 0.62, maxD: 0.74, stiff: 0.55 },

      // Голеностоп (держит кроссовку под естественным углом ~80..105° к голени)
      { a: P_KNEE_L, b: P_TOE_L, minD: 0.40, maxD: 0.46, stiff: 0.78 },
      { a: P_KNEE_R, b: P_TOE_R, minD: 0.40, maxD: 0.46, stiff: 0.78 },

      // Сгибание коленей в анатомических пределах (не сгибаются до пятки в таз и не переразгибаются)
      { a: P_HIP_L, b: P_ANK_L, minD: 0.44, maxD: 0.815, stiff: 0.48 },
      { a: P_HIP_R, b: P_ANK_R, minD: 0.44, maxD: 0.815, stiff: 0.48 },

      // Сгибание локтей в анатомических пределах
      { a: P_SH_L, b: P_HAND_L, minD: 0.30, maxD: 0.675, stiff: 0.44 },
      { a: P_SH_R, b: P_HAND_R, minD: 0.30, maxD: 0.675, stiff: 0.44 },

      // Ограничение чрезмерного задирания бёдер/коленей и разведения ног в шпагат
      { a: P_CHEST, b: P_KNEE_L, minD: 0.34, maxD: 0.92, stiff: 0.42 },
      { a: P_CHEST, b: P_KNEE_R, minD: 0.34, maxD: 0.92, stiff: 0.42 },
      { a: P_KNEE_L, b: P_KNEE_R, minD: 0.12, maxD: 0.68, stiff: 0.52 },
      { a: P_ANK_L, b: P_ANK_R, minD: 0.11, maxD: 0.88, stiff: 0.45 },

      // Ограничение выворота плечевого сустава назад
      { a: P_PELVIS, b: P_ELB_L, minD: 0.24, maxD: 0.78, stiff: 0.38 },
      { a: P_PELVIS, b: P_ELB_R, minD: 0.24, maxD: 0.78, stiff: 0.38 },
    ];
  }

  reset() {
    this.active = false;
    this.age = 0;
    this.acc = 0;
    this.flightDist = 0;
    this.maxHeight = 0;
    this.lastHitImpact = 0;
    this.hitCooldown = 0;
    this.restT = 0;
  }

  private computeMassWeightedCom(out: THREE.Vector3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const m = MASS_KG[i];
      const idx = i * 3;
      cx += this.pos[idx] * m;
      cy += this.pos[idx + 1] * m;
      cz += this.pos[idx + 2] * m;
    }
    out.set(cx / TOTAL_MASS, cy / TOTAL_MASS, cz / TOTAL_MASS);
  }

  trigger(
    initialWorldPose: Float32Array,
    info: CrashEventInfo,
    scooterPsi: number,
    scooterYawRate: number,
    crashSide: number,
    terrain: Terrain,
  ) {
    this.active = true;
    this.age = 0;
    this.acc = 0;
    this.lastHitImpact = 0;
    this.hitCooldown = 0.08;
    this.restT = 0;

    this.pos.set(initialWorldPose);
    this.prev.set(initialWorldPose);

    this.computeMassWeightedCom(this.comPos);
    this.originPos.copy(this.comPos);
    this.impactPos.set(info.impactX, info.impactY, info.impactZ);
    this.baseGroundY = terrain.height(this.comPos.x, this.comPos.z);
    this.flightDist = 0;
    this.maxHeight = 0;
    this.impactKmh = Math.round(Math.max(info.preSpeed, info.impactVn) * 3.6);
    this.peakG = Math.round(info.peakG * 10) / 10;

    // Вектор направления взгляда самоката
    const fx = Math.cos(scooterPsi);
    const fz = -Math.sin(scooterPsi);
    const lx = -Math.sin(scooterPsi);
    const lz = -Math.cos(scooterPsi);

    // Реальная скорость тела райдера непосредственно перед ударом (сохранение импульса)
    let baseVx = info.preVxW;
    let baseVy = clamp(info.preVyW, -6.5, 3.5);
    let baseVz = info.preVzW;
    const spd = Math.hypot(baseVx, baseVz);
    const effSpd = Math.max(spd, info.impactVn, 1.4);

    if (spd < 0.8) {
      baseVx = fx * effSpd * 0.55;
      baseVz = fz * effSpd * 0.55;
    }

    // Определяем параметры инерционного отделения человека от самоката по типу аварии:
    // В отличие от лёгкой куклы, реальный человек весом ~75 кг НЕ подлетает свечой вверх на 4 метра!
    // При ударе передним колесом стопы тормозятся о деку/стойку, а тяжёлый таз и грудная клетка
    // продолжают двигаться вперёд по инерции, создавая естественный вращательный момент (кувырок через руль).
    let footFactor = 0.42; // доля горизонтальной скорости у стоп
    let headFactor = 0.94; // доля горизонтальной скорости у головы и плеч
    let pitchAngular = 0;  // угловой импульс вращения вокруг поперечной оси (м/с на метр роста)
    let liftCom = 0;       // умеренный вертикальный подъём ЦТ за счёт опоры рук о руль (м/с)
    let sideVel = crashSide * clamp(effSpd * 0.06, 0.15, 0.85);
    let wallHit = 0; // скорость, погашенная о глухую стену

    if (info.kind === 'obstacle' || info.kind === 'endo') {
      const dotNorm = -(baseVx * info.impactNx + baseVz * info.impactNz) / Math.max(spd, 0.01);
      // Проверяем, не врезались ли мы вплотную в высокую стену здания
      const wallAhead =
        info.kind === 'obstacle' &&
        dotNorm > 0.55 &&
        terrain.boxes.some(
          (b) =>
            b.h > 2.2 &&
            Math.abs(info.impactX - b.x) <= b.halfX + 0.55 &&
            Math.abs(info.impactZ - b.z) <= b.halfZ + 0.55,
        );

      if (wallAhead) {
        // Удар в глухую стену: импульс гасится о стену, тело сминается и оседает вниз с небольшим отскоком
        baseVx = baseVx * 0.22 + info.impactNx * clamp(info.impactVn * 0.16, 0.25, 1.35);
        baseVz = baseVz * 0.22 + info.impactNz * clamp(info.impactVn * 0.16, 0.25, 1.35);
        wallHit = info.impactVn * 0.78;
        footFactor = 0.55;
        headFactor = 0.65;
        pitchAngular = clamp(effSpd * 0.08, 0.2, 0.9);
        liftCom = clamp(0.12 + info.impactVn * 0.04, 0.1, 0.55);
      } else {
        // Перелёт через руль (high-side / over-the-bars) через капот авто, столбик, камень или при стоппи:
        // Стопы задерживаются декой/рулевой колонкой, а корпус летит вперёд по баллистической дуге
        footFactor = 0.30;
        headFactor = 0.95;
        pitchAngular = clamp(0.55 + effSpd * 0.14, 0.55, 2.35);
        // Вертикальная скорость возникает только от отталкивания руками от руля и разворота корпуса (~0.35..1.45 м/с)
        liftCom = clamp(0.32 + effSpd * 0.085, 0.32, 1.45);
      }
    } else if (info.kind === 'loopout') {
      // Переворот назад при станте: самокат выскальзывает из-под ног вперёд,
      // а райдер падает спиной/тазом вниз на асфальт позади самоката
      footFactor = 0.78;
      headFactor = 0.52;
      pitchAngular = -clamp(0.65 + effSpd * 0.12, 0.65, 1.85);
      liftCom = clamp(0.12 + effSpd * 0.03, 0.1, 0.45);
      baseVy = Math.min(baseVy, -0.25);
    } else if (info.kind === 'landing') {
      // Жёсткое приземление с трамплина под углом: ноги подкашиваются, корпус клюёт вперёд в перекат
      footFactor = 0.52;
      headFactor = 0.90;
      pitchAngular = clamp(0.5 + effSpd * 0.12, 0.5, 1.9);
      liftCom = clamp(Math.abs(info.preVyW) * 0.18, 0.15, 0.95);
    } else {
      // Срыв в занос (lowside): колёса уходят вбок, райдер заваливается на бедро и плечо и скользит по покрытию
      footFactor = 0.72;
      headFactor = 0.84;
      pitchAngular = clamp(0.3 + effSpd * 0.08, 0.3, 1.25);
      liftCom = clamp(0.05 + effSpd * 0.025, 0.05, 0.35);
      baseVy = Math.min(baseVy, -0.35);
      sideVel = crashSide * clamp(0.75 + effSpd * 0.14, 0.75, 2.25);
    }

    const twistRate = clamp(scooterYawRate * 0.42 + crashSide * 0.75, -2.4, 2.4);

    let comVx = 0;
    let comVy = 0;
    let comVz = 0;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3;
      const h = HEIGHT_WEIGHT[i]; // 0 внизу (стопы), 1 вверху (голова)
      const centeredH = h - 0.52; // рычаг относительно центра масс (таз/живот)

      // Плавный градиент продольной скорости от стоп к голове по закону вращения твёрдого тела
      const velScale = footFactor + (headFactor - footFactor) * h;
      const fwdRotVel = centeredH * pitchAngular;

      const sideSign =
        i === P_SH_L || i === P_ELB_L || i === P_HAND_L || i === P_HIP_L || i === P_KNEE_L || i === P_ANK_L
          ? -1
          : i === P_SH_R || i === P_ELB_R || i === P_HAND_R || i === P_HIP_R || i === P_KNEE_R || i === P_ANK_R
            ? 1
            : 0;

      // Естественная асимметрия конечностей без резкого разбрасывания
      const limbAsym = i >= P_ELB_L ? sideSign * clamp(effSpd * 0.045, 0.1, 0.55) : 0;

      const vx =
        baseVx * velScale +
        fx * (fwdRotVel + limbAsym) +
        lx * (sideVel * (0.75 + 0.35 * h) + sideSign * twistRate * 0.16);

      // При вращении вперёд через руль таз и ноги кратковременно поднимаются дугой вокруг руля,
      // а голова движется преимущественно вперёд по касательной
      const arcVy =
        info.kind === 'obstacle' || info.kind === 'endo'
          ? liftCom * (0.85 - 0.25 * Math.abs(h - 0.55)) + Math.max(0, -centeredH) * pitchAngular * 0.45
          : liftCom * (0.5 + 0.4 * h);

      const vy = clamp(baseVy * 0.55 + arcVy, -5.0, 2.4);

      const vz =
        baseVz * velScale +
        fz * (fwdRotVel + limbAsym) +
        lz * (sideVel * (0.75 + 0.35 * h) + sideSign * twistRate * 0.16);

      this.prev[idx] = this.pos[idx] - vx * SUB_DT;
      this.prev[idx + 1] = this.pos[idx + 1] - vy * SUB_DT;
      this.prev[idx + 2] = this.pos[idx + 2] - vz * SUB_DT;

      const m = MASS_KG[i];
      comVx += vx * m;
      comVy += vy * m;
      comVz += vz * m;
    }

    this.comVel.set(comVx / TOTAL_MASS, comVy / TOTAL_MASS, comVz / TOTAL_MASS);

    // Лобовой удар: руки принимают нагрузку через руль, корпус налетает на стойку
    if (this.damage && (info.kind === 'obstacle' || info.kind === 'endo') && info.impactVn > 4 && this.computeFrames()) {
      const f = this.fr;
      const v = info.impactVn * 0.34;
      for (const part of [P_HAND_L, P_HAND_R]) this.damage.contact(part, v, 0, -f[12], -f[13], -f[14], 'handlebar', 1, 0, f, this.pos);
      this.damage.contact(P_CHEST, v * 0.9, 0, -f[12], -f[13], -f[14], 'handlebar', 1, 0, f, this.pos);
      if (wallHit > 0) {
        // Стена останавливает тело сразу: грудь, лицо и колени принимают основной удар
        this.damage.contact(P_CHEST, wallHit * 0.6, 0, -f[12], -f[13], -f[14], 'wall', 1, 0, f, this.pos);
        this.damage.contact(P_HEAD, wallHit * 0.5, 0, -f[12], -f[13], -f[14], 'wall', 1, 0, f, this.pos);
        for (const part of [P_KNEE_L, P_KNEE_R]) this.damage.contact(part, wallHit * 0.45, 0, -f[12], -f[13], -f[14], 'wall', 1, 0, f, this.pos);
      }
    }
  }

  step(dt: number, terrain: Terrain, scooter?: ScooterColliderState) {
    if (!this.active || dt <= 0) return;
    this.age += dt;
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.acc += Math.min(dt, 0.05);

    let maxHit = 0;
    let steps = 0;
    while (this.acc >= SUB_DT && steps < 12) {
      const hit = this.stepSub(SUB_DT, terrain, scooter);
      if (hit > maxHit) maxHit = hit;
      this.acc -= SUB_DT;
      steps++;
    }
    if (steps >= 12) this.acc = 0;

    if (maxHit > 1.4 && this.hitCooldown <= 0) {
      this.lastHitImpact = maxHit;
      this.hitCooldown = 0.11;
      const hitG = maxHit * 1.95;
      if (hitG > this.peakG) {
        this.peakG = Math.round(hitG * 10) / 10;
      }
    }

    // Обновляем взвешенный по массе ЦТ, скорость ЦТ, дистанцию перемещения и макс. подъём ЦТ
    const prevComX = this.comPos.x;
    const prevComY = this.comPos.y;
    const prevComZ = this.comPos.z;
    this.computeMassWeightedCom(this.comPos);

    if (steps > 0) {
      const stepTime = steps * SUB_DT;
      this.comVel.set(
        (this.comPos.x - prevComX) / stepTime,
        (this.comPos.y - prevComY) / stepTime,
        (this.comPos.z - prevComZ) / stepTime,
      );
    }

    if (this.comVel.length() < 0.4) this.restT += dt;
    else this.restT = 0;

    const d = Math.hypot(this.comPos.x - this.originPos.x, this.comPos.z - this.originPos.z);
    if (d > this.flightDist) this.flightDist = d;

    const gy = terrain.height(this.comPos.x, this.comPos.z);
    const hAbove = Math.max(0, this.comPos.y - gy);
    if (hAbove > this.maxHeight) this.maxHeight = hAbove;
  }

  private stepSub(dt: number, terrain: Terrain, scooter?: ScooterColliderState): number {
    const pos = this.pos;
    const prev = this.prev;
    const gravStep = G * dt * dt;

    // 1. Интеграция Верле с учётом баллистической инерции тяжёлого тела
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3;
      const x = pos[idx];
      const y = pos[idx + 1];
      const z = pos[idx + 2];

      // Тяжёлый торс и таз почти не тормозятся воздухом, а конечности испытывают лёгкое аэродинамическое сопротивление
      const airDrag = INV_MASS[i] < 0.25 ? 0.9996 : 0.9988;
      const vx = (x - prev[idx]) * airDrag;
      const vy = (y - prev[idx + 1]) * airDrag;
      const vz = (z - prev[idx + 2]) * airDrag;

      prev[idx] = x;
      prev[idx + 1] = y;
      prev[idx + 2] = z;

      pos[idx] = x + vx;
      pos[idx + 1] = y + vy - gravStep;
      pos[idx + 2] = z + vz;
    }

    // 2. Внутреннее вязкоупругое демпфирование суставов и мышечный тонус (гасит «резиновое» болтание конечностей)
    this.dampJointVelocities();

    // 3. Итеративное решение костных связей, анатомических шарниров и самоколлизий
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < this.bones.length; i++) {
        const c = this.bones[i];
        this.solveDistance(c.a, c.b, c.rest, c.stiff);
      }
      for (let i = 0; i < this.limits.length; i++) {
        const l = this.limits[i];
        this.solveLimit(l.a, l.b, l.minD, l.maxD, l.stiff, 0.55);
      }
      this.solveAnatomy();
      if (iter === 3 || iter === 6) {
        this.solveSelfCollisions();
      }
    }
    this.neckSpring();

    // 4. 3D-коллизии с самокатом, препятствиями, автомобилями, зданиями и рельефом земли
    if (scooter) {
      this.solveScooterCollision(scooter);
    }
    const maxImpact = this.solveWorldCollisions(dt, terrain);

    // 5. Финальная стабилизация длин костей с сохранением скоростей Верле (не сбрасывает трение о землю!)
    for (let iter = 0; iter < 4; iter++) {
      for (let i = 0; i < this.bones.length; i++) {
        const c = this.bones[i];
        this.solveDistancePreserveVel(c.a, c.b, c.rest, c.stiff);
      }
    }
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3;
      const minH = terrain.height(pos[idx], pos[idx + 2]) + RADII[i] * 0.92;
      if (pos[idx + 1] < minH) {
        const lift = minH - pos[idx + 1];
        pos[idx + 1] = minH;
        prev[idx + 1] += lift;
      }
    }

    return maxImpact;
  }

  private dampJointVelocities() {
    const pos = this.pos;
    const prev = this.prev;
    // В первые 0.7 с падения у человека работает рефлекторный мышечный тонус (группировка), затем мышцы расслабляются
    const muscleTone = this.age < 0.7 ? 0.055 : 0.032;

    for (let i = 0; i < this.bones.length; i++) {
      const c = this.bones[i];
      const ia = c.a * 3;
      const ib = c.b * 3;

      const vax = pos[ia] - prev[ia];
      const vay = pos[ia + 1] - prev[ia + 1];
      const vaz = pos[ia + 2] - prev[ia + 2];

      const vbx = pos[ib] - prev[ib];
      const vby = pos[ib + 1] - prev[ib + 1];
      const vbz = pos[ib + 2] - prev[ib + 2];

      const dvx = vbx - vax;
      const dvy = vby - vay;
      const dvz = vbz - vaz;

      const wa = INV_MASS[c.a];
      const wb = INV_MASS[c.b];
      const wSum = wa + wb;
      const damp = muscleTone * c.stiff / wSum;

      // Корректируем prev, уменьшая относительную скорость между соединёнными узлами
      prev[ia] -= dvx * damp * wa;
      prev[ia + 1] -= dvy * damp * wa;
      prev[ia + 2] -= dvz * damp * wa;

      prev[ib] += dvx * damp * wb;
      prev[ib + 1] += dvy * damp * wb;
      prev[ib + 2] += dvz * damp * wb;
    }
  }

  private solveDistance(a: number, b: number, rest: number, stiff: number) {
    const pos = this.pos;
    const ia = a * 3;
    const ib = b * 3;
    const dx = pos[ib] - pos[ia];
    const dy = pos[ib + 1] - pos[ia + 1];
    const dz = pos[ib + 2] - pos[ia + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;

    const wa = INV_MASS[a];
    const wb = INV_MASS[b];
    const wSum = wa + wb;
    const diff = ((d - rest) / d) * (stiff / wSum);

    pos[ia] += dx * diff * wa;
    pos[ia + 1] += dy * diff * wa;
    pos[ia + 2] += dz * diff * wa;

    pos[ib] -= dx * diff * wb;
    pos[ib + 1] -= dy * diff * wb;
    pos[ib + 2] -= dz * diff * wb;
  }

  private solveDistancePreserveVel(a: number, b: number, rest: number, stiff: number) {
    const pos = this.pos;
    const prev = this.prev;
    const ia = a * 3;
    const ib = b * 3;
    const dx = pos[ib] - pos[ia];
    const dy = pos[ib + 1] - pos[ia + 1];
    const dz = pos[ib + 2] - pos[ia + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;

    const wa = INV_MASS[a];
    const wb = INV_MASS[b];
    const wSum = wa + wb;
    const diff = ((d - rest) / d) * (stiff / wSum);

    const cax = dx * diff * wa;
    const cay = dy * diff * wa;
    const caz = dz * diff * wa;
    const cbx = dx * diff * wb;
    const cby = dy * diff * wb;
    const cbz = dz * diff * wb;

    pos[ia] += cax;
    pos[ia + 1] += cay;
    pos[ia + 2] += caz;
    prev[ia] += cax;
    prev[ia + 1] += cay;
    prev[ia + 2] += caz;

    pos[ib] -= cbx;
    pos[ib + 1] -= cby;
    pos[ib + 2] -= cbz;
    prev[ib] -= cbx;
    prev[ib + 1] -= cby;
    prev[ib + 2] -= cbz;
  }

  private solveLimit(
    a: number,
    b: number,
    minD: number,
    maxD: number,
    stiff: number,
    velDamp = 0,
  ) {
    const pos = this.pos;
    const prev = this.prev;
    const ia = a * 3;
    const ib = b * 3;
    const dx = pos[ib] - pos[ia];
    const dy = pos[ib + 1] - pos[ia + 1];
    const dz = pos[ib + 2] - pos[ia + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;

    let target = d;
    if (d < minD) target = minD;
    else if (d > maxD) target = maxD;
    else return;

    const wa = INV_MASS[a];
    const wb = INV_MASS[b];
    const wSum = wa + wb;
    const diff = ((d - target) / d) * (stiff / wSum);

    const cax = dx * diff * wa;
    const cay = dy * diff * wa;
    const caz = dz * diff * wa;
    const cbx = dx * diff * wb;
    const cby = dy * diff * wb;
    const cbz = dz * diff * wb;

    pos[ia] += cax;
    pos[ia + 1] += cay;
    pos[ia + 2] += caz;

    pos[ib] -= cbx;
    pos[ib + 1] -= cby;
    pos[ib + 2] -= cbz;

    if (velDamp > 0) {
      prev[ia] += cax * velDamp;
      prev[ia + 1] += cay * velDamp;
      prev[ia + 2] += caz * velDamp;

      prev[ib] -= cbx * velDamp;
      prev[ib + 1] -= cby * velDamp;
      prev[ib + 2] -= cbz * velDamp;
    }
  }

  // Оси корпуса: [0..2] позвоночник U, [3..5] таз вправо R, [6..8] таз вперёд F,
  // [9..11] плечи вправо SR, [12..14] плечи вперёд SF
  private fr = new Float64Array(15);
  private tmpP = new Float32Array(3);
  private tmpV = new Float32Array(3);

  private nudge(i: number, dx: number, dy: number, dz: number, damp = 0.6) {
    const k = i * 3;
    this.pos[k] += dx;
    this.pos[k + 1] += dy;
    this.pos[k + 2] += dz;
    this.prev[k] += dx * damp;
    this.prev[k + 1] += dy * damp;
    this.prev[k + 2] += dz * damp;
  }

  /**
   * Поворачивает кость joint→tip на d вдоль единичной нормали n. Противосила приходится на сустав и на
   * опорную точку родительского сегмента (c1 или c2) так, чтобы сумма сил и моментов была нулевой:
   * ограничитель сустава не раскручивает тело и не заставляет его ползти по земле.
   */
  private bend(tip: number, joint: number, c1: number, c2: number, nx: number, ny: number, nz: number, d: number) {
    const pos = this.pos;
    const ij = joint * 3;
    const tx = pos[tip * 3] - pos[ij];
    const ty = pos[tip * 3 + 1] - pos[ij + 1];
    const tz = pos[tip * 3 + 2] - pos[ij + 2];
    const tn = tx * nx + ty * ny + tz * nz;
    const tpx = tx - tn * nx;
    const tpy = ty - tn * ny;
    const tpz = tz - tn * nz;
    let beta = 0;
    let ref = -1;
    let best = 0;
    for (let k = 0; k < 2; k++) {
      const c = k === 0 ? c1 : c2;
      if (c < 0) continue;
      const cx = pos[c * 3] - pos[ij];
      const cy = pos[c * 3 + 1] - pos[ij + 1];
      const cz = pos[c * 3 + 2] - pos[ij + 2];
      const cn = cx * nx + cy * ny + cz * nz;
      const cpx = cx - cn * nx;
      const cpy = cy - cn * ny;
      const cpz = cz - cn * nz;
      const cc = cpx * cpx + cpy * cpy + cpz * cpz;
      const tc = tpx * cpx + tpy * cpy + tpz * cpz;
      if (cc < 1e-4 || tc >= 0) continue;
      const score = (tc * tc) / cc;
      if (score > best) {
        best = score;
        beta = Math.min(3, -tc / cc);
        ref = c;
      }
    }
    const ids = this.sepIds;
    const g = this.sepG;
    ids[0] = tip;
    ids[1] = joint;
    g[0] = 1;
    g[1] = -(1 + beta);
    let n = 2;
    let w = INV_MASS[tip] + INV_MASS[joint] * (1 + beta) * (1 + beta);
    if (ref >= 0) {
      ids[2] = ref;
      g[2] = beta;
      w += INV_MASS[ref] * beta * beta;
      n = 3;
    }
    const stopped = this.separate(n, nx, ny, nz, (d * w) / (INV_MASS[tip] + INV_MASS[joint] * (1 + beta)), JOINT_STIFF);
    if (this.damage && stopped > 0.004) this.damage.joint(joint, tip, stopped / SUB_DT, this.age);
  }

  /** Не даёт кости a→b отклониться так, чтобы её проекция на ось стала меньше minDot. */
  private limitDot(a: number, b: number, ax: number, ay: number, az: number, minDot: number, c1: number, c2: number) {
    const pos = this.pos;
    const ia = a * 3;
    const ib = b * 3;
    const ux = pos[ib] - pos[ia];
    const uy = pos[ib + 1] - pos[ia + 1];
    const uz = pos[ib + 2] - pos[ia + 2];
    const L = Math.hypot(ux, uy, uz);
    if (L < 1e-6) return;
    const c = (ux * ax + uy * ay + uz * az) / L;
    if (c >= minDot) return;
    // Составляющая оси, перпендикулярная кости: вдоль неё кость и доворачивается
    const px = ax - (c * ux) / L;
    const py = ay - (c * uy) / L;
    const pz = az - (c * uz) / L;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-4) return;
    this.bend(b, a, c1, c2, px / pl, py / pl, pz / pl, (L * (minDot - c)) / Math.max(pl, 0.35));
  }

  private computeFrames(): boolean {
    const pos = this.pos;
    const f = this.fr;
    let ux = pos[P_CHEST * 3] - pos[P_PELVIS * 3];
    let uy = pos[P_CHEST * 3 + 1] - pos[P_PELVIS * 3 + 1];
    let uz = pos[P_CHEST * 3 + 2] - pos[P_PELVIS * 3 + 2];
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-5) return false;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const side = (l: number, r: number, o: number): boolean => {
      let x = pos[r * 3] - pos[l * 3];
      let y = pos[r * 3 + 1] - pos[l * 3 + 1];
      let z = pos[r * 3 + 2] - pos[l * 3 + 2];
      const d = x * ux + y * uy + z * uz;
      x -= ux * d;
      y -= uy * d;
      z -= uz * d;
      const len = Math.hypot(x, y, z);
      if (len < 1e-5) return false;
      f[o] = x / len;
      f[o + 1] = y / len;
      f[o + 2] = z / len;
      // вперёд = U × вправо
      f[o + 3] = uy * f[o + 2] - uz * f[o + 1];
      f[o + 4] = uz * f[o] - ux * f[o + 2];
      f[o + 5] = ux * f[o + 1] - uy * f[o];
      return true;
    };
    f[0] = ux;
    f[1] = uy;
    f[2] = uz;
    return side(P_HIP_L, P_HIP_R, 3) && side(P_SH_L, P_SH_R, 9);
  }

  /** Суставы как у человека: колено и локоть — шарниры, бедро и плечо — конусы, позвоночник скручивается ограниченно. */
  private solveAnatomy() {
    if (!this.computeFrames()) return;
    const f = this.fr;

    // Скручивание плечевого пояса относительно таза
    const ang = Math.atan2(f[9] * f[6] + f[10] * f[7] + f[11] * f[8], f[9] * f[3] + f[10] * f[4] + f[11] * f[5]);
    if (Math.abs(ang) > TWIST_MAX) {
      // Плечи и таз доворачиваются навстречу с равными моментами
      const ratio = (MASS_KG[P_SH_L] * 0.185) / (MASS_KG[P_HIP_L] * 0.085);
      const ks = ((Math.abs(ang) - TWIST_MAX) * Math.sign(ang) * JOINT_STIFF) / (1 / 0.185 + ratio / 0.085);
      const kh = ks * ratio;
      this.nudge(P_SH_R, -f[12] * ks, -f[13] * ks, -f[14] * ks);
      this.nudge(P_SH_L, f[12] * ks, f[13] * ks, f[14] * ks);
      this.nudge(P_HIP_R, f[6] * kh, f[7] * kh, f[8] * kh);
      this.nudge(P_HIP_L, -f[6] * kh, -f[7] * kh, -f[8] * kh);
    }

    this.solveLeg(P_HIP_L, P_KNEE_L, P_ANK_L, P_TOE_L, -1);
    this.solveLeg(P_HIP_R, P_KNEE_R, P_ANK_R, P_TOE_R, 1);
    this.solveArm(P_SH_L, P_ELB_L, P_HAND_L, -1);
    this.solveArm(P_SH_R, P_ELB_R, P_HAND_R, 1);

    // Шея: голова остаётся в конусе вокруг продолжения позвоночника
    this.limitDot(P_CHEST, P_HEAD, f[0], f[1], f[2], NECK_COS, P_PELVIS, -1);
  }

  private solveLeg(hip: number, knee: number, ank: number, toe: number, side: number) {
    const pos = this.pos;
    const f = this.fr;
    const ox = f[3] * side;
    const oy = f[4] * side;
    const oz = f[5] * side;

    // Тазобедренный сустав
    this.limitDot(hip, knee, f[6], f[7], f[8], -HIP_BACK, P_CHEST, P_PELVIS);
    this.limitDot(hip, knee, -f[0], -f[1], -f[2], -HIP_UP, P_CHEST, P_PELVIS);
    this.limitDot(hip, knee, ox, oy, oz, -HIP_ADD, P_CHEST, P_PELVIS);
    this.limitDot(hip, knee, -ox, -oy, -oz, -HIP_ABD, P_CHEST, P_PELVIS);

    // Ось коленного шарнира — поперечная ось таза, спроецированная поперёк бедра
    let tx = pos[knee * 3] - pos[hip * 3];
    let ty = pos[knee * 3 + 1] - pos[hip * 3 + 1];
    let tz = pos[knee * 3 + 2] - pos[hip * 3 + 2];
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-5) return;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const d = f[3] * tx + f[4] * ty + f[5] * tz;
    let ax = f[3] - d * tx;
    let ay = f[4] - d * ty;
    let az = f[5] - d * tz;
    const al = Math.hypot(ax, ay, az);
    if (al < 0.3) return;
    ax /= al;
    ay /= al;
    az /= al;
    // «Вперёд» для колена: голень сгибается только назад от этой оси
    const fx = ay * tz - az * ty;
    const fy = az * tx - ax * tz;
    const fz = ax * ty - ay * tx;

    let sx = pos[ank * 3] - pos[knee * 3];
    let sy = pos[ank * 3 + 1] - pos[knee * 3 + 1];
    let sz = pos[ank * 3 + 2] - pos[knee * 3 + 2];
    const sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-5) return;
    const hyper = (sx * fx + sy * fy + sz * fz) / sl;
    if (hyper > KNEE_HYPER) {
      this.bend(ank, knee, hip, -1, -fx, -fy, -fz, (hyper - KNEE_HYPER) * sl);
    }
    const lat = (sx * ax + sy * ay + sz * az) / sl;
    if (Math.abs(lat) > KNEE_SIDE) {
      const sg = -Math.sign(lat);
      this.bend(ank, knee, hip, -1, ax * sg, ay * sg, az * sg, (Math.abs(lat) - KNEE_SIDE) * sl);
    }

    // Голеностоп: стопа смотрит вперёд от голени и не выворачивается вбок
    sx = (pos[ank * 3] - pos[knee * 3]) / sl;
    sy = (pos[ank * 3 + 1] - pos[knee * 3 + 1]) / sl;
    sz = (pos[ank * 3 + 2] - pos[knee * 3 + 2]) / sl;
    const d2 = ax * sx + ay * sy + az * sz;
    let bx = ax - d2 * sx;
    let by = ay - d2 * sy;
    let bz = az - d2 * sz;
    const bl = Math.hypot(bx, by, bz);
    if (bl < 0.3) return;
    bx /= bl;
    by /= bl;
    bz /= bl;
    const gx = by * sz - bz * sy;
    const gy = bz * sx - bx * sz;
    const gz = bx * sy - by * sx;
    const qx = pos[toe * 3] - pos[ank * 3];
    const qy = pos[toe * 3 + 1] - pos[ank * 3 + 1];
    const qz = pos[toe * 3 + 2] - pos[ank * 3 + 2];
    const ql = Math.hypot(qx, qy, qz);
    if (ql < 1e-5) return;
    const fwd = (qx * gx + qy * gy + qz * gz) / ql;
    if (fwd < FOOT_FWD) {
      this.bend(toe, ank, knee, -1, gx, gy, gz, (FOOT_FWD - fwd) * ql);
    }
    const flat = (qx * bx + qy * by + qz * bz) / ql;
    if (Math.abs(flat) > FOOT_SIDE) {
      const sg = -Math.sign(flat);
      this.bend(toe, ank, knee, -1, bx * sg, by * sg, bz * sg, (Math.abs(flat) - FOOT_SIDE) * ql);
    }
  }

  private solveArm(sh: number, elb: number, hand: number, side: number) {
    const pos = this.pos;
    const f = this.fr;

    const other = sh === P_SH_L ? P_SH_R : P_SH_L;
    // Плечевой сустав: рука не заводится далеко за спину и через грудь
    this.limitDot(sh, elb, f[12], f[13], f[14], -ARM_BACK, other, P_PELVIS);
    this.limitDot(sh, elb, f[9] * side, f[10] * side, f[11] * side, -ARM_CROSS, other, P_PELVIS);

    let ux = pos[elb * 3] - pos[sh * 3];
    let uy = pos[elb * 3 + 1] - pos[sh * 3 + 1];
    let uz = pos[elb * 3 + 2] - pos[sh * 3 + 2];
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-5) return;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // Запретное направление предплечья: назад, а для вытянутой вперёд руки — вниз
    const fwd = Math.max(0, ux * f[12] + uy * f[13] + uz * f[14]);
    let gx = -f[12] - f[0] * fwd;
    let gy = -f[13] - f[1] * fwd;
    let gz = -f[14] - f[2] * fwd;
    const d = gx * ux + gy * uy + gz * uz;
    gx -= d * ux;
    gy -= d * uy;
    gz -= d * uz;
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 0.25) return;
    gx /= gl;
    gy /= gl;
    gz /= gl;
    const wx = pos[hand * 3] - pos[elb * 3];
    const wy = pos[hand * 3 + 1] - pos[elb * 3 + 1];
    const wz = pos[hand * 3 + 2] - pos[elb * 3 + 2];
    const wl = Math.hypot(wx, wy, wz);
    if (wl < 1e-5) return;
    const back = (wx * gx + wy * gy + wz * gz) / wl;
    if (back > ELBOW_BACK) {
      this.bend(hand, elb, sh, -1, -gx, -gy, -gz, (back - ELBOW_BACK) * wl);
    }
  }

  /** Мышцы шеи мягко возвращают голову на продолжение позвоночника. */
  private neckSpring() {
    const pos = this.pos;
    const f = this.fr;
    const ih = P_HEAD * 3;
    const k = 0.12;
    const dx = (pos[P_CHEST * 3] + f[0] * 0.205 + f[6] * 0.02 - pos[ih]) * k;
    const dy = (pos[P_CHEST * 3 + 1] + f[1] * 0.205 + f[7] * 0.02 - pos[ih + 1]) * k;
    const dz = (pos[P_CHEST * 3 + 2] + f[2] * 0.205 + f[8] * 0.02 - pos[ih + 2]) * k;
    this.nudge(P_HEAD, dx, dy, dz, 0.7);
  }

  private separatePointSegment(p: number, a: number, b: number, minD: number) {
    const pos = this.pos;
    const ip = p * 3;
    const ia = a * 3;
    const ib = b * 3;
    const abx = pos[ib] - pos[ia];
    const aby = pos[ib + 1] - pos[ia + 1];
    const abz = pos[ib + 2] - pos[ia + 2];
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-8) return;
    const t = clamp(((pos[ip] - pos[ia]) * abx + (pos[ip + 1] - pos[ia + 1]) * aby + (pos[ip + 2] - pos[ia + 2]) * abz) / ab2, 0, 1);
    const nx = pos[ip] - (pos[ia] + abx * t);
    const ny = pos[ip + 1] - (pos[ia + 1] + aby * t);
    const nz = pos[ip + 2] - (pos[ia + 2] + abz * t);
    const dist = Math.hypot(nx, ny, nz);
    if (dist >= minD || dist < 1e-5) return;
    this.sepIds[0] = p;
    this.sepIds[1] = a;
    this.sepIds[2] = b;
    this.sepG[0] = 1;
    this.sepG[1] = -(1 - t);
    this.sepG[2] = -t;
    this.separate(3, nx / dist, ny / dist, nz / dist, minD - dist);
  }

  private sepIds = [0, 0, 0, 0];
  private sepG = [0, 0, 0, 0];

  /**
   * Раздвигает n узлов вдоль нормали с весами sepG на глубину c. Скорость не создаётся, гасится только
   * сближение — тела упираются друг в друга, а не отстреливаются.
   */
  private separate(n: number, nx: number, ny: number, nz: number, c: number, stiff = 0.65): number {
    const pos = this.pos;
    const prev = this.prev;
    const ids = this.sepIds;
    const g = this.sepG;
    let w = 0;
    let vrel = 0;
    for (let k = 0; k < n; k++) {
      const i = ids[k] * 3;
      w += INV_MASS[ids[k]] * g[k] * g[k];
      vrel += g[k] * ((pos[i] - prev[i]) * nx + (pos[i + 1] - prev[i + 1]) * ny + (pos[i + 2] - prev[i + 2]) * nz);
    }
    if (w < 1e-9) return 0;
    const lam = (c * stiff) / w;
    const lamV = vrel < 0 ? -vrel / w : 0;
    for (let k = 0; k < n; k++) {
      const m = INV_MASS[ids[k]] * g[k];
      const i = ids[k] * 3;
      this.nudge(ids[k], nx * lam * m, ny * lam * m, nz * lam * m, 1);
      prev[i] -= nx * lamV * m;
      prev[i + 1] -= ny * lamV * m;
      prev[i + 2] -= nz * lamV * m;
    }
    // Погашенная скорость сближения (за подшаг)
    return vrel < 0 ? -vrel : 0;
  }

  private separateSegments(a1: number, b1: number, a2: number, b2: number, minD: number) {
    const pos = this.pos;
    const i1 = a1 * 3;
    const j1 = b1 * 3;
    const i2 = a2 * 3;
    const j2 = b2 * 3;
    const d1x = pos[j1] - pos[i1];
    const d1y = pos[j1 + 1] - pos[i1 + 1];
    const d1z = pos[j1 + 2] - pos[i1 + 2];
    const d2x = pos[j2] - pos[i2];
    const d2y = pos[j2 + 1] - pos[i2 + 1];
    const d2z = pos[j2 + 2] - pos[i2 + 2];
    const rx = pos[i1] - pos[i2];
    const ry = pos[i1 + 1] - pos[i2 + 1];
    const rz = pos[i1 + 2] - pos[i2 + 2];
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    if (a < 1e-8 || e < 1e-8) return;
    const fq = d2x * rx + d2y * ry + d2z * rz;
    const c = d1x * rx + d1y * ry + d1z * rz;
    const b = d1x * d2x + d1y * d2y + d1z * d2z;
    const den = a * e - b * b;
    // Ближайшие точки двух отрезков
    let s = den > 1e-9 ? clamp((b * fq - c * e) / den, 0, 1) : 0.5;
    let t = (b * s + fq) / e;
    if (t < 0) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else if (t > 1) {
      t = 1;
      s = clamp((b - c) / a, 0, 1);
    }
    const nx = rx + d1x * s - d2x * t;
    const ny = ry + d1y * s - d2y * t;
    const nz = rz + d1z * s - d2z * t;
    const dist = Math.hypot(nx, ny, nz);
    if (dist >= minD || dist < 1e-5) return;
    this.sepIds[0] = a1;
    this.sepIds[1] = b1;
    this.sepIds[2] = a2;
    this.sepIds[3] = b2;
    this.sepG[0] = 1 - s;
    this.sepG[1] = s;
    this.sepG[2] = -(1 - t);
    this.sepG[3] = -t;
    this.separate(4, nx / dist, ny / dist, nz / dist, minD - dist);
  }

  private solveSelfCollisions() {
    const pos = this.pos;
    for (let i = 0; i < SELF_COLLISION_PAIRS.length; i++) {
      const [a, b, minD] = SELF_COLLISION_PAIRS[i];
      const dx = pos[b * 3] - pos[a * 3];
      const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
      const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-5 && d < minD) {
        this.sepIds[0] = a;
        this.sepIds[1] = b;
        this.sepG[0] = -1;
        this.sepG[1] = 1;
        this.separate(2, dx / d, dy / d, dz / d, minD - d);
      }
    }
    for (let i = 0; i < POINT_SEGMENT_PAIRS.length; i++) {
      const q = POINT_SEGMENT_PAIRS[i];
      this.separatePointSegment(q[0], q[1], q[2], q[3]);
    }
    for (let i = 0; i < SEGMENT_PAIRS.length; i++) {
      const q = SEGMENT_PAIRS[i];
      this.separateSegments(q[0], q[1], q[2], q[3], q[4]);
    }
  }

  private solveScooterCollision(sc: ScooterColliderState) {
    const fx = Math.cos(sc.psi);
    const fz = -Math.sin(sc.psi);
    const rx = Math.sin(sc.psi);
    const rz = Math.cos(sc.psi);
    const lay01 = clamp(sc.lay ?? 0, 0, 1);
    const lay = lay01 * 1.38;
    const side = sc.side ?? 1;

    // Капсулы самоката: дека между колёсами и рулевая стойка, которая ложится набок вместе с самокатом
    const dy = sc.y + 0.17 - 0.05 * lay01;
    const upK = Math.cos(lay);
    const latK = -side * Math.sin(lay);
    const bx = sc.x + fx * 0.455;
    const by = sc.y + 0.28 - 0.1 * lay01;
    const bz = sc.z + fz * 0.455;
    const len = 0.98;
    const tx = bx + (-fx * 0.19 * upK + rx * latK) * len;
    const ty = by + Math.max(0.02, upK) * len * 0.98;
    const tz = bz + (-fz * 0.19 * upK + rz * latK) * len;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Стопы в самый первый момент отрыва не выталкиваем резко, чтобы не подбрасывать ноги
      if ((i === P_TOE_L || i === P_TOE_R || i === P_ANK_L || i === P_ANK_R) && this.age < 0.12) continue;
      const pr = RADII[i];
      this.pushFromCapsule(i, sc.x - fx * 0.5, dy, sc.z - fz * 0.5, sc.x + fx * 0.42, dy, sc.z + fz * 0.42, pr + 0.085);
      // Кисти в первые мгновения ещё держатся за руль рядом со стойкой
      if ((i === P_HAND_L || i === P_HAND_R) && this.age < 0.15) continue;
      this.pushFromCapsule(i, bx, by, bz, tx, ty, tz, pr + 0.04);
    }
  }

  private pushFromCapsule(i: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, minD: number) {
    const pos = this.pos;
    const idx = i * 3;
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-8) return;
    const t = clamp(((pos[idx] - ax) * abx + (pos[idx + 1] - ay) * aby + (pos[idx + 2] - az) * abz) / ab2, 0, 1);
    const dx = pos[idx] - (ax + abx * t);
    const dy = pos[idx + 1] - (ay + aby * t);
    const dz = pos[idx + 2] - (az + abz * t);
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-5 || d >= minD) return;
    // Самокат лёгкий: он задерживает тело, но не отбрасывает его
    // … и только пока тело падает: лежащего райдера самокат не теребит
    const fade = clamp((2 - this.age) / 0.8, 0, 1);
    if (fade <= 0) return;
    const pen = (Math.min(0.012, (minD - d) * 0.55) * fade) / d;
    // Вниз, в асфальт, самокат тело не вдавливает
    this.nudge(i, dx * pen, Math.max(0, dy) * pen, dz * pen, 1);
  }

  private solveWorldCollisions(dt: number, terrain: Terrain): number {
    const pos = this.pos;
    const prev = this.prev;
    let maxImpact = 0;
    const cx = pos[P_PELVIS * 3];
    const cz = pos[P_PELVIS * 3 + 2];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const hit = this.collideSphere(pos, prev, i * 3, RADII[i], i, dt, terrain, cx, cz);
      if (hit > maxImpact) maxImpact = hit;
    }

    // Середины костей: препятствие, попавшее между суставами, останавливает всю конечность
    const tp = this.tmpP;
    const tv = this.tmpV;
    for (let m = 0; m < MID_BONES.length; m++) {
      const [a, b, r] = MID_BONES[m];
      const ia = a * 3;
      const ib = b * 3;
      for (let k = 0; k < 3; k++) {
        tp[k] = 0.5 * (pos[ia + k] + pos[ib + k]);
        tv[k] = 0.5 * (prev[ia + k] + prev[ib + k]);
      }
      const mx = tp[0];
      const my = tp[1];
      const mz = tp[2];
      const vx = tv[0];
      const vy = tv[1];
      const vz = tv[2];
      const hit = this.collideSphere(tp, tv, 0, r, -1 - m, dt, terrain, cx, cz);
      if (tp[0] === mx && tp[1] === my && tp[2] === mz && tv[0] === vx && tv[1] === vy && tv[2] === vz) continue;
      if (hit > maxImpact) maxImpact = hit;
      const d = [tp[0] - mx, tp[1] - my, tp[2] - mz];
      const dv = [tv[0] - vx, tv[1] - vy, tv[2] - vz];
      for (let k = 0; k < 3; k++) {
        pos[ia + k] += d[k];
        pos[ib + k] += d[k];
        prev[ia + k] += dv[k];
        prev[ib + k] += dv[k];
      }
    }
    return maxImpact;
  }

  /** Столкновение одной сферы с границами карты, коробками, столбами и землёй. part < 0 — середина кости. */
  private collideSphere(
    pos: Float32Array,
    prev: Float32Array,
    idx: number,
    r: number,
    part: number,
    dt: number,
    terrain: Terrain,
    pxCenter: number,
    pzCenter: number,
  ): number {
    let maxImpact = 0;
    const lim = HALF - 0.8;
    const boxes = terrain.boxes;
    const obstacles = terrain.obstacles;
    let x = pos[idx];
    let y = pos[idx + 1];
    let z = pos[idx + 2];
    const dmg = this.damage;
    const dmgPart = part >= 0 ? part : 99 - part;
    const hurt = (vn: number, vt: number, nx: number, ny: number, nz: number, cause: ContactCause, hard: number) =>
      dmg!.contact(dmgPart, vn, vt, nx, ny, nz, cause, hard, this.age, this.fr, this.pos);

    // 1. Границы карты
    if (Math.abs(x) > lim) {
      const vn = Math.abs(x - prev[idx]) / dt;
      if (vn > maxImpact) maxImpact = vn;
      if (dmg) hurt(vn, 0, -Math.sign(x), 0, 0, 'bounds', 1);
      x = clamp(x, -lim, lim);
      prev[idx] = x;
    }
    if (Math.abs(z) > lim) {
      const vn = Math.abs(z - prev[idx + 2]) / dt;
      if (vn > maxImpact) maxImpact = vn;
      if (dmg) hurt(vn, 0, 0, 0, -Math.sign(z), 'bounds', 1);
      z = clamp(z, -lim, lim);
      prev[idx + 2] = z;
    }

    // 2. Прямоугольные 3D-объекты (машины, здания, автобусные остановки, контейнеры, лавки)
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (Math.abs(box.x - pxCenter) > box.halfX + 4.0 || Math.abs(box.z - pzCenter) > box.halfZ + 4.0) continue;

      const baseH = terrain.macro(box.x, box.z);
      const topY = baseH + box.h;
      if (y - r > topY || y + r < baseH) continue;

      const cx = clamp(x, box.x - box.halfX, box.x + box.halfX);
      const cy = clamp(y, baseH, topY);
      const cz = clamp(z, box.z - box.halfZ, box.z + box.halfZ);

      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const dist = Math.hypot(dx, dy, dz);

      if (dist < r) {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let pen = 0;

        if (dist > 1e-5) {
          nx = dx / dist;
          ny = dy / dist;
          nz = dz / dist;
          pen = r - dist;
        } else {
          // Внутри AABB — выталкиваем через ближайшую грань (включая крышу/капот!)
          const pX = box.halfX - Math.abs(x - box.x);
          const pZ = box.halfZ - Math.abs(z - box.z);
          const pTop = topY - y;
          if (pTop <= pX && pTop <= pZ && pTop < 0.75) {
            ny = 1;
            pen = pTop + r;
          } else if (pX < pZ) {
            nx = x >= box.x ? 1 : -1;
            pen = pX + r;
          } else {
            nz = z >= box.z ? 1 : -1;
            pen = pZ + r;
          }
        }

        const vx = (x - prev[idx]) / dt;
        const vy = (y - prev[idx + 1]) / dt;
        const vz = (z - prev[idx + 2]) / dt;
        const vn = -(vx * nx + vy * ny + vz * nz);

        x += nx * pen;
        y += ny * pen;
        z += nz * pen;

        if (vn > 0) {
          if (vn > maxImpact) maxImpact = vn;
          // Неупругий удар человеческого тела о препятствие/капот (без «резинового» отскока)
          const bounce = vn > 3.5 ? 0.06 : 0.0;
          const vtx = vx + vn * nx;
          const vty = vy + vn * ny;
          const vtz = vz + vn * nz;
          if (dmg) {
            const car = box.kind === 'car';
            hurt(vn, Math.hypot(vtx, vty, vtz), nx, ny, nz, car ? 'car' : box.kind === 'building' ? 'wall' : 'bench', car ? 0.85 : 1);
          }
          const fric = ny > 0.6 ? 0.82 : 0.88;
          prev[idx] = x - (vtx * fric + nx * vn * bounce) * dt;
          prev[idx + 1] = y - (vty * fric + ny * vn * bounce) * dt;
          prev[idx + 2] = z - (vtz * fric + nz * vn * bounce) * dt;
        } else {
          prev[idx] += nx * pen * 0.85;
          prev[idx + 1] += ny * pen * 0.85;
          prev[idx + 2] += nz * pen * 0.85;
        }
      }
    }

    // 3. Цилиндрические объекты (деревья, камни, столбики, фонари, светофоры)
    for (let o = 0; o < obstacles.length; o++) {
      const obs = obstacles[o];
      if (Math.abs(obs.x - pxCenter) > 4.0 || Math.abs(obs.z - pzCenter) > 4.0) continue;
      const baseH = terrain.macro(obs.x, obs.z);
      const topY = baseH + obs.h;
      if (y - r > topY) continue;

      const dx = x - obs.x;
      const dz = z - obs.z;
      const dist = Math.hypot(dx, dz);
      const minD = obs.r + r;
      if (dist < minD) {
        if (y > topY - 0.12 && dist < obs.r) {
          const vn = Math.max(0, -(y - prev[idx + 1]) / dt);
          if (vn > maxImpact) maxImpact = vn;
          if (dmg) hurt(vn, 0, 0, 1, 0, obs.kind === 'tree' ? 'tree' : obs.kind === 'rock' ? 'rock' : 'pole', 1.1);
          y = topY + r;
          prev[idx + 1] = y;
        } else {
          const nx = dist > 1e-5 ? dx / dist : 1;
          const nz = dist > 1e-5 ? dz / dist : 0;
          const pen = minD - dist;
          const vx = (x - prev[idx]) / dt;
          const vz = (z - prev[idx + 2]) / dt;
          const vn = -(vx * nx + vz * nz);
          x += nx * pen;
          z += nz * pen;
          if (vn > 0) {
            if (vn > maxImpact) maxImpact = vn;
            const bounce = vn > 3.2 ? 0.08 : 0;
            // Узкая опора концентрирует удар
            if (dmg) hurt(vn, Math.hypot(vx + vn * nx, vz + vn * nz), nx, 0, nz, obs.kind === 'tree' ? 'tree' : obs.kind === 'rock' ? 'rock' : 'pole', 1.1);
            const vtx = (vx + vn * nx) * 0.82;
            const vtz = (vz + vn * nz) * 0.82;
            prev[idx] = x - (vtx + nx * vn * bounce) * dt;
            prev[idx + 2] = z - (vtz + nz * vn * bounce) * dt;
          } else {
            prev[idx] += nx * pen * 0.85;
            prev[idx + 2] += nz * pen * 0.85;
          }
        }
      }
    }

    // 4. Рельеф земли (включая трамплины, бордюры, холмы)
    const gh = terrain.height(x, z);
    if (part < 0) {
      // Середина кости только не даёт сегменту провалиться сквозь ребро бордюра или трамплина
      if (y < gh + r) {
        const lift = gh + r - y;
        y += lift;
        prev[idx + 1] += lift * 0.5;
      }
    } else if (y < gh + r + 0.025) {
      // Реалистичный неупругий удар + кулоновское трение при касании (закручивает тело в перекат) + трение скольжения одежды
      const vx = (x - prev[idx]) / dt;
      const vy = (y - prev[idx + 1]) / dt;
      const vz = (z - prev[idx + 2]) / dt;
      const vn = Math.max(0, -vy);

      if (y < gh + r) {
        y = gh + r;
      }
      if (vn > maxImpact) maxImpact = vn;

      const surf = terrain.surface(x, z);
      const mu = SURFACES[surf]?.mu ?? 0.85;
      // Одежда и защита имеют реалистичный коэффициент трения скольжения по покрытию
      const clothMu = mu * (part === P_TOE_L || part === P_TOE_R ? 0.85 : part === P_HEAD ? 0.52 : 0.72);

      const vt = Math.hypot(vx, vz);
      if (dmg) {
        if (vn > 0.6) hurt(vn, vt, 0, 1, 0, 'ground', SURFACES[surf]?.soft ? 0.65 : 1);
        if (vt > 0.4) dmg.scrape(part, vt * dt * mu, this.age);
      }
      let newVx = vx;
      let newVz = vz;
      if (vt > 1e-4) {
        // Опорные точки несут на себе вес сопряжённых сегментов тела (таза и торса)
        const dvFriction = clothMu * (G * dt * 2.8 + vn * 0.44);
        const scale = Math.max(0, vt - dvFriction) / vt;
        newVx = vx * scale;
        newVz = vz * scale;
        if (vt < 0.18 && vn < 0.3 && this.age > 0.5) {
          newVx = 0;
          newVz = 0;
        }
      }

      // Человеческое тело не отпрыгивает от асфальта как мяч — минимальный отскок только при очень сильном ударе
      const bounceVy = vn > 4.2 ? Math.min(0.42, (vn - 4.2) * 0.05) : 0;

      prev[idx] = x - newVx * dt;
      prev[idx + 1] = y - bounceVy * dt;
      prev[idx + 2] = z - newVz * dt;
    }

    pos[idx] = x;
    pos[idx + 1] = y;
    pos[idx + 2] = z;
    return maxImpact;
  }
}

// ============================================================================
// СИСТЕМА ЗАПИСИ И ПОВТОРА СО СЛОУМО (INSTANT SLOW-MO REPLAY)
// ============================================================================

export interface ReplayConeSnap {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotZ: number;
  fallen: boolean;
}

export interface ReplayFrame {
  time: number;
  vs: VisualState;
  riderPose: Float32Array;
  comX: number;
  comY: number;
  comZ: number;
  crashed: boolean;
  sparkBurstAge: number;
  cones: ReplayConeSnap[];
}

export const SLOW_MO_PRESETS = [0.25, 0.1, 0.5, 1.0] as const;
export const REPLAY_CAM_ORDER: ReplayCamMode[] = ['orbit', 'rider', 'impact', 'fpv'];

export class ReplaySystem {
  private liveBuffer: ReplayFrame[] = [];
  private savedClip: ReplayFrame[] = [];
  private recordTime = 0;
  private lastSampleT = -1;
  private recordingCrash = false;
  private crashRecordElapsed = 0;

  // Метаданные сохранённого повтора аварии
  hasClip = false;
  impactTime = 0;
  duration = 0;
  impactPos = new THREE.Vector3();
  impactDir = new THREE.Vector3(1, 0, 0);
  crashReason = '';
  impactKmh = 0;
  peakG = 0;
  maxFlightDist = 0;
  maxHeight = 0;

  // Состояние воспроизведения
  active = false;
  paused = false;
  cursor = 0;
  slowMoFactor = 0.25;
  effectiveSpeed = 0.25;
  camMode: ReplayCamMode = 'orbit';
  orbitAngle = 0;

  // Временные буферы для гладкой интерполяции без аллокаций
  private interpPose = new Float32Array(POSE_FLOATS);
  private interpCones: DynamicCone[] = [];
  private pauseAtEndT = 0;

  resetLive() {
    this.liveBuffer.length = 0;
    this.recordTime = 0;
    this.lastSampleT = -1;
    this.recordingCrash = false;
    this.crashRecordElapsed = 0;
  }

  clearClip() {
    this.savedClip = [];
    this.hasClip = false;
    this.duration = 0;
    this.impactTime = 0;
  }

  onCrashStart(info: CrashEventInfo, scooterPsi: number) {
    this.recordingCrash = true;
    this.crashRecordElapsed = 0;
    this.maxFlightDist = 0;
    this.maxHeight = 0;
    this.impactPos.set(info.impactX, info.impactY, info.impactZ);
    this.impactDir.set(Math.cos(scooterPsi), 0, -Math.sin(scooterPsi));
    this.crashReason = info.reason;
    this.impactKmh = Math.round(Math.max(info.preSpeed, info.impactVn) * 3.6);
    this.peakG = Math.round(info.peakG * 10) / 10;
  }

  recordStep(
    dt: number,
    vs: VisualState,
    riderWorldPose: Float32Array,
    comPos: THREE.Vector3,
    crashed: boolean,
    sparkBurstAge: number,
    cones: DynamicCone[],
    flightDist: number,
    maxHeight: number,
    peakG: number,
  ) {
    if (this.active) return;
    if (this.recordingCrash && this.crashRecordElapsed > 3.4) return;
    this.recordTime += dt;

    if (this.recordingCrash) {
      this.crashRecordElapsed += dt;
      if (flightDist > this.maxFlightDist) this.maxFlightDist = flightDist;
      if (maxHeight > this.maxHeight) this.maxHeight = maxHeight;
      if (peakG > this.peakG) this.peakG = peakG;
    }

    // Записываем сэмплы с частотой ~60 Гц (каждые 0.015 с)
    if (this.lastSampleT >= 0 && this.recordTime - this.lastSampleT < 0.015) {
      return;
    }
    this.lastSampleT = this.recordTime;

    const frame: ReplayFrame = {
      time: this.recordTime,
      vs: {
        ...vs,
        wf: { ...vs.wf },
        wr: { ...vs.wr },
      },
      riderPose: new Float32Array(riderWorldPose),
      comX: comPos.x,
      comY: comPos.y,
      comZ: comPos.z,
      crashed,
      sparkBurstAge,
      cones: cones.map((c) => ({
        x: c.x,
        y: c.y,
        z: c.z,
        rotX: c.rotX,
        rotZ: c.rotZ,
        fallen: c.fallen,
      })),
    };

    this.liveBuffer.push(frame);

    if (!this.recordingCrash) {
      // В обычной езде храним скользящее окно последних 1.45 с перед возможным столкновением
      const cutoff = this.recordTime - 1.45;
      while (this.liveBuffer.length > 2 && this.liveBuffer[0].time < cutoff) {
        this.liveBuffer.shift();
      }
    } else {
      // Во время аварии сохраняем весь клип (подъезд + удар + полёт рэгдолла до 3.4 с после удара)
      if (this.crashRecordElapsed <= 3.4) {
        this.finalizeClipFromLive();
      }
    }
  }

  finalizeClipFromLive() {
    if (this.liveBuffer.length < 2) return;
    const t0 = this.liveBuffer[0].time;
    this.savedClip = this.liveBuffer.map((f) => ({
      ...f,
      time: f.time - t0,
    }));
    this.duration = Math.max(0.05, this.savedClip[this.savedClip.length - 1].time);
    const crashFrame = this.savedClip.find((f) => f.crashed);
    this.impactTime = crashFrame ? crashFrame.time : this.duration * 0.35;
    this.hasClip = this.savedClip.length >= 2;
  }

  startReplay() {
    if (this.recordingCrash && this.liveBuffer.length >= 2) {
      this.finalizeClipFromLive();
    }
    if (!this.hasClip || this.savedClip.length < 2) return false;
    this.active = true;
    this.paused = false;
    this.cursor = 0;
    this.pauseAtEndT = 0;
    this.orbitAngle = 0.55;
    return true;
  }

  stopReplay() {
    this.active = false;
    this.paused = false;
  }

  togglePause() {
    if (!this.active) return;
    this.paused = !this.paused;
  }

  seekNormalized(norm01: number) {
    if (!this.hasClip) return;
    this.cursor = clamp(norm01, 0, 1) * this.duration;
    this.pauseAtEndT = 0;
  }

  cycleSlowMo(): number {
    const idx = SLOW_MO_PRESETS.indexOf(this.slowMoFactor as (typeof SLOW_MO_PRESETS)[number]);
    this.slowMoFactor = SLOW_MO_PRESETS[(idx + 1) % SLOW_MO_PRESETS.length];
    return this.slowMoFactor;
  }

  cycleCamMode(): ReplayCamMode {
    const idx = REPLAY_CAM_ORDER.indexOf(this.camMode);
    this.camMode = REPLAY_CAM_ORDER[(idx + 1) % REPLAY_CAM_ORDER.length];
    return this.camMode;
  }

  stepReplay(realDt: number, baseCones: DynamicCone[]) {
    if (!this.active || this.savedClip.length < 2) return null;

    // Плавный профиль скорости воспроизведения:
    // на подъезде к месту ДТП — быстрее, а прямо перед ударом и во время вылета рэгдолла — глубокое СЛОУМО!
    const distFromImpact = this.cursor - this.impactTime;
    let speedMult = this.slowMoFactor;
    if (this.slowMoFactor < 0.99) {
      if (distFromImpact < -0.22) {
        speedMult = Math.max(0.85, this.slowMoFactor * 2.5);
      } else if (distFromImpact < -0.04) {
        const k = (distFromImpact - -0.22) / 0.18;
        speedMult = 0.85 + (this.slowMoFactor - 0.85) * clamp(k, 0, 1);
      } else if (distFromImpact <= 1.85) {
        speedMult = this.slowMoFactor;
      } else {
        speedMult = Math.min(1.0, this.slowMoFactor * 1.65);
      }
    }
    this.effectiveSpeed = speedMult;

    if (!this.paused) {
      this.orbitAngle += realDt * 0.28;
      if (this.cursor >= this.duration) {
        this.pauseAtEndT += realDt;
        if (this.pauseAtEndT > 0.65) {
          this.cursor = 0;
          this.pauseAtEndT = 0;
        }
      } else {
        this.cursor = Math.min(this.duration, this.cursor + realDt * speedMult);
      }
    }

    return this.sampleAt(this.cursor, baseCones);
  }

  sampleAt(t: number, baseCones: DynamicCone[]) {
    const clip = this.savedClip;
    const n = clip.length;
    const clampedT = clamp(t, 0, this.duration);

    let i0 = 0;
    while (i0 < n - 2 && clip[i0 + 1].time <= clampedT) {
      i0++;
    }
    const f0 = clip[i0];
    const f1 = clip[Math.min(n - 1, i0 + 1)];
    const span = Math.max(1e-5, f1.time - f0.time);
    const a = clamp((clampedT - f0.time) / span, 0, 1);

    // 1. Интерполяция всех 51 координат рэгдолла/райдера
    for (let k = 0; k < POSE_FLOATS; k++) {
      this.interpPose[k] = f0.riderPose[k] + (f1.riderPose[k] - f0.riderPose[k]) * a;
    }

    // 2. Интерполяция состояния самоката
    const s0 = f0.vs;
    const s1 = f1.vs;
    const vs: VisualState = {
      x: s0.x + (s1.x - s0.x) * a,
      z: s0.z + (s1.z - s0.z) * a,
      psi: lerpAngle(s0.psi, s1.psi, a),
      groundRef: s0.groundRef + (s1.groundRef - s0.groundRef) * a,
      yb: s0.yb + (s1.yb - s0.yb) * a,
      th: s0.th + (s1.th - s0.th) * a,
      phi: s0.phi + (s1.phi - s0.phi) * a,
      delta: s0.delta + (s1.delta - s0.delta) * a,
      ybRest: s0.ybRest,
      thRest: s0.thRest,
      wf: {
        x: s0.wf.x,
        y: s0.wf.y + (s1.wf.y - s0.wf.y) * a,
        angle: s0.wf.angle + (s1.wf.angle - s0.wf.angle) * a,
        temp: s0.wf.temp + (s1.wf.temp - s0.wf.temp) * a,
        comp: (s0.wf.comp ?? 0) + ((s1.wf.comp ?? 0) - (s0.wf.comp ?? 0)) * a,
      },
      wr: {
        x: s0.wr.x,
        y: s0.wr.y + (s1.wr.y - s0.wr.y) * a,
        angle: s0.wr.angle + (s1.wr.angle - s0.wr.angle) * a,
        temp: s0.wr.temp + (s1.wr.temp - s0.wr.temp) * a,
        comp: (s0.wr.comp ?? 0) + ((s1.wr.comp ?? 0) - (s0.wr.comp ?? 0)) * a,
      },
      az: s0.az + (s1.az - s0.az) * a,
      ax: s0.ax + (s1.ax - s0.ax) * a,
      lean: s0.lean + (s1.lean - s0.lean) * a,
      leanLat: (s0.leanLat ?? 0) + ((s1.leanLat ?? 0) - (s0.leanLat ?? 0)) * a,
      crashE: s0.crashE + (s1.crashE - s0.crashE) * a,
      crashSide: s1.crashSide,
      speed: s0.speed + (s1.speed - s0.speed) * a,
      throttle: (s0.throttle ?? 0) + ((s1.throttle ?? 0) - (s0.throttle ?? 0)) * a,
      brake: (s0.brake ?? 0) + ((s1.brake ?? 0) - (s0.brake ?? 0)) * a,
      parked: false,
      stuntAngle: (s0.stuntAngle ?? 0) + ((s1.stuntAngle ?? 0) - (s0.stuntAngle ?? 0)) * a,
      tailScrape: a < 0.5 ? s0.tailScrape : s1.tailScrape,
      worldRiderPose: this.interpPose,
    };

    // 3. Интерполяция конусов
    if (this.interpCones.length !== baseCones.length) {
      this.interpCones = baseCones.map((c) => ({ ...c }));
    }
    for (let i = 0; i < baseCones.length; i++) {
      const c0 = f0.cones[i];
      const c1 = f1.cones[i];
      const dst = this.interpCones[i];
      if (c0 && c1) {
        dst.x = c0.x + (c1.x - c0.x) * a;
        dst.y = c0.y + (c1.y - c0.y) * a;
        dst.z = c0.z + (c1.z - c0.z) * a;
        dst.rotX = c0.rotX + (c1.rotX - c0.rotX) * a;
        dst.rotZ = c0.rotZ + (c1.rotZ - c0.rotZ) * a;
        dst.fallen = c0.fallen || c1.fallen;
      }
    }

    const comX = f0.comX + (f1.comX - f0.comX) * a;
    const comY = f0.comY + (f1.comY - f0.comY) * a;
    const comZ = f0.comZ + (f1.comZ - f0.comZ) * a;
    const sparkBurstAge =
      f0.sparkBurstAge >= 0 && f1.sparkBurstAge >= 0
        ? f0.sparkBurstAge + (f1.sparkBurstAge - f0.sparkBurstAge) * a
        : f1.sparkBurstAge;

    return {
      vs,
      riderPose: this.interpPose,
      comX,
      comY,
      comZ,
      crashed: f0.crashed || f1.crashed,
      sparkBurstAge,
      cones: this.interpCones,
    };
  }
}
