/**
 * Плавность кадров: ограничитель частоты, адаптивное разрешение и счётчик FPS.
 * Чистая логика без DOM и WebGL, поэтому проверяется скриптом check:frame на синтетических таймлайнах.
 */

/** Ограничивает частоту отрисовки (например 60 на мониторе 120/144 Гц), сохраняя средний темп. */
export class FrameLimiter {
  private next = -Infinity;

  /** fps = 0 — без ограничения. now — метка времени requestAnimationFrame, мс. */
  shouldRender(now: number, fps: number): boolean {
    if (!fps) return true;
    const interval = 1000 / fps;
    // метки vsync дрожат на доли миллисекунды: кадр, пришедший чуть раньше срока, не пропускаем
    if (now < this.next - Math.min(2, interval * 0.15)) return false;
    this.next += interval;
    // после паузы, скрытой вкладки или медленного кадра не догоняем пропущенное пачкой кадров
    if (now - this.next > interval) this.next = now + interval;
    return true;
  }

  reset() {
    this.next = -Infinity;
  }
}

/** Средняя частота отрисованных кадров за последние полсекунды. */
export class FpsMeter {
  fps = 0;
  private frames = 0;
  private start = -1;

  tick(now: number) {
    // после скрытой вкладки отсчёт начинаем заново, но медленные кадры (до 5 с) честно показываем
    if (this.start < 0 || now - this.start > 5000) {
      this.start = now;
      this.frames = 0;
      return;
    }
    this.frames++;
    const span = now - this.start;
    if (span >= 500) {
      this.fps = (this.frames * 1000) / span;
      this.start = now;
      this.frames = 0;
    }
  }
}

export const MIN_RENDER_SCALE = 0.55;
const WINDOW_MS = 1000;
const WARMUP_MS = 1500;

/**
 * Подбирает долю разрешения так, чтобы держать целевую частоту кадров.
 * Снижает разрешение, только когда кадр упирается в видеокарту: если основной поток сам занят
 * дольше бюджета кадра, меньшее разрешение не поможет, а картинку испортит.
 */
export class ResolutionGovernor {
  scale = 1;
  private winStart = -1;
  private warmUntil = 0;
  private intervals = 0;
  private frames = 0;
  private slow = 0;
  private cpu = 0;
  private goodWindows = 0;
  private upNeed = 3;
  private justRaised = false;

  /** Сбросить статистику: смена карты, качества, размера окна — первые кадры после неё не показательны. */
  reset(now: number, keepScale = true) {
    if (!keepScale) {
      this.scale = 1;
      this.upNeed = 3;
    }
    this.winStart = -1;
    this.warmUntil = now + WARMUP_MS;
    this.goodWindows = 0;
    this.justRaised = false;
  }

  /**
   * interval — время от прошлого отрисованного кадра, cpuMs — работа основного потока в этом кадре,
   * targetFps — желаемая частота. Возвращает true, когда scale изменился.
   */
  sample(now: number, interval: number, cpuMs: number, targetFps: number): boolean {
    // скрытая вкладка, пауза отладчика или долгая загрузка — не кадр, а пауза
    if (interval > 250 || now < this.warmUntil) return false;
    if (this.winStart < 0) {
      this.winStart = now;
      this.intervals = this.frames = this.slow = this.cpu = 0;
      return false;
    }
    const budget = 1000 / targetFps;
    this.intervals += interval;
    this.frames++;
    this.cpu += cpuMs;
    if (interval > budget * 1.35) this.slow++;
    if (now - this.winStart < WINDOW_MS) return false;

    const fps = (this.frames * 1000) / this.intervals;
    const slowShare = this.slow / this.frames;
    const cpuAvg = this.cpu / this.frames;
    this.winStart = -1;
    const prev = this.scale;

    if (fps < targetFps * 0.92 || slowShare > 0.12) {
      this.goodWindows = 0;
      if (cpuAvg < budget * 0.75 && this.scale > MIN_RENDER_SCALE) {
        // число пикселей ~ scale², поэтому шаг по scale берём от доли недостающего времени
        const k = Math.sqrt(Math.max(0.5, Math.min(1, fps / targetFps)));
        this.scale = Math.max(MIN_RENDER_SCALE, quant(this.scale * Math.min(0.93, k)));
        // только что поднятое разрешение снова не потянули — следующую попытку делаем реже
        if (this.justRaised) this.upNeed = Math.min(30, this.upNeed * 2);
      }
      this.justRaised = false;
    } else if (this.scale < 1 && fps >= targetFps * 0.97 && slowShare < 0.04) {
      this.justRaised = false;
      if (++this.goodWindows >= this.upNeed) {
        this.goodWindows = 0;
        this.scale = Math.min(1, quant(this.scale + 0.08));
        this.justRaised = true;
      }
    } else {
      this.justRaised = false;
    }
    return this.scale !== prev;
  }
}

const quant = (v: number) => Math.round(v * 20) / 20;

/** Поля симуляции, из которых строится картинка (камера, байк, райдер). */
export interface InterpolatedState {
  px: number;
  pz: number;
  psi: number;
  yb: number;
  th: number;
  phi: number;
  delta: number;
  wf: { y: number; angle: number };
  wr: { y: number; angle: number };
}

const read = (s: InterpolatedState, o: Float64Array) => {
  o[0] = s.px; o[1] = s.pz; o[2] = s.psi; o[3] = s.yb; o[4] = s.th; o[5] = s.phi; o[6] = s.delta;
  o[7] = s.wf.y; o[8] = s.wf.angle; o[9] = s.wr.y; o[10] = s.wr.angle;
};
const write = (s: InterpolatedState, o: Float64Array) => {
  s.px = o[0]; s.pz = o[1]; s.psi = o[2]; s.yb = o[3]; s.th = o[4]; s.phi = o[5]; s.delta = o[6];
  s.wf.y = o[7]; s.wf.angle = o[8]; s.wr.y = o[9]; s.wr.angle = o[10];
};

/**
 * Физика идёт фиксированными шагами 1/480 с, а кадры — с частотой экрана: на 144 Гц это 3–3–4 шага
 * за кадр, и без интерполяции байк едет рывками. Перед отрисовкой подставляем состояние между двумя
 * последними шагами, после кадра возвращаем настоящее, чтобы физика оставалась детерминированной.
 */
export class SimInterpolator {
  private prev = new Float64Array(11);
  private cur = new Float64Array(11);
  private mix = new Float64Array(11);
  private owner: InterpolatedState | null = null;
  private applied: InterpolatedState | null = null;

  /** Вызывать перед каждым шагом физики. */
  beforeStep(sim: InterpolatedState) {
    read(sim, this.prev);
    this.owner = sim;
  }

  /** alpha — доля следующего шага, уже накопленная во времени (acc / DT). */
  apply(sim: InterpolatedState, alpha: number): boolean {
    if (this.owner !== sim || this.applied) return false;
    read(sim, this.cur);
    const dx = this.cur[0] - this.prev[0];
    const dz = this.cur[1] - this.prev[1];
    // респаун или перенос на старт: тянуть картинку через всю карту нельзя
    if (dx * dx + dz * dz > 1) return false;
    const a = Math.max(0, Math.min(1, alpha));
    for (let i = 0; i < 11; i++) this.mix[i] = this.prev[i] + (this.cur[i] - this.prev[i]) * a;
    write(sim, this.mix);
    this.applied = sim;
    return true;
  }

  restore() {
    if (this.applied) write(this.applied, this.cur);
    this.applied = null;
  }

  invalidate() {
    this.restore();
    this.owner = null;
  }
}
