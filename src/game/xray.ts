// Рентген-режим повтора: скелет по 17 узлам позы, подсветка сломанных костей и подписи травм.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SITE_IDS, type Injury, type SiteId, type SiteState } from './damage';

// Индексы узлов позы (как в ragdoll.ts)
const PELVIS = 0;
const CHEST = 1;
const HEAD = 2;
const HIP = [3, 4];
const SH = [5, 6];
const KNEE = [7, 8];
const ANK = [9, 10];
const TOE = [11, 12];
const ELB = [13, 14];
const HAND = [15, 16];
const SIDES = ['L', 'R'] as const;

const BONE = new THREE.Color(0.5, 0.74, 0.92);
const AMBER = new THREE.Color(1.0, 0.66, 0.16);
const RED = new THREE.Color(1.0, 0.2, 0.12);
const HOT = new THREE.Color(1.0, 0.08, 0.1);
const SOFT = new THREE.Color(1.0, 0.82, 0.25);

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
// Плотность как на снимке: ярче там, где поверхность видна «с ребра»
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
uniform float uBase;
uniform float uPower;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float i = uBase + (1.0 - uBase) * pow(rim, uPower);
  // Предумноженная альфа: кости перекрывают силуэт тела и не выгорают в белое
  gl_FragColor = vec4(uColor * i * uGain, clamp(i * uAlpha * uGain, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

function xrayMaterial(color: THREE.Color, base: number, power: number, alpha: number) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uGain: { value: 1 }, uBase: { value: base }, uPower: { value: power }, uAlpha: { value: alpha } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    side: alpha > 0 ? THREE.DoubleSide : THREE.FrontSide,
  });
  return m;
}

function merge(list: THREE.BufferGeometry[]) {
  const flat = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  const out = mergeGeometries(flat, false)!;
  for (const g of list) g.dispose();
  for (const g of flat) g.dispose();
  return out;
}

/** Половина трубчатой кости: эпифиз у y = 0, диафиз до y = 1. */
function halfBone(rEnd: number, rShaft: number, seg = 10) {
  const pts = [
    [rEnd * 0.5, 0],
    [rEnd, 0.07],
    [rEnd * 0.9, 0.15],
    [rShaft * 1.2, 0.38],
    [rShaft, 0.7],
    [rShaft, 1],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, seg);
}

const sphere = (r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) =>
  new THREE.SphereGeometry(r, 12, 9).scale(sx, sy, sz).translate(x, y, z);
const tube = (pts: [number, number, number][], r: number, closed = false) =>
  new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), closed), pts.length * 4, r, 6, closed);

interface LongBone {
  a: THREE.Mesh;
  b: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

function orth(v: THREE.Vector3, n: THREE.Vector3, out: THREE.Vector3, fallback: THREE.Vector3) {
  out.copy(v).addScaledVector(n, -v.dot(n));
  if (out.lengthSq() < 1e-8) out.copy(fallback).addScaledVector(n, -fallback.dot(n));
  if (out.lengthSq() < 1e-8) out.set(n.y, n.z, n.x).cross(n);
  return out.normalize();
}

/** Локальная ось Y — от a к b (длина = масштаб), Z — вдоль ref. */
function placeY(obj: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, ref: THREE.Vector3, stretch = true) {
  _y.subVectors(b, a);
  const len = _y.length();
  if (len < 1e-6) _y.set(0, 1, 0);
  else _y.divideScalar(len);
  orth(ref, _y, _z, THREE.Object3D.DEFAULT_UP);
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(a);
  obj.scale.set(1, stretch ? Math.max(len, 1e-4) : 1, 1);
}

function setFrame(obj: THREE.Object3D, origin: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) {
  _m.makeBasis(x, y, z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(origin);
}

interface LabelEl {
  el: HTMLDivElement;
  line: SVGLineElement;
  dot: SVGCircleElement;
  text: string;
  w: number;
  h: number;
  x: number;
  y: number;
  placed: boolean;
}

export interface XrayFrame {
  pose: Float32Array;
  sites: Record<SiteId, SiteState>;
  injuries: Injury[];
  /** Время аварии по часам повтора, с — для вспышек свежих травм. */
  age: number;
  level: number; // 0..1
  hideHead: boolean;
  time: number; // реальное время, с
}

export class XrayView {
  group = new THREE.Group();
  /** Материал «прозрачного тела» для мешей райдера. */
  ghost = xrayMaterial(new THREE.Color(0.1, 0.3, 0.62), 0.0, 2.6, 0);
  visible = false;

  private veil: THREE.Mesh;
  private veilMat: THREE.ShaderMaterial;
  private mats = new Map<string, THREE.ShaderMaterial>();
  private long = new Map<string, LongBone>();
  private skull: THREE.Mesh;
  private crack: THREE.Mesh;
  private jaw: THREE.Mesh;
  private neck: THREE.Mesh;
  private spine: THREE.Mesh;
  private pelvis: THREE.Mesh;
  private sternum: THREE.Mesh;
  private ribs: THREE.Mesh[] = [];
  private scapula: THREE.Mesh[] = [];
  private hand: THREE.Mesh[] = [];
  private patella: THREE.Mesh[] = [];
  private foot: THREE.Mesh[] = [];
  private markers = new Map<SiteId, THREE.Sprite>();
  private glow: THREE.CanvasTexture;
  private pts: THREE.Vector3[] = Array.from({ length: 17 }, () => new THREE.Vector3());
  private anchors = new Map<SiteId, THREE.Vector3>();

  private layer: HTMLDivElement;
  private svg: SVGSVGElement;
  private labels = new Map<string, LabelEl>();
  private frame = 0;
  private insetLeft = 12;
  private insetTop = 0;

  // Оси корпуса
  private U = new THREE.Vector3();
  private Rp = new THREE.Vector3();
  private Fp = new THREE.Vector3();
  private Rs = new THREE.Vector3();
  private Fs = new THREE.Vector3();
  private Uh = new THREE.Vector3();
  private Rh = new THREE.Vector3();
  private Fh = new THREE.Vector3();
  private t0 = new THREE.Vector3();
  private t1 = new THREE.Vector3();
  private t2 = new THREE.Vector3();

  constructor(private container: HTMLElement) {
    const g = this.group;
    g.visible = false;
    g.frustumCulled = false;

    // Затемняющая вуаль поверх сцены: на её фоне светятся кости
    this.veilMat = new THREE.ShaderMaterial({
      uniforms: { uLevel: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader:
        'uniform float uLevel; varying vec2 vUv; void main() { float v = smoothstep(0.25, 1.35, length(vUv)); gl_FragColor = vec4(0.006, 0.02, 0.045, uLevel * mix(0.74, 0.95, v)); }',
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.veil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.veilMat);
    this.veil.frustumCulled = false;
    this.veil.renderOrder = 900;
    g.add(this.veil);

    const mat = (key: string) => {
      const m = xrayMaterial(BONE, 0.3, 1.4, 1.15);
      this.mats.set(key, m);
      return m;
    };
    const mesh = (geo: THREE.BufferGeometry, m: THREE.Material) => {
      const o = new THREE.Mesh(geo, m);
      o.frustumCulled = false;
      o.renderOrder = 920;
      g.add(o);
      return o;
    };

    // Череп: свод, лицевой отдел, скулы; система координат головы — X вперёд, Y вверх
    this.skull = mesh(
      merge([
        sphere(0.09, -0.012, 0.032, 0, 1.04, 0.95, 0.82),
        sphere(0.05, 0.04, -0.03, 0, 1.0, 1.05, 1.06),
        sphere(0.02, 0.058, -0.012, -0.045, 1, 0.7, 1.2),
        sphere(0.02, 0.058, -0.012, 0.045, 1, 0.7, 1.2),
        tube(
          [
            [0.068, 0.012, -0.058],
            [0.086, 0.018, -0.03],
            [0.09, 0.012, 0],
            [0.086, 0.018, 0.03],
            [0.068, 0.012, 0.058],
          ],
          0.007,
        ),
      ]),
      mat('skull'),
    );
    this.crack = mesh(
      tube(
        [
          [0.07, 0.07, 0.012],
          [0.045, 0.098, -0.01],
          [0.02, 0.112, 0.016],
          [-0.012, 0.12, -0.012],
          [-0.04, 0.112, 0.02],
          [-0.066, 0.094, -0.004],
          [-0.085, 0.066, 0.014],
        ],
        0.0035,
      ),
      xrayMaterial(HOT, 0.9, 1, 1.2),
    );
    this.jaw = mesh(
      merge([
        tube(
          [
            [-0.012, -0.03, -0.062],
            [-0.006, -0.082, -0.056],
            [0.04, -0.104, -0.04],
            [0.078, -0.108, 0],
            [0.04, -0.104, 0.04],
            [-0.006, -0.082, 0.056],
            [-0.012, -0.03, 0.062],
          ],
          0.0085,
        ),
        tube(
          [
            [0.03, -0.074, -0.036],
            [0.07, -0.076, -0.018],
            [0.08, -0.076, 0],
            [0.07, -0.076, 0.018],
            [0.03, -0.074, 0.036],
          ],
          0.006,
        ),
      ]),
      mat('jaw'),
    );

    // Позвоночник: шейный отдел и грудопоясничный (единичная длина вдоль Y, отростки назад)
    const vertebrae = (n: number, r0: number, r1: number) => {
      const list: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const y = (i + 0.5) / n;
        const r = r0 + (r1 - r0) * (i / (n - 1));
        list.push(new THREE.CylinderGeometry(r, r, 0.62 / n, 8).translate(0, y, 0));
        list.push(new THREE.BoxGeometry(r * 1.5, 0.3 / n, r * 0.5).translate(-r * 1.5, y, 0));
      }
      return merge(list);
    };
    this.neck = mesh(vertebrae(6, 0.017, 0.014), mat('cervical'));
    this.spine = mesh(vertebrae(15, 0.026, 0.019), mat('spine'));

    // Таз: крылья подвздошных костей, крестец, лобковая дуга
    this.pelvis = mesh(
      merge([
        sphere(0.05, -0.015, 0.03, -0.092, 0.3, 1.1, 0.85).rotateX(0.32),
        sphere(0.05, -0.015, 0.03, 0.092, 0.3, 1.1, 0.85).rotateX(-0.32),
        new THREE.ConeGeometry(0.05, 0.1, 6).rotateX(Math.PI).translate(-0.052, 0.012, 0).scale(0.6, 1, 1),
        tube(
          [
            [-0.01, -0.03, -0.085],
            [0.035, -0.07, -0.05],
            [0.058, -0.088, 0],
            [0.035, -0.07, 0.05],
            [-0.01, -0.03, 0.085],
          ],
          0.012,
        ),
        tube(
          [
            [-0.01, -0.03, -0.085],
            [-0.03, -0.095, -0.05],
            [0.03, -0.1, -0.022],
          ],
          0.01,
        ),
        tube(
          [
            [-0.01, -0.03, 0.085],
            [-0.03, -0.095, 0.05],
            [0.03, -0.1, 0.022],
          ],
          0.01,
        ),
      ]),
      mat('pelvis'),
    );

    // Грудная клетка: по восемь рёбер с каждой стороны и грудина. Начало координат — верх позвоночника.
    for (const s of [-1, 1]) {
      const list: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 8; i++) {
        const y = -0.035 - i * 0.034;
        const k = Math.sin(((i + 1.2) / 9.2) * Math.PI);
        const rx = 0.058 + 0.05 * k;
        const rz = 0.085 + 0.062 * k;
        const pts: [number, number, number][] = [];
        const end = i < 6 ? 0.3 : 0.75 + (i - 6) * 0.25;
        for (let j = 0; j <= 8; j++) {
          const a = Math.PI - (j / 8) * (Math.PI - end);
          pts.push([-0.012 + Math.cos(a) * rx, y - (j / 8) * 0.038, s * Math.sin(a) * rz]);
        }
        list.push(tube(pts, 0.0058));
      }
      this.ribs.push(mesh(merge(list), mat(s < 0 ? 'ribsL' : 'ribsR')));
      this.scapula.push(
        mesh(
          new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.1, -0.012), new THREE.Vector2(0.03, -0.15)]), {
            depth: 0.006,
            bevelEnabled: false,
          }),
          mat(`scapula${s < 0 ? 'L' : 'R'}`),
        ),
      );
    }
    this.sternum = mesh(new THREE.BoxGeometry(0.012, 0.17, 0.038).translate(0.092, -0.125, 0), mat('sternum'));

    // Трубчатые кости из двух половин: при переломе половины расходятся
    const addLong = (key: string, half: THREE.BufferGeometry) => {
      const m = mat(key);
      this.long.set(key, { a: mesh(half, m), b: mesh(half, m), mat: m });
    };
    const dual = (rEnd: number, rShaft: number, sep: number, thin = 1) =>
      merge([halfBone(rEnd, rShaft).translate(0, 0, -sep), halfBone(rEnd * 0.8 * thin, rShaft * 0.8 * thin).translate(0, 0, sep)]);
    for (const s of SIDES) {
      addLong(`clavicle${s}`, halfBone(0.012, 0.0075, 8));
      addLong(`humerus${s}`, halfBone(0.024, 0.0125));
      addLong(`forearm${s}`, dual(0.014, 0.008, 0.011));
      addLong(`femur${s}`, halfBone(0.03, 0.016));
      addLong(`tibia${s}`, dual(0.026, 0.0135, 0.02, 0.6));
      // Кисть: пясть и четыре пальца, Y — от запястья к пальцам
      const fingers: THREE.BufferGeometry[] = [sphere(0.022, 0, 0.012, 0, 0.5, 1, 1.25)];
      for (let f = 0; f < 4; f++) {
        const z = (f - 1.5) * 0.014;
        fingers.push(new THREE.CylinderGeometry(0.0042, 0.0036, 0.085, 5).translate(0.004, 0.07, z));
      }
      this.hand.push(mesh(merge(fingers), mat(`wrist${s}`)));
      this.patella.push(mesh(sphere(0.022, 0, 0, 0, 0.6, 1, 1), mat(`knee${s}`)));
      // Стопа в метрах: Y — от голеностопа к носку, X — к тылу стопы
      const meta: THREE.BufferGeometry[] = [sphere(0.026, -0.014, -0.028, 0, 1, 1.5, 0.95)];
      for (let f = 0; f < 4; f++) meta.push(new THREE.CylinderGeometry(0.005, 0.0065, 0.125, 5).translate(-0.012, 0.075, (f - 1.5) * 0.013));
      meta.push(sphere(0.012, -0.014, 0.148, 0, 0.9, 1.6, 2.4));
      this.foot.push(mesh(merge(meta), mat(`ankle${s}`)));
    }

    // Маркеры травм
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.22, 'rgba(255,255,255,0.75)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    this.glow = new THREE.CanvasTexture(c);
    for (const id of SITE_IDS) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.glow, color: RED, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true }),
      );
      sp.renderOrder = 930;
      sp.visible = false;
      g.add(sp);
      this.markers.set(id, sp);
      this.anchors.set(id, new THREE.Vector3());
    }

    // Подписи травм поверх канваса
    this.layer = document.createElement('div');
    this.layer.className = 'xray-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.layer.appendChild(this.svg);
    this.layer.style.display = 'none';
    container.appendChild(this.layer);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.group.visible = false;
    this.layer.style.display = 'none';
  }

  private setColor(key: string, grade: number, fresh: number, time: number) {
    const m = this.mats.get(key);
    if (!m) return;
    const c = grade >= 3 ? HOT : grade === 2 ? RED : grade === 1 ? AMBER : BONE;
    (m.uniforms.uColor.value as THREE.Color).copy(c);
    const pulse = grade >= 2 ? 1.25 + 0.3 * Math.sin(time * 7) : grade === 1 ? 1.15 : 1;
    m.uniforms.uGain.value = this.gain * (pulse + fresh * 1.6);
    m.uniforms.uBase.value = grade > 0 ? 0.5 : 0.3;
  }

  private gain = 1;

  private placeLong(key: string, a: THREE.Vector3, b: THREE.Vector3, ref: THREE.Vector3, grade: number) {
    const bone = this.long.get(key)!;
    const mid = this.t0.addVectors(a, b).multiplyScalar(0.5);
    const dir = this.t1.subVectors(b, a).normalize();
    orth(ref, dir, this.t2, THREE.Object3D.DEFAULT_UP);
    // Перелом: зазор и сдвиг отломков, со смещением — «штыкообразно»
    const gap = grade === 2 ? 0.011 : grade >= 3 ? -0.012 : 0;
    const shift = grade === 2 ? 0.006 : grade >= 3 ? 0.02 : 0;
    _a.copy(mid).addScaledVector(dir, -gap).addScaledVector(this.t2, shift);
    _b.copy(mid).addScaledVector(dir, gap).addScaledVector(this.t2, -shift);
    placeY(bone.a, a, _a, ref);
    placeY(bone.b, b, _b, ref);
  }

  update(f: XrayFrame, camera: THREE.PerspectiveCamera) {
    const level = f.level;
    if (level <= 0.01) {
      this.hide();
      return;
    }
    this.visible = true;
    this.group.visible = true;
    this.veilMat.uniforms.uLevel.value = level;
    this.gain = level;
    this.ghost.uniforms.uGain.value = level;

    const p = this.pts;
    for (let i = 0; i < 17; i++) p[i].set(f.pose[i * 3], f.pose[i * 3 + 1], f.pose[i * 3 + 2]);
    const { U, Rp, Fp, Rs, Fs, Uh, Rh, Fh } = this;
    U.subVectors(p[CHEST], p[PELVIS]).normalize();
    orth(_p.subVectors(p[HIP[1]], p[HIP[0]]), U, Rp, _z.set(0, 0, 1));
    Fp.crossVectors(U, Rp);
    orth(_p.subVectors(p[SH[1]], p[SH[0]]), U, Rs, Rp);
    Fs.crossVectors(U, Rs);
    Uh.subVectors(p[HEAD], p[CHEST]).normalize();
    orth(Rs, Uh, Rh, Rp);
    Fh.crossVectors(Uh, Rh);

    const st = f.sites;
    const fresh = (id: SiteId) => (st[id].t > 0 ? Math.max(0, 1 - (f.age - st[id].t) / 0.45) : 0);
    const paint = (id: SiteId, key: string = id) => this.setColor(key, st[id].fracture, f.age >= st[id].t ? fresh(id) : 0, f.time);

    // Голова и шея
    const showHead = !f.hideHead;
    this.skull.visible = this.jaw.visible = showHead;
    this.crack.visible = showHead && st.skull.fracture > 0;
    setFrame(this.skull, p[HEAD], Fh, Uh, Rh);
    setFrame(this.jaw, p[HEAD], Fh, Uh, Rh);
    setFrame(this.crack, p[HEAD], Fh, Uh, Rh);
    (this.crack.material as THREE.ShaderMaterial).uniforms.uGain.value = level * (1.4 + 0.5 * Math.sin(f.time * 7));
    paint('skull');
    paint('jaw');
    const spineTop = this.t0.copy(p[CHEST]).addScaledVector(Fs, -0.045).addScaledVector(U, 0.035);
    _a.copy(p[HEAD]).addScaledVector(Uh, -0.07).addScaledVector(Fh, -0.02);
    placeY(this.neck, spineTop, _a, Rs);
    this.neck.visible = showHead;
    paint('cervical');
    _b.copy(p[PELVIS]).addScaledVector(Fp, -0.05).addScaledVector(U, 0.02);
    _a.copy(spineTop);
    placeY(this.spine, _b, _a, Rp);
    paint('spine');

    // Таз и грудная клетка
    setFrame(this.pelvis, p[PELVIS], Fp, U, Rp);
    paint('pelvis');
    const torsoLen = p[CHEST].distanceTo(p[PELVIS]) / 0.5;
    for (let s = 0; s < 2; s++) {
      setFrame(this.ribs[s], p[CHEST], Fs, U, Rs);
      this.ribs[s].scale.set(1, torsoLen, 1);
      paint(s === 0 ? 'ribsL' : 'ribsR');
      _a.copy(p[SH[s]]).addScaledVector(Fs, -0.062).addScaledVector(U, -0.012).addScaledVector(Rs, s === 0 ? 0.03 : -0.03);
      // Лопатка лежит на задней поверхности рёбер, остриём вниз
      _x.copy(Rs).multiplyScalar(s === 0 ? 1 : -1);
      _z.copy(Fs).multiplyScalar(s === 0 ? -1 : 1);
      setFrame(this.scapula[s], _a, _x, U, _z);
      this.setColor(`scapula${SIDES[s]}`, 0, 0, f.time);
    }
    setFrame(this.sternum, p[CHEST], Fs, U, Rs);
    this.sternum.scale.set(1, torsoLen, 1);
    this.setColor('sternum', 0, 0, f.time);

    for (let s = 0; s < 2; s++) {
      const S = SIDES[s];
      const sign = s === 0 ? -1 : 1;
      // Ключица: от грудины к плечу
      _p.copy(p[CHEST]).addScaledVector(Fs, 0.08).addScaledVector(U, -0.03).addScaledVector(Rs, sign * 0.022);
      const sternal = this.anchors.get(`clavicle${S}`)!.copy(_p);
      this.placeLong(`clavicle${S}`, sternal, p[SH[s]], U, st[`clavicle${S}`].fracture);
      paint(`clavicle${S}`);
      this.placeLong(`humerus${S}`, p[SH[s]], p[ELB[s]], Rs, st[`humerus${S}`].fracture);
      paint(`humerus${S}`);
      this.placeLong(`forearm${S}`, p[ELB[s]], p[HAND[s]], Rs, st[`forearm${S}`].fracture);
      paint(`forearm${S}`);
      _a.subVectors(p[HAND[s]], p[ELB[s]]).normalize().multiplyScalar(0.1).add(p[HAND[s]]);
      placeY(this.hand[s], p[HAND[s]], _a, Rs, false);
      paint(`wrist${S}`);

      this.placeLong(`femur${S}`, p[HIP[s]], p[KNEE[s]], Rp, st[`femur${S}`].fracture);
      paint(`femur${S}`);
      this.placeLong(`tibia${S}`, p[KNEE[s]], p[ANK[s]], Rp, st[`tibia${S}`].fracture);
      paint(`tibia${S}`);
      // Надколенник — спереди колена, по биссектрисе сгиба
      _a.copy(p[KNEE[s]]).multiplyScalar(2).sub(p[HIP[s]]).sub(p[ANK[s]]);
      if (_a.lengthSq() < 1e-4) _a.copy(Fp);
      _a.normalize();
      _b.subVectors(p[KNEE[s]], p[HIP[s]]).normalize();
      orth(_a, _b, _x, Fp);
      _z.crossVectors(_x, _b);
      _p.copy(p[KNEE[s]]).addScaledVector(_x, 0.046);
      setFrame(this.patella[s], _p, _x, _b, _z);
      paint(`knee${S}`);
      // Стопа: тыл смотрит к колену
      _y.subVectors(p[TOE[s]], p[ANK[s]]).normalize();
      orth(_a.subVectors(p[KNEE[s]], p[ANK[s]]), _y, _x, U);
      _z.crossVectors(_x, _y);
      setFrame(this.foot[s], p[ANK[s]], _x, _y, _z);
      paint(`ankle${S}`);
    }

    // Точки травм
    const A = this.anchors;
    A.get('skull')!.copy(p[HEAD]).addScaledVector(Uh, 0.05);
    A.get('jaw')!.copy(p[HEAD]).addScaledVector(Fh, 0.06).addScaledVector(Uh, -0.09);
    A.get('cervical')!.lerpVectors(p[CHEST], p[HEAD], 0.45).addScaledVector(Fs, -0.03);
    A.get('spine')!.lerpVectors(p[PELVIS], p[CHEST], 0.45).addScaledVector(Fp, -0.05);
    A.get('pelvis')!.copy(p[PELVIS]);
    for (let s = 0; s < 2; s++) {
      const S = SIDES[s];
      const sign = s === 0 ? -1 : 1;
      A.get(`clavicle${S}`)!.lerp(p[SH[s]], 0.5);
      A.get(`ribs${S}`)!.copy(p[CHEST]).addScaledVector(U, -0.17 * torsoLen).addScaledVector(Rs, sign * 0.12).addScaledVector(Fs, 0.03);
      // Вывих показываем у сустава, перелом — посередине кости
      const joint = (id: SiteId, a: number, b: number) => A.get(id)!.lerpVectors(p[a], p[b], st[id].fracture > 0 ? 0.5 : st[id].ligament > 0 ? 0.04 : 0.5);
      joint(`humerus${S}`, SH[s], ELB[s]);
      joint(`forearm${S}`, ELB[s], HAND[s]);
      joint(`femur${S}`, HIP[s], KNEE[s]);
      A.get(`wrist${S}`)!.copy(p[HAND[s]]);
      A.get(`knee${S}`)!.copy(p[KNEE[s]]);
      A.get(`tibia${S}`)!.lerpVectors(p[KNEE[s]], p[ANK[s]], 0.5);
      A.get(`ankle${S}`)!.copy(p[ANK[s]]);
    }
    for (const id of SITE_IDS) {
      const sp = this.markers.get(id)!;
      const s = st[id];
      const worst = Math.max(s.fracture >= 2 ? 3 : s.fracture, s.ligament > 0 ? s.ligament + 0.5 : 0, s.soft * 0.6);
      if (worst <= 0 || (f.hideHead && (id === 'skull' || id === 'jaw'))) {
        sp.visible = false;
        continue;
      }
      sp.visible = true;
      sp.position.copy(A.get(id)!);
      const mat = sp.material;
      mat.color.copy(s.fracture >= 2 ? HOT : s.fracture === 1 || s.ligament > 0 ? AMBER : SOFT);
      const fr = fresh(id);
      const size = (0.07 + worst * 0.035) * (1 + 0.14 * Math.sin(f.time * 6 + worst)) * (1 + fr * 1.8);
      sp.scale.setScalar(size);
      mat.opacity = level * Math.min(1, 0.35 + worst * 0.2 + fr);
    }

    this.updateLabels(f, camera);
  }

  private updateLabels(f: XrayFrame, camera: THREE.PerspectiveCamera) {
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    this.layer.style.display = '';
    this.layer.style.opacity = String(f.level);
    const narrow = W < 640 || H < 430;
    // На узком портретном экране подписи закрыли бы тело: остаются маркеры и список в панели
    const max = W < 480 ? 0 : narrow ? 3 : 6;
    const major = f.injuries.filter((i) => i.kind !== 'contusion' && i.kind !== 'abrasion');
    const shown = (major.length ? major : f.injuries.slice(0, 2)).filter((i) => !(f.hideHead && (i.site === 'skull' || i.site === 'jaw'))).slice(0, max);

    const keep = new Set(shown.map((i) => i.id));
    for (const [id, l] of this.labels) {
      if (keep.has(id)) continue;
      l.el.remove();
      l.line.remove();
      l.dot.remove();
      this.labels.delete(id);
    }

    camera.updateMatrixWorld();
    const centre = _p.addVectors(this.pts[PELVIS], this.pts[CHEST]).multiplyScalar(0.5).project(camera);
    const cx = (centre.x * 0.5 + 0.5) * W;
    const items: { l: LabelEl; ax: number; ay: number }[] = [];
    for (const inj of shown) {
      let l = this.labels.get(inj.id);
      const text = inj.label;
      if (!l) {
        const el = document.createElement('div');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', '3.5');
        this.svg.append(line, dot);
        this.layer.appendChild(el);
        l = { el, line, dot, text: '', w: 0, h: 0, x: 0, y: 0, placed: false };
        this.labels.set(inj.id, l);
      }
      const tone = inj.kind === 'fracture' ? (inj.grade >= 2 ? 'red' : 'amber') : inj.kind === 'concussion' ? (inj.grade >= 2 ? 'red' : 'amber') : inj.kind === 'ligament' ? 'amber' : 'soft';
      const cls = `xray-label tone-${tone}`;
      if (l.text !== text || l.el.className !== cls) {
        l.text = text;
        l.el.className = cls;
        l.el.textContent = text;
        l.line.setAttribute('class', `tone-${tone}`);
        l.dot.setAttribute('class', `tone-${tone}`);
        l.w = l.el.offsetWidth;
        l.h = l.el.offsetHeight;
      }
      const a = _a.copy(this.anchors.get(inj.site)!).project(camera);
      const visible = a.z < 1 && a.z > -1;
      l.el.style.visibility = l.line.style.visibility = l.dot.style.visibility = visible ? '' : 'hidden';
      if (visible) items.push({ l, ax: (a.x * 0.5 + 0.5) * W, ay: (-a.y * 0.5 + 0.5) * H });
    }

    // Две колонки по сторонам от тела, подписи не наезжают друг на друга
    // Панель травм HUD занимает левый край (или верх на портретном экране) — подписи её обходят
    if (this.frame++ % 20 === 0) {
      const r = document.querySelector('.damage-panel')?.getBoundingClientRect();
      const host = this.container.getBoundingClientRect();
      this.insetLeft = r && r.width < W * 0.6 ? r.right - host.left + 10 : 12;
      this.insetTop = r && r.width >= W * 0.6 ? r.bottom - host.top + 8 : 0;
    }
    const top = Math.max(narrow ? 56 : 96, this.insetTop);
    const bottom = H - (narrow ? 150 : 210);
    const off = Math.min(W * 0.2, 210);
    for (const sideSign of [-1, 1]) {
      const col = items.filter((it) => (it.ax >= cx ? 1 : -1) === sideSign).sort((p, q) => p.ay - q.ay);
      let y = top;
      for (const it of col) {
        const l = it.l;
        const tx = sideSign > 0 ? Math.min(W - l.w - 12, Math.max(cx + off, it.ax + 36)) : Math.max(this.insetLeft, Math.min(cx - off, it.ax - 36) - l.w);
        const ty = Math.max(y, Math.min(bottom - l.h, it.ay - l.h / 2));
        y = ty + l.h + 8;
        const k = l.placed ? 0.3 : 1;
        l.x += (tx - l.x) * k;
        l.y += (ty - l.y) * k;
        l.placed = true;
        l.el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
        l.line.setAttribute('x1', (sideSign > 0 ? l.x : l.x + l.w).toFixed(1));
        l.line.setAttribute('y1', (l.y + l.h / 2).toFixed(1));
        l.line.setAttribute('x2', it.ax.toFixed(1));
        l.line.setAttribute('y2', it.ay.toFixed(1));
        l.dot.setAttribute('cx', it.ax.toFixed(1));
        l.dot.setAttribute('cy', it.ay.toFixed(1));
      }
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
      const mat = (o as THREE.Mesh | THREE.Sprite).material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.ghost.dispose();
    this.glow.dispose();
    this.group.removeFromParent();
    this.layer.remove();
  }
}
