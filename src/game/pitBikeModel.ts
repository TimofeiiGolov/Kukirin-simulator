import * as THREE from 'three';
import { MODELS, type Look, type ModeId, type Tune } from './data';
import { bake, cylZ, lathe, outline, plate, rbox, studioEnv, type Pt } from './geo';
import { FACTORY, PITBIKE } from './pitBikeSpec';
import { Rider } from './rider';
import type { ScooterRig, VisualState } from './scooterModel';
import { glowTexture } from './textures';

// KuKirin X1. Модель строится в заводских размерах (м) в осях рамы: x — вперёд, y — вверх,
// z — вправо, земля в покое на y = 0; группа art целиком масштабируется на PITBIKE.scale.
const S = PITBIKE.scale;
const RAKE = PITBIKE.rake;
const COS_R = Math.cos(RAKE);
const SIN_R = Math.sin(RAKE);
const RF = FACTORY.rFront;
const RR = FACTORY.rRear;
const AX_F = FACTORY.axleFront;
const AX_R = AX_F - FACTORY.wheelbase;
const FORK_OFF = 0.03; // вынос перьев вперёд от оси рулевой колонки
const FORK_LEN = 0.6; // от оси колеса до центра рулевой колонки вдоль вилки
const FORK_Z = 0.08;
const HD = {
  x: AX_F - FORK_OFF * COS_R - FORK_LEN * SIN_R,
  y: RF - FORK_OFF * SIN_R + FORK_LEN * COS_R,
};
const PIV = { x: -0.13, y: 0.31 }; // ось маятника
const MOTOR = { x: -0.02, y: 0.3 }; // центральный мотор, ведущая звезда соосна
const ARM_L = Math.hypot(AX_R - PIV.x, RR - PIV.y);
const ARM_Z = 0.078;
const CHAIN_Z = -0.057; // цепь слева
const SPR_F = 0.026;
const SPR_R = 0.088;
const COIL_H = 0.2; // длина пружины без нагрузки: виток не сплющивается при масштабировании
const SHOCK_TOP = { x: -0.215, y: 0.6 };
const SHOCK_BOT = { x: -0.135, y: 0.05 }; // в осях маятника
const SEAT = { x: -0.15, y: FACTORY.seatHeight };
const PEG = { x: -0.095, y: 0.262, z: 0.14 };
const HALF_BAR = FACTORY.barWidth / 2;
const BAR = { x: -0.03, y: 0.235 }; // концы руля в осях рулевой колонки

type Mats = Record<string, THREE.MeshStandardMaterial>;
type P2 = { x: number; y: number };

// ------------------------------------------------------------------
// Геометрические помощники
// ------------------------------------------------------------------
class Helix extends THREE.Curve<THREE.Vector3> {
  constructor(private r: number, private turns: number, private h = 1) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.r, t * this.h, Math.sin(a) * this.r);
  }
}

function add(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function tube(pts: [number, number, number][], r: number, mat: THREE.Material, parent: THREE.Object3D, seg = 7, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.35);
  return add(new THREE.TubeGeometry(curve, pts.length * seg, r, radial), mat, parent);
}

const _up = new THREE.Vector3(0, 1, 0);
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent: THREE.Object3D, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg, 1, true), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(_up, d.normalize());
  parent.add(m);
  return m;
}

/** Ставит объект с единичной длиной вдоль +Y между двумя точками плоскости XY. */
function span(o: THREE.Object3D, p1: P2, p2: P2, z: number, stretch: THREE.Object3D | null = o) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  o.position.set(p1.x, p1.y, z);
  o.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
  if (stretch) stretch.scale.y = Math.max(0.02, Math.hypot(dx, dy));
}

/** Зеркальная копия геометрии относительно плоскости XY (с перестановкой обхода). */
function mirrorZ(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  g.scale(1, 1, -1);
  for (const key of Object.keys(g.attributes)) {
    const at = g.attributes[key] as THREE.BufferAttribute;
    const n = at.itemSize;
    const arr = at.array as Float32Array;
    for (let i = 0; i < at.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const a = (i + 1) * n + k;
        const b = (i + 2) * n + k;
        const t = arr[a];
        arr[a] = arr[b];
        arr[b] = t;
      }
    }
  }
  return g;
}

/** Сплайн Катмулла — Рома по строкам чисел: сглаживает таблицу сечений. */
function smooth(rows: number[][], n: number): number[][] {
  const out: number[][] = [];
  const m = rows.length - 1;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * m;
    const k = Math.min(m - 1, Math.floor(t));
    const f = t - k;
    const p0 = rows[Math.max(0, k - 1)];
    const p1 = rows[k];
    const p2 = rows[k + 1];
    const p3 = rows[Math.min(m, k + 2)];
    out.push(
      p1.map(
        (_, j) =>
          0.5 *
          (2 * p1[j] +
            (-p0[j] + p2[j]) * f +
            (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * f * f +
            (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * f * f * f),
      ),
    );
  }
  return out;
}

/** Поверхность по сечениям: closed — замкнутые кольца, caps — торцы; нормаль = (вдоль) × (по кольцу). */
function loft(secs: THREE.Vector3[][], closed = false, caps = false, flip = false): THREE.BufferGeometry {
  const n = secs.length;
  const m = secs[0].length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const p = secs[i][j];
      pos.push(p.x, p.y, p.z);
      uv.push(i / (n - 1), j / (m - 1));
    }
  }
  const tri = (a: number, b: number, c: number) => (flip ? idx.push(a, c, b) : idx.push(a, b, c));
  const mj = closed ? m : m - 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < mj; j++) {
      const a = i * m + j;
      const b = (i + 1) * m + j;
      const c = (i + 1) * m + ((j + 1) % m);
      const d = i * m + ((j + 1) % m);
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  if (caps) {
    for (const e of [0, n - 1]) {
      const base = pos.length / 3;
      const cen = new THREE.Vector3();
      for (const p of secs[e]) {
        pos.push(p.x, p.y, p.z);
        uv.push(e ? 1 : 0, 0);
        cen.add(p);
      }
      cen.multiplyScalar(1 / m);
      pos.push(cen.x, cen.y, cen.z);
      uv.push(e ? 1 : 0, 0);
      for (let j = 0; j < m; j++) {
        if (e === 0) tri(base + m, base + j, base + ((j + 1) % m));
        else tri(base + m, base + ((j + 1) % m), base + j);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Кольцо сечения со скруглёнными плечами и выпуклым верхом (сиденье, крышка «бака»). */
function roundRing(x: number, yTop: number, yBot: number, hw: number, r: number, crown: number): THREE.Vector3[] {
  const rr = Math.min(r, hw * 0.6, (yTop - yBot) * 0.8);
  const ys = yTop - crown;
  const pts: THREE.Vector3[] = [];
  for (const s of [-1, 1]) {
    const side: THREE.Vector3[] = [new THREE.Vector3(x, yBot, s * (hw + 0.002)), new THREE.Vector3(x, ys - rr, s * hw)];
    for (let k = 1; k <= 3; k++) {
      const a = (k / 3) * (Math.PI / 2);
      side.push(new THREE.Vector3(x, ys - rr + rr * Math.sin(a), s * (hw - rr + rr * Math.cos(a))));
    }
    side.push(new THREE.Vector3(x, ys + crown * 0.7, s * (hw - rr) * 0.5));
    if (s < 0) pts.push(...side, new THREE.Vector3(x, yTop, 0));
    else pts.push(...side.reverse());
  }
  return pts;
}

/** Дуга поперёк крыла: прогиб depth к краям и отогнутая кромка lip. */
function arcRow(x: number, y: number, hw: number, depth: number, lip: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [new THREE.Vector3(x, y - depth - lip, -hw)];
  for (let j = 0; j <= 8; j++) {
    const k = j / 4 - 1;
    pts.push(new THREE.Vector3(x, y - depth * k * k, hw * k));
  }
  pts.push(new THREE.Vector3(x, y - depth - lip, hw));
  return pts;
}

// ------------------------------------------------------------------
// Ливрея: один атлас на все наклейки, координаты рисования — метры детали
// ------------------------------------------------------------------
const ATLAS = 2048;
interface Region {
  px: number;
  py: number;
  pw: number;
  ph: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
}

function uvOf(r: Region, a: number, b: number): [number, number] {
  return [(r.px + ((a - r.x0) / r.w) * r.pw) / ATLAS, 1 - (r.py + (1 - (b - r.y0) / r.h) * r.ph) / ATLAS];
}

/** Переписывает uv геометрии в область атласа; fn возвращает координаты детали. */
function mapUV(
  g: THREE.BufferGeometry,
  r: Region,
  fn: (x: number, y: number, z: number, u: number, v: number) => [number, number] = (x, y) => [x, y],
) {
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const [a, b] = fn(p.getX(i), p.getY(i), p.getZ(i), uv.getX(i), uv.getY(i));
    const [u, v] = uvOf(r, a, b);
    uv.setXY(i, u, v);
  }
  return g;
}

const decal = (pts: Pt[], r: Region, round = 0.004) => mapUV(new THREE.ShapeGeometry(outline(pts, round), 6), r);

function mix(a: string, b: string, k: number) {
  return `#${new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString()}`;
}

/** Параллелограмм: от заднего нижнего угла вдоль rot на len, вверх на h, со сдвигом верха skew. */
function para(x: number, y: number, len: number, h: number, rot: number, skew = 0): Pt[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const at = (a: number, b: number): Pt => [x + a * c - b * s, y + a * s + b * c];
  return [at(0, 0), at(len, 0), at(len + skew, h), at(skew, h)];
}

class Painter {
  k: number;
  constructor(public g: CanvasRenderingContext2D, public r: Region, private flipText = false) {
    this.k = r.pw / r.w;
  }
  X(x: number) {
    return this.r.px + ((x - this.r.x0) / this.r.w) * this.r.pw;
  }
  Y(y: number) {
    return this.r.py + (1 - (y - this.r.y0) / this.r.h) * this.r.ph;
  }
  fill(color: string) {
    this.g.fillStyle = color;
    this.g.fillRect(this.r.px - 6, this.r.py - 6, this.r.pw + 12, this.r.ph + 12);
  }
  poly(pts: Pt[], color: string) {
    const g = this.g;
    g.fillStyle = color;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(this.X(x), this.Y(y)) : g.moveTo(this.X(x), this.Y(y))));
    g.closePath();
    g.fill();
  }
  line(pts: Pt[], color: string, width: number, close = false) {
    const g = this.g;
    g.strokeStyle = color;
    g.lineWidth = width * this.k;
    g.lineJoin = 'miter';
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(this.X(x), this.Y(y)) : g.moveTo(this.X(x), this.Y(y))));
    if (close) g.closePath();
    g.stroke();
  }
  dot(x: number, y: number, r: number, color: string) {
    const g = this.g;
    g.fillStyle = color;
    g.beginPath();
    g.arc(this.X(x), this.Y(y), r * this.k, 0, Math.PI * 2);
    g.fill();
  }
  /** Текст с центром в точке; на зеркальной стороне отражается, чтобы читаться снаружи. */
  text(str: string, x: number, y: number, size: number, color: string, rot = 0, font = 'italic 900', stretch = 1) {
    const g = this.g;
    g.save();
    g.translate(this.X(x), this.Y(y));
    g.rotate(-rot);
    g.scale((this.flipText ? -1 : 1) * stretch, 1);
    g.fillStyle = color;
    g.font = `${font} ${size * this.k}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(str, 0, 0);
    g.restore();
  }
}

// Контуры боковин (вид справа): основная панель, чёрная крышка батареи, серый подъём к хвосту, хвост.
const PANEL: Pt[] = [
  [0.235, 0.762],
  [0.1, 0.712],
  [-0.08, 0.655],
  [-0.22, 0.63],
  [-0.3, 0.64],
  [-0.285, 0.575],
  [-0.2, 0.47],
  [-0.175, 0.335],
  [-0.1, 0.325],
  [-0.075, 0.4],
  [-0.02, 0.418],
  [0.2, 0.468],
  [0.325, 0.525],
  [0.31, 0.6],
  [0.262, 0.7],
];
const INSET: Pt[] = [
  [0.317, 0.533],
  [0.303, 0.612],
  [-0.03, 0.52],
  [-0.062, 0.412],
  [-0.02, 0.426],
  [0.2, 0.476],
];
const KICK: Pt[] = [
  [-0.3, 0.64],
  [-0.285, 0.575],
  [-0.2, 0.47],
  [-0.175, 0.335],
  [-0.1, 0.325],
  [-0.075, 0.4],
  [-0.115, 0.42],
  [-0.175, 0.535],
  [-0.215, 0.632],
];
const TAIL: Pt[] = [
  [-0.3, 0.64],
  [-0.4, 0.692],
  [-0.6, 0.785],
  [-0.745, 0.835],
  [-0.69, 0.776],
  [-0.5, 0.656],
  [-0.38, 0.586],
  [-0.285, 0.575],
];
const PLATE: Pt[] = [
  [-0.05, -0.15],
  [0.05, -0.15],
  [0.09, -0.03],
  [0.104, 0.085],
  [0.074, 0.135],
  [-0.074, 0.135],
  [-0.104, 0.085],
  [-0.09, -0.03],
];
const BEAM: Pt[] = [
  [0.03, 0.03],
  [0.037, 0],
  [0.03, -0.03],
  [-0.12, -0.037],
  [-ARM_L - 0.04, -0.027],
  [-ARM_L - 0.052, 0],
  [-ARM_L - 0.04, 0.027],
  [-0.12, 0.037],
];

interface Livery {
  tex: THREE.CanvasTexture;
  side: [Region, Region];
  tail: [Region, Region];
  arm: [Region, Region];
  plate: Region;
  fender: Region;
  rearF: Region;
  guard: Region;
  pad: Region;
}

function buildLivery(look: Look): Livery {
  const cv = document.createElement('canvas');
  cv.width = ATLAS;
  cv.height = ATLAS;
  const g = cv.getContext('2d')!;
  const silver = look.frame;
  const orange = look.accent;
  const black = '#101113';
  const white = '#f3f4f5';
  const grey = mix(silver, '#000000', 0.52);
  const light = mix(silver, '#ffffff', 0.22);
  g.fillStyle = silver;
  g.fillRect(0, 0, ATLAS, ATLAS);

  // полочная раскладка областей
  let cx = 10;
  let cy = 10;
  let rowH = 0;
  const alloc = (x0: number, y0: number, w: number, h: number, ppm = 1400, pw = Math.round(w * ppm), ph = Math.round(h * ppm)): Region => {
    if (cx + pw + 10 > ATLAS) {
      cx = 10;
      cy += rowH + 16;
      rowH = 0;
    }
    const r = { px: cx, py: cy, pw, ph, x0, y0, w, h };
    cx += pw + 16;
    rowH = Math.max(rowH, ph);
    return r;
  };
  const side: [Region, Region] = [alloc(-0.34, 0.3, 0.68, 0.48), alloc(-0.34, 0.3, 0.68, 0.48)];
  const tail: [Region, Region] = [alloc(-0.78, 0.54, 0.62, 0.32), alloc(-0.78, 0.54, 0.62, 0.32)];
  const plateR = alloc(-0.12, -0.16, 0.24, 0.32);
  const fender = alloc(-0.06, -0.09, 0.48, 0.18);
  const rearF = alloc(-0.8, -0.11, 0.3, 0.22);
  const guard = alloc(0, 0, 1, 1, 0, 110, 392);
  const pad = alloc(0, 0, 1, 1, 0, 400, 164);
  const arm: [Region, Region] = [alloc(-0.47, -0.05, 0.52, 0.1), alloc(-0.47, -0.05, 0.52, 0.1)];

  // --- боковины ---
  side.forEach((r, i) => {
    const p = new Painter(g, r, i === 1);
    p.fill(silver);
    // светлая грань вдоль верхней кромки и тёмный подъём к хвосту
    p.poly([PANEL[0], PANEL[1], PANEL[2], PANEL[3], [-0.22, 0.612], [-0.08, 0.636], [0.1, 0.692], [0.24, 0.742]], light);
    p.poly(KICK, grey);
    p.line([[-0.215, 0.632], [-0.175, 0.535], [-0.115, 0.42], [-0.075, 0.4]], mix(silver, '#000000', 0.55), 0.004);
    p.poly(INSET, black);
    p.line([INSET[1], INSET[2], INSET[3]], mix(silver, '#000000', 0.5), 0.005);
    // вентиляционное окно у рулевой колонки
    p.poly([[0.2, 0.728], [0.252, 0.702], [0.288, 0.632], [0.215, 0.672]], '#1b1c1f');
    // оранжевая плашка KuKirin с шашечками на крышке батареи
    const rot = 0.27;
    p.poly(para(0.098, 0.498, 0.196, 0.046, rot, 0.012), orange);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    p.text('KuKirin', 0.098 + 0.104 * c - 0.023 * s, 0.498 + 0.104 * s + 0.023 * c, 0.037, white, rot);
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 3; b++) {
        if ((a + b) % 2) continue;
        const u = -0.086 + a * 0.0135;
        const v = 0.003 + b * 0.0135;
        p.poly(para(0.098 + u * c - v * s, 0.498 + u * s + v * c, 0.0135, 0.0135, rot), orange);
      }
    }
    p.line([[0.03, 0.461], [0.262, 0.525]], orange, 0.0045);
    p.text('ELECTRIC DIRT BIKE', 0.165, 0.485, 0.0085, white, rot, '700');
    // оранжевые полосы по лонжерону
    p.line([[-0.075, 0.628], [0.2, 0.714]], orange, 0.0055);
    p.line([[-0.04, 0.623], [0.09, 0.664]], mix(silver, '#000000', 0.45), 0.0025);
    // знак «Λ»
    p.line([[0.062, 0.594], [0.098, 0.664], [0.134, 0.616]], '#232528', 0.013);
    // чёрная наклейка KuKirin SPEED / READY TO START
    const dr = 0.24;
    const dc = Math.cos(dr);
    const ds = Math.sin(dr);
    const dx = -0.172;
    const dy = 0.527;
    const at = (a: number, b: number): Pt => [dx + a * dc - b * ds, dy + a * ds + b * dc];
    p.poly(para(dx, dy, 0.168, 0.088, dr, 0.014), black);
    const flip = i === 1;
    // на зеркальной стороне раскладка внутри наклейки отражается вместе с текстом
    const la = (a: number) => (flip ? 0.168 + 0.014 - a : a);
    for (const [a, w] of [[0.012, 0.004], [0.02, 0.0025], [0.026, 0.006], [0.036, 0.002], [0.041, 0.004]]) {
      const a0 = la(a + (flip ? w : 0)) + 0.006;
      p.poly([at(a0, 0.034), at(a0 + w, 0.034), at(a0 + w + 0.006, 0.078), at(a0 + 0.006, 0.078)], white);
    }
    p.text('KuKirin', ...at(la(0.112) + 0.008, 0.062), 0.031, white, dr);
    p.text('SPEED', ...at(la(0.108) + 0.005, 0.036), 0.021, white, dr, 'italic 900', 1.25);
    p.text('READY TO START', ...at(la(0.092) + 0.002, 0.013), 0.0098, white, dr, '700');
    // X1 на сером подъёме у амортизатора
    p.text('X1', -0.235, 0.572, 0.058, white, 0.3);
    // крепёж
    for (const [x, y] of [[0.215, 0.742], [-0.06, 0.648], [-0.2, 0.618], [0.29, 0.552], [-0.045, 0.43], [-0.185, 0.485], [-0.118, 0.352]] as Pt[]) {
      p.dot(x, y, 0.0058, '#1d1f22');
      p.dot(x, y, 0.0026, '#70757c');
    }
  });

  // --- хвостовые панели ---
  tail.forEach((r, i) => {
    const p = new Painter(g, r, i === 1);
    p.fill(silver);
    p.poly([[-0.285, 0.575], [-0.38, 0.586], [-0.5, 0.656], [-0.455, 0.668], [-0.345, 0.615], [-0.3, 0.605]], grey);
    p.poly([[-0.415, 0.7], [-0.6, 0.785], [-0.745, 0.835], [-0.69, 0.776], [-0.56, 0.706], [-0.5, 0.656], [-0.46, 0.676]], black);
    p.poly([[-0.375, 0.679], [-0.56, 0.765], [-0.6, 0.768], [-0.435, 0.691], [-0.4, 0.668]], orange);
    p.poly([[-0.33, 0.656], [-0.375, 0.679], [-0.4, 0.668], [-0.36, 0.648]], white);
    p.line([[-0.5, 0.69], [-0.66, 0.775]], white, 0.003);
    p.text('READY TO START', -0.648, 0.789, 0.0105, white, -0.34, '700');
    for (const [x, y] of [[-0.34, 0.628], [-0.52, 0.71]] as Pt[]) p.dot(x, y, 0.005, '#1d1f22');
  });

  // --- передний номерной щиток ---
  {
    const p = new Painter(g, plateR);
    p.fill(black);
    for (const s of [-1, 1]) {
      const m = (pts: Pt[]) => pts.map(([x, y]): Pt => [x * s, y]);
      p.poly(m([[0.104, 0.085], [0.074, 0.135], [0.036, 0.135], [0.05, 0.06], [0.094, 0.0]]), light);
      p.poly(m([[0.094, 0.0], [0.05, 0.06], [0.058, 0.094], [0.1, 0.05]]), white);
      p.poly(m([[0.09, -0.03], [0.05, -0.15], [0.036, -0.15], [0.074, -0.035], [0.062, 0.04], [0.094, 0.0]]), orange);
      p.poly(m([[0.02, -0.062], [0.05, -0.05], [0.036, -0.1], [0.014, -0.09]]), orange);
      p.line(m([[0.03, 0.128], [0.042, 0.075], [0.03, 0.068]]), orange, 0.004);
    }
    p.poly([[-0.036, 0.129], [0.036, 0.129], [0.026, 0.078], [-0.026, 0.078]], '#050506');
    p.text('X1', 0.004, 0.012, 0.082, white, 0);
    p.text('KuKirin', 0, -0.126, 0.012, white, 0, '700');
  }

  // --- переднее крыло (вид сверху: x вдоль, z поперёк) ---
  {
    const p = new Painter(g, fender);
    p.fill(white);
    p.poly([[-0.06, -0.034], [0.2, -0.03], [0.345, 0], [0.2, 0.03], [-0.06, 0.034]], black);
    for (const s of [-1, 1]) {
      const m = (pts: Pt[]) => pts.map(([x, y]): Pt => [x, y * s]);
      p.poly(m([[0.02, 0.036], [0.21, 0.04], [0.375, 0.002], [0.4, 0.012], [0.22, 0.062], [0.03, 0.052]]), orange);
      p.poly(m([[0.1, 0.068], [0.25, 0.066], [0.33, 0.04], [0.22, 0.09], [0.1, 0.09]]), light);
      p.line(m([[0.02, 0.012], [0.19, 0.012], [0.3, 0.0]]), orange, 0.004);
    }
    p.poly([[0.345, -0.012], [0.42, -0.012], [0.42, 0.012], [0.345, 0.012]], black);
  }

  // --- заднее крыло (вид сверху) ---
  {
    const p = new Painter(g, rearF);
    p.fill(black);
    for (const s of [-1, 1]) {
      const m = (pts: Pt[]) => pts.map(([x, y]): Pt => [x, y * s]);
      p.poly(m([[-0.5, 0.058], [-0.66, 0.05], [-0.755, 0.012], [-0.765, 0.022], [-0.67, 0.066], [-0.5, 0.074]]), orange);
      p.poly(m([[-0.5, 0.082], [-0.68, 0.074], [-0.74, 0.045], [-0.74, 0.11], [-0.5, 0.11]]), light);
    }
    p.poly(para(-0.728, -0.018, 0.1, 0.036, 0), orange);
    p.text('KuKirin', -0.678, 0, 0.021, white, Math.PI);
  }

  // --- защита перьев вилки: u — по дуге, v — вдоль ---
  {
    const p = new Painter(g, guard);
    p.fill(black);
    p.poly([[0.06, 0.16], [0.94, 0.4], [0.94, 0.6], [0.06, 0.36]], orange);
    p.poly([[0.06, 0.42], [0.94, 0.66], [0.94, 0.73], [0.06, 0.49]], orange);
    p.poly([[0.06, 0.55], [0.94, 0.79], [0.94, 0.83], [0.06, 0.59]], white);
  }

  // --- накладка на перемычку руля: оранжевая со звёздами ---
  {
    const p = new Painter(g, pad);
    p.fill(orange);
    const dark = mix(orange, '#5a1a00', 0.55);
    for (let i = 0; i < 26; i++) {
      const x = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const y = (Math.sin(i * 78.233) * 12543.123) % 1;
      p.dot(Math.abs(x), Math.abs(y), 0.035 + 0.03 * Math.abs(Math.sin(i * 3.7)), i % 3 ? dark : mix(orange, '#ffd27a', 0.5));
    }
    const asp = pad.ph / pad.pw;
    for (const [sx, sy, sr] of [[0.2, 0.5, 0.2], [0.5, 0.52, 0.3], [0.8, 0.5, 0.2], [0.35, 0.3, 0.12], [0.65, 0.3, 0.12]]) {
      const pts: Pt[] = [];
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 + Math.PI / 2;
        const rad = k % 2 ? sr * 0.42 : sr;
        pts.push([sx + Math.cos(a) * rad * asp, sy + Math.sin(a) * rad]);
      }
      p.poly(pts, '#ffd400');
    }
    p.poly([[0, 0], [0.035, 0], [0.035, 1], [0, 1]], black);
    p.poly([[0.965, 0], [1, 0], [1, 1], [0.965, 1]], black);
  }

  // --- маятник: клетчатый флаг и RACING ---
  arm.forEach((r, i) => {
    const p = new Painter(g, r, i === 1);
    p.fill(mix(silver, '#ffffff', 0.25));
    for (let a = 0; a < 9; a++) {
      for (let b = 0; b < 4; b++) {
        const x = -0.045 - a * 0.016 - b * 0.006;
        const y = -0.03 + b * 0.015 + a * 0.0015;
        const fade = 1 - a / 12;
        p.poly(para(x, y, 0.016 * fade, 0.015 * fade, 0.1, -0.006), (a + b) % 2 ? black : white);
      }
    }
    p.line([[-0.2, -0.02], [-0.4, -0.012]], black, 0.003);
    p.text('RACING', -0.262, 0.004, 0.019, orange, -0.03);
    p.line([[-0.31, 0.004], [-0.4, 0.007]], orange, 0.004);
    p.dot(0, 0, 0.012, '#2a2c30');
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, side, tail, arm, plate: plateR, fender, rearF, guard, pad };
}

// ------------------------------------------------------------------
// Колёса
// ------------------------------------------------------------------
interface WheelRig {
  root: THREE.Group;
  spinner: THREE.Group;
  discMat: THREE.MeshStandardMaterial;
  discR: number;
  discZ: number;
}

/** Перфорированный диск-«волна». */
function discGeo(R: number) {
  const sh = new THREE.Shape();
  const n = 90;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = R * (1 - 0.05 * (0.5 + 0.5 * Math.cos(a * 9)));
    if (i) sh.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else sh.moveTo(r, 0);
  }
  const ring = (cx: number, cy: number, r: number, seg: number) => {
    const h = new THREE.Path();
    for (let i = 0; i <= seg; i++) {
      const a = -(i / seg) * Math.PI * 2;
      if (i) h.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else h.moveTo(cx + r, cy);
    }
    return h;
  };
  sh.holes.push(ring(0, 0, R * 0.62, 30));
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const r = R * (i % 2 ? 0.86 : 0.74);
    sh.holes.push(ring(Math.cos(a) * r, Math.sin(a) * r, R * 0.045, 6));
  }
  return new THREE.ExtrudeGeometry(sh, { depth: 0.003, bevelEnabled: false }).translate(0, 0, -0.0015);
}

/** Плоская деталь с круглыми окнами: паук диска, звезда цепи. */
function holedGeo(R: number, depth: number, holes: number, holeR: number, holeAt: number, teeth = 0) {
  const sh = new THREE.Shape();
  const n = teeth ? teeth * 2 : 40;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = teeth && i % 2 ? R - 0.006 : R;
    if (i) sh.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else sh.moveTo(r, 0);
  }
  for (let k = 0; k < holes; k++) {
    const a0 = (k / holes) * Math.PI * 2;
    const h = new THREE.Path();
    for (let i = 0; i <= 10; i++) {
      const a = -(i / 10) * Math.PI * 2;
      const x = Math.cos(a0) * holeAt + Math.cos(a) * holeR;
      const y = Math.sin(a0) * holeAt + Math.sin(a) * holeR;
      if (i) h.lineTo(x, y);
      else h.moveTo(x, y);
    }
    sh.holes.push(h);
  }
  return new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false }).translate(0, 0, -depth / 2);
}

/** Спицованное колесо с кроссовой покрышкой, диском-«волной» и (сзади) звездой цепи. */
function buildWheel(R: number, w: number, rimR: number, rear: boolean, mats: Mats, env: THREE.Texture): WheelRig {
  const root = new THREE.Group();
  const spinner = new THREE.Group();
  root.add(spinner);

  const kn = 0.011; // высота грунтозацепов
  const Rc = R - kn;
  const sec = Rc - rimR;
  const half: Pt[] = [
    [rimR - 0.004, -0.33 * w],
    [rimR + 0.008, -0.46 * w],
    [rimR + sec * 0.5, -0.5 * w],
    [Rc - 0.018, -0.45 * w],
    [Rc - 0.005, -0.28 * w],
  ];
  const prof: Pt[] = [...half, [Rc, 0], ...half.map(([r, h]): Pt => [r, -h]).reverse()];
  add(lathe(prof, 44, 0, Math.PI * 2, 26), mats.rubber, spinner);

  // протектор: центральные блоки, плечевые ряды, боковые зацепы
  const N = Math.round((Math.PI * 2 * R) / 0.05);
  const knob = (a: number, zAx: number, lat: number, rSurf: number, lenT: number, wid: number, h = kn) => {
    const rr = rSurf + h / 2 - 0.0015;
    const k = add(new THREE.BoxGeometry(lenT, h + 0.003, wid), mats.rubber, spinner, Math.cos(a) * rr, Math.sin(a) * rr, zAx);
    k.rotation.set(0, 0, a + Math.PI / 2);
    k.rotateX(-lat);
  };
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const ah = ((i + 0.5) / N) * Math.PI * 2;
    if (i % 2) {
      knob(a, 0, 0, Rc, 0.021, 0.4 * w);
    } else {
      knob(a, -0.15 * w, -0.12, Rc - 0.001, 0.021, 0.2 * w);
      knob(a, 0.15 * w, 0.12, Rc - 0.001, 0.021, 0.2 * w);
    }
    for (const s of [-1, 1]) {
      knob(ah, s * 0.37 * w, s * 0.62, Rc - 0.006, 0.024, 0.2 * w);
      knob(a, s * 0.49 * w, s * 1.25, Rc - 0.021, 0.02, 0.016, 0.006);
    }
  }

  // обод, ступица, спицы
  const rw = w * 0.74;
  const rimProf: Pt[] = [
    [rimR - 0.015, -rw / 2],
    [rimR + 0.006, -rw / 2],
    [rimR + 0.006, -rw / 2 + 0.006],
    [rimR - 0.004, -rw * 0.3],
    [rimR - 0.004, rw * 0.3],
    [rimR + 0.006, rw / 2 - 0.006],
    [rimR + 0.006, rw / 2],
    [rimR - 0.015, rw / 2],
    [rimR - 0.021, 0],
    [rimR - 0.015, -rw / 2],
  ];
  add(lathe(rimProf, 44), mats.rim, spinner);
  const hubR = rear ? 0.03 : 0.024;
  const flZ = rear ? 0.03 : 0.026;
  add(cylZ(hubR, flZ * 2 + 0.02, 16), mats.metal, spinner);
  for (const s of [-1, 1]) add(cylZ(hubR + 0.013, 0.005, 18), mats.metal, spinner, 0, 0, s * flZ);
  const spokes = 28;
  for (let i = 0; i < spokes; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const a0 = (i / spokes) * Math.PI * 2;
    const a1 = a0 + (i % 4 < 2 ? 1 : -1) * 0.55;
    strut(
      new THREE.Vector3(Math.cos(a0) * (hubR + 0.01), Math.sin(a0) * (hubR + 0.01), side * flZ),
      new THREE.Vector3(Math.cos(a1) * (rimR - 0.017), Math.sin(a1) * (rimR - 0.017), side * 0.005),
      0.0017,
      mats.metal,
      spinner,
      5,
    );
  }

  // тормозной диск: спереди слева, сзади справа
  const discMat = new THREE.MeshStandardMaterial({
    color: '#c3c8ce',
    roughness: 0.3,
    metalness: 0.9,
    emissive: new THREE.Color('#ff4a00'),
    emissiveIntensity: 0,
  });
  discMat.envMap = env;
  const discZ = rear ? 0.05 : -0.046;
  const discR = rear ? 0.092 : 0.108;
  add(discGeo(discR), discMat, spinner, 0, 0, discZ);
  add(holedGeo(discR * 0.66, 0.004, 5, discR * 0.17, discR * 0.4), mats.rubber, spinner, 0, 0, discZ);
  if (rear) {
    add(holedGeo(SPR_R + 0.004, 0.004, 6, 0.019, 0.052, 34), mats.rubber, spinner, 0, 0, CHAIN_Z);
    add(new THREE.TorusGeometry(SPR_R, 0.0052, 6, 40, Math.PI * 1.25).rotateZ(Math.PI * 0.375), mats.motor, root, 0, 0, CHAIN_Z);
  }
  add(cylZ(0.0075, rear ? 0.2 : 0.19, 10), rear ? mats.motor : mats.metal, root);
  return { root, spinner, discMat, discR, discZ };
}

// ------------------------------------------------------------------
// Сборка байка
// ------------------------------------------------------------------
export function buildPitBike(look: Look, _tune: Tune): ScooterRig {
  const model = MODELS[look.model];
  const env = studioEnv();

  const std = (color: string, rough = 0.42, metal = 0.4, doubleSide = false) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
  const glowMat = (color: string, k: number) =>
    new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: k, roughness: 0.3 });

  // ==================================================================
  // 1. МАТЕРИАЛЫ И ЛИВРЕЯ
  // ==================================================================
  const livery = buildLivery(look);
  const chainCv = document.createElement('canvas');
  chainCv.width = 16;
  chainCv.height = 32;
  const cg = chainCv.getContext('2d')!;
  cg.fillStyle = '#1a1c1f';
  cg.fillRect(0, 0, 16, 32);
  cg.fillStyle = '#6d727a';
  cg.fillRect(2, 2, 12, 9);
  cg.fillRect(4, 18, 8, 9);
  cg.fillStyle = '#c9ced4';
  cg.fillRect(5, 12, 6, 4);
  cg.fillRect(5, 28, 6, 4);
  const chainTex = new THREE.CanvasTexture(chainCv);
  chainTex.colorSpace = THREE.SRGBColorSpace;
  chainTex.wrapS = chainTex.wrapT = THREE.RepeatWrapping;
  chainTex.magFilter = THREE.NearestFilter;

  const mats: Mats = {
    frame: std(look.frame, 0.36, 0.55),
    livery: std('#ffffff', 0.44, 0.4, true),
    stem: std(look.stem, 0.42, 0.6),
    rim: std(look.rim, 0.38, 0.7),
    rubber: std('#131416', 0.9, 0),
    metal: std('#aeb3ba', 0.32, 0.92),
    chrome: std('#e6eaee', 0.1, 1),
    motor: std('#18191c', 0.5, 0.55),
    plastic: std('#0d0e10', 0.58, 0.05, true),
    light: glowMat(look.lightColor, 2.8),
    tail: glowMat('#ff1616', 2.2),
    spring: std('#f1f1ee', 0.45, 0.1),
    chain: std('#ffffff', 0.45, 0.7),
  };
  mats.livery.map = livery.tex;
  mats.chain.map = chainTex;
  for (const m of Object.values(mats)) m.envMap = env;
  const envBase = new Map<THREE.MeshStandardMaterial, number>();
  const textures: THREE.Texture[] = [livery.tex, chainTex];
  const extraMats: THREE.Material[] = [];

  const root = new THREE.Group();
  const lean = new THREE.Group();
  const body = new THREE.Group();
  const frame = new THREE.Group();
  const art = new THREE.Group();
  art.scale.setScalar(S);
  root.add(lean);
  lean.add(body);
  body.add(frame);
  frame.add(art);

  // ==================================================================
  // 2. КОРПУС: БОКОВИНЫ, СИДЕНЬЕ, ХВОСТ, МОТОР
  // ==================================================================
  // боковины сходятся к рулевой колонке, хвостовые панели — к кончику хвоста
  const SIDE_Z = 0.078;
  const TAIL_Z = 0.111;
  const sideG = [1, -1].map((s) => {
    const g = new THREE.Group();
    g.rotation.y = s * 0.07;
    art.add(g);
    return g;
  });
  const tailG = [1, -1].map((s) => {
    const g = new THREE.Group();
    g.rotation.y = -s * 0.05;
    art.add(g);
    return g;
  });
  /** Деталь правого борта и её зеркальная копия слева. */
  const sym = (groups: THREE.Object3D[], gR: THREE.BufferGeometry, gL: THREE.BufferGeometry, mat: THREE.Material, z: number) => {
    add(gR, mat, groups[0], 0, 0, z);
    add(mirrorZ(gL), mat, groups[1], 0, 0, -z);
    if (gL !== gR) gL.dispose();
  };
  const panelBack = plate(PANEL, 0.034, 0.008, 0.003);
  sym(sideG, panelBack, panelBack, mats.frame, SIDE_Z - 0.017);
  sym(sideG, decal(PANEL, livery.side[0], 0.008), decal(PANEL, livery.side[1], 0.008), mats.livery, SIDE_Z + 0.0005);
  // крышка батареи выступает над панелью
  const insetBack = plate(INSET, 0.007, 0.006, 0.002);
  sym(sideG, insetBack, insetBack, mats.plastic, SIDE_Z + 0.0035);
  sym(sideG, decal(INSET, livery.side[0], 0.006), decal(INSET, livery.side[1], 0.006), mats.livery, SIDE_Z + 0.0075);
  const tailBack = plate(TAIL, 0.03, 0.006, 0.003);
  sym(tailG, tailBack, tailBack, mats.frame, TAIL_Z - 0.015);
  sym(tailG, decal(TAIL, livery.tail[0]), decal(TAIL, livery.tail[1]), mats.livery, TAIL_Z + 0.0005);

  // тёмное «нутро» между боковинами и под хвостом
  add(plate(PANEL, 0.1, 0.008, 0.002), mats.plastic, art);
  add(
    plate(
      [
        [-0.29, 0.632],
        [-0.4, 0.686],
        [-0.6, 0.778],
        [-0.72, 0.822],
        [-0.68, 0.79],
        [-0.5, 0.682],
        [-0.37, 0.612],
        [-0.28, 0.59],
      ],
      0.136,
      0.006,
      0.002,
    ),
    mats.plastic,
    art,
  );

  // рулевая колонка
  const headTube = add(new THREE.CylinderGeometry(0.03, 0.03, 0.15, 18), mats.motor, art, HD.x, HD.y, 0);
  headTube.rotation.z = RAKE;
  add(
    plate(
      [
        [HD.x - 0.03, HD.y + 0.045],
        [HD.x + 0.02, HD.y - 0.07],
        [0.2, 0.6],
        [0.12, 0.7],
      ],
      0.06,
      0.01,
      0.004,
    ),
    mats.motor,
    art,
  );

  // сиденье: нос поднимается к «баку», минимум — 695 мм, хвост задран
  const seatRows = smooth(
    [
      // x, верх, низ, полуширина
      [0.118, 0.741, 0.725, 0.036],
      [0.085, 0.742, 0.708, 0.05],
      [0.0, 0.722, 0.682, 0.066],
      [-0.08, 0.703, 0.657, 0.076],
      [-0.15, 0.695, 0.641, 0.082],
      [-0.24, 0.699, 0.636, 0.086],
      [-0.33, 0.716, 0.662, 0.088],
      [-0.42, 0.742, 0.702, 0.087],
      [-0.52, 0.776, 0.748, 0.082],
      [-0.6, 0.802, 0.784, 0.07],
      [-0.638, 0.812, 0.801, 0.052],
    ],
    30,
  );
  add(loft(seatRows.map(([x, yt, yb, hw]) => roundRing(x, yt, yb, hw, 0.024, 0.007)), true, true), mats.rubber, art);

  // крышка между рулевой колонкой и носом сиденья, замок зажигания
  const coverRows = smooth(
    [
      [0.262, 0.776, 0.74, 0.03],
      [0.235, 0.782, 0.75, 0.044],
      [0.18, 0.766, 0.735, 0.052],
      [0.125, 0.75, 0.716, 0.054],
      [0.095, 0.744, 0.708, 0.052],
    ],
    8,
  );
  add(loft(coverRows.map(([x, yt, yb, hw]) => roundRing(x, yt, yb, hw, 0.014, 0.004)), true, true), mats.plastic, art);
  const key = new THREE.Group();
  key.position.set(0.178, 0.766, 0);
  key.rotation.z = 0.28;
  art.add(key);
  add(new THREE.CylinderGeometry(0.017, 0.019, 0.012, 16), mats.motor, key, 0, 0.004, 0);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.016, 14), mats.metal, key, 0, 0.005, 0);
  add(new THREE.BoxGeometry(0.012, 0.003, 0.003), mats.motor, key, 0, 0.013, 0);

  // заднее крыло за сиденьем и стоп-сигнал
  const fenders = new THREE.Group();
  art.add(fenders);
  const rfRows = smooth(
    [
      [-0.56, 0.772, 0.08],
      [-0.62, 0.801, 0.082],
      [-0.69, 0.824, 0.076],
      [-0.74, 0.84, 0.056],
      [-0.768, 0.848, 0.024],
    ],
    10,
  );
  add(
    mapUV(loft(rfRows.map(([x, y, hw]) => arcRow(x, y, hw, 0.007, 0.012))), livery.rearF, (x, _y, z) => [x, -z]),
    mats.livery,
    fenders,
  );
  const tailLamp = add(rbox(0.012, 0.016, 0.07, 0.004, 'z', 0.002), mats.tail, art, -0.716, 0.806, 0);
  tailLamp.rotation.z = 0.35;

  // центральный мотор: цилиндр с круглыми крышками, слева — кожух ведущей звезды
  add(cylZ(0.085, 0.118, 30), mats.motor, art, MOTOR.x, MOTOR.y, 0.016);
  for (const z of [-0.03, -0.006, 0.018, 0.042, 0.066]) add(cylZ(0.0875, 0.007, 30), mats.motor, art, MOTOR.x, MOTOR.y, z);
  add(lathe([[0.0, 0.0], [0.07, 0.0], [0.066, 0.012], [0.05, 0.019], [0.0, 0.021]], 26), mats.plastic, art, MOTOR.x, MOTOR.y, 0.075);
  add(cylZ(0.03, 0.006, 18), mats.motor, art, MOTOR.x, MOTOR.y, 0.097);
  const sprCover = add(lathe([[0.0, 0.0], [0.062, 0.0], [0.058, 0.014], [0.042, 0.02], [0.0, 0.022]], 26), mats.plastic, art, MOTOR.x, MOTOR.y, -0.068);
  sprCover.rotation.y = Math.PI;
  add(cylZ(0.026, 0.006, 18), mats.motor, art, MOTOR.x, MOTOR.y, -0.091);
  add(cylZ(SPR_F, 0.006, 14), mats.metal, art, MOTOR.x, MOTOR.y, CHAIN_Z);
  // ребристый корпус контроллера перед мотором
  const ctrl = new THREE.Group();
  ctrl.position.set(0.108, 0.312, 0);
  ctrl.rotation.z = 0.12;
  art.add(ctrl);
  add(rbox(0.104, 0.122, 0.124, 0.014, 'z', 0.004), mats.motor, ctrl);
  for (let i = -3; i <= 3; i++) add(rbox(0.116, 0.134, 0.005, 0.018, 'z', 0.001), mats.plastic, ctrl, 0, 0, i * 0.019);
  for (const s of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      const rib = add(new THREE.BoxGeometry(0.008, 0.11, 0.006), mats.plastic, ctrl, i * 0.02, 0, s * 0.064);
      rib.rotation.z = 0.5;
    }
  }

  for (const s of [-1, 1]) {
    // серебристые кронштейны мотора и пластины оси маятника
    add(
      plate(
        [
          [0.06, 0.445],
          [0.15, 0.462],
          [0.142, 0.385],
          [0.078, 0.375],
        ],
        0.007,
        0.01,
        0.002,
      ),
      mats.metal,
      art,
      0,
      0,
      s * 0.066,
    );
    add(
      plate(
        [
          [-0.205, 0.352],
          [-0.085, 0.342],
          [-0.052, 0.272],
          [-0.092, 0.222],
          [-0.17, 0.25],
        ],
        0.009,
        0.014,
        0.002,
      ),
      mats.metal,
      art,
      0,
      0,
      s * 0.096,
    );
    add(cylZ(0.017, 0.006, 14), mats.metal, art, PIV.x, PIV.y, s * 0.102);
    // подножка: чёрный кронштейн и зубчатая площадка
    add(rbox(0.03, 0.03, 0.05, 0.006, 'z', 0.002), mats.motor, art, PEG.x, PEG.y - 0.008, s * 0.118);
    add(rbox(0.042, 0.012, 0.078, 0.004, 'y', 0.002), mats.metal, art, PEG.x, PEG.y - 0.002, s * PEG.z);
    for (let i = 0; i < 5; i++) {
      for (const dx of [-0.017, 0.017]) {
        add(new THREE.ConeGeometry(0.0045, 0.009, 4), mats.metal, art, PEG.x + dx, PEG.y + 0.007, s * (PEG.z - 0.03 + i * 0.015));
      }
    }
  }
  add(cylZ(0.01, 0.2, 10), mats.metal, art, PIV.x, PIV.y, 0);

  // боковая подножка слева
  const stand = new THREE.Group();
  stand.position.set(-0.118, 0.236, -0.1);
  art.add(stand);
  const standLeg = new THREE.Group();
  stand.add(standLeg);
  const STAND_L = 0.236;
  add(new THREE.CylinderGeometry(0.0085, 0.0075, STAND_L, 8).translate(0, -STAND_L / 2, 0), mats.motor, standLeg);
  add(rbox(0.05, 0.008, 0.03, 0.004, 'y', 0.001), mats.motor, standLeg, 0.008, -STAND_L, -0.006);
  add(cylZ(0.014, 0.02, 10), mats.motor, stand);

  // ==================================================================
  // 3. РУЛЕВОЙ УЗЕЛ: ПЕРЕВЁРНУТАЯ ВИЛКА, КРЫЛО, ЩИТОК, РУЛЬ
  // ==================================================================
  const steerPivot = new THREE.Group();
  steerPivot.position.set(HD.x, HD.y, 0);
  steerPivot.rotation.z = RAKE;
  art.add(steerPivot);
  const steer = new THREE.Group();
  steerPivot.add(steer);

  for (const y of [0.088, -0.088]) add(rbox(0.082, 0.026, 0.218, 0.016, 'y', 0.004), mats.stem, steer, FORK_OFF * 0.5, y, 0);
  add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 14), mats.metal, steer, 0, 0.108, 0);
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.026, 0.026, 0.4, 18), mats.stem, steer, FORK_OFF, -0.095, s * FORK_Z);
    add(new THREE.CylinderGeometry(0.029, 0.029, 0.022, 18), mats.plastic, steer, FORK_OFF, -0.288, s * FORK_Z);
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 14), mats.metal, steer, FORK_OFF, 0.108, s * FORK_Z);
  }

  // высокое переднее крыло собрано в осях рамы
  const fenderF = new THREE.Group();
  fenderF.position.set(FORK_OFF, -0.088, 0);
  fenderF.rotation.z = -RAKE;
  steer.add(fenderF);
  const ffRows = smooth(
    [
      // x, верх, полуширина, прогиб
      [-0.012, -0.102, 0.03, 0.005],
      [0.02, -0.058, 0.044, 0.011],
      [0.06, -0.034, 0.05, 0.015],
      [0.12, -0.024, 0.062, 0.02],
      [0.2, -0.03, 0.074, 0.024],
      [0.28, -0.048, 0.074, 0.023],
      [0.34, -0.068, 0.058, 0.017],
      [0.39, -0.09, 0.026, 0.007],
    ],
    22,
  );
  add(
    mapUV(loft(ffRows.map(([x, y, hw, d]) => arcRow(x, y - 0.018, hw, d * 1.3, 0.012)), false, false, true), livery.fender, (x, _y, z) => [x, z]),
    mats.livery,
    fenderF,
  );

  // номерной щиток с фарой
  const plateG = new THREE.Group();
  plateG.position.set(FORK_OFF + 0.05, 0, 0);
  plateG.rotation.z = 0.07;
  steer.add(plateG);
  add(plate(PLATE, 0.008, 0.012, 0.003).rotateY(Math.PI / 2), mats.plastic, plateG, -0.0045, 0, 0);
  add(decal(PLATE, livery.plate, 0.012).rotateY(Math.PI / 2), mats.livery, plateG);
  const lensPts: Pt[] = [
    [-0.03, 0.124],
    [0.03, 0.124],
    [0.021, 0.083],
    [-0.021, 0.083],
  ];
  add(plate(lensPts, 0.008, 0.005, 0.002).rotateY(Math.PI / 2), mats.light, plateG, 0.003, 0, 0);
  for (const s of [-1, 1]) {
    add(rbox(0.05, 0.012, 0.012, 0.004, 'x', 0.001), mats.plastic, plateG, -0.028, 0.088, s * 0.06);
    add(rbox(0.05, 0.012, 0.012, 0.004, 'x', 0.001), mats.plastic, plateG, -0.028, -0.082, s * 0.05);
  }

  const headlight = new THREE.SpotLight(look.lightColor, 0, 52, 0.55, 0.55, 1.5);
  headlight.position.set(FORK_OFF + 0.075, 0.1, 0);
  const hlTarget = new THREE.Object3D();
  hlTarget.position.set(headlight.position.x + 3.84, headlight.position.y - 2.43, 0);
  steer.add(headlight, hlTarget);
  headlight.target = hlTarget;

  // руль с перемычкой и накладкой
  for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.014, 0.016, 0.04, 12), mats.stem, steer, 0.004, 0.118, s * 0.034);
  tube(
    [
      [BAR.x, BAR.y, -HALF_BAR],
      [BAR.x, BAR.y, -HALF_BAR + 0.15],
      [0.004, 0.14, -0.078],
      [0.004, 0.14, 0.078],
      [BAR.x, BAR.y, HALF_BAR - 0.15],
      [BAR.x, BAR.y, HALF_BAR],
    ],
    0.011,
    mats.stem,
    steer,
    8,
  );
  const padX = BAR.x * 0.72;
  const padY = BAR.y - 0.022;
  add(cylZ(0.0065, 0.29, 8), mats.stem, steer, padX, padY, 0);
  for (const th of [0, Math.PI]) {
    const padGeo = new THREE.CylinderGeometry(0.027, 0.027, 0.2, 9, 1, false, th + Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
    add(mapUV(padGeo, livery.pad, (_x, _y, _z, u, v) => [v, u]), mats.livery, steer, padX, padY, 0);
  }
  const gripL = new THREE.Object3D();
  const gripR = new THREE.Object3D();
  gripL.position.set(BAR.x, BAR.y, -(HALF_BAR - 0.06));
  gripR.position.set(BAR.x, BAR.y, HALF_BAR - 0.06);
  steer.add(gripL, gripR);
  const brakeLevers: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    add(cylZ(0.0168, 0.118, 14), mats.rubber, steer, BAR.x, BAR.y, s * (HALF_BAR - 0.059));
    add(cylZ(0.021, 0.006, 14), mats.rubber, steer, BAR.x, BAR.y, s * (HALF_BAR - 0.121));
    add(cylZ(0.019, 0.005, 14), mats.rubber, steer, BAR.x, BAR.y, s * (HALF_BAR - 0.002));
    // главный цилиндр и рычаг тормоза
    const pz = s * (HALF_BAR - 0.148);
    add(rbox(0.032, 0.026, 0.024, 0.006, 'z', 0.002), mats.plastic, steer, BAR.x + 0.014, BAR.y, pz);
    add(rbox(0.03, 0.03, 0.042, 0.006, 'z', 0.002), mats.plastic, steer, BAR.x + 0.03, BAR.y + 0.018, pz - s * 0.012);
    const lever = new THREE.Group();
    lever.position.set(BAR.x + 0.04, BAR.y - 0.002, pz);
    add(rbox(0.009, 0.008, 0.128, 0.003, 'z', 0.001).translate(0.008, 0, s * 0.064).rotateY(-s * 0.1), mats.plastic, lever);
    add(new THREE.SphereGeometry(0.0065, 8, 6), mats.plastic, lever, -0.005, 0, s * 0.128);
    steer.add(lever);
    brakeLevers.push(lever);
    // тросы и шланги петлёй перед щитком
    tube(
      [
        [BAR.x + 0.045, BAR.y + 0.012, pz - s * 0.02],
        [0.1, 0.17, s * 0.13],
        [0.125, 0.07, s * 0.04],
        [0.1, -0.06, s * 0.075],
        [FORK_OFF + 0.03, -0.12, s * 0.085],
      ],
      0.0035,
      mats.plastic,
      steer,
      6,
      5,
    );
  }

  // ЖК-дисплей у левой ручки, повёрнут к райдеру
  const dispG = new THREE.Group();
  dispG.position.set(BAR.x - 0.012, BAR.y + 0.034, -(HALF_BAR - 0.19));
  dispG.rotation.z = -0.95;
  steer.add(dispG);
  add(rbox(0.014, 0.052, 0.088, 0.006, 'x', 0.002), mats.plastic, dispG);
  add(rbox(0.02, 0.014, 0.02, 0.004, 'x', 0.001), mats.plastic, dispG, 0.014, -0.012, 0);
  const dc = document.createElement('canvas');
  dc.width = 256;
  dc.height = 128;
  const dctx = dc.getContext('2d')!;
  const dispTex = new THREE.CanvasTexture(dc);
  dispTex.colorSpace = THREE.SRGBColorSpace;
  textures.push(dispTex);
  const screenMat = new THREE.MeshBasicMaterial({ map: dispTex, toneMapped: false });
  extraMats.push(screenMat);
  const screen = add(new THREE.PlaneGeometry(0.078, 0.042), screenMat, dispG, -0.0076, 0, 0);
  screen.rotation.y = -Math.PI / 2;

  // ==================================================================
  // 4. КОЛЁСА И НИЗ ВИЛКИ
  // ==================================================================
  const wheelF = buildWheel(RF, 0.06, 0.178, false, mats, env);
  const wheelR = buildWheel(RR, 0.08, 0.152, true, mats, env);
  steer.add(wheelF.root);
  art.add(wheelR.root);
  // низ вилки ездит вместе с колесом: хромированные трубы уходят внутрь неподвижных стаканов
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.0195, 0.0195, 0.43, 16), mats.chrome, wheelF.root, 0, 0.235, s * FORK_Z);
    add(rbox(0.05, 0.085, 0.03, 0.012, 'z', 0.003), mats.metal, wheelF.root, 0, 0.012, s * FORK_Z);
    add(cylZ(0.014, 0.008, 12), mats.plastic, wheelF.root, 0, 0, s * (FORK_Z + 0.017));
    const gGeo = new THREE.CylinderGeometry(0.0285, 0.03, 0.27, 10, 1, true, -0.45, Math.PI + 0.9);
    add(mapUV(gGeo, livery.guard, (_x, _y, _z, u, v) => [u, v]), mats.livery, wheelF.root, 0, 0.185, s * FORK_Z);
  }
  add(rbox(0.034, 0.06, 0.03, 0.008, 'z', 0.003), mats.plastic, wheelF.root, -0.062, wheelF.discR * 0.62, wheelF.discZ);
  add(rbox(0.05, 0.02, 0.012, 0.006, 'z', 0.002), mats.metal, wheelF.root, -0.035, 0.05, -FORK_Z + 0.014);
  if (!look.fender) {
    fenders.visible = false;
    fenderF.visible = false;
  }

  // ==================================================================
  // 5. МАЯТНИК, ЦЕПЬ, МОНОАМОРТИЗАТОР
  // ==================================================================
  // оси маятника: +x — от оси колеса к оси качания, ось колеса в (−ARM_L, 0)
  const arm = new THREE.Group();
  arm.position.set(PIV.x, PIV.y, 0);
  art.add(arm);
  const beamGeo = plate(BEAM, 0.024, 0.012, 0.004);
  for (const s of [-1, 1]) add(beamGeo, mats.frame, arm, 0, 0, s * ARM_Z);
  add(decal(BEAM, livery.arm[0], 0.012), mats.livery, arm, 0, 0, ARM_Z + 0.0125);
  add(mirrorZ(decal(BEAM, livery.arm[1], 0.012)), mats.livery, arm, 0, 0, -ARM_Z - 0.0125);
  add(rbox(0.07, 0.05, ARM_Z * 2, 0.012, 'z', 0.002), mats.frame, arm, -0.085, 0, 0);
  add(rbox(0.03, 0.03, 0.03, 0.008, 'z', 0.002), mats.metal, arm, SHOCK_BOT.x, SHOCK_BOT.y - 0.012, 0);
  for (const s of [-1, 1]) {
    add(rbox(0.06, 0.036, 0.008, 0.008, 'z', 0.002), mats.metal, arm, -ARM_L, 0, s * (ARM_Z + 0.015));
    add(cylZ(0.012, 0.01, 6), mats.metal, arm, -ARM_L, 0, s * (ARM_Z + 0.022));
  }
  // защита цепи на левом пере
  const chainGuard = add(
    plate(
      [
        [-0.07, 0.036],
        [-0.1, 0.062],
        [-0.3, 0.07],
        [-0.36, 0.05],
        [-0.36, 0.036],
      ],
      0.022,
      0.008,
      0.003,
    ),
    mats.plastic,
    arm,
    0,
    0,
    CHAIN_Z - 0.004,
  );
  chainGuard.name = 'chainGuard';
  // внутреннее заднее крыло на маятнике, огибает покрышку спереди-сверху
  const hugRows: THREE.Vector3[][] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const a = 0.42 + t * 1.08;
    const hw = 0.056 - 0.012 * t * t;
    const row: THREE.Vector3[] = [];
    for (let j = -5; j <= 5; j++) {
      const k = j / 5;
      const r = RR + 0.03 - 0.014 * k * k - (Math.abs(j) === 5 ? 0.012 : 0);
      row.push(new THREE.Vector3(-ARM_L + Math.cos(a) * r, Math.sin(a) * r, hw * Math.min(1, Math.abs(k) * 1.25) * Math.sign(k)));
    }
    hugRows.push(row);
  }
  add(loft(hugRows), mats.plastic, arm);
  for (const s of [-1, 1]) {
    add(
      plate(
        [
          [-0.1, 0.03],
          [-0.15, 0.03],
          [-ARM_L + Math.cos(0.66) * (RR + 0.02), Math.sin(0.66) * (RR + 0.02)],
          [-ARM_L + Math.cos(0.46) * (RR + 0.02), Math.sin(0.46) * (RR + 0.02)],
        ],
        0.006,
        0.006,
        0.001,
      ),
      mats.plastic,
      arm,
      0,
      0,
      s * 0.05,
    );
  }
  // задний суппорт справа
  add(rbox(0.05, 0.03, 0.028, 0.008, 'z', 0.003), mats.plastic, arm, -ARM_L + 0.05, wheelR.discR * 0.72, wheelR.discZ);
  add(rbox(0.07, 0.014, 0.008, 0.005, 'z', 0.002), mats.metal, arm, -ARM_L + 0.03, 0.035, ARM_Z - 0.016);

  // цепь: две ветви между ведущей звездой и звездой колеса
  const chainRuns = [0, 1].map(() => {
    const run = new THREE.Mesh(new THREE.BoxGeometry(0.011, 1, 0.009).translate(0, 0.5, 0), mats.chain);
    art.add(run);
    return run;
  });

  // моноамортизатор с белой пружиной
  const shock = new THREE.Group();
  const shockLow = new THREE.Group();
  const shockUp = new THREE.Group();
  const coil = new THREE.Mesh(new THREE.TubeGeometry(new Helix(0.029, 6.5, COIL_H), 96, 0.0082, 7, false), mats.spring);
  shock.add(shockLow, shockUp, coil);
  art.add(shock);
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.25, 8).translate(0, 0.125, 0), mats.metal, shockLow);
  add(new THREE.CylinderGeometry(0.037, 0.037, 0.008, 16), mats.metal, shockLow, 0, 0.03, 0);
  add(cylZ(0.013, 0.034, 10), mats.metal, shockLow);
  add(new THREE.CylinderGeometry(0.019, 0.019, 0.13, 12).translate(0, -0.075, 0), mats.motor, shockUp);
  add(new THREE.CylinderGeometry(0.037, 0.037, 0.008, 16), mats.motor, shockUp, 0, -0.03, 0);
  add(cylZ(0.013, 0.034, 10), mats.motor, shockUp);
  const placeShock = (pBot: P2, pTop: P2) => {
    const len = Math.max(0.12, Math.hypot(pTop.x - pBot.x, pTop.y - pBot.y));
    span(shock, pBot, pTop, 0, null);
    shockUp.position.y = len;
    coil.position.y = 0.034;
    coil.scale.y = Math.max(0.03, len - 0.068) / COIL_H;
  };

  const dynamic = new Set<THREE.Object3D>([
    steerPivot,
    wheelF.root,
    wheelR.root,
    wheelF.spinner,
    wheelR.spinner,
    stand,
    arm,
    shock,
    shockLow,
    shockUp,
    coil,
    fenders,
    fenderF,
    ...chainRuns,
    ...brakeLevers,
  ]);
  for (const node of [art, steer, arm, fenders, fenderF, stand, shockLow, shockUp, wheelF.root, wheelR.root, wheelF.spinner, wheelR.spinner]) {
    bake(node, dynamic);
  }
  for (const lever of brakeLevers) bake(lever, dynamic);
  for (const m of [...Object.values(mats), wheelF.discMat, wheelR.discMat]) envBase.set(m, m.envMapIntensity);

  // неоновая подсветка днища
  let glowLight: THREE.PointLight | null = null;
  if (look.glow) {
    const gt = glowTexture();
    textures.push(gt);
    const glowM = new THREE.MeshBasicMaterial({
      map: gt,
      color: look.glowColor,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    extraMats.push(glowM);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.75), glowM);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(-0.02, 0.025, 0);
    frame.add(glow);
    glowLight = new THREE.PointLight(look.glowColor, 1.8, 3.8, 1.5);
    glowLight.position.set(-0.02, 0.14, 0);
    frame.add(glowLight);
  }

  // ==================================================================
  // 6. РАЙДЕР (СИДЯ) И ТЕНИ
  // ==================================================================
  // райдер не масштабируется: посадочные точки переводятся в оси рамы
  const rider = new Rider(look, 0, 0, {
    x: SEAT.x * S,
    y: (SEAT.y - 0.006) * S,
    pegX: PEG.x * S,
    pegY: (PEG.y + 0.008) * S,
    pegZ: PEG.z * S,
  });
  frame.add(rider.group);
  for (const m of rider.envMats) envBase.set(m, m.envMapIntensity);

  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (m.material && (m.material as THREE.Material).transparent) return;
      m.castShadow = true;
      m.receiveShadow = false;
    }
  });

  const tmpW = new THREE.Vector3();
  const tmpL = new THREE.Vector3();
  const tmpR = new THREE.Vector3();
  let lastDispKey = '';

  // ==================================================================
  // 7. ОБНОВЛЕНИЕ ПО СОСТОЯНИЮ ФИЗИКИ
  // ==================================================================
  const update = (s: VisualState, dt: number) => {
    root.position.set(s.x, s.groundRef, s.z);
    root.rotation.y = s.psi;
    lean.rotation.x = s.crashE > 0 ? -s.crashSide * 1.38 * s.crashE : -s.phi;

    const thv = s.th - s.thRest;
    const c = Math.cos(thv);
    const sn = Math.sin(thv);

    // ход подвески — вдоль вертикали рамы, как в физике; дальше всё в заводских единицах
    const sth = Math.sin(s.th);
    const yAf = s.yb + s.wf.x * sth;
    const yAr = s.yb + s.wr.x * sth;
    const restGapF = s.ybRest + s.wf.x * Math.sin(s.thRest) - PITBIKE.rFront;
    const restGapR = s.ybRest + s.wr.x * Math.sin(s.thRest) - PITBIKE.rRear;
    const dyF = Math.max(-0.05, Math.min(0.14, s.wf.y - yAf + restGapF)) / S;
    const dyR = Math.max(-0.05, Math.min(0.14, s.wr.y - yAr + restGapR)) / S;
    // переднее колесо скользит вдоль вилки, заднее идёт по вертикали
    const slide = dyF / COS_R;
    const wF = { x: AX_F - slide * SIN_R, y: RF + dyF };
    const wR = { x: AX_R, y: RR + dyR };

    // опорное колесо (заднее на вилли, переднее на стоппи) стоит точно на земле
    const bodyX = -wR.x * S * (c - 1) + wR.y * S * sn;
    let bodyY = s.wr.y - s.groundRef - (wR.x * sn + wR.y * c) * S;
    if (thv < -0.02) bodyY = Math.max(bodyY, s.wf.y - s.groundRef - (wF.x * sn + wF.y * c) * S);
    body.position.set(bodyX + s.wr.x - AX_R * S, bodyY, 0);
    body.rotation.z = thv;

    wheelF.root.position.set(FORK_OFF, -FORK_LEN + slide, 0);
    wheelF.spinner.rotation.z = -s.wf.angle;

    // маятник, цепь и моноамортизатор
    wheelR.root.position.set(wR.x, wR.y, 0);
    wheelR.spinner.rotation.z = -s.wr.angle;
    const L = Math.hypot(wR.x - PIV.x, wR.y - PIV.y);
    const ang = Math.atan2(PIV.y - wR.y, PIV.x - wR.x);
    arm.rotation.z = ang;
    arm.scale.x = L / ARM_L;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const sbx = SHOCK_BOT.x * (L / ARM_L);
    placeShock({ x: PIV.x + sbx * ca - SHOCK_BOT.y * sa, y: PIV.y + sbx * sa + SHOCK_BOT.y * ca }, SHOCK_TOP);

    // ветви цепи — внешние касательные к двум звёздам
    const cdx = wR.x - MOTOR.x;
    const cdy = wR.y - MOTOR.y;
    const D = Math.hypot(cdx, cdy);
    const ux = cdx / D;
    const uy = cdy / D;
    const k = (SPR_F - SPR_R) / D;
    const q = Math.sqrt(1 - k * k);
    chainRuns.forEach((run, i) => {
      const side = i === 0 ? 1 : -1;
      const nx = ux * k - uy * q * side;
      const ny = uy * k + ux * q * side;
      const p1 = { x: MOTOR.x + nx * SPR_F, y: MOTOR.y + ny * SPR_F };
      const p2 = { x: wR.x + nx * SPR_R, y: wR.y + ny * SPR_R };
      if (side > 0) span(run, p1, p2, CHAIN_Z);
      else span(run, p2, p1, CHAIN_Z);
    });
    chainTex.repeat.set(1, D / 0.0254);
    chainTex.offset.y = ((s.wr.angle * SPR_R) / 0.0254) % 1;

    steer.rotation.y = Math.max(-0.7, Math.min(0.7, s.delta * 2.0));

    const brk = s.brake ?? 0;
    mats.tail.emissiveIntensity = 1.8 + brk * 4.5;
    brakeLevers[0].rotation.y = brk * 0.22;
    brakeLevers[1].rotation.y = -brk * 0.22;
    stand.rotation.z = s.parked ? 0.12 : -1.42;
    standLeg.rotation.x = s.parked ? 0.42 : 0.04;
    wheelF.discMat.emissiveIntensity = Math.max(0, Math.min(1.6, (s.wf.temp - 130) / 260));
    wheelR.discMat.emissiveIntensity = Math.max(0, Math.min(1.6, (s.wr.temp - 130) / 260));

    root.updateMatrixWorld(true);
    if (s.worldRiderPose) {
      rider.applyWorldPose(s.worldRiderPose, frame);
    } else {
      gripL.getWorldPosition(tmpW);
      tmpL.copy(tmpW);
      frame.worldToLocal(tmpL);
      gripR.getWorldPosition(tmpW);
      tmpR.copy(tmpW);
      frame.worldToLocal(tmpR);
      rider.update(dt, {
        gripL: tmpL,
        gripR: tmpR,
        az: s.az,
        ax: s.ax,
        lean: s.lean,
        leanLat: s.leanLat,
        crash: s.crashE,
        speed: s.speed,
        stuntPitch: Math.max(0, ((s.stuntAngle ?? 0) * Math.PI) / 180),
      });
      rider.captureWorldPose(frame);
    }
  };

  // ==================================================================
  // 8. ДИСПЛЕЙ
  // ==================================================================
  const setDisplay = (kmh: number, unit: string, battery: number, mode: ModeId, stuntDeg = 0) => {
    const stKey = stuntDeg > 6 ? Math.round(stuntDeg) : 0;
    const key = `${Math.round(kmh)}|${unit}|${Math.round(battery * 50)}|${mode}|${stKey}`;
    if (key === lastDispKey) return;
    lastDispKey = key;
    dctx.fillStyle = '#06090e';
    dctx.fillRect(0, 0, 256, 128);
    dctx.fillStyle = '#141c26';
    dctx.fillRect(0, 0, 256, 26);
    dctx.fillStyle = stKey > 0 ? '#ff9f1c' : '#7cd4ff';
    dctx.font = '700 14px system-ui, sans-serif';
    dctx.textAlign = 'left';
    dctx.textBaseline = 'middle';
    dctx.fillText(stKey > 0 ? `WHEELIE · ${stKey}°` : `KUKIRIN ${model.label}`, 10, 13);
    dctx.textAlign = 'right';
    dctx.fillStyle = mode === 'eco' ? '#4ade80' : mode === 'drive' ? '#38bdf8' : look.accent;
    dctx.fillText(mode === 'eco' ? 'ECO' : mode === 'drive' ? 'DRIVE' : 'SPORT', 246, 13);
    dctx.fillStyle = '#ffffff';
    dctx.font = '900 68px system-ui, sans-serif';
    dctx.textAlign = 'center';
    dctx.fillText(String(Math.round(kmh)), 108, 64);
    dctx.font = '700 20px system-ui, sans-serif';
    dctx.fillStyle = look.accent;
    dctx.textAlign = 'left';
    dctx.fillText(unit.toUpperCase(), 178, 72);
    const segs = 10;
    const active = Math.ceil(battery * segs);
    for (let i = 0; i < segs; i++) {
      dctx.fillStyle = i < active ? (battery > 0.25 ? '#4ade80' : '#f87171') : '#18222d';
      dctx.fillRect(16 + i * 22.6, 105, 19, 10);
    }
    dispTex.needsUpdate = true;
  };
  setDisplay(0, 'km/h', 1, 'drive', 0);

  return {
    root,
    frame,
    rider,
    headlight,
    glowLight,
    update,
    setDisplay,
    setFirstPerson: (fp) => rider.setFirstPerson(fp),
    setEnvIntensity(k) {
      envBase.forEach((base, m) => (m.envMapIntensity = base * k));
    },
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
      Object.values(mats).forEach((m) => m.dispose());
      extraMats.forEach((m) => m.dispose());
      wheelF.discMat.dispose();
      wheelR.discMat.dispose();
      textures.forEach((t) => t.dispose());
      rider.dispose();
    },
  };
}
