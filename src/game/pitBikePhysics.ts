import { BRAKES, MODELS, PADS, SURFACES, TIRES, type SimInput, type Telemetry } from './data';
import { ScooterSim, Wheel, type SimConfig } from './physics';
import { PITBIKE } from './pitBikeSpec';
import { HALF, type Terrain } from './terrain';

// Физика питбайка Kukirin X1. Собственная модель динамики, не самокатная:
//  • мотор в раме → цепь → заднее колесо: момент, обороты и противо-ЭДС мотора, просадка батареи;
//  • крен — отдельная степень свободы: поворот — это наклон, боковую силу дают шины
//    мотоциклетного профиля (camber thrust), при срыве сцепления байк реально заваливается;
//  • телескопическая вилка (клевок при торможении) и маятник с цепью (анти-приседание при разгоне);
//  • вилли и стоппи — баланс вокруг реальной точки равновесия над осью опорного колеса;
//  • в воздухе байк доворачивают корпусом, газом и тормозом (реакция заднего колеса), рулём делают уип.
// Райдер-«автопилот» помогает держать крен и угол станта, но сцепление шин и запас момента — настоящие.
// Общими с самокатом остаются только столкновения с объектами карты и учёт аварий.

const G = 9.81;
const S = PITBIKE.scale;
const YREF = 0.8; // высота опорной точки рамы в покое (общая с рендером и камерой)
const ETA = 0.93; // КПД цепи
const KV = (PITBIKE.motorRpm * Math.PI) / 30 / PITBIKE.voltage; // рад/с на вольт
const PACK_R = 0.07; // внутреннее сопротивление батареи, Ом
const BATT_TIME_SCALE = 8; // расход ускорен так же, как у самокатов
const SIN_RAKE = Math.sin(PITBIKE.rake);
const TAN_RAKE = Math.tan(PITBIKE.rake);
// райдер: скорость закладки в поворот и жёсткость удержания крена корпусом
const BAL = { refW: 7.5, refRate: 2.4, wn: 8.5, zeta: 1, tMax: 650, som: 45 };
export const WHEELIE = { below: 0.08, pull: 680, hold: 420, loopDeg: 50 }; // рад, Н·м, град
export const STOPPIE = { target: 0.36, push: 520, endo: 0.8 };

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export class PitBikeSim extends ScooterSim {
  rF: number = PITBIKE.rFront;
  rR: number = PITBIKE.rRear;
  muF = 6.5; // неподрессоренная масса спереди: колесо, тормоз, низ вилки
  muR = 9.5; // сзади: колесо, звезда, тормоз, часть маятника
  travelR = 0.11 * S;
  x0F = 0.59;
  x0R = 0.59;
  motorRpm = 0;
  busV: number = PITBIKE.voltage;
  private hNow = 0.8; // высота ЦТ над дорогой на прошлом шаге
  phiRef = 0; // сглаженное задание крена
  private phiRefRate = 0;
  private airYaw = 0; // доворот байка в воздухе относительно траектории (уип)
  stoppie = false;
  stoppieDeg = 0;
  private stoppieIn = 0; // сглаженное намерение стоппи
  airTime = 0;
  private cbF = 1; // доля тормоза/газа, которую райдер оставляет в наклоне
  private cbR = 1;

  constructor(terrain: Terrain, cfg: SimConfig) {
    super(terrain, cfg);
    // поля подкласса инициализируются после конструктора базы — пересчитываем параметры
    this.configure(cfg);
  }

  configure(cfg: SimConfig) {
    const prevKey = this.structKey;
    this.cfg = cfg;
    const m = MODELS[cfg.model] ?? MODELS.x1;
    this.rF = PITBIKE.rFront;
    this.rR = PITBIKE.rRear;
    this.R = this.rR;
    this.Mt = m.mass + cfg.riderKg;
    this.Mb = this.Mt - 16; // muF + muR
    // райдер сидит ближе к задней оси: развесовка ~45/55
    this.a0 = PITBIKE.a0;
    this.b0 = PITBIKE.wheelbase - this.a0;
    this.aE = this.a0;
    this.bE = this.b0;
    this.hCg = (m.mass * 0.43 * S + cfg.riderKg * (0.94 + 0.7 * (S - 1))) / this.Mt;
    this.Ib = m.mass * 0.13 + cfg.riderKg * 0.11;
    this.Iz = m.mass * 0.16 + cfg.riderKg * 0.05;
    this.Ix = m.mass * 0.045 + cfg.riderKg * 0.09; // крен вокруг ЦТ
    this.Fz0 = (this.Mt * G) / 2;
    this.travel = 0.13 * S;
    this.travelR = 0.11 * S;
    this.trail = (this.rF * SIN_RAKE - 0.03 * S) / Math.cos(PITBIKE.rake);
    this.x0F = YREF - this.rF + 0.03;
    this.x0R = YREF - this.rR + 0.025;

    const t = cfg.tune;
    const key = `${cfg.model}|${cfg.wheel}|${t.fSpring}|${t.rSpring}|${t.fPre}|${t.rPre}|${t.fPsi}|${t.rPsi}|${cfg.riderKg}`;
    this.structKey = key;
    if (this.ready && key !== prevKey && Math.abs(this.u) < 0.2 && !this.crashed) {
      this.reset(this.px, this.pz, this.psi, true);
    }
  }

  reset(x: number, z: number, psi: number, keepCones = false) {
    this.phiRef = 0;
    this.phiRefRate = 0;
    this.airYaw = 0;
    this.stoppie = false;
    this.stoppieDeg = 0;
    this.stoppieIn = 0;
    this.airTime = 0;
    this.motorRpm = 0;
    super.reset(x, z, psi, keepCones);
  }

  /** Огибающая дороги под колесом своего радиуса (перед 14″, зад 12″). */
  protected envelope(x: number, z: number, fx: number, fz: number, psi: number, w: Wheel) {
    const R = w === this.wf ? this.rF : this.rR;
    const patch = clamp(2.1 - psi / 28, 0.3, 1.5);
    const maxD = R * 0.85;
    let H = -1e9;
    for (let i = -2; i <= 2; i++) {
      const d = clamp(i * 0.06 * patch, -maxD, maxD);
      const h = this.terrain.height(x + fx * d, z + fz * d) + Math.sqrt(R * R - d * d);
      if (h > H) H = h;
    }
    w.H = H;
    w.surf = this.terrain.surface(x, z);
  }

  /** Гидравлический амортизатор: пружина с преднатягом, отбойники и «срыв» клапана на быстром сжатии. */
  private shock(x: number, v: number, k: number, pre: number, cC: number, cR: number, travel: number): number {
    let F = k * (Math.max(x, 0) + pre);
    if (x < 0) {
      F += 180000 * x + (v < 0 ? 3800 : 1200) * v * clamp(-x / 0.008, 0, 1);
    } else if (x > travel * 0.8) {
      // прогрессивный отбойник: последние 20 % хода гасят удар плавно, без «стука»
      const over = x - travel * 0.8;
      const hard = Math.max(0, x - travel);
      F += 38000 * over + 1.2e6 * over * over + 260000 * hard + (v > 0 ? 2600 : 900) * v * clamp(over / 0.02, 0, 1);
    }
    F += v > 0 ? cC * (Math.min(v, 0.9) + 0.45 * Math.max(0, v - 0.9)) : cR * v;
    if (x >= 0 && F < 0) F = 0;
    return F;
  }

  /** Мотоциклетная шина: комбинированное скольжение + боковая сила от наклона колеса. */
  private tyre(w: Wheel, R: number, vx: number, vy: number, tanCam: number, loose: number, dig: number, dt: number) {
    const absVx = Math.abs(vx);
    const rawK = clamp((w.omega * R - vx) / Math.max(absVx, 0.45), -4, 4);
    const rawA = clamp(vy / Math.max(absVx, 0.35), -4, 4);
    const roll = Math.max(absVx, Math.abs(w.omega * R), 0.75);
    w.slipLon += (rawK - w.slipLon) * Math.min(1, (roll / 0.07) * dt);
    w.slipLat += (rawA - w.slipLat) * Math.min(1, (roll / 0.16) * dt);
    w.kappa = w.slipLon;
    w.tanA = w.slipLat;

    const soften = 1 + 1.5 * loose;
    const fx0 = (13 / soften) * w.kappa;
    const fy0 = (-10 / soften) * w.tanA + 0.95 * tanCam;
    const mu = Math.max(1e-3, w.mu * clamp(1.07 - 0.11 * (w.fz / this.Fz0), 0.84, 1.05));
    const rho = Math.hypot(fx0, fy0) / mu + 1e-9;
    // за пиком: на твёрдом сцепление падает, на рыхлом шипы «гребут» и сила чуть растёт
    const post = 1 - (0.12 - dig) * smooth(1.8, 5, rho);
    // до ~70% сцепления сила линейна, дальше плавно выходит на предел
    const F = (w.fz * post) / Math.sqrt(Math.sqrt(1 + rho ** 4));
    w.fx = F * fx0;
    w.fy = F * fy0;
    w.util = rho;
  }

  private gripOf(w: Wheel, psi: number): number {
    const sf = SURFACES[w.surf];
    const tg = TIRES[this.cfg.tire].grip[w.surf];
    const pf = clamp(1 - 0.005 * Math.max(0, psi - sf.optPsi) - 0.004 * Math.max(0, sf.optPsi - psi), 0.62, 1);
    return sf.mu * tg * pf;
  }

  step(inp: SimInput, dt: number) {
    const c = this.cfg;
    const T = c.tune;
    const M = MODELS[c.model] ?? MODELS.x1;
    const wf = this.wf;
    const wr = this.wr;
    const rF = this.rF;
    const rR = this.rR;
    const a0 = this.a0;
    const b0 = this.b0;
    const L = a0 + b0;
    const crashed = this.crashed;
    this.time += dt;

    // ---------- дорога под колёсами ----------
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
    const terrainPitch = Math.atan2(wf.H - rF - (wr.H - rR), L);
    const relPitch = this.th - terrainPitch;
    const sinRel = Math.sin(relPitch);
    const cosRel = Math.cos(relPitch);
    const frontLight = wf.fz < 25;
    const rearLight = wr.fz < 25;

    // ---------- откат назад ногами (заднего хода у мотора нет) ----------
    if (!crashed && !this.settling && inp.throttle < 0.05 && inp.brake > 0.5 && this.u < 0.25) {
      this.reverseHoldT += dt;
      if (this.reverseHoldT > 0.32) this.reversing = true;
    } else if (inp.throttle > 0.05 || inp.brake < 0.1) {
      this.reverseHoldT = 0;
      this.reversing = false;
    }

    // ---------- райдер: намерение стоппи и вилли ----------
    const active = !crashed && !this.settling && !this.reversing;
    const stuntBtn = active ? clamp(inp.stunt ?? 0, 0, 1) : 0;
    const backLean = active ? clamp(-inp.lean, 0, 1) : 0;
    const forwardLean = !crashed ? clamp(inp.lean, 0, 1) : 0;

    // стоппи: стант + тормоз либо передний тормоз с весом на руль; продолжается, пока есть скорость
    const braking = Math.max(inp.brakeF, inp.brake);
    const stoppieAsk =
      active &&
      !this.airborne &&
      inp.throttle < 0.1 &&
      ((stuntBtn > 0.05 && braking > 0.3) || (inp.brakeF > 0.5 && forwardLean > 0.3));
    const stoppieWant = stoppieAsk && this.u > (relPitch < -0.05 ? 1.0 : 2.8);
    this.stoppieIn += ((stoppieWant ? 1 : 0) - this.stoppieIn) * Math.min(1, dt * 10);
    // у земли скорость уходит — райдер плавно опускает заднее колесо
    const stoppieTarget = stoppieWant
      ? clamp(STOPPIE.target + 0.14 * forwardLean - 0.2 * backLean, 0.12, 0.56) * smooth(0.8, 3.2, this.u)
      : 0;

    this.lean += ((crashed ? 0 : stoppieWant ? Math.max(inp.lean, 0.85) : inp.lean) - this.lean) * Math.min(1, dt * 7.5);

    const wheelieBtn = stoppieAsk ? 0 : stuntBtn;
    const canStunt = active && (this.u > 0.35 || this.thr > 0.15 || relPitch > 0.12 || wheelieBtn > 0.05);
    const manualUp = backLean > 0.2 && this.thr > 0.15;
    const wantUp = canStunt && (wheelieBtn > 0.05 || manualUp);
    const rawStunt = canStunt
      ? clamp(wheelieBtn + backLean * (this.thr > 0.12 || relPitch > 0.12 ? 0.95 : 0.35) - forwardLean * 0.9, 0, 1)
      : 0;
    this.stuntInput += (rawStunt - this.stuntInput) * Math.min(1, dt * 10);
    const poseT = clamp(Math.max(this.stuntInput, clamp((relPitch - 0.08) / 0.38, 0, 1)), 0, 1);
    this.stuntPose += (poseT - this.stuntPose) * Math.min(1, dt * 9);
    // угол баланса: Q поднимает выше, E и задний тормоз опускают
    const balAng = Math.atan2(this.bE, Math.max(0.2, this.hNow - rR)); // точка равновесия над задней осью
    const stuntTarget = !wantUp
      ? 0
      : clamp(
          (wheelieBtn > 0.05 ? balAng - WHEELIE.below + 0.1 * backLean : balAng - 0.2 + 0.2 * (backLean - 0.2)) -
            0.3 * forwardLean -
            0.4 * inp.brakeR,
          0,
          0.64,
        );

    // ---------- ручка газа, мотор, цепь ----------
    // в вилли райдер сам работает газом вокруг точки баланса
    const balThr = clamp(0.62 + 2.6 * (stuntTarget - relPitch) - 0.45 * this.wth, 0, 1);
    let thT = 0;
    if (!crashed && !stoppieWant) {
      if (wheelieBtn > 0.05 && canStunt) thT = wheelieBtn * balThr * (0.62 + 0.38 * inp.throttle);
      else if (wantUp) thT = inp.throttle * (relPitch > 0.1 ? clamp(balThr + 0.15, 0.1, 1) : 1);
      else thT = inp.throttle * clamp(1 - (relPitch - 0.15) * 6, 0, 1);
    }
    thT *= 1 - 0.85 * (1 - this.cbR) * (wr.kappa > 0.02 ? 1 : 0);
    this.thr += clamp(thT - this.thr, -10 * dt, 5 * dt);

    const tcsTarget = T.tcs && wr.kappa > 0.12 ? clamp(1 - (wr.kappa - 0.12) * 8, 0.05, 1) : 1;
    this.tcsF += (tcsTarget - this.tcsF) * Math.min(1, dt * 40);
    this.tcsActive = this.tcsF < 0.9;

    const modeK = c.mode === 'eco' ? 0.55 : c.mode === 'drive' ? 0.8 : 1;
    const vlim = M.modeSpeeds[c.mode] / 3.6;
    const vOc = this.battery > 0.002 ? 43 + 11.6 * this.battery : 0;
    const wm = Math.max(0, wr.omega) * PITBIKE.gear;
    this.motorRpm = (wm * 30) / Math.PI;
    const wNoLoad = KV * Math.min(this.busV, vOc);
    let Tm = 0;
    if (!crashed && !this.reversing && wNoLoad > 1) {
      const cap = Math.min(PITBIKE.motorTorque * modeK, (PITBIKE.motorPeakW * modeK) / Math.max(wm, 20));
      const emf = clamp((wNoLoad - wm) / (0.08 * wNoLoad), 0, 1); // противо-ЭДС у предела оборотов
      const limiter = clamp((vlim - wr.omega * rR) / 0.05, 0, 1); // ограничитель режима по скорости колеса
      Tm = this.thr * this.tcsF * cap * emf * limiter;
    }
    const Tdrive = Tm * PITBIKE.gear * ETA;
    const pushBack =
      this.reversing && !crashed ? -70 * inp.brake * clamp((this.u + 1.1) / 0.5, 0, 1) : 0;

    // ---------- руль и крен: райдер закладывает байк и ведёт руль под него ----------
    const absU = Math.abs(this.u);
    const uu = Math.max(absU, 0.5) ** 2;
    const sens = T.steerSens / 100;
    const steerCmd = crashed ? 0 : clamp(inp.steer, -1, 1);
    const latT = crashed ? 0 : steerCmd * clamp(0.3 + absU * 0.05, 0.3, 0.9);
    this.leanLat += (latT - this.leanLat) * Math.min(1, dt * 8.5);
    this.muSense += (0.5 * (wf.mu + wr.mu) - this.muSense) * Math.min(1, dt * 0.7);
    // запас по сцеплению остаётся под газ и тормоз в повороте
    const phiMax = Math.min(clamp(0.7 * sens, 0.3, 0.8), Math.atan(0.74 * this.muSense));
    const ayDirect = (uu * Math.tan(Math.abs(steerCmd) * 0.55 * sens)) / L;
    const ayCmd = -Math.sign(steerCmd) * Math.min(ayDirect, G * Math.tan(phiMax) * Math.abs(steerCmd));
    // под тормозами райдер приподнимает байк: часть сцепления нужна на замедление
    let phiCmd = Math.atan(ayCmd / G) * (1 - 0.45 * this.brace * smooth(2, 6, absU));
    if (this.airborne) phiCmd = -steerCmd * 0.5; // уип: в воздухе байк кладут набок рулём и корпусом
    else if (frontLight || rearLight) phiCmd *= 0.4; // на одном колесе поворачивают аккуратно
    const wBal = this.airborne || frontLight ? 0 : smooth(1.8, 4.5, this.u);
    const h = this.hNow;
    let dTarget = 0;
    let phiErr = 0;
    if (!crashed) {
      // задание крена — плавная траектория без рывков; на пределе сцепления райдер приподнимает байк
      const ease = this.airborne ? 1 : 1 - 0.6 * smooth(0.85, 1.3, Math.max(wf.util, wr.util));
      const acc = BAL.refW * BAL.refW * (phiCmd * ease - this.phiRef) - 2 * BAL.refW * this.phiRefRate;
      this.phiRefRate = clamp(this.phiRefRate + acc * dt, -BAL.refRate, BAL.refRate);
      this.phiRef += this.phiRefRate * dt;
      phiErr = this.phi - this.phiRef;
      // руль даёт ровно ту боковую силу, что уравновешивает заданный крен; ошибку добирает подруливание
      const ff = Math.atan((L * G * Math.tan(this.phiRef)) / uu);
      const fb = wBal * (0.55 * phiErr + 0.12 * (this.rollRate - this.phiRefRate));
      const drift =
        !this.airborne && absU > 2.5 && Math.abs(this.v) > 0.3
          ? clamp(Math.atan2(this.v, absU) * 0.3, -0.16, 0.16)
          : 0;
      dTarget = clamp(ff + fb + drift, -0.6, 0.6);
    } else {
      this.phiRefRate = 0;
    }
    const damper = T.steerDamper / 100;
    const sOm = BAL.som * (1 - 0.2 * damper);
    const sZeta = 0.9 + 0.5 * damper;
    this.steerVel += (sOm * sOm * (dTarget - this.delta) - 2 * sZeta * sOm * this.steerVel) * dt;
    const maxRate = 6 * (1 - 0.4 * damper);
    this.steerVel = clamp(this.steerVel, -maxRate, maxRate);
    this.delta = clamp(this.delta + this.steerVel * dt, -0.62, 0.62);

    // ---------- тормозные рычаги ----------
    const braceT = crashed || this.reversing ? 0 : clamp(Math.max(inp.brake, inp.brakeF, inp.brakeR * 0.5), 0, 1);
    this.brace += (braceT - this.brace) * Math.min(1, dt * (braceT > this.brace ? 9 : 4));
    const bt = BRAKES[T.brakeType];
    const pad = PADS[T.pad];
    const both = this.reversing ? 0 : inp.brake;
    let tF = crashed ? 0 : Math.max(inp.brakeF, both * Math.min(1, (2 * T.bias) / 100));
    let tR = crashed ? 0 : Math.max(inp.brakeR, both * Math.min(1, (2 * (100 - T.bias)) / 100));
    if (stoppieWant) {
      // райдер дозирует передний тормоз вокруг угла баланса
      tF = clamp(0.6 + 5 * (stoppieTarget + relPitch) + 0.9 * this.wth, 0.08, 1);
      tR = inp.brakeR;
    } else if (!crashed) {
      // без команды на стоппи райдер отпускает рычаг, как только заднее колесо пошло вверх
      if (relPitch < -0.04 && rearLight) tF *= clamp(1 + (relPitch + 0.04) * 7, 0.2, 1);
      // перебор угла на заднем колесе райдер ловит задним тормозом
      if (relPitch > 0.14 && this.u > 0.5) {
        tR = Math.max(tR, clamp((relPitch - (wantUp ? stuntTarget : 0.62) - 0.06) * 8 + this.wth * 0.5, 0, 1));
      }
    }
    // в наклоне райдер дозирует тормоза и газ по сцеплению: запас шины уходит на поворот
    const leaned = crashed ? 0 : smooth(0.05, 0.22, Math.abs(this.phi) + Math.abs(this.v) / Math.max(absU, 3));
    this.cbF += ((1 - 0.45 * leaned) * (1 - 0.9 * leaned * smooth(0.8, 1.15, Math.max(wf.util, wr.util))) - this.cbF) * Math.min(1, dt * 25);
    this.cbR += ((1 - 0.9 * leaned * smooth(0.8, 1.15, wr.util)) - this.cbR) * Math.min(1, dt * 25);
    if (!stoppieWant) {
      tF *= this.cbF;
      tR *= this.cbR;
    }
    wf.raw += clamp(tF - wf.raw, -14 * dt, 6 * dt);
    wr.raw += clamp(tR - wr.raw, -14 * dt, 6 * dt);
    const lagK = 1 - Math.exp(-dt / bt.lag);
    wf.eff += (wf.raw - wf.eff) * lagK;
    wr.eff += (wr.raw - wr.eff) * lagK;
    const shF = Math.pow(Math.max(wf.eff, 0), T.curve);
    const shR = Math.pow(Math.max(wr.eff, 0), T.curve);

    // ---------- шины: нормальная нагрузка ----------
    const loads: [Wheel, number][] = [
      [wf, 3400 * T.fPsi],
      [wr, 3700 * T.rPsi],
    ];
    for (const [w, kt] of loads) {
      const hDot = clamp((w.H - w.hPrev) / dt, -7, 7);
      w.hPrev = w.H;
      const defl = w.H - w.y;
      w.fz = defl > 0 ? clamp(kt * defl + 520 * (hDot - w.vy), 0, 9000) : 0;
    }
    const nowAir = wf.fz < 1 && wr.fz < 1;
    if (this.wasAirborne && !nowAir && !this.settling) {
      const landVel = Math.max(0, -this.vyb);
      if (landVel > 1.2) this.impactMag = Math.max(this.impactMag, landVel * 0.8);
      // длинноходная подвеска и ноги райдера прощают много: падение — только при явно кривом приземлении
      if ((landVel > 3.4 && (relPitch > 0.9 || relPitch < -0.75)) || (landVel > 3.2 && Math.abs(this.phi) > 0.85)) {
        this.doCrash('Жёсткое приземление под опасным углом', {
          kind: 'landing',
          preVyW: -landVel,
          impactVn: landVel * 1.5,
        });
      }
    }
    this.wasAirborne = nowAir;
    this.airborne = nowAir;
    this.airTime = nowAir ? this.airTime + dt : 0;

    // ---------- подвеска: вилка и моноамортизатор ----------
    const sth = Math.sin(this.th);
    const cth = Math.cos(this.th);
    const xf = this.x0F - (this.yb + a0 * sth - wf.y);
    const xr = this.x0R - (this.yb - b0 * sth - wr.y);
    const vxf = wf.vy - (this.vyb + a0 * cth * this.wth);
    const vxr = wr.vy - (this.vyb - b0 * cth * this.wth);
    wf.comp = xf;
    wr.comp = xr;
    const Fsf = this.shock(xf, vxf, T.fSpring * 400, (T.fPre * 3) / 1000, 250 + 4 * T.fComp, 500 + 8 * T.fReb, this.travel);
    const Fsr = this.shock(xr, vxr, T.rSpring * 550, (T.rPre * 2.5) / 1000, 300 + 5 * T.rComp, 600 + 9 * T.rReb, this.travelR);

    // ---------- шины: продольные и боковые силы ----------
    wf.mu = this.gripOf(wf, T.fPsi);
    wr.mu = this.gripOf(wr, T.rPsi);
    const sfF = SURFACES[wf.surf];
    const sfR = SURFACES[wr.surf];
    const knob = TIRES[c.tire].tread === 'knob' ? 0.18 : 0.06;
    let FxF = 0;
    let FyF = 0;
    let FxR = 0;
    let FyR = 0;
    if (!crashed) {
      // скорость пятна контакта: ЦТ качается над ним вместе с креном
      const vC = this.v - h * Math.cos(this.phi) * this.rollRate;
      const vFy = vC + a0 * this.r;
      const vRy = vC - b0 * this.r;
      const cd = Math.cos(this.delta);
      const sd = Math.sin(this.delta);
      const tanCam = Math.tan(clamp(this.phi, -1.1, 1.1));
      this.tyre(wf, rF, this.u * cd + vFy * sd, -this.u * sd + vFy * cd, tanCam, sfF.loose, sfF.soft ? knob : 0, dt);
      this.tyre(wr, rR, this.u, vRy, tanCam, sfR.loose, sfR.soft ? knob : 0, dt);
      FxF = wf.fx * cd - wf.fy * sd;
      FyF = wf.fx * sd + wf.fy * cd;
      FxR = wr.fx;
      FyR = wr.fy;
    } else {
      wf.fx = wf.fy = wr.fx = wr.fy = 0;
      wf.kappa = wr.kappa = wf.tanA = wr.tanA = 0;
      wf.slipLon = wr.slipLon = wf.slipLat = wr.slipLat = 0;
    }

    // ---------- вращение колёс: цепь, дисковые тормоза, электронный тормоз ----------
    const speed = absU;
    const rotorK = T.rotor / 160;
    const coast = this.thr < 0.05 && !this.reversing ? 1 : 0;
    const regenCmd = (T.regen / 100) * (0.22 * coast + 0.78 * wr.eff);
    const regenT = 30 * regenCmd * clamp((speed - 0.8) / 2, 0, 1) * (this.battery > 0.002 ? 1 : 0);
    let regenW = 0;
    let spinReact = 0; // реакция рамы на раскрутку/торможение колёс в воздухе
    const Cth = 150 * rotorK * rotorK;
    const spin: [Wheel, number, number, number, number, number][] = [
      [wf, rF, shF, 0, 0.17, 300],
      [wr, rR, shR, Tdrive, 0.2 + 0.0026 * PITBIKE.gear * PITBIKE.gear, 220],
    ];
    for (const [w, R, sh, Td, Iw, baseT] of spin) {
      if (T.abs && sh > 0.04 && this.u > 1.2 && !crashed) {
        const target = w.kappa < -T.absThr / 100 ? 0 : 1;
        w.absF += (target - w.absF) * Math.min(1, dt * (target < w.absF ? 110 : 45));
      } else {
        w.absF += (1 - w.absF) * Math.min(1, dt * 60);
      }
      w.absActive = w.absF < 0.8 && sh > 0.04;
      const fade = 1 - clamp((w.temp - pad.fadeStart) / 260, 0, 0.55);
      const cold = pad.cold + (1 - pad.cold) * clamp((w.temp - 25) / 90, 0, 1);
      const wet = w.surf === 'wet' || w.surf === 'snow' ? pad.wet : 1;
      const Tb = crashed ? 0 : sh * baseT * bt.torque * rotorK * pad.bite * fade * cold * wet * w.absF;
      const Tr = w === wr && !crashed ? regenT : 0;

      const om0 = w.omega;
      let om = w.omega + ((Td - w.fx * R) / Iw) * dt;
      if (crashed) om *= Math.exp(-dt * 4);
      const dBrake = ((Tb + Tr + (w === wr ? 0.5 : 0.15)) / Iw) * dt; // у заднего — трение цепи
      const before = om;
      if (Math.abs(om) <= dBrake) om = 0;
      else om -= Math.sign(om) * dBrake;
      w.omega = om;
      w.angle += om * dt;
      w.locked = Math.abs(om) < 0.5 && Tb > 20 && speed > 2;
      w.temp += ((Tb * Math.abs(before)) / Cth) * dt;
      w.temp -= (w.temp - 25) * (0.3 + 0.06 * speed) * dt;
      if (Tr > 0) regenW += Tr * Math.abs(om);
      spinReact += (Iw * (om - om0)) / dt;
    }

    // ---------- рама: вертикаль и тангаж ----------
    const ground = 0.5 * (wf.H - rF + (wr.H - rR));
    const hAx = this.hCg + clamp(this.yb - ground - YREF, -0.12, 0.25) - 0.05 * this.brace;
    this.hNow = hAx;
    // на подъёме райдер сам сдвигается к рулю
    const climb = clamp(slopeF * 0.4, 0, 0.1) * (1 - this.stuntPose);
    const riderLon = !crashed
      ? clamp(this.lean * 0.13 * (1 - 0.6 * this.stuntPose) - 0.08 * this.brace * (1 - this.stoppieIn) + climb, -0.14, 0.17)
      : 0;
    const aEff = a0 - riderLon;
    const bEff = (b0 + riderLon) * (1 - 0.15 * this.stuntPose);
    this.aE = aEff;
    this.bE = bEff;

    // Торможение передним сжимает вилку (сила вдоль наклонных перьев), тяга цепи распирает маятник
    const jackF = -FxF * TAN_RAKE * 0.6;
    const jackR = FxR * (FxR > 0 ? 0.45 : 0.2);
    const FbF = Fsf - jackF;
    const FbR = Fsr + jackR;

    // Плечи сил относительно ЦТ: на одном колесе плечо опоры уходит в ноль в точке баланса
    const lf = aEff * cosRel + (hAx - rF) * sinRel;
    const lr = bEff * cosRel - (hAx - rR) * sinRel;
    const hx = hAx * cosRel + bEff * Math.max(0, sinRel) + aEff * Math.max(0, -sinRel);
    let riderTorque = 0;
    if (!crashed) {
      if (this.airborne) {
        // райдер корпусом ставит байк под склон приземления; Q задирает нос, E опускает
        const level = clamp(terrainPitch, -0.45, 0.45) + 0.05 - this.lean * 0.5;
        riderTorque = clamp(170 * (level - this.th) - 36 * this.wth, -150, 150) + clamp(spinReact, -260, 260);
      } else {
        riderTorque = -this.lean * c.riderKg * G * 0.16 * (1 - 0.7 * this.stuntPose) * (1 - this.stoppieIn);
        if (wantUp && wr.fz > 15) {
          // рывок руля на себя и перенос корпуса: до угла баланса тянем в полную силу, дальше — держим
          const up = relPitch < stuntTarget - 0.1 ? WHEELIE.pull : WHEELIE.hold;
          riderTorque += clamp((stuntTarget - relPitch) * 1500 - this.wth * 210, -WHEELIE.pull, up);
        } else if (stoppieWant && wf.fz > 40) {
          // бросок корпуса на руль; сам отрыв колеса — только за счёт торможения
          riderTorque += clamp((-stoppieTarget - relPitch) * 1300 - this.wth * 170, -STOPPIE.push, STOPPIE.push * 0.7);
        } else if (relPitch > 0.05 && frontLight && wr.fz > 15) {
          // переднее колесо опускают плавно, придерживая корпусом
          riderTorque += clamp(900 * (-0.6 - this.wth), -40, 600);
        } else if (relPitch < -0.05 && rearLight && wf.fz > 40) {
          riderTorque += clamp(900 * (0.6 - this.wth), -600, 40);
        }
      }
    }
    const tau = FbF * lf - FbR * lr + (FxF + FxR) * hx + riderTorque - 30 * this.wth;
    const azb = (FbF + FbR) / this.Mb - G;
    this.azBody += (azb - this.azBody) * Math.min(1, dt * 60);
    this.vyb += azb * dt;
    this.yb += this.vyb * dt;
    this.wth += (tau / this.Ib) * dt;
    this.th += this.wth * dt;
    if (this.th > terrainPitch + 0.95) {
      this.th = terrainPitch + 0.95;
      this.wth = Math.min(0, this.wth);
    } else if (this.th < terrainPitch - 0.95) {
      this.th = terrainPitch - 0.95;
      this.wth = Math.max(0, this.wth);
    }
    wf.vy += ((wf.fz + jackF - Fsf) / this.muF - G) * dt;
    wf.y += wf.vy * dt;
    wr.vy += ((wr.fz - jackR - Fsr) / this.muR - G) * dt;
    wr.y += wr.vy * dt;

    // ---------- движение в плане ----------
    const tire = TIRES[c.tire];
    const crr = (s: typeof sfF, psi: number) =>
      s.rr * (s.soft ? tire.rrSoft : tire.rrHard) * clamp(s.soft ? 0.7 + 0.015 * psi : 1.4 - 0.0111 * psi, 0.7, 1.6);
    const rrForce = (crr(sfF, T.fPsi) * wf.fz + crr(sfR, T.rPsi) * wr.fz + 5) * Math.tanh(this.u * 6);
    // райдер сидит прямо; наклон к рулю уменьшает лобовую площадь
    const cdA = 0.62 - 0.1 * Math.max(0, this.lean);
    const drag = 0.5 * 1.2 * cdA * this.u * absU;
    const gnd = this.airborne ? 0 : 1;
    let du: number;
    let dv: number;
    let dr: number;
    if (!crashed) {
      du = (FxF + FxR + pushBack * gnd - drag - rrForce) / this.Mt + this.v * this.r - G * slopeF * gnd;
      dv = (FyF + FyR) / this.Mt - this.u * this.r - G * slopeL * gnd;
      dr = (a0 * FyF - b0 * FyR) / this.Iz - this.r * (0.3 + 0.15 * damper);
      if (this.airborne) {
        // уип: байк доворачивают поперёк траектории и возвращают к приземлению
        this.airYaw += this.r * dt;
        dr += 16 * (-steerCmd * 0.3 * smooth(0.12, 0.3, this.airTime) - this.airYaw) - 6 * this.r;
      } else {
        this.airYaw = 0;
        // на заднем колесе курс правят корпусом
        if (frontLight && wr.fz > 30 && relPitch > 0.12 && this.u > 0.5) {
          const rate = -inp.steer * sens * clamp(1.4 / (1 + this.u * 0.08), 0.4, 1.3);
          dr += (rate - this.r) * 5;
          dv *= 0.92;
        }
      }
    } else {
      const sp = Math.hypot(this.u, this.v);
      const fr = 0.6 * Math.max(wf.mu, 0.18) * G; // байк скользит на боку
      const k = sp > 1e-3 ? Math.min(fr, sp / dt) / sp : 0;
      du = -this.u * k + this.v * this.r - G * slopeF;
      dv = -this.v * k - this.u * this.r - G * slopeL;
      dr = -this.r * 3.4;
    }
    this.u += du * dt;
    this.v += dv * dt;
    this.r += dr * dt;
    if (!crashed && !this.airborne) {
      const hold = Math.max(wf.eff, wr.eff);
      if (hold > 0.15 && this.thr < 0.05 && !this.reversing && absU < 0.45) {
        this.u *= 1 - Math.min(1, dt * 28 * hold);
        if (Math.abs(this.u) < 0.03) this.u = 0;
      }
      if (absU < 0.6) {
        const k = Math.min(1, dt * 18 * (wf.mu + wr.mu));
        this.v *= 1 - k;
        this.r *= 1 - k;
        if (Math.abs(this.v) < 0.015) this.v = 0;
      }
    }
    this.axB += (du - this.axB) * Math.min(1, dt * 20);
    this.ayLat += (this.u * this.r - this.ayLat) * Math.min(1, dt * 20);
    this.psi += this.r * dt;
    this.px += (this.u * fx + this.v * lx) * dt;
    this.pz += (this.u * fz + this.v * lz) * dt;
    this.odo += absU * dt;

    // ---------- крен ----------
    if (!crashed) {
      let tq: number;
      if (this.airborne) {
        // в воздухе байк кладут и выравнивают корпусом
        tq = -(170 * phiErr + 58 * (this.rollRate - this.phiRefRate));
      } else {
        const FzT = wf.fz + wr.fz;
        const gyro = (Math.abs(wf.omega) + Math.abs(wr.omega)) * 0.3;
        // перевёрнутый маятник: вес валит байк, боковая сила шин поднимает
        tq = hAx * (FzT * Math.sin(this.phi) - (FyF + FyR) * Math.cos(this.phi)) - (60 + gyro) * this.rollRate;
        // райдер корпусом и коленями ведёт байк к заданному крену. Пока шины держат — уверенно;
        // когда обе шины сорвались, сил корпуса уже не хватает и байк ложится
        const Itot = this.Ix + this.Mt * hAx * hAx;
        const slide = smooth(1.25, 2.1, Math.min(wf.util, wr.util) * 0.6 + Math.max(wf.util, wr.util) * 0.4);
        const feet = 1 - smooth(1.2, 3.2, this.u); // на малой скорости — ногами
        const hold = Math.max(1 - 0.8 * slide * (c.crash ? 1 : 0), feet, frontLight || rearLight ? 1 : 0);
        const want =
          (Itot * BAL.wn * BAL.wn + this.Mt * G * hAx * feet) * phiErr +
          2 * BAL.zeta * BAL.wn * Itot * (this.rollRate - this.phiRefRate);
        tq -= hold * clamp(want, -BAL.tMax, BAL.tMax);
        // нога в упор, если аварии выключены или байк почти стоит
        const dab = Math.abs(this.phi) - 0.95;
        if (dab > 0 && (!c.crash || this.settling || this.u < 1.5)) {
          tq -= Math.sign(this.phi) * dab * 9000 + 300 * this.rollRate;
        }
      }
      this.rollRate = clamp(this.rollRate + (tq / this.Ix) * dt, -6, 6);
      this.phi = clamp(this.phi + this.rollRate * dt, -1.2, 1.2);
    } else {
      this.rollRate *= Math.exp(-dt * 6);
    }

    // ---------- батарея ----------
    const pel = (Tm * wm) / 0.88 + (this.thr > 0.01 ? 25 : 0);
    this.power = pel - regenW * 0.55;
    const amps = this.power / Math.max(this.busV, 30);
    this.busV += (vOc - amps * PACK_R - this.busV) * Math.min(1, dt * 12);
    this.battery = clamp(this.battery - ((this.power * dt) / 3600 / M.battWh) * BATT_TIME_SCALE, 0, 1);

    // ---------- столкновения и границы карты (общие с самокатом) ----------
    if (!this.settling) {
      this.resolveObstacleCollisions(false);
      this.updateCones(dt, fx, fz, lx, lz);
    }
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
      const hard = vn > 4.5;
      this.u *= hard ? 0.25 : 0.35;
      this.v *= hard ? 0.25 : 0.35;
      if (hard) {
        this.doCrash('Столкновение с ограждением', {
          kind: 'obstacle',
          preVxW: vxW,
          preVyW: this.vyb,
          preVzW: vzW,
          preSpeed: Math.hypot(vxW, vzW),
          impactVn: vn,
          impactNx: Math.abs(this.px) >= lim ? -Math.sign(this.px) : 0,
          impactNz: Math.abs(this.pz) >= lim ? -Math.sign(this.pz) : 0,
        });
      }
    }

    // ---------- вилли, стоппи и падения ----------
    const relNow = this.th - terrainPitch;
    const deg = Math.max(0, (relNow * 180) / Math.PI);
    const degS = Math.max(0, (-relNow * 180) / Math.PI);
    this.stuntAngle = deg;
    this.stoppieDeg = degS;
    this.tailScrape = false;
    if (!crashed && !this.settling) {
      // Падение набок — байк реально завалился дальше, чем можно поймать
      if (!this.airborne && this.u > 1.5 && Math.abs(this.phi) > 1.02) {
        this.doCrash(
          wf.util >= wr.util ? 'Срыв переднего колеса в повороте' : 'Критический занос: потеря сцепления',
          { kind: 'slip' },
        );
      }
      const slideAng = speed > 4.5 ? Math.abs(Math.atan2(this.v, absU)) : 0;
      this.slipT = !this.airborne && slideAng > 0.85 ? this.slipT + dt : Math.max(0, this.slipT - dt * 2.4);
      if (this.slipT > 0.6) this.doCrash('Критический занос: потеря сцепления', { kind: 'slip' });

      const rearUp = !this.airborne && wr.fz < 8 && wf.fz > 60 && relNow < -0.1;
      const stoppieNow = rearUp && this.u > 0.8 && (stoppieWant || this.stoppieIn > 0.2);
      this.stoppie = stoppieNow;
      // предупреждение — только когда зад поднялся сам, без команды на стоппи
      this.endo = rearUp && !stoppieNow && this.u > 3 && wf.eff > 0.5;
      if (rearUp && relNow < -STOPPIE.endo) {
        this.doCrash('Через руль! Слишком резкое переднее торможение', {
          kind: 'endo',
          preVyW: Math.max(this.vyb, 0.85),
        });
      }

      const frontUp = !this.airborne && wf.fz < 12 && wr.fz > 35 && deg > 7.5;
      const wheelieNow = frontUp && this.u > 0.8;
      this.wheelie = wheelieNow;
      if (wheelieNow || stoppieNow) {
        this.stuntHoldGrace = 0.4;
        const d = Math.max(0, this.u) * dt;
        this.stuntDist += d;
        this.stuntTime += dt;
        this.stuntScore += stoppieNow
          ? d * 22 * (degS >= 14 && degS <= 32 ? 2.2 : 1)
          : d * 15 * (deg >= 19 && deg <= 37 ? 2.2 : deg > 37 ? 2.8 : 1);
        if (this.stuntDist > this.bestStuntDist) this.bestStuntDist = this.stuntDist;
        if (this.stuntScore > this.bestStuntScore) this.bestStuntScore = this.stuntScore;
      } else if (this.stuntHoldGrace > 0) {
        this.stuntHoldGrace = Math.max(0, this.stuntHoldGrace - dt);
      } else {
        this.stuntDist = 0;
        this.stuntTime = 0;
        this.stuntScore = 0;
      }
      if (frontUp && deg > WHEELIE.loopDeg) {
        this.loopOutT += dt;
        if (this.loopOutT > 0.35) {
          this.doCrash('Опрокидывание назад! Перекрутил угол станта — контролируй задним тормозом (X / Пробел)', {
            kind: 'loopout',
          });
        }
      } else {
        this.loopOutT = Math.max(0, this.loopOutT - dt * 2.5);
      }
    } else {
      this.wheelie = false;
      this.stoppie = false;
      this.endo = false;
      if (crashed) {
        this.stuntDist = 0;
        this.stuntTime = 0;
        this.stuntScore = 0;
      }
    }
    if (crashed) this.crashT += dt;
  }

  telemetry(): Telemetry {
    const t = super.telemetry();
    t.compR = clamp(this.wr.comp / this.travelR, 0, 1);
    if (this.stoppie || (this.stoppieDeg > 6 && this.stuntHoldGrace > 0 && !this.wheelie)) {
      const d = this.stoppieDeg;
      t.wheelie = true;
      t.stoppie = true;
      t.stuntAngle = d;
      t.stuntZone = d > 36 ? 'danger' : d >= 14 ? 'sweet' : 'lift';
    }
    return t;
  }
}
