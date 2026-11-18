import * as THREE from 'three';
import type { Look } from './data';
import { bake, cylZ, plate, rbox, studioEnv, type Pt } from './geo';
import {
  PARTICLE_COUNT,
  POSE_FLOATS,
  P_ANK_L,
  P_ANK_R,
  P_CHEST,
  P_ELB_L,
  P_ELB_R,
  P_HAND_L,
  P_HAND_R,
  P_HEAD,
  P_HIP_L,
  P_HIP_R,
  P_KNEE_L,
  P_KNEE_R,
  P_PELVIS,
  P_SH_L,
  P_SH_R,
  P_TOE_L,
  P_TOE_R,
} from './ragdoll';

const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _invM4 = new THREE.Matrix4();

function ik(
  root: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  mid: THREE.Vector3,
  end: THREE.Vector3,
) {
  _d.subVectors(target, root);
  let dist = _d.length();
  dist = Math.min(Math.max(dist, 0.06), (l1 + l2) * 0.999);
  _d.normalize();
  end.copy(root).addScaledVector(_d, dist);
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  mid.copy(root).addScaledVector(_d, a).addScaledVector(_p, h);
}

/** Ставит сегмент единичной длины между a и b: локальная −Y у a, +Y у b. */
function place(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  _a.subVectors(b, a);
  const len = _a.length();
  if (len > 1e-5) {
    _a.divideScalar(len);
    mesh.quaternion.setFromUnitVectors(UP, _a);
  }
  mesh.scale.set(1, len, 1);
}

function orientBasis(obj: THREE.Object3D, upVec: THREE.Vector3, rightZVec: THREE.Vector3) {
  _y.copy(upVec);
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0);
  else _y.normalize();

  _z.copy(rightZVec).addScaledVector(_y, -rightZVec.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
  else _z.normalize();

  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y).normalize();

  _m4.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m4);
}

// ---------------------------------------------------------------------------
// Процедурные поверхности тела и шлема
// ---------------------------------------------------------------------------

function finish(pos: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface Ring {
  y: number;
  rx: number; // полуглубина (вперёд-назад)
  rz: number; // полуширина
  x?: number;
}

/** Тело из суперэллиптических сечений вдоль Y — торс, таз. */
function loft(rings: Ring[], seg = 22, pow = 2.5): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const e = 2 / pow;
  for (const r of rings) {
    for (let j = 0; j < seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      pos.push((r.x ?? 0) + r.rx * Math.sign(c) * Math.abs(c) ** e, r.y, r.rz * Math.sign(s) * Math.abs(s) ** e);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      idx.push(a, a + seg, b, b, a + seg, b + seg);
    }
  }
  const last = rings.length - 1;
  const vb = pos.length / 3;
  pos.push(rings[0].x ?? 0, rings[0].y, 0, rings[last].x ?? 0, rings[last].y, 0);
  for (let j = 0; j < seg; j++) {
    const n = (j + 1) % seg;
    idx.push(vb, j, n, vb + 1, last * seg + n, last * seg + j);
  }
  return finish(pos, idx);
}

/** Сетка по строкам сверху вниз; столбцы — обход вокруг Y. wrap замыкает кольцо, pole закрывает макушку. */
function surf(
  rows: number,
  cols: number,
  f: (v: number, u: number, out: THREE.Vector3) => void,
  wrap: boolean,
  pole?: THREE.Vector3,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = wrap ? cols : cols + 1;
  const tmp = new THREE.Vector3();
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j < n; j++) {
      f(i / rows, j / cols, tmp);
      pos.push(tmp.x, tmp.y, tmp.z);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * n + j;
      const b = i * n + (wrap ? (j + 1) % n : j + 1);
      idx.push(a, b, a + n, b, b + n, a + n);
    }
  }
  if (pole) {
    const vp = pos.length / 3;
    pos.push(pole.x, pole.y, pole.z);
    for (let j = 0; j < cols; j++) idx.push(vp, wrap ? (j + 1) % n : j + 1, j);
  }
  return finish(pos, idx);
}

/** Сегмент конечности единичной длины: профиль радиуса от проксимального (−0.5) к дистальному (+0.5) концу. */
function limb(profile: Pt[], seg = 14): THREE.BufferGeometry {
  const pts = new THREE.SplineCurve(profile.map(([y, r]) => new THREE.Vector2(r, y))).getPoints(14);
  return new THREE.LatheGeometry(pts, seg);
}

function tubeLoop(points: THREE.Vector3[], r: number, closed = true) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed), points.length * 2, r, 6, closed);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Оболочка интеграла: купол-эллипсоид сверху, юбка с подбородочной дугой снизу. Центр — центр головы.
const FULL = { af: 0.147, ab: 0.152, c: 0.132, top: 0.15, depth: 0.156 };
function fullShell(theta: number, y: number, off: number, out: THREE.Vector3) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const a = c > 0 ? FULL.af : FULL.ab;
  let r = 1 / Math.sqrt((c / a) ** 2 + (s / FULL.c) ** 2);
  if (y >= 0) {
    r *= Math.sqrt(Math.max(0, 1 - (y / FULL.top) ** 2));
  } else {
    const d = -y / FULL.depth;
    r *= 1 - (c > 0 ? 0.1 : 0.2) * d * d;
    r += 0.02 * smooth(0.12, 0.55, d) * Math.max(0, c) ** 1.5;
  }
  r += off;
  out.set(c * r, y, s * r);
}

// Открытый городской шлем: купол с кромкой, опущенной на затылке.
const OPEN = { af: 0.127, ab: 0.134, c: 0.114, top: 0.14 };
const openEdge = (theta: number) => 0.03 - 0.0425 * (1 - Math.cos(theta)) - 0.012 * Math.sin(theta) ** 2;
function openDir(dx: number, dy: number, dz: number, off: number, out: THREE.Vector3) {
  const a = dx > 0 ? OPEN.af : OPEN.ab;
  const r = 1 / Math.sqrt((dx / a) ** 2 + (dy / OPEN.top) ** 2 + (dz / OPEN.c) ** 2) + off;
  out.set(dx * r, dy * r, dz * r);
}
function openShell(theta: number, v: number, off: number, out: THREE.Vector3) {
  const phi = v * Math.acos(openEdge(theta) / OPEN.top);
  openDir(Math.cos(theta) * Math.sin(phi), Math.cos(phi), Math.sin(theta) * Math.sin(phi), off, out);
}

export interface RiderParams {
  gripL: THREE.Vector3;
  gripR: THREE.Vector3;
  az: number;
  ax: number;
  lean: number;
  leanLat?: number;
  crash: number; // 0..1
  speed: number;
  stuntPitch?: number; // рад, угол станта
}

/** Посадка сидя (питбайк): верх сиденья под тазом и подножки. */
export interface RiderSeat {
  x: number;
  y: number;
  pegX: number;
  pegY: number;
  pegZ: number;
}

export class Rider {
  group = new THREE.Group();
  head = new THREE.Group();
  eye = new THREE.Object3D();
  /** Материалы с отражением окружения (шлем, визор, очки) — их яркость приглушается ночью. */
  envMats: THREE.MeshStandardMaterial[] = [];
  private rz = 0;
  private rv = 0;
  private tilt = 0.25;
  private latShift = 0;
  private stuntBlend = 0;

  private parts: Record<string, THREE.Mesh> = {};
  private shoeL = new THREE.Group();
  private shoeR = new THREE.Group();
  private gloveL = new THREE.Group();
  private gloveR = new THREE.Group();
  private deckTop: number;
  private rearKickX: number;
  private seat: RiderSeat | null;

  // Хранение текущих 17 узлов в локальных и мировых координатах для рэгдолла и повтора
  lastLocalPose = new Float32Array(POSE_FLOATS);
  lastWorldPose = new Float32Array(POSE_FLOATS);

  // Временные векторы
  private P = new THREE.Vector3();
  private S = new THREE.Vector3();
  private headPos = new THREE.Vector3();
  private hipL = new THREE.Vector3();
  private hipR = new THREE.Vector3();
  private shL = new THREE.Vector3();
  private shR = new THREE.Vector3();
  private kneeL = new THREE.Vector3();
  private kneeR = new THREE.Vector3();
  private ankL = new THREE.Vector3();
  private ankR = new THREE.Vector3();
  private toeL = new THREE.Vector3();
  private toeR = new THREE.Vector3();
  private elbL = new THREE.Vector3();
  private elbR = new THREE.Vector3();
  private handL = new THREE.Vector3();
  private handR = new THREE.Vector3();
  private endL = new THREE.Vector3();
  private endR = new THREE.Vector3();
  private ikEnd = new THREE.Vector3();
  private neckTop = new THREE.Vector3();
  private tmpT = new THREE.Vector3();
  private poleKL = new THREE.Vector3(1, 0.25, -0.35);
  private poleKR = new THREE.Vector3(1, 0.25, 0.35);
  private poleEL = new THREE.Vector3(-0.3, -0.7, -1);
  private poleER = new THREE.Vector3(-0.3, -0.7, 1);
  private limpL = new THREE.Vector3();
  private limpR = new THREE.Vector3();

  private localPts: THREE.Vector3[] = Array.from({ length: PARTICLE_COUNT }, () => new THREE.Vector3());

  constructor(look: Look, deckTop: number, rearKickX = -0.3, seat: RiderSeat | null = null) {
    this.seat = seat;
    this.deckTop = deckTop;
    this.rearKickX = rearKickX;
    const env = studioEnv();
    const mat = (color: string, roughness: number, metalness = 0, side: THREE.Side = THREE.FrontSide) =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness, side });
    const glossy = (color: string, roughness: number, metalness: number, side: THREE.Side = THREE.FrontSide) => {
      const m = mat(color, roughness, metalness, side);
      m.envMap = env;
      this.envMats.push(m);
      return m;
    };
    const skin = mat(look.skin, 0.62);
    const jacket = mat(look.jacket, 0.82);
    const pants = mat(look.pants, 0.9);
    const glove = mat('#141517', 0.72);
    const shoeM = mat('#26282d', 0.78);
    const sole = mat('#e6e6e3', 0.85);
    const trim = mat('#0b0c0e', 0.8, 0, THREE.DoubleSide);

    const part = (geo: THREE.BufferGeometry, m: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, m);
      this.group.add(mesh);
      return mesh;
    };
    const ball = (r: number, m: THREE.Material) => part(new THREE.SphereGeometry(r, 14, 10), m);
    const P = this.parts;

    // Ноги: бедро сужается к колену, штанина — к щиколотке с манжетой
    const thigh = limb([[-0.5, 0.079], [-0.25, 0.081], [0.1, 0.068], [0.5, 0.056]]);
    const shin = limb([[-0.5, 0.055], [-0.28, 0.059], [0.1, 0.05], [0.4, 0.043], [0.44, 0.047], [0.5, 0.046]]);
    P.thighL = part(thigh, pants);
    P.thighR = part(thigh.clone(), pants);
    P.shinL = part(shin, pants);
    P.shinR = part(shin.clone(), pants);
    P.kneeL = ball(0.058, pants);
    P.kneeR = ball(0.058, pants);
    P.hipSL = ball(0.08, pants);
    P.hipSR = ball(0.08, pants);
    P.pelvis = part(
      loft([
        { y: -0.15, rx: 0.045, rz: 0.07 },
        { y: -0.115, rx: 0.088, rz: 0.135 },
        { y: -0.06, rx: 0.106, rz: 0.162 },
        { y: 0.02, rx: 0.106, rz: 0.158 },
        { y: 0.1, rx: 0.098, rz: 0.146 },
      ]),
      pants,
    );

    // Торс: куртка с подолом, грудной клеткой, скатом плеч и воротником (единичная высота таз → основание шеи)
    P.torso = part(
      loft([
        { y: -0.61, rx: 0.104, rz: 0.16 },
        { y: -0.59, rx: 0.111, rz: 0.167 },
        { y: -0.46, rx: 0.109, rz: 0.163 },
        { y: -0.22, rx: 0.1, rz: 0.15, x: 0.004 },
        { y: 0.08, rx: 0.113, rz: 0.168, x: 0.012 },
        { y: 0.3, rx: 0.113, rz: 0.186, x: 0.012 },
        { y: 0.42, rx: 0.096, rz: 0.192, x: 0.006 },
        { y: 0.49, rx: 0.082, rz: 0.156 },
        { y: 0.54, rx: 0.068, rz: 0.088 },
        { y: 0.6, rx: 0.063, rz: 0.066 },
        { y: 0.67, rx: 0.062, rz: 0.064 },
        { y: 0.67, rx: 0.052, rz: 0.054 },
      ]),
      jacket,
    );
    // Молния куртки по передней линии торса
    const zip: Pt[] = [[-0.59, 0.113], [-0.46, 0.111], [-0.22, 0.106], [0.08, 0.127], [0.3, 0.127], [0.42, 0.104], [0.49, 0.084], [0.54, 0.07], [0.6, 0.065], [0.66, 0.064]];
    P.torso.add(
      new THREE.Mesh(
        surf(zip.length - 1, 1, (vv, u, out) => {
          const q = zip[Math.round(vv * (zip.length - 1))];
          out.set(q[1] + 0.0015, q[0], (u - 0.5) * 0.012);
        }, false),
        trim,
      ),
    );
    P.shoulderL = ball(0.064, jacket);
    P.shoulderR = ball(0.064, jacket);
    const uarm = limb([[-0.5, 0.061], [-0.2, 0.059], [0.5, 0.049]], 12);
    const farm = limb([[-0.5, 0.049], [-0.25, 0.05], [0.3, 0.04], [0.36, 0.043], [0.5, 0.042]], 12);
    P.uarmL = part(uarm, jacket);
    P.uarmR = part(uarm.clone(), jacket);
    P.farmL = part(farm, jacket);
    P.farmR = part(farm.clone(), jacket);
    P.elbL = ball(0.05, jacket);
    P.elbR = ball(0.05, jacket);
    P.neck = part(new THREE.CylinderGeometry(0.049, 0.055, 1, 14), skin);

    // Перчатки: ось Y — вдоль предплечья, X — к ладони, Z — поперёк кисти
    for (const [g, side] of [
      [this.gloveL, -1],
      [this.gloveR, 1],
    ] as [THREE.Group, number][]) {
      const back = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), glove);
      back.scale.set(0.6, 1.15, 1.12);
      back.position.set(-0.02, -0.012, 0);
      const knuckles = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.05, 4, 10).rotateX(Math.PI / 2), glove);
      knuckles.position.set(-0.002, 0.03, 0);
      const fingers = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.052, 4, 10).rotateX(Math.PI / 2), glove);
      fingers.position.set(0.026, 0.016, 0);
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.013, 0.034, 4, 8), glove);
      thumb.position.set(0.018, -0.006, -side * 0.044);
      thumb.rotation.z = -0.9;
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.043, 0.04, 12), glove);
      cuff.position.set(0, -0.07, 0);
      g.add(back, knuckles, fingers, thumb, cuff);
      bake(g, new Set());
      this.group.add(g);
    }

    // Кроссовки: профиль верха и подошвы, выдавленный по ширине стопы (X — к носку)
    for (const sh of [this.shoeL, this.shoeR]) {
      const upper: Pt[] = [
        [-0.078, -0.03],
        [0.142, -0.03],
        [0.158, -0.014],
        [0.134, 0.014],
        [0.06, 0.036],
        [0.022, 0.066],
        [-0.062, 0.072],
        [-0.086, 0.02],
      ];
      const a = new THREE.Mesh(plate(upper, 0.09, 0.016, 0.014), shoeM);
      const b = new THREE.Mesh(
        plate(
          [
            [-0.086, -0.05],
            [0.146, -0.05],
            [0.164, -0.034],
            [0.16, -0.026],
            [-0.088, -0.026],
          ],
          0.096,
          0.006,
          0.004,
        ),
        sole,
      );
      const laces = new THREE.Mesh(rbox(0.07, 0.006, 0.04, 0.003, 'z', 0.002), sole);
      laces.position.set(0.058, 0.04, 0);
      laces.rotation.z = -0.42;
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 6, 14).rotateX(Math.PI / 2), trim);
      collar.scale.set(1.15, 1, 0.95);
      collar.position.set(-0.02, 0.07, 0);
      sh.add(a, b, laces, collar);
      bake(sh, new Set());
      this.group.add(sh);
    }

    this.buildHead(look, skin, trim, glossy);
    this.eye.position.set(0.075, 0.025, 0);
    this.head.add(this.eye);
    this.group.add(this.head);

    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }

  private buildHead(
    look: Look,
    skin: THREE.Material,
    trim: THREE.Material,
    glossy: (color: string, roughness: number, metalness: number, side?: THREE.Side) => THREE.MeshStandardMaterial,
  ) {
    const H = this.head;
    const put = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      H.add(mesh);
      return mesh;
    };
    const strap = (a: THREE.Vector3, b: THREE.Vector3) => {
      const m = put(new THREE.BoxGeometry(0.003, 1, 0.014), trim);
      place(m, a, b);
    };
    const v = new THREE.Vector3();

    // Голова: единая лепная поверхность — свод черепа, скулы, челюсть, подбородок
    const HEAD_RINGS: Ring[] = [
      { y: -0.128, rx: 0.03, rz: 0.026, x: 0.03 },
      { y: -0.116, rx: 0.05, rz: 0.04, x: 0.022 },
      { y: -0.094, rx: 0.07, rz: 0.056, x: 0.012 },
      { y: -0.064, rx: 0.085, rz: 0.067, x: 0.004 },
      { y: -0.03, rx: 0.094, rz: 0.075, x: -0.002 },
      { y: 0.01, rx: 0.099, rz: 0.078, x: -0.005 },
      { y: 0.05, rx: 0.098, rz: 0.077, x: -0.008 },
      { y: 0.085, rx: 0.086, rz: 0.068, x: -0.01 },
      { y: 0.108, rx: 0.062, rz: 0.05, x: -0.012 },
      { y: 0.121, rx: 0.03, rz: 0.025, x: -0.012 },
    ];
    put(loft(HEAD_RINGS, 20, 2.2), skin);
    if (look.helmet !== 'full') {
      // Нос, уши, спортивные очки
      const nose = put(new THREE.ConeGeometry(0.014, 0.04, 8), skin, 0.096, -0.02, 0);
      nose.scale.set(1.2, 1, 0.9);
      nose.rotation.z = -0.5;
      const lensM = glossy('#0a0c10', 0.08, 0.9, THREE.DoubleSide);
      put(
        surf(
          3,
          14,
          (vv, u, out) => {
            const t = (u * 2 - 1) * (1.12 - 0.12 * vv);
            const dip = 0.008 * Math.cos(t * 2.6) ** 8;
            out.set(-0.004 + Math.cos(t) * 0.105, 0.034 - vv * (0.036 - dip), Math.sin(t) * 0.0835);
          },
          false,
        ),
        lensM,
      );
      for (const sd of [-1, 1]) {
        put(new THREE.SphereGeometry(0.022, 10, 8), skin, -0.014, -0.006, sd * 0.076).scale.set(0.55, 1, 0.4);
        strap(new THREE.Vector3(0.04, 0.026, sd * 0.076), new THREE.Vector3(-0.02, 0.02, sd * 0.081));
      }
    }

    if (look.helmet === 'none') {
      const hairM = new THREE.MeshStandardMaterial({ color: '#2b211a', roughness: 1 });
      // Волосы: шапка по своду черепа с линией роста надо лбом и опущенным затылком
      put(
        surf(
          9,
          24,
          (vv, u, out) => {
            const t = u * Math.PI * 2;
            const c = Math.cos(t);
            const low = 0.07 - 0.13 * (1 - c) * 0.5 - 0.03 * Math.sin(t) ** 2;
            const y = 0.13 - (0.13 - low) * (0.08 + 0.92 * vv);
            const k = Math.sqrt(Math.max(0, 1 - ((y - 0.005) / 0.127) ** 2));
            out.set(-0.01 + c * (c > 0 ? 0.108 : 0.115) * k, y + 0.004, Math.sin(t) * 0.09 * k);
          },
          true,
          new THREE.Vector3(-0.012, 0.136, 0),
        ),
        hairM,
      );
    } else if (look.helmet === 'full') {
      const shell = glossy(look.helmetColor, 0.22, 0.15);
      const visorM = glossy('#07090d', 0.06, 0.95);
      // Строки: купол по широте, затем юбка до нижней кромки и подвёрнутый внутрь край
      const ys: number[] = [];
      for (let i = 1; i <= 12; i++) ys.push(FULL.top * Math.cos((i / 12) * Math.PI * 0.5));
      for (let i = 1; i <= 9; i++) ys.push(-FULL.depth * (i / 9));
      put(
        surf(
          ys.length,
          40,
          (vv, u, out) => {
            const i = Math.min(ys.length - 1, Math.round(vv * ys.length));
            if (vv >= 1) fullShell(u * Math.PI * 2, -FULL.depth + 0.004, -0.014, out);
            else fullShell(u * Math.PI * 2, ys[i], 0, out);
          },
          true,
          new THREE.Vector3(0, FULL.top, 0),
        ),
        shell,
      );
      const patch = (t0: number, t1: number, y0: number, y1: number, off: number, m: THREE.Material, round = 0) => {
        const ym = (y0 + y1) / 2;
        const tm = (t0 + t1) / 2;
        return put(
          surf(
            8,
            Math.max(4, Math.round((t1 - t0) * 14)),
            (vv, u, out) => {
              const y = y1 + (y0 - y1) * vv;
              const half = (t1 - t0) / 2 - round * Math.abs((y - ym) / ((y1 - y0) / 2)) ** 3;
              fullShell(tm + (u * 2 - 1) * half, y, off, out);
            },
            false,
          ),
          m,
        );
      };
      // Проём с уплотнителем и тонированный визор
      patch(-1.16, 1.16, -0.07, 0.058, 0.0012, trim, 0.3);
      patch(-1.1, 1.1, -0.062, 0.05, 0.0034, visorM, 0.3);
      for (const s of [-1, 1]) {
        fullShell(s * 1.2, -0.006, 0.002, v);
        put(cylZ(0.017, 0.008, 14), trim, v.x, v.y, v.z);
        // Вентиляция: подбородок, лоб, затылок
        patch(s * 0.27 - 0.15, s * 0.27 + 0.15, -0.122, -0.1, 0.0015, trim, 0.05);
        patch(s * 0.2 - 0.1, s * 0.2 + 0.1, 0.082, 0.094, 0.0015, trim, 0.03);
        patch(Math.PI + s * 0.3 - 0.13, Math.PI + s * 0.3 + 0.13, 0.03, 0.044, 0.0015, trim, 0.03);
      }
      // Окантовка нижней кромки и шейный валик
      const rim: THREE.Vector3[] = [];
      for (let i = 0; i < 28; i++) {
        fullShell((i / 28) * Math.PI * 2, -FULL.depth, -0.003, v);
        rim.push(v.clone());
      }
      put(tubeLoop(rim, 0.006), trim);
      put(
        surf(
          1,
          28,
          (vv, u, out) => {
            if (vv < 0.5) fullShell(u * Math.PI * 2, -FULL.depth + 0.004, -0.01, out);
            else out.set(0.004 + Math.cos(u * Math.PI * 2) * 0.062, -FULL.depth + 0.012, Math.sin(u * Math.PI * 2) * 0.06);
          },
          true,
        ),
        trim,
      );
    } else {
      const shell = glossy(look.helmetColor, 0.3, 0.1);
      const cy = 0.01;
      put(surf(12, 36, (vv, u, out) => openShell(u * Math.PI * 2, 0.06 + vv * 0.94, 0, out), true, new THREE.Vector3(0, OPEN.top, 0)), shell, 0, cy, 0);
      // Торец скорлупы с пенным вкладышем
      put(
        surf(
          1,
          36,
          (vv, u, out) => {
            openShell(u * Math.PI * 2, 1, 0, out);
            if (vv > 0.5) out.set(out.x * 0.86, out.y + 0.004, out.z * 0.86);
          },
          true,
        ),
        trim,
        0,
        cy,
        0,
      );
      const edge: THREE.Vector3[] = [];
      for (let i = 0; i < 28; i++) {
        openShell((i / 28) * Math.PI * 2, 1, 0.001, v);
        edge.push(v.clone());
      }
      put(tubeLoop(edge, 0.0045), trim, 0, cy, 0);
      // Продольные вентиляционные прорези
      const slot = (a0: number, a1: number, beta: number) =>
        put(
          surf(
            6,
            3,
            (vv, u, out) => {
              const al = a0 + (a1 - a0) * vv;
              const be = beta + (u - 0.5) * 0.11 * (1 - (2 * vv - 1) ** 4);
              openDir(Math.sin(al) * Math.cos(be), Math.cos(al) * Math.cos(be), Math.sin(be), 0.0015, out);
            },
            false,
          ),
          trim,
          0,
          cy,
          0,
        );
      for (const be of [-0.62, -0.31, 0, 0.31, 0.62]) {
        const k = 1 - Math.abs(be) * 0.35;
        slot(0.22, 0.22 + 0.55 * k, be);
        slot(-0.2 - 0.55 * k, -0.2, be);
      }
      // Козырёк
      const brim = put(rbox(0.06, 0.007, 0.15, 0.028, 'y', 0.002), shell, 0.142, cy + 0.034, 0);
      brim.rotation.z = -0.22;
      // Регулятор размера и ремешки с пряжкой
      put(cylZ(0.014, 0.01, 12).rotateY(Math.PI / 2), trim, -0.124, -0.05, 0);
      const chin = new THREE.Vector3(0.03, -0.128, 0);
      for (const s of [-1, 1]) {
        const under = new THREE.Vector3(0.026, -0.112, s * 0.058);
        openShell(s * 1.0, 1, -0.004, v);
        strap(new THREE.Vector3(v.x, v.y + cy, v.z), under);
        openShell(s * 2.1, 1, -0.004, v);
        strap(new THREE.Vector3(v.x, v.y + cy, v.z), under);
        strap(under, chin);
      }
      put(new THREE.BoxGeometry(0.012, 0.01, 0.026), trim, chin.x, chin.y, 0);
    }
    bake(H, new Set());
  }

  setFirstPerson(fp: boolean) {
    this.head.visible = !fp;
    this.parts.neck.visible = !fp;
  }

  private setLocalJoint(idx: number, v: THREE.Vector3) {
    const i = idx * 3;
    this.lastLocalPose[i] = v.x;
    this.lastLocalPose[i + 1] = v.y;
    this.lastLocalPose[i + 2] = v.z;
  }

  captureWorldPose(frameObj: THREE.Object3D, out = this.lastWorldPose): Float32Array {
    const m = frameObj.matrixWorld;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3;
      this.tmpT.set(this.lastLocalPose[idx], this.lastLocalPose[idx + 1], this.lastLocalPose[idx + 2]);
      this.tmpT.applyMatrix4(m);
      out[idx] = this.tmpT.x;
      out[idx + 1] = this.tmpT.y;
      out[idx + 2] = this.tmpT.z;
    }
    return out;
  }

  /** Тело по 17 узлам: общая часть для езды, рэгдолла и повтора. */
  private poseBody(
    pelvis: THREE.Vector3,
    chest: THREE.Vector3,
    hipL: THREE.Vector3,
    hipR: THREE.Vector3,
    shL: THREE.Vector3,
    shR: THREE.Vector3,
    kneeL: THREE.Vector3,
    kneeR: THREE.Vector3,
    ankL: THREE.Vector3,
    ankR: THREE.Vector3,
    elbL: THREE.Vector3,
    elbR: THREE.Vector3,
    handL: THREE.Vector3,
    handR: THREE.Vector3,
  ) {
    const P = this.parts;
    place(P.thighL, hipL, kneeL);
    place(P.thighR, hipR, kneeR);
    place(P.shinL, kneeL, ankL);
    place(P.shinR, kneeR, ankR);
    P.kneeL.position.copy(kneeL);
    P.kneeR.position.copy(kneeR);
    P.hipSL.position.copy(hipL);
    P.hipSR.position.copy(hipR);

    P.pelvis.position.copy(pelvis);
    _d.subVectors(chest, pelvis);
    _p.subVectors(hipR, hipL);
    orientBasis(P.pelvis, _d, _p);

    P.torso.position.copy(pelvis).add(chest).multiplyScalar(0.5);
    const torsoLen = Math.max(0.05, _d.length());
    _p.subVectors(shR, shL);
    orientBasis(P.torso, _d, _p);
    P.torso.scale.set(1, torsoLen, 1);
    P.shoulderL.position.copy(shL);
    P.shoulderR.position.copy(shR);

    place(P.uarmL, shL, elbL);
    place(P.uarmR, shR, elbR);
    place(P.farmL, elbL, handL);
    place(P.farmR, elbR, handR);
    P.elbL.position.copy(elbL);
    P.elbR.position.copy(elbR);
    this.gloveL.position.copy(handL);
    this.gloveR.position.copy(handR);
    _p.subVectors(shR, shL);
    orientBasis(this.gloveL, _d.subVectors(handL, elbL), _p);
    orientBasis(this.gloveR, _d.subVectors(handR, elbR), _p);
  }

  applyWorldPose(worldPose: Float32Array, frameObj: THREE.Object3D) {
    _invM4.copy(frameObj.matrixWorld).invert();
    const pts = this.localPts;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3;
      pts[i].set(worldPose[idx], worldPose[idx + 1], worldPose[idx + 2]).applyMatrix4(_invM4);
      this.lastLocalPose[idx] = pts[i].x;
      this.lastLocalPose[idx + 1] = pts[i].y;
      this.lastLocalPose[idx + 2] = pts[i].z;
      this.lastWorldPose[idx] = worldPose[idx];
      this.lastWorldPose[idx + 1] = worldPose[idx + 1];
      this.lastWorldPose[idx + 2] = worldPose[idx + 2];
    }

    const chest = pts[P_CHEST];
    const head = pts[P_HEAD];
    const shL = pts[P_SH_L];
    const shR = pts[P_SH_R];
    this.poseBody(
      pts[P_PELVIS],
      chest,
      pts[P_HIP_L],
      pts[P_HIP_R],
      shL,
      shR,
      pts[P_KNEE_L],
      pts[P_KNEE_R],
      pts[P_ANK_L],
      pts[P_ANK_R],
      pts[P_ELB_L],
      pts[P_ELB_R],
      pts[P_HAND_L],
      pts[P_HAND_R],
    );

    // Шея и 3D-голова
    this.neckTop.lerpVectors(chest, head, 0.48);
    place(this.parts.neck, chest, this.neckTop);
    this.head.position.copy(head);
    _d.subVectors(head, chest);
    _p.subVectors(shR, shL);
    orientBasis(this.head, _d, _p);

    // Кроссовки (ориентируются вдоль стопы ank -> toe и голени ank -> knee)
    const placeShoe = (shoe: THREE.Group, ank: THREE.Vector3, toe: THREE.Vector3, knee: THREE.Vector3) => {
      _x.subVectors(toe, ank);
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
      else _x.normalize();

      _y.subVectors(knee, ank);
      _y.addScaledVector(_x, -_y.dot(_x));
      if (_y.lengthSq() < 1e-6) _y.set(0, 1, 0);
      else _y.normalize();

      _z.crossVectors(_x, _y).normalize();
      _y.crossVectors(_z, _x).normalize();

      _m4.makeBasis(_x, _y, _z);
      shoe.quaternion.setFromRotationMatrix(_m4);
      shoe.position.copy(ank).addScaledVector(_y, -0.035);
    };
    placeShoe(this.shoeL, pts[P_ANK_L], pts[P_TOE_L], pts[P_KNEE_L]);
    placeShoe(this.shoeR, pts[P_ANK_R], pts[P_TOE_R], pts[P_KNEE_R]);
  }

  update(dt: number, p: RiderParams) {
    // Пружинная модель ног (биомеханическая амортизация райдера на кочках и приземлениях)
    const k = 185;
    const c = 14.5;
    this.rv += (-k * this.rz - c * this.rv - p.az) * dt;
    this.rz += this.rv * dt;
    this.rz = Math.max(-0.085, Math.min(0.06, this.rz));

    const stuntPitch = Math.max(0, p.stuntPitch ?? 0);
    const stuntTarget = Math.min(1, Math.max(stuntPitch / 0.42, p.lean < -0.25 ? (-p.lean - 0.25) * 0.9 : 0));
    this.stuntBlend += (stuntTarget - this.stuntBlend) * Math.min(1, dt * 8 + 0.05);
    const sb = this.stuntBlend;

    // Реакция корпуса на продольное ускорение (при разгоне подаётся вперёд, при торможении упирается и оттягивает таз назад)
    const lonG = Math.max(-9, Math.min(9, p.ax));
    const seat = this.seat;
    const tiltT = (seat ? 0.34 : 0.24) + 0.16 * p.lean + 0.38 * stuntPitch + 0.014 * lonG;
    this.tilt += (tiltT - this.tilt) * Math.min(1, dt * 7 + 0.05);

    // Боковое смещение таза и плеч внутрь поворота (leanLat: -1 влево, +1 вправо)
    const latT = Math.max(-1, Math.min(1, p.leanLat ?? 0));
    this.latShift += (latT - this.latShift) * Math.min(1, dt * 8 + 0.05);
    const ls = this.latShift;

    const e = p.crash;
    const tau = this.tilt + 1.15 * e;

    const px = (seat ? seat.x : -0.22) + (seat ? 0.04 : 0.065) * p.lean + 0.004 * lonG - 0.045 * sb + 0.8 * e;
    const py =
      (seat ? seat.y + 0.095 + this.rz * 0.3 + 0.05 * sb + 0.12 * e : 0.89 + this.rz) -
      0.035 * sb -
      0.5 * e -
      0.02 * Math.max(0, p.lean) -
      0.018 * Math.abs(ls);
    const pz = ls * 0.042;
    this.P.set(px, py, pz);

    const torsoLen = 0.5;
    const sz = ls * 0.095;
    this.S.set(px + Math.sin(tau) * torsoLen, py + Math.cos(tau) * torsoLen, sz);

    const hipRoll = -ls * 0.015;
    this.hipL.set(px, py - 0.02 - hipRoll, pz - 0.085);
    this.hipR.set(px, py - 0.02 + hipRoll, pz + 0.085);

    const shRoll = -ls * 0.028;
    this.shL.set(this.S.x - 0.01, this.S.y - 0.03 - shRoll, sz - 0.185);
    this.shR.set(this.S.x - 0.01, this.S.y - 0.03 + shRoll, sz + 0.185);

    const dk = this.deckTop + 0.089;
    this.ankL.set(0.055 - 0.02 * sb, dk, -0.04);
    const rFootX = -0.2 + (this.rearKickX - -0.2) * (0.35 + 0.65 * sb);
    const rFootY = dk + 0.014 + 0.028 * sb;
    this.ankR.set(rFootX, rFootY, 0.04);
    if (seat) {
      this.ankL.set(seat.pegX - 0.03, seat.pegY + 0.089, -seat.pegZ);
      this.ankR.set(seat.pegX - 0.03, seat.pegY + 0.089, seat.pegZ);
    }

    // Ноги (в повороте внутреннее колено чуть отводится в сторону поворота)
    this.poleKL.set(1, seat ? 0.8 : 0.25, (seat ? -0.22 : -0.35) + ls * 0.14);
    this.poleKR.set(1, seat ? 0.8 : 0.25, (seat ? 0.22 : 0.35) + ls * 0.14);
    ik(this.hipL, this.ankL, 0.42, 0.41, this.poleKL, this.kneeL, this.ikEnd);
    ik(this.hipR, this.ankR, 0.42, 0.41, this.poleKR, this.kneeR, this.ikEnd);

    this.shoeL.position.set(this.ankL.x, this.ankL.y - 0.035, this.ankL.z);
    this.shoeR.position.set(this.ankR.x, this.ankR.y - 0.035, this.ankR.z);
    this.shoeL.rotation.set(0, 0.14, 0);
    const rPitch = seat ? 0 : -0.16 - 0.28 * sb;
    this.shoeR.rotation.set(0, -0.14, rPitch);

    this.toeL.set(this.ankL.x + 0.158, this.ankL.y - 0.01, this.ankL.z - 0.022);
    this.toeR.set(
      this.ankR.x + Math.cos(rPitch) * 0.158,
      this.ankR.y + Math.sin(rPitch) * 0.158,
      this.ankR.z + 0.022,
    );

    // Руки
    let gl = p.gripL;
    let gr = p.gripR;
    if (e > 0) {
      this.limpL.set(this.shL.x + 0.25, this.shL.y - 0.4, this.shL.z - 0.18);
      this.limpR.set(this.shR.x + 0.25, this.shR.y - 0.4, this.shR.z + 0.18);
      this.handL.lerpVectors(gl, this.limpL, Math.min(1, e * 1.5));
      this.handR.lerpVectors(gr, this.limpR, Math.min(1, e * 1.5));
      gl = this.handL;
      gr = this.handR;
    }
    const endL = this.endL;
    const endR = this.endR;
    ik(this.shL, gl, 0.35, 0.34, this.poleEL, this.elbL, endL);
    ik(this.shR, gr, 0.35, 0.34, this.poleER, this.elbR, endR);
    this.poseBody(
      this.P,
      this.S,
      this.hipL,
      this.hipR,
      this.shL,
      this.shR,
      this.kneeL,
      this.kneeR,
      this.ankL,
      this.ankR,
      this.elbL,
      this.elbR,
      endL,
      endR,
    );

    // Шея и голова (взгляд слегка поворачивается внутрь виража)
    this.neckTop.set(
      this.S.x + Math.sin(tau * 0.6) * 0.1 + 0.02,
      this.S.y + Math.cos(tau * 0.6) * 0.1 + 0.02,
      sz * 1.08,
    );
    place(this.parts.neck, this.S, this.neckTop);
    this.headPos.set(this.neckTop.x + 0.025, this.neckTop.y + 0.1, sz * 1.14);
    this.head.position.copy(this.headPos);
    this.head.rotation.set(
      ls * 0.08,
      -ls * 0.18,
      -0.15 * tau + 0.55 * stuntPitch + 0.05 - (e > 0 ? 0.5 * e : 0),
    );

    // Записываем локальную позу всех 17 узлов
    this.setLocalJoint(P_PELVIS, this.P);
    this.setLocalJoint(P_CHEST, this.S);
    this.setLocalJoint(P_HEAD, this.headPos);
    this.setLocalJoint(P_HIP_L, this.hipL);
    this.setLocalJoint(P_HIP_R, this.hipR);
    this.setLocalJoint(P_SH_L, this.shL);
    this.setLocalJoint(P_SH_R, this.shR);
    this.setLocalJoint(P_KNEE_L, this.kneeL);
    this.setLocalJoint(P_KNEE_R, this.kneeR);
    this.setLocalJoint(P_ANK_L, this.ankL);
    this.setLocalJoint(P_ANK_R, this.ankR);
    this.setLocalJoint(P_TOE_L, this.toeL);
    this.setLocalJoint(P_TOE_R, this.toeR);
    this.setLocalJoint(P_ELB_L, this.elbL);
    this.setLocalJoint(P_ELB_R, this.elbR);
    this.setLocalJoint(P_HAND_L, endL);
    this.setLocalJoint(P_HAND_R, endR);
  }

  /** Пружина ног и сглаженные наклоны не должны переживать респаун. */
  resetPose() {
    this.rz = 0;
    this.rv = 0;
    this.tilt = 0.25;
    this.latShift = 0;
    this.stuntBlend = 0;
  }

  private xrayMats: Map<THREE.Mesh, THREE.Material | THREE.Material[]> | null = null;

  /** Рентген-режим повтора: тело становится полупрозрачным силуэтом; null возвращает обычный вид. */
  setXray(ghost: THREE.Material | null) {
    if (!!ghost === !!this.xrayMats) return;
    if (ghost) {
      const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
      this.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        saved.set(m, m.material);
        m.material = ghost;
        m.renderOrder = 910;
        m.castShadow = false;
      });
      this.xrayMats = saved;
    } else {
      for (const [m, mat] of this.xrayMats!) {
        m.material = mat;
        m.renderOrder = 0;
        m.castShadow = true;
      }
      this.xrayMats = null;
    }
  }

  dispose() {
    this.setXray(null);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
