import {
  BRAKES,
  MODELS,
  PADS,
  SURFACES,
  TIRES,
  type ModeId,
  type ModelId,
  type SimInput,
  type SurfaceId,
  type Telemetry,
  type TireId,
  type Tune,
} from './data';
import type { CrashEventInfo, CrashKind } from './ragdoll';
import { HALF, OBSTACLE_REASON, type Terrain } from './terrain';

export const DT = 1 / 480;
const G = 9.81;
const Y0 = 0.8; // высота ЦТ (самокат + райдер) над землёй в покое
const TILT_WINDOW = [-2, -1, 0, 1, 2];

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface SimConfig {
  model: ModelId;
  wheel: number; // дюймы
  tire: TireId;
  tune: Tune;
  riderKg: number;
  mode: ModeId;
  crash: boolean;
}

export interface DynamicCone {
  x0: number;
  z0: number;
  r: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotZ: number;
  vRotX: number;
  vRotZ: number;
  fallen: boolean;
}

export class Wheel {
  y = 0;
  vy = 0;
  omega = 0;
  angle = 0;
  temp = 25;
  absF = 1;
  raw = 0;
  eff = 0;
  kappa = 0;
  tanA = 0;
  slipLon = 0; // сглаженное продольное скольжение (релаксация шины)
  slipLat = 0; // сглаженное боковое скольжение (релаксация каркаса шины)
  fz = 0;
  fx = 0;
  fy = 0;
  util = 0;
  H = 0;
  hPrev = 0;
  comp = 0;
  absActive = false;
  locked = false;
  surf: SurfaceId = 'asphalt';
  mu = 1;
}

export class ScooterSim {
  terrain: Terrain;
  cfg!: SimConfig;
  structKey = '';

  // производные параметры
  R = 0.13;
  muW = 3.5;
  Mb = 100;
  Mt = 100;
  Ib = 18;
  Iz = 13;
  Ix = 22; // момент инерции по крену (самокат + райдер)
  a0 = 0.56;
  b0 = 0.6;
  travel = 0.085;
  trail = 0.034; // механический кастор (плечо стабилизации переднего колеса), м

  // состояние
  px = 0;
  pz = 0;
  psi = 0;
  u = 0;
  v = 0;
  r = 0;
  yb = 0.8;
  vyb = 0;
  th = 0;
  wth = 0;
  delta = 0;
  steerVel = 0; // угловая скорость поворота руля, рад/с
  phi = 0;
  rollRate = 0; // угловая скорость крена, рад/с
  lean = 0;
  leanLat = 0; // боковой вынос корпуса райдера внутрь поворота (-1..+1)
  muSense = 1; // оценка сцепления райдером
  brace = 0; // группировка при торможении 0..1
  steerTrim = 0; // поправка руля на увод шин, рад
  hCg = 0.8; // высота общего ЦТ над дорогой, м
  Fz0 = 490; // статическая нагрузка на колесо, Н
  thr = 0;
  tcsF = 1;
  tcsActive = false;
  wf = new Wheel();
  wr = new Wheel();
  aE = 0.56;
  bE = 0.6;
  X0 = 0.7;
  grad = { x: 0, z: 0 };

  // индикаторы и коллизии
  battery = 1;
  power = 0;
  odo = 0;
  axB = 0;
  ayLat = 0;
  azBody = 0;
  crashed = false;
  crashT = 0;
  crashReason = '';
  crashSide = 1;
  slipT = 0;
  frontWashT = 0;
  endoT = 0;
  endo = false;
  wheelie = false;
  stuntInput = 0;
  stuntPose = 0;
  stuntAngle = 0; // градусы
  stuntDist = 0;
  stuntTime = 0;
  stuntScore = 0;
  bestStuntDist = 0;
  bestStuntScore = 0;
  stuntHoldGrace = 0;
  loopOutT = 0;
  tailScrape = false;
  airborne = false;
  wasAirborne = false;
  settling = false;
  time = 0;
  ready = false;
  reverseHoldT = 0;
  reversing = false;
  impactMag = 0; // импульс последнего удара для звука/тряски камеры
  justCrashed = false;
  lastCrashInfo: CrashEventInfo | null = null;
  cones: DynamicCone[] = [];

  constructor(terrain: Terrain, cfg: SimConfig) {
    this.terrain = terrain;
    this.initCones();
    this.configure(cfg);
  }

  setTerrain(terrain: Terrain) {
    this.terrain = terrain;
    this.initCones();
    this.respawn();
  }

  /** Вернуть самокат в точку старта текущей карты. */
  respawn() {
    const s = this.terrain.spawn;
    this.reset(s?.x ?? 0, s?.z ?? 0, s?.psi ?? 0, false);
  }

  private initCones() {
    this.cones = this.terrain.cones.map((c) => {
      const gy = this.terrain.height(c.x, c.z);
      return {
        x0: c.x,
        z0: c.z,
        r: c.r,
        x: c.x,
        y: gy,
        z: c.z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: 0,
        rotZ: 0,
        vRotX: 0,
        vRotZ: 0,
        fallen: false,
      };
    });
  }

  resetCones() {
    for (const c of this.cones) {
      const gy = this.terrain.height(c.x0, c.z0);
      c.x = c.x0;
      c.y = gy;
      c.z = c.z0;
      c.vx = 0;
      c.vy = 0;
      c.vz = 0;
      c.rotX = 0;
      c.rotZ = 0;
      c.vRotX = 0;
      c.vRotZ = 0;
      c.fallen = false;
    }
  }

  configure(cfg: SimConfig) {
    const prevR = this.R;
    this.cfg = cfg;
    const m = MODELS[cfg.model] ?? MODELS.g2;
    this.R = cfg.wheel * 0.0254 * 0.52;
    this.muW = 3.2 + (cfg.wheel - 8.5) * 0.5;
    this.Mt = m.mass + cfg.riderKg;
    this.Mb = this.Mt - 2 * this.muW;
    this.Ib = this.Mb * 0.19;
    this.Iz = this.Mt * 0.145;
    this.Ix = m.mass * 0.11 + cfg.riderKg * 0.34;
    this.hCg = (m.mass * 0.3 + cfg.riderKg * 1.08) / this.Mt;
    this.Fz0 = (this.Mt * G) / 2;
    this.travel = m.travel;
    this.trail = 0.026 + (cfg.wheel - 8.5) * 0.0035;
    this.X0 = Y0 - this.R + 0.02;

    const t = cfg.tune;
    const key = `${cfg.model}|${cfg.wheel}|${t.fSpring}|${t.rSpring}|${t.fPre}|${t.rPre}|${t.fPsi}|${t.rPsi}|${cfg.riderKg}`;
    if (this.ready && key !== this.structKey) {
      const prevModelWheel = this.structKey.split('|').slice(0, 2).join('|');
      const nextModelWheel = `${cfg.model}|${cfg.wheel}`;
      this.structKey = key;
      if (prevModelWheel !== nextModelWheel) {
        const dR = this.R - prevR;
        this.wf.y += dR;
        this.wr.y += dR;
        this.yb += dR;
      }
      if (Math.abs(this.u) < 0.2 && !this.crashed) {
        this.reset(this.px, this.pz, this.psi, true);
      }
    }
    this.structKey = key;
  }

  protected envelope(x: number, z: number, fx: number, fz: number, psi: number, w: Wheel) {
    const R = this.R;
    const patch = clamp(1.9 - psi / 30, 0.25, 1.4);
    const maxD = R * 0.88;
    let H = -1e9;
    for (let i = 0; i < TILT_WINDOW.length; i++) {
      const d = clamp(TILT_WINDOW[i] * 0.045 * patch, -maxD, maxD);
      const h = this.terrain.height(x + fx * d, z + fz * d) + Math.sqrt(Math.max(0, R * R - d * d));
      if (h > H) H = h;
    }
    w.H = H;
    w.surf = this.terrain.surface(x, z);
  }

  reset(x: number, z: number, psi: number, keepCones = false) {
    this.px = x;
    this.pz = z;
    this.psi = psi;
    this.u = 0;
    this.v = 0;
    this.r = 0;
    this.vyb = 0;
    this.wth = 0;
    this.delta = 0;
    this.steerVel = 0;
    this.phi = 0;
    this.rollRate = 0;
    this.lean = 0;
    this.leanLat = 0;
    this.muSense = 1;
    this.brace = 0;
    this.steerTrim = 0;
    this.thr = 0;
    this.tcsF = 1;
    this.tcsActive = false;
    this.crashed = false;
    this.crashT = 0;
    this.slipT = 0;
    this.frontWashT = 0;
    this.endoT = 0;
    this.endo = false;
    this.wheelie = false;
    this.stuntInput = 0;
    this.stuntPose = 0;
    this.stuntAngle = 0;
    this.stuntDist = 0;
    this.stuntTime = 0;
    this.stuntScore = 0;
    this.stuntHoldGrace = 0;
    this.loopOutT = 0;
    this.tailScrape = false;
    this.airborne = false;
    this.wasAirborne = false;
    this.reverseHoldT = 0;
    this.reversing = false;
    this.impactMag = 0;
    this.justCrashed = false;
    this.lastCrashInfo = null;
    this.axB = 0;
    this.ayLat = 0;
    this.azBody = 0;
    if (!keepCones) this.resetCones();

    for (const w of [this.wf, this.wr]) {
      w.vy = 0;
      w.omega = 0;
      w.raw = 0;
      w.eff = 0;
      w.absF = 1;
      w.temp = 25;
      w.fx = 0;
      w.fy = 0;
      w.kappa = 0;
      w.tanA = 0;
      w.slipLon = 0;
      w.slipLat = 0;
      w.util = 0;
      w.absActive = false;
      w.locked = false;
    }
    const cs = Math.cos(psi);
    const sn = Math.sin(psi);
    this.aE = this.a0;
    this.bE = this.b0;
    this.envelope(x + cs * this.a0, z - sn * this.a0, cs, -sn, this.cfg.tune.fPsi, this.wf);
    this.envelope(x - cs * this.b0, z + sn * this.b0, cs, -sn, this.cfg.tune.rPsi, this.wr);
    this.wf.y = this.wf.H - 0.004;
    this.wr.y = this.wr.H - 0.004;
    this.wf.hPrev = this.wf.H;
    this.wr.hPrev = this.wr.H;
    this.yb = (this.wf.H + this.wr.H) / 2 + Y0 - this.R;
    this.th = Math.atan2(this.wf.H - this.wr.H, this.a0 + this.b0);
    this.ready = true;
    this.settle(1.2);
  }

  settle(seconds: number) {
    this.settling = true;
    const inp: SimInput = { throttle: 0, steer: 0, lean: 0, brake: 0, brakeF: 0, brakeR: 0 };
    const n = Math.floor(seconds / DT);
    for (let i = 0; i < n; i++) this.step(inp, DT);
    this.u = 0;
    this.v = 0;
    this.r = 0;
    this.delta = 0;
    this.steerVel = 0;
    this.phi = 0;
    this.rollRate = 0;
    this.odo = 0;
    this.settling = false;
  }

  recover() {
    this.crashed = false;
    this.justCrashed = false;
    this.crashT = 0;
    this.u = 0;
    this.v = 0;
    this.r = 0;
    this.phi = 0;
    this.rollRate = 0;
    this.delta = 0;
    this.steerVel = 0;
    this.lean = 0;
    this.leanLat = 0;
    this.muSense = 1;
    this.brace = 0;
    this.steerTrim = 0;
    this.thr = 0;
    this.tcsF = 1;
    this.tcsActive = false;
    this.slipT = 0;
    this.frontWashT = 0;
    this.endoT = 0;
    this.endo = false;
    this.wheelie = false;
    this.stuntInput = 0;
    this.stuntPose = 0;
    this.stuntAngle = 0;
    this.stuntDist = 0;
    this.stuntTime = 0;
    this.stuntScore = 0;
    this.stuntHoldGrace = 0;
    this.loopOutT = 0;
    this.tailScrape = false;
    this.airborne = false;
    this.wasAirborne = false;
    this.reverseHoldT = 0;
    this.reversing = false;
    this.axB = 0;
    this.ayLat = 0;
    this.azBody = 0;
    this.resolveObstacleCollisions(true);
    const cs = Math.cos(this.psi);
    const sn = Math.sin(this.psi);
    this.envelope(this.px + cs * this.a0, this.pz - sn * this.a0, cs, -sn, this.cfg.tune.fPsi, this.wf);
    this.envelope(this.px - cs * this.b0, this.pz + sn * this.b0, cs, -sn, this.cfg.tune.rPsi, this.wr);
    this.wf.y = this.wf.H - 0.003;
    this.wr.y = this.wr.H - 0.003;
    this.wf.hPrev = this.wf.H;
    this.wr.hPrev = this.wr.H;
    this.wf.vy = 0;
    this.wr.vy = 0;
    this.yb = (this.wf.H + this.wr.H) / 2 + Y0 - this.R - 0.015;
    this.vyb = 0;
    this.th = Math.atan2(this.wf.H - this.wr.H, this.a0 + this.b0);
    this.wth = 0;
    for (const w of [this.wf, this.wr]) {
      w.omega = 0;
      w.raw = 0;
      w.eff = 0;
      w.fx = 0;
      w.fy = 0;
      w.kappa = 0;
      w.tanA = 0;
      w.slipLon = 0;
      w.slipLat = 0;
      w.util = 0;
      w.absF = 1;
      w.absActive = false;
      w.locked = false;
    }
  }

  protected doCrash(reason: string, partial?: Partial<CrashEventInfo> & { kind?: CrashKind }) {
    if (!this.cfg.crash || this.settling || this.crashed) return;
    this.crashed = true;
    this.justCrashed = true;
    this.crashT = 0;
    this.crashReason = reason;
    this.crashSide =
      Math.abs(this.phi) > 0.08
        ? Math.sign(this.phi)
        : this.r !== 0
          ? Math.sign(this.r)
          : this.v >= 0
            ? 1
            : -1;

    const cs = Math.cos(this.psi);
    const sn = Math.sin(this.psi);
    const fx = cs;
    const fz = -sn;
    const lx = -sn;
    const lz = -cs;
    const preVxW = partial?.preVxW ?? this.u * fx + this.v * lx;
    const preVyW = partial?.preVyW ?? this.vyb;
    const preVzW = partial?.preVzW ?? this.u * fz + this.v * lz;
    const preSpeed = partial?.preSpeed ?? Math.hypot(preVxW, preVzW);
    const impactVn = partial?.impactVn ?? preSpeed;

    this.lastCrashInfo = {
      reason,
      preVxW,
      preVyW,
      preVzW,
      preSpeed,
      impactVn,
      impactNx: partial?.impactNx ?? -fx,
      impactNz: partial?.impactNz ?? -fz,
      impactX: partial?.impactX ?? this.px + fx * this.a0,
      impactY: partial?.impactY ?? this.yb,
      impactZ: partial?.impactZ ?? this.pz + fz * this.a0,
      peakG: partial?.peakG ?? clamp(impactVn * 2.0 + preSpeed * 0.55, 2.8, 42),
      kind: partial?.kind ?? 'obstacle',
    };
  }

  private susp(x: number, v: number, k: number, pre: number, cC: number, cR: number): number {
    let F = k * (Math.max(x, 0) + pre);
    if (x < 0) {
      // Отбойник разжатия (droop stop) с демпфированием, чтобы не было высокочастотного звона при отрыве колеса
      const stopDamp = v < 0 ? 4200 : 1400;
      F += 220000 * x + stopDamp * v * clamp(-x / 0.008, 0, 1);
    } else if (x > this.travel) {
      // Гидравлический отбойник сжатия (bump stop) при жёстких приземлениях
      const over = x - this.travel;
      const bumpDamp = v > 0 ? 5500 : 1600;
      F += 230000 * over + bumpDamp * v * clamp(over / 0.01, 0, 1);
    }
    F += (v > 0 ? cC : cR) * v;
    if (x >= 0 && F < 0) F = 0;
    return F;
  }

  private tireForce(
    w: Wheel,
    vx: number,
    vy: number,
    kp: number,
    ap: number,
    camberAngle: number,
    dt: number,
  ) {
    const absVx = Math.abs(vx);
    const ucl = Math.max(absVx, 0.45);
    const rawKappa = clamp((w.omega * this.R - vx) / ucl, -4, 4);
    const rawTanA = clamp(vy / Math.max(absVx, 0.35), -4, 4);

    // Релаксация каркаса шины: боковая и продольная деформация протектора нарастает на длине ~7–14 см качения
    const rollSpeed = Math.max(absVx, Math.abs(w.omega * this.R), 0.75);
    const alphaLon = Math.min(1, (rollSpeed / 0.055) * dt);
    const alphaLat = Math.min(1, (rollSpeed / 0.13) * dt);
    w.slipLon += (rawKappa - w.slipLon) * alphaLon;
    w.slipLat += (rawTanA - w.slipLat) * alphaLat;
    w.kappa = w.slipLon;
    w.tanA = w.slipLat;

    const sx = w.kappa / kp;
    const sy = w.tanA / ap;
    const s = Math.hypot(sx, sy) + 1e-9;

    // Нелинейная кривая сцепления Пасейки (Magic Formula)
    // Чувствительность к нагрузке: перегруженная шина держит относительно хуже
    const loadK = clamp(1.06 - 0.12 * (w.fz / this.Fz0), 0.82, 1.04);
    const peakF = Math.sin(1.42 * Math.atan(2.05 * s)) * w.mu * loadK * w.fz;
    w.fx = (peakF * sx) / s;

    // Боковая сила от увода + боковая сила от наклона колеса (camber thrust в повороте)
    const latSlipF = (-peakF * sy) / s;
    const camberReserve = Math.max(0.15, 1 - 0.55 * clamp(s - 0.35, 0, 1.2));
    const camberF = Math.sin(camberAngle) * w.mu * w.fz * 0.24 * camberReserve;
    w.fy = clamp(latSlipF + camberF, -w.mu * w.fz * 1.06, w.mu * w.fz * 1.06);
    w.util = s;
  }

  private wheelMu(w: Wheel, psi: number): number {
    const sf = SURFACES[w.surf];
    const tg = TIRES[this.cfg.tire].grip[w.surf];
    const pf = clamp(1 - 0.0055 * Math.max(0, psi - sf.optPsi) - 0.004 * Math.max(0, sf.optPsi - psi), 0.6, 1);
    return sf.mu * tg * pf;
  }

  private applyImpactResponse(
    nx: number,
    nz: number,
    arm: number,
    fx: number,
    fz: number,
    lx: number,
    lz: number,
    restitution: number,
    crashThreshold: number,
    reason: string,
  ) {
    const vLocX = this.u;
    const vLocY = this.v + arm * this.r;
    const vxW = vLocX * fx + vLocY * lx;
    const vzW = vLocX * fz + vLocY * lz;
    const vn = -(vxW * nx + vzW * nz);

    if (vn > 0) {
      const jn = (1 + restitution) * vn;
      const dVxW = nx * jn;
      const dVzW = nz * jn;
      const duImp = dVxW * fx + dVzW * fz;
      const dvImp = dVxW * lx + dVzW * lz;

      this.u = (this.u + duImp) * 0.72;
      this.v = (this.v + dvImp) * 0.72;

      // При ударе гасим избыточное вращение колёс, чтобы самокат не карабкался обратно в стену
      this.wf.omega *= 0.45;
      this.wr.omega *= 0.45;

      const crossYaw = arm * (nx * lx + nz * lz);
      this.r += crossYaw * vn * 1.35;
      this.steerVel += crossYaw * vn * 4.5;
      this.impactMag = Math.max(this.impactMag, vn);

      if (vn > crashThreshold) {
        const preSpeed = Math.hypot(vxW, vzW);
        this.doCrash(reason, {
          kind: 'obstacle',
          preVxW: vxW,
          preVyW: this.vyb,
          preVzW: vzW,
          preSpeed,
          impactVn: vn,
          impactNx: nx,
          impactNz: nz,
          impactX: this.px + fx * arm,
          impactY: this.yb,
          impactZ: this.pz + fz * arm,
          peakG: clamp(vn * 2.25 + preSpeed * 0.6, 3.8, 46),
        });
      }
    }
  }

  protected resolveObstacleCollisions(quiet = false) {
    const cs = Math.cos(this.psi);
    const sn = Math.sin(this.psi);
    const fx = cs;
    const fz = -sn;
    const lx = -sn;
    const lz = -cs;

    const pts = [
      { arm: this.a0, rad: 0.22 },
      { arm: 0, rad: 0.24 },
      { arm: -this.b0, rad: 0.22 },
    ];

    const lowestWheelBottom = Math.min(this.wf.y, this.wr.y) - this.R;

    // 1. Цилиндрические препятствия (деревья, камни, фонари, светофоры, болларды)
    const obstacles = this.terrain.obstacles;
    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (Math.abs(obs.x - this.px) > 3.2 || Math.abs(obs.z - this.pz) > 3.2) continue;

      const groundY = this.terrain.macro(obs.x, obs.z);
      if (lowestWheelBottom > groundY + obs.h * 0.85) continue;

      for (let p = 0; p < pts.length; p++) {
        const pt = pts[p];
        const wx = this.px + fx * pt.arm;
        const wz = this.pz + fz * pt.arm;
        const dx = wx - obs.x;
        const dz = wz - obs.z;
        const dist = Math.hypot(dx, dz);
        const minDist = obs.r + pt.rad;
        if (dist < minDist) {
          const nx = dist > 1e-5 ? dx / dist : fx;
          const nz = dist > 1e-5 ? dz / dist : fz;
          const overlap = minDist - dist;

          this.px += nx * (overlap + 0.005);
          this.pz += nz * (overlap + 0.005);

          if (!quiet) {
            const reason = OBSTACLE_REASON[obs.kind] ?? 'Столкновение с препятствием';
            const thr = obs.kind === 'bollard' ? 3.5 : obs.kind === 'rock' ? 4.2 : 3.8;
            this.applyImpactResponse(nx, nz, pt.arm, fx, fz, lx, lz, 0.18, thr, reason);
          }
          break;
        }
      }
    }

    // 2. Прямоугольные объекты (здания, припаркованные машины, автобусные остановки, скамейки)
    const boxes = this.terrain.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (Math.abs(box.x - this.px) > box.halfX + 2.5 || Math.abs(box.z - this.pz) > box.halfZ + 2.5) continue;

      const groundY = this.terrain.macro(box.x, box.z);
      if (lowestWheelBottom > groundY + box.h * 0.9) continue;

      for (let p = 0; p < pts.length; p++) {
        const pt = pts[p];
        const wx = this.px + fx * pt.arm;
        const wz = this.pz + fz * pt.arm;

        const cx = clamp(wx, box.x - box.halfX, box.x + box.halfX);
        const cz = clamp(wz, box.z - box.halfZ, box.z + box.halfZ);
        const dx = wx - cx;
        const dz = wz - cz;
        const dist = Math.hypot(dx, dz);

        if (dist < pt.rad) {
          let nx = 0;
          let nz = 0;
          let overlap = 0;

          if (dist > 1e-5) {
            nx = dx / dist;
            nz = dz / dist;
            overlap = pt.rad - dist;
          } else {
            // Точка уже внутри AABB — выталкиваем вдоль ближайшей грани
            const penX = box.halfX - Math.abs(wx - box.x);
            const penZ = box.halfZ - Math.abs(wz - box.z);
            if (penX < penZ) {
              nx = wx >= box.x ? 1 : -1;
              nz = 0;
              overlap = penX + pt.rad;
            } else {
              nx = 0;
              nz = wz >= box.z ? 1 : -1;
              overlap = penZ + pt.rad;
            }
          }

          this.px += nx * (overlap + 0.006);
          this.pz += nz * (overlap + 0.006);

          if (!quiet) {
            const thr = box.kind === 'bench' ? 3.5 : 4.0;
            this.applyImpactResponse(nx, nz, pt.arm, fx, fz, lx, lz, 0.14, thr, box.label);
          }
          break;
        }
      }
    }

    // 3. Коллизия с вертикальным торцом и боковыми стенками всех трамплинов карты (для обоих колёс)
    const ramps = this.terrain.ramps;
    const wheelPts = [
      { arm: this.a0, w: this.wf },
      { arm: -this.b0, w: this.wr },
    ];
    for (let i = 0; i < ramps.length; i++) {
      const ramp = ramps[i];
      for (let wp = 0; wp < wheelPts.length; wp++) {
        const { arm, w } = wheelPts[wp];
        const fWx = this.px + fx * arm;
        const fWz = this.pz + fz * arm;
        const rx = ramp.dir === 1 ? fWx - ramp.x0 : ramp.x0 - fWx;
        const rz = fWz - ramp.z0;
        if (rx < -0.6 || rx > ramp.len + 0.6 || Math.abs(rz) > ramp.halfW + 0.6) continue;

        const wheelBottom = w.y - this.R - this.terrain.macro(fWx, fWz);

        // Задняя вертикальная стенка трамплина (въезд со стороны высокого торца)
        const vxW = this.u * fx + this.v * lx;
        if (
          rx >= ramp.len - 0.2 &&
          rx <= ramp.len + 0.36 &&
          Math.abs(rz) < ramp.halfW + 0.22 &&
          wheelBottom < ramp.h - 0.12 &&
          vxW * ramp.dir < 0
        ) {
          const targetX = ramp.x0 + ramp.dir * (ramp.len + 0.37);
          this.px += targetX - fWx;
          if (!quiet) {
            const preVzW = this.u * fz + this.v * lz;
            const preSpeed = Math.hypot(vxW, preVzW);
            const vn = Math.abs(vxW);
            this.u *= -0.18;
            this.v *= 0.4;
            this.wf.omega *= 0.3;
            this.wr.omega *= 0.3;
            this.impactMag = Math.max(this.impactMag, vn);
            if (vn > 3.8) {
              this.doCrash('Удар о торец трамплина', {
                kind: 'obstacle',
                preVxW: vxW,
                preVyW: this.vyb,
                preVzW,
                preSpeed,
                impactVn: vn,
                impactNx: ramp.dir,
                impactNz: 0,
                impactX: fWx,
                impactY: this.yb,
                impactZ: fWz,
              });
            }
          }
          break;
        }

        // Боковые стенки трамплина (въезд сбоку там, где ступенька выше 13 см)
        if (rx > 0.85 && rx < ramp.len) {
          const rampH = (rx / ramp.len) * ramp.h;
          if (rampH > 0.13 && wheelBottom < rampH - 0.1) {
            const distZ = Math.abs(rz) - ramp.halfW;
            if (distZ > -0.22 && distZ < 0.26) {
              const signZ = rz >= 0 ? 1 : -1;
              const vzW = this.u * fz + this.v * lz;
              if (vzW * signZ < 0) {
                const preVxW = this.u * fx + this.v * lx;
                const preSpeed = Math.hypot(preVxW, vzW);
                this.pz = ramp.z0 + signZ * (ramp.halfW + 0.26) - fz * arm;
                if (!quiet) {
                  const vn = Math.abs(vzW);
                  const dVzW = -vzW * 1.15;
                  this.u += dVzW * fz;
                  this.v += dVzW * lz;
                  this.impactMag = Math.max(this.impactMag, vn);
                  if (vn > 4.0) {
                    this.doCrash('Удар о борт трамплина', {
                      kind: 'obstacle',
                      preVxW,
                      preVyW: this.vyb,
                      preVzW: vzW,
                      preSpeed,
                      impactVn: vn,
                      impactNx: 0,
                      impactNz: signZ,
                      impactX: fWx,
                      impactY: this.yb,
                      impactZ: fWz,
                    });
                  }
                }
                break;
              }
            }
          }
        }
      }
    }
  }

  protected updateCones(dt: number, fx: number, fz: number, lx: number, lz: number) {
    const pts = [
      { x: this.px + fx * this.a0, z: this.pz + fz * this.a0, r: 0.2 },
      { x: this.px, z: this.pz, r: 0.22 },
      { x: this.px - fx * this.b0, z: this.pz - fz * this.b0, r: 0.2 },
    ];
    const vxW = this.u * fx + this.v * lx;
    const vzW = this.u * fz + this.v * lz;

    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];

      if (Math.abs(c.x - this.px) < 2.2 && Math.abs(c.z - this.pz) < 2.2) {
        for (let p = 0; p < pts.length; p++) {
          const pt = pts[p];
          const dx = c.x - pt.x;
          const dz = c.z - pt.z;
          const d = Math.hypot(dx, dz);
          const minD = c.r + pt.r;
          if (d < minD) {
            const nx = d > 1e-4 ? dx / d : fx;
            const nz = d > 1e-4 ? dz / d : fz;
            c.x = pt.x + nx * (minD + 0.02);
            c.z = pt.z + nz * (minD + 0.02);
            const hitSpd = Math.max(1.8, Math.hypot(vxW, vzW) * 1.15);
            c.vx = vxW * 0.85 + nx * hitSpd * 0.65;
            c.vz = vzW * 0.85 + nz * hitSpd * 0.65;
            c.vy = Math.min(3.4, 0.9 + hitSpd * 0.26);
            c.vRotX = nz * hitSpd * 2.6 + (Math.random() - 0.5) * 3;
            c.vRotZ = -nx * hitSpd * 2.6 + (Math.random() - 0.5) * 3;
            c.fallen = true;
            this.u *= 0.985;
            this.impactMag = Math.max(this.impactMag, 1.1);
            break;
          }
        }
      }

      if (c.fallen) {
        const gy = this.terrain.height(c.x, c.z);
        c.vy -= G * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        c.rotX += c.vRotX * dt;
        c.rotZ += c.vRotZ * dt;

        if (c.y <= gy) {
          c.y = gy;
          if (c.vy < -0.5) {
            c.vy = -c.vy * 0.32;
          } else {
            c.vy = 0;
          }
          const fr = Math.exp(-dt * 3.8);
          c.vx *= fr;
          c.vz *= fr;
          c.vRotX *= fr;
          c.vRotZ *= fr;
          const tilt = Math.hypot(c.rotX, c.rotZ);
          if (tilt > 0.05 && tilt < 1.35) {
            const k = (1.35 - tilt) * 4 * dt;
            c.rotX += (c.rotX / tilt) * k;
            c.rotZ += (c.rotZ / tilt) * k;
          }
        }
      }
    }
  }

  step(inp: SimInput, dt: number) {
    const c = this.cfg;
    const T = c.tune;
    const M = MODELS[c.model] ?? MODELS.g2;
    const R = this.R;
    const crashed = this.crashed;
    const wf = this.wf;
    const wr = this.wr;
    this.time += dt;

    // ---------- режим / тяга / задний ход ----------
    const pw = c.mode === 'eco' ? 0.5 : c.mode === 'drive' ? 0.8 : 1;
    // Each scooter has its own factory gears; DRIVE is not 75% of SPORT.
    const vlim = M.modeSpeeds[c.mode] / 3.6;
    const battK = this.battery > 0.002 ? 0.75 + 0.25 * Math.min(1, this.battery / 0.25) : 0;

    if (!crashed && !this.settling && inp.throttle < 0.05 && inp.brake > 0.5 && this.u < 0.25) {
      this.reverseHoldT += dt;
      if (this.reverseHoldT > 0.32) {
        this.reversing = true;
      }
    } else if (inp.throttle > 0.05 || inp.brake < 0.1) {
      this.reverseHoldT = 0;
      this.reversing = false;
    }

    // TCS
    const kDrive = M.awd ? Math.max(wr.kappa, wf.kappa) : wr.kappa;
    const tcsTarget = T.tcs && kDrive > 0.1 ? clamp(1 - (kDrive - 0.1) * 9, 0.05, 1) : 1;
    this.tcsF += (tcsTarget - this.tcsF) * Math.min(1, dt * 40);
    this.tcsActive = this.tcsF < 0.9;

    const thT = crashed ? 0 : inp.throttle;
    this.thr += clamp(thT - this.thr, -8 * dt, 2.8 * dt);

    let Fd = 0;
    if (!crashed) {
      if (this.reversing) {
        const revLim = -1.8; // ~6.5 км/ч назад
        Fd = -95 * inp.brake * battK * clamp((this.u - revLim) / 0.8, 0, 1);
      } else {
        const cap = Math.min(M.force * pw, (M.peakPower * pw) / Math.max(Math.abs(this.u), 0.8)) * battK;
        Fd = this.thr * this.tcsF * cap * clamp((vlim - this.u) / 0.12, 0, 1);
      }
    }

    // ---------- вес райдера и геометрия ----------
    this.lean += ((crashed ? 0 : inp.lean) - this.lean) * Math.min(1, dt * 7.5);
    const steerCmd = crashed ? 0 : clamp(inp.steer, -1, 1);
    const latTarget = crashed ? 0 : steerCmd * clamp(0.35 + Math.abs(this.u) * 0.06, 0.35, 1.0);
    this.leanLat += (latTarget - this.leanLat) * Math.min(1, dt * 8.5);

    const a0 = this.a0;
    const b0 = this.b0;
    this.aE = a0;
    this.bE = b0;

    // ---------- рулевое управление с возвращающим моментом кастора (trail) и демпфером ----------
    const absU = Math.abs(this.u);
    const sens = T.steerSens / 100;
    const wheelbase = a0 + b0;
    const uu = Math.max(absU, 0.5) ** 2;
    // Райдер оценивает сцепление с запаздыванием и не закладывает крен круче, чем держит покрытие
    this.muSense += (0.5 * (wf.mu + wr.mu) - this.muSense) * Math.min(1, dt * 0.7);
    const phiMax = Math.min(clamp(0.62 * sens, 0.3, 0.76), Math.atan(this.muSense));
    // На малой скорости руль ограничен упором, на высокой — допустимым креном
    const ayDirect = (uu * Math.tan(Math.abs(steerCmd) * 0.58 * sens)) / wheelbase;
    const ayCmd = -Math.sign(steerCmd) * Math.min(ayDirect, G * Math.tan(phiMax) * Math.abs(steerCmd));
    const wLean = this.airborne ? 0 : clamp((absU - 2.5) / 3.5, 0, 1) ** 2 * (3 - 2 * clamp((absU - 2.5) / 3.5, 0, 1));
    const dKin = Math.atan((wheelbase * ayCmd) / uu);
    const dLean = Math.atan((wheelbase * G * Math.tan(this.phi)) / uu);

    // Эффект контрруления на входе в вираж + стабилизация кастором (при отпускании руля dTarget строго = 0)
    const counterSteerImpulse =
      absU > 3.2 && Math.abs(steerCmd) > 0.05 ? clamp(this.rollRate * 0.024, -0.045, 0.045) : 0;
    // При заносе задней оси (this.v) кастор помогает подруливать в сторону заноса
    const driftAlign =
      !this.airborne && absU > 2.5 && Math.abs(this.v) > 0.25
        ? clamp(Math.atan2(this.v, absU) * 0.32 * (1 - 0.5 * Math.abs(steerCmd)), -0.18, 0.18)
        : 0;
    // Райдер подправляет руль, пока боковое ускорение не уравновесит крен (компенсация увода шин);
    // на пределе сцепления доворачивать бесполезно — поправка сбрасывается
    if (!crashed && wLean > 0 && wf.util < 0.75 && wr.util < 0.75) {
      const ayErr = G * Math.tan(this.phi) - this.u * this.r;
      this.steerTrim = clamp(this.steerTrim + ((ayErr * wheelbase) / uu) * 2.5 * wLean * dt, -0.1, 0.1);
    } else {
      this.steerTrim *= Math.exp(-dt * 5);
    }
    const dTarget = crashed
      ? 0
      : clamp(dKin + (dLean - dKin) * wLean + this.steerTrim * wLean + driftAlign - counterSteerImpulse, -0.62, 0.62);

    // Группировка при торможении: райдер знает, что жмёт рычаг, и заранее смещается назад-вниз
    const braceT = crashed || this.reversing ? 0 : clamp(Math.max(inp.brake, inp.brakeF, inp.brakeR * 0.5), 0, 1);
    this.brace += (braceT - this.brace) * Math.min(1, dt * (braceT > this.brace ? 9 : 4));

    const damperRatio = T.steerDamper / 100;
    const steerOmega = 17.5 - 3.2 * damperRatio;
    const steerZeta = 1.7 + 1.4 * damperRatio;
    const steerAccel =
      steerOmega * steerOmega * (dTarget - this.delta) -
      2 * steerZeta * steerOmega * this.steerVel;

    this.steerVel += steerAccel * dt;
    const maxSteerRate = 3.4 * (1 - 0.48 * damperRatio);
    this.steerVel = clamp(this.steerVel, -maxSteerRate, maxSteerRate);
    this.delta = clamp(this.delta + this.steerVel * dt, -0.65, 0.65);

    // ---------- тормозные рычаги ----------
    const bt = BRAKES[T.brakeType];
    const pad = PADS[T.pad];
    const bothF = Math.min(1, (2 * T.bias) / 100);
    const bothR = Math.min(1, (2 * (100 - T.bias)) / 100);
    const effBrakeInput = this.reversing ? 0 : inp.brake;
    const tF = crashed ? 0 : Math.max(inp.brakeF, effBrakeInput * bothF);
    const tR = crashed ? 0 : Math.max(inp.brakeR, effBrakeInput * bothR);
    wf.raw += clamp(tF - wf.raw, -14 * dt, 5.5 * dt);
    wr.raw += clamp(tR - wr.raw, -14 * dt, 5.5 * dt);
    const lagK = 1 - Math.exp(-dt / bt.lag);
    wf.eff += (wf.raw - wf.eff) * lagK;
    wr.eff += (wr.raw - wr.eff) * lagK;
    const shF = Math.pow(Math.max(wf.eff, 0), T.curve);
    const shR = Math.pow(Math.max(wr.eff, 0), T.curve);

    // ---------- геометрия и земля ----------
    const cs = Math.cos(this.psi);
    const sn = Math.sin(this.psi);
    const fx = cs;
    const fz = -sn;
    const lx = -sn;
    const lz = -cs;
    this.envelope(this.px + fx * a0, this.pz + fz * a0, fx, fz, T.fPsi, wf);
    this.envelope(this.px - fx * b0, this.pz - fz * b0, fx, fz, T.rPsi, wr);
    this.terrain.gradient(this.px, this.pz, this.grad);
    const slopeF = this.grad.x * fx + this.grad.z * fz;
    const slopeL = this.grad.x * lx + this.grad.z * lz;

    // ---------- шины: нормальная нагрузка ----------
    const ktF = 4400 * T.fPsi;
    const ktR = 4400 * T.rPsi;
    const ct = 440;
    for (const [w, kt] of [
      [wf, ktF],
      [wr, ktR],
    ] as [Wheel, number][]) {
      const hDot = clamp((w.H - w.hPrev) / dt, -7, 7);
      w.hPrev = w.H;
      const defl = w.H - w.y;
      w.fz = defl > 0 ? clamp(kt * defl + ct * (hDot - w.vy), 0, 7500) : 0;
    }
    const nowAirborne = wf.fz < 1 && wr.fz < 1;
    if (this.wasAirborne && !nowAirborne && !this.settling) {
      const landVel = Math.max(0, -this.vyb);
      if (landVel > 1.2) {
        this.impactMag = Math.max(this.impactMag, landVel * 0.8);
      }
      const slopePitch = Math.atan2(wf.H - wr.H, a0 + b0);
      const landRollErr = Math.abs(this.phi);
      if ((landVel > 2.4 && Math.abs(this.th - slopePitch) > 0.55) || (landVel > 2.8 && landRollErr > 0.62)) {
        this.doCrash('Жёсткое приземление под опасным углом', {
          kind: 'landing',
          preVyW: -landVel,
          impactVn: landVel * 1.5,
        });
      }
    }
    this.wasAirborne = nowAirborne;
    this.airborne = nowAirborne;

    // ---------- подвеска ----------
    const sth = Math.sin(this.th);
    const cth = Math.cos(this.th);
    const yAf = this.yb + a0 * sth;
    const yAr = this.yb - b0 * sth;
    const vAf = this.vyb + a0 * cth * this.wth;
    const vAr = this.vyb - b0 * cth * this.wth;
    const xf = this.X0 - (yAf - wf.y);
    const xr = this.X0 - (yAr - wr.y);
    const vxf = -(vAf - wf.vy);
    const vxr = -(vAr - wr.vy);
    wf.comp = xf;
    wr.comp = xr;
    const Fsf = this.susp(xf, vxf, T.fSpring * 1000, T.fPre / 1000, 250 + 22 * T.fComp, 400 + 38 * T.fReb);
    const Fsr = this.susp(xr, vxr, T.rSpring * 1000, T.rPre / 1000, 250 + 22 * T.rComp, 400 + 38 * T.rReb);

    // ---------- шины: продольные / боковые силы ----------
    const vFy = this.v + a0 * this.r;
    const vRy = this.v - b0 * this.r;
    const cd = Math.cos(this.delta);
    const sd = Math.sin(this.delta);
    const vxwF = this.u * cd + vFy * sd;
    const vywF = -this.u * sd + vFy * cd;

    wf.mu = this.wheelMu(wf, T.fPsi);
    wr.mu = this.wheelMu(wr, T.rPsi);
    const sfF = SURFACES[wf.surf];
    const sfR = SURFACES[wr.surf];

    let FxF = 0;
    let FyF = 0;
    let FxR = 0;
    let FyR = 0;

    if (!crashed) {
      const activeCamber = this.phi * clamp(Math.abs(this.delta) * 4.5, 0, 1);
      this.tireForce(wf, vxwF, vywF, 0.11 + 0.14 * sfF.loose, 0.13 + 0.14 * sfF.loose, activeCamber, dt);
      this.tireForce(wr, this.u, vRy, 0.11 + 0.14 * sfR.loose, 0.13 + 0.14 * sfR.loose, activeCamber, dt);
      FxF = wf.fx * cd - wf.fy * sd;
      FyF = wf.fx * sd + wf.fy * cd;
      FxR = wr.fx;
      FyR = wr.fy;
    } else {
      wf.fx = wf.fy = wr.fx = wr.fy = 0;
      wf.kappa = wr.kappa = 0;
      wf.tanA = wr.tanA = 0;
      wf.slipLon = wr.slipLon = 0;
      wf.slipLat = wr.slipLat = 0;
    }

    // ---------- вращение колёс, тормоза, рекуперация ----------
    const rotorK = T.rotor / 160;
    const baseT = 130 * bt.torque * rotorK * pad.bite;
    const Cth = 110 * rotorK * rotorK;
    const speed = Math.abs(this.u);
    const coast = this.thr < 0.05 && !this.reversing ? 1 : 0;
    const regenCmd = (T.regen / 100) * (0.22 * coast + 0.78 * Math.max(wf.eff, wr.eff));
    // Рекуперативное торможение активно и при полной батарее (ограничивается только перезаряд > 100%)
    const regenFade = clamp((speed - 0.8) / 2, 0, 1);
    const regenT = 24 * regenCmd * regenFade;
    let regenW = 0;

    const wheels: [Wheel, number, number, boolean][] = [
      [wf, shF, M.awd ? Fd * 0.5 * R : 0, M.awd],
      [wr, shR, M.awd ? Fd * 0.5 * R : Fd * R, true],
    ];
    for (const [w, sh, Tdrv, driven] of wheels) {
      // Реальная инерция: мотор-колесо ~0.09 кг·м², свободное ~0.06 (для 10″)
      const Iw = (driven ? 0.09 : 0.06) * (c.wheel / 10) ** 2;
      if (T.abs && sh > 0.04 && this.u > 1.2 && !crashed) {
        const thr = T.absThr / 100;
        const target = w.kappa < -thr ? 0 : 1;
        w.absF += (target - w.absF) * Math.min(1, dt * (target < w.absF ? 110 : 45));
      } else {
        w.absF += (1 - w.absF) * Math.min(1, dt * 60);
      }
      w.absActive = w.absF < 0.8 && sh > 0.04;

      const fade = 1 - clamp((w.temp - pad.fadeStart) / 260, 0, 0.55);
      const cold = pad.cold + (1 - pad.cold) * clamp((w.temp - 25) / 90, 0, 1);
      const wetF = w.surf === 'wet' || w.surf === 'snow' ? pad.wet : 1;
      const Tb = crashed ? 0 : sh * baseT * fade * cold * wetF * w.absF;
      const Tr = driven && !crashed ? regenT * (M.awd ? 0.5 : 1) : 0;

      let om = w.omega + ((Tdrv - w.fx * R) / Iw) * dt;
      if (crashed) om *= Math.exp(-dt * 4);
      const dBrake = ((Tb + Tr + 0.15) / Iw) * dt;
      const before = om;
      if (Math.abs(om) <= dBrake) om = 0;
      else om -= Math.sign(om) * dBrake;
      w.omega = om;
      w.angle += om * dt;
      w.locked = Math.abs(om) < 0.5 && Tb > 15 && speed > 2;

      const P = Tb * Math.abs(before);
      w.temp += (P / Cth) * dt;
      w.temp -= (w.temp - 25) * (0.35 + 0.06 * speed) * dt;
      if (Tr > 0) regenW += Tr * Math.abs(om);
    }

    // ---------- вертикальная и продольно-угловая динамика + СТАНТ (WHEELIE) ----------
    const terrainPitch = Math.atan2(wf.H - wr.H, a0 + b0);
    const relPitch = this.th - terrainPitch;

    // Управление стантом: клавиша Shift (inp.stunt) или перенос веса назад (Q / джойстик вниз) при разгоне
    const stuntBtn = !crashed && !this.reversing ? clamp(inp.stunt ?? 0, 0, 1) : 0;
    const backLean = !crashed && !this.reversing ? clamp(-inp.lean, 0, 1) : 0;
    const forwardLean = !crashed ? clamp(inp.lean, 0, 1) : 0;
    const canStunt = !crashed && !this.settling && !this.reversing && (this.u > 0.35 || this.thr > 0.15 || relPitch > 0.12);

    const rawStuntCmd = canStunt
      ? clamp(stuntBtn + backLean * (this.thr > 0.12 || relPitch > 0.12 ? 0.95 : 0.35) - forwardLean * 0.9, 0, 1)
      : 0;
    this.stuntInput += (rawStuntCmd - this.stuntInput) * Math.min(1, dt * 10);

    // Поза станта (перенос задней ноги на упор и смещение ЦТ к задней оси)
    const targetPose = clamp(Math.max(this.stuntInput, clamp((relPitch - 0.08) / 0.38, 0, 1)), 0, 1);
    this.stuntPose += (targetPose - this.stuntPose) * Math.min(1, dt * 9);

    const azb = (Fsf + Fsr) / this.Mb - G;
    this.azBody += (azb - this.azBody) * Math.min(1, dt * 60);
    // Плечо сил шин — реальная высота общего ЦТ над дорогой: зависит от массы самоката и райдера
    const hAx = clamp(this.yb - 0.5 * (wf.y + wr.y) + R + (this.hCg - Y0) - 0.07 * this.brace, 0.45, 1.1);

    // При выходе в стант райдер встаёт на задний упор (kickplate) над задней осью,
    // при наклоне вперёд/назад (Q/E) смещает проекцию ЦТ между колёсами,
    // а при торможении приседает и отклоняется назад
    const riderLonShift = !crashed ? clamp(this.lean * 0.13 - 0.09 * this.brace, -0.14, 0.14) : 0;
    const aEff = clamp(a0 - riderLonShift, 0.38, 0.72);
    const bEff = clamp((b0 + riderLonShift) * (1 - 0.86 * this.stuntPose), 0.06, 0.76);

    // Момент от переноса веса райдера и рывка руля на себя при станте
    const leanTorque = !crashed ? -this.lean * (this.airborne ? 52 : c.riderKg * G * 0.18) : 0;

    let stuntTorque = 0;
    if (canStunt && !this.airborne && wr.fz > 15) {
      if (stuntBtn > 0.05 || (backLean > 0.2 && this.thr > 0.15) || relPitch > 0.14) {
        // Целевой угол баланса станта (Sweet Spot ~0.48..0.56 рад = 27°..32°)
        const extraPull = stuntBtn > 0.1 && backLean > 0.2 ? backLean * 0.32 : backLean > 0.2 ? (backLean - 0.2) * 0.22 : 0;
        const thrBoost = (this.thr - 0.35) * 0.14;
        const targetPitch = clamp(
          0.49 + extraPull + thrBoost - forwardLean * 0.42 - wr.eff * 0.55,
          0.0,
          0.92,
        );
        const activeDrive = Math.max(stuntBtn, backLean * (this.thr > 0.1 ? 0.9 : 0.4), relPitch > 0.18 ? 0.65 : 0);
        const pitchErr = targetPitch - relPitch;
        stuntTorque = activeDrive * (pitchErr * 680 - this.wth * 52);
      }
      // Задний тормоз в станте резко и предсказуемо опускает нос самоката (спасает от переворота назад!)
      if (relPitch > 0.08 && wr.eff > 0.02) {
        stuntTorque -= wr.eff * 340 * clamp(relPitch / 0.3, 0.2, 1.3);
      }
    }

    const tau =
      (Fsf * aEff - Fsr * bEff) * cth +
      (FxF + FxR) * hAx +
      leanTorque +
      stuntTorque -
      38 * this.wth;

    this.vyb += azb * dt;
    this.yb += this.vyb * dt;
    this.wth += (tau / this.Ib) * dt;
    this.th += this.wth * dt;

    // Расширенный диапазон угла тангажа для полноценного станта (до ~50° вверх) и стоппи
    const maxUpPitch = 0.88;
    const maxDownPitch = 0.48;
    if (this.th > terrainPitch + maxUpPitch) {
      this.th = terrainPitch + maxUpPitch;
      this.wth = Math.min(0, this.wth);
    } else if (this.th < terrainPitch - maxDownPitch) {
      this.th = terrainPitch - maxDownPitch;
      this.wth = Math.max(0, this.wth);
    }

    for (const [w, Fs] of [
      [wf, Fsf],
      [wr, Fsr],
    ] as [Wheel, number][]) {
      const aw = (w.fz - Fs) / this.muW - G;
      w.vy += aw * dt;
      w.y += w.vy * dt;
    }

    // ---------- плоское движение ----------
    const rrK = TIRES[c.tire];
    const rrF = SURFACES[wf.surf];
    const rrR = SURFACES[wr.surf];
    const rrCoef = (s: typeof rrF, psi: number) => {
      const tm = s.soft ? rrK.rrSoft : rrK.rrHard;
      const pm = s.soft ? 0.7 + 0.015 * psi : 1.4 - 0.0111 * psi;
      return s.rr * tm * clamp(pm, 0.7, 1.6);
    };
    const rrForce =
      (rrCoef(rrF, T.fPsi) * wf.fz + rrCoef(rrR, T.rPsi) * wr.fz + 4) * Math.tanh(this.u * 6);
    // Standing rider + scooter: effective drag area, calibrated on flat asphalt.
    const cdA = 0.4 - 0.08 * Math.max(0, this.lean);
    const drag = 0.5 * 1.2 * cdA * this.u * Math.abs(this.u);

    let du: number;
    let dv: number;
    let dr: number;
    // В полёте уклон под колёсами не действует на аппарат
    const gnd = this.airborne ? 0 : 1;
    if (!crashed) {
      du = (FxF + FxR - drag - rrForce) / this.Mt + this.v * this.r - G * slopeF * gnd;
      dv = (FyF + FyR) / this.Mt - this.u * this.r - G * slopeL * gnd;
      // Демпфирование рыскания зависит от скорости и демпфера руля
      const yawDamp = 0.38 + 0.18 * (T.steerDamper / 100);
      dr = (a0 * FyF - b0 * FyR) / this.Iz - this.r * yawDamp;

      // Подруливание наклоном корпуса на заднем колесе во время станта (когда переднее колесо в воздухе)
      if (!this.airborne && wf.fz < 25 && wr.fz > 30 && relPitch > 0.12 && this.u > 0.5) {
        const wheelieSteer = -inp.steer * (T.steerSens / 100);
        const steerRate = wheelieSteer * clamp(1.65 / (1 + this.u * 0.08), 0.45, 1.5);
        dr += (steerRate - this.r) * 6.5;
        dv *= 0.92;
      }
    } else {
      const sp = Math.hypot(this.u, this.v);
      const fr = 0.54 * Math.max(wf.mu, 0.18) * G;
      const k = sp > 1e-3 ? Math.min(fr, sp / dt) / sp : 0;
      du = -this.u * k + this.v * this.r - G * slopeF;
      dv = -this.v * k - this.u * this.r - G * slopeL;
      dr = -this.r * 3.4;
    }
    this.u += du * dt;
    this.v += dv * dt;
    this.r += dr * dt;

    if (!crashed && !this.airborne) {
      const brakeHold = Math.max(wf.eff, wr.eff);
      if (brakeHold > 0.15 && this.thr < 0.05 && !this.reversing && Math.abs(this.u) < 0.45) {
        const holdRate = Math.min(1, dt * 28 * brakeHold);
        this.u *= 1 - holdRate;
        if (Math.abs(this.u) < 0.03) this.u = 0;
      }
      if (Math.abs(this.u) < 0.6) {
        const latHold = Math.min(1, dt * 18 * (wf.mu + wr.mu));
        this.v *= 1 - latHold;
        this.r *= 1 - latHold;
        if (Math.abs(this.v) < 0.015) this.v = 0;
      }
    }

    this.axB += (du - this.axB) * Math.min(1, dt * 20);
    this.ayLat += (this.u * this.r - this.ayLat) * Math.min(1, dt * 20);
    this.psi += this.r * dt;
    this.px += (this.u * fx + this.v * lx) * dt;
    this.pz += (this.u * fz + this.v * lz) * dt;
    this.odo += Math.abs(this.u) * dt;

    // ---------- динамика крена 2-го порядка (инерция крена, перенос веса, гироскопический момент) ----------
    if (!crashed) {
      // Самокат — одноколейный: на скорости райдер задаёт крен, а руль лишь удерживает равновесие.
      // На малой скорости крен, наоборот, следует за фактическим поворотом.
      const speedFactor = clamp((absU - 0.7) / 2.8, 0, 1);
      const centripetalLean = Math.atan((this.u * this.r) / G);
      const commandedLean = Math.atan(ayCmd / G);
      const phiTarget = this.airborne
        ? 0
        : clamp((centripetalLean + (commandedLean - centripetalLean) * wLean) * speedFactor, -0.82, 0.82);

      // Гироскопы колёс и масса аппарата замедляют перекладку: тяжёлый G4 валится в поворот ленивее G2
      const gyro = (Math.abs(wf.omega) + Math.abs(wr.omega)) * 0.0011 * (this.R / 0.13) ** 2;
      const rollOmega = this.airborne ? 4.2 : (8.8 * Math.sqrt(28 / this.Ix)) / (1 + gyro);
      const rollZeta = this.airborne ? 0.9 : 1.02 + 0.22 * (T.steerDamper / 100);
      const rollAccel =
        rollOmega * rollOmega * (phiTarget - this.phi) - 2 * rollZeta * rollOmega * this.rollRate;
      this.rollRate = clamp(this.rollRate + rollAccel * dt, -5.5, 5.5);
      this.phi = clamp(this.phi + this.rollRate * dt, -0.86, 0.86);
    } else {
      this.rollRate *= Math.exp(-dt * 6);
    }

    // ---------- энергия ----------
    const pel = (Math.abs(Fd) * Math.max(Math.abs(this.u), 0)) / 0.85 + (this.thr > 0.01 || this.reversing ? 18 : 0);
    this.power = pel - regenW * 0.5;
    this.battery = clamp(this.battery - ((this.power * dt) / 3600 / M.battWh) * 8, 0, 1);

    // ---------- коллизии с препятствиями и конусами ----------
    if (!this.settling) {
      this.resolveObstacleCollisions(false);
      this.updateCones(dt, fx, fz, lx, lz);
    }

    // ---------- границы арены ----------
    const lim = HALF - 1.2;
    if (Math.abs(this.px) > lim || Math.abs(this.pz) > lim) {
      const vxW = this.u * fx + this.v * lx;
      const vzW = this.u * fz + this.v * lz;
      let vn = 0;
      if (Math.abs(this.px) > lim) {
        vn = Math.max(vn, Math.abs(vxW));
        this.px = clamp(this.px, -lim, lim);
      }
      if (Math.abs(this.pz) > lim) {
        vn = Math.max(vn, Math.abs(vzW));
        this.pz = clamp(this.pz, -lim, lim);
      }
      this.impactMag = Math.max(this.impactMag, vn);
      if (vn > 4.5) {
        const preSpeed = Math.hypot(vxW, vzW);
        this.u *= 0.25;
        this.v *= 0.25;
        this.doCrash('Столкновение с ограждением', {
          kind: 'obstacle',
          preVxW: vxW,
          preVyW: this.vyb,
          preVzW: vzW,
          preSpeed,
          impactVn: vn,
          impactNx: Math.abs(this.px) >= lim ? -Math.sign(this.px) : 0,
          impactNz: Math.abs(this.pz) >= lim ? -Math.sign(this.pz) : 0,
        });
      } else {
        this.u *= 0.35;
        this.v *= 0.35;
      }
    }

    // ---------- учёт станта (Wheelie), заноса и условия падения ----------
    const relPitchNow = this.th - terrainPitch;
    const degNow = Math.max(0, (relPitchNow * 180) / Math.PI);
    this.stuntAngle = degNow;

    if (!crashed && !this.settling) {
      // Различаем контролируемый занос заднего колеса (дрифт) и срыв переднего колеса (lowside washout)
      const bodySideslip = speed > 3.2 ? Math.abs(Math.atan2(this.v, Math.abs(this.u))) : 0;
      const counterSteeringHelp =
        this.v * this.delta > 0.01 ? clamp(Math.abs(this.delta) * 1.4, 0, 0.45) : 0;

      // Срыв передней оси (особенно при пережатии переднего тормоза в наклоне на скользком покрытии)
      const frontOverloaded =
        !this.airborne &&
        !this.wheelie &&
        speed > 4.2 &&
        Math.abs(wf.tanA) > 0.68 + counterSteeringHelp * 0.35 &&
        (Math.abs(this.phi) > 0.22 || wf.locked || Math.abs(wf.tanA) > 0.88);
      if (frontOverloaded) {
        this.frontWashT += dt * (wf.locked ? 1.45 : 1.0);
      } else {
        this.frontWashT = Math.max(0, this.frontWashT - dt * 2.6);
      }

      // Глубокий боковой разворот (разворот поперёк хода свыше ~45° без контрруления)
      const spinOut =
        !this.airborne &&
        !this.wheelie &&
        speed > 4.5 &&
        (bodySideslip > 0.78 + counterSteeringHelp || Math.abs(wr.tanA) > 1.15);
      if (spinOut) {
        this.slipT += dt;
      } else {
        this.slipT = Math.max(0, this.slipT - dt * 2.4);
      }

      if (this.frontWashT > 0.38) {
        this.doCrash('Срыв переднего колеса в повороте', { kind: 'slip' });
      } else if (this.slipT > 0.48) {
        this.doCrash('Критический занос: потеря сцепления', { kind: 'slip' });
      }

      const endoNow =
        !this.airborne &&
        wr.fz < 8 &&
        wf.fz > 60 &&
        this.u > 3 &&
        Math.max(wf.eff, 0) > 0.5 &&
        this.axB < -3;
      this.endo = endoNow;

      const wheelieNow = !this.airborne && wf.fz < 12 && wr.fz > 35 && degNow > 7.5 && this.u > 0.8;
      this.wheelie = wheelieNow;
      this.tailScrape = wheelieNow && degNow > 36 && this.u > 1.5;

      if (wheelieNow) {
        this.stuntHoldGrace = 0.4;
        const dMeters = Math.max(0, this.u) * dt;
        this.stuntDist += dMeters;
        this.stuntTime += dt;
        const zoneMult = degNow >= 19 && degNow <= 37 ? 2.2 : degNow > 37 ? 2.8 : 1.0;
        this.stuntScore += dMeters * 15 * zoneMult;
        if (this.stuntDist > this.bestStuntDist) this.bestStuntDist = this.stuntDist;
        if (this.stuntScore > this.bestStuntScore) this.bestStuntScore = this.stuntScore;
      } else {
        if (this.stuntHoldGrace > 0) {
          this.stuntHoldGrace = Math.max(0, this.stuntHoldGrace - dt);
        } else {
          this.stuntDist = 0;
          this.stuntTime = 0;
          this.stuntScore = 0;
        }
      }

      // Проверка переворота назад при критическом угле станта (> 47.5°)
      if (wheelieNow && degNow > 47.5) {
        this.loopOutT += dt;
        if (this.loopOutT > 0.28) {
          this.doCrash('Опрокидывание назад! Перекрутил угол станта — контролируй задним тормозом (X / Пробел)', {
            kind: 'loopout',
          });
        }
      } else {
        this.loopOutT = Math.max(0, this.loopOutT - dt * 2.5);
      }

      if (endoNow) this.endoT += dt;
      else this.endoT = Math.max(0, this.endoT - dt * 2.2);
      if (this.endoT > 0.32) {
        this.doCrash('Через руль! Слишком резкое переднее торможение', {
          kind: 'endo',
          preVyW: Math.max(this.vyb, 0.85),
        });
      }
    } else {
      this.wheelie = false;
      this.tailScrape = false;
      if (crashed) {
        this.stuntDist = 0;
        this.stuntTime = 0;
        this.stuntScore = 0;
      }
    }
    if (crashed) this.crashT += dt;
  }

  telemetry(): Telemetry {
    const wf = this.wf;
    const wr = this.wr;
    const deg = this.stuntAngle;
    const showStunt = this.wheelie || (this.stuntHoldGrace > 0 && this.stuntDist > 0.5);
    const stuntZone: Telemetry['stuntZone'] =
      !showStunt && deg < 5
        ? 'none'
        : deg > 37.5
          ? 'danger'
          : deg >= 19
            ? 'sweet'
            : 'lift';
    return {
      speed: this.u,
      throttle: this.thr,
      battery: this.battery,
      power: this.power,
      surface: wr.surf,
      compF: clamp(wf.comp / this.travel, 0, 1),
      compR: clamp(wr.comp / this.travel, 0, 1),
      tempF: wf.temp,
      tempR: wr.temp,
      absActive: wf.absActive || wr.absActive,
      tcsActive: this.tcsActive,
      gLon: this.axB / G,
      gLat: this.ayLat / G,
      crashed: this.crashed,
      crashReason: this.crashReason,
      airborne: this.airborne,
      odo: this.odo,
      slipF: wf.util,
      slipR: wr.util,
      lockF: wf.locked,
      lockR: wr.locked,
      endo: this.endo,
      wheelie: showStunt,
      stuntAngle: deg,
      stuntDist: this.stuntDist,
      stuntTime: this.stuntTime,
      stuntScore: Math.round(this.stuntScore),
      bestStuntDist: this.bestStuntDist,
      bestStuntScore: Math.round(this.bestStuntScore),
      stuntZone,
      tailScrape: this.tailScrape,
    };
  }
}
