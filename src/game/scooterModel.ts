import * as THREE from 'three';
import { MODELS, type Look, type ModeId, type Tune } from './data';
import { bake, cylZ, extrudeZ, lathe, plate, rbox, studioEnv, type Pt } from './geo';
import { buildPitBike } from './pitBikeModel';
import { Rider } from './rider';
import { decalTexture, deckGripTexture, glowTexture, stemDecalTexture } from './textures';

export const TILT = 0.19; // наклон рулевой стойки назад (рад)
const B = { x: 0.455, y: 0.3 }; // основание рулевой колонки (над передним маятником)
const PF = { x: 0.425, y: 0.195 }; // шарнир переднего маятника (нижняя траверса вилки)
const PR = { x: -0.365, y: 0.175 }; // шарнир заднего маятника
const DECK_TOP = 0.205;

export interface WheelVis {
  x: number; // локально вдоль рамы (вперёд +)
  y: number; // мировая высота центра колеса
  angle: number;
  temp: number;
  comp?: number;
}

export interface VisualState {
  x: number;
  z: number;
  psi: number;
  groundRef: number;
  yb: number;
  th: number;
  phi: number;
  delta: number;
  ybRest: number;
  thRest: number;
  wf: WheelVis;
  wr: WheelVis;
  az: number;
  ax: number;
  lean: number;
  leanLat?: number;
  crashE: number; // 0..1 прогресс падения
  crashSide: number;
  speed: number;
  throttle?: number;
  brake?: number;
  parked?: boolean;
  stuntAngle?: number; // градусы
  tailScrape?: boolean;
  worldRiderPose?: Float32Array;
}

export interface ScooterRig {
  root: THREE.Group;
  frame: THREE.Group;
  rider: Rider;
  headlight: THREE.SpotLight;
  glowLight: THREE.PointLight | null;
  update(s: VisualState, dt: number): void;
  setDisplay(kmh: number, unit: string, battery: number, mode: ModeId, stuntDeg?: number): void;
  setFirstPerson(fp: boolean): void;
  /** Яркость отражений окружения на металле и лаке (1 — день, ~0.25 — ночь). */
  setEnvIntensity(k: number): void;
  dispose(): void;
}

type Mats = Record<string, THREE.MeshStandardMaterial>;

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  r: number;
  turns: number;
  constructor(r: number, turns: number) {
    super();
    this.r = r;
    this.turns = turns;
  }
  getPoint(t: number, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.r, t, Math.sin(a) * this.r);
  }
}

function rotNeg(dx: number, dy: number, a: number) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

function unitCyl(r: number, mat: THREE.Material, seg = 12) {
  const g = new THREE.CylinderGeometry(r, r, 1, seg);
  g.translate(0, 0.5, 0);
  return new THREE.Mesh(g, mat);
}

function add(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Плоская развёртка UV сверху (как у верхней грани BoxGeometry). */
function planarUV(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), 1 - (pos.getZ(i) - bb.min.z) / (bb.max.z - bb.min.z));
  }
}

interface ShockRig {
  g: THREE.Group;
  coil: THREE.Mesh;
  rod: THREE.Mesh;
  body: THREE.Mesh;
  capTop: THREE.Mesh;
  capBot: THREE.Mesh;
  eyeTop: THREE.Mesh;
}

interface WheelRig {
  root: THREE.Group;
  spinner: THREE.Group;
  discMat: THREE.MeshStandardMaterial;
}

interface ArmRig {
  g: THREE.Group;
  beam: THREE.Mesh;
  L: number;
}

/** Литой рычаг подвески: бобышки шарнира и оси, зауженная талия и облегчающий паз. */
function buildSwingarm(mat: THREE.Material, mats: Mats, L: number): ArmRig {
  const g = new THREE.Group();
  const r0 = 0.021;
  const r1 = 0.019;
  const sh = new THREE.Shape();
  sh.absarc(0, 0, r0, Math.PI, Math.PI * 2, false);
  sh.quadraticCurveTo(0.009, L * 0.5, r1, L);
  sh.absarc(0, L, r1, 0, Math.PI, false);
  sh.quadraticCurveTo(-0.009, L * 0.5, -r0, 0);
  const slot = new THREE.Path();
  slot.absarc(0, L * 0.38, 0.0042, Math.PI, Math.PI * 2, false);
  slot.lineTo(0.0042, L * 0.64);
  slot.absarc(0, L * 0.64, 0.0042, 0, Math.PI, false);
  slot.closePath();
  sh.holes.push(slot);
  const beam = new THREE.Mesh(extrudeZ(sh, 0.013, 0.003, 10), mat);
  g.add(beam);
  const bolt = new THREE.Mesh(cylZ(0.0085, 0.019, 6), mats.chrome);
  g.add(bolt);
  return { g, beam, L };
}

function placeArm(arm: ArmRig, p1: { x: number; y: number }, p2: { x: number; y: number }, z: number) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  arm.g.position.set(p1.x, p1.y, z);
  arm.g.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
  arm.beam.scale.y = Math.max(0.3, Math.hypot(dx, dy) / arm.L);
}

function buildWheel(look: Look, tune: Tune, R: number, rear: boolean, mats: Mats, motor: boolean, zA: number): WheelRig {
  const root = new THREE.Group();
  const spinner = new THREE.Group();
  root.add(spinner);

  const width = 0.084 * (R / 0.1325);
  const hw = width / 2;
  const rimR = R - R * 0.33 + 0.007;
  const sec = R - rimR;

  // 1. Бескамерная покрышка с настоящим профилем: борт, выпуклая боковина, плечо и беговая дорожка
  const half: Pt[] = [
    [rimR - 0.004, -0.34 * width],
    [rimR + 0.18 * sec, -0.47 * width],
    [rimR + 0.55 * sec, -0.5 * width],
    [R - 0.16 * sec, -0.44 * width],
    [R - 0.03 * sec, -0.3 * width],
    [R, -0.12 * width],
  ];
  const tirePts = [...half, ...half.map(([r, h]) => [r, -h] as Pt).reverse()];
  add(lathe(tirePts, 44, 0, Math.PI * 2, 26), mats.rubber, spinner);

  // 2. Протектор
  const treadKind = look.tire === 'off' ? 'knob' : look.tire === 'semi' ? 'fine' : 'none';
  if (treadKind !== 'none') {
    const knob = treadKind === 'knob';
    const n = knob ? 30 : 44;
    const rows = knob ? 3 : 2;
    const g = knob ? new THREE.BoxGeometry(0.03, 0.012, width * 0.27) : new THREE.BoxGeometry(0.009, 0.006, width * 0.4);
    const im = new THREE.InstancedMesh(g, mats.tread, n * rows);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qY = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const yAxis = new THREE.Vector3(0, 1, 0);
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < n; i++) {
        const phase = knob ? (r === 1 ? 0.5 : r * 0.25) : r * 0.5;
        const a = (i + phase) * ((Math.PI * 2) / n);
        const zz = knob ? (r - 1) * width * 0.29 : (r === 0 ? -1 : 1) * width * 0.2;
        const rad = knob && r !== 1 ? R - 0.0065 : R - 0.002;
        p.set(Math.cos(a) * rad, Math.sin(a) * rad, zz);
        const chev = knob ? (r - 1) * 0.22 : r === 0 ? 0.32 : -0.32;
        q.setFromAxisAngle(zAxis, a - Math.PI / 2);
        q.multiply(qY.setFromAxisAngle(yAxis, chev));
        // Боковые шашки наклонены по плечу покрышки
        if (knob && r !== 1) q.multiply(qY.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (r - 1) * -0.32));
        sc.set(knob && r === 1 ? 1.12 : 0.9, 1, 1);
        m.compose(p, q, sc);
        im.setMatrixAt(idx++, m);
      }
    }
    spinner.add(im);
  } else {
    // Дорожная шина: продольные водоотводные канавки
    for (const gz of [-0.17, 0, 0.17]) {
      const groove = add(new THREE.TorusGeometry(R - 0.0006 - Math.abs(gz) * 0.012, 0.0016, 5, 56), mats.tread, spinner);
      groove.position.z = gz * width;
    }
  }

  // 3. Обод с бортовыми закраинами
  const k = 0.37 * width;
  add(
    lathe(
      [
        [rimR + 0.004, -k],
        [rimR - 0.006, -0.3 * width],
        [rimR - 0.011, 0],
        [rimR - 0.006, 0.3 * width],
        [rimR + 0.004, k],
        [rimR + 0.004, k + 0.004],
        [rimR - 0.007, k + 0.004],
        [rimR - 0.015, 0.3 * width],
        [rimR - 0.019, 0],
        [rimR - 0.015, -0.3 * width],
        [rimR - 0.007, -k - 0.004],
        [rimR + 0.004, -k - 0.004],
        [rimR + 0.004, -k],
      ],
      48,
    ),
    mats.rim,
    spinner,
  );
  for (const s of [-1, 1]) {
    const tape = add(new THREE.RingGeometry(rimR - 0.0045, rimR + 0.0025, 48), mats.rimTape, spinner, 0, 0, s * (k + 0.0046));
    if (s < 0) tape.rotation.y = Math.PI;
  }
  // Вентиль
  const valve = add(new THREE.CylinderGeometry(0.0028, 0.0028, 0.022, 6), mats.chrome, spinner, 0, rimR - 0.027, hw * 0.35);
  valve.rotation.x = 0.5;

  // 4. Мотор-колесо (статор закрыт литыми крышками) или лёгкая литая ступица со спицами
  const rimIn = rimR - 0.017;
  if (motor) {
    const hubR = rimR * 0.74;
    const m = width * 0.36;
    add(
      lathe(
        [
          [0.012, -m - 0.004],
          [hubR * 0.45, -m - 0.004],
          [hubR * 0.8, -m],
          [hubR * 0.97, -m + 0.008],
          [hubR, -m + 0.016],
          [hubR, m - 0.016],
          [hubR * 0.97, m - 0.008],
          [hubR * 0.8, m],
          [hubR * 0.45, m + 0.004],
          [0.012, m + 0.004],
        ],
        40,
      ),
      mats.motor,
      spinner,
    );
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      const web = add(
        plate(
          [
            [hubR - 0.006, -0.017],
            [rimIn + 0.004, -0.012],
            [rimIn + 0.004, 0.012],
            [hubR - 0.006, 0.017],
          ],
          width * 0.34,
          0.003,
          0.003,
        ),
        mats.rim,
        spinner,
      );
      web.rotation.z = a;
    }
    for (const s of [-1, 1]) {
      const zc = s * (m + 0.004);
      const ring = add(new THREE.RingGeometry(hubR * 0.3, hubR * 0.4, 28), mats.rimTape, spinner, 0, 0, zc + s * 0.0006);
      if (s < 0) ring.rotation.y = Math.PI;
      for (let b = 0; b < 8; b++) {
        const ba = (b / 8) * Math.PI * 2;
        add(cylZ(0.0034, 0.005, 6), mats.chrome, spinner, Math.cos(ba) * hubR * 0.86, Math.sin(ba) * hubR * 0.86, s * (m - 0.004));
      }
      for (let f = 0; f < 16; f++) {
        const fa = (f / 16) * Math.PI * 2;
        const fin = add(new THREE.BoxGeometry(hubR * 0.3, 0.003, 0.003), mats.motor, spinner, Math.cos(fa) * hubR * 0.6, Math.sin(fa) * hubR * 0.6, zc);
        fin.rotation.z = fa;
      }
    }
  } else {
    const m = width * 0.32;
    add(
      lathe(
        [
          [0.012, -m],
          [0.03, -m],
          [0.034, -m + 0.006],
          [0.026, -m + 0.016],
          [0.026, m - 0.016],
          [0.034, m - 0.006],
          [0.03, m],
          [0.012, m],
        ],
        24,
      ),
      mats.rim,
      spinner,
    );
    for (let i = 0; i < 5; i++) {
      const baseA = (i / 5) * Math.PI * 2;
      for (const fork of [-0.2, 0.2]) {
        const sp = add(
          plate(
            [
              [0.022, -0.008],
              [rimIn + 0.004, -0.0055],
              [rimIn + 0.004, 0.0055],
              [0.022, 0.008],
            ],
            width * 0.26,
            0.002,
            0.003,
          ),
          mats.rim,
          spinner,
        );
        sp.rotation.z = baseA + fork;
      }
    }
  }

  // 5. Вентилируемый тормозной диск с настоящими отверстиями и паук-адаптер
  const rotorR = Math.min(tune.rotor / 2000, rimR - 0.006);
  const discZ = -(hw + 0.012);
  const discMat = new THREE.MeshStandardMaterial({
    color: '#c9cfd6',
    metalness: 1,
    roughness: 0.3,
    emissive: new THREE.Color('#ff4800'),
    emissiveIntensity: 0,
    envMap: mats.chrome.envMap,
  });
  const circle = <T extends THREE.Path>(path: T, cx: number, cy: number, r: number, n: number): T => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (i === 0) path.moveTo(cx + r, cy);
      else path.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    path.closePath();
    return path;
  };
  const rotor = circle(new THREE.Shape(), 0, 0, rotorR, 44);
  rotor.holes.push(circle(new THREE.Path(), 0, 0, rotorR * 0.64, 36));
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const rr = rotorR * (i % 2 ? 0.76 : 0.89);
    rotor.holes.push(circle(new THREE.Path(), Math.cos(a) * rr, Math.sin(a) * rr, rotorR * 0.045, 8));
  }
  add(extrudeZ(rotor, 0.0026, 0, 1), discMat, spinner, 0, 0, discZ);

  const star: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    for (const [da, rr] of [
      [-0.3, 0.3],
      [-0.1, 0.69],
      [0.1, 0.69],
      [0.3, 0.3],
    ]) {
      star.push([Math.cos(a + da) * rotorR * rr, Math.sin(a + da) * rotorR * rr]);
    }
  }
  add(plate(star, 0.0034, 0.004, 0), mats.metal, spinner, 0, 0, discZ);
  add(cylZ(rotorR * 0.3, 0.02, 20), mats.metal, spinner, 0, 0, discZ + 0.009);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(cylZ(0.003, 0.003, 6), mats.chrome, spinner, Math.cos(a) * rotorR * 0.6, Math.sin(a) * rotorR * 0.6, discZ - 0.003);
  }

  // 6. Суппорт на кронштейне от рычага подвески
  const calGroup = new THREE.Group();
  const ca = rear ? Math.PI * 0.22 : Math.PI * 0.78;
  const calRad = rotorR - 0.006;
  calGroup.position.set(Math.cos(ca) * calRad, Math.sin(ca) * calRad, discZ);
  calGroup.rotation.z = ca - Math.PI / 2;
  const four = tune.brakeType === 'hyd4';
  const calLen = four ? 0.062 : 0.05;
  add(rbox(calLen, 0.034, 0.03, 0.009, 'z', 0.003), mats.caliper, calGroup, 0, 0.002, -0.001);
  // Прорезь под диск и колодки
  add(new THREE.BoxGeometry(calLen * 0.7, 0.02, 0.006), mats.plastic, calGroup, 0, -0.009, 0);
  add(
    plate(
      [
        [-0.011, -calRad - 0.014],
        [0.011, -calRad - 0.014],
        [0.018, -0.006],
        [-0.018, -0.006],
      ],
      0.006,
      0.006,
      0.0015,
    ),
    mats.metal,
    calGroup,
    0,
    0,
    -0.017,
  );
  const nPistons = four ? 2 : 1;
  for (let p = 0; p < nPistons; p++) {
    const px = nPistons === 2 ? (p === 0 ? -0.014 : 0.014) : 0;
    add(cylZ(0.0088, 0.004, 14), mats.metal, calGroup, px, 0.003, -0.0165);
    add(cylZ(0.0035, 0.006, 6), mats.chrome, calGroup, px, 0.003, -0.018);
  }
  if (tune.brakeType !== 'mech') {
    // Банджо-болт и начало тормозного шланга
    add(cylZ(0.0042, 0.012, 6), mats.chrome, calGroup, calLen * 0.36, 0.014, -0.012);
    const hose = add(new THREE.CylinderGeometry(0.0028, 0.0028, 0.05, 6), mats.rubber, calGroup, calLen * 0.36, 0.036, -0.012);
    hose.rotation.z = 0.25;
  }
  root.add(calGroup);

  // Ось, шайбы и гайки снаружи рычагов
  add(cylZ(0.0075, 2 * (zA + 0.016), 10), mats.chrome, root);
  for (const s of [-1, 1]) {
    add(cylZ(0.015, 0.003, 16), mats.metal, root, 0, 0, s * (zA + 0.008));
    add(cylZ(0.0115, 0.009, 6), mats.metal, root, 0, 0, s * (zA + 0.0135));
  }

  // 7. Штампованное крыло с отбортовкой
  if (look.fender) {
    const rf = R + 0.02;
    const fw = width * 0.58;
    const start = Math.PI * (rear ? 0.78 : 0.76);
    const len = Math.PI * (rear ? 0.72 : 0.76);
    add(
      lathe(
        [
          [rf - 0.014, -fw - 0.001],
          [rf - 0.003, -fw + 0.004],
          [rf, -fw * 0.62],
          [rf + 0.002, 0],
          [rf, fw * 0.62],
          [rf - 0.003, fw - 0.004],
          [rf - 0.014, fw + 0.001],
          [rf - 0.014, fw - 0.002],
          [rf - 0.006, fw - 0.007],
          [rf - 0.003, 0],
          [rf - 0.006, -fw + 0.007],
          [rf - 0.014, -fw + 0.002],
          [rf - 0.014, -fw - 0.001],
        ],
        30,
        start,
        len,
      ),
      mats.fender,
      root,
    );

    // Кронштейны крыла от оси
    const stayPhi = Math.PI * (rear ? 1.22 : 1.2);
    const sx = Math.sin(stayPhi);
    const sy = -Math.cos(stayPhi);
    for (const s of [-1, 1]) {
      const stay = add(new THREE.CylinderGeometry(0.0032, 0.0032, rf - 0.02, 6), mats.plastic, root, sx * (rf * 0.5 + 0.004), sy * (rf * 0.5 + 0.004), s * (fw + 0.002));
      stay.rotation.z = Math.atan2(sy, sx) - Math.PI / 2;
    }

    if (rear) {
      // Задний фонарь на крыле
      const tp = Math.PI * 1.36;
      const tx = Math.sin(tp);
      const ty = -Math.cos(tp);
      const housing = add(rbox(0.016, 0.034, width * 0.82, 0.005, 'z', 0.002), mats.plastic, root, tx * (rf + 0.007), ty * (rf + 0.007), 0);
      housing.rotation.z = Math.atan2(ty, tx);
      const lens = add(rbox(0.008, 0.022, width * 0.7, 0.004, 'z', 0.002), mats.tail, root, tx * (rf + 0.014), ty * (rf + 0.014), 0);
      lens.rotation.z = Math.atan2(ty, tx);
    }
  }

  return { root, spinner, discMat };
}

export function buildScooter(look: Look, tune: Tune): ScooterRig {
  const model = MODELS[look.model] ?? MODELS.g2;
  if (model.kind === 'pitbike') return buildPitBike(look, tune);
  const isG2 = look.model === 'g2';
  const isG2Max = look.model === 'g2max';
  const isG3Pro = look.model === 'g3pro';
  const isG4 = look.model === 'g4';

  const R = look.wheel * 0.0254 * 0.52;
  const W = model.deckW;
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

  const mats: Mats = {
    frame: std(look.frame, 0.38, 0.72),
    accent: std(look.accent, 0.36, 0.55),
    caliper: std(look.accent, 0.42, 0.3),
    rimTape: new THREE.MeshStandardMaterial({
      color: look.accent,
      roughness: 0.4,
      metalness: 0.3,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
    stem: std(look.stem, 0.42, 0.7),
    rim: std(look.rim, 0.36, 0.78),
    rubber: std('#17181b', 0.86, 0.0),
    tread: std('#101113', 0.94, 0.0),
    metal: std('#80868f', 0.34, 0.95),
    chrome: std('#e4e9ee', 0.1, 1.0),
    motor: std('#1b1d21', 0.52, 0.6),
    plastic: std('#0c0d0f', 0.62, 0.05, true),
    grip: std('#151618', 0.92, 0),
    fender: std('#101114', 0.5, 0.08, true),
    light: glowMat(look.lightColor, 2.8),
    drl: glowMat(look.accent, 1.6),
    tail: glowMat('#ff1616', 2.2),
    amber: std('#ff8a1e', 0.35, 0.1),
    spring: std(look.accent, 0.34, 0.6),
    dark: std('#111316', 0.5, 0.45, true),
  };
  for (const m of Object.values(mats)) m.envMap = env;
  const envBase = new Map<THREE.MeshStandardMaterial, number>();
  const textures: THREE.Texture[] = [];

  const root = new THREE.Group();
  const lean = new THREE.Group();
  const body = new THREE.Group();
  const frame = new THREE.Group();
  root.add(lean);
  lean.add(body);
  body.add(frame);

  // Поперечная компоновка подвески: щёки рамы/вилки → рычаги → пружины
  const tireW = 0.084 * (R / 0.1325);
  const zP = tireW * 0.58 + 0.009;
  const zA = zP + 0.013;
  const zS = zA + 0.006;

  // ==================================================================
  // 1. ДЕКА: ЭКСТРУЗИЯ СО СКРУГЛЁННЫМИ КРОМКАМИ, КОВРИК, БОКОВЫЕ ПАНЕЛИ
  // ==================================================================
  const deckL = Math.max(0.65, model.deckLen * 0.71);
  const deckH = isG4 ? 0.082 : isG2Max || isG3Pro ? 0.078 : 0.072;
  const deckX = -0.015;
  const deckY = DECK_TOP - deckH / 2;
  const deckBot = DECK_TOP - deckH;
  const deckFront = deckX + deckL / 2;
  const deckRear = deckX - deckL / 2;

  add(rbox(deckL, deckH, W, 0.016, 'x', 0.005), mats.frame, frame, deckX, deckY, 0);

  // Рельефный резиновый коврик с логотипом модели
  const gripTex = deckGripTexture(model.label, look.accent);
  textures.push(gripTex);
  const gripMat = new THREE.MeshStandardMaterial({ map: gripTex, roughness: 0.92, metalness: 0.02 });
  const matGeo = rbox(deckL - 0.085, 0.006, W - 0.028, 0.024, 'y', 0.002);
  planarUV(matGeo);
  add(matGeo, gripMat, frame, deckX - 0.03, DECK_TOP + 0.002, 0);

  const decalTex = decalTexture(model.label, look.accent, true);
  textures.push(decalTex);
  const decalMat = new THREE.MeshBasicMaterial({
    map: decalTex,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    toneMapped: false,
  });
  const panelH = deckH - 0.034;
  for (const s of [-1, 1]) {
    // Утопленная боковая панель с логотипом и светодиодной линией под ней
    add(rbox(deckL * 0.82, panelH, 0.003, 0.007, 'z', 0.001), mats.plastic, frame, deckX - 0.012, deckY + 0.003, s * (W / 2 + 0.0002));
    const d = add(new THREE.PlaneGeometry(panelH * 7.6, panelH * 0.98), decalMat, frame, deckX - 0.012, deckY + 0.003, s * (W / 2 + 0.0022));
    if (s < 0) d.rotation.y = Math.PI;
    add(
      rbox(deckL * 0.84, isG3Pro || isG4 ? 0.006 : 0.0045, 0.004, 0.002, 'z', 0.001),
      look.glow || isG3Pro ? mats.drl : mats.accent,
      frame,
      deckX - 0.012,
      deckBot + 0.0125,
      s * (W / 2 - 0.0008),
    );

    // Габаритные огни по углам деки
    add(rbox(0.008, 0.016, 0.03, 0.004, 'x', 0.002), mats.light, frame, deckFront - 0.001, deckY + 0.006, s * (W / 2 - 0.034));
    add(rbox(0.008, 0.018, 0.034, 0.004, 'x', 0.002), mats.tail, frame, deckRear + 0.001, deckY - 0.004, s * (W / 2 - 0.03));
    // Боковые катафоты
    add(rbox(0.03, 0.012, 0.003, 0.003, 'z', 0.001), mats.amber, frame, deckFront - 0.035, deckY + 0.003, s * (W / 2 + 0.0006));
  }
  // Зарядный порт с резиновой заглушкой (правый борт)
  add(cylZ(0.012, 0.004, 18), mats.metal, frame, deckRear + 0.03, deckY + 0.003, W / 2 + 0.001);
  add(cylZ(0.009, 0.006, 14), mats.rubber, frame, deckRear + 0.03, deckY + 0.003, W / 2 + 0.002);

  // Защита днища и оребрённый батарейный бокс у старших моделей
  add(rbox(deckL * 0.9, 0.008, W * 0.8, 0.003, 'x', 0.002), mats.dark, frame, deckX, deckBot - 0.002, 0);
  if (model.batteryBox) {
    add(rbox(deckL * 0.76, 0.03, W * 0.82, 0.008, 'x', 0.004), mats.dark, frame, deckX - 0.01, deckBot - 0.016, 0);
    for (let f = -4; f <= 4; f++) {
      add(new THREE.BoxGeometry(0.008, 0.007, W * 0.78), mats.metal, frame, deckX - 0.01 + f * 0.05, deckBot - 0.033, 0);
    }
  }

  // Задний упор для ноги: наклонная плита с резиновой накладкой
  const kickStartX = deckRear + 0.03;
  const kickGroup = new THREE.Group();
  kickGroup.position.set(kickStartX, DECK_TOP - 0.004, 0);
  kickGroup.rotation.z = -0.44;
  frame.add(kickGroup);
  const kickW = W * 0.86;
  add(rbox(0.185, 0.016, kickW, 0.007, 'z', 0.003), isG2 ? mats.stem : mats.frame, kickGroup, -0.07, 0.006, 0);
  add(rbox(0.13, 0.005, kickW - 0.03, 0.002, 'z', 0.002), mats.rubber, kickGroup, -0.078, 0.016, 0);
  for (let i = 0; i < 5; i++) {
    add(rbox(0.008, 0.005, kickW - 0.05, 0.002, 'z', 0.001), mats.rubber, kickGroup, -0.03 - i * 0.024, 0.02, 0);
  }
  // Отогнутая задняя кромка
  const kickLip = add(rbox(0.03, 0.014, kickW, 0.006, 'z', 0.003), isG2 ? mats.stem : mats.frame, kickGroup, -0.168, 0.014, 0);
  kickLip.rotation.z = -0.55;
  if (isG2) {
    // Фирменная широкая LED стоп-полоса Kukirin G2
    add(rbox(0.006, 0.01, kickW * 0.72, 0.003, 'x', 0.001), mats.tail, kickGroup, -0.166, 0.002, 0);
  }

  // Подрамник задней подвески: щёки с шарниром маятника и верхним ухом пружины
  const topR = { x: -0.435, y: 0.226 };
  for (const s of [-1, 1]) {
    add(
      plate(
        [
          [-0.3, 0.2],
          [-0.3, 0.146],
          [-0.375, 0.152],
          [-0.394, 0.176],
          [-0.458, 0.214],
          [-0.458, 0.252],
          [-0.42, 0.244],
        ],
        0.008,
        0.012,
        0.002,
      ),
      mats.frame,
      frame,
      0,
      0,
      s * zP,
    );
    add(cylZ(0.006, zS - zP + 0.014, 8), mats.chrome, frame, topR.x, topR.y, s * (zP + (zS - zP + 0.014) / 2 - 0.002));
  }
  add(cylZ(0.008, 2 * zA + 0.02, 10), mats.chrome, frame, PR.x, PR.y, 0);
  add(cylZ(0.013, 2 * zP, 12), mats.dark, frame, PR.x, PR.y, 0);

  // Откидная подножка слева
  const kickstandPivot = new THREE.Group();
  const standY = deckBot + 0.006;
  kickstandPivot.position.set(-0.1, standY, -(W / 2 - 0.014));
  frame.add(kickstandPivot);
  add(cylZ(0.009, 0.02, 10), mats.metal, kickstandPivot);
  {
    const end = new THREE.Vector3(-0.034, -(standY - 0.006), -0.06);
    const leg = add(new THREE.CylinderGeometry(0.0062, 0.0055, end.length(), 8), mats.stem, kickstandPivot, end.x / 2, end.y / 2, end.z / 2);
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().normalize());
    add(rbox(0.04, 0.006, 0.026, 0.008, 'y', 0.002), mats.plastic, kickstandPivot, end.x - 0.004, end.y, end.z - 0.004);
  }

  // ==================================================================
  // 2. ГУСЬ РАМЫ И РУЛЕВОЙ СТАКАН
  // ==================================================================
  const ax = { x: -Math.sin(TILT), y: Math.cos(TILT) }; // ось рулевой колонки
  const neckW = isG4 ? 0.084 : isG3Pro ? 0.076 : 0.07;
  const htTop = { x: B.x + ax.x * 0.13, y: B.y + ax.y * 0.13 };
  const htBot = { x: B.x + ax.x * 0.012, y: B.y + ax.y * 0.012 };
  add(
    plate(
      [
        [0.243, DECK_TOP - 0.002],
        [htTop.x - 0.036, htTop.y - 0.004],
        [htTop.x, htTop.y - 0.002],
        [htBot.x, htBot.y],
        [0.38, 0.289],
        [0.338, 0.208],
        [0.326, deckBot + 0.004],
        [0.22, deckBot + 0.004],
      ],
      neckW,
      0.02,
      0.007,
    ),
    isG2 ? mats.stem : mats.frame,
    frame,
  );
  for (const s of [-1, 1]) {
    // Фрезерованная вставка на щеке гуся
    add(
      plate(
        [
          [0.292, 0.232],
          [0.378, 0.354],
          [0.394, 0.312],
          [0.342, 0.236],
        ],
        0.003,
        0.008,
        0.001,
      ),
      isG3Pro ? mats.drl : mats.accent,
      frame,
      0,
      0,
      s * (neckW / 2 + 0.0008),
    );
    for (const [bx, by] of [
      [0.275, 0.2],
      [0.345, 0.185],
      [0.385, 0.375],
    ]) {
      add(cylZ(0.0055, 0.004, 6), mats.chrome, frame, bx, by, s * (neckW / 2 + 0.0015));
    }
  }
  const headTube = add(new THREE.CylinderGeometry(0.037, 0.037, 0.118, 24), isG2 ? mats.stem : mats.frame, frame, B.x + ax.x * 0.071, B.y + ax.y * 0.071, 0);
  headTube.rotation.z = TILT;

  // ==================================================================
  // 3. РУЛЕВАЯ КОЛОНКА, ВИЛКА, ФАРА, СТОЙКА И КОКПИТ
  // ==================================================================
  const steerPivot = new THREE.Group();
  steerPivot.position.set(B.x, B.y, 0);
  steerPivot.rotation.z = TILT;
  frame.add(steerPivot);
  const steer = new THREE.Group();
  steerPivot.add(steer);

  // Чашки рулевых подшипников
  add(new THREE.CylinderGeometry(0.04, 0.036, 0.022, 24), mats.metal, steer, 0, 0.001, 0);
  add(new THREE.CylinderGeometry(0.036, 0.04, 0.02, 24), mats.metal, steer, 0, 0.14, 0);

  // Нижняя траверса и щёки вилки с шарниром рычага и ухом пружины
  const PFs = rotNeg(PF.x - B.x, PF.y - B.y, TILT);
  const topF = { x: 0.045, y: 0.055 };
  add(rbox(0.074, 0.034, 2 * zP + 0.008, 0.011, 'z', 0.003), mats.stem, steer, 0.002, -0.028, 0);
  for (const s of [-1, 1]) {
    add(
      plate(
        [
          [-0.072, -0.116],
          [-0.03, -0.118],
          [-0.006, -0.07],
          [0.008, 0.018],
          [0.05, 0.034],
          [0.066, 0.056],
          [0.05, 0.078],
          [0.022, 0.074],
          [-0.02, 0.022],
          [-0.036, -0.02],
          [-0.076, -0.074],
        ],
        0.008,
        0.012,
        0.002,
      ),
      mats.stem,
      steer,
      0,
      0,
      s * zP,
    );
    add(cylZ(0.006, zS - zP + 0.014, 8), mats.chrome, steer, topF.x, topF.y, s * (zP + (zS - zP + 0.014) / 2 - 0.002));
    // Катафот на щеке вилки
    add(rbox(0.01, 0.03, 0.003, 0.003, 'z', 0.001), mats.amber, steer, -0.03, -0.062, s * (zP + 0.0045)).rotation.z = 0.5;
  }
  add(cylZ(0.008, 2 * zA + 0.02, 10), mats.chrome, steer, PFs.x, PFs.y, 0);
  add(cylZ(0.013, 2 * zP, 12), mats.dark, steer, PFs.x, PFs.y, 0);

  // Фара на кронштейне траверсы
  const lampY = 0.108;
  add(rbox(0.012, 0.1, 0.034, 0.004, 'z', 0.002), mats.stem, steer, 0.043, 0.03, 0);
  if (isG2) {
    // Широкая линейная LED-фара Kukirin G2
    add(rbox(0.05, 0.05, 0.132, 0.014, 'x', 0.006), mats.plastic, steer, 0.066, lampY, 0);
    add(rbox(0.006, 0.028, 0.112, 0.008, 'x', 0.002), mats.light, steer, 0.0905, lampY, 0);
    add(rbox(0.004, 0.038, 0.122, 0.012, 'x', 0.001), mats.chrome, steer, 0.0885, lampY, 0);
  } else {
    // Двойная линзованная оптика с хромированными ободками
    add(rbox(0.052, 0.058, 0.128, 0.018, 'x', 0.006), mats.plastic, steer, 0.066, lampY, 0);
    for (const s of [-1, 1]) {
      const bezel = add(new THREE.TorusGeometry(0.021, 0.0035, 8, 24), isG3Pro || isG4 ? mats.drl : mats.chrome, steer, 0.092, lampY, s * 0.032);
      bezel.rotation.y = Math.PI / 2;
      const lens = add(new THREE.SphereGeometry(0.0195, 16, 12), mats.light, steer, 0.089, lampY, s * 0.032);
      lens.scale.set(0.4, 1, 1);
    }
  }

  const headlight = new THREE.SpotLight(look.lightColor, 0, 52, 0.55, 0.55, 1.5);
  headlight.position.set(0.095, 0.115, 0);
  const hlTarget = new THREE.Object3D();
  hlTarget.position.set(4.5, -0.65, 0);
  steer.add(headlight, hlTarget);
  headlight.target = hlTarget;

  // Складной узел и рулевая стойка
  const stemLen = model.stemH;
  const ytop = 0.13 + stemLen;
  add(new THREE.CylinderGeometry(0.031, 0.034, 0.05, 20), mats.stem, steer, 0, 0.172, 0);
  add(rbox(0.074, 0.06, model.dualStem ? 0.14 : 0.066, 0.014, 'z', 0.004), mats.stem, steer, 0.002, 0.222, 0);
  add(cylZ(0.011, model.dualStem ? 0.15 : 0.078, 12), mats.metal, steer, -0.04, 0.2, 0);
  const foldLever = add(rbox(0.014, 0.085, 0.024, 0.006, 'z', 0.002), mats.accent, steer, 0.047, 0.238, 0);
  foldLever.rotation.z = -0.1;
  add(cylZ(0.006, 0.05, 8), mats.chrome, steer, 0.043, 0.2, 0);

  const tubes = model.dualStem ? [-0.048, 0.048] : [0];
  const rTube = model.dualStem ? 0.019 : 0.0245;
  for (const z of tubes) {
    const t = unitCyl(rTube, mats.stem, 24);
    t.position.set(0, 0.24, z);
    t.scale.y = ytop - 0.24;
    steer.add(t);
    // Хомут телескопической секции
    add(new THREE.CylinderGeometry(rTube + 0.004, rTube + 0.004, 0.03, 20), mats.metal, steer, 0, ytop - 0.11, z);
  }
  if (model.dualStem) {
    for (const cy of [0.3, 0.56, ytop - 0.03]) {
      add(rbox(0.058, 0.03, 0.15, 0.012, 'y', 0.003), cy === 0.56 ? mats.accent : mats.stem, steer, 0.002, cy, 0);
    }
  }

  // Вертикальный логотип Kukirin, обёрнутый вокруг трубы стойки
  const stemTex = stemDecalTexture(look.accent, model.label === 'G2' ? 'Kukirin G2' : `Kukirin ${model.label}`);
  textures.push(stemTex);
  stemTex.center.set(0.5, 0.5);
  stemTex.rotation = Math.PI / 2;
  const stemDecalMat = new THREE.MeshBasicMaterial({
    map: stemTex,
    transparent: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  for (const s of [1, -1]) {
    const arc = 0.04 / (rTube + 0.0006);
    const g = new THREE.CylinderGeometry(rTube + 0.0006, rTube + 0.0006, 0.46, 12, 1, true, (s > 0 ? 0 : Math.PI) - arc / 2, arc);
    add(g, stemDecalMat, steer, 0, 0.58, model.dualStem ? s * 0.048 : 0);
  }

  // Вынос с четырёхболтовой крышкой и руль
  const half = model.hbarW / 2;
  const barY = ytop + 0.018;
  add(rbox(0.062, 0.056, model.dualStem ? 0.14 : 0.07, 0.012, 'z', 0.004), mats.stem, steer, 0.004, ytop + 0.006, 0);
  add(rbox(0.014, 0.046, model.dualStem ? 0.13 : 0.064, 0.008, 'x', 0.003), mats.metal, steer, 0.036, barY, 0);
  for (const bz of [-0.022, 0.022]) {
    for (const by of [-0.015, 0.015]) add(new THREE.CylinderGeometry(0.004, 0.004, 0.006, 6).rotateZ(Math.PI / 2), mats.chrome, steer, 0.0445, barY + by, bz);
  }
  add(cylZ(0.0125, model.hbarW, 16), mats.stem, steer, 0.008, barY, 0);

  const gripL = new THREE.Object3D();
  const gripR = new THREE.Object3D();
  const brakeLevers: THREE.Group[] = [];
  const gripGeo = () =>
    lathe(
      [
        [0.0125, -0.061],
        [0.022, -0.061],
        [0.022, -0.054],
        [0.0178, -0.05],
        [0.0192, -0.02],
        [0.0178, 0.012],
        [0.0188, 0.04],
        [0.0205, 0.056],
        [0.0205, 0.061],
        [0.0125, 0.061],
      ],
      18,
    );

  for (const s of [-1, 1]) {
    // Эргономичная грипса с упором и заглушкой торца
    const g = add(gripGeo(), mats.grip, steer, 0.008, barY, s * (half - 0.061));
    if (s < 0) g.rotation.y = Math.PI;
    add(cylZ(0.0135, 0.004, 14), mats.metal, steer, 0.008, barY, s * (half + 0.001));
    add(cylZ(0.0215, 0.007, 16), mats.metal, steer, 0.008, barY, s * (half - 0.1255));

    // Тормозная машинка: хомут, корпус, бачок
    const masterZ = s * (half - 0.168);
    add(cylZ(0.0165, 0.016, 14), mats.dark, steer, 0.008, barY, masterZ);
    add(rbox(0.04, 0.022, 0.03, 0.007, 'z', 0.003), mats.dark, steer, 0.03, barY + 0.002, masterZ);
    if (tune.brakeType !== 'mech') {
      add(rbox(0.026, 0.016, 0.036, 0.006, 'y', 0.003), mats.dark, steer, 0.03, barY + 0.02, masterZ);
      add(rbox(0.02, 0.003, 0.03, 0.005, 'y', 0.001), mats.metal, steer, 0.03, barY + 0.029, masterZ);
    }

    // Анимированный тормозной рычаг: изогнутая лопатка перед грипсой
    const leverPivot = new THREE.Group();
    leverPivot.position.set(0.04, barY - 0.004, s * (half - 0.155));
    steer.add(leverPivot);
    const blade = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.016, 0, s * 0.018),
      new THREE.Vector3(0.022, -0.002, s * 0.055),
      new THREE.Vector3(0.016, -0.004, s * 0.1),
    ]);
    const bladeMesh = add(new THREE.TubeGeometry(blade, 14, 0.0048, 6), mats.metal, leverPivot);
    bladeMesh.scale.y = 1.5;
    add(new THREE.SphereGeometry(0.0068, 10, 8), mats.metal, leverPivot, 0.016, -0.006, s * 0.1);
    add(new THREE.CylinderGeometry(0.0042, 0.0042, 0.018, 8), mats.chrome, leverPivot);
    brakeLevers.push(leverPivot);
  }

  // Пульт слева: свет, сигнал, поворотники
  const swZ = -(half - 0.136);
  add(rbox(0.036, 0.04, 0.026, 0.008, 'z', 0.003), mats.plastic, steer, 0.004, barY, swZ);
  add(rbox(0.009, 0.01, 0.012, 0.003, 'z', 0.001), mats.accent, steer, -0.016, barY + 0.008, swZ);
  add(rbox(0.009, 0.008, 0.012, 0.003, 'z', 0.001), mats.metal, steer, -0.016, barY - 0.006, swZ);
  // Звонок
  add(new THREE.SphereGeometry(0.017, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.chrome, steer, 0.004, barY + 0.012, -(half - 0.21));

  // Курок газа справа
  const throttlePivot = new THREE.Group();
  throttlePivot.position.set(0.008, barY, half - 0.136);
  steer.add(throttlePivot);
  add(cylZ(0.0205, 0.022, 16), mats.plastic, throttlePivot);
  const paddle = add(rbox(0.04, 0.01, 0.018, 0.004, 'z', 0.002), mats.accent, throttlePivot, -0.024, -0.014, 0);
  paddle.rotation.z = 0.35;

  gripL.position.set(0.008, barY, -(half - 0.061));
  gripR.position.set(0.008, barY, half - 0.061);
  steer.add(gripL, gripR);

  // Бортовой цветной LCD-дисплей по центру руля
  add(rbox(0.022, 0.034, 0.04, 0.006, 'z', 0.002), mats.stem, steer, -0.004, ytop + 0.04, 0);
  const dispG = new THREE.Group();
  dispG.position.set(isG2 ? 0.0 : -0.01, ytop + (isG2 ? 0.05 : 0.058), 0);
  dispG.rotation.z = isG2 ? -0.52 : -0.45;
  steer.add(dispG);
  add(rbox(0.02, 0.084, 0.15, 0.014, 'x', 0.004), mats.plastic, dispG);
  add(rbox(0.003, 0.074, 0.14, 0.01, 'x', 0.001), mats.dark, dispG, -0.0095, 0, 0);

  const dc = document.createElement('canvas');
  dc.width = 256;
  dc.height = 128;
  const dctx = dc.getContext('2d')!;
  const dispTex = new THREE.CanvasTexture(dc);
  dispTex.colorSpace = THREE.SRGBColorSpace;
  textures.push(dispTex);
  const screenMat = new THREE.MeshBasicMaterial({ map: dispTex, toneMapped: false });
  const screen = add(new THREE.PlaneGeometry(0.128, 0.064), screenMat, dispG, -0.0118, 0, 0);
  screen.rotation.y = -Math.PI / 2;

  // Тормозные шланги и жгут дисплея уходят в стойку
  for (const s of [-1, 1]) {
    const zCable = model.dualStem ? s * 0.03 : s * 0.012;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.05, barY + 0.002, s * (half - 0.168)),
      new THREE.Vector3(0.085, ytop - 0.05, s * (half - 0.2)),
      new THREE.Vector3(0.07, ytop - 0.2, s * 0.05),
      new THREE.Vector3(0.036, ytop - 0.34, zCable),
      new THREE.Vector3(0.03, 0.3, zCable),
    ]);
    add(new THREE.TubeGeometry(curve, 28, 0.0034, 6), mats.rubber, steer);
  }

  // ==================================================================
  // 4. КОЛЁСА, РЫЧАГИ И ПРУЖИННО-ГИДРАВЛИЧЕСКИЕ АМОРТИЗАТОРЫ
  // ==================================================================
  const wheelF = buildWheel(look, tune, R, false, mats, model.awd, zA);
  const wheelR = buildWheel(look, tune, R, true, mats, true, zA);
  steer.add(wheelF.root);
  frame.add(wheelR.root);

  const armMat = isG2 || isG2Max ? mats.accent : mats.frame;
  const wF0 = rotNeg(0.56 - B.x, R - B.y, TILT);
  const LF = Math.hypot(wF0.x - PFs.x, wF0.y - PFs.y);
  const LR = Math.hypot(-0.6 - PR.x, R - PR.y);
  const armFL = buildSwingarm(armMat, mats, LF);
  const armFR = buildSwingarm(armMat, mats, LF);
  const armRL = buildSwingarm(armMat, mats, LR);
  const armRR = buildSwingarm(armMat, mats, LR);
  steer.add(armFL.g, armFR.g);
  frame.add(armRL.g, armRR.g);

  const helixGeo = new THREE.TubeGeometry(new HelixCurve(0.0165, 7.5), 96, 0.0042, 6, false);
  const eyeGeo = cylZ(0.0095, 0.016, 12);
  const makeShock = (): ShockRig => {
    const g = new THREE.Group();
    const coil = new THREE.Mesh(helixGeo, mats.spring);
    const rod = unitCyl(0.0055, mats.chrome, 10);
    const bodyCyl = unitCyl(0.0118, mats.motor, 14);
    const capTop = unitCyl(0.0215, mats.metal, 18);
    const capBot = unitCyl(0.0215, mats.metal, 18);
    const eyeBot = new THREE.Mesh(eyeGeo, mats.metal);
    const eyeTop = new THREE.Mesh(eyeGeo, mats.metal);
    g.add(rod, bodyCyl, coil, capTop, capBot, eyeBot, eyeTop);
    return { g, coil, rod, body: bodyCyl, capTop, capBot, eyeTop };
  };
  const shocksF = [makeShock(), makeShock()];
  const shocksR = [makeShock(), makeShock()];
  shocksF.forEach((s) => steer.add(s.g));
  shocksR.forEach((s) => frame.add(s.g));

  const placeShock = (sh: ShockRig, pBot: { x: number; y: number }, pTop: { x: number; y: number }, z: number) => {
    const dx = pTop.x - pBot.x;
    const dy = pTop.y - pBot.y;
    const len = Math.max(0.07, Math.hypot(dx, dy));
    sh.g.position.set(pBot.x, pBot.y, z);
    sh.g.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;

    sh.rod.scale.set(1, len, 1);
    const bodyLen = Math.min(len * 0.5, 0.07);
    sh.body.position.y = len - bodyLen - 0.008;
    sh.body.scale.set(1, bodyLen, 1);

    sh.capBot.position.y = 0.014;
    sh.capBot.scale.set(1, 0.006, 1);
    sh.capTop.position.y = len - 0.022;
    sh.capTop.scale.set(1, 0.008, 1);
    sh.eyeTop.position.y = len;

    sh.coil.position.y = 0.02;
    sh.coil.scale.set(1, Math.max(0.02, len - 0.042), 1);
  };

  // Статичные детали каждого узла склеиваются по материалам
  const dynamic = new Set<THREE.Object3D>([
    steerPivot,
    wheelF.root,
    wheelR.root,
    wheelF.spinner,
    wheelR.spinner,
    kickstandPivot,
    throttlePivot,
    ...brakeLevers,
    ...[armFL, armFR, armRL, armRR].map((a) => a.g),
    ...[...shocksF, ...shocksR].map((s) => s.g),
  ]);
  for (const node of [frame, steer, wheelF.root, wheelR.root, wheelF.spinner, wheelR.spinner, kickstandPivot, throttlePivot, ...brakeLevers]) {
    bake(node, dynamic);
  }
  for (const m of [...Object.values(mats), wheelF.discMat, wheelR.discMat]) envBase.set(m, m.envMapIntensity);

  // Неоновая подсветка днища
  let glowLight: THREE.PointLight | null = null;
  if (look.glow) {
    const gt = glowTexture();
    textures.push(gt);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.25, W + 0.52),
      new THREE.MeshBasicMaterial({
        map: gt,
        color: look.glowColor,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(-0.02, 0.025, 0);
    frame.add(glow);
    glowLight = new THREE.PointLight(look.glowColor, 1.8, 3.8, 1.5);
    glowLight.position.set(-0.02, 0.1, 0);
    frame.add(glowLight);
  }

  // ==================================================================
  // 5. ЭФФЕКТ ИСКР ИЗ-ПОД ЗАДНЕГО КРЫЛА ПРИ ЭКСТРЕМАЛЬНОМ СТАНТЕ
  // ==================================================================
  const sparkGroup = new THREE.Group();
  sparkGroup.position.set(-0.68, 0.04, 0);
  sparkGroup.visible = false;
  frame.add(sparkGroup);
  const sparkMat = new THREE.MeshBasicMaterial({
    color: '#ffae2b',
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const sparks: THREE.Mesh[] = [];
  for (let i = 0; i < 14; i++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.008, 0.008), sparkMat);
    sparkGroup.add(sp);
    sparks.push(sp);
  }

  // ==================================================================
  // 6. РАЙДЕР И ТЕНИ
  // ==================================================================
  const rider = new Rider(look, DECK_TOP, kickStartX - 0.035);
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
  wheelF.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).receiveShadow = false) : 0));

  const tmpW = new THREE.Vector3();
  const tmpL = new THREE.Vector3();
  const tmpR = new THREE.Vector3();
  let lastDispKey = '';
  let sparkPhase = 0;

  const update = (s: VisualState, dt: number) => {
    root.position.set(s.x, s.groundRef, s.z);
    root.rotation.y = s.psi;
    lean.rotation.x = s.crashE > 0 ? -s.crashSide * 1.38 * s.crashE : -s.phi;

    // Угол тангажа рамы (включая стант и рельеф)
    const thv = s.th - s.thRest;
    const c = Math.cos(thv);
    const sn = Math.sin(thv);

    // Ход подвески колёс строго вдоль вертикали рамы (без паразитного продольного растяжения маятников при станте!)
    const sth = Math.sin(s.th);
    const yAf = s.yb + s.wf.x * sth;
    const yAr = s.yb + s.wr.x * sth;
    const restGapF = s.ybRest + s.wf.x * Math.sin(s.thRest) - R;
    const restGapR = s.ybRest + s.wr.x * Math.sin(s.thRest) - R;
    const dyF = Math.max(-0.045, Math.min(0.095, s.wf.y - yAf + restGapF));
    const dyR = Math.max(-0.045, Math.min(0.095, s.wr.y - yAr + restGapR));

    const wF = { x: s.wf.x, y: R + dyF };
    const wR = { x: s.wr.x, y: R + dyR };

    // Выставляем положение body так, чтобы опорное колесо (заднее при станте, переднее при стоппи) точно стояло на земле
    const bodyX = -wR.x * (c - 1) + wR.y * sn;
    let bodyY = s.wr.y - s.groundRef - (wR.x * sn + wR.y * c);
    if (thv < -0.02) {
      const bodyYFront = s.wf.y - s.groundRef - (wF.x * sn + wF.y * c);
      bodyY = Math.max(bodyY, bodyYFront);
    }
    body.position.set(bodyX, bodyY, 0);
    body.rotation.z = thv;
    frame.position.set(0, 0, 0);

    // Передний маятник и амортизаторы (в системе рулевой колонки, z = ±0.084)
    const wFs = rotNeg(wF.x - B.x, wF.y - B.y, TILT);
    wheelF.root.position.set(wFs.x, wFs.y, 0);
    wheelF.root.rotation.z = -TILT;
    wheelF.spinner.rotation.z = -s.wf.angle;
    placeArm(armFL, PFs, wFs, -zA);
    placeArm(armFR, PFs, wFs, zA);
    const aF = { x: PFs.x + (wFs.x - PFs.x) * 0.72, y: PFs.y + (wFs.y - PFs.y) * 0.72 };
    shocksF.forEach((sh, i) => {
      placeShock(sh, aF, topF, i === 0 ? -zS : zS);
    });

    // Задний маятник и амортизаторы
    wheelR.root.position.set(wR.x, wR.y, 0);
    wheelR.spinner.rotation.z = -s.wr.angle;
    placeArm(armRL, PR, wR, -zA);
    placeArm(armRR, PR, wR, zA);
    // Нижнее ухо пружины — на приливе рычага над осью колеса
    const rdx = wR.x - PR.x;
    const rdy = wR.y - PR.y;
    const rl = Math.hypot(rdx, rdy);
    const aR = { x: PR.x + rdx * 0.93 + (rdy / rl) * 0.024, y: PR.y + rdy * 0.93 - (rdx / rl) * 0.024 };
    shocksR.forEach((sh, i) => {
      placeShock(sh, aR, topR, i === 0 ? -zS : zS);
    });

    steer.rotation.y = Math.max(-0.7, Math.min(0.7, s.delta * 2.0));

    // Анимация тормозных ручек, курка газа, стоп-сигнала и подножки
    const brk = s.brake ?? 0;
    const thr = s.throttle ?? 0;
    mats.tail.emissiveIntensity = 1.8 + brk * 4.5;
    brakeLevers[0].rotation.y = brk * 0.28;
    brakeLevers[1].rotation.y = -brk * 0.28;
    throttlePivot.rotation.z = -thr * 0.45;
    kickstandPivot.rotation.z = s.parked ? 0 : -1.2;

    // Тепловое свечение тормозных дисков
    wheelF.discMat.emissiveIntensity = Math.max(0, Math.min(1.6, (s.wf.temp - 130) / 260));
    wheelR.discMat.emissiveIntensity = Math.max(0, Math.min(1.6, (s.wr.temp - 130) / 260));

    // Искры из-под заднего крыла / упора при глубоком угле станта
    if (s.tailScrape && !s.parked) {
      sparkGroup.visible = true;
      sparkPhase += dt * 38;
      for (let i = 0; i < sparks.length; i++) {
        const p = ((sparkPhase + i * 0.37) % 1);
        const side = (i % 2 === 0 ? 1 : -1) * (0.015 + (i % 5) * 0.016);
        const sp = sparks[i];
        sp.position.set(-p * 0.38, p * 0.14 + Math.sin(p * Math.PI) * 0.05, side * (1 + p * 1.4));
        sp.rotation.z = -0.35 + p * 0.5;
        sp.rotation.y = side * 2.2;
        const sc = Math.max(0.15, 1 - p);
        sp.scale.set(sc, sc, sc);
      }
    } else {
      sparkGroup.visible = false;
    }

    // Привязка рук райдера к грипсам руля, позы станта или 3D-позы рэгдолла/повтора
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

  const setDisplay = (kmh: number, unit: string, battery: number, mode: ModeId, stuntDeg = 0) => {
    const stKey = stuntDeg > 6 ? Math.round(stuntDeg) : 0;
    const key = `${Math.round(kmh)}|${unit}|${Math.round(battery * 50)}|${mode}|${model.awd}|${stKey}`;
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
    dctx.fillText(stKey > 0 ? `STUNT · ${stKey}°` : model.awd ? 'DUAL MOTOR' : `KUKIRIN ${model.label}`, 10, 13);

    dctx.textAlign = 'right';
    dctx.fillStyle = mode === 'eco' ? '#4ade80' : mode === 'drive' ? '#38bdf8' : look.accent;
    dctx.fillText(mode === 'eco' ? 'GEAR 1 · ECO' : mode === 'drive' ? 'GEAR 2 · DRV' : 'GEAR 3 · SPT', 246, 13);

    dctx.fillStyle = '#ffffff';
    dctx.font = '900 68px system-ui, sans-serif';
    dctx.textAlign = 'center';
    dctx.textBaseline = 'middle';
    dctx.fillText(String(Math.round(kmh)), 108, 64);

    dctx.font = '700 20px system-ui, sans-serif';
    dctx.fillStyle = look.accent;
    dctx.textAlign = 'left';
    dctx.fillText(unit.toUpperCase(), 178, 72);

    dctx.strokeStyle = '#4b5b6b';
    dctx.lineWidth = 2.5;
    dctx.strokeRect(12, 102, 232, 16);
    const segs = 10;
    const activeSegs = Math.ceil(battery * segs);
    for (let i = 0; i < segs; i++) {
      if (i < activeSegs) {
        dctx.fillStyle = battery > 0.25 ? '#4ade80' : '#f87171';
      } else {
        dctx.fillStyle = '#18222d';
      }
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
        if (m.isMesh || (o as THREE.InstancedMesh).isInstancedMesh) {
          m.geometry?.dispose();
        }
      });
      Object.values(mats).forEach((m) => m.dispose());
      gripMat.dispose();
      decalMat.dispose();
      stemDecalMat.dispose();
      sparkMat.dispose();
      screenMat.dispose();
      wheelF.discMat.dispose();
      wheelR.discMat.dispose();
      textures.forEach((t) => t.dispose());
      helixGeo.dispose();
      rider.dispose();
    },
  };
}
